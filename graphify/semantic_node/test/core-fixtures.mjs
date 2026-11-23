import { loadModule } from './helpers.mjs';
import { createHash } from 'node:crypto';
const { ANNOTATION_LIMITS, canonicalJSON } = await loadModule('src/core/wire.ts');

export const digest = value => createHash('sha256').update(value).digest('hex');
export const copy = value => JSON.parse(JSON.stringify(value));

export function descriptor(id = 'sample') {
  return {
    id, version: '1.0.0', implementationDigest: digest(`${id} implementation`), configurationDigest: digest('{}'),
    languages: ['fixture'], view: { id: 'fixture-view', version: 1 },
    roles: [{ id: `${id}.exported`, label: 'Exported' }],
    properties: [
      { id: `${id}.label`, label: 'Label', valueKind: 'string', multiple: false },
      { id: `${id}.count`, label: 'Count', valueKind: 'integer', multiple: false },
      { id: `${id}.enabled`, label: 'Enabled', valueKind: 'boolean', multiple: false },
      { id: `${id}.origin`, label: 'Origin', valueKind: 'reference', multiple: false },
    ],
    relations: [{ id: `${id}.uses`, label: 'Uses' }],
  };
}

export function manifest(plugins = [], limits = {}) {
  const value = {
    version: 1, core: { version: '1.0.0', implementationDigest: digest('core') },
    view: { id: 'fixture-view', version: 1, implementationDigest: digest('view') }, parserDigest: digest('parser'),
    plugins: plugins.map(plugin => plugin.descriptor ?? plugin), limits: { ...ANNOTATION_LIMITS, ...limits },
  };
  return { ...value, id: digest(canonicalJSON(value)) };
}

export function sourceSpan(source, start = 0, end = source.length) {
  return {
    startByte: Buffer.byteLength(source.slice(0, start)), endByte: Buffer.byteLength(source.slice(0, end)),
    startLine: source.slice(0, start).split('\n').length,
    endLine: source.slice(0, end > start ? end - 1 : start).split('\n').length,
  };
}

export function fixture(source = 'export const alpha = 1;\nexport const beta = alpha;\n') {
  const split = source.indexOf('\n') + 1 || source.length;
  const document = { source, sourceHash: digest(source), relativePath: 'fixtures/input.txt', language: 'fixture' };
  const declarations = [
    { key: 'root', kind: 'module', span: sourceSpan(source), exports: [] },
    { key: 'a', kind: 'constant', name: 'alpha', owner: 'root', span: sourceSpan(source, 0, split), exports: ['alpha'] },
    { key: 'b', kind: 'constant', name: 'beta', owner: 'root', span: sourceSpan(source, split), exports: ['beta'] },
  ];
  return {
    document,
    view: { id: 'fixture-view', version: 1, language: 'fixture', declarations, state: 'complete', diagnostics: [] },
    evidence: { ruleId: 'export-rule', basis: 'syntax', span: { ...declarations[1].span } },
  };
}

export function rolePlugin(id = 'sample') {
  return {
    descriptor: descriptor(id),
    analyze({ view, budget }, emitter) {
      for (const declaration of view.declarations) {
        if (budget.isCancelled()) return { state: 'truncated' };
        budget.step();
        if (declaration.exports.length) emitter.role(declaration.key, `${id}.exported`, {
          ruleId: 'export-rule', basis: 'syntax', span: declaration.span,
        });
      }
    },
  };
}
