import type { PluginDescriptor } from '#core/wire';

export const roles = {
  'signal-accessor': 'Solid Signal Accessor', 'signal-setter': 'Solid Signal Setter',
  'signal-pair': 'Authored Signal Pair', 'store-pair': 'Authored Store Pair',
  store: 'Solid Store', 'store-updater': 'Solid Store Updater',
  'props-partition': 'Solid Props Partition', 'props-remainder': 'Solid Remaining Props', prop: 'Solid Projected Prop',
  accessor: 'Derived or Bridged Accessor', selector: 'Key Selector', reaction: 'Reaction Tracker', 'on-callback': 'Explicit Dependency Callback',
  owner: 'Captured Possibly-Null Owner', context: 'Context Identity', 'cleanup-callback': 'Returned Cleanup Callback',
  resource: 'Resource Accessor', 'resource-actions': 'Resource Actions', 'resource-mutator': 'Resource Mutator', 'resource-refetch': 'Resource Refetch',
  'transition-pending': 'Transition Pending Accessor', 'transition-start': 'Transition Starter',
  'store-modifier': 'Store Modifier', 'mutable-store': 'Mutable Store', 'raw-store': 'Unwrapped Store Alias',
  'merged-props': 'Lazy Shallow Merged Props', children: 'Resolved Children Accessor', 'lazy-component': 'Lazy Component',
  observable: 'Observable Bridge', disposer: 'Explicit Disposer', 'request-event': 'Optional Server Request Event',
  query: 'Router Query Handle', action: 'Router Action Handle',
} as const;
export const properties = {
  'partition-index': ['Props Tuple Slot', false], 'included-key': ['Included Prop Key', true],
  'excluded-key': ['Excluded Prop Key', true], 'prop-key': ['Projected Prop Key', false],
  boundary: ['Declared Boundary', true], 'callback-role': ['Callback Contract', true], 'parameter-role': ['Callback Parameter Contract', true],
  'return-contract': ['Declared Return Semantics', true], option: ['Authored Static Option', true], 'jsx-mode': ['Authored JSX Binding Mode', true],
  'callback-dispatch': ['Conditional Render Child Dispatch', true], 'callback-argument-contract': ['Conditional Render Child Argument', true],
  'jsx-contribution': ['Ordered JSX Prop Contribution', true], 'jsx-props-contract': ['JSX Props Resolution Contract', true], 'dynamic-dispatch': ['Conditional Dynamic Component Dispatch', true],
} as const;
export const relations = {
  factory: 'Declared Solid Factory Import', 'created-by': 'Factory Call',
  'setter-for': 'Sets Signal Accessor', 'updater-for': 'Updates Store', 'alias-of': 'Stable Binding Alias',
  'props-source': 'Partitioned Props Expression',
  'signal-read': 'Signal Accessor Call', 'signal-write': 'Signal Setter Call',
  'store-read': 'Store Property Read', 'store-update': 'Store Updater Call',
  'api-call': 'Qualified API Call', 'accessor-read': 'Accessor Call', 'handle-call': 'Direct Handle Call',
  callback: 'Declared Callback', source: 'Explicit Source Expression', 'parameter-source': 'Callback Value Source',
  'potential-read': 'Direct Potential Tracked Read', 'untracked-read': 'Direct Accessor Call in Untracked Body', 'batch-write': 'Direct Setter or Updater Call in Batch Body',
  'resource-for': 'Resource Action For Accessor', 'transition-for': 'Starts Pending Transition',
  'resource-status': 'Resource Status Property Read',
  'owner-source': 'Explicit Owner Argument', 'context-source': 'Explicit Context Identity', 'merge-source': 'Ordered Lazy Props Source',
  'returned-callback': 'Returns Same Callback', 'store-target': 'Explicit Store Operation Target', 'modifier-source': 'Explicit Store Modifier',
  'event-handler': 'Native Event Handler', 'event-data': 'Native Bound Event Data', 'jsx-binding': 'Native JSX Binding Expression',
  'jsx-overridden': 'Possibly Overridden JSX Attribute', 'render-child': 'Conditional Child Source Expression',
  'conditional-callback': 'Conditional Render Child Candidate', 'jsx-contribution-source': 'Authored JSX Contribution Source', 'jsx-element': 'Containing JSX Element Occurrence',
  'dynamic-component': 'Dynamic Component Expression', 'provider-context': 'Context Provider Identity', 'module-source': 'Literal Lazy Module Request',
  'key-source': 'Authored Router Key', 'action-source': 'Associated Router Action',
} as const;
export type SolidRole = `solid.${keyof typeof roles}`;
export type SolidProperty = `solid.${keyof typeof properties}`;
export type SolidRelation = `solid.${keyof typeof relations}`;

export function descriptor(digests: { implementationDigest: string; configurationDigest: string }): PluginDescriptor {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error('Solid plugin requires build-supplied content digests');
  return {
    id: 'solid', version: '1', ...digests, languages: ['typescript', 'tsx'], view: { id: 'typescript', version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `solid.${name}`, label })),
    properties: Object.entries(properties).map(([name, [label, multiple]]) => ({ id: `solid.${name}`, label, multiple, valueKind: 'string' })),
    relations: Object.entries(relations).map(([name, label]) => ({ id: `solid.${name}`, label })),
  };
}
