"""Lossless evidence transport through Graphify's structural graph pipeline."""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from graphify.framework_evidence import (
    SEMANTIC_EVIDENCE_KEY,
    EvidenceLimits,
    EvidenceStore,
    EvidenceValidationError,
    merge_evidence,
    validate_store,
)

KEY = SEMANTIC_EVIDENCE_KEY


def evidence_from_data(data: dict, *, limits: EvidenceLimits | None = None) -> EvidenceStore | None:
    """Accept extraction's top-level input or graph metadata, never null/ambiguous authority."""
    if type(data) is not dict:
        raise EvidenceValidationError("Evidence container must be a JSON object")
    metadata = data.get("graph")
    top_present = KEY in data
    nested_present = type(metadata) is dict and KEY in metadata
    if not top_present and not nested_present:
        return None
    if "graph" in data and type(metadata) is not dict:
        raise EvidenceValidationError("Evidence graph metadata must be a JSON object")
    top = validate_store(data[KEY], limits=limits) if top_present else None
    nested = None
    if nested_present and isinstance(metadata, dict):
        nested = top if top_present and data[KEY] is metadata[KEY] else validate_store(metadata[KEY], limits=limits)
    if top_present and nested_present and top != nested:
        raise EvidenceValidationError("Conflicting semantic evidence containers")
    return top if top_present else nested


def evidence_is_complete(store: EvidenceStore | None) -> bool:
    """Coverage predicate for an already validated snapshot, without revalidation."""
    return all(
        not entry.get("refreshFailed")
        and entry["result"]["state"] in {"complete", "not-applicable"}
        and not entry["result"]["diagnostics"]
        and all(report["state"] in {"complete", "not-applicable"} and not report["diagnostics"]
                for report in entry["result"]["reports"])
        for entry in (store or {}).get("documents", {}).values()
    )


def _source_paths(values: Iterable[str | Path], limits: EvidenceLimits) -> list[str]:
    """Validate a bounded source inventory without granting mutation authority."""
    if isinstance(values, (str, bytes, dict)) or not isinstance(values, Iterable):
        raise EvidenceValidationError("Expected an explicit source collection")
    paths = []
    for count, path in enumerate(values, 1):
        if count > limits.max_documents:
            raise EvidenceValidationError("Source ownership limit exceeded")
        if not isinstance(path, (str, Path)) or not str(path):
            raise EvidenceValidationError("Invalid source ownership path")
        spelling = str(path).replace("\\", "/")
        if any(ord(char) < 32 or ord(char) == 127 for char in spelling):
            raise EvidenceValidationError("Invalid source ownership path")
        paths.append(spelling)
    return paths


def _owned_sources(
    values: Iterable[str | Path],
    known: set[str],
    root: str | Path | None,
    limits: EvidenceLimits,
) -> set[str]:
    """Map explicit ownership to exact stored paths, not resolved source targets.

    Only a scan-root alias is resolved. A symlink *inside* that root remains an
    independent corpus entry. Unrelated structural sources cannot authorize a
    change to this store, so outside-root/unmatched paths have no effect.
    """
    from graphify.build import _is_abs, _prune_identity

    inventory = _source_paths(values, limits)
    identity_to_paths: dict[str, set[str]] = {}
    for path in known:
        identity = _prune_identity(path, str(root) if root is not None else None)
        if identity is not None:
            identity_to_paths.setdefault(os.path.normcase(identity), set()).add(path)
    owned: set[str] = set()
    for spelling in inventory:
        if spelling in known:
            owned.add(spelling)
            continue
        identity = _prune_identity(spelling, str(root) if root is not None else None)
        matches = (
            identity_to_paths.get(os.path.normcase(identity), set())
            if identity is not None
            else set()
        )
        if len(matches) > 1:
            raise EvidenceValidationError("Ambiguous source ownership alias")
        if not matches and _is_abs(spelling) and any(spelling.endswith("/" + key) for key in known):
            raise EvidenceValidationError(
                "Source ownership is outside the evidence root; pass root explicitly"
            )
        owned.update(matches)
    return owned


def combine_evidence(
    chunks: Iterable[dict],
    *,
    previous: Any = None,
    root: str | Path | None = None,
    replaced_sources: Iterable[str | Path] = (),
    deleted_sources: Iterable[str | Path] = (),
    failed_sources: Iterable[str | Path] = (),
    limits: EvidenceLimits | None = None,
) -> EvidenceStore | None:
    """Combine source-owned batches; absence is not deletion or a successful refresh.

    Different snapshots for the same path within one batch are an error, not a
    last-writer-wins choice. Explicit refreshes without corresponding evidence
    are failed even when another chunk carries an older snapshot for that path.
    Replacement/failure takes precedence over a simultaneous structural prune.
    When both the previous store and root are absent, validated snapshots keep
    their own corpus-local keys; absolute success inventory cannot rebind them.
    Explicit mutation directives still require exact ownership.
    """
    limits = limits or EvidenceLimits()
    prior = validate_store(previous, limits=limits) if previous is not None else None
    incoming: EvidenceStore | None = None
    ownership: list[tuple[dict, set[str]]] = []
    for chunk in chunks:
        store = evidence_from_data(chunk, limits=limits)
        if store is not None:
            incoming = store if incoming is None else merge_evidence(incoming, store, limits=limits)
        ownership.append((chunk, set(store["documents"]) if store is not None else set()))
    if prior is None and incoming is None:
        return None
    fresh = set(incoming["documents"]) if incoming is not None else set()
    known = fresh | (set(prior["documents"]) if prior is not None else set())

    def paths(values: Iterable[str | Path]) -> set[str]:
        return _owned_sources(values, known, root, limits)

    def refreshed_paths(values: Iterable[str | Path], produced: set[str]) -> set[str]:
        if prior is None and root is None and produced:
            from graphify.build import _is_abs

            # Fresh snapshots already own their canonical corpus-local keys.
            # Absolute dispatch inventory cannot rebind those keys without a
            # root, and is not a request to mutate a previous evidence store.
            # Keep relative hints: they can identify missing cross-chunk output.
            values = [path for path in _source_paths(values, limits) if not _is_abs(path)]
        return paths(values)

    replaced = paths(replaced_sources)
    failed = paths(failed_sources)
    missing: set[str] = set()
    explicit_ownership = bool(replaced_sources) or any(
        chunk.get("extracted_sources") for chunk, _ in ownership
    )
    for chunk, produced in ownership:
        extracted = refreshed_paths(chunk.get("extracted_sources", ()), produced)
        if not explicit_ownership:
            from graphify.build import _fold_node_aliases, _is_ast_tier

            node_sources: set[str] = set()
            for node in chunk.get("nodes", ()):
                if isinstance(node, dict) and _is_ast_tier(node):
                    normalized = dict(node)
                    _fold_node_aliases(normalized)
                    source = normalized.get("source_file")
                    if source:
                        if not isinstance(source, (str, Path)):
                            raise EvidenceValidationError("Invalid AST source ownership")
                        node_sources.add(str(source))
            extracted.update(refreshed_paths(node_sources, produced))
        replaced.update(extracted)
        failed.update(paths(chunk.get("failed_sources", ())))
        missing.update(extracted - produced)
    missing.update(replaced - fresh)
    failed.update(missing)
    # A persisted snapshot may arrive as a carried chunk instead of ``previous``.
    # Preserve its complete record before a different AST-only chunk marks that
    # source stale; otherwise a later partial refresh could lose the last good copy.
    carried = (missing & fresh) - (set(prior["documents"]) if prior is not None else set())
    if carried and incoming is not None:
        prior = merge_evidence(
            prior,
            {
                "version": 1,
                "manifests": incoming["manifests"],
                "producers": incoming["producers"],
                "documents": {path: incoming["documents"][path] for path in carried},
            },
            limits=limits,
        )
    replaced.update(fresh)
    deleted = paths(deleted_sources) - replaced - failed
    if prior is None and not deleted and not failed:
        return incoming
    return merge_evidence(
        prior,
        incoming,
        replaced_sources=replaced,
        deleted_sources=deleted,
        failed_sources=failed,
        limits=limits,
    )


def pack_raw_evidence(data: dict) -> EvidenceStore | None:
    """Canonicalize at persistence: graph.semantic_evidence is the sole output slot."""
    store = evidence_from_data(data)
    if store is not None:
        data["graph"] = {**data.get("graph", {}), KEY: store}
        data.pop(KEY, None)
    return store


def prune_evidence(data: dict, sources: Iterable[str], *, root=None) -> None:
    store = evidence_from_data(data)
    if store is None:
        return
    updated = combine_evidence([], previous=store, root=root, deleted_sources=sources)
    data["graph"] = {**data.get("graph", {}), KEY: updated}
    data.pop(KEY, None)
