"""Provider-free, one-shot candidate producer for a native publication owner.

Protocol v1 uses exact-byte SHA256 file/artifact hashes. inputDigest is SHA256
of UTF-8-path-byte-sorted rows: path NUL sha256 NUL decimal-bytes NUL kind LF.
Only the native parent may publish a current pointer or acknowledge freshness.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import sys


VERSION = 1
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_GRAPH_BYTES = 512 * 1024 * 1024
MAX_FILES = 10_000
IDENTITY_FIELDS = ("projectId", "rootId", "rootIdentity", "sourceRoot")
DIGEST_FIELDS = ("bundleDigest", "policyDigest", "inputDigest")
FILE_FIELDS = ("path", "sha256", "bytes", "kind")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_CONTROL = re.compile(r"(?:\.gitignore|\.graphifyrc|package\.json|(?:ts|js)config[^/]*\.json)\Z", re.I)
PROGRESS_PREFIX = "GRAPHIFY_PROGRESS_V1 "
MAX_PROGRESS_BYTES = 64 * 1024 * 1024
MAX_PROGRESS_EVENTS = 5 * MAX_FILES + 32
MAX_PROGRESS_LINE = 32 * 1024


class _Progress:
    """Diagnostic observations only. The native owner alone can publish/complete."""
    def __init__(self, stream, job_id):
        self.stream = stream
        self.job_id = job_id if isinstance(job_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id) else ""
        self.remaining, self.events = MAX_PROGRESS_BYTES, 0
        self.gap = False

    def emit(self, phase, *, total=0, selected=0, reused=0, completed=0, failed=0,
             path="", state="", native="", nodes=0, edges=0, pass_id=0):
        if (not self.job_id
                or phase not in {"snapshot", "extract", "reuse", "merge", "validate", "candidate", "file_started", "file_completed", "file_reused"}
                or any(type(n) is not int or not 0 <= n <= MAX_FILES for n in (total, selected, reused, completed, failed))
                or selected + reused > total or completed > selected or failed > completed
                or path and not _relative(path)):
            return
        record = {"version": 1, "jobId": self.job_id, "phase": phase, "total": total,
                  "selected": selected, "reused": reused, "completed": completed, "failed": failed, "pass": pass_id}
        if path:
            record.update(path=path, state=state, native=native, nodes=nodes, edges=edges)
        line = PROGRESS_PREFIX + json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"
        # Reserve a final compact checkpoint and an explicit gap. No raw parser
        # text or partial record is ever forwarded when a budget is exhausted.
        terminal = phase in {"validate", "candidate"}
        if len(line) > MAX_PROGRESS_LINE or not terminal and (self.events >= MAX_PROGRESS_EVENTS - 3 or len(line) > self.remaining - 4096):
            if not self.gap:
                self.gap = True
                self._write(PROGRESS_PREFIX + json.dumps({"version": 1, "jobId": self.job_id, "phase": "gap",
                            "total": total, "selected": selected, "reused": reused, "completed": completed,
                            "failed": failed, "pass": pass_id}, separators=(",", ":")) + "\n")
            return
        self._write(line)

    def _write(self, line):
        if len(line) > self.remaining:
            return
        self.remaining -= len(line)
        self.events += 1
        try:
            self.stream.write(line)
            self.stream.flush()
        except (OSError, ValueError):
            self.remaining = 0


class WorkerError(ValueError):
    def __init__(self, code: str, message: str, status="blocked"):
        super().__init__(message)
        self.code, self.status = code, status


def _json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise WorkerError("invalid_json", "Duplicate JSON object key")
        value[key] = item
    return value


def _decode(data: bytes):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite number")))
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise WorkerError("invalid_json", "Expected bounded, strict UTF-8 JSON") from exc


def _text(value, *, limit=4096) -> bool:
    try:
        return isinstance(value, str) and 0 < len(value.encode("utf-8")) <= limit and not any(ord(c) < 32 or ord(c) == 127 for c in value)
    except UnicodeError:
        return False


def _relative(value) -> bool:
    if not _text(value) or any(c in value for c in '\\:<>"|?*') or value.startswith("/"):
        return False
    parts = value.split("/")
    return all(_component(part) for part in parts)


def _component(value: str) -> bool:
    stem = value.split(".", 1)[0].rstrip(" ")
    return (value not in {"", ".", ".."} and not value.endswith((".", " "))
            and not any(c in value for c in '\\/:<>"|?*')
            and not re.fullmatch(r"(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9\u00b9\u00b2\u00b3])", stem, re.I))


def input_digest(files: list[dict]) -> str:
    digest = hashlib.sha256()
    for row in sorted(files, key=lambda item: item["path"].encode("utf-8")):
        digest.update((row["path"] + "\0" + row["sha256"] + "\0" + str(row["bytes"])
                       + "\0" + row["kind"] + "\n").encode("utf-8"))
    return digest.hexdigest()


def _inventory(value, *, states=False) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_FILES:
        raise WorkerError("input_limit", "Inventory must contain at most 10000 files")
    result, seen, total = [], set(), 0
    for row in value:
        expected = set(FILE_FIELDS) | ({"structuralState", "nativeState"} if states else set())
        if not isinstance(row, dict) or set(row) != expected or not _relative(row.get("path")):
            raise WorkerError("invalid_inventory", "Invalid source inventory row or relative path")
        key = row["path"].casefold()
        if key in seen:
            raise WorkerError("invalid_inventory", "Duplicate or case-aliased source path")
        seen.add(key)
        if not isinstance(row["sha256"], str) or not _SHA256.fullmatch(row["sha256"]):
            raise WorkerError("invalid_inventory", "File SHA256 must be lowercase hexadecimal")
        if type(row["bytes"]) is not int or not 0 <= row["bytes"] <= MAX_FILE_BYTES:
            raise WorkerError("input_limit", "Source byte limit exceeded")
        total += row["bytes"]
        suffix, name = PurePosixPath(row["path"]).suffix.lower(), PurePosixPath(row["path"]).name
        if not ((row["kind"] == "code" and suffix in {".ts", ".tsx"})
                or (row["kind"] == "document" and suffix == ".md")
                or (row["kind"] == "control" and _CONTROL.fullmatch(name))):
            raise WorkerError("unsupported_source", "Only TS, TSX, Markdown and explicit resolver controls are supported")
        if states and (not isinstance(row["structuralState"], str) or not isinstance(row["nativeState"], str)
                       or row["structuralState"] not in {"complete", "failed"}
                       or row["nativeState"] not in {"complete", "partial", "missing", "not_applicable"}):
            raise WorkerError("previous_invalid", "Invalid source coverage state")
        result.append(dict(row))
    if total > MAX_INPUT_BYTES:
        raise WorkerError("input_limit", "Total snapshot byte limit exceeded")
    return sorted(result, key=lambda row: row["path"].encode("utf-8"))


def _local_path(value) -> Path:
    if not _text(value) or not Path(value).is_absolute() or str(value).startswith(("\\\\", "//")):
        raise WorkerError("unsafe_path", "Expected an absolute local path")
    path = Path(value)
    if os.name == "nt" and any(not _component(part) for part in path.parts[1:]):
        raise WorkerError("unsafe_path", "Expected unambiguous local path components")
    return Path(os.path.abspath(path))


def _io_path(path: Path) -> Path:
    """Use the Windows I/O namespace only after local-path admission."""
    if os.name != "nt":
        return path
    if not re.fullmatch(r"[A-Za-z]:", path.drive) or path.root != "\\":
        raise WorkerError("unsafe_path", "Expected a local drive path")
    return Path("\\\\?\\" + str(path))


def _check_private_path(path: Path, *, directory=False) -> Path:
    # Only admitted I/O paths and validated relative inventory paths reach here.
    for candidate in reversed((path, *path.parents)):
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise WorkerError("unsafe_path", "Reparse points and symbolic links are forbidden")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise WorkerError("unsafe_path", "Expected an existing private directory")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise WorkerError("unsafe_path", "Expected a regular file with one link")
    return path


def _safe_path(value, *, directory=False) -> Path:
    return _check_private_path(_io_path(_local_path(value)), directory=directory)


def _read_file(path: Path, limit: int) -> bytes:
    return _read_private_file(_safe_path(str(path)), limit)


def _read_private_file(path: Path, limit: int) -> bytes:
    _check_private_path(path)
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise WorkerError("input_limit", "File exceeds the worker byte limit")
    return data


def _descriptor(path: str, data: bytes) -> dict:
    return {"path": path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def _validate_request(request: dict) -> tuple[list[dict], Path, Path, Path]:
    required = {"version", "jobId", *IDENTITY_FIELDS, *DIGEST_FIELDS,
                "inputRoot", "outputDir", "cacheDir", "files"}
    if not isinstance(request, dict) or set(request) - {"previous"} != required or type(request["version"]) is not int or request["version"] != VERSION:
        raise WorkerError("invalid_request", "Unsupported worker request schema")
    if any(not _text(request[key]) for key in ("jobId", *IDENTITY_FIELDS)):
        raise WorkerError("invalid_request", "Missing or invalid request identity")
    if not (Path(request["sourceRoot"]).is_absolute() or PureWindowsPath(request["sourceRoot"]).is_absolute()):
        raise WorkerError("invalid_request", "Logical sourceRoot must be absolute")
    if any(not isinstance(request[key], str) or not _SHA256.fullmatch(request[key]) for key in DIGEST_FIELDS):
        raise WorkerError("invalid_request", "Invalid request digest")
    files = _inventory(request["files"])
    if input_digest(files) != request["inputDigest"]:
        raise WorkerError("input_digest_mismatch", "Inventory does not match inputDigest")
    root, output, cache = (_safe_path(request[key], directory=True) for key in ("inputRoot", "outputDir", "cacheDir"))
    directories = (root, output, cache)
    logical = _io_path(_local_path(request["sourceRoot"]))
    if any(a.is_relative_to(b) for a in directories for b in directories if a != b) or len(set(directories)) != 3:
        raise WorkerError("unsafe_path", "Input, output and cache directories must be disjoint")
    if any(path.is_relative_to(logical) or logical.is_relative_to(path) for path in directories):
        raise WorkerError("unsafe_path", "Private worker directories must be separate from the logical workspace")
    if any(output.iterdir()):
        raise WorkerError("output_not_empty", "Candidate output directory must be empty")
    previous = request.get("previous")
    if previous is not None:
        if not isinstance(previous, dict) or set(previous) != {"graphPath", "manifestPath", "graphSha256", "manifestSha256"}:
            raise WorkerError("invalid_request", "Invalid previous artifact descriptor")
        for key in ("graphSha256", "manifestSha256"):
            if not isinstance(previous[key], str) or not _SHA256.fullmatch(previous[key]):
                raise WorkerError("invalid_request", "Invalid previous artifact digest")
        for key in ("graphPath", "manifestPath"):
            path = _safe_path(previous[key])
            if any(path.is_relative_to(directory) for directory in directories) or path.is_relative_to(logical):
                raise WorkerError("unsafe_path", "Previous artifacts must be separate immutable inputs")
    return files, root, output, cache


def _snapshot(root: Path, files: list[dict]) -> dict[str, bytes]:
    expected = {row["path"]: row for row in files}
    found = set()
    stack = [root]
    entries = 0
    while stack:
        directory = stack.pop()
        for path in directory.iterdir():
            entries += 1
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise WorkerError("unsafe_snapshot", "Snapshot contains a link or reparse point")
            if stat.S_ISDIR(info.st_mode):
                stack.append(path)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                found.add(path.relative_to(root).as_posix())
            else:
                raise WorkerError("unsafe_snapshot", "Snapshot contains a non-regular or multiply-linked file")
            if entries > MAX_FILES * 64:
                raise WorkerError("input_limit", "Snapshot directory limit exceeded")
    if found != set(expected):
        raise WorkerError("snapshot_inventory_mismatch", "Snapshot must contain exactly the admitted inventory")
    captured = {}
    for relative, row in expected.items():
        data = _read_private_file(root / relative, row["bytes"])
        if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise WorkerError("snapshot_hash_mismatch", "Snapshot bytes differ from the admitted inventory")
        captured[relative] = data
    return captured


def _validate_cache(cache: Path) -> None:
    total, count, stack = 0, 0, [cache]
    while stack:
        for path in stack.pop().iterdir():
            count += 1
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise WorkerError("unsafe_cache", "Cache contains a link or reparse point")
            if stat.S_ISDIR(info.st_mode):
                stack.append(path)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                total += info.st_size
            else:
                raise WorkerError("unsafe_cache", "Cache contains a non-regular or multiply-linked file")
            if total > MAX_INPUT_BYTES or count > MAX_FILES * 64:
                raise WorkerError("cache_limit", "Cache exceeds the worker resource limit")


def _native_state(entry, row) -> str:
    if not entry or entry.get("refreshFailed"):
        return "missing"
    result = entry["result"]
    source_hash = entry.get("redaction", {}).get("originalSourceHash", result["sourceHash"])
    if source_hash != row["sha256"]:
        return "missing"
    states = [result, *result["reports"]]
    return "complete" if all(item["state"] in {"complete", "not-applicable"} and not item["diagnostics"] for item in states) else "partial"


def _validate_graph(data, files: list[dict]) -> dict:
    from graphify.framework_pipeline import evidence_from_data

    if not isinstance(data, dict) or any(not isinstance(data.get(key), list) for key in ("nodes", "links", "hyperedges")):
        raise WorkerError("graph_invalid", "Graph lists are missing or invalid")
    if type(data.get("directed")) is not bool or type(data.get("multigraph")) is not bool or not isinstance(data.get("graph"), dict):
        raise WorkerError("graph_invalid", "Graph metadata is missing or invalid")
    sources = {row["path"] for row in files if row["kind"] != "control"}
    ids, represented = set(), set()
    for node in data["nodes"]:
        if not isinstance(node, dict) or not _text(node.get("id")) or node["id"] in ids:
            raise WorkerError("graph_invalid", "Graph node IDs must be unique nonempty strings")
        ids.add(node["id"])
        source = node.get("source_file")
        if source:
            if not isinstance(source, str) or source not in sources:
                raise WorkerError("graph_invalid", "Graph node is owned by an unadmitted source")
            if node.get("_origin") == "ast" and node.get("label") == PurePosixPath(source).name:
                represented.add(source)
        elif not node.get("external") and node.get("type") != "external":
            raise WorkerError("graph_invalid", "Non-external graph node lacks source ownership")
    for edge in data["links"]:
        if not isinstance(edge, dict) or not _text(edge.get("source")) or not _text(edge.get("target")) or edge["source"] not in ids or edge["target"] not in ids or not _text(edge.get("relation")):
            raise WorkerError("graph_invalid", "Graph edge has invalid endpoints or relation")
        if edge.get("source_file") not in sources:
            raise WorkerError("graph_invalid", "Graph edge is owned by an unadmitted source")
    for group in data["hyperedges"]:
        if not isinstance(group, dict) or group.get("source_file") not in sources or not isinstance(group.get("nodes"), list) or any(not isinstance(n, str) or n not in ids for n in group["nodes"]):
            raise WorkerError("graph_invalid", "Graph hyperedge has invalid participants")
    try:
        evidence = evidence_from_data(data)
    except ValueError as exc:
        raise WorkerError("graph_invalid", "Invalid typed native evidence") from exc
    documents = (evidence or {}).get("documents", {})
    code = {row["path"] for row in files if row["kind"] == "code"}
    if set(documents) - code:
        raise WorkerError("graph_invalid", "Native evidence is owned by an unadmitted code source")
    return {"represented": represented, "documents": documents}


def _previous(request: dict):
    previous = request.get("previous")
    if previous is None:
        return None, None, None
    try:
        graph_bytes = _read_file(Path(previous["graphPath"]), MAX_GRAPH_BYTES)
        manifest_bytes = _read_file(Path(previous["manifestPath"]), MAX_REQUEST_BYTES)
        if hashlib.sha256(graph_bytes).hexdigest() != previous["graphSha256"] or hashlib.sha256(manifest_bytes).hexdigest() != previous["manifestSha256"]:
            raise ValueError("Previous digest mismatch")
        graph, manifest = _decode(graph_bytes), _decode(manifest_bytes)
        if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != VERSION or any(manifest.get(key) != request[key] for key in IDENTITY_FIELDS):
            raise ValueError("Previous identity mismatch")
        if any(not isinstance(manifest.get(key), str) or not _SHA256.fullmatch(manifest[key])
               for key in (*DIGEST_FIELDS, "workerFingerprint")):
            raise ValueError("Previous fingerprint missing")
        files = _inventory(manifest.get("files"), states=True)
        if manifest.get("inputDigest") != input_digest(files) or manifest.get("graph") != _descriptor("graph.json", graph_bytes):
            raise ValueError("Previous manifest mismatch")
        state = _validate_graph(graph, files)
        if graph["graph"].get("worker") != {"version": VERSION, **{key: request[key] for key in IDENTITY_FIELDS}}:
            raise ValueError("Previous graph identity mismatch")
        for row in files:
            if row["kind"] != "control" and row["structuralState"] == "complete" and row["path"] not in state["represented"]:
                raise ValueError("Previous structural coverage missing")
            actual_native = _native_state(state["documents"].get(row["path"]), row) if row["kind"] == "code" else "not_applicable"
            if row["nativeState"] != actual_native:
                raise ValueError("Previous native coverage mismatch")
        complete = all(row["structuralState"] == "complete" and row["nativeState"] in {"complete", "not_applicable"} for row in files)
        if type(manifest.get("complete")) is not bool or manifest["complete"] != complete:
            raise ValueError("Previous completeness mismatch")
        manifest["files"] = files
        return graph, manifest, graph_bytes
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise WorkerError("previous_invalid", "Previous graph/manifest failed digest, ownership or completeness validation") from exc


def _fingerprint(root: Path) -> str:
    from graphify.native_annotations import analysis_fingerprint, options_for_root

    digest = hashlib.sha256(analysis_fingerprint(options=options_for_root(root)).encode("ascii"))
    package = Path(__file__).parent
    for relative in ("worker.py", "input_snapshot.py", "rcfile.py", "ids.py", "extractors/resolution.py",
                     "extractors/markdown.py", "markdown_resolution.py"):
        digest.update(relative.encode("ascii") + b"\0" + (package / relative).read_bytes())
    return digest.hexdigest()


def _coverage(files, selected=0, reused=0, deleted=0) -> dict:
    return {"total": len(files), "code": sum(row["kind"] == "code" for row in files),
            "documents": sum(row["kind"] == "document" for row in files),
            "controls": sum(row["kind"] == "control" for row in files),
            "selected": selected, "reused": reused, "deleted": deleted,
            "failed": sum(row.get("structuralState") == "failed" for row in files),
            "nativeComplete": sum(row.get("nativeState") == "complete" for row in files),
            "nativePartial": sum(row.get("nativeState") == "partial" for row in files),
            "nativeMissing": sum(row.get("nativeState") == "missing" for row in files),
            "structuralComplete": all(row.get("structuralState") == "complete" for row in files)}


def _extract_candidate(request, files, root, cache, previous_graph, previous_manifest, fingerprint, progress):
    from graphify.build import dedupe_edges, dedupe_nodes, finalize_raw_graph_endpoints, has_parallel_links, merge_raw_extraction
    from graphify.extract import extract
    from graphify.framework_pipeline import pack_raw_evidence
    from graphify.markdown_resolution import DOCUMENTATION_EDGE_PRODUCER

    current = {row["path"]: row for row in files}
    prior = {row["path"]: row for row in (previous_manifest or {}).get("files", [])}
    deleted = set(prior) - set(current)
    changed = {path for path, row in current.items() if any(prior.get(path, {}).get(key) != row[key] for key in FILE_FIELDS)}
    compatible = previous_manifest is not None and previous_manifest.get("workerFingerprint") == fingerprint and all(
        previous_manifest.get(key) == request[key] for key in ("bundleDigest", "policyDigest"))
    control_change = any(current.get(path, prior.get(path))["kind"] == "control" for path in changed | deleted)
    sources = {path for path, row in current.items() if row["kind"] != "control"}
    selected = sources if not compatible or control_change else changed & sources
    selected = set(selected)
    selected.update(path for path in sources if prior.get(path, {}).get("structuralState") != "complete"
                    or prior.get(path, {}).get("nativeState") not in {"complete", "not_applicable"})
    old_code = {path for path, row in prior.items() if row["kind"] == "code"}
    new_code = {path for path, row in current.items() if row["kind"] == "code"}
    if old_code != new_code:
        selected.update(new_code)
    # Inbound structural dependencies must be refreshed if a callee changes.
    nodes = (previous_graph or {}).get("nodes", [])
    edges = (previous_graph or {}).get("links", [])
    owners = {node["id"]: node.get("source_file") for node in nodes}
    dependencies = {}
    for edge in edges:
        target, owner = owners.get(edge["target"]), edge.get("source_file")
        if owner in new_code and target and owner != target:
            dependencies.setdefault(target, set()).add(owner)
    pending = list(selected | deleted)
    while pending:
        for owner in dependencies.get(pending.pop(), set()) - selected:
            selected.add(owner)
            pending.append(owner)
    pass_id = 0
    observed_states = {}
    def parse_selected():
        nonlocal pass_id
        pass_id += 1
        observed_states.clear()
        reused = sources - selected
        completed, failures = set(), set()
        counts = {"total": len(sources), "selected": len(selected), "pass_id": pass_id}
        progress.emit("extract", **counts)
        for number, path in enumerate(sorted(reused), 1):
            progress.emit("file_reused", **counts, reused=number, path=path, state="reused", native=prior[path]["nativeState"])

        def file_progress(path, result):
            relative = path.relative_to(root).as_posix()
            if relative not in selected:
                raise WorkerError("extraction_invalid", "Extractor observed an unselected source", "failed")
            if result is None:
                progress.emit("file_started", **counts, reused=len(reused), completed=len(completed), failed=len(failures),
                              path=relative, state="processing")
                return
            completed.add(relative)
            structural = "failed" if result.get("error") or not result.get("nodes") else "complete"
            native = _native_state(result.get("_annotation"), current[relative]) if current[relative]["kind"] == "code" else "not_applicable"
            if structural == "failed":
                failures.add(relative)
            state = "failed" if structural == "failed" else "complete" if native in {"complete", "not_applicable"} else "partial"
            observed_states[relative] = state
            progress.emit("file_completed", **counts, reused=len(reused), completed=len(completed), failed=len(failures),
                          path=relative, state=state, native=native, nodes=len(result.get("nodes", [])), edges=len(result.get("edges", [])))

        context_nodes = [node for node in nodes if node.get("source_file") in reused]
        context_edges = [edge for edge in edges if edge.get("source_file") in reused
                         and edge.get("_generated_by") != DOCUMENTATION_EDGE_PRODUCER]
        return extract([root / path for path in sorted(selected)], root=root, cache_root=cache,
                       framework_root=root, parallel=False, max_workers=1,
                       resolution_context_nodes=context_nodes, resolution_context_edges=context_edges,
                       file_progress=file_progress) if selected else {
                           "nodes": [], "edges": [], "extracted_sources": [], "failed_sources": []}

    result = parse_selected()
    if new_code - selected:
        # A changed declaration set can make previously unique/unresolved names
        # ambiguous even without an old dependency edge. Rebind all code then.
        def declarations(items):
            return {_json_bytes({key: node.get(key) for key in
                                 ("id", "label", "_callable", "_callable_class", "_ts_fields", "_ts_static_fields")})
                    for node in items if node.get("source_file") in selected & new_code}

        if declarations(nodes) != declarations(result["nodes"]):
            selected.update(new_code)
            result = parse_selected()
    reused = sources - selected
    failed = set()
    for path in result.get("failed_sources", []):
        relative = Path(path).relative_to(root).as_posix() if Path(path).is_absolute() else path
        if relative not in selected:
            raise WorkerError("extraction_invalid", "Extractor reported an unselected failure", "failed")
        failed.add(relative)
    produced = set()
    for path in result.get("extracted_sources", []):
        relative = Path(path).relative_to(root).as_posix() if Path(path).is_absolute() else path
        produced.add(relative)
    if produced & failed or produced | failed != selected:
        raise WorkerError("extraction_invalid", "Extractor did not account for every selected source", "failed")
    progress.emit("merge", total=len(sources), selected=len(selected), reused=len(reused), completed=len(selected), failed=len(failed), pass_id=pass_id)
    if previous_graph is not None:
        result = merge_raw_extraction(result, request["previous"]["graphPath"], root=root,
                                      prune_sources=sorted(deleted), previous_data=previous_graph)
    result["edges"] = [edge for edge in result.get("edges", []) if edge.get("_generated_by") != DOCUMENTATION_EDGE_PRODUCER]
    links = dedupe_edges(result["edges"])
    graph = {"nodes": dedupe_nodes(result["nodes"]), "links": links, "hyperedges": list(result.get("hyperedges", [])),
             "directed": True, "multigraph": has_parallel_links(links, directed=True),
             "graph": {"worker": {"version": VERSION, **{key: request[key] for key in IDENTITY_FIELDS}}}}
    if "semantic_evidence" in result:
        graph["semantic_evidence"] = result["semantic_evidence"]
    finalize_raw_graph_endpoints(graph, root=root)
    pack_raw_evidence(graph)
    graph["nodes"].sort(key=lambda node: node["id"])
    graph["links"].sort(key=_json_bytes)
    graph["hyperedges"].sort(key=_json_bytes)
    graph["multigraph"] = has_parallel_links(graph["links"], directed=True)
    state = _validate_graph(graph, files)
    manifest_files = []
    for row in files:
        path = row["path"]
        structural = "failed" if path in failed or (row["kind"] != "control" and path not in state["represented"]) else "complete"
        native = _native_state(state["documents"].get(path), row) if row["kind"] == "code" else "not_applicable"
        manifest_files.append({**row, "structuralState": structural, "nativeState": native})
    # Merging/validation can change coverage; this checkpoint corrects the
    # per-file observation without counting the source a second time.
    failed_count = sum(row["structuralState"] == "failed" for row in manifest_files)
    for row in manifest_files:
        if row["path"] in selected:
            state = "failed" if row["structuralState"] == "failed" else "complete" if row["nativeState"] in {"complete", "not_applicable"} else "partial"
            if observed_states.get(row["path"]) != state:
                progress.emit("file_completed", total=len(sources), selected=len(selected), reused=len(reused), completed=len(selected),
                              failed=failed_count, pass_id=pass_id, path=row["path"], state=state, native=row["nativeState"])
    return graph, manifest_files, _coverage(manifest_files, len(selected), len(reused), len(deleted))


def run_request(request: dict, *, progress=None) -> dict:
    """Produce artifacts in an empty private output directory; never publish."""
    result = {"version": VERSION, "jobId": "", "rootId": "", "bundleDigest": "", "policyDigest": "", "inputDigest": "",
              "status": "failed", "coverage": {**_coverage([]), "structuralComplete": False}}
    if isinstance(request, dict):
        for key in ("jobId", "rootId", *DIGEST_FIELDS):
            if _text(request.get(key)):
                result[key] = request[key]
    progress = progress or _Progress(sys.stderr, result["jobId"])
    phase = "request"
    try:
        files, root, output, cache = _validate_request(request)
        progress.emit("snapshot", total=sum(row["kind"] != "control" for row in files))
        result["coverage"] = {**_coverage(files), "structuralComplete": False}
        phase = "cache"
        _validate_cache(cache)
        phase = "snapshot"
        captured = _snapshot(root, files)
        phase = "previous"
        previous_graph, previous_manifest, previous_bytes = _previous(request)
        capabilities()
        from graphify.input_snapshot import admitted_snapshot
        phase = "extract"
        with admitted_snapshot(root, captured, cache):
            from graphify.rcfile import load_graphifyrc
            if load_graphifyrc(root).get("languages"):
                raise WorkerError("unsupported_configuration", "Worker language remapping is not supported")
            from graphify.extractors.resolution import _strip_jsonc
            for row in files:
                if row["kind"] == "control" and row["path"].lower().endswith(".json"):
                    try:
                        configuration = _decode(_strip_jsonc(captured[row["path"]].decode("utf-8-sig")).encode("utf-8"))
                        if not isinstance(configuration, dict) or not isinstance(configuration.get("compilerOptions", {}), dict):
                            raise ValueError("Invalid resolver configuration")
                    except (UnicodeError, ValueError) as exc:
                        raise WorkerError("invalid_configuration", "An admitted resolver control is not a valid JSON/JSONC object") from exc
            fingerprint = _fingerprint(root)
            unchanged = previous_manifest is not None and previous_manifest["complete"] and all(
                previous_manifest.get(key) == request[key] for key in DIGEST_FIELDS
            ) and previous_manifest.get("workerFingerprint") == fingerprint
            if unchanged:
                manifest_files = previous_manifest["files"]
                graph_bytes = previous_bytes
                coverage = _coverage(manifest_files, reused=sum(row["kind"] != "control" for row in files))
                progress.emit("reuse", total=coverage["reused"])
                for number, row in enumerate((row for row in manifest_files if row["kind"] != "control"), 1):
                    progress.emit("file_reused", total=coverage["reused"], reused=number, path=row["path"],
                                  state="reused", native=row["nativeState"])
            else:
                graph, manifest_files, coverage = _extract_candidate(
                    request, files, root, cache, previous_graph, previous_manifest, fingerprint, progress)
                graph_bytes = _json_bytes(graph)
        progress.emit("validate", total=coverage["code"] + coverage["documents"],
                      selected=coverage["selected"], reused=coverage["reused"],
                      completed=coverage["selected"], failed=coverage["failed"])
        if len(graph_bytes) > MAX_GRAPH_BYTES:
            raise WorkerError("output_limit", "Candidate graph exceeds the worker byte limit")
        # Revalidate private input integrity, but stamp only the admitted hashes.
        # Source parsers consumed captured bytes, never these post-parse reads.
        phase = "snapshot"
        if _snapshot(root, files) != captured:
            raise WorkerError("snapshot_changed", "Private input changed during extraction")
        phase = "cache"
        _validate_cache(cache)
        phase = "output"
        complete = coverage["structuralComplete"] and not coverage["nativeMissing"] and not coverage["nativePartial"]
        graph_descriptor = _descriptor("graph.json", graph_bytes)
        manifest = {"version": VERSION, **{key: request[key] for key in (*IDENTITY_FIELDS, *DIGEST_FIELDS)},
                    "workerFingerprint": fingerprint, "files": manifest_files, "complete": complete, "graph": graph_descriptor}
        manifest_bytes = _json_bytes(manifest)
        if len(manifest_bytes) > MAX_REQUEST_BYTES:
            raise WorkerError("output_limit", "Candidate manifest exceeds the worker byte limit")
        for name, data in (("graph.json", graph_bytes), ("manifest.json", manifest_bytes)):
            with (output / name).open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        result.update(status="verified_unchanged" if unchanged else "candidate_ready" if complete else "partial",
                      coverage=coverage, graph=graph_descriptor, manifest=_descriptor("manifest.json", manifest_bytes))
        progress.emit("candidate", total=coverage["code"] + coverage["documents"],
                      selected=coverage["selected"], reused=coverage["reused"],
                      completed=coverage["selected"], failed=coverage["failed"])
        if not complete:
            result["error"] = {"code": "incomplete_analysis", "message": "Some structural or native source analyses are incomplete"}
    except WorkerError as exc:
        result.update(status=exc.status, error={"code": exc.code, "message": str(exc)[:512]})
    except OSError:
        result.update(status="blocked", error={"code": f"{phase}_io_failed",
                                               "message": f"Private worker {phase} filesystem operation failed"})
    except Exception as exc:
        print(f"Worker failed ({type(exc).__name__})", file=sys.stderr)
        result.update(status="failed", error={"code": "worker_failed", "message": "Worker could not produce a validated candidate"})
    return result


def capabilities() -> dict:
    from importlib.metadata import entry_points
    from graphify.native_annotations import BUILTIN_PLUGINS, parser_descriptor, plugins
    if entry_points(group="graphify.annotations"):
        raise WorkerError("unsupported_plugins", "Worker does not load installed annotation entry points")
    if {plugin.__name__ for plugin in plugins()} != {f"graphify.native_annotations.{name}" for name in BUILTIN_PLUGINS}:
        raise WorkerError("unsupported_plugins", "Only bundled native annotation plugins are supported")
    return {"version": VERSION, "protocolVersion": VERSION, "sourceKinds": ["code", "document", "control"],
            "sourceExtensions": [".ts", ".tsx", ".md"], "providerFree": True, "maxWorkers": 1,
            "clustering": False, "semanticEnrichment": False, "parser": parser_descriptor()}


class _Diagnostics(io.TextIOBase):
    def __init__(self, stream):
        self.stream, self.emitted = stream, False

    def write(self, text):
        # Parser diagnostics can embed source, credentials and private paths.
        # Do not attempt regex redaction of arbitrary diagnostic text.
        if text.strip() and not self.emitted:
            self.emitted = True
            try:
                self.stream.write("GRAPHIFY_DIAGNOSTIC_V1 Diagnostic output withheld for privacy.\n")
                self.stream.flush()
            except (OSError, ValueError):
                pass
        return len(text)

    def flush(self):
        try:
            self.stream.flush()
        except (OSError, ValueError):
            pass


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise WorkerError("invalid_arguments", "Use exactly --capabilities or --request with a private request path")


def main(argv=None) -> int:
    sys.dont_write_bytecode = True
    parser = _ArgumentParser(description=__doc__, add_help=False)
    options = parser.add_mutually_exclusive_group(required=True)
    options.add_argument("--request")
    options.add_argument("--capabilities", action="store_true")
    capability_request = False
    diagnostic_stream = sys.stderr
    diagnostics = _Diagnostics(diagnostic_stream)
    with redirect_stdout(diagnostics), redirect_stderr(diagnostics):
        try:
            args = parser.parse_args(argv)
            capability_request = args.capabilities
            if args.capabilities:
                result = capabilities()
            else:
                request = _decode(_read_file(Path(args.request), MAX_REQUEST_BYTES))
                progress = _Progress(diagnostic_stream, request.get("jobId") if isinstance(request, dict) else None)
                result = run_request(request, progress=progress)
        except Exception as exc:
            result = {"version": VERSION, "jobId": "", "rootId": "", "status": "blocked",
                      "bundleDigest": "", "policyDigest": "", "inputDigest": "", "coverage": {**_coverage([]), "structuralComplete": False},
                      "error": {"code": exc.code if isinstance(exc, WorkerError) else "invalid_request",
                                "message": "Worker request or runtime capability validation failed"}}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":"), allow_nan=False), flush=True)
    return {"candidate_ready": 0, "verified_unchanged": 0, "partial": 2, "blocked": 3}.get(result.get("status"), 0 if capability_request else 1)


if __name__ == "__main__":
    raise SystemExit(main())
