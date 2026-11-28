"""Explicit, immutable source input for the one-shot worker.

Ordinary library callers retain their existing filesystem behavior. Worker calls
freeze source/control bytes and prohibit ambient reads, processes and networking.
This is a source-admission boundary, not a sandbox for untrusted Python plugins.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import os
from pathlib import Path
import sys


_ACTIVE: ContextVar[dict | None] = ContextVar("graphify_input_snapshot", default=None)
_AUDIT_INSTALLED = False


def _key(path) -> str:
    return os.path.normcase(os.path.abspath(os.fsdecode(path)))


def snapshot_root() -> Path | None:
    current = _ACTIVE.get()
    return current["root"] if current is not None else None


def permits_source_path(path: Path) -> bool:
    current = _ACTIVE.get()
    return current is None or _key(path) in current["paths"]


def source_bytes(path: Path) -> bytes | None:
    current = _ACTIVE.get()
    if current is None:
        return None
    key = _key(path)
    if key not in current["files"]:
        raise PermissionError("Source was not admitted to the private snapshot")
    return current["files"][key]


def read_source_text(path: Path, *, encoding="utf-8", errors="strict") -> str:
    data = source_bytes(path)
    if data is None:
        return path.read_text(encoding=encoding, errors=errors)
    return data.decode(encoding, errors=errors).replace("\r\n", "\n").replace("\r", "\n")


def _within(key: str, root: str) -> bool:
    return key == root or key.startswith(root + os.sep)


def _audit(event, args):
    current = _ACTIVE.get()
    if current is None:
        return
    if event.startswith(("subprocess.", "socket.", "os.exec", "os.spawn")) or event in {"os.system", "os.fork"}:
        raise PermissionError("Worker extraction cannot start processes or use the network")
    if event in {"os.link", "os.symlink"}:
        raise PermissionError("Worker extraction cannot create filesystem aliases")
    if event in {"os.mkdir", "os.remove", "os.rmdir", "os.rename", "os.chmod", "os.truncate", "os.utime"}:
        paths = args[:2] if event == "os.rename" else args[:1]
        if any(isinstance(path, int) or not _within(_key(path), current["cache"]) for path in paths):
            raise PermissionError("Worker extraction may mutate only its private cache")
        return
    if event not in {"open", "os.listdir", "os.scandir"}:
        return
    path = args[0]
    if isinstance(path, int):
        raise PermissionError("Descriptor-based input is not admitted")
    key = _key(path)
    writing = event == "open" and bool(args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
    if writing:
        if not _within(key, current["cache"]):
            raise PermissionError("Worker extraction may write only its private cache")
        return
    if key in current["paths"] or any(_within(key, root) for root in current["runtime"]):
        return
    if _within(key, current["cache"]):
        return
    raise PermissionError("Read outside the admitted snapshot or installed runtime")


@contextmanager
def admitted_snapshot(root: Path, files: dict[str, bytes], cache: Path):
    global _AUDIT_INSTALLED
    if not _AUDIT_INSTALLED:
        sys.addaudithook(_audit)
        _AUDIT_INSTALLED = True
    paths = {_key(root)}
    captured = {}
    for relative, data in files.items():
        path = root / relative
        captured[_key(path)] = data
        paths.add(_key(path))
        paths.update(_key(parent) for parent in path.parents if parent.is_relative_to(root))
    runtime = {_key(Path(__file__).parent), _key(sys.base_prefix), _key(sys.prefix)}
    # A portable runtime installs dependencies beside, not inside, Python.
    runtime.update(_key(path) for path in sys.path if path and Path(path).name in {"site-packages", "packages"})
    token = _ACTIVE.set({"root": root, "files": captured, "paths": paths,
                         "cache": _key(cache), "runtime": runtime})
    try:
        yield
    finally:
        _ACTIVE.reset(token)
