import type { ReturnContract, ReturnShape } from '#typescript';
import type { SolidRole } from './vocabulary.js';

const value: ReturnShape = Object.freeze({ kind: 'value' });
const pair: ReturnShape = Object.freeze({ kind: 'tuple', items: Object.freeze([value, value]) });
const object = (properties: Record<string, ReturnShape>): ReturnShape => ({ kind: 'object', properties });
const record: ReturnShape = { kind: 'record', value };
const root = ['solid-js', '@fst/components-fst-solid/solid-js'];
const store = ['solid-js/store', '@fst/components-fst-solid/solid-js/store'];
const web = ['solid-js/web'], wrappedWeb = [...web, '@fst/components-fst-solid/solid-js/web'];
const router = ['@solidjs/router'];

export interface CallbackRule {
  readonly index: number;
  readonly role: string;
  readonly parameters?: readonly string[];
  readonly reads?: 'tracked' | 'untracked' | 'batch';
  readonly returns?: string;
  readonly arity?: 'positive' | 'index-accessor';
}
export interface SolidApiRule {
  readonly name: string;
  readonly modules: readonly string[];
  readonly result?: ReturnShape;
  readonly slots?: Readonly<Record<string, SolidRole>>;
  readonly callbacks?: readonly CallbackRule[];
  readonly sources?: readonly number[];
  readonly boundary?: string;
  readonly jsx?: boolean;
  readonly identityObservations?: ReturnContract['identityObservations'];
}
const accumulator = 'return is next accumulator, not cleanup';
const callback = (index: number, role: string, parameters: readonly string[] = [], reads?: CallbackRule['reads'], returns?: string): CallbackRule => ({ index, role, parameters, ...(reads ? { reads } : {}), ...(returns ? { returns } : {}) });
const accessor = { '': 'solid.accessor' } as const;
const rule = (name: string, modules: readonly string[], rest: Omit<SolidApiRule, 'name' | 'modules'> = {}): SolidApiRule => ({ name, modules, ...rest });
const freeze = <T>(input: T): T => {
  if (input && typeof input === 'object' && !Object.isFrozen(input)) { for (const item of Object.values(input)) freeze(item); Object.freeze(input); }
  return input;
};

/** Reviewed 1.9.x source exports; router entries are separately qualified 0.15.4 APIs. */
export const solidApiRules: readonly SolidApiRule[] = freeze([
  rule('createSignal', root, { result: pair, slots: { '': 'solid.signal-pair', '0': 'solid.signal-accessor', '1': 'solid.signal-setter' } }),
  rule('createStore', store, { result: pair, slots: { '': 'solid.store-pair', '0': 'solid.store', '1': 'solid.store-updater' } }),
  rule('splitProps', root, { result: { kind: 'key-partitions', sourceArgument: 0, keysFromArgument: 1 } }),
  rule('createMemo', root, { result: value, slots: accessor, callbacks: [callback(0, 'memo derivation', ['previous result'], 'tracked', accumulator)] }),
  rule('createSelector', root, { result: value, slots: { '': 'solid.selector' }, callbacks: [callback(0, 'selector source', [], 'tracked'), callback(1, 'selector equality', ['key', 'source value'])] }),
  rule('createDeferred', root, { result: value, slots: accessor, sources: [0], boundary: 'deferred accessor; no inferred scheduler order' }),
  rule('createReaction', root, { result: value, slots: { '': 'solid.reaction' }, callbacks: [callback(0, 'reaction invalidation', [], 'untracked')] }),
  ...['createEffect', 'createComputed', 'createRenderEffect'].map((name) => rule(name, root, { callbacks: [callback(0, `${name} callback`, ['previous accumulator'], 'tracked', accumulator)] })),
  rule('on', root, { result: value, slots: { '': 'solid.on-callback' }, boundary: 'explicit dependency accessors; callback receives values and is untracked' }),
  rule('untrack', root, { callbacks: [callback(0, 'untracked synchronous body', [], 'untracked')], boundary: 'tracking suppressed; ownership not removed' }),
  rule('batch', root, { callbacks: [callback(0, 'synchronous batch body', [], 'batch')], boundary: 'batch scope stops at suspension; no inferred flush order' }),
  rule('createRoot', root, { callbacks: [callback(0, 'root body', ['root disposer'])], sources: [1], boundary: 'declared root; returned value is callback result, not necessarily disposer' }),
  rule('getOwner', root, { result: value, slots: { '': 'solid.owner' }, boundary: 'captured owner may be null' }),
  rule('runWithOwner', root, { callbacks: [callback(1, 'borrowed-owner synchronous body')], sources: [0], boundary: 'restores owner, not tracking; does not transfer disposal' }),
  rule('onCleanup', root, { result: value, slots: { '': 'solid.cleanup-callback' }, callbacks: [callback(0, 'current-owner cleanup')], boundary: 'same callback returned; manual call does not unregister owner cleanup; owner-bound cleanup request, not wrapper lifetime or observed disposal' }),
  rule('onMount', root, { callbacks: [callback(0, 'mount effect body', [], 'untracked', 'callback return is not cleanup registration')], boundary: 'client effect invokes callback untracked after initial render; server onMount is a no-op; mount, owner and scheduling not observed' }),
  rule('createContext', root, { result: object({ Provider: value, defaultValue: value, id: value }), slots: { '': 'solid.context' }, sources: [0],
    identityObservations: { factoryArities: [0, 1, 2], uses: [
      { kind: 'call-argument', origins: root.map(module => ({ module, name: 'useContext' })), index: 0, arity: 1 },
      { kind: 'jsx-member', member: 'Provider' },
    ] } }),
  rule('useContext', root, { sources: [0], boundary: 'context lookup request; no closest-provider inference' }),
  rule('createResource', root, { result: { kind: 'tuple', items: [object({ state: value, loading: value, error: value, latest: value }), object({ mutate: value, refetch: value })] }, slots: { '0': 'solid.resource', '1': 'solid.resource-actions', '1.mutate': 'solid.resource-mutator', '1.refetch': 'solid.resource-refetch' } }),
  rule('useTransition', root, { result: pair, slots: { '0': 'solid.transition-pending', '1': 'solid.transition-start' } }),
  rule('startTransition', root, { callbacks: [callback(0, 'transition work')], boundary: 'requested transition; no completion or scheduler inference' }),
  rule('produce', store, { result: value, slots: { '': 'solid.store-modifier' }, callbacks: [callback(0, 'store draft mutation', ['mutable draft'])] }),
  rule('reconcile', store, { result: value, slots: { '': 'solid.store-modifier' }, sources: [0] }),
  rule('createMutable', store, { result: record, slots: { '': 'solid.mutable-store' }, sources: [0] }),
  rule('modifyMutable', store, { sources: [0, 1], boundary: 'explicit mutable store modifier application' }),
  rule('unwrap', store, { result: value, slots: { '': 'solid.raw-store' }, sources: [0], boundary: 'raw store alias; not an immutable deep copy' }),
  rule('mergeProps', [...root, ...web], { result: record, slots: { '': 'solid.merged-props' }, boundary: 'shallow lazy sources; last non-undefined property wins; no eager folding' }),
  rule('children', root, { result: object({ toArray: value }), slots: { '': 'solid.children' }, callbacks: [callback(0, 'resolved children source', [], 'tracked')],
    identityObservations: { factoryArities: [1], uses: [{ kind: 'receiver-call', member: 'toArray', arity: 0 }] } }),
  rule('lazy', root, { result: object({ preload: value }), slots: { '': 'solid.lazy-component' }, callbacks: [callback(0, 'lazy module loader')], boundary: 'lazy module request; no inferred loading/completion' }),
  rule('mapArray', root, { result: value, slots: accessor, sources: [0], callbacks: [{ ...callback(1, 'item mapping', ['item value', 'index accessor']), arity: 'index-accessor' }] }),
  rule('indexArray', root, { result: value, slots: accessor, sources: [0], callbacks: [callback(1, 'index mapping', ['item accessor', 'index value'])] }),
  rule('catchError', root, { callbacks: [callback(0, 'protected synchronous body'), callback(1, 'error handler', ['error'])], boundary: 'error boundary request; not arbitrary async catch' }),
  rule('from', root, { result: value, slots: accessor, sources: [0], callbacks: [callback(0, 'external producer', ['signal setter'], undefined, 'producer returns cleanup callback')] }),
  rule('observable', root, { result: object({ subscribe: value }), slots: { '': 'solid.observable' }, sources: [0] }),
  ...['For', 'Index', 'Show', 'Match', 'Switch', 'ErrorBoundary', 'Suspense', 'SuspenseList'].map((name) => rule(name, [...root, ...web], { jsx: true })),
  rule('Dynamic', wrappedWeb, { jsx: true }), rule('Portal', wrappedWeb, { jsx: true }),
  rule('createDynamic', web, { sources: [0, 1], callbacks: [callback(0, 'dynamic component accessor')] }),
  ...['render', 'hydrate'].map((name) => rule(name, name === 'render' ? wrappedWeb : web, { result: value, slots: { '': 'solid.disposer' }, sources: [1], callbacks: [callback(0, 'render body')], boundary: `${name} mount request; returned disposer is explicit` })),
  ...['renderToString', 'renderToStringAsync', 'renderToStream'].map((name) => rule(name, name === 'renderToString' ? wrappedWeb : web, { callbacks: [callback(0, 'server render body')], boundary: `${name} request; server and client execution differ` })),
  rule('getRequestEvent', web, { result: object({ request: value, locals: record }), slots: { '': 'solid.request-event' }, boundary: 'request event may be absent outside server request' }),
  ...['NoHydration', 'Hydration', 'HydrationScript'].map((name) => rule(name, web, { jsx: true })),
  ...['query', 'cache'].map((name) => rule(name, router, { result: object({ key: value, keyFor: value }), slots: { '': 'solid.query' }, callbacks: [callback(0, 'router query fetcher')], sources: [1] })),
  rule('revalidate', router, { sources: [0], boundary: 'revalidation request, not cache-hit/invalidation proof' }),
  ...['get', 'set', 'delete', 'clear'].map((name) => rule(`query.${name}`, router, { sources: name === 'clear' ? [] : name === 'set' ? [0, 1] : [0], boundary: 'explicit query cache operation; no cache-state inference' })),
  rule('action', router, { result: object({ url: value, with: value }), slots: { '': 'solid.action' }, callbacks: [callback(0, 'router action body')], sources: [1] }),
  rule('useAction', router, { result: value, slots: { '': 'solid.action' }, sources: [0] }),
  ...['useSubmission', 'useSubmissions'].map((name) => rule(name, router, { sources: [0], callbacks: [callback(1, 'submission filter', ['action input'])] })),
  ...['createAsync', 'createAsyncStore'].map((name) => rule(name, router, { result: object({ latest: value }), slots: accessor, callbacks: [callback(0, 'router async source')], boundary: 'returns accessor with latest; not a plain store object' })),
  ...['redirect', 'reload', 'json'].map((name) => rule(name, router, { sources: [0], boundary: 'router response helper; no route convention inference' })),
]);

export const contractId = (name: string) => `solid.${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
const identities = new Map(solidApiRules.flatMap((entry) => entry.modules.map((module) => [JSON.stringify([module, entry.name]), entry] as const)));
export const solidRule = (module: string, name: string): SolidApiRule | undefined => identities.get(JSON.stringify([module, name]));

/** Source identities, not imports of the application or framework runtime. */
export const solidReturnContracts: readonly ReturnContract[] = freeze(solidApiRules.filter((entry) => entry.result).map((entry) => ({ id: contractId(entry.name), origins: entry.modules.map((module) => ({ module, name: entry.name })), result: entry.result!, ...(entry.identityObservations ? { identityObservations: entry.identityObservations } : {}) })));

export function solidApi(module: string, name: string): string | undefined {
  const entry = solidRule(module, name);
  return entry?.result ? contractId(entry.name) : undefined;
}
