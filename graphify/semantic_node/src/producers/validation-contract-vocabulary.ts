import type { PluginDescriptor, SourceSpan } from '#core/wire';

/** Reviewed, conditional source grammar, NOT the importing application's version.
 * Official v4.1.12 core/checks.ts uses input.length (UTF-16) and inclusive numeric
 * comparisons; core/parse.ts returns the parsed value or success/data envelope.
 * Current zod.dev/api describes code-point lengths instead. Do not generalize
 * these reviewed rules to an unobserved installed Zod version.
 * No arbitrary source, messages, defaults or private values are copied.
 */
export const validationContractRules = {
  version: 1,
  spanEncoding: 's:utf8-start:utf8-end:start-line:end-line',
  rules: ['zod-object-parse-v1', 'zod-object-safe-parse-v1', 'zod-value-kind-v1', 'zod-minimum-v1', 'zod-maximum-v1'],
  module: 'zod', importedName: 'z',
  reviewedAPI: 'zod-v4.1.12',
  contractID: 'zod-v4.1.12-primitive-object-v1',
  reviewedSources: [
    'https://raw.githubusercontent.com/colinhacks/zod/v4.1.12/packages/zod/src/v4/core/checks.ts',
    'https://raw.githubusercontent.com/colinhacks/zod/v4.1.12/packages/zod/src/v4/core/parse.ts',
  ],
  conditions: ['reviewed-api-assumed', 'reviewed-zod-utf16-api-assumed', 'installed-version-not-captured', 'external-mutation-not-observed', 'execution-not-observed'],
  limitations: ['unknown-object-keys-not-strict', 'number-finiteness-not-claimed', 'number-integrality-not-claimed'],
  modes: { parse: { condition: 'normal-validation-return', returnTarget: 'return' }, safeParse: { condition: 'success-true', returnTarget: 'return.data' } },
  predicates: ['value_kind', 'minimum', 'maximum'],
  valueKinds: ['string', 'number', 'boolean'],
  metrics: ['value-kind', 'utf16-length', 'numeric-value'],
  numericLiteral: '-?[ \\t\\r\\n]*(0|[1-9][0-9]*)',
  maxSourceBytes: 256 * 1024, maxWork: 100000, maxDepth: 64,
  maxFields: 8, maxUses: 8, maxAtoms: 128, maxFacts: 1024, maxFieldKeyBytes: 128,
  maxIdentifierBytes: 128,
} as const;

const roles = { 'validation-use': 'Qualified Inline Validation Use', 'validation-predicate': 'Source-Declared Validation Predicate' };
const references = { 'import-reference': 'Exact Named Zod Import' };
const spans = { import: 'Named Import Specifier', owner: 'Exact Lexical Callable', parameter: 'Required Parameter Identifier', argument: 'Exact Parameter Argument', schema: 'Inline Object Schema Call', call: 'Validation Call', return: 'Sole Return Or Arrow Expression', key: 'Field Key', type: 'Primitive Method', method: 'Validation Or Predicate Method', bound: 'Numeric Bound Literal' };
const strings = { mode: 'Parse Mode', 'return-target': 'Conditional Return Target', condition: 'Reviewed Contract Condition', 'field-key': 'Identifier Field Key', predicate: 'Closed Predicate Kind', 'value-kind': 'Closed Primitive Kind', metric: 'Closed Predicate Metric' };
const integers = { 'predicate-count': 'Complete Use Predicate Census', 'use-count': 'Complete Source Use Census', 'bound-value': 'Literal Safe Integer Bound' };
const booleans = { 'inventory-complete': 'Full Import Usage Inventory', 'unit-complete': 'Whole Qualified Evidence Unit' };
export type ValidationContractRole = keyof typeof roles;
export type ValidationContractProperty = keyof typeof references | keyof typeof spans | keyof typeof strings | keyof typeof integers | keyof typeof booleans;

export function validationContractSpan(span: SourceSpan): string {
  return `s:${span.startByte}:${span.endByte}:${span.startLine}:${span.endLine}`;
}

export function validationContractDescriptor(digests: { implementationDigest: string; configurationDigest: string }): PluginDescriptor {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error('Validation contract plugin requires build-supplied digests');
  return {
    id: 'validation-contract', version: '1', ...digests, languages: ['typescript', 'tsx'], view: { id: 'typescript', version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `validation-contract.${name}`, label })),
    properties: [
      ...Object.entries(references).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: 'reference' as const })),
      ...Object.entries(spans).map(([name, label]) => ({ id: `validation-contract.${name}`, label, description: 'Exact source span locator, never embedded source text.', multiple: true, valueKind: 'string' as const })),
      ...Object.entries(strings).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: 'string' as const })),
      ...Object.entries(integers).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: 'integer' as const })),
      ...Object.entries(booleans).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: 'boolean' as const })),
    ],
    relations: [],
  };
}
