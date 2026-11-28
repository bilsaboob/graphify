"""Reviewed local outcomes, writes, environment reads and authored assertions."""

import re

from ._evidence import args, boolean, canonical_json, descriptor, locator, optional, same, string


RULES = {
    "version": 1,
    "spanEncoding": "s:utf8-start:utf8-end:start-line:end-line",
    "rules": [
        "local-outcome-v1",
        "local-write-v1",
        "environment-read-v1",
        "test-registration-v1",
        "test-assertion-v1",
    ],
    "testModules": ["bun:test", "vitest", "node:test"],
    "assertModules": ["node:assert", "node:assert/strict"],
    "processModules": ["process", "node:process"],
    "maxUnits": 128,
    "maxFacts": 2048,
    "maxKeyBytes": 128,
    "maxContextDepth": 64,
}
DESCRIPTOR = descriptor(
    "implementation",
    {
        "return": "Local Return Statement",
        "throw": "Local Throw Statement",
        "assignment": "Direct Assignment",
        "update": "Direct Update",
        "config-read": "Qualified Environment Read",
        "test": "Authored Test Registration",
        "assertion": "Authored Assertion",
    },
    spans={
        "owner": "Lexical Callable Span",
        "value": "Value Expression Span",
        "target": "Write Target Span",
        "if-true": "Enclosing If True Predicate Span",
        "if-false": "Enclosing If False Predicate Span",
        "conditional-true": "Enclosing Conditional True Predicate Span",
        "conditional-false": "Enclosing Conditional False Predicate Span",
        "fallback": "Fallback Expression Span",
        "fallback-expression": "Complete Defaulting Expression Span",
        "callback": "Registered Test Callback Span",
        "test-name": "Test Name Expression Span",
        "actual": "Asserted Expression Span",
        "expected": "Expected Expression Span",
        "test-owner": "Exact Test Callback Span",
    },
    strings={
        "condition": "Source Evidence Limitation",
        "operator": "Parsed Write Operator",
        "config-key": "Static Environment Key",
        "config-source": "Environment API",
        "config-provenance": "Environment Provenance",
        "fallback-semantics": "Defaulting Semantics",
        "runner": "Imported Test Runner",
        "api": "Imported Registration API",
        "matcher": "Parsed Assertion Matcher",
        "async-mode": "Parsed Assertion Async Mode",
    },
    booleans={
        "negated": "Parsed Matcher Negation",
        "awaited": "Directly Awaited Assertion",
        "unit-complete": "Complete Source Unit",
    },
    span_description="Exact source span locator; never an evaluated value or embedded source text.",
)
_CALLABLES = {
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "generator_function",
    "arrow_function",
    "method_definition",
}
_WRAPPERS = {
    "parenthesized_expression",
    "as_expression",
    "satisfies_expression",
    "type_assertion",
    "non_null_expression",
}
_MEMBERS = {"member_expression", "subscript_expression"}
_WRITES = {"assignment_expression", "augmented_assignment_expression", "update_expression"}
_OPERATORS = {
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**=",
    "<<=",
    ">>=",
    ">>>=",
    "&=",
    "|=",
    "^=",
    "&&=",
    "||=",
    "??=",
    "++",
    "--",
}
_EXPECT = {
    "toBe": 1,
    "toEqual": 1,
    "toStrictEqual": 1,
    "toContain": 1,
    "toHaveLength": 1,
    "toMatch": 1,
    "toBeTruthy": 0,
    "toBeFalsy": 0,
    "toBeNull": 0,
    "toBeUndefined": 0,
    "toBeDefined": 0,
}
_ASSERT = {
    "ok": 1,
    "equal": 2,
    "notEqual": 2,
    "strictEqual": 2,
    "notStrictEqual": 2,
    "deepEqual": 2,
    "notDeepEqual": 2,
    "deepStrictEqual": 2,
    "notDeepStrictEqual": 2,
    "match": 2,
    "doesNotMatch": 2,
}


def analyze(view, budget, emitter):
    if view.state in {"truncated", "unsupported", "failed"}:
        return {"state": view.state, "diagnostics": []}
    partial = truncated = stopped = False
    units = facts = 0
    diagnostics, codes = [], set()

    def diagnose(code, node):
        nonlocal partial, truncated
        partial = True
        code = f"implementation.{code}"
        if code in codes:
            return
        message = "Source form is outside the reviewed implementation evidence contract."
        if (
            len(diagnostics) >= view.limits["maxDiagnostics"]
            or len(message.encode()) > view.limits["maxValueBytes"]
        ):
            truncated = True
            return
        codes.add(code)
        diagnostics.append({"code": code, "message": message, "span": view.span(node)})

    def loc(node):
        return locator(view, node)

    def outer(node):
        parent = view.parent(node)
        while parent and parent.type in _WRAPPERS:
            budget.step()
            node, parent = parent, view.parent(parent)
        return node, parent

    def owner(node):
        nonlocal truncated
        at, depth = view.parent(node), 0
        while at:
            budget.step()
            depth += 1
            if depth > RULES["maxContextDepth"]:
                truncated = True
                return None
            if at.type in _CALLABLES:
                return at
            at = view.parent(at)
        return None

    def context(node):
        nonlocal truncated
        properties = [("condition", "source-only")]
        child, parent, depth = node, view.parent(node), 0
        while parent:
            budget.step()
            depth += 1
            if depth > RULES["maxContextDepth"]:
                truncated = True
                properties.append(("condition", "context-depth-limit"))
                break
            if parent.type in _CALLABLES:
                properties.append(("owner", loc(parent)))
                break
            if parent.type in {"if_statement", "ternary_expression"}:
                predicate = parent.fields.get("condition")
                polarity = (
                    "true"
                    if same(child, parent.fields.get("consequence"))
                    else "false"
                    if same(child, parent.fields.get("alternative"))
                    else None
                )
                if predicate and polarity:
                    prefix = "if" if parent.type == "if_statement" else "conditional"
                    properties.append((f"{prefix}-{polarity}", loc(predicate)))
            boundary = None
            if parent.type in {
                "for_statement",
                "for_in_statement",
                "while_statement",
                "do_statement",
            }:
                boundary = "loop-context"
            elif parent.type in {"try_statement", "catch_clause", "finally_clause"}:
                boundary = "try-context"
            elif parent.type in {"switch_statement", "switch_case", "switch_default"}:
                boundary = "switch-context"
            elif (
                parent.type == "binary_expression"
                and any(t in {"&&", "||", "??"} for t in parent.tokens)
                and same(child, parent.fields.get("right"))
            ):
                boundary = "short-circuit-context"
            if boundary:
                properties.append(("condition", boundary))
                diagnose("control-context", node)
            child, parent = parent, view.parent(parent)
        return properties

    def emit(node, role, rule, basis, properties):
        nonlocal units, facts, stopped, truncated
        if stopped:
            return
        subject = view.owner(node)
        if not subject:
            diagnose("owner-unavailable", node)
            return
        all_properties = context(node) + properties + [("unit-complete", True)]
        units += 1
        if units > RULES["maxUnits"] or facts + len(all_properties) + 1 > RULES["maxFacts"]:
            truncated = stopped = True
            diagnose("unit-limit", node)
            return
        values = [
            string(value) if isinstance(value, str) else boolean(value)
            for _, value in all_properties
        ]
        if any(
            len(canonical_json(value).encode()) > view.limits["maxValueBytes"] for value in values
        ):
            diagnose("value-limit", node)
            return
        evidence = {"ruleId": rule, "basis": basis, "span": view.span(node)}
        facts += 1
        if not emitter.role(subject["key"], f"implementation.{role}", evidence):
            stopped = truncated = True
            return
        for (prop, _), value in zip(all_properties, values):
            budget.step()
            facts += 1
            if not emitter.property(
                subject["key"], f"implementation.{prop}", "literal", value, evidence
            ):
                stopped = truncated = True
                return

    def safe_key(key):
        return (
            isinstance(key, str)
            and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is not None
            and len(key.encode()) <= RULES["maxKeyBytes"]
        )

    def static_key(node):
        budget.step(512)
        constant = view.constant(node)
        return (
            constant.get("value")
            if constant.get("known") and safe_key(constant.get("value"))
            else None
        )

    def member_name(node):
        if node.type == "member_expression" and node.fields.get("property"):
            return view.name(node.fields["property"])
        if node.type == "subscript_expression" and node.fields.get("index"):
            return static_key(node.fields["index"])
        return None

    def optional_receiver(node):
        at = view.unwrap(node)
        while at.type in _MEMBERS and at.fields.get("object"):
            if optional(at):
                return True
            budget.step()
            at = view.unwrap(at.fields["object"])
        return optional(at)

    def origin(node):
        budget.step(512)
        result = view.resolve(node)
        return result if result.get("kind") == "import" else None

    # Ambiguous bindings must never be promoted to an assumed ambient global.
    declared_process = any(item.get("name") == "process" for item in view.declarations)
    replaced_meta_env = False
    for node in view.nodes:
        budget.step()
        if view.name(node) == "process":
            child, parent, depth = node, view.parent(node), 0
            while parent:
                depth += 1
                if depth > RULES["maxContextDepth"]:
                    break
                budget.step()
                if (
                    parent.type
                    in {
                        "formal_parameters",
                        "required_parameter",
                        "optional_parameter",
                        "import_clause",
                        "catch_clause",
                    }
                    or parent.type in _CALLABLES
                    and same(parent.fields.get("parameter"), child)
                ):
                    declared_process = True
                    break
                if parent.type in {"statement_block", "program"}:
                    break
                child, parent = parent, view.parent(parent)
        target = (
            node.fields.get("left") or node.fields.get("argument")
            if node.type in _WRITES
            else node.children[0]
            if node.type == "unary_expression" and "delete" in node.tokens and node.children
            else None
        )
        if not target:
            continue
        at = view.unwrap(target)
        if view.name(at) == "process":
            declared_process = True
        if at.type in _MEMBERS and member_name(at) == "env" and at.fields.get("object"):
            base = view.unwrap(at.fields["object"])
            if view.name(base) == "process":
                declared_process = True
            if base.type == "meta_property":
                replaced_meta_env = True

    def environment(input_node):
        node = view.unwrap(input_node)
        if node.type in _MEMBERS and member_name(node) == "env" and node.fields.get("object"):
            base = view.unwrap(node.fields["object"])
            if base.type == "meta_property" and re.fullmatch(
                r"import\s*\.\s*meta", view.text(base)
            ):
                if replaced_meta_env or optional_receiver(node):
                    diagnose("config-pattern", node)
                    return None
                return {"source": "import.meta.env", "provenance": "syntax", "basis": "syntax"}
            if (
                base.type == "identifier"
                and view.name(base) == "process"
                and not view.binding(base)
            ):
                if declared_process or optional_receiver(node):
                    diagnose("config-pattern", node)
                    return None
                return {
                    "source": "process.env",
                    "provenance": "ambient-assumed",
                    "basis": "convention",
                }
        if node.type != "identifier" and node.type not in _MEMBERS:
            return None
        bound = origin(node)
        if (
            bound
            and bound["module"] in RULES["processModules"]
            and (
                bound["name"] == "env"
                and not bound.get("member")
                or bound["name"] == "default"
                and bound.get("member") == "env"
            )
        ):
            if optional_receiver(node):
                diagnose("config-pattern", node)
                return None
            return {"source": "process.env", "provenance": "import-bound", "basis": "import-bound"}
        return None

    def env_properties(env, key):
        condition = (
            "ambient-api-assumed"
            if env["provenance"] == "ambient-assumed"
            else "environment-provenance-unproven"
            if env["source"] == "import.meta.env"
            else "import-contract-not-runtime"
        )
        return [
            ("config-key", key),
            ("config-source", env["source"]),
            ("config-provenance", env["provenance"]),
            ("condition", condition),
        ]

    def fallback(node):
        at, parent = outer(node)
        if (
            parent
            and parent.type == "binary_expression"
            and same(parent.fields.get("left"), at)
            and parent.fields.get("right")
        ):
            operator = next((token for token in parent.tokens if token in {"??", "||"}), None)
            if operator:
                return [
                    ("fallback", loc(parent.fields["right"])),
                    ("fallback-expression", loc(parent)),
                    ("fallback-semantics", "nullish" if operator == "??" else "falsy"),
                ]
        return []

    registrations, registration_calls = {}, set()
    for node in view.nodes:
        budget.step()
        if stopped:
            break
        if node.type != "call_expression" or not node.fields.get("function"):
            continue
        bound = origin(node.fields["function"])
        if not bound or bound["module"] not in RULES["testModules"]:
            continue
        api = (
            "test"
            if bound["name"] == "default" and bound["module"] == "node:test"
            else bound["name"]
        )
        if api not in {"test", "it"}:
            continue
        registration_calls.add(loc(node))
        parameters = args(node)
        callback = view.unwrap(parameters[1]) if len(parameters) > 1 else None
        if (
            bound.get("member")
            or optional(node)
            or optional_receiver(node.fields["function"])
            or len(parameters) != 2
            or not callback
            or callback.type not in {"arrow_function", "function_expression"}
        ):
            diagnose("test-shape", node)
            continue
        registrations[loc(callback)] = {"runner": bound["module"], "api": api}
        emit(
            node,
            "test",
            "test-registration-v1",
            "import-bound",
            [
                ("runner", bound["module"]),
                ("api", api),
                ("callback", loc(callback)),
                ("test-name", loc(parameters[0])),
            ],
        )

    for node in view.nodes:
        budget.step()
        if stopped:
            break
        if node.type in {"return_statement", "throw_statement"}:
            value = next((child for child in node.children if child.type != "comment"), None)
            emit(
                node,
                "return" if node.type == "return_statement" else "throw",
                "local-outcome-v1",
                "syntax",
                [("value", loc(value))] if value else [],
            )
        elif node.type in _WRITES:
            target, value = (
                node.fields.get("left") or node.fields.get("argument"),
                node.fields.get("right"),
            )
            operator = next((token for token in node.tokens if token in _OPERATORS), None)
            if not target or not operator or target.type in {"object_pattern", "array_pattern"}:
                diagnose("write-shape", node)
                continue
            emit(
                node,
                "update" if node.type == "update_expression" else "assignment",
                "local-write-v1",
                "syntax",
                [("target", loc(target)), ("operator", operator)]
                + ([("value", loc(value))] if value else []),
            )
        if node.type in _MEMBERS and node.fields.get("object"):
            env = environment(node.fields["object"])
            if env:
                at, parent = outer(node)
                write = parent and (
                    parent.type in _WRITES
                    and (
                        same(parent.fields.get("left"), at)
                        or same(parent.fields.get("argument"), at)
                    )
                    or parent.type == "unary_expression"
                    and "delete" in parent.tokens
                )
                if write:
                    continue
                key = member_name(node)
                if not safe_key(key) or optional(node):
                    diagnose("config-key", node)
                    continue
                emit(
                    node,
                    "config-read",
                    "environment-read-v1",
                    env["basis"],
                    env_properties(env, key) + fallback(node),
                )
            if member_name(node) == "env" and environment(node):
                at, parent = outer(node)
                key_read = (
                    parent and parent.type in _MEMBERS and same(parent.fields.get("object"), at)
                )
                pattern = (
                    parent
                    and parent.type == "variable_declarator"
                    and parent.fields.get("name")
                    and parent.fields["name"].type == "object_pattern"
                    and same(parent.fields.get("value"), at)
                )
                if not key_read and not pattern:
                    diagnose("config-pattern", node)
        if (
            node.type == "variable_declarator"
            and node.fields.get("value")
            and node.fields.get("name")
            and node.fields["name"].type == "object_pattern"
        ):
            env = environment(node.fields["value"])
            if env:
                for element in node.fields["name"].children:
                    budget.step()
                    if element.type == "comment":
                        continue
                    key = default_value = None
                    if element.type == "shorthand_property_identifier_pattern":
                        key = view.name(element)
                    elif element.type == "object_assignment_pattern":
                        key = (
                            view.name(element.fields["left"])
                            if element.fields.get("left")
                            else None
                        )
                        default_value = element.fields.get("right")
                    elif element.type == "pair_pattern" and element.fields.get("key"):
                        field = element.fields["key"]
                        key = (
                            static_key(field.children[0])
                            if field.type == "computed_property_name" and field.children
                            else view.name(field)
                            if field.type != "computed_property_name"
                            else None
                        )
                        value = element.fields.get("value")
                        if value and value.type == "assignment_pattern":
                            default_value = value.fields.get("right")
                        elif not value or value.type != "identifier":
                            key = None
                    if not safe_key(key):
                        diagnose("config-pattern", element)
                        continue
                    properties = env_properties(env, key)
                    if default_value:
                        properties += [
                            ("fallback", loc(default_value)),
                            ("fallback-expression", loc(element)),
                            ("fallback-semantics", "undefined"),
                        ]
                    emit(element, "config-read", "environment-read-v1", env["basis"], properties)
        if (
            node.type != "call_expression"
            or not node.fields.get("function")
            or loc(node) in registration_calls
        ):
            continue
        fn, parameters = view.unwrap(node.fields["function"]), args(node)
        matcher = actual = expected = None
        negated = recognized = False
        async_mode = "sync"
        if fn.type == "member_expression" and fn.fields.get("object") and fn.fields.get("property"):
            matcher = view.name(fn.fields["property"])
            base, modifiers, optional_modifier = view.unwrap(fn.fields["object"]), [], False
            while (
                base.type == "member_expression"
                and base.fields.get("object")
                and base.fields.get("property")
                and len(modifiers) < 4
            ):
                budget.step()
                optional_modifier = optional_modifier or optional(base)
                modifiers.insert(0, view.name(base.fields["property"]) or "")
                base = view.unwrap(base.fields["object"])
            if base.type == "call_expression" and base.fields.get("function"):
                bound = origin(base.fields["function"])
                recognized = bool(
                    bound
                    and bound["module"] in {"bun:test", "vitest"}
                    and bound["name"] == "expect"
                )
                if recognized and bound:
                    values = args(base)
                    valid_modifiers = (
                        len(modifiers) <= 2
                        and len(set(modifiers)) == len(modifiers)
                        and all(item in {"not", "resolves", "rejects"} for item in modifiers)
                        and not {"resolves", "rejects"}.issubset(modifiers)
                    )
                    if (
                        bound.get("member")
                        or matcher not in _EXPECT
                        or len(parameters) != _EXPECT[matcher]
                        or len(values) != 1
                        or not valid_modifiers
                        or optional_modifier
                        or optional(base)
                        or optional(fn)
                        or optional_receiver(base.fields["function"])
                    ):
                        diagnose("assertion-shape", node)
                        continue
                    actual, expected = values[0], parameters[0] if parameters else None
                    negated = "not" in modifiers
                    async_mode = next((item for item in modifiers if item != "not"), "sync")
        if not recognized:
            bound = origin(fn)
            if bound and bound["module"] in RULES["assertModules"]:
                recognized = True
                matcher = (
                    bound.get("member") or "ok"
                    if bound["name"] in {"default", "*", "strict"}
                    else f"{bound['name']}.{bound['member']}"
                    if bound.get("member")
                    else bound["name"]
                )
                if matcher not in _ASSERT or len(parameters) != _ASSERT[matcher]:
                    diagnose("assertion-shape", node)
                    continue
                actual, expected = parameters[0], parameters[1] if len(parameters) > 1 else None
                negated = matcher.startswith("not") or matcher == "doesNotMatch"
        if not recognized or not actual or not matcher:
            continue
        if (
            optional(node)
            or optional_receiver(fn)
            or any(item.type == "spread_element" for item in parameters)
        ):
            diagnose("assertion-shape", node)
            continue
        callable_node = owner(node)
        if not callable_node or loc(callable_node) not in registrations:
            diagnose("assertion-owner", node)
            continue
        _, parent = outer(node)
        properties = [("test-owner", loc(callable_node)), ("actual", loc(actual))]
        if expected:
            properties.append(("expected", loc(expected)))
        properties += [
            ("matcher", matcher),
            ("negated", negated),
            ("async-mode", async_mode),
            ("awaited", bool(parent and parent.type == "await_expression")),
        ]
        emit(node, "assertion", "test-assertion-v1", "import-bound", properties)
    return {
        "state": "truncated"
        if truncated
        else "partial"
        if partial
        else "complete"
        if facts
        else "not-applicable",
        "diagnostics": diagnostics,
    }
