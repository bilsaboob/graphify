import { canonicalJSON } from '#core/wire';
import { object, requireValid } from '#core/validation';
import catalog from '../../module_catalog.json' with { type: 'json' };

export type ModuleAliases = Readonly<Record<string, string>>;

// Reviewed identity roots only. Descendants still need an exact existing API
// contract; an alias never asserts package contents, versions or runtime parity.
export const MODULE_FAMILIES = Object.freeze(catalog.MODULE_FAMILIES);
export const MODULE_ALIAS_TARGETS = Object.freeze(catalog.MODULE_ALIAS_TARGETS);

const targets = new Set(MODULE_ALIAS_TARGETS);
const bareModule = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const within = (module: string, prefix: string) => module === prefix || module.startsWith(`${prefix}/`);

export function normalizeModuleAliases(input: unknown = {}): ModuleAliases {
  requireValid(input !== null && typeof input === 'object' && !Array.isArray(input), 'Invalid module aliases');
  const value = object(input, [], Object.keys(input));
  const keys = Object.keys(value).sort();
  requireValid(keys.length <= 64 && canonicalJSON(value).length <= 4096, 'Module alias limit exceeded');
  for (const key of keys) {
    requireValid(key.length <= 256 && bareModule.test(key), 'Invalid module alias prefix');
    requireValid(!MODULE_FAMILIES.some(root => within(key, root) || within(root, key)), 'Canonical module identities cannot be aliased');
    requireValid(typeof value[key] === 'string' && targets.has(value[key] as string), 'Unsupported module alias target');
  }
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key] as string])));
}

export function createModuleIdentity(moduleAliases: ModuleAliases) {
  const prefixes = Object.keys(moduleAliases).sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
  return (module: string): string => {
    const prefix = prefixes.find(prefix => within(module, prefix));
    if (prefix === undefined) return module;
    requireValid(bareModule.test(module), 'Unsupported aliased module specifier');
    // Apply once to the original identity. Overlaps use the longest slash-boundary
    // prefix; canonical source prefixes are rejected, so chains are impossible.
    return moduleAliases[prefix]! + module.slice(prefix.length);
  };
}
