"""Reviewed FST import, return-shape and receiver contracts."""

ROOT = "@fst/components-fst-solid"
_CATALOGUE = {}
_PUBLIC_NAMES = {}
_ORIGINS = {}


def _add(paths, entries):
    for path in paths:
        module = f"{ROOT}/{path}"
        for name, rule in entries.items():
            _CATALOGUE[module, name] = rule
            _PUBLIC_NAMES.setdefault(module, set()).add(name.split(".")[0])
            if rule.get("result") and "." not in name:
                key = (rule["result"], "construct" if rule.get("construct") else "call")
                _ORIGINS.setdefault(key, []).append({"module": module, "name": name})


def _rule(operation, callbacks=(), sources=(), **options):
    return {
        "operation": operation,
        "callbacks": list(callbacks),
        "sources": list(sources),
        **options,
    }


_add(
    ["hooks/value"],
    {
        "value": {"operation": "value.create", "result": "value", "sources": [0, 1]},
        "switchValue": {
            "operation": "value.switch-create",
            "result": "accessor",
            "sources": [0],
            "callbacks": [0],
            "policy": "read-only-accessor-case-results-invoked-during-setup",
        },
        "lazyValueList": {
            "operation": "list.lazy-create",
            "result": "value",
            "callbacks": [0],
            "sources": [0],
            "policy": "explicit-load",
        },
    },
)
_add(
    ["hooks/delayed"],
    {
        "delayedValue": {
            "operation": "value.delayed-create",
            "result": "delayed-value",
            "sources": [1, 2],
            "keys": [0],
        },
        "delayedToggle": {
            "operation": "toggle.delayed-create",
            "result": "toggle-pair",
            "sources": [1, 2],
            "keys": [0],
        },
        "delayedAction": {
            "operation": "action.scheduler-create",
            "result": "scheduler",
            "options": {"argument": 0, "literals": ["multiple"]},
        },
    },
)
_add(
    ["hooks/timer"],
    {
        "useTimeout": {
            "operation": "timer.timeout-register",
            "result": "cancel",
            "callbacks": [0],
            "keys": [1],
            "policy": "owner-cleanup-and-returned-clear-no-unregister",
        },
        "useInterval": {
            "operation": "timer.interval-register",
            "result": "cancel",
            "callbacks": [0],
            "keys": [1],
            "policy": "owner-cleanup-and-returned-clear-no-unregister",
        },
    },
)
for _path, _name, _target in [
    ("hooks/documentEvent", "onDocumentEvent", "document"),
    ("hooks/windowEvent", "useWindowEvent", "window"),
]:
    _add(
        [_path],
        {
            _name: {
                "operation": f"event.{_target}-register",
                "keys": [0],
                "callbacks": [1],
                "sources": [2],
                "policy": "cleanup-request-without-capture-options",
            }
        },
    )
_add(
    ["hooks/windowSize"],
    {
        "useWindowSize": {
            "operation": "window.size-observe",
            "result": "accessor",
            "policy": "owner-cleanup-request",
        }
    },
)
_add(
    ["hooks/mouse"],
    {
        "useMouseHover": {
            "operation": "mouse.hover-observe",
            "result": "hover-value",
            "sources": [0],
            "options": {
                "argument": 1,
                "callbacks": ["callback", "isInside"],
                "literals": ["checkVisible"],
            },
            "policy": "owner-cleanup-request",
        },
        "onMouseClickOutside": {
            "operation": "mouse.outside-click-register",
            "result": "removable",
            "callbacks": [1],
            "sources": [0],
            "policy": "owner-cleanup-and-manual-remove-request",
        },
    },
)
_add(
    ["hooks/resize"],
    {
        "onResize": {
            "operation": "resize.observe",
            "result": "resize-observer",
            "sources": [0],
            "callbacks": [1],
            "policy": "manual-disconnect",
        },
        "observeHeightChange": {
            "operation": "height.observe",
            "result": "disposable",
            "sources": [0],
            "callbacks": [1],
            "policy": "manual-dispose",
        },
    },
)
_add(
    ["hooks/reorder"],
    {
        "createReorderInteraction": {
            "operation": "reorder.create",
            "result": "reorder",
            "options": {
                "argument": 0,
                "callbacks": ["start"],
                "sources": ["element", "disabled", "invalidation"],
                "literals": ["threshold"],
            },
            "policy": "requires-owner-cleanup-request",
        },
    },
)
_add(
    ["app/field", "app"],
    {
        "field": {
            "operation": "field.create-contract",
            "result": "field",
            "sources": [0],
            "options": {"argument": 1, "literals": ["bindInitialValue", "name"]},
        },
        "resolveTextFieldOrText": {
            "operation": "field.resolve-conditional-pair",
            "result": "field-text-pair",
            "sources": [0],
            "policy": "nullable-field-or-untyped-value",
        },
    },
)
_add(
    ["app/component", "app"],
    {
        "setContextData": {"operation": "context.provide", "keys": [0], "sources": [1]},
        "getContextData": {
            "operation": "context.lookup",
            "keys": [0],
            "sources": [1],
            "policy": "current-then-ancestors",
        },
        "getContextDataLike": {
            "operation": "context.prefix-lookup",
            "keys": [0],
            "sources": [1],
            "policy": "nearest-prefix-current-then-ancestors; stop-with-null-on-ambiguity; depth-argument-limits-contexts; nullish-depth-default-500; no-merged-ancestors",
        },
        "clearContextData": {"operation": "context.remove-request", "keys": [0]},
        "getOrSetContextData": {
            "operation": "context.lookup-or-provide",
            "keys": [0],
            "callbacks": [1],
            "policy": "current-then-ancestors",
        },
        "newScopedContext": {
            "operation": "context.create-scoped",
            "keys": [0],
            "callbacks": [1],
            "policy": "provide-current-no-disposal-guarantee",
        },
        "useContextOrNewScoped": {
            "operation": "context.reuse-or-create-scoped",
            "keys": [0],
            "callbacks": [1],
            "sources": [2],
            "policy": "current-then-ancestors",
        },
        "useContextFromParent": {
            "operation": "context.lookup",
            "keys": [0],
            "sources": [1],
            "policy": "current-then-ancestors-with-current-prefix-fallback",
        },
        "useContextFromParentOrNewScoped": {
            "operation": "context.lookup-or-create",
            "keys": [0],
            "callbacks": [1],
            "sources": [2],
            "policy": "current-then-ancestors-with-current-prefix-fallback",
        },
        "useGlobalContext": {
            "operation": "context.reuse-or-create-global",
            "keys": [0],
            "callbacks": [1],
            "policy": "global-store-no-disposal-guarantee",
        },
        "resolveChildren": {
            "operation": "children.normalize",
            "result": "accessor",
            "sources": [0],
        },
        "useView": {
            "operation": "view.create",
            "result": "view",
            "callbacks": [0],
            "policy": "replaceable-root-manual-dispose",
        },
        "useRootViewRenderer": {
            "operation": "view.capture-renderer",
            "result": "root-renderer",
            "policy": "captured-owner-manual-result-dispose",
        },
        "elemRef": {
            "operation": "dom.content-ref-create",
            "result": "accessor",
            "policy": "first-non-fst-content-element",
        },
        "elemRefFst": {
            "operation": "dom.wrapper-ref-create",
            "result": "accessor",
            "policy": "fst-wrapper-element",
        },
    },
)
_add(
    ["app/state", "app/state/state", "app"],
    {
        "newStateObj": {
            "operation": "model.proxy-create",
            "result": "model",
            "sources": [0, 1],
            "policy": "proxy-request",
        },
    },
)
_add(
    ["app/state", "app/state/state.list", "app"],
    {
        "List.new": {
            "operation": "list.raw-create",
            "result": "raw-list",
            "sources": [0],
            "policy": "raw-list-not-yet-reactive",
        },
        "List.from": {
            "operation": "list.derive",
            "result": "list",
            "callbacks": [0, 1],
            "sources": [0],
            "policy": "proxy-list-source-replacement",
        },
    },
)
_add(
    ["app/model"],
    {
        "Model.new": {
            "operation": "model.proxy-create",
            "result": "model",
            "sources": [0],
            "policy": "returns-proxy",
        },
        "createModel": {
            "operation": "model.raw-create",
            "result": "raw-model",
            "sources": [0],
            "policy": "raw-object-with-proxy-member",
        },
    },
)
_add(
    ["app/scope", "app/scope/itemScope"],
    {
        "useScopeSelectedBoundTo": {
            "operation": "selection.bind-one-way",
            "sources": [0, 1],
            "callbacks": [2],
            "policy": "requested-binding-not-synchronization-guarantee",
        },
        "useScopeSelectedBound": {
            "operation": "selection.bind-two-way",
            "sources": [0, 1],
            "callbacks": [2, 3],
            "policy": "requested-binding-not-synchronization-guarantee",
        },
    },
)
_add(
    ["app/load", "app"],
    {
        "onInit": {
            "operation": "initialization.register",
            "callbacks": [0],
            "policy": "effect-initialization-not-dom-mount",
        },
        "load": {
            "operation": "loader.create",
            "result": "loader",
            "callbacks": [0],
            "policy": "effect-started-loader",
        },
        "LoadGroup": {
            "operation": "load-group.create",
            "result": "load-group",
            "construct": True,
            "sources": [0, 2],
            "keys": [1],
            "borrowed": {"value": 0},
        },
        "LoadSequence": {
            "operation": "load-sequence.create",
            "result": "load-sequence",
            "construct": True,
            "sources": [0],
            "callbacks": [1],
        },
        "lazyListLoadGroup": {
            "operation": "load-group.lazy-list-create",
            "result": "lazy-load-group",
            "sources": [1],
            "keys": [0],
            "callbacks": [2],
            "backing": "load-group",
        },
        "useResetLoadGroupOnInit": {
            "operation": "load-group.reset-on-init",
            "sources": [0],
            "options": {"argument": 1, "literals": ["delay", "resetScope"]},
        },
    },
)
_add(
    ["app/fragment"],
    {
        "useFragment": {
            "operation": "fragment.normalize",
            "result": "fragment",
            "sources": [0, 1],
            "options": {"argument": 0, "callbacks": ["render"], "literals": ["class"]},
            "policy": "cached-until-explicit-rerender",
        }
    },
)
_add(
    ["app/props"],
    {
        "usePropValue": {
            "operation": "prop.normalize",
            "result": "prop-value",
            "sources": [0, 1],
            "policy": "hasValue-tests-original-input-presence",
        }
    },
)
_add(
    ["app/dom/hooks"],
    {
        "onEnter": {
            "operation": "dom.enter-register",
            "callbacks": [0],
            "policy": "dom-visibility-enter",
        },
        "onExit": {
            "operation": "dom.exit-register",
            "callbacks": [0],
            "policy": "dom-visibility-exit-not-component-post-render",
        },
    },
)
_add(
    ["app/dom/extendedDom"],
    {
        "onDomElemAdded": {
            "operation": "dom.added-register",
            "result": "removable",
            "options": {
                "argument": 0,
                "callbacks": ["callback", "match"],
                "sources": ["parent"],
                "literals": ["id"],
            },
            "policy": "manual-remove",
        },
        "findFstElem": {"operation": "dom.lookup", "sources": [0], "keys": [1]},
    },
)
_add(
    ["animation/Show"],
    {
        "withVisibility": {"operation": "visibility.provide", "result": "visibility"},
        "useVisibility": {
            "operation": "visibility.lookup",
            "result": "visibility",
            "policy": "context-lookup-runtime-provider-unknown",
        },
    },
)
_add(
    ["animation/Animate"],
    {
        "usePageAnimations": {
            "operation": "animation.context-reuse-or-create",
            "result": "animator",
        },
        "animationSpec": {
            "operation": "animation.specify",
            "sources": [0, 1],
            "callbacks": [2],
            "keys": [3],
        },
    },
)
_add(
    ["app/action"],
    {
        "action": {
            "operation": "action.create",
            "result": "action",
            "callbacks": [0],
            "policy": "status-not-permission-enforcement-arguments-array",
        },
        "confirmAction": {
            "operation": "action.confirmable-create",
            "result": "action",
            "options": {
                "argument": 0,
                "callbacks": ["request", "begin", "cancel", "confirm", "complete"],
                "literals": ["completeDelay"],
            },
            "policy": "confirmation-request-workflow",
        },
    },
)
_add(
    ["app/state", "app/state/confirmation", "app"],
    {
        "ConfirmationRequest": {
            "operation": "confirmation.create",
            "result": "confirmation",
            "construct": True,
        }
    },
)
_add(
    ["app/router"],
    {
        "defineRoutes": {
            "operation": "routes.define",
            "sources": [0],
            "policy": "authored-route-metadata-not-runtime-match",
        },
        "defineNavGroups": {"operation": "navigation.groups-define", "sources": [0]},
        "useRouting": {
            "operation": "routing.lookup",
            "result": "routing",
            "policy": "runtime-context-provider-unknown",
        },
        "useRouterState": {
            "operation": "routing.state-lookup",
            "result": "router-state",
            "policy": "location-state-value-not-accessor",
        },
        "useOnNavigate": {
            "operation": "navigation.observe",
            "callbacks": [0],
            "policy": "owner-cleanup-request",
        },
        "getCurrentNavEntry": {"operation": "navigation.entry-read", "sources": [0]},
        "updateRouterSideNavItemId": {
            "operation": "navigation.side-item-write-request",
            "sources": [0],
            "keys": [1],
        },
    },
)
_add(
    ["signalr", "signalr/onMessageHook"],
    {
        name: {
            "operation": f"subscription.{name}",
            "sources": [0],
            "callbacks": [1],
            "policy": "owner-cleanup-remove-request",
        }
        for name in (
            "onHubMessage",
            "onHubConnectionClosed",
            "onHubConnectionConnected",
            "onHubConnectionReconnected",
        )
    },
)
_add(
    ["signalr", "signalr/hub"],
    {
        "signalRHub": {
            "operation": "hub.create",
            "result": "hub",
            "options": {"argument": 0, "sources": ["url"]},
            "policy": "connection-request-not-connected-proof",
        }
    },
)
_add(
    ["signalr", "signalr/api"],
    {
        "signalRApi": {
            "operation": "transport.signalr-create",
            "result": "remote-api",
            "sources": [0],
            "options": {"argument": 1, "literals": ["apiPath"]},
        }
    },
)
_add(
    ["app/backendApi", "app"],
    {
        "backendApi": {
            "operation": "transport.backend-create",
            "result": "remote-api",
            "keys": [0],
            "policy": "external-service-target-unresolved",
        }
    },
)
_add(
    ["http/api"],
    {
        "httpApi": {
            "operation": "transport.http-create",
            "result": "remote-api",
            "sources": [0],
            "options": {"argument": 1, "sources": ["baseUrl", "authentication"]},
            "policy": "authored-endpoints-not-network-success",
        }
    },
)
_add(
    ["webview/interop"],
    {
        "invokeOnWebViewReady": {
            "operation": "webview.ready-register",
            "callbacks": [0],
            "policy": "immediate-or-queued-by-environment",
        }
    },
)
_add(
    ["async", "async/promise"],
    {
        "promise": {
            "operation": "deferred.create",
            "result": "deferred",
            "options": {"argument": 0, "callbacks": ["onResolve", "onReject"]},
            "policy": "custom-thenable-not-native-promise",
        },
        "resolvePromise": _rule("async.normalize", (), [0]),
    },
)
_add(
    ["async", "async/delay"],
    {
        "delay": {"operation": "async.delay-request", "keys": [0]},
        "delaySinceLast": {"operation": "async.elapsed-delay-request", "keys": [0], "sources": [1]},
    },
)
_add(
    ["http/retry"],
    {
        "invokeWithRetry": {
            "operation": "retry.invoke-request",
            "callbacks": [0],
            "options": {"argument": 1, "literals": ["maxRetries", "maxTotalMs", "initialDelayMs"]},
            "policy": "delay-budget-not-execution-deadline",
        }
    },
)
_add(
    ["collections/array"],
    {
        "forEachAsync": {
            "operation": "collection.concurrent-callbacks",
            "sources": [0],
            "callbacks": [1],
            "forwards": [0],
            "policy": "all-started-before-await",
        },
        "onArrayChange": {
            "operation": "collection.change-request",
            "sources": [0, 1, 2],
            "callbacks": [3],
            "forwards": [0, 1, 2],
            "policy": "boolean-and-reference-payload-not-guaranteed",
        },
    },
)
_add(
    ["cn", "cn/cnExtract"],
    {"cnExtract": {"operation": "classes.partition", "result": "classes-pair", "sources": [0, 1]}},
)
_add(
    ["cache/IndexDbCache"],
    {
        "IndexedDbCache": {
            "operation": "cache.create",
            "result": "cache",
            "construct": True,
            "options": {"argument": 0, "literals": ["dbName", "storeName", "version"]},
        },
        "getAndInitCacheDb": {
            "operation": "cache.reuse-or-create",
            "result": "cache",
            "keys": [0],
            "backing": "cache",
            "shared": "cache",
        },
        "initGlobalCache": {
            "operation": "cache.global-initialize",
            "result": "cache",
            "backing": "cache",
            "shared": "cache",
        },
        "getGlobalCache": {
            "operation": "cache.global-get-or-create",
            "result": "cache",
            "backing": "cache",
            "shared": "cache",
        },
    },
)
_add(
    ["session/sessionStorage"],
    {
        "getOrAddSessionValue": {
            "operation": "session.read-or-write",
            "keys": [0],
            "callbacks": [1],
        },
        "getSessionValue": {"operation": "session.read", "keys": [0]},
        "setSessionValue": {"operation": "session.write-request", "keys": [0], "sources": [1]},
        "clearSessionValues": {"operation": "session.clear-request"},
    },
)

# Method names acquire meaning only through a proven receiver handle.
HANDLE_METHODS = {
    "value": {
        "get": _rule("value.untracked-read"),
        "set": _rule("value.explicit-write-request", (), [0], forwards=[0]),
        "onChange": _rule(
            "value.pre-commit-observe",
            [0],
            result="self",
            policy="cleanup-request-not-unsubscribe-proof",
        ),
        "load": _rule("value.load-request", (), [0, 1]),
        "loaded": _rule("value.loaded-read"),
        "isLoaded": _rule("value.is-loaded-read"),
        "refreshOnChange": _rule("value.replace-derivation", [0], [0], result="self"),
    },
    "delayed-value": {
        "get": _rule("value.untracked-read"),
        "set": _rule("value.delayed-write-request", (), [0], forwards=[0]),
        "setNow": _rule("value.immediate-write-request", (), [0], forwards=[0]),
        "cancelChange": _rule("value.cancel-pending-request"),
        "onChange": _rule(
            "value.pre-commit-observe",
            [0],
            result="self",
            policy="cleanup-request-not-unsubscribe-proof",
        ),
        "load": _rule("value.load-request", (), [0, 1]),
        "loaded": _rule("value.loaded-read"),
        "isLoaded": _rule("value.is-loaded-read"),
    },
    "field": {
        "map": _rule("field.map-same-handle", [0], result="self"),
        "refreshOn": _rule("field.refresh-dependency", (), [0], result="self"),
        "update": _rule("field.merge-write-request", (), [0], forwards=[0]),
        "get": {"operation": "field.metadata-read", "keys": [0]},
        "set": {"operation": "field.metadata-write-request", "keys": [0], "sources": [1]},
        "with": {
            "operation": "field.metadata-assign-request",
            "keys": [0],
            "sources": [1],
            "result": "self",
        },
        "withAnimation": {
            "operation": "field.animation-metadata-assign-request",
            "sources": [0],
            "result": "self",
        },
        "onMountedEditor": {
            "operation": "field.editor-mounted-observe",
            "callbacks": [0],
            "result": "self",
        },
        "removeOnChange": _rule("field.remove-change-observer-request", [0], result="self"),
        "removeOnSet": _rule("field.remove-set-observer-request", [0], result="self"),
        "dispose": {
            "operation": "field.dispose-request",
            "policy": "guard-only-not-full-resource-release",
        },
        "onChange": {"operation": "field.pre-commit-observe", "callbacks": [0], "result": "self"},
        "onSet": {"operation": "field.post-commit-observe", "callbacks": [0], "result": "self"},
    },
    "form": {
        "field": {"operation": "form.field-access", "result": "field", "keys": [0]},
        "form": {
            "operation": "form.subform-prefix",
            "result": "subform",
            "keys": [0],
            "policy": "facade-not-new-owner",
        },
        "setFieldValue": {"operation": "form.field-write-request", "keys": [0], "sources": [1]},
        "onChange": {
            "operation": "form.member-observe",
            "keys": [0],
            "callbacks": [1],
            "policy": "deferred",
        },
        "onReady": _rule("form.ready-observe", [0]),
    },
    "subform": {
        "field": {"operation": "form.prefixed-field-access", "result": "field", "keys": [0]}
    },
    "state": {
        "onChange": {
            "operation": "state.member-observe",
            "keys": [0],
            "callbacks": [1],
            "policy": "initial-and-change",
        },
        "onReady": _rule("state.ready-observe", [0]),
        "init": _rule("state.configure", [0]),
    },
    "scope": {
        "onReady": _rule("scope.ready-observe", [0]),
        "init": _rule("scope.configure", [0]),
        "onSelectedChange": _rule("selection.selected-observe", [0]),
        "onActiveChange": _rule("selection.active-observe", [0]),
        "onClicked": _rule("selection.clicked-observe", [0]),
        "setSelected": _rule("selection.select-request", (), [0, 1]),
        "setActive": _rule("selection.activate-request", (), [0, 1]),
        "setClicked": _rule("selection.click-request", (), [0, 1]),
        "setHovered": _rule("selection.hover-request", (), [0]),
        "setAll": _rule("selection.items-replace-request", (), [0]),
        "setMarked": _rule(
            "selection.set-marked-request", (), [0], policy="implementation-writes-all-not-marked"
        ),
        "reset": _rule("selection.reset-request"),
    },
    "loader": {
        "then": _rule(
            "loader.completion-observe",
            [0],
            result="self",
            policy="callback-receives-loader-on-success-or-error",
        ),
        "isLoading": _rule("loader.loading-read", (), [0]),
        "isLoaded": _rule("loader.loaded-read", (), [0]),
        "isLoadingError": _rule("loader.error-status-read"),
        "isLoadingSuccess": _rule("loader.success-status-read"),
    },
    "load-group": {"complete": _rule("load-group.complete-request")},
    "lazy-load-group": {
        "complete": _rule("load-group.complete-request"),
        "resetOnInit": _rule("load-group.reset-on-init", (), [0], result="self"),
    },
    "load-sequence": {
        "load": _rule("load-sequence.invoke-request"),
        "reset": _rule("load-sequence.reset-request", (), [0]),
        "complete": _rule("load-sequence.complete-request"),
        "onCompleted": _rule("load-sequence.complete-observe", [0], result="self"),
    },
    "list": {
        "set": _rule("list.replace-request", (), [0]),
        "setAt": _rule("list.item-write-request", (), [0, 1]),
        "add": _rule("list.add-request", (), [0]),
        "push": _rule("list.push-request", (), [0]),
        "pop": _rule("list.pop-request"),
        "shift": _rule("list.shift-request"),
        "unshift": _rule("list.unshift-request", (), [0]),
        "splice": _rule("list.splice-request", (), [0, 1, 2]),
        "reverse": _rule("list.reverse-request"),
        "asArray": _rule("list.array-read"),
        "filter": _rule("list.filter", [0]),
        "map": _rule("list.map", [0]),
        "at": _rule("list.item-read", (), [0]),
    },
    "view": {
        "render": _rule(
            "view.render-replace-root",
            (),
            [0],
            forwards=[0],
            policy="props-input-previous-root-dispose-request",
        ),
        "dispose": _rule("view.dispose-request"),
    },
    "root-view": {
        "dispose": {"operation": "view.dispose-request", "policy": "manual-result-dispose"}
    },
    "prop-value": {
        "hasValue": {
            "operation": "prop.original-presence-read",
            "policy": "not-accessor-result-presence",
        }
    },
    "removable": {"remove": _rule("subscription.remove-request")},
    "disposable": {"dispose": _rule("resource.dispose-request")},
    "resize-observer": {
        "disconnect": _rule("resize.disconnect-request"),
        "unobserve": _rule("resize.unobserve-request", (), [0]),
        "observe": _rule("resize.observe-request", (), [0]),
    },
    "visibility": {
        "onChange": _rule("visibility.before-change-observe", [0], result="disposable"),
        "show": _rule("visibility.show-request", (), [0]),
        "toggle": _rule("visibility.toggle-request"),
    },
    "animator": {
        "animation": _rule("animation.define", (), [0]),
        "create": _rule("animation.create", [1], [0], result="animation-instance"),
        "controls": {"operation": "animation.controls-create", "result": "animation-controls"},
    },
    "animation-instance": {
        "dispose": _rule("animation.dispose-request"),
        "play": {"operation": "animation.instance-play-request", "keys": [0], "sources": [1]},
    },
    "animation-controls": {
        "play": {"operation": "animation.play-request", "keys": [0], "sources": [1]},
        "playEnter": _rule("animation.enter-request"),
        "playExit": _rule("animation.exit-request"),
        "attach": _rule("animation.attach", (), [0, 1]),
        "onPlay": _rule("animation.play-observe", [0]),
    },
    "action": {
        "enabledWhen": _rule(
            "action.enabled-status-observe", [0], result="self", policy="not-execution-permission"
        ),
        "isEnabled": _rule("action.enabled-status-read"),
        "isExecuting": _rule("action.executing-status-read"),
    },
    "scheduler": {
        "reset": {"operation": "action.cancel-scheduled-request", "keys": [0]},
        "isPending": {"operation": "action.pending-read", "keys": [0]},
    },
    "confirmation": {
        "activate": _rule("confirmation.activate-request", (), [0], result="self"),
        "response": {"operation": "confirmation.response-read", "result": "deferred"},
        "completion": {"operation": "confirmation.completion-read", "result": "deferred"},
        "confirm": _rule("confirmation.confirm-request", (), [0]),
        "cancel": _rule("confirmation.cancel-request", (), [0]),
        "complete": _rule("confirmation.complete-request", (), [0]),
        "reset": _rule("confirmation.reset-request"),
        "onCompletion": _rule(
            "confirmation.completion-observe",
            [0],
            result="self",
            policy="cleanup-request-not-correct-callback-removal-proof",
        ),
    },
    "routing": {
        "navigateTo": {"operation": "navigation.to-request", "keys": [0], "sources": [1]},
        "navigateBack": _rule("navigation.back-request", (), [0]),
        "navigateForward": _rule("navigation.forward-request"),
        "navigateBackTo": {"operation": "navigation.back-to-request", "keys": [0]},
        "onNavigate": _rule(
            "navigation.observe", [0], policy="manual-unsubscribe-may-return-undefined"
        ),
        "currentPath": _rule("navigation.current-path-read"),
        "matchRoute": _rule("navigation.match-request", (), [0]),
    },
    "hub": {
        "onMessage": {
            "operation": "hub.message-register",
            "options": {"argument": 0, "callbacks": ["callback"]},
            "policy": "manual-remove-may-return-undefined",
        },
        "onConnectionClosed": {
            "operation": "hub.closed-register",
            "options": {"argument": 0, "callbacks": ["callback"]},
        },
        "onConnectionConnected": {
            "operation": "hub.connected-register",
            "options": {"argument": 0, "callbacks": ["callback"]},
        },
        "onConnectionReconnected": {
            "operation": "hub.reconnected-register",
            "options": {"argument": 0, "callbacks": ["callback"]},
        },
        "connect": _rule("hub.connect-request"),
        "disconnect": _rule("hub.disconnect-request"),
        "sendMessage": _rule("hub.send-request", (), [0]),
        "makeApiInvocation": {"operation": "hub.api-request", "keys": [0, 1], "sources": [2]},
    },
    "deferred": {
        "resolve": _rule("deferred.resolve-request", (), [0]),
        "reject": _rule("deferred.reject-request", (), [0]),
        "reset": _rule("deferred.reset-request"),
        "done": _rule("deferred.done-read"),
        "then": _rule(
            "deferred.then-register", [0, 1], policy="custom-thenable-callback-result-discarded"
        ),
        "catch": _rule("deferred.catch-register", [0]),
        "finally": _rule("deferred.finally-register", [0]),
    },
    "cache": {
        "getUrlResource": {
            "operation": "cache.resource-get-or-fetch",
            "keys": [0, 1],
            "policy": "creates-object-url-no-auto-release-proof",
        },
        "removeUrlResource": {"operation": "cache.resource-remove-request", "keys": [0, 1]},
        "saveData": {"operation": "cache.data-save-request", "keys": [0, 2], "sources": [1]},
        "getData": {"operation": "cache.data-read", "keys": [0, 1]},
        "pruneOtherVersions": {"operation": "cache.prune-request", "keys": [0, 1]},
        "clearAll": _rule("cache.clear-request"),
        "deleteDatabase": _rule("cache.delete-request"),
    },
}

HANDLE_PARTS = {
    "toggle-pair": {"0": "accessor", "1": "cancel"},
    "field-text-pair": {"0": "nullable-field", "1": "nullable-untyped-value"},
    "classes-pair": {"0": "class-list", "1": "nullable-class-list"},
    "reorder": {"phase": "accessor", "cancel": "cancel"},
    "raw-model": {"$proxy": "proxy-result"},
    "proxy-result": {"instance": "model"},
    "load-group": {"value": "value", "completion": "deferred"},
    "lazy-load-group": {"value": "value", "completion": "deferred"},
    "load-sequence": {"completion": "deferred"},
    "root-view": {"dispose": "cancel", "view": "rendered-value"},
}
_HOVER_METHODS = {
    **HANDLE_METHODS["value"],
    "update": _rule("mouse.hover-update-request", (), [0, 1]),
    "setHover": _rule("mouse.hover-write-request", (), [0]),
}


def methods_for(kind: str):
    if kind == "hover-value":
        return _HOVER_METHODS
    return HANDLE_METHODS.get({"raw-list": "list", "item-scope": "scope"}.get(kind, kind), {})


def _shape_for(kind):
    value = {"kind": "value"}
    if kind in ("toggle-pair", "field-text-pair", "classes-pair"):
        return {"kind": "tuple", "items": [value, value]}
    if kind == "reorder":
        return {"kind": "object", "properties": {"phase": value, "cancel": value}}
    keys = [*methods_for(kind), *HANDLE_PARTS.get(kind, {})]
    return {"kind": "object", "properties": dict.fromkeys(keys, value)} if keys else value


RETURN_CONTRACTS = [
    {
        "id": f"fst-solid.{kind}{'-construct' if invocation == 'construct' else ''}{f'-{index}' if index else ''}",
        "origins": entries[index : index + 16],
        "result": _shape_for(kind),
        **({"invocation": invocation} if invocation == "construct" else {}),
    }
    for (kind, invocation), entries in _ORIGINS.items()
    for index in range(0, len(entries), 16)
]


def core_rule(module, name):
    return _CATALOGUE.get((module, name))


_FAMILY_IMPORTS = {
    "app/component": ("component", "componentWithChildren", "onComponentCleanup"),
    "app/state": ("State", "onChange", "onChangeDelayed", "resolveChildrenOnChange"),
    "app/state/onChange": ("onChange", "onChangeDelayed", "resolveChildrenOnChange"),
    "app/form": ("Form", "FormField"),
    "app/scope": ("Scope", "ItemScope"),
    "app/field": ("field", "Field"),
    "app/fieldBinding": ("InputField", "useFieldBinding"),
    "app": (
        "component",
        "componentWithChildren",
        "onComponentCleanup",
        "State",
        "onChange",
        "onChangeDelayed",
        "resolveChildrenOnChange",
        "field",
        "Field",
        "InputField",
        "useFieldBinding",
    ),
    "solid-js": ("onCleanup", "onMount"),
}
for _path, _names in _FAMILY_IMPORTS.items():
    _PUBLIC_NAMES.setdefault(f"{ROOT}/{_path}", set()).update(_names)


def canonical_api(module, name):
    return name if name in _PUBLIC_NAMES.get(module, ()) else None
