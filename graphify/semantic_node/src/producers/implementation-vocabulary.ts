import type { PluginDescriptor, SourceSpan } from '#core/wire';

/** Implementation source evidence, vocabulary 1 (NOT a new AnnotationFact wire).
 * A unit is keyed by source identity + evidence.pluginId/ruleId/span, never by
 * subject/name. The subject is only a containing retained declaration. All unit
 * facts have the same evidence. Consume only units with unit-complete=true;
 * interrupted emission can leave a prefix without that final marker.
 *
 * Span-valued strings use s:<startByte>:<endByte>:<startLine>:<endLine>, decimal,
 * UTF-8 half-open bytes and inclusive one-based lines in this exact source.
 * They are locators, NOT evaluated values, text, JSON, or generic v1 References.
 * The latter require verbatim text and would copy secrets/defaults or whole
 * callable bodies. Consumers must validate these spans against archived source.
 * Ordinary call edges do not acquire these typed unit semantics.
 *
 * owner is the nearest lexical callable (not declaration owner); test-owner is
 * present only for assertions directly inside a supported test callback. Guards
 * stop at the callable boundary. They assert lexical containment only, not CFG,
 * fallthrough, invocation, ordering, transactions, async completion or coverage.
 *
 * config-source = process.env | import.meta.env; config-provenance = import-bound
 * | ambient-assumed | syntax. No provenance establishes the effective global or
 * deployed settings. fallback-semantics = nullish (??), falsy (||), undefined
 * (binding default), always accompanied by fallback and fallback-expression spans.
 * These are local expressions only, not resolved precedence or safe defaults.
 * Assertion async-mode = sync | resolves | rejects describes parsed expect
 * modifiers only; awaited records an actual enclosing await expression. Import
 * contracts do not establish registration, assertion execution, pass or coverage.
 * Supported test registrations are direct two-argument test/it calls with inline
 * arrow/function callbacks. Suites/options/parameterization and callback aliases
 * are not silently interpreted. Matcher/arity allowlists live in the plugin.
 */
export const implementationRules = {
  version: 1,
  spanEncoding: 's:utf8-start:utf8-end:start-line:end-line',
  rules: ['local-outcome-v1', 'local-write-v1', 'environment-read-v1', 'test-registration-v1', 'test-assertion-v1'],
  testModules: ['bun:test', 'vitest', 'node:test'],
  assertModules: ['node:assert', 'node:assert/strict'],
  processModules: ['process', 'node:process'],
  maxUnits: 128,
  maxFacts: 2048,
  maxKeyBytes: 128,
  maxContextDepth: 64,
} as const;

const roles = {
  return: 'Local Return Statement', throw: 'Local Throw Statement',
  assignment: 'Direct Assignment', update: 'Direct Update',
  'config-read': 'Qualified Environment Read', test: 'Authored Test Registration', assertion: 'Authored Assertion',
};
const spans = {
  owner: 'Lexical Callable Span', value: 'Value Expression Span', target: 'Write Target Span',
  'if-true': 'Enclosing If True Predicate Span', 'if-false': 'Enclosing If False Predicate Span',
  'conditional-true': 'Enclosing Conditional True Predicate Span', 'conditional-false': 'Enclosing Conditional False Predicate Span',
  fallback: 'Fallback Expression Span', 'fallback-expression': 'Complete Defaulting Expression Span',
  callback: 'Registered Test Callback Span', 'test-name': 'Test Name Expression Span',
  actual: 'Asserted Expression Span', expected: 'Expected Expression Span', 'test-owner': 'Exact Test Callback Span',
};
const strings = {
  condition: 'Source Evidence Limitation', operator: 'Parsed Write Operator',
  'config-key': 'Static Environment Key', 'config-source': 'Environment API', 'config-provenance': 'Environment Provenance',
  'fallback-semantics': 'Defaulting Semantics', runner: 'Imported Test Runner', api: 'Imported Registration API',
  matcher: 'Parsed Assertion Matcher', 'async-mode': 'Parsed Assertion Async Mode',
};
const booleans = { negated: 'Parsed Matcher Negation', awaited: 'Directly Awaited Assertion', 'unit-complete': 'Complete Source Unit' };
export type ImplementationRole = keyof typeof roles;
export type ImplementationProperty = keyof typeof spans | keyof typeof strings | keyof typeof booleans;

export function implementationSpan(span: SourceSpan): string {
  return `s:${span.startByte}:${span.endByte}:${span.startLine}:${span.endLine}`;
}

export function implementationDescriptor(digests: { implementationDigest: string; configurationDigest: string }): PluginDescriptor {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error('Implementation plugin requires build-supplied digests');
  return {
    id: 'implementation', version: '1', ...digests, languages: ['typescript', 'tsx'], view: { id: 'typescript', version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `implementation.${name}`, label })),
    // Cardinality is per subject in wire v1, but these properties are per occurrence.
    properties: [
      ...Object.entries(spans).map(([name, label]) => ({ id: `implementation.${name}`, label, description: 'Exact source span locator; never an evaluated value or embedded source text.', multiple: true, valueKind: 'string' as const })),
      ...Object.entries(strings).map(([name, label]) => ({ id: `implementation.${name}`, label, multiple: true, valueKind: 'string' as const })),
      ...Object.entries(booleans).map(([name, label]) => ({ id: `implementation.${name}`, label, multiple: true, valueKind: 'boolean' as const })),
    ],
    relations: [],
  };
}
