# Security helpers - URL validation, safe fetch, path guards, label sanitisation
from __future__ import annotations

import hashlib
import html
import http.client
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import warnings
from array import array
from bisect import bisect_left, bisect_right
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Any

import ipaddress
import socket

from graphify.paths import GRAPHIFY_OUT, GRAPHIFY_OUT_NAME

_ALLOWED_SCHEMES = {"http", "https"}
_MAX_FETCH_BYTES = 52_428_800   # 50 MB hard cap for binary downloads
_MAX_TEXT_BYTES  = 10_485_760   # 10 MB hard cap for HTML / text

# Graph-load memory-bomb cap: reject .json files larger than this before
# JSON-parsing them into a dict. Without this, a multi-gigabyte (or
# specifically crafted) graph.json can exhaust process memory during
# json.loads + node_link_graph rehydration.
# Default fallback cap. Kept as a module-level constant so the value is
# discoverable and so existing callers/tests that reference it directly keep
# working; the effective cap is resolved at call time by
# ``_max_graph_file_bytes`` (which lets ``GRAPHIFY_MAX_GRAPH_BYTES`` override it).
_MAX_GRAPH_FILE_BYTES = 512 * 1024 * 1024   # 512 MiB


def _max_graph_file_bytes() -> int:
    """Return the graph.json size cap in bytes.

    Honors the ``GRAPHIFY_MAX_GRAPH_BYTES`` environment variable so users with
    large codebases can raise the limit without editing source. The value may
    be plain bytes (``671088640``) or carry an ``MB`` / ``GB`` suffix
    (``640MB``, ``2GB`` — case-insensitive, binary multipliers: ``MB`` is
    1024*1024 and ``GB`` is 1024*1024*1024, i.e. MiB / GiB).
    Falls back to ``_MAX_GRAPH_FILE_BYTES`` (512 MiB) when the env var is unset,
    blank, or unparseable.

    Read fresh on every call so the env var can be set before import and still
    take effect.
    """
    raw = os.environ.get("GRAPHIFY_MAX_GRAPH_BYTES", "").strip()
    if not raw:
        return _MAX_GRAPH_FILE_BYTES
    text = raw.upper()
    multiplier = 1
    if text.endswith("GB"):
        multiplier = 1024 * 1024 * 1024
        text = text[:-2].strip()
    elif text.endswith("MB"):
        multiplier = 1024 * 1024
        text = text[:-2].strip()
    try:
        value = int(text)
    except ValueError:
        return _MAX_GRAPH_FILE_BYTES
    if value <= 0:
        return _MAX_GRAPH_FILE_BYTES
    return value * multiplier

# AWS metadata, link-local, and common cloud metadata endpoints
_BLOCKED_HOSTS = {"metadata.google.internal", "metadata.google.com"}

# RFC 6598 Shared Address Space (CGN) -- is_private misses this on Python <3.11
_CGN_NETWORK = ipaddress.ip_network("100.64.0.0/10")

# RFC 6052 NAT64 Well-Known Prefix -- is_reserved=True in Python but these embed
# public IPv4 addresses and are legitimate public internet traffic, not SSRF vectors.
_NAT64_WKP = ipaddress.ip_network("64:ff9b::/96")


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------

def _ip_is_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True if *ip* falls in a private/reserved/internal range.

    Shared by validate_url (pre-flight DNS check) and the SSRF-guarded
    connection classes (connect-time check) so both use identical logic.
    NAT64 well-known-prefix addresses are unwrapped to their embedded IPv4
    before the check, since those carry legitimate public traffic.
    """
    # For NAT64 addresses, check the embedded IPv4 instead of the wrapper
    if isinstance(ip, ipaddress.IPv6Address) and ip in _NAT64_WKP:
        ip = ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
    return (
        ip.is_private
        or ip.is_reserved
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip in _CGN_NETWORK
    )


def validate_url(url: str) -> str:
    """Raise ValueError if *url* is not http or https, or targets a private/internal IP.

    Blocks file://, ftp://, data:, and any other scheme that could be used
    for SSRF or local file access. Also blocks requests to private/reserved
    IP ranges (127.x, 10.x, 169.254.x, etc.) and cloud metadata endpoints
    to prevent SSRF in cloud environments.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        raise ValueError(
            f"Blocked URL scheme '{parsed.scheme}' - only http and https are allowed. "
            f"Got: {url!r}"
        )

    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"Blocked URL containing embedded credentials. Got: {url!r}")

    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"Blocked URL with an invalid port. Got: {url!r}") from exc
    if port == 0:
        raise ValueError(f"Blocked URL with port 0. Got: {url!r}")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError(f"Blocked URL without a hostname. Got: {url!r}")

    if hostname:
        # Block known cloud metadata hostnames
        if hostname.lower() in _BLOCKED_HOSTS:
            raise ValueError(
                f"Blocked cloud metadata endpoint '{hostname}'. "
                f"Got: {url!r}"
            )

        # Resolve hostname and block private/reserved IP ranges
        try:
            infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
            for info in infos:
                addr = info[4][0]
                ip = ipaddress.ip_address(addr)
                if _ip_is_blocked(ip):
                    raise ValueError(
                        f"Blocked private/internal IP {addr} (resolved from '{hostname}'). "
                        f"Got: {url!r}"
                    )
        except socket.gaierror as exc:
            raise ValueError(
                f"DNS resolution failed for '{hostname}': {exc}. Got: {url!r}"
            ) from exc

    return url


# ---------------------------------------------------------------------------
# SSRF-guarded connections
#
# Instead of monkey-patching the process-global socket.getaddrinfo (a
# non-thread-safe TOCTOU hazard when multiple fetches run concurrently),
# we subclass the HTTP(S) connection so each connection resolves DNS exactly
# once, validates the resulting IP, and then connects to that exact IP. There
# is no second resolution, so a DNS-rebind attack cannot swap in a private
# address (e.g. 169.254.169.254) between validation and connection.
# ---------------------------------------------------------------------------


def _resolve_and_validate(host: str, port: int) -> tuple[int, str]:
    """Resolve *host* once and return (family, validated_ip) for the first
    address that is not in a blocked range.

    Raises OSError if every resolved address is private/reserved/internal,
    matching the failure mode urllib/http.client expect from connect().
    """
    infos = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    for family, _type, _proto, _canon, sockaddr in infos:
        addr = sockaddr[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if _ip_is_blocked(ip):
            raise OSError(
                f"SSRF blocked: IP {addr} resolved from '{host}' is private/reserved"
            )
        return family, addr
    raise OSError(f"SSRF blocked: no usable address resolved from '{host}'")


class _SSRFGuardedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that resolves + validates DNS once, then connects to the
    exact validated IP (no second resolution = no DNS-rebind TOCTOU)."""

    def connect(self) -> None:
        family, ip = _resolve_and_validate(self.host, self.port)
        self.sock = socket.create_connection(
            (ip, self.port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self._tunnel()


class _SSRFGuardedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection variant of _SSRFGuardedHTTPConnection.

    Connects to the validated IP but performs the TLS handshake with
    server_hostname set to the original hostname so SNI / certificate
    validation work correctly (validating against the IP would break TLS).
    """

    def connect(self) -> None:
        family, ip = _resolve_and_validate(self.host, self.port)
        sock = socket.create_connection(
            (ip, self.port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
            sock = self.sock
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _SSRFGuardedHTTPHandler(urllib.request.HTTPHandler):
    """urllib handler that routes http:// through _SSRFGuardedHTTPConnection."""

    def http_open(self, req):
        return self.do_open(_SSRFGuardedHTTPConnection, req)


class _SSRFGuardedHTTPSHandler(urllib.request.HTTPSHandler):
    """urllib handler that routes https:// through _SSRFGuardedHTTPSConnection."""

    def https_open(self, req):
        return self.do_open(_SSRFGuardedHTTPSConnection, req)


class _NoFileRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect handler that re-validates every redirect target.

    Prevents open-redirect SSRF attacks where an http:// URL redirects
    to file:// or an internal address.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)          # raises ValueError if scheme is wrong
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _build_opener() -> urllib.request.OpenerDirector:
    # build_opener replaces the default HTTP(S)Handlers with our SSRF-guarded
    # subclasses, so every connection resolves+validates DNS once and connects
    # to that exact IP. Thread-safe: no process-global state is mutated.
    return urllib.request.build_opener(
        _SSRFGuardedHTTPHandler,
        _SSRFGuardedHTTPSHandler,
        _NoFileRedirectHandler,
    )


# ---------------------------------------------------------------------------
# Safe fetch
# ---------------------------------------------------------------------------

def safe_fetch(url: str, max_bytes: int = _MAX_FETCH_BYTES, timeout: int = 30) -> bytes:
    """Fetch *url* and return raw bytes.

    Protections applied:
    - URL scheme validated (http / https only)
    - Redirects re-validated via _NoFileRedirectHandler
    - Response body capped at *max_bytes* (streaming read)
    - Non-2xx status raises urllib.error.HTTPError
    - Network errors propagate as urllib.error.URLError / OSError

    Raises:
        ValueError        - disallowed scheme or redirect target
        urllib.error.HTTPError  - non-2xx HTTP status
        urllib.error.URLError   - DNS / connection failure
        OSError               - size cap exceeded
    """
    validate_url(url)
    opener = _build_opener()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 graphify/1.0"})

    with opener.open(req, timeout=timeout) as resp:
        # urllib raises HTTPError for non-2xx when using urlopen directly;
        # with a custom opener we check manually to be safe.
        status = getattr(resp, "status", None) or getattr(resp, "code", None)
        if status is not None and not (200 <= status < 300):
            raise urllib.error.HTTPError(url, status, f"HTTP {status}", {}, None)

        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = resp.read(65_536)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise OSError(
                    f"Response from {url!r} exceeds size limit "
                    f"({max_bytes // 1_048_576} MB). Aborting download."
                )
            chunks.append(chunk)

    return b"".join(chunks)


def safe_fetch_text(url: str, max_bytes: int = _MAX_TEXT_BYTES, timeout: int = 15) -> str:
    """Fetch *url* and return decoded text (UTF-8, replacing bad bytes).

    Wraps safe_fetch with tighter defaults for HTML / text content.
    """
    raw = safe_fetch(url, max_bytes=max_bytes, timeout=timeout)
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Path validation
# ---------------------------------------------------------------------------

def validate_graph_path(path: str | Path, base: Path | None = None) -> Path:
    """Resolve *path* and verify it stays inside *base*.

    *base* defaults to the `graphify-out` directory relative to CWD.
    Also requires the base directory to exist, so a caller cannot
    trick graphify into reading files before any graph has been built.

    Raises:
        ValueError  - path escapes base, or base does not exist
        FileNotFoundError - resolved path does not exist
    """
    if base is None:
        resolved_hint = Path(path).resolve()
        for candidate in [resolved_hint, *resolved_hint.parents]:
            if candidate.name == GRAPHIFY_OUT_NAME:
                base = candidate
                break
        if base is None:
            base = Path(GRAPHIFY_OUT).resolve()

    base = base.resolve()
    if not base.exists():
        raise ValueError(
            f"Graph base directory does not exist: {base}. "
            "Run /graphify first to build the graph."
        )

    resolved = Path(path).resolve()
    try:
        resolved.relative_to(base)
    except ValueError:
        raise ValueError(
            f"Path {path!r} escapes the allowed directory {base}. "
            "Only paths inside graphify-out/ are permitted."
        )

    if not resolved.exists():
        raise FileNotFoundError(f"Graph file not found: {resolved}")

    return resolved


def check_graph_file_size_cap(path: Path) -> None:
    """Reject *path* if its size exceeds the configured graph-file cap.

    Protects callers from memory bombs by failing fast before a multi-GiB
    graph.json is read into memory and JSON-parsed. Silently returns when
    ``path.stat()`` cannot be read — the caller's own existence/path check
    is expected to surface a clearer error in that case.

    The cap is resolved on every call via :func:`_max_graph_file_bytes`, so the
    ``GRAPHIFY_MAX_GRAPH_BYTES`` env var can be set before import and still
    apply.

    Raises:
        ValueError - file size exceeds the cap. The message includes the
        observed size, the cap, and how to raise the limit.
    """
    cap = _max_graph_file_bytes()
    try:
        size = path.stat().st_size
    except OSError:
        return
    if size > cap:
        raise ValueError(
            f"graph file {path} is {size:_d} bytes, exceeds {cap:_d}-byte cap\n"
            f"(set GRAPHIFY_MAX_GRAPH_BYTES=<bytes> or "
            f"GRAPHIFY_MAX_GRAPH_BYTES=<N>GB to raise the limit)"
        )


# ---------------------------------------------------------------------------
# Label sanitisation (mirrors code-review-graph's _sanitize_name pattern)
# ---------------------------------------------------------------------------

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAX_LABEL_LEN = 256


# Credential shapes redacted from free text that is persisted into the graph
# (rationale/comment labels). Shape-based only, so it is risk reduction rather
# than a guarantee: vendor-prefixed tokens, PEM private-key blocks and URL
# userinfo. Boundaries are alphanumeric-only lookarounds rather than \b so a
# token glued to an identifier by `_` (`token_ghp_...`, `AKIA..._prod`) still
# matches.
_SECRET_SHAPE_RE = re.compile(
    # Header through the END line, or to end of text when the block is cut off:
    # the base64 body is the secret, not the header.
    r"(?s:-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----"
    r"(?:.*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|.*))"
    r"|(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])"
    r"|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}"
    r"|(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}"
    r"|(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,}"
    r"|(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{10,}"
    # Require a digit so hyphenated prose (`sk-learn-compatible-...`) is left alone.
    r"|(?<![A-Za-z0-9])sk-(?:ant-|proj-)?(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}"
    r"|(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}"
    # Payload segment may be tiny (`e30` is `{}`).
    r"|(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}"
    r"|(?<=\bBearer )[A-Za-z0-9._~+/=-]{16,}"
    # Userinfo up to the LAST `@` before the host: the user may be empty
    # (`redis://:pw@host`) and the password may contain `@` or `/`.
    r"|(?<=://)[^\s/@]*:[^\s?#]*(?=@[^\s@/?#]+)"
)

REDACTED_MARKER = "[redacted]"
SOURCE_REDACTION_POLICY = "credential-shapes-preserve-coordinates-v1"
SOURCE_REDACTION_MASKS = MappingProxyType({1: "*", 2: "\u00a4", 3: "\u2588", 4: "\U0001f7e5"})
SOURCE_REDACTION_REGEX_MASKS = MappingProxyType({**SOURCE_REDACTION_MASKS, 1: "x"})

# Match the source-only framework analyzer's admission and traversal limits.
_SOURCE_REDACTION_MAX_BYTES = 256 * 1024
_SOURCE_REDACTION_MAX_NODES = 100_000
_SOURCE_REDACTION_MAX_DEPTH = 256
_SOURCE_REDACTION_MAX_RANGES = 4096
_SOURCE_REDACTION_MAX_SCAN_BYTES = 16 * 1024 * 1024
_SOURCE_REDACTION_PARSE_TIMEOUT_MICROS = 1_000_000


def redact_secrets(text: str | None) -> str:
    """Replace credential-shaped substrings in *text* with ``[redacted]``.

    Applied to free text copied out of source files (docstrings and ``# WHY:``
    style comments) before it becomes a node label, so a token pasted into a
    comment does not land in graph.json / graph.html / GRAPH_REPORT.md.
    """
    if not text:
        return "" if text is None else text
    return _SECRET_SHAPE_RE.sub(REDACTED_MARKER, str(text))


def redact_source_credentials(source: str, language: str) -> tuple[str, dict | None]:
    """Mask credential shapes in TS/TSX data without moving source coordinates.

    Unsupported containment or syntax is refused, never repaired. Metadata has
    half-open byte spans and one-based inclusive lines; the original file hash
    is a freshness/provenance witness, not proof of authenticity. No source or
    per-credential digest is retained in metadata.
    """
    def refusal(line: int = 1) -> ValueError:
        return ValueError(f"Cannot safely redact source credentials at line {line}")

    if not isinstance(source, str) or language not in ("typescript", "tsx"):
        raise refusal()
    first = _SECRET_SHAPE_RE.search(source)
    if first is None:
        return source, None
    first_line = source.count("\n", 0, first.start()) + 1
    if len(source) > _SOURCE_REDACTION_MAX_BYTES:
        raise refusal(first_line)
    try:
        raw = source.encode("utf-8")
        original_utf16 = len(source.encode("utf-16-le")) // 2
    except UnicodeError:
        raise refusal(first_line) from None
    if len(raw) > _SOURCE_REDACTION_MAX_BYTES:
        raise refusal(first_line)

    offsets = array("I", [0])
    for char in source:
        offsets.append(offsets[-1] + len(char.encode("utf-8")))
    line_starts = [0, *(index + 1 for index, byte in enumerate(raw) if byte == 10)]
    matches = []
    for match in _SECRET_SHAPE_RE.finditer(source):
        if len(matches) >= _SOURCE_REDACTION_MAX_RANGES:
            raise refusal(bisect_right(line_starts, offsets[match.start()]))
        matches.append((offsets[match.start()], offsets[match.end()]))

    try:
        from tree_sitter import Language, Parser
        import tree_sitter_typescript

        factory = (
            tree_sitter_typescript.language_tsx
            if language == "tsx"
            else tree_sitter_typescript.language_typescript
        )
        grammar = Language(factory())
    except Exception:
        raise refusal(first_line) from None

    def syntax(data: bytes) -> tuple[list, list, list, set]:
        try:
            # The 0.25 runtime's progress callback can crash on nested input on
            # Windows. Its native timeout safely bounds direct bytes parsing.
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore", message=r"Use the progress_callback in parse\(\)",
                    category=DeprecationWarning,
                )
                parser = Parser(grammar, timeout_micros=_SOURCE_REDACTION_PARSE_TIMEOUT_MICROS)
            tree = parser.parse(data)
        except Exception:
            raise refusal(first_line) from None
        if tree is None:
            raise refusal(first_line)
        if tree.root_node.has_error:
            raise refusal(first_line)

        regions, escapes, structure, regex_regions = [], [], [], []
        pending = [(tree.root_node, 0, False)]
        count = 0
        while pending:
            node, depth, opaque = pending.pop()
            count += 1
            if count > _SOURCE_REDACTION_MAX_NODES or depth > _SOURCE_REDACTION_MAX_DEPTH:
                raise refusal(node.start_point.row + 1)
            kind, start, end = node.type, node.start_byte, node.end_byte
            if not opaque:
                structure.append((kind, start, end))
            if kind == "escape_sequence":
                escapes.append((start, end))
            # TypeScript also uses an anonymous `string` token for type syntax.
            if kind in {"string", "template_string"} and node.is_named:
                quote = data[start:start + 1]
                if quote not in (b"'", b'"', b"`") or data[end - 1:end] != quote:
                    raise refusal(node.start_point.row + 1)
                cursor = start + 1
                if kind == "template_string":
                    for child in node.children:
                        if child.type == "template_substitution":
                            regions.append((cursor, child.start_byte))
                            cursor = child.end_byte
                regions.append((cursor, end - 1))
            elif kind == "comment":
                if data[start:start + 2] == b"//":
                    regions.append((start + 2, end))
                elif data[start:start + 2] == b"/*" and data[end - 2:end] == b"*/":
                    regions.append((start + 2, end - 2))
                else:
                    raise refusal(node.start_point.row + 1)
            elif kind == "jsx_text":
                regions.append((start, end))
            elif kind == "regex_pattern":
                regions.append((start, end))
                regex_regions.append((start, end))
            for child in reversed(node.children):
                child_opaque = opaque or kind in {"string", "comment", "jsx_text", "regex_pattern"} or (
                    kind == "template_string" and child.type in {"string_fragment", "escape_sequence"}
                )
                pending.append((child, depth + 1, child_opaque))
        return sorted(regions), sorted(escapes), structure, set(regex_regions)

    regions, escapes, structure, regex_regions = syntax(raw)
    region_starts = [start for start, _ in regions]
    # Tests and validators often repeat the detected userinfo as a plain
    # expected string. Mask those identical data occurrences too, but never
    # rewrite coincidentally equal code/identifier text.
    seeds = {raw[start:end] for start, end in matches if raw[start:end] != b":"}
    if len(raw) * len(seeds) > _SOURCE_REDACTION_MAX_SCAN_BYTES:
        raise refusal(first_line)
    expanded_matches = set(matches)
    for seed in seeds:
        cursor = 0
        while (position := raw.find(seed, cursor)) >= 0:
            end = position + len(seed)
            region = bisect_right(region_starts, position) - 1
            if region >= 0 and end <= regions[region][1]:
                expanded_matches.add((position, end))
                if len(expanded_matches) > _SOURCE_REDACTION_MAX_RANGES:
                    raise refusal(bisect_right(line_starts, position))
            cursor = end
    matches = sorted(expanded_matches)
    escape_ends = [end for _, end in escapes]
    ranges = []
    for start, end in matches:
        line = bisect_right(line_starts, start)
        region = bisect_right(region_starts, start) - 1
        if region < 0 or end > regions[region][1]:
            raise refusal(line)
        if regions[region] in regex_regions:
            # Partial replacement can unbalance a pattern. Replace the entire
            # literal pattern with non-special characters, retaining delimiters
            # and flags; its original matching semantics are unavailable.
            start, end = regions[region]
        # Removing only part of an escape can leave an invalid backslash prefix.
        index = bisect_right(escape_ends, start)
        while index < len(escapes) and escapes[index][0] < end:
            start = min(start, escapes[index][0])
            end = max(end, escapes[index][1])
            index += 1
        if start < regions[region][0] or end > regions[region][1]:
            raise refusal(line)
        if ranges and start <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(end, ranges[-1][1]))
        else:
            ranges.append((start, end))

    chunks, metadata_ranges = [], []
    cursor = 0
    for start, end in ranges:
        first_char, last_char = bisect_left(offsets, start), bisect_left(offsets, end)
        if offsets[first_char] != start or offsets[last_char] != end:
            raise refusal(bisect_right(line_starts, start))
        chunks.append(source[cursor:first_char])
        masks = SOURCE_REDACTION_REGEX_MASKS if (start, end) in regex_regions else SOURCE_REDACTION_MASKS
        chunks.append("".join(
            char if char in "\r\n" else masks[len(char.encode("utf-8"))]
            for char in source[first_char:last_char]
        ))
        cursor = last_char
        metadata_ranges.append({
            "startByte": start,
            "endByte": end,
            "startLine": bisect_right(line_starts, start),
            "endLine": bisect_right(line_starts, end - 1),
        })
    chunks.append(source[cursor:])
    masked = "".join(chunks)
    masked_raw = masked.encode("utf-8")
    if (
        len(masked_raw) != len(raw)
        or len(masked.encode("utf-16-le")) // 2 != original_utf16
        or redact_secrets(masked) != masked
    ):
        raise refusal(first_line)
    # Also catch a mask creating syntax, e.g. '*' before '/' inside a comment.
    if syntax(masked_raw)[2] != structure:
        raise refusal(first_line)
    return masked, {
        "version": 1,
        "policy": SOURCE_REDACTION_POLICY,
        "originalSourceHash": hashlib.sha256(raw).hexdigest(),
        "ranges": metadata_ranges,
    }


def sanitize_label(text: str | None) -> str:
    """Strip control characters and cap length.

    Safe for embedding in JSON data (inside <script> tags) and plain text.
    For direct HTML injection, wrap the result with html.escape().
    """
    if text is None:
        return ""
    text = _CONTROL_CHAR_RE.sub("", str(text))
    if len(text) > _MAX_LABEL_LEN:
        text = text[:_MAX_LABEL_LEN]
    return text


# ---------------------------------------------------------------------------
# Metadata sanitisation (recursive, bounded, HTML-safe)
# ---------------------------------------------------------------------------

_METADATA_MAX_VALUE_LEN = 512
_METADATA_MAX_LIST_ITEMS = 50
_METADATA_MAX_ATTRIBUTES = 100


def _sanitize_metadata_string(value: object) -> str:
    """Return a control-character-free, HTML-escaped, bounded string."""
    text = _CONTROL_CHAR_RE.sub("", str(value))
    text = html.escape(text, quote=True)
    if len(text) > _METADATA_MAX_VALUE_LEN:
        text = text[:_METADATA_MAX_VALUE_LEN]
    return text  # html is imported at module level (line 5)


def _sanitize_metadata_value(value: object) -> object:
    """Sanitize a metadata value while preserving simple JSON-compatible types."""
    if isinstance(value, bool):
        # bool is a subclass of int — must be checked first to avoid coercion.
        return value
    if isinstance(value, str):
        return _sanitize_metadata_string(value)
    if isinstance(value, dict):
        return sanitize_metadata(value)
    if isinstance(value, (list, tuple)):
        return [_sanitize_metadata_value(item) for item in value[:_METADATA_MAX_LIST_ITEMS]]
    if isinstance(value, (int, float)) or value is None:
        return value
    return _sanitize_metadata_string(value)


def sanitize_metadata(metadata: Mapping[str, Any] | None) -> dict[str, object]:
    """Sanitize metadata keys and values before graph export.

    Metadata is less constrained than node labels: it can contain nested
    dicts, lists, source snippets, external index symbols, and docstring
    text. This helper keeps the data JSON-compatible, strips control
    characters, escapes HTML-sensitive characters in strings, caps long
    strings/lists, and drops entries whose key becomes empty after
    sanitization.
    """
    if metadata is None:
        return {}

    result: dict[str, object] = {}
    for key, value in metadata.items():
        clean_key = _sanitize_metadata_string(key)
        if not clean_key:
            continue
        result[clean_key] = _sanitize_metadata_value(value)
    return result
