"""Return the text of a Markdown section straight from its source file.

A heading node records the line its heading sits on. The section it opens is
found at read time from the current file: it runs to the line before the next
heading of the same or a shallower level, so it includes its subsections. The
boundary is never stored, so an edit inside a section cannot make it stale, and
graphs built before this module existed work unchanged.

Heading detection reuses the Markdown extractor's own rules (ATX headings,
CommonMark fences, leading frontmatter), so what counts as a heading here is
exactly what the extractor turned into a node.

Examples use their recorded whole-fence range and redacted span hash. A stale
or inaccessible example returns its indexed preview, never a guessed new span.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from graphify.extractors.base import _read_source_text
from graphify.extractors.markdown import (
    _MD_ATX_CLOSING_RE,
    _MD_ATX_HEADING_RE,
    _fence_closes,
    _fence_open,
    _split_frontmatter,
)
from graphify.security import redact_secrets, sanitize_label

DEFAULT_MAX_CHARS = 8000

# The suffixes the extractor dispatches to extract_markdown.
_MARKDOWN_SUFFIXES = frozenset({".md", ".mdx", ".qmd", ".skill"})
_LINE_RE = re.compile(r"^L(\d+)$")
# Control characters other than tab, so a section keeps its line layout while a
# document cannot push terminal escapes or fake log lines into a model's context.
_BODY_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


@dataclass(frozen=True)
class Section:
    source_file: str
    start: int
    end: int
    text: str
    truncated: bool
    moved: bool
    note: str = ""


def _headings(lines: list[str]) -> list[tuple[int, int, str]]:
    """``(line, level, title)`` for every heading the extractor would emit."""
    _, body_start = _split_frontmatter(lines)
    out: list[tuple[int, int, str]] = []
    fence = None
    # Like the extractor, track fences from the first line, frontmatter included.
    for i, text in enumerate(lines):
        if fence is not None:
            if _fence_closes(text, fence):
                fence = None
            continue
        opened = _fence_open(text)
        if opened is not None:
            fence = opened
            continue
        if i < body_start:
            continue
        m = _MD_ATX_HEADING_RE.match(text)
        title = _MD_ATX_CLOSING_RE.sub("", m.group(2).strip()) if m else ""
        if m and title:
            out.append((i + 1, len(m.group(1)), title))
    return out


def _resolve_inside(source_file: str, root: Path) -> "Path | None":
    """The file ``source_file`` names, or None when it falls outside ``root``."""
    candidate = Path(source_file)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve()
        resolved.relative_to(root.resolve())
    except (OSError, RuntimeError, ValueError):
        return None
    return resolved


def section_root(gp: Path) -> Path:
    """The project root section reads are confined to, for the graph at ``gp``.

    For a graph in ``<project>/graphify-out`` a ``.graphify_root`` marker may
    only narrow the root to a folder inside the project, never widen it, so a
    committed marker cannot open the rest of the disk to reads.
    """
    from graphify.paths import GRAPHIFY_OUT, graph_root_for

    root = graph_root_for(gp)
    out = Path(GRAPHIFY_OUT).parts
    if out and not Path(GRAPHIFY_OUT).is_absolute() and gp.parent.parts[-len(out):] == out:
        project = gp.parent.parents[len(out) - 1]
        try:
            root.resolve().relative_to(project.resolve())
        except (OSError, RuntimeError, ValueError):
            return project
    return root


def is_section_node(node: dict) -> bool:
    kind = node.get("node_kind")
    suffix = Path(str(node.get("source_file") or "")).suffix.lower()
    return kind in ("heading", "page", "code_example") and suffix in _MARKDOWN_SUFFIXES


def read_section(node: dict, root: Path,
                 max_chars: int = DEFAULT_MAX_CHARS) -> "tuple[Section | None, str]":
    """Read a heading/page or indexed example. ``(section, "")`` or ``(None, reason)``."""
    label = str(node.get("label") or "")
    source_file = str(node.get("source_file") or "")
    max_chars = max(1, max_chars)
    if not is_section_node(node):
        return None, (f"'{sanitize_label(redact_secrets(label))}' is not a Markdown heading, page or example. "
                      "get_section reads Markdown sections only.")

    example = node.get("node_kind") == "code_example"
    attrs = node.get("attributes")
    attrs = attrs if isinstance(attrs, dict) else {}
    m = _LINE_RE.match(str(node.get("source_location") or "").strip())
    recorded = int(m.group(1)) if m else 0
    start, end = attrs.get("start_line"), attrs.get("end_line")
    valid_span = (type(start) is int and type(end) is int
                  and 0 < start <= end and recorded == start)

    def unavailable(reason: str) -> "tuple[Section | None, str]":
        if not example:
            return None, reason
        preview = attrs.get("preview")
        note = "Indexed preview; source stale/unavailable."
        if not isinstance(preview, str):
            preview = ""
            note += " No stored preview is available."
        note += f" {reason}"
        preview = redact_secrets(_BODY_CONTROL_RE.sub("", preview.replace("\r\n", "\n").replace("\r", "\n")))
        return Section(
            sanitize_label(redact_secrets(source_file)), recorded,
            end if valid_span else recorded, preview[:max_chars],
            len(preview) > max_chars, False, note,
        ), ""

    if node.get("repo"):
        if example:
            return unavailable("Source belongs to a merged multi-repo graph; read it from that repo's own graph.")
        return unavailable(f"'{sanitize_label(redact_secrets(label))}' comes from a merged multi-repo graph. "
                           "Read it from that repo's own graph.")
    path = _resolve_inside(source_file, root)
    if path is None:
        if example:
            return unavailable("Source is outside the project; no source file was read.")
        return unavailable(f"Refusing to read '{sanitize_label(redact_secrets(source_file))}': it is outside the project.")
    try:
        lines = _read_source_text(path, warn=False).splitlines()
    except (OSError, UnicodeError) as exc:
        if example:
            return unavailable(f"Could not read current source ({type(exc).__name__}); run `graphify update .`.")
        return unavailable(f"Could not read {sanitize_label(redact_secrets(source_file))}: "
                           f"{sanitize_label(redact_secrets(str(exc)))}")

    if example:
        if not valid_span or end > len(lines):
            return unavailable("The indexed fence range is no longer available; run `graphify update .`.")
        enclosing = None
        for line in lines[:start - 1]:
            if enclosing is None:
                enclosing = _fence_open(line)
            elif _fence_closes(line, enclosing):
                enclosing = None
        fence = _fence_open(lines[start - 1])
        closing = next((i + 1 for i in range(start, len(lines))
                        if fence is not None and _fence_closes(lines[i], fence)), len(lines))
        body = redact_secrets("\n".join(lines[start - 1:end]))
        if (enclosing is not None or fence is None or closing != end
                or hashlib.sha256(body.encode("utf-8")).hexdigest() != attrs.get("span_hash")):
            return unavailable("The indexed fence changed or cannot be verified; run `graphify update .`.")
        # Markdown is not masked by _read_source_text (only TS/TSX is). Redact
        # the whole fence before hashing or truncating its displayed text.
        body = redact_secrets(_BODY_CONTROL_RE.sub("", body))
        return Section(sanitize_label(redact_secrets(source_file)), start, end,
                       body[:max_chars], len(body) > max_chars, False), ""

    moved = False
    if node.get("node_kind") == "page":
        _, body_start = _split_frontmatter(lines)
        start, end = body_start + 1, len(lines)
    else:
        heads = _headings(lines)
        same = [h for h in heads
                if h[2] == label or sanitize_label(h[2]) == sanitize_label(label)]
        exact = [h for h in same if h[0] == recorded]
        # The recorded line wins. A heading that moved is followed only when its
        # title is unique in the file; with several, guessing could return the
        # wrong one.
        hit = exact[0] if exact else same[0] if len(same) == 1 else None
        if hit is None:
            return None, (f"'{label}' is no longer at line {recorded} of {source_file}. "
                          "Run `graphify update .` to refresh the graph.")
        moved = hit[0] != recorded
        start, level = hit[0], hit[1]
        end = next((ln - 1 for ln, lv, _ in heads if ln > start and lv <= level), len(lines))
    while end > start and not lines[end - 1].strip():
        end -= 1
    if end < start:
        return None, f"{source_file} has no text for '{label}'."
    body = "\n".join(_BODY_CONTROL_RE.sub("", ln) for ln in lines[start - 1:end])
    body = redact_secrets(body)
    truncated = len(body) > max_chars
    if truncated:
        body = body[:max_chars]
    return Section(sanitize_label(redact_secrets(source_file)), start, end, body, truncated, moved), ""


def format_section(section: Section, label: str) -> str:
    label = sanitize_label(redact_secrets(label))
    source_file = sanitize_label(redact_secrets(section.source_file))
    span = f"L{section.start}-L{section.end}" if section.start > 0 else "unknown span"
    header = f"Section: {label}  [{source_file}:{span}]"
    notes = []
    if section.note:
        notes.append(sanitize_label(redact_secrets(section.note)))
    if section.moved:
        notes.append("The heading moved since indexing; run `graphify update .` "
                     "to refresh the graph.")
    if section.truncated:
        notes.append("Truncated indexed preview; more stored text was omitted." if section.note else
                     f"Truncated; read {source_file} lines {section.start}-{section.end} for the rest.")
    return "\n".join([header, *(f"Note: {n}" for n in notes), "", section.text])


def resolve_section_query(G, query: str) -> "tuple[str | None, str]":
    """Resolve a heading/example label, node id or ``path::Heading`` to one section node.

    A code symbol that shares a heading's name must not shadow it, so a query
    that is ambiguous or lands on a non-section node is retried against the
    section nodes alone.
    """
    from graphify.serve import _resolve_single_node

    nid, err = _resolve_single_node(G, query)
    if nid is not None and is_section_node(G.nodes[nid]):
        return nid, ""
    sections = G.subgraph([n for n, d in G.nodes(data=True) if is_section_node(d)])
    sec_nid, _ = _resolve_single_node(sections, query)
    if sec_nid is not None:
        return sec_nid, ""
    return nid, err or ""
