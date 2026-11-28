"""Provider-free regressions for malformed semantic attribution and cache replay."""
from __future__ import annotations

import copy
import json
import sys

import pytest

from graphify import cache, llm


BAD_ID = "src_packages_fst-disco-ui_docs_doc.disco-ui.selection-controls_fieldbinding"
BAD_NODE = {
    "id": BAD_ID,
    "label": "FieldBinding",
    "file_type": "concept",
    "source source_file": "src/packages/fst-disco-ui/docs/doc.disco-ui.selection-controls.md",
    "_origin": "semantic",
}


def _node(nid, source="a.md"):
    return {"id": nid, "label": nid, "file_type": "concept", "source_file": source}


def _edge(source, target, owner="a.md"):
    return {"source": source, "target": target, "relation": "references",
            "source_file": owner, "confidence": "EXTRACTED"}


def _fragment():
    return {
        "nodes": [_node("kept"), _node("other"), copy.deepcopy(BAD_NODE)],
        "edges": [_edge("kept", "other"), _edge("kept", BAD_ID), _edge(BAD_ID, "other")],
        "hyperedges": [
            {"id": "good", "nodes": ["kept", "other"], "source_file": "a.md"},
            {"id": "bad", "nodes": ["kept", BAD_ID], "source_file": "a.md"},
        ],
    }


def test_incident_malformed_key_is_not_repaired_and_relations_are_removed(tmp_path):
    result = _fragment()
    before = copy.deepcopy(BAD_NODE)
    files, count = cache.scope_semantic_result(result, tmp_path, ["a.md", "b.md"])

    assert files == set()  # The malformed key and id are not attribution evidence.
    assert count == 4
    assert [n["id"] for n in result["nodes"]] == ["kept", "other"]
    assert result["edges"] == [_edge("kept", "other")]
    assert [h["id"] for h in result["hyperedges"]] == ["good"]
    assert result["_partial_files"] == ["a.md", "b.md"]
    assert BAD_NODE == before


@pytest.mark.parametrize("bucket", ["nodes", "edges", "hyperedges"])
@pytest.mark.parametrize("source", [None, "", " \t", 0, False, 42, ["a.md"], {"path": "a.md"}])
def test_required_source_shape_is_rejected_without_crashing(tmp_path, bucket, source):
    row = {"id": "bad", "source": "kept", "target": "other", "nodes": ["kept", "other"],
           "source_file": source}
    result = {"nodes": [_node("kept"), _node("other")], "edges": [], "hyperedges": []}
    result[bucket].append(row)
    _, count = cache.scope_semantic_result(result, tmp_path, ["a.md"])
    assert count == 1 and row not in result[bucket]
    assert result["_partial_files"] == ["a.md"]


@pytest.mark.parametrize("owner", [None, "src/packages/fst_disco_ui/components-fst-disco-ui"])
def test_valid_endpoints_do_not_authorize_invalid_relation_owner(tmp_path, owner):
    result = {"nodes": [_node("kept"), _node("other")],
              "edges": [_edge("kept", "other", owner)],
              "hyperedges": [{"id": "unowned_group", "nodes": ["kept", "other"]}]}
    _, count = cache.scope_semantic_result(result, tmp_path, ["a.md", "b.md"])
    assert count == 2
    assert not result["edges"] and not result["hyperedges"]
    assert result["_partial_files"] == ["a.md", "b.md"]


@pytest.mark.parametrize("marker", [{"external": True}, {"type": "external"}])
@pytest.mark.parametrize("owner", [{}, {"source_file": ""}])
def test_explicit_external_survives_scope_and_cache(tmp_path, marker, owner):
    doc = tmp_path / "a.md"
    doc.write_text("# A\n", encoding="utf-8")
    external = {"id": "external", "label": "External", "file_type": "concept", **marker, **owner}
    result = {"nodes": [_node("kept"), external],
              "edges": [_edge("kept", "external")], "hyperedges": []}
    assert cache.scope_semantic_result(result, tmp_path, [doc]) == (set(), 0)
    assert "_partial_files" not in result
    cache.save_cached(doc, result, root=tmp_path, kind="semantic")
    cached = cache.load_cached(doc, root=tmp_path, kind="semantic")
    assert cached is not None and external in cached["nodes"]


def test_invalid_external_source_is_not_excused_and_duplicate_owned_id_survives(tmp_path):
    result = {"nodes": [_node("kept"), {"id": "kept"},
                        {"id": "bad", "external": True, "source_file": None}],
              "edges": [_edge("kept", "kept")], "hyperedges": []}
    assert cache.scope_semantic_result(result, tmp_path, ["a.md"])[1] == 2
    assert result["nodes"] == [_node("kept")]
    assert result["edges"] == [_edge("kept", "kept")]


@pytest.mark.parametrize("prompt", [None, "current prompt"])
@pytest.mark.parametrize("bucket,source", [("nodes", None), ("nodes", []), ("edges", 42), ("hyperedges", "")])
def test_legacy_and_current_cache_reject_malformed_owners(tmp_path, prompt, bucket, source):
    doc = tmp_path / "a.md"
    doc.write_text("# A\n", encoding="utf-8")
    result = _fragment()
    result["nodes"].pop()  # Write raw historical JSON, bypassing the new producer guard.
    result[bucket].append({"id": "invalid", "source_file": source})
    if bucket == "nodes":
        result["nodes"].append(copy.deepcopy(BAD_NODE))
    fp = cache.prompt_fingerprint(prompt) if prompt else None
    entry = cache.cache_dir(tmp_path, "semantic", fp) / f"{cache.file_hash(doc, tmp_path)}.json"
    entry.write_text(json.dumps(result), encoding="utf-8")

    assert cache.load_cached(doc, root=tmp_path, kind="semantic", prompt=prompt) is None
    assert cache.load_cached(doc, root=tmp_path, kind="semantic", prompt=prompt, allow_partial=True) is None
    assert cache.check_semantic_cache([str(doc)], root=tmp_path, prompt=prompt) == ([], [], [], [str(doc)])


@pytest.mark.parametrize("empty", [False, True])
def test_cache_writer_cleans_incident_relations_and_marks_dispatched_inputs_partial(tmp_path, empty):
    docs = [tmp_path / name for name in ("a.md", "b.md")]
    for doc in docs:
        doc.write_text("# Doc\n", encoding="utf-8")
    result = _fragment() if not empty else {"nodes": [copy.deepcopy(BAD_NODE)], "edges": [], "hyperedges": []}
    original = copy.deepcopy(result)
    assert cache.save_semantic_cache(**result, root=tmp_path, allowed_source_files=iter(docs)) == 2
    assert result == original
    for doc in docs:
        assert cache.load_cached(doc, root=tmp_path, kind="semantic") is None
        partial = cache.load_cached(doc, root=tmp_path, kind="semantic", allow_partial=True)
        assert partial is not None and partial["partial"]
        assert all(n["id"] != BAD_ID for n in partial["nodes"])
        assert all(BAD_ID not in (e["source"], e["target"]) for e in partial["edges"])
        assert all(BAD_ID not in h["nodes"] for h in partial["hyperedges"])


@pytest.mark.parametrize("split", [False, True])
def test_real_llm_path_marks_only_actual_request_inputs_partial_before_checkpoint(tmp_path, monkeypatch, split):
    docs = [tmp_path / name for name in ("a.md", "b.md", "c.md")]
    for doc in docs:
        doc.write_text(f"# {doc.stem}\n", encoding="utf-8")
    monkeypatch.delenv("GRAPHIFY_NO_INCREMENTAL_CACHE", raising=False)
    calls = []

    def transport(_url, _key, _model, text, **kwargs):
        names = [p.name for p in docs if p.name in text]
        calls.append(names)
        if split and names == ["a.md", "b.md"]:
            return {"nodes": [], "edges": [], "hyperedges": [], "finish_reason": "length"}
        result = {"nodes": [_node(name, name) for name in names], "edges": [], "hyperedges": []}
        if "a.md" in names:
            result["nodes"].append(copy.deepcopy(BAD_NODE))
            result["edges"].append(_edge("a.md", BAD_ID))
        return llm._parse_llm_json(json.dumps(result))

    monkeypatch.setattr(llm, "_call_openai_compat", transport)
    result = llm.extract_corpus_parallel(
        docs, root=tmp_path, backend="kimi", api_key="fixture", model="fixture",
        token_budget=None, chunk_size=2, max_concurrency=1, max_retry_depth=1,
    )
    partial = {str(docs[0])} if split else {str(docs[0]), str(docs[1])}
    assert set(result["_partial_files"]) == partial
    assert result["uncovered_files"] == [] and result["failed_chunks"] == 0
    assert {n["id"] for n in result["nodes"]} == {p.name for p in docs}
    assert not result["edges"]
    assert len(calls) == (4 if split else 2)
    for doc in docs:
        cached = cache.load_cached(doc, root=tmp_path, kind="semantic", prompt=llm._extraction_system())
        assert (cached is None) == (str(doc) in partial)


@pytest.mark.parametrize("cached_baseline", [False, True, "forced", "cache-fragments"])
@pytest.mark.parametrize("no_cluster", [False, True])
def test_cli_partial_refresh_preserves_structure_native_evidence_and_prior_semantics(
    tmp_path, monkeypatch, capsys, cached_baseline, no_cluster,
):
    import graphify.__main__ as mainmod

    (tmp_path / "entry.ts").write_text("export function useful() { return 1; }\n", encoding="utf-8")
    (tmp_path / "a.md").write_text("# A\nDocumented behavior.\n", encoding="utf-8")
    (tmp_path / "b.md").write_text("# B\nRelated behavior.\n", encoding="utf-8")
    monkeypatch.setattr(mainmod, "_check_skill_version", lambda *_: None)
    monkeypatch.setenv("MOONSHOT_API_KEY", "fixture")
    phase = 0
    calls = []

    def transport(*args, **kwargs):
        calls.append(phase)
        nodes = [_node(f"a_{phase}"), _node(f"b_{phase}", "b.md")]
        external = {"id": "library", "label": "Library", "file_type": "concept", "type": "external"}
        result = {"nodes": [*nodes, external], "edges": [_edge(f"a_{phase}", "library")], "hyperedges": []}
        if phase:
            result["nodes"].append(copy.deepcopy(BAD_NODE))
            result["edges"].extend([_edge(f"a_{phase}", BAD_ID),
                                    _edge(f"a_{phase}", f"b_{phase}", "unadmitted/directory")])
            result["hyperedges"].append({"id": "unowned", "nodes": [f"a_{phase}", f"b_{phase}"]})
        return llm._parse_llm_json(json.dumps(result))

    monkeypatch.setattr(llm, "_call_openai_compat", transport)

    def run(force=True):
        monkeypatch.setattr(sys, "argv", ["graphify", "extract", str(tmp_path), "--backend", "kimi",
                                          "--no-dedup", *(["--no-cluster"] if no_cluster else []),
                                          *(["--force"] if force else [])])
        try:
            mainmod.main()
        except SystemExit as exc:
            assert exc.code in (None, 0)
        return json.loads((tmp_path / "graphify-out/graph.json").read_text(encoding="utf-8"))

    prior = run()
    if cached_baseline:
        # A rejected CLI run can leave graph.json and a complete-looking
        # manifest behind. Replay must not preserve its unowned model rows.
        poisoned = copy.deepcopy(prior)
        poisoned["nodes"].append(copy.deepcopy(BAD_NODE))
        edge_key = "links" if "links" in poisoned else "edges"
        poisoned[edge_key].extend([_edge("a_0", BAD_ID), _edge("a_0", "b_0", "unadmitted/directory")])
        poisoned.setdefault("hyperedges", []).append({"id": "unowned", "nodes": ["a_0", "b_0"]})
        (tmp_path / "graphify-out/graph.json").write_text(json.dumps(poisoned), encoding="utf-8")
        if cached_baseline == "cache-fragments":
            # Older writers skipped the unowned node, but cached its incident
            # edge under a valid source. Invalidate before cache reads, not after.
            cache.save_cached(tmp_path / "a.md", {
                "nodes": [_node("a_0")], "edges": [_edge("a_0", BAD_ID)],
            }, root=tmp_path, kind="semantic", prompt=llm._extraction_system())
            path = tmp_path / "graphify-out/manifest.json"
            manifest = json.loads(path.read_text(encoding="utf-8"))
            for name in ("a.md", "b.md"):
                manifest[name]["semantic_hash"] = ""
            path.write_text(json.dumps(manifest), encoding="utf-8")
        if cached_baseline is True:
            monkeypatch.setattr(llm, "_call_openai_compat", lambda *a, **k: pytest.fail("unchanged baseline repair invoked a provider"))
    phase = 1
    current = run(force=cached_baseline is False or cached_baseline == "forced")
    nodes = {n["id"]: n for n in current["nodes"]}
    expected = {"a_0", "b_0", "library"} | (set() if cached_baseline is True else {"a_1", "b_1"})
    assert expected <= nodes.keys()
    assert BAD_ID not in nodes
    edges = current.get("links", current.get("edges", []))
    assert all(BAD_ID not in (e["source"], e["target"]) for e in edges)
    assert all(e.get("source_file") != "unadmitted/directory" for e in edges)
    assert not current["hyperedges"]
    old_code = [n for n in prior["nodes"] if n.get("source_file") == "entry.ts"]
    assert old_code
    for node in old_code:
        for key in ("label", "file_type", "source_file", "source_location", "_origin", "attributes"):
            assert nodes[node["id"]].get(key) == node.get(key)
    assert current["graph"]["semantic_evidence"] == prior["graph"]["semantic_evidence"]
    structural = [n for n in current["nodes"] if n.get("_origin") == "ast" and n.get("source_file") in ("a.md", "b.md")]
    assert structural and all(n["attributes"]["semantic_coverage"] == "partial" for n in structural)
    manifest = json.loads((tmp_path / "graphify-out/manifest.json").read_text(encoding="utf-8"))
    for name in ("a.md", "b.md"):
        assert not manifest[name].get("semantic_hash")
        assert cache.load_cached(tmp_path / name, root=tmp_path, kind="semantic", prompt=llm._extraction_system()) is None
    stderr = capsys.readouterr().err
    assert ("semantic coverage marked partial for retry" if cached_baseline else "incomplete semantic coverage") in stderr
    if cached_baseline == "cache-fragments":
        assert calls == [0, 1]
    if cached_baseline is True:
        assert calls == [0]
        phase = 0
        monkeypatch.setattr(llm, "_call_openai_compat", transport)
        healed = run(force=False)
        assert calls == [0, 0]
        assert BAD_ID not in {n["id"] for n in healed["nodes"]}
        assert all(n.get("attributes", {}).get("semantic_coverage") != "partial" for n in healed["nodes"])


@pytest.mark.parametrize("no_cluster", [False, True])
@pytest.mark.parametrize("allow_partial", [False, True])
def test_cli_refuses_baseline_repair_after_incomplete_scan(
    tmp_path, monkeypatch, capsys, no_cluster, allow_partial,
):
    import graphify.__main__ as mainmod

    docs = [tmp_path / name for name in ("a.md", "b.md")]
    for doc in docs:
        doc.write_text(f"# {doc.stem}\nExisting document.\n", encoding="utf-8")
        cache.save_cached(doc, {"nodes": [_node(doc.stem, doc.name)], "edges": []},
                          root=tmp_path, kind="semantic", prompt=llm._extraction_system())
    cache._flush_stat_index()
    out = tmp_path / "graphify-out"
    graph_path = out / "graph.json"
    graph_path.write_text(json.dumps({
        "nodes": [_node("a"), _node("b", "b.md"), copy.deepcopy(BAD_NODE)],
        "edges": [_edge("a", "b"), _edge("a", BAD_ID)],
        "hyperedges": [],
    }), encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps({
        doc.name: {"semantic_hash": cache.file_hash(doc, tmp_path)} for doc in docs
    }), encoding="utf-8")
    before = {p.relative_to(out): p.read_bytes() for p in out.rglob("*") if p.is_file()}

    # b.md is alive and not provably excluded. The existing stale-source
    # guard keeps it, but an incomplete ownership allowlist would reject it.
    monkeypatch.setattr("graphify.detect.detect", lambda *_a, **_kw: {
        "files": {"document": [str(docs[0])]},
        "walk_errors": [f"{docs[1]}: permission denied"],
        "ignored": [], "pruned_noise_dirs": [], "skipped_sensitive": [],
    })
    monkeypatch.setattr(mainmod, "_check_skill_version", lambda *_: None)
    monkeypatch.setenv("MOONSHOT_API_KEY", "fixture")

    def forbidden(*_args, **_kwargs):
        pytest.fail("incomplete baseline repair must stop before extraction or cache writes")

    monkeypatch.setattr("graphify.extract.extract", forbidden)
    monkeypatch.setattr(llm, "extract_corpus_parallel", forbidden)
    monkeypatch.setattr(cache, "mark_semantic_cache_partial", forbidden)
    monkeypatch.setattr(sys, "argv", [
        "graphify", "extract", str(tmp_path), "--force", "--backend", "kimi", "--no-dedup",
        *(["--no-cluster"] if no_cluster else []),
        *(["--allow-partial"] if allow_partial else []),
    ])
    with pytest.raises(SystemExit) as exc:
        mainmod.main()
    assert exc.value.code == 1
    assert docs[1].is_file()
    assert {p.relative_to(out): p.read_bytes() for p in out.rglob("*") if p.is_file()} == before
    assert {n["id"] for n in json.loads(graph_path.read_text(encoding="utf-8"))["nodes"]} == {"a", "b", BAD_ID}
    stderr = capsys.readouterr().err
    assert "fail-closed" in stderr
    assert "cannot repair cached semantic ownership after an incomplete source scan" in stderr
