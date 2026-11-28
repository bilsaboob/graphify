"""Provider-free worker protocol, snapshot security and incremental fixtures."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from graphify import worker


def _sha(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def job(tmp_path):
    counter = 0

    def make(contents, previous=None, **overrides):
        nonlocal counter
        counter += 1
        root = tmp_path / f"job-{counter}"
        snapshot, output, cache = (root / name for name in ("input", "output", "cache"))
        for path in (snapshot, output, cache):
            path.mkdir(parents=True)
        files = []
        for relative, content in contents.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            path = snapshot / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            kind = "code" if path.suffix in {".ts", ".tsx"} else "document" if path.suffix == ".md" else "control"
            files.append({"path": relative, "sha256": _sha(data), "bytes": len(data), "kind": kind})
        request = {"version": 1, "jobId": f"job-{counter}", "projectId": "project-a", "rootId": "root-a",
                   "rootIdentity": "volume-file-identity", "sourceRoot": str(tmp_path / "logical-project"),
                   "inputRoot": str(snapshot), "outputDir": str(output), "cacheDir": str(cache),
                   "bundleDigest": "1" * 64, "policyDigest": "2" * 64,
                   "inputDigest": worker.input_digest(files), "files": files}
        if previous is not None:
            old_request, old_result = previous
            request["previous"] = {"graphPath": str(Path(old_request["outputDir"]) / old_result["graph"]["path"]),
                                   "manifestPath": str(Path(old_request["outputDir"]) / old_result["manifest"]["path"]),
                                   "graphSha256": old_result["graph"]["sha256"],
                                   "manifestSha256": old_result["manifest"]["sha256"]}
        request.update(overrides)
        return request
    return make


def _run(request, expected="candidate_ready"):
    result = worker.run_request(request)
    assert result["status"] == expected, result
    return result


def _artifacts(request, result):
    output = Path(request["outputDir"])
    for name in ("graph", "manifest"):
        descriptor = result[name]
        data = (output / descriptor["path"]).read_bytes()
        assert len(data) == descriptor["bytes"] and _sha(data) == descriptor["sha256"]
    return json.loads((output / "graph.json").read_bytes()), json.loads((output / "manifest.json").read_bytes())


def test_cold_and_strict_unchanged(job, monkeypatch):
    source = {"src/value.ts": "export function value() { return 1; }\n"}
    first = job(source)
    ready = _run(first)
    graph, manifest = _artifacts(first, ready)
    assert graph["nodes"] and graph["graph"]["semantic_evidence"]["documents"]["src/value.ts"]
    assert manifest["complete"] and manifest["files"][0]["sha256"] == _sha(source["src/value.ts"].encode())
    second = job(source, (first, ready))
    import graphify.extract
    monkeypatch.setattr(graphify.extract, "extract", lambda *a, **k: pytest.fail("No-op reparsed sources"))
    unchanged = _run(second, "verified_unchanged")
    assert unchanged["coverage"]["selected"] == 0 and unchanged["coverage"]["reused"] == 1
    assert unchanged["graph"] == ready["graph"]
    assert not (Path(second["outputDir"]) / "current.json").exists()


def test_edit_add_rename_delete_and_last_file(job):
    first = job({"a.ts": "export function before() {}"})
    prior = (first, _run(first))
    for contents, wanted, absent in [
        ({"a.ts": "export function after() {}"}, "after", "before"),
        ({"a.ts": "export function after() {}", "b.ts": "export const newValue = 2;"}, "newValue", "before"),
        ({"renamed.ts": "export const newValue = 2;"}, "newValue", "after"),
        ({}, None, "newValue"),
    ]:
        request = job(contents, prior)
        result = _run(request)
        graph, manifest = _artifacts(request, result)
        labels = [node.get("label", "") for node in graph["nodes"]]
        assert not any(absent in label for label in labels)
        if wanted:
            assert any(wanted in label for label in labels)
        else:
            assert graph["nodes"] == graph["links"] == graph["hyperedges"] == []
            assert manifest["files"] == [] and manifest["complete"]
        prior = (request, result)


def test_empty_cold_and_unchanged(job):
    request = job({})
    ready = _run(request)
    assert ready["coverage"]["total"] == 0 and ready["coverage"]["structuralComplete"]
    _run(job({}, (request, ready)), "verified_unchanged")


def test_empty_typescript_and_external_stub_last_deletion(job):
    request = job({"empty.ts": "", "page.tsx": 'import {component} from "@fst/components-fst-solid/app/component"; export const Page = component(() => null);'})
    ready = _run(request)
    graph, _ = _artifacts(request, ready)
    documents = graph["graph"]["semantic_evidence"]["documents"]
    assert set(documents) == {"empty.ts", "page.tsx"}
    assert any(f["term"] == "fst-solid.component" for f in documents["page.tsx"]["result"]["facts"])
    empty = job({}, (request, ready))
    graph, _ = _artifacts(empty, _run(empty))
    assert graph["nodes"] == graph["links"] == []


@pytest.mark.parametrize("specifier,resolved", [
    ("@diagnostic/example-plugin", False),
    ("./not-created.js", False),
    ("@local/not-created", False),
    ("./local", True),
])
def test_rescued_dynamic_imports_preserve_reference_ownership(job, specifier, resolved):
    source = {
        "a.ts": (f"export async function first() {{ return import('{specifier}'); }}\n"
                 f"export async function again() {{ return import('{specifier}'); }}\n"),
        "b.ts": f"export async function second() {{ return import('{specifier}'); }}\n",
        "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@local/*":["lib/*"]}}}',
    }
    if resolved:
        source["local.ts"] = "export const value = 1;\n"
    request = job(source)
    ready = _run(request)
    graph, _ = _artifacts(request, ready)
    nodes = {node["id"]: node for node in graph["nodes"]}
    edges = [edge for edge in graph["links"] if edge["relation"] == "dynamic_import"]
    assert len(edges) == 2
    assert {edge["source_file"] for edge in edges} == {"a.ts", "b.ts"}
    targets = {edge["target"] for edge in edges}
    assert len(targets) == 1
    target = nodes[targets.pop()]
    if resolved:
        assert target["source_file"] == "local.ts" and not target.get("external")
    else:
        assert target["source_file"] == ""
        assert target["external"] is True and target["type"] == "external"
        assert target["file_type"] == "concept"
    assert all(not node.get("source_file") or node["source_file"] in source for node in nodes.values())
    other = job(source)
    assert _artifacts(other, _run(other))[0] == graph
    deleted = job({}, (request, ready))
    empty, _ = _artifacts(deleted, _run(deleted))
    assert empty["nodes"] == empty["links"] == []


def test_markdown_spans_and_snapshot_independent_ids(job):
    contents = {"src/value.ts": "export function getValue() { return 1; }\n",
                "docs/guide.md": "---\ntitle: Guide\n---\n# Usage\nUse `getValue()`.\n```ts\ngetValue();\n```\n"}
    request = job(contents)
    result = _run(request)
    graph, _ = _artifacts(request, result)
    example = next(node for node in graph["nodes"] if node.get("node_kind") == "code_example")
    assert example["source_location"] == "L6"
    assert (example["attributes"]["start_line"], example["attributes"]["end_line"]) == (6, 8)
    assert any(edge["source"] == example["id"] and edge["relation"] == "references" for edge in graph["links"])
    second = job(contents)
    again = _run(second)
    other, _ = _artifacts(second, again)
    assert graph == other
    serialized = json.dumps(graph)
    assert request["inputRoot"] not in serialized and "job-1" not in serialized
    contents["docs/guide.md"] = "---\ntitle: Longer\nother: true\n---\n# Usage\n```ts\ngetValue();\n```\n"
    edited = job(contents, (request, result))
    updated = _run(edited)
    assert updated["coverage"]["selected"] == updated["coverage"]["reused"] == 1
    graph, _ = _artifacts(edited, updated)
    assert next(n for n in graph["nodes"] if n.get("node_kind") == "heading")["source_location"] == "L5"


def test_incremental_cross_file_context_and_inbound_refresh(job):
    contents = {"callee.ts": "export function target() { return 1; }",
                "caller.ts": 'import { target } from "./callee"; export function caller() { return target(); }',
                "unrelated.ts": "export function unrelated() {}"}
    first = job(contents)
    result = _run(first)
    contents["caller.ts"] = 'import { target } from "./callee"; export function caller() { return target() + 2; }'
    second = job(contents, (first, result))
    result2 = _run(second)
    graph, _ = _artifacts(second, result2)
    assert result2["coverage"]["selected"] == 1 and result2["coverage"]["reused"] == 2
    by_id = {n["id"]: n for n in graph["nodes"]}
    assert any(e["relation"] == "calls" and by_id[e["source"]].get("source_file") == "caller.ts"
               and by_id[e["target"]].get("source_file") == "callee.ts" for e in graph["links"])
    contents["callee.ts"] = "export function changed() {}"
    third = job(contents, (second, result2))
    result3 = _run(third)
    assert result3["coverage"]["selected"] == 3
    graph, _ = _artifacts(third, result3)
    assert not any(n.get("label") == "target" for n in graph["nodes"])


@pytest.mark.parametrize("field", ["bundleDigest", "policyDigest"])
def test_configuration_fingerprints_invalidate_reuse(job, field):
    contents = {"a.ts": "export const value = 1;"}
    first = job(contents)
    ready = _run(first)
    request = job(contents, (first, ready), **{field: "3" * 64})
    assert _run(request)["coverage"]["selected"] == 1


def test_admitted_configuration_and_changed_control(job):
    contents = {"tsconfig.json": '{"compilerOptions":{"paths":{"@lib/*":["lib/*"]}}}',
                "lib/a.ts": "export function target() {}",
                "caller.ts": 'import {target} from "@lib/a"; export function run() { target(); }'}
    first = job(contents)
    ready = _run(first)
    assert ready["coverage"]["controls"] == 1
    graph, _ = _artifacts(first, ready)
    assert any(e["relation"] == "calls" for e in graph["links"])
    contents["tsconfig.json"] = '{"compilerOptions":{"paths":{"@lib/*":["missing/*"]}}}'
    second = job(contents, (first, ready))
    assert _run(second)["coverage"]["selected"] == 2


@pytest.mark.parametrize("damage", ["hash", "json", "nodes", "evidence", "complete", "ownership", "identity"])
def test_corrupt_previous_never_unchanged(job, damage):
    contents = {"a.ts": "export function value() {}"}
    first = job(contents)
    ready = _run(first)
    graph, manifest = _artifacts(first, ready)
    if damage == "json":
        data = b"{"
    else:
        if damage == "nodes":
            graph["nodes"] = []
        elif damage == "evidence":
            graph["graph"].pop("semantic_evidence")
        elif damage == "ownership":
            graph["nodes"][0]["source_file"] = "../outside.ts"
        elif damage == "identity":
            graph["graph"]["worker"]["rootId"] = "wrong-root"
        data = worker._json_bytes(graph)
        if damage == "hash":
            data += b" "
    if damage == "complete":
        manifest["complete"] = False
    path = Path(first["outputDir"]) / "graph.json"
    path.write_bytes(data)
    if damage != "hash":
        ready["graph"] = worker._descriptor("graph.json", data)
        manifest["graph"] = ready["graph"]
        raw = worker._json_bytes(manifest)
        (path.parent / "manifest.json").write_bytes(raw)
        ready["manifest"] = worker._descriptor("manifest.json", raw)
    result = _run(job(contents, (first, ready)), "blocked")
    assert result["error"]["code"] == "previous_invalid"


def test_partial_parser_failure_not_clean_and_keeps_last_good(job, monkeypatch):
    import graphify.extract
    contents = {"a.ts": "export function before() {}"}
    first = job(contents)
    ready = _run(first)
    original = graphify.extract.extract

    def failed(paths, **kwargs):
        return {"nodes": [], "edges": [], "failed_sources": [str(p) for p in paths], "extracted_sources": []}

    monkeypatch.setattr(graphify.extract, "extract", failed)
    contents["a.ts"] = "export function after() {}"
    second = job(contents, (first, ready))
    partial = _run(second, "partial")
    graph, manifest = _artifacts(second, partial)
    assert any("before" in n["label"] for n in graph["nodes"])
    assert not manifest["complete"] and manifest["files"][0]["structuralState"] == "failed"
    monkeypatch.setattr(graphify.extract, "extract", original)
    third = job(contents, (second, partial))
    assert _run(third)["coverage"]["selected"] == 1


def test_absent_native_evidence_is_not_complete(job, monkeypatch):
    import graphify.extract
    original = graphify.extract.extract

    def no_evidence(*args, **kwargs):
        result = original(*args, **kwargs)
        result.pop("semantic_evidence", None)
        return result

    monkeypatch.setattr(graphify.extract, "extract", no_evidence)
    result = _run(job({"a.ts": "export const n = 1;"}), "partial")
    assert result["coverage"]["nativeMissing"] == 1 and result["coverage"]["structuralComplete"]


def test_native_analysis_diagnostics_stay_partial(job):
    request = job({"broken.ts": "export function broken( {"})
    partial = _run(request, "partial")
    graph, manifest = _artifacts(request, partial)
    assert partial["coverage"]["structuralComplete"] and partial["coverage"]["nativePartial"] == 1
    assert graph["graph"]["semantic_evidence"]["documents"]["broken.ts"]["result"]["diagnostics"]
    assert not manifest["complete"]
    result = _run(job({"broken.ts": "export function broken( {"}, (request, partial)), "partial")
    assert result["coverage"]["selected"] == 1


def test_redacted_native_hash_binds_exact_admitted_source(job):
    fake = "ghp_" + "a" * 36
    contents = {"a.ts": f'export const credential = "{fake}";\r\nexport const value = 1;\r\n'}
    first = job(contents)
    result = _run(first)
    graph, manifest = _artifacts(first, result)
    entry = graph["graph"]["semantic_evidence"]["documents"]["a.ts"]
    assert entry["redaction"]["originalSourceHash"] == manifest["files"][0]["sha256"]
    assert fake not in json.dumps(graph)
    _run(job(contents, (first, result)), "verified_unchanged")


def test_code_change_rebinds_unchanged_document_hints(job):
    contents = {"a.ts": "export function target() {}", "guide.md": "# Guide\n`target()`\n"}
    first = job(contents)
    result = _run(first)
    contents["a.ts"] = "export function renamed() {}"
    second = job(contents, (first, result))
    updated = _run(second)
    graph, _ = _artifacts(second, updated)
    assert updated["coverage"]["reused"] == 1
    assert not any(n.get("label") == "target" for n in graph["nodes"])
    heading = next(n for n in graph["nodes"] if n.get("node_kind") == "heading")
    assert heading["attributes"]["code_resolution"]["unresolved"] == 1


def test_worker_uses_no_cli_detector_model_or_node(job, monkeypatch):
    import graphify.detect
    import graphify.framework_analysis

    def prohibited(*args, **kwargs):
        pytest.fail("Worker called an ambient detector or Node analyzer")

    monkeypatch.setattr(graphify.detect, "detect", prohibited)
    monkeypatch.setattr(graphify.framework_analysis, "_run_worker", prohibited)
    request = job({"a.tsx": "export const View = () => <div />;", "guide.md": "# Guide"})
    _run(request)


def test_capabilities_rejects_external_plugins_before_loading(monkeypatch):
    import importlib.metadata
    import graphify.native_annotations

    monkeypatch.setattr(importlib.metadata, "entry_points", lambda **kwargs: [object()])
    monkeypatch.setattr(graphify.native_annotations, "plugins", lambda: pytest.fail("External plugins were loaded"))
    with pytest.raises(worker.WorkerError, match="does not load"):
        worker.capabilities()


def test_missing_extraction_provenance_never_clean(job, monkeypatch):
    import graphify.extract
    original = graphify.extract.extract

    def missing(*args, **kwargs):
        result = original(*args, **kwargs)
        result.pop("extracted_sources")
        return result

    monkeypatch.setattr(graphify.extract, "extract", missing)
    result = _run(job({"guide.md": "# Guide"}), "failed")
    assert result["error"]["code"] == "extraction_invalid"


def test_snapshot_hash_mismatch_and_extra_files(job):
    first = job({"a.ts": "export const n = 1;"})
    (Path(first["inputRoot"]) / "a.ts").write_text("export const n = 2;")
    assert _run(first, "blocked")["error"]["code"] == "snapshot_hash_mismatch"
    second = job({})
    (Path(second["inputRoot"]) / "unlisted.ts").write_text("export const n = 1;")
    assert _run(second, "blocked")["error"]["code"] == "snapshot_inventory_mismatch"


def test_snapshot_change_after_parsing_cannot_stamp_new_bytes(job, monkeypatch):
    original = worker._snapshot
    request = job({"guide.md": "# Before"})
    count = 0

    def mutate(root, files):
        nonlocal count
        count += 1
        if count == 2:
            (root / "guide.md").write_text("# After!")
        return original(root, files)

    monkeypatch.setattr(worker, "_snapshot", mutate)
    result = _run(request, "blocked")
    assert result["error"]["code"] == "snapshot_hash_mismatch"
    assert list(Path(request["outputDir"]).iterdir()) == []


def test_admitted_bytes_remain_frozen_and_ambient_io_is_blocked(job):
    from graphify.input_snapshot import admitted_snapshot, read_source_text
    request = job({"guide.md": "# Admitted"})
    root, cache = Path(request["inputRoot"]), Path(request["cacheDir"])
    snapshot = worker._snapshot(root, request["files"])
    (root / "guide.md").write_text("# Changed!")
    with admitted_snapshot(root, snapshot, cache):
        assert read_source_text(root / "guide.md") == "# Admitted"
        with pytest.raises(PermissionError):
            (root.parent / "not-admitted.txt").read_bytes()
        with pytest.raises(PermissionError):
            (root / "guide.md").write_text("not permitted")
        with pytest.raises(PermissionError):
            subprocess.run([sys.executable, "-c", "pass"])
        import socket
        with pytest.raises(PermissionError):
            socket.socket()


@pytest.mark.parametrize("path", ["../a.ts", "/a.ts", "C:/a.ts", "a\\b.ts", "a/./b.ts", "a//b.ts", "CON.ts", "a.ts:stream", "a.ts\n",
                                  "COM\u00b9.ts", "LPT\u00b2.ts", "COM\u00b3.ts", "NUL .ts", "con .md", "CONIN$.ts", "conout$.md"])
def test_rejects_invalid_inventory_paths(job, path):
    request = job({})
    request["files"] = [{"path": path, "bytes": 0, "sha256": _sha(b""), "kind": "code"}]
    request["inputDigest"] = worker.input_digest(request["files"])
    assert _run(request, "blocked")["error"]["code"] == "invalid_inventory"


def test_rejects_hardlinks_and_directory_overlap(job, tmp_path):
    request = job({"a.ts": "export const n = 1;"})
    source = Path(request["inputRoot"]) / "a.ts"
    os.link(source, tmp_path / "alias.ts")
    assert _run(request, "blocked")["error"]["code"] == "unsafe_snapshot"
    request = job({})
    request["outputDir"] = request["inputRoot"]
    assert _run(request, "blocked")["error"]["code"] == "unsafe_path"


def test_rejects_hardlinked_cache_and_prepopulated_output(job, tmp_path):
    request = job({})
    outside = tmp_path / "outside.txt"
    outside.write_text("not a cache")
    os.link(outside, Path(request["cacheDir"]) / "linked.txt")
    assert _run(request, "blocked")["error"]["code"] == "unsafe_cache"
    request = job({})
    (Path(request["outputDir"]) / "current.json").write_text("preserve me")
    assert _run(request, "blocked")["error"]["code"] == "output_not_empty"


@pytest.mark.parametrize("configuration", ['{"compilerOptions":false}', '{"bad":}', '{"a":1,"a":2}'])
def test_invalid_controls_are_blocked(job, configuration):
    result = _run(job({"tsconfig.json": configuration, "a.ts": "export const x = 1;"}), "blocked")
    assert result["error"]["code"] == "invalid_configuration"


def test_out_of_root_config_and_markdown_targets_do_not_probe_original(job, monkeypatch):
    request = job({"tsconfig.json": '{"extends":"../outside.json","references":[{"path":"../other"}]}',
                   "a.ts": 'import {foo} from "../outside"; export const x = 1;',
                   "guide.md": "# Guide\n[secret](../outside.md)\n[[../outside.md]]\n[encoded](../outside%20secret.md)"})
    parent = Path(request["inputRoot"]).parent
    original_stat = Path.stat

    def checked(path, *args, **kwargs):
        if path.parent == parent and path.name.startswith(("outside", "other")):
            pytest.fail("Unadmitted original/parent path was probed")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", checked)
    _run(request)


def test_snapshot_boundary_never_reads_parent_config_or_original(job, monkeypatch, tmp_path):
    contents = {"a.ts": 'import {secret} from "../private"; export const value = 1;'}
    request = job(contents)
    original = Path(request["sourceRoot"])
    original.mkdir()
    (original / "a.ts").write_text("throw new Error('not admitted');")
    (Path(request["inputRoot"]).parent / "package.json").write_text('{"workspaces":["../*"]}')
    (Path(request["inputRoot"]).parent / "tsconfig.json").write_text('{"extends":"private.json"}')
    (Path(request["inputRoot"]).parent / "private.ts").write_text("export function secret() {}")
    result = _run(request)
    graph, _ = _artifacts(request, result)
    assert not any(n.get("label") == "secret" for n in graph["nodes"])


def test_worker_cli_json_only_and_capabilities(tmp_path, job):
    environment = {**os.environ, "GRAPHIFY_BACKEND": "disabled", "GRAPHIFY_MAX_WORKERS": "99"}
    capabilities = subprocess.run([sys.executable, "-B", "-m", "graphify.worker", "--capabilities"],
                                  capture_output=True, text=True, env=environment, check=True)
    assert json.loads(capabilities.stdout)["providerFree"] is True
    request = job({"guide.md": "# Provider-free\n```ts\nconst a = 1;\n```\n"})
    request_path = tmp_path / "request.json"
    request_path.write_bytes(worker._json_bytes(request))
    completed = subprocess.run([sys.executable, "-B", "-m", "graphify.worker", "--request", str(request_path)],
                               capture_output=True, text=True, env=environment)
    assert completed.returncode == 0, completed.stderr + completed.stdout
    assert len(completed.stdout.splitlines()) == 1
    assert json.loads(completed.stdout)["status"] == "candidate_ready"


@pytest.mark.parametrize("arguments", [[], ["--unknown"], ["--request"], ["--capabilities", "--request", "x"]])
def test_worker_invalid_arguments_are_machine_results(arguments, capsys):
    assert worker.main(arguments) == 3
    output = capsys.readouterr()
    result = json.loads(output.out)
    assert result["status"] == "blocked" and result["error"]["code"] == "invalid_arguments"
    assert result["coverage"]["structuralComplete"] is False


@pytest.mark.parametrize("raw", [b'{"version":1,"version":1}', b'{"x":NaN}', b'\xff'])
def test_worker_rejects_non_strict_request_json(tmp_path, raw, capsys):
    path = tmp_path / "request.json"
    path.write_bytes(raw)
    assert worker.main(["--request", str(path)]) == 3
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "invalid_json"


def test_input_digest_exact_cross_language_vector():
    files = [{"path": "b.ts", "bytes": 3, "sha256": "b" * 64, "kind": "code"},
             {"path": "a.md", "bytes": 0, "sha256": "a" * 64, "kind": "document"}]
    assert worker.input_digest(files) == _sha(("a.md\0" + "a" * 64 + "\x000\x00document\n"
                                              + "b.ts\0" + "b" * 64 + "\x003\x00code\n").encode())
    assert worker.input_digest([]) == _sha(b"")


def _progress_records(text):
    return [json.loads(line[len(worker.PROGRESS_PREFIX):]) for line in text.splitlines()
            if line.startswith(worker.PROGRESS_PREFIX)]


def test_progress_is_separate_bounded_and_redacts_parser_diagnostics(job, tmp_path, monkeypatch, capsys):
    import graphify.extract
    original = graphify.extract.extract
    request = job({"a.ts": "export const value = 1;"})
    secret = "ghp_" + "b" * 36

    def noisy(*args, **kwargs):
        print(request["inputRoot"], secret, "export const privateSource = 123;")
        print(request["sourceRoot"], file=sys.stderr)
        return original(*args, **kwargs)

    monkeypatch.setattr(graphify.extract, "extract", noisy)
    path = tmp_path / "progress-request.json"
    path.write_bytes(worker._json_bytes(request))
    assert worker.main(["--request", str(path)]) == 0
    output = capsys.readouterr()
    assert len(output.out.splitlines()) == 1
    assert json.loads(output.out)["status"] == "candidate_ready"
    records = _progress_records(output.err)
    assert [r["phase"] for r in records] == ["snapshot", "extract", "file_started", "file_completed", "merge", "validate", "candidate"]
    assert all(r["version"] == 1 and r["jobId"] == request["jobId"] for r in records)
    assert records[2]["completed"] == 0 and records[3]["completed"] == 1
    assert records[2]["path"] == records[3]["path"] == "a.ts"
    assert records[3]["state"] == records[3]["native"] == "complete"
    assert [r["completed"] for r in records[3:]] == [1, 1, 1, 1]
    assert len(output.err.encode()) <= worker.MAX_PROGRESS_BYTES + 128
    for private in (request["inputRoot"], request["sourceRoot"], secret, "privateSource"):
        assert private not in output.err
    assert output.err.count("GRAPHIFY_DIAGNOSTIC_V1") == 1


def test_unchanged_progress_has_reuse_without_fake_parsing(job):
    first = job({"guide.md": "# Guide"})
    ready = _run(first)
    request = job({"guide.md": "# Guide"}, (first, ready))
    stream = io.StringIO()
    result = worker.run_request(request, progress=worker._Progress(stream, request["jobId"]))
    assert result["status"] == "verified_unchanged"
    records = _progress_records(stream.getvalue())
    assert [r["phase"] for r in records] == ["snapshot", "reuse", "file_reused", "validate", "candidate"]
    assert records[2]["reused"] == 1 and records[2]["path"] == "guide.md"
    assert records[2]["state"] == "reused"
    assert all(r["selected"] == r["completed"] == 0 for r in records)


def test_invalid_extraction_never_reports_candidate_or_completed(job, monkeypatch):
    import graphify.extract
    monkeypatch.setattr(graphify.extract, "extract", lambda *a, **k: {"nodes": [], "edges": []})
    request = job({"guide.md": "# Guide"})
    stream = io.StringIO()
    result = worker.run_request(request, progress=worker._Progress(stream, request["jobId"]))
    assert result["status"] == "failed"
    records = _progress_records(stream.getvalue())
    assert all(r["completed"] == 0 and r["phase"] != "candidate" for r in records)


def test_progress_budget_and_invalid_envelopes():
    stream = io.StringIO()
    progress = worker._Progress(stream, "safe-job")
    progress.emit("source code or private path")
    progress.emit("extract", total=1, selected=2)
    progress.emit("merge", total=1, selected=1, completed=True)
    assert stream.getvalue() == ""
    for _ in range(worker.MAX_PROGRESS_EVENTS + 10):
        progress.emit("extract", total=10000, selected=10000)
    assert len(stream.getvalue()) <= worker.MAX_PROGRESS_BYTES
    assert len(stream.getvalue().splitlines()) <= worker.MAX_PROGRESS_EVENTS
    assert sum(r["phase"] == "gap" for r in _progress_records(stream.getvalue())) == 1
    private = io.StringIO()
    worker._Progress(private, "C:/private/job").emit("extract")
    assert private.getvalue() == ""
    diagnostics = worker._Diagnostics(private)
    diagnostics.write("private secret source\n" * 100000)
    diagnostics.write("second secret")
    assert private.getvalue() == "GRAPHIFY_DIAGNOSTIC_V1 Diagnostic output withheld for privacy.\n"


def test_unavailable_progress_channel_does_not_fail_worker(job):
    class Broken(io.StringIO):
        def write(self, text):
            raise BrokenPipeError("private path")

        def flush(self):
            raise BrokenPipeError("private path")

    stream = Broken()
    diagnostics = worker._Diagnostics(stream)
    diagnostics.write("private source")
    diagnostics.flush()
    request = job({"guide.md": "# Guide"})
    assert worker.run_request(request, progress=worker._Progress(stream, request["jobId"]))["status"] == "candidate_ready"


def test_progress_budget_covers_ten_thousand_sources():
    stream = io.StringIO()
    progress = worker._Progress(stream, "capacity")
    for i in range(10000):
        progress.emit("file_started", total=10000, selected=10000, completed=i,
                      path=f"src/source-{i}.ts", state="processing", pass_id=1)
        progress.emit("file_completed", total=10000, selected=10000, completed=i + 1,
                      path=f"src/source-{i}.ts", state="complete", native="complete", nodes=2, edges=1, pass_id=1)
    records = _progress_records(stream.getvalue())
    assert len(records) == 20000 and records[-1]["completed"] == 10000
    assert records[-1]["path"] == "src/source-9999.ts"
    assert len(stream.getvalue()) < worker.MAX_PROGRESS_BYTES


def test_file_completion_waits_for_native_annotations(job, monkeypatch):
    from graphify.native_annotations import runtime
    original = runtime.analyze_source
    stream = io.StringIO()
    request = job({"a.ts": "export const value = 1;", "package.json": "{}"})

    def checked(*args, **kwargs):
        records = _progress_records(stream.getvalue())
        assert records[-1]["phase"] == "file_started"
        assert not any(r["phase"] == "file_completed" for r in records)
        return original(*args, **kwargs)

    monkeypatch.setattr(runtime, "analyze_source", checked)
    result = worker.run_request(request, progress=worker._Progress(stream, request["jobId"]))
    assert result["status"] == "candidate_ready"
    assert all(r.get("path") != "package.json" and r["total"] == 1 for r in _progress_records(stream.getvalue()))


def test_progress_expanded_pass_resets_counts_and_reused_observations(job):
    first = job({"a.ts": "export const alpha = 1;", "b.ts": "export const beta = 2;"})
    ready = _run(first)
    request = job({"a.ts": "export const renamed = 1;", "b.ts": "export const beta = 2;"}, (first, ready))
    stream = io.StringIO()
    result = worker.run_request(request, progress=worker._Progress(stream, request["jobId"]))
    assert result["status"] == "candidate_ready"
    records = _progress_records(stream.getvalue())
    passes = [r for r in records if r["phase"] == "extract"]
    assert [r["pass"] for r in passes] == [1, 2]
    assert all(r["completed"] == r["reused"] == 0 for r in passes)
    assert any(r["phase"] == "file_reused" and r["path"] == "b.ts" for r in records)
    assert any(r["phase"] == "file_started" and r["path"] == "b.ts" and r["pass"] == 2 for r in records)
    assert records[-1]["completed"] == 2 and records[-1]["reused"] == 0


def test_progress_partial_and_failed_sources_are_finished_attempts(job, monkeypatch):
    request = job({"broken.ts": "export function broken( {"})
    stream = io.StringIO()
    result = worker.run_request(request, progress=worker._Progress(stream, request["jobId"]))
    assert result["status"] == "partial"
    completed = [r for r in _progress_records(stream.getvalue()) if r["phase"] == "file_completed"]
    assert completed[-1]["state"] == completed[-1]["native"] == "partial"
    assert completed[-1]["completed"] == 1 and completed[-1]["failed"] == 0
    import graphify.extract
    monkeypatch.setattr(graphify.extract, "_safe_extract_with_xaml_root", lambda *a, **k: {"nodes": [], "edges": [], "error": "private diagnostic"})
    request = job({"failed.ts": "export const value = 1;"})
    stream = io.StringIO()
    result = worker.run_request(request, progress=worker._Progress(stream, request["jobId"]))
    assert result["status"] == "partial"
    records = _progress_records(stream.getvalue())
    assert records[-1]["completed"] == records[-1]["failed"] == 1
    assert any(r["phase"] == "file_completed" and r["state"] == "failed" and r["native"] == "missing" for r in records)
    assert "private diagnostic" not in stream.getvalue()


def _long_job(tmp_path, contents, tag, previous=None):
    base = tmp_path / tag
    while len(str(base)) < 310:
        base /= "private-snapshot-segment"
    snapshot, output, cache = (base / name for name in ("input", "output", "cache"))
    for directory in (snapshot, output, cache):
        Path("\\\\?\\" + str(directory)).mkdir(parents=True)
    files = []
    for relative, content in contents.items():
        raw = content.encode("utf-8")
        path = snapshot / relative
        extended = Path("\\\\?\\" + str(path))
        extended.parent.mkdir(parents=True, exist_ok=True)
        extended.write_bytes(raw)
        kind = "code" if path.suffix in {".ts", ".tsx"} else "document" if path.suffix == ".md" else "control"
        files.append({"path": relative, "sha256": _sha(raw), "bytes": len(raw), "kind": kind})
    request = {"version": 1, "jobId": tag, "projectId": "project-a", "rootId": "root-a",
               "rootIdentity": "volume-file-identity", "sourceRoot": str(tmp_path / "logical-project"),
               "inputRoot": str(snapshot), "outputDir": str(output), "cacheDir": str(cache),
               "bundleDigest": "1" * 64, "policyDigest": "2" * 64,
               "inputDigest": worker.input_digest(files), "files": files}
    if previous is not None:
        prior, result = previous
        request["previous"] = {"graphPath": str(Path(prior["outputDir"]) / result["graph"]["path"]),
                               "manifestPath": str(Path(prior["outputDir"]) / result["manifest"]["path"]),
                               "graphSha256": result["graph"]["sha256"],
                               "manifestSha256": result["manifest"]["sha256"]}
    return request


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
def test_deep_private_paths_preserve_graph_and_reuse(job, tmp_path, monkeypatch):
    contents = {
        "tsconfig.json": '{"compilerOptions":{"paths":{"@quota/*":["src/deep/*"]}}}',
        "src/deep/caf\u00e9.ts": "export function normalizeQuota(value: string) { return value.trim(); }\n",
        "src/use.ts": 'import { normalizeQuota } from "@quota/caf\u00e9"; export function useQuota() { return normalizeQuota("quota"); }\n',
        "docs/guide.md": "# Quota\nUse `normalizeQuota()`.\n```ts\nnormalizeQuota(\"quota\");\n```\n",
    }
    short = job(contents)
    short_result = _run(short)
    expected, _ = _artifacts(short, short_result)
    deep = _long_job(tmp_path, contents, "deep-first")
    for method in ("stat", "open", "iterdir", "mkdir"):
        original = getattr(Path, method)

        def require_private_io(path, *args, _original=original, **kwargs):
            if len(str(path)) > 250 and not str(path).startswith("\\\\?\\"):
                raise FileNotFoundError(3, "ordinary Windows path exceeds fixture limit")
            return _original(path, *args, **kwargs)

        monkeypatch.setattr(Path, method, require_private_io)
    result = _run(deep)
    graph_bytes = worker._read_file(Path(deep["outputDir"]) / "graph.json", worker.MAX_GRAPH_BYTES)
    actual = json.loads(graph_bytes)
    assert actual == expected
    assert result["coverage"]["controls"] == 1
    by_id = {node["id"]: node for node in actual["nodes"]}
    assert any(edge["relation"] == "calls"
               and by_id[edge["source"]].get("source_file") == "src/use.ts"
               and by_id[edge["target"]].get("source_file") == "src/deep/caf\u00e9.ts"
               for edge in actual["links"])
    assert "\\\\?\\" not in graph_bytes.decode("utf-8")
    unchanged = _long_job(tmp_path, contents, "deep-second", (deep, result))
    unchanged_result = _run(unchanged, "verified_unchanged")
    assert unchanged_result["graph"] == result["graph"]
    changed = dict(contents, **{"src/deep/caf\u00e9.ts": "export function normalizeQuota(value: string) { return value.trim().toLowerCase(); }\n"})
    edited = _long_job(tmp_path, changed, "deep-third", (unchanged, unchanged_result))
    # Both the changed declaration and its caller must remain eligible for refresh.
    assert _run(edited)["coverage"]["selected"] >= 2


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
@pytest.mark.parametrize("field", ["inputRoot", "outputDir", "cacheDir", "sourceRoot"])
def test_private_namespace_is_not_accepted_from_requests(job, field):
    request = job({})
    request[field] = "\\\\?\\" + request[field]
    assert _run(request, "blocked")["error"]["code"] == "unsafe_path"


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
@pytest.mark.parametrize("damage", ["extra", "hash", "hardlink", "cache-link", "output", "overlap"])
def test_deep_private_paths_keep_snapshot_guards(tmp_path, damage):
    request = _long_job(tmp_path, {"value.ts": "export const value = 1;"}, "guard")
    root, output, cache = (Path("\\\\?\\" + request[key]) for key in ("inputRoot", "outputDir", "cacheDir"))
    expected = {"extra": "snapshot_inventory_mismatch", "hash": "snapshot_hash_mismatch",
                "hardlink": "unsafe_snapshot", "cache-link": "unsafe_cache",
                "output": "output_not_empty", "overlap": "unsafe_path"}[damage]
    if damage == "extra":
        (root / "extra.ts").write_text("export const extra = 1;")
    elif damage == "hash":
        (root / "value.ts").write_text("changed")
    elif damage == "hardlink":
        os.link(root / "value.ts", tmp_path / "alias.ts")
    elif damage == "cache-link":
        outside = tmp_path / "outside.txt"
        outside.write_text("not admitted")
        os.link(outside, cache / "linked.txt")
    elif damage == "output":
        (output / "graph.json").write_text("preserve")
    else:
        request["outputDir"] = request["inputRoot"]
    assert _run(request, "blocked")["error"]["code"] == expected


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
def test_deep_private_request_file_cli(tmp_path, capsys):
    request = _long_job(tmp_path, {"guide.md": "# Deep worker request\n"}, "request")
    path = Path(request["inputRoot"]).parent / "request.json"
    Path("\\\\?\\" + str(path)).write_bytes(worker._json_bytes(request))
    assert worker.main(["--request", str(path)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "candidate_ready"
    assert worker.main(["--request", "\\\\?\\" + str(path)]) == 3
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "unsafe_path"


@pytest.mark.parametrize("path", [r"\\server\share\request.json", r"\\?\C:\private\request.json",
                                  r"\\.\C:\private\request.json", "//server/share/request.json", "relative/request.json"])
def test_private_request_syntax_rejected_before_filesystem(path, monkeypatch):
    monkeypatch.setattr(Path, "lstat", lambda *a, **k: pytest.fail("Unadmitted path was probed"))
    with pytest.raises(worker.WorkerError) as result:
        worker._safe_path(path)
    assert result.value.code == "unsafe_path"


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
@pytest.mark.parametrize("location", ["ancestor", "input", "cache"])
def test_deep_private_paths_reject_reparse_attributes(tmp_path, monkeypatch, location):
    request = _long_job(tmp_path, {"nested/value.ts": "export const value = 1;"}, "reparse")
    if location == "ancestor":
        target = Path("\\\\?\\" + request["inputRoot"]).parent
        expected = "unsafe_path"
    elif location == "input":
        target = Path("\\\\?\\" + request["inputRoot"]) / "nested"
        expected = "unsafe_snapshot"
    else:
        target = Path("\\\\?\\" + request["cacheDir"]) / "nested"
        target.mkdir()
        expected = "unsafe_cache"
    original = Path.lstat

    def reparse(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path == target:
            return SimpleNamespace(st_mode=info.st_mode, st_nlink=info.st_nlink, st_file_attributes=0x400)
        return info

    monkeypatch.setattr(Path, "lstat", reparse)
    assert _run(request, "blocked")["error"]["code"] == expected


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
@pytest.mark.parametrize("component", ["COM\u00b9.ts", "LPT\u00b2", "NUL .ts", "conout$", "file:stream", "trailing.", "trailing "])
def test_extended_conversion_rejects_ambiguous_external_components(tmp_path, monkeypatch, component):
    monkeypatch.setattr(Path, "lstat", lambda *a, **k: pytest.fail("Ambiguous external path was probed"))
    with pytest.raises(worker.WorkerError) as result:
        worker._safe_path(str(tmp_path / component))
    assert result.value.code == "unsafe_path"


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
@pytest.mark.parametrize("field", ["graphPath", "manifestPath"])
def test_previous_artifact_namespace_is_not_accepted(job, field):
    first = job({"value.ts": "export const value = 1;"})
    result = _run(first)
    request = job({"value.ts": "export const value = 1;"}, (first, result))
    request["previous"][field] = "\\\\?\\" + request["previous"][field]
    assert _run(request, "blocked")["error"]["code"] == "unsafe_path"


@pytest.mark.skipif(os.name != "nt", reason="Windows private-path namespace")
def test_extended_snapshot_keeps_frozen_bytes_and_audit_boundary(tmp_path):
    from graphify.input_snapshot import admitted_snapshot, read_source_text
    request = _long_job(tmp_path, {"guide.md": "# Admitted"}, "audit")
    files, root, _, cache = worker._validate_request(request)
    captured = worker._snapshot(root, files)
    (root / "guide.md").write_text("# Changed!")
    with admitted_snapshot(root, captured, cache):
        assert read_source_text(root / "guide.md") == "# Admitted"
        with pytest.raises(PermissionError):
            (root.parent / "outside.txt").read_bytes()
        with pytest.raises(PermissionError):
            (root / "guide.md").write_text("not permitted")
        with pytest.raises(PermissionError):
            subprocess.run([sys.executable, "-c", "pass"])
        import socket
        with pytest.raises(PermissionError):
            socket.socket()
        (cache / "allowed.txt").write_text("private cache only")


@pytest.mark.parametrize("function,phase", [("_validate_request", "request"), ("_validate_cache", "cache"),
                                           ("_snapshot", "snapshot"), ("_extract_candidate", "extract")])
def test_private_io_failure_identifies_phase_without_private_details(job, monkeypatch, function, phase):
    request = job({"value.ts": "export const value = 1;"})

    def failed(*args, **kwargs):
        raise OSError(3, "private source and credential must not leak", request["inputRoot"])

    monkeypatch.setattr(worker, function, failed)
    result = _run(request, "blocked")
    assert result["error"]["code"] == f"{phase}_io_failed"
    assert "credential" not in result["error"]["message"]
    assert request["inputRoot"] not in json.dumps(result)
    assert list(Path(request["outputDir"]).iterdir()) == []
