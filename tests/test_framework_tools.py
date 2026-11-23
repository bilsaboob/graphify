"""The semantic lane must be usable through actual CLI and MCP dispatch."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

from graphify.build import build_from_json
from graphify.export import to_json
from graphify.extract import extract
from graphify.serve import _build_server, _read_graph


SOURCE = '''import { component } from "@fst/components-fst-solid/app/component";
import { createSignal, onCleanup } from "solid-js";
export const View = component(() => {
    const [count, setCount] = createSignal(0);
    onCleanup(() => setCount(0));
    return <span>{count()}</span>;
});
'''


@pytest.fixture(scope="module")
def indexed(tmp_path_factory):
    root = tmp_path_factory.mktemp("framework tools")
    source = root / "view.tsx"
    source.write_text(SOURCE, encoding="utf-8", newline="")
    output = root / "graphify-out"
    output.mkdir()
    graph = build_from_json(extract([source], root=root, parallel=False), root=root)
    path = output / "graph.json"
    assert to_json(graph, {}, str(path), force=True)
    source.unlink()  # Reads must use the retained snapshot, not live files.
    return root, path


def cli(indexed, command, *arguments):
    root, path = indexed
    env = dict(os.environ, GRAPHIFY_BACKEND="none", GRAPHIFY_QUERY_LOG_DISABLE="1")
    return subprocess.run(
        [sys.executable, "-B", "-m", "graphify", command, *arguments, "--graph", str(path)],
        cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=60,
    )


def test_cli_search_and_inspect_retained_source(indexed):
    response = cli(indexed, "semantic-search", "--symbol", "View", "--max-bytes", "8192")
    assert response.returncode == 0, response.stderr
    assert len(response.stdout.encode("utf-8")) <= 8192
    result = json.loads(response.stdout)
    assert result["status"] == "ok" and len(result["matches"]) == 1
    reference = result["matches"][0]["reference"]
    inspected = cli(indexed, "semantic-inspect", reference, "--max-bytes", "16384")
    assert inspected.returncode == 0, inspected.stderr
    detail = json.loads(inspected.stdout)
    assert detail["status"] == "ok"
    assert detail["groups"] and "component" in detail["excerpt"]["text"]
    assert "untrusted-source-data" in inspected.stdout
    assert not (indexed[0] / "view.tsx").exists()


def test_cli_invalid_reference_and_arguments_fail_explicitly(indexed):
    stale = cli(indexed, "semantic-inspect", "gfe1:source:" + "0" * 64)
    assert stale.returncode == 4
    assert json.loads(stale.stdout)["status"] == "unsupported"
    invalid = cli(indexed, "semantic-search", "--max-bytes", "-1")
    assert invalid.returncode == 1 and "error:" in invalid.stderr
    unknown = cli(indexed, "semantic-search", "--invented-option")
    assert unknown.returncode == 2


def test_semantic_cli_never_refreshes_installed_skills(monkeypatch, capsys, indexed):
    from graphify import __main__ as main

    def forbidden(*args, **kwargs):
        raise AssertionError("A read-only semantic lookup tried to modify installed skills")

    monkeypatch.setattr(main, "_refresh_stale_skills", forbidden)
    monkeypatch.setattr(main, "_refresh_v1_opencode_plugins", forbidden)
    monkeypatch.setattr(main, "_check_skill_version", forbidden)
    monkeypatch.setattr(sys, "argv", ["graphify", "semantic-search", "--graph", str(indexed[1]), "--symbol", "View"])
    main._run_cli()
    assert json.loads(capsys.readouterr().out)["status"] == "ok"


def server_callbacks(monkeypatch, graph):
    import mcp.server

    class Server:
        def __init__(self, name, **callbacks):
            self.callbacks = callbacks

    monkeypatch.setattr(mcp.server, "Server", Server)
    return _build_server(str(graph)).callbacks


def call(callbacks, name, arguments):
    result = asyncio.run(callbacks["on_call_tool"](None, SimpleNamespace(name=name, arguments=arguments)))
    text = "".join(content.text for content in result.content)
    return result, text


def test_mcp_advertises_and_executes_semantic_operations(monkeypatch, indexed):
    callbacks = server_callbacks(monkeypatch, indexed[1])
    listed = asyncio.run(callbacks["on_list_tools"](None, None))
    tools = {tool.name: tool for tool in listed.tools}
    assert {"query_semantics", "inspect_semantics"} <= tools.keys()
    schema = getattr(tools["inspect_semantics"], "input_schema", None)
    if schema is None:
        schema = tools["inspect_semantics"].inputSchema
    assert schema["required"] == ["reference"]
    assert schema["additionalProperties"] is False
    assert "project_path" in schema["properties"]
    _, text = call(callbacks, "query_semantics", {"symbol": "View", "max_bytes": 8192})
    assert len(text.encode("utf-8")) <= 8192
    reference = json.loads(text)["matches"][0]["reference"]
    _, detail = call(callbacks, "inspect_semantics", {"reference": reference, "max_bytes": 16384})
    assert len(detail.encode("utf-8")) <= 16384
    assert json.loads(detail)["groups"]
    assert not (indexed[0] / "view.tsx").exists()


@pytest.mark.parametrize("name,arguments", [
    ("query_semantics", {"max_bytes": True}),
    ("query_semantics", {"path": "../outside.ts"}),
    ("query_semantics", {"invented": True}),
    ("inspect_semantics", {}),
    ("inspect_semantics", {"reference": "gfe1:source:" + "0" * 64, "excerpt_bytes": 0}),
])
def test_mcp_invalid_semantic_requests_are_tool_errors(monkeypatch, indexed, name, arguments):
    result, text = call(server_callbacks(monkeypatch, indexed[1]), name, arguments)
    assert getattr(result, "is_error", getattr(result, "isError", False))
    assert "Error" in text or "Unknown" in text


def test_corrupt_evidence_is_not_silently_ignored(indexed, tmp_path):
    data = json.loads(indexed[1].read_text(encoding="utf-8"))
    data["graph"]["semantic_evidence"]["documents"]["view.tsx"]["source"] += "changed"
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(RuntimeError, match="Invalid framework evidence"):
        _read_graph(str(path))


@pytest.mark.parametrize("cache_name", ["arbitrary-artifacts", "graphify-out", ".cache"])
def test_external_cache_is_not_a_source_root(tmp_path, cache_name):
    source = tmp_path / "view.tsx"
    source.write_text(SOURCE, encoding="utf-8", newline="")
    result = extract([source], cache_root=tmp_path / cache_name, parallel=False)
    assert set(result["semantic_evidence"]["documents"]) == {"view.tsx"}
    assert result["semantic_evidence"]["documents"]["view.tsx"]["source"] == SOURCE
