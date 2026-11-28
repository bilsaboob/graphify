"""Native annotation plugins. The extractor depends on this boundary, not rules.

An installed ``graphify.annotations`` entry point may expose a module with
``DESCRIPTOR``, ``analyze(view, budget, emitter)``, and optional ``RETURN_CONTRACTS``
and ``ATOMIC``. Plugins are trusted installed Python code, never loaded from the
indexed project. Their output uses the same validated, source-owned evidence
contract as the built-in plugins. Native trees never leave a per-file worker.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import importlib
from importlib.metadata import entry_points, version
import inspect
from pathlib import Path

from graphify.framework_config import AnalysisOptions, normalize_analysis_options
from graphify.framework_evidence import ANNOTATION_LIMITS, canonical_json


BUILTIN_PLUGINS = ("fst", "solid", "components", "implementation", "transport", "validation", "dispatch")
SUPPORTED_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts"})
_ACTIVE_RUN: ContextVar[AnnotationRun | None] = ContextVar("native_annotation_run", default=None)


class AnnotationError(RuntimeError):
    """An exact, bounded annotation snapshot could not be produced."""


@lru_cache(maxsize=1)
def plugins() -> tuple:
    modules = [importlib.import_module(f"{__name__}.{name}") for name in BUILTIN_PLUGINS]
    modules.extend(point.load() for point in sorted(entry_points(group="graphify.annotations"), key=lambda p: p.name))
    ids = [module.DESCRIPTOR["id"] for module in modules]
    if len(set(ids)) != len(ids):
        raise AnnotationError("Duplicate native annotation plugin identity")
    return tuple(sorted(modules, key=lambda module: module.DESCRIPTOR["id"]))


def options_for_root(root: Path) -> AnalysisOptions:
    from graphify.rcfile import load_graphifyrc

    configuration = load_graphifyrc(root)
    return normalize_analysis_options(
        {"moduleAliases": configuration.get("semantic_module_aliases", {})},
        max_limits=ANNOTATION_LIMITS,
    )


def parser_descriptor() -> dict:
    grammar = version("tree-sitter-typescript")
    if grammar != "0.23.2":
        raise AnnotationError("Installed TypeScript grammar is not qualified for native annotations")
    return {"id": "tree-sitter-typescript", "version": grammar,
            "runtimeVersion": version("tree-sitter"), "coordinateEncoding": "utf8"}


def analysis_fingerprint(*, options: AnalysisOptions | dict | None = None) -> str:
    """Bind plugin code, admission, redaction, parser and configuration to reuse."""
    configuration = normalize_analysis_options(options, max_limits=ANNOTATION_LIMITS)
    package = Path(__file__).parent
    files = set(package.glob("*.py"))
    files.update(Path(inspect.getfile(module)) for module in plugins())
    files.update(package.parent / name for name in (
        "framework_config.py", "framework_evidence.py", "framework_pipeline.py",
        "security.py", "extract.py", "rcfile.py", "watch.py", "build.py",
        "extractors/base.py", "extractors/engine.py", "semantic_node/module_catalog.json",
    ))
    digest = hashlib.sha256(b"graphify.native-annotations.v1\0")
    for path in sorted(files, key=lambda p: (p.name, str(p))):
        digest.update(path.name.encode("utf-8") + b"\0")
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(128 * 1024), b""):
                digest.update(block)
    digest.update(canonical_json(configuration).encode("utf-8"))
    digest.update(canonical_json(parser_descriptor()).encode("utf-8"))
    digest.update(canonical_json([plugin.DESCRIPTOR for plugin in plugins()]).encode("utf-8"))
    return digest.hexdigest()


@dataclass(frozen=True)
class AnnotationRun:
    root: Path
    options: AnalysisOptions
    manifest: dict
    producer: dict


def prepare_run(root: Path, paths: list[Path]) -> AnnotationRun | None:
    from graphify.rcfile import effective_suffix
    from graphify.framework_evidence import _manifest, _producer

    if not any(effective_suffix(path) in SUPPORTED_SUFFIXES for path in paths):
        return None
    root = root.resolve()
    options = options_for_root(root)
    implementation = analysis_fingerprint(options=options)
    configuration = hashlib.sha256(canonical_json(options).encode("utf-8")).hexdigest()
    digests = {"implementationDigest": implementation, "configurationDigest": configuration}
    manifest = {
        "version": 1, "core": {"version": "1", **digests},
        "view": {"id": "typescript", "version": 1, **digests},
        "parserDigest": hashlib.sha256(canonical_json(parser_descriptor()).encode("utf-8")).hexdigest(),
        "plugins": [{**plugin.DESCRIPTOR, **digests} for plugin in plugins()],
        "limits": options["limits"],
    }
    manifest["id"] = hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()
    producer = {"id": "graphify.frameworks", "version": "1", "fingerprint": implementation,
                "configuration": {"moduleAliases": options["moduleAliases"]}}
    _manifest(manifest)
    _producer(producer, manifest)
    return AnnotationRun(root, options, manifest, producer)


def activate(run: AnnotationRun | None):
    return _ACTIVE_RUN.set(run)


def current_run() -> AnnotationRun | None:
    return _ACTIVE_RUN.get()


def deactivate(token) -> None:
    _ACTIVE_RUN.reset(token)


def annotate_parse(path: Path, source: bytes, tree, config, parser) -> dict | None:
    """Consume the existing native parse; only grammar-repaired inputs reparse."""
    from graphify.extractors.base import captured_source
    from graphify.rcfile import effective_suffix

    run = _ACTIVE_RUN.get()
    if run is None or effective_suffix(path) not in SUPPORTED_SUFFIXES:
        return None
    capture = captured_source(path)
    if capture is None or "source" not in capture or not capture.get("exact_utf8"):
        raise AnnotationError("Native evidence requires an exact UTF-8 source capture")
    exact = capture["source"]
    if len(exact) > run.options["limits"]["maxSourceBytes"]:
        raise AnnotationError("Native annotation source exceeds its byte limit")
    # Root aliases are resolved, but in-corpus source aliases remain independent.
    import os
    from graphify.build import _prune_identity
    identity = _prune_identity(os.path.abspath(path), str(run.root))
    if identity is None:
        raise AnnotationError("Annotation source is outside the admitted root")
    try:
        relative = Path(identity).relative_to(run.root).as_posix()
    except (ValueError, TypeError) as exc:
        raise AnnotationError("Annotation source is outside the admitted root") from exc
    language = "tsx" if config.ts_language_fn == "language_tsx" else "typescript"
    if source != exact:
        tree = parser.parse(exact)
    from .runtime import analyze_source
    entry = analyze_source(exact, tree, relative, language, run)
    if capture.get("redaction") is not None:
        entry["redaction"] = capture["redaction"]
    return entry


def collect(run: AnnotationRun | None, results: list[dict]) -> tuple[dict | None, list[tuple[Path, str]]]:
    """Assemble disjoint outputs once; do not re-copy the accumulated corpus."""
    if run is None:
        return None, []
    from graphify.framework_evidence import EvidenceLimits

    documents, snapshots = {}, []
    for result in results:
        entry = result.pop("_annotation", None)
        snapshot = result.pop("_annotation_snapshot", None)
        if entry is None or "error" in result:
            continue
        path = entry["result"]["relativePath"]
        if path in documents and documents[path] != entry:
            raise AnnotationError("Conflicting native source snapshots")
        documents[path] = entry
        if snapshot is not None:
            snapshots.append(snapshot)
    if not documents:
        return None, []
    limits = EvidenceLimits()
    if len(documents) > limits.max_documents:
        raise AnnotationError("Native annotation corpus exceeds its document limit")
    store = {"version": 1, "manifests": {run.manifest["id"]: run.manifest},
             "producers": {run.manifest["id"]: run.producer}, "documents": documents}
    canonical_json(store, max_bytes=limits.max_store_bytes, max_work=limits.max_work, max_depth=limits.max_depth)
    return store, snapshots


def verify_run(run: AnnotationRun | None, snapshots: list[tuple[Path, str]]) -> None:
    if run is None:
        return
    if options_for_root(run.root) != run.options or analysis_fingerprint(options=run.options) != run.producer["fingerprint"]:
        raise AnnotationError("Annotation implementation or configuration changed; retry indexing")
    for path, expected in snapshots:
        with Path(path).open("rb") as stream:
            current = stream.read(run.options["limits"]["maxSourceBytes"] + 1)
        if hashlib.sha256(current).hexdigest() != expected:
            raise AnnotationError("Source changed during native annotation extraction; retry indexing")
