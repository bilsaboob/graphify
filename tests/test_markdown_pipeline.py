"""Offline end-to-end coverage for document enrichment in existing pipelines."""
from __future__ import annotations

import copy
import json
import sys

import pytest

from graphify.build import build_from_json, build_merge, merge_raw_extraction
from graphify.markdown_resolution import DOCUMENTATION_EDGE_PRODUCER


def _node(nid, source="notes.md", *, kind="doc_concept", **attrs):
    code = kind == "code"
    return {"id": nid, "label": nid, "source_file": source, "source_location": "L1",
            "file_type": "code" if code else "concept", "node_kind": kind,
            "_origin": "ast" if code else "semantic", "attributes": attrs}


def _save(path, nodes, edges=(), hyperedges=()):
    data = {"nodes": nodes, "edges": list(edges), "hyperedges": list(hyperedges),
            "directed": True, "multigraph": False, "graph": {"owner": "fixture"}}
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


@pytest.mark.parametrize("clustered", [False, True])
def test_partial_refresh_retains_entities_details_and_groups(tmp_path, clustered):
    old = _node("meaning", aliases=["old term"], code_hints=[{"text": "oldName"}])
    other = _node("other")
    group = {"id": "group", "label": "Documented flow", "nodes": ["meaning", "other"],
             "source_file": "notes.md", "_origin": "semantic"}
    path = tmp_path / "graph.json"
    _save(path, [old, other, _node("api", "api.py", kind="code")], hyperedges=[group])
    fresh = {
        "nodes": [_node("meaning", aliases=["new term"], code_hints=[{"text": "newName"}]),
                  _node("new_fact")],
        "edges": [], "hyperedges": [{**group, "nodes": ["meaning", "new_fact"]}],
        "_partial_files": [str(tmp_path / "notes.md")],
    }
    if clustered:
        graph = build_merge([fresh], path, root=tmp_path, dedup=False)
        nodes = dict(graph.nodes(data=True))
        groups = graph.graph["hyperedges"]
        assert not graph.graph.get("_unverified_semantic_shrink")
    else:
        result = merge_raw_extraction(fresh, path, root=tmp_path)
        nodes = {n["id"]: n for n in result["nodes"]}
        groups = result["hyperedges"]
        assert not result.get("_unverified_semantic_shrink")
    assert {"meaning", "other", "new_fact", "api"} <= nodes.keys()
    assert nodes["meaning"]["attributes"]["aliases"] == ["old term", "new term"]
    assert nodes["meaning"]["attributes"]["code_hints"] == [{"text": "oldName"}, {"text": "newName"}]
    assert len(groups) == 1 and set(groups[0]["nodes"]) == {"meaning", "other", "new_fact"}


def test_distinct_source_concepts_survive_dedup_and_get_advisory_connection(tmp_path):
    left, right = _node("left", "a.md", summary="Creates the payload"), _node("right", "b.md", summary="Consumes the payload")
    left["label"] = right["label"] = "Session payload"
    graph = build_from_json({"nodes": [left, right], "edges": []}, root=tmp_path)
    assert {"left", "right"} <= set(graph)
    assert graph.edges["left", "right"]["confidence"] == "AMBIGUOUS"
    assert graph.edges["left", "right"]["relation"] == "conceptually_related_to"
    assert graph.nodes["left"]["attributes"]["summary"] != graph.nodes["right"]["attributes"]["summary"]


def test_cluster_export_cannot_resurrect_generated_edge_over_authored_one(tmp_path):
    from graphify.export import to_json

    owner = _node("topic", code_hints=[{"text": "api"}])
    target = _node("api", "api.py", kind="code")
    authored = {"source": "topic", "target": "api", "relation": "references",
                "confidence": "EXTRACTED", "confidence_score": 1.0,
                "source_file": "notes.md", "source_location": "L3", "author_note": "keep"}
    raw = {"nodes": [owner, target], "edges": [
        {**authored, "_generated_by": DOCUMENTATION_EDGE_PRODUCER, "context": "documentation"},
        authored,
    ]}
    graph = build_from_json(raw, root=tmp_path, directed=True)
    path = tmp_path / "roundtrip.json"
    to_json(graph, {0: list(graph)}, str(path), original_links=raw["edges"], force=True)
    saved = json.loads(path.read_text(encoding="utf-8"))
    links = saved.get("links", saved.get("edges", []))
    assert len(links) == 1 and links[0]["author_note"] == "keep"
    assert "_generated_by" not in links[0]
    assert graph.nodes["topic"]["attributes"]["code_candidates"][0]["target_id"] == "api"


@pytest.fixture
def auth_corpus(tmp_path, monkeypatch):
    import graphify.__main__ as mainmod
    from graphify import llm

    monkeypatch.setenv("GRAPHIFY_BACKEND", "ollama")
    monkeypatch.setattr(mainmod, "_check_skill_version", lambda *_: None)
    for directory in ("src", "docs"):
        (tmp_path / directory).mkdir()
    (tmp_path / "src/auth.py").write_text(
        "class AccessPolicy:\n    def canSignIn(self, user):\n        return bool(user)\n\n"
        "def completeSignIn(user):\n    policy = AccessPolicy()\n    return policy.canSignIn(user)\n\n"
        "def createSession(user):\n    return {'user': user}\n", encoding="utf-8",
    )
    (tmp_path / "src/client.py").write_text("def restoreApplication(payload):\n    return payload\n", encoding="utf-8")
    (tmp_path / "docs/auth.md").write_text(
        "# Authentication\n## Eligibility\n`AccessPolicy` decides admission.\n"
        "## Session creation\n```python\nsession = createSession(user)\n```\n", encoding="utf-8",
    )
    (tmp_path / "docs/startup.md").write_text("# Startup\n## Restore\n`restoreApplication` reads the session payload.\n", encoding="utf-8")
    facts = [
        {**_node("eligibility", "docs/auth.md", summary="Controls admission", aliases=["access rules"],
                code_hints=[{"text": "AccessPolicy", "source_location": "L3"}]),
         "label": "Sign-in eligibility", "source_location": "L2"},
        {**_node("auth_payload", "docs/auth.md", summary="Created after sign-in", aliases=["session contract"],
                code_hints=[{"text": "createSession", "role": "producer"}]),
         "label": "Session payload", "source_location": "L4"},
        {**_node("startup_payload", "docs/startup.md", summary="Restores application state", aliases=["session contract"],
                code_hints=[{"text": "restoreApplication", "role": "consumer"}]),
         "label": "Session payload", "source_location": "L2"},
    ]
    calls = []

    def semantics(paths, **kwargs):
        calls.append(list(paths))
        result = {"nodes": copy.deepcopy(facts), "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}
        kwargs["on_chunk_done"](0, 1, result)
        return result

    monkeypatch.setattr(llm, "extract_corpus_parallel", semantics)
    monkeypatch.setattr(sys, "argv", ["graphify", "extract", str(tmp_path), "--backend", "ollama", "--no-cluster"])
    with pytest.raises(SystemExit) as exc:
        mainmod.main()
    assert exc.value.code == 0
    assert len(calls) == 1
    monkeypatch.setattr(llm, "extract_corpus_parallel", lambda *a, **kw: pytest.fail("update called a model"))
    monkeypatch.setenv("GRAPHIFY_BACKEND", "none")
    return tmp_path


def _graph(root):
    from graphify.paths import load_node_link_graph
    data = json.loads((root / "graphify-out/graph.json").read_text(encoding="utf-8"))
    return load_node_link_graph(data)


def test_full_cli_indexes_structure_concepts_examples_and_native_lookup(auth_corpus):
    from graphify.sections import read_section, format_section
    from graphify.serve import _query_graph_text

    graph = _graph(auth_corpus)
    kinds = {n.get("node_kind") for _, n in graph.nodes(data=True)}
    assert {"page", "heading", "doc_concept", "code_example"} <= kinds
    text = _query_graph_text(graph, "access rules docs", depth=3, token_budget=4000, demote_docs=False)
    assert "NODE Sign-in eligibility" in text and "NODE AccessPolicy" in text
    assert "src/auth.py" in text and "attrs=" in text and "match_reason=" in text
    text = _query_graph_text(graph, "session contract docs", depth=3, token_budget=5000, demote_docs=False)
    assert "restoreApplication" in text and "context=consumer" in text and "context=producer" in text
    example = next(n for _, n in graph.nodes(data=True) if n.get("node_kind") == "code_example")
    section, error = read_section(example, auth_corpus)
    assert section is not None, error
    assert "```python" in section.text and "createSession(user)" in section.text
    assert format_section(section, example["label"]).startswith("Section:")
    assert not any(e.get("relation") == "calls" and str(e.get("source_file", "")).endswith(".md")
                   for _, _, e in graph.edges(data=True))


def test_update_rebinds_candidates_and_refreshes_frontmatter_spans_without_llm(auth_corpus):
    from graphify.sections import read_section
    from graphify.watch import _rebuild_code

    before = _graph(auth_corpus)
    concept = next(n for n, d in before.nodes(data=True) if d.get("label") == "Sign-in eligibility")
    extra = auth_corpus / "src/other.py"
    extra.write_text("class AccessPolicy:\n    pass\n", encoding="utf-8")
    assert _rebuild_code(auth_corpus, changed_paths=[extra], no_cluster=True, acquire_lock=False)
    graph = _graph(auth_corpus)
    candidates = [e for a, _, e in graph.edges(data=True) if e.get("_src", a) == concept
                  and e.get("_generated_by") == DOCUMENTATION_EDGE_PRODUCER
                  and e.get("relation") == "references"]
    assert len(candidates) == 2 and all(e["confidence"] == "AMBIGUOUS" for e in candidates)
    extra.unlink()
    assert _rebuild_code(auth_corpus, changed_paths=[extra], no_cluster=True, acquire_lock=False)
    graph = _graph(auth_corpus)
    assert graph.nodes[concept]["attributes"]["code_resolution"]["matched"] == 1
    doc = auth_corpus / "docs/auth.md"
    doc.write_text("---\ntitle: Authentication\n---\n" + doc.read_text(encoding="utf-8"), encoding="utf-8")
    assert _rebuild_code(auth_corpus, incremental=True, no_cluster=True, acquire_lock=False)
    graph = _graph(auth_corpus)
    example = next(n for _, n in graph.nodes(data=True) if n.get("node_kind") == "code_example")
    assert example["attributes"]["start_line"] == 8
    section, error = read_section(example, auth_corpus)
    assert section is not None and not section.note, error
    assert concept in graph and graph.nodes[concept]["attributes"]["aliases"] == ["access rules"]


def test_structure_and_meaning_with_same_id_are_kept_separate(tmp_path):
    from graphify.build import preserve_semantic_identities
    heading = {"id": "topic", "label": "Topic", "file_type": "document", "node_kind": "heading",
               "source_file": "notes.md", "source_location": "L2", "_origin": "ast"}
    concept = _node("topic", summary="A responsibility, not just the heading")
    structure = {"nodes": [heading], "edges": []}
    preserve_semantic_identities(structure, {"nodes": [concept], "edges": []}, root=tmp_path)
    assert heading["id"].startswith("topic__ast_")
    graph = build_from_json({"nodes": [heading, concept], "edges": []}, root=tmp_path)
    assert heading["id"] in graph and "topic" in graph
    assert graph.nodes["topic"]["attributes"]["summary"] == concept["attributes"]["summary"]
