import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule, hash, parse } from '../helpers.mjs';
import { analyzeSource, fixtureDigests } from './harness.mjs';

const { createAnalyzer } = await loadModule('src/analysis.ts');
const { canonicalJSON, validateAnnotationManifest } = await loadModule('src/core/index.ts');
const facts = (result, term) => result.facts.filter(fact => fact.term === term);
const values = (result, term) => facts(result, term).map(fact => fact.value?.value);
const text = (source, span) => Buffer.from(source).subarray(span.startByte, span.endByte).toString('utf8');

test('the owned analyzer composes exactly seven content-bound producers and immutable limits', () => {
  const analyzer = createAnalyzer(fixtureDigests), manifest = analyzer.manifest;
  assert.deepEqual(manifest.plugins.map(plugin => plugin.id), ['dispatch-binding', 'fst-components', 'fst-solid', 'implementation', 'solid', 'transport-binding', 'validation-contract']);
  const { id, ...body } = manifest;
  assert.equal(id, hash(canonicalJSON(body)));
  validateAnnotationManifest(manifest, hash);
  for (const plugin of manifest.plugins) assert.equal(plugin.implementationDigest, fixtureDigests.implementationDigest);
  assert.equal(manifest.core.implementationDigest, fixtureDigests.implementationDigest);
  assert.equal(manifest.view.implementationDigest, fixtureDigests.implementationDigest);
  assert.equal(createAnalyzer({ ...fixtureDigests, configuration: { limits: {} } }).manifest.id, id);
  assert.notEqual(createAnalyzer({ ...fixtureDigests, parserDigest: hash('another-parser') }).manifest.id, id);
  assert.notEqual(createAnalyzer({ ...fixtureDigests, implementationDigest: hash('another-owned-build') }).manifest.id, id);
  const limited = createAnalyzer({ ...fixtureDigests, configuration: { limits: { maxFacts: 100 } } }).manifest;
  assert.notEqual(limited.id, id);
  assert.notEqual(limited.plugins[0].configurationDigest, manifest.plugins[0].configurationDigest);
  assert.throws(() => { manifest.limits.maxFacts = 1; });
  assert.throws(() => { manifest.plugins[0].roles.push({ id: 'forged', label: 'forged' }); });
  for (const configuration of [{ moduleAliases: { local: 'unreviewed-sdk' } }, { sdkPaths: ['app'] }, { limits: { maxWork: 2_000_001 } }, { limits: { maxFacts: 0 } }, { limits: { unknown: 1 } }, { limits: [] }, { limits: null }, null, []]) {
    assert.throws(() => createAnalyzer({ ...fixtureDigests, configuration }));
  }
  assert.throws(() => createAnalyzer({ ...fixtureDigests, implementationDigest: 'invented' }));
});

test('context prefix lookup records nearest unambiguous ancestor and explicit depth, never current-only', () => {
  const source = `import {getContextDataLike as lookup} from '@fst/components-fst-solid/app/component';
function use(){ const a=lookup('item'); const b=lookup('item',1); const c=lookup('item',3); const d=lookup('item',depth); }`;
  const result = analyzeSource(source);
  const policies = facts(result, 'fst-solid.api-policy').filter(fact => fact.value.value.includes('nearest-prefix'));
  assert.equal(policies.length, 4);
  for (const fact of policies) {
    assert.match(fact.value.value, /current-then-ancestors/);
    assert.match(fact.value.value, /stop-with-null-on-ambiguity/);
    assert.match(fact.value.value, /depth-argument-limits-contexts/);
    assert.match(fact.value.value, /nullish-depth-default-500/);
    assert.match(fact.value.value, /no-merged-ancestors/);
  }
  assert.deepEqual(facts(result, 'fst-solid.source').map(fact => text(source, fact.target.span)).sort(), ['1', '3', 'depth']);
  assert(!JSON.stringify(result.facts).includes('prefix-current-context-only'));
});

test('Form has no inherited onError API and custom names do not acquire a contract', () => {
  for (const members of ['', 'onError(callback) { callback(); }']) {
    const result = analyzeSource(`import {Form} from '@fst/components-fst-solid/app/form'; class Edit extends Form {${members}} const form=Edit.new(); form.onError(handler);`);
    assert(!values(result, 'fst-solid.api-operation').includes('form.error-observe'));
    assert(!facts(result, 'fst-solid.callback').some(fact => fact.target.name === 'handler'));
  }
});

test('Scope and ItemScope initLoad declarations are conditional initialization hooks, not DOM mount', () => {
  const source = `import {Scope,ItemScope} from '@fst/components-fst-solid/app/scope';
class Rows extends Scope { async initLoad(){ return loadRows(); } }
class Row extends ItemScope { initLoad(){ return loadRow(); } }
class Other extends Foreign { initLoad(){} }
class Static extends Scope { static initLoad(){} }
class Getter extends Scope { get initLoad(){return handler;} }`;
  const result = analyzeSource(source);
  assert.deepEqual(values(result, 'fst-solid.hook-kind').sort(), ['item-scope.initLoad', 'scope.initLoad']);
  assert.equal(facts(result, 'fst-solid.lifecycle-hook').length, 2);
  const policies = values(result, 'fst-solid.api-policy').filter(value => value.includes('initLoad'));
  assert.equal(policies.length, 2);
  assert(policies.every(value => value.includes('finally') && value.includes('unproven')));
});

for (const module of ['solid-js', '@fst/components-fst-solid/solid-js']) test(`lifecycle source semantics for ${module} distinguish owner cleanup, untracked mount and same callback return`, () => {
  const source = `import {onMount as mount,onCleanup as cleanup,createSignal,createEffect} from '${module}';
function setup(){const [read,set]=createSignal(0); function dispose(){} const manual=cleanup(dispose); manual();
mount(()=>{read(); return ()=>set(1);}); createEffect(()=>{cleanup(()=>set(2)); read();});}`;
  const result = analyzeSource(source);
  assert.equal(facts(result, 'solid.api-call').filter(fact => ['onMount', 'onCleanup'].includes(fact.target.name)).length, 3);
  assert(values(result, 'solid.callback-role').includes('mount effect body'));
  assert(values(result, 'solid.callback-role').includes('current-owner cleanup'));
  assert(values(result, 'solid.boundary').some(value => value.includes('server onMount is a no-op')));
  assert(values(result, 'solid.return-contract').includes('callback return is not cleanup registration'));
  assert.equal(facts(result, 'solid.returned-callback').length, 1);
  assert.equal(facts(result, 'solid.untracked-read').filter(fact => text(source, fact.evidence.span) === 'read()').length, 1);
  assert.equal(facts(result, 'solid.potential-read').length, 1);
  assert(!facts(result, 'solid.callback').some(fact => fact.target.text === '()=>set(1)'));
});

test('bare lifecycle lookalikes, shadowed imports, mutation and unsupported arity are not registration facts', () => {
  for (const source of [
    `import {onMount,onCleanup} from './foreign'; function setup(){onMount(fn);onCleanup(fn);}`,
    `import {onMount,onCleanup} from 'solid-js'; function setup(onMount,onCleanup){onMount(fn);onCleanup(fn);}`,
    `import type {onMount,onCleanup} from 'solid-js'; function setup(){onMount(fn);onCleanup(fn);}`,
    `import * as S from 'solid-js'; S.onMount=other; S.onCleanup=other; function setup(){S.onMount(fn);S.onCleanup(fn);}`,
    `import {onMount,onCleanup} from 'solid-js'; function setup(){onMount();onCleanup(...callbacks);}`,
  ]) {
    const result = analyzeSource(source);
    assert.equal(facts(result, 'solid.api-call').length, 0);
    assert.equal(facts(result, 'solid.callback').length, 0);
    assert.equal(facts(result, 'solid.cleanup-callback').length, 0);
  }
});

test('repeated occurrences and Unicode spans survive full composition without guessed SDK identities', () => {
  const source = '\uFEFF// \u{1f680}\r\nimport {field} from "@fst/components-fst-solid/app/field";\r\nfunction use(){const title=field("\u{1f642}"); title(maybe);title(maybe);}\r\n';
  const result = analyzeSource(source, { relativePath: 'any/location.ts' });
  const dispatch = facts(result, 'fst-solid.field-dispatch');
  assert.equal(dispatch.length, 2);
  assert.notEqual(dispatch[0].evidence.span.startByte, dispatch[1].evidence.span.startByte);
  assert(dispatch.every(fact => text(source, fact.evidence.span) === 'title(maybe)'));
  assert.equal(facts(result, 'fst-solid.field-argument').length, 2);
  const foreign = analyzeSource('class State{}; class Login extends State{}; function component(fn){return fn} const C=component(()=>null);', { relativePath: 'app/sdk/solid.ts' });
  assert(!foreign.facts.some(fact => ['fst-solid', 'solid', 'fst-components'].includes(fact.evidence.pluginId)));
});

test('composition rejects stale source hashes before analyzing a supplied tree', () => {
  const source = 'const value=1;', parsed = parse(source, 'typescript');
  try {
    const analyzer = createAnalyzer(fixtureDigests);
    assert.throws(() => analyzer.analyze({ source, sourceHash: hash('other'), relativePath: 'fixture.ts', language: 'typescript' }, parsed.tree), /Source snapshot mismatch/);
  } finally { parsed.close(); }
});
