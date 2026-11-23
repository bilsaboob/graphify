import type { PluginDescriptor } from '#core/wire';
import { coreImport } from './core-rules.js';

export const roles = {
  component: 'FST Component', state: 'FST State', form: 'FST Form', scope: 'FST Scope',
  'item-scope': 'FST Item Scope', field: 'FST Field', 'field-binding': 'Borrowed Field Binding',
  'lifecycle-hook': 'Declared Lifecycle Hook', 'registration': 'Explicit Registration',
  'api-handle': 'Reviewed FST API Handle',
  'component-factory': 'Authored Component Factory',
} as const;
export const properties = {
  name: ['Trace Name', false], 'design-name': ['Design Name', false], 'design-concept': ['Design Concept', false],
  'field-path': ['Literal Field Path', false], 'lifetime-operation': ['Requested Lifetime Operation', true],
  'lookup-policy': ['Requested Lookup Policy', true], 'instance-kind': ['Instance Construction', true],
  'hook-kind': ['Declared Hook Contract', false], 'registration-kind': ['Registration API', true],
  'observation-phase': ['Field Observation Phase', true], 'field-operation': ['Field Invocation', true],
  'field-dispatch': ['Conditional Field Invocation Contract', true], 'list-contribution': ['Ordered List Item Contribution', true],
  'ownership': ['Binding Ownership', false],
  'change-argument': ['OnChangeArgs Snapshot Binding', true],
  'children-change-argument': ['Children Change Snapshot Binding', true],
  'api-operation': ['Explicit API Operation', true], 'api-policy': ['Reviewed API Boundary', true],
  'handle-kind': ['Reviewed Return Handle Kind', false], 'key': ['Literal API Key Or Delay', true],
  'option': ['Literal API Option', true], 'callback-binding': ['Callback Payload Binding', true],
  'route-entry': ['Authored Route Entry', true], 'route-path': ['Authored Route Path', true],
  'component-return': ['Component Construction Boundary', true],
} as const;
export const relations = {
  'factory': 'Declared Factory Import', 'implemented-by': 'Renderer', 'props-type': 'Props Type',
  'extends': 'Declared Base', 'type-argument': 'Generic Type Argument', 'lifetime-target': 'Lifetime Call Target',
  'form-origin': 'Form Expression', 'field-path-expression': 'Field Path Expression', 'field-type': 'Field Type Reference', 'value-type': 'Value Type',
  'borrows': 'Borrowed Field Source', 'callback': 'Registered Callback', 'observes': 'Explicit Dependency',
  'field-target': 'Field Call Target',
  'field-argument': 'Conditional Field Argument Expression', 'field-write-options': 'Conditional Field Write Options',
  'list-item-source': 'List Item Or Iterable Expression', 'list-construction': 'Containing List Construction',
  'change-argument-source': 'OnChangeArgs Snapshot Dependency',
  'operation-target': 'Direct API Operation Target', 'source': 'Explicit API Input',
  'key-expression': 'API Key Or Delay Expression', 'callback-source': 'Callback Payload Source',
  'subform-origin': 'Subform Prefix Expression', 'route-component': 'Authored Route Component',
  'route-option': 'Authored Route Option', 'route-definition': 'Authored Route Definition',
  'returns-component': 'Returned Component Construction', 'returned-renderer': 'Returned Component Renderer',
  'returned-options': 'Returned Component Options Expression',
} as const;
export type FstSolidRole = `fst-solid.${keyof typeof roles}`;
export type FstSolidProperty = `fst-solid.${keyof typeof properties}`;
export type FstSolidRelation = `fst-solid.${keyof typeof relations}`;

export function descriptor(digests: { implementationDigest: string; configurationDigest: string }): PluginDescriptor {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error('FST plugin requires build-supplied content digests');
  return {
    id: 'fst-solid', version: '1', ...digests, languages: ['typescript', 'tsx'], view: { id: 'typescript', version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `fst-solid.${name}`, label })),
    properties: Object.entries(properties).map(([name, [label, multiple]]) => ({ id: `fst-solid.${name}`, label, multiple, valueKind: 'string' })),
    relations: Object.entries(relations).map(([name, label]) => ({ id: `fst-solid.${name}`, label })),
  };
}

// Current source exports, not package-resolution or runtime execution. In particular,
// root exports identity, /app exports neither Form nor Scope, and Field is a type.
const root = '@fst/components-fst-solid';
const catalogue: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [`${root}/app/component`]: ['component', 'componentWithChildren', 'onComponentCleanup'],
  [`${root}/app/state`]: ['State', 'onChange', 'onChangeDelayed', 'resolveChildrenOnChange'],
  [`${root}/app/state/onChange`]: ['onChange', 'onChangeDelayed', 'resolveChildrenOnChange'],
  [`${root}/app/form`]: ['Form', 'FormField'],
  [`${root}/app/scope`]: ['Scope', 'ItemScope'],
  [`${root}/app/field`]: ['field', 'Field'],
  [`${root}/app/fieldBinding`]: ['InputField', 'useFieldBinding'],
  [`${root}/app`]: ['component', 'componentWithChildren', 'onComponentCleanup', 'State', 'onChange', 'onChangeDelayed', 'resolveChildrenOnChange', 'field', 'Field', 'InputField', 'useFieldBinding'],
  [`${root}/solid-js`]: ['onCleanup', 'onMount'],
});
export function canonicalApi(module: string, name: string): string | undefined {
  return Object.hasOwn(catalogue, module) && catalogue[module]?.includes(name) || coreImport(module, name) ? name : undefined;
}
