"""Redaction is preprocessing with explicit provenance, not a hash exception."""
from __future__ import annotations

import copy
import hashlib
import json

import pytest

from graphify import framework_analysis as analysis
from graphify.build import build_from_json
from graphify.export import to_json
from graphify.extract import extract
from graphify.extractors.base import _read_source_bytes
from graphify.framework_evidence import (
    EvidenceValidationError,
    attach_evidence,
    inspect_semantics,
    merge_evidence,
    query_semantics,
    validate_store,
)
from graphify.security import redact_secrets, redact_source_credentials
from graphify.serve import _read_graph


def source(password="fixturePassword19"):
    return (
        '\ufeff// source snapshot\r\n'
        f'export const endpoint = "https://fixtureUser17:{password}@example.test/path";\r\n'
        'export function execute() { return endpoint; }\r\n'
    )


def test_string_type_keywords_are_not_literal_containers():
    original = (
        "type Name = string;\n"
        "function echo(value: string): string { return value; }\n"
        'const url = "https://fixtureUser:fixturePassword@example.test";\n'
    )
    safe, metadata = redact_source_credentials(original, "typescript")
    assert metadata is not None
    assert "type Name = string" in safe
    assert "value: string): string" in safe
    assert "fixturePassword" not in safe


def test_detected_credential_is_also_removed_from_duplicate_assertion_literal():
    original = (
        'const url = "https://fixtureUser:fixturePassword@example.test";\n'
        'expect(report).not.toContain("fixtureUser:fixturePassword");\n'
    )
    safe, metadata = redact_source_credentials(original, "typescript")
    assert "fixtureUser:fixturePassword" not in safe
    assert len(metadata["ranges"]) == 2
    assert 'expect(report).not.toContain("' in safe


def test_duplicate_detection_does_not_rewrite_code_or_empty_userinfo_colon():
    original = 'const url="https://u:p@example.test"; const pair={u:p};'
    safe, _ = redact_source_credentials(original, "typescript")
    assert "{u:p}" in safe
    empty = 'const url="https://:@example.test"; const separator=":";'
    safe, _ = redact_source_credentials(empty, "typescript")
    assert 'separator=":"' in safe


def test_credential_bearing_regex_is_masked_as_a_whole_data_literal():
    original = (
        'const url="https://fixtureUser:fixturePassword@example.test";\n'
        'expect(report).not.toMatch(/fixtureUser:fixturePassword|otherFixture:otherSecret/giu);\n'
    )
    safe, metadata = redact_source_credentials(original, "typescript")
    assert "fixturePassword" not in safe and "otherSecret" not in safe
    assert 'expect(report).not.toMatch(/' in safe and '/giu)' in safe
    assert len(safe.encode()) == len(original.encode())
    assert len(metadata["ranges"]) == 2
    document = analysis.make_document(original, "credentials.ts")
    store = analysis.analyze_documents([document])
    validate_store(store)


def test_vendor_token_regex_preserves_the_surrounding_program():
    token = "ghp_" + "A" * 36
    original = f"const pattern=/{token}/g; const other=42;"
    safe, _ = redact_source_credentials(original, "typescript")
    assert token not in safe and "/g; const other=42;" in safe
    assert redact_secrets(safe) == safe


@pytest.fixture()
def indexed(tmp_path):
    original = source()
    path = tmp_path / "credentials.ts"
    path.write_bytes(original.encode("utf-8"))
    extraction = extract([path], root=tmp_path, parallel=False)
    return path, original, extraction


def test_redacted_index_preserves_structure_without_credentials(indexed, tmp_path):
    path, original, extraction = indexed
    entry = extraction["semantic_evidence"]["documents"][path.name]
    assert path.read_bytes() == original.encode("utf-8")
    assert entry["source"] != original
    assert len(entry["source"].encode("utf-8")) == len(original.encode("utf-8"))
    assert len(entry["source"].encode("utf-16-le")) == len(original.encode("utf-16-le"))
    assert entry["redaction"]["originalSourceHash"] == hashlib.sha256(original.encode()).hexdigest()
    assert entry["result"]["sourceHash"] == hashlib.sha256(entry["source"].encode()).hexdigest()
    assert entry["result"]["sourceHash"] != entry["redaction"]["originalSourceHash"]
    assert _read_source_bytes(path) == entry["source"].encode("utf-8")
    assert any("execute" in node["label"] for node in extraction["nodes"])
    assert any(node.get("source_redaction") for node in extraction["nodes"])
    declaration = next(d for d in entry["result"]["declarations"] if d.get("name") == "execute")
    assert declaration["nameSpan"]["startByte"] == original.encode().index(b"execute")

    graph = build_from_json(extraction, root=tmp_path)
    output = tmp_path / "graph.json"
    to_json(graph, {}, str(output), force=True)
    published = output.read_text(encoding="utf-8")
    assert "fixtureUser17" not in published and "fixturePassword19" not in published
    graph = _read_graph(str(output))
    result = query_semantics(graph, symbol="execute", max_bytes=16384)
    detail = inspect_semantics(graph, result["matches"][0]["reference"], max_bytes=32768)
    assert detail["status"] == "ok"
    assert detail["redaction"]["originalSourceHash"] == entry["redaction"]["originalSourceHash"]
    assert detail["coverage"]["sourceFidelity"] == "redacted"
    assert not detail["coverage"]["complete"]
    assert detail["excerpt"]["sourceKind"] == "redacted-source-snapshot"
    assert path.read_bytes() == original.encode("utf-8")


def test_original_credentials_never_reach_worker(monkeypatch):
    original = source()
    document = analysis.make_document(original, "credentials.ts")
    run = analysis._run_worker

    def checked(request, **kwargs):
        encoded = json.dumps(request)
        assert "fixtureUser17" not in encoded and "fixturePassword19" not in encoded
        assert "redaction" not in request["documents"][0]
        return run(request, **kwargs)

    monkeypatch.setattr(analysis, "_run_worker", checked)
    result = analysis.analyze_documents([document])
    assert result["documents"]["credentials.ts"]["redaction"] == document["redaction"]


def test_same_size_secret_change_invalidates_reference(indexed):
    path, original, extraction = indexed
    initial = extraction["semantic_evidence"]
    graph = build_from_json(extraction, root=path.parent)
    old_reference = query_semantics(graph, symbol="execute")["matches"][0]["reference"]
    replacement = source("fixturePassword20")
    assert len(original) == len(replacement)
    new = analysis.analyze_documents([analysis.make_document(replacement, path.name)])
    assert new["documents"][path.name]["source"] == initial["documents"][path.name]["source"]
    merged = merge_evidence(initial, new, replaced_sources=[path.name])
    attach_evidence(graph, merged)
    assert inspect_semantics(graph, old_reference)["status"] == "unsupported"


@pytest.mark.parametrize("corrupt", ["raw-source", "wrong-span", "same-hash", "unexpected-field"])
def test_redaction_cannot_bypass_persisted_validation(indexed, corrupt):
    path, original, extraction = indexed
    store = copy.deepcopy(extraction["semantic_evidence"])
    entry = store["documents"][path.name]
    if corrupt == "raw-source":
        entry["source"] = original
        entry["result"]["sourceHash"] = hashlib.sha256(original.encode()).hexdigest()
    elif corrupt == "wrong-span":
        entry["redaction"]["ranges"][0] = {"startByte": 3, "endByte": 5, "startLine": 1, "endLine": 1}
    elif corrupt == "same-hash":
        entry["redaction"]["originalSourceHash"] = entry["result"]["sourceHash"]
    else:
        entry["redaction"]["originalText"] = original
    with pytest.raises(EvidenceValidationError):
        validate_store(store)


def test_retained_snapshot_keeps_redaction_provenance(indexed):
    path, original, extraction = indexed
    initial = extraction["semantic_evidence"]
    incomplete = analysis.analyze_documents(
        [analysis.make_document(original, path.name)], options={"limits": {"maxFacts": 1}},
    )
    merged = merge_evidence(initial, incomplete, replaced_sources=[path.name])
    retained = merged["documents"][path.name]["retained"]
    assert retained["redaction"] == initial["documents"][path.name]["redaction"]
    assert redact_secrets(retained["source"]) == retained["source"]
    failed = merge_evidence(initial, failed_sources=[path.name])
    assert failed["documents"][path.name]["retained"]["redaction"] == retained["redaction"]
