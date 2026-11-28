from __future__ import annotations

import copy
import hashlib
import io
import json
import subprocess
import threading
from importlib.metadata import version
from pathlib import Path

import pytest

from graphify import framework_analysis as analysis
from graphify.framework_evidence import canonical_json, validate_payload
from graphify.security import redact_secrets


def _request(documents=(), **extra):
    return {
        "version": 1,
        "parser": analysis.parser_descriptor(),
        "documents": list(documents),
        **extra,
    }


def _wire(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


@pytest.fixture(scope="module")
def manifest_payload():
    return analysis._run_worker(_request())


def _payload(base, documents):
    """Mock only transport, retaining a real manifest and a valid empty fact set."""
    payload = copy.deepcopy(base)
    payload["documents"] = [
        {
            "source": document["source"],
            "result": {
                "version": 1,
                "analysisSetId": payload["manifest"]["id"],
                "relativePath": document["relativePath"],
                "sourceHash": document["sourceHash"],
                "language": document["language"],
                "state": "not-applicable",
                "declarations": [],
                "facts": [],
                "diagnostics": [],
                "reports": [
                    {"pluginId": plugin["id"], "state": "not-applicable", "diagnostics": []}
                    for plugin in payload["manifest"]["plugins"]
                ],
            },
        }
        for document in documents
    ]
    validate_payload(payload)
    return payload


def _nodes(root):
    pending = [root]
    while pending:
        node = pending.pop()
        yield node
        pending.extend(child["node"] for child in reversed(node["children"]))


def test_serializer_preserves_bom_astral_crlf_and_anonymous_tokens():
    source = '\ufeff// \U0001f680\r\nconst caf\u00e9 = "\U0001f642";\r\n'
    tree = analysis.serialize_tree(source)
    raw16 = source.encode("utf-16-le")
    for node in _nodes(tree):
        for edge in ("start", "end"):
            prefix = raw16[: node[f"{edge}Index"] * 2].decode("utf-16-le")
            tail = prefix.rsplit("\n", 1)[-1]
            assert node[f"{edge}Position"] == {
                "row": prefix.count("\n"),
                "column": len(tail.encode("utf-16-le")) // 2,
            }
    identifiers = [node for node in _nodes(tree) if node["type"] == "identifier"]
    assert len(identifiers) == 1
    name = identifiers[0]
    assert raw16[name["startIndex"] * 2 : name["endIndex"] * 2].decode("utf-16-le") == "caf\u00e9"
    assert any(not node["isNamed"] and node["type"] == ";" for node in _nodes(tree))
    assert any(child["field"] == "name" for node in _nodes(tree) for child in node["children"])
    document = analysis.make_document(source, "src/caf\u00e9.ts")
    assert document["source"] == source
    assert document["sourceHash"] == hashlib.sha256(source.encode()).hexdigest()
    assert document["relativePath"] == "src/caf\u00e9.ts"


@pytest.mark.parametrize("source", [None, b"code", 1, "\ud800", "\udfff"])
def test_parser_rejects_nontext_and_invalid_unicode(source):
    with pytest.raises(analysis.FrameworkAnalysisError):
        analysis.serialize_tree(source)


@pytest.mark.parametrize("language", [None, False, [], "javascript", "TSX"])
def test_parser_rejects_unknown_languages(language):
    with pytest.raises(analysis.FrameworkAnalysisError):
        analysis.serialize_tree("const value=1", language)


def test_parser_has_explicit_source_node_depth_budgets(monkeypatch):
    with pytest.raises(analysis.FrameworkAnalysisError, match="byte"):
        analysis.serialize_tree("\U0001f680" * (analysis.MAX_SOURCE_BYTES // 4 + 1))
    monkeypatch.setattr(analysis, "MAX_TREE_NODES", 2)
    with pytest.raises(analysis.FrameworkAnalysisError, match="node"):
        analysis.serialize_tree("const value=1;")
    monkeypatch.setattr(analysis, "MAX_TREE_NODES", 100_000)
    monkeypatch.setattr(analysis, "MAX_TREE_DEPTH", 1)
    with pytest.raises(analysis.FrameworkAnalysisError, match="depth"):
        analysis.serialize_tree("const value=1;")


@pytest.mark.parametrize(
    "path",
    [
        None,
        Path("a.ts"),
        "",
        ".",
        "..",
        "../a.ts",
        "a/../b.ts",
        "a/./b.ts",
        "./a.ts",
        "/a.ts",
        "a//b.ts",
        "a/",
        "C:/a.ts",
        "a\\b.ts",
        "a\x00.ts",
        "a\x7f.ts",
        "a\n.ts",
        "\ud800.ts",
        "\u00e9" * 1025,
    ],
)
def test_source_paths_are_exact_canonical_relative_identities(path):
    with pytest.raises(analysis.FrameworkAnalysisError):
        analysis.make_document("const value=1;", path)


def test_parser_version_is_installed_and_qualified(monkeypatch):
    assert analysis.parser_descriptor() == {
        "id": "tree-sitter-typescript",
        "version": version("tree-sitter-typescript"),
        "runtimeVersion": version("tree-sitter"),
        "coordinateEncoding": "utf16",
    }
    original = analysis.version
    monkeypatch.setattr(
        analysis,
        "version",
        lambda name: "99.0.0" if name == "tree-sitter-typescript" else original(name),
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="not qualified"):
        analysis.parser_descriptor()


def test_secret_snapshot_is_redacted_but_forged_raw_dispatch_is_refused(monkeypatch):
    secret = "ghp_" + "A" * 36
    source = f'const token="{secret}";'
    assert redact_secrets(source) != source
    tree = analysis.serialize_tree(source)
    document = analysis.make_document(source, "credential.ts")
    assert secret not in json.dumps(document)
    assert document["redaction"]["originalSourceHash"] == hashlib.sha256(source.encode()).hexdigest()
    assert document["sourceHash"] != document["redaction"]["originalSourceHash"]
    invoked = []
    monkeypatch.setattr(analysis, "_run_worker", lambda *args, **kwargs: invoked.append(args))
    forged = {
        "source": source,
        "sourceHash": hashlib.sha256(source.encode()).hexdigest(),
        "relativePath": "credential.ts",
        "language": "typescript",
        "tree": tree,
    }
    with pytest.raises(analysis.FrameworkAnalysisError, match="credential-shaped"):
        analysis.analyze_documents([forged])
    assert not invoked


def test_secret_snapshot_diagnostic_locates_line_and_redacts_sensitive_path():
    secret = "ghp_" + "B" * 36
    source = f'// context\r\nconst label = "safe";\r\nconst token = "{secret}";\r\n'
    with pytest.raises(analysis.FrameworkAnalysisError) as error:
        analysis.make_document(source, f"fixtures/{secret}.ts")
    message = str(error.value)
    assert "fixtures/[redacted].ts" in message
    assert secret not in message
    assert "const token" not in message


def test_real_worker_exact_unicode_source_never_executes_application(tmp_path):
    marker = tmp_path / "must-not-exist"
    source = (
        "\ufeff// \U0001f680\r\n"
        + f'import {{writeFileSync}} from "node:fs"; writeFileSync({json.dumps(str(marker))}, "executed");\r\n'
    )
    source += "import {onMount} from 'solid-js'; export function setup(){onMount(()=>{});}\r\n"
    document = analysis.make_document(source, "src/setup.ts")
    store = analysis.analyze_documents([document])
    entry = store["documents"]["src/setup.ts"]
    assert entry["source"] == source
    assert entry["result"]["sourceHash"] == hashlib.sha256(source.encode()).hexdigest()
    assert entry["result"]["relativePath"] == "src/setup.ts"
    assert len(next(iter(store["manifests"].values()))["plugins"]) == 7
    calls = [fact for fact in entry["result"]["facts"] if fact["term"] == "solid.api-call"]
    assert len(calls) == 1
    span = calls[0]["evidence"]["span"]
    assert source.encode()[span["startByte"] : span["endByte"]] == b"onMount(()=>{})"
    assert not marker.exists()


def test_empty_corpus_retains_real_manifest_and_no_documents():
    store = analysis.analyze_documents([])
    assert store["documents"] == {}
    assert len(store["manifests"]) == 1


def test_mixed_parse_recovery_retains_both_sources_without_complete_claim():
    documents = [
        analysis.make_document("const good=1;", "good.ts"),
        analysis.make_document("const = ;", "broken.ts"),
    ]
    store = analysis.analyze_documents(documents)
    assert set(store["documents"]) == {"good.ts", "broken.ts"}
    assert store["documents"]["broken.ts"]["result"]["state"] == "unsupported"
    assert store["documents"]["broken.ts"]["source"] == "const = ;"
    assert store["documents"]["broken.ts"]["result"]["facts"] == []


@pytest.mark.parametrize(
    "options",
    [
        [],
        False,
        0,
        "",
        {"unknown": 1},
        {"limits": None},
        {"limits": []},
        {"limits": {"maxFacts": True}},
        {"limits": {"maxFacts": 1.0}},
        {"limits": {"maxFacts": 0}},
        {"limits": {"maxPlugins": 6}},
        {"limits": {"maxWork": 2_000_001}},
        {"limits": {"unknown": 1}},
        {"moduleAliases": None},
        {"moduleAliases": []},
        {"moduleAliases": {"@sample/ui": "unknown-library"}},
        {"moduleAliases": {"./local": "solid-js"}},
        {"moduleAliases": {"solid-js": "@fst/components-fst-solid"}},
        {"moduleAliases": {}, "guessOwnership": True},
    ],
)
def test_options_are_not_falsy_defaults(options, monkeypatch):
    monkeypatch.setattr(
        analysis, "_run_worker", lambda *args, **kwargs: pytest.fail("invalid options dispatched")
    )
    with pytest.raises(analysis.FrameworkAnalysisError):
        analysis.analyze_documents([], options=options)


@pytest.mark.parametrize("options", [None, {}, {"limits": {}}])
def test_only_explicit_api_none_normalizes_to_default_options(options):
    assert analysis.analyze_documents([], options=options)["documents"] == {}


def test_wire_null_options_are_rejected_instead_of_normalized():
    with pytest.raises(analysis.FrameworkAnalysisError, match="options"):
        analysis._run_worker(_request(options=None))


@pytest.mark.parametrize(
    "timeout", [True, False, 0, -1, float("nan"), float("inf"), 1801, "1", 10**1000]
)
def test_timeout_is_finite_positive_and_not_boolean(timeout):
    with pytest.raises(analysis.FrameworkAnalysisError, match="timeout"):
        analysis._run_worker(_request(), timeout=timeout)
    with pytest.raises(analysis.FrameworkAnalysisError, match="timeout"):
        analysis.analyze_documents([], timeout=timeout)


@pytest.mark.parametrize("bound", ["documents", "sources", "nodes", "wire"])
def test_batches_enforce_actual_document_source_node_and_escaped_wire_budgets(
    bound, monkeypatch, manifest_payload
):
    source = '// "\\\t\U0001f680\r\nconst value=1;'
    documents = [analysis.make_document(source, f"{index}.ts") for index in range(3)]
    size, nodes, wire = analysis._document_metrics(documents[0])
    assert wire == len(_wire(documents[0]))
    overhead = len(_wire(_request(options=analysis._options({}))))
    name, maximum = {
        "documents": ("MAX_BATCH_DOCUMENTS", 2),
        "sources": ("MAX_BATCH_SOURCE_BYTES", size * 2),
        "nodes": ("MAX_BATCH_TREE_NODES", nodes * 2),
        "wire": ("MAX_REQUEST_BYTES", overhead + wire * 2 + 1),
    }[bound]
    monkeypatch.setattr(analysis, name, maximum)
    calls = []

    def run(request, **kwargs):
        calls.append(copy.deepcopy(request))
        assert len(_wire(request)) <= analysis.MAX_REQUEST_BYTES
        return _payload(manifest_payload, request["documents"])

    monkeypatch.setattr(analysis, "_run_worker", run)
    store = analysis.analyze_documents(documents)
    assert [len(request["documents"]) for request in calls] == [2, 1]
    assert set(store["documents"]) == {"0.ts", "1.ts", "2.ts"}


def test_oversized_singleton_and_late_duplicate_never_dispatch_a_prefix(monkeypatch):
    small = analysis.make_document("", "small.ts")
    large = analysis.make_document('// "\\' * 200, "large.ts")
    monkeypatch.setattr(
        analysis, "_run_worker", lambda *args, **kwargs: pytest.fail("preflight failure dispatched")
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="Duplicate"):
        analysis.analyze_documents([small, large, small])
    monkeypatch.setattr(
        analysis,
        "MAX_REQUEST_BYTES",
        len(_wire(_request([large], options=analysis._options({})))) - 1,
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="cannot fit"):
        analysis.analyze_documents([small, large])


def test_configured_source_budget_is_preflighted_before_process_launch(monkeypatch):
    document = analysis.make_document("const value=1;", "value.ts")
    monkeypatch.setattr(
        analysis,
        "_run_worker",
        lambda *args, **kwargs: pytest.fail("source budget failure dispatched"),
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="cannot fit"):
        analysis.analyze_documents([document], options={"limits": {"maxSourceBytes": 1}})


@pytest.mark.parametrize("mutation", ["hash", "extra", "cycle", "shared", "nodes", "depth"])
def test_forged_document_identity_and_unsafe_tree_are_rejected_before_dispatch(
    mutation, monkeypatch
):
    document = analysis.make_document("const value=1;", "value.ts")
    if mutation == "hash":
        document["sourceHash"] = "0" * 64
    elif mutation == "extra":
        document["unexpected"] = True
    elif mutation == "cycle":
        document["tree"]["children"].append({"field": None, "node": document["tree"]})
    elif mutation == "shared":
        document["tree"]["children"].append(document["tree"]["children"][0])
    elif mutation == "nodes":
        monkeypatch.setattr(analysis, "MAX_TREE_NODES", 1)
    else:
        monkeypatch.setattr(analysis, "MAX_TREE_DEPTH", 1)
    monkeypatch.setattr(
        analysis, "_run_worker", lambda *args, **kwargs: pytest.fail("invalid document dispatched")
    )
    with pytest.raises(analysis.FrameworkAnalysisError):
        analysis.analyze_documents([document])


@pytest.mark.parametrize(
    "mutation",
    ["source", "language", "path", "missing", "extra", "parser", "configuration", "malformed"],
)
def test_responses_must_match_exact_admitted_source_set_and_analysis_contract(
    mutation, monkeypatch, manifest_payload
):
    document = analysis.make_document("const value=1;", "value.ts")
    payload = _payload(manifest_payload, [document])
    result = payload["documents"][0]["result"]
    if mutation == "source":
        payload["documents"][0]["source"] = "const value=2;"
        result["sourceHash"] = hashlib.sha256(b"const value=2;").hexdigest()
    elif mutation == "language":
        result["language"] = "tsx"
    elif mutation == "path":
        result["relativePath"] = "other.ts"
    elif mutation == "missing":
        payload["documents"] = []
    elif mutation == "extra":
        payload["documents"].append(copy.deepcopy(payload["documents"][0]))
        payload["documents"][-1]["result"]["relativePath"] = "extra.ts"
    elif mutation == "parser":
        payload["manifest"]["parserDigest"] = "a" * 64
    elif mutation == "configuration":
        payload["manifest"]["limits"]["maxFacts"] = 100
    else:
        del result["reports"]
    if mutation in {"parser", "configuration"}:
        payload["manifest"]["id"] = hashlib.sha256(
            canonical_json(
                {key: value for key, value in payload["manifest"].items() if key != "id"}
            ).encode()
        ).hexdigest()
        result["analysisSetId"] = payload["manifest"]["id"]
    monkeypatch.setattr(analysis, "_run_worker", lambda *args, **kwargs: payload)
    with pytest.raises(analysis.FrameworkAnalysisError):
        analysis.analyze_documents([document])


def test_later_process_failure_does_not_return_a_partial_store(monkeypatch, manifest_payload):
    documents = [analysis.make_document("const value=1;", f"{index}.ts") for index in range(2)]
    monkeypatch.setattr(analysis, "MAX_BATCH_DOCUMENTS", 1)
    calls = []

    def run(request, **kwargs):
        calls.append(request)
        if len(calls) == 2:
            raise analysis.FrameworkAnalysisError("second batch failed")
        return _payload(manifest_payload, request["documents"])

    monkeypatch.setattr(analysis, "_run_worker", run)
    with pytest.raises(analysis.FrameworkAnalysisError, match="second batch failed"):
        analysis.analyze_documents(documents)
    assert len(calls) == 2


def test_a_worker_build_change_between_batches_cannot_mix_analysis_sets(
    monkeypatch, manifest_payload
):
    documents = [analysis.make_document("", f"{index}.ts") for index in range(2)]
    monkeypatch.setattr(analysis, "MAX_BATCH_DOCUMENTS", 1)
    calls = []

    def run(request, **kwargs):
        calls.append(request)
        payload = _payload(manifest_payload, request["documents"])
        if len(calls) == 2:
            fingerprint = "e" * 64
            payload["producer"]["fingerprint"] = fingerprint
            manifest = payload["manifest"]
            for descriptor in [manifest["core"], manifest["view"], *manifest["plugins"]]:
                descriptor["implementationDigest"] = fingerprint
            manifest["id"] = hashlib.sha256(
                canonical_json(
                    {key: value for key, value in manifest.items() if key != "id"}
                ).encode()
            ).hexdigest()
            for document in payload["documents"]:
                document["result"]["analysisSetId"] = manifest["id"]
            validate_payload(payload)
        return payload

    monkeypatch.setattr(analysis, "_run_worker", run)
    with pytest.raises(analysis.FrameworkAnalysisError, match="changed during"):
        analysis.analyze_documents(documents)


def test_only_admitted_paths_are_read_and_original_bytes_are_retained(
    tmp_path, monkeypatch, manifest_payload
):
    admitted = tmp_path / "admitted.tsx"
    original = b"\xef\xbb\xbfconst Page=()=> <div/>;\r\n"
    admitted.write_bytes(original)
    (tmp_path / "not-admitted.ts").write_text(
        'throw new Error("do not discover");', encoding="utf-8"
    )
    captured = []

    def run(documents, **kwargs):
        captured.extend(documents)
        return validate_payload(_payload(manifest_payload, documents))

    monkeypatch.setattr(analysis, "analyze_documents", run)
    store = analysis.analyze_paths([admitted, admitted, tmp_path / "not-supported.py"], tmp_path)
    assert store is not None and set(store["documents"]) == {"admitted.tsx"}
    assert len(captured) == 1
    assert captured[0]["source"].encode() == original
    assert captured[0]["sourceHash"] == hashlib.sha256(original).hexdigest()
    assert captured[0]["language"] == "tsx"
    assert analysis.analyze_paths([], tmp_path) is None
    assert analysis.analyze_paths([tmp_path / "not-supported.py"], tmp_path) is None


@pytest.mark.parametrize("change", ["contents", "deleted", "grown"])
def test_changed_or_missing_source_after_analysis_never_returns_old_snapshot(
    change, tmp_path, monkeypatch
):
    source = tmp_path / "source.ts"
    source.write_bytes(b"const value=1;")

    def analyze(documents, **kwargs):
        if change == "deleted":
            source.unlink()
        else:
            source.write_bytes(
                b"const value=2;"
                if change == "contents"
                else b"x" * (analysis.MAX_SOURCE_BYTES + 1)
            )
        return {"version": 1, "manifests": {}, "producers": {}, "documents": {}}

    monkeypatch.setattr(analysis, "analyze_documents", analyze)
    with pytest.raises(analysis.FrameworkAnalysisError, match="during framework analysis"):
        analysis.analyze_paths([source], tmp_path)


def test_invalid_utf8_or_oversized_source_is_not_repaired_or_truncated(tmp_path, monkeypatch):
    source = tmp_path / "source.ts"
    monkeypatch.setattr(
        analysis, "analyze_documents", lambda *args, **kwargs: pytest.fail("invalid capture sent")
    )
    for raw in [b"\xffconst value=1;", b"x" * (analysis.MAX_SOURCE_BYTES + 1)]:
        source.write_bytes(raw)
        with pytest.raises(analysis.FrameworkAnalysisError):
            analysis.analyze_paths([source], tmp_path)


def test_relative_scan_root_and_dot_paths_keep_canonical_identity(
    tmp_path, monkeypatch, manifest_payload
):
    root = tmp_path / "project"
    (root / "sub").mkdir(parents=True)
    (root / "file.ts").write_bytes(b"const value=1;")
    monkeypatch.chdir(tmp_path)
    captured = []

    def run(documents, **kwargs):
        captured.extend(documents)
        return validate_payload(_payload(manifest_payload, documents))

    monkeypatch.setattr(analysis, "analyze_documents", run)
    store = analysis.analyze_paths(
        [Path("project/sub/../file.ts"), Path("project/file.ts")], Path("project")
    )
    assert store is not None and set(store["documents"]) == {"file.ts"}
    assert len(captured) == 1


def test_analyze_paths_rejects_out_of_root_identity_without_searching_elsewhere(
    tmp_path, monkeypatch
):
    root = tmp_path / "project"
    root.mkdir()
    outside = tmp_path / "outside.ts"
    outside.write_bytes(b"const value=1;")
    monkeypatch.setattr(
        analysis, "analyze_documents", lambda *args, **kwargs: pytest.fail("outside source sent")
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="outside the admitted root"):
        analysis.analyze_paths([outside], root)


def test_scan_root_symlink_preserves_separately_admitted_file_aliases(
    tmp_path, monkeypatch, manifest_payload
):
    root, root_alias = tmp_path / "real", tmp_path / "alias"
    root.mkdir()
    source = root / "source.ts"
    source.write_bytes(b"const value=1;")
    try:
        (root / "source-alias.ts").symlink_to(source)
        root_alias.symlink_to(root, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Host cannot create test symlinks: {exc}")

    def run(documents, **kwargs):
        return validate_payload(_payload(manifest_payload, documents))

    monkeypatch.setattr(analysis, "analyze_documents", run)
    store = analysis.analyze_paths([source, root_alias / "source-alias.ts"], root_alias)
    assert store is not None and set(store["documents"]) == {"source.ts", "source-alias.ts"}


def test_partial_stdin_writes_are_retried_to_completion(tmp_path, monkeypatch):
    closed = threading.Event()

    class ShortInput:
        def __init__(self):
            self.data = bytearray()
            self.closed = False

        def write(self, data):
            chunk = bytes(data[:7])
            self.data.extend(chunk)
            return len(chunk)

        def close(self):
            self.closed = True
            closed.set()

    class Process:
        def __init__(self):
            self.stdin, self.stdout, self.stderr = ShortInput(), io.BytesIO(b"{}"), io.BytesIO()
            self.returncode = None

        def poll(self):
            return self.returncode

        def kill(self):
            self.returncode = -9

        def wait(self, timeout=None):
            assert closed.wait(timeout)
            self.returncode = 0
            return 0

    process = Process()
    monkeypatch.setattr(analysis.subprocess, "Popen", lambda *args, **kwargs: process)
    request = b"x" * (128 * 1024 + 3)
    assert analysis._run_process(
        ["node"],
        request,
        environment={},
        cwd=tmp_path,
        timeout=5,
        stdout_limit=128,
        stderr_limit=128,
    ) == (0, b"{}", b"")
    assert bytes(process.stdin.data) == request
    assert process.stdin.closed and process.stdout.closed and process.stderr.closed


def test_fingerprint_binds_python_bridge_bundle_and_parser_bytes(tmp_path, monkeypatch):
    bridge, worker = tmp_path / "framework_analysis.py", tmp_path / "worker.mjs"
    bridge.write_bytes(b"bridge-version-one")
    worker.write_bytes(b"bundle-version-one")
    dependencies = ["extract.py", "build.py", "framework_pipeline.py", "watch.py", "security.py", "extractors/base.py"]
    for name in dependencies:
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_bytes(b"pipeline-version-one")
    monkeypatch.setattr(analysis, "__file__", str(bridge))
    monkeypatch.setattr(analysis, "_worker_path", lambda: worker)
    first = analysis.analysis_fingerprint()
    assert first == analysis.analysis_fingerprint()
    assert first == analysis.analysis_fingerprint(options={"limits": {}})
    assert first != analysis.analysis_fingerprint(options={"limits": {"maxFacts": 100}})
    bridge.write_bytes(b"bridge-version-two")
    second = analysis.analysis_fingerprint()
    worker.write_bytes(b"bundle-version-two")
    third = analysis.analysis_fingerprint()
    descriptor = analysis.parser_descriptor()
    monkeypatch.setattr(
        analysis, "parser_descriptor", lambda: {**descriptor, "runtimeVersion": "0.25.3"}
    )
    assert len({first, second, third, analysis.analysis_fingerprint()}) == 4
    before = analysis.analysis_fingerprint()
    for name in dependencies:
        (tmp_path / name).write_bytes(b"pipeline-version-two")
        after = analysis.analysis_fingerprint()
        assert after != before
        before = after


def _script(tmp_path, monkeypatch, source):
    worker = tmp_path / "worker fixture.mjs"
    worker.write_text(source, encoding="utf-8")
    monkeypatch.setattr(analysis, "_worker_path", lambda: worker)
    return worker


def test_real_process_strips_node_preloads_and_uses_no_shell(tmp_path, monkeypatch):
    _script(
        tmp_path,
        monkeypatch,
        "process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({options:process.env.NODE_OPTIONS??null,path:process.env.NODE_PATH??null}))); ",
    )
    monkeypatch.setenv("NODE_OPTIONS", "--require definitely-not-executed")
    monkeypatch.setenv("NODE_PATH", str(tmp_path / "foreign libraries"))
    processes, original = [], analysis.subprocess.Popen

    def spawn(command, **kwargs):
        assert kwargs["shell"] is False
        assert not {key.upper() for key in kwargs["env"]} & {"NODE_OPTIONS", "NODE_PATH"}
        assert Path(command[0]).name.lower() in {"node", "node.exe"}
        process = original(command, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(analysis.subprocess, "Popen", spawn)
    assert analysis._run_worker(_request()) == {"options": None, "path": None}
    assert len(processes) == 2
    for process in processes:
        assert process.poll() is not None
        assert all(stream.closed for stream in (process.stdin, process.stdout, process.stderr))


@pytest.mark.parametrize(
    "stdout",
    [
        b"",
        b"not json",
        b"{}{}",
        b"[]",
        b"null",
        b"\xff{}",
        b'{"value":NaN}',
        b'{"value":Infinity}',
        b'{"value":1e999}',
        b'{"version":1,"version":2}',
        b"[" * 2000 + b"]" * 2000,
    ],
)
def test_malformed_process_responses_fail_closed(stdout, monkeypatch):
    calls = []

    def run(command, encoded, **kwargs):
        calls.append(command)
        return (0, b"v22.21.1\n", b"") if len(calls) == 1 else (0, stdout, b"")

    monkeypatch.setattr(analysis, "_run_process", run)
    with pytest.raises(analysis.FrameworkAnalysisError, match="response"):
        analysis._run_worker(_request())


@pytest.mark.parametrize("version_text", [b"v18.20.0\n", b"not-node\n", b"v22.0.0\nextra"])
def test_unqualified_node_version_never_launches_worker(version_text, monkeypatch):
    calls = []

    def run(command, *args, **kwargs):
        calls.append(command)
        return 0, version_text, b""

    monkeypatch.setattr(analysis, "_run_process", run)
    with pytest.raises(analysis.FrameworkAnalysisError, match="Node.js 20"):
        analysis._run_worker(_request())
    assert len(calls) == 1


@pytest.mark.parametrize("kind", ["stdout", "stderr", "timeout"])
def test_real_process_limits_kill_reap_and_close_pipes(kind, tmp_path, monkeypatch):
    script = "setInterval(()=>{},1000);"
    if kind != "timeout":
        script = f"process.{kind}.write('x'.repeat(1024));" + script
    _script(tmp_path, monkeypatch, script)
    monkeypatch.setattr(analysis, "MAX_RESPONSE_BYTES", 128)
    monkeypatch.setattr(analysis, "MAX_STDERR_BYTES", 128)
    processes, original = [], analysis.subprocess.Popen

    def spawn(*args, **kwargs):
        process = original(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(analysis.subprocess, "Popen", spawn)
    with pytest.raises(
        analysis.FrameworkAnalysisError, match="timed out" if kind == "timeout" else "output limit"
    ):
        analysis._run_worker(_request(), timeout=0.3 if kind == "timeout" else 5)
    assert processes and all(process.poll() is not None for process in processes)
    assert all(
        stream.closed
        for process in processes
        for stream in (process.stdin, process.stdout, process.stderr)
    )
    assert not [
        thread for thread in threading.enumerate() if thread.name.startswith("graphify-node-")
    ]


def test_version_probe_is_itself_bounded(tmp_path):
    node = analysis._node_executable(analysis._node_environment())
    with pytest.raises(analysis.FrameworkAnalysisError, match="output limit"):
        analysis._run_process(
            [node, "-e", "process.stdout.write('x'.repeat(1024))"],
            b"",
            environment=analysis._node_environment(),
            cwd=tmp_path,
            timeout=5,
            stdout_limit=256,
            stderr_limit=4096,
        )


def test_failed_process_diagnostic_is_bounded_and_redacted(monkeypatch):
    secret = "ghp_" + "A" * 36
    calls = []

    def run(command, encoded, **kwargs):
        calls.append(command)
        return (
            (0, b"v22.21.1\n", b"")
            if len(calls) == 1
            else (1, b"", (secret + " detail" * 1000).encode())
        )

    monkeypatch.setattr(analysis, "_run_process", run)
    with pytest.raises(analysis.FrameworkAnalysisError) as error:
        analysis._run_worker(_request())
    assert secret not in str(error.value)
    assert len(str(error.value)) < 4200


def test_missing_bundle_never_runs_install_or_network(tmp_path, monkeypatch):
    monkeypatch.setattr(analysis, "__file__", str(tmp_path / "framework_analysis.py"))
    monkeypatch.setattr(
        analysis.subprocess,
        "Popen",
        lambda *args, **kwargs: pytest.fail("automatic subprocess fallback"),
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="missing"):
        analysis._run_worker(_request())


def test_missing_node_has_no_automatic_installer(monkeypatch):
    monkeypatch.setattr(
        analysis,
        "_node_executable",
        lambda _env: (_ for _ in ()).throw(analysis.FrameworkAnalysisError("Node missing")),
    )
    monkeypatch.setattr(
        analysis.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("automatic installer")
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="Node missing"):
        analysis._run_worker(_request())


@pytest.mark.skipif(analysis.os.name != "nt", reason="Windows executable resolution")
def test_windows_lookup_selects_explicit_exe_not_cmd_or_implicit_cwd(tmp_path, monkeypatch):
    path_dir, cwd_dir = tmp_path / "PATH with spaces", tmp_path / "cwd"
    path_dir.mkdir()
    cwd_dir.mkdir()
    (path_dir / "node.cmd").write_text("exit 1", encoding="utf-8")
    (cwd_dir / "node.exe").write_bytes(b"not selected")
    monkeypatch.chdir(cwd_dir)
    with pytest.raises(analysis.FrameworkAnalysisError, match="on PATH"):
        analysis._node_executable({"PATH": str(path_dir)})
    expected = path_dir / "node.exe"
    expected.write_bytes(b"selected by name, not executed")
    assert analysis._node_executable({"PATH": f'"{path_dir}"'}) == str(expected.resolve())


def test_root_options_use_authoritative_defaults_and_no_implicit_ancestors(tmp_path):
    from graphify.framework_config import normalize_analysis_options
    from graphify.framework_evidence import ANNOTATION_LIMITS

    parent, root = tmp_path, tmp_path / "project"
    root.mkdir()
    (parent / ".graphifyrc").write_text(
        'semantic_module_aliases={"@parent/ui":"solid-js"}\n', encoding="utf-8"
    )
    reference_limits = {**ANNOTATION_LIMITS, "maxPlugins": 8}
    expected = normalize_analysis_options({}, max_limits=reference_limits)
    assert analysis.options_for_root(root) == expected
    assert expected["moduleAliases"] == {}
    assert expected["limits"] == reference_limits
    assert (
        analysis.analysis_fingerprint(options=analysis.options_for_root(root))
        == analysis.analysis_fingerprint()
    )


def test_rc_alias_map_is_explicit_sorted_and_independent_of_other_settings(tmp_path):
    from graphify.rcfile import load_graphifyrc

    content = '\ufeff# explicit source-only API assumptions\r\nquery_depth=3\r\nsemantic_module_aliases={"@sample/ui":"@fst/components-fst-solid","@sample/reactive":"solid-js"}\r\nlanguage.tpl=.tsx\r\n'
    (tmp_path / ".graphifyrc").write_bytes(content.encode())
    configuration = analysis.options_for_root(tmp_path)
    assert list(configuration["moduleAliases"]) == ["@sample/reactive", "@sample/ui"]
    assert configuration["moduleAliases"] == {
        "@sample/reactive": "solid-js",
        "@sample/ui": "@fst/components-fst-solid",
    }
    loaded = load_graphifyrc(tmp_path)
    assert loaded["semantic_module_aliases"] == configuration["moduleAliases"]
    assert loaded["query_depth"] == 3
    assert loaded["languages"] == {".tpl": ".tsx"}
    configuration["moduleAliases"]["@unretained"] = "solid-js"
    assert "@unretained" not in analysis.options_for_root(tmp_path)["moduleAliases"]


@pytest.mark.parametrize(
    "value",
    [
        "null",
        "[]",
        '"solid-js"',
        "false",
        "NaN",
        "Infinity",
        '{"@sample/ui":null}',
        '{"@sample/ui":{}}',
        '{"./relative":"solid-js"}',
        '{"@sample/ui":"unreviewed"}',
        '{"@sample/ui":"solid-js","@sample/ui":"solid-js"}',
        '{"@sample/ui":"solid-js","@sample/\\u0075i":"solid-js"}',
        '{"@sample/ui":"solid-js"} trailing',
        '{"@sample/ui":"solid-js"',
        "[" * 1100 + "]" * 1100,
    ],
)
def test_rc_rejects_unknown_null_and_duplicate_raw_alias_config(value, tmp_path):
    (tmp_path / ".graphifyrc").write_text(f"semantic_module_aliases={value}\n", encoding="utf-8")
    with pytest.raises(analysis.FrameworkAnalysisError, match="configuration"):
        analysis.options_for_root(tmp_path)


def test_rc_repeated_alias_setting_is_not_last_wins(tmp_path):
    (tmp_path / ".graphifyrc").write_text(
        "semantic_module_aliases={}\nsemantic_module_aliases={}\n", encoding="utf-8"
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="configuration"):
        analysis.options_for_root(tmp_path)


def test_alias_configuration_is_effective_fingerprint_input_not_source_rewriting(tmp_path):
    path = tmp_path / ".graphifyrc"
    first = {"@sample/ui": "@fst/components-fst-solid", "@sample/reactive": "solid-js"}
    path.write_text("semantic_module_aliases=" + json.dumps(first), encoding="utf-8")
    configured = analysis.analysis_fingerprint(options=analysis.options_for_root(tmp_path))
    assert configured != analysis.analysis_fingerprint()
    path.write_text(
        "# same effective map\nsemantic_module_aliases="
        + json.dumps(dict(reversed(list(first.items())))),
        encoding="utf-8",
    )
    assert analysis.analysis_fingerprint(options=analysis.options_for_root(tmp_path)) == configured
    path.write_text(
        'semantic_module_aliases={"@sample/ui":"@fst/components-fst-solid"}', encoding="utf-8"
    )
    assert analysis.analysis_fingerprint(options=analysis.options_for_root(tmp_path)) != configured
    for options in [False, [], {"moduleAliases": None}, {"unknown": True}]:
        with pytest.raises(analysis.FrameworkAnalysisError):
            analysis.analysis_fingerprint(options=options)


@pytest.mark.parametrize("specifier", ["@sample/ui/solid-js", "@sample/u\\u0069/solid-js"])
def test_real_worker_alias_configuration_preserves_unicode_source_and_import_evidence(
    specifier, tmp_path
):
    root = tmp_path / "project"
    folder = root / "nested"
    folder.mkdir(parents=True)
    aliases = {"@sample/ui": "@fst/components-fst-solid"}
    (root / ".graphifyrc").write_text(
        "semantic_module_aliases=" + json.dumps(aliases), encoding="utf-8"
    )
    # The project root, not a watched subfolder or an application naming pattern,
    # selects the single explicit API contract configuration.
    (folder / ".graphifyrc").write_text("semantic_module_aliases={}", encoding="utf-8")
    source = '\ufeff// \U0001f680\r\nimport {onMount as mount} from "@sample/ui/solid-js";\r\nexport function setup(){mount(()=>{});}\r\n'
    source = source.replace("@sample/ui/solid-js", specifier)
    file = folder / "app.tsx"
    file.write_bytes(source.encode())
    original_hash = hashlib.sha256(source.encode()).hexdigest()
    document = analysis.make_document(source, "nested/app.tsx", "tsx")
    default = analysis.analyze_documents([document])
    assert not [
        fact
        for fact in default["documents"]["nested/app.tsx"]["result"]["facts"]
        if fact["term"] == "solid.api-call"
    ]
    store = analysis.analyze_paths([file], root)
    assert store is not None and set(store["documents"]) == {"nested/app.tsx"}
    entry = store["documents"]["nested/app.tsx"]
    assert entry["source"] == source
    assert entry["result"]["sourceHash"] == original_hash
    assert file.read_bytes() == source.encode()
    assert specifier in entry["source"] and "@fst/components" not in entry["source"]
    calls = [fact for fact in entry["result"]["facts"] if fact["term"] == "solid.api-call"]
    assert len(calls) == 1
    span = calls[0]["evidence"]["span"]
    assert source.encode()[span["startByte"] : span["endByte"]] == b"mount(()=>{})"
    manifest = next(iter(store["manifests"].values()))
    configuration_digest = hashlib.sha256(
        canonical_json(analysis.options_for_root(root)).encode()
    ).hexdigest()
    for descriptor in [manifest["core"], manifest["view"], *manifest["plugins"]]:
        assert descriptor["configurationDigest"] == configuration_digest
    assert manifest["id"] not in default["manifests"]
    payload = analysis._run_worker(_request([document], options=analysis.options_for_root(root)))
    assert payload["producer"]["configuration"] == {"moduleAliases": aliases}
    assert payload["documents"][0]["source"] == source


@pytest.mark.parametrize("change", ["different", "delete", "invalid"])
def test_alias_config_change_during_analysis_fails_closed(change, tmp_path, monkeypatch):
    file, rc = tmp_path / "source.ts", tmp_path / ".graphifyrc"
    file.write_bytes(b"const value=1;")
    rc.write_text('semantic_module_aliases={"@sample/ui":"solid-js"}', encoding="utf-8")

    def run(documents, *, options):
        assert options["moduleAliases"] == {"@sample/ui": "solid-js"}
        if change == "delete":
            rc.unlink()
        else:
            rc.write_text(
                "semantic_module_aliases=" + ("{}" if change == "different" else "null"),
                encoding="utf-8",
            )
        return {"version": 1, "manifests": {}, "producers": {}, "documents": {}}

    monkeypatch.setattr(analysis, "analyze_documents", run)
    with pytest.raises(analysis.FrameworkAnalysisError, match="configuration"):
        analysis.analyze_paths([file], tmp_path)


def test_valid_response_with_different_alias_assumptions_is_not_accepted(monkeypatch):
    payload = analysis._run_worker(_request(options={"moduleAliases": {"@sample/ui": "solid-js"}}))
    validate_payload(payload)
    monkeypatch.setattr(analysis, "_run_worker", lambda *args, **kwargs: payload)
    with pytest.raises(
        analysis.FrameworkAnalysisError, match="changed the requested analysis contract"
    ):
        analysis.analyze_documents([])


def test_old_limits_only_producer_shape_has_no_response_fallback(monkeypatch, manifest_payload):
    payload = copy.deepcopy(manifest_payload)
    del payload["producer"]["configuration"]
    monkeypatch.setattr(analysis, "_run_worker", lambda *args, **kwargs: payload)
    with pytest.raises(analysis.FrameworkAnalysisError, match="invalid evidence"):
        analysis.analyze_documents([])


def test_fingerprint_covers_owned_normalizer_and_shared_catalog(tmp_path, monkeypatch):
    from graphify import framework_config

    normalizer = tmp_path / "framework_config.py"
    catalog = tmp_path / "semantic_node" / "module_catalog.json"
    catalog.parent.mkdir()
    normalizer.write_bytes(b"normalizer-version-one")
    catalog.write_bytes(b'{"MODULE_FAMILIES":[],"MODULE_ALIAS_TARGETS":[]}')
    monkeypatch.setattr(framework_config, "__file__", str(normalizer))
    first = analysis.analysis_fingerprint()
    normalizer.write_bytes(b"normalizer-version-two")
    second = analysis.analysis_fingerprint()
    catalog.write_bytes(catalog.read_bytes() + b"\n")
    assert len({first, second, analysis.analysis_fingerprint()}) == 3


def test_implementation_change_during_analysis_is_not_returned(tmp_path, monkeypatch):
    file = tmp_path / "source.ts"
    file.write_bytes(b"const value=1;")
    fingerprints = iter(["before", "after"])
    monkeypatch.setattr(analysis, "analysis_fingerprint", lambda **kwargs: next(fingerprints))
    monkeypatch.setattr(
        analysis,
        "analyze_documents",
        lambda *args, **kwargs: {"version": 1, "manifests": {}, "producers": {}, "documents": {}},
    )
    with pytest.raises(analysis.FrameworkAnalysisError, match="implementation changed"):
        analysis.analyze_paths([file], tmp_path)


@pytest.mark.skipif(analysis.os.name != "nt", reason="Windows corpus identity case rules")
def test_duplicate_windows_path_case_does_not_duplicate_evidence(
    tmp_path, monkeypatch, manifest_payload
):
    file = tmp_path / "source.ts"
    file.write_bytes(b"const value=1;")
    captured = []

    def run(documents, **kwargs):
        captured.extend(documents)
        return validate_payload(_payload(manifest_payload, documents))

    monkeypatch.setattr(analysis, "analyze_documents", run)
    result = analysis.analyze_paths([file, file.with_name("SOURCE.ts")], tmp_path)
    assert result is not None and set(result["documents"]) == {"source.ts"}
    assert len(captured) == 1
