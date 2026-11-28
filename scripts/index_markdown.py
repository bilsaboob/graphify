"""Scoped Markdown enrichment for the local Bun runner, not a full index rebuild."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import stat
import sys
from datetime import date
from pathlib import Path


BUCKETS = ("nodes", "edges", "hyperedges")


def _plain_path(path: Path) -> bool:
    """Do not follow symlinks or Windows junctions, including output aliases."""
    try:
        if path.resolve() != path.absolute():
            return False
        info = path.lstat()
        return not (
            stat.S_ISLNK(info.st_mode)
            or getattr(info, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        )
    except FileNotFoundError:
        return True
    except (OSError, RuntimeError):
        return False


def _signature(path: Path) -> tuple | None:
    try:
        info = path.stat()
        return info.st_mtime_ns, info.st_size, info.st_dev, info.st_ino
    except FileNotFoundError:
        return None


def _documents(root: Path, out: Path) -> list[Path]:
    from graphify.detect import _is_noise_dir, _is_sensitive, ignored_predicate
    from graphify.watch import _read_build_excludes, _read_build_gitignore

    ignored = ignored_predicate(
        root,
        extra_excludes=_read_build_excludes(out),
        gitignore=_read_build_gitignore(out),
    )

    def admitted(path: Path, *, directory: bool = False) -> bool:
        parts = tuple(part.lower() for part in path.relative_to(root).parts)
        if parts[:2] == ("src", "libs") or "graphify-out" in parts:
            return False
        if not _plain_path(path):
            return False
        if directory and _is_noise_dir(path.name, path.parent):
            return False
        return not ignored(path) and not _is_sensitive(path)

    def walk_error(error: OSError) -> None:
        raise error

    files = []
    for parent, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        directory = Path(parent)
        dirs[:] = sorted(name for name in dirs if admitted(directory / name, directory=True))
        for name in names:
            path = directory / name
            if path.suffix.lower() == ".md" and admitted(path) and path.is_file():
                files.append(path)
    return sorted(files)


def _validate_records(data: dict, *, external_ids: set[str] | None = None,
                      allow_unresolved: bool = False) -> None:
    """Validate without building/deduplicating the saved code graph."""
    for bucket in BUCKETS:
        if not isinstance(data.get(bucket, []), list) or any(
            not isinstance(item, dict) for item in data.get(bucket, [])
        ):
            raise ValueError(f"Invalid {bucket}: expected a list of objects")
        if any(item.get("source_file") is not None and not isinstance(item["source_file"], str)
               for item in data.get(bucket, [])):
            raise ValueError(f"Invalid {bucket} source_file")
    ids: set[str] = set()
    for node in data.get("nodes", []):
        identity = node.get("id")
        if not isinstance(identity, str) or not identity or identity in ids:
            raise ValueError(f"Invalid or duplicate node id: {identity!r}")
        ids.add(identity)
    ids.update(external_ids or ())
    for edge in data.get("edges", []):
        if any(not isinstance(edge.get(key), str) or not edge[key]
               or (not allow_unresolved and edge[key] not in ids) for key in ("source", "target")):
            raise ValueError("Invalid or dangling edge endpoint")
    for hyperedge in data.get("hyperedges", []):
        members = hyperedge.get("nodes")
        if not isinstance(members, list) or any(not isinstance(n, str) or not n
                                               or (not allow_unresolved and n not in ids) for n in members):
            raise ValueError("Invalid or dangling hyperedge member")
        identity = hyperedge.get("id")
        # Native extraction preserves distinct group records from document
        # slices, even when their optional display IDs coincide. These are not
        # node IDs and must not be deduplicated or rejected by the scoped runner.
        if identity is not None and not isinstance(identity, str):
            raise ValueError("Invalid hyperedge id")


def _normalize_semantic_nodes(data: dict, *, code_ids: set[str] | None = None) -> None:
    """Normalize prepared, scoped semantic rows in place, never code records.

    Merge only compatible same-ID/source/label details; retain other variants
    and source-local endpoint alternatives without changing source ownership.
    """
    from graphify.build import _normalize_id

    def stable(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))

    def join(left, right, field=""):
        if stable(left) == stable(right) or right is None:
            return copy.deepcopy(left)
        if left is None:
            return copy.deepcopy(right)
        if isinstance(left, dict) and isinstance(right, dict):
            merged = copy.deepcopy(left)
            for key, value in right.items():
                merged[key] = join(merged.get(key), value, key)
            return merged
        if field in ("aliases", "code_hints") and isinstance(left, list) and isinstance(right, list):
            return sorted({stable(value): value for value in left + right}.values(), key=stable)
        raise ValueError("Distinct semantic metadata")

    def ambiguous(row, reason):
        prior = row.get("match_reason")
        row["match_reason"] = f"{prior}; {reason}" if prior else reason
        row["confidence"] = "AMBIGUOUS"
        score = row.get("confidence_score")
        row["confidence_score"] = min(score, 0.5) if isinstance(score, (int, float)) else 0.5

    labels = {}
    for node in data["nodes"]:
        nid, label = node.get("id"), node.get("label")
        if not isinstance(nid, str) or not _normalize_id(nid):
            raise ValueError("Invalid semantic node id")
        if isinstance(label, str) and label.strip():
            labels.setdefault((nid, node["source_file"]), set()).add(label)

    identities = {}
    for node in data["nodes"]:
        label = node.get("label")
        names = [label] if isinstance(label, str) and label.strip() else []
        if label is None or isinstance(label, str):
            names = names or sorted(labels.get((node["id"], node["source_file"]), ()))
        if not names:
            raise ValueError("Markdown extraction returned an invalid node label")
        for name in names:
            variant = {**node, "label": name}
            if len(names) > 1:
                ambiguous(variant, "Label inherited from ambiguous same-source ID siblings")
            key = node["id"], node["source_file"], name
            identities.setdefault(key, {})[stable(variant)] = variant

    groups = {}
    for (nid, _, _), records in sorted(identities.items()):
        variants = [records[key] for key in sorted(records)]
        merged = variants[0]
        try:
            for variant in variants[1:]:
                merged = join(merged, variant)
        except ValueError:
            pass  # Conflicting locations/claims remain separate, not last-writer-wins.
        else:
            variants = [merged]
        groups.setdefault(_normalize_id(nid), []).extend(variants)

    reserved = {_normalize_id(nid) for nid in code_ids or ()}
    occupied = set(groups) | reserved
    exact, normalized = {}, {}
    nodes = []
    for norm, variants in sorted(groups.items()):
        for node in variants:
            raw = node["id"]
            if len(variants) > 1 or norm in reserved:
                digest = hashlib.sha256(stable(node).encode("utf-8")).hexdigest()
                candidate = f"{norm}__doc_{digest[:16]}"
                while _normalize_id(candidate) in occupied:
                    candidate += "_" + digest[16:32]
                node["id"] = candidate
                occupied.add(_normalize_id(candidate))
                attrs = node.get("attributes")
                attrs = dict(attrs) if isinstance(attrs, dict) else ({"original_attributes": attrs} if attrs is not None else {})
                hints = attrs.get("code_hints", [])
                hint = {"text": raw, "source_location": node.get("source_location"), "kind": "id_collision"}
                if isinstance(hints, list):
                    attrs["code_hints"] = hints + ([hint] if hint not in hints else [])
                else:
                    attrs["original_code_hints"] = hints
                    attrs["code_hints"] = [hint]
                node["attributes"] = attrs
            nodes.append(node)
            # Cache replays retain original spellings as hints. They are lookup
            # candidates only, never authority to change another document's owner.
            spellings = {raw, node["id"]}
            attrs = node.get("attributes")
            hints = attrs.get("code_hints", []) if isinstance(attrs, dict) else []
            if isinstance(hints, list):
                spellings.update(h["text"] for h in hints if isinstance(h, dict)
                                 and h.get("kind") == "id_collision" and isinstance(h.get("text"), str))
            for spelling in spellings:
                for source in (node["source_file"], None):
                    exact.setdefault((source, spelling), set()).add(node["id"])
                    normalized.setdefault((source, _normalize_id(spelling)), set()).add(node["id"])
    data["nodes"] = sorted(nodes, key=lambda node: node["id"])

    def candidates(endpoint, source):
        if not isinstance(endpoint, str) or not endpoint:
            raise ValueError("Invalid semantic endpoint")
        norm = _normalize_id(endpoint)
        return sorted(exact.get((source, endpoint)) or exact.get((None, endpoint))
                      or normalized.get((source, norm)) or normalized.get((None, norm)) or {endpoint})

    edges = []
    for edge in data["edges"]:
        sources = candidates(edge.get("source"), edge["source_file"])
        targets = candidates(edge.get("target"), edge["source_file"])
        uncertain = [edge[key] for key, values in (("source", sources), ("target", targets)) if len(values) > 1]
        for source in sources:
            for target in targets:
                row = {**edge, "source": source, "target": target}
                for key, endpoint in (("_src", source), ("_tgt", target)):
                    if key in row:
                        row[key] = endpoint
                if uncertain:
                    ambiguous(row, "Ambiguous semantic endpoint(s): " + ", ".join(sorted(set(uncertain))))
                edges.append(row)
    data["edges"] = edges
    for group in data["hyperedges"]:
        if not isinstance(group.get("nodes"), list):
            raise ValueError("Invalid hyperedge members")
        members, uncertain = [], []
        for member in group["nodes"]:
            found = candidates(member, group["source_file"])
            members.extend(nid for nid in found if nid not in members)
            if len(found) > 1:
                uncertain.append(member)
        group["nodes"] = members
        if uncertain:
            ambiguous(group, "Ambiguous semantic endpoint(s): " + ", ".join(sorted(set(uncertain))))


def _scoped_result(result: dict, files: list[Path], root: Path, *, normalize_ids: bool = True,
                   code_ids: set[str] | None = None) -> dict:
    from graphify.cache import _semantic_source_matcher, scope_semantic_result
    from graphify.llm import _partial_source_files, prepare_markdown_semantics

    if not isinstance(result, dict):
        raise ValueError("Semantic extraction must return an object")
    for bucket in BUCKETS:
        if not isinstance(result.get(bucket, []), list) or any(
            not isinstance(item, dict) for item in result.get(bucket, [])
        ):
            raise ValueError(f"Invalid semantic {bucket}")
    partial = set(_partial_source_files(result)) | set(result.get("uncovered_files") or [])
    if result.get("partial") or (result.get("failed_chunks") and not partial):
        partial.update(str(path) for path in files)

    # No model-supplied evidence, graph metadata, or extraction ownership can
    # enter the typed/AST lane. Cache hits receive the same trust checks.
    fresh = {key: copy.deepcopy(result.get(key, [])) for key in BUCKETS}
    for key in BUCKETS:
        for item in fresh[key]:
            if item.get("source_file") is not None and not isinstance(item["source_file"], str):
                raise ValueError("Invalid semantic source_file")
    scope_semantic_result(fresh, root=root, allowed_source_files=files)
    identity, normalize = _semantic_source_matcher(root)
    allowed = {identity(path): path.relative_to(root).as_posix() for path in files}
    for key in BUCKETS:
        kept = []
        for item in fresh[key]:
            source = item.get("source_file")
            source_id = identity(normalize(source)) if source else None
            if source_id not in allowed:
                continue  # Also drop sourceless items and the scope helper's edge exception.
            item["source_file"] = allowed[source_id]
            item["_origin"] = "semantic"
            kept.append(item)
        fresh[key] = kept

    prepare_markdown_semantics(fresh)
    if normalize_ids:
        _normalize_semantic_nodes(fresh, code_ids=code_ids)
        _validate_records(fresh, allow_unresolved=True)
        from graphify.validate import VALID_CONFIDENCES

        for edge in fresh["edges"]:
            if (not isinstance(edge.get("relation"), str) or not edge["relation"].strip()
                    or edge.get("confidence") not in VALID_CONFIDENCES):
                raise ValueError("Markdown extraction returned an invalid edge")
    represented = {node["source_file"] for node in fresh["nodes"]}
    represented.update(group["source_file"] for group in fresh["hyperedges"] if group.get("source_file"))
    missing = set(allowed.values()) - represented
    fresh["_partial_files"] = sorted(missing | {
        allowed[identity(normalize(str(path)))] for path in partial
        if identity(normalize(str(path))) in allowed
    })
    return fresh


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--token-budget", type=int, default=4000)
    parser.add_argument("--api-timeout", type=int, default=600)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.token_budget <= 0 or args.api_timeout <= 0 or not args.model.strip():
        parser.error("model, token budget, and API timeout must be nonempty/positive")
    root = args.project.resolve(strict=True)
    if not root.is_dir():
        parser.error("project must be a directory")

    from graphify.paths import GRAPHIFY_OUT, write_json_atomic, write_text_atomic

    out = root / GRAPHIFY_OUT
    if out.absolute() != root / "graphify-out" or not _plain_path(out):
        raise ValueError("Markdown indexing requires a non-linked PROJECT/graphify-out output")
    for name in ("graph.json", ".graphify_root", ".graphify_build.json", "cache", "cache/stat-index.json", "cache/semantic"):
        if not _plain_path(out / name):
            raise ValueError(f"Refusing linked output: {out / name}")
    marker = out / ".graphify_root"
    if marker.exists():
        recorded = Path(marker.read_text(encoding="utf-8-sig").strip())
        if not recorded.is_absolute() or recorded.resolve() != root:
            raise ValueError("Existing .graphify_root does not match the project")
    files = _documents(root, out)
    if args.dry_run:
        for path in files:
            print(path.relative_to(root).as_posix())
        return 0
    if not files:
        print("No admitted Markdown documents; existing graph unchanged.")
        return 0

    from graphify.build import (
        _is_ast_tier, _load_existing_graph, dedupe_nodes,
        finalize_raw_graph_endpoints, has_parallel_links, merge_raw_extraction,
        preserve_semantic_identities,
    )
    from graphify.cache import (
        _semantic_source_matcher, check_semantic_cache, mark_semantic_cache_partial, save_semantic_cache,
    )
    from graphify.framework_pipeline import evidence_from_data, pack_raw_evidence
    from graphify.markdown_resolution import _is_advisory_document

    graph_path = out / "graph.json"
    initial_stat = _signature(graph_path)
    metadata: dict = {}
    loaded = _load_existing_graph(graph_path, metadata_out=metadata)
    original = metadata.get("data", {})
    if not isinstance(original.get("graph", {}), dict):
        raise ValueError("Invalid graph metadata")
    for key in ("directed", "multigraph"):
        if key in original and not isinstance(original[key], bool):
            raise ValueError(f"Invalid graph {key} flag")
    if "links" in original and "edges" in original and original["links"] != original["edges"]:
        raise ValueError("Conflicting graph edge containers")
    old_slot = "links" if "links" in original else "edges"
    if loaded is not None:
        _validate_records({"nodes": original.get("nodes"), "edges": original.get(old_slot)})
        for container in (original, original.get("graph", {})):
            if "hyperedges" in container:
                _validate_records({"nodes": original["nodes"], "hyperedges": container["hyperedges"]})
    old_nodes, old_edges, old_hyper, _ = loaded or ([], [], [], False)
    _validate_records({"nodes": old_nodes, "edges": old_edges, "hyperedges": old_hyper})
    code_ids = {n["id"] for n in old_nodes if n.get("file_type") == "code" and not _is_advisory_document(n)}
    prior_evidence = evidence_from_data(original)
    input_stats = {path: _signature(path) for path in files}
    from graphify.extract import extract

    structure = extract(
        files, root=root, cache_root=root, max_workers=1,
        resolution_context_nodes=[n for n in old_nodes if _is_ast_tier(n)],
        resolution_context_edges=[e for e in old_edges if _is_ast_tier(e)],
    )
    for parent, dirs, names in os.walk(out / "cache" / "semantic", followlinks=False):
        if any(not _plain_path(Path(parent) / name) for name in dirs + names):
            raise ValueError("Refusing linked semantic cache entries")

    from graphify.llm import _extraction_system, extract_corpus_parallel

    prompt = _extraction_system()

    def check_inputs() -> None:
        changed = [path for path in files if not _plain_path(path) or not path.is_file() or _signature(path) != input_stats[path]]
        if changed:
            # A chunk checkpoint may have hashed an edit made during inference.
            # Do not serve that old extraction under the newly edited hash.
            if not args.force:
                mark_semantic_cache_partial(
                    [path for path in changed if _plain_path(path) and path.is_file()], root=root, prompt=prompt,
                )
            raise RuntimeError("Markdown inputs changed during extraction")

    cached = {key: [] for key in BUCKETS}
    pending = [str(path) for path in files]
    if not args.force:
        nodes, edges, hyperedges, pending = check_semantic_cache(pending, root=root, prompt=prompt)
        cached = {"nodes": nodes, "edges": edges, "hyperedges": hyperedges}
        # Preflight cached metadata before paying for fresh inference. Keep raw
        # rows for the single combined normalization, so batch boundaries do not
        # decide which spelling keeps an unsuffixed ID.
        _scoped_result(cached, files, root, code_ids=code_ids)
    print(f"Markdown documents: {len(files)} admitted, {len(files) - len(pending)} cached, {len(pending)} pending.", flush=True)
    result = {key: [] for key in BUCKETS}
    if pending:
        saved_env = {key: os.environ.get(key) for key in ("GRAPHIFY_API_TIMEOUT", "GRAPHIFY_NO_INCREMENTAL_CACHE")}
        try:
            os.environ["GRAPHIFY_API_TIMEOUT"] = str(args.api_timeout)
            # Forced refreshes must not union old model/settings into a new
            # prompt-only checkpoint. Normal runs retain scoped retry progress.
            if args.force:
                os.environ["GRAPHIFY_NO_INCREMENTAL_CACHE"] = "1"
            try:
                result = extract_corpus_parallel(
                    [Path(path) for path in pending], backend="ollama", model=args.model,
                    root=root, token_budget=args.token_budget, max_concurrency=1,
                    on_chunk_done=lambda idx, total, result: print(
                        f"Markdown chunk {idx + 1}/{total} returned.", flush=True,
                    ),
                )
            except Exception as exc:
                print(f"Markdown semantics pending: {exc}; keeping structure and prior knowledge.", file=sys.stderr)
                result = {**{key: [] for key in BUCKETS}, "uncovered_files": pending}
            result = _scoped_result(result, [Path(path) for path in pending], root, normalize_ids=False)
        finally:
            for key, value in saved_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            check_inputs()
    semantic = _scoped_result({
        **{key: cached[key] + result[key] for key in BUCKETS},
        "_partial_files": result.get("_partial_files", []),
    }, files, root, code_ids=code_ids)
    identity, normalize = _semantic_source_matcher(root)
    admitted = {identity(path) for path in files}

    def protected(item: dict) -> bool:
        source = item.get("source_file")
        return (
            not isinstance(source, str)
            or not source or identity(normalize(source)) not in admitted
        )

    preserve_semantic_identities(
        structure, semantic,
        retained={"nodes": old_nodes, "edges": old_edges, "hyperedges": old_hyper}, root=root,
    )
    protected_ids = {node["id"] for node in old_nodes if protected(node)}
    if protected_ids & {node["id"] for node in semantic["nodes"]}:
        raise ValueError("Markdown node id collides with existing code or an untouched source")
    for node in structure.get("nodes", []):
        node.setdefault("attributes", {})["semantic_coverage"] = (
            "partial" if node.get("source_file") in semantic["_partial_files"] else "complete"
        )
    fresh = {key: list(structure.get(key, [])) + semantic[key] for key in BUCKETS}
    fresh.update({key: structure.get(key, []) for key in ("extracted_sources", "failed_sources")})
    fresh["_partial_files"] = semantic["_partial_files"]
    if protected_ids & {node["id"] for node in fresh["nodes"]}:
        raise ValueError("Markdown structure collides with an untouched source")
    _validate_records(fresh, external_ids={node["id"] for node in old_nodes}, allow_unresolved=True)
    from graphify.validate import VALID_CONFIDENCES, VALID_FILE_TYPES

    for node in fresh["nodes"]:
        if not isinstance(node.get("file_type"), str) or node["file_type"] not in VALID_FILE_TYPES:
            raise ValueError("Markdown extraction returned an invalid node type")
        if not isinstance(node.get("label"), str) or not node["label"].strip():
            raise ValueError("Markdown extraction returned an invalid node label")
    for edge in fresh["edges"]:
        if (
            not isinstance(edge.get("relation"), str) or not edge["relation"].strip()
            or not isinstance(edge.get("confidence"), str) or edge["confidence"] not in VALID_CONFIDENCES
        ):
            raise ValueError("Markdown extraction returned an invalid edge")

    def edge_key(edge: dict) -> tuple:
        pair = (edge["source"], edge["target"])
        return pair if original.get("directed") else tuple(sorted(pair))

    protected_edges = {edge_key(edge) for edge in old_edges if protected(edge)}
    if any(edge_key(edge) in protected_edges for edge in fresh["edges"]):
        raise ValueError("Markdown edge collides with an untouched edge")
    if _signature(graph_path) != initial_stat:
        raise RuntimeError("Graph changed during extraction; refusing to overwrite it")
    merged = merge_raw_extraction(copy.deepcopy(fresh), graph_path, root=root)
    if merged.get("_unverified_semantic_shrink"):
        if not args.force:
            uncertain = set(merged["_unverified_semantic_shrink"])
            semantic["_partial_files"] = sorted(set(semantic["_partial_files"]) | uncertain)
            fresh["_partial_files"] = semantic["_partial_files"]
            for node in fresh["nodes"]:
                if node.get("source_file") in uncertain:
                    node.setdefault("attributes", {})["semantic_coverage"] = "partial"
            merged = merge_raw_extraction(copy.deepcopy(fresh), graph_path, root=root)
            print("Retaining prior meaning alongside a smaller response; use --force for an expected complete refresh.", file=sys.stderr)
        else:
            print("Accepting complete Markdown semantic shrink under --force.", file=sys.stderr)
    if evidence_from_data(merged) != prior_evidence:
        raise RuntimeError("Markdown enrichment would change typed evidence")

    # The raw loader backfills legacy origins. Restore carried records from
    # its original snapshot instead of making unrelated code-provenance edits.
    for key, old_rows, raw_rows in (
        ("nodes", old_nodes, original.get("nodes", [])),
        ("edges", old_edges, original.get(old_slot, [])),
        ("hyperedges", old_hyper, original.get("hyperedges", original.get("graph", {}).get("hyperedges", []))),
    ):
        carried_count = len(merged.get(key, [])) - len(fresh[key])
        carried = iter(merged.get(key, [])[:carried_count])
        new_rows = merged.get(key, [])[carried_count:]
        current = next(carried, None)
        restored = []
        for old, raw in zip(old_rows, raw_rows):
            if old == current:
                restored.append(raw)
                current = next(carried, None)
            elif protected(old):
                raise RuntimeError("Markdown enrichment would remove an untouched record")
        if current is not None:
            raise RuntimeError("Unexpected raw merge result")
        merged[key] = restored + new_rows

    merged["nodes"] = dedupe_nodes(merged["nodes"])
    from graphify.markdown_resolution import DOCUMENTATION_EDGE_PRODUCER
    merged["edges"] = [e for e in merged["edges"]
                       if e.get("_generated_by") != DOCUMENTATION_EDGE_PRODUCER]
    # Code evidence may contain distinct call sites on one pair. Do not run
    # document deduplication over records this scoped command does not own.
    untouched_edges = [e for e in merged["edges"] if protected(e)]
    # Connectivity alone is not identity for uncertain documentary claims:
    # different locations/reasons on the same pair must survive as well.
    document_edges = {}
    for edge in merged["edges"]:
        if not protected(edge):
            document_edges.setdefault(json.dumps(edge, sort_keys=True), edge)
    merged["edges"] = untouched_edges + list(document_edges.values())
    untouched = {
        key: [(row, copy.deepcopy(row)) for row in merged[key] if protected(row)]
        for key in ("nodes", "edges")
    }
    finalize_raw_graph_endpoints(merged, root=root)
    # Endpoint finalization also normalizes legacy records. This scoped command
    # owns Markdown, not unrelated code/provenance migrations.
    for key, rows in untouched.items():
        present = {id(row) for row in merged[key]}
        for row, original_row in rows:
            row.clear()
            row.update(original_row)
            if id(row) not in present:
                merged[key].append(row)
    # Retained relationships may cite a previous documentary occurrence whose
    # ID was replaced by source-scoped variants. Keep that existing endpoint as
    # an explicit reference anchor, rather than rewrite an untouched relation.
    present_ids = {node["id"] for node in merged["nodes"]}
    original_nodes = {node["id"]: node for node in original.get("nodes", [])}
    referenced = {edge[key] for edge in merged["edges"] if protected(edge)
                  for key in ("source", "target")}
    referenced.update(member for group in merged.get("hyperedges", []) if protected(group)
                      for member in group.get("nodes", []))
    for node_id in sorted(referenced - present_ids):
        prior = original_nodes.get(node_id)
        if prior is not None and Path(str(prior.get("source_file") or "")).suffix.lower() == ".md":
            anchor = copy.deepcopy(prior)
            anchor["_generated_by"] = "markdown-reference-anchor-v1"
            attrs = anchor.get("attributes")
            if not isinstance(attrs, dict):
                attrs = {} if attrs is None else {"original_attributes": attrs}
                anchor["attributes"] = attrs
            attrs["retained_reference_anchor"] = True
            merged["nodes"].append(anchor)
    _validate_records(merged)

    output = {**original, "nodes": merged["nodes"], "graph": dict(original.get("graph", {}))}
    edge_slot = "links" if "links" in original else "edges"
    output[edge_slot] = merged["edges"]
    if "links" in original and "edges" in original:
        output["edges"] = merged["edges"]
    if "hyperedges" in original or merged.get("hyperedges"):
        output["hyperedges"] = merged.get("hyperedges", [])
    if "hyperedges" in output["graph"]:
        output["graph"]["hyperedges"] = merged.get("hyperedges", [])
    output.setdefault("directed", False)
    output["multigraph"] = bool(original.get("multigraph")) or has_parallel_links(
        merged["edges"], directed=output["directed"],
    )
    pack_raw_evidence(output)
    check_inputs()
    save_semantic_cache(
        semantic["nodes"], semantic["edges"], semantic["hyperedges"], root=root,
        allowed_source_files=files, prompt=prompt, merge_existing=False,
        partial_source_files=semantic["_partial_files"],
    )
    if _signature(graph_path) != initial_stat:
        raise RuntimeError("Graph changed during extraction; refusing to overwrite it")
    from graphify.export import _BACKUP_ARTIFACTS, backup_if_protected

    for directory in (out, out / date.today().isoformat()):
        if any(not _plain_path(directory / name) for name in ("", *_BACKUP_ARTIFACTS)):
            raise ValueError("Refusing linked graph backup artifacts")
    backup_if_protected(out)
    write_json_atomic(graph_path, output, ensure_ascii=False, compact=True)
    if not marker.exists():
        write_text_atomic(marker, str(root))
    print(f"Indexed structure for {len(files)} Markdown document(s); {len(semantic['_partial_files'])} semantic source(s) pending. Code and typed evidence preserved.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Markdown indexing failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
