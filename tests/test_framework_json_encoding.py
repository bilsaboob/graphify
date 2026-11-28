from __future__ import annotations

import json
import traceback
from enum import IntEnum

import pytest

from graphify import framework_analysis as analysis


def _wire(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode(
        "utf-8"
    )


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,
        False,
        0,
        -123,
        10**200,
        0.0,
        -0.0,
        1.2345678901234567,
        5e-324,
        1.7976931348623157e308,
        "",
        [],
        (),
        {},
        [[], {}, (), [None, True, False, 12, -0.0]],
        {"z": (1, 2), "a": {"last": None}, "empty": ""},
        {None: 1, True: 2, False: 3, -12: 4, 2.5: 5, "true": 6, "null": 7},
    ],
)
def test_compact_json_matches_stdlib_and_exact_byte_limit(value):
    expected = _wire(value)
    assert analysis._encode_json(value, len(expected)) == expected
    assert analysis._encode_json(value, len(expected) + 1) == expected
    with pytest.raises(analysis.FrameworkAnalysisError, match="byte limit"):
        analysis._encode_json(value, len(expected) - 1)


@pytest.mark.parametrize(
    "text",
    [
        '\ufeffcaf\u00e9\u4e2d\U0001f680\u2028\u2029\uffff\r\n\t"\\/',
        "".join(chr(value) for value in range(32)) + "\x7f",
        "x" * (analysis._JSON_STRING_CHUNK_CHARS - 1) + '\U0001f680\r\n"\\\x00',
        "\x00" * (analysis._JSON_STRING_CHUNK_CHARS + 1),
        "\U0001f680" * (analysis._JSON_STRING_CHUNK_CHARS + 1),
    ],
    ids=["unicode-crlf-quotes", "controls", "mixed-chunk-boundary", "long-escapes", "long-utf8"],
)
@pytest.mark.parametrize("as_key", [False, True])
def test_unicode_escaping_and_chunk_boundaries(text, as_key):
    value = {text: text} if as_key else text
    expected = _wire(value)
    assert analysis._encode_json(value, len(expected)) == expected
    with pytest.raises(analysis.FrameworkAnalysisError, match="byte limit"):
        analysis._encode_json(value, len(expected) - 1)


def test_protocol_documents_match_stdlib_without_recursive_generator(monkeypatch):
    documents = [
        analysis.make_document(
            '\ufeff// \U0001f680\r\nexport const caf\u00e9 = "a\\t\\\"b";\r\n',
            "src/caf\u00e9.ts",
        ),
        analysis.make_document(
            'export const View = () => <div title="hello">\U0001f680</div>;\r\n',
            "src/view.tsx",
            "tsx",
        ),
    ]
    request = {"version": 1, "parser": analysis.parser_descriptor(), "documents": documents}
    expected = _wire(request)

    def forbidden(*args, **kwargs):
        pytest.fail("recursive JSON generator must not be used")

    monkeypatch.setattr(json.JSONEncoder, "iterencode", forbidden)
    assert analysis._encode_json(request, len(expected)) == expected


def test_maximum_cst_depth_still_fits_json_envelope():
    nesting = analysis.MAX_TREE_DEPTH - 4
    source = "export const value = " + "[" * nesting + "0" + "]" * nesting + ";"
    document = analysis.make_document(source, "src/deep.ts")
    pending = [(document["tree"], 0)]
    depth = 0
    while pending:
        node, level = pending.pop()
        depth = max(depth, level)
        pending.extend((child["node"], level + 1) for child in node["children"])
    assert depth == analysis.MAX_TREE_DEPTH
    request = {"version": 1, "parser": analysis.parser_descriptor(), "documents": [document]}
    expected = _wire(request)
    assert analysis._encode_json(request, len(expected)) == expected


def test_arbitrary_container_depth_is_bounded():
    value = 0
    for _ in range(analysis._JSON_MAX_DEPTH):
        value = [value]
    assert analysis._encode_json(value, analysis.MAX_REQUEST_BYTES) == _wire(value)
    with pytest.raises(analysis.FrameworkAnalysisError, match="depth limit"):
        analysis._encode_json([value], analysis.MAX_REQUEST_BYTES)


def test_repeated_shared_containers_are_not_cycles():
    leaf = {"position": {"row": 0, "column": 1}, "empty": []}
    shared = [leaf, leaf]
    value = {"first": shared, "second": (shared, leaf), "third": shared}
    assert analysis._encode_json(value, analysis.MAX_REQUEST_BYTES) == _wire(value)


@pytest.mark.parametrize("kind", ["list", "dict", "tuple"])
def test_cycles_are_rejected(kind):
    if kind == "dict":
        value = {}
        value["self"] = value
    else:
        child = []
        value = child if kind == "list" else (child,)
        child.append(value)
    with pytest.raises(analysis.FrameworkAnalysisError, match="not bounded valid JSON"):
        analysis._encode_json(value, analysis.MAX_REQUEST_BYTES)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
@pytest.mark.parametrize("as_key", [False, True])
def test_nonfinite_numbers_are_rejected(value, as_key):
    with pytest.raises(analysis.FrameworkAnalysisError, match="not bounded valid JSON"):
        analysis._encode_json({value: None} if as_key else [value], 100)


@pytest.mark.parametrize("value", [b"bytes", bytearray(b"bytes"), {1, 2}, object(), {(): None}])
def test_unsupported_values_and_keys_are_rejected(value):
    with pytest.raises(analysis.FrameworkAnalysisError, match="not bounded valid JSON"):
        analysis._encode_json(value, 100)


@pytest.mark.parametrize(
    "text",
    ["\ud800", "\udfff", "x" * 4096 + "\ud800", "\ud800\udc00"],
    ids=["high-surrogate", "low-surrogate", "later-chunk", "surrogate-pair"],
)
@pytest.mark.parametrize("as_key", [False, True])
def test_invalid_utf8_is_rejected(text, as_key):
    with pytest.raises(analysis.FrameworkAnalysisError, match="not bounded valid JSON"):
        analysis._encode_json({text: None} if as_key else text, 100_000)


def test_numeric_subclasses_use_json_number_representation():
    class Choice(IntEnum):
        FIRST = 1

    class Number(float):
        def __repr__(self):
            raise AssertionError("custom representation must not be called")

    value = {Choice.FIRST: Number(1.5), Number(-0.0): [Choice.FIRST, Number(2.5)]}
    assert analysis._encode_json(value, 100) == _wire(value)


def test_string_scratch_allocation_and_failure_are_bounded(monkeypatch):
    original = json.encoder.encode_basestring
    sizes = []

    def record(text):
        sizes.append(len(text))
        return original(text)

    monkeypatch.setattr(json.encoder, "encode_basestring", record)
    chunk = analysis._JSON_STRING_CHUNK_CHARS
    with pytest.raises(analysis.FrameworkAnalysisError, match="byte limit"):
        analysis._encode_json("x" * (chunk * 8), chunk)
    assert not sizes
    with pytest.raises(analysis.FrameworkAnalysisError, match="byte limit"):
        analysis._encode_json("\x00" * (chunk * 8), chunk * 8 + 2)
    assert sizes and max(sizes) <= chunk
    assert len(sizes) < 8


def test_oversized_integer_is_rejected_before_decimal_conversion():
    with pytest.raises(analysis.FrameworkAnalysisError, match="byte limit"):
        analysis._encode_json(1 << 1_000_000, 16)


def test_output_overflow_does_not_traverse_remaining_siblings():
    class GuardedList(list):
        def __iter__(self):
            yield None
            pytest.fail("items after an overflowing value must not be visited")

    with pytest.raises(analysis.FrameworkAnalysisError, match="byte limit"):
        analysis._encode_json(GuardedList([None, None]), 1)


@pytest.mark.parametrize("error_type", [ValueError, RuntimeError, analysis.FrameworkAnalysisError])
def test_input_errors_do_not_echo_sensitive_values(error_type):
    marker = "private-input-must-not-appear"

    class InvalidMapping(dict):
        def items(self):
            raise error_type(marker)

    with pytest.raises(analysis.FrameworkAnalysisError) as error:
        analysis._encode_json(InvalidMapping({marker: None}), 1000)
    assert str(error.value) == "Framework analysis request is not bounded valid JSON"
    assert marker not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize("maximum", [0, -1, None, True, 1.5])
def test_invalid_or_empty_byte_budgets_fail_closed(maximum):
    with pytest.raises(analysis.FrameworkAnalysisError, match="byte limit"):
        analysis._encode_json(None, maximum)
