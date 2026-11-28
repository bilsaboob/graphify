from __future__ import annotations

import copy
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

import networkx as nx
import pytest

from graphify.framework_evidence import (
    ANNOTATION_LIMITS,
    SEMANTIC_EVIDENCE_KEY,
    EvidenceLimits,
    EvidenceValidationError,
    attach_evidence,
    canonical_json,
    extract_evidence,
    inspect_semantics,
    merge_evidence,
    query_semantics,
    response_json,
    validate_payload,
    validate_store,
)


FIXTURE = Path(__file__).parent / "fixtures" / "framework_evidence" / "snapshot.tsx"
FINGERPRINT = hashlib.sha256(b"graphify-owned-producer-fixture").hexdigest()
LONG_VALUE = "source-only <condition> & not runtime proof; " * 24


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _seal(payload):
    manifest = payload["manifest"]
    configuration = {"limits": manifest["limits"], **payload["producer"]["configuration"]}
    configuration_digest = _hash(canonical_json(configuration))
    for descriptor in (manifest["core"], manifest["view"], *manifest["plugins"]):
        descriptor["configurationDigest"] = configuration_digest
    manifest["id"] = _hash(canonical_json({k: v for k, v in manifest.items() if k != "id"}))
    for doc in payload["documents"]:
        doc["result"]["analysisSetId"] = manifest["id"]
        doc["result"]["sourceHash"] = _hash(doc["source"])
    return payload


def _span(source, text=None, *, start=None, end=None):
    if text is not None:
        start = source.index(text, start or 0)
        end = start + len(text)
    assert start is not None and end is not None
    return {
        "startByte": len(source[:start].encode("utf-8")),
        "endByte": len(source[:end].encode("utf-8")),
        "startLine": source[:start].count("\n") + 1,
        "endLine": source[: end - 1 if end > start else start].count("\n") + 1,
    }


def _payload(*, repeats=64, path="src/Page.tsx", unicode=False, crlf=False, module_aliases=None):
    source = FIXTURE.read_text(encoding="utf-8")
    value = LONG_VALUE + ("\U0001f680 caf\u00e9 \u2028 \u2029" if unicode else "")
    source = source.replace("TITLE", value)
    source = source.replace("  onCleanup(cleanup);", "  onCleanup(cleanup);\n" * repeats)
    if crlf:
        source = source.replace("\n", "\r\n")
    page_start = source.index("export function Page")
    cleanup_start = source.index("export function cleanup")
    cleanup_end = source.index("}", cleanup_start) + 1
    declarations = [
        {
            "key": "function:cleanup",
            "kind": "function",
            "name": "cleanup",
            "exports": ["cleanup"],
            "span": _span(source, start=cleanup_start, end=cleanup_end),
            "nameSpan": _span(source, "cleanup", start=cleanup_start),
        },
        {
            "key": "function:Page",
            "kind": "function",
            "name": "Page",
            "exports": ["Page"],
            "span": _span(source, start=page_start, end=len(source)),
            "nameSpan": _span(source, "Page", start=page_start),
        },
    ]

    def evidence(rule, span):
        return {"pluginId": "fst-solid", "ruleId": rule, "basis": "import-bound", "span": span}

    facts = [
        {
            "kind": "role",
            "subject": "function:Page",
            "term": "fst-solid.component",
            "evidence": evidence("component.role", declarations[1]["nameSpan"]),
        },
        {
            "kind": "property",
            "subject": "function:Page",
            "term": "fst-solid.name",
            "resolution": "constant",
            "value": {"kind": "string", "value": value},
            "evidence": evidence("component.name", _span(source, f'"{value}"')),
        },
    ]
    index = page_start
    for _ in range(repeats):
        index = source.index("onCleanup(cleanup)", index)
        span = _span(source, "onCleanup(cleanup)", start=index)
        facts.append(
            {
                "kind": "relation",
                "subject": "function:Page",
                "term": "fst-solid.cleanup",
                "target": {"kind": "declaration", "key": "function:cleanup"},
                "evidence": evidence("cleanup.registration", span),
            }
        )
        index += len("onCleanup(cleanup)")
    manifest = {
        "version": 1,
        "id": "0" * 64,
        "core": {"version": "1", "implementationDigest": FINGERPRINT},
        "view": {"id": "typescript", "version": 1, "implementationDigest": FINGERPRINT},
        "parserDigest": _hash("tree-sitter-typescript:0.23.2"),
        "plugins": [
            {
                "id": "fst-solid",
                "version": "1",
                "implementationDigest": FINGERPRINT,
                "languages": ["typescript", "tsx"],
                "view": {"id": "typescript", "version": 1},
                "roles": [
                    {
                        "id": "fst-solid.component",
                        "label": "Component",
                        "description": "Source declares a component; this is not an execution trace.",
                    }
                ],
                "properties": [
                    {
                        "id": "fst-solid.name",
                        "label": "Trace name",
                        "description": "Literal or constant source trace name.",
                        "valueKind": "string",
                        "multiple": True,
                    },
                    {
                        "id": "fst-solid.condition",
                        "label": "Condition",
                        "valueKind": "reference",
                        "multiple": True,
                    },
                    {
                        "id": "fst-solid.enabled",
                        "label": "Enabled",
                        "valueKind": "boolean",
                        "multiple": False,
                    },
                    {
                        "id": "fst-solid.depth",
                        "label": "Depth",
                        "valueKind": "integer",
                        "multiple": True,
                    },
                ],
                "relations": [
                    {
                        "id": "fst-solid.cleanup",
                        "label": "Registers cleanup",
                        "description": "Registration in the current owner; not proof that cleanup ran.",
                    }
                ],
            }
        ],
        "limits": dict(ANNOTATION_LIMITS),
    }
    return _seal(
        {
            "version": 1,
            "producer": {
                "id": "graphify.frameworks",
                "version": "1",
                "fingerprint": FINGERPRINT,
                "configuration": {
                    "moduleAliases": module_aliases if module_aliases is not None else {}
                },
            },
            "manifest": manifest,
            "documents": [
                {
                    "source": source,
                    "result": {
                        "version": 1,
                        "analysisSetId": manifest["id"],
                        "sourceHash": _hash(source),
                        "relativePath": path,
                        "language": "tsx",
                        "state": "complete",
                        "declarations": declarations,
                        "facts": facts,
                        "reports": [
                            {"pluginId": "fst-solid", "state": "complete", "diagnostics": []}
                        ],
                        "diagnostics": [],
                    },
                }
            ],
        }
    )


def _graph(payload=None):
    graph = nx.DiGraph()
    attach_evidence(graph, validate_payload(payload or _payload()))
    return graph


def _store(graph) -> Any:
    store = extract_evidence(graph)
    assert store is not None
    return store


def _page_ref(graph):
    found = query_semantics(graph, symbol="Page")
    assert found["status"] == "ok", found
    return found["matches"][0]["reference"]


def _facts(response):
    return [
        item
        for group in response["groups"]
        for category in ("roles", "properties", "relations")
        for item in group[category]
    ]


def test_lossless_records_source_manifest_and_defensive_copies():
    payload = _payload()
    original = copy.deepcopy(payload)
    store = validate_payload(json.dumps(payload))
    graph = nx.Graph()
    attach_evidence(graph, store)
    entry = _store(graph)["documents"]["src/Page.tsx"]
    assert entry["source"] == original["documents"][0]["source"]
    assert entry["result"] == original["documents"][0]["result"]
    assert len(entry["result"]["facts"]) == 66
    assert len(entry["result"]["facts"][1]["value"]["value"]) > 512
    assert _store(graph)["manifests"][original["manifest"]["id"]] == original["manifest"]
    payload["documents"][0]["result"]["facts"].clear()
    store["documents"]["src/Page.tsx"]["source"] = "changed"
    entry["result"]["facts"].clear()
    assert len(_store(graph)["documents"]["src/Page.tsx"]["result"]["facts"]) == 66
    assert graph.number_of_nodes() == graph.number_of_edges() == 0
    response = query_semantics(graph)
    expected = copy.deepcopy(response)
    response["matches"][0]["coverage"]["reports"].clear()
    assert query_semantics(graph) == expected
    graph.graph[SEMANTIC_EVIDENCE_KEY]["documents"]["src/Page.tsx"]["result"]["facts"][0]["evidence"]["span"]["startByte"] = -1
    assert query_semantics(graph)["reason"] == "invalid-semantic-evidence"


def test_whole_json_graph_round_trip_bypasses_generic_sanitization():
    graph = _graph()
    raw = nx.node_link_data(graph)
    loaded = nx.node_link_graph(json.loads(json.dumps(raw)))
    assert extract_evidence(loaded) == extract_evidence(graph)
    assert _page_ref(loaded) == _page_ref(graph)


def test_unicode_and_crlf_exact_bytes_lines_and_excerpts():
    payload = _payload(unicode=True, crlf=True, path="src/caf\u00e9/Page.tsx")
    graph = _graph(payload)
    response = inspect_semantics(graph, _page_ref(graph), excerpt_bytes=113)
    assert response["status"] == "ok"
    source = payload["documents"][0]["source"].encode("utf-8")
    excerpt = response["excerpt"]
    assert source[excerpt["startByte"] : excerpt["endByte"]].decode("utf-8") == excerpt["text"]
    assert "\r\n" in excerpt["text"]
    assert len(excerpt["text"].encode("utf-8")) <= 113
    assert excerpt["truncated"] and excerpt["nextStartByte"] == excerpt["endByte"]
    second = inspect_semantics(
        graph, _page_ref(graph), excerpt_start=excerpt["nextStartByte"], excerpt_bytes=113
    )
    assert second["excerpt"]["startByte"] == excerpt["endByte"]


@pytest.mark.parametrize("damage", ["split", "line", "hash", "surrogate", "ref-text"])
def test_invalid_source_coordinates_and_hash_fail_closed(damage):
    payload = _payload(unicode=True, crlf=True)
    doc = payload["documents"][0]
    fact = doc["result"]["facts"][1]
    if damage == "split":
        byte = doc["source"].encode("utf-8").index("\U0001f680".encode("utf-8"))
        fact["evidence"]["span"]["startByte"] = byte + 1
    elif damage == "line":
        fact["evidence"]["span"]["endLine"] += 1
    elif damage == "hash":
        doc["result"]["sourceHash"] = "0" * 64
    elif damage == "surrogate":
        doc["source"] += "\ud800"
    else:
        fact["term"] = "fst-solid.condition"
        fact["value"] = {
            "kind": "reference",
            "value": {
                "kind": "expression",
                "span": fact["evidence"]["span"],
                "text": "not source text",
            },
        }
    with pytest.raises(EvidenceValidationError):
        validate_payload(payload)


@pytest.mark.parametrize(
    "path",
    [
        "/abs.ts",
        "C:/abs.ts",
        "src\\a.ts",
        "../a.ts",
        "./a.ts",
        "a//b.ts",
        "a/../b.ts",
        "a/",
        "a\x00.ts",
    ],
)
def test_noncanonical_source_paths_rejected(path):
    payload = _payload()
    payload["documents"][0]["result"]["relativePath"] = path
    with pytest.raises(EvidenceValidationError):
        validate_payload(payload)


@pytest.mark.parametrize(
    "damage",
    [
        "payload-version",
        "result-version",
        "manifest-version",
        "extra",
        "manifest-hash",
        "manifest-limit",
        "producer",
        "fingerprint",
        "plugin",
        "term",
        "subject",
        "target",
        "owner",
        "owner-cycle",
        "owner-span",
        "evidence-span",
        "missing-report",
        "report-failed",
        "hidden-partial",
        "typed-value",
        "unresolved-value",
        "duplicate-fact",
        "duplicate-source",
        "name-span",
    ],
)
def test_closed_typed_contract_rejects_corruption(damage):
    payload = _payload(repeats=2)
    result = payload["documents"][0]["result"]
    if damage == "payload-version":
        payload["version"] = True
    elif damage == "result-version":
        result["version"] = 2
    elif damage == "manifest-version":
        payload["manifest"]["version"] = 2
    elif damage == "extra":
        result["facts"][0]["handle"] = "forged"
    elif damage == "manifest-hash":
        payload["manifest"]["plugins"][0]["roles"][0]["description"] = "changed"
    elif damage == "manifest-limit":
        payload["manifest"]["limits"]["maxFacts"] = 4097
        _seal(payload)
    elif damage == "producer":
        payload["producer"]["id"] = "untrusted-other"
    elif damage == "fingerprint":
        payload["producer"]["fingerprint"] = "f" * 64
    elif damage == "plugin":
        result["facts"][0]["evidence"]["pluginId"] = "other"
    elif damage == "term":
        result["facts"][0]["term"] = "fst-solid.cleanup"
    elif damage == "subject":
        result["facts"][0]["subject"] = "missing"
    elif damage == "target":
        result["facts"][2]["target"]["key"] = "missing"
    elif damage == "owner":
        result["declarations"][0]["owner"] = "missing"
    elif damage == "owner-cycle":
        result["declarations"][0]["owner"] = "function:cleanup"
    elif damage == "owner-span":
        result["declarations"][0]["owner"] = "function:Page"
    elif damage == "evidence-span":
        result["facts"][0]["evidence"]["span"] = result["declarations"][0]["span"]
    elif damage == "missing-report":
        result["reports"].clear()
    elif damage == "report-failed":
        result["reports"][0]["state"] = "failed"
    elif damage == "hidden-partial":
        result["reports"][0]["state"] = "partial"
    elif damage == "typed-value":
        result["facts"][1]["value"]["value"] = 42
    elif damage == "unresolved-value":
        result["facts"][1]["resolution"] = "expression"
    elif damage == "duplicate-fact":
        result["facts"].append(copy.deepcopy(result["facts"][0]))
    elif damage == "duplicate-source":
        payload["documents"].append(copy.deepcopy(payload["documents"][0]))
    elif damage == "name-span":
        result["declarations"][1]["nameSpan"] = result["declarations"][0]["nameSpan"]
    with pytest.raises(EvidenceValidationError):
        validate_payload(payload)


def test_json_duplicate_keys_cycles_nonfinite_and_forged_store_keys():
    with pytest.raises(EvidenceValidationError, match="Duplicate JSON key"):
        validate_payload('{"version":1,"version":1}')
    for bad in (float("nan"), 1.5, 2**53):
        with pytest.raises(EvidenceValidationError):
            canonical_json({"value": bad})
    cycle = []
    cycle.append(cycle)
    with pytest.raises(EvidenceValidationError):
        canonical_json(cycle)
    store = validate_payload(_payload())
    store["documents"]["other.ts"] = store["documents"].pop("src/Page.tsx")
    with pytest.raises(EvidenceValidationError, match="ownership"):
        validate_store(store)


def test_canonical_json_matches_wire_escaping_and_safe_integers():
    assert canonical_json({"z": "\U0001f680<>&\u2028\u2029", "a": 2}) == (
        '{"a":2,"z":"\U0001f680\\u003c\\u003e\\u0026\\u2028\\u2029"}'
    )
    with pytest.raises(EvidenceValidationError):
        canonical_json({"a": {"b": 1}}, max_depth=1)


def test_preserves_role_property_and_conditioned_sites_without_endpoint_dedup():
    payload = _payload(repeats=3)
    result = payload["documents"][0]["result"]
    first_role, first_property = copy.deepcopy(result["facts"][:2])
    for index, relation in enumerate(result["facts"][2:]):
        for template in (first_role, first_property):
            fact = copy.deepcopy(template)
            fact["evidence"]["span"] = relation["evidence"]["span"]
            fact["evidence"]["ruleId"] += f".condition-{index}"
            result["facts"].append(fact)
    graph = _graph(payload)
    inspected = inspect_semantics(graph, _page_ref(graph))
    facts = _facts(inspected)
    assert len(facts) == len(result["facts"]) == 11
    assert len({item["reference"] for item in facts}) == 11
    assert len(inspected["groups"][0]["relatedDeclarations"]) == 1


def test_import_type_expression_and_local_targets_remain_distinct():
    payload = _payload(repeats=1)
    doc = payload["documents"][0]
    relation = doc["result"]["facts"][-1]
    expression_span = _span(doc["source"], "onCleanup(cleanup)")
    for index, target in enumerate(
        [
            {"kind": "import", "module": "package", "name": "cleanup", "member": "run"},
            {"kind": "type", "text": "onCleanup(cleanup)", "span": expression_span},
            {"kind": "expression", "text": "onCleanup(cleanup)", "span": expression_span},
        ]
    ):
        fact = copy.deepcopy(relation)
        fact["target"] = target
        fact["evidence"]["ruleId"] = f"reference.kind-{index}"
        doc["result"]["facts"].append(fact)
    graph = _graph(payload)
    response = inspect_semantics(graph, _page_ref(graph))
    targets = [item["targetEvidence"] for item in _facts(response) if "targetEvidence" in item]
    assert targets[0]["kind"] == "declaration" and "reference" in targets[0]
    assert inspect_semantics(graph, targets[0]["reference"])["status"] == "ok"
    for target in targets[1:]:
        assert "implementation-body-unresolved" in target["resolution"]
        assert "reference" not in target


def test_property_resolutions_typed_values_and_cardinality():
    payload = _payload(repeats=1)
    result = payload["documents"][0]["result"]
    template = result["facts"][1]
    for index, (term, resolution, value) in enumerate(
        [
            ("fst-solid.name", "absent", None),
            ("fst-solid.name", "expression", None),
            ("fst-solid.enabled", "literal", {"kind": "boolean", "value": False}),
            ("fst-solid.depth", "constant", {"kind": "integer", "value": 42}),
            (
                "fst-solid.condition",
                "constant",
                {"kind": "reference", "value": {"kind": "declaration", "key": "function:cleanup"}},
            ),
        ]
    ):
        fact = {
            "kind": "property",
            "subject": template["subject"],
            "term": term,
            "resolution": resolution,
            "evidence": copy.deepcopy(template["evidence"]),
        }
        fact["evidence"]["ruleId"] = f"property.resolution-{index}"
        if value is not None:
            fact["value"] = value
        result["facts"].append(fact)
    validate_payload(payload)
    conflicting = copy.deepcopy(result["facts"][-3])
    conflicting["value"]["value"] = True
    conflicting["evidence"]["ruleId"] = "property.conflict"
    result["facts"].append(conflicting)
    with pytest.raises(EvidenceValidationError, match="single-valued"):
        validate_payload(payload)


def test_binding_operations_are_retained_not_runtime_values():
    payload = _payload(repeats=1)
    doc = payload["documents"][0]
    page = doc["result"]["declarations"][1]
    source_span = _span(doc["source"], "title", start=doc["source"].index("const title"))
    expression = {"kind": "expression", "span": source_span, "text": "title"}
    declaration = {
        "key": "binding:title",
        "kind": "variable",
        "name": "title",
        "exports": [],
        "owner": page["key"],
        "span": source_span,
        "nameSpan": source_span,
        "binding": {
            "source": expression,
            "sourceSpan": source_span,
            "patternSpan": source_span,
            "operations": [{"kind": "property", "span": source_span, "key": "title"}],
            "value": "unknown",
            "shapes": [{"kind": "object", "span": source_span, "keys": ["title"]}],
        },
    }
    declaration["writes"] = [copy.deepcopy(declaration["binding"])]
    doc["result"]["declarations"].append(declaration)
    graph = _graph(payload)
    row = query_semantics(graph, symbol="title")["matches"][0]
    assert row["declaration"] == declaration
    response = inspect_semantics(graph, row["reference"])
    assert response["groups"][0]["relatedDeclarations"][0]["key"] == page["key"]
    declaration["binding"]["value"] = "resolved"
    with pytest.raises(EvidenceValidationError, match="runtime value"):
        validate_payload(payload)


def test_search_exact_symbols_meaning_path_and_plugin_no_fuzzy_links():
    graph = _graph()
    assert (
        query_semantics(graph, "current owner", plugin="fst-solid")["matches"][0]["declaration"][
            "name"
        ]
        == "Page"
    )
    assert query_semantics(graph, path="src", symbol="Page")["total"] == 1
    assert query_semantics(graph, path="sr", symbol="Page")["total"] == 0
    assert query_semantics(graph, symbol="page")["total"] == 0
    assert query_semantics(graph, symbol="Pag")["total"] == 0
    assert query_semantics(graph, plugin="other")["total"] == 0
    row = query_semantics(graph, symbol="Page")["matches"][0]
    assert any("not proof" in term.get("description", "") for term in row["vocabulary"])


def test_failed_unsupported_and_diagnostics_are_visible_not_complete():
    for state in ("failed", "unsupported", "partial", "truncated", "not-applicable"):
        payload = _payload(repeats=1)
        result = payload["documents"][0]["result"]
        result["state"] = result["reports"][0]["state"] = state
        if state in ("failed", "unsupported", "not-applicable"):
            result["facts"].clear()
        graph = _graph(payload)
        row = query_semantics(graph, path="src/Page.tsx")["matches"][0]
        assert row["coverage"]["effectiveState"] == state
        assert row["coverage"]["complete"] == (state == "not-applicable")
    payload = _payload()
    payload["documents"][0]["result"]["diagnostics"] = [
        {"code": "parse.recovery", "message": LONG_VALUE}
    ]
    graph = _graph(payload)
    coverage = query_semantics(graph, symbol="Page")["matches"][0]["coverage"]
    assert coverage["reportedState"] == "complete"
    assert coverage["effectiveState"] == "partial" and not coverage["complete"]
    assert coverage["diagnostics"][0]["message"] == LONG_VALUE


def test_incremental_ownership_partial_failed_missing_and_deleted():
    original = validate_payload(_payload())
    second = validate_payload(_payload(path="src/Other.tsx"))
    joined = merge_evidence(original, second)
    assert set(joined["documents"]) == {"src/Page.tsx", "src/Other.tsx"}
    partial_payload = _payload(repeats=1)
    partial_payload["documents"][0]["result"]["state"] = "partial"
    partial_payload["documents"][0]["result"]["reports"][0]["state"] = "partial"
    partial = validate_payload(partial_payload)
    with pytest.raises(EvidenceValidationError, match="ownership"):
        merge_evidence(joined, partial)
    merged = merge_evidence(joined, partial, replaced_sources=["src/Page.tsx"])
    head = merged["documents"]["src/Page.tsx"]
    assert head["result"]["state"] == "partial"
    assert head.get("retained") == original["documents"]["src/Page.tsx"]
    assert merged["documents"]["src/Other.tsx"] == second["documents"]["src/Other.tsx"]
    missing = merge_evidence(merged, replaced_sources=["src/Other.tsx"])
    assert missing["documents"]["src/Other.tsx"].get("refreshFailed") is True
    assert (
        missing["documents"]["src/Other.tsx"].get("retained")
        == second["documents"]["src/Other.tsx"]
    )
    graph = nx.Graph()
    attach_evidence(graph, missing)
    coverage = query_semantics(graph, path="src/Other.tsx")["matches"][0]["coverage"]
    assert coverage["sourceFreshness"] == "refresh-failed-current-source-unknown"
    assert coverage["effectiveState"] == "failed" and not coverage["complete"]
    failed = merge_evidence(missing, failed_sources=["src/Page.tsx"])
    assert failed["documents"]["src/Page.tsx"]["result"] == head["result"]
    assert failed["documents"]["src/Page.tsx"].get("refreshFailed") is True
    deleted = merge_evidence(failed, deleted_sources=["src/Page.tsx"])
    assert set(deleted["documents"]) == {"src/Other.tsx"}
    recovered = merge_evidence(failed, original, replaced_sources=["src/Page.tsx"])
    assert recovered["documents"]["src/Page.tsx"] == original["documents"]["src/Page.tsx"]
    assert "retained" not in original["documents"]["src/Page.tsx"]


def test_failed_valid_output_retains_prior_complete_but_not_current_handles():
    first_graph = _graph()
    old_ref = _page_ref(first_graph)
    original = _store(first_graph)
    payload = _payload(repeats=0)
    result = payload["documents"][0]["result"]
    result["state"] = result["reports"][0]["state"] = "failed"
    result["facts"].clear()
    changed = merge_evidence(original, validate_payload(payload), failed_sources=["src/Page.tsx"])
    attach_evidence(first_graph, changed)
    assert (
        inspect_semantics(first_graph, old_ref)["reason"] == "stale-or-unknown-evidence-reference"
    )
    assert (
        query_semantics(first_graph, symbol="Page")["matches"][0]["coverage"]["complete"] is False
    )
    assert (
        changed["documents"]["src/Page.tsx"].get("retained")
        == original["documents"]["src/Page.tsx"]
    )


def test_credential_shaped_source_or_records_are_rejected_not_rewritten():
    payload = _payload(repeats=1)
    original = copy.deepcopy(payload)
    token = "ghp_" + "a" * 40
    payload["documents"][0]["source"] += "\n// " + token
    _seal(payload)
    with pytest.raises(EvidenceValidationError, match="Credential-shaped") as error:
        validate_payload(payload)
    assert token not in str(error.value)
    store = validate_payload(original)
    store["documents"]["src/Page.tsx"]["source"] += "\n// " + token
    store["documents"]["src/Page.tsx"]["result"]["sourceHash"] = _hash(
        store["documents"]["src/Page.tsx"]["source"]
    )
    with pytest.raises(EvidenceValidationError, match="Credential-shaped"):
        validate_store(store)
    original["documents"][0]["result"]["diagnostics"] = [{"code": "untrusted", "message": token}]
    with pytest.raises(EvidenceValidationError, match="Credential-shaped"):
        validate_payload(original)


def test_multi_producer_analysis_conflicts_are_explicit_and_path_qualified():
    original = validate_payload(_payload())
    upgraded = _payload()
    fingerprint = _hash("producer-upgrade")
    upgraded["producer"]["fingerprint"] = fingerprint
    upgraded["manifest"]["core"]["implementationDigest"] = fingerprint
    upgraded["manifest"]["view"]["implementationDigest"] = fingerprint
    upgraded["manifest"]["plugins"][0]["implementationDigest"] = fingerprint
    upgrade = validate_payload(_seal(upgraded))
    with pytest.raises(EvidenceValidationError, match="producer conflict"):
        merge_evidence(original, upgrade)
    replaced = merge_evidence(original, upgrade, replaced_sources=["src/Page.tsx"])
    graph = nx.Graph()
    attach_evidence(graph, original)
    old_ref = _page_ref(graph)
    attach_evidence(graph, replaced)
    assert _page_ref(graph) != old_ref
    assert inspect_semantics(graph, old_ref)["status"] == "unsupported"
    upgraded["documents"][0]["result"]["relativePath"] = "src/Other.tsx"
    joined = merge_evidence(original, validate_payload(upgraded))
    assert len(joined["manifests"]) == 2
    attach_evidence(graph, joined)
    matches = query_semantics(graph, symbol="Page")["matches"]
    assert len({row["reference"] for row in matches}) == 2


def test_conflicting_delete_and_persisted_corruption_fail_atomically():
    store = validate_payload(_payload())
    with pytest.raises(EvidenceValidationError, match="deleted"):
        merge_evidence(store, store, deleted_sources=["src/Page.tsx"])
    graph = _graph()
    before = copy.deepcopy(graph.graph)
    corrupt = copy.deepcopy(store)
    corrupt["documents"]["src/Page.tsx"]["result"]["sourceHash"] = "f" * 64
    with pytest.raises(EvidenceValidationError):
        attach_evidence(graph, corrupt)
    assert graph.graph == before
    graph.graph[SEMANTIC_EVIDENCE_KEY] = corrupt
    with pytest.raises(EvidenceValidationError):
        extract_evidence(graph)
    assert query_semantics(graph)["reason"] == "invalid-semantic-evidence"
    assert inspect_semantics(graph, _page_ref(_graph()))["reason"] == "invalid-semantic-evidence"


def test_manifest_only_and_source_deletion_do_not_discard_valid_manifest_records():
    payload = _payload(repeats=1)
    payload["documents"].clear()
    empty = validate_payload(payload)
    assert merge_evidence(None, empty) == empty
    store = validate_payload(_payload(repeats=1))
    deleted = merge_evidence(store, deleted_sources=["src/Page.tsx"])
    assert deleted["documents"] == {}
    assert deleted["manifests"] == store["manifests"]


def test_limits_reject_without_clipping_and_allow_explicit_reader_configuration():
    payload = _payload()
    with pytest.raises(EvidenceValidationError, match="byte limit"):
        validate_payload(payload, limits=EvidenceLimits(max_payload_bytes=512))
    payload["manifest"]["limits"]["maxFacts"] = 50
    with pytest.raises(EvidenceValidationError, match="array limit"):
        validate_payload(_seal(payload))
    with pytest.raises(EvidenceValidationError):
        EvidenceLimits(max_depth=129)
    with pytest.raises(EvidenceValidationError):
        query_semantics(_graph(), max_bytes=255)
    graph = _graph()
    configured = EvidenceLimits(response_bytes=8192, max_response_bytes=8192, max_page_items=2)
    response = query_semantics(graph, limit=2, limits=configured)
    assert len(response_json(response).encode("utf-8")) <= 8192


def test_lower_analysis_work_and_depth_do_not_invalidate_the_manifest_json():
    payload = _payload(repeats=1)
    payload["manifest"]["limits"].update(maxWork=1, maxDepth=1)
    result = payload["documents"][0]["result"]
    result["facts"].clear()
    result["declarations"].clear()
    result["state"] = result["reports"][0]["state"] = "truncated"
    result["reports"][0]["diagnostics"] = [
        {"code": "budget.work", "message": "Analysis work budget exhausted."}
    ]
    graph = _graph(_seal(payload))
    row = query_semantics(graph)["matches"][0]
    assert row["coverage"]["effectiveState"] == "truncated"
    assert not row["coverage"]["complete"]


def test_inspection_whole_response_budget_and_continuation_preserve_every_fact():
    graph = _graph(_payload(unicode=True))
    reference = _page_ref(graph)
    cursor = None
    facts = []
    page_count = 0
    while True:
        response = inspect_semantics(
            graph, reference, max_bytes=8500, excerpt_bytes=128, cursor=cursor
        )
        assert response["status"] == "ok", response
        assert len(response_json(response).encode("utf-8")) <= 8500
        assert len(json.dumps(response).encode("utf-8")) <= 8500
        facts.extend(_facts(response))
        page_count += 1
        cursor = response["continuation"]
        if cursor is None:
            assert not response["truncated"]
            break
        assert response["truncated"]
        assert page_count < 100
    assert len(facts) == 66 and len({fact["reference"] for fact in facts}) == 66
    assert page_count > 1
    fact_response = inspect_semantics(graph, facts[1]["reference"])
    assert [f["fact"] for f in _facts(fact_response)] == [facts[1]["fact"]]


def test_query_continuation_and_scope_staleness():
    graph = _graph()
    response = query_semantics(graph, limit=1)
    assert response["truncated"] and response["continuation"]
    second = query_semantics(graph, limit=1, cursor=response["continuation"])
    assert second["matches"][0]["reference"] != response["matches"][0]["reference"]
    assert (
        query_semantics(graph, query="different", cursor=response["continuation"])["reason"]
        == "stale-or-invalid-continuation"
    )
    attach_evidence(
        graph,
        merge_evidence(
            extract_evidence(graph),
            validate_payload(_payload(repeats=1)),
            replaced_sources=["src/Page.tsx"],
        ),
    )
    assert (
        query_semantics(graph, cursor=response["continuation"])["reason"]
        == "stale-or-invalid-continuation"
    )


def test_small_budget_returns_useful_reason_not_partial_dependency_records():
    graph = _graph()
    for budget in (256, 512, 1500):
        response = inspect_semantics(graph, _page_ref(graph), max_bytes=budget)
        assert response["status"] == "unsupported"
        assert "budget" in response["reason"]
        assert len(response_json(response).encode("utf-8")) <= budget
        assert "groups" not in response
    result = query_semantics(graph, symbol="Page", max_bytes=1000)
    assert result["reason"] == "indivisible-evidence-exceeds-budget"
    assert result["requiredBytes"] > 1000


def test_no_live_reads_processes_or_name_join_and_forged_refs_rejected(monkeypatch):
    graph = _graph()
    reference = _page_ref(graph)
    graph.add_node("fuzzy-page", label="Page", source_file="unrelated.ts")

    def forbidden(*args, **kwargs):
        raise AssertionError("Semantic readers must not perform I/O")

    monkeypatch.setattr("builtins.open", forbidden)
    monkeypatch.setattr(Path, "open", forbidden)
    monkeypatch.setattr(Path, "read_text", forbidden)
    monkeypatch.setattr("subprocess.run", forbidden)
    assert query_semantics(graph, symbol="Page")["total"] == 1
    assert inspect_semantics(graph, reference)["status"] == "ok"
    assert inspect_semantics(graph, "fuzzy-page")["reason"] == "invalid-evidence-reference"
    assert (
        inspect_semantics(graph, "gfe1:declaration:" + "0" * 64)["reason"]
        == "stale-or-unknown-evidence-reference"
    )
    assert extract_evidence(nx.Graph()) is None
    assert query_semantics(nx.Graph())["reason"] == "semantic-evidence-not-indexed"


def test_full_configuration_provenance_survives_payload_store_and_empty_documents():
    aliases = {
        "caller-ui": "@fst/components-fst-solid/app/component",
        "caller-reactive": "solid-js",
    }
    payload = _payload(module_aliases=aliases, repeats=1)
    expected_digest = _hash(canonical_json({"limits": ANNOTATION_LIMITS, "moduleAliases": aliases}))
    manifest = payload["manifest"]
    for descriptor in (manifest["core"], manifest["view"], *manifest["plugins"]):
        assert descriptor["configurationDigest"] == expected_digest
    store = validate_payload(payload)
    assert store["producers"] == {manifest["id"]: payload["producer"]}
    assert validate_store(json.dumps(store)) == store
    graph = _graph(payload)
    response = inspect_semantics(graph, _page_ref(graph))
    assert response["producer"]["configuration"]["moduleAliases"] == aliases
    assert any("not verified package" in unknown for unknown in response["unknowns"])
    assert _store(graph)["documents"]["src/Page.tsx"]["source"] == payload["documents"][0]["source"]
    deleted = merge_evidence(store, deleted_sources=["src/Page.tsx"])
    assert deleted["documents"] == {} and deleted["producers"] == store["producers"]
    assert validate_store(deleted) == deleted
    payload["documents"].clear()
    empty = validate_payload(payload)
    assert empty["producers"] == store["producers"]
    assert merge_evidence(None, empty) == empty


@pytest.mark.parametrize("location", ["core", "view", "plugin", "all", "aliases", "limits"])
def test_reidentified_manifest_cannot_hide_forged_configuration_digest(location):
    payload = _payload(module_aliases={"caller": "solid-js"}, repeats=1)
    manifest = payload["manifest"]
    if location == "aliases":
        payload["producer"]["configuration"]["moduleAliases"]["caller"] = "@solidjs/router"
    elif location == "limits":
        manifest["limits"]["maxFacts"] = 4000
    elif location == "all":
        for descriptor in (manifest["core"], manifest["view"], *manifest["plugins"]):
            descriptor["configurationDigest"] = "f" * 64
    else:
        descriptor = manifest["plugins"][0] if location == "plugin" else manifest[location]
        descriptor["configurationDigest"] = "f" * 64
    # Re-sign only the manifest: passing its content hash is not enough to bind
    # caller-readable aliases and effective limits to every producer descriptor.
    manifest["id"] = _hash(
        canonical_json({key: value for key, value in manifest.items() if key != "id"})
    )
    for document in payload["documents"]:
        document["result"]["analysisSetId"] = manifest["id"]
    with pytest.raises(EvidenceValidationError, match="configuration disagrees"):
        validate_payload(payload)


@pytest.mark.parametrize("missing", ["producer", "aliases", "core", "view", "plugin"])
def test_native_graphify_configuration_fields_are_required_without_migration(missing):
    payload = _payload(repeats=1)
    if missing == "producer":
        del payload["producer"]["configuration"]
    elif missing == "aliases":
        del payload["producer"]["configuration"]["moduleAliases"]
    elif missing == "plugin":
        del payload["manifest"]["plugins"][0]["configurationDigest"]
    else:
        del payload["manifest"][missing]["configurationDigest"]
    with pytest.raises(EvidenceValidationError, match="Missing object property"):
        validate_payload(payload)


@pytest.mark.parametrize(
    "configuration",
    [
        None,
        [],
        {"moduleAliases": None},
        {"moduleAliases": []},
        {"moduleAliases": {}, "limits": {}},
        {"moduleAliases": {}, "extra": True},
        {"moduleAliases": {"solid-js": "@solidjs/router"}},
        {"moduleAliases": {"caller": "unreviewed"}},
        {"moduleAliases": {"caller": "solid-js", "solid-js/sub": "solid-js"}},
    ],
)
def test_producer_configuration_is_closed_and_uses_shared_alias_rules(configuration):
    payload = _payload(repeats=1)
    payload["producer"]["configuration"] = configuration
    with pytest.raises(EvidenceValidationError):
        validate_payload(payload)


@pytest.mark.parametrize(
    "damage", ["absent", "missing", "extra", "registry", "document", "retained"]
)
def test_persisted_producers_and_all_document_generations_are_validated(damage):
    store: Any = validate_payload(_payload(module_aliases={"caller": "solid-js"}, repeats=1))
    if damage == "absent":
        del store["producers"]
    elif damage == "missing":
        store["producers"].clear()
    elif damage == "extra":
        store["producers"]["0" * 64] = copy.deepcopy(next(iter(store["producers"].values())))
    else:
        if damage == "registry":
            producer = next(iter(store["producers"].values()))
        elif damage == "document":
            producer = store["documents"]["src/Page.tsx"]["producer"]
            # validate_store must not rely on an aliased registry object being
            # the same Python instance as a document's independently decoded data.
            store = json.loads(json.dumps(store))
            producer = store["documents"]["src/Page.tsx"]["producer"]
        else:
            partial = _payload(module_aliases={"other": "solid-js"}, repeats=2)
            partial["documents"][0]["result"]["state"] = "partial"
            partial["documents"][0]["result"]["reports"][0]["state"] = "partial"
            store = merge_evidence(
                store, validate_payload(partial), replaced_sources=["src/Page.tsx"]
            )
            producer = store["documents"]["src/Page.tsx"]["retained"]["producer"]
        producer["configuration"]["moduleAliases"] = {"caller": "@solidjs/router"}
    with pytest.raises(EvidenceValidationError):
        validate_store(store)


def test_configuration_change_invalidates_exact_handles_without_rewriting_source():
    first = _payload(module_aliases={"caller": "solid-js"}, repeats=1)
    second = _payload(module_aliases={"caller": "@solidjs/router"}, repeats=1)
    assert first["documents"][0]["source"] == second["documents"][0]["source"]
    assert (
        first["documents"][0]["result"]["sourceHash"]
        == second["documents"][0]["result"]["sourceHash"]
    )
    assert first["manifest"]["id"] != second["manifest"]["id"]
    graph = _graph(first)
    reference = _page_ref(graph)
    fact_reference = _facts(inspect_semantics(graph, reference))[0]["reference"]
    second_store = validate_payload(second)
    with pytest.raises(EvidenceValidationError, match="ownership"):
        merge_evidence(_store(graph), second_store)
    merged = merge_evidence(_store(graph), second_store, replaced_sources=["src/Page.tsx"])
    attach_evidence(graph, merged)
    assert len(merged["producers"]) == len(merged["manifests"]) == 2
    assert _page_ref(graph) != reference
    for stale in (reference, fact_reference):
        assert inspect_semantics(graph, stale)["reason"] == "stale-or-unknown-evidence-reference"
    assert (
        query_semantics(graph, symbol="Page")["matches"][0]["producer"]["configuration"]
        == second["producer"]["configuration"]
    )


def test_alias_key_order_does_not_change_manifest_or_content_references():
    first = _payload(module_aliases={"z": "solid-js", "a": "@solidjs/router"}, repeats=1)
    second = _payload(module_aliases={"a": "@solidjs/router", "z": "solid-js"}, repeats=1)
    assert first["manifest"] == second["manifest"]
    assert _page_ref(_graph(first)) == _page_ref(_graph(second))


@pytest.mark.skipif(shutil.which("node") is None, reason="Installed Node worker requires Node.js")
@pytest.mark.parametrize("dynamic_metadata", [False, True])
def test_real_installed_worker_aliases_bind_provenance_without_source_rewrites(dynamic_metadata):
    from graphify.framework_analysis import analyze_documents, make_document
    from graphify.framework_config import normalize_analysis_options

    aliases = {"@caller/ui": "@fst/components-fst-solid", "@caller/ui/reactive": "solid-js"}
    metadata = "{name: componentName}" if dynamic_metadata else '{name: "Panel"}'
    source = (
        '\ufeffimport { component } from "@caller/ui/app/component";\r\n'
        'import { createSignal } from "@caller/ui/reactive";\r\n'
        'import { componentName } from "@caller/metadata";\r\n'
        "// caf\u00e9 \U0001f680\r\n"
        "export const Panel = component(() => { const [value, setValue] = createSignal(1); "
        "return { value, setValue }; }, " + metadata + ");\r\n"
    )
    options = normalize_analysis_options({"moduleAliases": aliases}, max_limits={**ANNOTATION_LIMITS, "maxPlugins": 8})
    document = make_document(source, "src/Alias.ts", "typescript")
    store = analyze_documents([document], options=options)
    assert validate_store(store) == store
    entry = store["documents"]["src/Alias.ts"]
    assert entry["source"] == source
    assert entry["result"]["sourceHash"] == _hash(source)
    expected_state = "partial" if dynamic_metadata else "complete"
    assert entry["result"]["state"] == expected_state, (
        entry["result"]["diagnostics"],
        entry["result"]["reports"],
    )
    assert entry["producer"]["configuration"] == {"moduleAliases": aliases}
    manifest = store["manifests"][entry["result"]["analysisSetId"]]
    digest = _hash(canonical_json(options))
    assert all(
        descriptor["configurationDigest"] == digest
        for descriptor in (manifest["core"], manifest["view"], *manifest["plugins"])
    )
    framework_plugins = {"fst-solid", "fst-components", "solid"}
    assert any(
        fact["evidence"]["pluginId"] in framework_plugins for fact in entry["result"]["facts"]
    )
    default = analyze_documents([document])
    default_entry = default["documents"]["src/Alias.ts"]
    assert not any(
        fact["evidence"]["pluginId"] in framework_plugins
        for fact in default_entry["result"]["facts"]
    )
    assert default_entry["result"]["declarations"] == entry["result"]["declarations"]
    assert default_entry["result"]["sourceHash"] == entry["result"]["sourceHash"]
    assert default_entry["result"]["analysisSetId"] != entry["result"]["analysisSetId"]
    empty = analyze_documents([], options=options)
    assert empty["documents"] == {} and empty["producers"] == store["producers"]
    graph = nx.Graph()
    attach_evidence(graph, store)
    match = query_semantics(graph, symbol="Panel")["matches"][0]
    inspected = inspect_semantics(graph, match["sourceReference"])
    assert inspected["coverage"]["complete"] is not dynamic_metadata
    if dynamic_metadata:
        report = next(
            report
            for report in inspected["coverage"]["reports"]
            if report["pluginId"] == "fst-solid"
        )
        assert report["state"] == "partial"
        assert any(
            diagnostic["code"] == "fst-solid.dynamic-options"
            for diagnostic in report["diagnostics"]
        )
    assert inspected["producer"]["configuration"]["moduleAliases"] == aliases
    assert inspected["excerpt"]["text"] == source
    assert any("not verified package" in unknown for unknown in inspected["unknowns"])
