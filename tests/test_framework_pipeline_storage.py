"""Storage lifecycle qualification independent of the Node producer/runtime."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import networkx as nx
import pytest

from graphify.build import (
    _load_existing_graph,
    build,
    build_from_json,
    build_merge,
    merge_raw_extraction,
    prefix_graph_for_global,
)
from graphify.export import to_html, to_json
from graphify.framework_evidence import (
    EvidenceLimits,
    EvidenceValidationError,
    attach_evidence,
    extract_evidence,
    inspect_semantics,
    merge_evidence,
    query_semantics,
    validate_payload,
)
from graphify.framework_pipeline import (
    combine_evidence,
    evidence_from_data,
    pack_raw_evidence,
    prune_evidence,
)
from tests.test_framework_evidence import LONG_VALUE, _payload, _seal


KEY = "semantic_evidence"
SOURCE = "src/Page.tsx"


@pytest.fixture(autouse=True)
def _no_git_probe(monkeypatch):
    monkeypatch.setattr("graphify.export._git_head", lambda cwd=None: None)


def _store(*, path=SOURCE, repeats=64, unicode=False, crlf=False):
    return validate_payload(_payload(path=path, repeats=repeats, unicode=unicode, crlf=crlf))


def _chunk(store=None, *, path=SOURCE, extracted=False):
    data: dict = {
        "nodes": [
            {
                "id": "navigation-" + path,
                "label": "Page",
                "file_type": "code",
                "source_file": path,
                "source_location": "L1",
                "_origin": "ast",
            },
            {
                "id": "cleanup-" + path,
                "label": "cleanup",
                "file_type": "code",
                "source_file": path,
                "source_location": "L2",
                "_origin": "ast",
            },
        ],
        "edges": [
            {
                "source": "navigation-" + path,
                "target": "cleanup-" + path,
                "relation": "calls",
                "confidence": "EXTRACTED",
                "source_file": path,
                "_origin": "ast",
            }
            for _ in range(64)
        ],
    }
    if store is not None:
        data[KEY] = store
    if extracted:
        data["extracted_sources"] = [path]
    return data


def _seed(tmp_path, store=None):
    store = store if store is not None else _store()
    graph = build_from_json(_chunk(store), root=tmp_path)
    graph_path = tmp_path / "graph.json"
    assert to_json(graph, {}, str(graph_path), force=True)
    return graph_path, store


def _ref(graph, *, path=SOURCE):
    result = query_semantics(graph, path=path, symbol="Page")
    assert result["status"] == "ok", result
    return result["matches"][0]["reference"]


@pytest.mark.parametrize("directed", [False, True])
@pytest.mark.parametrize("slot", ["top", "nested", "identical-both"])
def test_build_dedup_recluster_export_preserves_exact_evidence(tmp_path, directed, slot):
    store = _store()
    chunk = _chunk(copy.deepcopy(store))
    if slot != "top":
        chunk["graph"] = {KEY: copy.deepcopy(store)}
        if slot == "nested":
            del chunk[KEY]
    graph = build([chunk], root=tmp_path, directed=directed, dedup=True)
    assert extract_evidence(graph) == store
    assert graph.number_of_nodes() == 2
    assert graph.number_of_edges() == 1  # Navigation is deliberately not the fact store.
    reference = _ref(graph)
    path = tmp_path / "graph.json"
    assert to_json(graph, {0: list(graph)}, str(path), force=True)
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert KEY not in saved and saved["graph"][KEY] == store
    reloaded = build_from_json(copy.deepcopy(saved), root=tmp_path, directed=directed)
    assert extract_evidence(reloaded) == store
    assert _ref(reloaded) == reference
    assert to_json(
        reloaded, {7: list(reloaded)}, str(path), force=True, original_links=saved["links"]
    )
    again = json.loads(path.read_text(encoding="utf-8"))["graph"][KEY]
    assert again == store
    facts = again["documents"][SOURCE]["result"]["facts"]
    assert len(facts) == 66
    assert facts[1]["value"]["value"] == LONG_VALUE and len(LONG_VALUE) > 512


@pytest.mark.parametrize("lane", ["raw", "build"])
def test_noop_and_partial_file_inventory_do_not_delete_or_invalidate(tmp_path, lane):
    combined = merge_evidence(_store(), _store(path="src/Other.tsx", repeats=1))
    path, original = _seed(tmp_path, combined)
    for _ in range(2):
        if lane == "raw":
            raw = merge_raw_extraction({"nodes": [], "edges": []}, path, root=tmp_path)
            graph = build_from_json(raw, root=tmp_path)
        else:
            graph = build_merge([], path, root=tmp_path)
        assert extract_evidence(graph) == original
        assert to_json(graph, {}, str(path), force=True)
    fresh = _chunk(_store(path="new.tsx", repeats=2), path="new.tsx", extracted=True)
    if lane == "raw":
        graph = build_from_json(merge_raw_extraction(fresh, path, root=tmp_path), root=tmp_path)
    else:
        graph = build_merge([fresh], path, root=tmp_path)
    assert graph.graph[KEY]["documents"][SOURCE] == original["documents"][SOURCE]
    assert graph.graph[KEY]["documents"]["src/Other.tsx"] == original["documents"]["src/Other.tsx"]


@pytest.mark.parametrize("lane", ["raw", "build"])
@pytest.mark.parametrize("ownership", ["extracted", "ast-argument", "ast-node", "failed"])
def test_structural_only_refresh_does_not_claim_old_annotations_current(tmp_path, lane, ownership):
    path, original = _seed(tmp_path)
    args = {}
    fresh = {"nodes": [], "edges": []}
    if ownership == "extracted":
        fresh["extracted_sources"] = [SOURCE]
    elif ownership == "ast-argument":
        args["ast_sources"] = [SOURCE]
    elif ownership == "ast-node":
        fresh = _chunk(path=SOURCE)
    else:
        fresh["failed_sources"] = [SOURCE]
    if lane == "raw":
        graph = build_from_json(
            merge_raw_extraction(fresh, path, root=tmp_path, **args), root=tmp_path
        )
    else:
        graph = build_merge([fresh], path, root=tmp_path, **args)
    entry = graph.graph[KEY]["documents"][SOURCE]
    assert entry["result"] == original["documents"][SOURCE]["result"]
    assert entry["retained"] == original["documents"][SOURCE]
    row = query_semantics(graph, path=SOURCE)["matches"][0]
    assert row["coverage"]["effectiveState"] == "failed"
    assert row["coverage"]["sourceFreshness"] == "refresh-failed-current-source-unknown"
    assert not row["coverage"]["complete"]
    assert to_json(graph, {}, str(path), force=True)
    assert json.loads(path.read_text(encoding="utf-8"))["graph"][KEY] == graph.graph[KEY]


@pytest.mark.parametrize("explicit", [True, False])
def test_carried_store_cannot_mask_missing_refresh_in_another_chunk(tmp_path, explicit):
    old = _store()
    graph = build(
        [{"nodes": [], "edges": [], "graph": {KEY: old}}, _chunk(path=SOURCE, extracted=explicit)],
        root=tmp_path,
    )
    assert graph.graph[KEY]["documents"][SOURCE]["refreshFailed"] is True
    assert graph.graph[KEY]["documents"][SOURCE]["retained"] == old["documents"][SOURCE]
    assert not query_semantics(graph, path=SOURCE)["matches"][0]["coverage"]["complete"]


@pytest.mark.parametrize("alias", ["file", "path", "filepath", "src"])
def test_ast_source_field_aliases_cannot_leave_previous_evidence_current(tmp_path, alias):
    fresh = _chunk()
    for node in fresh["nodes"]:
        node[alias] = node.pop("source_file")
    result = combine_evidence([fresh], previous=_store(), root=tmp_path)
    assert result is not None and result["documents"][SOURCE].get("refreshFailed") is True


@pytest.mark.parametrize("lane", ["raw", "build"])
def test_partial_result_archives_previous_and_invalidates_exact_handles(tmp_path, lane):
    path, old = _seed(tmp_path)
    old_graph = build_from_json({"nodes": [], "edges": [], KEY: old})
    old_reference = _ref(old_graph)
    payload = _payload(repeats=2)
    result = payload["documents"][0]["result"]
    result["state"] = result["reports"][0]["state"] = "partial"
    partial = validate_payload(payload)
    new = _chunk(partial, extracted=True)
    if lane == "raw":
        graph = build_from_json(merge_raw_extraction(new, path, root=tmp_path), root=tmp_path)
    else:
        graph = build_merge([new], path, root=tmp_path)
    entry = graph.graph[KEY]["documents"][SOURCE]
    assert entry["result"] == result
    assert entry["retained"] == old["documents"][SOURCE]
    assert (
        inspect_semantics(graph, old_reference)["reason"] == "stale-or-unknown-evidence-reference"
    )
    current = inspect_semantics(graph, _ref(graph))
    facts = [
        item
        for group in current["groups"]
        for category in ("roles", "properties", "relations")
        for item in group[category]
    ]
    assert len(facts) == len(result["facts"]) == 4
    assert not current["coverage"]["complete"]


def test_raw_nested_input_is_not_left_as_a_second_authority(tmp_path):
    path, old = _seed(tmp_path)
    fresh = _store(repeats=2)
    nested = {KEY: copy.deepcopy(fresh), "other": {"keep": True}}
    new = _chunk(extracted=True)
    new["graph"] = nested
    result = merge_raw_extraction(new, path, root=tmp_path)
    assert result is new
    assert result[KEY] == fresh
    assert KEY not in result["graph"]
    assert result["graph"]["other"] == {"keep": True}
    assert nested[KEY] == fresh  # Do not mutate an aliased metadata dictionary.
    pack_raw_evidence(result)
    assert KEY not in result and result["graph"][KEY] == fresh
    assert old != fresh


@pytest.mark.parametrize(
    "hint", ["./src/Page.tsx", "src/./Page.tsx", "src/a/../Page.tsx", "src\\Page.tsx", "absolute"]
)
@pytest.mark.parametrize("lane", ["raw", "build", "helper"])
def test_whole_source_pruning_matches_lexical_aliases(tmp_path, hint, lane):
    original = merge_evidence(_store(), _store(path="src/Other.tsx", repeats=1))
    path, _ = _seed(tmp_path, original)
    spelling = str(tmp_path / SOURCE) if hint == "absolute" else hint
    if lane == "raw":
        data = merge_raw_extraction(
            {"nodes": [], "edges": []}, path, root=tmp_path, prune_sources=[spelling]
        )
        store = evidence_from_data(data)
    elif lane == "build":
        graph = build_merge([], path, root=tmp_path, prune_sources=[spelling])
        store = extract_evidence(graph)
    else:
        data = {"graph": {KEY: original}}
        prune_evidence(data, [spelling], root=tmp_path)
        store = evidence_from_data(data)
    assert store is not None
    assert set(store["documents"]) == {"src/Other.tsx"}
    assert store["documents"]["src/Other.tsx"] == original["documents"]["src/Other.tsx"]


@pytest.mark.parametrize("lane", ["raw", "build"])
def test_evidence_only_sources_support_root_inference_for_delete(tmp_path, lane):
    path = tmp_path / "nonstandard.json"
    graph = nx.Graph()
    attach_evidence(graph, _store())
    assert to_json(graph, {}, str(path), force=True)
    if lane == "raw":
        result = merge_raw_extraction(
            {"nodes": [], "edges": []}, path, prune_sources=[str(tmp_path / SOURCE)]
        )
        store = evidence_from_data(result)
    else:
        store = extract_evidence(build_merge([], path, prune_sources=[str(tmp_path / SOURCE)]))
    assert store is not None and store["documents"] == {}


def test_source_symlink_alias_is_not_resolved_to_another_owned_entry(tmp_path, monkeypatch):
    original = merge_evidence(
        _store(path="alias.tsx", repeats=1), _store(path="target.tsx", repeats=1)
    )
    resolve = Path.resolve

    def no_leaf_resolution(path, *args, **kwargs):
        assert path.name not in {"alias.tsx", "target.tsx"}
        return resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", no_leaf_resolution)
    result = combine_evidence(
        [], previous=original, root=tmp_path, deleted_sources=[str(tmp_path / "alias.tsx")]
    )
    assert result is not None and set(result["documents"]) == {"target.tsx"}


def test_ambiguous_rootless_absolute_refresh_fails_instead_of_leaving_current_annotations(tmp_path):
    with pytest.raises(EvidenceValidationError, match="pass root explicitly"):
        combine_evidence([], previous=_store(), replaced_sources=[str(tmp_path / SOURCE)])


def test_explicit_refresh_or_failure_wins_over_same_source_delete_alias(tmp_path):
    old, fresh = _store(), _store(repeats=1)
    replaced = combine_evidence(
        [_chunk(fresh, extracted=True)],
        previous=old,
        root=tmp_path,
        deleted_sources=[str(tmp_path / SOURCE)],
    )
    assert replaced is not None and replaced["documents"][SOURCE] == fresh["documents"][SOURCE]
    failed = combine_evidence(
        [], previous=old, root=tmp_path, failed_sources=[SOURCE], deleted_sources=["src\\Page.tsx"]
    )
    assert failed is not None and failed["documents"][SOURCE].get("refreshFailed") is True
    assert failed["documents"][SOURCE].get("retained") == old["documents"][SOURCE]


@pytest.mark.parametrize("value", [None, "src/Page.tsx", [42]])
def test_malformed_ownership_cannot_silently_become_a_noop(value):
    with pytest.raises(EvidenceValidationError):
        combine_evidence([{"extracted_sources": value}], previous=_store())


@pytest.mark.parametrize("ownership", ["chunk", "argument"])
def test_explicit_ast_ownership_does_not_claim_cross_file_stub_sources(tmp_path, ownership):
    old = _store()
    chunks = [_chunk()]
    arguments = {}
    if ownership == "chunk":
        chunks.append({"extracted_sources": ["other.py"]})
    else:
        arguments["replaced_sources"] = ["other.py"]
    assert combine_evidence(chunks, previous=old, root=tmp_path, **arguments) == old


@pytest.mark.parametrize("force", [False, True])
def test_export_refuses_missing_lane_even_when_navigation_is_unchanged(tmp_path, force):
    path, store = _seed(tmp_path)
    before = path.read_bytes()
    graph = build_from_json(_chunk(), root=tmp_path)
    with pytest.raises(EvidenceValidationError, match="discard saved semantic evidence"):
        to_json(graph, {}, str(path), force=force)
    assert path.read_bytes() == before
    attach_evidence(graph, merge_evidence(store, deleted_sources=[SOURCE]))
    assert to_json(graph, {}, str(path), force=force)
    assert json.loads(path.read_text(encoding="utf-8"))["graph"][KEY]["documents"] == {}


@pytest.mark.parametrize(
    "data", [{KEY: None}, {"graph": {KEY: None}}, {KEY: []}, {"graph": {KEY: {"version": 2}}}]
)
def test_present_invalid_evidence_is_not_treated_as_absent(data, tmp_path):
    data = {"nodes": [], "edges": [], **copy.deepcopy(data)}
    for operation in (evidence_from_data, build_from_json, pack_raw_evidence):
        with pytest.raises(EvidenceValidationError):
            operation(copy.deepcopy(data))
    with pytest.raises(EvidenceValidationError):
        merge_raw_extraction(data, tmp_path / "missing.json")


def test_conflicting_containers_or_producers_fail_before_mutating_raw_input(tmp_path):
    path, store = _seed(tmp_path)
    other = _store(repeats=1)
    new = _chunk(copy.deepcopy(store), extracted=True)
    new["graph"] = {KEY: other}
    before = copy.deepcopy(new)
    with pytest.raises(EvidenceValidationError, match="Conflicting"):
        merge_raw_extraction(new, path, root=tmp_path)
    assert new == before
    with pytest.raises(EvidenceValidationError, match="conflict"):
        build([{KEY: store}, {KEY: other}], root=tmp_path)


@pytest.mark.parametrize("lane", ["raw", "build"])
def test_merge_uses_one_graph_read_for_navigation_and_evidence(tmp_path, monkeypatch, lane):
    path, store = _seed(tmp_path)
    original_read = Path.read_text
    first = path.read_text(encoding="utf-8")
    alternate = json.loads(first)
    alternate["graph"][KEY] = _store(repeats=1)
    reads = []

    def generation_read(filename, *args, **kwargs):
        if filename == path:
            reads.append(filename)
            return first if len(reads) == 1 else json.dumps(alternate)
        return original_read(filename, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", generation_read)
    if lane == "raw":
        saved = evidence_from_data(
            merge_raw_extraction({"nodes": [], "edges": []}, path, root=tmp_path)
        )
    else:
        saved = extract_evidence(build_merge([], path, root=tmp_path))
    assert saved == store and reads == [path]


def test_export_uses_one_existing_read_and_does_not_mutate_graph_metadata(tmp_path, monkeypatch):
    path, store = _seed(tmp_path)
    graph = build_from_json(_chunk(store), root=tmp_path)
    before = copy.deepcopy(graph.graph)
    original_read = Path.read_text
    reads = []

    def count_reads(filename, *args, **kwargs):
        if filename == path:
            reads.append(filename)
        return original_read(filename, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", count_reads)
    assert to_json(graph, {}, str(path))
    assert reads == [path]
    assert graph.graph == before


def test_loader_metadata_out_is_cleared_on_absence_and_invalid_store_fails(tmp_path):
    path, _ = _seed(tmp_path)
    metadata = {}
    assert _load_existing_graph(path, metadata_out=metadata) is not None
    assert KEY in metadata["data"]["graph"]
    assert _load_existing_graph(tmp_path / "missing.json", metadata_out=metadata) is None
    assert "data" not in metadata
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["graph"][KEY]["documents"][SOURCE]["source"] += "corrupt"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(EvidenceValidationError):
        _load_existing_graph(path, metadata_out=metadata)
    assert "data" not in metadata


def test_loader_preserves_raw_snapshot_before_origin_and_nested_mutations(tmp_path):
    path = tmp_path / "graph.json"
    raw = {
        "nodes": [
            {
                "id": "legacy",
                "label": "legacy",
                "source_location": "L1",
                "source_file": SOURCE,
                "file_type": "code",
                "details": {"items": [1]},
            }
        ],
        "edges": [
            {"source": "legacy", "target": "legacy", "relation": "calls", "details": {"items": [2]}}
        ],
        "graph": {KEY: _store(repeats=1), "hyperedges": [{"id": "h", "nodes": ["legacy"]}]},
    }
    path.write_text(json.dumps(raw), encoding="utf-8")
    metadata = {}
    loaded = _load_existing_graph(path, metadata_out=metadata)
    assert loaded is not None
    nodes, edges, hyperedges, _ = loaded
    assert nodes[0]["_origin"] == "ast"
    assert edges[0]["_origin"] == "semantic"
    nodes[0]["details"]["items"].append(3)
    edges[0]["details"]["items"].append(4)
    hyperedges[0]["nodes"].clear()
    assert metadata["data"] == raw


def test_unicode_crlf_source_and_paths_survive_raw_and_graph_storage(tmp_path):
    source_path = "src/caf\u00e9.tsx"
    store = _store(path=source_path, unicode=True, crlf=True)
    raw = _chunk(store, path=source_path)
    pack_raw_evidence(raw)
    graph = build_from_json(raw, root=tmp_path)
    path = tmp_path / "graph.json"
    assert to_json(graph, {}, str(path), force=True)
    updated = merge_raw_extraction({"nodes": [], "edges": []}, path, root=tmp_path)
    assert evidence_from_data(updated) == store
    rebuilt = build_from_json(updated, root=tmp_path)
    assert _ref(rebuilt, path=source_path) == _ref(graph, path=source_path)
    source = rebuilt.graph[KEY]["documents"][source_path]["source"]
    assert "\r\n" in source and "\U0001f680" in source


def test_scan_root_alias_and_real_root_own_the_same_corpus_entry(tmp_path):
    root = tmp_path / "corpus"
    root.mkdir()
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(root, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory symlinks unavailable: {exc}")
    for scan_root, hint_root in ((root, alias), (alias, root)):
        result = combine_evidence(
            [], previous=_store(), root=scan_root, deleted_sources=[str(hint_root / SOURCE)]
        )
        assert result is not None and result["documents"] == {}


def test_html_navigation_excludes_raw_evidence_without_sanitizing_the_snapshot(tmp_path):
    payload = _payload(repeats=1)
    marker = "FRAMEWORK_SOURCE_MUST_NOT_ENTER_HTML"
    payload["documents"][0]["source"] += f"\n// </script><script>{marker}=1</script>\n"
    store = validate_payload(_seal(payload))
    graph = build_from_json(_chunk(store), root=tmp_path)
    html_path = tmp_path / "graph.html"
    to_html(graph, {0: list(graph)}, str(html_path), community_labels={0: "Navigation"})
    html = html_path.read_text(encoding="utf-8")
    assert marker not in html and KEY not in html
    assert extract_evidence(graph) == store
    json_path = tmp_path / "graph.json"
    assert to_json(graph, {}, str(json_path), force=True)
    saved = json.loads(json_path.read_text(encoding="utf-8"))["graph"][KEY]
    assert saved == store and marker in saved["documents"][SOURCE]["source"]


def test_absent_lane_stays_absent_and_global_composition_is_explicitly_unsupported():
    graph = build_from_json(_chunk())
    assert extract_evidence(graph) is None
    assert combine_evidence([{"nodes": [], "edges": []}]) is None
    plain = {"nodes": [], "edges": [], "graph": {"label": "keep"}}
    before = copy.deepcopy(plain)
    pack_raw_evidence(plain)
    prune_evidence(plain, [SOURCE])
    assert plain == before
    assert prefix_graph_for_global(graph, "repo").number_of_nodes() == 2
    attach_evidence(graph, _store())
    with pytest.raises(EvidenceValidationError, match="corpus-qualified"):
        prefix_graph_for_global(graph, "repo")


@pytest.mark.parametrize("inventory", ["extracted", "ast-nodes"])
@pytest.mark.parametrize("lane", ["helper", "build"])
def test_fresh_rootless_assembly_imports_snapshot_paths_not_absolute_dispatch(
    tmp_path, inventory, lane
):
    chunks = []
    expected = None
    references = {}
    # Same basename, including a suffix overlap: no absolute spelling may be
    # guessed into the other snapshot's corpus-local source identity.
    for path in ("Page.tsx", "nested/Page.tsx"):
        store = _store(path=path, repeats=2, unicode=True, crlf=True)
        expected = merge_evidence(expected, store)
        references[path] = _ref(build_from_json({KEY: store}), path=path)
        chunk = _chunk(store, path=path)
        absolute = str(tmp_path / "not-on-disk" / path)
        for node in chunk["nodes"]:
            node["source_file"] = absolute
        if inventory == "extracted":
            chunk["extracted_sources"] = [absolute]
        chunks.append(chunk)
    if lane == "helper":
        result = combine_evidence(chunks)
        graph = build_from_json({KEY: result})
    else:
        graph = build(chunks)
        result = extract_evidence(graph)
    assert result is not None
    assert result == expected
    assert set(result["documents"]) == {"Page.tsx", "nested/Page.tsx"}
    assert len(set(references.values())) == 2
    for path, reference in references.items():
        assert _ref(graph, path=path) == reference
        assert "refreshFailed" not in result["documents"][path]


def test_fresh_assembly_never_reads_or_resolves_live_source_to_infer_ownership(
    tmp_path, monkeypatch
):
    store = _store()
    chunk = _chunk(store)
    chunk["extracted_sources"] = [str(tmp_path / SOURCE)]

    def forbidden(*args, **kwargs):
        raise AssertionError("Fresh source identity comes only from the validated snapshot")

    monkeypatch.setattr(Path, "read_bytes", forbidden)
    monkeypatch.setattr(Path, "read_text", forbidden)
    monkeypatch.setattr(Path, "resolve", forbidden)
    monkeypatch.setattr("builtins.open", forbidden)
    assert combine_evidence([chunk]) == store


@pytest.mark.parametrize("inventory", [None, "not-a-source-list", [None], [""], ["bad\x00path"]])
def test_fresh_assembly_still_validates_dispatch_inventory(inventory):
    chunk = _chunk(_store())
    chunk["extracted_sources"] = inventory
    with pytest.raises(EvidenceValidationError):
        combine_evidence([chunk])


def test_fresh_assembly_still_enforces_inventory_limit_before_ignoring_absolute_paths(tmp_path):
    chunk = _chunk(_store())
    chunk["extracted_sources"] = [str(tmp_path / SOURCE)] * 2
    with pytest.raises(EvidenceValidationError, match="ownership limit"):
        combine_evidence([chunk], limits=EvidenceLimits(max_documents=1))


@pytest.mark.parametrize("state", ["partial", "failed"])
def test_fresh_import_keeps_reported_incomplete_snapshots_unchanged(tmp_path, state):
    payload = _payload(repeats=1)
    result = payload["documents"][0]["result"]
    result["state"] = result["reports"][0]["state"] = state
    if state == "failed":
        result["facts"].clear()
    store = validate_payload(payload)
    chunk = _chunk(store)
    chunk["extracted_sources"] = [str(tmp_path / SOURCE)]
    imported = combine_evidence([chunk])
    assert imported == store
    graph = build_from_json({KEY: imported})
    assert not query_semantics(graph)["matches"][0]["coverage"]["complete"]


def test_fresh_import_does_not_ignore_failed_source_inventory(tmp_path):
    chunk = _chunk(_store())
    chunk["extracted_sources"] = [str(tmp_path / SOURCE)]
    chunk["failed_sources"] = [str(tmp_path / SOURCE)]
    with pytest.raises(EvidenceValidationError, match="pass root explicitly"):
        combine_evidence([chunk])


@pytest.mark.parametrize("prior_present", [False, True])
@pytest.mark.parametrize("directive", ["replaced_sources", "deleted_sources", "failed_sources"])
def test_explicit_mutation_does_not_gain_rootless_authority_from_fresh_snapshots(
    tmp_path,
    prior_present,
    directive,
):
    old = _store()
    new = _chunk(_store(repeats=1))
    arguments: dict = {directive: [str(tmp_path / SOURCE)]}
    with pytest.raises(EvidenceValidationError, match="pass root explicitly"):
        combine_evidence([new], previous=old if prior_present else None, **arguments)


@pytest.mark.parametrize("inventory", ["extracted", "ast-nodes"])
def test_incremental_refresh_inventory_still_requires_exact_root(tmp_path, inventory):
    old = _store()
    new = _chunk(_store(repeats=1))
    absolute = str(tmp_path / SOURCE)
    for node in new["nodes"]:
        node["source_file"] = absolute
    if inventory == "extracted":
        new["extracted_sources"] = [absolute]
    with pytest.raises(EvidenceValidationError, match="pass root explicitly"):
        combine_evidence([new], previous=old)
    with pytest.raises(EvidenceValidationError, match="pass root explicitly"):
        combine_evidence([new], previous=old, root=tmp_path / "different-corpus")
    result = combine_evidence([new], previous=old, root=tmp_path)
    assert result is not None and result["documents"][SOURCE] == new[KEY]["documents"][SOURCE]


def test_rootless_ast_only_chunk_cannot_rebind_an_imported_snapshot(tmp_path):
    carried = {"graph": {KEY: _store()}}
    refreshed = _chunk()
    refreshed["extracted_sources"] = [str(tmp_path / SOURCE)]
    with pytest.raises(EvidenceValidationError, match="pass root explicitly"):
        combine_evidence([carried, refreshed])


def test_relative_missing_output_still_marks_carried_source_stale_during_fresh_assembly(tmp_path):
    carried = _store(path="Other.tsx")
    new = _chunk(_store(), extracted=True)
    new["extracted_sources"] = [str(tmp_path / SOURCE), "Other.tsx"]
    result = combine_evidence([{KEY: carried}, new])
    assert result is not None
    assert result["documents"]["Other.tsx"].get("refreshFailed") is True
    assert result["documents"]["Other.tsx"].get("retained") == carried["documents"]["Other.tsx"]
    assert result["documents"][SOURCE] == new[KEY]["documents"][SOURCE]


def test_rootless_delete_never_guesses_a_matching_basename(tmp_path):
    old = _store()
    assert (
        combine_evidence(
            [], previous=old, deleted_sources=[str(tmp_path / "unrelated" / "Page.tsx")]
        )
        == old
    )


@pytest.mark.parametrize("lane", ["raw", "build"])
@pytest.mark.parametrize("existing_graph", [False, True])
def test_first_evidence_assembly_does_not_invent_replacement_authority(
    tmp_path,
    lane,
    existing_graph,
):
    path = tmp_path / "custom-graph.json"
    if existing_graph:
        assert to_json(nx.Graph(), {}, str(path), force=True)
    store = _store()
    new = _chunk(store)
    absolute = str(tmp_path / SOURCE)
    new["extracted_sources"] = [absolute]
    if lane == "raw":
        result = evidence_from_data(merge_raw_extraction(new, path, ast_sources=[absolute]))
    else:
        result = extract_evidence(build_merge([new], path, ast_sources=[absolute]))
    assert result == store
