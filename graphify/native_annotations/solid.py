"""Reviewed, import-bound Solid contracts over the native TypeScript view."""

import re

from .jsx import (
    FUNCTIONS,
    PROPS_CONTRACT,
    WRAPPERS,
    args_of,
    array_items,
    bounded,
    expression,
    first_child,
    function_node,
    js_string,
    key,
    spread_argument,
    valid_string,
)


_ROLES = {
    "signal-accessor": "Solid Signal Accessor",
    "signal-setter": "Solid Signal Setter",
    "signal-pair": "Authored Signal Pair",
    "store-pair": "Authored Store Pair",
    "store": "Solid Store",
    "store-updater": "Solid Store Updater",
    "props-partition": "Solid Props Partition",
    "props-remainder": "Solid Remaining Props",
    "prop": "Solid Projected Prop",
    "accessor": "Derived or Bridged Accessor",
    "selector": "Key Selector",
    "reaction": "Reaction Tracker",
    "on-callback": "Explicit Dependency Callback",
    "owner": "Captured Possibly-Null Owner",
    "context": "Context Identity",
    "cleanup-callback": "Returned Cleanup Callback",
    "resource": "Resource Accessor",
    "resource-actions": "Resource Actions",
    "resource-mutator": "Resource Mutator",
    "resource-refetch": "Resource Refetch",
    "transition-pending": "Transition Pending Accessor",
    "transition-start": "Transition Starter",
    "store-modifier": "Store Modifier",
    "mutable-store": "Mutable Store",
    "raw-store": "Unwrapped Store Alias",
    "merged-props": "Lazy Shallow Merged Props",
    "children": "Resolved Children Accessor",
    "lazy-component": "Lazy Component",
    "observable": "Observable Bridge",
    "disposer": "Explicit Disposer",
    "request-event": "Optional Server Request Event",
    "query": "Router Query Handle",
    "action": "Router Action Handle",
}
_PROPERTIES = {
    "partition-index": ("Props Tuple Slot", False),
    "included-key": ("Included Prop Key", True),
    "excluded-key": ("Excluded Prop Key", True),
    "prop-key": ("Projected Prop Key", False),
    "boundary": ("Declared Boundary", True),
    "callback-role": ("Callback Contract", True),
    "parameter-role": ("Callback Parameter Contract", True),
    "return-contract": ("Declared Return Semantics", True),
    "option": ("Authored Static Option", True),
    "jsx-mode": ("Authored JSX Binding Mode", True),
    "callback-dispatch": ("Conditional Render Child Dispatch", True),
    "callback-argument-contract": ("Conditional Render Child Argument", True),
    "jsx-contribution": ("Ordered JSX Prop Contribution", True),
    "jsx-props-contract": ("JSX Props Resolution Contract", True),
    "dynamic-dispatch": ("Conditional Dynamic Component Dispatch", True),
}
_RELATIONS = {
    "factory": "Declared Solid Factory Import",
    "created-by": "Factory Call",
    "setter-for": "Sets Signal Accessor",
    "updater-for": "Updates Store",
    "alias-of": "Stable Binding Alias",
    "props-source": "Partitioned Props Expression",
    "signal-read": "Signal Accessor Call",
    "signal-write": "Signal Setter Call",
    "store-read": "Store Property Read",
    "store-update": "Store Updater Call",
    "api-call": "Qualified API Call",
    "accessor-read": "Accessor Call",
    "handle-call": "Direct Handle Call",
    "callback": "Declared Callback",
    "source": "Explicit Source Expression",
    "parameter-source": "Callback Value Source",
    "potential-read": "Direct Potential Tracked Read",
    "untracked-read": "Direct Accessor Call in Untracked Body",
    "batch-write": "Direct Setter or Updater Call in Batch Body",
    "resource-for": "Resource Action For Accessor",
    "transition-for": "Starts Pending Transition",
    "resource-status": "Resource Status Property Read",
    "owner-source": "Explicit Owner Argument",
    "context-source": "Explicit Context Identity",
    "merge-source": "Ordered Lazy Props Source",
    "returned-callback": "Returns Same Callback",
    "store-target": "Explicit Store Operation Target",
    "modifier-source": "Explicit Store Modifier",
    "event-handler": "Native Event Handler",
    "event-data": "Native Bound Event Data",
    "jsx-binding": "Native JSX Binding Expression",
    "jsx-overridden": "Possibly Overridden JSX Attribute",
    "render-child": "Conditional Child Source Expression",
    "conditional-callback": "Conditional Render Child Candidate",
    "jsx-contribution-source": "Authored JSX Contribution Source",
    "jsx-element": "Containing JSX Element Occurrence",
    "dynamic-component": "Dynamic Component Expression",
    "provider-context": "Context Provider Identity",
    "module-source": "Literal Lazy Module Request",
    "key-source": "Authored Router Key",
    "action-source": "Associated Router Action",
}
DESCRIPTOR = {
    "id": "solid",
    "version": "1",
    "languages": ["typescript", "tsx"],
    "view": {"id": "typescript", "version": 1},
    "roles": [{"id": f"solid.{name}", "label": label} for name, label in _ROLES.items()],
    "properties": [
        {"id": f"solid.{name}", "label": label, "multiple": multiple, "valueKind": "string"}
        for name, (label, multiple) in _PROPERTIES.items()
    ],
    "relations": [{"id": f"solid.{name}", "label": label} for name, label in _RELATIONS.items()],
}

_VALUE = {"kind": "value"}
_PAIR = {"kind": "tuple", "items": [_VALUE, _VALUE]}
_RECORD = {"kind": "record", "value": _VALUE}
_ROOT = ["solid-js", "@fst/components-fst-solid/solid-js"]
_STORE = ["solid-js/store", "@fst/components-fst-solid/solid-js/store"]
_WEB = ["solid-js/web"]
_WRAPPED_WEB = _WEB + ["@fst/components-fst-solid/solid-js/web"]
_ROUTER = ["@solidjs/router"]
_ACCUMULATOR = "return is next accumulator, not cleanup"
_ACCESSOR = {"": "solid.accessor"}


def _object(**properties):
    return {"kind": "object", "properties": properties}


def _callback(index, role, parameters=(), reads=None, returns=None, **rest):
    return {
        "index": index,
        "role": role,
        "parameters": list(parameters),
        **({"reads": reads} if reads else {}),
        **({"returns": returns} if returns else {}),
        **rest,
    }


def _rule(name, modules, **rest):
    return {"name": name, "modules": modules, **rest}


_RULES = [
    _rule(
        "createSignal",
        _ROOT,
        result=_PAIR,
        slots={"": "solid.signal-pair", "0": "solid.signal-accessor", "1": "solid.signal-setter"},
    ),
    _rule(
        "createStore",
        _STORE,
        result=_PAIR,
        slots={"": "solid.store-pair", "0": "solid.store", "1": "solid.store-updater"},
    ),
    _rule(
        "splitProps",
        _ROOT,
        result={"kind": "key-partitions", "sourceArgument": 0, "keysFromArgument": 1},
    ),
    _rule(
        "createMemo",
        _ROOT,
        result=_VALUE,
        slots=_ACCESSOR,
        callbacks=[_callback(0, "memo derivation", ["previous result"], "tracked", _ACCUMULATOR)],
    ),
    _rule(
        "createSelector",
        _ROOT,
        result=_VALUE,
        slots={"": "solid.selector"},
        callbacks=[
            _callback(0, "selector source", reads="tracked"),
            _callback(1, "selector equality", ["key", "source value"]),
        ],
    ),
    _rule(
        "createDeferred",
        _ROOT,
        result=_VALUE,
        slots=_ACCESSOR,
        sources=[0],
        boundary="deferred accessor; no inferred scheduler order",
    ),
    _rule(
        "createReaction",
        _ROOT,
        result=_VALUE,
        slots={"": "solid.reaction"},
        callbacks=[_callback(0, "reaction invalidation", reads="untracked")],
    ),
    *[
        _rule(
            name,
            _ROOT,
            callbacks=[
                _callback(0, f"{name} callback", ["previous accumulator"], "tracked", _ACCUMULATOR)
            ],
        )
        for name in ("createEffect", "createComputed", "createRenderEffect")
    ],
    _rule(
        "on",
        _ROOT,
        result=_VALUE,
        slots={"": "solid.on-callback"},
        boundary="explicit dependency accessors; callback receives values and is untracked",
    ),
    _rule(
        "untrack",
        _ROOT,
        callbacks=[_callback(0, "untracked synchronous body", reads="untracked")],
        boundary="tracking suppressed; ownership not removed",
    ),
    _rule(
        "batch",
        _ROOT,
        callbacks=[_callback(0, "synchronous batch body", reads="batch")],
        boundary="batch scope stops at suspension; no inferred flush order",
    ),
    _rule(
        "createRoot",
        _ROOT,
        callbacks=[_callback(0, "root body", ["root disposer"])],
        sources=[1],
        boundary="declared root; returned value is callback result, not necessarily disposer",
    ),
    _rule(
        "getOwner",
        _ROOT,
        result=_VALUE,
        slots={"": "solid.owner"},
        boundary="captured owner may be null",
    ),
    _rule(
        "runWithOwner",
        _ROOT,
        callbacks=[_callback(1, "borrowed-owner synchronous body")],
        sources=[0],
        boundary="restores owner, not tracking; does not transfer disposal",
    ),
    _rule(
        "onCleanup",
        _ROOT,
        result=_VALUE,
        slots={"": "solid.cleanup-callback"},
        callbacks=[_callback(0, "current-owner cleanup")],
        boundary="same callback returned; manual call does not unregister owner cleanup; owner-bound cleanup request, not wrapper lifetime or observed disposal",
    ),
    _rule(
        "onMount",
        _ROOT,
        callbacks=[
            _callback(
                0,
                "mount effect body",
                reads="untracked",
                returns="callback return is not cleanup registration",
            )
        ],
        boundary="client effect invokes callback untracked after initial render; server onMount is a no-op; mount, owner and scheduling not observed",
    ),
    _rule(
        "createContext",
        _ROOT,
        result=_object(Provider=_VALUE, defaultValue=_VALUE, id=_VALUE),
        slots={"": "solid.context"},
        sources=[0],
        identityObservations={
            "factoryArities": [0, 1, 2],
            "uses": [
                {
                    "kind": "call-argument",
                    "origins": [{"module": module, "name": "useContext"} for module in _ROOT],
                    "index": 0,
                    "arity": 1,
                },
                {"kind": "jsx-member", "member": "Provider"},
            ],
        },
    ),
    _rule(
        "useContext",
        _ROOT,
        sources=[0],
        boundary="context lookup request; no closest-provider inference",
    ),
    _rule(
        "createResource",
        _ROOT,
        result={
            "kind": "tuple",
            "items": [
                _object(state=_VALUE, loading=_VALUE, error=_VALUE, latest=_VALUE),
                _object(mutate=_VALUE, refetch=_VALUE),
            ],
        },
        slots={
            "0": "solid.resource",
            "1": "solid.resource-actions",
            "1.mutate": "solid.resource-mutator",
            "1.refetch": "solid.resource-refetch",
        },
    ),
    _rule(
        "useTransition",
        _ROOT,
        result=_PAIR,
        slots={"0": "solid.transition-pending", "1": "solid.transition-start"},
    ),
    _rule(
        "startTransition",
        _ROOT,
        callbacks=[_callback(0, "transition work")],
        boundary="requested transition; no completion or scheduler inference",
    ),
    _rule(
        "produce",
        _STORE,
        result=_VALUE,
        slots={"": "solid.store-modifier"},
        callbacks=[_callback(0, "store draft mutation", ["mutable draft"])],
    ),
    _rule("reconcile", _STORE, result=_VALUE, slots={"": "solid.store-modifier"}, sources=[0]),
    _rule("createMutable", _STORE, result=_RECORD, slots={"": "solid.mutable-store"}, sources=[0]),
    _rule(
        "modifyMutable",
        _STORE,
        sources=[0, 1],
        boundary="explicit mutable store modifier application",
    ),
    _rule(
        "unwrap",
        _STORE,
        result=_VALUE,
        slots={"": "solid.raw-store"},
        sources=[0],
        boundary="raw store alias; not an immutable deep copy",
    ),
    _rule(
        "mergeProps",
        _ROOT + _WEB,
        result=_RECORD,
        slots={"": "solid.merged-props"},
        boundary="shallow lazy sources; last non-undefined property wins; no eager folding",
    ),
    _rule(
        "children",
        _ROOT,
        result=_object(toArray=_VALUE),
        slots={"": "solid.children"},
        callbacks=[_callback(0, "resolved children source", reads="tracked")],
        identityObservations={
            "factoryArities": [1],
            "uses": [{"kind": "receiver-call", "member": "toArray", "arity": 0}],
        },
    ),
    _rule(
        "lazy",
        _ROOT,
        result=_object(preload=_VALUE),
        slots={"": "solid.lazy-component"},
        callbacks=[_callback(0, "lazy module loader")],
        boundary="lazy module request; no inferred loading/completion",
    ),
    _rule(
        "mapArray",
        _ROOT,
        result=_VALUE,
        slots=_ACCESSOR,
        sources=[0],
        callbacks=[
            _callback(1, "item mapping", ["item value", "index accessor"], arity="index-accessor")
        ],
    ),
    _rule(
        "indexArray",
        _ROOT,
        result=_VALUE,
        slots=_ACCESSOR,
        sources=[0],
        callbacks=[_callback(1, "index mapping", ["item accessor", "index value"])],
    ),
    _rule(
        "catchError",
        _ROOT,
        callbacks=[
            _callback(0, "protected synchronous body"),
            _callback(1, "error handler", ["error"]),
        ],
        boundary="error boundary request; not arbitrary async catch",
    ),
    _rule(
        "from",
        _ROOT,
        result=_VALUE,
        slots=_ACCESSOR,
        sources=[0],
        callbacks=[
            _callback(
                0,
                "external producer",
                ["signal setter"],
                returns="producer returns cleanup callback",
            )
        ],
    ),
    _rule(
        "observable",
        _ROOT,
        result=_object(subscribe=_VALUE),
        slots={"": "solid.observable"},
        sources=[0],
    ),
    *[
        _rule(name, _ROOT + _WEB, jsx=True)
        for name in (
            "For",
            "Index",
            "Show",
            "Match",
            "Switch",
            "ErrorBoundary",
            "Suspense",
            "SuspenseList",
        )
    ],
    _rule("Dynamic", _WRAPPED_WEB, jsx=True),
    _rule("Portal", _WRAPPED_WEB, jsx=True),
    _rule(
        "createDynamic",
        _WEB,
        sources=[0, 1],
        callbacks=[_callback(0, "dynamic component accessor")],
    ),
    *[
        _rule(
            name,
            _WRAPPED_WEB if name == "render" else _WEB,
            result=_VALUE,
            slots={"": "solid.disposer"},
            sources=[1],
            callbacks=[_callback(0, "render body")],
            boundary=f"{name} mount request; returned disposer is explicit",
        )
        for name in ("render", "hydrate")
    ],
    *[
        _rule(
            name,
            _WRAPPED_WEB if name == "renderToString" else _WEB,
            callbacks=[_callback(0, "server render body")],
            boundary=f"{name} request; server and client execution differ",
        )
        for name in ("renderToString", "renderToStringAsync", "renderToStream")
    ],
    _rule(
        "getRequestEvent",
        _WEB,
        result=_object(request=_VALUE, locals=_RECORD),
        slots={"": "solid.request-event"},
        boundary="request event may be absent outside server request",
    ),
    *[_rule(name, _WEB, jsx=True) for name in ("NoHydration", "Hydration", "HydrationScript")],
    *[
        _rule(
            name,
            _ROUTER,
            result=_object(key=_VALUE, keyFor=_VALUE),
            slots={"": "solid.query"},
            callbacks=[_callback(0, "router query fetcher")],
            sources=[1],
        )
        for name in ("query", "cache")
    ],
    _rule(
        "revalidate",
        _ROUTER,
        sources=[0],
        boundary="revalidation request, not cache-hit/invalidation proof",
    ),
    *[
        _rule(
            f"query.{name}",
            _ROUTER,
            sources=[] if name == "clear" else [0, 1] if name == "set" else [0],
            boundary="explicit query cache operation; no cache-state inference",
        )
        for name in ("get", "set", "delete", "clear")
    ],
    _rule(
        "action",
        _ROUTER,
        result=_object(url=_VALUE, **{"with": _VALUE}),
        slots={"": "solid.action"},
        callbacks=[_callback(0, "router action body")],
        sources=[1],
    ),
    _rule("useAction", _ROUTER, result=_VALUE, slots={"": "solid.action"}, sources=[0]),
    *[
        _rule(
            name,
            _ROUTER,
            sources=[0],
            callbacks=[_callback(1, "submission filter", ["action input"])],
        )
        for name in ("useSubmission", "useSubmissions")
    ],
    *[
        _rule(
            name,
            _ROUTER,
            result=_object(latest=_VALUE),
            slots=_ACCESSOR,
            callbacks=[_callback(0, "router async source")],
            boundary="returns accessor with latest; not a plain store object",
        )
        for name in ("createAsync", "createAsyncStore")
    ],
    *[
        _rule(
            name,
            _ROUTER,
            sources=[0],
            boundary="router response helper; no route convention inference",
        )
        for name in ("redirect", "reload", "json")
    ],
]
_IDENTITIES = {(module, entry["name"]): entry for entry in _RULES for module in entry["modules"]}
RETURN_CONTRACTS = [
    {
        "id": "solid." + re.sub(r"[A-Z]", lambda match: "-" + match[0].lower(), entry["name"]),
        "origins": [{"module": module, "name": entry["name"]} for module in entry["modules"]],
        "result": entry["result"],
        **(
            {"identityObservations": entry["identityObservations"]}
            if "identityObservations" in entry
            else {}
        ),
    }
    for entry in _RULES
    if "result" in entry
]


def _api(origin, member=False):
    if origin.get("kind") != "import" or (origin.get("member") and not member):
        return None
    return _IDENTITIES.get(
        (
            origin["module"],
            origin["name"] + ("." + origin["member"] if origin.get("member") else ""),
        )
    )


def analyze(view, budget, emitter):
    if view.state in ("truncated", "unsupported", "failed"):
        return {"state": view.state, "diagnostics": []}
    diagnostics, matched = [], False

    def diagnose(code, message, node):
        if len(diagnostics) < 16 and not any(item["code"] == code for item in diagnostics):
            diagnostics.append({"code": code, "message": message, "span": view.span(node)})

    def evidence(node, rule):
        return {"ruleId": rule, "basis": "import-bound", "span": view.span(node)}

    def relation(subject, term, target, node, rule):
        nonlocal matched
        budget.step()
        if not bounded(view, target):
            diagnose(
                "solid.reference-limit",
                "Source reference exceeds the bounded wire value size.",
                node,
            )
            return
        matched = True
        emitter.relation(subject["key"], term, target, evidence(node, rule))

    def property_(subject, term, value, node):
        nonlocal matched
        budget.step()
        if not valid_string(view, value):
            diagnose(
                "solid.key-limit",
                "A semantic value is outside the bounded wire string contract.",
                node,
            )
            return
        matched = True
        emitter.property(
            subject["key"],
            term,
            "literal",
            {"kind": "string", "value": value},
            evidence(node, "declared-contract"),
        )

    handles, groups, factories, calls = {}, {}, {}, []
    for node in view.nodes:
        budget.step()
        if node.type != "call_expression" or not node.fields.get("function") or "?." in node.tokens:
            continue
        rule = _api(view.resolve(node.fields["function"]), member=True)
        if rule:
            if rule["name"] in ("onMount", "onCleanup"):
                args = args_of(node)
                if len(args) != 1 or args[0].type == "spread_element":
                    diagnose(
                        "solid.call-shape",
                        "Lifecycle registration requires one explicit callback argument.",
                        node,
                    )
                    continue
            calls.append((node, rule))
            if "result" in rule:
                factories[key(node)] = rule
    if any(rule["name"].startswith("query.") for _, rule in calls):
        escaped = False
        for node in view.nodes:
            budget.step()
            if node.type not in ("identifier", "member_expression"):
                continue
            origin = view.resolve(node)
            if (
                origin.get("kind") != "import"
                or origin["module"] != "@solidjs/router"
                or origin["name"] != "query"
                or origin.get("member")
            ):
                continue
            binding = view.binding(node)
            if (
                binding
                and binding["kind"] == "import"
                and node.startIndex >= binding["node"].startIndex
                and node.endIndex <= binding["node"].endIndex
            ):
                continue
            at, parent = node, view.parent(node)
            while parent and parent.type in WRAPPERS:
                budget.step()
                at, parent = parent, view.parent(parent)
            if (
                parent
                and parent.type == "variable_declarator"
                and parent.fields.get("value") is at
                and view.parent(parent)
                and "const" in view.parent(parent).tokens
            ):
                continue
            if (
                parent
                and parent.type == "call_expression"
                and parent.fields.get("function") is at
                and "?." not in parent.tokens
            ):
                continue
            if (
                parent
                and parent.type == "member_expression"
                and parent.fields.get("object") is at
                and "?." not in parent.tokens
            ):
                member, call = view.resolve(parent), view.parent(parent)
                if (
                    member.get("kind") == "import"
                    and member.get("member")
                    and _api(member, member=True)
                    and call
                    and call.type == "call_expression"
                    and call.fields.get("function") is parent
                    and "?." not in call.tokens
                ):
                    continue
            escaped = True
            break
        if escaped:
            for node, rule in calls:
                if rule["name"].startswith("query."):
                    diagnose(
                        "solid.call-shape",
                        "Imported query namespace members may have escaped or been replaced.",
                        node,
                    )
            calls = [(node, rule) for node, rule in calls if not rule["name"].startswith("query.")]
    has_jsx = any(
        node.type in ("jsx_opening_element", "jsx_self_closing_element") for node in view.nodes
    )
    jsx_context = False
    if has_jsx:
        for node in view.nodes:
            budget.step()
            if node.type == "comment" and re.search(
                r"@jsxImportSource\s+(?:solid-js|@fst/components-fst-solid/solid-js)(?:\s|\*/|$)",
                view.text(node),
            ):
                jsx_context = True
                break
    if not calls and not has_jsx:
        return {"state": "partial" if diagnostics else "not-applicable", "diagnostics": diagnostics}
    for declaration in view.declarations:
        budget.step()
        if declaration["kind"] != "const":
            continue
        node = view.declarationNode(declaration["key"])
        if node is None:
            continue
        if node.type == "variable_declarator":
            initial = view.unwrap(node.fields["value"]) if node.fields.get("value") else None
            if initial is None or (
                initial.type
                not in ("identifier", "undefined", "member_expression", "subscript_expression")
                and not (
                    initial.type == "call_expression"
                    and factories.get(key(initial), {}).get("slots", {}).get("")
                )
            ):
                continue
        if not factories:
            continue
        budget.step(512)
        source = view.initializerProjection(declaration["key"])
        if not source or not source["complete"]:
            continue
        budget.step(512)
        projection = view.project(source["initializer"], source["path"])
        if not projection or not projection.get("contract"):
            continue
        factory = factories.get(key(projection["initializer"]))
        if not factory:
            continue
        path, partitions = projection["path"], projection.get("partitions")
        slot = int(path[0]) if path and str(path[0]).isdigit() else -1
        role = factory.get("slots", {}).get(".".join(map(str, path)))
        if projection["contract"] == "solid.split-props" and partitions and path:
            role = (
                "solid.prop"
                if len(path) == 2
                else "solid.props-remainder"
                if slot == len(partitions["keys"])
                else "solid.props-partition"
            )
        if projection["contract"] == "solid.merge-props" and len(path) == 1:
            role = "solid.prop"
        if not role:
            continue
        handle = {
            "declaration": declaration,
            "node": node,
            "projection": projection,
            "slot": slot,
            "role": role,
        }
        handles[declaration["key"]] = handle
        groups.setdefault(key(projection["initializer"]), []).append(handle)
        matched = True
        emitter.role(declaration["key"], role, evidence(node, "return-binding"))
        relation(
            declaration,
            "solid.factory",
            view.resolve(projection["initializer"].fields["function"]),
            node,
            "return-binding",
        )
        relation(
            declaration,
            "solid.created-by",
            view.reference(projection["initializer"]),
            node,
            "return-binding",
        )
        if role in ("solid.signal-pair", "solid.store-pair"):
            property_(
                declaration,
                "solid.return-contract",
                "authored two-slot result; later slot identity requires mutation and escape proof",
                node,
            )
        if factory["name"] == "onCleanup":
            argument = first_child(projection["initializer"].fields.get("arguments"))
            if argument:
                relation(
                    declaration,
                    "solid.returned-callback",
                    view.reference(argument),
                    node,
                    "same-cleanup-callback",
                )
            property_(declaration, "solid.return-contract", factory["boundary"], node)
        if partitions:
            relation(
                declaration,
                "solid.props-source",
                view.reference(partitions["source"]),
                node,
                "props-partition",
            )
            property_(declaration, "solid.partition-index", str(slot), node)
            if len(path) == 2:
                property_(declaration, "solid.prop-key", str(path[1]), node)
            else:
                remainder = slot == len(partitions["keys"])
                for prop in (
                    [p for group in partitions["keys"] for p in group]
                    if remainder
                    else partitions["keys"][slot]
                ):
                    property_(
                        declaration,
                        "solid.excluded-key" if remainder else "solid.included-key",
                        prop,
                        node,
                    )
    for node, factory in ((node, rule) for node, rule in calls if "result" in rule):
        budget.step()
        group = groups.get(key(node))
        if not group:
            parent = view.parent(node)
            returned = parent and (
                parent.type == "return_statement"
                or (parent.type == "arrow_function" and parent.fields.get("body") is node)
            )
            if not returned and factory["name"] in ("createSignal", "createStore", "splitProps"):
                diagnose(
                    "solid.unsupported-binding",
                    "Factory result has no proven stable supported binding projection.",
                    node,
                )
            continue
        group.sort(key=lambda item: item["declaration"]["span"]["startByte"])
        canonical = {}
        for handle in group:
            budget.step()
            path = tuple(
                int(part) if index == 0 and str(part).isdigit() else part
                for index, part in enumerate(handle["projection"]["path"])
            )
            first = canonical.get(path)
            if first is None:
                canonical[path] = handle
            else:
                relation(
                    handle["declaration"],
                    "solid.alias-of",
                    {"kind": "declaration", "key": first["declaration"]["key"]},
                    handle["node"],
                    "stable-alias",
                )
        read = canonical.get((0,))
        if read and read["role"] in (
            "solid.signal-accessor",
            "solid.store",
            "solid.resource",
            "solid.transition-pending",
        ):
            for handle in group:
                budget.step()
                if handle["slot"] != 1:
                    continue
                if (
                    read["role"] in ("solid.signal-accessor", "solid.store")
                    and len(handle["projection"]["path"]) != 1
                ):
                    continue
                term = {
                    "solid.signal-accessor": "solid.setter-for",
                    "solid.store": "solid.updater-for",
                    "solid.resource": "solid.resource-for",
                    "solid.transition-pending": "solid.transition-for",
                }[read["role"]]
                relation(
                    handle["declaration"],
                    term,
                    {"kind": "declaration", "key": read["declaration"]["key"]},
                    handle["node"],
                    "return-pair",
                )

    def invoked(node):
        binding = view.binding(node)
        return (
            handles.get(binding["declaration"])
            if binding
            and binding.get("available")
            and binding.get("stable")
            and not binding.get("typeOnly")
            and binding.get("declaration")
            else None
        )

    def handle_of(input_node):
        node = view.unwrap(input_node)
        known = invoked(node)
        if known:
            return known
        if (
            node.type not in ("member_expression", "subscript_expression")
            or not node.fields.get("object")
            or "?." in node.tokens
        ):
            return None
        base = invoked(view.unwrap(node.fields["object"]))
        if not base:
            return None
        budget.step(512)
        projection = view.project(node)
        factory = factories.get(key(projection["initializer"])) if projection else None
        role = (
            factory.get("slots", {}).get(".".join(map(str, projection["path"])))
            if factory
            else None
        )
        return (
            {"declaration": base["declaration"], "role": role, "projection": projection}
            if role
            else None
        )

    for node in view.nodes:
        budget.step()
        if (
            node.type == "call_expression"
            and node.fields.get("function")
            and "?." not in node.tokens
        ):
            fn = view.unwrap(node.fields["function"])
            bound, owner = handle_of(fn), view.owner(node)
            if bound and owner:
                role = bound["role"]
                term = {
                    "solid.signal-accessor": "solid.signal-read",
                    "solid.signal-setter": "solid.signal-write",
                    "solid.store-updater": "solid.store-update",
                }.get(role)
                if role in (
                    "solid.accessor",
                    "solid.resource",
                    "solid.children",
                    "solid.transition-pending",
                ):
                    term = "solid.accessor-read"
                if role in (
                    "solid.selector",
                    "solid.reaction",
                    "solid.on-callback",
                    "solid.resource-mutator",
                    "solid.resource-refetch",
                    "solid.transition-start",
                    "solid.cleanup-callback",
                    "solid.disposer",
                    "solid.query",
                    "solid.action",
                ):
                    term = "solid.handle-call"
                if term:
                    relation(owner, term, view.reference(fn), node, "direct-invocation")
        if node.type not in ("member_expression", "subscript_expression") or "?." in node.tokens:
            continue
        parent = view.parent(node)
        if (
            parent
            and parent.type in ("member_expression", "subscript_expression")
            and parent.fields.get("object") is node
        ):
            continue
        target, context = node, parent
        while context and context.type in WRAPPERS:
            budget.step()
            target, context = context, view.parent(context)
        if context and (
            (
                context.type in ("assignment_expression", "augmented_assignment_expression")
                and context.fields.get("left") is target
            )
            or context.type == "update_expression"
            or (context.type == "unary_expression" and "delete" in context.tokens)
        ):
            continue
        base = node
        while (
            base.type in ("member_expression", "subscript_expression")
            and base.fields.get("object")
            and "?." not in base.tokens
        ):
            budget.step()
            base = view.unwrap(base.fields["object"])
        store_handle, owner = invoked(base), view.owner(node)
        if store_handle and store_handle["role"] == "solid.store" and owner:
            relation(owner, "solid.store-read", view.reference(base), node, "direct-store-read")
    _analyze_semantics(view, budget, calls, handle_of, relation, property_, diagnose, jsx_context)
    return {
        "state": "partial" if diagnostics else "complete" if matched else "not-applicable",
        "diagnostics": diagnostics,
    }


def _analyze_semantics(view, budget, calls, handle, relation, property_, diagnose, jsx_context):
    reads = {
        "solid.signal-accessor",
        "solid.accessor",
        "solid.resource",
        "solid.children",
        "solid.transition-pending",
        "solid.selector",
    }
    writes = {"solid.signal-setter", "solid.store-updater", "solid.resource-mutator"}
    methods = {
        "solid.resource-actions": ("mutate", "refetch"),
        "solid.observable": ("subscribe",),
        "solid.lazy-component": ("preload",),
        "solid.children": ("toArray",),
        "solid.query": ("keyFor",),
        "solid.action": ("with",),
    }

    def at(items, index):
        return items[index] if 0 <= index < len(items) else None

    def native_context(input_node):
        if jsx_context:
            return True
        node = input_node
        for _ in range(64):
            if node is None:
                break
            budget.step()
            if node.type == "call_expression" and node.fields.get("function"):
                origin = view.resolve(node.fields["function"])
                if (
                    origin.get("kind") == "import"
                    and not origin.get("member")
                    and origin["module"] == "@fst/components-fst-solid/app/component"
                    and origin["name"] in ("component", "componentWithChildren")
                ):
                    renderer = first_child(node.fields.get("arguments"))
                    if (
                        renderer
                        and view.unwrap(renderer).type in FUNCTIONS
                        and input_node.startIndex >= renderer.startIndex
                        and input_node.endIndex <= renderer.endIndex
                    ):
                        return True
            annotation = node.fields.get("type") or node.fields.get("return_type")
            if annotation:
                stack = [annotation]
                for _ in range(64):
                    if not stack:
                        break
                    budget.step()
                    type_node = stack.pop()
                    origin = view.resolve(type_node, "type")
                    if (
                        origin.get("kind") == "import"
                        and origin["module"] in _ROOT
                        and origin["name"]
                        in ("Component", "ParentComponent", "FlowComponent", "VoidComponent", "JSX")
                    ):
                        return True
                    stack.extend(type_node.children)
            node = view.parent(node)
        return False

    def source(owner, node, anchor, term="solid.source"):
        if owner and node:
            relation(owner, term, view.reference(node), anchor, "explicit-source")

    def fn_of(node):
        return function_node(view, budget, node)

    def parameters_of(fn):
        parameters = fn.fields.get("parameters") or fn.fields.get("parameter")
        items = (
            parameters.children
            if parameters and parameters.type == "formal_parameters"
            else [parameters]
            if parameters
            else []
        )
        return [
            item
            for item in items
            if item.type != "comment"
            and (item.fields.get("pattern") or item.fields.get("name") or item).type != "this"
        ]

    def fields(input_node):
        if input_node is None:
            return None
        node = view.unwrap(input_node)
        if node.type != "object":
            budget.step(512)
            current = view.constant(node)
            if not current.get("known") or not isinstance(current.get("value"), dict):
                return None
            budget.step(512)
            projected = view.project(node)
            if not projected or projected["path"]:
                return None
            node = projected["initializer"]
        if node.type != "object" or len(node.children) > 32:
            return None
        result = {}
        for child in node.children:
            budget.step()
            if child.type == "comment":
                continue
            if child.type == "shorthand_property_identifier":
                result[view.text(child)] = child
                continue
            name = view.name(child.fields["key"]) if child.fields.get("key") else None
            if child.type != "pair" or not name or not child.fields.get("value"):
                return None
            result[name] = child.fields["value"]
        return result

    def direct(fn, mode):
        if "generator" in fn.type or "*" in fn.tokens or not fn.fields.get("body"):
            return
        stack = [fn.fields["body"]]
        while stack:
            budget.step()
            node = stack.pop()
            if node.type in ("await_expression", "yield_expression"):
                break
            if node.type in FUNCTIONS or node.type in ("class", "class_declaration"):
                continue
            if (
                node.type == "call_expression"
                and node.fields.get("function")
                and "?." not in node.tokens
            ):
                pending, suspends = list(node.children), False
                while pending:
                    budget.step()
                    child = pending.pop()
                    if child.type in FUNCTIONS:
                        continue
                    if child.type in ("await_expression", "yield_expression"):
                        suspends = True
                        break
                    pending.extend(child.children)
                target = view.unwrap(node.fields["function"])
                value, owner = handle(target), view.owner(node)
                term = None
                if value:
                    if value["role"] in reads and mode != "batch":
                        term = (
                            "solid.potential-read" if mode == "tracked" else "solid.untracked-read"
                        )
                    elif value["role"] in writes and mode == "batch":
                        term = "solid.batch-write"
                if not suspends and term and owner:
                    relation(owner, term, view.reference(target), node, "direct-callback-call")
            stack.extend(reversed(node.children))

    def callback(input_node, anchor, spec, dependencies=None):
        if input_node is None:
            return None
        value = view.unwrap(input_node)
        if value.type in ("object", "array", "regex", "template_string") or (
            value.type == "unary_expression" and "void" in value.tokens
        ):
            return None
        budget.step(512)
        if view.constant(input_node).get("known"):
            return None
        fn, labels = fn_of(input_node), spec.get("parameters", [])
        if spec.get("arity"):
            arity = None
            budget.step(512)
            parent = view.parent(anchor)
            observation = (
                parent
                if anchor.type == "jsx_opening_element" and parent and parent.type == "jsx_element"
                else anchor
            )
            if fn and view.referenceStable(input_node, observation, "before-call"):
                items = parameters_of(fn)
                if len(items) <= 16:
                    arity = 0
                    for parameter in items:
                        pattern = (
                            parameter.fields.get("pattern")
                            or parameter.fields.get("name")
                            or parameter
                        )
                        if parameter.fields.get("value") or pattern.type in (
                            "assignment_pattern",
                            "rest_pattern",
                        ):
                            break
                        arity += 1
            if (
                arity is None
                and spec["arity"] == "positive"
                and spec["role"] in ("Show render child", "Match render child")
            ):
                owner = view.owner(anchor)
                if owner:
                    relation(
                        owner,
                        "solid.conditional-callback",
                        expression(view, input_node),
                        anchor,
                        "conditional-child-dispatch",
                    )
                    other = (
                        "uses fallback"
                        if spec["role"].startswith("Show")
                        else "Switch selects another Match or fallback"
                    )
                    property_(
                        owner,
                        "solid.callback-dispatch",
                        f"{spec['role']}: when selected, typeof child === function && child.length > 0 invokes child untracked; otherwise renders child value; when not selected, {other}; callable identity, length and branch unproven",
                        anchor,
                    )
                    label = (
                        labels[0]
                        if labels
                        else "condition value when keyed, guarded condition accessor otherwise"
                    )
                    property_(
                        owner,
                        "solid.callback-argument-contract",
                        f"conditional argument[0]: {label}; accessors are guarded by the active branch; not a parameter binding",
                        anchor,
                    )
                return None
            if arity is None:
                diagnose(
                    "solid.callback-shape",
                    "Arity-dependent callback dispatch requires a stable local function object.",
                    anchor,
                )
            if spec["arity"] == "positive" and not arity:
                return None
            if spec["arity"] == "index-accessor" and (arity is None or arity <= 1):
                labels = labels[:1]
        source(view.owner(anchor), input_node, anchor, "solid.callback")
        if fn is None:
            return None
        owner = view.owner(fn)
        if owner:
            property_(owner, "solid.callback-role", spec["role"], fn)
            if spec.get("returns"):
                property_(owner, "solid.return-contract", spec["returns"], fn)
        items = parameters_of(fn)
        for index in range(min(len(items), len(labels), 8)):
            budget.step(512)
            parameter = items[index]
            pattern = (
                (parameter.fields.get("pattern") or parameter.fields.get("name") or parameter)
                if parameter.type == "optional_parameter" and not parameter.fields.get("value")
                else parameter
            )
            projected = view.patternProjections(pattern)
            if not projected["complete"] or len(projected["projections"]) > 32:
                diagnose(
                    "solid.callback-shape",
                    "Callback bindings require bounded static patterns without defaults or rest.",
                    parameter,
                )
                continue
            for entry in projected["projections"]:
                subject = view.owner(entry["node"]) or owner
                if not subject:
                    continue
                if entry["path"] and "accessor" in labels[index]:
                    diagnose(
                        "solid.callback-shape",
                        "Destructured function properties are not whole accessor parameters.",
                        entry["node"],
                    )
                    continue
                path = "." + ".".join(map(str, entry["path"])) if entry["path"] else ""
                property_(
                    subject,
                    "solid.parameter-role",
                    f"{view.text(entry['node'])}: {labels[index]}{path}",
                    entry["node"],
                )
                if dependencies is not None and index < 2:
                    dependency = (
                        at(dependencies, entry["path"][0])
                        if len(entry["path"]) == 1 and type(entry["path"][0]) is int
                        else dependencies[0]
                        if not entry["path"] and len(dependencies) == 1
                        else None
                    )
                    source(subject, dependency, entry["node"], "solid.parameter-source")
        if spec.get("reads"):
            direct(fn, spec["reads"])
        return fn

    def options(input_node, anchor, names):
        mapping, owner = fields(input_node), view.owner(anchor)
        if mapping is None:
            return
        for name in names:
            value = mapping.get(name)
            if not value or not owner:
                continue
            source(owner, value, anchor)
            budget.step(512)
            literal = view.constant(value)
            if literal.get("known") and type(literal.get("value")) in (str, bool, int, float):
                property_(owner, "solid.option", f"{name}={js_string(literal['value'])}", anchor)

    for node, rule in calls:
        budget.step()
        args, owner, name = args_of(node), view.owner(node), rule["name"]
        if len(args) > 32 or any(item.type == "spread_element" for item in args):
            diagnose(
                "solid.call-shape",
                "API arguments require bounded explicit positions without spreads.",
                node,
            )
            continue
        if name not in ("createSignal", "createStore", "splitProps") and owner:
            relation(
                owner,
                "solid.api-call",
                view.resolve(node.fields["function"]),
                node,
                "qualified-api",
            )
            if rule.get("boundary"):
                property_(owner, "solid.boundary", rule["boundary"], node)
        for spec in rule.get("callbacks", []):
            if name != "from":
                callback(at(args, spec["index"]), node, spec)
        for index in rule.get("sources", []):
            term = (
                "solid.owner-source"
                if name in ("runWithOwner", "createRoot")
                else "solid.context-source"
                if name == "useContext"
                else "solid.key-source"
                if name in ("query", "cache", "revalidate", "query.get", "query.delete")
                or (name == "query.set" and index == 0)
                else "solid.action-source"
                if name in ("useAction", "useSubmission", "useSubmissions")
                else "solid.source"
            )
            source(owner, at(args, index), node, term)
        if name == "on":
            deps = (
                (array_items(view, args[0]) if view.unwrap(args[0]).type == "array" else [args[0]])
                if args
                else None
            )
            if deps is None:
                diagnose(
                    "solid.callback-shape",
                    "Explicit dependency arrays require bounded static slots without holes or spreads.",
                    node,
                )
            else:
                for dep in deps:
                    source(owner, dep, node)
            callback(
                at(args, 1),
                node,
                _callback(
                    1,
                    "on value callback (untracked)",
                    [
                        "current dependency values",
                        "previous dependency values or undefined",
                        "previous returned accumulator",
                    ],
                    "untracked",
                    "next accumulator, not cleanup",
                ),
                deps,
            )
            options(at(args, 2), node, ["defer"])
        if name == "createResource":
            known_options = fields(at(args, 1))
            has_source = len(args) >= 3 or (len(args) == 2 and fn_of(args[1]) is not None)
            if len(args) == 2 and known_options is None and not has_source:
                diagnose(
                    "solid.call-shape",
                    "Two-argument resource overload requires a proven fetcher function or options object.",
                    node,
                )
                continue
            fetcher, settings = at(args, 1 if has_source else 0), at(args, 2 if has_source else 1)
            if has_source:
                source(owner, at(args, 0), node)
            callback(
                fetcher,
                node,
                _callback(
                    0,
                    "resource fetcher",
                    [
                        "source value" if has_source else "true source value",
                        "fetcher info (value and refetching)",
                    ],
                ),
            )
            mapping = fields(settings) or {}
            callback(
                mapping.get("storage"),
                node,
                _callback(
                    0,
                    "resource storage factory",
                    ["initial stored value"],
                    returns="accessor/setter pair",
                ),
            )
            options(settings, node, ["initialValue", "deferStream", "ssrLoadFrom"])
        if name == "mergeProps":
            for index, arg in enumerate(args):
                source(owner, arg, arg, "solid.merge-source")
                if owner:
                    property_(owner, "solid.option", f"merge source {index}", arg)
        if name == "modifyMutable":
            source(owner, at(args, 0), node, "solid.store-target")
            source(owner, at(args, 1), node, "solid.modifier-source")
        if name == "createDynamic":
            source(owner, at(args, 0), node, "solid.dynamic-component")
        if name == "from":
            budget.step(512)
            if not args or not view.referenceStable(args[0], node, "before-call"):
                diagnose(
                    "solid.call-shape",
                    "Producer subscription dispatch requires a stable reference after argument evaluation.",
                    node,
                )
            else:
                producer = fields(args[0])
                if producer is not None and "subscribe" in producer:
                    callback(
                        producer["subscribe"],
                        node,
                        _callback(
                            0,
                            "external subscription producer",
                            ["next value callback"],
                            returns="cleanup callback or unsubscribe object",
                        ),
                    )
                elif fn_of(args[0]) and rule.get("callbacks"):
                    callback(args[0], node, rule["callbacks"][0])
        if name == "lazy" and args:
            fn = fn_of(args[0])
            body = fn.fields.get("body") if fn else None
            if body:
                value = (
                    first_child(
                        next(
                            (item for item in body.children if item.type == "return_statement"),
                            None,
                        )
                    )
                    if body.type == "statement_block"
                    else body
                )
                if (
                    value
                    and value.type == "call_expression"
                    and value.fields.get("function")
                    and value.fields["function"].type == "import"
                ):
                    module = at(args_of(value), 0)
                    if module and module.type == "string":
                        source(owner, module, node, "solid.module-source")
        if name in ("createMemo", "createDeferred", "reconcile"):
            settings = at(args, 2 if name == "createMemo" else 1)
            mapping = fields(settings) or {}
            if name != "reconcile":
                callback(
                    mapping.get("equals"),
                    node,
                    _callback(0, "equality comparator", ["previous value", "next value"]),
                )
            options(
                settings,
                node,
                ["key", "merge"]
                if name == "reconcile"
                else ["equals", "timeoutMs"]
                if name == "createDeferred"
                else ["equals"],
            )
        if name == "renderToStream":
            mapping = fields(at(args, 1)) or {}
            for name in ("onCompleteShell", "onCompleteAll"):
                callback(
                    mapping.get(name), node, _callback(0, f"server {name}", ["stream info (write)"])
                )
    for node in view.nodes:
        budget.step()
        if (
            node.type == "call_expression"
            and node.fields.get("function")
            and "?." not in node.tokens
        ):
            fn, args, owner = view.unwrap(node.fields["function"]), args_of(node), view.owner(node)
            bound = handle(fn)
            if bound and bound["role"] == "solid.reaction":
                callback(at(args, 0), node, _callback(0, "reaction tracked body", reads="tracked"))
            if bound and bound["role"] == "solid.transition-start":
                callback(at(args, 0), node, _callback(0, "transition work"))
            if bound and bound["role"] == "solid.store-updater" and args:
                last = args[-1]
                modifier, value = handle(last), view.unwrap(last)
                api = (
                    _api(view.resolve(value.fields["function"]))
                    if value.type == "call_expression" and value.fields.get("function")
                    else None
                )
                source(
                    owner,
                    last,
                    node,
                    "solid.modifier-source"
                    if (modifier and modifier["role"] == "solid.store-modifier")
                    or (api and api["name"] in ("produce", "reconcile"))
                    else "solid.source",
                )
                for index in range(min(len(args) - 1, 16) if owner else 0):
                    source(owner, args[index], node)
                    budget.step(512)
                    literal = view.constant(args[index])
                    if literal.get("known") and type(literal.get("value")) in (str, int, float):
                        property_(
                            owner,
                            "solid.option",
                            f"store path {index}={js_string(literal['value'])}",
                            node,
                        )
            if (
                fn.type == "member_expression"
                and fn.fields.get("object")
                and fn.fields.get("property")
                and "?." not in fn.tokens
            ):
                base, method = handle(fn.fields["object"]), view.name(fn.fields["property"])
                if base and method in methods.get(base["role"], ()):
                    budget.step(512)
                    projected = view.project(fn)
                    if (
                        projected
                        and projected.get("contract")
                        and projected["contract"] == base["projection"].get("contract")
                        and owner
                    ):
                        if not bound:
                            relation(
                                owner,
                                "solid.handle-call",
                                view.reference(fn),
                                node,
                                "declared-handle-member",
                            )
                        if base["role"] == "solid.observable" and method == "subscribe":
                            if args and fn_of(args[0]):
                                callback(
                                    args[0],
                                    node,
                                    _callback(0, "observable observer", ["next value"]),
                                )
                            else:
                                source(owner, at(args, 0), node)
                                budget.step(512)
                                if args and view.referenceStable(args[0], node, "before-call"):
                                    callback(
                                        (fields(args[0]) or {}).get("next"),
                                        node,
                                        _callback(0, "observable next observer", ["next value"]),
                                    )
                    elif owner:
                        diagnose(
                            "solid.call-shape",
                            "Declared handle member is not proven after a receiver escape or mutation.",
                            node,
                        )
        if (
            node.type == "member_expression"
            and node.fields.get("object")
            and node.fields.get("property")
            and "?." not in node.tokens
        ):
            base, name, owner = (
                handle(node.fields["object"]),
                view.name(node.fields["property"]),
                view.owner(node),
            )
            if (
                base
                and base["role"] == "solid.resource"
                and owner
                and name in ("loading", "error", "state", "latest")
            ):
                budget.step(512)
                if view.project(node):
                    source(owner, node.fields["object"], node, "solid.resource-status")
                    property_(owner, "solid.option", f"resource.{name}", node)
        if node.type not in (
            "jsx_opening_element",
            "jsx_self_closing_element",
        ) or not node.fields.get("name"):
            continue
        tag, owner = node.fields["name"], view.owner(node)
        origin = view.resolve(tag)
        rule = _api(origin)
        attributes, superseded, duplicates, spreads, overridden = {}, set(), set(), [], []
        for item in node.children:
            budget.step()
            if item.type == "jsx_expression":
                spreads.append(item)
                superseded.update(attributes)
                overridden.extend(attr["node"] for attr in attributes.values())
                attributes.clear()
                continue
            if item.type != "jsx_attribute" or not item.children:
                continue
            raw = at(item.children, 1)
            value = first_child(raw) if raw and raw.type == "jsx_expression" else raw
            name = view.text(item.children[0])
            if name in attributes:
                duplicates.add(name)
                superseded.add(name)
                del attributes[name]
                continue
            superseded.discard(name)
            attributes[name] = {"node": item, "value": value}

        def prop(name):
            if name not in attributes and (spreads or name in superseded):
                diagnose(
                    "solid.jsx-shape",
                    f"JSX {name} is not proven after spread or duplicate props.",
                    node,
                )
            return attributes.get(name, {}).get("value")

        def record_spreads():
            for attr in overridden:
                source(owner, attr, attr, "solid.jsx-overridden")
            for spread in spreads:
                source(owner, spread_argument(spread), spread)
                if owner:
                    property_(
                        owner,
                        "solid.jsx-mode",
                        "spread props (dynamic keys; authored order retained; final effective values unproven)",
                        spread,
                    )

        parent = view.parent(node)
        children = []
        if (
            node.type == "jsx_opening_element"
            and parent
            and parent.type == "jsx_element"
            and next((item for item in parent.children if item.type == "jsx_opening_element"), None)
            is node
        ):
            children = [
                item
                for item in parent.children
                if item.type not in ("jsx_opening_element", "jsx_closing_element", "comment")
                and not (item.type == "jsx_text" and not view.text(item).strip())
                and not (
                    item.type == "jsx_expression"
                    and all(child.type == "comment" for child in item.children)
                )
            ]
        child = (
            first_child(children[0])
            if len(children) == 1 and children[0].type == "jsx_expression"
            else None
        )
        if rule and rule.get("jsx") and owner:
            name = rule["name"]
            relation(owner, "solid.api-call", origin, node, "qualified-jsx")
            record_spreads()
            if name in ("For", "Index"):
                source(owner, prop("each"), node)
                callback(
                    child if children else prop("children"),
                    node,
                    _callback(
                        0,
                        f"{name} children",
                        ["item value", "index accessor"]
                        if name == "For"
                        else ["item accessor", "index value"],
                        **({"arity": "index-accessor"} if name == "For" else {}),
                    ),
                )
            if name in ("Show", "Match"):
                source(owner, prop("when"), node)
                keyed = attributes.get("keyed")
                unknown_keyed = keyed is None and (bool(spreads) or "keyed" in superseded)
                if unknown_keyed:
                    prop("keyed")
                mode = (
                    "condition value or accessor (dynamic keyed)"
                    if unknown_keyed
                    else "condition accessor"
                    if keyed is None
                    else "condition value (keyed)"
                    if keyed["value"] is None or view.text(keyed["value"]) == "true"
                    else "condition accessor"
                    if view.text(keyed["value"]) == "false"
                    else "condition value or accessor (dynamic keyed)"
                )
                rendered = child if children else prop("children")
                source(owner, rendered, node, "solid.render-child")
                callback(
                    rendered,
                    node,
                    _callback(0, f"{name} render child", [mode], "untracked", arity="positive"),
                )
            if name == "ErrorBoundary":
                callback(
                    prop("fallback"),
                    node,
                    _callback(0, "error fallback", ["error", "reset callback"]),
                )
            if name == "Dynamic":
                if not spreads:
                    source(owner, prop("component"), node, "solid.dynamic-component")
                else:
                    ordinal, group = 0, 0

                    def contribution(item, kind, input_node):
                        nonlocal ordinal
                        property_(
                            owner, "solid.jsx-contribution", f"{ordinal}:group={group}:{kind}", item
                        )
                        ordinal += 1
                        relation(
                            owner,
                            "solid.jsx-contribution-source",
                            expression(view, input_node),
                            item,
                            "dynamic-prop-sequence",
                        )
                        relation(
                            owner,
                            "solid.jsx-element",
                            expression(view, node),
                            item,
                            "dynamic-prop-sequence",
                        )

                    for item in node.children:
                        budget.step()
                        if item.type == "jsx_attribute" and item.children:
                            contribution(item, f"attribute:{view.text(item.children[0])}", item)
                        elif item.type == "jsx_expression":
                            input_node = spread_argument(item)
                            if input_node:
                                group += 1
                                contribution(item, "spread", input_node)
                                group += 1
                    for child in children:
                        contribution(child, "nested-child-source", child)
                    property_(owner, "solid.jsx-props-contract", PROPS_CONTRACT, node)
                    property_(
                        owner,
                        "solid.dynamic-dispatch",
                        "effective component is removed from forwarded props; function selects component invocation, string selects intrinsic element, other types yield no rendered value; final component, branch, output and execution success unproven",
                        node,
                    )
                    if duplicates:
                        diagnose(
                            "solid.jsx-shape",
                            "Duplicate authored JSX attributes remain unsupported by the ordered Dynamic contract.",
                            node,
                        )
            if name == "Portal":
                source(owner, prop("mount"), node)
                source(owner, prop("ref"), node)
                property_(
                    owner, "solid.boundary", "DOM relocation does not change owner ancestry", node
                )
            if name in ("Suspense", "SuspenseList", "NoHydration", "Hydration", "HydrationScript"):
                property_(
                    owner,
                    "solid.boundary",
                    f"{name} authored render boundary; no scheduling guarantee",
                    node,
                )
                for name in ("fallback", "revealOrder", "tail"):
                    source(owner, prop(name), node)
        if (
            tag.type == "member_expression"
            and tag.fields.get("object")
            and tag.fields.get("property")
            and view.name(tag.fields["property"]) == "Provider"
        ):
            context = handle(tag.fields["object"])
            if owner and context and context["role"] == "solid.context":
                record_spreads()
                budget.step(512)
                if view.project(tag):
                    source(owner, tag.fields["object"], node, "solid.provider-context")
                    source(owner, prop("value"), node)
                else:
                    diagnose(
                        "solid.jsx-shape",
                        "Provider member identity is not proven after a receiver escape.",
                        node,
                    )
        if (
            not re.fullmatch(r"[a-z][a-z0-9:_-]*", view.text(tag))
            or not owner
            or not native_context(node)
        ):
            continue
        record_spreads()
        if any(
            name in ("ref", "innerHTML")
            or name.startswith("use:")
            or re.match(r"on(?::|capture:|[A-Za-z])", name)
            for name in superseded
        ):
            diagnose(
                "solid.jsx-shape",
                "Native JSX bindings before a spread or duplicate attribute are not proven.",
                node,
            )
        for name, attr in attributes.items():
            value, anchor = attr["value"], attr["node"]
            if name.startswith("use:"):
                property_(
                    owner, "solid.jsx-mode", "native directive (element, value accessor)", anchor
                )
                directive = at(anchor.children[0].children, 1) if anchor.children else None
                source(owner, directive, anchor, "solid.jsx-binding")
                source(owner, value, anchor)
                callback(
                    directive,
                    anchor,
                    _callback(
                        0, "native directive", ["native element", "directive value accessor"]
                    ),
                )
            elif name == "ref":
                source(owner, value, anchor, "solid.jsx-binding")
                callback(value, anchor, _callback(0, "native ref callback", ["native element"]))
            elif name == "innerHTML":
                source(owner, value, anchor, "solid.jsx-binding")
                property_(
                    owner, "solid.jsx-mode", "raw innerHTML assignment (not escaped text)", anchor
                )
            elif re.match(r"on(?::|capture:|[A-Za-z])", name) and value:
                property_(owner, "solid.jsx-mode", name, anchor)
                target, data = value, None
                native_name = name.startswith(("on:", "oncapture:"))
                if view.unwrap(value).type == "array":
                    items = array_items(view, value)
                    if native_name or items is None or len(items) != 2:
                        diagnose(
                            "solid.jsx-shape",
                            "Native event tuple requires exactly [handler, data] on an ordinary onEvent attribute.",
                            anchor,
                        )
                        continue
                    target, data = items
                elif name.startswith("on:") and view.unwrap(value).type == "object":
                    target = (fields(value) or {}).get("handleEvent")
                    if target is None:
                        diagnose(
                            "solid.jsx-shape",
                            "Native listener object requires explicit handleEvent and bounded options.",
                            anchor,
                        )
                        continue
                    options(value, anchor, ["capture", "passive", "once", "signal"])
                elif view.unwrap(value).type == "object":
                    diagnose(
                        "solid.jsx-shape",
                        "Listener option objects are supported only for explicit on: events.",
                        anchor,
                    )
                    continue
                source(owner, target, anchor, "solid.event-handler")
                source(owner, data, anchor, "solid.event-data")
                callback(
                    target,
                    anchor,
                    _callback(
                        0,
                        "bound native event handler" if data else "native event handler",
                        ["bound data", "native event"] if data else ["native event"],
                    ),
                )
    for node in view.nodes:
        budget.step()
        if node.type != "comment" or not re.search(r"@once\b", view.text(node)):
            continue
        parent = view.parent(node)
        owner = view.owner(parent) if parent else None
        if parent and parent.type == "jsx_expression" and owner and native_context(parent):
            property_(
                owner, "solid.jsx-mode", "@once requested; compiler-transform dependent", parent
            )
