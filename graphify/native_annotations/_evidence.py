"""Shared mechanics for occurrence evidence and complete lexical inventories."""

import re

from ..framework_evidence import canonical_json


IDENTIFIERS = {
    "identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
}
_DYNAMIC = {"eval", "Function", "require", "getBuiltinModule", "createRequire"}
_AMBIENT = {"globalThis", "global", "window", "self", "module"}
_IDENTIFIER = re.compile(r"[$A-Z_a-z][$A-Z_a-z0-9]*\Z")
_LITERAL = re.compile(
    r"""(?:"[\x20-\x21\x23-\x5b\x5d-\x7e]*"|'[\x20-\x26\x28-\x5b\x5d-\x7e]*')\Z"""
)


def descriptor(
    plugin,
    roles,
    *,
    references=None,
    spans=None,
    strings=None,
    integers=None,
    booleans=None,
    span_description="Exact source span locator; never embedded source text.",
):
    properties = []
    for group, kind, description in (
        (references, "reference", None),
        (spans, "string", span_description),
        (strings, "string", None),
        (integers, "integer", None),
        (booleans, "boolean", None),
    ):
        for name, label in (group or {}).items():
            term = {"id": f"{plugin}.{name}", "label": label, "multiple": True, "valueKind": kind}
            if description:
                term["description"] = description
            properties.append(term)
    return {
        "id": plugin,
        "version": "1",
        "languages": ["typescript", "tsx"],
        "view": {"id": "typescript", "version": 1},
        "roles": [{"id": f"{plugin}.{name}", "label": label} for name, label in roles.items()],
        "properties": properties,
        "relations": [],
    }


def same(a, b):
    return (
        a is not None
        and b is not None
        and a.type == b.type
        and a.startIndex == b.startIndex
        and a.endIndex == b.endIndex
    )


def node_key(node):
    return node.type, node.startIndex, node.endIndex


def children(node):
    return [child for child in node.children if child.type != "comment"] if node else []


def args(node):
    return children(node.fields.get("arguments")) if node else []


def optional(node):
    return node is not None and (
        "?." in node.tokens or any(child.type == "optional_chain" for child in node.children)
    )


def locator(view, node):
    span = view.span(node)
    return f"s:{span['startByte']}:{span['endByte']}:{span['startLine']}:{span['endLine']}"


def string(value):
    return {"kind": "string", "value": value}


def integer(value):
    return {"kind": "integer", "value": value}


def boolean(value):
    return {"kind": "boolean", "value": value}


def reference(key):
    return {"kind": "reference", "value": {"kind": "declaration", "key": key}}


def import_reference(module, name):
    return {"kind": "reference", "value": {"kind": "import", "module": module, "name": name}}


def identifier(view, node, maximum=128):
    text = view.text(node)
    return bool(_IDENTIFIER.fullmatch(text)) and len(text.encode("utf-8")) <= maximum


def literal(view, node):
    raw = view.text(node) if node and node.type == "string" else ""
    # These are character indices within an already decoded, ASCII-only literal.
    return raw[1:-1] if _LITERAL.fullmatch(raw) else None


def dynamic_exposure(view, node):
    if node.type in IDENTIFIERS:
        name = view.name(node)
        if name in _DYNAMIC or name in _AMBIENT:
            return True
        if name == "process":
            env = view.parent(node)
            access = view.parent(env) if env else None
            return not (
                env
                and env.type == "member_expression"
                and same(env.fields.get("object"), node)
                and not optional(env)
                and env.fields.get("property")
                and view.name(env.fields["property"]) == "env"
                and access
                and access.type == "member_expression"
                and same(access.fields.get("object"), env)
                and not optional(access)
                and access.fields.get("property")
                and access.fields["property"].type == "property_identifier"
            )
    field = {
        "member_expression": "property",
        "subscript_expression": "index",
        "pair_pattern": "key",
    }.get(node.type)
    prop = node.fields.get(field) if field else None
    name = view.name(prop) if prop else None
    return node.type == "import" or name in _DYNAMIC or name == "constructor"


class CensusLimit(Exception):
    """Local qualification limit, distinct from the engine's shared budget."""


class Census:
    """Stage complete units before emission; the engine discards non-complete output."""

    def __init__(self, plugin, message, rules, view, budget):
        self.plugin, self.message, self.rules = plugin, message, rules
        self.view, self.budget = view, budget
        self.work = self.facts = 0
        self.partial = self.truncated = False
        self.diagnostics = []
        self.codes = set()
        self.staged = []

    def diagnose(self, code, node=None):
        self.partial = True
        code = f"{self.plugin}.{code}"
        if code in self.codes:
            return
        if (
            len(self.diagnostics) >= self.view.limits["maxDiagnostics"]
            or len(self.message.encode("utf-8")) > self.view.limits["maxValueBytes"]
        ):
            self.truncated = True
            return
        diagnostic = {"code": code, "message": self.message}
        if node is not None:
            diagnostic["span"] = self.view.span(node)
        self.codes.add(code)
        self.diagnostics.append(diagnostic)

    def limit(self, code):
        self.truncated = True
        self.diagnose(code)
        raise CensusLimit(code)

    def step(self, amount=1):
        self.work += amount
        if self.work > self.rules["maxWork"]:
            self.limit("work-limit")
        self.budget.step(amount)

    def binding(self, node):
        self.step(self.rules["maxDepth"])
        return self.view.binding(node)

    def check_tree(self):
        if len(self.view.raw_source) > self.rules["maxSourceBytes"]:
            self.limit("source-limit")
        pending = [(self.view.root, 0)]
        while pending:
            node, depth = pending.pop()
            self.step()
            if depth > self.rules["maxDepth"]:
                self.limit("depth-limit")
            pending.extend((child, depth + 1) for child in node.children)

    def stage(self, node, subject, role, rule, properties, maximum=None):
        self.facts += len(properties) + 1
        if self.facts > (self.rules["maxFacts"] if maximum is None else maximum):
            self.limit("fact-limit")
        if any(
            len(canonical_json(value).encode("utf-8")) > self.view.limits["maxValueBytes"]
            for _, value in properties
        ):
            self.limit("value-limit")
        self.staged.append((node, subject, role, rule, properties))

    def emit(self, emitter):
        for node, subject, role, rule, properties in self.staged:
            self.step()
            evidence = {"ruleId": rule, "basis": "import-bound", "span": self.view.span(node)}
            if not emitter.role(subject, f"{self.plugin}.{role}", evidence):
                self.limit("output-limit")
            for prop, value in properties:
                self.step()
                if not emitter.property(
                    subject, f"{self.plugin}.{prop}", "literal", value, evidence
                ):
                    self.limit("output-limit")

    def report(self):
        return {
            "state": "truncated"
            if self.truncated
            else "partial"
            if self.partial
            else "complete"
            if self.staged
            else "not-applicable",
            "diagnostics": self.diagnostics,
        }
