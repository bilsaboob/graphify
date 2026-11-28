"""Graph-only advisory enrichment; fixtures never index a live repository."""
from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from graphify.markdown_resolution import DOCUMENTATION_EDGE_PRODUCER, enrich_documentation


def _doc(nid="concept", label="Session payload", *, source="docs/guide.md",
         kind="doc_concept", hints=None, location="L12", **attributes):
    if hints is not None:
        attributes["code_hints"] = hints
    return {"id": nid, "label": label, "file_type": "document", "node_kind": kind,
            "source_file": source, "source_location": location, "_origin": "semantic",
            "attributes": attributes}


def _code(nid="widget", label="Widget", source="src/widget.py", **extra):
    return {"id": nid, "label": label, "file_type": "code", "source_file": source,
            "source_location": "L4", "_origin": "ast", **extra}


def _edge(src, dst, relation="references", **extra):
    return {"source": src, "target": dst, "relation": relation, "confidence": "EXTRACTED",
            "source_file": "docs/guide.md", "source_location": "L9", **extra}


def _generated(edges, *, relation=None, source=None):
    return [edge for edge in edges if edge.get("_generated_by") == DOCUMENTATION_EDGE_PRODUCER
            and (relation is None or edge["relation"] == relation)
            and (source is None or edge["source"] == source)]


def _refs(edges, source="concept"):
    return {edge["target"]: edge for edge in _generated(edges, relation="references", source=source)}


def test_unique_ambiguous_unknown_and_no_code_mutation():
    hints = [{"text": "Widget", "source_location": "L14"},
             {"text": "render()", "source_location": "L15"},
             {"text": "MissingAPI", "source_location": "L16"}]
    doc = _doc(hints=deepcopy(hints), summary="Useful despite incomplete binding")
    code = [_code(), _code("render-a", ".render()"),
            _code("render-b", ".render()", "src/other.py")]
    nodes = [doc, *code]
    edges = [_edge("widget", "render-a", "calls", source_file="src/widget.py", _origin="ast")]
    original_code, original_edges = deepcopy(code), deepcopy(edges)

    assert enrich_documentation(nodes, edges) is None

    refs = _refs(edges)
    assert refs["widget"]["confidence"] == "INFERRED"
    assert refs["widget"]["source_location"] == "L14"
    assert {refs[target]["confidence"] for target in ("render-a", "render-b")} == {"AMBIGUOUS"}
    assert doc["attributes"]["code_resolution"] == {"matched": 1, "ambiguous": 1, "unresolved": 1}
    assert doc["attributes"]["code_hints"] == hints
    assert "code_candidates" not in doc["attributes"]
    assert code == original_code
    assert edges[:1] == original_edges
    assert all(e["relation"] != "calls" for e in _generated(edges))
    assert all(e["source_file"] == "docs/guide.md" and e["_origin"] == "semantic"
               for e in _generated(edges))
    assert doc["file_type"] == "document" and doc["_origin"] == "semantic"


def test_idempotent_refresh_preserves_input_containers_and_other_producers():
    doc = _doc(hints=[{"text": "Widget", "source_location": "L14"}])
    nodes = [doc, _code(), _doc("page", "guide.md", kind="page", location="L1")]
    foreign = _edge("page", "concept", "documents", _generated_by="different-producer")
    edges = [foreign, _edge("concept", "obsolete", _generated_by=DOCUMENTATION_EDGE_PRODUCER)]
    nodes_identity, edges_identity = id(nodes), id(edges)
    enrich_documentation(nodes, edges)
    first = deepcopy((nodes, edges))
    enrich_documentation(nodes, edges)
    assert (nodes, edges) == first
    assert id(nodes) == nodes_identity and id(edges) == edges_identity
    assert edges[0] is foreign and "obsolete" not in str(edges)
    assert all(e["target"] in {n["id"] for n in nodes} for e in edges)


def test_code_inventory_excludes_doc_stubs_files_and_external_nodes():
    legacy = _doc("legacy", "Widget", kind=None)
    legacy["file_type"] = "code"
    paper_stub = _doc("paper-stub", "Widget", source="paper.pdf", kind="doc_mention")
    paper_stub["file_type"] = "code"
    named_stub = _doc("stub", "Widget", kind="doc_mention")
    fake_file = _code("file", "Widget", "src/Widget")
    kind_file = _code("kind-file", "Widget", node_kind="file")
    external = _code("external", "Widget", external=True)
    doc = _doc(hints=[{"text": "Widget", "source_location": "L22"}])
    nodes = [doc, legacy, paper_stub, named_stub, fake_file, kind_file, external, _code()]
    edges = []

    enrich_documentation(nodes, edges)

    assert set(_refs(edges)) == {"widget"}
    for nid in ("legacy", "paper-stub", "stub"):
        assert set(_refs(edges, nid)) == {"widget"}
    assert legacy["file_type"] == "code" and legacy["source_file"].endswith(".md")
    assert legacy["_origin"] == "semantic"


def test_document_like_row_cannot_reclassify_actual_code_source():
    real = _code(attributes={"keep": [1, 2]})
    stray = _doc("stray", source="src/widget.py", hints=[{"text": "Widget"}])
    doc = _doc(hints=[{"text": "Widget"}])
    original_real, original_stray = deepcopy(real), deepcopy(stray)
    edges = []
    enrich_documentation([real, stray, doc], edges)
    assert set(_refs(edges)) == {"widget"}
    assert real == original_real and stray == original_stray


def test_declarations_types_and_fields_are_candidates_without_callable_flags():
    doc = _doc(hints=[{"text": "SessionPayload"}, {"text": "SessionPayload::TOKEN"}])
    nodes = [doc, _code("type", "SessionPayload", node_kind="type"),
             _code("field", ".TOKEN", node_kind="field")]
    edges = [_edge("type", "field", "contains", source_file="src/widget.py")]
    enrich_documentation(nodes, edges)
    assert set(_refs(edges)) == {"type", "field"}
    assert _refs(edges)["field"]["confidence"] == "INFERRED"
    assert "qualifiers" in _refs(edges)["field"]["match_reason"]


@pytest.mark.parametrize("hint,targets,weak", [
    ({"text": "Widget.render()"}, {"render-a"}, False),
    ({"text": "render()", "qualifiers": ["Gadget"]}, {"render-b"}, False),
    ({"text": "render()", "qualifiers": "Gadget"}, {"render-b"}, False),
    ({"text": "render()", "path": "../src/widget.py"}, {"render-a"}, False),
    ({"text": "src/widget.py::Widget::render"}, {"render-a"}, False),
    ({"text": "LostOwner.render()"}, {"render-a", "render-b"}, True),
    ({"text": "render()", "path": "src/missing.py"}, {"render-a", "render-b"}, True),
    ({"text": "render()", "path": "../../src/widget.py"}, {"render-a", "render-b"}, True),
    ({"text": "LostOwner.render()", "path": "src/widget.py"}, {"render-a"}, True),
])
def test_path_and_qualifier_matches_are_advisory_not_rejection_gates(hint, targets, weak):
    doc = _doc(hints=[deepcopy(hint)])
    nodes = [doc, _code(), _code("gadget", "Gadget", "src/gadget.py"),
             _code("render-a", ".render()"), _code("render-b", ".render()", "src/gadget.py")]
    edges = [_edge("widget", "render-a", "method"), _edge("gadget", "render-b", "method")]
    enrich_documentation(nodes, edges)
    refs = _refs(edges)
    assert set(refs) == targets
    assert {e["confidence"] for e in refs.values()} == {"AMBIGUOUS" if weak else "INFERRED"}
    assert all(("weak" in e["match_reason"]) == weak for e in refs.values())
    assert doc["attributes"]["code_hints"] == [hint]


def test_absolute_relative_paths_rebind_using_root_without_reading_sources(tmp_path, monkeypatch):
    def no_read(*args, **kwargs):
        pytest.fail("enrichment must not read sources")

    monkeypatch.setattr(Path, "read_text", no_read)
    monkeypatch.setattr(Path, "read_bytes", no_read)
    doc = _doc(source=str(tmp_path / "docs" / "guide.md"), hints=[
        {"text": "Widget", "path": "../src/widget.py"},
        {"text": "Gadget", "path": str(tmp_path / "src" / "gadget.py")},
    ])
    nodes = [doc, _code(), _code("gadget", "Gadget", str(tmp_path / "src" / "gadget.py"))]
    edges = []
    enrich_documentation(nodes, edges, root=tmp_path)
    assert set(_refs(edges)) == {"widget", "gadget"}
    assert all(e["confidence"] == "INFERRED" for e in _refs(edges).values())
    assert all(e["source_file"] == str(tmp_path / "docs" / "guide.md") for e in _refs(edges).values())


def test_current_code_add_delete_and_replacement_rebind_persisted_hints():
    doc = _doc(hints=[{"text": "Widget", "source_location": "L17"}])
    doc["attributes"]["code_candidates"] = [{"target_id": "bogus-cached-id"}]
    nodes, edges = [doc, _code()], []
    enrich_documentation(nodes, edges)
    assert set(_refs(edges)) == {"widget"}
    nodes.append(_code("other", "Widget", "other.py"))
    enrich_documentation(nodes, edges)
    assert set(_refs(edges)) == {"widget", "other"}
    assert all(e["confidence"] == "AMBIGUOUS" for e in _refs(edges).values())
    nodes[:] = [doc, nodes[-1]]
    enrich_documentation(nodes, edges)
    assert set(_refs(edges)) == {"other"} and _refs(edges)["other"]["confidence"] == "INFERRED"
    nodes[-1] = _code("final-current-id", "Widget", "replacement.py")
    enrich_documentation(nodes, edges)
    assert set(_refs(edges)) == {"final-current-id"}
    nodes[:] = [doc]
    enrich_documentation(nodes, edges)
    assert not _refs(edges)
    assert doc["attributes"]["code_resolution"] == {"matched": 0, "ambiguous": 0, "unresolved": 1}
    assert "code_candidates" not in doc["attributes"]
    assert doc["attributes"]["code_hints"] == [{"text": "Widget", "source_location": "L17"}]


def test_json_persisted_heading_and_example_hints_need_no_raw_calls():
    heading = _doc("heading", "Examples", kind="heading", location="L4", hints=[
        {"text": "Widget.render()", "qualifiers": ["Widget"], "source_location": "L6"},
    ])
    example = _doc("example", "Python example", kind="code_example", location="L8", hints=[
        {"text": "render()", "path": "../src/widget.py", "source_location": "L9"},
        {"text": "UnindexedAPI", "source_location": "L10"},
    ], language="python", preview="Widget.render()", start_line=8, end_line=11,
        section={"source_file": "docs/guide.md", "heading": "Examples", "source_location": "L4"})
    example["_origin"] = heading["_origin"] = "ast"
    nodes = json.loads(json.dumps([heading, example, _code(), _code("render", ".render()")]))
    edges = [_edge("widget", "render", "method")]
    enrich_documentation(nodes, edges)
    assert _refs(edges, "heading")["render"]["source_location"] == "L6"
    assert _refs(edges, "heading")["render"]["context"] == "documentation"
    assert _refs(edges, "example")["render"]["source_location"] == "L9"
    assert _refs(edges, "example")["render"]["context"] == "example"
    assert _refs(edges, "example")["render"]["_origin"] == "ast"
    assert nodes[1]["attributes"]["code_resolution"]["unresolved"] == 1
    assert nodes[1]["attributes"]["section"] == example["attributes"]["section"]
    assert nodes[1]["attributes"]["section_resolution"]["target_id"] == "heading"


def test_parser_hints_survive_json_without_raw_call_channel(monkeypatch):
    from graphify.extractors import markdown

    monkeypatch.setattr(markdown, "_read_source_text", lambda path: (
        "# Usage\n\nUse `Widget`.\n\n```python\nWidget.render()\n```\n"
    ))
    parsed = markdown.extract_markdown(Path("docs/guide.md"))
    nodes = json.loads(json.dumps(parsed["nodes"]))
    edges = json.loads(json.dumps(parsed["edges"]))
    nodes.extend([_code(), _code("render", ".render()")])
    edges.append(_edge("widget", "render", "method"))
    enrich_documentation(nodes, edges)
    heading = next(n for n in nodes if n.get("node_kind") == "heading")
    example = next(n for n in nodes if n.get("node_kind") == "code_example")
    assert _refs(edges, heading["id"])["widget"]["source_location"] == "L3"
    assert _refs(edges, example["id"])["render"]["source_location"] == "L6"
    assert _refs(edges, example["id"])["render"]["context"] == "example"
    assert example["attributes"]["section_resolution"]["target_id"] == heading["id"]


def test_existing_strong_explicit_resolver_is_unchanged_and_not_overwritten():
    from graphify.markdown_resolution import resolve_markdown_mentions

    doc = _doc(hints=[{"text": "src/widget.py::Widget", "source_location": "L8"}])
    nodes = [doc, _code(_callable=True)]
    edges = []
    resolve_markdown_mentions([{"raw_calls": [{
        "language": "markdown", "caller_nid": "concept", "callee": "Widget",
        "path": "src/widget.py", "source_file": "docs/guide.md", "source_location": "L8",
    }]}], nodes, edges)
    original = deepcopy(edges)
    assert len(original) == 1 and original[0]["confidence"] == "EXTRACTED"
    enrich_documentation(nodes, edges)
    assert edges == original and "_generated_by" not in edges[0]
    assert doc["attributes"]["code_candidates"][0]["target_id"] == "widget"


@pytest.mark.parametrize("reverse", [False, True])
def test_concept_stub_claim_makes_direct_code_reference_and_keeps_flow(reverse):
    concept = _doc("flow", "Session handoff")
    stub = _doc("stub", "Widget", kind="doc_mention", location="L25")
    consumer = _doc("consumer", "Startup", hints=[{"text": "UnknownStartup"}])
    claim = _edge("stub" if reverse else "flow", "flow" if reverse else "stub",
                  "produces", context="producer", source_location="L20", _origin="semantic")
    flow = _edge("flow", "consumer", "shares_data_with", context="consumer", _origin="semantic")
    nodes, edges = [concept, stub, consumer, _code()], [claim, flow]
    original = deepcopy(edges)
    enrich_documentation(nodes, edges)
    assert edges[:2] == original
    assert _refs(edges, "flow")["widget"]["context"] == "producer"
    assert _refs(edges, "flow")["widget"]["source_location"] == "L20"
    assert "documented produces via mention" in _refs(edges, "flow")["widget"]["match_reason"]
    assert _refs(edges, "stub")["widget"]["context"] == "producer"
    assert consumer["attributes"]["code_resolution"]["unresolved"] == 1
    assert not _refs(edges, "consumer")
    assert {e["relation"] for e in _generated(edges)} <= {"references", "contains"}


def test_producer_consumer_roles_from_hints_and_document_relationships():
    flow = _doc("flow", "Payload handoff")
    producer = _doc("producer", "Write payload", hints=[{"text": "save", "role": "producer"}])
    consumer = _doc("consumer", "Read payload", hints=[{"text": "load"}])
    edges = [_edge("flow", "producer", context="producer"),
             _edge("flow", "consumer", context="consumer: reads documented payload")]
    original = deepcopy(edges)
    enrich_documentation([flow, producer, consumer, _code("save", "save"), _code("load", "load")], edges)
    assert edges[:2] == original
    assert _refs(edges, "producer")["save"]["context"] == "producer"
    assert _refs(edges, "consumer")["load"]["context"] == "consumer"
    assert not _refs(edges, "flow")  # No transitive semantic propagation.


def test_example_role_on_concept_hint_is_documentary_and_never_a_call():
    doc = _doc(hints=[{"text": "Widget", "role": "example", "source_location": "L30"},
                      {"text": "Widget", "role": "call", "source_location": "L31"}])
    edges = []
    enrich_documentation([doc, _code()], edges)
    assert _refs(edges)["widget"]["context"] == "example"
    assert doc["attributes"]["code_candidates"][0]["context"] == "documentation"
    assert all(e["relation"] != "calls" for e in edges)


def test_crossdoc_stub_claim_does_not_mix_a_mention_line_with_another_source():
    concept = _doc(source="a.md", location="L5")
    stub = _doc("stub", "Widget", kind="doc_mention", source="b.md", location="L25")
    edges = [_edge("concept", "stub", source_file="a.md", source_location=None)]
    enrich_documentation([concept, stub, _code()], edges)
    reference = _refs(edges)["widget"]
    assert reference["source_file"] == "a.md" and reference["source_location"] == "L5"
    assert _refs(edges, "stub")["widget"]["source_location"] == "L25"


@pytest.mark.parametrize("section,location,expected", [
    ("  usage  ", None, "heading"),
    ("docs/guide.md::Usage", None, "heading"),
    ({"source_file": "docs/guide.md", "heading": "Usage", "source_location": "L5"}, None, "heading"),
    (None, "L7", "heading"),
    ("L7", None, "heading"),
    ("Repeated", None, "page"),
    ("Repeated", "L22", "repeat-two"),
    ("Missing section", "L7", "page"),
    ({"source_file": "other.md", "heading": "Usage"}, None, "page"),
    ("other.md::Usage", None, "page"),
    (None, None, "page"),
])
def test_document_section_association_preserves_locator_and_falls_back(section, location, expected):
    page = _doc("page", "guide.md", kind="page", location="L1")
    heading = _doc("heading", "Usage", kind="heading", location="L5")
    one = _doc("repeat-one", "Repeated", kind="heading", location="L10")
    two = _doc("repeat-two", "Repeated", kind="heading", location="L20")
    concept = _doc(section=deepcopy(section), location=location)
    edges = []
    enrich_documentation([page, heading, one, two, concept], edges)
    assert concept["attributes"]["section"] == section
    assert concept["source_location"] == location
    assert concept["attributes"]["section_resolution"]["target_id"] == expected
    assert [(e["source"], e["target"]) for e in _generated(edges, relation="contains")] == [(expected, "concept")]


def test_existing_section_containment_is_kept_without_generated_marker():
    heading = _doc("heading", "Usage", kind="heading", location="L5")
    concept = _doc(location=None)
    edge = _edge("heading", "concept", "contains", _origin="semantic")
    edges = [edge]
    enrich_documentation([heading, concept], edges)
    assert edges == [edge] and "_generated_by" not in edge
    assert concept["attributes"]["section_resolution"]["target_id"] == "heading"


def test_numbered_heading_is_not_misread_as_a_line_locator():
    heading = _doc("heading", "1. Usage", kind="heading", location="L5")
    concept = _doc(section="1. Usage", location=None)
    edges = []
    enrich_documentation([heading, concept], edges)
    assert concept["attributes"]["section_resolution"]["target_id"] == "heading"


def test_crossdoc_full_labels_and_explicit_aliases_connect_without_bound_code():
    a = _doc("a", "Session Payload v1", source="a.md", aliases=["Payload contract"])
    b = _doc("b", " SESSION   payload V1 ", source="b.md")
    c = _doc("c", "Wire format", source="c.md", aliases=["payload CONTRACT"])
    same_page = _doc("same-page", "Session Payload v1", source="a.md")
    nodes = [a, b, c, same_page,
             _doc("different-version", "Session Payload v2", source="v2.md"),
             _doc("different-punctuation", "Session-Payload v1", source="dash.md"),
             _doc("heading", "Session Payload v1", source="h.md", kind="heading"),
             _doc("example", "Session Payload v1", source="e.md", kind="code_example"),
             _doc("mention", "Session Payload v1", source="m.md", kind="doc_mention")]
    edges = []
    enrich_documentation(nodes, edges)
    related = _generated(edges, relation="conceptually_related_to")
    assert {(e["source"], e["target"]) for e in related} == {("a", "b"), ("a", "c"), ("b", "same-page")}
    assert all(e["confidence"] == "AMBIGUOUS" for e in related)
    assert all(e["context"] == "documentation" for e in related)
    assert not _generated(edges, relation="references")
    assert len(nodes) == 9  # Separate meanings are never merged.
    assert not any(e["source"] == "b" and e["target"] == "c" for e in related)


@pytest.mark.parametrize("anchor", ["code", "document"])
def test_crossdoc_local_links_or_shared_targets_strengthen_only_the_reason(anchor):
    a = _doc("a", "Session Payload", source="a.md")
    b = _doc("b", "Session Payload", source="b.md")
    nodes, edges = [a, b, _code()], []
    if anchor == "code":
        for node in (a, b):
            node["attributes"]["code_hints"] = [{"text": "Widget"}]
    else:
        nodes.extend([_doc("page-a", "a.md", source="a.md", kind="page"),
                      _doc("page-b", "b.md", source="b.md", kind="page")])
        edges.append(_edge("page-a", "page-b", source_file="a.md"))
    enrich_documentation(nodes, edges)
    (related,) = _generated(edges, relation="conceptually_related_to")
    assert related["confidence"] == "INFERRED"
    assert ("shared code candidate" if anchor == "code" else "documented link") in related["match_reason"]


@pytest.mark.parametrize("reverse", [False, True])
def test_pair_collisions_preserve_authored_edges_and_all_candidate_details(reverse):
    hints = [{"text": "Widget", "source_location": "L20", "role": "producer"},
             {"text": "Widget", "source_location": "L21", "role": "consumer"}]
    doc = _doc(hints=hints)
    authored = _edge("widget" if reverse else "concept", "concept" if reverse else "widget",
                     "implements", confidence="EXTRACTED", confidence_score=1.0, _origin="semantic")
    original = deepcopy(authored)
    edges = [authored]
    enrich_documentation([doc, _code()], edges)
    assert edges == [original] and edges[0] is authored
    details = doc["attributes"]["code_candidates"]
    assert {d["context"] for d in details} == {"producer", "consumer"}
    assert {d["source_location"] for d in details} == {"L20", "L21"}
    assert all(d["target_id"] == "widget" for d in details)
    assert "_generated_by" not in authored


def test_generated_pair_coalescing_preserves_remaining_mentions_and_ambiguity():
    doc = _doc(hints=[{"text": "Widget", "source_location": "L20"},
                      {"text": "Widget", "source_location": "L21", "role": "consumer"}])
    nodes = [doc, _code(), _code("other", "Widget", "other.py")]
    edges = []
    enrich_documentation(nodes, edges)
    assert set(_refs(edges)) == {"widget", "other"}
    assert {d["target_id"] for d in doc["attributes"]["code_candidates"]} == {"widget", "other"}
    assert all(d["confidence"] == "AMBIGUOUS" for d in doc["attributes"]["code_candidates"])
    assert all(d["source_location"] == "L21" for d in doc["attributes"]["code_candidates"])


def test_concept_pair_collision_retains_weak_candidate_without_overwriting_flow():
    a, b = _doc("a", source="a.md"), _doc("b", source="b.md")
    flow = _edge("b", "a", "shares_data_with", context="producer", source_file="b.md")
    edges = [flow]
    enrich_documentation([a, b], edges)
    assert edges == [flow] and "_generated_by" not in flow
    assert a["attributes"]["concept_candidates"] == [{
        "target_id": "b", "confidence": "AMBIGUOUS", "match_reason": "shared full concept label/alias",
    }]


def test_match_reasons_are_bounded_and_redacted_without_rewriting_claim():
    secret = "ghp_" + "a" * 36
    concept, stub = _doc(), _doc("stub", "Widget", kind="doc_mention")
    claim = _edge("concept", "stub", secret + "x" * 600, _origin="semantic")
    edges = [claim]
    enrich_documentation([concept, stub, _code()], edges)
    reason = _refs(edges)["widget"]["match_reason"]
    assert len(reason) <= 200 and secret not in reason
    assert claim["relation"].startswith(secret)  # Authored input is not rewritten.


def test_lookup_work_is_indexed_and_repeated_hints_reuse_owner_and_path_matches(monkeypatch):
    import graphify.markdown_resolution as resolver

    nodes = [_code(f"code-{i}", f"Symbol{i}", f"src/{i}/unit.py") for i in range(400)]
    nodes += [_doc(f"doc-{i}", f"Meaning {i}", source=f"docs/{i}.md", hints=[
        {"text": "Symbol17", "qualifiers": ["src"], "path": "src/17/unit.py"},
        {"text": "Symbol17", "qualifiers": ["src"], "path": "src/17/unit.py"},
    ]) for i in range(100)]
    original_label, original_evidence, original_path = resolver._symbol_label, resolver._evidence, resolver._match_cited_file
    calls = {"labels": 0, "owners": 0, "path_pool": []}

    def label(node):
        calls["labels"] += 1
        return original_label(node)

    def evidence(*args):
        calls["owners"] += 1
        return original_evidence(*args)

    def path(cited, doc, files):
        calls["path_pool"].append(len(files))
        return original_path(cited, doc, files)

    monkeypatch.setattr(resolver, "_symbol_label", label)
    monkeypatch.setattr(resolver, "_evidence", evidence)
    monkeypatch.setattr(resolver, "_match_cited_file", path)
    edges = []
    enrich_documentation(nodes, edges)
    assert len(_generated(edges, relation="references")) == 100
    assert calls["labels"] == 400 and calls["owners"] == 1
    assert len(calls["path_pool"]) == 100 and set(calls["path_pool"]) == {1}


def test_refresh_removes_own_stale_edges_even_after_all_documents_disappear():
    edges = [_edge("gone", "widget", _generated_by=DOCUMENTATION_EDGE_PRODUCER)]
    enrich_documentation([_code()], edges)
    assert edges == []


def test_incomplete_optional_hint_metadata_keeps_useful_candidates():
    hints = [None, {"text": "Widget", "qualifiers": 42}, {"text": "Missing", "path": None}]
    doc = _doc(hints=deepcopy(hints))
    edges = []
    enrich_documentation([doc, _code()], edges)
    assert _refs(edges)["widget"]["confidence"] == "AMBIGUOUS"
    assert doc["attributes"]["code_hints"] == hints
    assert doc["attributes"]["code_resolution"] == {"matched": 0, "ambiguous": 1, "unresolved": 1}
