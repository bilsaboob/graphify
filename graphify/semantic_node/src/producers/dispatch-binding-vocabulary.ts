import type { PluginDescriptor, SourceSpan } from '#core/wire';

/** Reviewed source rules, not installed application versions or runtime proof.
 * Elysia handle delegates to this.fetch; tRPC's caller resolves a path against
 * that router's procedure map. Neither URL origin nor matching names bind a
 * deployment. This producer retains family witnesses, never execution pairs.
 */
export const dispatchBindingRules = {
  version: 1,
  spanEncoding: 's:utf8-start:utf8-end:start-line:end-line',
  rules: ['elysia-app-v1', 'elysia-route-v1', 'elysia-handle-v1', 'trpc-router-v1', 'trpc-procedure-v1', 'trpc-caller-v1', 'trpc-call-v1'],
  http: { module: 'elysia', name: 'Elysia', assumption: 'elysia-1.3.21-in-process-v1', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] },
  rpc: { module: '@trpc/server', name: 'initTRPC', assumption: 'trpc-11.4.3-in-process-v1', kinds: ['query', 'mutation'], reserved: ['__proto__', 'constructor', 'prototype', 'then', 'call', 'apply', '_def', 'createCaller'] },
  request: { module: 'undici', name: 'Request', reviewedAPI: 'undici-7.13.0-request', origins: ['ambient-fetch', 'undici-named'] },
  reviewedSources: [
    'https://raw.githubusercontent.com/elysiajs/elysia/1.3.21/src/index.ts',
    'https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/initTRPC.ts',
    'https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/procedureBuilder.ts',
    'https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/router.ts',
    'https://raw.githubusercontent.com/nodejs/undici/v7.13.0/lib/web/fetch/request.js',
  ],
  conditions: ['lexical-binding-only', 'reviewed-api-assumed', 'installed-version-not-captured', 'execution-not-observed', 'external-mutation-not-observed', 'runtime-not-observed', 'registration-order-unknown', 'registered-at-dispatch-required', 'potential-correspondence-only'],
  httpConditions: ['standard-request-api-assumed', 'deployment-not-observed', 'url-origin-not-a-binding'],
  rpcConditions: ['input-result-semantics-unknown', 'procedure-kind-not-side-effect-proof', 'network-serialization-not-implied'],
  pathPattern: '^/(?:[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)?$',
  maxSourceBytes: 256 * 1024, maxWork: 100000, maxDepth: 64,
  maxFamilies: 8, maxEndpoints: 32, maxFacts: 2048, maxArguments: 16,
  maxCallersPerFamily: 1, maxPathBytes: 256, maxURLBytes: 1024, maxIdentifierBytes: 128,
  maxPairCandidates: 1024, maxPairs: 64,
} as const;

const roles = { 'dispatch-family': 'Qualified In-Process Binding Family', 'dispatch-handler': 'Registered In-Process Handler', 'dispatch-caller': 'Exact Local RPC Caller', 'dispatch-call': 'Potential In-Process Dispatch' };
const references = { declaration: 'Exact Family Declaration', 'import-reference': 'Exact Framework Import', 'initializer-declaration': 'RPC Initializer Declaration', 'caller-declaration': 'Exact Caller Declaration', 'request-import-reference': 'Named Request Import' };
const spans = { allocation: 'Family Allocation', import: 'Named Import Specifier', initializer: 'RPC Initialization', owner: 'Lexical Callable Or Module', receiver: 'Direct Receiver', selector: 'Path URL Or Procedure Selector', method: 'API Method Token', 'method-literal': 'Explicit Request Method', handler: 'Inline Handler', argument: 'Exact Argument', request: 'Request Allocation', 'request-constructor': 'Request Constructor', 'request-import': 'Request Import Specifier', caller: 'Caller Allocation', context: 'Empty Caller Context' };
const strings = { family: 'Closed Dispatch Family', 'api-assumption': 'Reviewed API Assumption', 'http-method': 'Exact HTTP Method', path: 'Simple Path Only', 'procedure-key': 'Exact Procedure Key', 'procedure-kind': 'Declared Procedure Kind', 'request-origin': 'Qualified Request Origin', condition: 'Conditional Qualification Limitation' };
const integers = { 'family-count': 'Whole Source Family Census', 'endpoint-count': 'Whole Family Endpoint Census', 'caller-count': 'Whole Family Caller Census', 'argument-count': 'Exact Argument Census' };
const booleans = { 'inventory-complete': 'Complete File-Local Use Inventory', 'unit-complete': 'Complete Evidence Unit' };
export type DispatchBindingRole = keyof typeof roles;
export type DispatchBindingProperty = keyof typeof references | keyof typeof spans | keyof typeof strings | keyof typeof integers | keyof typeof booleans;

export function dispatchBindingSpan(span: SourceSpan): string { return `s:${span.startByte}:${span.endByte}:${span.startLine}:${span.endLine}`; }

export function dispatchBindingDescriptor(digests: { implementationDigest: string; configurationDigest: string }): PluginDescriptor {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error('Dispatch binding plugin requires build-supplied digests');
  return {
    id: 'dispatch-binding', version: '1', ...digests, languages: ['typescript', 'tsx'], view: { id: 'typescript', version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label })),
    properties: [
      ...Object.entries(references).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: 'reference' as const })),
      ...Object.entries(spans).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, description: 'Exact source locator, never embedded source text.', multiple: true, valueKind: 'string' as const })),
      ...Object.entries(strings).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: 'string' as const })),
      ...Object.entries(integers).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: 'integer' as const })),
      ...Object.entries(booleans).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: 'boolean' as const })),
    ],
    relations: [],
  };
}
