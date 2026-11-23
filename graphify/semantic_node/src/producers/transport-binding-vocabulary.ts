import type { PluginDescriptor, SourceSpan } from '#core/wire';

/** File-local lexical qualification, not a runtime or graph contract.
 * Units share evidence.pluginId/ruleId/span; subjects alone are not unit IDs.
 * Locators are half-open UTF-8 bytes and inclusive one-based lines, never source
 * text. Only declaration/import references are emitted, not expression references.
 * Conditional correspondence requires a completed instance and completed endpoints
 * with the same declaration/allocation and exact event key in the same source.
 * Neither const nor a complete reference inventory asserts object immutability.
 * Unsupported uses of any candidate allocation veto this plugin's whole source
 * unit: another escaped receiver could expose the shared constructor/prototype.
 */
export const transportBindingRules = {
  version: 1,
  spanEncoding: 's:utf8-start:utf8-end:start-line:end-line',
  rules: ['node-event-instance-v1', 'node-event-listener-v1', 'node-event-emission-v1'],
  module: 'node:events',
  importedName: 'EventEmitter',
  excludedEvents: ['error', 'newListener', 'removeListener'],
  conditions: ['lexical-binding-only', 'standard-node-api-assumed', 'runtime-version-not-captured', 'registration-order-unknown', 'execution-unknown', 'external-mutation-unknown'],
  maxSourceBytes: 256 * 1024,
  maxWork: 100000,
  maxDepth: 64,
  maxInstances: 16,
  maxEndpoints: 48,
  maxFacts: 1024,
  maxEventKeyBytes: 128,
  maxEmissionArguments: 16,
  maxPairCandidates: 1024,
  maxCorrespondences: 64,
} as const;

const roles = { 'event-instance': 'Qualified Event Allocation', 'event-listener': 'Qualified Event Listener', 'event-emission': 'Qualified Event Emission' };
const references = { declaration: 'Exact Local Allocation Declaration', 'import-reference': 'Direct Constructor Import' };
const spans = { allocation: 'Allocation Span', import: 'Named Import Specifier Span', receiver: 'Direct Receiver Span', 'event-literal': 'Event Literal Span', callback: 'Inline Arrow Callback Span', owner: 'Lexical Callable Or Module Span' };
const strings = { 'event-key': 'Exact ASCII Event Key', condition: 'Lexical Qualification Limitation' };
const integers = { 'endpoint-count': 'Full Qualified Allocation Endpoint Count' };
const booleans = { 'inventory-complete': 'Qualified File-Local Reference Inventory', 'unit-complete': 'Complete Evidence Unit' };
export type TransportBindingRole = keyof typeof roles;
export type TransportBindingProperty = keyof typeof references | keyof typeof spans | keyof typeof strings | keyof typeof integers | keyof typeof booleans;

export function transportBindingSpan(span: SourceSpan): string {
  return `s:${span.startByte}:${span.endByte}:${span.startLine}:${span.endLine}`;
}

export function transportBindingDescriptor(digests: { implementationDigest: string; configurationDigest: string }): PluginDescriptor {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error('Transport binding plugin requires build-supplied digests');
  return {
    id: 'transport-binding', version: '1', ...digests, languages: ['typescript', 'tsx'], view: { id: 'typescript', version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `transport-binding.${name}`, label })),
    properties: [
      ...Object.entries(references).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: 'reference' as const })),
      ...Object.entries(spans).map(([name, label]) => ({ id: `transport-binding.${name}`, label, description: 'Exact source span locator; never embedded source text.', multiple: true, valueKind: 'string' as const })),
      ...Object.entries(strings).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: 'string' as const })),
      ...Object.entries(integers).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: 'integer' as const })),
      ...Object.entries(booleans).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: 'boolean' as const })),
    ],
    relations: [],
  };
}
