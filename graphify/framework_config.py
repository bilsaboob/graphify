"""Closed, bounded configuration for Graphify-owned source annotation.

Alias targets come from the same packaged catalog bundled into the Node worker.
The catalog is read once at import, not during graph queries or source analysis.
Mappings declare API identity only, not package contents or runtime equivalence.
Overlapping source prefixes are retained: Node applies the longest slash-boundary
prefix exactly once. This module never resolves imports or rewrites source text.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from importlib.resources import files
from typing import Any, TypedDict


MAX_OPTIONS_BYTES = 4096
MAX_MODULE_ALIASES = 64
MAX_ALIAS_PREFIX_LENGTH = 256
_MAX_CATALOG_BYTES = 64 * 1024
_MAX_SAFE_INTEGER = (1 << 53) - 1
_BARE_MODULE = re.compile(
    r"(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*"
    r"(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*\Z"
)


class FrameworkConfigurationError(ValueError):
    """Invalid or over-budget analyzer configuration; no partial options apply."""


class AnalysisOptions(TypedDict):
    limits: dict[str, int]
    moduleAliases: dict[str, str]


def _require(condition: Any, message: str) -> None:
    if not condition:
        raise FrameworkConfigurationError(message)


def _within(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(prefix + "/")


def _catalog() -> tuple[tuple[str, ...], frozenset[str]]:
    """Load only the bounded owned asset, rejecting malformed packaged catalogs."""
    path = files("graphify").joinpath("semantic_node", "module_catalog.json")

    def pairs(items: list[tuple[str, Any]]) -> dict:
        value = {}
        for key, item in items:
            _require(key not in value, "Duplicate module catalog key")
            value[key] = item
        return value

    try:
        with path.open("rb") as stream:
            raw = stream.read(_MAX_CATALOG_BYTES + 1)
        _require(len(raw) <= _MAX_CATALOG_BYTES, "Module catalog exceeds 64-KiB limit")
        value: dict[str, Any] = json.loads(
            raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs
        )
    except FrameworkConfigurationError:
        raise
    except (OSError, UnicodeError, ValueError, RecursionError) as exc:
        raise FrameworkConfigurationError(
            "Packaged module catalog is unavailable or invalid"
        ) from exc
    _require(
        type(value) is dict and set(value) == {"MODULE_FAMILIES", "MODULE_ALIAS_TARGETS"},
        "Invalid module catalog shape",
    )
    for name in ("MODULE_FAMILIES", "MODULE_ALIAS_TARGETS"):
        entries: list[Any] = value[name]
        _require(type(entries) is list and bool(entries), "Invalid module catalog entries")
        for entry in entries:
            _require(
                type(entry) is str
                and len(entry) <= MAX_OPTIONS_BYTES
                and _BARE_MODULE.fullmatch(entry),
                "Invalid module catalog identity",
            )
        _require(len(set(entries)) == len(entries), "Duplicate module catalog identity")
    families = tuple(value["MODULE_FAMILIES"])
    targets = frozenset(value["MODULE_ALIAS_TARGETS"])
    _require(
        set(families) <= targets
        and all(any(_within(target, family) for family in families) for target in targets),
        "Module catalog targets disagree with families",
    )
    return families, targets


MODULE_FAMILIES, MODULE_ALIAS_TARGETS = _catalog()


def _check_budget(value: Any, message: str) -> None:
    # Only validated ASCII identifiers, bare module names and safe integers reach
    # this point, so compact sorted JSON is identical to the wire canonical JSON.
    encoded = json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    )
    _require(len(encoded) <= MAX_OPTIONS_BYTES, message)


def normalize_module_aliases(value: Any) -> dict[str, str]:
    """Validate an own JSON map and return a detached, lexically sorted map.

    The closed contract permits at most 64 entries and 256 ASCII characters per
    source prefix; its whole canonical JSON is at most 4096 bytes. Targets must
    be exact reviewed catalog entries. Canonical families cannot be remapped or
    shadowed, so neither alias chains nor recursive rewriting can arise.
    Raw JSON duplicate-key detection belongs at the decoding boundary.
    """
    _require(type(value) is dict, "Module aliases must be a plain JSON object")
    _require(len(value) <= MAX_MODULE_ALIASES, "Module alias entry limit exceeded")
    for prefix, target in value.items():
        _require(
            type(prefix) is str
            and len(prefix) <= MAX_ALIAS_PREFIX_LENGTH
            and _BARE_MODULE.fullmatch(prefix),
            "Invalid module alias prefix",
        )
        _require(
            not any(
                _within(prefix, family) or _within(family, prefix) for family in MODULE_FAMILIES
            ),
            "Canonical module identities cannot be aliased",
        )
        _require(
            type(target) is str
            and len(target) <= MAX_OPTIONS_BYTES
            and target in MODULE_ALIAS_TARGETS,
            "Unsupported module alias target",
        )
    normalized = {key: value[key] for key in sorted(value)}
    _check_budget(normalized, "Module aliases exceed 4096-byte canonical JSON limit")
    return normalized


def normalize_analysis_options(
    options: Any = None,
    *,
    max_limits: Mapping[str, int],
) -> AnalysisOptions:
    """Return complete lower-only limits and explicit aliases, never partial data.

    ``None`` means omitted API options, not a wire-level null object. Nested null
    maps are invalid. ``max_limits`` is supplied by the caller's wire contract;
    this module never imports evidence and cannot create a dependency cycle.
    Both supplied and expanded options must fit the 4096-byte canonical budget.
    """
    _require(isinstance(max_limits, Mapping) and bool(max_limits), "Invalid limit contract")
    for name, maximum in max_limits.items():
        _require(
            type(name) is str and len(name) <= 128 and re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", name),
            "Invalid limit name",
        )
        _require(
            type(maximum) is int and 1 <= maximum <= _MAX_SAFE_INTEGER,
            "Invalid maximum analysis limit",
        )
    supplied: dict[str, Any] = {} if options is None else options
    _require(
        type(supplied) is dict and supplied.keys() <= {"limits", "moduleAliases"},
        "Invalid analyzer options or unknown option field",
    )
    bounds: dict[str, Any] = supplied.get("limits", {})
    _require(
        type(bounds) is dict and bounds.keys() <= max_limits.keys(),
        "Invalid analysis limits or unknown limit field",
    )
    for name, value in bounds.items():
        _require(
            type(value) is int and 1 <= value <= max_limits[name],
            "Analysis limits must be positive safe integers no greater than their maxima",
        )
    aliases = normalize_module_aliases(supplied.get("moduleAliases", {}))
    _check_budget(supplied, "Analyzer options exceed 4096-byte canonical JSON limit")
    normalized: AnalysisOptions = {
        "limits": {key: bounds.get(key, max_limits[key]) for key in sorted(max_limits)},
        "moduleAliases": aliases,
    }
    _check_budget(normalized, "Effective analyzer options exceed 4096-byte canonical JSON limit")
    return normalized
