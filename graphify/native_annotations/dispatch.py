"""In-process Elysia/tRPC family witnesses, never deployment or execution pairs."""

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
    "rules": [
        "elysia-app-v1",
        "elysia-route-v1",
        "elysia-handle-v1",
        "trpc-router-v1",
        "trpc-procedure-v1",
        "trpc-caller-v1",
        "trpc-call-v1",
    ],
    "http": {
        "module": "elysia",
        "name": "Elysia",
        "assumption": "elysia-1.3.21-in-process-v1",
        "methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    },
    "rpc": {
        "module": "@trpc/server",
        "name": "initTRPC",
        "assumption": "trpc-11.4.3-in-process-v1",
        "kinds": ["query", "mutation"],
        "reserved": [
            "__proto__",
            "constructor",
            "prototype",
            "then",
            "call",
            "apply",
            "_def",
            "createCaller",
        ],
    },
    "request": {
        "module": "undici",
        "name": "Request",
        "reviewedAPI": "undici-7.13.0-request",
        "origins": ["ambient-fetch", "undici-named"],
    },
    "reviewedSources": [
        "https://raw.githubusercontent.com/elysiajs/elysia/1.3.21/src/index.ts",
        "https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/initTRPC.ts",
        "https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/procedureBuilder.ts",
        "https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/router.ts",
        "https://raw.githubusercontent.com/nodejs/undici/v7.13.0/lib/web/fetch/request.js",
    ],
    "conditions": [
        "lexical-binding-only",
        "reviewed-api-assumed",
        "installed-version-not-captured",
        "execution-not-observed",
        "external-mutation-not-observed",
        "runtime-not-observed",
        "registration-order-unknown",
        "registered-at-dispatch-required",
        "potential-correspondence-only",
    ],
    "httpConditions": [
        "standard-request-api-assumed",
        "deployment-not-observed",
        "url-origin-not-a-binding",
    ],
    "rpcConditions": [
        "input-result-semantics-unknown",
        "procedure-kind-not-side-effect-proof",
        "network-serialization-not-implied",
    ],
    "pathPattern": "^/(?:[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)?$",
    "maxSourceBytes": 256 * 1024,
    "maxWork": 100000,
    "maxDepth": 64,
    "maxFamilies": 8,
    "maxEndpoints": 32,
    "maxFacts": 2048,
    "maxArguments": 16,
    "maxCallersPerFamily": 1,
    "maxPathBytes": 256,
    "maxURLBytes": 1024,
    "maxIdentifierBytes": 128,
    "maxPairCandidates": 1024,
    "maxPairs": 64,
}
DESCRIPTOR = descriptor(
    "dispatch-binding",
    {
        "dispatch-family": "Qualified In-Process Binding Family",
        "dispatch-handler": "Registered In-Process Handler",
        "dispatch-caller": "Exact Local RPC Caller",
        "dispatch-call": "Potential In-Process Dispatch",
    },
    references={
        "declaration": "Exact Family Declaration",
        "import-reference": "Exact Framework Import",
        "initializer-declaration": "RPC Initializer Declaration",
        "caller-declaration": "Exact Caller Declaration",
        "request-import-reference": "Named Request Import",
    },
    spans={
        "allocation": "Family Allocation",
        "import": "Named Import Specifier",
        "initializer": "RPC Initialization",
        "owner": "Lexical Callable Or Module",
        "receiver": "Direct Receiver",
        "selector": "Path URL Or Procedure Selector",
        "method": "API Method Token",
        "method-literal": "Explicit Request Method",
        "handler": "Inline Handler",
        "argument": "Exact Argument",
        "request": "Request Allocation",
        "request-constructor": "Request Constructor",
        "request-import": "Request Import Specifier",
        "caller": "Caller Allocation",
        "context": "Empty Caller Context",
    },
    strings={
        "family": "Closed Dispatch Family",
        "api-assumption": "Reviewed API Assumption",
        "http-method": "Exact HTTP Method",
        "path": "Simple Path Only",
        "procedure-key": "Exact Procedure Key",
        "procedure-kind": "Declared Procedure Kind",
        "request-origin": "Qualified Request Origin",
        "condition": "Conditional Qualification Limitation",
    },
    integers={
        "family-count": "Whole Source Family Census",
        "endpoint-count": "Whole Family Endpoint Census",
        "caller-count": "Whole Family Caller Census",
        "argument-count": "Exact Argument Census",
    },
    booleans={
        "inventory-complete": "Complete File-Local Use Inventory",
        "unit-complete": "Complete Evidence Unit",
    },
    span_description="Exact source locator, never embedded source text.",
)
_CALLABLES = {"function_declaration", "function_expression", "arrow_function"}
_OWNER_CONTEXT = {
    "program",
    "statement_block",
    "expression_statement",
    "return_statement",
    "variable_declarator",
    "lexical_declaration",
    "export_statement",
}
_URL = re.compile(r"https?://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::([0-9]{1,5}))?(/[^?#]*)\Z")


def analyze(view, budget, emitter):
    if view.state != "complete":
        return {"state": view.state, "diagnostics": []}
    census = Census(
        "dispatch-binding",
        "File-local dispatch qualification is incomplete or outside the reviewed in-process contract.",
        RULES,
        view,
        budget,
    )
    endpoint_count = 0

    def span(node):
        return string(locator(view, node))

    def is_identifier(node):
        return identifier(view, node, RULES["maxIdentifierBytes"])

    def path(value):
        return (
            value is not None
            and len(value.encode()) <= RULES["maxPathBytes"]
            and re.fullmatch(RULES["pathPattern"], value) is not None
        )

    def member(node):
        if not node or node.type != "member_expression" or optional(node):
            return None
        prop = node.fields.get("property")
        if (
            not prop
            or prop.type != "property_identifier"
            or not is_identifier(prop)
            or not node.fields.get("object")
        ):
            return None
        return {"receiver": node.fields["object"], "method": prop, "name": view.text(prop)}

    def call(node):
        if (
            not node
            or node.type != "call_expression"
            or not node.fields.get("arguments")
            or node.fields.get("type_arguments")
            or optional(node)
        ):
            return None
        target = member(node.fields.get("function"))
        return {**target, "args": args(node)} if target else None

    def owner(node, registration=False):
        child, parent, result = node, view.parent(node), None
        if not registration and parent and parent.type == "await_expression":
            child, parent = parent, view.parent(parent)
        if not parent or not (
            parent.type == "expression_statement"
            or not registration
            and (
                parent.type == "return_statement"
                or parent.type == "arrow_function"
                and same(parent.fields.get("body"), child)
                or parent.type == "variable_declarator"
                and same(parent.fields.get("value"), child)
            )
        ):
            return None
        while parent:
            census.step()
            if parent.type in _CALLABLES:
                if not same(parent.fields.get("body"), child):
                    return None
                if result is None:
                    result = parent
            elif parent.type not in _OWNER_CONTEXT:
                return None
            child, parent = parent, view.parent(parent)
        return result or view.root

    def argument_properties(values):
        return [("argument-count", integer(len(values)))] + [
            ("argument", span(value)) for value in values
        ]

    try:
        census.check_tree()
        imports, import_tokens, names = {}, set(), set()
        apis = [RULES["http"], RULES["rpc"], RULES["request"]]
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
            if module in {"node:module", "module", "node:vm", "vm"}:
                census.diagnose("dynamic-scope", node)
            api = next((api for api in apis if module == api["module"]), None)
            if not api:
                if module and any(module.startswith(api["module"] + "/") for api in apis):
                    census.diagnose("import-shape", node)
                continue
            clause = next((child for child in node.children if child.type == "import_clause"), None)
            if not clause:
                census.diagnose("import-shape", node)
                continue
            for part in children(clause):
                census.step()
                if part.type != "named_imports":
                    census.diagnose("import-shape", part)
                    continue
                for specifier in children(part):
                    census.step()
                    if "type" in specifier.tokens:
                        continue
                    imported = specifier.fields.get("name")
                    local_name = specifier.fields.get("alias") or imported
                    if (
                        not imported
                        or imported.type != "identifier"
                        or view.text(imported) != api["name"]
                        or not local_name
                        or local_name.type != "identifier"
                        or not is_identifier(local_name)
                    ):
                        census.diagnose("import-shape", specifier)
                        continue
                    imports[node_key(local_name)] = {
                        "node": specifier,
                        "module": api["module"],
                        "name": api["name"],
                    }
                    import_tokens.update((node_key(local_name), node_key(imported)))
                    names.add(view.name(local_name))
        if not any(
            imported["module"] != RULES["request"]["module"] for imported in imports.values()
        ):
            return {"state": "not-applicable", "diagnostics": []}
        allowed, declarations, tracked = set(), set(), set()
        retained = {declaration["key"] for declaration in view.declarations}

        def imported_at(node, module):
            if not node or node.type != "identifier" or not is_identifier(node):
                return None
            origin = census.binding(node)
            imported = (
                imports.get(node_key(origin["node"]))
                if origin and origin["kind"] == "import"
                else None
            )
            return (
                imported
                if origin
                and origin.get("available")
                and origin.get("stable")
                and not origin.get("typeOnly")
                and imported
                and imported["module"] == module
                else None
            )

        def local(allocation):
            node = view.parent(allocation)
            container = view.parent(node) if node else None
            name = node.fields.get("name") if node else None
            declaration = view.declarationAt(node) if node else None
            if (
                not node
                or node.type != "variable_declarator"
                or not same(node.fields.get("value"), allocation)
                or not name
                or name.type != "identifier"
                or not is_identifier(name)
                or not container
                or container.type != "lexical_declaration"
                or "const" not in container.tokens
                or not same(view.parent(container), view.root)
                or not declaration
                or declaration["kind"] != "const"
                or declaration["exports"]
            ):
                census.diagnose("allocation-shape", allocation)
                return None
            if declaration["key"] not in retained:
                census.limit("inventory-limit")
            tracked.add(declaration["key"])
            declarations.add(node_key(name))
            names.add(view.name(name))
            return {
                "node": node,
                "name": name,
                "allocation": allocation,
                "declaration": declaration["key"],
            }

        def declaration_of(node):
            if not node or node.type != "identifier" or not is_identifier(node):
                return None
            origin = census.binding(node)
            return (
                origin.get("declaration")
                if origin and origin.get("available") and origin.get("stable")
                else None
            )

        families, initializers = [], []

        def add_family(family):
            if len(families) >= RULES["maxFamilies"]:
                census.limit("family-limit")
            families.append(family)

        def add_endpoint(family, node, lexical_owner, role, rule, properties):
            nonlocal endpoint_count
            endpoint_count += 1
            if endpoint_count > RULES["maxEndpoints"]:
                census.limit("endpoint-limit")
            family["endpoints"].append(
                {
                    "node": node,
                    "owner": lexical_owner,
                    "role": role,
                    "ruleId": rule,
                    "properties": properties,
                }
            )

        for node in view.nodes:
            census.step()
            ctor = node.fields.get("constructor")
            imported = (
                imported_at(ctor, RULES["http"]["module"])
                if node.type == "new_expression"
                else None
            )
            if imported and ctor:
                if (
                    not node.fields.get("arguments")
                    or args(node)
                    or node.fields.get("type_arguments")
                    or optional(node)
                ):
                    census.diagnose("allocation-shape", node)
                    continue
                declaration = local(node)
                if declaration:
                    allowed.add(node_key(ctor))
                    add_family(
                        {
                            **declaration,
                            "imported": imported,
                            "kind": "elysia-http",
                            "endpoints": [],
                        }
                    )
            invocation = call(node)
            init_import = (
                imported_at(invocation["receiver"], RULES["rpc"]["module"])
                if invocation and invocation["name"] == "create"
                else None
            )
            if invocation and init_import:
                if invocation["args"]:
                    census.diagnose("initializer-shape", node)
                    continue
                declaration = local(node)
                if declaration:
                    if len(initializers) >= RULES["maxFamilies"]:
                        census.limit("family-limit")
                    allowed.add(node_key(invocation["receiver"]))
                    initializers.append({**declaration, "imported": init_import})
        for node in view.nodes:
            census.step()
            invocation = call(node)
            if not invocation or invocation["name"] != "router":
                continue
            declaration = declaration_of(invocation["receiver"])
            initializer = next(
                (init for init in initializers if init["declaration"] == declaration), None
            )
            if not initializer:
                continue
            shape = invocation["args"][0] if invocation["args"] else None
            binding_local = local(node)
            if (
                not binding_local
                or len(invocation["args"]) != 1
                or not shape
                or shape.type != "object"
                or not children(shape)
            ):
                census.diagnose("router-shape", node)
                continue
            family = {
                **binding_local,
                "imported": initializer["imported"],
                "initializer": initializer,
                "kind": "trpc-rpc",
                "endpoints": [],
            }
            keys = set()
            for field in children(shape):
                census.step()
                selector, procedure = field.fields.get("key"), field.fields.get("value")
                procedure_call = call(procedure)
                builder = member(procedure_call["receiver"]) if procedure_call else None
                handler = (
                    procedure_call["args"][0] if procedure_call and procedure_call["args"] else None
                )
                if (
                    field.type != "pair"
                    or not selector
                    or selector.type != "property_identifier"
                    or not is_identifier(selector)
                    or view.text(selector) in RULES["rpc"]["reserved"]
                    or view.text(selector) in keys
                    or not procedure
                    or not procedure_call
                    or procedure_call["name"] not in RULES["rpc"]["kinds"]
                    or len(procedure_call["args"]) != 1
                    or not handler
                    or handler.type != "arrow_function"
                    or not builder
                    or builder["name"] != "procedure"
                    or declaration_of(builder["receiver"]) != initializer["declaration"]
                ):
                    census.diagnose("procedure-shape", field)
                    continue
                keys.add(view.text(selector))
                allowed.add(node_key(builder["receiver"]))
                add_endpoint(
                    family,
                    procedure,
                    view.root,
                    "dispatch-handler",
                    RULES["rules"][4],
                    [
                        ("receiver", span(builder["receiver"])),
                        ("selector", span(selector)),
                        ("method", span(procedure_call["method"])),
                        ("handler", span(handler)),
                        ("procedure-key", string(view.text(selector))),
                        ("procedure-kind", string(procedure_call["name"])),
                        *argument_properties(procedure_call["args"]),
                    ],
                )
            allowed.add(node_key(invocation["receiver"]))
            add_family(family)
        for node in view.nodes:
            census.step()
            invocation = call(node)
            if not invocation or invocation["name"] != "createCaller":
                continue
            declaration = declaration_of(invocation["receiver"])
            family = next(
                (
                    family
                    for family in families
                    if family["kind"] == "trpc-rpc" and family["declaration"] == declaration
                ),
                None,
            )
            if not family:
                continue
            context = invocation["args"][0] if invocation["args"] else None
            binding_local = local(node)
            if (
                not binding_local
                or family.get("caller")
                or len(invocation["args"]) != 1
                or not context
                or context.type != "object"
                or children(context)
            ):
                census.diagnose("caller-shape", node)
                continue
            family.update(
                caller=binding_local,
                context=context,
                callerReceiver=invocation["receiver"],
                callerMethod=invocation["method"],
            )
            allowed.add(node_key(invocation["receiver"]))
        for node in view.nodes:
            census.step()
            invocation = call(node)
            if not invocation:
                continue
            declaration = declaration_of(invocation["receiver"])
            family = (
                next(
                    (
                        family
                        for family in families
                        if (
                            family["declaration"]
                            if family["kind"] == "elysia-http"
                            else family.get("caller", {}).get("declaration")
                        )
                        == declaration
                    ),
                    None,
                )
                if declaration
                else None
            )
            if not family:
                continue
            values = invocation["args"]
            if family["kind"] == "trpc-rpc":
                lexical_owner = owner(node)
                registered = any(
                    endpoint["role"] == "dispatch-handler"
                    and any(
                        prop == "procedure-key"
                        and value["kind"] == "string"
                        and value["value"] == invocation["name"]
                        for prop, value in endpoint["properties"]
                    )
                    for endpoint in family["endpoints"]
                )
                if (
                    not lexical_owner
                    or len(values) > RULES["maxArguments"]
                    or any(value.type == "spread_element" for value in values)
                    or not registered
                ):
                    census.diagnose("caller-use", node)
                    continue
                allowed.add(node_key(invocation["receiver"]))
                add_endpoint(
                    family,
                    node,
                    lexical_owner,
                    "dispatch-call",
                    RULES["rules"][6],
                    [
                        ("receiver", span(invocation["receiver"])),
                        ("selector", span(invocation["method"])),
                        ("method", span(invocation["method"])),
                        ("procedure-key", string(invocation["name"])),
                        ("caller", span(family["caller"]["allocation"])),
                        ("caller-declaration", reference(family["caller"]["declaration"])),
                        *argument_properties(values),
                    ],
                )
                continue
            method = invocation["name"].upper()
            if method in RULES["http"]["methods"] and invocation["name"] == method.lower():
                selector = values[0] if values else None
                handler = values[1] if len(values) > 1 else None
                value, lexical_owner = literal(view, selector), owner(node, True)
                duplicate = any(
                    endpoint["role"] == "dispatch-handler"
                    and any(
                        prop == "path" and item["kind"] == "string" and item["value"] == value
                        for prop, item in endpoint["properties"]
                    )
                    and any(
                        prop == "http-method"
                        and item["kind"] == "string"
                        and item["value"] == method
                        for prop, item in endpoint["properties"]
                    )
                    for endpoint in family["endpoints"]
                )
                if (
                    not lexical_owner
                    or len(values) != 2
                    or not selector
                    or not path(value)
                    or not handler
                    or handler.type != "arrow_function"
                    or duplicate
                ):
                    census.diagnose("route-shape", node)
                    continue
                allowed.add(node_key(invocation["receiver"]))
                add_endpoint(
                    family,
                    node,
                    lexical_owner,
                    "dispatch-handler",
                    RULES["rules"][1],
                    [
                        ("receiver", span(invocation["receiver"])),
                        ("selector", span(selector)),
                        ("method", span(invocation["method"])),
                        ("handler", span(handler)),
                        ("http-method", string(method)),
                        ("path", string(value)),
                        *argument_properties(values),
                    ],
                )
                continue
            if invocation["name"] != "handle":
                census.diagnose("receiver-use", node)
                continue
            request = values[0] if values else None
            ctor = request.fields.get("constructor") if request else None
            lexical_owner = owner(node)
            request_import = imported_at(ctor, RULES["request"]["module"])
            ambient = (
                ctor
                and ctor.type == "identifier"
                and view.text(ctor) == "Request"
                and not census.binding(ctor)
            )
            request_args = args(request)
            url = literal(view, request_args[0]) if request_args else None
            parsed = (
                _URL.fullmatch(url) if url and len(url.encode()) <= RULES["maxURLBytes"] else None
            )
            host, port, request_path = parsed.groups() if parsed else (None, None, None)
            host_valid = bool(
                host
                and re.fullmatch(r"[A-Za-z0-9]+(?:[A-Za-z0-9.-]*[A-Za-z0-9])?", host)
                and all(
                    len(label) <= 63 and not label.startswith("-") and not label.endswith("-")
                    for label in host.split(".")
                )
                and (
                    re.search(r"[A-Za-z]", host)
                    or re.fullmatch(r"(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}", host)
                    and all(int(part) <= 255 for part in host.split("."))
                )
            )
            http_method, method_literal, valid_options = "GET", None, True
            if len(request_args) > 1:
                options = request_args[1]
                fields = children(options)
                field = fields[0] if fields else None
                method_literal = field.fields.get("value") if field else None
                explicit = literal(view, method_literal)
                key = field.fields.get("key") if field else None
                if (
                    options.type != "object"
                    or len(fields) != 1
                    or not field
                    or field.type != "pair"
                    or not key
                    or key.type != "property_identifier"
                    or view.text(key) != "method"
                    or explicit not in RULES["http"]["methods"]
                ):
                    valid_options = False
                else:
                    http_method = explicit
            if (
                not lexical_owner
                or len(values) != 1
                or not request
                or request.type != "new_expression"
                or not request.fields.get("arguments")
                or request.fields.get("type_arguments")
                or optional(request)
                or not ctor
                or not (request_import or ambient)
                or not 1 <= len(request_args) <= 2
                or not valid_options
                or not host_valid
                or port
                and int(port) > 65535
                or not path(request_path)
            ):
                census.diagnose("request-shape", node)
                continue
            allowed.update((node_key(invocation["receiver"]), node_key(ctor)))
            properties = [
                ("receiver", span(invocation["receiver"])),
                ("selector", span(request_args[0])),
                ("method", span(invocation["method"])),
                ("request", span(request)),
                ("request-constructor", span(ctor)),
                ("request-origin", string("undici-named" if request_import else "ambient-fetch")),
                ("http-method", string(http_method)),
                ("path", string(request_path)),
                *argument_properties(values),
            ]
            if method_literal:
                properties.append(("method-literal", span(method_literal)))
            if request_import:
                properties += [
                    ("request-import", span(request_import["node"])),
                    (
                        "request-import-reference",
                        import_reference(RULES["request"]["module"], RULES["request"]["name"]),
                    ),
                ]
            add_endpoint(
                family, node, lexical_owner, "dispatch-call", RULES["rules"][2], properties
            )
        # Unsupported later uses and ambient Request escapes invalidate the whole census.
        for node in view.nodes:
            census.step()
            if (
                node.type not in IDENTIFIERS
                or node_key(node) in import_tokens
                or node_key(node) in declarations
            ):
                continue
            origin = census.binding(node)
            imported = origin and origin["kind"] == "import" and node_key(origin["node"]) in imports
            if imported or origin and origin.get("declaration") in tracked:
                if (
                    not origin.get("available")
                    or not origin.get("stable")
                    or origin.get("typeOnly")
                    or node_key(node) not in allowed
                ):
                    census.diagnose("binding-use", node)
            elif (
                not origin
                and (view.name(node) in names or view.name(node) == "Request")
                and node_key(node) not in allowed
            ):
                census.diagnose("ambiguous-reference", node)
        if census.partial:
            return census.report()

        def stage(family, node, lexical_owner, role, rule, properties, subject=None):
            if subject is None:
                owning = view.owner(lexical_owner)
                subject = owning["key"] if owning else None
            if subject not in retained:
                census.limit("inventory-limit")
            http = family["kind"] == "elysia-http"
            all_properties = [
                ("declaration", reference(family["declaration"])),
                (
                    "import-reference",
                    import_reference(family["imported"]["module"], family["imported"]["name"]),
                ),
                ("import", span(family["imported"]["node"])),
                ("allocation", span(family["allocation"])),
                ("owner", span(lexical_owner)),
                ("family", string(family["kind"])),
                ("api-assumption", string(RULES["http" if http else "rpc"]["assumption"])),
            ]
            if family.get("initializer"):
                all_properties += [
                    ("initializer-declaration", reference(family["initializer"]["declaration"])),
                    ("initializer", span(family["initializer"]["allocation"])),
                ]
            all_properties += [
                ("condition", string(condition))
                for condition in RULES["conditions"]
                + RULES["httpConditions" if http else "rpcConditions"]
            ]
            all_properties += properties + [
                ("inventory-complete", boolean(True)),
                ("unit-complete", boolean(True)),
            ]
            census.stage(
                node,
                subject,
                role,
                rule,
                all_properties,
                min(RULES["maxFacts"], view.limits["maxFacts"]),
            )

        for family in families:
            census.step()
            stage(
                family,
                family["allocation"],
                view.root,
                "dispatch-family",
                RULES["rules"][0 if family["kind"] == "elysia-http" else 3],
                [
                    ("family-count", integer(len(families))),
                    ("endpoint-count", integer(len(family["endpoints"]))),
                    ("caller-count", integer(1 if family.get("caller") else 0)),
                ],
                family["declaration"],
            )
            if family.get("caller"):
                stage(
                    family,
                    family["caller"]["allocation"],
                    view.root,
                    "dispatch-caller",
                    RULES["rules"][5],
                    [
                        ("caller", span(family["caller"]["allocation"])),
                        ("caller-declaration", reference(family["caller"]["declaration"])),
                        ("receiver", span(family["callerReceiver"])),
                        ("method", span(family["callerMethod"])),
                        ("context", span(family["context"])),
                        *argument_properties([family["context"]]),
                    ],
                    family["caller"]["declaration"],
                )
            for endpoint in family["endpoints"]:
                stage(
                    family,
                    endpoint["node"],
                    endpoint["owner"],
                    endpoint["role"],
                    endpoint["ruleId"],
                    endpoint["properties"],
                )
        census.emit(emitter)
    except CensusLimit:
        pass
    return census.report()
