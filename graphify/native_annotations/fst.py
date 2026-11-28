"""File-local FST source annotations, independent of the analyzed runtime."""

import re

from ..framework_evidence import canonical_json
from .fst_core import analyze_core
from .fst_rules import RETURN_CONTRACTS, canonical_api
from .fst_safety import family_safety

_ROLES = {
    "component": "FST Component",
    "state": "FST State",
    "form": "FST Form",
    "scope": "FST Scope",
    "item-scope": "FST Item Scope",
    "field": "FST Field",
    "field-binding": "Borrowed Field Binding",
    "lifecycle-hook": "Declared Lifecycle Hook",
    "registration": "Explicit Registration",
    "api-handle": "Reviewed FST API Handle",
    "component-factory": "Authored Component Factory",
}
_PROPERTIES = {
    "name": ("Trace Name", False),
    "design-name": ("Design Name", False),
    "design-concept": ("Design Concept", False),
    "field-path": ("Literal Field Path", False),
    "lifetime-operation": ("Requested Lifetime Operation", True),
    "lookup-policy": ("Requested Lookup Policy", True),
    "instance-kind": ("Instance Construction", True),
    "hook-kind": ("Declared Hook Contract", False),
    "registration-kind": ("Registration API", True),
    "observation-phase": ("Field Observation Phase", True),
    "field-operation": ("Field Invocation", True),
    "field-dispatch": ("Conditional Field Invocation Contract", True),
    "list-contribution": ("Ordered List Item Contribution", True),
    "ownership": ("Binding Ownership", False),
    "change-argument": ("OnChangeArgs Snapshot Binding", True),
    "children-change-argument": ("Children Change Snapshot Binding", True),
    "api-operation": ("Explicit API Operation", True),
    "api-policy": ("Reviewed API Boundary", True),
    "handle-kind": ("Reviewed Return Handle Kind", False),
    "key": ("Literal API Key Or Delay", True),
    "option": ("Literal API Option", True),
    "callback-binding": ("Callback Payload Binding", True),
    "route-entry": ("Authored Route Entry", True),
    "route-path": ("Authored Route Path", True),
    "component-return": ("Component Construction Boundary", True),
}
_RELATIONS = {
    "factory": "Declared Factory Import",
    "implemented-by": "Renderer",
    "props-type": "Props Type",
    "extends": "Declared Base",
    "type-argument": "Generic Type Argument",
    "lifetime-target": "Lifetime Call Target",
    "form-origin": "Form Expression",
    "field-path-expression": "Field Path Expression",
    "field-type": "Field Type Reference",
    "value-type": "Value Type",
    "borrows": "Borrowed Field Source",
    "callback": "Registered Callback",
    "observes": "Explicit Dependency",
    "field-target": "Field Call Target",
    "field-argument": "Conditional Field Argument Expression",
    "field-write-options": "Conditional Field Write Options",
    "list-item-source": "List Item Or Iterable Expression",
    "list-construction": "Containing List Construction",
    "change-argument-source": "OnChangeArgs Snapshot Dependency",
    "operation-target": "Direct API Operation Target",
    "source": "Explicit API Input",
    "key-expression": "API Key Or Delay Expression",
    "callback-source": "Callback Payload Source",
    "subform-origin": "Subform Prefix Expression",
    "route-component": "Authored Route Component",
    "route-option": "Authored Route Option",
    "route-definition": "Authored Route Definition",
    "returns-component": "Returned Component Construction",
    "returned-renderer": "Returned Component Renderer",
    "returned-options": "Returned Component Options Expression",
}
DESCRIPTOR = {
    "id": "fst-solid",
    "version": "1",
    "languages": ["typescript", "tsx"],
    "view": {"id": "typescript", "version": 1},
    "roles": [{"id": f"fst-solid.{name}", "label": label} for name, label in _ROLES.items()],
    "properties": [
        {"id": f"fst-solid.{name}", "label": label, "multiple": multiple, "valueKind": "string"}
        for name, (label, multiple) in _PROPERTIES.items()
    ],
    "relations": [
        {"id": f"fst-solid.{name}", "label": label} for name, label in _RELATIONS.items()
    ],
}
_FAMILIES = {"State": "state", "Form": "form", "Scope": "scope", "ItemScope": "item-scope"}
_LIFETIME = {
    "state": ("new", "newScoped", "use", "useOrNull", "useOrNewScoped", "useGlobal", "asScoped"),
    "form": ("new", "newScoped", "use", "useOrNewScoped", "useGlobal", "asScoped"),
    "scope": ("newScoped", "use", "useOrNewScoped"),
    "item-scope": ("newScoped", "use"),
}
_LIFETIME_NAMES = set().union(*_LIFETIME.values())
_FUNCTIONS = {
    "arrow_function",
    "function_expression",
    "function_declaration",
    "generator_function",
    "generator_function_declaration",
}
_WRAPPERS = {
    "parenthesized_expression",
    "as_expression",
    "satisfies_expression",
    "type_assertion",
    "non_null_expression",
    "instantiation_expression",
}
_FORBIDDEN_STRING = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]")
_COMMENTS = re.compile(r"/\*[\s\S]*?\*/|//[^\r\n]*")


def analyze(view, budget, emitter):
    if view.state in ("truncated", "unsupported", "failed"):
        return {"state": view.state, "diagnostics": []}
    if not any(
        node.type == "import_statement"
        and node.fields.get("source") is not None
        and (view.moduleIdentity(node.fields["source"]) or "").startswith(
            "@fst/components-fst-solid/"
        )
        for node in view.nodes
    ):
        return {"state": "not-applicable", "diagnostics": []}
    diagnostics = []
    matched = partial = False

    def diagnose(code, message, node):
        nonlocal partial
        partial = True
        if len(diagnostics) < 16 and not any(item["code"] == code for item in diagnostics):
            diagnostics.append({"code": code, "message": message, "span": view.span(node)})

    def evidence(node, rule, basis="import-bound"):
        return {"ruleId": rule, "basis": basis, "span": view.span(node)}

    def wire_size(value):
        return len(canonical_json(value).encode("utf-8"))

    def role(subject, term, node, rule):
        nonlocal matched
        matched = True
        emitter.role(subject["key"], term, evidence(node, rule))

    def property_fact(subject, term, value, node, rule, resolution="literal"):
        nonlocal matched
        matched = True
        emitter.property(
            subject["key"],
            term,
            resolution,
            {"kind": "string", "value": value},
            evidence(node, rule),
        )

    def relation(subject, term, target, node, rule, basis="import-bound"):
        nonlocal matched
        budget.step()
        if wire_size(target) > view.limits["maxValueBytes"]:
            diagnose(
                "fst-solid.reference-limit",
                "Source reference exceeds the bounded wire value size.",
                node,
            )
            return
        matched = True
        emitter.relation(subject["key"], term, target, evidence(node, rule, basis))

    def api(input_node, space="value"):
        if input_node is None:
            return None
        origin = view.resolve(input_node, space)
        return (
            canonical_api(origin["module"], origin["name"])
            if origin["kind"] == "import" and not origin.get("member")
            else None
        )

    def arguments_of(node):
        arguments = node.fields.get("arguments")
        return (
            [child for child in arguments.children if child.type != "comment"]
            if arguments is not None
            else []
        )

    def member(node):
        value = view.unwrap(node)
        if value.type != "member_expression" or "?." in value.tokens:
            return None
        obj, prop = value.fields.get("object"), value.fields.get("property")
        if obj is None or prop is None:
            return None
        name = view.name(prop)
        return {"object": obj, "name": view.text(prop) if name is None else name}

    declaration_map = {declaration["key"]: declaration for declaration in view.declarations}
    classes = {}

    def extension_of(node):
        heritage = (
            next((child for child in node.children if child.type == "class_heritage"), None)
            if node is not None
            else None
        )
        return (
            next((child for child in heritage.children if child.type == "extends_clause"), None)
            if heritage is not None
            else None
        )

    def classify(declaration, seen=None):
        seen = set() if seen is None else seen
        budget.step()
        budget.depth(len(seen))
        key = declaration["key"]
        if key in classes:
            return classes[key]
        if declaration["kind"] != "class" or key in seen or len(seen) >= 24:
            return None
        seen.add(key)
        node = view.declarationNode(key)
        extension = extension_of(node)
        base = extension.fields.get("value") if extension is not None else None
        if node is None or extension is None or base is None:
            return None
        name, resolved = api(base), view.resolve(base)
        parent = declaration_map.get(resolved["key"]) if resolved["kind"] == "declaration" else None
        inherited = classify(parent, seen) if parent else None
        family = (_FAMILIES.get(name) if name is not None else None) or (
            inherited["family"] if inherited else None
        )
        if not family:
            return None
        info = {"declaration": declaration, "node": node, "family": family}
        if inherited:
            info["base"] = inherited
        classes[key] = info
        role(
            declaration,
            f"fst-solid.{family}",
            base,
            "local-base-family" if inherited else "base-family",
        )
        relation(declaration, "fst-solid.extends", resolved, base, "base-family")
        types = extension.fields.get("type_arguments")
        for type_node in types.children if types is not None else ():
            relation(
                declaration,
                "fst-solid.type-argument",
                view.reference(type_node, "type"),
                type_node,
                "base-types",
                "syntax",
            )
        return info

    for declaration in view.declarations:
        if declaration["kind"] != "class" or classify(declaration):
            continue
        extension = extension_of(view.declarationNode(declaration["key"]))
        base = extension.fields.get("value") if extension is not None else None
        if base is not None and view.resolve(base)["kind"] in ("import", "declaration"):
            diagnose(
                "fst-solid.unresolved-base",
                "Base-family heritage is not proven through a bounded local canonical inheritance chain.",
                base,
            )

    def class_of(node):
        reference = view.resolve(node)
        return classes.get(reference["key"]) if reference["kind"] == "declaration" else None

    def overrides(info, name, is_static):
        current = info
        while current:
            budget.step()
            body = current["node"].fields.get("body")
            for child in body.children if body is not None else ():
                budget.step()
                if is_static and child.type == "class_static_block":
                    return True
                declaration = view.declarationAt(child)
                name_node = child.fields.get("name")
                member_name = declaration.get("name") if declaration else None
                if member_name is None and name_node is not None:
                    member_name = view.name(name_node)
                if ("static" in child.tokens) == is_static and (
                    (name_node is not None and name_node.type == "computed_property_name")
                    or member_name == name
                ):
                    return True
            current = current.get("base")
        return False

    safety = family_safety(view, budget, classes, _LIFETIME_NAMES)

    def inherited_method(info, name):
        return (
            not overrides(info, name, False)
            and not safety["changed"](info, name)
            and not any(
                safety["changed"](info, hook) or overrides(info, hook, False)
                for hook in ("buildMember", "build")
            )
        )

    def static_call(node):
        if node.type != "call_expression" or node.fields.get("function") is None:
            return None
        access = member(node.fields["function"])
        if not access:
            return None
        info = class_of(access["object"])
        if not info or access["name"] not in _LIFETIME[info["family"]]:
            return None
        if overrides(info, access["name"], True) or safety["staticChanged"](info, access["name"]):
            diagnose(
                "fst-solid.static-override",
                "A local override, mutation or escape prevents an inherited lifetime API claim.",
                node,
            )
            return None
        return {"info": info, "name": access["name"], "object": access["object"]}

    def instance(input_node, seen=None, report_this=False):
        seen = set() if seen is None else seen
        budget.step()
        budget.depth(len(seen))
        if len(seen) >= 24:
            return None
        node = view.unwrap(input_node)
        reference = view.reference(node)
        if node.type == "this":
            cursor = view.parent(node)
            while cursor is not None:
                budget.step()
                if (
                    cursor.type in _FUNCTIONS and cursor.type != "arrow_function"
                ) or cursor.type in ("class_static_block", "computed_property_name"):
                    break
                if cursor.type in ("method_definition", "public_field_definition"):
                    body = view.parent(cursor)
                    if "static" in cursor.tokens or body is None or body.type != "class_body":
                        break
                    owner = view.parent(body)
                    declaration = view.declarationAt(owner) if owner is not None else None
                    info = classes.get(declaration["key"]) if declaration else None
                    if info:
                        return {
                            "classInfo": info,
                            "reference": reference,
                            "raw": True,
                            "origin": cursor,
                        }
                    break
                if cursor.type in ("class_declaration", "abstract_class_declaration", "class"):
                    break
                cursor = view.parent(cursor)
            if report_this:
                diagnose(
                    "fst-solid.unresolved-this",
                    "This receiver is not proven to be a local FST instance.",
                    node,
                )
            return None
        direct = static_call(node)
        if direct:
            if direct["name"] == "asScoped":
                args = arguments_of(node)
                original = (
                    instance(args[0], seen, report_this)
                    if args and args[0].type != "spread_element"
                    else None
                )
                return (
                    {**original, "reference": reference}
                    if original
                    and original["classInfo"]["declaration"]["key"]
                    == direct["info"]["declaration"]["key"]
                    else None
                )
            return {
                "classInfo": direct["info"],
                "reference": reference,
                "raw": direct["name"] not in ("new", "newScoped"),
                "origin": node,
            }
        if node.type == "new_expression" and node.fields.get("constructor") is not None:
            info = class_of(node.fields["constructor"])
            if info:
                return {"classInfo": info, "reference": reference, "raw": True, "origin": node}
        binding = view.binding(node)
        if (
            binding
            and binding["kind"] == "const"
            and binding["available"]
            and binding["stable"]
            and binding.get("initializer") is not None
            and binding.get("declaration")
            and binding["declaration"] not in seen
        ):
            seen.add(binding["declaration"])
            target = instance(binding["initializer"], seen, report_this)
            if target:
                return {**target, "reference": reference}
        return None

    def field(input_node, seen=None):
        seen = set() if seen is None else seen
        budget.step()
        budget.depth(len(seen))
        if len(seen) >= 24:
            return None
        node = view.unwrap(input_node)
        reference = view.reference(node)
        if node.type == "call_expression" and node.fields.get("function") is not None:
            if api(node.fields["function"]) == "field":
                return {"reference": reference, "creation": node}
            access = member(node.fields["function"])
            if access and access["name"] == "field":
                value = instance(access["object"], report_this=True)
                if (
                    value
                    and value["classInfo"]["family"] == "form"
                    and inherited_method(value["classInfo"], "field")
                ):
                    return {"reference": reference, "creation": node, "origin": access["object"]}
            if access and access["name"] in ("onChange", "onSet", "map"):
                original = field(access["object"], seen)
                if original:
                    budget.step(512)
                    return (
                        original
                        if view.project(node.fields["function"])
                        else {**original, "unprovenMethod": True}
                    )
        binding = view.binding(node)
        if (
            binding
            and binding["kind"] == "const"
            and binding["available"]
            and binding["stable"]
            and binding.get("initializer") is not None
            and binding.get("declaration")
            and binding["declaration"] not in seen
        ):
            seen.add(binding["declaration"])
            result = field(binding["initializer"], seen)
            if result:
                return {**result, "reference": reference}
        return None

    def assigned(call):
        cursor = call
        for _ in range(64):
            budget.step()
            declaration = view.declarationAt(cursor)
            if declaration:
                return declaration
            parent = view.parent(cursor)
            if parent is None:
                return None
            if parent.type in _WRAPPERS:
                cursor = parent
                continue
            value = parent.fields.get("value")
            if (
                parent.type in ("variable_declarator", "public_field_definition")
                and value is not None
                and value.startIndex == cursor.startIndex
            ):
                return view.declarationAt(parent)
            return None
        return None

    def subject(node, fallback=None):
        return view.owner(node) or (
            declaration_map.get(fallback["key"])
            if fallback and fallback["kind"] == "declaration"
            else None
        )

    def safe_string(value):
        return (
            not _FORBIDDEN_STRING.search(value)
            and wire_size({"kind": "string", "value": value}) <= view.limits["maxValueBytes"]
        )

    def string_option(owner, node, key, term, anchor):
        if node is None:
            emitter.property(
                owner["key"], term, "absent", None, evidence(anchor, "component-options")
            )
            return
        budget.step(512)
        value = view.constantProperty(node, key)
        if value["known"] and isinstance(value.get("value"), str) and safe_string(value["value"]):
            property_fact(
                owner, term, value["value"], node, "component-options", value["resolution"]
            )
        elif not value["known"] and value.get("reason") == "absent":
            emitter.property(
                owner["key"], term, "absent", None, evidence(node, "component-options")
            )
        else:
            emitter.property(
                owner["key"], term, "expression", None, evidence(node, "component-options")
            )
            diagnose(
                "fst-solid.dynamic-options",
                "Component metadata is not a proven bounded string constant.",
                node,
            )

    def change_arguments(owner, dependencies, callback, mode="onChange"):
        inputs = [child for child in dependencies.children if child.type != "comment"]

        def punctuation(start, end):
            return _COMMENTS.sub("", view.slice_bytes(start, end)).strip()

        if (
            not inputs
            or len(inputs) > (4 if mode == "onChange" else 3)
            or (mode == "resolveChildrenOnChange" and len(inputs) < 2)
            or any(
                input_node.type == "spread_element"
                or punctuation(
                    inputs[index - 1].endIndex if index else dependencies.startIndex + 1,
                    input_node.startIndex,
                )
                != ("," if index else "")
                for index, input_node in enumerate(inputs)
            )
            or punctuation(inputs[-1].endIndex, dependencies.endIndex - 1) not in ("", ",")
        ):
            diagnose(
                "fst-solid.dynamic-dependencies",
                "Callback projections require the supported explicit dependency arity without holes or spreads.",
                dependencies,
            )
            return
        fn, seen = view.unwrap(callback), set()
        while fn.type not in _FUNCTIONS and len(seen) < 24 and id(fn) not in seen:
            budget.step()
            seen.add(id(fn))
            binding = view.binding(fn)
            if not binding or not binding["available"] or not binding["stable"]:
                return
            next_node = binding.get("initializer") or (
                view.declarationNode(binding["declaration"])
                if binding["kind"] == "function" and binding.get("declaration")
                else None
            )
            if next_node is None:
                return
            fn = view.unwrap(next_node)
        if fn.type not in _FUNCTIONS:
            return
        parameters = fn.fields.get("parameters") or fn.fields.get("parameter")
        parameter = (
            next((child for child in parameters.children if child.type != "comment"), None)
            if parameters is not None and parameters.type == "formal_parameters"
            else parameters
        )
        if parameter is None:
            return
        projected = view.patternProjections(parameter)
        if not projected["complete"] or any(
            len(item["path"]) > 1
            or len(item["path"]) == 1
            and (type(item["path"][0]) is not int or item["path"][0] >= len(inputs))
            for item in projected["projections"]
        ):
            diagnose(
                "fst-solid.callback-pattern",
                "Only bounded positional callback bindings are projected to change snapshots.",
                parameter,
            )
            return
        for item in projected["projections"]:
            budget.step()
            node, path = item["node"], item["path"]
            if len(path) != 1 or type(path[0]) is not int:
                continue
            name = view.name(node)
            if not name or not 0 <= path[0] < len(inputs) or not safe_string(name):
                continue
            binding_owner = view.owner(node) or owner
            term = (
                "fst-solid.children-change-argument"
                if mode == "resolveChildrenOnChange" and path[0] == 0
                else "fst-solid.change-argument"
            )
            property_fact(binding_owner, term, name, node, "change-argument")
            relation(
                binding_owner,
                "fst-solid.change-argument-source",
                view.reference(inputs[path[0]]),
                node,
                "change-argument",
            )

    for declaration in view.declarations:
        budget.step()
        node = view.declarationNode(declaration["key"])
        if node is None:
            continue
        if declaration["kind"] == "method" and declaration.get("owner"):
            info = classes.get(declaration["owner"])
            if info and not any(token in ("static", "get", "set") for token in node.tokens):
                name, family_kind = declaration.get("name"), info["family"]
                hook = (
                    f"form.{name}"
                    if family_kind == "form"
                    and name in ("init", "save", "submit", "validate", "errors")
                    else f"{family_kind}.initLoad"
                    if family_kind in ("state", "scope", "item-scope") and name == "initLoad"
                    else None
                )
                if hook:
                    role(declaration, "fst-solid.lifecycle-hook", node, "method-hook")
                    property_fact(declaration, "fst-solid.hook-kind", hook, node, "method-hook")
                if hook and family_kind in ("scope", "item-scope"):
                    property_fact(
                        declaration,
                        "fst-solid.api-policy",
                        "initialization-enabled effect requests initLoad through webview readiness; completion flags set in finally; invocation, success and scheduling unproven",
                        node,
                        "scope-initialization",
                    )
                elif family_kind == "state" and name == "init":
                    property_fact(
                        declaration,
                        "fst-solid.hook-kind",
                        "state.init-configuration-override",
                        node,
                        "state-configuration",
                    )
        value = view.unwrap(node.fields["value"]) if node.fields.get("value") is not None else None
        if value is None:
            continue
        handle = field(value)
        if not handle:
            continue
        if handle.get("unprovenMethod"):
            property_fact(
                declaration,
                "fst-solid.api-policy",
                "authored Field source lineage only; fluent method and returned callable identity unproven",
                value,
                "field-creation",
            )
        else:
            role(declaration, "fst-solid.field", value, "field-creation")
        if handle.get("origin") is not None:
            relation(
                declaration,
                "fst-solid.form-origin",
                view.reference(handle["origin"]),
                value,
                "form-field",
            )
            args = arguments_of(handle["creation"])
            path = args[0] if args else None
            if path is not None:
                relation(
                    declaration,
                    "fst-solid.field-path-expression",
                    view.reference(path),
                    value,
                    "form-field",
                    "syntax",
                )
            budget.step(512)
            literal = view.constant(path) if path is not None else None
            if (
                path is not None
                and literal
                and literal["known"]
                and isinstance(literal.get("value"), str)
                and safe_string(literal["value"])
            ):
                resolution = (
                    literal["resolution"]
                    if path.startIndex >= value.startIndex and path.endIndex <= value.endIndex
                    else "constant"
                )
                property_fact(
                    declaration,
                    "fst-solid.field-path",
                    literal["value"],
                    value,
                    "form-field",
                    resolution,
                )
            else:
                emitter.property(
                    declaration["key"],
                    "fst-solid.field-path",
                    "expression",
                    None,
                    evidence(value, "form-field"),
                )
                diagnose(
                    "fst-solid.dynamic-field-path",
                    "Field path remains an expression, not a resolved TypeScript property.",
                    value,
                )
        types = handle["creation"].fields.get("type_arguments")
        for type_node in types.children if types is not None else ():
            relation(
                declaration,
                "fst-solid.value-type",
                view.reference(type_node, "type"),
                value,
                "field-value-type",
                "syntax",
            )

    for node in view.nodes:
        budget.step()
        if node.type in ("generic_type", "type_identifier"):
            name = node.fields.get("name") if node.type == "generic_type" else node
            type_api = api(name, "type")
            if type_api in ("Field", "InputField", "FormField"):
                parent = view.parent(node)
                if (
                    node.type == "type_identifier"
                    and parent is not None
                    and parent.type == "generic_type"
                ):
                    continue
                owner = subject(node)
                if owner:
                    relation(
                        owner,
                        "fst-solid.field-type",
                        view.resolve(name, "type"),
                        node,
                        "field-type",
                        "syntax",
                    )
                    types = node.fields.get("type_arguments")
                    for type_node in types.children if types is not None else ():
                        relation(
                            owner,
                            "fst-solid.value-type",
                            view.reference(type_node, "type"),
                            type_node,
                            "field-type",
                            "syntax",
                        )
        if node.type == "new_expression" and node.fields.get("constructor") is not None:
            info, owner = class_of(node.fields["constructor"]), subject(node)
            if info and owner:
                property_fact(
                    owner, "fst-solid.instance-kind", "raw-constructor", node, "raw-construction"
                )
                relation(
                    owner,
                    "fst-solid.lifetime-target",
                    {"kind": "declaration", "key": info["declaration"]["key"]},
                    node,
                    "raw-construction",
                )
            elif api(node.fields["constructor"], "type") in ("Field", "InputField", "FormField"):
                diagnose(
                    "fst-solid.type-construction",
                    "Field type references are not runtime constructors.",
                    node,
                )
            continue
        if node.type != "call_expression" or node.fields.get("function") is None:
            continue
        fn, args = node.fields["function"], arguments_of(node)
        called, access = api(fn), member(fn)
        if called in ("component", "componentWithChildren"):
            owner = assigned(node)
            if not args or any(arg.type == "spread_element" for arg in args):
                diagnose(
                    "fst-solid.component-shape",
                    "Component constructions require an explicit renderer without positional spreads.",
                    node,
                )
                continue
            if not owner:
                value, parent = node, view.parent(node)
                while parent is not None and parent.type in _WRAPPERS - {
                    "instantiation_expression"
                }:
                    budget.step()
                    value, parent = parent, view.parent(parent)
                factory = (
                    parent
                    if parent is not None
                    and parent.type == "arrow_function"
                    and parent.fields.get("body") is value
                    else None
                )
                if parent is not None and parent.type == "return_statement":
                    at = view.parent(parent)
                    while at is not None:
                        budget.step()
                        if at.type in _FUNCTIONS or at.type == "method_definition":
                            factory = at
                            break
                        at = view.parent(at)
                factory_owner = (
                    (view.declarationAt(factory) or assigned(factory))
                    if factory is not None
                    and "async" not in factory.tokens
                    and "generator" not in factory.type
                    and "*" not in factory.tokens
                    else None
                )
                if not factory_owner:
                    diagnose(
                        "fst-solid.component-shape",
                        "Construction is not a directly assigned component or a declared synchronous factory return.",
                        node,
                    )
                    continue
                role(
                    factory_owner,
                    "fst-solid.component-factory",
                    node,
                    "returned-component-construction",
                )
                relation(
                    factory_owner,
                    "fst-solid.returns-component",
                    view.reference(node),
                    node,
                    "returned-component-construction",
                )
                relation(
                    factory_owner,
                    "fst-solid.factory",
                    view.resolve(fn),
                    fn,
                    "returned-component-construction",
                )
                relation(
                    factory_owner,
                    "fst-solid.returned-renderer",
                    view.reference(args[0]),
                    args[0],
                    "returned-component-construction",
                )
                if len(args) > 1:
                    relation(
                        factory_owner,
                        "fst-solid.returned-options",
                        view.reference(args[1]),
                        args[1],
                        "returned-component-construction",
                        "syntax",
                    )
                property_fact(
                    factory_owner,
                    "fst-solid.component-return",
                    "authored construction; metadata evaluated per invocation; other returns and callers not inferred",
                    node,
                    "returned-component-construction",
                )
                continue
            role(owner, "fst-solid.component", node, "component-factory")
            relation(owner, "fst-solid.factory", view.resolve(fn), fn, "component-factory")
            relation(
                owner,
                "fst-solid.implemented-by",
                view.reference(args[0]),
                args[0],
                "component-renderer",
            )
            types = node.fields.get("type_arguments")
            for type_node in types.children if types is not None else ():
                relation(
                    owner,
                    "fst-solid.props-type",
                    view.reference(type_node, "type"),
                    type_node,
                    "component-props",
                    "syntax",
                )
            if types is None:
                ref = view.reference(args[0])
                declared = (
                    view.declarationNode(ref["key"]) if ref["kind"] == "declaration" else None
                )
                renderer = view.unwrap(
                    (declared.fields.get("value") or declared) if declared is not None else args[0]
                )
                parameters = renderer.fields.get("parameters")
                parameter = (
                    parameters.children[0]
                    if parameters is not None and parameters.children
                    else renderer.fields.get("parameter")
                )
                annotation = parameter.fields.get("type") if parameter is not None else None
                if annotation is not None and annotation.children:
                    relation(
                        owner,
                        "fst-solid.props-type",
                        view.reference(annotation.children[0], "type"),
                        args[0],
                        "renderer-props",
                        "syntax",
                    )
            options = args[1] if len(args) > 1 else None
            string_option(owner, options, "name", "fst-solid.name", node)
            string_option(owner, options, "designName", "fst-solid.design-name", node)
            string_option(owner, options, "designConcept", "fst-solid.design-concept", node)
            continue
        inherited = static_call(node)
        if inherited:
            target_ref = {"kind": "declaration", "key": inherited["info"]["declaration"]["key"]}
            owner = subject(node, target_ref)
            if owner:
                operation = {
                    "new": "create-standalone",
                    "newScoped": "create-scoped",
                    "use": "require-existing",
                    "useOrNull": "optional-existing",
                    "useOrNewScoped": "reuse-or-create-scoped",
                    "useGlobal": "reuse-or-create-global",
                    "asScoped": "provide-existing",
                }
                property_fact(
                    owner,
                    "fst-solid.lifetime-operation",
                    operation[inherited["name"]],
                    node,
                    "lifetime-call",
                )
                relation(owner, "fst-solid.lifetime-target", target_ref, node, "lifetime-call")
                if inherited["name"] in ("use", "useOrNull", "useOrNewScoped"):
                    property_fact(
                        owner,
                        "fst-solid.lookup-policy",
                        "scoped-with-global-fallback"
                        if inherited["info"]["family"] in ("state", "form")
                        else "scoped-only",
                        node,
                        "lifetime-call",
                    )
        elif access and access["name"] in _LIFETIME_NAMES and api(access["object"]) != "List":
            origin, declared = view.resolve(access["object"]), view.reference(access["object"])
            if (
                origin["kind"] == "import"
                or declared["kind"] == "declaration"
                and declared["key"] in classes
            ):
                diagnose(
                    "fst-solid.unresolved-lifetime",
                    "The receiver or family API is not a proven inherited lifetime operation.",
                    node,
                )
        owner = subject(node)
        if called == "field" and owner:
            property_fact(
                owner, "fst-solid.field-operation", "construct-standalone", node, "field-creation"
            )
            relation(owner, "fst-solid.factory", view.resolve(fn), fn, "field-creation")
        if access and access["name"] == "field" and owner:
            handle = field(node)
            if handle and handle.get("origin") is not None:
                property_fact(
                    owner, "fst-solid.field-operation", "access-form-field", node, "form-field"
                )
                relation(
                    owner,
                    "fst-solid.form-origin",
                    view.reference(handle["origin"]),
                    node,
                    "form-field",
                )
                if args:
                    relation(
                        owner,
                        "fst-solid.field-path-expression",
                        view.reference(args[0]),
                        node,
                        "form-field",
                        "syntax",
                    )
        if access and access["name"] == "form":
            receiver = instance(access["object"])
            if receiver and receiver["classInfo"]["family"] == "form":
                diagnose(
                    "fst-solid.subform-expression",
                    "Subform traversal remains an unresolved form expression in this file-local slice.",
                    node,
                )
        if called == "useFieldBinding":
            if not owner or not args:
                diagnose(
                    "fst-solid.unattached-registration",
                    "A binding call without a containing declaration is not represented.",
                    node,
                )
                continue
            assigned_owner = assigned(node) or owner
            role(assigned_owner, "fst-solid.field-binding", node, "field-binding")
            property_fact(
                assigned_owner, "fst-solid.ownership", "borrowed-no-disposal", node, "field-binding"
            )
            relation(
                assigned_owner,
                "fst-solid.borrows",
                view.reference(args[0]),
                args[0],
                "field-binding",
            )
        if called in (
            "onChange",
            "onChangeDelayed",
            "resolveChildrenOnChange",
            "onCleanup",
            "onComponentCleanup",
            "onMount",
        ):
            if not owner:
                diagnose(
                    "fst-solid.unattached-registration",
                    "A registration without a containing declaration is not represented.",
                    node,
                )
                continue
            role(owner, "fst-solid.registration", node, "registration")
            contract = {
                "onCleanup": "solid.content-or-effect-cleanup",
                "onComponentCleanup": "fst.wrapper-cleanup",
                "onMount": "solid.content-mount",
                "onChangeDelayed": "explicit-delayed-dependency-watch",
                "resolveChildrenOnChange": "explicit-children-dependency-watch",
            }.get(called, "explicit-dependency-watch")
            property_fact(owner, "fst-solid.registration-kind", contract, node, "registration")
            watch = called in ("onChange", "onChangeDelayed", "resolveChildrenOnChange")
            callback_index = 2 if called == "onChangeDelayed" else 1 if watch else 0
            callback = args[callback_index] if len(args) > callback_index else None
            if callback is not None:
                relation(
                    owner, "fst-solid.callback", view.reference(callback), callback, "registration"
                )
            if watch:
                dep_index = 1 if called == "onChangeDelayed" else 0
                deps = view.unwrap(args[dep_index]) if len(args) > dep_index else None
                if (
                    deps is not None
                    and deps.type == "array"
                    and not any(child.type == "spread_element" for child in deps.children)
                ):
                    for dep in deps.children:
                        if dep.type != "comment":
                            relation(
                                owner,
                                "fst-solid.observes",
                                view.reference(dep),
                                dep,
                                "explicit-dependencies",
                                "syntax",
                            )
                    if callback is not None:
                        change_arguments(owner, deps, callback, called)
                elif deps is not None:
                    relation(
                        owner,
                        "fst-solid.observes",
                        view.reference(deps),
                        deps,
                        "explicit-dependencies",
                        "syntax",
                    )
                    diagnose(
                        "fst-solid.dynamic-dependencies",
                        "Only explicit dependency arrays are enumerated; reactive dependency discovery is not performed.",
                        deps,
                    )
        if access and access["name"] in ("onChange", "onSet"):
            handle = field(access["object"])
            target = subject(node, handle["reference"] if handle else None)
            if handle and target:
                role(target, "fst-solid.registration", node, "field-observer")
                property_fact(
                    target,
                    "fst-solid.observation-phase",
                    "pre-commit" if access["name"] == "onChange" else "post-commit",
                    node,
                    "field-observer",
                )
                relation(
                    target,
                    "fst-solid.field-target",
                    handle["reference"],
                    access["object"],
                    "field-observer",
                )
                if args:
                    relation(
                        target,
                        "fst-solid.callback",
                        view.reference(args[0]),
                        args[0],
                        "field-observer",
                    )
        if access and access["name"] == "init" and owner:
            receiver = instance(access["object"])
            if (
                receiver
                and receiver["classInfo"]["family"] == "state"
                and inherited_method(receiver["classInfo"], "init")
            ):
                property_fact(
                    owner,
                    "fst-solid.registration-kind",
                    "state.init-configuration",
                    node,
                    "state-configuration",
                )
                if args:
                    relation(
                        owner,
                        "fst-solid.callback",
                        view.reference(args[0]),
                        args[0],
                        "state-configuration",
                    )
        handle = field(fn)
        target = subject(node, handle["reference"] if handle else None)
        if handle and target:
            if handle.get("unprovenMethod"):
                diagnose(
                    "fst-solid.unknown-field-value",
                    "Fluent Field invocation requires a proven, unescaped method result.",
                    node,
                )
                continue
            if (
                any(arg.type == "spread_element" for arg in args)
                or "?." in node.tokens
                or any(child.type == "optional_chain" for child in node.children)
            ):
                diagnose(
                    "fst-solid.unknown-field-value",
                    "Field dispatch requires an unconditional call with explicit argument positions.",
                    node,
                )
                continue
            budget.step(512)
            value = view.constant(args[0]) if args else None
            read = not args or value and value["known"] and "value" not in value
            write = (
                value
                and value["known"]
                and "value" in value
                or args
                and view.unwrap(args[0]).type in _FUNCTIONS
            )
            if read or write:
                property_fact(
                    target,
                    "fst-solid.field-operation",
                    "read" if read else "write-request",
                    node,
                    "field-invocation",
                )
            elif args:
                property_fact(
                    target,
                    "fst-solid.field-operation",
                    "conditional-read-or-write-request",
                    node,
                    "field-invocation",
                )
                property_fact(
                    target,
                    "fst-solid.field-dispatch",
                    "argument[0] === undefined: read; otherwise: write request (function inputs are updaters); branch, value, completion and disposal state unproven",
                    node,
                    "field-invocation",
                )
                relation(
                    target,
                    "fst-solid.field-argument",
                    {"kind": "expression", "text": view.text(args[0]), "span": view.span(args[0])},
                    node,
                    "field-invocation",
                )
                if len(args) > 1:
                    relation(
                        target,
                        "fst-solid.field-write-options",
                        {
                            "kind": "expression",
                            "text": view.text(args[1]),
                            "span": view.span(args[1]),
                        },
                        node,
                        "field-invocation",
                    )
            relation(target, "fst-solid.field-target", handle["reference"], fn, "field-invocation")

    def family(input_node, method=None):
        if not classes:
            return None
        value = instance(input_node)
        if not value or method and not inherited_method(value["classInfo"], method):
            return None
        return {
            "kind": value["classInfo"]["family"],
            "raw": value["raw"],
            "origin": value["origin"],
        }

    def command(input_node, name):
        if (
            not classes
            or name.startswith(("_", "$", "#"))
            or name in ("constructor", "init", "build", "buildMember", "onChange")
        ):
            return False
        value = instance(input_node)
        if (
            not value
            or value["raw"]
            or value["classInfo"]["family"] != "state"
            or safety["customProxy"](value["classInfo"])
            or safety["changed"](value["classInfo"], name)
        ):
            return False
        body = value["classInfo"]["node"].fields.get("body")
        return body is not None and any(
            child.type == "method_definition"
            and not any(token in ("static", "get", "set") for token in child.tokens)
            and child.fields.get("name") is not None
            and view.name(child.fields["name"]) == name
            for child in body.children
        )

    analyze_core(
        view,
        budget,
        bool(classes),
        role,
        property_fact,
        relation,
        diagnose,
        safe_string,
        assigned,
        family,
        command,
    )
    return {
        "state": "partial" if partial else "complete" if matched else "not-applicable",
        "diagnostics": diagnostics,
    }


__all__ = ["DESCRIPTOR", "RETURN_CONTRACTS", "analyze"]
