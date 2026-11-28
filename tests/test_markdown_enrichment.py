"""Offline Markdown examples, persistent hints and semantic ownership contracts."""
from __future__ import annotations

import copy
import hashlib
import json

import pytest

from graphify.extractors.markdown import extract_markdown
from graphify import llm
from graphify.security import redact_secrets


def _extract(tmp_path, source, name="guide.md"):
    path = tmp_path / name
    path.write_bytes(source.encode("utf-8"))
    return extract_markdown(path)


def _examples(fragment):
    return [n for n in fragment["nodes"] if n.get("node_kind") == "code_example"]


@pytest.mark.parametrize("block,language,preview", [
    ("```python\nbroken(\n```", "python", "broken("),
    ("~~~unknown-lang extra-info\nnot valid code }\n~~~~", "unknown-lang", "not valid code }"),
    ("```\n```", "", ""),
    ("~~~strange", "strange", ""),
    ("```unknown\nunclosed(", "unknown", "unclosed("),
    ("````md\n```py\n# Not a heading\n```\n````", "md", "```py\n# Not a heading\n```"),
    ("~~~\n```\n~~~", "", "```"),
    ("```js\n``` not a close\n# Still code\n```", "js", "``` not a close\n# Still code"),
    ("    ```py\n    example(\n    ```", "py", "    example("),
])
def test_fences_are_examples_without_compiling(tmp_path, block, language, preview):
    fragment = _extract(tmp_path, "# Guide\n\n" + block)
    example, = _examples(fragment)
    attrs = example["attributes"]
    assert example["file_type"] == "document"
    assert example["source_location"] == "L3"
    assert attrs["start_line"] == 3
    assert attrs["end_line"] == len(block.splitlines()) + 2
    assert attrs["language"] == language
    assert attrs["preview"] == preview
    assert attrs["section"] == "Guide"
    assert attrs["span_hash"] == hashlib.sha256(block.encode()).hexdigest()
    heading, = [n for n in fragment["nodes"] if n["node_kind"] == "heading"]
    assert heading["label"] == "Guide"
    assert any(e["source"] == heading["id"] and e["target"] == example["id"]
               and e["relation"] == "contains" for e in fragment["edges"])
    assert all(e["relation"] == "contains" for e in fragment["edges"])
    assert not fragment["raw_calls"]
    assert all("_origin" not in n for n in fragment["nodes"])


@pytest.mark.parametrize("newline,encoding", [("\r\n", "utf-8"), ("\r", "utf-8"), ("\n", "utf-16")])
def test_example_fingerprint_uses_normalized_source(tmp_path, newline, encoding):
    path = tmp_path / "guide.md"
    block = "```py\nStore.load()\n```"
    path.write_bytes((block.replace("\n", newline) + newline).encode(encoding))
    example, = _examples(extract_markdown(path))
    assert example["attributes"]["start_line"] == 1
    assert example["attributes"]["end_line"] == 3
    assert example["attributes"]["span_hash"] == hashlib.sha256(block.encode()).hexdigest()


def test_frontmatter_spans_and_document_links_are_preserved(tmp_path):
    (tmp_path / "target.md").write_text("# Target\n", encoding="utf-8")
    source = ("---\ntitle: Examples\nsnippet: |\n  ```py\n  # YAML, not an example\n  ```\n"
              'consulted: "[[target]]"\n---\n# Samples\n```py\nStore.load()\n```\n')
    fragment = _extract(tmp_path, source)
    example, = _examples(fragment)
    assert example["source_location"] == "L10"
    assert example["attributes"]["end_line"] == 12
    page = next(n for n in fragment["nodes"] if n["node_kind"] == "page")
    assert page["frontmatter"]["title"] == "Examples"
    assert any(e["relation"] == "references" and e["source"] == page["id"]
               for e in fragment["edges"])
    heading, = [n for n in fragment["nodes"] if n["node_kind"] == "heading"]
    shifted = _extract(tmp_path, source.replace("title: Examples\n", "title: Examples\nstatus: draft\n"))
    later, = _examples(shifted)
    assert later["attributes"]["start_line"] == 11
    assert later["attributes"]["end_line"] == 13
    assert later["attributes"]["span_hash"] == example["attributes"]["span_hash"]
    assert next(n for n in shifted["nodes"] if n["node_kind"] == "heading")["id"] == heading["id"]


def test_distinct_examples_attach_to_page_and_heading(tmp_path):
    source = "```py\nStore.load()\n```\n# Guide\n```py\nStore.load()\n```\n"
    fragment = _extract(tmp_path, source)
    first, second = _examples(fragment)
    assert first["id"] != second["id"]
    assert first["attributes"]["span_hash"] == second["attributes"]["span_hash"]
    owners = {n["node_kind"]: n for n in fragment["nodes"] if n["node_kind"] != "code_example"}
    contains = {(e["source"], e["target"]) for e in fragment["edges"]}
    assert (owners["page"]["id"], first["id"]) in contains
    assert (owners["heading"]["id"], second["id"]) in contains
    assert fragment == _extract(tmp_path, source)


def test_example_id_cannot_replace_an_existing_heading(tmp_path):
    fragment = _extract(tmp_path, "# Code Example 3\n\n```py\nStore.load()\n```\n")
    example, = _examples(fragment)
    heading, = [n for n in fragment["nodes"] if n["node_kind"] == "heading"]
    assert heading["id"] != example["id"]
    assert any(e["source"] == heading["id"] and e["target"] == example["id"]
               for e in fragment["edges"])


def test_inline_and_example_hints_persist_without_changing_explicit_raw_calls(tmp_path):
    source = ("Use `UnknownCall()`.\n# API `Widget`\n"
              "See `src/store.py::Store::load` and `Widget.load()`.\n"
              "Also `Mystery!` and `build --quiet`.\n```ts\n"
              'import { loadSession as restore } from "../src/session.ts";\n'
              'import SessionStore from "@app/session";\n'
              "from lib.session import create_session\n"
              "SessionStore.read(undefined)\nnot every prose word is an identifier\n```\n")
    fragment = _extract(tmp_path, source)
    page = next(n for n in fragment["nodes"] if n["node_kind"] == "page")
    assert page["attributes"]["code_hints"] == [{"text": "UnknownCall()", "source_location": "L1"}]
    heading = next(n for n in fragment["nodes"] if n["node_kind"] == "heading")
    hints = {h["text"]: h for h in heading["attributes"]["code_hints"]}
    assert {"Widget", "src/store.py::Store::load", "Widget.load()", "Mystery!", "build --quiet"} == set(hints)
    assert hints["src/store.py::Store::load"] == {
        "text": "src/store.py::Store::load", "source_location": "L3",
        "path": "src/store.py", "qualifiers": ["Store"],
    }
    calls = {c["context"]: c for c in fragment["raw_calls"]}
    assert set(calls) == {"UnknownCall()", "Widget", "src/store.py::Store::load", "Widget.load()"}
    assert calls["src/store.py::Store::load"]["callee"] == "load"
    assert calls["src/store.py::Store::load"]["path"] == "src/store.py"
    assert calls["src/store.py::Store::load"]["qualifiers"] == ["Store"]
    assert all(c["language"] == "markdown" and not c["is_member_call"] for c in calls.values())
    example, = _examples(fragment)
    hints = {h["text"]: h for h in example["attributes"]["code_hints"]}
    assert {"loadSession", "restore", "SessionStore", "lib.session", "create_session", "SessionStore.read"} <= set(hints)
    assert hints["@app/session"]["path"] == "@app/session"
    assert hints["../src/session.ts"]["path"] == "../src/session.ts"
    assert hints["SessionStore.read"]["source_location"] == "L9"
    assert hints["SessionStore.read"]["qualifiers"] == ["SessionStore"]
    assert all(h["role"] == "example" for h in hints.values())
    assert not {"every", "prose", "word", "identifier"} & set(hints)


def test_redaction_precedes_preview_hint_and_metadata_persistence(tmp_path):
    secret = "ghp_" + "AbCd0123" * 5
    private_body = "PrivateKeyBody.call()"
    content = ("x" * 500 + f" '{secret}'\n"
               f"-----BEGIN PRIVATE KEY-----\n{private_body}\n-----END PRIVATE KEY-----\n"
               "Store.load()")
    block = f"```{secret}\n{content}\n```"
    source = f'---\ntitle: "{secret}"\n---\n# {secret}\nUse `{secret}`.\n{block}\n'
    fragment = _extract(tmp_path, source, secret + ".md")
    serialized = json.dumps(fragment)
    assert secret.lower() not in serialized.lower()
    assert private_body not in serialized
    example, = _examples(fragment)
    attrs = example["attributes"]
    assert attrs["preview"] == redact_secrets(content)[:512]
    assert len(attrs["preview"]) == 512
    assert attrs["language"] == "[redacted]"
    assert attrs["section"] == "[redacted]"
    assert attrs["start_line"] == 6 and attrs["end_line"] == 12
    assert attrs["span_hash"] == hashlib.sha256(redact_secrets(block).encode()).hexdigest()
    assert any(h["text"] == "Store.load()" for h in attrs["code_hints"])
    assert not fragment["raw_calls"]


def test_runtime_prompt_describes_optional_doc_metadata_and_no_production_calls():
    prompt = llm._extraction_system()
    assert all(f"attributes.{key}" in prompt for key in ("summary", "aliases", "section", "code_hints"))
    assert "optional" in prompt and "source_location" in prompt and "qualifiers" in prompt
    assert "producer/consumer roles" in prompt and "`context` and `role`" in prompt
    assert "requiring a matching implementation symbol" in prompt
    assert "use `references`, not\n`calls`" in prompt
    assert "graphify_reference_stub" in prompt


def test_semantic_normalizer_retains_claims_stubs_flags_and_source_attribution():
    derived = {key: {"target_id": "stale"} for key in (
        "code_resolution", "code_candidates", "section_resolution", "concept_candidates")}
    concept = {"id": "doc_concept", "label": "Unproven flow", "file_type": "concept",
               "source_file": "docs\\FLOW.MD", "source_location": "L4", "_origin": "ast",
               "attributes": {"summary": "May reuse data", "aliases": ["Payload v2"],
                              "section": "Flow", "code_hints": [{"text": "UnknownAPI()", "source_location": "L7"}],
                              "custom": {"claim": "uncertain"}, **derived}}
    stub = {"id": "doc_stub", "label": "UnknownAPI", "file_type": "code",
            "source_file": "docs/flow.md", "_origin": "ast", "verification": "unverified",
            "metadata": {"graphify_reference_stub": True}, "_callable": True}
    unknown = {"id": "doc_unknown", "file_type": "novel_claim", "source_file": "docs/flow.md",
               "confidence": "AMBIGUOUS", "rationale": "Document suggests a dependency"}
    code = {"id": "real_code", "file_type": "code", "source_file": "lib/run.py", "_origin": "ast"}
    edge = {"source": "doc_concept", "target": "doc_stub", "relation": "references",
            "source_file": "docs/flow.md", "confidence": "AMBIGUOUS", "_origin": "ast",
            "context": "documentation", "role": "producer", "match_reason": "Authored claim",
            "_generated_by": "markdown-advisory-v1", "attributes": dict(derived)}
    fragment = {"nodes": [concept, stub, unknown, code], "edges": [edge, {
        "source": "doc_stub", "target": "doc_unknown", "relation": "shares_data_with", "_origin": "ast",
    }], "hyperedges": [{"id": "flow", "nodes": ["doc_concept", "doc_stub", "doc_unknown"],
                        "source_file": "docs/flow.md", "_origin": "ast"}],
        "_partial_files": ["docs/flow.md"], "failed_chunks": 1}
    before = copy.deepcopy(fragment)
    assert llm.prepare_markdown_semantics(fragment) is fragment
    assert concept["node_kind"] == "doc_concept"
    assert stub["node_kind"] == "doc_mention"
    assert all(n["_origin"] == "semantic" for n in fragment["nodes"][:3])
    assert all(e["_origin"] == "semantic" for e in fragment["edges"] + fragment["hyperedges"])
    assert code == before["nodes"][3]
    assert stub["verification"] == "unverified" and stub["_callable"] is True
    assert stub["metadata"] == {"graphify_reference_stub": True}
    assert unknown["file_type"] == "concept" and unknown["confidence"] == "AMBIGUOUS"
    assert unknown["attributes"]["model_file_type"] == "novel_claim"
    assert unknown["rationale"] == before["nodes"][2]["rationale"]
    assert "_generated_by" not in edge
    assert not set(derived) & concept["attributes"].keys()
    assert not set(derived) & edge["attributes"].keys()
    assert concept["attributes"]["code_hints"] == before["nodes"][0]["attributes"]["code_hints"]
    assert concept["source_file"] == before["nodes"][0]["source_file"]
    assert edge["role"] == "producer" and edge["match_reason"] == "Authored claim"
    assert fragment["_partial_files"] == before["_partial_files"] and fragment["failed_chunks"] == 1
    again = copy.deepcopy(fragment)
    assert llm.prepare_markdown_semantics(fragment) == again


def test_normalizer_tolerates_missing_metadata_and_runs_at_model_ingress(tmp_path, monkeypatch):
    assert llm.prepare_markdown_semantics({}) == {}
    assert llm.prepare_markdown_semantics({"nodes": None, "edges": None}) == {"nodes": None, "edges": None}
    fragment = {"nodes": [{"id": "unknown", "label": "GhostSymbol()", "file_type": "code", "source_file": "unknown.md",
                           "attributes": None, "_origin": "ast"}],
                "edges": [], "hyperedges": [{"id": "claim", "source_file": "unknown.md", "_origin": "ast"}]}
    parsed = llm._parse_llm_json(json.dumps(fragment))
    path = tmp_path / "unknown.md"
    path.write_text("No implementation symbols here.\n", encoding="utf-8")
    monkeypatch.setattr(llm, "_call_openai_compat", lambda *args, **kwargs: parsed)
    assert llm.extract_files_direct([path], backend="kimi", api_key="unused", root=tmp_path) is parsed
    assert parsed["nodes"][0]["node_kind"] == "doc_mention"
    assert parsed["nodes"][0]["_origin"] == "semantic"
    assert parsed["nodes"][0]["attributes"] is None
    assert parsed["nodes"][0]["verification"] == "unverified"
    assert parsed["hyperedges"][0]["_origin"] == "semantic"
    assert llm._stamp_semantic_origin(fragment)["nodes"][0]["_origin"] == "semantic"


def test_semantic_preview_and_hint_metadata_is_redacted_before_caching():
    secret = "ghp_" + "AbCd0123" * 5
    fragment = {"nodes": [{"id": "doc", "source_file": "guide.md", "attributes": {
        "preview": f"Client({secret})", "summary": f"Uses {secret}",
        "code_hints": [{"text": secret, "path": f"lib/{secret}.py", "qualifiers": [secret]}],
        "section": {"heading": secret, "source_location": "L2"},
    }}]}
    attrs = llm.prepare_markdown_semantics(fragment)["nodes"][0]["attributes"]
    assert secret not in json.dumps(attrs)
    assert attrs["code_hints"][0]["text"] == "[redacted]"
    assert attrs["section"]["source_location"] == "L2"
def test_documented_calls_are_retained_without_becoming_runtime_calls():
    from graphify.llm import prepare_markdown_semantics

    fragment = {"nodes": [], "hyperedges": [], "edges": [
        {"source": "a", "target": "b", "relation": "calls", "source_file": "docs/auth.md", "context": {"unknown": True}},
        {"source": "a", "target": "b", "relation": "calls", "source_file": "src/auth.py", "context": "call"},
    ]}
    prepare_markdown_semantics(fragment)
    documentary, code = fragment["edges"]
    assert documentary["relation"] == "references"
    assert documentary["documented_relation"] == "calls"
    assert documentary["context"] == "documentation"
    assert "not static code evidence" in documentary["match_reason"]
    assert code["relation"] == "calls" and code["context"] == "call"
