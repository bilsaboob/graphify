"""Cross-file resolution of code-span mentions in Markdown documents.

``extract_markdown`` reports every inline code span that reads as a symbol
name (``Widget``, ``render()``, ``pkg.Widget``, ``src/mod.py::Widget::render``)
as a ``raw_calls`` entry tagged ``language: "markdown"`` instead of guessing a
target id: the symbol is defined in some other file, and only once every file
is extracted and the id-remap passes have run can the mention be matched to
the node that actually exists. Riding the ``raw_calls`` channel means those
passes rewrite the mention's ``caller_nid`` alongside every other raw call,
and the extraction cache round-trips it for free.

This resolver runs from the language-resolver registry (see
``resolver_registry``) with the merged corpus in hand and turns each mention
into a ``references`` edge from the heading (or page) that cites the symbol
to the code node that defines it:

* a path-qualified mention resolves against the cited file only. The file is
  matched by its path relative to the document, then as a segment-aligned
  suffix of a scanned file, and must be unique; the symbol chain is walked
  through ``contains`` / ``method`` edges so ``mod.py::Widget::render`` is
  the ``render`` owned by ``Widget``. The document names the file and the
  symbol verbatim, so the edge is EXTRACTED;
* a bare mention resolves only when exactly one callable or type in the
  corpus carries that label (case-sensitive; language built-ins excluded).
  Only nodes the extractors marked ``_callable`` qualify, for the reason the
  indirect-call pass gives (#1566): a by-name match must land on a real
  function, method or class, never on a same-named data symbol such as a
  JSON key. A dotted mention (``pkg.Widget``, ``Widget.render``) keeps its
  qualifiers, and a candidate survives only when every qualifier is a label
  on its ``contains`` / ``method`` owner chain or a segment (or stem) of its
  source path: ``time.sleep`` never lands on a repo's own ``sleep``, and
  ``Widget.render`` picks the ``render`` that ``Widget`` owns. No other
  tie-breaking: an ambiguous name is a guess, and a guess is not an edge.
  A bare, parenthesis-less method name is held to one more test: a word like
  ``redis`` is prose as often as it is a reference, so a method match survives
  only when the citing section also names the class that owns it (#4609).
  A bare free function name is held to the same test with its defining file in
  place of the owner class: prose-like words (``token``, ``raw``) require the
  citing section to cite that file or a symbol from it (#4804). Evidence is
  section-scoped. Classes, snake_case, camelCase, trailing ``()``, or PascalCase
  in export languages carry sufficient evidence on their own. Links to scanned
  source files also mint doc->file references edges.
  The match is INFERRED (0.95, a named cross-file reference).

An explicit relative cite (``./`` or ``../``) resolves against the document's
directory only; it never falls through to the suffix rule, so a path that
escapes the corpus cannot land on an unrelated copy of the file elsewhere.

The shared cross-file call pass in ``extract`` skips ``markdown`` raw calls,
so a mention never surfaces as a ``calls`` edge.
"""
from __future__ import annotations

import os
import re
from bisect import bisect_right
from pathlib import Path
from typing import Any

from graphify.extractors.base import (
    _LANGUAGE_BUILTIN_GLOBALS,
    active_scan_root as _active_scan_root,
)

MARKDOWN_MENTION_SUFFIXES = frozenset({".md", ".mdx", ".qmd", ".skill"})
DOCUMENTATION_EDGE_PRODUCER = "markdown-advisory-v1"

_CONTAINMENT_RELATIONS = frozenset({"contains", "method"})

#: Leading ``./`` and ``../`` segments of a cited path, stripped as whole
#: segments (``lstrip("./")`` would eat the dot of ``.github/...``).
_RELATIVE_PREFIX_RE = re.compile(r"^(\.\.?/)+")


def _symbol_label(node: dict[str, Any]) -> str:
    """A node's label as a document would write it: no ``()``, no leading dot."""
    return str(node.get("label", "")).strip("()").lstrip(".")


_CAMEL_CASE_RE = re.compile(r'[a-z][A-Z]')

# Languages where exported identifiers are PascalCase by convention (#4804).
_PASCAL_EXPORT_SUFFIXES = frozenset({
    ".go", ".cs", ".vb", ".swift", ".scala", ".pas", ".dpr", ".lpr",
    ".ps1", ".psm1",
})


def _is_prose_like_label(label: str) -> bool:
    """Whether a bare label looks like ordinary prose rather than a distinct code identifier.

    Distinct code identifiers — snake_case (containing ``_``) or camelCase (a
    lowercase letter followed by uppercase) — are exempt from the bare
    free-function evidence test (#4804), while plain single-word lowercase
    names (``token``, ``raw``, ``fail``, ``config``) require evidence. A
    PascalCase label is exempt only in a PascalCase-export language, checked
    by the caller against the target's source file.
    """
    return "_" not in label and not _CAMEL_CASE_RE.search(label)


def _is_pascal_case_export_language(source_file: str) -> bool:
    """Whether *source_file*'s language exports identifiers as PascalCase."""
    return os.path.splitext(_posix(source_file))[1].lower() in _PASCAL_EXPORT_SUFFIXES


def _is_file_node(node: dict[str, Any]) -> bool:
    label = str(node.get("label", ""))
    source_file = str(node.get("source_file", ""))
    return bool(source_file) and label == os.path.basename(source_file)


def _posix(path: str) -> str:
    return path.replace("\\", "/")


def _is_advisory_document(node: dict) -> bool:
    """Scope new enrichment to Markdown or explicitly enriched document records."""
    from graphify.detect import DOC_EXTENSIONS, PAPER_EXTENSIONS

    suffix = Path(_posix(str(node.get("source_file") or ""))).suffix.lower()
    return suffix == ".md" or (
        node.get("node_kind") in {"doc_concept", "doc_mention", "code_example"}
        and suffix in DOC_EXTENSIONS | PAPER_EXTENSIONS | MARKDOWN_MENTION_SUFFIXES | {".markdown"}
    )


def _match_cited_file(cited: str, doc_file: str, source_files: set[str]) -> str | None:
    """The scanned source file a ``path::Name`` mention names, or None.

    Tries the path relative to the citing document first (``../src/mod.py``
    from ``docs/guide.md``), then an exact match, then a unique
    segment-aligned suffix (``src/mod.py`` naming ``/repo/src/mod.py``). A
    cite that is explicitly relative (``./x`` or ``../x``) stops after the
    first step: it names one location, and a suffix match elsewhere would be a
    different file.
    """
    cited_posix = _posix(cited)
    doc_dir = os.path.dirname(doc_file)
    relative = _posix(os.path.normpath(os.path.join(doc_dir, cited_posix)))
    if relative in source_files:
        return relative
    if cited_posix.startswith(("./", "../")):
        return None
    if cited_posix in source_files:
        return cited_posix
    return _cited_file_suffix(cited_posix, source_files)


def _cited_file_suffix(cited_posix: str, source_files: set[str]) -> str | None:
    """The scanned file a normalized cite names by unique segment-aligned suffix."""
    stripped = _RELATIVE_PREFIX_RE.sub("", cited_posix)
    matches = [sf for sf in source_files
               if sf == stripped or sf.endswith("/" + stripped)]
    return matches[0] if len(matches) == 1 else None


def _match_cited_file_any_form(cited: str, doc_file: str,
                               source_files: set[str], *,
                               form_mismatch: bool,
                               scan_root: "Path | str | None" = None) -> str | None:
    """Resolve a cited file even when a partial rebuild mixes path forms.

    Preserved nodes carry project-relative ``source_file`` values while a
    freshly re-extracted document may carry an absolute one, so the
    document-relative join in :func:`_match_cited_file` can miss a file that is
    in the corpus. The suffix fallback fires only when that mixing is detected
    (an absolute citing document against a corpus with relative paths) — with
    uniform path forms the explicit-relative discipline above holds unchanged.
    The result licenses evidence and doc->file citations, both anchored to
    corpus files, so a unique corpus path that is a suffix of the joined path
    is the file the document's own directory tree names.
    """
    matched = _match_cited_file(cited, doc_file, source_files)
    if matched is not None:
        return matched
    root = _posix(str(scan_root)) if scan_root is not None else None
    if root is None:
        active = _active_scan_root()
        if active is not None:
            root = _posix(str(active))
    # Fresh Markdown can remain relative while unchanged code comes from an
    # absolute cache record. Compare the same anchored path, not a loose suffix.
    if root is not None and not os.path.isabs(doc_file):
        absolute_doc = _posix(os.path.normpath(os.path.join(root, doc_file)))
        matched = _match_cited_file(cited, absolute_doc, source_files)
        if matched is not None:
            return matched
    if not form_mismatch:
        return None
    joined = _posix(os.path.normpath(
        os.path.join(os.path.dirname(_posix(doc_file)), _posix(cited))))
    if root is not None:
        try:
            rel = _posix(os.path.relpath(joined, root))
        except ValueError:
            return None
        if rel.startswith("..") or os.path.isabs(rel):
            return None
        matches = [sf for sf in source_files if rel == sf or rel.endswith("/" + sf)]
        return matches[0] if len(matches) == 1 else None

    matches = []
    doc_posix = _posix(doc_file)
    for sf in source_files:
        if joined == sf:
            matches.append(sf)
        elif joined.endswith("/" + sf):
            prefix = joined[:-len(sf)]
            if prefix.endswith("/") and doc_posix.startswith(prefix):
                matches.append(sf)
    return matches[0] if len(matches) == 1 else None


def _match_file_link(cited: str, doc_file: str,
                     source_files: set[str], *,
                     form_mismatch: bool,
                     scan_root: "Path | str | None" = None) -> str | None:
    """Resolve an authored Markdown link to a source file strictly against its target."""
    doc_dir = os.path.dirname(_posix(doc_file))
    relative = _posix(os.path.normpath(os.path.join(doc_dir, _posix(cited))))
    if relative in source_files:
        return relative
    if not form_mismatch:
        return None
    root = _posix(str(scan_root)) if scan_root is not None else None
    if root is None:
        active = _active_scan_root()
        if active is not None:
            root = _posix(str(active))
    if root is not None:
        try:
            rel = _posix(os.path.relpath(relative, root))
        except ValueError:
            return None
        if not rel.startswith("..") and not os.path.isabs(rel) and rel in source_files:
            return rel
        return None
    matches = []
    doc_posix = _posix(doc_file)
    for sf in source_files:
        if relative == sf:
            matches.append(sf)
        elif relative.endswith("/" + sf):
            prefix = relative[:-len(sf)]
            if prefix.endswith("/") and doc_posix.startswith(prefix):
                matches.append(sf)
    return matches[0] if len(matches) == 1 else None


def _evidence(node_id: str, nodes_by_id: dict[str, dict[str, Any]],
              parents: dict[str, set[str]]) -> set[str]:
    """Labels a dotted mention may qualify ``node_id`` with.

    The labels of every node on its ``contains`` / ``method`` owner chain
    (``Widget`` for ``Widget.render``) plus each segment and stem of its
    source path (``pkg`` and ``mod`` for ``pkg.mod.Widget``).
    """
    evidence: set[str] = set()
    frontier = {node_id}
    seen: set[str] = set()
    while frontier:
        nid = frontier.pop()
        if nid in seen:
            continue
        seen.add(nid)
        owners = parents.get(nid, set())
        for owner in owners:
            node = nodes_by_id.get(owner)
            if node is not None:
                evidence.add(_symbol_label(node))
        frontier |= owners
    node = nodes_by_id.get(node_id, {})
    for segment in _posix(str(node.get("source_file", ""))).split("/"):
        if segment:
            evidence.add(segment)
            evidence.add(os.path.splitext(segment)[0])
    return evidence


def _markdown_raw_calls(per_file: list[dict]) -> list[dict]:
    calls: list[dict] = []
    for result in per_file:
        if not isinstance(result, dict):
            continue
        for rc in result.get("raw_calls", []) or []:
            if isinstance(rc, dict) and rc.get("language") == "markdown":
                calls.append(rc)
    return calls


def resolve_markdown_mentions(
    per_file: list[dict],
    all_nodes: list[dict],
    all_edges: list[dict],
    *,
    scan_root: "Path | str | None" = None,
) -> None:
    """Turn ``language: "markdown"`` raw calls into ``references`` edges in place."""
    mentions = _markdown_raw_calls(per_file)
    if not mentions:
        return

    root = scan_root or _active_scan_root()

    code_nodes = [
        n for n in all_nodes
        if n.get("id") and n.get("file_type") == "code" and not _is_file_node(n)
    ]
    by_label: dict[str, list[str]] = {}
    by_file: dict[str, dict[str, list[str]]] = {}
    for n in code_nodes:
        label = _symbol_label(n)
        if not label:
            continue
        if n.get("_callable"):
            by_label.setdefault(label, []).append(n["id"])
        source_file = _posix(str(n.get("source_file", "")))
        if source_file:
            by_file.setdefault(source_file, {}).setdefault(label, []).append(n["id"])
    source_files = set(by_file)
    symbol_has_relative_paths = any(not os.path.isabs(sf) for sf in source_files)

    parents: dict[str, set[str]] = {}
    for e in all_edges:
        if e.get("relation") in _CONTAINMENT_RELATIONS:
            parents.setdefault(str(e.get("target")), set()).add(str(e.get("source")))
    nodes_by_id = {n["id"]: n for n in all_nodes if n.get("id")}
    node_ids = set(nodes_by_id)
    existing = {
        (e.get("source"), e.get("target"))
        for e in all_edges if e.get("relation") == "references"
    }

    def _resolve_chain(file_labels: dict[str, list[str]], names: list[str]) -> str | None:
        candidates = list(file_labels.get(names[-1], []))
        for depth, owner_name in enumerate(reversed(names[:-1]), start=1):
            owners = set(file_labels.get(owner_name, []))
            narrowed = []
            for c in candidates:
                chain = {c}
                for _ in range(depth):
                    chain = {p for nid in chain for p in parents.get(nid, ())}
                if chain & owners:
                    narrowed.append(c)
            candidates = narrowed
        return candidates[0] if len(candidates) == 1 else None

    def _target(rc: dict) -> tuple[str | None, str, float]:
        """The node a mention resolves to, plus the confidence of that match."""
        names = list(rc.get("qualifiers") or []) + [str(rc.get("callee", "")).strip()]
        cited = rc.get("path")
        if cited:
            doc_file = _posix(str(rc.get("source_file", "")))
            source_file = _match_cited_file_any_form(
                str(cited), doc_file, source_files,
                form_mismatch=os.path.isabs(doc_file) and symbol_has_relative_paths,
                scan_root=root,
            )
            if source_file is None:
                return None, "EXTRACTED", 1.0
            return _resolve_chain(by_file[source_file], names), "EXTRACTED", 1.0
        callee = names[-1]
        # Only skip a *bare* builtin-named mention (no qualifier). A dotted
        # mention like `Repository.open` carries qualifier evidence that proves
        # the reference, so it must not be discarded just because `open` is a
        # language builtin.
        if len(names) == 1 and callee in _LANGUAGE_BUILTIN_GLOBALS:
            return None, "INFERRED", 0.95
        qualifiers = set(names[:-1])
        ns_chain = bool(rc.get("ns_qualified"))
        by_name = by_label.get(callee, [])
        candidates = [
            c for c in by_name
            if qualifiers <= _evidence(c, nodes_by_id, parents)
        ]
        if not candidates and ns_chain:
            # A PSR-4 namespace root (`App\`) maps to the scan directory and has
            # no path segment, so when no candidate accounts for the whole chain,
            # the leading qualifiers a candidate cannot account for are dropped
            # (#4610). Only then: a qualifier that does match a candidate keeps
            # discriminating (`Mailer::send()` still picks the right `send`).
            def _dropped(c: str) -> bool:
                evidence = _evidence(c, nodes_by_id, parents)
                wanted = list(names[:-1])
                while wanted and wanted[0] not in evidence:
                    wanted.pop(0)
                return set(wanted) <= evidence

            candidates = [c for c in by_name if _dropped(c)]
        return (candidates[0] if len(candidates) == 1 else None), "INFERRED", 0.95

    def _method_owner(node_id: str) -> str | None:
        """The class that owns *node_id*, when it is a method and not a function."""
        for parent in parents.get(node_id, ()):
            node = nodes_by_id.get(parent)
            if node is not None and node.get("_callable_class"):
                return parent
        return None

    def _section_chain(caller: str) -> set[str]:
        """*caller* (a heading or page) plus every heading enclosing it.

        A citation recorded under a heading licenses bare mentions in that
        heading's own section and every section nested inside it; a sibling
        section is not covered (#4804).
        """
        chain = {caller}
        frontier = [caller]
        while frontier:
            nid = frontier.pop()
            for p in parents.get(nid, ()):
                if p not in chain:
                    chain.add(p)
                    frontier.append(p)
        return chain

    #: Targets already cited by each caller (heading or page), used as
    #: section-scoped evidence in passes 2b and 2c.
    cited_targets: dict[str, set[str]] = {}

    # Files cited via file spans, path-qualified mentions, or links (#4804).
    code_file_nodes = {
        _posix(str(n.get("source_file"))): n["id"]
        for n in all_nodes
        if n.get("id") and n.get("file_type") == "code"
        and n.get("source_file") and _is_file_node(n)
    }
    citable_files = set(code_file_nodes)
    # Detect path mixing in partial rebuilds (absolute doc vs relative corpus).
    corpus_has_relative_paths = any(not os.path.isabs(sf) for sf in citable_files)
    cited_files: dict[str, set[str]] = {}
    for rc in mentions:
        cited = rc.get("path")
        if not cited:
            continue
        caller = str(rc.get("evidence_owner") or rc.get("caller_nid", ""))
        if not caller:
            continue
        doc = _posix(str(rc.get("source_file", "")))
        if rc.get("file_link") and not rc.get("wikilink"):
            source_file = _match_file_link(
                str(cited), doc, citable_files,
                form_mismatch=os.path.isabs(doc) and corpus_has_relative_paths,
                scan_root=root,
            )
        else:
            source_file = _match_cited_file_any_form(
                str(cited), doc, citable_files,
                form_mismatch=os.path.isabs(doc) and corpus_has_relative_paths,
                scan_root=root,
            )
        if source_file is not None:
            cited_files.setdefault(caller, set()).add(source_file)

    # Mint page --references--> file edges for links to scanned files (#4804).
    for rc in mentions:
        if not rc.get("file_link"):
            continue
        caller = str(rc.get("caller_nid", ""))
        cited = str(rc.get("path") or "")
        if not caller or caller not in node_ids or not cited:
            continue
        doc = _posix(str(rc.get("source_file", "")))
        if rc.get("wikilink"):
            target_file = _match_cited_file_any_form(
                cited, doc, citable_files,
                form_mismatch=os.path.isabs(doc) and corpus_has_relative_paths,
                scan_root=root,
            )
        else:
            target_file = _match_file_link(
                cited, doc, citable_files,
                form_mismatch=os.path.isabs(doc) and corpus_has_relative_paths,
                scan_root=root,
            )
        target = code_file_nodes.get(target_file) if target_file else None
        if target is None or target == caller or (caller, target) in existing:
            continue
        existing.add((caller, target))
        all_edges.append({
            "source": caller,
            "target": target,
            "relation": "references",
            "context": rc.get("context", ""),
            "confidence": "EXTRACTED",
            "confidence_score": 1.0,
            "source_file": rc.get("source_file", ""),
            "source_location": rc.get("source_location"),
            "weight": 1.0,
        })

    def _add(rc: dict, target: str | None, confidence: str, score: float) -> None:
        caller = str(rc.get("caller_nid", ""))
        if target is None or target == caller:
            return
        if (caller, target) in existing:
            # Retain target as section-scoped citation evidence (#4609, #4804).
            cited_targets.setdefault(caller, set()).add(target)
            return
        existing.add((caller, target))
        all_edges.append({
            "source": caller,
            "target": target,
            "relation": "references",
            "context": rc.get("context", ""),
            "confidence": confidence,
            "confidence_score": score,
            "source_file": rc.get("source_file", ""),
            "source_location": rc.get("source_location"),
            "weight": 1.0,
        })
        cited_targets.setdefault(caller, set()).add(target)

    # Pass 1: explicit evidence resolves directly (path, dotted chain, or trailing ()).
    bare: list[dict] = []
    for rc in mentions:
        caller = str(rc.get("caller_nid", ""))
        callee = str(rc.get("callee", "")).strip()
        if not caller or not callee or caller not in node_ids:
            continue
        names = list(rc.get("qualifiers") or []) + [callee]
        span = str(rc.get("context") or "")
        if rc.get("path") or len(names) > 1 or "(" in span:
            _add(rc, *_target(rc))
        else:
            bare.append(rc)

    # Pass 2a: classes and distinct identifiers (snake_case, camelCase, export PascalCase).
    method_mentions: list[tuple[dict, str, str, float]] = []
    function_mentions: list[tuple[dict, str, str, float]] = []
    for rc in bare:
        target, confidence, score = _target(rc)
        if target is None:
            continue
        if nodes_by_id.get(target, {}).get("_callable_class"):
            _add(rc, target, confidence, score)
        elif _method_owner(target) is not None:
            method_mentions.append((rc, target, confidence, score))
        else:
            label = _symbol_label(nodes_by_id[target])
            if label[:1].isupper():
                prose_like = not _is_pascal_case_export_language(
                    nodes_by_id[target].get("source_file", ""))
            else:
                prose_like = _is_prose_like_label(label)
            if prose_like:
                function_mentions.append((rc, target, confidence, score))
            else:
                _add(rc, target, confidence, score)

    # Pass 2b: bare method mentions require the owner class to be cited (#4609).
    for rc, target, confidence, score in method_mentions:
        chain = _section_chain(str(rc.get("caller_nid", "")))
        cited = {t for c in chain for t in cited_targets.get(c, ())}
        if _method_owner(target) in cited:
            _add(rc, target, confidence, score)

    # Pass 2c: bare prose-like free function names require defining file or symbol evidence (#4804).
    for rc, target, confidence, score in function_mentions:
        target_file = _posix(str(nodes_by_id.get(target, {}).get("source_file") or ""))
        if not target_file:
            continue
        chain = _section_chain(str(rc.get("caller_nid", "")))
        cited = {t for c in chain for t in cited_targets.get(c, ())}
        if target_file in {f for c in chain for f in cited_files.get(c, ())} or any(
            _posix(str(nodes_by_id.get(t, {}).get("source_file") or "")) == target_file
            for t in cited
        ):
            _add(rc, target, confidence, score)


def enrich_documentation(
    nodes: list[dict], edges: list[dict], *, root: str | Path | None = None,
) -> None:
    """Refresh advisory documentation links against final, already indexed IDs.

    Source hints are never replaced with bindings. Only document-owned attributes
    and this producer's edges change; callers must discard generated edges before
    graph coalescing as well. A pair already carrying independent evidence wins,
    with the blocked candidate retained on its document instead. No source IO or
    transitive propagation of documentary claims takes place here.
    """
    from graphify.detect import DOC_EXTENSIONS, PAPER_EXTENSIONS
    from graphify.extractors.markdown import _code_span_mention
    from graphify.security import redact_secrets, sanitize_label

    edges[:] = [e for e in edges if e.get("_generated_by") != DOCUMENTATION_EDGE_PRODUCER]
    by_id = {n["id"]: n for n in nodes if n.get("id")}

    def source_key(value: Any) -> str:
        value = _posix(str(value or ""))
        if not value:
            return ""
        if root is not None and os.path.isabs(value):
            try:
                value = os.path.relpath(value, str(root))
            except ValueError:
                pass
        return _posix(os.path.normpath(value))

    sources = {nid: source_key(n.get("source_file")) for nid, n in by_id.items()}
    doc_suffixes = DOC_EXTENSIONS | PAPER_EXTENSIONS | {".markdown"}
    docs = {nid: n for nid, n in by_id.items() if _is_advisory_document(n)}
    doc_files = {sources[nid] for nid in docs}
    if not docs:
        return

    def attrs(node: dict) -> dict:
        value = node.get("attributes")
        return value if isinstance(value, dict) else {}

    def normal(value: Any) -> str:
        return " ".join(str(value or "").casefold().split())

    def line(value: Any) -> int:
        match = re.match(r"^(?:L)?([1-9][0-9]*)(?:\b|:)", str(value or ""))
        return int(match[1]) if match else 0

    def roles(value: Any) -> set[str]:
        found = set(re.findall(r"\b(?:producer|consumer|documentation|example)\b", normal(value)))
        return found & {"producer", "consumer"} or found

    def reason(value: str) -> str:
        return sanitize_label(redact_secrets(value))[:200]

    for node in docs.values():
        # Copy the attribute mapping: a caller can share it with an original row.
        node["attributes"] = dict(attrs(node))
        for key in ("code_resolution", "code_candidates", "section_resolution", "concept_candidates"):
            node["attributes"].pop(key, None)

    concepts = {nid for nid, n in docs.items()
                if n.get("node_kind") == "doc_concept"
                or (n.get("file_type") == "concept" and not n.get("node_kind"))}
    mentions = {nid for nid, n in docs.items()
                if n.get("node_kind") == "doc_mention"
                or (n.get("file_type") == "code" and not _is_file_node(n)
                    and n.get("node_kind") not in {"page", "heading", "doc_concept", "code_example"})}
    # File nodes are eligible only for an explicit original-ID hint below, not
    # for ordinary label matching. Legacy paper/Markdown stubs are never code.
    doc_code_suffixes = MARKDOWN_MENTION_SUFFIXES | PAPER_EXTENSIONS | {".markdown"}
    indexed_code = {nid: n for nid, n in by_id.items()
                    if nid not in docs and n.get("file_type") == "code" and sources[nid]
                    and Path(sources[nid]).suffix.lower() not in doc_code_suffixes
                    and not n.get("external") and n.get("type") != "external"
                    and n.get("node_kind") not in {"page", "heading", "doc_mention", "doc_concept", "code_example"}}
    code = {nid: n for nid, n in indexed_code.items() if not _is_file_node(n) and n.get("node_kind") != "file"}
    labels: dict[str, list[str]] = {}
    file_suffixes: dict[str, set[str]] = {}
    for nid in sorted(code):
        labels.setdefault(_symbol_label(code[nid]), []).append(nid)
    code_files = {sources[nid] for nid in code}
    for source in code_files:
        parts = source.split("/")
        for offset in range(len(parts)):
            file_suffixes.setdefault("/".join(parts[offset:]), set()).add(source)

    parents: dict[str, set[str]] = {}
    section_parents: dict[str, set[str]] = {}
    participant_roles: dict[str, set[str]] = {}
    claims: dict[str, list[tuple[str, dict]]] = {}
    doc_links: set[frozenset[str]] = set()
    code_targets: dict[str, set[str]] = {}
    # Reserve reverse pairs too: some publication paths still use a simple Graph.
    occupied = {frozenset((e.get("source"), e.get("target"))) for e in edges}
    for edge in edges:
        src, dst = edge.get("source"), edge.get("target")
        relation = edge.get("relation")
        if relation in _CONTAINMENT_RELATIONS:
            if src in by_id and dst in by_id and src not in docs and dst not in docs:
                parents.setdefault(dst, set()).add(src)
            if src in docs and dst in docs and sources[src] == sources[dst]:
                section_parents.setdefault(dst, set()).add(src)
        if src in docs and dst in code and relation == "references":
            code_targets.setdefault(src, set()).add(dst)
        if dst in docs and src in code and relation == "references":
            code_targets.setdefault(dst, set()).add(src)
        if src not in docs or dst not in docs:
            continue
        if relation == "references" and sources[src] != sources[dst]:
            doc_links.add(frozenset((sources[src], sources[dst])))
        edge_roles = roles(edge.get("context")) | roles(edge.get("role"))
        for participant in ({src, dst} & mentions) or {dst}:
            participant_roles.setdefault(participant, set()).update(edge_roles)
        if relation not in _CONTAINMENT_RELATIONS:
            if src in concepts and dst in mentions:
                claims.setdefault(src, []).append((dst, edge))
            if dst in concepts and src in mentions:
                claims.setdefault(dst, []).append((src, edge))

    def add_edge(src: str, dst: str, relation: str, context: str, confidence: str,
                 match_reason: str, site: dict, *, location: Any = None,
                 score: float = 0.75) -> bool:
        pair = frozenset((src, dst))
        if src == dst or pair in occupied:
            return False
        occupied.add(pair)
        edges.append({
            "source": src, "target": dst, "relation": relation, "context": context,
            "confidence": confidence, "confidence_score": score, "weight": 1.0,
            "source_file": site.get("source_file", ""),
            "source_location": location if location is not None else site.get("source_location"),
            "match_reason": reason(match_reason),
            "_origin": site.get("_origin") or "semantic",
            "_generated_by": DOCUMENTATION_EDGE_PRODUCER,
        })
        return True

    pages: dict[str, list[str]] = {}
    headings: dict[tuple[str, str], list[str]] = {}
    heading_lines: dict[str, dict[int, list[str]]] = {}
    for nid, node in docs.items():
        sf = sources[nid]
        if node.get("node_kind") == "page":
            pages.setdefault(sf, []).append(nid)
        elif node.get("node_kind") == "heading":
            headings.setdefault((sf, normal(node.get("label"))), []).append(nid)
            at = line(node.get("source_location"))
            if at:
                heading_lines.setdefault(sf, {}).setdefault(at, []).append(nid)
    starts = {sf: sorted(lines) for sf, lines in heading_lines.items()}
    for nid in sorted(concepts | mentions | {nid for nid, n in docs.items()
                                          if n.get("node_kind") == "code_example"}):
        node = docs[nid]
        sf = sources[nid]
        section = attrs(node).get("section") or attrs(node).get("heading")
        locator = section if isinstance(section, dict) else {}
        section_source = locator.get("source_file")
        title = locator.get("heading") or locator.get("label")
        at = line(locator.get("source_location") or locator.get("start_line"))
        if isinstance(section, str):
            prefix, sep, heading = section.partition("::")
            if sep and Path(prefix).suffix.lower() in doc_suffixes:
                section_source, title = prefix, heading
            else:
                title = section
            title = title.lstrip("#").strip()
            at = line(title) if re.fullmatch(r"L[1-9][0-9]*(?::[0-9]+)?", title) else 0
            if at:
                title = None
        at = at or line(node.get("source_location")) or line(attrs(node).get("start_line"))
        positions = starts.get(sf, [])
        pos = bisect_right(positions, at) - 1
        located = (heading_lines[sf][positions[pos]] if pos >= 0 else [])
        candidates = headings.get((sf, normal(title)), []) if title else located
        if len(candidates) > 1 and len(located) == 1 and located[0] in candidates:
            candidates = located
        if not title and not at:
            candidates = [parent for parent in section_parents.get(nid, ())
                          if docs[parent].get("node_kind") == "heading"]
        if section_source and source_key(section_source) != sf:
            candidates = []
        target = candidates[0] if len(candidates) == 1 else None
        status = "section" if target else "page"
        if target is None and pages.get(sf):
            target = min(pages[sf])
        resolution = {"status": status if target else "unresolved", "source_file": node.get("source_file")}
        if target:
            resolution.update(target_id=target, source_location=docs[target].get("source_location"))
            add_edge(target, nid, "contains", "documentation", "INFERRED",
                     "document section" if status == "section" else "document page fallback", node)
        attrs(node)["section_resolution"] = resolution

    evidence_cache: dict[str, set[str]] = {}
    path_cache: dict[tuple[str, str], str | None] = {}
    match_cache: dict[tuple, tuple[list[str], str, bool]] = {}

    def candidates(hint: dict, sf: str) -> tuple[list[str], str, bool]:
        text = str(hint.get("text") or "").strip().strip("`")
        if hint.get("kind") == "id_collision":
            return ([text] if text in indexed_code else [], "weak original documentary ID match", True)
        parsed = _code_span_mention(text)
        # The inline grammar deliberately excludes constants. Persisted semantic
        # hints may name indexed fields too, so keep their simple name chains.
        cited, names = parsed if parsed is not None else (
            None, re.split(r"::|[.\\]", _symbol_label({"label": text})))
        cited = str(hint.get("path") or cited or "")
        qualifiers = hint.get("qualifiers") or []
        if isinstance(qualifiers, str):
            qualifiers = re.split(r"::|[.\\]", qualifiers)
        if not isinstance(qualifiers, (list, tuple)):
            qualifiers = [qualifiers]
        wanted = set(str(q) for q in qualifiers) | set(names[:-1])
        name = names[-1] if names else ""
        key = (name, tuple(sorted(wanted)), cited, sf if cited else "")
        if key in match_cache:
            return match_cache[key]
        found = labels.get(name, [])
        failures = []
        matched_file = None
        if cited:
            path_key = (sf, cited)
            if path_key not in path_cache:
                path = source_key(cited) if os.path.isabs(cited) else _posix(cited)
                joined = source_key(os.path.join(os.path.dirname(sf), path))
                pool = set(file_suffixes.get(_RELATIVE_PREFIX_RE.sub("", path), ()))
                pool.update(f for f in (joined, source_key(path)) if f in code_files)
                path_cache[path_key] = _match_cited_file_any_form(
                    path, sf, pool, form_mismatch=os.path.isabs(sf)
                    and any(not os.path.isabs(f) for f in pool), scan_root=root,
                )
            matched_file = path_cache[path_key]
            narrowed = [nid for nid in found if sources[nid] == matched_file]
            if narrowed:
                found = narrowed
            else:
                failures.append("path not matched")
        if wanted:
            for nid in found:
                if nid not in evidence_cache:
                    evidence_cache[nid] = _evidence(nid, by_id, parents)
            narrowed = [nid for nid in found if wanted <= evidence_cache[nid]]
            if narrowed:
                found = narrowed
            else:
                failures.append("qualifiers not matched")
        why = "weak name match; " + "; ".join(failures) if failures else "name match"
        if not failures:
            if matched_file:
                why += "; cited file"
            if wanted:
                why += "; owner/path qualifiers"
        result = (found, why, bool(failures))
        match_cache[key] = result
        return result

    hints: dict[str, list[dict]] = {}
    for nid, node in docs.items():
        value = attrs(node).get("code_hints")
        hints[nid] = [h for h in value if isinstance(h, dict) and h.get("text")] if isinstance(value, list) else []
        if nid in mentions and node.get("label") and (
            not hints[nid] or all(h.get("kind") == "id_collision" for h in hints[nid])
        ):
            hints[nid].insert(0, {"text": node["label"], "source_location": node.get("source_location")})

    for nid in sorted(docs):
        node = docs[nid]
        work = [(hint, node, None) for hint in hints[nid]]
        for mention, claim in claims.get(nid, []):
            work.extend((hint, docs[mention], claim) for hint in hints[mention])
        if not work:
            continue
        counts = {"matched": 0, "ambiguous": 0, "unresolved": 0}
        for hint, owner, claim in work:
            found, why, weak = candidates(hint, sources[owner["id"]])
            confidence = "AMBIGUOUS" if weak or len(found) > 1 else "INFERRED"
            counts["unresolved" if not found else "ambiguous" if confidence == "AMBIGUOUS" else "matched"] += 1
            site = owner
            location = hint.get("source_location") or owner.get("source_location")
            contexts = roles(hint.get("role")) | participant_roles.get(owner["id"], set())
            if claim is not None:
                site = dict(node)
                if source_key(claim.get("source_file")) in doc_files:
                    site["source_file"] = claim["source_file"]
                site["_origin"] = claim.get("_origin") or node.get("_origin") or "semantic"
                if source_key(site.get("source_file")) != sources[owner["id"]]:
                    location = node.get("source_location")
                location = claim.get("source_location") or location
                contexts = roles(claim.get("context")) | roles(claim.get("role")) or contexts
                why = f"documented {claim.get('relation', 'reference')} via mention; {why}"
            contexts = contexts & {"producer", "consumer"} or contexts
            contexts = contexts or {"example" if node.get("node_kind") == "code_example" else "documentation"}
            for target in found:
                code_targets.setdefault(nid, set()).add(target)
                for context in sorted(contexts):
                    if not add_edge(nid, target, "references", context, confidence, why, site,
                                    location=location, score=0.35 if weak else 0.5 if len(found) > 1 else 0.75):
                        detail = {"hint": hint["text"], "target_id": target,
                                  "confidence": confidence, "context": context,
                                  "source_file": site.get("source_file"), "source_location": location,
                                  "match_reason": reason(why)}
                        if claim is not None:
                            detail["via"] = owner["id"]
                        attrs(node).setdefault("code_candidates", []).append(detail)
        attrs(node)["code_resolution"] = counts

    buckets: dict[str, set[str]] = {}
    for nid in sorted(concepts):
        aliases = attrs(docs[nid]).get("aliases") or []
        if isinstance(aliases, str):
            aliases = [aliases]
        if not isinstance(aliases, list):
            aliases = []
        for label in [docs[nid].get("label"), *aliases]:
            key = normal(label) if isinstance(label, str) else ""
            if key:
                buckets.setdefault(key, set()).add(nid)
    paired: set[tuple[str, str]] = set()
    for key in sorted(buckets):
        by_source: dict[str, list[str]] = {}
        for nid in sorted(buckets[key]):
            by_source.setdefault(sources[nid], []).append(nid)
        groups = list(by_source.values())
        for offset, group in enumerate(groups):
            for other in groups[offset + 1:]:
                for left in group:
                    for right in other:
                        src, dst = sorted((left, right))
                        if (src, dst) in paired:
                            continue
                        paired.add((src, dst))
                        why = "shared full concept label/alias"
                        linked = frozenset((sources[src], sources[dst])) in doc_links
                        shared = bool(code_targets.get(src, set()) & code_targets.get(dst, set()))
                        if linked:
                            why += "; documented link"
                        if shared:
                            why += "; shared code candidate"
                        confidence = "INFERRED" if linked or shared else "AMBIGUOUS"
                        if not add_edge(src, dst, "conceptually_related_to", "documentation",
                                        confidence, why, docs[src], score=0.65 if linked or shared else 0.25):
                            attrs(docs[src]).setdefault("concept_candidates", []).append({
                                "target_id": dst, "confidence": confidence, "match_reason": reason(why),
                            })
