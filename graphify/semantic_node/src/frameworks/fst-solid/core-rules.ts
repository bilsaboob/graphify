import type { ReturnContract, ReturnShape } from '#typescript';

export interface CoreRule {
  readonly operation: string;
  readonly result?: string;
  readonly callbacks?: readonly number[];
  readonly sources?: readonly number[];
  readonly keys?: readonly number[];
  readonly options?: { readonly argument: number; readonly callbacks?: readonly string[]; readonly sources?: readonly string[]; readonly literals?: readonly string[] };
  readonly policy?: string;
  readonly construct?: boolean;
  /** Arguments delivered as data to user callbacks, not merely observed locally. */
  readonly forwards?: readonly number[];
  readonly backing?: string;
  readonly shared?: string;
  readonly borrowed?: Readonly<Record<string, number>>;
}

const root = '@fst/components-fst-solid';
const catalogue = new Map<string, CoreRule>();
const publicNames = new Map<string, Set<string>>();
const origins = new Map<string, { module: string; name: string }[]>();
function add(paths: readonly string[], entries: Readonly<Record<string, CoreRule>>) {
  for (const path of paths) for (const [name, rule] of Object.entries(entries)) {
    const module = `${root}/${path}`;
    catalogue.set(`${module}\0${name}`, Object.freeze(rule));
    const names = publicNames.get(module) ?? new Set<string>();
    names.add(name.split('.')[0]!); publicNames.set(module, names);
    if (rule.result && !name.includes('.')) {
      const key = `${rule.result}:${rule.construct ? 'construct' : 'call'}`;
      const list = origins.get(key) ?? [];
      list.push({ module, name }); origins.set(key, list);
    }
  }
}
const rule = (operation: string, callbacks: readonly number[] = [], sources: readonly number[] = []): CoreRule => ({ operation, callbacks, sources });

add(['hooks/value'], {
  value: { operation: 'value.create', result: 'value', sources: [0, 1] },
  switchValue: { operation: 'value.switch-create', result: 'accessor', sources: [0], callbacks: [0], policy: 'read-only-accessor-case-results-invoked-during-setup' },
  lazyValueList: { operation: 'list.lazy-create', result: 'value', callbacks: [0], sources: [0], policy: 'explicit-load' },
});
add(['hooks/delayed'], {
  delayedValue: { operation: 'value.delayed-create', result: 'delayed-value', sources: [1, 2], keys: [0] },
  delayedToggle: { operation: 'toggle.delayed-create', result: 'toggle-pair', sources: [1, 2], keys: [0] },
  delayedAction: { operation: 'action.scheduler-create', result: 'scheduler', options: { argument: 0, literals: ['multiple'] } },
});
add(['hooks/timer'], {
  useTimeout: { operation: 'timer.timeout-register', result: 'cancel', callbacks: [0], keys: [1], policy: 'owner-cleanup-and-returned-clear-no-unregister' },
  useInterval: { operation: 'timer.interval-register', result: 'cancel', callbacks: [0], keys: [1], policy: 'owner-cleanup-and-returned-clear-no-unregister' },
});
for (const [path, name, target] of [['hooks/documentEvent', 'onDocumentEvent', 'document'], ['hooks/windowEvent', 'useWindowEvent', 'window']] as const) {
  add([path], { [name]: { operation: `event.${target}-register`, keys: [0], callbacks: [1], sources: [2], policy: 'cleanup-request-without-capture-options' } });
}
add(['hooks/windowSize'], { useWindowSize: { operation: 'window.size-observe', result: 'accessor', policy: 'owner-cleanup-request' } });
add(['hooks/mouse'], {
  useMouseHover: { operation: 'mouse.hover-observe', result: 'hover-value', sources: [0], options: { argument: 1, callbacks: ['callback', 'isInside'], literals: ['checkVisible'] }, policy: 'owner-cleanup-request' },
  onMouseClickOutside: { operation: 'mouse.outside-click-register', result: 'removable', callbacks: [1], sources: [0], policy: 'owner-cleanup-and-manual-remove-request' },
});
add(['hooks/resize'], {
  onResize: { operation: 'resize.observe', result: 'resize-observer', sources: [0], callbacks: [1], policy: 'manual-disconnect' },
  observeHeightChange: { operation: 'height.observe', result: 'disposable', sources: [0], callbacks: [1], policy: 'manual-dispose' },
});
add(['hooks/reorder'], {
  createReorderInteraction: { operation: 'reorder.create', result: 'reorder', options: { argument: 0, callbacks: ['start'], sources: ['element', 'disabled', 'invalidation'], literals: ['threshold'] }, policy: 'requires-owner-cleanup-request' },
});
add(['app/field', 'app'], {
  field: { operation: 'field.create-contract', result: 'field', sources: [0], options: { argument: 1, literals: ['bindInitialValue', 'name'] } },
  resolveTextFieldOrText: { operation: 'field.resolve-conditional-pair', result: 'field-text-pair', sources: [0], policy: 'nullable-field-or-untyped-value' },
});
add(['app/component', 'app'], {
  setContextData: { operation: 'context.provide', keys: [0], sources: [1] },
  getContextData: { operation: 'context.lookup', keys: [0], sources: [1], policy: 'current-then-ancestors' },
  getContextDataLike: { operation: 'context.prefix-lookup', keys: [0], sources: [1], policy: 'nearest-prefix-current-then-ancestors; stop-with-null-on-ambiguity; depth-argument-limits-contexts; nullish-depth-default-500; no-merged-ancestors' },
  clearContextData: { operation: 'context.remove-request', keys: [0] },
  getOrSetContextData: { operation: 'context.lookup-or-provide', keys: [0], callbacks: [1], policy: 'current-then-ancestors' },
  newScopedContext: { operation: 'context.create-scoped', keys: [0], callbacks: [1], policy: 'provide-current-no-disposal-guarantee' },
  useContextOrNewScoped: { operation: 'context.reuse-or-create-scoped', keys: [0], callbacks: [1], sources: [2], policy: 'current-then-ancestors' },
  useContextFromParent: { operation: 'context.lookup', keys: [0], sources: [1], policy: 'current-then-ancestors-with-current-prefix-fallback' },
  useContextFromParentOrNewScoped: { operation: 'context.lookup-or-create', keys: [0], callbacks: [1], sources: [2], policy: 'current-then-ancestors-with-current-prefix-fallback' },
  useGlobalContext: { operation: 'context.reuse-or-create-global', keys: [0], callbacks: [1], policy: 'global-store-no-disposal-guarantee' },
  resolveChildren: { operation: 'children.normalize', result: 'accessor', sources: [0] },
  useView: { operation: 'view.create', result: 'view', callbacks: [0], policy: 'replaceable-root-manual-dispose' },
  useRootViewRenderer: { operation: 'view.capture-renderer', result: 'root-renderer', policy: 'captured-owner-manual-result-dispose' },
  elemRef: { operation: 'dom.content-ref-create', result: 'accessor', policy: 'first-non-fst-content-element' },
  elemRefFst: { operation: 'dom.wrapper-ref-create', result: 'accessor', policy: 'fst-wrapper-element' },
});
add(['app/state', 'app/state/state', 'app'], {
  newStateObj: { operation: 'model.proxy-create', result: 'model', sources: [0, 1], policy: 'proxy-request' },
});
add(['app/state', 'app/state/state.list', 'app'], {
  'List.new': { operation: 'list.raw-create', result: 'raw-list', sources: [0], policy: 'raw-list-not-yet-reactive' },
  'List.from': { operation: 'list.derive', result: 'list', callbacks: [0, 1], sources: [0], policy: 'proxy-list-source-replacement' },
});
add(['app/model'], {
  'Model.new': { operation: 'model.proxy-create', result: 'model', sources: [0], policy: 'returns-proxy' },
  createModel: { operation: 'model.raw-create', result: 'raw-model', sources: [0], policy: 'raw-object-with-proxy-member' },
});
add(['app/scope', 'app/scope/itemScope'], {
  useScopeSelectedBoundTo: { operation: 'selection.bind-one-way', sources: [0, 1], callbacks: [2], policy: 'requested-binding-not-synchronization-guarantee' },
  useScopeSelectedBound: { operation: 'selection.bind-two-way', sources: [0, 1], callbacks: [2, 3], policy: 'requested-binding-not-synchronization-guarantee' },
});
add(['app/load', 'app'], {
  onInit: { operation: 'initialization.register', callbacks: [0], policy: 'effect-initialization-not-dom-mount' },
  load: { operation: 'loader.create', result: 'loader', callbacks: [0], policy: 'effect-started-loader' },
  LoadGroup: { operation: 'load-group.create', result: 'load-group', construct: true, sources: [0, 2], keys: [1], borrowed: { value: 0 } },
  LoadSequence: { operation: 'load-sequence.create', result: 'load-sequence', construct: true, sources: [0], callbacks: [1] },
  lazyListLoadGroup: { operation: 'load-group.lazy-list-create', result: 'lazy-load-group', sources: [1], keys: [0], callbacks: [2], backing: 'load-group' },
  useResetLoadGroupOnInit: { operation: 'load-group.reset-on-init', sources: [0], options: { argument: 1, literals: ['delay', 'resetScope'] } },
});
add(['app/fragment'], { useFragment: { operation: 'fragment.normalize', result: 'fragment', sources: [0, 1], options: { argument: 0, callbacks: ['render'], literals: ['class'] }, policy: 'cached-until-explicit-rerender' } });
add(['app/props'], { usePropValue: { operation: 'prop.normalize', result: 'prop-value', sources: [0, 1], policy: 'hasValue-tests-original-input-presence' } });
add(['app/dom/hooks'], {
  onEnter: { operation: 'dom.enter-register', callbacks: [0], policy: 'dom-visibility-enter' },
  onExit: { operation: 'dom.exit-register', callbacks: [0], policy: 'dom-visibility-exit-not-component-post-render' },
});
add(['app/dom/extendedDom'], {
  onDomElemAdded: { operation: 'dom.added-register', result: 'removable', options: { argument: 0, callbacks: ['callback', 'match'], sources: ['parent'], literals: ['id'] }, policy: 'manual-remove' },
  findFstElem: { operation: 'dom.lookup', sources: [0], keys: [1] },
});
add(['animation/Show'], {
  withVisibility: { operation: 'visibility.provide', result: 'visibility' },
  useVisibility: { operation: 'visibility.lookup', result: 'visibility', policy: 'context-lookup-runtime-provider-unknown' },
});
add(['animation/Animate'], {
  usePageAnimations: { operation: 'animation.context-reuse-or-create', result: 'animator' },
  animationSpec: { operation: 'animation.specify', sources: [0, 1], callbacks: [2], keys: [3] },
});
add(['app/action'], {
  action: { operation: 'action.create', result: 'action', callbacks: [0], policy: 'status-not-permission-enforcement-arguments-array' },
  confirmAction: { operation: 'action.confirmable-create', result: 'action', options: { argument: 0, callbacks: ['request', 'begin', 'cancel', 'confirm', 'complete'], literals: ['completeDelay'] }, policy: 'confirmation-request-workflow' },
});
add(['app/state', 'app/state/confirmation', 'app'], { ConfirmationRequest: { operation: 'confirmation.create', result: 'confirmation', construct: true } });
add(['app/router'], {
  defineRoutes: { operation: 'routes.define', sources: [0], policy: 'authored-route-metadata-not-runtime-match' },
  defineNavGroups: { operation: 'navigation.groups-define', sources: [0] },
  useRouting: { operation: 'routing.lookup', result: 'routing', policy: 'runtime-context-provider-unknown' },
  useRouterState: { operation: 'routing.state-lookup', result: 'router-state', policy: 'location-state-value-not-accessor' },
  useOnNavigate: { operation: 'navigation.observe', callbacks: [0], policy: 'owner-cleanup-request' },
  getCurrentNavEntry: { operation: 'navigation.entry-read', sources: [0] },
  updateRouterSideNavItemId: { operation: 'navigation.side-item-write-request', sources: [0], keys: [1] },
});
add(['signalr', 'signalr/onMessageHook'], Object.fromEntries(['onHubMessage', 'onHubConnectionClosed', 'onHubConnectionConnected', 'onHubConnectionReconnected'].map((name) => [name, {
  operation: `subscription.${name}`, sources: [0], callbacks: [1], policy: 'owner-cleanup-remove-request',
}])));
add(['signalr', 'signalr/hub'], { signalRHub: { operation: 'hub.create', result: 'hub', options: { argument: 0, sources: ['url'] }, policy: 'connection-request-not-connected-proof' } });
add(['signalr', 'signalr/api'], { signalRApi: { operation: 'transport.signalr-create', result: 'remote-api', sources: [0], options: { argument: 1, literals: ['apiPath'] } } });
add(['app/backendApi', 'app'], { backendApi: { operation: 'transport.backend-create', result: 'remote-api', keys: [0], policy: 'external-service-target-unresolved' } });
add(['http/api'], { httpApi: { operation: 'transport.http-create', result: 'remote-api', sources: [0], options: { argument: 1, sources: ['baseUrl', 'authentication'] }, policy: 'authored-endpoints-not-network-success' } });
add(['webview/interop'], { invokeOnWebViewReady: { operation: 'webview.ready-register', callbacks: [0], policy: 'immediate-or-queued-by-environment' } });
add(['async', 'async/promise'], {
  promise: { operation: 'deferred.create', result: 'deferred', options: { argument: 0, callbacks: ['onResolve', 'onReject'] }, policy: 'custom-thenable-not-native-promise' },
  resolvePromise: rule('async.normalize', [], [0]),
});
add(['async', 'async/delay'], { delay: { operation: 'async.delay-request', keys: [0] }, delaySinceLast: { operation: 'async.elapsed-delay-request', keys: [0], sources: [1] } });
add(['http/retry'], { invokeWithRetry: { operation: 'retry.invoke-request', callbacks: [0], options: { argument: 1, literals: ['maxRetries', 'maxTotalMs', 'initialDelayMs'] }, policy: 'delay-budget-not-execution-deadline' } });
add(['collections/array'], { forEachAsync: { operation: 'collection.concurrent-callbacks', sources: [0], callbacks: [1], forwards: [0], policy: 'all-started-before-await' }, onArrayChange: { operation: 'collection.change-request', sources: [0, 1, 2], callbacks: [3], forwards: [0, 1, 2], policy: 'boolean-and-reference-payload-not-guaranteed' } });
add(['cn', 'cn/cnExtract'], { cnExtract: { operation: 'classes.partition', result: 'classes-pair', sources: [0, 1] } });
add(['cache/IndexDbCache'], {
  IndexedDbCache: { operation: 'cache.create', result: 'cache', construct: true, options: { argument: 0, literals: ['dbName', 'storeName', 'version'] } },
  getAndInitCacheDb: { operation: 'cache.reuse-or-create', result: 'cache', keys: [0], backing: 'cache', shared: 'cache' },
  initGlobalCache: { operation: 'cache.global-initialize', result: 'cache', backing: 'cache', shared: 'cache' },
  getGlobalCache: { operation: 'cache.global-get-or-create', result: 'cache', backing: 'cache', shared: 'cache' },
});
add(['session/sessionStorage'], {
  getOrAddSessionValue: { operation: 'session.read-or-write', keys: [0], callbacks: [1] },
  getSessionValue: { operation: 'session.read', keys: [0] },
  setSessionValue: { operation: 'session.write-request', keys: [0], sources: [1] },
  clearSessionValues: { operation: 'session.clear-request' },
});

/** Method policies are qualified by a proven handle, never by a method name alone. */
export const handleMethods: Readonly<Record<string, Readonly<Record<string, CoreRule>>>> = {
  value: {
    get: rule('value.untracked-read'), set: { ...rule('value.explicit-write-request', [], [0]), forwards: [0] },
    onChange: { ...rule('value.pre-commit-observe', [0]), result: 'self', policy: 'cleanup-request-not-unsubscribe-proof' },
    load: rule('value.load-request', [], [0, 1]), loaded: rule('value.loaded-read'), isLoaded: rule('value.is-loaded-read'),
    refreshOnChange: { ...rule('value.replace-derivation', [0], [0]), result: 'self' },
  },
  'delayed-value': {
    get: rule('value.untracked-read'), set: { ...rule('value.delayed-write-request', [], [0]), forwards: [0] }, setNow: { ...rule('value.immediate-write-request', [], [0]), forwards: [0] },
    cancelChange: rule('value.cancel-pending-request'), onChange: { ...rule('value.pre-commit-observe', [0]), result: 'self', policy: 'cleanup-request-not-unsubscribe-proof' },
    load: rule('value.load-request', [], [0, 1]), loaded: rule('value.loaded-read'), isLoaded: rule('value.is-loaded-read'),
  },
  field: {
    map: { ...rule('field.map-same-handle', [0]), result: 'self' }, refreshOn: { ...rule('field.refresh-dependency', [], [0]), result: 'self' }, update: { ...rule('field.merge-write-request', [], [0]), forwards: [0] },
    get: { operation: 'field.metadata-read', keys: [0] }, set: { operation: 'field.metadata-write-request', keys: [0], sources: [1] },
    with: { operation: 'field.metadata-assign-request', keys: [0], sources: [1], result: 'self' },
    withAnimation: { operation: 'field.animation-metadata-assign-request', sources: [0], result: 'self' },
    onMountedEditor: { operation: 'field.editor-mounted-observe', callbacks: [0], result: 'self' },
    removeOnChange: { ...rule('field.remove-change-observer-request', [0]), result: 'self' }, removeOnSet: { ...rule('field.remove-set-observer-request', [0]), result: 'self' },
    dispose: { operation: 'field.dispose-request', policy: 'guard-only-not-full-resource-release' },
    onChange: { operation: 'field.pre-commit-observe', callbacks: [0], result: 'self' }, onSet: { operation: 'field.post-commit-observe', callbacks: [0], result: 'self' },
  },
  form: {
    field: { operation: 'form.field-access', result: 'field', keys: [0] }, form: { operation: 'form.subform-prefix', result: 'subform', keys: [0], policy: 'facade-not-new-owner' },
    setFieldValue: { operation: 'form.field-write-request', keys: [0], sources: [1] }, onChange: { operation: 'form.member-observe', keys: [0], callbacks: [1], policy: 'deferred' },
    onReady: rule('form.ready-observe', [0]),
  },
  subform: { field: { operation: 'form.prefixed-field-access', result: 'field', keys: [0] } },
  state: { onChange: { operation: 'state.member-observe', keys: [0], callbacks: [1], policy: 'initial-and-change' }, onReady: rule('state.ready-observe', [0]), init: rule('state.configure', [0]) },
  scope: {
    onReady: rule('scope.ready-observe', [0]), init: rule('scope.configure', [0]),
    onSelectedChange: rule('selection.selected-observe', [0]), onActiveChange: rule('selection.active-observe', [0]), onClicked: rule('selection.clicked-observe', [0]),
    setSelected: rule('selection.select-request', [], [0, 1]), setActive: rule('selection.activate-request', [], [0, 1]), setClicked: rule('selection.click-request', [], [0, 1]),
    setHovered: rule('selection.hover-request', [], [0]), setAll: rule('selection.items-replace-request', [], [0]),
    setMarked: { ...rule('selection.set-marked-request', [], [0]), policy: 'implementation-writes-all-not-marked' }, reset: rule('selection.reset-request'),
  },
  loader: { then: { ...rule('loader.completion-observe', [0]), result: 'self', policy: 'callback-receives-loader-on-success-or-error' }, isLoading: rule('loader.loading-read', [], [0]), isLoaded: rule('loader.loaded-read', [], [0]), isLoadingError: rule('loader.error-status-read'), isLoadingSuccess: rule('loader.success-status-read') },
  'load-group': { complete: rule('load-group.complete-request') },
  'lazy-load-group': { complete: rule('load-group.complete-request'), resetOnInit: { ...rule('load-group.reset-on-init', [], [0]), result: 'self' } },
  'load-sequence': { load: rule('load-sequence.invoke-request'), reset: rule('load-sequence.reset-request', [], [0]), complete: rule('load-sequence.complete-request'), onCompleted: { ...rule('load-sequence.complete-observe', [0]), result: 'self' } },
  list: { set: rule('list.replace-request', [], [0]), setAt: rule('list.item-write-request', [], [0, 1]), add: rule('list.add-request', [], [0]), push: rule('list.push-request', [], [0]), pop: rule('list.pop-request'), shift: rule('list.shift-request'), unshift: rule('list.unshift-request', [], [0]), splice: rule('list.splice-request', [], [0, 1, 2]), reverse: rule('list.reverse-request'), asArray: rule('list.array-read'), filter: rule('list.filter', [0]), map: rule('list.map', [0]), at: rule('list.item-read', [], [0]) },
  view: { render: { ...rule('view.render-replace-root', [], [0]), forwards: [0], policy: 'props-input-previous-root-dispose-request' }, dispose: rule('view.dispose-request') },
  'root-view': { dispose: { operation: 'view.dispose-request', policy: 'manual-result-dispose' } },
  'prop-value': { hasValue: { operation: 'prop.original-presence-read', policy: 'not-accessor-result-presence' } },
  removable: { remove: rule('subscription.remove-request') }, disposable: { dispose: rule('resource.dispose-request') },
  'resize-observer': { disconnect: rule('resize.disconnect-request'), unobserve: rule('resize.unobserve-request', [], [0]), observe: rule('resize.observe-request', [], [0]) },
  visibility: { onChange: { ...rule('visibility.before-change-observe', [0]), result: 'disposable' }, show: rule('visibility.show-request', [], [0]), toggle: rule('visibility.toggle-request') },
  animator: { animation: rule('animation.define', [], [0]), create: { ...rule('animation.create', [1], [0]), result: 'animation-instance' }, controls: { operation: 'animation.controls-create', result: 'animation-controls' } },
  'animation-instance': { dispose: rule('animation.dispose-request'), play: { operation: 'animation.instance-play-request', keys: [0], sources: [1] } },
  'animation-controls': { play: { operation: 'animation.play-request', keys: [0], sources: [1] }, playEnter: rule('animation.enter-request'), playExit: rule('animation.exit-request'), attach: rule('animation.attach', [], [0, 1]), onPlay: rule('animation.play-observe', [0]) },
  action: { enabledWhen: { ...rule('action.enabled-status-observe', [0]), result: 'self', policy: 'not-execution-permission' }, isEnabled: rule('action.enabled-status-read'), isExecuting: rule('action.executing-status-read') },
  scheduler: { reset: { operation: 'action.cancel-scheduled-request', keys: [0] }, isPending: { operation: 'action.pending-read', keys: [0] } },
  confirmation: { activate: { ...rule('confirmation.activate-request', [], [0]), result: 'self' }, response: { operation: 'confirmation.response-read', result: 'deferred' }, completion: { operation: 'confirmation.completion-read', result: 'deferred' }, confirm: rule('confirmation.confirm-request', [], [0]), cancel: rule('confirmation.cancel-request', [], [0]), complete: rule('confirmation.complete-request', [], [0]), reset: rule('confirmation.reset-request'), onCompletion: { ...rule('confirmation.completion-observe', [0]), result: 'self', policy: 'cleanup-request-not-correct-callback-removal-proof' } },
  routing: { navigateTo: { operation: 'navigation.to-request', keys: [0], sources: [1] }, navigateBack: rule('navigation.back-request', [], [0]), navigateForward: rule('navigation.forward-request'), navigateBackTo: { operation: 'navigation.back-to-request', keys: [0] }, onNavigate: { ...rule('navigation.observe', [0]), policy: 'manual-unsubscribe-may-return-undefined' }, currentPath: rule('navigation.current-path-read'), matchRoute: rule('navigation.match-request', [], [0]) },
  hub: { onMessage: { operation: 'hub.message-register', options: { argument: 0, callbacks: ['callback'] }, policy: 'manual-remove-may-return-undefined' }, onConnectionClosed: { operation: 'hub.closed-register', options: { argument: 0, callbacks: ['callback'] } }, onConnectionConnected: { operation: 'hub.connected-register', options: { argument: 0, callbacks: ['callback'] } }, onConnectionReconnected: { operation: 'hub.reconnected-register', options: { argument: 0, callbacks: ['callback'] } }, connect: rule('hub.connect-request'), disconnect: rule('hub.disconnect-request'), sendMessage: rule('hub.send-request', [], [0]), makeApiInvocation: { operation: 'hub.api-request', keys: [0, 1], sources: [2] } },
  deferred: { resolve: rule('deferred.resolve-request', [], [0]), reject: rule('deferred.reject-request', [], [0]), reset: rule('deferred.reset-request'), done: rule('deferred.done-read'), then: { ...rule('deferred.then-register', [0, 1]), policy: 'custom-thenable-callback-result-discarded' }, catch: rule('deferred.catch-register', [0]), finally: rule('deferred.finally-register', [0]) },
  cache: { getUrlResource: { operation: 'cache.resource-get-or-fetch', keys: [0, 1], policy: 'creates-object-url-no-auto-release-proof' }, removeUrlResource: { operation: 'cache.resource-remove-request', keys: [0, 1] }, saveData: { operation: 'cache.data-save-request', keys: [0, 2], sources: [1] }, getData: { operation: 'cache.data-read', keys: [0, 1] }, pruneOtherVersions: { operation: 'cache.prune-request', keys: [0, 1] }, clearAll: rule('cache.clear-request'), deleteDatabase: rule('cache.delete-request') },
};

const value: ReturnShape = Object.freeze({ kind: 'value' });
export const handleParts: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'toggle-pair': { '0': 'accessor', '1': 'cancel' },
  'field-text-pair': { '0': 'nullable-field', '1': 'nullable-untyped-value' },
  'classes-pair': { '0': 'class-list', '1': 'nullable-class-list' },
  reorder: { phase: 'accessor', cancel: 'cancel' },
  'raw-model': { $proxy: 'proxy-result' },
  'proxy-result': { instance: 'model' },
  'load-group': { value: 'value', completion: 'deferred' },
  'lazy-load-group': { value: 'value', completion: 'deferred' },
  'load-sequence': { completion: 'deferred' },
  'root-view': { dispose: 'cancel', view: 'rendered-value' },
};
export function methodsFor(kind: string): Readonly<Record<string, CoreRule>> | undefined {
  if (kind === 'raw-list') return handleMethods.list;
  if (kind === 'item-scope') return handleMethods.scope;
  if (kind === 'hover-value') return { ...handleMethods.value, update: rule('mouse.hover-update-request', [], [0, 1]), setHover: rule('mouse.hover-write-request', [], [0]) };
  return Object.hasOwn(handleMethods, kind) ? handleMethods[kind] : undefined;
}
const shapeFor = (kind: string): ReturnShape => {
  if (['toggle-pair', 'field-text-pair', 'classes-pair'].includes(kind)) return { kind: 'tuple', items: [value, value] };
  if (kind === 'reorder') return { kind: 'object', properties: { phase: value, cancel: value } };
  const keys = [...Object.keys(methodsFor(kind) ?? {}), ...Object.keys(handleParts[kind] ?? {})];
  return keys.length ? { kind: 'object', properties: Object.fromEntries(keys.map((key) => [key, value])) } : value;
};
/** Only reviewed successful-return shapes; nullable tuple slots remain opaque values. */
export const fstReturnContracts: readonly ReturnContract[] = Object.freeze([...origins].flatMap(([key, entries]) => {
  const [kind, invocation] = key.split(':') as [string, 'call' | 'construct'];
  const result: ReturnContract[] = [];
  for (let index = 0; index < entries.length; index += 16) result.push(Object.freeze({ id: `fst-solid.${kind}${invocation === 'construct' ? '-construct' : ''}${index ? `-${index}` : ''}`, origins: Object.freeze(entries.slice(index, index + 16)), result: shapeFor(kind), ...(invocation === 'construct' ? { invocation } : {}) }));
  return result;
}));
export function coreRule(module: string, name: string): CoreRule | undefined { return catalogue.get(`${module}\0${name}`); }
export function coreImport(module: string, name: string): boolean {
  return publicNames.get(module)?.has(name) ?? false;
}
