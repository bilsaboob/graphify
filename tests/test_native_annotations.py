"""The native seam: shared parse and an independently registered rule module."""

from pathlib import Path
from types import ModuleType


def test_annotation_plugins_share_the_structural_parse_without_node(tmp_path, monkeypatch):
    from graphify import framework_analysis
    from graphify.extract import extract
    from graphify.extractors import engine
    from graphify.native_annotations import typescript

    path = tmp_path / "page.tsx"
    source = 'import { component } from "@fst/components-fst-solid/app/component";\r\nexport const Page = component(() => null);'
    path.write_bytes(source.encode())
    parsed, observed = [], []
    get_parser, make_view = engine._get_parser, typescript.TypeScriptView

    class Parser:
        def __init__(self, parser):
            self.parser = parser

        def parse(self, raw):
            tree = self.parser.parse(raw)
            parsed.append((raw, tree))
            return tree

    def view(raw, tree, **kwargs):
        observed.append((raw, tree))
        return make_view(raw, tree, **kwargs)

    def parser(*args):
        native, error = get_parser(*args)
        return Parser(native), error

    def no_worker(*args, **kwargs):
        raise AssertionError("Native extraction must not call the Node transport")

    monkeypatch.setattr(engine, "_get_parser", parser)
    monkeypatch.setattr(typescript, "TypeScriptView", view)
    monkeypatch.setattr(framework_analysis, "_run_worker", no_worker)
    result = extract([path], root=tmp_path, max_workers=1)
    assert len(parsed) == len(observed) == 1
    assert observed[0][1] is parsed[0][1]
    assert observed[0][0] == source.encode()
    entry = result["semantic_evidence"]["documents"]["page.tsx"]
    assert entry["source"] == source
    assert "fst-solid.component" in {fact["term"] for fact in entry["result"]["facts"]}


def test_independent_plugin_emits_through_the_same_registry(tmp_path, monkeypatch):
    from graphify import native_annotations
    from graphify.extract import extract
    from graphify.framework_evidence import validate_store

    plugin = ModuleType("example_annotations")
    plugin.__file__ = str(Path(__file__).resolve())
    setattr(plugin, "DESCRIPTOR", {"id": "example", "version": "1", "view": {"id": "typescript", "version": 1},
                         "languages": ["typescript", "tsx"],
                         "roles": [{"id": "example.function", "label": "Example Function",
                                    "description": "An exported function declaration."}],
                         "properties": [], "relations": []})

    def analyze(view, budget, emitter):
        for declaration in view.declarations:
            budget.step()
            if declaration["kind"] == "function" and declaration["exports"]:
                emitter.role(declaration["key"], "example.function", {
                    "ruleId": "example.export", "span": declaration["span"], "basis": "syntax",
                })
        return {"state": "complete", "diagnostics": []}

    setattr(plugin, "analyze", analyze)
    extra = ModuleType("another_annotations")
    extra.__file__ = str(Path(__file__).resolve())
    setattr(extra, "DESCRIPTOR", {**getattr(plugin, "DESCRIPTOR"), "id": "another", "roles": []})
    setattr(extra, "analyze", lambda view, budget, emitter: {"state": "not-applicable", "diagnostics": []})
    installed = native_annotations.plugins()
    monkeypatch.setattr(native_annotations, "plugins", lambda: tuple(sorted((*installed, plugin, extra), key=lambda item: item.DESCRIPTOR["id"])))
    path = tmp_path / "custom.ts"
    path.write_text("export function example() { return 1; }", encoding="utf-8")
    store = extract([path], root=tmp_path, max_workers=1)["semantic_evidence"]
    validate_store(store)
    facts = store["documents"]["custom.ts"]["result"]["facts"]
    assert any(fact["term"] == "example.function" and fact["evidence"]["pluginId"] == "example" for fact in facts)
