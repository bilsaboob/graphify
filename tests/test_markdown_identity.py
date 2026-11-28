"""Offline publication regressions for document identities and advisory links."""
from __future__ import annotations

import json
from copy import deepcopy
from hashlib import sha256

import pytest

import graphify.build as builder
from graphify.markdown_resolution import DOCUMENTATION_EDGE_PRODUCER, enrich_documentation


def _code(nid="src_widget_widget", label="Widget"):
    return {"id": nid, "label": label, "file_type": "code", "_origin": "ast",
            "source_file": "src/widget.py", "source_location": "L4",
            "attributes": {"typed": "unchanged"}, "_callable": True}


def _doc(nid="docs_guide_usage", *, kind="doc_concept", source="docs/guide.md", **attributes):
    ast = kind in {"page", "heading", "code_example"}
    return {"id": nid, "label": "Usage", "file_type": "document", "node_kind": kind,
            "_origin": "ast" if ast else "semantic", "source_file": source,
            "source_location": "L5" if ast else None, "attributes": attributes}


def _edge(src, dst, *, source="docs/guide.md", origin="semantic", relation="references", **extra):
    return {"source": src, "target": dst, "relation": relation, "_origin": origin,
            "source_file": source, "source_location": "L8", "confidence": "INFERRED", **extra}


def _group(nid, members, *, source="docs/guide.md", origin="semantic"):
    return {"id": nid, "label": "Documentary participants", "nodes": members,
            "relation": "shares_data_with", "confidence": "INFERRED",
            "source_file": source, "_origin": origin}


def _fragment(nodes=(), edges=(), groups=()):
    return {"nodes": list(nodes), "edges": list(edges), "hyperedges": list(groups)}


def _snapshot(G):
    return {"nodes": [{**attrs, "id": nid} for nid, attrs in G.nodes(data=True)],
            "edges": [{**attrs, "source": attrs.get("_src", src), "target": attrs.get("_tgt", dst)}
                      for src, dst, attrs in G.edges(data=True)],
            "hyperedges": deepcopy(G.graph.get("hyperedges", [])), "directed": G.is_directed()}


def _load_snapshot(monkeypatch, snapshot):
    def load(path, *, metadata_out=None):
        data = deepcopy(snapshot)
        if metadata_out is not None:
            metadata_out["data"] = data
        return data["nodes"], data.get("edges", []), data.get("hyperedges", []), data.get("directed", True)

    monkeypatch.setattr(builder, "_load_existing_graph", load)


@pytest.mark.parametrize("kind,file_type", [("doc_concept", "document"), ("doc_mention", "code")])
def test_code_collision_rekeys_only_documentary_occurrence(kind, file_type):
    code, method = _code(), _code("src_widget_run", ".run()")
    call = _edge(code["id"], method["id"], source="src/widget.py", origin="ast", relation="calls")
    code_group = _group("code-group", [code["id"], method["id"]], source="src/widget.py", origin="ast")
    structural = _fragment([code, method], [call], [code_group])
    doc = _doc(code["id"], kind=kind, source="src/widget.md", summary="Separate meaning")
    doc["file_type"] = file_type
    other = _doc("src_widget_flow", source="src/widget.md", summary="A documented flow")
    claim = _edge(doc["id"], other["id"], source="src/widget.md", context="producer")
    doc_group = _group("doc-group", [doc["id"], other["id"]], source="src/widget.md")
    # Even a code-owned edge carried in a semantic fragment is not a doc claim.
    semantic = _fragment([doc, other], [claim, deepcopy(call)], [doc_group, deepcopy(code_group)])
    original_structure = deepcopy(structural)
    original_code_edge, original_code_group = deepcopy(semantic["edges"][1]), deepcopy(semantic["hyperedges"][1])

    builder.preserve_semantic_identities(structural, semantic)

    assert structural == original_structure
    alias = semantic["nodes"][0]["id"]
    assert alias.startswith(code["id"] + "__doc_") and alias != code["id"]
    assert semantic["nodes"][0]["source_file"] == "src/widget.md"
    assert semantic["nodes"][0]["_origin"] == "semantic"
    assert semantic["edges"][0]["source"] == alias
    assert semantic["hyperedges"][0]["nodes"] == [alias, other["id"]]
    assert semantic["edges"][1] == original_code_edge
    assert semantic["hyperedges"][1] == original_code_group
    before = deepcopy((structural, semantic))
    builder.preserve_semantic_identities(structural, semantic)
    assert (structural, semantic) == before


def test_doc_alias_replay_uses_normalized_source_and_retained_code(tmp_path):
    code = _code()
    original_doc = _doc(code["id"], source="src/widget.md", summary="Document meaning")
    other = _doc("src_widget_peer", source="src/widget.md")
    fresh = _fragment([deepcopy(original_doc), deepcopy(other)], [
        _edge(code["id"], other["id"], source="src/widget.md"),
    ], [_group("flow", [code["id"], other["id"]], source="src/widget.md")])
    builder.preserve_semantic_identities(_fragment(), fresh, retained=_fragment([code]), root=tmp_path)
    alias = fresh["nodes"][0]["id"]
    retained = _fragment([deepcopy(code), *deepcopy(fresh["nodes"])], deepcopy(fresh["edges"]), deepcopy(fresh["hyperedges"]))
    retained_before = deepcopy(retained)
    replay = _fragment([original_doc, other], [
        _edge(code["id"], other["id"], source=str(tmp_path / "src" / "widget.md")),
    ], [_group("flow", [code["id"], other["id"]], source="src/widget.md")])
    replay["nodes"][0]["source_file"] = str(tmp_path / "src" / "widget.md")

    builder.preserve_semantic_identities(_fragment(), replay, retained=retained, root=tmp_path)

    assert replay["nodes"][0]["id"] == alias
    assert replay["edges"][0]["source"] == alias
    assert replay["hyperedges"][0]["nodes"][0] == alias
    assert retained == retained_before


@pytest.mark.parametrize("dedup", [False, True])
def test_build_keeps_code_identity_and_documentary_edges_on_collision(dedup):
    code, method = _code(), _code("src_widget_run", ".run()")
    call = _edge(code["id"], method["id"], source="src/widget.py", origin="ast", relation="calls")
    doc = _doc(code["id"], source="src/widget.md", summary="Distinct code documentation")
    peer = _doc("src_widget_peer", source="src/widget.md", summary="Documentary peer")
    semantic = _fragment([doc, peer], [_edge(doc["id"], peer["id"], source="src/widget.md")], [
        _group("flow", [doc["id"], peer["id"]], source="src/widget.md"),
    ])
    G = builder.build([_fragment([code, method], [call]), semantic], directed=True, dedup=dedup)
    alias = next(nid for nid, data in G.nodes(data=True) if data.get("attributes", {}).get("summary") == "Distinct code documentation")
    assert alias != code["id"]
    assert G.nodes[code["id"]] == {k: v for k, v in code.items() if k != "id"}
    assert G.edges[code["id"], method["id"]]["relation"] == "calls"
    assert G.edges[code["id"], method["id"]]["_src"] == code["id"]
    assert G.has_edge(alias, peer["id"])
    assert G.graph["hyperedges"][0]["nodes"] == [alias, peer["id"]]


@pytest.mark.parametrize("mode,dedup", [("raw", False), ("raw", True), ("clustered", False), ("clustered", True)])
def test_partial_refresh_preserves_heading_and_retained_meaning_with_stable_ids(monkeypatch, tmp_path, mode, dedup):
    meaning = _doc(summary="Retained explanation", aliases=["Original meaning"])
    peer = _doc("docs_guide_peer", summary="Related participant")
    code, method = _code(), _code("src_widget_run", ".run()")
    call = _edge(code["id"], method["id"], source="src/widget.py", origin="ast", relation="calls")
    claim = _edge(meaning["id"], peer["id"], context="producer")
    group = _group("flow", [meaning["id"], peer["id"]])
    stored = _fragment([meaning, peer, code, method], [claim, call], [group])
    stored["directed"] = True
    expected_alias = meaning["id"] + "__ast_" + sha256(meaning["id"].encode()).hexdigest()[:16]
    prior_nodes = None

    for _ in range(2):
        _load_snapshot(monkeypatch, stored)
        heading = _doc(kind="heading", code_hints=[{"text": "Widget", "source_location": "L6"}])
        page = _doc("docs_guide", kind="page")
        page["label"] = "guide.md"
        fresh = _fragment([page, heading], [_edge(page["id"], heading["id"], origin="ast", relation="contains")])
        fresh.update(_partial_files=["docs/guide.md"], extracted_sources=["docs/guide.md"])
        if mode == "raw":
            stored = builder.merge_raw_extraction(fresh, tmp_path / "fixture.json", root=tmp_path)
            if dedup:
                from graphify.dedup import deduplicate_entities
                stored["nodes"], stored["edges"] = deduplicate_entities(
                    stored["nodes"], stored["edges"], communities={}, hyperedges=stored["hyperedges"], root=str(tmp_path))
            else:
                stored["nodes"] = builder.dedupe_nodes(stored["nodes"])
            builder.finalize_raw_graph_endpoints(stored, root=tmp_path)
        else:
            G = builder.build_merge([fresh], graph_path=tmp_path / "fixture.json", root=tmp_path, dedup=dedup)
            stored = _snapshot(G)
        by_id = {n["id"]: n for n in stored["nodes"]}
        assert by_id[meaning["id"]]["node_kind"] == "doc_concept"
        assert by_id[meaning["id"]]["_origin"] == "semantic"
        assert by_id[meaning["id"]]["attributes"]["summary"] == "Retained explanation"
        assert by_id[expected_alias]["node_kind"] == "heading"
        assert by_id[expected_alias]["_origin"] == "ast"
        assert any(e["source"] == page["id"] and e["target"] == expected_alias and e["relation"] == "contains"
                   for e in stored["edges"])
        assert any(e["source"] == meaning["id"] and e["target"] == peer["id"] and e.get("context") == "producer"
                   for e in stored["edges"])
        assert any(e["source"] == code["id"] and e["target"] == method["id"] and e["relation"] == "calls"
                   for e in stored["edges"])
        assert stored["hyperedges"][0]["nodes"] == group["nodes"]
        if prior_nodes is not None:
            assert set(by_id) == prior_nodes
        prior_nodes = set(by_id)


def test_combined_raw_fragment_retargets_only_the_corresponding_document_tier():
    heading = _doc(kind="heading")
    meaning = _doc(summary="Keep the meaning")
    page = _doc("docs_guide", kind="page")
    peer = _doc("docs_guide_peer", summary="Peer")
    raw = _fragment([heading, meaning, page, peer], [
        _edge(page["id"], heading["id"], origin="ast", relation="contains"),
        _edge(meaning["id"], peer["id"], context="consumer"),
    ], [_group("flow", [meaning["id"], peer["id"]])])
    builder.preserve_semantic_identities(raw, {})
    alias = heading["id"]
    assert alias != meaning["id"]
    assert raw["edges"][0]["target"] == alias
    assert raw["edges"][1]["source"] == meaning["id"]
    assert raw["hyperedges"][0]["nodes"][0] == meaning["id"]
    before = deepcopy(raw)
    builder.preserve_semantic_identities(raw, {})
    assert raw == before


@pytest.mark.parametrize("mode,dedup", [("raw", False), ("raw", True), ("clustered", False), ("clustered", True)])
def test_partial_doc_code_collision_replay_keeps_prior_details(monkeypatch, tmp_path, mode, dedup):
    code, method = _code(), _code("src_widget_run", ".run()")
    call = _edge(code["id"], method["id"], source="src/widget.py", origin="ast", relation="calls")
    stored = _fragment([code, method], [call])
    stored["directed"] = True
    alias = None
    for attributes in ({"summary": "Retain through partial replay"}, {"aliases": ["Partial update"]}):
        _load_snapshot(monkeypatch, stored)
        doc = _doc(code["id"], source="src/widget.md", **attributes)
        peer = _doc("src_widget_peer", source="src/widget.md", summary="Peer")
        fresh = _fragment([doc, peer], [_edge(doc["id"], peer["id"], source="src/widget.md")], [
            _group("flow", [doc["id"], peer["id"]], source="src/widget.md"),
        ])
        fresh["_partial_files"] = ["src/widget.md"]
        if mode == "raw":
            stored = builder.merge_raw_extraction(fresh, tmp_path / "fixture.json", root=tmp_path)
            if dedup:
                from graphify.dedup import deduplicate_entities
                stored["nodes"], stored["edges"] = deduplicate_entities(
                    stored["nodes"], stored["edges"], communities={}, hyperedges=stored["hyperedges"], root=str(tmp_path))
            else:
                stored["nodes"] = builder.dedupe_nodes(stored["nodes"])
            builder.finalize_raw_graph_endpoints(stored, root=tmp_path)
        else:
            stored = _snapshot(builder.build_merge([fresh], graph_path=tmp_path / "fixture.json", root=tmp_path, dedup=dedup))
        by_id = {node["id"]: node for node in stored["nodes"]}
        current_alias = next(nid for nid in by_id if nid.startswith(code["id"] + "__doc_"))
        assert alias is None or alias == current_alias
        alias = current_alias
        assert by_id[code["id"]] == code
        assert by_id[alias]["attributes"]["summary"] == "Retain through partial replay"
        assert any(edge["source"] == code["id"] and edge["target"] == method["id"] and edge["relation"] == "calls"
                   for edge in stored["edges"])
        assert any(edge["source"] == alias and edge["target"] == peer["id"] for edge in stored["edges"])
        assert stored["hyperedges"][0]["nodes"] == [alias, peer["id"]]


def test_doc_twin_export_uses_rebuilt_shared_original_links(tmp_path):
    from graphify.export import to_json

    page = _doc("docs_guide", kind="page")
    page["label"] = "guide.md"
    twin = {"id": "docs_guide_doc", "label": "Guide", "file_type": "document",
            "source_file": "docs/guide.md", "source_location": None, "_origin": "semantic"}
    concept = _doc(code_hints=[{"text": "Widget", "source_location": "L7"}], summary="Concept")
    code = _code()
    original_links = [
        _edge(page["id"], twin["id"], origin="ast"),
        _edge(concept["id"], "removed-code", _generated_by=DOCUMENTATION_EDGE_PRODUCER),
    ]
    raw = {"nodes": [page, twin, concept, code], "links": original_links}
    G = builder.build_from_json(raw, directed=True, dedup=False)
    assert raw["links"] is original_links
    assert all(e["source"] != e["target"] for e in original_links)
    assert not any(e["target"] == "removed-code" for e in original_links)
    assert any(e["source"] == concept["id"] and e["target"] == code["id"] for e in original_links)
    out = tmp_path / "graph.json"
    assert to_json(G, {}, str(out), original_links=original_links, built_at_commit="fixture", force=True)
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert any(e["source"] == concept["id"] and e["target"] == code["id"] for e in saved["links"])
    assert not any(e["target"] == "removed-code" for e in saved["links"])
    rebuilt = builder.build_from_json(saved, directed=True, dedup=False)
    assert rebuilt.has_edge(concept["id"], code["id"])
    assert len(saved["links"]) == len(original_links)


@pytest.mark.parametrize("contexts", [["producer"], ["producer", "consumer"]])
def test_adapter_uses_original_claims_once_without_discarding_distinct_roles(contexts):
    concept = _doc(summary="Documentary flow")
    stub = _doc("docs_guide_stub", kind="doc_mention", code_hints=[{"text": "Widget", "source_location": "L8"}])
    code = _code()
    claims = [_edge(concept["id"], stub["id"], context=context, source_location=f"L{8 + i}")
              for i, context in enumerate(contexts)]
    raw = _fragment([concept, stub, code], claims)
    G = builder.build_from_json(raw, directed=True, dedup=False)
    attributes = G.nodes[concept["id"]]["attributes"]
    assert attributes["code_resolution"] == {"matched": len(contexts), "ambiguous": 0, "unresolved": 0}
    assert G.edges[concept["id"], code["id"]]["context"] == contexts[0]
    details = attributes.get("code_candidates", [])
    assert [candidate["context"] for candidate in details] == contexts[1:]
    assert all("_generated_by" not in claim for claim in claims)
    before = deepcopy(attributes)
    builder._enrich_document_graph(G, original_edges=raw["edges"])
    assert G.nodes[concept["id"]]["attributes"] == before


@pytest.mark.parametrize("label,kind", [("widget.py", None), ("FileHandle", "file"), ("DifferentImplementation", "class")])
def test_original_document_id_is_a_weak_live_code_hint_even_when_labels_differ(label, kind):
    code = _code(label=label)
    if kind is not None:
        code["node_kind"] = kind
    original_code = deepcopy(code)
    doc = _doc(code["id"], kind="doc_mention", summary="A documentary occurrence, not code")
    original_id = doc["id"]
    semantic = _fragment([doc])
    builder.preserve_semantic_identities(_fragment([code]), semantic)
    hint = {"text": original_id, "source_location": None, "kind": "id_collision"}
    assert doc["attributes"]["code_hints"] == [hint]
    assert "target_id" not in hint
    edges = []
    enrich_documentation([doc, code], edges)
    (reference,) = [edge for edge in edges if edge.get("relation") == "references"]
    assert (reference["source"], reference["target"]) == (doc["id"], code["id"])
    assert reference["confidence"] == "AMBIGUOUS" and reference["confidence_score"] < 0.5
    assert reference["source_file"] == "docs/guide.md" and reference["_origin"] == "semantic"
    assert reference["match_reason"] == "weak original documentary ID match"
    assert code == original_code
    assert doc["attributes"]["code_hints"] == [hint]
    before = deepcopy((doc, edges))
    enrich_documentation([doc, code], edges)
    assert (doc, edges) == before


def test_explicit_identity_hint_does_not_enable_bare_file_name_matching():
    code = _code(label="FileHandle")
    code["node_kind"] = "file"
    explicit = _doc("explicit", code_hints=[{"text": code["id"], "kind": "id_collision"}])
    bare = _doc("bare", code_hints=[{"text": "FileHandle"}, {"text": code["id"]}])
    edges = []
    enrich_documentation([explicit, bare, code], edges)
    assert [(e["source"], e["target"]) for e in edges if e.get("relation") == "references"] == [("explicit", code["id"])]
    assert bare["attributes"]["code_resolution"]["unresolved"] == 2


def test_original_id_hint_rechecks_inventory_and_never_binds_a_paper_stub():
    code = _code(label="UnrelatedImplementation")
    doc = _doc(code["id"], kind="doc_mention")
    semantic = _fragment([doc])
    builder.preserve_semantic_identities(_fragment([code]), semantic)
    hints = deepcopy(doc["attributes"]["code_hints"])
    edges = []
    enrich_documentation([doc, code], edges)
    assert any(e["target"] == code["id"] for e in edges)
    replacement = {**code, "id": "new-current-id"}
    enrich_documentation([doc, replacement], edges)
    assert not edges
    paper_stub = {**code, "source_file": "paper.pdf", "_origin": "semantic"}
    paper_before = deepcopy(paper_stub)
    enrich_documentation([doc, paper_stub], edges)
    assert not edges and paper_stub == paper_before
    current = {**code, "source_file": "src/replacement.py", "label": "NewImplementation"}
    current_before = deepcopy(current)
    enrich_documentation([doc, current], edges)
    assert any(e["target"] == current["id"] and e["confidence"] == "AMBIGUOUS" for e in edges)
    assert current == current_before
    assert doc["attributes"]["code_hints"] == hints
    assert all("target_id" not in hint for hint in hints)


@pytest.mark.parametrize("extension", ["html", "rst", "txt"])
def test_legacy_non_markdown_identity_and_attributes_are_outside_new_enrichment(extension):
    code = _code()
    legacy = {"id": code["id"], "label": "Legacy page", "file_type": "document",
              "source_file": f"docs/guide.{extension}", "attributes": {"summary": "Unchanged"}}
    structure, semantic = _fragment([code]), _fragment([legacy])
    before = deepcopy((structure, semantic))
    builder.preserve_semantic_identities(structure, semantic)
    assert (structure, semantic) == before
    enrich_documentation(structure["nodes"] + semantic["nodes"], semantic["edges"])
    assert (structure, semantic) == before
