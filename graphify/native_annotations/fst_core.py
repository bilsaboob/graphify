"""Import/receiver-qualified FST operations; source requests, not runtime success."""

from .fst_rules import HANDLE_PARTS, RETURN_CONTRACTS, core_rule, methods_for
from .values import js_string

_FUNCTIONS = {
    "arrow_function",
    "function_expression",
    "function_declaration",
    "generator_function",
    "generator_function_declaration",
}
_FAMILIES = {"state", "form", "scope", "item-scope"}
_VALUES = {"value", "delayed-value", "hover-value"}


def analyze_core(
    view,
    budget,
    has_families,
    role,
    emit_property,
    relation,
    diagnose,
    safe_string,
    assigned,
    family,
    command,
):
    def property_fact(owner, term, value, node, rule, resolution="literal"):
        if not safe_string(value):
            diagnose(
                "fst-solid.core-limit",
                "API metadata exceeds the bounded wire string contract.",
                node,
            )
            return
        emit_property(owner, term, value, node, rule, resolution)

    def args_of(node):
        arguments = node.fields.get("arguments")
        return (
            [child for child in arguments.children if child.type != "comment"]
            if arguments is not None
            else []
        )

    def access(input_node):
        node = view.unwrap(input_node)
        if "?." in node.tokens or node.fields.get("object") is None:
            return None
        key = (
            node.fields.get("property")
            if node.type == "member_expression"
            else node.fields.get("index")
            if node.type == "subscript_expression"
            else None
        )
        name = (
            view.name(key)
            if key is not None and (node.type != "subscript_expression" or key.type == "string")
            else None
        )
        return {"object": node.fields["object"], "name": name} if name is not None else None

    def imported(input_node):
        reference = view.resolve(input_node)
        if reference["kind"] == "import" and not reference.get("member"):
            rule = core_rule(reference["module"], reference["name"])
            if rule:
                return rule
        member = access(input_node)
        base = view.resolve(member["object"]) if member else None
        return (
            core_rule(base["module"], f"{base['name']}.{member['name']}")
            if member and base and base["kind"] == "import" and not base.get("member")
            else None
        )

    calls = [node for node in view.nodes if node.type in ("call_expression", "new_expression")]
    direct = {}
    for node in calls:
        budget.step()
        if "?." in node.tokens or any(child.type == "optional_chain" for child in node.children):
            continue
        fn = node.fields.get("function") or node.fields.get("constructor")
        rule = imported(fn) if fn is not None else None
        if rule and bool(rule.get("construct")) == (node.type == "new_expression"):
            direct[id(node)] = rule
    analyze_receivers = bool(direct) or has_families
    bindings, borrowed_inputs, constructed, construction_proofs = {}, {}, {}, {}
    active, unsafe, unsafe_constructors = set(), set(), set()
    receiver_proofs_limited = False

    def known_function(input_node):
        if input_node is None:
            return False
        node = view.unwrap(input_node)
        for _ in range(16):
            budget.step()
            if node.type in _FUNCTIONS:
                return True
            binding = view.binding(node)
            if (
                not binding
                or not binding["stable"]
                or not binding["available"]
                or binding.get("typeOnly")
            ):
                return False
            next_node = binding.get("initializer") or (
                view.declarationNode(binding["declaration"])
                if binding["kind"] == "function" and binding.get("declaration")
                else None
            )
            if next_node is None:
                return False
            node = view.unwrap(next_node)
        return False

    def method(handle, name):
        return methods_for(handle["kind"]).get(name)

    def make(kind, node):
        return {
            "kind": kind,
            "creation": node,
            "root": f"{node.startIndex}:{node.endIndex}",
            "reference": view.reference(node),
        }

    def part_of(receiver, name, depth):
        borrowed = direct.get(id(receiver["creation"]), {}).get("borrowed", {})
        if name in borrowed:
            args = args_of(receiver["creation"])
            index = borrowed[name]
            return handle(args[index], depth + 1) if index < len(args) else None
        kind = HANDLE_PARTS.get(receiver["kind"], {}).get(name)
        return {**receiver, "kind": kind} if kind else None

    def observe_construction(node, result):
        if not result or not result.get("constructed"):
            return result
        key = id(node)
        if key not in construction_proofs:
            budget.step(512)
            construction_proofs[key] = (
                (view.project(node) or {}).get("contract", "").startswith("fst-solid.")
            )
        return result if construction_proofs[key] else None

    def handle(input_node, depth=0):
        budget.step()
        budget.depth(depth)
        if depth > 16:
            diagnose(
                "fst-solid.core-limit",
                "Handle provenance exceeds the bounded local depth.",
                input_node,
            )
            return None
        node = view.unwrap(input_node)
        reference = view.reference(node)
        binding = view.binding(node)
        if binding:
            if (
                not binding["available"]
                or not binding["stable"]
                or binding.get("typeOnly")
                or binding["kind"] != "const"
                or not binding.get("declaration")
            ):
                return None
            key = binding["declaration"]
            if key in active:
                return None
            if key in bindings:
                found = observe_construction(node, bindings[key])
                return {**found, "reference": reference} if found else None
            active.add(key)
            result = (
                handle(binding["initializer"], depth + 1)
                if binding.get("initializer") is not None
                else None
            )
            if binding.get("initializer") is None:
                budget.step(512)
                source = view.initializerProjection(key)
                if source and source["complete"]:
                    budget.step(512)
                    projection = view.project(node)
                    if (
                        projection
                        and projection.get("contract", "").startswith("fst-solid.")
                        and len(projection["path"]) <= 1
                    ):
                        origin = handle(projection["initializer"], depth + 1)
                        if origin:
                            result = (
                                part_of(origin, str(projection["path"][0]), depth)
                                if projection["path"]
                                else origin
                            )
            active.remove(key)
            bindings[key] = result
            observed = observe_construction(node, result)
            return {**observed, "reference": reference} if observed else None
        rule = direct.get(id(node))
        if rule and rule.get("result"):
            if rule["operation"] == "list.raw-create" and "raw-list" in unsafe_constructors:
                return None
            if any(arg.type == "spread_element" for arg in args_of(node)):
                return None
            if not rule.get("construct"):
                result = make(rule["result"], node)
                if rule.get("shared"):
                    result["root"] = f"shared:{rule['shared']}"
                if rule.get("backing"):
                    result["constructionKind"] = rule["backing"]
                elif rule["result"] == "raw-list":
                    result["constructionKind"] = "raw-list"
                return result
            if id(node) in constructed:
                return constructed[id(node)]
            budget.step(512)
            projection = view.project(node)
            result = (
                {
                    **make(rule["result"], node),
                    "constructed": True,
                    "constructionKind": rule["result"],
                }
                if projection and projection.get("contract", "").startswith("fst-solid.")
                else None
            )
            constructed[id(node)] = result
            if result and rule.get("borrowed"):
                args = args_of(node)
                borrowed_inputs[result["root"]] = [
                    args[index] for index in rule["borrowed"].values() if index < len(args)
                ]
            return result
        family_result = family(node)
        if family_result:
            return {
                **make(family_result["kind"], family_result["origin"]),
                "reference": reference,
                "raw": family_result["raw"],
            }
        member = access(node)
        if member:
            receiver = handle(member["object"], depth + 1)
            part = part_of(receiver, member["name"], depth) if receiver else None
            if part:
                return {**part, "reference": reference}
        if node.type != "call_expression" or node.fields.get("function") is None:
            return None
        access_fn = access(node.fields["function"])
        if access_fn:
            receiver = handle(access_fn["object"], depth + 1)
            contract = method(receiver, access_fn["name"]) if receiver else None
            if not contract:
                return None
            if receiver["kind"] in _FAMILIES and not family(access_fn["object"], access_fn["name"]):
                return None
            if contract.get("result") == "subform" and not family(access_fn["object"], "field"):
                return None
            if contract.get("result") == "self":
                return {**receiver, "reference": reference}
            args = args_of(node)
            if (
                receiver["kind"] in _VALUES
                and access_fn["name"] == "load"
                and args
                and known_function(args[0])
            ):
                return {**receiver, "reference": reference}
            if contract.get("result"):
                result = {**make(contract["result"], node), "root": receiver["root"]}
                if receiver.get("constructionKind"):
                    result["constructionKind"] = receiver["constructionKind"]
                return result
        else:
            receiver = handle(node.fields["function"], depth + 1)
            if receiver and receiver["kind"] == "root-renderer":
                return make("root-view", node)
        return None

    def taint(input_node, seen=None):
        nonlocal receiver_proofs_limited
        budget.step()
        node = view.unwrap(input_node)
        seen = set() if seen is None else seen
        if id(node) in seen:
            return
        found = handle(node)
        if found:
            if found["root"] in unsafe:
                return
            unsafe.add(found["root"])
            # Borrowing wrappers expose their original input without becoming aliases.
            for borrowed in borrowed_inputs.get(found["root"], ()):
                taint(borrowed, seen)
            return
        if node.type in ("call_expression", "new_expression"):
            args = args_of(node)
            for index in direct.get(id(node), {}).get("borrowed", {}).values():
                if index < len(args):
                    taint(args[index], seen)
            return
        if node.type.startswith("jsx_"):
            pending = [node]
            while pending:
                budget.step()
                child = pending.pop()
                if child.type == "jsx_expression":
                    for value in child.children:
                        taint(value, seen)
                else:
                    pending.extend(child.children)
            return
        if node.type == "pair" and node.fields.get("value") is not None:
            taint(node.fields["value"], seen)
            return
        if node.type in (
            "string",
            "number",
            "true",
            "false",
            "null",
            "comment",
            "property_identifier",
        ):
            return
        if len(seen) >= 4096:
            receiver_proofs_limited = True
            diagnose(
                "fst-solid.core-limit",
                f"resource=receiver-escape-nodes accounted={len(seen) + 1} limit=4096; receiver operations are omitted.",
                input_node,
            )
            return
        seen.add(id(node))
        # An escaping closure exposes returns, not every receiver read in its body.
        if node.type in _FUNCTIONS:
            body = node.fields.get("body")
            if body is None:
                return
            if body.type != "statement_block":
                taint(body, seen)
            else:
                pending = list(body.children)
                while pending:
                    budget.step()
                    child = pending.pop()
                    if child.type == "return_statement":
                        for value in child.children:
                            taint(value, seen)
                    elif child.type not in _FUNCTIONS:
                        pending.extend(child.children)
            return
        if (
            node.type in ("member_expression", "subscript_expression")
            and node.fields.get("object") is not None
        ):
            taint(node.fields["object"], seen)
            return
        binding = view.binding(node)
        if binding:
            origin = binding.get("origin")
            if origin:
                list_factory = core_rule(
                    origin["module"], f"{'List' if origin['name'] == '*' else origin['name']}.new"
                )
                if list_factory and list_factory["operation"] == "list.raw-create":
                    unsafe_constructors.add("raw-list")
                constructor = core_rule(origin["module"], origin["name"])
                if constructor and constructor.get("construct") and constructor.get("result"):
                    unsafe_constructors.add(constructor["result"])
                if origin["name"] == "*":
                    for contract in RETURN_CONTRACTS:
                        budget.step()
                        if contract.get("invocation") == "construct":
                            for imported_origin in contract["origins"]:
                                if imported_origin["module"] == origin["module"]:
                                    candidate = core_rule(
                                        imported_origin["module"], imported_origin["name"]
                                    )
                                    if candidate and candidate.get("result"):
                                        unsafe_constructors.add(candidate["result"])
            if binding.get("initializer") is not None:
                taint(binding["initializer"], seen)
            elif binding["kind"] == "const" and binding.get("declaration"):
                budget.step(512)
                projection = view.initializerProjection(binding["declaration"])
                if projection:
                    taint(projection["initializer"], seen)
            elif binding["kind"] == "function" and binding.get("declaration"):
                fn = view.declarationNode(binding["declaration"])
                if fn is not None:
                    taint(fn, seen)
            return
        for child in node.children:
            taint(child, seen)

    for node in view.nodes if analyze_receivers else ():
        budget.step()
        if (
            node.type
            in (
                "assignment_expression",
                "augmented_assignment_expression",
                "update_expression",
                "for_in_statement",
            )
            or node.type == "unary_expression"
            and "delete" in node.tokens
        ):
            left = node.fields.get("left") or node.fields.get("argument")
            if left is not None:
                taint(left)
            if node.fields.get("right") is not None:
                taint(node.fields["right"])
        if node.type in ("return_statement", "jsx_expression"):
            for value in node.children:
                taint(value)
    for node in calls if analyze_receivers else ():
        budget.step()
        fn = node.fields.get("function") or node.fields.get("constructor")
        if fn is None:
            continue
        direct_rule, args = direct.get(id(node)), args_of(node)
        if direct_rule:
            for index in direct_rule.get("forwards", ()):
                if index < len(args):
                    taint(args[index])
            continue
        member = access(fn)
        receiver = handle(member["object"]) if member else None
        if member and member["name"] == "asScoped" and family(node):
            continue
        command_access = access(member["object"]) if member and member["name"] == "then" else None
        if command_access and command(command_access["object"], command_access["name"]):
            continue
        if (
            member
            and receiver
            and not method(receiver, member["name"])
            and receiver["kind"] != "remote-api"
        ):
            taint(member["object"])
        direct_handle = handle(fn) if not member else None
        contract = method(receiver, member["name"]) if member and receiver else None
        if contract:
            for index in contract.get("forwards", ()):
                if index < len(args):
                    taint(args[index])
            continue
        if direct_handle:
            forwarded = (
                args
                if direct_handle["kind"]
                in ("action", "value", "delayed-value", "hover-value", "field")
                else args[1:]
                if direct_handle["kind"] == "root-renderer"
                else ()
            )
            for arg in forwarded:
                taint(arg)
            continue
        if member and not receiver:
            taint(member["object"])
        if (
            not member
            and fn.type in ("member_expression", "subscript_expression")
            and fn.fields.get("object") is not None
        ):
            taint(fn.fields["object"])
        for arg in args:
            taint(arg)

    def usable(node):
        found = handle(node)
        return (
            found
            if found
            and not receiver_proofs_limited
            and found["root"] not in unsafe
            and found.get("constructionKind") not in unsafe_constructors
            else None
        )

    def literal(owner, node, term, anchor=None):
        anchor = node if anchor is None else anchor
        budget.step(512)
        value = view.constant(node)
        if value["known"] and type(value.get("value")) in (str, int, float, bool):
            text = js_string(value["value"])
            if safe_string(text):
                resolution = (
                    value["resolution"]
                    if node.startIndex >= anchor.startIndex and node.endIndex <= anchor.endIndex
                    else "constant"
                )
                property_fact(owner, term, text, anchor, "core-literal", resolution)
            else:
                diagnose(
                    "fst-solid.core-limit",
                    "Literal metadata exceeds the wire string limit.",
                    anchor,
                )

    def projected(node, name):
        budget.step(512)
        result = view.project(node, [name])
        if not result or result["path"]:
            return None
        obj = view.unwrap(node)
        for _ in range(16):
            if obj.type == "object":
                break
            budget.step()
            binding = view.binding(obj)
            if (
                not binding
                or not binding["available"]
                or not binding["stable"]
                or binding["kind"] != "const"
                or binding.get("initializer") is None
            ):
                break
            obj = view.unwrap(binding["initializer"])
        if obj.type == "object":
            selected = None
            for child in obj.children:
                budget.step()
                if child.type == "shorthand_property_identifier" and view.name(child) == name:
                    selected = child
                key = child.fields.get("key")
                key_node = (
                    key.children[0]
                    if key is not None and key.type == "computed_property_name" and key.children
                    else key
                )
                if child.type == "pair" and key_node is not None and view.name(key_node) == name:
                    selected = child.fields.get("value")
            if selected is not None:
                return selected
        return result["initializer"]

    def emit(owner, node, rule, target, args):
        property_fact(owner, "fst-solid.api-operation", rule["operation"], node, "core-call")
        relation(owner, "fst-solid.operation-target", view.reference(target), node, "core-call")
        if rule.get("policy"):
            property_fact(owner, "fst-solid.api-policy", rule["policy"], node, "core-contract")
        for index in rule.get("callbacks", ()):
            if index < len(args):
                relation(
                    owner, "fst-solid.callback", view.reference(args[index]), node, "core-callback"
                )
        for index in rule.get("sources", ()):
            if index < len(args):
                relation(
                    owner, "fst-solid.source", view.reference(args[index]), node, "core-source"
                )
        for index in rule.get("keys", ()):
            if index < len(args):
                relation(
                    owner, "fst-solid.key-expression", view.reference(args[index]), node, "core-key"
                )
                literal(owner, args[index], "fst-solid.key")
        options_rule = rule.get("options")
        options = (
            args[options_rule["argument"]]
            if options_rule and options_rule["argument"] < len(args)
            else None
        )
        if options is not None:
            for name in [*options_rule.get("callbacks", ()), *options_rule.get("sources", ())]:
                value = projected(options, name)
                if value is not None:
                    term = (
                        "fst-solid.callback"
                        if name in options_rule.get("callbacks", ())
                        else "fst-solid.source"
                    )
                    relation(owner, term, view.reference(value), node, f"core-option-{name}")
            for name in options_rule.get("literals", ()):
                budget.step(512)
                value = view.constantProperty(options, name)
                if value["known"] and type(value.get("value")) in (str, int, float, bool):
                    text = f"{name}={js_string(value['value'])}"
                    if safe_string(text):
                        property_fact(
                            owner,
                            "fst-solid.option",
                            text,
                            node,
                            "core-options",
                            value["resolution"],
                        )

    def callback_binding(callback, source, kind, allowed=()):
        fn = view.unwrap(callback)
        for _ in range(16):
            if fn.type in _FUNCTIONS:
                break
            budget.step()
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
        pattern = view.patternProjections(parameter)
        if not pattern["complete"] or any(
            len(item["path"]) > 1 or len(item["path"]) == 1 and str(item["path"][0]) not in allowed
            for item in pattern["projections"]
        ):
            return
        for binding in pattern["projections"]:
            owner, name = view.owner(binding["node"]), view.name(binding["node"])
            if not owner or not name or not safe_string(name):
                continue
            suffix = f".{binding['path'][0]}" if binding["path"] else ""
            property_fact(
                owner,
                "fst-solid.callback-binding",
                f"{name}:{kind}{suffix}",
                binding["node"],
                "core-callback-binding",
            )
            relation(
                owner,
                "fst-solid.callback-source",
                view.reference(source),
                binding["node"],
                "core-callback-binding",
            )

    def route_definitions(owner, node, input_node, groups):
        budget.step(512)
        result = view.project(input_node)
        obj = result["initializer"] if result and not result["path"] else None
        if obj is None or obj.type != "object":
            diagnose(
                "fst-solid.core-shape", "Route definitions require a bounded static object.", node
            )
            return
        if len(obj.children) > 32:
            diagnose(
                "fst-solid.core-limit", "Route definitions exceed the bounded entry count.", node
            )
            return

        def entry_name(entry):
            key = entry.fields.get("key")
            unwrapped = (
                key.children[0]
                if key is not None and key.type == "computed_property_name" and key.children
                else key
            )
            if (
                key is not None
                and key.type == "computed_property_name"
                and (unwrapped is None or unwrapped.type != "string")
            ):
                return None
            return view.name(unwrapped) if unwrapped is not None else None

        names, duplicates = set(), set()
        for entry in obj.children:
            if entry.type == "comment":
                continue
            name = entry_name(entry)
            if entry.type != "pair" or name is None:
                diagnose(
                    "fst-solid.core-shape",
                    "Dynamic route keys or spreads may replace other entries; the table is not enumerated.",
                    node,
                )
                return
            if name in names:
                duplicates.add(name)
            names.add(name)
        if duplicates:
            diagnose(
                "fst-solid.core-shape",
                "Duplicate route entries are not correlated with earlier source anchors.",
                node,
            )
        for entry in obj.children:
            budget.step()
            if entry.type == "comment":
                continue
            name = entry_name(entry)
            if entry.type != "pair" or not name or entry.fields.get("value") is None:
                diagnose("fst-solid.core-shape", "Dynamic route entries are not enumerated.", node)
                continue
            if name in duplicates:
                continue
            value = projected(input_node, name)
            if value is None:
                continue
            definition = view.unwrap(value)
            for _ in range(16):
                if definition.type == "object":
                    break
                budget.step()
                binding = view.binding(definition)
                if (
                    not binding
                    or not binding["available"]
                    or not binding["stable"]
                    or binding["kind"] != "const"
                    or binding.get("initializer") is None
                ):
                    break
                definition = view.unwrap(binding["initializer"])
            if definition.type == "object":
                keys, unresolved = set(), False
                for child in definition.children:
                    budget.step()
                    if child.type == "comment":
                        continue
                    key = (
                        view.name(child)
                        if child.type == "shorthand_property_identifier"
                        else entry_name(child)
                    )
                    if (
                        key is None
                        or key in keys
                        or child.type not in ("pair", "shorthand_property_identifier")
                    ):
                        unresolved = True
                        break
                    keys.add(key)
                if unresolved:
                    diagnose(
                        "fst-solid.core-shape",
                        "Duplicate or dynamic route options are not correlated with a declaration.",
                        node,
                    )
                    continue
            entry_owner = view.owner(entry)
            if not entry_owner:
                continue
            relation(
                owner, "fst-solid.route-definition", view.reference(value), node, "core-routes"
            )
            property_fact(entry_owner, "fst-solid.route-entry", name, entry, "core-routes")
            if not groups:
                component = projected(value, "component")
                if component is not None:
                    relation(
                        entry_owner,
                        "fst-solid.route-component",
                        view.reference(component),
                        entry,
                        "core-route-component",
                    )
            for prop in (
                ("name", "navPath")
                if groups
                else ("id", "path", "home", "defaultPathArgs", "navGroup", "preloadComponent")
            ):
                item = projected(value, prop)
                if item is not None:
                    relation(
                        entry_owner,
                        "fst-solid.route-option",
                        view.reference(item),
                        entry,
                        f"core-route-{prop}",
                    )
                    if prop == "path":
                        literal(entry_owner, item, "fst-solid.route-path", entry)

    for node in calls if analyze_receivers else ():
        budget.step()
        if "?." in node.tokens:
            continue
        fn = node.fields.get("function") or node.fields.get("constructor")
        if fn is None:
            continue
        args, owner = args_of(node), view.owner(node)
        if not owner:
            continue
        direct_rule = direct.get(id(node))
        if direct_rule:
            item_sequence = (
                direct_rule["operation"] == "list.raw-create" and node.type == "call_expression"
            )
            if item_sequence and (receiver_proofs_limited or "raw-list" in unsafe_constructors):
                diagnose(
                    "fst-solid.core-shape",
                    "List factory identity is not proven after a constructor escape, mutation or bounded proof limit.",
                    node,
                )
                continue
            if any(arg.type == "spread_element" for arg in args) and not item_sequence:
                diagnose(
                    "fst-solid.core-shape",
                    "Spread arguments do not establish positional API contracts.",
                    node,
                )
                continue
            effective = (
                {**direct_rule, "sources": []}
                if item_sequence
                else {**direct_rule, "callbacks": [2], "sources": [0, 1]}
                if direct_rule["operation"] == "collection.change-request"
                and len(args) > 2
                and known_function(args[2])
                else direct_rule
            )
            emit(owner, node, effective, fn, args)
            if item_sequence:
                property_fact(
                    owner,
                    "fst-solid.api-policy",
                    "ordered variadic contributions; spread iterables expand at runtime; final item count, values and normal completion unproven",
                    node,
                    "list-item-sequence",
                )
                for index, arg in enumerate(args):
                    budget.step()
                    spread = arg.type == "spread_element"
                    input_node = (
                        next((child for child in arg.children if child.type != "comment"), None)
                        if spread
                        else arg
                    )
                    if input_node is None:
                        diagnose(
                            "fst-solid.core-shape",
                            "List item contribution has no inspectable source expression.",
                            arg,
                        )
                        continue
                    property_fact(
                        owner,
                        "fst-solid.list-contribution",
                        f"{index}:{'spread-iterable' if spread else 'item'}",
                        arg,
                        "list-item-sequence",
                    )
                    relation(
                        owner,
                        "fst-solid.list-item-source",
                        {
                            "kind": "expression",
                            "text": view.text(input_node),
                            "span": view.span(input_node),
                        },
                        arg,
                        "list-item-sequence",
                    )
                    relation(
                        owner,
                        "fst-solid.list-construction",
                        {"kind": "expression", "text": view.text(node), "span": view.span(node)},
                        arg,
                        "list-item-sequence",
                    )
            assigned_owner = assigned(node)
            if assigned_owner and direct_rule.get("result") and handle(node):
                role(assigned_owner, "fst-solid.api-handle", node, "core-return")
                property_fact(
                    assigned_owner,
                    "fst-solid.handle-kind",
                    direct_rule["result"],
                    node,
                    "core-return",
                )
            operation = direct_rule["operation"]
            if operation in ("routes.define", "navigation.groups-define") and args:
                route_definitions(owner, node, args[0], operation == "navigation.groups-define")
            if operation == "load-sequence.create" and len(args) > 1:
                callback_binding(
                    args[1],
                    node,
                    "load-sequence-entry",
                    ("loadGroup", "index", "isLast", "isFirst"),
                )
            if (
                operation in ("value.create", "fragment.normalize")
                and args
                and known_function(args[0])
            ):
                relation(
                    owner,
                    "fst-solid.callback",
                    view.reference(args[0]),
                    node,
                    "core-initial-derivation",
                )
            if operation == "value.delayed-create" and len(args) > 1 and known_function(args[1]):
                relation(
                    owner,
                    "fst-solid.callback",
                    view.reference(args[1]),
                    node,
                    "core-initial-derivation",
                )
            if operation == "value.switch-create":
                if len(args) > 17:
                    diagnose(
                        "fst-solid.core-limit",
                        "Switch cases exceed bounded case enumeration.",
                        node,
                    )
                for entry in args[1:17]:
                    if entry.type != "array":
                        continue
                    parts = [child for child in entry.children if child.type != "comment"]
                    if len(parts) != 2 or any(part.type == "spread_element" for part in parts):
                        continue
                    budget.step(1024)
                    if view.project(entry, [0]) and view.project(entry, [1]):
                        emit(
                            owner,
                            entry,
                            {
                                "operation": "value.switch-case",
                                "sources": [0, 1],
                                "callbacks": [0] if known_function(parts[0]) else [],
                            },
                            parts[0],
                            parts,
                        )
            continue
        member = access(fn)
        receiver = usable(member["object"]) if member else None
        if member and receiver:
            contract = method(receiver, member["name"])
            if (
                contract
                and receiver["kind"] in _FAMILIES
                and not family(member["object"], member["name"])
            ):
                contract = None
            if (
                not contract
                and receiver["kind"] == "remote-api"
                and not member["name"].startswith(("$", "_"))
            ):
                contract = {
                    "operation": "transport.method-request",
                    "sources": list(range(len(args))),
                    "policy": "remote-target-unresolved",
                }
            if not contract or any(arg.type == "spread_element" for arg in args):
                continue
            if receiver["kind"] in _VALUES and member["name"] == "load":
                contract = (
                    {
                        "operation": "value.configure-loader",
                        "callbacks": [0],
                        "options": {"argument": 1, "literals": ["explicit", "delay"]},
                    }
                    if args and known_function(args[0])
                    else {
                        "operation": "value.load-configure-or-invoke"
                        if args
                        else "value.invoke-loader",
                        "sources": [0, 1],
                    }
                )
            emit(owner, node, contract, member["object"], args)
            if receiver["kind"] == "subform":
                relation(
                    owner,
                    "fst-solid.subform-origin",
                    view.reference(receiver["creation"]),
                    node,
                    "core-subform",
                )
            if args and member["name"] in ("onSelectedChange", "onActiveChange", "onClicked"):
                slot = {
                    "onSelectedChange": "selected",
                    "onActiveChange": "active",
                    "onClicked": "clicked",
                }[member["name"]]
                callback_binding(args[0], member["object"], "selection-event", (slot, "args"))
            if args and member["name"] == "onChange" and receiver["kind"] in _VALUES:
                callback_binding(
                    args[0], member["object"], "pre-commit-value", ("value", "oldValue")
                )
            continue
        if member and member["name"] == "then" and not receiver:
            command_access = access(member["object"])
            state = usable(command_access["object"]) if command_access else None
            if (
                command_access
                and state
                and state["kind"] == "state"
                and not state.get("raw")
                and args
                and command(command_access["object"], command_access["name"])
            ):
                emit(
                    owner,
                    node,
                    {
                        "operation": "state.method-completion-observe",
                        "callbacks": [0],
                        "policy": "successful-invocation-observer-not-promise-chain",
                    },
                    member["object"],
                    args,
                )
        invoked = usable(fn) if not member else None
        if not invoked:
            continue
        kind, contract = invoked["kind"], None
        if kind in _VALUES:
            budget.step(512)
            constant = view.constant(args[0]) if args else None
            operation = (
                "value.tracked-read"
                if not args or constant and constant["known"] and "value" not in constant
                else "value.write-request"
                if constant and constant["known"] or args and known_function(args[0])
                else "value.call-read-or-write"
            )
            contract = {"operation": operation, "sources": [0] if args else []}
        elif kind in ("accessor", "prop-value", "loader"):
            contract = {"operation": f"{kind}.read"}
        elif kind == "cancel":
            contract = {
                "operation": "cleanup.invoke-request",
                "policy": "not-owner-cleanup-unregistration",
            }
        elif kind == "action":
            contract = {
                "operation": "action.invoke-request",
                "sources": list(range(len(args))),
                "policy": "parameters-delivered-as-array-no-enabled-enforcement",
            }
        elif kind == "scheduler":
            budget.step(512)
            first = view.constant(args[0]) if args else None
            if first and first["known"] and type(first.get("value")) in (int, float):
                contract = {
                    "operation": "action.schedule-request",
                    "keys": [0, 2],
                    "callbacks": [1],
                }
            elif first and first["known"] and isinstance(first.get("value"), str):
                contract = {
                    "operation": "action.schedule-request",
                    "keys": [0, 1, 3],
                    "callbacks": [2],
                }
            else:
                contract = {
                    "operation": "action.schedule-unknown-overload",
                    "sources": list(range(len(args))),
                }
        elif kind == "fragment":
            contract = {
                "operation": "fragment.render-request",
                "keys": [0],
                "policy": "cached-unless-explicit-rerender",
            }
        elif kind == "root-renderer":
            contract = {
                "operation": "view.render-root-request",
                "sources": [0, 1],
                "callbacks": [0] if args and known_function(args[0]) else [],
                "policy": "manual-result-dispose",
            }
        if contract and not any(arg.type == "spread_element" for arg in args):
            emit(owner, node, contract, fn, args)

    # Component onExit is post-render, unlike the DOM visibility-exit hook.
    for node in calls:
        budget.step()
        if node.type != "call_expression" or node.fields.get("function") is None:
            continue
        origin = view.resolve(node.fields["function"])
        if (
            origin["kind"] != "import"
            or origin.get("member")
            or origin["name"] not in ("component", "componentWithChildren")
            or origin["module"]
            not in ("@fst/components-fst-solid/app", "@fst/components-fst-solid/app/component")
        ):
            continue
        owner, args = view.owner(node), args_of(node)
        if not owner or len(args) < 2:
            continue
        callback = projected(args[1], "onExit")
        if callback is not None:
            emit(
                owner,
                node,
                {
                    "operation": "component.post-render-register",
                    "callbacks": [0],
                    "policy": "not-unmount-or-visibility-exit",
                },
                node.fields["function"],
                [callback],
            )
