"""Conditional, reviewed primitive Zod contracts with a complete import census."""

import re

from ._evidence import (
    Census,
    CensusLimit,
    IDENTIFIERS,
    args,
    boolean,
    children,
    descriptor,
    dynamic_exposure,
    identifier,
    import_reference,
    integer,
    locator,
    node_key,
    optional,
    same,
    string,
)


ATOMIC = True
RULES = {
    "version": 1,
    "spanEncoding": "s:utf8-start:utf8-end:start-line:end-line",
    "rules": [
        "zod-object-parse-v1",
        "zod-object-safe-parse-v1",
        "zod-value-kind-v1",
        "zod-minimum-v1",
        "zod-maximum-v1",
    ],
    "module": "zod",
    "importedName": "z",
    "reviewedAPI": "zod-v4.1.12",
    "contractID": "zod-v4.1.12-primitive-object-v1",
    "reviewedSources": [
        "https://raw.githubusercontent.com/colinhacks/zod/v4.1.12/packages/zod/src/v4/core/checks.ts",
        "https://raw.githubusercontent.com/colinhacks/zod/v4.1.12/packages/zod/src/v4/core/parse.ts",
    ],
    "conditions": [
        "reviewed-api-assumed",
        "reviewed-zod-utf16-api-assumed",
        "installed-version-not-captured",
        "external-mutation-not-observed",
        "execution-not-observed",
    ],
    "limitations": [
        "unknown-object-keys-not-strict",
        "number-finiteness-not-claimed",
        "number-integrality-not-claimed",
    ],
    "modes": {
        "parse": {"condition": "normal-validation-return", "returnTarget": "return"},
        "safeParse": {"condition": "success-true", "returnTarget": "return.data"},
    },
    "predicates": ["value_kind", "minimum", "maximum"],
    "valueKinds": ["string", "number", "boolean"],
    "metrics": ["value-kind", "utf16-length", "numeric-value"],
    "numericLiteral": r"-?[ \t\r\n]*(0|[1-9][0-9]*)",
    "maxSourceBytes": 256 * 1024,
    "maxWork": 100000,
    "maxDepth": 64,
    "maxFields": 8,
    "maxUses": 8,
    "maxAtoms": 128,
    "maxFacts": 1024,
    "maxFieldKeyBytes": 128,
    "maxIdentifierBytes": 128,
}
DESCRIPTOR = descriptor(
    "validation-contract",
    {
        "validation-use": "Qualified Inline Validation Use",
        "validation-predicate": "Source-Declared Validation Predicate",
    },
    references={"import-reference": "Exact Named Zod Import"},
    spans={
        "import": "Named Import Specifier",
        "owner": "Exact Lexical Callable",
        "parameter": "Required Parameter Identifier",
        "argument": "Exact Parameter Argument",
        "schema": "Inline Object Schema Call",
        "call": "Validation Call",
        "return": "Sole Return Or Arrow Expression",
        "key": "Field Key",
        "type": "Primitive Method",
        "method": "Validation Or Predicate Method",
        "bound": "Numeric Bound Literal",
    },
    strings={
        "mode": "Parse Mode",
        "return-target": "Conditional Return Target",
        "condition": "Reviewed Contract Condition",
        "field-key": "Identifier Field Key",
        "predicate": "Closed Predicate Kind",
        "value-kind": "Closed Primitive Kind",
        "metric": "Closed Predicate Metric",
    },
    integers={
        "predicate-count": "Complete Use Predicate Census",
        "use-count": "Complete Source Use Census",
        "bound-value": "Literal Safe Integer Bound",
    },
    booleans={
        "inventory-complete": "Full Import Usage Inventory",
        "unit-complete": "Whole Qualified Evidence Unit",
    },
    span_description="Exact source span locator, never embedded source text.",
)
_BAD_PLACEMENT = {
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "try_statement",
    "catch_clause",
    "switch_statement",
    "ternary_expression",
    "binary_expression",
    "method_definition",
    "class_static_block",
}


def analyze(view, budget, emitter):
    if view.state != "complete":
        return {"state": view.state, "diagnostics": []}
    census = Census(
        "validation-contract",
        "File-local validation qualification is incomplete or outside the reviewed contract.",
        RULES,
        view,
        budget,
    )

    def member_call(node):
        if (
            not node
            or node.type != "call_expression"
            or not node.fields.get("arguments")
            or node.fields.get("type_arguments")
            or optional(node)
        ):
            return None
        fn = node.fields.get("function")
        if (
            not fn
            or fn.type != "member_expression"
            or optional(fn)
            or not fn.fields.get("property")
            or fn.fields["property"].type != "property_identifier"
            or not fn.fields.get("object")
        ):
            return None
        return {
            "receiver": fn.fields["object"],
            "method": fn.fields["property"],
            "name": view.text(fn.fields["property"]),
            "args": args(node),
        }

    def span(node):
        return string(locator(view, node))

    try:
        census.check_tree()
        imports, import_tokens, import_names = {}, set(), set()
        for node in view.nodes:
            census.step()
            if dynamic_exposure(view, node):
                census.diagnose("dynamic-scope", node)
            if (
                node.type != "import_statement"
                or not node.fields.get("source")
                or "type" in node.tokens
            ):
                continue
            module = view.moduleIdentity(node.fields["source"])
            if module in {"node:module", "module"}:
                census.diagnose("dynamic-scope", node)
            if module != RULES["module"] and not (module and module.startswith("zod/")):
                continue
            clause = next((child for child in node.children if child.type == "import_clause"), None)
            for part in children(clause):
                if part.type != "named_imports":
                    census.diagnose("import-shape", part)
                    continue
                for specifier in children(part):
                    census.step()
                    if "type" in specifier.tokens:
                        continue
                    name = specifier.fields.get("name")
                    local = specifier.fields.get("alias") or name
                    if (
                        module != RULES["module"]
                        or not name
                        or view.text(name) != RULES["importedName"]
                        or name.type != "identifier"
                        or not local
                        or local.type != "identifier"
                        or not identifier(view, local, RULES["maxIdentifierBytes"])
                    ):
                        census.diagnose("import-shape", specifier)
                        continue
                    imports[node_key(local)] = specifier
                    import_names.add(view.name(local))
                    import_tokens.update((node_key(local), node_key(name)))
        if not imports:
            return {"state": "not-applicable", "diagnostics": []}

        def imported_at(node):
            if node.type != "identifier":
                return None
            origin = census.binding(node)
            if (
                origin
                and origin["kind"] == "import"
                and not origin.get("typeOnly")
                and origin.get("available")
                and origin.get("stable")
            ):
                return imports.get(node_key(origin["node"]))
            return None

        allowed, uses = set(), []
        retained = {declaration["key"] for declaration in view.declarations}
        atom_count = 0
        for node in view.nodes:
            census.step()
            call = member_call(node)
            if not call or call["name"] not in {"parse", "safeParse"}:
                continue
            schema = member_call(call["receiver"])
            if not schema or schema["name"] != "object":
                continue
            imported = imported_at(schema["receiver"])
            if not imported:
                continue
            shape = schema["args"][0] if schema["args"] else None
            if (
                len(schema["args"]) != 1
                or not shape
                or shape.type != "object"
                or len(call["args"]) != 1
                or call["args"][0].type != "identifier"
            ):
                census.diagnose("schema-shape", node)
                continue
            returned, owner = node, view.parent(node)
            if owner and owner.type == "return_statement":
                returned = owner
                block = view.parent(owner)
                owner = view.parent(block) if block else None
                if (
                    not block
                    or block.type != "statement_block"
                    or len(children(block)) != 1
                    or not owner
                    or not same(owner.fields.get("body"), block)
                ):
                    census.diagnose("owner-shape", node)
                    continue
            elif (
                not owner
                or owner.type != "arrow_function"
                or not same(owner.fields.get("body"), node)
            ):
                census.diagnose("owner-shape", node)
                continue
            if (
                owner.type not in {"function_declaration", "function_expression", "arrow_function"}
                or "async" in owner.tokens
                or owner.fields.get("type_parameters")
            ):
                census.diagnose("owner-shape", owner)
                continue
            formal = owner.fields.get("parameters") or owner.fields.get("parameter")
            parameters = (
                children(formal)
                if formal and formal.type == "formal_parameters"
                else [formal]
                if formal
                else []
            )
            parameter = (
                parameters[0].fields.get("pattern")
                if parameters and parameters[0].type == "required_parameter"
                else parameters[0]
                if parameters
                else None
            )
            if (
                len(parameters) != 1
                or not parameter
                or parameter.type != "identifier"
                or not identifier(view, parameter, RULES["maxIdentifierBytes"])
                or parameters[0].fields.get("value")
                or "?" in parameters[0].tokens
                or "=" in parameters[0].tokens
            ):
                census.diagnose("parameter-shape", owner)
                continue
            argument = call["args"][0]
            origin = census.binding(argument)
            # Sole-return syntax, not const or parameter immutability, proves this use.
            if (
                not origin
                or origin["kind"] != "parameter"
                or not origin.get("available")
                or not same(origin["node"], parameter)
                or view.text(argument) != view.text(parameter)
            ):
                census.diagnose("argument-binding", argument)
                continue
            ancestor, placement = view.parent(owner), True
            while ancestor:
                census.step()
                if ancestor.type in _BAD_PLACEMENT:
                    placement = False
                ancestor = view.parent(ancestor)
            if not placement:
                census.diagnose("owner-placement", owner)
                continue
            fields = children(shape)
            if len(fields) > RULES["maxFields"]:
                census.limit("field-limit")
            if not fields:
                census.diagnose("schema-shape", shape)
                continue
            keys, atoms, accepted, valid = set(), [], [schema["receiver"]], True
            for field in fields:
                census.step()
                key, value = field.fields.get("key"), field.fields.get("value")
                key_text = view.text(key) if key else ""
                if (
                    field.type != "pair"
                    or not key
                    or key.type != "property_identifier"
                    or not identifier(view, key, RULES["maxFieldKeyBytes"])
                    or key_text == "__proto__"
                    or key_text in keys
                    or not value
                ):
                    valid = False
                    break
                keys.add(key_text)
                current, primitive, bounds, methods = value, member_call(value), [], set()
                while primitive and primitive["name"] in {"min", "max"}:
                    census.step()
                    bound = primitive["args"][0] if primitive["args"] else None
                    negative = (
                        bound and bound.type == "unary_expression" and tuple(bound.tokens) == ("-",)
                    )
                    number = bound.fields.get("argument") if bound and negative else bound
                    raw = view.text(number) if number and number.type == "number" else ""
                    # Bound digit length before int conversion, including Python's own digit cap.
                    valid_number = bool(re.fullmatch(r"0|[1-9][0-9]*", raw)) and len(raw) <= 16
                    numeric = int(raw) * (-1 if negative else 1) if valid_number else 0
                    if (
                        len(primitive["args"]) != 1
                        or not bound
                        or not valid_number
                        or abs(numeric) > 9007199254740991
                        or primitive["name"] in methods
                    ):
                        valid = False
                        break
                    if negative and not re.fullmatch(
                        r"-[ \t\r\n]*(0|[1-9][0-9]*)", view.text(bound)
                    ):
                        valid = False
                        break
                    methods.add(primitive["name"])
                    bounds.append(
                        {
                            "node": current,
                            "method": primitive["method"],
                            "bound": bound,
                            "value": numeric,
                            "predicate": "minimum" if primitive["name"] == "min" else "maximum",
                        }
                    )
                    current = primitive["receiver"]
                    primitive = member_call(current)
                if (
                    not valid
                    or not primitive
                    or primitive["name"] not in {"string", "number", "boolean"}
                    or primitive["args"]
                    or not same(imported_at(primitive["receiver"]), imported)
                ):
                    valid = False
                    break
                kind = primitive["name"]
                if (
                    bounds
                    and kind == "boolean"
                    or kind == "string"
                    and any(bound["value"] < 0 for bound in bounds)
                ):
                    valid = False
                    break
                atoms.append(
                    {
                        "node": current,
                        "key": key,
                        "type": primitive["method"],
                        "method": primitive["method"],
                        "kind": kind,
                        "predicate": "value_kind",
                    }
                )
                atoms.extend(
                    {**bound, "key": key, "type": primitive["method"], "kind": kind}
                    for bound in reversed(bounds)
                )
                accepted.append(primitive["receiver"])
            if not valid:
                census.diagnose("predicate-shape", shape)
                continue
            if len(uses) >= RULES["maxUses"]:
                census.limit("use-limit")
            atom_count += len(atoms)
            if atom_count > RULES["maxAtoms"]:
                census.limit("atom-limit")
            subject = view.owner(node)
            if not subject or subject["key"] not in retained:
                census.limit("inventory-limit")
            allowed.update(node_key(item) for item in accepted)
            uses.append(
                {
                    "node": node,
                    "schema": call["receiver"],
                    "method": call["method"],
                    "mode": call["name"],
                    "imported": imported,
                    "owner": owner,
                    "parameter": parameter,
                    "argument": argument,
                    "returned": returned,
                    "atoms": atoms,
                    "subject": subject["key"],
                }
            )
        for node in view.nodes:
            census.step()
            if node.type not in IDENTIFIERS or node_key(node) in import_tokens:
                continue
            origin = census.binding(node)
            if origin and origin["kind"] == "import" and node_key(origin["node"]) in imports:
                if (
                    not origin.get("stable")
                    or not origin.get("available")
                    or origin.get("typeOnly")
                    or node_key(node) not in allowed
                ):
                    census.diagnose("import-use", node)
            elif not origin and view.name(node) in import_names:
                census.diagnose("ambiguous-reference", node)
        if census.partial:
            return census.report()
        for use in uses:
            census.step()
            mode = RULES["modes"][use["mode"]]
            properties = [
                ("import-reference", import_reference(RULES["module"], RULES["importedName"])),
                ("import", span(use["imported"])),
                ("owner", span(use["owner"])),
                ("parameter", span(use["parameter"])),
                ("argument", span(use["argument"])),
                ("schema", span(use["schema"])),
                ("call", span(use["node"])),
                ("return", span(use["returned"])),
                ("method", span(use["method"])),
                ("mode", string(use["mode"])),
                ("return-target", string(mode["returnTarget"])),
                ("predicate-count", integer(len(use["atoms"]))),
                ("use-count", integer(len(uses))),
                *[
                    ("condition", string(condition))
                    for condition in [*RULES["conditions"], mode["condition"]]
                ],
                ("inventory-complete", boolean(True)),
                ("unit-complete", boolean(True)),
            ]
            census.stage(
                use["node"],
                use["subject"],
                "validation-use",
                RULES["rules"][0 if use["mode"] == "parse" else 1],
                properties,
            )
            for atom in use["atoms"]:
                census.step()
                predicate = atom["predicate"]
                metric = (
                    "value-kind"
                    if predicate == "value_kind"
                    else "utf16-length"
                    if atom["kind"] == "string"
                    else "numeric-value"
                )
                properties = [
                    ("call", span(use["node"])),
                    ("field-key", string(view.text(atom["key"]))),
                    ("key", span(atom["key"])),
                    ("type", span(atom["type"])),
                    ("method", span(atom["method"])),
                    ("predicate", string(predicate)),
                    ("value-kind", string(atom["kind"])),
                    ("metric", string(metric)),
                ]
                if atom.get("bound"):
                    properties += [
                        ("bound", span(atom["bound"])),
                        ("bound-value", integer(atom["value"])),
                    ]
                properties.append(("unit-complete", boolean(True)))
                census.stage(
                    atom["node"],
                    use["subject"],
                    "validation-predicate",
                    RULES["rules"][
                        2 if predicate == "value_kind" else 3 if predicate == "minimum" else 4
                    ],
                    properties,
                )
        census.emit(emitter)
    except CensusLimit:
        pass
    return census.report()
