import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { hash, loadModule, packageRoot, parse } from './helpers.mjs';

const { createAnalyzer } = await loadModule('src/analysis.ts');
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
const { MODULE_ALIAS_TARGETS, MODULE_FAMILIES, normalizeModuleAliases } = await loadModule('src/typescript/module-aliases.ts');
const { canonicalJSON, validateAnnotationManifest, validateAnnotationResult } = await loadModule('src/core/wire.ts');
const { processRequest } = await loadModule('src/worker.ts');
const digests = { implementationDigest: hash('module-alias-test-build'), parserDigest: hash('module-alias-test-parser') };
const fst = '@fst/components-fst-solid';
const aliases = { '@example/sdk': fst, '@example/controls': '@fst/components-fst-disco-ui' };
const frameworkIds = new Set(['fst-solid', 'fst-components', 'solid']);
const facts = (result, term) => result.facts.filter(fact => fact.term === term);
const frameworkFacts = result => result.facts.filter(fact => frameworkIds.has(fact.evidence.pluginId));
const slice = (source, span) => Buffer.from(source).subarray(span.startByte, span.endByte).toString();
const document = source => ({ source, sourceHash: hash(source), relativePath: 'not-on-disk/example.tsx', language: 'tsx' });
const analyze = (source, configuration = {}) => createAnalyzer({ ...digests, configuration }).analyze(document(source), parse(source).tree);
const viewOf = (source, moduleAliases = {}) => createTypeScriptView({ ...document(source), tree: parse(source).tree, moduleAliases });
const request = (source = '', options) => {
  const parsed = parse(source);
  return { version: 1, parser: parsed.parser, documents: source ? [{ ...document(source), tree: parsed.serialized }] : [], ...(options === undefined ? {} : { options }) };
};
function invoke(input) {
  const { NODE_OPTIONS, ...env } = process.env;
  return spawnSync(process.execPath, [resolve(packageRoot, 'worker.mjs')], {
    cwd: packageRoot, env, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 30_000, maxBuffer: 34 * 1024 * 1024,
  });
}

test('reviewed module identities come from the single owned catalog shared with evidence clients', async () => {
  const catalog = JSON.parse(await readFile(resolve(packageRoot, 'module_catalog.json'), 'utf8'));
  assert.deepEqual(Object.keys(catalog).sort(), ['MODULE_ALIAS_TARGETS', 'MODULE_FAMILIES']);
  assert.deepEqual(MODULE_FAMILIES, catalog.MODULE_FAMILIES);
  assert.deepEqual(MODULE_ALIAS_TARGETS, catalog.MODULE_ALIAS_TARGETS);
  assert(Object.isFrozen(MODULE_FAMILIES));
  assert(Object.isFrozen(MODULE_ALIAS_TARGETS));
  assert.equal(new Set(MODULE_FAMILIES).size, MODULE_FAMILIES.length);
  assert.equal(new Set(MODULE_ALIAS_TARGETS).size, MODULE_ALIAS_TARGETS.length);
  for (const family of MODULE_FAMILIES) {
    assert(MODULE_ALIAS_TARGETS.includes(family));
    assert.throws(() => normalizeModuleAliases({ [family]: 'solid-js' }));
  }
  for (const target of MODULE_ALIAS_TARGETS) assert(MODULE_FAMILIES.some(family => target === family || target.startsWith(`${family}/`)));
});

test('renamed SDK named and namespace imports use reviewed FST, Solid and component contracts', () => {
  const source = `import {component as define} from '@example/sdk/app/component';
import * as StateApi from '@example/sdk/app/state';
import * as Reactive from '@example/sdk/solid-js';
import {TextBox as Input} from '@example/controls';
class Model extends StateApi.State {}
export const Page=define(()=>{const [read,write]=Reactive.createSignal(''); return <Input value={read()} onChange={value=>write(value)}/>;});`;
  const result = analyze(source, { moduleAliases: aliases });
  assert.equal(facts(result, 'fst-solid.state').length, 1);
  assert.equal(facts(result, 'fst-solid.component').length, 1);
  assert.equal(facts(result, 'solid.signal-accessor').length, 1);
  assert.equal(facts(result, 'solid.signal-setter').length, 1);
  assert.equal(facts(result, 'fst-components.control').length, 1);
  assert.equal(facts(result, 'fst-solid.factory')[0].target.module, `${fst}/app/component`);
  assert.equal(facts(result, 'fst-solid.extends')[0].target.module, `${fst}/app/state`);
  assert.equal(facts(result, 'solid.factory')[0].target.module, `${fst}/solid-js`);
  assert.equal(facts(result, 'fst-components.import')[0].target.module, '@fst/components-fst-disco-ui');
  assert.equal(result.sourceHash, hash(source));
});

test('default empty aliases do not recognize renamed SDKs or infer framework identity from source names', () => {
  const source = `import {component} from '@example/sdk/app/component';
import {State} from '@example/sdk/app/state'; import {createSignal} from '@example/sdk/solid-js';
import {TextBox} from '@example/controls'; class Model extends State {}
export const Page=component(()=>{const [read,write]=createSignal('');return <TextBox value={read()}/>;});`;
  const unconfigured = analyze(source);
  assert.deepEqual(frameworkFacts(unconfigured), []);
  assert.deepEqual(analyze(source, { moduleAliases: {} }), unconfigured);
  assert.equal(unconfigured.reports.find(report => report.pluginId === 'fst-solid').state, 'not-applicable');
  assert.deepEqual(frameworkFacts(analyze('class State{} class Form{} class Local extends State{} function component(fn){return fn} const Page=component(()=>null);', { moduleAliases: aliases })), []);
});

test('all supported module families and explicit API submodule roots can be declared without package resolution', () => {
  const cases = [
    ['solid-js', 'import {createSignal} from "renamed"; const [get,set]=createSignal(0);', 'solid.signal-accessor'],
    ['solid-js/store', 'import * as Store from "renamed"; const [get,set]=Store.createStore({});', 'solid.store'],
    ['solid-js/web', 'import {render} from "renamed"; const dispose=render(()=>null,target);', 'solid.disposer'],
    ['@solidjs/router', 'import * as Router from "renamed"; const send=Router.action(async()=>1,"send");', 'solid.action'],
    [`${fst}/app/form`, 'import {Form as Base} from "renamed"; class Edit extends Base {}', 'fst-solid.form'],
    ['@fst/components-fst-disco-ui', 'import * as UI from "renamed"; const Page=()=> <UI.TextBox value=""/>;', 'fst-components.control'],
    ['@fst/components-fst-solid-icons/assets', 'import {loadIconDef as load} from "renamed"; const icon=load("a");', 'fst-components.asset-request'],
    ['@fst/components-fst-solid-threejs', 'import * as Three from "renamed"; const scene=new Three.Scene3d();', 'fst-components.scene'],
  ];
  for (const [target, source, term] of cases) {
    assert(facts(analyze(source, { moduleAliases: { renamed: target } }), term).length > 0, target);
    assert.equal(facts(analyze(source), term).length, 0, `default: ${target}`);
  }
  for (const target of MODULE_ALIAS_TARGETS) assert.equal(normalizeModuleAliases({ renamed: target }).renamed, target);
  assert.equal(new Set(MODULE_ALIAS_TARGETS).size, MODULE_ALIAS_TARGETS.length);
});

test('module identity lookup only maps actual static import and export source strings', () => {
  const source = `import * as SDK from '@example/sdk/app/state';
export {State as Base} from '@example/sdk/app/state'; export * from '@example/sdk/app/form';
const name='@example/sdk/app/state'; const object={'@example/sdk/app/state':1};
export {name as "@example/sdk/app/state"};
// @jsxImportSource @example/sdk/solid-js
const dynamic=import('@example/sdk/app/state'); const required=require('@example/sdk/app/state');`;
  const view = viewOf(source, aliases);
  const sources = view.nodes.filter(node => ['import_statement', 'export_statement'].includes(node.type) && node.fields.source).map(node => node.fields.source);
  assert.deepEqual(sources.map(node => view.moduleIdentity(node)), [`${fst}/app/state`, `${fst}/app/state`, `${fst}/app/form`]);
  for (const node of view.nodes.filter(node => node.type === 'string')) {
    assert.equal(view.name(node), view.text(node).slice(1, -1));
    if (!sources.includes(node)) assert.equal(view.moduleIdentity(node), undefined);
  }
  assert.equal(view.source, source);
  assert.equal(view.sourceHash, hash(source));
  assert(view.diagnostics.some(item => item.code === 'typescript.re-export'));
  assert.deepEqual(view.declarations.find(item => item.name === 'name').exports, ['@example/sdk/app/state']);
});

test('longest slash-boundary match is deterministic, case-sensitive, and never substring or chained resolution', () => {
  const moduleAliases = { pkg: fst, 'pkg/reactive': 'solid-js', 'pkg/reactive/store': 'solid-js/store', Other: 'solid-js' };
  const inputs = ['pkg', 'pkg/app/state', 'pkg/reactive', 'pkg/reactive/store', 'pkg/reactive/web', 'pkg/reactive-extra', 'pkg-extra/app/state', 'pkg2/app/state', './pkg/app/state', '/pkg/app/state', 'unrelated/pkg/app/state', 'other', 'Other'];
  const expected = [fst, `${fst}/app/state`, 'solid-js', 'solid-js/store', 'solid-js/web', `${fst}/reactive-extra`, 'pkg-extra/app/state', 'pkg2/app/state', './pkg/app/state', '/pkg/app/state', 'unrelated/pkg/app/state', 'other', 'solid-js'];
  const source = inputs.map((module, index) => `import * as M${index} from '${module}';`).join('\n');
  for (const config of [moduleAliases, Object.fromEntries(Object.entries(moduleAliases).reverse())]) {
    const view = viewOf(source, config);
    assert.deepEqual(view.nodes.filter(node => node.type === 'import_statement').map(node => view.moduleIdentity(node.fields.source)), expected);
  }
  for (const module of ['pkg-extra/app/state', 'pkg2/app/state', './pkg/app/state', 'other/pkg/app/state']) {
    assert.deepEqual(frameworkFacts(analyze(`import {State} from '${module}'; class Example extends State {}`, { moduleAliases })), []);
  }
  const first = createAnalyzer({ ...digests, configuration: { moduleAliases } });
  const reversed = createAnalyzer({ ...digests, configuration: { moduleAliases: Object.fromEntries(Object.entries(moduleAliases).reverse()) } });
  assert.deepEqual(first.manifest, reversed.manifest);
  assert.deepEqual(normalizeModuleAliases({ first: 'solid-js', second: 'solid-js' }), { first: 'solid-js', second: 'solid-js' });
  assert.throws(() => normalizeModuleAliases({ first: 'second', second: 'solid-js' }));
  assert.throws(() => normalizeModuleAliases({ first: 'solid-js', 'solid-js': fst }));
});

test('alias-matching traversal and non-bare specifiers stay explicitly unsupported rather than normalized', () => {
  for (const module of ['pkg/../app/state', 'pkg/./app/state', 'pkg//app/state', 'pkg/app/state/', 'pkg/app/state?x', 'pkg/%2e%2e/app/state']) {
    const result = analyze(`import {State} from '${module}'; class Example extends State {}`, { moduleAliases: { pkg: fst } });
    assert.equal(result.state, 'unsupported', module);
    assert.deepEqual(frameworkFacts(result), [], module);
    assert(result.diagnostics.some(item => item.code === 'typescript.module-alias-specifier'), module);
  }
});

test('declarations, property names, strings and comments do not acquire alias identities', () => {
  const source = `// @jsxImportSource reactive
const object={reactive:'reactive'}; function reactive(){return 1;} function createSignal(){return [1,2];}
class State {} class Example extends State {} const result=reactive(); const [get,set]=createSignal();
const Page=()=> <div onClick={()=>result}/>;`;
  const view = viewOf(source, { reactive: 'solid-js' });
  for (const node of view.nodes.filter(node => view.name(node) === 'reactive')) {
    assert.equal(view.moduleIdentity(node), undefined);
    assert.equal(view.name(node), 'reactive');
  }
  assert.deepEqual(frameworkFacts(analyze(source, { moduleAliases: { reactive: 'solid-js' } })), []);
});

test('configured aliases preserve imported-value shadowing, type-only and mutation negatives', () => {
  const cases = [
    `import {component} from '@example/sdk/app/component'; function use(component){return component(()=>null);}`,
    `import {State} from '@example/sdk/app/state'; function use(State){class Example extends State{}}`,
    `import type {State} from '@example/sdk/app/state'; class Example extends State{}`,
    `import * as SDK from '@example/sdk/app/state'; SDK.State=Foreign; class Example extends SDK.State{}`,
    `import * as SDK from '@example/sdk/app/component'; const alias=SDK; alias.component=other; const Page=SDK.component(()=>null);`,
    `import {createSignal} from '@example/sdk/solid-js'; function use(createSignal){const [get,set]=createSignal(0);}`,
    `import type {createSignal} from '@example/sdk/solid-js'; const [get,set]=createSignal(0);`,
    `import * as Reactive from '@example/sdk/solid-js'; Reactive.createSignal=other; const [get,set]=Reactive.createSignal(0);`,
    `import {TextBox} from '@example/controls'; function Page(TextBox){return <TextBox/>;}`,
    `import * as UI from '@example/controls'; UI.TextBox=other; const Page=()=> <UI.TextBox/>;`,
  ];
  for (const source of cases) assert.deepEqual(frameworkFacts(analyze(source, { moduleAliases: aliases })), [], source);
});

test('alias declarations do not expand canonical export contracts or relax lower-only analysis limits', () => {
  for (const [module, imported] of [
    ['@example/sdk', 'State'], ['@example/sdk/app', 'Form'], ['@example/sdk/app/component', 'State'],
    ['@example/sdk/not-a-reviewed-api', 'State'], ['@example/sdk/solid-js', 'State'],
  ]) {
    const source = `import {${imported} as Base} from '${module}'; class Example extends Base {}`;
    assert.deepEqual(frameworkFacts(analyze(source, { moduleAliases: aliases })), [], module);
  }
  const source = `import {component} from '@example/sdk/app/component'; const Page=component(()=>null);`;
  assert(facts(analyze(source, { moduleAliases: aliases }), 'fst-solid.component').length > 0);
  for (const limits of [{ maxFacts: 1 }, { maxWork: 1 }, { maxDeclarations: 1 }, { maxDepth: 1 }]) {
    const analyzer = createAnalyzer({ ...digests, configuration: { moduleAliases: aliases, limits } });
    const result = analyzer.analyze(document(source), parse(source).tree);
    assert.notEqual(result.state, 'complete');
    validateAnnotationResult(result, analyzer.manifest, source);
  }
});

test('canonicalized imports cannot also satisfy another producer through their raw module spelling', () => {
  for (const [source, plugin] of [
    ['import {z} from "zod"; const Schema=z.string(); function read(input){return Schema.parse(input);}', 'validation-contract'],
    ['import {Elysia} from "elysia"; const app=new Elysia(); app.get("/",()=>1); app.handle(new Request("http://local/"));', 'dispatch-binding'],
    ['import {EventEmitter} from "node:events"; const bus=new EventEmitter(); bus.on("item",()=>{}); bus.emit("item");', 'transport-binding'],
  ]) {
    // Protocol-prefixed modules cannot be configured; a bare producer identity can.
    if (plugin === 'transport-binding') {
      assert.throws(() => normalizeModuleAliases({ 'node:events': 'solid-js' }));
      continue;
    }
    const key = plugin === 'validation-contract' ? 'zod' : 'elysia';
    const result = analyze(source, { moduleAliases: { [key]: 'solid-js' } });
    assert.equal(result.facts.filter(fact => fact.evidence.pluginId === plugin).length, 0);
  }
});

test('Unicode, escaped import identities, CRLF, and repeated exact byte ranges survive alias analysis', () => {
  const source = '\uFEFF// \u{1f680}\r\nimport {field} from "@example/\\u0073dk/app/field";\r\nfunction use(){const title=field("\u{1f642}");title(maybe);title(maybe);}\r\n';
  const configured = analyze(source, { moduleAliases: aliases });
  const unconfigured = analyze(source);
  assert.equal(configured.sourceHash, hash(source));
  assert.deepEqual(configured.declarations, unconfigured.declarations);
  const dispatch = facts(configured, 'fst-solid.field-dispatch');
  assert.equal(dispatch.length, 2);
  assert.notEqual(dispatch[0].evidence.span.startByte, dispatch[1].evidence.span.startByte);
  assert(dispatch.every(fact => slice(source, fact.evidence.span) === 'title(maybe)'));
  assert(dispatch.every(fact => fact.evidence.span.startLine === 3 && fact.evidence.span.endLine === 3));
  const analyzer = createAnalyzer({ ...digests, configuration: { moduleAliases: aliases } });
  validateAnnotationResult(configured, analyzer.manifest, source);
  const view = viewOf(source, aliases), sourceNode = view.nodes.find(node => node.type === 'import_statement').fields.source;
  assert.equal(view.moduleIdentity(sourceNode), `${fst}/app/field`);
  assert.equal(view.text(sourceNode), '"@example/\\u0073dk/app/field"');
  assert.equal(view.name(sourceNode), '@example/sdk/app/field');
});

test('normalized configuration is retained, detached, immutable and bound to every analysis identity', () => {
  const input = { moduleAliases: { zeta: 'solid-js', alpha: fst }, limits: { maxWork: 1_000_000 } };
  const analyzer = createAnalyzer({ ...digests, configuration: input });
  const expected = { moduleAliases: { alpha: fst, zeta: 'solid-js' } };
  const expectedDigest = hash(canonicalJSON({ limits: analyzer.manifest.limits, ...expected }));
  assert.deepEqual(analyzer.configuration, expected);
  assert(Object.isFrozen(analyzer.configuration));
  assert(Object.isFrozen(analyzer.configuration.moduleAliases));
  assert.throws(() => { analyzer.configuration.moduleAliases.alpha = 'solid-js'; });
  input.moduleAliases.alpha = 'solid-js'; input.limits.maxWork = 1;
  assert.deepEqual(analyzer.configuration, expected);
  for (const descriptor of [analyzer.manifest.core, analyzer.manifest.view, ...analyzer.manifest.plugins]) assert.equal(descriptor.configurationDigest, expectedDigest);
  validateAnnotationManifest(analyzer.manifest, hash);
  const source = 'export const value=1;', parsed = parse(source);
  const result = analyzer.analyze(document(source), parsed.tree);
  assert.equal(result.analysisSetId, analyzer.manifest.id);
  for (const configuration of [{ moduleAliases: { alpha: fst, zeta: 'solid-js' } }, { limits: { maxWork: 1_000_000 } }, { limits: { maxWork: 1_000_000 }, moduleAliases: { alpha: 'solid-js', zeta: 'solid-js' } }]) {
    const changed = createAnalyzer({ ...digests, configuration });
    assert.notEqual(changed.manifest.id, analyzer.manifest.id);
    assert.notEqual(changed.analyze(document(source), parsed.tree).analysisSetId, result.analysisSetId);
    assert.equal(changed.manifest.core.implementationDigest, analyzer.manifest.core.implementationDigest);
  }
  const defaults = createAnalyzer(digests);
  assert.deepEqual(defaults.configuration, { moduleAliases: {} });
  assert.equal(createAnalyzer({ ...digests, configuration: { limits: {}, moduleAliases: {} } }).manifest.id, defaults.manifest.id);
});

test('strict options reject invalid types, unknown targets, non-bare paths, canonical remapping and limits', () => {
  const invalidAliases = [null, [], 'sdk', 1, false, { sdk: null }, { sdk: [] }, { sdk: {} }, { sdk: 'unknown' },
    { sdk: `${fst}/unreviewed` }, { sdk: `${fst}/app/../app/state` }, { sdk: 'solid-js/' }, { sdk: 'solid-js/store/unknown' },
    { './sdk': fst }, { '../sdk': fst }, { '/sdk': fst }, { 'C:/sdk': fst }, { 'file:sdk': fst }, { 'node:fs': fst },
    { '@scope': fst }, { '@scope/': fst }, { 'sdk/../api': fst }, { 'sdk/./api': fst }, { 'sdk//api': fst }, { 'sdk/': fst },
    { 'sdk\\api': fst }, { 'sdk?query': fst }, { 'sdk#fragment': fst }, { 'sdk/*': fst }, { 'sdk/%2e%2e': fst },
    { ' sdk': fst }, { 'sdk\n': fst }, { '\u00e9sdk': fst }, { '': fst }, { ['a'.repeat(257)]: fst },
    { [fst]: fst }, { [`${fst}/app`]: 'solid-js' }, { 'solid-js': 'solid-js' }, { 'solid-js/custom': fst },
    { '@fst/components-fst-disco-ui': fst }, { '@solidjs/router': fst },
    Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`sdk${index}`, 'solid-js'])),
  ];
  for (const moduleAliases of invalidAliases) assert.throws(() => createAnalyzer({ ...digests, configuration: { moduleAliases } }), JSON.stringify(moduleAliases));
  for (const configuration of [{ other: {} }, { moduleAliases: {}, limits: { other: 1 } }, { moduleAliases: {}, limits: { maxWork: 2_000_001 } }, { moduleAliases: {}, limits: { maxFacts: 0 } }, { moduleAliases: {}, limits: [] }, { moduleAliases: undefined }]) {
    assert.throws(() => createAnalyzer({ ...digests, configuration }));
  }
  let invoked = false;
  assert.throws(() => normalizeModuleAliases(Object.defineProperty({}, 'sdk', { enumerable: true, get() { invoked = true; return fst; } })));
  assert.equal(invoked, false);
  assert.throws(() => normalizeModuleAliases(Object.assign(Object.create({ inherited: fst }), { sdk: fst })));
  assert.throws(() => normalizeModuleAliases({ sdk: fst, [Symbol('hidden')]: fst }));
  assert.throws(() => normalizeModuleAliases(Object.defineProperty({ sdk: fst }, 'hidden', { value: fst })));
  const tooLarge = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`sdk${index}${'a'.repeat(120)}`, fst]));
  assert.throws(() => createAnalyzer({ ...digests, configuration: { moduleAliases: tooLarge } }), /limit/i);
});

test('both supplied and expanded effective configuration honor the exact 4096-byte bound', () => {
  const limits = createAnalyzer(digests).manifest.limits;
  const entries = Array.from({ length: 15 }, (_, index) => [`p${String(index).padStart(2, '0')}${'x'.repeat(249)}`, 'solid-js']);
  const moduleAliases = Object.fromEntries(entries);
  assert(Buffer.byteLength(canonicalJSON({ moduleAliases })) < 4096);
  const overage = Buffer.byteLength(canonicalJSON({ limits, moduleAliases })) - 4096;
  assert(overage > 0 && overage < entries.at(-1)[0].length - 3);
  assert.throws(() => createAnalyzer({ ...digests, configuration: { moduleAliases } }), /Normalized configuration limit/);
  entries.at(-1)[0] = entries.at(-1)[0].slice(0, -overage);
  const exact = Object.fromEntries(entries);
  assert.equal(Buffer.byteLength(canonicalJSON({ limits, moduleAliases: exact })), 4096);
  const analyzer = createAnalyzer({ ...digests, configuration: { moduleAliases: exact } });
  assert.equal(analyzer.manifest.core.configurationDigest, hash(canonicalJSON({ limits, moduleAliases: exact })));
  assert.deepEqual(analyzer.manifest, createAnalyzer({ ...digests, configuration: { limits, moduleAliases: exact } }).manifest);
});

test('protocol payload carries readable caller-declared aliases with exact original source and manifest-only provenance', () => {
  const source = `import {State} from '@example/sdk/app/state'; export class Example extends State {}`;
  const input = request(source, { moduleAliases: aliases });
  const result = processRequest(input);
  assert.deepEqual(result.producer.configuration, { moduleAliases: Object.fromEntries(Object.entries(aliases).sort()) });
  assert.equal(result.documents[0].source, source);
  assert.equal(result.documents[0].result.sourceHash, hash(source));
  assert.equal(facts(result.documents[0].result, 'fst-solid.state').length, 1);
  assert.equal(result.documents[0].result.analysisSetId, result.manifest.id);
  validateAnnotationManifest(result.manifest, hash);
  validateAnnotationResult(result.documents[0].result, result.manifest, source);
  const empty = processRequest({ ...input, documents: [] });
  assert.deepEqual(empty.producer, result.producer);
  assert.deepEqual(empty.manifest, result.manifest);
  assert.deepEqual(empty.documents, []);
  const run = invoke(input);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), result);
  assert.equal(invoke(input).stdout, run.stdout);
});

test('duplicate configuration keys, including escape-equivalent aliases, fail closed before JSON collapsing', () => {
  const base = JSON.stringify(request()).slice(0, -1);
  for (const options of [
    '"options":{"moduleAliases":{"sdk":"solid-js","sdk":"solid-js"}}',
    '"options":{"moduleAliases":{"sdk":"solid-js","sdk":"@fst/components-fst-solid"}}',
    '"options":{"moduleAliases":{"sdk":"solid-js","\\u0073dk":"@fst/components-fst-solid"}}',
    '"options":{"moduleAliases":{},"moduleAliases":{"sdk":"solid-js"}}',
    '"options":{"moduleAliases":{}},"options":{"moduleAliases":{"sdk":"solid-js"}}',
  ]) {
    const run = invoke(`${base},${options}}`);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(JSON.parse(run.stderr).error.code, 'invalid-json');
  }
  const wrongTarget = invoke(request('', { moduleAliases: { sdk: 'unsupported' } }));
  assert.equal(wrongTarget.status, 1);
  assert.equal(JSON.parse(wrongTarget.stderr).error.code, 'invalid-configuration');
  const unknownOption = invoke(request('', { moduleAliases: aliases, sdkPaths: ['sdk'] }));
  assert.equal(JSON.parse(unknownOption.stderr).error.code, 'invalid-request');
});
