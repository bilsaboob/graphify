from __future__ import annotations

import json
from pathlib import Path

import pytest

import graphify.__main__ as mainmod
from graphify.cli import _prune_graph_json_sources, _stale_graph_sources
from graphify.framework_analysis import analyze_paths
from graphify.framework_pipeline import evidence_from_data

SOURCE = 'import {createSignal} from "solid-js"; export const [read, write] = createSignal(1);\n'


def _run(monkeypatch, root, *args):
    monkeypatch.setattr(mainmod, "_check_skill_version", lambda *_: None)
    monkeypatch.setattr(mainmod.sys, "argv", ["graphify", "extract", str(root), "--code-only", "--no-cluster", *args])
    try:
        mainmod.main()
    except SystemExit as exc:
        assert exc.code in (None, 0)


@pytest.mark.parametrize("change", ["implementation", "configuration"])
def test_raw_incremental_framework_epoch_does_not_widen_non_typescript_or_documents(tmp_path, monkeypatch, change):
    import graphify.extract as extract
    import graphify.framework_analysis as framework
    source = tmp_path / "app.tsx"
    source.write_text(SOURCE, encoding="utf-8")
    (tmp_path / "other.py").write_text("def ordinary(): return 1\n", encoding="utf-8")
    (tmp_path / "notes.md").write_text("# Untouched document\n", encoding="utf-8")
    _run(monkeypatch, tmp_path)
    calls = []
    actual = extract.extract

    def spy(paths, **kwargs):
        calls.append([Path(path).name for path in paths])
        return actual(paths, **kwargs)

    monkeypatch.setattr(extract, "extract", spy)
    if change == "implementation":
        monkeypatch.setattr(framework, "analysis_fingerprint", lambda **_: "changed-implementation")
    else:
        (tmp_path / ".graphifyrc").write_text("# changed analysis configuration\n", encoding="utf-8")
    _run(monkeypatch, tmp_path)
    assert calls == [["app.tsx"]]
    calls.clear()
    _run(monkeypatch, tmp_path)
    assert calls == []
    graph = json.loads((tmp_path / "graphify-out/graph.json").read_text(encoding="utf-8"))
    assert "semantic_evidence" not in graph
    assert set(evidence_from_data(graph)["documents"]) == {"app.tsx"}


def test_cli_prunes_evidence_only_sources_without_requiring_removed_nodes(tmp_path):
    source = tmp_path / "app.tsx"
    source.write_text(SOURCE, encoding="utf-8")
    store = analyze_paths([source], tmp_path)
    out = tmp_path / "graphify-out"
    out.mkdir()
    graph = out / "graph.json"
    graph.write_text(json.dumps({"nodes": [], "links": [], "graph": {"semantic_evidence": store, "custom": 7}}), encoding="utf-8")
    assert _stale_graph_sources(graph, tmp_path, set(), {}) == []
    excluded = _stale_graph_sources(graph, tmp_path, set(), {"ignored": [str(source)]})
    assert excluded == ["app.tsx"]
    _prune_graph_json_sources(graph, excluded)
    data = json.loads(graph.read_text(encoding="utf-8"))
    assert evidence_from_data(data)["documents"] == {}
    assert data["graph"]["custom"] == 7


def test_cli_failed_refresh_keeps_evidence_but_not_a_current_complete_claim(tmp_path, monkeypatch):
    import graphify.extract as extract
    source = tmp_path / "app.tsx"
    source.write_text(SOURCE, encoding="utf-8")
    _run(monkeypatch, tmp_path)
    path = tmp_path / "graphify-out/graph.json"
    before = json.loads(path.read_text(encoding="utf-8"))
    source.write_text(SOURCE.replace("(1)", "(2)"), encoding="utf-8")

    def fail(*args, **kwargs):
        raise RuntimeError("simulated framework failure")

    monkeypatch.setattr(extract, "extract", fail)
    monkeypatch.setattr(mainmod.sys, "argv", ["graphify", "extract", str(tmp_path), "--code-only", "--no-cluster"])
    with pytest.raises(SystemExit) as exc:
        mainmod.main()
    assert exc.value.code == 1
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["nodes"] == before["nodes"]
    document = evidence_from_data(data)["documents"]["app.tsx"]
    assert document["refreshFailed"]
    assert document["retained"]["result"]["state"] == "complete"


def test_cli_model_output_cannot_inject_typed_evidence(tmp_path, monkeypatch):
    (tmp_path / "app.tsx").write_text(SOURCE, encoding="utf-8")
    (tmp_path / "notes.md").write_text("# Notes\n", encoding="utf-8")
    calls = []

    def mocked_model(paths, **kwargs):
        calls.append(paths)
        result = {"nodes": [{"id": "concept_notes", "label": "Notes", "type": "concept", "source_file": "notes.md"}],
                  "edges": [], "hyperedges": [], "semantic_evidence": {"untrusted": "must not be consumed"},
                  "input_tokens": 1, "output_tokens": 1}
        kwargs["on_chunk_done"](0, 1, result)
        return result

    monkeypatch.setattr("graphify.llm.extract_corpus_parallel", mocked_model)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-fake-key")
    monkeypatch.setattr(mainmod, "_check_skill_version", lambda *_: None)
    monkeypatch.setattr(mainmod.sys, "argv", ["graphify", "extract", str(tmp_path), "--backend", "claude", "--no-cluster", "--no-dedup"])
    try:
        mainmod.main()
    except SystemExit as exc:
        assert exc.code in (None, 0)
    assert len(calls) == 1
    graph = json.loads((tmp_path / "graphify-out/graph.json").read_text(encoding="utf-8"))
    assert set(evidence_from_data(graph)["documents"]) == {"app.tsx"}
