"""Graphify-owned, source-only TypeScript framework analysis.

Python supplies the admitted syntax snapshot. The bundled Node worker consumes
data only: it never imports the analyzed application or discovers more files.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from array import array
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import TYPE_CHECKING

from graphify.security import redact_secrets, redact_source_credentials

if TYPE_CHECKING:
    from graphify.framework_config import AnalysisOptions
    from graphify.framework_evidence import EvidenceStore

MAX_SOURCE_BYTES = 256 * 1024
MAX_TREE_NODES = 100_000
MAX_TREE_DEPTH = 256
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
MAX_BATCH_SOURCE_BYTES = 1024 * 1024
MAX_BATCH_DOCUMENTS = 16
MAX_BATCH_TREE_NODES = 250_000
MAX_OPTIONS_BYTES = 4096
SUPPORTED_PARSER_VERSION = "0.23.2"
SUPPORTED_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts"})
PRODUCERS = frozenset(
    {
        "fst-solid",
        "solid",
        "fst-components",
        "implementation",
        "transport-binding",
        "validation-contract",
        "dispatch-binding",
    }
)


class FrameworkAnalysisError(RuntimeError):
    """The requested evidence could not be produced without weakening its contract."""


def parser_descriptor() -> dict:
    try:
        descriptor = {
            "id": "tree-sitter-typescript",
            "version": version("tree-sitter-typescript"),
            "runtimeVersion": version("tree-sitter"),
            "coordinateEncoding": "utf16",
        }
    except PackageNotFoundError as exc:
        raise FrameworkAnalysisError("The qualified TypeScript parser is not installed") from exc
    if descriptor["version"] != SUPPORTED_PARSER_VERSION:
        raise FrameworkAnalysisError(
            "Installed TypeScript grammar is not qualified for this analyzer"
        )
    return descriptor


@lru_cache(maxsize=2)
def _language(language: str):
    from tree_sitter import Language
    import tree_sitter_typescript

    parser_descriptor()
    factory = (
        tree_sitter_typescript.language_tsx
        if language == "tsx"
        else tree_sitter_typescript.language_typescript
    )
    return Language(factory())


def serialize_tree(source: str, language: str = "typescript") -> dict:
    """Encode all CST children with original-source UTF-16 coordinates.

    Tree-sitter's Python offsets are UTF-8 bytes; the source-only view uses
    JavaScript string coordinates. Only actual character boundaries are mapped.
    """
    from tree_sitter import Parser

    if not isinstance(source, str):
        raise FrameworkAnalysisError("Source must be text")
    if not isinstance(language, str) or language not in {"typescript", "tsx"}:
        raise FrameworkAnalysisError("Framework analysis supports TypeScript and TSX only")
    try:
        raw = source.encode("utf-8")
    except UnicodeError as exc:
        raise FrameworkAnalysisError("Source is not valid Unicode") from exc
    if len(raw) > MAX_SOURCE_BYTES:
        raise FrameworkAnalysisError(f"Source exceeds the {MAX_SOURCE_BYTES}-byte analysis limit")
    offsets = array("i", [-1]) * (len(raw) + 1)
    byte, utf16 = 0, 0
    offsets[0] = 0
    for char in source:
        byte += len(char.encode("utf-8"))
        utf16 += 2 if ord(char) > 0xFFFF else 1
        offsets[byte] = utf16
    line_starts = [0]
    line_starts.extend(index + 1 for index, value in enumerate(raw) if value == 10)
    tree = Parser(_language(language)).parse(raw)

    def encode(node) -> dict:
        start, end = node.start_byte, node.end_byte
        if offsets[start] < 0 or offsets[end] < 0:
            raise FrameworkAnalysisError("Parser returned a non-character-boundary span")
        return {
            "type": node.type,
            "startIndex": offsets[start],
            "endIndex": offsets[end],
            "startPosition": {
                "row": node.start_point.row,
                "column": offsets[start] - offsets[line_starts[node.start_point.row]],
            },
            "endPosition": {
                "row": node.end_point.row,
                "column": offsets[end] - offsets[line_starts[node.end_point.row]],
            },
            "hasError": node.has_error,
            "isMissing": node.is_missing,
            "isNamed": node.is_named,
            "children": [],
        }

    result = encode(tree.root_node)
    pending = [(tree.root_node, result, 0)]
    count = 1
    while pending:
        node, output, depth = pending.pop()
        if depth > MAX_TREE_DEPTH:
            raise FrameworkAnalysisError("Syntax tree exceeds the analysis depth limit")
        for index, child in enumerate(node.children):
            count += 1
            if count > MAX_TREE_NODES:
                raise FrameworkAnalysisError("Syntax tree exceeds the analysis node limit")
            encoded = encode(child)
            output["children"].append({"field": node.field_name_for_child(index), "node": encoded})
            pending.append((child, encoded, depth + 1))
    return result


def _source_identity(
    source: str, relative_path: str, language: str, *, check_credentials: bool = True
) -> bytes:
    if not isinstance(source, str) or not isinstance(relative_path, str):
        raise FrameworkAnalysisError("Source and relative path must be text")
    try:
        raw, path_bytes = source.encode("utf-8"), relative_path.encode("utf-8")
    except UnicodeError as exc:
        raise FrameworkAnalysisError("Source identity is not valid Unicode") from exc
    if (
        not path_bytes
        or len(path_bytes) > 2048
        or any(part in {"", ".", ".."} for part in relative_path.split("/"))
        or "\\" in relative_path
        or ":" in relative_path
        or any(ord(char) < 32 or ord(char) == 127 for char in relative_path)
    ):
        raise FrameworkAnalysisError("Evidence requires a canonical project-relative source path")
    if redact_secrets(relative_path) != relative_path:
        raise FrameworkAnalysisError(f"Credential-shaped source path: {redact_secrets(relative_path)}")
    if not isinstance(language, str) or language not in {"typescript", "tsx"}:
        raise FrameworkAnalysisError("Framework analysis supports TypeScript and TSX only")
    if len(raw) > MAX_SOURCE_BYTES:
        raise FrameworkAnalysisError("Source exceeds the analysis byte limit")
    redacted = redact_secrets(source) if check_credentials else source
    if redacted != source:
        first_difference = next(
            (index for index, (original, safe) in enumerate(zip(source, redacted)) if original != safe),
            min(len(source), len(redacted)),
        )
        line = source.count("\n", 0, first_difference) + 1
        safe_path = redact_secrets(relative_path)
        raise FrameworkAnalysisError(
            f"Cannot retain exact semantic source: credential-shaped content in {safe_path}:{line}; "
            "remove the inline credential or explicitly exclude the file"
        )
    return raw


def make_document(source: str, relative_path: str, language: str = "typescript") -> dict:
    # Only this preprocessing step may receive original credential-shaped text.
    # The Node worker and persisted validators still reject unredacted input.
    _source_identity(source, relative_path, language, check_credentials=False)
    try:
        source, redaction = redact_source_credentials(source, language)
    except ValueError as exc:
        raise FrameworkAnalysisError(
            f"Cannot safely redact source {redact_secrets(relative_path)}: {exc}"
        ) from exc
    raw = _source_identity(source, relative_path, language)
    document = {
        "source": source,
        "sourceHash": hashlib.sha256(raw).hexdigest(),
        "relativePath": relative_path,
        "language": language,
        "tree": serialize_tree(source, language),
    }
    if redaction is not None:
        document["redaction"] = redaction
    return document


def _node_environment() -> dict[str, str]:
    # Ambient preload hooks must not execute code during source-only analysis.
    return {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in {"NODE_OPTIONS", "NODE_PATH"}
    }


def _worker_path() -> Path:
    worker = Path(__file__).with_name("semantic_node") / "worker.mjs"
    if not worker.is_file():
        raise FrameworkAnalysisError(
            "Bundled framework analyzer is missing; build graphify/semantic_node with npm ci and npm run build"
        )
    return worker


def analysis_fingerprint(*, options: AnalysisOptions | dict | None = None) -> str:
    """Build-state identity; changes force deterministic reanalysis, not model work."""
    from graphify import framework_config, rcfile
    from graphify.framework_evidence import canonical_json

    configuration = _options({} if options is None else options)
    digest = hashlib.sha256(b"graphify.framework-analysis.v1\0")
    config_source = Path(framework_config.__file__)
    for label, path in (
        (b"worker\0", _worker_path()),
        (b"bridge\0", Path(__file__)),
        (b"configuration-source\0", config_source),
        (b"configuration-reader\0", Path(rcfile.__file__)),
        (b"module-catalog\0", config_source.with_name("semantic_node") / "module_catalog.json"),
        (b"source-admission\0", Path(__file__).with_name("extract.py")),
        (b"source-identity\0", Path(__file__).with_name("build.py")),
        (b"evidence-lifecycle\0", Path(__file__).with_name("framework_pipeline.py")),
        (b"refresh-policy\0", Path(__file__).with_name("watch.py")),
        (b"source-redaction\0", Path(__file__).with_name("security.py")),
        (b"source-reader\0", Path(__file__).parent / "extractors" / "base.py"),
    ):
        content = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(128 * 1024), b""):
                content.update(block)
        digest.update(label + content.digest())
    digest.update(
        b"parser\0"
        + json.dumps(parser_descriptor(), sort_keys=True, separators=(",", ":")).encode("utf-8")
    )
    digest.update(b"configuration\0" + canonical_json(configuration).encode("utf-8"))
    return digest.hexdigest()


def options_for_root(root: Path) -> AnalysisOptions:
    """Return the explicit source-identity assumptions for this corpus root."""
    from graphify.rcfile import load_graphifyrc

    try:
        configuration = load_graphifyrc(Path(root))
        aliases = configuration.get("semantic_module_aliases", {})
        return _options({"moduleAliases": aliases})
    except (OSError, ValueError, UnicodeError) as exc:
        raise FrameworkAnalysisError("Cannot read valid framework analysis configuration") from exc


_JSON_STRING_CHUNK_CHARS = 4096
# Each CST edge adds a children array, a field/node object, and a node object.
_JSON_MAX_DEPTH = 3 * MAX_TREE_DEPTH + 8


def _encode_json(value, maximum: int) -> bytes:
    """Stream compact UTF-8 JSON without propagating tokens through ancestors."""
    if type(maximum) is not int or maximum < 0:
        raise FrameworkAnalysisError("Invalid framework analysis request byte limit")
    encoded = bytearray()
    encode_string = json.encoder.encode_basestring
    stack = []
    active = set()

    def write(block: bytes) -> None:
        if len(block) > maximum - len(encoded):
            raise OverflowError
        encoded.extend(block)

    def write_string(text: str) -> None:
        size = str.__len__(text)
        if size + 2 > maximum - len(encoded):
            raise OverflowError
        if size <= _JSON_STRING_CHUNK_CHARS:
            write(encode_string(text).encode("utf-8"))
            return
        # Bound scratch space even when escaping or UTF-8 expands a huge string.
        write(b'"')
        for start in range(0, size, _JSON_STRING_CHUNK_CHARS):
            chunk = str.__getitem__(text, slice(start, start + _JSON_STRING_CHUNK_CHARS))
            write(encode_string(chunk)[1:-1].encode("utf-8"))
        write(b'"')

    def number(item) -> str:
        if isinstance(item, int):
            # Decimal output needs at least one byte per four bits.
            if int.bit_length(item) > 4 * (maximum - len(encoded)):
                raise OverflowError
            return int.__repr__(item)
        text = float.__repr__(item)
        if text in {"nan", "inf", "-inf"}:
            raise ValueError
        return text

    try:
        while True:
            if isinstance(value, str):
                write_string(value)
            elif value is None:
                write(b"null")
            elif value is True:
                write(b"true")
            elif value is False:
                write(b"false")
            elif isinstance(value, (int, float)):
                write(number(value).encode("ascii"))
            elif isinstance(value, (dict, list, tuple)):
                marker = id(value)
                if marker in active:
                    raise ValueError
                if len(stack) >= _JSON_MAX_DEPTH:
                    raise RecursionError
                mapping = isinstance(value, dict)
                write(b"{" if mapping else b"[")
                iterator = iter(value.items()) if mapping else iter(value)
                stack.append([iterator, marker, mapping, True])
                active.add(marker)
            else:
                raise TypeError

            while stack:
                frame = stack[-1]
                iterator, marker, mapping, first = frame
                try:
                    item = next(iterator)
                except StopIteration:
                    stack.pop()
                    active.remove(marker)
                    write(b"}" if mapping else b"]")
                    continue
                if first:
                    frame[3] = False
                else:
                    write(b",")
                if mapping:
                    key, value = item
                    if not isinstance(key, str):
                        if key is None:
                            key = "null"
                        elif key is True:
                            key = "true"
                        elif key is False:
                            key = "false"
                        elif isinstance(key, (int, float)):
                            key = number(key)
                        else:
                            raise TypeError
                    write_string(key)
                    write(b":")
                else:
                    value = item
                break
            else:
                return bytes(encoded)
    except OverflowError:
        raise FrameworkAnalysisError("Framework analysis request exceeds its byte limit") from None
    except RecursionError:
        raise FrameworkAnalysisError("Framework analysis request exceeds its depth limit") from None
    except Exception:
        # Encoder and user-defined container errors must not echo source values.
        raise FrameworkAnalysisError(
            "Framework analysis request is not bounded valid JSON"
        ) from None


def _options(value) -> AnalysisOptions:
    from graphify.framework_config import normalize_analysis_options
    from graphify.framework_evidence import ANNOTATION_LIMITS

    if type(value) is not dict:
        raise FrameworkAnalysisError("Framework analysis options must be an object")
    try:
        # The development Node oracle retains its original eight-plugin protocol.
        normalized = normalize_analysis_options(value, max_limits={**ANNOTATION_LIMITS, "maxPlugins": 8})
    except (TypeError, ValueError) as exc:
        raise FrameworkAnalysisError("Invalid framework analysis options") from exc
    if normalized["limits"]["maxPlugins"] < len(PRODUCERS):
        raise FrameworkAnalysisError("Framework analysis requires all seven producers")
    _encode_json(normalized, MAX_OPTIONS_BYTES)
    return normalized


def _node_executable(environment: dict[str, str]) -> str:
    if os.name == "nt":
        # Do not let Windows' implicit cwd search or PATHEXT choose a .cmd shim.
        candidates = (
            Path(entry.strip('"')) / "node.exe" for entry in os.get_exec_path(environment) if entry
        )
        node = next((str(path.resolve()) for path in candidates if path.is_file()), None)
    else:
        node = shutil.which("node", path=environment.get("PATH", os.defpath))
    if not node:
        raise FrameworkAnalysisError(
            "TypeScript framework analysis requires Node.js 20 or newer on PATH"
        )
    return str(Path(node).resolve())


def _run_process(
    command: list[str],
    encoded: bytes,
    *,
    environment: dict[str, str],
    cwd: Path,
    timeout: float,
    stdout_limit: int,
    stderr_limit: int,
) -> tuple[int, bytes, bytes]:
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(cwd),
            env=environment,
            shell=False,
            bufsize=0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise FrameworkAnalysisError("Could not launch the bundled Node analyzer") from exc
    stdin, stdout, stderr = process.stdin, process.stdout, process.stderr
    assert stdin is not None and stdout is not None and stderr is not None
    outputs = [bytearray(), bytearray()]
    overflow = threading.Event()
    errors: list[Exception] = []

    def kill() -> None:
        try:
            if process.poll() is None:
                process.kill()
        except OSError as exc:
            errors.append(exc)

    def read_pipe(stream, target: bytearray, maximum: int) -> None:
        try:
            while block := stream.read(min(64 * 1024, maximum + 1)):
                if len(target) + len(block) > maximum:
                    overflow.set()
                    kill()
                    break
                target.extend(block)
        except (OSError, ValueError) as exc:
            errors.append(exc)
            kill()
        finally:
            stream.close()

    def write_input() -> None:
        try:
            data = memoryview(encoded)
            while data:
                written = stdin.write(data[: 64 * 1024])
                if not written:
                    raise OSError("Incomplete request write")
                data = data[written:]
        except (OSError, ValueError) as exc:
            errors.append(exc)
            kill()
        finally:
            stdin.close()

    threads = [
        threading.Thread(
            target=read_pipe,
            args=(stdout, outputs[0], stdout_limit),
            name="graphify-node-stdout",
            daemon=True,
        ),
        threading.Thread(
            target=read_pipe,
            args=(stderr, outputs[1], stderr_limit),
            name="graphify-node-stderr",
            daemon=True,
        ),
        threading.Thread(target=write_input, name="graphify-node-stdin", daemon=True),
    ]
    expired = False
    try:
        for thread in threads:
            thread.start()
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        expired = True
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        errors.append(exc)
    finally:
        kill()
        try:
            process.wait(timeout=5)
        except (OSError, subprocess.SubprocessError) as exc:
            errors.append(exc)
        for thread in threads:
            if thread.ident is not None:
                thread.join(timeout=1)
        for stream in (stdin, stdout, stderr):
            stream.close()
        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=1)
    if expired:
        raise FrameworkAnalysisError(
            "Framework analysis timed out; no partial response was accepted"
        )
    if overflow.is_set():
        raise FrameworkAnalysisError("Framework analyzer exceeded its output limit")
    if errors or any(thread.is_alive() for thread in threads):
        raise FrameworkAnalysisError("Framework analyzer transport did not complete")
    return process.returncode, bytes(outputs[0]), bytes(outputs[1])


def _run_worker(request: dict, *, timeout: float = 120.0) -> dict:
    if type(timeout) not in (int, float) or not 0 < timeout <= 1800:
        raise FrameworkAnalysisError("Invalid framework analysis timeout")
    if type(request) is not dict or set(request) - {"version", "parser", "documents", "options"}:
        raise FrameworkAnalysisError("Invalid framework request envelope")
    if "options" in request:
        _options(request["options"])
    encoded = _encode_json(request, MAX_REQUEST_BYTES)
    environment = _node_environment()
    node, worker = _node_executable(environment), _worker_path()
    deadline = time.monotonic() + timeout
    code, stdout, _stderr = _run_process(
        [node, "--version"],
        b"",
        environment=environment,
        cwd=worker.parent,
        timeout=min(10.0, timeout),
        stdout_limit=256,
        stderr_limit=4096,
    )
    match = re.fullmatch(rb"v(\d+)\.\d+\.\d+\s*", stdout)
    if code or not match or int(match[1]) < 20:
        raise FrameworkAnalysisError("TypeScript framework analysis requires Node.js 20 or newer")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise FrameworkAnalysisError(
            "Framework analysis timed out; no partial response was accepted"
        )
    code, stdout, stderr = _run_process(
        [node, str(worker)],
        encoded,
        environment=environment,
        cwd=worker.parent,
        timeout=remaining,
        stdout_limit=MAX_RESPONSE_BYTES,
        stderr_limit=MAX_STDERR_BYTES,
    )
    if code:
        detail = redact_secrets(stderr.decode("utf-8", errors="replace"))[:4096]
        raise FrameworkAnalysisError(f"Framework analyzer failed: {detail}")
    try:

        def reject_constant(value):
            raise ValueError("Non-JSON numeric constant")

        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("Duplicate JSON key")
                result[key] = value
            return result

        result = json.loads(
            stdout.decode("utf-8"),
            parse_constant=reject_constant,
            parse_float=reject_constant,
            object_pairs_hook=unique_object,
        )
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise FrameworkAnalysisError("Framework analyzer returned an invalid response") from exc
    if not isinstance(result, dict):
        raise FrameworkAnalysisError("Framework analyzer returned a non-object response")
    return result


def _document_metrics(document: dict) -> tuple[int, int, int]:
    fields = {
        "source",
        "sourceHash",
        "relativePath",
        "language",
        "tree",
    }
    if type(document) is not dict or not fields <= set(document) or set(document) - fields - {"redaction"}:
        raise FrameworkAnalysisError("Invalid framework source document")
    raw = _source_identity(document["source"], document["relativePath"], document["language"])
    if hashlib.sha256(raw).hexdigest() != document["sourceHash"]:
        raise FrameworkAnalysisError("Framework source hash does not match the exact snapshot")
    if "redaction" in document:
        from graphify.framework_evidence import validate_redaction
        validate_redaction(document["source"], document["redaction"])
    pending, seen = [(document["tree"], 0)], set()
    fields = {
        "type",
        "startIndex",
        "endIndex",
        "startPosition",
        "endPosition",
        "hasError",
        "isMissing",
        "isNamed",
        "children",
    }
    while pending:
        node, depth = pending.pop()
        if type(node) is not dict or set(node) != fields or id(node) in seen:
            raise FrameworkAnalysisError("Invalid, shared or cyclic serialized syntax node")
        seen.add(id(node))
        if len(seen) > MAX_TREE_NODES or depth > MAX_TREE_DEPTH:
            raise FrameworkAnalysisError(
                "Serialized syntax exceeds the per-document node or depth limit"
            )
        children = node["children"]
        if type(children) is not list or len(children) > MAX_TREE_NODES:
            raise FrameworkAnalysisError("Invalid serialized syntax children")
        if len(seen) + len(pending) + len(children) > MAX_TREE_NODES:
            raise FrameworkAnalysisError("Serialized syntax exceeds the per-document node limit")
        for child in children:
            if type(child) is not dict or set(child) != {"field", "node"}:
                raise FrameworkAnalysisError("Invalid serialized syntax child")
            pending.append((child["node"], depth + 1))
    return len(raw), len(seen), len(_encode_json(document, MAX_REQUEST_BYTES))


def _validated_store_metrics(store: dict) -> tuple[int, int]:
    """Measure an already validated fragment without re-walking prior batches.

    The C encoder is safe here: the fragment has already passed the bounded
    persisted-store validator. Account for canonical HTML/line escaping too.
    """
    encoded = json.dumps(store, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    size = len(encoded.encode("utf-8"))
    size += 5 * sum(encoded.count(char) for char in ("<", ">", "&"))
    size += 3 * sum(encoded.count(char) for char in ("\u2028", "\u2029"))
    work = 0
    pending = [store]
    while pending:
        item = pending.pop()
        work += 1
        if isinstance(item, dict):
            work += len(item)  # Canonical JSON visits each key as well as its value.
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    return size, work


class _EvidenceAccumulator:
    """Assemble disjoint, validated source batches with global budget checks."""

    def __init__(self):
        from graphify.framework_evidence import EvidenceLimits
        self.limits = EvidenceLimits()
        self.store = None
        self.size = 0
        self.work = 0
        self.header_size = 0
        self.header_work = 0

    def append(self, fragment: dict) -> None:
        size, work = _validated_store_metrics(fragment)
        if self.store is None:
            header = {**fragment, "documents": {}}
            self.header_size, self.header_work = _validated_store_metrics(header)
            candidate_size, candidate_work = size, work
            candidate_count = len(fragment["documents"])
        else:
            if (
                fragment["version"] != self.store["version"]
                or fragment["manifests"] != self.store["manifests"]
                or fragment["producers"] != self.store["producers"]
            ):
                raise FrameworkAnalysisError("Framework analyzer changed during the batch sequence")
            if self.store["documents"].keys() & fragment["documents"].keys():
                raise FrameworkAnalysisError("Duplicate source in framework evidence batches")
            comma = int(bool(self.store["documents"]) and bool(fragment["documents"]))
            candidate_size = self.size + size - self.header_size + comma
            candidate_work = self.work + work - self.header_work
            candidate_count = len(self.store["documents"]) + len(fragment["documents"])
        if (
            candidate_size > self.limits.max_store_bytes
            or candidate_work > self.limits.max_work
            or candidate_count > self.limits.max_documents
        ):
            raise FrameworkAnalysisError("Framework evidence corpus exceeds its aggregate limit")
        self.size, self.work = candidate_size, candidate_work
        if self.store is None:
            self.store = {**fragment, "documents": dict(fragment["documents"])}
        else:
            self.store["documents"].update(fragment["documents"])

    def finish(self):
        from graphify.framework_evidence import validate_store
        if self.store is None:
            raise FrameworkAnalysisError("No framework evidence batch was produced")
        return validate_store(self.store, limits=self.limits)


def analyze_documents(
    documents: list[dict], *, options: AnalysisOptions | dict | None = None, timeout: float = 120.0
) -> EvidenceStore:
    """Preflight the corpus, then bound each Node probe-plus-batch by timeout."""
    from graphify.framework_evidence import (
        EvidenceValidationError,
        canonical_json,
        validate_payload,
        validate_store,
    )

    if type(documents) is not list:
        raise FrameworkAnalysisError("Framework documents must be a list")
    if type(timeout) not in (int, float) or not 0 < timeout <= 1800:
        raise FrameworkAnalysisError("Invalid framework analysis timeout")
    configuration = _options({} if options is None else options)
    parser = parser_descriptor()
    parser_digest = hashlib.sha256(canonical_json(parser).encode("utf-8")).hexdigest()
    limits = configuration["limits"]
    assumptions = {"moduleAliases": configuration["moduleAliases"]}
    base = {"version": 1, "parser": parser, "documents": [], "options": configuration}
    overhead = len(_encode_json(base, MAX_REQUEST_BYTES))
    metrics, seen = [], set()
    for document in documents:
        size, nodes, wire = _document_metrics(document)
        if document["relativePath"] in seen:
            raise FrameworkAnalysisError("Duplicate source in framework analysis request")
        seen.add(document["relativePath"])
        if (
            size > limits["maxSourceBytes"]
            or size > MAX_BATCH_SOURCE_BYTES
            or nodes > MAX_BATCH_TREE_NODES
            or overhead + wire > MAX_REQUEST_BYTES
        ):
            raise FrameworkAnalysisError(
                "One source document cannot fit the framework request limits"
            )
        metrics.append((size, nodes, wire))
    accumulator, analysis_id = _EvidenceAccumulator(), None

    def dispatch(items: list[dict]) -> EvidenceStore:
        nonlocal analysis_id
        # Original-file digests and transformation records stay with the trusted
        # caller; the analyzer receives only sanitized text, syntax and hashes.
        worker_items = [
            {key: value for key, value in item.items() if key != "redaction"}
            if "redaction" in item else item for item in items
        ]
        payload = _run_worker({**base, "documents": worker_items}, timeout=timeout)
        try:
            incoming = validate_payload(payload)
        except EvidenceValidationError as exc:
            raise FrameworkAnalysisError("Framework analyzer returned invalid evidence") from exc
        if any("redaction" in entry for entry in incoming["documents"].values()):
            raise FrameworkAnalysisError("Framework analyzer cannot author source redaction provenance")
        manifest = payload["manifest"]
        if (
            manifest["parserDigest"] != parser_digest
            or manifest["limits"] != limits
            or {plugin["id"] for plugin in manifest["plugins"]} != PRODUCERS
            or payload["producer"]["id"] != "graphify.frameworks"
            or payload["producer"]["version"] != "1"
            or payload["producer"]["configuration"] != assumptions
        ):
            raise FrameworkAnalysisError(
                "Framework analyzer changed the requested analysis contract"
            )
        if analysis_id is not None and manifest["id"] != analysis_id:
            raise FrameworkAnalysisError("Framework analyzer changed during the batch sequence")
        analysis_id = manifest["id"]
        expected = {item["relativePath"]: item for item in items}
        actual = incoming["documents"]
        if set(actual) != set(expected):
            raise FrameworkAnalysisError("Framework analyzer changed the admitted source set")
        for path, entry in actual.items():
            item = expected[path]
            if (
                entry["source"] != item["source"]
                or entry["result"]["sourceHash"] != item["sourceHash"]
                or entry["result"]["language"] != item["language"]
            ):
                raise FrameworkAnalysisError(
                    "Framework analyzer changed an admitted source snapshot"
                )
            if "redaction" in item:
                entry["redaction"] = item["redaction"]
        return validate_store(incoming) if any("redaction" in item for item in items) else incoming

    batch: list[dict] = []
    source_bytes, tree_nodes, wire_bytes = 0, 0, overhead
    for document, (size, nodes, wire) in zip(documents, metrics, strict=True):
        if batch and (
            len(batch) >= MAX_BATCH_DOCUMENTS
            or source_bytes + size > MAX_BATCH_SOURCE_BYTES
            or tree_nodes + nodes > MAX_BATCH_TREE_NODES
            or wire_bytes + 1 + wire > MAX_REQUEST_BYTES
        ):
            incoming = dispatch(batch)
            accumulator.append(incoming)
            batch, source_bytes, tree_nodes, wire_bytes = [], 0, 0, overhead
        wire_bytes += wire + bool(batch)
        batch.append(document)
        source_bytes += size
        tree_nodes += nodes
    if batch or accumulator.store is None:
        incoming = dispatch(batch)
        accumulator.append(incoming)
    return accumulator.finish()


def analyze_paths(paths: list[Path], root: Path) -> EvidenceStore | None:
    """Analyze only supplied, already-admitted files; never expand the corpus."""
    import sys
    from time import monotonic
    from graphify.build import _prune_identity
    from graphify.rcfile import effective_suffix

    selected = [(Path(path), effective_suffix(Path(path))) for path in paths]
    selected = [(path, suffix) for path, suffix in selected if suffix in SUPPORTED_SUFFIXES]
    if not selected:
        return None
    try:
        base = Path(root).resolve()
    except (OSError, RuntimeError) as exc:
        raise FrameworkAnalysisError("Cannot resolve framework source root") from exc
    configuration = options_for_root(base)
    implementation = analysis_fingerprint(options=configuration)
    snapshots: list[tuple[Path, str]] = []
    seen: set[str] = set()
    admitted: list[tuple[Path, str, str]] = []
    for path, suffix in selected:
        # Input paths keep normal cwd semantics. Resolve only the root alias,
        # never an in-corpus file alias, and do not guess alternate file paths.
        path = Path(os.path.abspath(path))
        identity = _prune_identity(str(path), str(base))
        try:
            if not isinstance(identity, str):
                raise ValueError("Missing source identity")
            relative = Path(identity).relative_to(base).as_posix()
        except ValueError as exc:
            raise FrameworkAnalysisError("Framework source is outside the admitted root") from exc
        identity_key = os.path.normcase(identity)
        if identity_key in seen:
            continue
        seen.add(identity_key)
        admitted.append((path, relative, suffix))
    accumulator = _EvidenceAccumulator()
    if len(admitted) > accumulator.limits.max_documents:
        raise FrameworkAnalysisError("Framework source count exceeds its corpus limit")
    total, completed = len(admitted), 0
    started = monotonic()
    print(f"[graphify frameworks] Starting source analysis for {total} files (no model calls).", file=sys.stderr, flush=True)
    documents: list[dict] = []
    source_bytes, tree_nodes = 0, 0

    def flush_batch() -> None:
        nonlocal documents, source_bytes, tree_nodes, completed
        if not documents:
            return
        print(
            f"[graphify frameworks] Analyzing {len(documents)} files; {completed}/{total} processed.",
            file=sys.stderr, flush=True,
        )
        accumulator.append(analyze_documents(documents, options=configuration))
        completed += len(documents)
        documents, source_bytes, tree_nodes = [], 0, 0
        print(
            f"[graphify frameworks] {completed}/{total} processed ({monotonic() - started:.1f}s).",
            file=sys.stderr, flush=True,
        )

    for index, (path, relative, suffix) in enumerate(admitted, 1):
        if index == 1 or index % 25 == 0:
            print(f"[graphify frameworks] Preparing source {index}/{total}.", file=sys.stderr, flush=True)
        try:
            with path.open("rb") as stream:
                raw = stream.read(MAX_SOURCE_BYTES + 1)
            if len(raw) > MAX_SOURCE_BYTES:
                raise FrameworkAnalysisError(f"Framework source exceeds byte limit: {relative}")
            source = raw.decode("utf-8")
        except (OSError, UnicodeError) as exc:
            raise FrameworkAnalysisError(
                f"Cannot capture exact semantic source: {relative}"
            ) from exc
        document = make_document(source, relative, "tsx" if suffix == ".tsx" else "typescript")
        pending = [document["tree"]]
        nodes = 0
        while pending:
            node = pending.pop()
            nodes += 1
            pending.extend(child["node"] for child in node["children"])
        if documents and (
            len(documents) >= MAX_BATCH_DOCUMENTS
            or source_bytes + len(raw) > MAX_BATCH_SOURCE_BYTES
            or tree_nodes + nodes > MAX_BATCH_TREE_NODES
        ):
            flush_batch()
        documents.append(document)
        source_bytes += len(raw)
        tree_nodes += nodes
        snapshots.append((path, hashlib.sha256(raw).hexdigest()))
    flush_batch()
    print(f"[graphify frameworks] Validating final evidence for {total} files.", file=sys.stderr, flush=True)
    result = accumulator.finish()
    if options_for_root(base) != configuration:
        raise FrameworkAnalysisError(
            "Framework configuration changed during analysis; retry indexing"
        )
    if analysis_fingerprint(options=configuration) != implementation:
        raise FrameworkAnalysisError(
            "Framework implementation changed during analysis; retry indexing"
        )
    for path, expected_hash in snapshots:
        try:
            with path.open("rb") as stream:
                current = stream.read(MAX_SOURCE_BYTES + 1)
        except OSError as exc:
            raise FrameworkAnalysisError(
                "Source became unreadable during framework analysis; retry indexing"
            ) from exc
        if hashlib.sha256(current).hexdigest() != expected_hash:
            raise FrameworkAnalysisError("Source changed during framework analysis; retry indexing")
    print(
        f"[graphify frameworks] Source evidence ready for {total} files ({monotonic() - started:.1f}s).",
        file=sys.stderr, flush=True,
    )
    return result
