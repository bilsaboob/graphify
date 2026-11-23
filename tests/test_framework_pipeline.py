"""Source-only semantic qualification through Graphify's real persisted pipeline.

Fixtures are parser inputs, never imported applications. Expected contracts come
from the reference producer tests, not from generic call edges or name matches.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import pytest

from graphify.build import build_from_json, build_merge, merge_raw_extraction
from graphify.export import to_json
from graphify.extract import extract
from graphify.framework_evidence import inspect_semantics, query_semantics, response_json
from graphify.serve import _read_graph


FIXTURES = Path(__file__).parent / "fixtures" / "framework_semantics"
PLUGINS = {
    "fst-solid", "solid", "fst-components", "implementation",
    "transport-binding", "validation-contract", "dispatch-binding",
}


def _extract_sources(root, sources):
    paths = []
    for relative, source in sources.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(source.encode("utf-8"))
        paths.append(path)
    return extract(paths, root=root, cache_root=root, parallel=False)


def _round_trip(graph, path):
    assert to_json(graph, {}, str(path), force=True)
    return _read_graph(str(path))


def _result(graph, path):
    store = graph.graph["semantic_evidence"]
    assert store["version"] == 1
    document = store["documents"][path]
    result = document["result"]
    assert result["sourceHash"] == hashlib.sha256(document["source"].encode("utf-8")).hexdigest()
    assert result["relativePath"] == path
    assert result["analysisSetId"] in store["manifests"]
    return result


def _facts(result, term, name=None):
    keys = {d["key"] for d in result["declarations"] if d.get("name") == name}
    return [f for f in result["facts"] if f["term"] == term and (name is None or f["subject"] in keys)]


def _values(result, term, name=None):
    return [f["value"]["value"] for f in _facts(result, term, name) if "value" in f]


def _declaration(result, name):
    found = [d for d in result["declarations"] if d.get("name") == name]
    assert len(found) == 1, (name, found)
    return found[0]


def _text(source, span):
    data = source.encode("utf-8")
    start, end = span["startByte"], span["endByte"]
    assert 0 <= start <= end <= len(data)
    assert span["startLine"] == data[:start].decode("utf-8").count("\n") + 1
    assert span["endLine"] == data[:end].decode("utf-8").removesuffix("\n").count("\n") + 1
    return data[start:end].decode("utf-8")


def _locator(source, value):
    assert re.fullmatch(r"s:\d+:\d+:\d+:\d+", value), value
    values = map(int, value.split(":")[1:])
    return _text(source, dict(zip(("startByte", "endByte", "startLine", "endLine"), values)))


def _units(result, plugin, role):
    grouped = {}
    for fact in result["facts"]:
        if fact["evidence"]["pluginId"] != plugin:
            continue
        key = json.dumps([fact["subject"], fact["evidence"]], sort_keys=True)
        grouped.setdefault(key, []).append(fact)
    return [facts for facts in grouped.values()
            if any(f["kind"] == "role" and f["term"] == f"{plugin}.{role}" for f in facts)
            and any(f["term"] == f"{plugin}.unit-complete" and f["value"]["value"] is True for f in facts)]


def _fields(unit, name):
    return [f["value"]["value"] for f in unit if f["term"].endswith("." + name) and "value" in f]


def _field(unit, name):
    found = _fields(unit, name)
    assert len(found) == 1, (name, found)
    return found[0]


def _source_row(graph, path):
    response = query_semantics(graph, path=path, limit=1, max_bytes=128 * 1024)
    assert response["status"] == "ok", response
    assert len(response["matches"]) == 1
    row = response["matches"][0]
    assert row["kind"] == "source" and row["relativePath"] == path
    return row


def _inspect_all(graph, reference, *, max_bytes=128 * 1024):
    cursor = None
    seen = set()
    declarations, facts = {}, {}
    for _ in range(64):
        response = inspect_semantics(graph, reference, cursor=cursor, max_bytes=max_bytes, excerpt_bytes=64)
        assert len(response_json(response).encode("utf-8")) <= max_bytes
        assert response["status"] == "ok", response
        for group in response["groups"]:
            declarations[group["reference"]] = group["declaration"]
            for category in ("roles", "properties", "relations"):
                for item in group[category]:
                    assert item["reference"] not in facts, "A continuation repeated a fact"
                    assert item["vocabulary"]["id"] == item["fact"]["term"]
                    facts[item["reference"]] = item["fact"]
        if not response["truncated"]:
            assert response["continuation"] is None
            return declarations, facts
        cursor = response["continuation"]
        assert cursor and cursor not in seen, "A continuation must make bounded progress"
        seen.add(cursor)
    pytest.fail("Semantic inspection did not finish within 64 pages")


@pytest.fixture(scope="module")
def pipeline(tmp_path_factory):
    root = tmp_path_factory.mktemp("framework-pipeline")
    sources = {p.name: p.read_text(encoding="utf-8") for p in sorted(FIXTURES.glob("*.ts*"))}
    raw = _extract_sources(root, sources)
    graph = build_from_json(deepcopy(raw), directed=True, root=root)
    loaded = _round_trip(graph, root / "graph.json")
    assert loaded.graph["semantic_evidence"] == graph.graph["semantic_evidence"]
    return root, sources, raw, loaded


def test_all_seven_producers_survive_public_pipeline(pipeline):
    _, sources, raw, graph = pipeline
    assert raw["semantic_evidence"] == graph.graph["semantic_evidence"]
    store = graph.graph["semantic_evidence"]
    assert set(store["documents"]) == set(sources)
    for path in sources:
        result = _result(graph, path)
        assert {r["pluginId"] for r in result["reports"]} == PLUGINS
        assert not any(r["state"] == "failed" for r in result["reports"]), result["reports"]
        manifest = store["manifests"][result["analysisSetId"]]
        assert {p["id"] for p in manifest["plugins"]} == PLUGINS
        assert store["documents"][path]["source"] == sources[path]
        keys = {d["key"] for d in result["declarations"]}
        for fact in result["facts"]:
            assert fact["subject"] in keys
            assert fact["evidence"]["pluginId"] in PLUGINS
            assert _text(sources[path], fact["evidence"]["span"])
            if fact.get("target", {}).get("kind") == "declaration":
                assert fact["target"]["key"] in keys


def test_state_form_scopes_and_borrowed_field_lifetimes(pipeline):
    result = _result(pipeline[3], "lifetime.tsx")
    for name, role in [("DraftState", "state"), ("DraftForm", "form"), ("DraftScope", "scope")]:
        assert _facts(result, "fst-solid." + role, name)
    assert _values(result, "fst-solid.lifetime-operation", "state") == ["create-scoped"]
    assert _values(result, "fst-solid.lifetime-operation", "standalone") == ["create-standalone"]
    assert "scoped-only" in _values(result, "fst-solid.lookup-policy", "scope")
    assert "scoped-with-global-fallback" in _values(result, "fst-solid.lookup-policy", "form")
    assert "raw-constructor" in _values(result, "fst-solid.instance-kind", "raw")
    assert "borrowed-no-disposal" in _values(result, "fst-solid.ownership", "binding")
    assert _values(result, "fst-solid.field-path", "title") == ["title"]
    origin = _facts(result, "fst-solid.form-origin", "title")
    assert any(f["target"] == {"kind": "declaration", "key": _declaration(result, "form")["key"]} for f in origin)


def test_field_undefined_known_and_conditional_dispatch_remain_distinct(pipeline):
    result = _result(pipeline[3], "lifetime.tsx")
    source = pipeline[1]["lifetime.tsx"]
    calls = {_text(source, f["evidence"]["span"]): f["value"]["value"]
             for f in _facts(result, "fst-solid.field-operation", "setup")}
    assert calls["local(undefined)"] == "read"
    assert calls["local('changed')"] == "write-request"
    assert calls["local(candidate)"] == "conditional-read-or-write-request"
    assert any("argument[0] === undefined: read; otherwise: write request" in v
               for v in _values(result, "fst-solid.field-dispatch", "setup"))
    assert {"pre-commit", "post-commit"} <= set(_values(result, "fst-solid.observation-phase", "setup"))


def test_configuration_initialization_and_cleanup_are_not_interchangeable(pipeline):
    result = _result(pipeline[3], "lifetime.tsx")
    assert _values(result, "fst-solid.hook-kind", "initLoad") == ["state.initLoad"]
    assert _values(result, "fst-solid.hook-kind", "init") == ["form.init"]
    registrations = _values(result, "fst-solid.registration-kind", "setup")
    assert {"state.init-configuration", "solid.content-or-effect-cleanup", "fst.wrapper-cleanup"} <= set(registrations)
    assert {"component.post-render-register", "dom.exit-register"} <= set(_values(result, "fst-solid.api-operation"))
    assert not any("undocumentedCallback" in f.get("target", {}).get("text", "")
                   for f in _facts(result, "fst-solid.callback"))


def test_signal_and_store_pairings_keep_exact_declarations_and_occurrences(pipeline):
    result = _result(pipeline[3], "reactive.tsx")
    for setter, accessor, term in [("setFirst", "first", "setter-for"), ("setSecond", "second", "setter-for"),
                                   ("write", "first", "setter-for"), ("update", "record", "updater-for"),
                                   ("patch", "record", "updater-for")]:
        assert _facts(result, "solid." + term, setter)[0]["target"]["key"] == _declaration(result, accessor)["key"]
    reads = _facts(result, "solid.signal-read", "setup")
    first = [f for f in reads if f["target"]["key"] == _declaration(result, "first")["key"]]
    assert len(first) == 2
    assert len({f["evidence"]["span"]["startByte"] for f in first}) == 2
    assert len(_facts(result, "solid.signal-write", "setup")) == 3
    assert len(_facts(result, "solid.store-update", "setup")) == 2


def test_for_index_show_and_spread_override_do_not_guess_final_values(pipeline):
    result = _result(pipeline[3], "reactive.tsx")
    assert {"item: item value", "index: index accessor", "item: item accessor", "index: index value",
            "item: condition value (keyed)", "item: condition accessor"} <= set(_values(result, "solid.parameter-role"))
    assert not _facts(result, "solid.dynamic-component", "Overridden")
    assert _facts(result, "solid.jsx-overridden", "Overridden")[0]["target"]["text"] == "component={Known}"
    assert any("dynamic keys" in value for value in _values(result, "solid.jsx-mode", "Overridden"))


def test_component_library_typed_callbacks_and_spread_order(pipeline):
    result = _result(pipeline[3], "controls.tsx")
    contracts = _values(result, "fst-components.callback-contract")
    for expected in ["TextBox.onInput(string", "Checkbox.onChange(boolean", "Slider.onInput(number", "ColorEditor.onInput(normalized-hex-string)"]:
        assert any(expected in value for value in contracts), contracts
    assert any("borrowed-field" in value for value in _values(result, "fst-components.ownership"))
    assert "value=#abcdef" in _values(result, "fst-components.literal", "OverriddenColor")
    assert "value=#123456" not in _values(result, "fst-components.literal", "OverriddenColor")
    assert not _facts(result, "fst-components.value", "UnknownProps")
    assert any("TextBox.onInput" in value for value in _values(result, "fst-components.callback-contract", "UnknownProps"))


def test_local_outcomes_writes_assertions_and_environment_are_structured(pipeline):
    result = _result(pipeline[3], "implementation.ts")
    source = pipeline[1]["implementation.ts"]
    returned = _units(result, "implementation", "return")
    guarded = next(u for u in returned if _locator(source, _field(u, "value")) == "input")
    thrown = _units(result, "implementation", "throw")[0]
    assignment = _units(result, "implementation", "assignment")[0]
    assert _locator(source, _field(guarded, "if-true")) == "(input.ready)"
    assert _locator(source, _field(thrown, "if-false")) == "(input.ready)"
    assert _field(assignment, "operator") == "+="
    assert _field(assignment, "if-true") == _field(guarded, "if-true")
    assert _field(_units(result, "implementation", "update")[0], "operator") == "++"
    reads = _units(result, "implementation", "config-read")
    assert {_field(u, "config-key") for u in reads} == {"REGION", "MODE", "TOKEN", "ORIGIN"}
    assert {_field(u, "fallback-semantics") for u in reads if _fields(u, "fallback-semantics")} == {"nullish", "falsy", "undefined"}
    tests = _units(result, "implementation", "test")
    assertions = _units(result, "implementation", "assertion")
    assert len(tests) == len(assertions) == 2
    assert len({_field(u, "callback") for u in tests}) == 2
    for assertion in assertions:
        assert sum(_field(u, "callback") == _field(assertion, "test-owner") for u in tests) == 1
    asynchronous = next(u for u in assertions if _field(u, "async-mode") == "resolves")
    assert _field(asynchronous, "negated") is True
    assert _field(asynchronous, "awaited") is True
    assert "private-default" not in json.dumps([f for f in result["facts"] if f["evidence"]["pluginId"] == "implementation"])


def test_event_allocations_do_not_join_on_event_name(pipeline):
    result = _result(pipeline[3], "events.ts")
    instances = _units(result, "transport-binding", "event-instance")
    listeners = _units(result, "transport-binding", "event-listener")
    emissions = _units(result, "transport-binding", "event-emission")
    assert len(instances) == len(listeners) == len(emissions) == 2
    assert len({_field(u, "allocation") for u in instances}) == 2
    assert len({json.dumps(_field(u, "declaration"), sort_keys=True) for u in instances}) == 2
    assert len({_field(u, "allocation") for u in listeners}) == 1
    assert len({_field(u, "allocation") for u in emissions}) == 2
    assert sorted(_field(u, "endpoint-count") for u in instances) == [1, 3]
    for unit in instances + listeners + emissions:
        assert _field(unit, "inventory-complete") is True
        assert {"registration-order-unknown", "execution-unknown"} <= set(_fields(unit, "condition"))
        assert all(f["evidence"]["basis"] == "import-bound" and f["kind"] != "relation" for f in unit)


def test_parse_and_safe_parse_preserve_qualified_outcomes(pipeline):
    result = _result(pipeline[3], "validation.ts")
    uses = _units(result, "validation-contract", "validation-use")
    predicates = _units(result, "validation-contract", "validation-predicate")
    assert len(uses) == 2 and len(predicates) == 14
    for mode, condition, target in [("parse", "normal-validation-return", "return"), ("safeParse", "success-true", "return.data")]:
        unit = next(u for u in uses if _field(u, "mode") == mode)
        assert _field(unit, "return-target") == target
        assert condition in _fields(unit, "condition")
        assert "installed-version-not-captured" in _fields(unit, "condition")
        assert _field(unit, "predicate-count") == 7
        own_predicates = [u for u in predicates if _field(u, "call") == _field(unit, "call")]
        assert len(own_predicates) == 7
        assert sum(_fields(u, "metric") == ["utf16-length"] for u in own_predicates) == 2
    assert all(f["kind"] != "relation" for f in result["facts"] if f["evidence"]["pluginId"] == "validation-contract")


def test_elysia_and_trpc_bind_only_their_in_process_families(pipeline):
    result = _result(pipeline[3], "dispatch.ts")
    families = _units(result, "dispatch-binding", "dispatch-family")
    handlers = _units(result, "dispatch-binding", "dispatch-handler")
    calls = _units(result, "dispatch-binding", "dispatch-call")
    assert len(families) == 3 and len(handlers) == len(calls) == 4
    assert len({_field(u, "allocation") for u in families}) == 3
    for family in families:
        endpoints = [u for u in handlers + calls if _field(u, "declaration") == _field(family, "declaration")]
        assert len(endpoints) == _field(family, "endpoint-count")
        assert all(_field(u, "allocation") == _field(family, "allocation") for u in endpoints)
    for unit in families + handlers + calls:
        assert {"execution-not-observed", "potential-correspondence-only", "registered-at-dispatch-required"} <= set(_fields(unit, "condition"))
        assert all(f["kind"] != "relation" for f in unit)
    http_calls = [u for u in calls if _fields(u, "http-method")]
    assert len(http_calls) == 2
    assert all(_field(u, "path") == "/ready" and "url-origin-not-a-binding" in _fields(u, "condition") for u in http_calls)
    rpc_calls = [u for u in calls if _fields(u, "procedure-key")]
    assert len(rpc_calls) == 2
    assert all(not _fields(u, "procedure-kind") for u in rpc_calls)


@pytest.mark.parametrize("path,plugin", [
    ("lifetime.tsx", "fst-solid"), ("reactive.tsx", "solid"),
    ("controls.tsx", "fst-components"), ("implementation.ts", "implementation"),
    ("events.ts", "transport-binding"), ("validation.ts", "validation-contract"),
    ("dispatch.ts", "dispatch-binding"),
])
def test_queries_inspect_full_structured_facts_and_source_coverage(pipeline, path, plugin):
    graph = pipeline[3]
    result = _result(graph, path)
    source = _source_row(graph, path)
    assert source["sourceHash"] == result["sourceHash"]
    assert source["analysisSetId"] == result["analysisSetId"]
    assert source["coverage"]["reports"] == result["reports"]
    assert "not runtime" in source["coverage"]["scope"]
    declarations, facts = _inspect_all(graph, source["reference"])
    encoded = lambda rows: sorted(json.dumps(row, sort_keys=True) for row in rows)
    assert encoded(declarations.values()) == encoded(result["declarations"])
    assert encoded(facts.values()) == encoded(result["facts"])
    assert any(f["evidence"]["pluginId"] == plugin for f in facts.values())
    selected = next(d for d in result["declarations"] if any(f["subject"] == d["key"] and f["evidence"]["pluginId"] == plugin for f in result["facts"]))
    search = query_semantics(graph, path=path, plugin=plugin, symbol=selected["key"], max_bytes=128 * 1024)
    assert search["status"] == "ok" and search["total"] == 1
    assert search["matches"][0]["declaration"] == selected
    assert search["matches"][0]["sourceReference"] == source["reference"]
    inspected = inspect_semantics(graph, search["matches"][0]["reference"], max_bytes=128 * 1024, excerpt_bytes=64)
    assert inspected["status"] == "ok"
    assert inspected["unknowns"] and "not" in " ".join(inspected["unknowns"])


_ORIGIN_CASES = [
    ("fst-solid", "fst-solid.component", "component", "@fst/components-fst-solid/app/component",
     "const Panel = component(() => null);", "component = replacement;"),
    ("solid", "solid.signal-accessor", "createSignal", "solid-js",
     "const [read, write] = createSignal(0); read(); write(1);", "createSignal = replacement;"),
    ("fst-components", "fst-components.callback-contract", "TextBox", "@fst/components-fst-disco-ui",
     "const Panel = () => <TextBox onInput={next => consume(next)} />;", "TextBox = replacement;"),
    ("implementation", "implementation.config-read", "env", "node:process",
     "const value = env.REGION;", "env = replacement;"),
    ("transport-binding", "transport-binding.event-instance", "EventEmitter", "node:events",
     "const bus = new EventEmitter(); bus.on('ready', () => {}); bus.emit('ready');", "EventEmitter.prototype.on = replacement;"),
    ("validation-contract", "validation-contract.validation-use", "z", "zod",
     "function accept(input) { return z.object({ name: z.string() }).parse(input); }", "z.object = replacement;"),
    ("dispatch-binding", "dispatch-binding.dispatch-family", "Elysia", "elysia",
     "const app = new Elysia(); app.get('/ready', () => {}); app.handle(new Request('https://example.invalid/ready'));", "Elysia.prototype.handle = replacement;"),
]


@pytest.mark.parametrize("variant", ["foreign", "shadowed", "mutated"])
@pytest.mark.parametrize("plugin,term,name,module,body,mutation", _ORIGIN_CASES, ids=[row[0] for row in _ORIGIN_CASES])
def test_foreign_shadowed_and_mutated_bindings_are_not_framework_proof(tmp_path, variant, plugin, term, name, module, body, mutation):
    imported = "foreign-lookalike" if variant == "foreign" else module
    source = f"import {{ {name} }} from '{imported}';\n"
    if variant == "shadowed":
        source += f"function shadow({name}) {{ {body} }}"
    else:
        source += (mutation if variant == "mutated" else "") + body
    raw = _extract_sources(tmp_path, {"neutral.tsx": source})
    graph = _round_trip(build_from_json(raw, root=tmp_path), tmp_path / "graph.json")
    result = _result(graph, "neutral.tsx")
    assert not _facts(result, term), (variant, plugin, result)
    source_row = _source_row(graph, "neutral.tsx")
    assert any(r["pluginId"] == plugin for r in source_row["coverage"]["reports"])
    search = query_semantics(graph, term, path="neutral.tsx", plugin=plugin, max_bytes=128 * 1024)
    assert search["status"] == "ok" and search["matches"] == []


@pytest.mark.parametrize("source,plugin", [
    ("import {field} from '@fst/components-fst-solid/app/field'; function setup(undefined) { const local=field(''); local(undefined); }", "fst-solid"),
    ("import {z} from 'zod'; function accept(input) { const schema=z.object({name:z.string()}); return schema.safeParse(input); }", "validation-contract"),
    ("import {Elysia} from 'elysia'; const app=new Elysia(); app.get('/ready',()=>{}); app.use(plugin); app.handle(new Request('https://example.invalid/ready'));", "dispatch-binding"),
    ("import {initTRPC} from '@trpc/server'; const t=initTRPC.create(); const router=t.router({ready:t.procedure.input(schema).query(()=>{})}); const caller=router.createCaller({}); caller.ready();", "dispatch-binding"),
    ("fetch('/ready'); remote.get('/ready',()=>{}); rpc.send('ready');", "dispatch-binding"),
    ("import {EventEmitter} from 'node:events'; const bus=new EventEmitter(); bus.on('ready',()=>{}); bus.emit('ready'); unknown(bus);", "transport-binding"),
], ids=["shadowed-undefined", "stored-schema", "mounted-app", "rpc-middleware", "network-lookalikes", "escaped-emitter"])
def test_unsupported_shapes_do_not_promote_conditional_contracts(tmp_path, source, plugin):
    result = _result(build_from_json(_extract_sources(tmp_path, {"neutral.ts": source}), root=tmp_path), "neutral.ts")
    if plugin == "fst-solid":
        assert not {"read", "write-request"}.intersection(_values(result, "fst-solid.field-operation"))
    else:
        assert not [f for f in result["facts"] if f["evidence"]["pluginId"] == plugin]


def test_tree_syntax_error_is_retrievable_but_never_claimed_complete(tmp_path):
    source = "import {component} from '@fst/components-fst-solid/app/component'; const Panel=component(()=>null); const broken = ("
    graph = _round_trip(build_from_json(_extract_sources(tmp_path, {"broken.tsx": source}), root=tmp_path), tmp_path / "graph.json")
    result = _result(graph, "broken.tsx")
    assert result["state"] not in {"complete", "not-applicable"}
    assert result["facts"] == []
    row = _source_row(graph, "broken.tsx")
    assert row["coverage"]["complete"] is False
    assert row["coverage"]["effectiveState"] not in {"complete", "not-applicable"}
    assert row["coverage"]["diagnostics"] or any(r["diagnostics"] for r in row["coverage"]["reports"])


def test_unicode_bom_crlf_spans_and_snapshot_inspection(tmp_path, monkeypatch):
    source = (
        "\ufeff// \u4e2d\U0001f680\r\n"
        "import {component} from '@fst/components-fst-solid/app/component';\r\n"
        "export const Panel=component(()=> <div>\U0001f642</div>,{name:'\u00e9\U0001f642'});\r\n"
    )
    graph = _round_trip(build_from_json(_extract_sources(tmp_path, {"unicode.tsx": source}), root=tmp_path), tmp_path / "graph.json")
    result = _result(graph, "unicode.tsx")
    assert _values(result, "fst-solid.name", "Panel") == ["\u00e9\U0001f642"]
    renderer = _facts(result, "fst-solid.implemented-by", "Panel")[0]["target"]
    assert _text(source, renderer["span"]) == renderer["text"]
    (tmp_path / "unicode.tsx").unlink()

    def forbidden(*args, **kwargs):
        pytest.fail("Semantic reads must use persisted evidence, not source files or a subprocess")

    monkeypatch.setattr(Path, "read_text", forbidden)
    monkeypatch.setattr(Path, "read_bytes", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    reference = _source_row(graph, "unicode.tsx")["reference"]
    whole = inspect_semantics(graph, reference, max_bytes=128 * 1024, excerpt_bytes=len(source.encode("utf-8")))
    assert whole["status"] == "ok"
    assert whole["excerpt"]["text"] == source
    assert whole["excerpt"]["truncated"] is False
    page = inspect_semantics(graph, reference, max_bytes=128 * 1024, excerpt_bytes=7)
    excerpt = page["excerpt"]
    assert excerpt["truncated"] is True
    assert source.encode("utf-8")[excerpt["startByte"]:excerpt["endByte"]].decode("utf-8") == excerpt["text"]
    next_page = inspect_semantics(graph, reference, max_bytes=128 * 1024, excerpt_bytes=7, excerpt_start=excerpt["nextStartByte"])
    assert next_page["excerpt"]["startByte"] == excerpt["endByte"]


def test_application_source_and_model_calls_are_never_executed(tmp_path, monkeypatch):
    from graphify import llm

    def forbidden(*args, **kwargs):
        pytest.fail("Source-only semantic extraction must not call a model")

    monkeypatch.setattr(llm, "extract_files_direct", forbidden)
    marker = tmp_path / "application-ran.txt"
    source = (
        "import {writeFileSync} from 'node:fs';\n"
        f"writeFileSync({json.dumps(str(marker))}, 'must-not-run');\n"
        "throw new Error('application source executed');\n"
        "export function inert() { return 7; }\n"
    )
    raw = _extract_sources(tmp_path, {"inert.ts": source})
    result = _result(build_from_json(raw, root=tmp_path), "inert.ts")
    assert _facts(result, "implementation.return", "inert")
    assert not marker.exists()
    assert raw.get("input_tokens", 0) == raw.get("output_tokens", 0) == 0


def _capacity_source():
    long_name = "unabridged<&>-" + "source-qualified-" * 70
    source = "import {component} from '@fst/components-fst-solid/app/component';\n"
    source += "\n".join(
        f"export const Card{i}=component(()=>null,{{name:{json.dumps(long_name if i == 0 else f'card-{i}')}}});"
        for i in range(64)
    )
    return source, long_name


@pytest.fixture(scope="module")
def capacity(tmp_path_factory):
    root = tmp_path_factory.mktemp("framework-capacity")
    source, long_name = _capacity_source()
    raw = _extract_sources(root, {"capacity.tsx": source})
    graph = _round_trip(build_from_json(deepcopy(raw), root=root), root / "graph.json")
    result = _result(graph, "capacity.tsx")
    assert len(result["facts"]) > 50
    assert _values(result, "fst-solid.name", "Card0") == [long_name]
    assert len(long_name) > 512
    return root, raw, graph, long_name


@pytest.mark.parametrize("lane", ["undirected", "directed", "raw-merge"])
def test_full_build_raw_merge_export_reload_preserve_large_evidence(capacity, tmp_path, lane):
    _, raw, _, long_name = capacity
    original = deepcopy(raw["semantic_evidence"])
    first = build_from_json(deepcopy(raw), root=tmp_path, directed=lane == "directed")
    path = tmp_path / "graph.json"
    loaded = _round_trip(first, path)
    assert loaded.graph["semantic_evidence"] == original
    fresh = _extract_sources(tmp_path, {"added.ts": "export function added() { return 7; }"})
    if lane == "raw-merge":
        merged_raw = merge_raw_extraction(fresh, path, root=tmp_path, ast_sources=["added.ts"])
        assert merged_raw["semantic_evidence"]["documents"]["capacity.tsx"] == original["documents"]["capacity.tsx"]
        merged = build_from_json(merged_raw, root=tmp_path)
    else:
        merged = build_merge([fresh], path, root=tmp_path, ast_sources=["added.ts"])
    final = _round_trip(merged, tmp_path / "merged.json")
    assert final.graph["semantic_evidence"]["documents"]["capacity.tsx"] == original["documents"]["capacity.tsx"]
    result = _result(final, "capacity.tsx")
    assert len(result["facts"]) > 50
    assert _values(result, "fst-solid.name", "Card0") == [long_name]
    row = _source_row(final, "capacity.tsx")
    _, inspected = _inspect_all(final, row["reference"])
    assert len(inspected) == len(result["facts"])
    assert any(f.get("value", {}).get("value") == long_name for f in inspected.values())


def test_real_raw_cli_writer_preserves_large_evidence(tmp_path):
    source, long_name = _capacity_source()
    source_path = tmp_path / "capacity.tsx"
    source_path.write_text(source, encoding="utf-8")
    (tmp_path / "survivor.ts").write_text("export function survivor() { return 7; }", encoding="utf-8")
    output = tmp_path / "out" / "graphify-out" / "graph.json"
    env = {**os.environ, "GRAPHIFY_OUT": str(output.parent), "GRAPHIFY_MAX_WORKERS": "1",
           "GRAPHIFY_BACKEND": "none", "PYTHONIOENCODING": "utf-8"}

    def run_extract():
        run = subprocess.run(
            [sys.executable, "-m", "graphify", "extract", ".", "--code-only", "--no-cluster"],
            cwd=tmp_path, env=env, capture_output=True, text=True, encoding="utf-8", timeout=90,
        )
        assert run.returncode == 0, run.stdout + run.stderr
        saved = json.loads(output.read_text(encoding="utf-8"))
        assert "semantic_evidence" not in saved, "Persisted raw JSON has one metadata authority"
        return _read_graph(str(output))

    graph = run_extract()
    result = _result(graph, "capacity.tsx")
    assert len(result["facts"]) > 50
    assert _values(result, "fst-solid.name", "Card0") == [long_name]
    _, facts = _inspect_all(graph, _source_row(graph, "capacity.tsx")["reference"])
    assert len(facts) == len(result["facts"])
    old = query_semantics(graph, path="capacity.tsx", symbol="Card0", max_bytes=128 * 1024)["matches"][0]
    _, old_facts = _inspect_all(graph, old["reference"])
    survivor = _source_row(graph, "survivor.ts")

    # Exercise the real raw writer twice: a stale nested store must not compete
    # with the refreshed top-level extraction store during incremental merge.
    source_path.write_text(source.replace(long_name, long_name + "-updated"), encoding="utf-8")
    graph = run_extract()
    assert _values(_result(graph, "capacity.tsx"), "fst-solid.name", "Card0") == [long_name + "-updated"]
    for reference in [old["reference"], old["sourceReference"], *old_facts]:
        assert inspect_semantics(graph, reference)["status"] == "unsupported"
    current = _source_row(graph, "capacity.tsx")
    assert _source_row(graph, "survivor.ts")["reference"] == survivor["reference"]

    source_path.unlink()
    graph = run_extract()
    assert set(graph.graph["semantic_evidence"]["documents"]) == {"survivor.ts"}
    assert inspect_semantics(graph, current["reference"])["status"] == "unsupported"
    assert _source_row(graph, "survivor.ts")["reference"] == survivor["reference"]


def test_whole_json_query_budget_and_explicit_omissions(capacity):
    graph = capacity[2]
    budget = 8192
    cursor = None
    references, cursors = set(), set()
    total = None
    for _ in range(64):
        response = query_semantics(graph, path="capacity.tsx", limit=200, cursor=cursor, max_bytes=budget)
        encoded = response_json(response)
        assert len(encoded.encode("utf-8")) <= budget
        assert json.loads(encoded) == response
        assert response["status"] == "ok", response
        total = response["total"] if total is None else total
        assert total == response["total"]
        rows = response["matches"]
        assert rows, "A truncated page must advance rather than omit evidence silently"
        assert not references.intersection(row["reference"] for row in rows)
        references.update(row["reference"] for row in rows)
        if not response["truncated"]:
            assert response["continuation"] is None
            break
        assert len(references) < total
        cursor = response["continuation"]
        assert cursor and cursor not in cursors
        cursors.add(cursor)
    else:
        pytest.fail("Query continuation did not finish within 64 pages")
    assert len(references) == total and total > 50 and cursors
    tiny = query_semantics(graph, path="capacity.tsx", max_bytes=256)
    assert len(response_json(tiny).encode("utf-8")) <= 256
    assert tiny["status"] == "unsupported" and "budget" in tiny["reason"]
    source_ref = _source_row(graph, "capacity.tsx")["reference"]
    first = inspect_semantics(graph, source_ref, max_bytes=budget, excerpt_bytes=64)
    assert first["status"] == "ok" and first["truncated"] and first["continuation"]
    assert len(response_json(first).encode("utf-8")) <= budget
    second = inspect_semantics(graph, source_ref, max_bytes=budget, excerpt_bytes=64, cursor=first["continuation"])
    assert second["status"] == "ok" and len(response_json(second).encode("utf-8")) <= budget
    assert second["continuation"] != first["continuation"]
    oversized = inspect_semantics(graph, source_ref, max_bytes=256)
    assert oversized["status"] == "unsupported" and "budget" in oversized["reason"]
    assert len(response_json(oversized).encode("utf-8")) <= 256


@pytest.mark.parametrize("lane", ["build-merge", "raw-merge"])
def test_update_and_delete_invalidate_exact_refs_without_name_joining(tmp_path, lane):
    prefix = "import {component} from '@fst/components-fst-solid/app/component';\n"
    old = prefix + "export const Panel=component(()=>null,{name:'old'});"
    unrelated = prefix + "export const Panel=component(()=>null,{name:'other'});"
    raw = _extract_sources(tmp_path, {"alpha.tsx": old, "beta.tsx": unrelated})
    path = tmp_path / "graph.json"
    graph = _round_trip(build_from_json(raw, root=tmp_path), path)
    row = query_semantics(graph, path="alpha.tsx", symbol="Panel", max_bytes=128 * 1024)["matches"][0]
    _, old_facts = _inspect_all(graph, row["reference"])
    old_refs = [row["reference"], row["sourceReference"], *old_facts]
    other = _source_row(graph, "beta.tsx")
    old_cursor = query_semantics(graph, limit=1)["continuation"]
    updated_source = "// declaration name deliberately unchanged\n" + old.replace("name:'old'", "name:'new'")
    fresh = _extract_sources(tmp_path, {"alpha.tsx": updated_source})
    if lane == "raw-merge":
        graph = build_from_json(merge_raw_extraction(fresh, path, root=tmp_path, ast_sources=["alpha.tsx"]), root=tmp_path)
    else:
        graph = build_merge([fresh], path, root=tmp_path, ast_sources=["alpha.tsx"])
    graph = _round_trip(graph, path)
    assert _values(_result(graph, "alpha.tsx"), "fst-solid.name", "Panel") == ["new"]
    for reference in old_refs:
        answer = inspect_semantics(graph, reference)
        assert answer["status"] == "unsupported"
        assert answer["reason"] == "stale-or-unknown-evidence-reference"
    assert _source_row(graph, "beta.tsx")["reference"] == other["reference"]
    stale_page = query_semantics(graph, limit=1, cursor=old_cursor)
    assert stale_page["status"] == "unsupported" and stale_page["reason"] == "stale-or-invalid-continuation"
    current = query_semantics(graph, path="alpha.tsx", symbol="Panel", max_bytes=128 * 1024)["matches"][0]
    _, current_facts = _inspect_all(graph, current["reference"])
    deleted_refs = [current["reference"], current["sourceReference"], *current_facts]
    (tmp_path / "alpha.tsx").unlink()
    if lane == "raw-merge":
        pruned = merge_raw_extraction({"nodes": [], "edges": []}, path, root=tmp_path, prune_sources=[str(tmp_path / "alpha.tsx")])
        graph = build_from_json(pruned, root=tmp_path)
    else:
        graph = build_merge([], path, root=tmp_path, prune_sources=[str(tmp_path / "alpha.tsx")])
    graph = _round_trip(graph, path)
    assert set(graph.graph["semantic_evidence"]["documents"]) == {"beta.tsx"}
    assert query_semantics(graph, path="alpha.tsx")["matches"] == []
    for reference in deleted_refs:
        answer = inspect_semantics(graph, reference)
        assert answer["status"] == "unsupported" and answer["reason"] == "stale-or-unknown-evidence-reference"
    assert inspect_semantics(graph, other["reference"])["status"] == "ok"


def test_failed_replacement_does_not_present_previous_facts_as_current(tmp_path):
    original = "import {component} from '@fst/components-fst-solid/app/component'; export const Panel=component(()=>null);"
    path = tmp_path / "graph.json"
    graph = _round_trip(build_from_json(_extract_sources(tmp_path, {"view.tsx": original}), root=tmp_path), path)
    old = _source_row(graph, "view.tsx")
    broken = _extract_sources(tmp_path, {"view.tsx": original + " const unfinished = ("})
    graph = _round_trip(build_merge([broken], path, root=tmp_path, ast_sources=["view.tsx"]), path)
    current = _source_row(graph, "view.tsx")
    assert current["reference"] != old["reference"]
    assert current["coverage"]["complete"] is False
    assert current["coverage"]["effectiveState"] not in {"complete", "not-applicable"}
    assert inspect_semantics(graph, old["reference"])["status"] == "unsupported"
    _, facts = _inspect_all(graph, current["reference"])
    assert not facts
