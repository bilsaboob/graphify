from __future__ import annotations

import json
from pathlib import Path

import pytest

from graphify.framework_analysis import analyze_documents, analyze_paths, make_document
from graphify.framework_pipeline import evidence_from_data
from graphify.watch import (
    _BUILD_STATE_NAME,
    _FRAMEWORK_STATE_NAME,
    _rebuild_code,
    _reconcile_existing_graph,
)

SOURCE = 'import {createSignal} from "solid-js"; export const [read, write] = createSignal(1);\n'


def _capture(root, names):
    paths = [root / name for name in names]
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(SOURCE, encoding="utf-8")
    return analyze_paths(paths, root)


def _graph(root, store):
    out = root / "graphify-out"
    out.mkdir(exist_ok=True)
    path = out / "graph.json"
    path.write_text(json.dumps({"nodes": [], "links": [], "graph": {"semantic_evidence": store, "custom": "keep"}}), encoding="utf-8")
    return path


def test_reconcile_same_read_preserves_and_prunes_evidence_only_sources(tmp_path, monkeypatch):
    names = ["src/keep.tsx", "src/gone.tsx", "src/ignored.tsx", "src/unobserved.tsx", "outside.tsx"]
    store = _capture(tmp_path, names)
    path = _graph(tmp_path, store)
    (tmp_path / "src/gone.tsx").unlink()
    reads = []
    original = Path.read_text

    def read(file, *args, **kwargs):
        if file == path:
            reads.append(file)
        return original(file, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read)
    result, snapshot = _reconcile_existing_graph(
        path, {"nodes": [], "edges": []}, out=path.parent,
        project_root=tmp_path, watch_root=tmp_path / "src",
        code_files=[tmp_path / "src/keep.tsx"], extract_targets=[], full_rebuild=True,
        deleted_paths=set(), deleted_source_identities=set(),
        is_ignored_full=lambda file: file.name == "ignored.tsx",
    )
    assert reads == [path]
    assert set(evidence_from_data(result)["documents"]) == {"src/keep.tsx", "src/unobserved.tsx", "outside.tsx"}
    assert set(evidence_from_data(snapshot)["documents"]) == set(names)
    assert result["graph"] == {"custom": "keep"}


def test_reconcile_failed_source_preserves_nodes_and_marks_retained_snapshot(tmp_path):
    store = _capture(tmp_path, ["app.tsx"])
    path = _graph(tmp_path, store)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["nodes"] = [{"id": "read", "label": "read", "source_file": "app.tsx", "file_type": "code", "_origin": "ast"}]
    path.write_text(json.dumps(data), encoding="utf-8")
    source = tmp_path / "app.tsx"
    result, _ = _reconcile_existing_graph(
        path, {"nodes": [], "edges": [], "failed_sources": [str(source)]},
        out=path.parent, project_root=tmp_path, watch_root=tmp_path,
        code_files=[source], extract_targets=[source], full_rebuild=True,
        deleted_paths=set(), deleted_source_identities=set(),
    )
    assert result["nodes"] == data["nodes"]
    document = evidence_from_data(result)["documents"]["app.tsx"]
    assert document["refreshFailed"] is True
    assert document["retained"]["result"]["state"] == "complete"


def test_reconcile_partial_framework_result_retains_previous_complete_snapshot(tmp_path):
    store = _capture(tmp_path, ["app.tsx"])
    path = _graph(tmp_path, store)
    source = tmp_path / "app.tsx"
    partial = analyze_documents(
        [make_document(source.read_bytes().decode("utf-8"), "app.tsx", "tsx")],
        options={"limits": {"maxFacts": 1}},
    )
    result, _ = _reconcile_existing_graph(
        path, {"nodes": [], "edges": [], "semantic_evidence": partial, "extracted_sources": [str(source)]},
        out=path.parent, project_root=tmp_path, watch_root=tmp_path,
        code_files=[source], extract_targets=[source], full_rebuild=False,
        deleted_paths=set(), deleted_source_identities=set(),
    )
    document = evidence_from_data(result)["documents"]["app.tsx"]
    assert document["result"]["state"] == "truncated"
    assert document["retained"]["result"]["state"] == "complete"


@pytest.mark.parametrize("raw", [True, False])
def test_watch_roundtrip_preserves_metadata_and_updates_evidence(tmp_path, raw):
    _capture(tmp_path, ["app.tsx"])
    assert _rebuild_code(tmp_path, no_cluster=raw, acquire_lock=False)
    path = tmp_path / "graphify-out/graph.json"
    first = json.loads(path.read_text(encoding="utf-8"))
    assert "semantic_evidence" not in first
    first["graph"]["custom"] = {"stable": True}
    old_hash = first["graph"]["semantic_evidence"]["documents"]["app.tsx"]["result"]["sourceHash"]
    path.write_text(json.dumps(first), encoding="utf-8")
    (tmp_path / "app.tsx").write_text(SOURCE.replace("createSignal(1)", "createSignal(2)"), encoding="utf-8")
    assert _rebuild_code(tmp_path, no_cluster=raw, incremental=True, acquire_lock=False)
    second = json.loads(path.read_text(encoding="utf-8"))
    assert "semantic_evidence" not in second
    assert second["graph"]["custom"] == {"stable": True}
    assert evidence_from_data(second)["documents"]["app.tsx"]["result"]["sourceHash"] != old_hash


def test_relative_subfolder_watch_anchors_evidence_without_rebasing_wire_keys(tmp_path, monkeypatch):
    folder = tmp_path / "nested"
    folder.mkdir()
    source = folder / "app.tsx"
    source.write_text(SOURCE, encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert _rebuild_code(Path("nested"), no_cluster=True, acquire_lock=False)
    graph = folder / "graphify-out/graph.json"
    first = json.loads(graph.read_text(encoding="utf-8"))
    assert set(evidence_from_data(first)["documents"]) == {"nested/app.tsx"}
    original = evidence_from_data(first)["documents"]["nested/app.tsx"]["result"]["sourceHash"]
    source.write_text(SOURCE + "// updated snapshot\n", encoding="utf-8")
    assert _rebuild_code(Path("nested"), no_cluster=True, incremental=True, acquire_lock=False)
    second = json.loads(graph.read_text(encoding="utf-8"))
    assert set(evidence_from_data(second)["documents"]) == {"nested/app.tsx"}
    assert evidence_from_data(second)["documents"]["nested/app.tsx"]["result"]["sourceHash"] != original


@pytest.mark.parametrize("change", ["implementation", "configuration"])
def test_watch_framework_epoch_refreshes_only_admitted_typescript(tmp_path, monkeypatch, change):
    import graphify.extract as extract
    import graphify.framework_analysis as framework
    _capture(tmp_path, ["app.tsx"])
    (tmp_path / "other.py").write_text("def ordinary(): return 1\n", encoding="utf-8")
    (tmp_path / "notes.md").write_text("# Keep document placeholder\n", encoding="utf-8")
    assert _rebuild_code(tmp_path, no_cluster=True, acquire_lock=False)
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
    assert _rebuild_code(tmp_path, no_cluster=True, incremental=True, acquire_lock=False)
    assert calls == [["app.tsx"]]
    calls.clear()
    assert _rebuild_code(tmp_path, no_cluster=True, incremental=True, acquire_lock=False)
    assert calls == []


def test_watch_hard_failure_labels_old_evidence_without_losing_structural_data(tmp_path, monkeypatch):
    import graphify.extract as extract
    _capture(tmp_path, ["app.tsx"])
    assert _rebuild_code(tmp_path, no_cluster=True, acquire_lock=False)
    path = tmp_path / "graphify-out/graph.json"
    before = json.loads(path.read_text(encoding="utf-8"))

    def fail(*args, **kwargs):
        raise RuntimeError("simulated framework worker failure")

    monkeypatch.setattr(extract, "extract", fail)
    assert not _rebuild_code(tmp_path, no_cluster=True, force=True, acquire_lock=False)
    after = json.loads(path.read_text(encoding="utf-8"))
    assert after["nodes"] == before["nodes"]
    document = evidence_from_data(after)["documents"]["app.tsx"]
    assert document["refreshFailed"] and document["retained"]["result"]["state"] == "complete"
    assert not (path.parent / _FRAMEWORK_STATE_NAME).exists()


def test_failed_source_cannot_receive_full_clean_build_stamp(tmp_path, monkeypatch):
    import graphify.extract as extract
    _capture(tmp_path, ["app.tsx"])
    assert _rebuild_code(tmp_path, no_cluster=True, acquire_lock=False)
    monkeypatch.setattr(extract, "extract", lambda paths, **kwargs: {
        "nodes": [], "edges": [], "failed_sources": [str(path) for path in paths],
    })
    assert _rebuild_code(tmp_path, no_cluster=True, force=True, acquire_lock=False)
    out = tmp_path / "graphify-out"
    state = json.loads((out / _BUILD_STATE_NAME).read_text(encoding="utf-8"))
    assert state["full_clean"] is False
    assert not (out / _FRAMEWORK_STATE_NAME).exists()
