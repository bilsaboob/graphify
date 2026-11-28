"""Offline fixture qualification for the Bun runner's Markdown-only helper."""

from __future__ import annotations

import builtins
import copy
import importlib.util
import json
import os
import stat
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest


SPEC = importlib.util.spec_from_file_location(
    "index_markdown_script", Path(__file__).parents[1] / "scripts" / "index_markdown.py"
)
script = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(script)


@pytest.fixture(autouse=True)
def _isolate_backend_env(monkeypatch):
    # Override the suite fixture so even importing llm cannot fetch a tokenizer.
    monkeypatch.setitem(sys.modules, "tiktoken", None)
    from graphify import llm

    original = llm.extract_corpus_parallel
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: pytest.fail("unexpected provider call"))
    monkeypatch.delenv("GRAPHIFY_NO_INCREMENTAL_CACHE", raising=False)
    from graphify import extract as extractor
    real_extract = extractor.extract

    def markdown_only(paths, *args, **kwargs):
        paths = list(paths)
        assert all(path.suffix.lower() == ".md" for path in paths)
        return real_extract(paths, *args, **kwargs)

    monkeypatch.setattr(extractor, "extract", markdown_only)
    return original


@pytest.fixture(autouse=True)
def _output_scope(tmp_path, monkeypatch):
    # Import before changing the path: watch retains its own module-level copy.
    from graphify import cache, paths, watch

    output = str(tmp_path / "graphify-out")
    monkeypatch.setenv("GRAPHIFY_OUT", output)
    monkeypatch.setattr(paths, "GRAPHIFY_OUT", output)
    monkeypatch.setattr(cache, "_GRAPHIFY_OUT", output)
    monkeypatch.setattr(watch, "_GRAPHIFY_OUT", output)


def _write(root, name, content="# Fixture\n"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _run(root, *args):
    return script.main([
        str(root), "--model", "fixture-local-model", "--token-budget", "4000",
        "--api-timeout", "600", *args,
    ])


def _result(files, root, *, generation="fresh"):
    nodes, edges, hyperedges = [], [], []
    for path in files:
        source = Path(path).relative_to(root).as_posix()
        ids = [f"{source}:{generation}:page", f"{source}:{generation}:detail"]
        nodes.extend({
            "id": node_id, "label": node_id, "file_type": "document",
            "source_file": source, "source_location": "L1", "_origin": "ast",
        } for node_id in ids)
        edges.append({
            "source": ids[0], "target": ids[1], "relation": "contains",
            "confidence": "EXTRACTED", "source_file": source, "_origin": "ast",
        })
        hyperedges.append({"id": source + ":group", "nodes": ids, "source_file": source, "_origin": "ast"})
    return {"nodes": nodes, "edges": edges, "hyperedges": hyperedges}


def _seed(root, *, edge_slot="links", directed=True):
    from graphify.framework_evidence import validate_payload
    from tests.test_framework_evidence import _payload

    store = validate_payload(_payload(repeats=1))
    data = {
        "directed": directed, "multigraph": True, "custom": {"keep": [1, 2]},
        "nodes": [
            {"id": "callee", "label": "callee", "file_type": "code", "source_file": "src/Page.tsx", "source_location": "L2"},
            {"id": "caller", "label": "caller", "file_type": "code", "source_file": "src/Page.tsx", "source_location": "L1", "_origin": "ast"},
            {"id": "untouched", "label": "ignored", "file_type": "document", "source_file": "ignored.md", "_origin": "semantic"},
            {"id": "deleted", "label": "deleted", "file_type": "document", "source_file": "deleted.md", "_origin": "semantic"},
        ],
        edge_slot: [
            {"source": "caller", "target": "callee", "relation": "calls", "confidence": "EXTRACTED", "source_file": "src/Page.tsx", "source_location": "L1", "key": 0},
            {"source": "caller", "target": "callee", "relation": "references", "confidence": "EXTRACTED", "source_file": "src/Page.tsx", "_origin": "ast", "key": 1},
        ],
        "graph": {
            "semantic_evidence": store, "owner": {"name": "fixture"},
            "hyperedges": [{"id": "code-group", "nodes": ["caller", "callee"], "source_file": "src/Page.tsx"}],
        },
    }
    path = _write(root, "graphify-out/graph.json", json.dumps(data))
    _write(root, "graphify-out/.graphify_root", str(root.resolve()))
    for name, content in {
        ".graphify_build.json": json.dumps({"excludes": ["persisted.md"], "gitignore": True, "code_only": True}),
        "manifest.json": '{"src/Page.tsx": {"hash": "untouched"}}',
        ".framework_state.json": '{"fixture": "untouched"}',
        "cache/semantic/unrelated.json": '{"fixture": "never swept"}',
    }.items():
        _write(root, "graphify-out/" + name, content)
    _write(root, ".graphifyignore", "ignored.md\n")
    return path, data


@pytest.mark.parametrize("edge_slot,directed", [("links", True), ("edges", False)])
def test_selection_local_dispatch_and_lossless_merge(tmp_path, monkeypatch, edge_slot, directed):
    from graphify import llm

    graph, before = _seed(tmp_path, edge_slot=edge_slot, directed=directed)
    admitted = ["README.md", "docs/nested/UPPER.MD", "papers/research.md"]
    for name in admitted:
        _write(tmp_path, name, "# Abstract\nWe propose a journal paper. DOI: fixture\n")
    excluded = [
        "src/libs/lib/hidden.md", "src/libs/ROOT.MD", "graphify-out/wiki/index.md",
        "docs/graphify-out/wiki/index.md", "ignored.md", "persisted.md", "git-ignored.md",
        "docs/nested/blocked.md", "node_modules/package/readme.md", "dist/generated.md",
        "secrets.md", "docs/page.mdx", "docs/page.markdown", "docs/source.ts", "paper.pdf",
    ]
    for name in excluded:
        _write(tmp_path, name)
    _write(tmp_path, ".gitignore", "git-ignored.md\n")
    _write(tmp_path, ".graphifyignore", "ignored.md\nsrc/libs/\n!src/libs/\n!src/libs/**\n!node_modules/**\n")
    _write(tmp_path, "src/.graphifyignore", "!libs/\n!libs/**\n")
    _write(tmp_path, "src/libs/.graphifyignore", "!**\n")
    _write(tmp_path, "docs/nested/.graphifyignore", "blocked.md\n")
    sidecars = {p: p.read_bytes() for p in graph.parent.rglob("*") if p.is_file() and p != graph}
    calls = []

    def extract(files, **kwargs):
        calls.append((files, kwargs))
        assert os.environ["GRAPHIFY_API_TIMEOUT"] == "600"
        assert "GRAPHIFY_NO_INCREMENTAL_CACHE" not in os.environ
        result = _result(files, tmp_path)
        result["nodes"].extend([
            {"id": "evil", "source_file": "src/Page.tsx", "_origin": "ast"},
            {"id": "ghost", "source_file": None},
        ])
        result["edges"].append({
            **result["edges"][0], "source_file": "src/Page.tsx", "relation": "poison",
        })
        result.update({"semantic_evidence": {"invalid": True}, "graph": {"semantic_evidence": None},
                       "extracted_sources": ["src/Page.tsx"], "failed_sources": ["src/Page.tsx"]})
        return result

    monkeypatch.setattr(llm, "extract_corpus_parallel", extract)
    assert _run(tmp_path) == 0
    assert len(calls) == 1
    files, kwargs = calls[0]
    assert {p.relative_to(tmp_path).as_posix() for p in files} == set(admitted)
    assert callable(kwargs.pop("on_chunk_done"))
    assert kwargs == {"backend": "ollama", "model": "fixture-local-model", "root": tmp_path,
                      "token_budget": 4000, "max_concurrency": 1}
    after = json.loads(graph.read_text(encoding="utf-8"))
    assert after["nodes"][:len(before["nodes"])] == before["nodes"]
    assert after[edge_slot][:len(before[edge_slot])] == before[edge_slot]
    assert after["graph"]["semantic_evidence"] == before["graph"]["semantic_evidence"]
    assert after["graph"]["owner"] == before["graph"]["owner"]
    assert after["graph"]["hyperedges"][0] == before["graph"]["hyperedges"][0]
    assert after["custom"] == before["custom"]
    assert after["directed"] is directed and after["multigraph"] is True
    assert ("edges" if edge_slot == "links" else "links") not in after
    added = after["nodes"][len(before["nodes"]):]
    assert {n["_origin"] for n in added} == {"ast", "semantic"}
    assert {n["source_file"] for n in added if n.get("node_kind") == "page"} == set(admitted)
    assert not any(e.get("relation") == "poison" for e in after[edge_slot])
    assert "extracted_sources" not in after and "semantic_evidence" not in after
    assert {p: p.read_bytes() for p in sidecars} == sidecars


def test_cache_replay_and_force_bypass(tmp_path, monkeypatch):
    from graphify import cache, llm

    doc = _write(tmp_path, "README.md")
    calls = []

    def extract(files, **kwargs):
        calls.append(files)
        assert os.environ["GRAPHIFY_NO_INCREMENTAL_CACHE"] == ("inherited" if len(calls) == 1 else "1")
        return _result(files, tmp_path, generation=f"run{len(calls)}")

    monkeypatch.setattr(llm, "extract_corpus_parallel", extract)
    monkeypatch.setenv("GRAPHIFY_NO_INCREMENTAL_CACHE", "inherited")
    assert _run(tmp_path) == _run(tmp_path) == 0
    assert calls == [[doc]]
    monkeypatch.setattr(cache, "check_semantic_cache", lambda *a, **kw: pytest.fail("force cache read"))
    monkeypatch.setattr(cache, "load_cached", lambda *a, **kw: pytest.fail("force checkpoint merge"))
    assert _run(tmp_path, "--force") == 0
    assert calls == [[doc], [doc]]
    assert os.environ["GRAPHIFY_NO_INCREMENTAL_CACHE"] == "inherited"
    saved = json.loads((tmp_path / "graphify-out/graph.json").read_text(encoding="utf-8"))
    assert {n["id"] for n in saved["nodes"] if n.get("_origin") == "semantic"} == {
        "README.md:run2:page", "README.md:run2:detail",
    }
    assert any(n.get("node_kind") == "heading" for n in saved["nodes"])
    assert (tmp_path / "graphify-out/.graphify_root").read_text(encoding="utf-8") == str(tmp_path)


def test_doc_derived_code_nodes_replay_and_refresh_without_ast_authority(tmp_path, monkeypatch):
    from graphify import llm

    graph, before = _seed(tmp_path)
    _write(tmp_path, "README.md")
    calls = []

    def extract(files, **kwargs):
        calls.append(files)
        result = _result(files, tmp_path)
        result["nodes"][1].update(file_type="code", label=f"Documented symbol version {len(calls)}")
        return result

    monkeypatch.setattr(llm, "extract_corpus_parallel", extract)
    assert _run(tmp_path) == _run(tmp_path) == _run(tmp_path, "--force") == 0
    assert len(calls) == 2
    after = json.loads(graph.read_text(encoding="utf-8"))
    symbol = next(n for n in after["nodes"] if n["id"] == "README.md:fresh:detail")
    assert symbol["file_type"] == "code" and symbol["source_file"] == "README.md"
    assert symbol["_origin"] == "semantic" and symbol["label"] == "Documented symbol version 2"
    assert after["nodes"][:len(before["nodes"])] == before["nodes"]
    assert after["graph"]["semantic_evidence"] == before["graph"]["semantic_evidence"]


def test_new_parallel_document_relations_set_multigraph(tmp_path, monkeypatch):
    import networkx as nx
    from graphify import llm

    doc = _write(tmp_path, "README.md")
    result = _result([doc], tmp_path)
    result["edges"].append({**result["edges"][0], "relation": "references"})
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: result)
    assert _run(tmp_path) == 0
    saved = json.loads((tmp_path / "graphify-out/graph.json").read_text(encoding="utf-8"))
    assert saved["multigraph"] is True
    assert nx.node_link_graph(saved, edges="edges").number_of_edges(
        "README.md:fresh:page", "README.md:fresh:detail",
    ) == 2


def test_completed_chunk_checkpoint_survives_failure_and_retry(tmp_path, monkeypatch, _isolate_backend_env):
    from graphify import llm

    graph, original = _seed(tmp_path)
    _write(tmp_path, "first.md")
    _write(tmp_path, "second.md")
    attempts = []

    def model_chunk(files, **kwargs):
        name = files[0].name
        attempts.append(name)
        if name == "second.md" and attempts.count(name) == 1:
            raise RuntimeError("fixture model chunk failed")
        return _result(files, tmp_path)

    monkeypatch.setattr(llm, "extract_corpus_parallel", _isolate_backend_env)
    monkeypatch.setattr(llm, "_pack_chunks_by_tokens", lambda files, **kw: [[path] for path in files])
    monkeypatch.setattr(llm, "_extract_with_adaptive_retry", model_chunk)
    assert _run(tmp_path) == 0
    partial = json.loads(graph.read_text(encoding="utf-8"))
    assert partial["nodes"][:len(original["nodes"])] == original["nodes"]
    assert any(n["id"] == "first.md:fresh:page" for n in partial["nodes"])
    assert any(n["source_file"] == "second.md" and n.get("attributes", {}).get("semantic_coverage") == "partial"
               for n in partial["nodes"])
    assert _run(tmp_path) == 0
    assert attempts == ["first.md", "second.md", "second.md"]
    saved = json.loads(graph.read_text(encoding="utf-8"))
    assert saved["nodes"][:len(original["nodes"])] == original["nodes"]


def test_source_edit_cannot_leave_a_complete_checkpoint_under_new_hash(tmp_path, monkeypatch, _isolate_backend_env):
    from graphify import cache, llm

    graph, _ = _seed(tmp_path)
    doc = _write(tmp_path, "README.md")
    before = graph.read_bytes()

    def model_chunk(files, **kwargs):
        result = _result(files, tmp_path)
        doc.write_text("# Edited while the model was extracting old content\n", encoding="utf-8")
        return result

    monkeypatch.setattr(llm, "extract_corpus_parallel", _isolate_backend_env)
    monkeypatch.setattr(llm, "_extract_with_adaptive_retry", model_chunk)
    with pytest.raises(RuntimeError, match="inputs changed"):
        _run(tmp_path)
    assert graph.read_bytes() == before
    nodes, edges, hyperedges, pending = cache.check_semantic_cache(
        [str(doc)], root=tmp_path, prompt=llm._extraction_system(),
    )
    assert not nodes and not edges and not hyperedges and pending == [str(doc)]


@pytest.mark.parametrize("failure", [
    "chunk", "uncovered", "partial-file", "partial-item", "omitted", "stray-only",
    "code-id", "untouched-id", "shape", "endpoint", "type", "label", "edge-collision",
])
def test_partial_results_survive_but_invalid_graph_data_is_rejected(tmp_path, monkeypatch, failure):
    from graphify import cache, llm

    graph, original = _seed(tmp_path)
    _write(tmp_path, "README.md")
    _write(tmp_path, "docs/other.md")
    before = graph.read_bytes()

    def extract(files, **kwargs):
        result = _result(files, tmp_path)
        if failure == "chunk":
            result["failed_chunks"] = 1
        elif failure == "uncovered":
            result["uncovered_files"] = [str(files[0])]
        elif failure == "partial-file":
            result["_partial_files"] = [str(files[0])]
        elif failure == "partial-item":
            result["edges"][0]["_partial"] = True
        elif failure == "omitted":
            return _result(files[:1], tmp_path)
        elif failure == "stray-only":
            for node in result["nodes"]:
                node["source_file"] = "src/Page.tsx"
        elif failure in ("code-id", "untouched-id"):
            result["nodes"].append({**result["nodes"][0], "id": "caller" if failure == "code-id" else "untouched"})
        elif failure == "shape":
            result["nodes"] = {"unexpected": "object"}
        elif failure == "endpoint":
            result["edges"][0]["target"] = "not-in-graph"
        elif failure == "type":
            result["nodes"][0]["file_type"] = "invalid"
        elif failure == "label":
            del result["nodes"][0]["label"]
        elif failure == "edge-collision":
            result["edges"].append({**result["edges"][0], "source": "caller", "target": "callee"})
        return result

    monkeypatch.setattr(llm, "extract_corpus_parallel", extract)
    if failure == "hyper-collision":
        assert _run(tmp_path, "--force") == 0
        after = json.loads(graph.read_text(encoding="utf-8"))
        groups = [h for h in after["graph"]["hyperedges"] if h.get("id") == "code-group"]
        assert len(groups) == 2
        assert original["graph"]["hyperedges"][0] in groups
        assert {h["source_file"] for h in groups} == {"src/Page.tsx", "README.md"}
        return
    if failure in {"type", "unknown-type", "unknown-confidence"}:
        assert _run(tmp_path, "--force") == 0
        after = json.loads(graph.read_text(encoding="utf-8"))
        assert after["nodes"][:len(original["nodes"])] == original["nodes"]
        if failure == "unknown-type":
            assert any(n.get("attributes", {}).get("model_file_type") == "ast" for n in after["nodes"])
        elif failure == "unknown-confidence":
            assert all(e.get("confidence") != "made-up" for e in after["links"])
        else:
            assert any(n.get("node_kind") == "doc_concept" and n.get("file_type") == "concept"
                       for n in after["nodes"])
        return
    if failure == "code-id":
        assert _run(tmp_path, "--force") == 0
        after = json.loads(graph.read_text(encoding="utf-8"))
        assert after["nodes"][:len(original["nodes"])] == original["nodes"]
        assert any(n["id"].startswith("caller__doc_") and n["source_file"].endswith(".md")
                   for n in after["nodes"])
        monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: pytest.fail("alias cache miss"))
        assert _run(tmp_path) == 0
        return
    if failure == "endpoint":
        assert _run(tmp_path, "--force") == 0
        after = json.loads(graph.read_text(encoding="utf-8"))
        assert after["nodes"][:len(original["nodes"])] == original["nodes"]
        assert any(hint.get("text") == "not-in-graph"
                   for node in after["nodes"]
                   for hint in node.get("attributes", {}).get("code_hints", []))
        return
    if failure in {"chunk", "uncovered", "partial-file", "partial-item", "omitted", "stray-only"}:
        save = cache.save_semantic_cache

        def save_partial(*args, **kwargs):
            assert kwargs.get("partial_source_files")
            return save(*args, **kwargs)

        monkeypatch.setattr(cache, "save_semantic_cache", save_partial)
        assert _run(tmp_path, "--force") == 0
        after = json.loads(graph.read_text(encoding="utf-8"))
        assert after["nodes"][:len(original["nodes"])] == original["nodes"]
        assert after["graph"]["semantic_evidence"] == original["graph"]["semantic_evidence"]
        assert any(n.get("node_kind") == "heading" for n in after["nodes"])
        assert any(n.get("attributes", {}).get("semantic_coverage") == "partial" for n in after["nodes"])
        return
    monkeypatch.setattr(cache, "save_semantic_cache", lambda *a, **kw: pytest.fail("invalid complete cache save"))
    with pytest.raises((RuntimeError, ValueError)):
        _run(tmp_path, "--force")
    assert graph.read_bytes() == before


@pytest.mark.parametrize("corruption", ["json", "metadata", "evidence", "nodes", "edges", "empty-object", "hyperedges"])
def test_corrupt_existing_graph_fails_before_provider(tmp_path, corruption):
    graph, data = _seed(tmp_path)
    _write(tmp_path, "README.md")
    if corruption == "metadata":
        data["graph"] = []
    elif corruption == "evidence":
        data["graph"]["semantic_evidence"] = {"invalid": True}
    elif corruption == "nodes":
        data["nodes"] = ["invalid"]
    elif corruption == "edges":
        data["links"][0]["target"] = "missing"
    elif corruption == "empty-object":
        data["nodes"] = data["links"] = {}
    elif corruption == "hyperedges":
        data["hyperedges"] = None
    graph.write_text("{" if corruption == "json" else json.dumps(data), encoding="utf-8")
    before = graph.read_bytes()
    with pytest.raises((RuntimeError, ValueError)):
        _run(tmp_path)
    assert graph.read_bytes() == before


@pytest.mark.parametrize("force,partial", [(False, False), (True, False), (True, True)])
def test_semantic_shrink_requires_explicit_force_and_complete_result(tmp_path, monkeypatch, force, partial):
    from graphify import llm

    graph, data = _seed(tmp_path)
    doc = _write(tmp_path, "README.md")
    previous = _result([doc], tmp_path, generation="old")
    for node in previous["nodes"]:
        node["_origin"] = "semantic"
    data["nodes"].extend(previous["nodes"])
    graph.write_text(json.dumps(data), encoding="utf-8")
    fresh = _result([doc], tmp_path)
    fresh["nodes"] = fresh["nodes"][:1]
    fresh["edges"] = fresh["hyperedges"] = []
    if partial:
        fresh["_partial_files"] = [str(doc)]
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: fresh)
    assert _run(tmp_path, *(["--force"] if force else [])) == 0
    after = json.loads(graph.read_text(encoding="utf-8"))
    ids = {n["id"] for n in after["nodes"] if n["source_file"] == "README.md" and n.get("_origin") == "semantic"}
    assert fresh["nodes"][0]["id"] in ids
    old_ids = {n["id"] for n in previous["nodes"]}
    assert old_ids.isdisjoint(ids) if force and not partial else old_ids <= ids
    assert after["nodes"][:len(data["nodes"]) - 2] == data["nodes"][:-2]


@pytest.mark.parametrize("dry_run", [False, True])
def test_empty_and_dry_run_do_not_import_llm_or_mutate_output(tmp_path, monkeypatch, capsys, dry_run):
    if dry_run:
        _write(tmp_path, "README.md")
    _write(tmp_path, "src/libs/ignored.md")
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        assert name != "graphify.llm", "dry/empty run imported llm"
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    assert _run(tmp_path, *(["--dry-run"] if dry_run else [])) == 0
    assert not (tmp_path / "graphify-out").exists()
    if dry_run:
        assert capsys.readouterr().out == "README.md\n"


def test_links_and_junctions_are_pruned_before_walk(tmp_path, monkeypatch, capsys):
    _write(tmp_path, "README.md")
    junction = tmp_path / "junction"
    _write(tmp_path, "junction/escape.md")
    original_lstat = Path.lstat

    def lstat(path, *args, **kwargs):
        if path == junction:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    assert _run(tmp_path, "--dry-run") == 0
    assert capsys.readouterr().out == "README.md\n"


def test_symlink_escape_is_never_admitted(tmp_path, capsys):
    outside = _write(tmp_path.parent, "outside-markdown.md")
    try:
        (tmp_path / "linked.md").symlink_to(outside)
        (tmp_path / "linked-dir").symlink_to(outside.parent, target_is_directory=True)
    except OSError:
        pytest.skip("Symlink creation requires Windows Developer Mode or privilege")
    assert _run(tmp_path, "--dry-run") == 0
    assert capsys.readouterr().out == ""


def test_mismatched_output_marker_is_not_rebound(tmp_path):
    _write(tmp_path, "README.md")
    marker = _write(tmp_path, "graphify-out/.graphify_root", str(tmp_path.parent))
    with pytest.raises(ValueError, match="does not match"):
        _run(tmp_path)
    assert marker.read_text(encoding="utf-8") == str(tmp_path.parent)


def test_atomic_write_failure_leaves_saved_graph(tmp_path, monkeypatch):
    from graphify import llm, paths

    graph, _ = _seed(tmp_path)
    _write(tmp_path, "README.md")
    before = graph.read_bytes()
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda files, **kw: _result(files, tmp_path))

    def fail_write(*args, **kwargs):
        raise OSError("fixture atomic write failure")

    monkeypatch.setattr(paths, "write_json_atomic", fail_write)
    with pytest.raises(OSError, match="atomic write failure"):
        _run(tmp_path)
    assert graph.read_bytes() == before


@pytest.mark.parametrize("changed", ["document", "graph"])
@pytest.mark.parametrize("force", [False, True])
def test_concurrent_edits_refuse_publication_and_cache_save(tmp_path, monkeypatch, changed, force):
    from graphify import cache, llm

    graph, _ = _seed(tmp_path)
    _write(tmp_path, "README.md")
    expected = graph.read_bytes()

    def extract(files, **kwargs):
        nonlocal expected
        result = _result(files, tmp_path)
        if changed == "document":
            _write(tmp_path, "README.md", "# Different source contents during inference\n")
        else:
            graph.write_text('{"concurrent": "fixture edit"}', encoding="utf-8")
            expected = graph.read_bytes()
        return result

    monkeypatch.setattr(llm, "extract_corpus_parallel", extract)
    monkeypatch.setattr(cache, "save_semantic_cache", lambda *a, **kw: pytest.fail("cache save after concurrent edit"))
    if force:
        monkeypatch.setattr(cache, "mark_semantic_cache_partial", lambda *a, **kw: pytest.fail("force cache read"))
    with pytest.raises(RuntimeError, match="changed during extraction"):
        _run(tmp_path, *(["--force"] if force else []))
    assert graph.read_bytes() == expected


def test_existing_protected_graph_backup_policy_is_reused(tmp_path, monkeypatch):
    from graphify import llm

    graph, _ = _seed(tmp_path)
    _write(tmp_path, "README.md")
    _write(tmp_path, "graphify-out/.graphify_semantic_marker", "protected")
    before = graph.read_bytes()
    monkeypatch.delenv("GRAPHIFY_NO_BACKUP", raising=False)
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda files, **kw: _result(files, tmp_path))
    assert _run(tmp_path) == 0
    assert (graph.parent / date.today().isoformat() / "graph.json").read_bytes() == before


def test_linked_cache_entries_are_refused_before_provider(tmp_path):
    graph, _ = _seed(tmp_path)
    _write(tmp_path, "README.md")
    outside = _write(tmp_path.parent, "outside-cache.json", '{}')
    try:
        (graph.parent / "cache/semantic/linked.json").symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation requires Windows Developer Mode or privilege")
    before = graph.read_bytes()
    with pytest.raises(ValueError, match="linked semantic cache"):
        _run(tmp_path)
    assert graph.read_bytes() == before


def test_protected_backup_cannot_escape_output_through_link(tmp_path, monkeypatch):
    from graphify import llm

    graph, _ = _seed(tmp_path)
    _write(tmp_path, "README.md")
    _write(tmp_path, "graphify-out/.graphify_semantic_marker", "protected")
    outside = tmp_path.parent / "outside-backup"
    outside.mkdir()
    try:
        (graph.parent / date.today().isoformat()).symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Symlink creation requires Windows Developer Mode or privilege")
    before = graph.read_bytes()
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda files, **kw: _result(files, tmp_path))
    with pytest.raises(ValueError, match="linked graph backup"):
        _run(tmp_path)
    assert graph.read_bytes() == before
    assert not list(outside.iterdir())
def test_scoped_refresh_preserves_every_code_call_site_and_import_flag(tmp_path, monkeypatch):
    from graphify import llm

    graph, original = _seed(tmp_path)
    original["links"].extend([
        {**original["links"][0], "source_location": "L20"},
        {**original["links"][0], "relation": "imports", "type_only": True},
    ])
    graph.write_text(json.dumps(original), encoding="utf-8")
    _write(tmp_path, "README.md")
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda files, **kw: _result(files, tmp_path))
    assert _run(tmp_path) == 0
    after = json.loads(graph.read_text(encoding="utf-8"))
    assert after["links"][:len(original["links"])] == original["links"]
    assert after["graph"]["semantic_evidence"] == original["graph"]["semantic_evidence"]


def test_native_repeated_hyperedge_ids_survive_refresh_and_cache_replay(tmp_path, monkeypatch):
    from graphify import llm

    graph, original = _seed(tmp_path)
    original["graph"]["hyperedges"].append({
        **original["graph"]["hyperedges"][0], "nodes": ["callee"], "label": "Separate code group",
    })
    graph.write_text(json.dumps(original), encoding="utf-8")
    doc = _write(tmp_path, "README.md")
    result = _result([doc], tmp_path)
    result["hyperedges"].append({
        **result["hyperedges"][0], "nodes": [result["nodes"][1]["id"]], "label": "Another document slice",
    })
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: result)
    assert _run(tmp_path) == 0
    first = json.loads(graph.read_text(encoding="utf-8"))
    groups = first["graph"]["hyperedges"]
    assert len(groups) == 4
    assert all(h in groups for h in original["graph"]["hyperedges"])
    assert sum(h["source_file"] == "README.md" for h in groups) == 2
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: pytest.fail("unexpected cache miss"))
    assert _run(tmp_path) == 0
    second = json.loads(graph.read_text(encoding="utf-8"))
    assert second["graph"]["hyperedges"] == groups
    assert second["graph"]["semantic_evidence"] == original["graph"]["semantic_evidence"]


def test_retired_document_ids_remain_anchors_for_untouched_references(tmp_path, monkeypatch, capsys):
    from graphify import llm

    graph, original = _seed(tmp_path)
    original["nodes"].append({
        "id": "legacy_doc", "label": "Original overview", "file_type": "concept",
        "node_kind": "doc_concept", "source_file": "README.md", "_origin": "semantic",
    })
    reference = {"source": "legacy_doc", "target": "caller", "relation": "cites",
                 "source_file": "legacy-location.md", "confidence": "INFERRED", "_origin": "semantic"}
    original["links"].append(reference)
    original["graph"]["hyperedges"][0]["nodes"].append("legacy_doc")
    graph.write_text(json.dumps(original), encoding="utf-8")
    _write(tmp_path, "README.md")
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda files, **kw: _result(files, tmp_path))
    assert _run(tmp_path) == 0
    first = json.loads(graph.read_text(encoding="utf-8"))
    anchor = next(n for n in first["nodes"] if n["id"] == "legacy_doc")
    assert anchor["_generated_by"] == "markdown-reference-anchor-v1"
    assert anchor["source_file"] == "README.md" and anchor["_origin"] == "semantic"
    assert reference in first["links"]
    assert first["graph"]["hyperedges"] == original["graph"]["hyperedges"] + [
        h for h in first["graph"]["hyperedges"] if h.get("source_file") == "README.md"
    ]
    assert first["graph"]["semantic_evidence"] == original["graph"]["semantic_evidence"]
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: pytest.fail("unexpected cache miss"))
    assert _run(tmp_path) == 0
    assert "0 semantic source(s) pending" in capsys.readouterr().out
    second = json.loads(graph.read_text(encoding="utf-8"))
    assert reference in second["links"]
    assert next(n for n in second["nodes"] if n["id"] == "legacy_doc") == anchor


def test_model_cannot_claim_runtime_reference_anchor_ownership():
    from graphify.llm import prepare_markdown_semantics

    data = {"nodes": [{"id": "topic", "label": "Topic", "file_type": "concept",
                       "source_file": "guide.md", "_generated_by": "markdown-reference-anchor-v1",
                       "attributes": {"retained_reference_anchor": True}}], "edges": [], "hyperedges": []}
    prepare_markdown_semantics(data)
    assert "_generated_by" not in data["nodes"][0]
    assert "retained_reference_anchor" not in data["nodes"][0]["attributes"]


@pytest.mark.parametrize("missing_source", [False, True])
def test_partial_relationships_and_group_members_remain_as_hints(tmp_path, monkeypatch, missing_source):
    from graphify import llm

    graph, original = _seed(tmp_path)
    doc = _write(tmp_path, "README.md")
    result = _result([doc], tmp_path)
    result["edges"][0]["source" if missing_source else "target"] = "omitted_symbol"
    result["hyperedges"][0]["nodes"].append("omitted_group_member")
    result["_partial_files"] = [str(doc)]
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: result)
    assert _run(tmp_path) == 0
    after = json.loads(graph.read_text(encoding="utf-8"))
    assert after["nodes"][:len(original["nodes"])] == original["nodes"]
    hints = {h["text"] for n in after["nodes"] for h in n.get("attributes", {}).get("code_hints", [])}
    assert {"omitted_symbol", "omitted_group_member"} <= hints
    group = next(h for h in after["graph"]["hyperedges"] if h.get("source_file") == "README.md")
    assert group["unresolved_members"] == ["omitted_group_member"]
    assert "omitted_group_member" not in group["nodes"]


def test_scoped_variants_keep_source_local_candidate_associations(tmp_path):
    from graphify.build import _normalize_id

    files = [_write(tmp_path, name) for name in ("first.md", "second.md", "third.md")]
    result = _result(files, tmp_path)
    for index, node in enumerate(result["nodes"]):
        if index % 2:
            node.update(id="shared", label="Component")
    first = result["nodes"][1]
    first["label"] = "@Package README"
    result["nodes"].extend([
        {**first, "label": "Package README"},
        *({**first, "id": "function", "label": name} for name in ("f1", "f2", "f3", "f4")),
    ])
    for edge, group in zip(result["edges"], result["hyperedges"]):
        edge.update(target="shared", relation="calls", _src=edge["source"], _tgt="shared")
        group.update(id="repeated-display-id", nodes=[edge["source"], "shared"])
    result["edges"].append({**result["edges"][0], "target": "function"})
    result["edges"].append({**result["edges"][0], "source": "function"})
    result["hyperedges"].append({**result["hyperedges"][0], "nodes": ["function"]})
    before = copy.deepcopy(result)
    scoped = script._scoped_result(result, files, tmp_path)
    assert result == before
    ids = {n["id"] for n in scoped["nodes"]}
    assert len(ids) == len(scoped["nodes"]) == len({_normalize_id(nid) for nid in ids})
    script._validate_records(scoped)
    by_id = {n["id"]: n for n in scoped["nodes"]}
    for edge in scoped["edges"]:
        assert (edge["_src"], edge["_tgt"]) == (edge["source"], edge["target"])
        assert by_id[edge["source"]]["source_file"] == edge["source_file"]
        assert by_id[edge["target"]]["source_file"] == edge["source_file"]
        assert edge["relation"] == "references" and edge["documented_relation"] == "calls"
        if edge["source_file"] == "first.md":
            assert edge["confidence"] == "AMBIGUOUS" and "Ambiguous semantic endpoint" in edge["match_reason"]
            assert edge["confidence_score"] <= 0.5
        else:
            assert edge["confidence"] == "EXTRACTED"
    assert {by_id[e["target"]]["label"] for e in scoped["edges"] if e["source_file"] == "first.md"} == {
        "@Package README", "Package README", "f1", "f2", "f3", "f4",
    }
    assert len(scoped["hyperedges"]) == 4
    for group in scoped["hyperedges"]:
        assert group["id"] == "repeated-display-id"
        assert all(by_id[nid]["source_file"] == group["source_file"] for nid in group["nodes"])
        if group["source_file"] == "first.md":
            assert group["confidence"] == "AMBIGUOUS" and group["match_reason"]
    assert script._scoped_result(scoped, files, tmp_path) == scoped
    result["nodes"].reverse()
    assert script._scoped_result(result, files, tmp_path) == scoped


def test_sparse_ambiguous_sibling_labels_are_candidates_not_an_arbitrary_winner(tmp_path):
    doc = _write(tmp_path, "guide.md")
    base = {"id": "reused", "source_file": "guide.md", "file_type": "concept"}
    scoped = script._scoped_result({"nodes": [
        {**base, "label": "First"}, {**base, "label": "Second"},
        {**base, "metadata": {"note": "uncertain detail"}, "match_reason": "Original observation"},
    ]}, [doc], tmp_path)
    assert {node["label"] for node in scoped["nodes"]} == {"First", "Second"}
    assert all(node["confidence"] == "AMBIGUOUS" for node in scoped["nodes"])
    assert all(node["metadata"] == {"note": "uncertain detail"} for node in scoped["nodes"])
    assert all("Original observation; Label inherited" in node["match_reason"] for node in scoped["nodes"])
    assert script._scoped_result(scoped, [doc], tmp_path) == scoped


def test_scoped_compatible_metadata_sparse_labels_and_conflicting_details(tmp_path):
    doc = _write(tmp_path, "guide.md")
    base = {"id": "entry", "label": "Entry", "source_file": "guide.md", "file_type": "concept"}
    result = {"nodes": [
        {**base, "rationale": "Keep independent ownership", "attributes": {"aliases": ["First"], "summary": "Summary"}},
        {**base, "attributes": {"aliases": ["Second"], "section": "Usage"}},
        {**base, "label": None, "source_location": "L3", "metadata": {"review": "uncertain"}},
        {**base, "id": "detail", "source_location": "L5", "rationale": "First explanation"},
        {**base, "id": "detail", "source_location": "L9", "rationale": "Different explanation"},
    ], "edges": [], "hyperedges": []}
    result["nodes"].append(copy.deepcopy(result["nodes"][0]))
    scoped = script._scoped_result(result, [doc], tmp_path)
    assert len(scoped["nodes"]) == 3
    merged = next(n for n in scoped["nodes"] if n["id"] == "entry")
    assert merged["label"] == "Entry" and merged["source_location"] == "L3"
    assert merged["rationale"] == "Keep independent ownership"
    assert merged["metadata"] == {"review": "uncertain"}
    assert merged["attributes"] == {"aliases": ["First", "Second"], "summary": "Summary", "section": "Usage"}
    details = [n for n in scoped["nodes"] if n["id"] != "entry"]
    assert {(n["source_location"], n["rationale"]) for n in details} == {
        ("L5", "First explanation"), ("L9", "Different explanation"),
    }
    assert all(any(h["text"] == "detail" for h in n["attributes"]["code_hints"]) for n in details)
    assert script._scoped_result(scoped, [doc], tmp_path) == scoped


def test_scoped_normalized_id_collisions_and_foreign_candidates(tmp_path):
    from graphify.build import _normalize_id, finalize_raw_graph_endpoints

    files = [_write(tmp_path, name) for name in ("one.md", "two.md")]
    base = {"source_file": "one.md", "file_type": "document"}
    result = {"nodes": [
        {**base, "id": "same.id", "label": "First"},
        {**base, "id": "same-id", "label": "Second"},
        {**base, "id": "anchor", "label": "Anchor"},
        {**base, "id": "other", "label": "Other", "source_file": "two.md"},
        {**base, "id": "remote.id", "label": "Local punctuation variant"},
        {**base, "id": "remote-id", "label": "Explicit foreign endpoint", "source_file": "two.md"},
    ], "edges": [
        {"source": "anchor", "target": target, "relation": "references", "confidence": "INFERRED", "source_file": "one.md"}
        for target in ("same.id", "same-id", "SAME ID")
    ], "hyperedges": [{"id": "group", "nodes": ["other", "SAME ID"], "source_file": "two.md"}]}
    result["edges"].append({**result["edges"][0], "target": "remote-id"})
    scoped = script._scoped_result(result, files, tmp_path)
    assert len({_normalize_id(n["id"]) for n in scoped["nodes"]}) == 6
    assert len(scoped["edges"]) == 5
    assert [e["confidence"] for e in scoped["edges"]] == ["INFERRED", "INFERRED", "AMBIGUOUS", "AMBIGUOUS", "INFERRED"]
    target = next(n for n in scoped["nodes"] if n["id"] == scoped["edges"][-1]["target"])
    assert target["label"] == "Explicit foreign endpoint" and target["source_file"] == "two.md"
    group = scoped["hyperedges"][0]
    assert len(group["nodes"]) == 3 and group["confidence"] == "AMBIGUOUS"
    expected = copy.deepcopy(scoped["edges"])
    finalize_raw_graph_endpoints(scoped, root=tmp_path)
    assert all(edge in scoped["edges"] for edge in expected)
    script._validate_records(scoped)


def test_normalized_document_id_cannot_capture_existing_code_identity(tmp_path, monkeypatch):
    from graphify import llm
    from graphify.build import _normalize_id

    graph, original = _seed(tmp_path)
    doc = _write(tmp_path, "README.md")
    result = _result([doc], tmp_path)
    old_id = result["nodes"][1]["id"]
    result["nodes"][1]["id"] = "CALLER"
    result["edges"][0]["target"] = "CALLER"
    result["hyperedges"][0]["nodes"] = ["CALLER" if n == old_id else n for n in result["hyperedges"][0]["nodes"]]
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: result)
    assert _run(tmp_path) == 0
    first = json.loads(graph.read_text(encoding="utf-8"))
    assert first["nodes"][:len(original["nodes"])] == original["nodes"]
    assert first["links"][:len(original["links"])] == original["links"]
    assert len({_normalize_id(n["id"]) for n in first["nodes"]}) == len(first["nodes"])
    doc_node = next(n for n in first["nodes"] if n["id"].startswith("caller__doc_"))
    assert doc_node["source_file"] == "README.md"
    assert any(h["text"] == "CALLER" for h in doc_node["attributes"]["code_hints"])
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: pytest.fail("unexpected cache miss"))
    assert _run(tmp_path) == 0
    assert json.loads(graph.read_text(encoding="utf-8")) == first


@pytest.mark.parametrize("failure", ["id", "label", "foreign-label", "source", "endpoint", "group", "relation"])
def test_invalid_cached_metadata_fails_before_pending_dispatch(tmp_path, monkeypatch, failure):
    from graphify import cache

    graph, _ = _seed(tmp_path)
    cached_doc = _write(tmp_path, "cached.md")
    pending_doc = _write(tmp_path, "pending.md")
    cached = _result([cached_doc], tmp_path)
    if failure == "id":
        cached["nodes"][0]["id"] = None
    elif failure in ("label", "foreign-label"):
        del cached["nodes"][0]["label"]
        if failure == "foreign-label":
            cached["nodes"].append({**cached["nodes"][0], "label": "Not a local sibling", "source_file": "pending.md"})
    elif failure == "source":
        cached["nodes"][0]["source_file"] = 42
    elif failure == "endpoint":
        cached["edges"][0]["target"] = None
    elif failure == "group":
        cached["hyperedges"][0]["id"] = 42
    else:
        cached["edges"][0]["relation"] = ""
    monkeypatch.setattr(cache, "check_semantic_cache", lambda *a, **kw: (
        cached["nodes"], cached["edges"], cached["hyperedges"], [str(pending_doc)],
    ))
    before = graph.read_bytes()
    with pytest.raises(ValueError):
        _run(tmp_path)
    assert graph.read_bytes() == before


@pytest.mark.parametrize("partial", [False, True])
def test_native_cached_variants_combine_with_fresh_without_code_loss(tmp_path, monkeypatch, partial):
    from graphify import cache, llm
    from graphify.build import _normalize_id

    graph, original = _seed(tmp_path)
    cached_doc = _write(tmp_path, "cached.md")
    fresh_doc = _write(tmp_path, "fresh.md")

    def result(doc):
        data = _result([doc], tmp_path)
        data["nodes"][1].update(id="caller", label="First documented function", file_type="code")
        data["nodes"].append({**data["nodes"][1], "label": "Second documented function"})
        data["edges"][0].update(target="caller", relation="calls", source_location="L2")
        data["edges"].append({**data["edges"][0], "source_location": "L8"})
        data["hyperedges"][0].update(id="shared-group", nodes=[data["nodes"][0]["id"], "caller"])
        data["hyperedges"].append({**data["hyperedges"][0], "label": "Another group", "nodes": ["caller"]})
        return data

    cached, fresh = result(cached_doc), result(fresh_doc)
    cache.save_semantic_cache(**cached, root=tmp_path, prompt=llm._extraction_system())
    if partial:
        fresh["_partial_files"] = [str(fresh_doc)]
    calls = []

    def extract(files, **kwargs):
        calls.append(files)
        return fresh

    monkeypatch.setattr(llm, "extract_corpus_parallel", extract)
    assert _run(tmp_path) == 0
    assert calls == [[fresh_doc]]
    first = json.loads(graph.read_text(encoding="utf-8"))
    assert first["nodes"][:len(original["nodes"])] == original["nodes"]
    assert first["links"][:len(original["links"])] == original["links"]
    assert first["graph"]["semantic_evidence"] == original["graph"]["semantic_evidence"]
    mentions = [n for n in first["nodes"] if n.get("node_kind") == "doc_mention"]
    assert len(mentions) == 4
    assert len({_normalize_id(n["id"]) for n in mentions}) == 4
    for source in ("cached.md", "fresh.md"):
        ids = {n["id"] for n in mentions if n["source_file"] == source}
        claims = [e for e in first["links"] if e.get("documented_relation") == "calls" and e["source_file"] == source]
        assert len(claims) == 4
        assert {e["target"] for e in claims} == ids
        assert {e["source_location"] for e in claims} == {"L2", "L8"}
        assert all(e["confidence"] == "AMBIGUOUS" and e["relation"] == "references" for e in claims)
        groups = [h for h in first["graph"]["hyperedges"] if h.get("source_file") == source]
        assert len(groups) == 2 and all(ids <= set(h["nodes"]) for h in groups)
    if partial:
        assert any(n.get("attributes", {}).get("semantic_coverage") == "partial" for n in first["nodes"]
                   if n.get("source_file") == "fresh.md")
    else:
        monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: pytest.fail("unexpected cache miss"))
        cache._stat_index.clear()
        assert _run(tmp_path) == 0
        second = json.loads(graph.read_text(encoding="utf-8"))
        assert second == first
