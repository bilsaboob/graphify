"""Complete, file-local inventories of direct Node EventEmitter uses."""

from ._evidence import (
    Census,
    CensusLimit,
    IDENTIFIERS,
    args,
    boolean,
    descriptor,
    import_reference,
    integer,
    literal,
    locator,
    node_key,
    optional,
    reference,
    same,
    string,
)


ATOMIC = True
RULES = {
    "version": 1,
    "spanEncoding": "s:utf8-start:utf8-end:start-line:end-line",
    "rules": ["node-event-instance-v1", "node-event-listener-v1", "node-event-emission-v1"],
    "module": "node:events",
    "importedName": "EventEmitter",
    "excludedEvents": ["error", "newListener", "removeListener"],
    "conditions": [
        "lexical-binding-only",
        "standard-node-api-assumed",
        "runtime-version-not-captured",
        "registration-order-unknown",
        "execution-unknown",
        "external-mutation-unknown",
    ],
    "maxSourceBytes": 256 * 1024,
    "maxWork": 100000,
    "maxDepth": 64,
    "maxInstances": 16,
    "maxEndpoints": 48,
    "maxFacts": 1024,
    "maxEventKeyBytes": 128,
    "maxEmissionArguments": 16,
    "maxPairCandidates": 1024,
    "maxCorrespondences": 64,
}
DESCRIPTOR = descriptor(
    "transport-binding",
    {
        "event-instance": "Qualified Event Allocation",
        "event-listener": "Qualified Event Listener",
        "event-emission": "Qualified Event Emission",
    },
    references={
        "declaration": "Exact Local Allocation Declaration",
        "import-reference": "Direct Constructor Import",
    },
    spans={
        "allocation": "Allocation Span",
        "import": "Named Import Specifier Span",
        "receiver": "Direct Receiver Span",
        "event-literal": "Event Literal Span",
        "callback": "Inline Arrow Callback Span",
        "owner": "Lexical Callable Or Module Span",
    },
    strings={"event-key": "Exact ASCII Event Key", "condition": "Lexical Qualification Limitation"},
    integers={"endpoint-count": "Full Qualified Allocation Endpoint Count"},
    booleans={
        "inventory-complete": "Qualified File-Local Reference Inventory",
        "unit-complete": "Complete Evidence Unit",
    },
)
_CALLABLES = {
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "generator_function",
    "arrow_function",
}
_OWNER_CONTEXT = {
    "expression_statement",
    "statement_block",
    "program",
    "variable_declarator",
    "lexical_declaration",
    "export_statement",
    "arguments",
    "call_expression",
    "parenthesized_expression",
}


def analyze(view, budget, emitter):
    if view.state != "complete":
        return {"state": view.state, "diagnostics": []}
    census = Census(
        "transport-binding",
        "File-local transport qualification is incomplete or outside the reviewed contract.",
        RULES,
        view,
        budget,
    )

    def endpoint_owner(node):
        child, parent, owner = node, view.parent(node), None
        if not parent or not (
            parent.type == "expression_statement"
            or parent.type == "arrow_function"
            and same(parent.fields.get("body"), child)
        ):
            return None
        while parent:
            census.step()
            if parent.type in _CALLABLES:
                if not same(parent.fields.get("body"), child):
                    return None
                if owner is None:
                    owner = parent
            elif parent.type not in _OWNER_CONTEXT:
                return None
            child, parent = parent, view.parent(parent)
        return owner or view.root

    def span(node):
        return string(locator(view, node))

    try:
        census.check_tree()
        imports, imported_names = {}, set()
        constructor_veto = False
        for node in view.nodes:
            census.step()
            if node.type in IDENTIFIERS and view.name(node) in {"require", "eval"}:
                constructor_veto = True
            if node.type == "call_expression":
                values, fn = args(node), node.fields.get("function")
                first = values[0] if values else None
                prop = fn.fields.get("property") if fn else None
                if fn and (
                    fn.type == "import"
                    or prop
                    and view.name(prop) in {"getBuiltinModule", "require", "eval"}
                ):
                    constructor_veto = True
                endpoint = (
                    fn
                    and fn.type == "member_expression"
                    and prop
                    and view.name(prop) in {"on", "emit"}
                )
                if (
                    not endpoint
                    and first
                    and first.type == "string"
                    and view.name(first) in {RULES["module"], "events"}
                ):
                    constructor_veto = True
            if node.type != "import_statement" or not node.fields.get("source"):
                continue
            module = view.moduleIdentity(node.fields["source"])
            if module in {"node:module", "module"}:
                constructor_veto = True
            if module not in {RULES["module"], "events"} or "type" in node.tokens:
                continue
            clause = next((child for child in node.children if child.type == "import_clause"), None)
            for part in clause.children if clause else ():
                census.step()
                if part.type != "named_imports":
                    constructor_veto = True
                    continue
                for specifier in part.children:
                    census.step()
                    if specifier.type == "comment" or "type" in specifier.tokens:
                        continue
                    name = specifier.fields.get("name")
                    local = specifier.fields.get("alias") or name
                    if (
                        module != RULES["module"]
                        or not name
                        or name.type != "identifier"
                        or view.name(name) != RULES["importedName"]
                        or not local
                        or local.type != "identifier"
                    ):
                        constructor_veto = True
                        continue
                    imports[node_key(local)] = specifier
                    imported_names.add(node_key(name))
        if not imports:
            return {"state": "not-applicable", "diagnostics": []}
        instances = []
        retained = {declaration["key"] for declaration in view.declarations}
        for node in view.nodes:
            census.step()
            ctor = node.fields.get("constructor")
            if node.type != "new_expression" or not ctor or ctor.type != "identifier":
                continue
            origin = census.binding(ctor)
            if not origin or origin["kind"] != "import" or origin.get("typeOnly"):
                continue
            imported = imports.get(node_key(origin["node"]))
            if not imported:
                continue
            declaration_node = view.parent(node)
            container = view.parent(declaration_node) if declaration_node else None
            name = declaration_node.fields.get("name") if declaration_node else None
            declaration = view.declarationAt(declaration_node) if declaration_node else None
            if (
                not origin.get("stable")
                or not origin.get("available")
                or not node.fields.get("arguments")
                or args(node)
                or node.fields.get("type_arguments")
                or optional(node)
                or not declaration_node
                or declaration_node.type != "variable_declarator"
                or not same(declaration_node.fields.get("value"), node)
                or not name
                or name.type != "identifier"
                or not container
                or container.type != "lexical_declaration"
                or "const" not in container.tokens
                or not same(view.parent(container), view.root)
                or not declaration
                or declaration["kind"] != "const"
                or declaration["exports"]
            ):
                constructor_veto = True
                census.diagnose("allocation-shape", node)
                continue
            if declaration["key"] not in retained:
                census.limit("inventory-limit")
            if len(instances) >= RULES["maxInstances"]:
                census.limit("instance-limit")
            instances.append(
                {
                    "node": declaration_node,
                    "name": name,
                    "allocation": node,
                    "declaration": declaration["key"],
                    "imported": imported,
                    "endpoints": [],
                    "veto": False,
                }
            )
        by_declaration = {instance["declaration"]: instance for instance in instances}
        constructors = {
            node_key(instance["allocation"].fields["constructor"]) for instance in instances
        }
        endpoints = 0
        for node in view.nodes:
            census.step()
            if node.type not in IDENTIFIERS:
                continue
            parent = view.parent(node)
            if (
                view.name(node) == "eval"
                and parent
                and parent.type == "call_expression"
                and same(parent.fields.get("function"), node)
            ):
                constructor_veto = True
                census.diagnose("dynamic-scope", node)
            origin = census.binding(node)
            if origin and origin["kind"] == "import" and node_key(origin["node"]) in imports:
                if same(node, origin["node"]) or node_key(node) in imported_names:
                    continue
                if (
                    not origin.get("stable")
                    or not origin.get("available")
                    or node_key(node) not in constructors
                ):
                    constructor_veto = True
                    census.diagnose("constructor-use", node)
                continue
            instance = by_declaration.get(origin.get("declaration")) if origin else None
            if not instance:
                if not origin:
                    for item in instances:
                        if view.name(node) == view.name(item["name"]):
                            item["veto"] = True
                            census.diagnose("ambiguous-reference", node)
                continue
            if same(node, instance["name"]):
                continue
            call = view.parent(parent) if parent else None
            values = args(call)
            method = (
                view.name(parent.fields["property"])
                if parent and parent.fields.get("property")
                else None
            )
            event = values[0] if values else None
            callback = values[1] if method == "on" and len(values) > 1 else None
            key = literal(view, event)
            owner = endpoint_owner(call) if call else None
            if (
                not origin.get("available")
                or not origin.get("stable")
                or node.type != "identifier"
                or not parent
                or parent.type != "member_expression"
                or not same(parent.fields.get("object"), node)
                or optional(parent)
                or not call
                or call.type != "call_expression"
                or not same(call.fields.get("function"), parent)
                or optional(call)
                or call.fields.get("type_arguments")
                or not owner
                or method not in {"on", "emit"}
                or not event
                or not key
                or len(key.encode()) > RULES["maxEventKeyBytes"]
                or key in RULES["excludedEvents"]
                or any(value.type == "spread_element" for value in values)
                or (
                    len(values) != 2 or not callback or callback.type != "arrow_function"
                    if method == "on"
                    else len(values) > RULES["maxEmissionArguments"]
                )
            ):
                instance["veto"] = True
                census.diagnose("receiver-use", node)
                continue
            endpoints += 1
            if endpoints > RULES["maxEndpoints"]:
                census.limit("endpoint-limit")
            instance["endpoints"].append(
                {
                    "node": call,
                    "receiver": node,
                    "event": event,
                    "key": key,
                    "callback": callback,
                    "owner": owner,
                }
            )
        if constructor_veto:
            census.diagnose("constructor-use")
        # One escaped allocation may expose the shared constructor or prototype.
        if constructor_veto or any(instance["veto"] for instance in instances):
            return census.report()
        for instance in instances:
            census.step()
            if not instance["endpoints"]:
                continue
            common = [
                ("declaration", reference(instance["declaration"])),
                ("import-reference", import_reference(RULES["module"], RULES["importedName"])),
                ("allocation", span(instance["allocation"])),
                ("import", span(instance["imported"])),
                *[("condition", string(condition)) for condition in RULES["conditions"]],
            ]
            units = [
                (
                    instance["allocation"],
                    "event-instance",
                    RULES["rules"][0],
                    [
                        ("owner", span(view.root)),
                        ("endpoint-count", integer(len(instance["endpoints"]))),
                    ],
                )
            ]
            for endpoint in instance["endpoints"]:
                callback = endpoint["callback"]
                properties = [
                    ("owner", span(endpoint["owner"])),
                    ("receiver", span(endpoint["receiver"])),
                    ("event-literal", span(endpoint["event"])),
                    ("event-key", string(endpoint["key"])),
                ]
                if callback:
                    properties.append(("callback", span(callback)))
                units.append(
                    (
                        endpoint["node"],
                        "event-listener" if callback else "event-emission",
                        RULES["rules"][1 if callback else 2],
                        properties,
                    )
                )
            for node, role, rule, properties in units:
                subject = view.owner(node)
                if not subject or subject["key"] not in retained:
                    census.limit("inventory-limit")
                census.stage(
                    node,
                    subject["key"],
                    role,
                    rule,
                    common
                    + properties
                    + [("inventory-complete", boolean(True)), ("unit-complete", boolean(True))],
                )
        census.emit(emitter)
    except CensusLimit:
        pass
    return census.report()
