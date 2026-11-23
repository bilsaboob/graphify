from __future__ import annotations

import copy
import io
import json
from collections import UserDict
from importlib.resources import files
from types import MappingProxyType

import pytest

from graphify import framework_config as config
from graphify.framework_config import (
    MODULE_ALIAS_TARGETS,
    MODULE_FAMILIES,
    FrameworkConfigurationError,
    normalize_analysis_options,
    normalize_module_aliases,
)
from graphify.framework_evidence import ANNOTATION_LIMITS, canonical_json


def _options(value=None, *, max_limits=ANNOTATION_LIMITS):
    return normalize_analysis_options(value, max_limits=max_limits)


def test_catalog_is_the_packaged_node_asset_not_a_second_whitelist():
    asset = files("graphify").joinpath("semantic_node", "module_catalog.json")
    catalog = json.loads(asset.read_text(encoding="utf-8"))
    assert tuple(catalog["MODULE_FAMILIES"]) == MODULE_FAMILIES
    assert frozenset(catalog["MODULE_ALIAS_TARGETS"]) == MODULE_ALIAS_TARGETS
    for target in catalog["MODULE_ALIAS_TARGETS"]:
        assert normalize_module_aliases({"caller-library": target}) == {"caller-library": target}


def test_defaults_and_lower_only_effective_options_are_detached_and_sorted():
    assert _options() == {"limits": ANNOTATION_LIMITS, "moduleAliases": {}}
    assert _options({}) == _options(None)
    supplied = {
        "limits": {"maxFacts": 7},
        "moduleAliases": {"z": "solid-js", "a": "@solidjs/router"},
    }
    before = copy.deepcopy(supplied)
    normalized = _options(supplied)
    assert list(normalized["limits"]) == sorted(ANNOTATION_LIMITS)
    assert list(normalized["moduleAliases"]) == ["a", "z"]
    assert normalized["limits"]["maxFacts"] == 7
    assert all(
        normalized["limits"][key] == value
        for key, value in ANNOTATION_LIMITS.items()
        if key != "maxFacts"
    )
    normalized["moduleAliases"]["a"] = "solid-js"
    normalized["limits"]["maxFacts"] = 1
    assert supplied == before and ANNOTATION_LIMITS["maxFacts"] == 4096


def test_prefix_overlap_is_retained_for_longest_slash_boundary_resolution():
    aliases = {
        "client/ui/nested": "@solidjs/router",
        "client": "@fst/components-fst-solid",
        "client/ui": "solid-js",
        "client-ui": "solid-js/web",
    }
    normalized = normalize_module_aliases(aliases)
    assert normalized == aliases
    assert list(normalized) == sorted(aliases)
    assert normalize_module_aliases({"@app/ui.v2/Part_1-lib": "solid-js"})


@pytest.mark.parametrize("value", [None, [], "{}", 0, True, UserDict(), MappingProxyType({})])
def test_aliases_require_an_own_plain_json_mapping(value):
    with pytest.raises(FrameworkConfigurationError, match="plain JSON object"):
        normalize_module_aliases(value)


def test_dict_subclasses_are_rejected_without_running_overridden_methods():
    class Hostile(dict):
        def items(self):
            raise AssertionError("Must reject non-JSON container before executing methods")

    with pytest.raises(FrameworkConfigurationError):
        normalize_module_aliases(Hostile())
    with pytest.raises(FrameworkConfigurationError):
        _options(Hostile())


@pytest.mark.parametrize(
    "prefix",
    [
        "",
        "./pkg",
        "../pkg",
        "/pkg",
        "pkg/",
        "pkg//sub",
        "pkg/./sub",
        "pkg/../sub",
        "pkg\\sub",
        "@scope",
        "@scope/",
        "node:fs",
        "https://host/pkg",
        "pkg?x",
        "pkg#x",
        "pkg*",
        "pkg/*",
        "pkg%2fsub",
        "pkg sub",
        "pkg\t",
        "pkg\n",
        "pkg\x00",
        "pkg\x7f",
        "-pkg",
        "_pkg",
        ".pkg",
        "@_scope/pkg",
        "@scope/_pkg",
        "__proto__",
        "pkg/\u00e9",
        "\u03c0kg",
        "pkg\u2028",
        "pkg\ud800",
        17,
        None,
    ],
)
def test_non_ascii_or_non_bare_prefixes_are_rejected(prefix):
    with pytest.raises(FrameworkConfigurationError, match="prefix"):
        normalize_module_aliases({prefix: "solid-js"})


@pytest.mark.parametrize(
    "target",
    [
        None,
        [],
        {},
        1,
        True,
        "",
        "unknown",
        "Solid-js",
        "solid-js/unknown",
        "@fst/components-fst-solid/not-reviewed",
        "@fst/components-fst-solid/app/component/unknown",
        "./solid-js",
        "https://host/solid-js",
        "solid-js/",
        "solid-js\u2028",
    ],
)
def test_targets_must_be_exact_reviewed_catalog_entries(target):
    with pytest.raises(FrameworkConfigurationError, match="target"):
        normalize_module_aliases({"caller-lib": target})


def test_canonical_families_and_descendants_cannot_be_remapped_or_chained():
    for family in MODULE_FAMILIES:
        for prefix in (family, family + "/arbitrary"):
            with pytest.raises(FrameworkConfigurationError, match="Canonical"):
                normalize_module_aliases({prefix: "solid-js"})
        # Similar spelling is not a slash-boundary match or inferred identity.
        assert normalize_module_aliases({family + "-local": "solid-js"})
    with pytest.raises(FrameworkConfigurationError):
        normalize_module_aliases({"first": "second", "second": "solid-js"})
    with pytest.raises(FrameworkConfigurationError):
        normalize_module_aliases({"first": "solid-js", "solid-js": "@solidjs/router"})


def test_entry_and_prefix_bounds_are_exact_and_never_truncate():
    aliases = {f"lib{i}": "solid-js" for i in range(64)}
    assert len(normalize_module_aliases(aliases)) == 64
    aliases["overflow"] = "solid-js"
    with pytest.raises(FrameworkConfigurationError, match="entry limit"):
        normalize_module_aliases(aliases)
    assert len(aliases) == 65
    assert normalize_module_aliases({"x" * 256: "solid-js"})
    with pytest.raises(FrameworkConfigurationError, match="prefix"):
        normalize_module_aliases({"x" * 257: "solid-js"})
    with pytest.raises(FrameworkConfigurationError, match="4096"):
        normalize_module_aliases({f"k{i}" + "x" * 250: "solid-js" for i in range(20)})


def _exact_budget_options():
    value: dict = {
        "limits": dict(ANNOTATION_LIMITS),
        "moduleAliases": {f"k{i:02}": "solid-js" for i in range(64)},
    }
    remaining = 4096 - len(canonical_json(value).encode("utf-8"))
    for key in list(value["moduleAliases"]):
        extra = min(remaining, 256 - len(key))
        if extra:
            value["moduleAliases"][key + "x" * extra] = value["moduleAliases"].pop(key)
            remaining -= extra
    assert remaining == 0
    return value


def test_whole_options_budget_covers_expanded_limits_at_exact_boundary():
    value = _exact_budget_options()
    assert len(canonical_json(_options(value)).encode("utf-8")) == 4096
    aliases = value["moduleAliases"]
    key = next(key for key in aliases if len(key) < 256)
    aliases[key + "x"] = aliases.pop(key)
    with pytest.raises(FrameworkConfigurationError, match="4096"):
        _options(value)
    small_input = {"moduleAliases": aliases}
    assert len(canonical_json(small_input).encode("utf-8")) < 4096
    with pytest.raises(FrameworkConfigurationError, match="Effective"):
        _options(small_input)


@pytest.mark.parametrize(
    "value",
    [
        [],
        "{}",
        True,
        4,
        {"unknown": True},
        {"moduleAliases": None},
        {"limits": None},
        {"limits": []},
        {"limits": {"unknown": 1}},
    ],
)
def test_unknown_options_or_invalid_nested_maps_fail_closed(value):
    with pytest.raises(FrameworkConfigurationError):
        _options(value)


@pytest.mark.parametrize(
    "value", [True, False, 0, -1, 1.0, float("nan"), float("inf"), "1", None, [], {}, 4097, 1 << 53]
)
def test_limits_only_accept_positive_safe_integers_up_to_current_maximum(value):
    with pytest.raises(FrameworkConfigurationError):
        _options({"limits": {"maxFacts": value}})
    assert _options({"limits": {key: 1 for key in ANNOTATION_LIMITS}})["limits"] == {
        key: 1 for key in ANNOTATION_LIMITS
    }


@pytest.mark.parametrize(
    "maxima",
    [
        {},
        {"maxFacts": True},
        {"maxFacts": 0},
        {"maxFacts": -1},
        {"maxFacts": 1 << 53},
        {"not-valid": 1},
        {17: 1},
    ],
)
def test_supplied_limit_contract_itself_is_checked(maxima):
    with pytest.raises(FrameworkConfigurationError):
        _options(max_limits=maxima)


def test_normalizers_do_not_reread_catalog_or_project_files(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Configuration validation must use the loaded immutable catalog")

    monkeypatch.setattr(config, "files", forbidden)
    monkeypatch.setattr("builtins.open", forbidden)
    assert _options({"moduleAliases": {"local": "solid-js"}})["moduleAliases"] == {
        "local": "solid-js"
    }


@pytest.mark.parametrize(
    "raw",
    [
        b"{}",
        b"[]",
        b"{",
        b"\xff",
        b"{}" + b" " * (64 * 1024),
        b'{"MODULE_FAMILIES":[],"MODULE_FAMILIES":[],"MODULE_ALIAS_TARGETS":[]}',
        b'{"MODULE_FAMILIES":["solid-js"],"MODULE_ALIAS_TARGETS":["solid-js","solid-js"]}',
        b'{"MODULE_FAMILIES":["solid-js"],"MODULE_ALIAS_TARGETS":["other"]}',
        b'{"MODULE_FAMILIES":["../bad"],"MODULE_ALIAS_TARGETS":["../bad"]}',
        b"1" * 5000,
        b"[" * 1500 + b"]" * 1500,
    ],
    ids=[
        "empty-object",
        "array",
        "syntax",
        "utf8",
        "oversized",
        "duplicate-key",
        "duplicate-target",
        "foreign-target",
        "relative-target",
        "integer-budget",
        "depth-budget",
    ],
)
def test_bad_packaged_catalog_is_rejected_without_a_fallback_whitelist(monkeypatch, raw):
    class Asset:
        def joinpath(self, *parts):
            return self

        def open(self, mode):
            assert mode == "rb"
            return io.BytesIO(raw)

    monkeypatch.setattr(config, "files", lambda name: Asset())
    with pytest.raises(FrameworkConfigurationError):
        config._catalog()
