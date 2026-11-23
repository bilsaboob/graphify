import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule, hash as sha256 } from '../helpers.mjs';
import { analyzeSource, annotationManifest, inspectSource, sourceParams } from './harness.mjs';
const { createValidationContractPlugin } = await loadModule('src/producers/validation-contract-plugin.ts');
const { validationContractDescriptor, validationContractRules: rules, validationContractSpan } = await loadModule('src/producers/validation-contract-vocabulary.ts');
const { createAnnotationEngine, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');

const prefix = 'import { z as v } from "zod";\n';
const shape = 'v.object({ name: v.string().min(2).max(8), count: v.number().min(-2).max(10), ok: v.boolean() })';
const use = (schema = shape, mode = 'parse', name = 'accept') => `export function ${name}(input: unknown) { return ${schema}.${mode}(input); }`;
const facts = result => result.facts.filter(fact => fact.evidence.pluginId === 'validation-contract');
const report = result => result.reports.find(report => report.pluginId === 'validation-contract');
const field = (unit, name) => unit.facts.find(fact => fact.term === `validation-contract.${name}`)?.value?.value;
function units(result, role) {
  const grouped = new Map();
  for (const fact of facts(result)) {
    const key = canonicalJSON({ subject: fact.subject, evidence: fact.evidence });
    const unit = grouped.get(key) ?? { subject: fact.subject, evidence: fact.evidence, facts: [] };
    unit.facts.push(fact); grouped.set(key, unit);
  }
  return [...grouped.values()].filter(unit => field(unit, 'unit-complete') === true && (!role || unit.facts.some(fact => fact.kind === 'role' && fact.term === `validation-contract.${role}`)));
}
function text(source, locator) {
  assert.match(locator, /^s:\d+:\d+:\d+:\d+$/);
  const [, start, end, startLine, endLine] = locator.split(':').map(Number);
  const bytes = Buffer.from(source);
  assert.equal(bytes.subarray(0, start).toString('utf8').split('\n').length, startLine);
  assert.equal(bytes.subarray(0, end).toString('utf8').replace(/\n$/, '').split('\n').length, endLine);
  return bytes.subarray(start, end).toString('utf8');
}
function analyze(source, options = {}) {
  return analyzeSource(source, { relativePath: options.path ?? 'neutral/validation-contract.ts', language: options.language ?? 'typescript', limits: options.limits });
}

test('actual parse-only fixture emits exact import/owner/parameter/schema/call/predicate spans', async () => {
  const source = prefix + use();
  const result = await analyze(source);
  assert.equal(report(result).state, 'complete');
  const uses = units(result, 'validation-use'), atoms = units(result, 'validation-predicate');
  assert.equal(uses.length, 1); assert.equal(atoms.length, 7);
  const unit = uses[0];
  assert.equal(text(source, field(unit, 'import')), 'z as v');
  assert.deepEqual(field(unit, 'import-reference'), { kind: 'import', module: 'zod', name: 'z' });
  assert.equal(text(source, field(unit, 'owner')), use().replace(/^export /, ''));
  assert.equal(text(source, field(unit, 'parameter')), 'input');
  assert.equal(text(source, field(unit, 'argument')), 'input');
  assert.equal(text(source, field(unit, 'schema')), shape);
  assert.equal(text(source, field(unit, 'call')), `${shape}.parse(input)`);
  assert.equal(text(source, field(unit, 'return')), `return ${shape}.parse(input);`);
  assert.equal(text(source, field(unit, 'method')), 'parse');
  assert.equal(field(unit, 'predicate-count'), 7); assert.equal(field(unit, 'use-count'), 1);
  assert.equal(field(unit, 'inventory-complete'), true);
  assert.equal(field(unit, 'return-target'), 'return');
  for (const atom of atoms) {
    assert.equal(field(atom, 'call'), field(unit, 'call'));
    assert.equal(text(source, field(atom, 'key')), field(atom, 'field-key'));
    assert.equal(text(source, field(atom, 'type')), field(atom, 'value-kind'));
    assert.equal(atom.subject, unit.subject);
    assert.ok(text(source, validationContractSpan(atom.evidence.span)).startsWith('v.'));
    if (field(atom, 'predicate') === 'value_kind') assert.equal(field(atom, 'bound'), undefined);
    else assert.equal(Number(text(source, field(atom, 'bound'))), field(atom, 'bound-value'));
  }
  assert.ok(facts(result).every(fact => fact.kind !== 'relation' && fact.evidence.basis === 'import-bound'));
});

test('aliases, renames, plain imports and arrow owners retain exact source identity', async () => {
  for (const [alias, parameter, name] of [['v', 'input', 'accept'], ['schemaAPI', 'payload', 'renamed'], ['z', '$value', 'unrelated']]) {
    const source = prefix.replace('z as v', alias === 'z' ? 'z' : `z as ${alias}`)
      + `export const ${name} = (${parameter}: unknown) => ${shape.replaceAll('v.', `${alias}.`)}.parse(${parameter});`;
    const result = await analyze(source, { path: 'different/location.ts' });
    assert.equal(units(result, 'validation-predicate').length, 7);
    const unit = units(result, 'validation-use')[0];
    assert.equal(text(source, field(unit, 'parameter')), parameter);
    assert.equal(field(unit, 'return'), field(unit, 'call'));
    assert.match(text(source, field(unit, 'owner')), /^\(/);
    const subject = result.declarations.find(declaration => declaration.key === unit.subject);
    assert.ok(subject.span.startByte <= unit.evidence.span.startByte && subject.span.endByte >= unit.evidence.span.endByte);
  }
  const simple = await analyze(prefix + 'const accept = input => v.object({ok:v.boolean()}).parse(input);');
  assert.equal(units(simple).length, 2);
});

test('UTF16 and inclusive numeric metrics are conditional reviewed assumptions, not runtime versions', async () => {
  const result = await analyze(prefix + use());
  const unit = units(result, 'validation-use')[0];
  assert.deepEqual(unit.facts.filter(fact => fact.term === 'validation-contract.condition').map(fact => fact.value.value).sort(), [...rules.conditions, 'normal-validation-return'].sort());
  const atoms = units(result, 'validation-predicate');
  assert.equal(atoms.filter(atom => field(atom, 'metric') === 'utf16-length').length, 2);
  assert.equal(atoms.filter(atom => field(atom, 'metric') === 'numeric-value').length, 2);
  assert.equal(atoms.filter(atom => field(atom, 'value-kind') === 'boolean').length, 1);
  const minimum = atoms.find(atom => field(atom, 'field-key') === 'name' && field(atom, 'predicate') === 'minimum');
  assert.equal(field(minimum, 'bound-value'), '\ud83d\ude00'.length, 'reviewed metric counts UTF16 code units, not code points');
  assert.equal(rules.reviewedAPI, 'zod-v4.1.12');
  assert.ok(rules.limitations.includes('number-finiteness-not-claimed'));
  assert.ok(rules.limitations.includes('number-integrality-not-claimed'));
  assert.ok(rules.limitations.includes('unknown-object-keys-not-strict'));
  assert.ok(!JSON.stringify(facts(result)).includes('4.1.12'), 'review source version must not masquerade as installed runtime evidence');
});

test('safeParse predicates map to accepted input and return.data only on success true', async () => {
  const source = prefix + use(shape, 'safeParse');
  const result = await analyze(source);
  const unit = units(result, 'validation-use')[0];
  assert.equal(field(unit, 'mode'), 'safeParse'); assert.equal(field(unit, 'return-target'), 'return.data');
  assert.equal(unit.evidence.ruleId, 'zod-object-safe-parse-v1');
  assert.ok(unit.facts.some(fact => fact.term === 'validation-contract.condition' && fact.value.value === 'success-true'));
  assert.ok(!unit.facts.some(fact => fact.term === 'validation-contract.condition' && fact.value.value === 'normal-validation-return'));
  assert.equal(units(result, 'validation-predicate').length, 7);
  for (const source of [
    prefix + `function accept(input) { const result = ${shape}.safeParse(input); if (result.success === true) return result.data; }`,
    prefix + `function accept(input) { if (ready) return ${shape}.safeParse(input); }`,
    prefix + `function accept(input) { return ${shape}.safeParse(input).data; }`,
  ]) assert.equal(facts(await analyze(source)).length, 0, source);
});

test('fake, shadowed, type-only and non-named imports never become qualified schemas', async () => {
  for (const source of [
    use(), 'const v = fake;' + use(), prefix.replace('"zod"', '"fake-zod"') + use(),
    prefix.replace('import {', 'import type {') + use(), prefix.replace('z as v', 'type z as v') + use(),
    'import v from "zod";' + use(), 'import * as v from "zod";' + use(),
    prefix.replace('"zod"', '"zod/v4"') + use(),
    prefix + 'function outer(v) { ' + use().replace('export ', '') + ' }',
    prefix + 'const v = fake;' + use(), prefix + 'let v;' + use(),
    prefix.replace('z as v', 'z as v\u00e9') + use().replaceAll('v.', 'v\u00e9.'),
    prefix.replace('z as v', 'z as \\u0076') + use(),
  ]) assert.equal(facts(await analyze(source)).length, 0, source);
  const independentShadow = await analyze(prefix + use() + 'function unrelated(v) { return v.anything(); }');
  assert.equal(units(independentShadow, 'validation-use').length, 1);
});

test('full source import inventory rejects mutation, escape, aliases, extraction and dynamic loaders', async () => {
  for (const extra of [
    'v = replacement;', 'v.object = replacement;', 'v.string.prototype.min = replacement;',
    'Object.assign(v, replacement);', 'Object.getPrototypeOf(v).object = replacement;',
    'Object.setPrototypeOf(v, replacement);', 'const alias = v;', 'unknown(v);',
    'const object = v.object;', 'const {string} = v;', 'const escaped = {v};',
    'export {v};', 'function leak() { return v; }', 'v.string();',
    'const schema = v.object({name:v.string()});', 'v["object"]({});', 'v?.object({});',
    'eval("v.object = replacement");', 'const load = require;', 'require(moduleName);',
    'import(moduleName);', 'process.getBuiltinModule(moduleName);',
    'import {createRequire} from "node:module";', 'import {ZodObject} from "zod";',
    'import {z as other} from "zod"; other.object = replacement;',
  ]) assert.equal(facts(await analyze(prefix + use() + extra)).length, 0, extra);
});

test('ambient evaluator and loader references veto the whole source before aliases can hide them', async () => {
  // These are parser inputs only. inertText/moduleName/key are intentionally
  // unbound placeholders; no evaluator, loader or fixture body is ever executed.
  for (const extra of [
    'globalThis.eval(inertText);',
    'globalThis["eval"](inertText);',
    'const run = globalThis.eval; run(inertText);',
    'const run = globalThis["eval"]; const next = run; next(inertText);',
    'globalThis?.eval?.(inertText);',
    'const run = globalThis?.["eval"]; run?.(inertText);',
    'globalThis["\\u0065val"](inertText);',
    'globalThis.\\u0065val(inertText);',
    'globalThis[key](inertText);',
    'globalThis["ev" + "al"](inertText);',
    'const ambient = globalThis; const run = ambient[key];',
    'const ambient = glo\\u0062alThis; const run = ambient[key];',
    'const {eval:run} = globalThis;',
    'const { [key]:run } = globalThis;',
    'const holder = {globalThis};',
    'function expose() { return globalThis; }',
    'const run = global.eval;', 'const run = window["eval"];', 'const run = self[key];',
    'const run = eval; const next = run;', 'const run = e\\u0076al;',
    'const make = Function;', 'const make = F\\u0075nction;',
    'const make = globalThis.Function;', 'const make = globalThis["Function"];',
    'const make = (() => {}).constructor;',
    'const {constructor:make} = (() => {});',
    'const run = object.eval;', 'const run = object["\\x65val"];',
    'const {eval:run} = object;', 'const {Function:make} = object;',
    'const load = require;', 'const load = process.getBuiltinModule;',
    'const load = process["getBuiltinModule"];', 'const load = process?.[key];',
    'const ambient = process; const load = ambient[key];',
    'const load = module.require;', 'const load = module["require"];',
    'const ambient = module; const load = ambient[key];',
    'const load = loader.createRequire;', 'const load = loader?.["require"];',
  ]) {
    const result = await analyze(prefix + use() + extra);
    assert.equal(report(result).state, 'partial', extra);
    assert.equal(facts(result).length, 0, extra);
    assert.ok(report(result).diagnostics.some(diagnostic => diagnostic.code === 'validation-contract.dynamic-scope'), extra);
  }
  const before = await analyze(prefix + 'const run = globalThis.eval;' + use(shape, 'safeParse'));
  assert.equal(report(before).state, 'partial'); assert.deepEqual(facts(before), []);
  const multiple = await analyze(prefix + use() + 'const run=globalThis[key];' + use(shape, 'safeParse', 'second'));
  assert.equal(report(multiple).state, 'partial'); assert.deepEqual(facts(multiple), [], 'no completed prefix use survives the source veto');
});

test('conservative ambient veto is explicit while unrelated text and supported renamed schemas stay qualified', async () => {
  for (const extra of [
    'globalThis.console;',
    'function unrelated(globalThis) { return globalThis.label; }',
    'const Function = localFactory;',
    'const processAlias = process;',
    'const missing = module[key];',
  ]) {
    const result = await analyze(prefix + use() + extra);
    assert.equal(report(result).state, 'partial', extra);
    assert.deepEqual(facts(result), [], extra);
  }
  for (const mode of ['parse', 'safeParse']) {
    const source = prefix.replace('z as v', 'z as schemaAPI')
      + use(shape, mode, 'renamed').replaceAll('v.', 'schemaAPI.').replaceAll('input', 'payload')
      + '// globalThis.eval Function require are inert comment text\n'
      + 'const note = "globalThis[eval]"; const value = process.env.MODE; const item = ordinary[key];';
    const result = await analyze(source);
    assert.equal(report(result).state, 'complete');
    assert.equal(units(result, 'validation-use').length, 1);
    assert.equal(units(result, 'validation-predicate').length, 7);
  }
  const keys = await analyze(prefix + use('v.object({eval:v.string(),Function:v.boolean(),globalThis:v.number()})'));
  assert.equal(report(keys).state, 'complete', 'schema property keys are not evaluator references');
});

test('only the closed inline primitive object grammar qualifies', async () => {
  for (const schema of [
    'schema', 'v.object({})', 'v.object(shape)', 'v.object({name:externalSchema})',
    'v.object({name:v.object({nested:v.string()})})', 'v.object({...shape})',
    'v.object({[name]:v.string()})', 'v.object({"name":v.string()})',
    'v.object({name:v.string(),name:v.number()})', 'v.object({__proto__:v.string()})',
    'v.object({name})', 'v.object({get name(){return v.string();}})',
    'v.object({name:v.coerce.string()})', 'v.object({name:v.string().optional()})',
    'v.object({name:v.string().default("private-default")})', 'v.object({name:v.string().nullable()})',
    'v.object({name:v.union([v.string(),v.number()])})', 'v.object({name:v.string().refine(check)})',
    'v.object({name:v.string().transform(change)})', 'v.object({name:v.number().int()})',
    'v.object({name:v.number().finite()})', 'v.object({name:v.string().trim()})',
    'v.object({name:v.string().min(1).min(2)})', 'v.object({name:v.string().max(2).max(3)})',
    'v.object({name:v.boolean().min(1)})', 'v.object({name:v.string().min(-1)})',
    'v.object({name:v.string("private-message")})', 'v.object({name:v.string().min(1,"private-message")})',
    'v.object({name:v.string()},options)', 'v.object({name:v.string()}).strict()',
    'v.object({name:(v.string())})', 'v.object({name:v["string"]()})',
  ]) assert.equal(facts(await analyze(prefix + use(schema))).length, 0, schema);
});

test('sole synchronous return, exact one required parameter and unwrapped argument are required', async () => {
  for (const declaration of [
    `async function accept(input) { return ${shape}.parse(input); }`,
    `function* accept(input) { return ${shape}.parse(input); }`,
    `function accept(input, extra) { return ${shape}.parse(input); }`,
    `function accept(input = other) { return ${shape}.parse(input); }`,
    `function accept(input?: unknown) { return ${shape}.parse(input); }`,
    `function accept({input}) { return ${shape}.parse(input); }`,
    `function accept(...input) { return ${shape}.parse(input); }`,
    `function accept(input) { input = other; return ${shape}.parse(input); }`,
    `function accept(input) { "use strict"; return ${shape}.parse(input); }`,
    `function accept(input) { if(ready) return ${shape}.parse(input); }`,
    `function accept(input) { for(;;) return ${shape}.parse(input); }`,
    `function accept(input) { try { return ${shape}.parse(input); } finally {} }`,
    `function accept(input) { return ${shape}.parse(other); }`,
    `function accept(input) { return ${shape}.parse((input)); }`,
    `function accept(input) { return ${shape}.parse(input as unknown); }`,
    `function accept(input) { return ${shape}.parse(input,options); }`,
    `function accept(input) { return ${shape}.parse(...input); }`,
    `function accept(input) { return ${shape}.parseAsync(input); }`,
    `function accept(input) { return ${shape}.safeParseAsync(input); }`,
    `function accept(input) { return ${shape}.parse?.(input); }`,
    `function accept(input) { return ${shape}?.parse(input); }`,
    `function accept(input) { return ${shape}.parse(input)!; }`,
    `function accept(input) { return await ${shape}.parse(input); }`,
    `const accept = async input => ${shape}.parse(input);`,
    `const accept = input => ready ? ${shape}.parse(input) : other;`,
    `class Owner { accept(input) { return ${shape}.parse(input); } }`,
    `if (ready) { function accept(input) { return ${shape}.parse(input); } }`,
    `function accept(\u00e9) { return ${shape}.parse(\u00e9); }`,
    `function accept(input) { return ${shape}.parse(\\u0069nput); }`,
  ]) assert.equal(facts(await analyze(prefix + declaration)).length, 0, declaration);
});

test('numeric bounds preserve literal integrity, negative zero and contradictory source atoms', async () => {
  for (const literal of ['1.5', '1.0', '1e2', '0x10', '0b10', '1_000', '+2', '01', '2n', 'NaN', 'Infinity', 'limit', '(2)', '1+2', '9007199254740992', '-9007199254740992', '"2"', '/*x*/2, message', '-/*x*/2']) {
    assert.equal(facts(await analyze(prefix + use(`v.object({count:v.number().min(${literal})})`))).length, 0, literal);
  }
  for (const literal of ['0', '-0', '- 2', '9007199254740991', '-9007199254740991']) {
    const source = prefix + use(`v.object({count:v.number().min(${literal})})`);
    const result = await analyze(source);
    const atom = units(result, 'validation-predicate').find(atom => field(atom, 'predicate') === 'minimum');
    assert.ok(atom, literal); assert.equal(text(source, field(atom, 'bound')), literal);
    assert.equal(field(atom, 'bound-value'), Number(literal.replaceAll(' ', '')) || 0);
    assert.ok(!Object.is(field(atom, 'bound-value'), -0));
  }
  const inverted = await analyze(prefix + use('v.object({count:v.number().max(2).min(5)})'));
  assert.equal(units(inverted, 'validation-predicate').length, 3);
  assert.ok(!facts(inverted).some(fact => /contradiction|compatible|executed|required|own-property|finite|integer/.test(fact.term)));
});

test('UTF8, CRLF and TSX spans stay exact without copying bodies or source values', async () => {
  const source = '// \u4e2d\ud83d\ude00 private-comment\r\n' + prefix.replace('\n', '\r\n') + use().replace('accept', 'accepter\u00e9')
    + '\r\nconst secret = "private-secret"; const element = <div/>;';
  const result = await analyze(source, { path: 'elsewhere/renamed.tsx', language: 'tsx' });
  assert.equal(units(result, 'validation-use').length, 1);
  for (const unit of units(result)) {
    assert.ok(text(source, validationContractSpan(unit.evidence.span)).length);
    for (const property of ['import', 'owner', 'parameter', 'argument', 'schema', 'call', 'return', 'key', 'type', 'method', 'bound']) if (field(unit, property)) assert.ok(text(source, field(unit, property)).length);
  }
  assert.ok(!JSON.stringify(facts(result)).includes('private-'));
  assert.ok(!JSON.stringify(facts(result)).includes('elsewhere'));
});

test('full source census and every source/work/depth/output budget are all-or-nothing', async () => {
  const source = prefix + use();
  for (const extra of [' function broken( {', 'export {other} from "external";']) assert.equal(facts(await analyze(source + extra)).length, 0);
  for (const limits of [{maxFacts:1}, {maxFacts:30}, {maxFacts:80}, {maxWork:20}, {maxWork:3000}, {maxDepth:4}, {maxDeclarations:1}, {maxValueBytes:32}, {maxResultBytes:1800}]) {
    const result = await analyze(source, {limits});
    assert.equal(facts(result).length, 0, JSON.stringify(limits)); assert.notEqual(report(result).state, 'complete', JSON.stringify(limits));
  }
  const repeated = (count, fields) => prefix + Array.from({length:count}, (_, i) => use(`v.object({${fields}})`, 'parse', `accept${i}`)).join('\n');
  const eight = await analyze(repeated(8, 'ok:v.boolean()'));
  assert.equal(units(eight, 'validation-use').length, 8);
  for (const unit of units(eight, 'validation-use')) assert.equal(field(unit, 'use-count'), 8);
  const fields = Array.from({length:8}, (_, i) => `field${i}:v.string().min(1).max(8)`).join(',');
  assert.equal(units(await analyze(repeated(1, fields)), 'validation-predicate').length, 24);
  for (const [input, code] of [
    [repeated(9, 'ok:v.boolean()'), 'use-limit'],
    [repeated(1, fields + ',ninth:v.boolean()'), 'field-limit'],
    [repeated(6, fields), 'atom-limit'],
    [repeated(4, fields), 'fact-limit'],
    [source + 'unrelated;'.repeat(1600), 'work-limit'],
    [source + 'const nested=' + '('.repeat(70) + 'value' + ')'.repeat(70) + ';', 'depth-limit'],
  ]) {
    const result = await analyze(input);
    assert.equal(report(result).state, 'truncated', code); assert.equal(facts(result).length, 0, code);
    assert.ok(report(result).diagnostics.some(diagnostic => diagnostic.code === `validation-contract.${code}`), JSON.stringify(report(result)));
  }
  const params = sourceParams(source), manifest = structuredClone(await annotationManifest());
  manifest.plugins = manifest.plugins.filter(plugin => plugin.id === 'validation-contract');
  const {id, ...body} = manifest; manifest.id = sha256(canonicalJSON(body));
  const engine = createAnnotationEngine({manifest, plugins:[createValidationContractPlugin(manifest.plugins[0])], digest:sha256});
  const plugin = createValidationContractPlugin(manifest.plugins[0]);
  const emitted = [];
  const oversized = plugin.analyze({document:{source:'x'.repeat(rules.maxSourceBytes + 1)},view:{state:'complete',limits:{maxDiagnostics:32,maxValueBytes:1024}},budget:{step(){}}}, {role:value=>emitted.push(value),property:value=>emitted.push(value)});
  assert.equal(oversized.state, 'truncated'); assert.deepEqual(emitted, []);
  assert.ok(oversized.diagnostics.some(diagnostic => diagnostic.code === 'validation-contract.source-limit'));
  let checks = 0;
  const document = {source, sourceHash:params.sourceHash, relativePath:params.relativePath, language:params.language};
  const cancelled = await inspectSource(params, source, tree => engine.analyze(document, createTypeScriptView({tree, ...document, limits:manifest.limits}), {cancelled:() => ++checks > 30}));
  assert.equal(report(cancelled).state, 'truncated'); assert.equal(facts(cancelled).length, 0);
});
