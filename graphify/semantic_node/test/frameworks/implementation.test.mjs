import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule, hash as sha256 } from '../helpers.mjs';
import { analyzeSource, annotationManifest, inspectSource, sourceParams } from './harness.mjs';
const { createImplementationPlugin } = await loadModule('src/producers/implementation-plugin.ts');
const { implementationRules, implementationSpan } = await loadModule('src/producers/implementation-vocabulary.ts');
const { createAnnotationEngine, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');

const field = (unit, name) => unit.facts.find(fact => fact.term === `implementation.${name}`)?.value?.value;
const fields = (unit, name) => unit.facts.filter(fact => fact.term === `implementation.${name}`).map(fact => fact.value.value);
function units(result, role) {
  const grouped = new Map();
  for (const fact of result.facts.filter(fact => fact.evidence.pluginId === 'implementation')) {
    const key = canonicalJSON(fact.evidence);
    const unit = grouped.get(key) ?? { facts: [], evidence: fact.evidence };
    unit.facts.push(fact); grouped.set(key, unit);
  }
  return [...grouped.values()].filter(unit => field(unit, 'unit-complete') === true && (!role || unit.facts.some(fact => fact.kind === 'role' && fact.term === `implementation.${role}`)));
}
function spanText(source, span) { return Buffer.from(source).subarray(span.startByte, span.endByte).toString('utf8'); }
function text(source, locator) {
  assert.match(locator, /^s:\d+:\d+:\d+:\d+$/);
  const [, startByte, endByte, startLine, endLine] = locator.split(':').map(Number);
  const value = spanText(source, { startByte, endByte });
  assert.equal(Buffer.byteLength(Buffer.from(source).subarray(0, startByte).toString('utf8')), startByte);
  assert.equal(source.slice(0, Buffer.from(source).subarray(0, startByte).toString('utf8').length).split('\n').length, startLine);
  assert.equal(Buffer.from(source).subarray(0, endByte).toString('utf8').replace(/\n$/, '').split('\n').length, endLine);
  return value;
}
async function analyze(source, options = {}) {
  const params = sourceParams(source, { relativePath: options.path ?? 'renamed/source.ts', language: options.language ?? 'typescript' });
  const published = await annotationManifest();
  const manifest = structuredClone(published);
  manifest.plugins = manifest.plugins.filter(plugin => plugin.id === 'implementation');
  Object.assign(manifest.limits, options.limits);
  const { id, ...body } = manifest;
  manifest.id = sha256(canonicalJSON(body));
  const descriptor = manifest.plugins[0];
  const engine = createAnnotationEngine({ manifest, plugins: [createImplementationPlugin(descriptor)], digest: sha256 });
  const result = await inspectSource(params, source, tree => engine.analyze(
    { source, sourceHash: params.sourceHash, relativePath: params.relativePath, language: params.language },
    createTypeScriptView({ tree, source, sourceHash: params.sourceHash, relativePath: params.relativePath, language: params.language, limits: manifest.limits }),
    options.cancelled ? { cancelled: options.cancelled } : undefined,
  ));
  validateAnnotationResult(result, manifest, source);
  assert.notEqual(result.reports[0].state, 'failed', JSON.stringify(result));
  return result;
}

test('local outcomes and writes retain exact occurrence, lexical callable, guards and polarity', async () => {
  const source = 'export function transform(input) { if (input.ready) { input.count += delta; return input; } else { throw failure; } }\n'
    + 'const more = () => { count++; if (enabled) run(() => { return nested; }); return fallback; };\n'
    + 'const choose = ready ? (left = value) : (right = other);';
  const result = await analyze(source);
  assert.equal(result.state, 'complete');
  const returns = units(result, 'return');
  assert.equal(returns.length, 3);
  const guarded = returns.find(unit => text(source, field(unit, 'value')) === 'input');
  assert.equal(text(source, field(guarded, 'if-true')), '(input.ready)');
  assert.match(text(source, field(guarded, 'owner')), /^export|^function transform/);
  const thrown = units(result, 'throw')[0];
  assert.equal(text(source, field(thrown, 'if-false')), '(input.ready)');
  assert.equal(text(source, field(thrown, 'value')), 'failure');
  const nested = returns.find(unit => text(source, field(unit, 'value')) === 'nested');
  assert.equal(text(source, field(nested, 'owner')), '() => { return nested; }');
  assert.equal(field(nested, 'if-true'), undefined, 'creation guard is not callback execution guard');
  const fallback = returns.find(unit => text(source, field(unit, 'value')) === 'fallback');
  assert.equal(field(fallback, 'if-false'), undefined, 'no inferred early-return fallthrough');
  assert.equal(units(result, 'update').length, 1);
  assert.equal(field(units(result, 'update')[0], 'operator'), '++');
  const assignments = units(result, 'assignment');
  assert.equal(assignments.length, 3);
  assert.equal(field(assignments.find(unit => field(unit, 'operator') === '+='), 'if-true'), field(guarded, 'if-true'));
  assert.equal(assignments.filter(unit => field(unit, 'conditional-true')).length, 1);
  assert.equal(assignments.filter(unit => field(unit, 'conditional-false')).length, 1);
});

test('loop, try, switch and short-circuit bodies remain lexical partial evidence', async () => {
  const source = 'function action(items) { for (const item of items) { try { if (item) return item; } catch { throw problem; } finally { value = next; } } switch (value) { case 1: return value; } enabled && count++; return done; }';
  const result = await analyze(source);
  assert.equal(result.state, 'partial');
  assert.ok(result.reports[0].diagnostics.some(item => item.code === 'implementation.control-context'));
  const first = units(result, 'return').find(unit => text(source, field(unit, 'value')) === 'item');
  assert.ok(fields(first, 'condition').includes('loop-context'));
  assert.ok(fields(first, 'condition').includes('try-context'));
  assert.equal(text(source, field(first, 'if-true')), '(item)');
  assert.ok(fields(units(result, 'update')[0], 'condition').includes('short-circuit-context'));
  assert.ok(!JSON.stringify(result.facts).includes('transaction'));
  assert.equal(field(units(result, 'return').find(unit => text(source, field(unit, 'value')) === 'done'), 'if-false'), undefined);
});

test('qualified environment APIs capture safe keys and default semantics without values', async () => {
  const source = 'import proc from "node:process"; import { env as settings } from "process";\n'
    + 'const KEY = "REGION"; const first = proc.env[KEY] ?? "never-copy-secret-one";\n'
    + 'const second = settings.MODE || "never-copy-secret-two";\n'
    + 'const third = import.meta.env["ORIGIN"] ?? privateDefault;\n'
    + 'function load() { return process.env.NAME ?? "never-copy-secret-three"; }\n'
    + 'const { TOKEN: renamed = "never-copy-secret-four", LIMIT = "never-copy-secret-five", MODE } = proc.env;';
  const result = await analyze(source);
  const reads = units(result, 'config-read');
  assert.equal(reads.length, 7, JSON.stringify(result));
  assert.deepEqual(reads.map(unit => field(unit, 'config-key')).sort(), ['LIMIT', 'MODE', 'MODE', 'NAME', 'ORIGIN', 'REGION', 'TOKEN']);
  const region = reads.find(unit => field(unit, 'config-key') === 'REGION');
  assert.equal(field(region, 'config-provenance'), 'import-bound');
  assert.equal(field(region, 'fallback-semantics'), 'nullish');
  assert.equal(text(source, field(region, 'fallback')), '"never-copy-secret-one"');
  assert.equal(reads.filter(unit => field(unit, 'fallback-semantics') === 'falsy').length, 1);
  assert.equal(reads.filter(unit => field(unit, 'fallback-semantics') === 'undefined').length, 2);
  assert.equal(field(reads.find(unit => field(unit, 'config-key') === 'NAME'), 'config-provenance'), 'ambient-assumed');
  assert.ok(fields(reads.find(unit => field(unit, 'config-key') === 'NAME'), 'condition').includes('ambient-api-assumed'));
  assert.equal(field(reads.find(unit => field(unit, 'config-key') === 'ORIGIN'), 'config-provenance'), 'syntax');
  assert.ok(!JSON.stringify(result.facts).includes('never-copy-secret'));
  assert.ok(!result.facts.some(fact => /visibility|secret|public|phase/.test(fact.term)));
});

test('dynamic keys, unsupported destructuring and optional env reads are explicit partials', async () => {
  const source = 'import proc from "node:process"; const x = proc.env[dynamic]; const y = import.meta.env?.MAYBE; const { [dynamic]: value, ...rest } = proc.env;';
  const result = await analyze(source);
  assert.equal(units(result, 'config-read').length, 0);
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.reports[0].diagnostics.map(item => item.code).sort(), ['implementation.config-key', 'implementation.config-pattern']);
  for (const source of [
    'import proc from "node:process"; const value = proc?.env.KEY;',
    'const value = import.meta?.env.KEY;',
    'const value = process.env;',
    `const value = process.env.${'A'.repeat(129)};`,
    'const KEY = "REGION"; function load(KEY) { return process.env[KEY]; }',
  ]) {
    const result = await analyze(source);
    assert.equal(units(result, 'config-read').length, 0, source);
    assert.equal(result.state, 'partial', source);
  }
});

test('shadowed globals, ordinary objects, type-only or replaced imports are not config contracts', async () => {
  for (const source of [
    'const process = { env: { KEY: "value" } }; const read = process.env.KEY;',
    'function load(process) { return process.env.KEY; }',
    'function load() { const value = process.env.KEY; const process = local; return value; }',
    'const object = { env: { PUBLIC_PASSWORD: "value" } }; const read = object.env.PUBLIC_PASSWORD;',
    'import type proc from "node:process"; const read = proc.env.KEY;',
    'import proc from "custom-process"; const read = proc.env.KEY;',
    'import proc from "node:process"; proc.env = {}; const read = proc.env.KEY;',
    'process.env.KEY = value; delete process.env.OTHER;',
    'process.env = fake; const read = process.env.KEY;',
    'function f(process, process) { return process.env.KEY; }',
  ]) {
    const result = await analyze(source);
    assert.equal(units(result, 'config-read').length, 0, source);
  }
});

test('renamed runner imports own assertions by exact anonymous callback, not module or title', async () => {
  const source = 'import { test as register, expect as check } from "bun:test";\n'
    + 'register("same", () => { check(first).toBe(expectedFirst); });\n'
    + 'register("same", async () => { await check(second).resolves.not.toEqual(expectedSecond); });';
  const result = await analyze(source);
  const tests = units(result, 'test'), assertions = units(result, 'assertion');
  assert.equal(tests.length, 2); assert.equal(assertions.length, 2);
  assert.notEqual(field(tests[0], 'callback'), field(tests[1], 'callback'));
  for (const assertion of assertions) {
    const matching = tests.filter(unit => field(unit, 'callback') === field(assertion, 'test-owner'));
    assert.equal(matching.length, 1);
    assert.equal(field(assertion, 'owner'), field(assertion, 'test-owner'));
    assert.ok(text(source, field(matching[0], 'callback')).includes(text(source, field(assertion, 'actual'))));
  }
  const asyncAssertion = assertions.find(unit => field(unit, 'async-mode') === 'resolves');
  assert.equal(field(asyncAssertion, 'negated'), true); assert.equal(field(asyncAssertion, 'awaited'), true);
  const sync = assertions.find(unit => field(unit, 'async-mode') === 'sync');
  assert.equal(field(sync, 'negated'), false); assert.equal(field(sync, 'awaited'), false);
  assert.ok(!JSON.stringify(result.facts).includes('expectedFirst'));
});

test('reviewed vitest namespaces and node:test/node:assert bindings work after renaming', async () => {
  for (const [source, matcher] of [
    ['import * as suite from "vitest"; suite.it("case", () => { suite.expect(actual).not.toBeNull(); });', 'toBeNull'],
    ['import run from "node:test"; import verify from "node:assert/strict"; run("case", () => { verify.equal(actual, expected); });', 'equal'],
    ['import { it as run } from "node:test"; import { strictEqual as verify } from "node:assert"; run("case", () => { verify(actual, expected); });', 'strictEqual'],
  ]) {
    const result = await analyze(source, { path: 'unrelated/moved-file.ts' });
    assert.equal(units(result, 'test').length, 1, source);
    assert.equal(units(result, 'assertion').length, 1, JSON.stringify(result));
    assert.equal(field(units(result, 'assertion')[0], 'matcher'), matcher);
  }
});

test('fake/local expect, unsupported runner shapes and nested callbacks never mix assertions', async () => {
  const source = 'import { test, expect } from "vitest";\n'
    + 'test("outer", () => { expect(first).toBe(value); run(() => { expect(nested).toBe(value); }); test("inner", () => { expect(inner).toBe(other); }); });\n'
    + 'test("fake", (expect) => { expect(fake).toBe(value); });\n'
    + 'test.each([1])("unsupported", () => { expect(ignored).toBe(value); });\n'
    + 'expect(topLevel).toBe(value);';
  const result = await analyze(source);
  assert.equal(units(result, 'test').length, 3);
  assert.equal(units(result, 'assertion').length, 2, JSON.stringify(result));
  assert.deepEqual(units(result, 'assertion').map(unit => text(source, field(unit, 'actual'))).sort(), ['first', 'inner']);
  assert.equal(result.state, 'partial');
  assert.ok(result.reports[0].diagnostics.some(item => item.code === 'implementation.assertion-owner'));
  assert.ok(result.reports[0].diagnostics.some(item => item.code === 'implementation.test-shape'));
  for (const fake of [
    'function test(name, callback) {} function expect(value) {} test("case", () => { expect(value).toBe(other); });',
    'import { test, expect } from "lookalike"; test("case", () => { expect(value).toBe(other); });',
    'import type { test, expect } from "vitest"; test("case", () => { expect(value).toBe(other); });',
    'import { test, expect } from "vitest"; expect.toBe = custom; test("case", () => { expect(value).toBe(other); });',
  ]) assert.equal(units(await analyze(fake), 'assertion').length, 0, fake);
});

test('unreviewed assertion chains and arities report partial rather than invented matcher flags', async () => {
  for (const assertion of ['expect(value).toCustom(other)', 'expect(value).resolves.rejects.toBe(other)', 'expect(value).not.not.toBe(other)', 'expect(value, message).toBe(other)', 'expect(value).toBe(...values)', 'expect(value)?.toBe(other)', 'expect(value)?.not.toBe(other)', 'expect(value).resolves?.not.toBe(other)']) {
    const result = await analyze(`import { test, expect } from "vitest"; test("case", () => { ${assertion}; });`);
    assert.equal(units(result, 'assertion').length, 0, assertion);
    assert.equal(result.state, 'partial', assertion);
  }
  for (const source of [
    'import * as suite from "vitest"; suite?.test("case", () => {});',
    'import { test } from "vitest"; import * as suite from "vitest"; test("case", () => { suite?.expect(value).toBe(other); });',
    'import { test } from "node:test"; import check from "node:assert/strict"; test("case", () => { check?.equal(value, other); });',
  ]) {
    const result = await analyze(source);
    assert.equal(units(result, 'assertion').length, 0, source);
    assert.equal(result.state, 'partial', source);
  }
});

test('UTF8 and CRLF span locators preserve precise nodes and all guard branches', async () => {
  const source = '// \u4e2d\ud83d\ude00\r\nfunction r\u00e9sultat(entr\u00e9e) {\r\n if (entr\u00e9e) { return "\u4e2d\ud83d\ude00"; } else if (other) { throw problem; } else { count--; }\r\n}\r\n';
  const result = await analyze(source);
  const returned = units(result, 'return')[0];
  assert.equal(text(source, field(returned, 'value')), '"\u4e2d\ud83d\ude00"');
  assert.equal(spanText(source, returned.evidence.span), 'return "\u4e2d\ud83d\ude00";');
  assert.equal(returned.evidence.span.startLine, 3);
  assert.equal(fields(units(result, 'throw')[0], 'if-true').length, 1);
  assert.equal(fields(units(result, 'throw')[0], 'if-false').length, 1);
  assert.equal(fields(units(result, 'update')[0], 'if-false').length, 2);
  assert.equal(implementationSpan(returned.evidence.span), `s:${returned.evidence.span.startByte}:${returned.evidence.span.endByte}:3:3`);
});

test('fact, output, diagnostic and work budgets cannot manufacture completed units or coverage', async () => {
  const simple = 'function local() { if (ready) return result; throw error; }';
  const limited = await analyze(simple, { limits: { maxFacts: 2 } });
  assert.equal(limited.state, 'truncated'); assert.equal(units(limited).length, 0); assert.ok(limited.facts.length <= 2);
  const output = await analyze(simple.repeat(3), { limits: { maxResultBytes: 1600 } });
  assert.equal(output.state, 'truncated'); assert.ok(Buffer.byteLength(canonicalJSON(output)) <= 1600);
  const dynamic = 'const config = process.env[key]; const { ...rest } = process.env;';
  const diagnostics = await analyze(dynamic, { limits: { maxDiagnostics: 1 } });
  assert.equal(diagnostics.state, 'truncated'); assert.equal(diagnostics.reports[0].diagnostics.length, 1);
  const work = await analyze(simple, { limits: { maxWork: 30 } });
  assert.equal(work.state, 'truncated');
  const pluginWork = await analyze('const config = process.env.KEY;', { limits: { maxWork: 400 } });
  assert.equal(pluginWork.state, 'truncated');
  assert.ok(pluginWork.reports[0].diagnostics.some(item => item.code === 'core.budget-limit' && item.message.includes('resource=work')));
  const cancelled = await analyze(simple, { cancelled: () => true });
  assert.equal(cancelled.state, 'truncated'); assert.equal(units(cancelled).length, 0);
  const many = await analyze(`function run() { ${'value++;'.repeat(140)} }`);
  assert.equal(many.state, 'truncated'); assert.equal(units(many).length, implementationRules.maxUnits);
  const tinyValue = await analyze(simple, { limits: { maxValueBytes: 32 } });
  assert.equal(tinyValue.state, 'truncated'); assert.equal(units(tinyValue).length, 0);
});


test('renamed paths, symbols and TSX retain semantic unit shapes without project heuristics', async () => {
  const source = 'import { test as register, expect as check } from "vitest"; function action(value) { if (value) return value; } register("case", () => { check(action(input)).toBe(expected); }); const view = <div/>;';
  const renamed = source.replaceAll('action', 'another').replaceAll('value', 'other').replaceAll('register', 'scenario').replaceAll('check', 'verify');
  const a = await analyze(source, { path: 'feature/one.tsx', language: 'tsx' });
  const b = await analyze(renamed, { path: 'unrelated/elsewhere.tsx', language: 'tsx' });
  assert.notEqual(a.sourceHash, b.sourceHash);
  const shape = result => units(result).map(unit => unit.facts.map(fact => [fact.kind, fact.term, fact.value?.kind]).sort()).sort();
  assert.deepEqual(shape(a), shape(b));
  assert.equal(units(b, 'assertion').length, 1);
});
