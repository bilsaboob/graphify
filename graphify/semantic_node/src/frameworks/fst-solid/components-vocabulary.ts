import type { PluginDescriptor } from '#core/wire';

const roles = {
  control: 'Input Control Usage', overlay: 'Overlay Usage', 'dom-effect': 'Reversible DOM Effect Usage',
  'asset-request': 'Asset API Request', scene: 'Scene Usage', registration: 'Explicit Registration',
  resource: 'Resource Contract', runtime: 'Scenegraph Runtime', camera: 'Camera Controller',
  animation: 'Animation Controller', handle: 'Returned Handle', 'callback-payload': 'Callback Payload Binding',
} as const;
const properties = {
  api: 'Reviewed Public API', operation: 'Requested Operation', 'result-contract': 'Declared Result Contract',
  'callback-contract': 'Declared Callback Contract', 'callback-binding': 'Callback Binding Name',
  'callback-path': 'Callback Payload Path', prop: 'Authored Property', literal: 'Authored Literal',
  ownership: 'Ownership Contract', cleanup: 'Cleanup Contract', requirement: 'Required Context',
  qualification: 'Source Qualification',
  'jsx-contribution': 'Ordered JSX Prop Contribution', 'props-contract': 'JSX Props Resolution Contract', 'conditional-prop-contract': 'Conditional Public Prop Contract',
} as const;
const relations = {
  import: 'Qualified Public Import', target: 'Requested Operation Target', input: 'Authored Input',
  field: 'Borrowed Field Expression', value: 'Controlled Value Expression', checked: 'Controlled Checked Expression',
  callback: 'Authored Callback', 'created-by': 'Handle Origin', 'argument-source': 'Callback Contract Source',
  document: 'Scenegraph Document', 'scene-target': 'Scene Expression', options: 'Authored Options',
  'spread-source': 'Forwarded JSX Source', 'forwarded-prop': 'Forwarded JSX Property Expression',
  'jsx-contribution-source': 'Authored JSX Contribution Source', 'jsx-element': 'Containing JSX Element Occurrence',
} as const;
export type FstComponentsRole = `fst-components.${keyof typeof roles}`;
export type FstComponentsProperty = `fst-components.${keyof typeof properties}`;
export type FstComponentsRelation = `fst-components.${keyof typeof relations}`;

export function componentsDescriptor(digests: { implementationDigest: string; configurationDigest: string }): PluginDescriptor {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error('FST components plugin requires build-supplied content digests');
  return {
    id: 'fst-components', version: '1', ...digests, languages: ['typescript', 'tsx'], view: { id: 'typescript', version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `fst-components.${name}`, label })),
    properties: Object.entries(properties).map(([name, label]) => ({ id: `fst-components.${name}`, label, multiple: true, valueKind: 'string' })),
    relations: Object.entries(relations).map(([name, label]) => ({ id: `fst-components.${name}`, label })),
  };
}
