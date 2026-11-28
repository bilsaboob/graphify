"""Small source-only helpers shared by the native JSX annotation plugins."""

import json
import re

from .values import js_string as js_string


FUNCTIONS = frozenset(
    (
        "arrow_function",
        "function_expression",
        "function_declaration",
        "generator_function",
        "generator_function_declaration",
        "method_definition",
    )
)
WRAPPERS = frozenset(
    (
        "parenthesized_expression",
        "as_expression",
        "satisfies_expression",
        "non_null_expression",
    )
)
PROPS_CONTRACT = (
    "authored groups and order, not compiler lowering proof; Solid lazy merge uses "
    "last-non-undefined property precedence, object-literal flattening uses own-property "
    "precedence; nested children supply the final children property; effective keys, "
    "values, getters and child normalization not evaluated"
)
_COMMENTS = re.compile(r"/\*[\s\S]*?\*/|//[^\r\n]*")
_INVALID_STRING = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]")


def key(node):
    return node.startIndex, node.endIndex


def args_of(node):
    arguments = node.fields.get("arguments")
    return [child for child in arguments.children if child.type != "comment"] if arguments else []


def first_child(node):
    return (
        next((child for child in node.children if child.type != "comment"), None) if node else None
    )


def expression(view, node):
    return {"kind": "expression", "text": view.text(node), "span": view.span(node)}


def bounded(view, value):
    # Match wire canonical JSON's HTML-safe escaping, not ensure_ascii's larger size.
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    for char, replacement in (
        ("<", "\\u003c"),
        (">", "\\u003e"),
        ("&", "\\u0026"),
        ("\u2028", "\\u2028"),
        ("\u2029", "\\u2029"),
    ):
        text = text.replace(char, replacement)
    return len(text.encode("utf-8", errors="surrogatepass")) <= view.limits["maxValueBytes"]


def valid_string(view, value):
    return not _INVALID_STRING.search(value) and bounded(view, {"kind": "string", "value": value})


def function_node(view, budget, input_node, functions=FUNCTIONS, limit=24):
    node, seen = view.unwrap(input_node), set()
    while node.type not in functions and len(seen) < limit and key(node) not in seen:
        budget.step()
        seen.add(key(node))
        binding = view.binding(node)
        if (
            not binding
            or not binding.get("available")
            or not binding.get("stable")
            or binding.get("typeOnly")
        ):
            return None
        next_node = binding.get("initializer")
        if next_node is None and binding["kind"] == "function" and binding.get("declaration"):
            next_node = view.declarationNode(binding["declaration"])
        if next_node is None:
            return None
        node = view.unwrap(next_node)
    return node if node.type in functions else None


def array_items(view, input_node, limit=16):
    node = view.unwrap(input_node)
    items = [child for child in node.children if child.type != "comment"]
    if node.type != "array" or len(items) > limit:
        return None

    def punctuation(start, end):
        return _COMMENTS.sub("", view.slice_bytes(start, end)).strip()

    for index, item in enumerate(items):
        if item.type == "spread_element" or punctuation(
            items[index - 1].endIndex if index else node.startIndex + 1, item.startIndex
        ) != ("," if index else ""):
            return None
    return (
        items
        if punctuation(items[-1].endIndex if items else node.startIndex + 1, node.endIndex - 1)
        in ("", ",")
        else None
    )


def spread_argument(node):
    return first_child(
        next((child for child in node.children if child.type == "spread_element"), None)
    )
