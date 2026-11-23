import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule, hash as sha256 } from '../helpers.mjs';
import { analyzeSource, annotationManifest, inspectSource, sourceParams } from './harness.mjs';
const { createTransportBindingPlugin } = await loadModule('src/producers/transport-binding-plugin.ts');
const { transportBindingDescriptor, transportBindingRules: rules, transportBindingSpan } = await loadModule('src/producers/transport-binding-vocabulary.ts');
const { createAnnotationEngine, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');

const prefix = 'import { EventEmitter as Emitter } from "node:events"; const bus = new Emitter();\n';
const endpoints = 'bus.on("ready", () => {}); bus.emit("ready", payload);';
const field = (unit, name) => unit.facts.find(fact => fact.term === `transport-binding.${name}`)?.value?.value;
const facts = result => result.facts.filter(fact => fact.evidence.pluginId === 'transport-binding');
const report = result => result.reports.find(report => report.pluginId === 'transport-binding');
function units(result, role) {
  const grouped = new Map();
  for (const fact of facts(result)) {
    const key = canonicalJSON(fact.evidence);
    const unit = grouped.get(key) ?? { facts: [], evidence: fact.evidence };
    unit.facts.push(fact); grouped.set(key, unit);
  }
  return [...grouped.values()].filter(unit => field(unit, 'unit-complete') === true && (!role || unit.facts.some(fact => fact.kind === 'role' && fact.term === `transport-binding.${role}`)));
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
  return analyzeSource(source, { relativePath: options.path ?? 'neutral/transport-binding.ts', language: options.language ?? 'typescript', limits: options.limits });
}

test('named value import aliases qualify exact allocation and endpoint locators only', async () => {
  const source = prefix + 'function register() { bus.on("ready", value => consume(value, "never-copy-callback-secret")); }\n'
    + 'export function publish() { bus.emit("ready", "never-copy-payload-secret"); }';
  const result = await analyze(source);
  assert.equal(report(result).state, 'complete');
  assert.equal(units(result).length, 3);
  const instance = units(result, 'event-instance')[0], listener = units(result, 'event-listener')[0], emission = units(result, 'event-emission')[0];
  assert.equal(text(source, field(instance, 'allocation')), 'new Emitter()');
  assert.equal(field(instance, 'endpoint-count'), 2);
  assert.equal(text(source, field(instance, 'import')), 'EventEmitter as Emitter');
  assert.equal(text(source, field(listener, 'receiver')), 'bus');
  assert.equal(text(source, field(listener, 'event-literal')), '"ready"');
  assert.equal(text(source, field(listener, 'callback')), 'value => consume(value, "never-copy-callback-secret")');
  assert.match(text(source, field(listener, 'owner')), /^function register/);
  assert.match(text(source, field(emission, 'owner')), /^function publish/);
  for (const unit of units(result)) {
    assert.equal(field(unit, 'inventory-complete'), true);
    assert.deepEqual(field(unit, 'declaration'), field(instance, 'declaration'));
    assert.deepEqual(field(unit, 'import-reference'), { kind: 'import', module: 'node:events', name: 'EventEmitter' });
    assert.ok(unit.facts.every(fact => fact.evidence.basis === 'import-bound'));
    const subject = result.declarations.find(declaration => declaration.key === unit.facts[0].subject);
    assert.ok(subject.span.startByte <= unit.evidence.span.startByte && subject.span.endByte >= unit.evidence.span.endByte);
  }
  assert.ok(!JSON.stringify(facts(result)).includes('never-copy'));
  assert.ok(facts(result).every(fact => fact.kind !== 'relation'));
  assert.equal(units(await analyze((prefix + endpoints).replace('EventEmitter as Emitter', 'EventEmitter').replace('new Emitter()', 'new EventEmitter()'))).length, 3);
});

test('two allocations with the same event remain separate and never create worker joins', async () => {
  const source = prefix + endpoints + '\nconst second = new Emitter(); second.on("ready", () => {}); second.emit("ready");';
  const result = await analyze(source);
  assert.equal(units(result, 'event-instance').length, 2);
  assert.equal(units(result, 'event-listener').length, 2);
  assert.equal(units(result, 'event-emission').length, 2);
  const instances = units(result, 'event-instance');
  assert.notEqual(field(instances[0], 'allocation'), field(instances[1], 'allocation'));
  assert.notDeepEqual(field(instances[0], 'declaration'), field(instances[1], 'declaration'));
  for (const instance of instances) {
    assert.equal(field(instance, 'endpoint-count'), 2);
    assert.equal(units(result).filter(unit => field(unit, 'allocation') === field(instance, 'allocation')).length, 3);
  }
  assert.ok(!facts(result).some(fact => fact.kind === 'relation'));
});

test('anonymous and variable-arrow lexical owners are not replaced with containing subjects', async () => {
  const source = prefix + 'bus.on("ready", () => { bus.emit("nested"); }); const publish = () => bus.emit("ready");';
  const result = await analyze(source);
  assert.equal(report(result).state, 'complete');
  assert.equal(field(units(result, 'event-instance')[0], 'endpoint-count'), 3);
  const emissions = units(result, 'event-emission');
  assert.equal(emissions.length, 2);
  for (const unit of emissions) assert.match(text(source, field(unit, 'owner')), /^\(\) =>/);
  assert.ok(emissions.some(unit => field(unit, 'owner') !== transportBindingSpan(result.declarations.find(declaration => declaration.key === unit.facts[0].subject).span)));
});

test('shadowed, fake, type-only, factory, parameter, field and subclass origins cannot qualify', async () => {
  for (const source of [
    'class Emitter {} const bus = new Emitter(); ' + endpoints,
    'import { EventEmitter as Emitter } from "fake:events"; const bus = new Emitter(); ' + endpoints,
    'import type { EventEmitter as Emitter } from "node:events"; const bus = new Emitter(); ' + endpoints,
    'import { type EventEmitter as Emitter } from "node:events"; const bus = new Emitter(); ' + endpoints,
    'import EventEmitter from "node:events"; const bus = new EventEmitter(); ' + endpoints,
    'import * as events from "node:events"; const bus = new events.EventEmitter(); ' + endpoints,
    'import { EventEmitter as Emitter } from "node:events"; function build(Emitter) { const bus = new Emitter(); ' + endpoints + ' }',
    prefix + 'function run(bus) { ' + endpoints + ' }',
    prefix.replace('new Emitter()', 'makeEmitter()') + endpoints,
    prefix.replace('new Emitter()', 'new Emitter({ captureRejections: true })') + endpoints,
    prefix.replace('new Emitter()', 'new Emitter') + endpoints,
    prefix.replace('new Emitter()', '(new Emitter())') + endpoints,
    prefix.replace('const bus', 'let bus') + endpoints,
    prefix.replace('const bus', 'export const bus') + endpoints,
    prefix + endpoints + ' export { bus };',
    prefix + endpoints + ' export default bus;',
    'import { EventEmitter as Emitter } from "node:events"; class Local extends Emitter {} const bus = new Local(); ' + endpoints,
    'import { EventEmitter as Emitter } from "node:events"; class Owner { bus = new Emitter(); run() { this.bus.emit("ready"); } }',
  ]) assert.equal(facts(await analyze(source)).length, 0, source);
  const shadow = await analyze(prefix + endpoints + ' function other(bus) { bus.emit("other"); }');
  assert.equal(units(shadow).length, 3, 'shadowed parameter must not join or veto the qualified lexical declaration');
});

test('full-file receiver and constructor mutation or escape veto even earlier valid endpoints', async () => {
  for (const use of [
    'const alias = bus;', 'const method = bus.on;', 'const { emit } = bus;',
    'unknown(bus);', 'const escaped = { bus };', 'const escaped = [bus];', 'function leak() { return bus; }',
    'bus = other;', 'bus.on = other;', 'bus["emit"] = other;', 'delete bus.on;', 'bus.count++;',
    'bus.__proto__.on = other;', 'bus.constructor.prototype.emit = other;',
    'Object.assign(bus, overrides);', 'Object.setPrototypeOf(bus, overrides);', 'Object.getPrototypeOf(bus).on = other;',
    'Object.assign(Emitter.prototype, overrides);', 'Emitter.prototype.emit = other;', 'Emitter = Other;',
    'const Constructor = Emitter;', 'unknown(Emitter);', 'const proto = Emitter.prototype;',
    'bus.off("ready", handler);', 'bus.once("ready", () => {});', 'bus.removeAllListeners();',
    'bus["on"]("ready", () => {});', 'bus?.emit("ready");', 'bus.emit?.("ready");',
    'bus.on("ready", () => {}).emit("ready");', 'bus.emit.call(bus, "ready");',
    'eval("bus.on = other");',
  ]) {
    const source = prefix + endpoints + '\n' + use;
    const result = await analyze(source);
    assert.equal(facts(result).length, 0, use);
    assert.notEqual(report(result).state, 'complete', use);
  }
  const source = prefix + endpoints + ' import { EventEmitter as Other } from "node:events"; Other.prototype.on = replacement;';
  assert.equal(facts(await analyze(source)).length, 0, 'constructor aliases share the imported API, not independent mutation safety');
});

test('alternate builtin acquisition and prototype access cannot bypass constructor qualification', async () => {
  for (const extra of [
    'const other = require("node:events"); other.EventEmitter.prototype.on = replacement;',
    'const key = "node:events"; const other = require(key); other.EventEmitter.prototype.on = replacement;',
    'const load = require; const other = load(`node:events`); other.EventEmitter.prototype.on = replacement;',
    'const other = await import("node:events"); other.EventEmitter.prototype.on = replacement;',
    'const key = "node:events"; const other = await import(key); other.EventEmitter.prototype.on = replacement;',
    'const other = process.getBuiltinModule("events"); other.EventEmitter.prototype.on = replacement;',
    'const key = "events"; const other = process.getBuiltinModule(key); other.EventEmitter.prototype.on = replacement;',
    'import { createRequire as loader } from "node:module"; const load = loader(import.meta.url); const other = load("node:events"); other.EventEmitter.prototype.on = replacement;',
    'const second = new Emitter(); second.constructor.prototype.on = replacement;',
    'const second = new Emitter(); second.__proto__.on = replacement;',
    'const second = new Emitter(); Object.getPrototypeOf(second).on = replacement;',
  ]) assert.equal(facts(await analyze(prefix + endpoints + extra)).length, 0, extra);
});

test('unsupported callback, argument and event forms veto the entire binding', async () => {
  for (const endpoint of [
    'bus.on("ready", handler);', 'bus.on("ready", choice ? first : second);',
    'bus.on("ready", function () {});', 'bus.on("ready", (() => {}));', 'bus.on("ready", () => {}, options);',
    'bus.emit(event);', 'bus.emit(`ready`);', 'bus.emit("rea" + "dy");', 'bus.emit("rea\\x64y");',
    'bus.emit("\u00e9");', 'bus.emit("");', 'bus.emit("error");', 'bus.emit("newListener");', 'bus.emit("removeListener");',
    'bus.emit("ready", ...values);', `bus.emit("${'x'.repeat(129)}");`,
    `bus.emit("ready", ${Array.from({ length: 16 }, () => 'payload').join(',')});`,
  ]) assert.equal(facts(await analyze(prefix + endpoints + endpoint)).length, 0, endpoint);
  const bounded = await analyze(prefix + `bus.on('${'x'.repeat(128)}', () => {}); bus.emit('${'x'.repeat(128)}', ${Array.from({ length: 15 }, () => 'value').join(',')});`);
  assert.equal(units(bounded).length, 3);
  for (const key of ['events', 'node:events', 'event name', 'topic:part.changed']) assert.equal(units(await analyze(prefix + endpoints.replaceAll('ready', key))).length, 3, key);
});

test('branch, loop, try, switch, short circuit and consumed endpoint placements are rejected', async () => {
  for (const placement of [
    'if (ready) { bus.emit("ready"); }', 'for (;;) { bus.emit("ready"); }',
    'while (ready) { bus.emit("ready"); }', 'do { bus.emit("ready"); } while (ready);',
    'try { bus.emit("ready"); } catch {}', 'switch (mode) { case 1: bus.emit("ready"); }',
    'ready && bus.emit("ready");', 'ready ? bus.emit("ready") : other;',
    'if (ready) register(() => { bus.emit("ready"); });',
    'function send() { return bus.emit("ready"); }', 'const result = bus.emit("ready");',
    'class Owner { send() { bus.emit("ready"); } }',
  ]) assert.equal(facts(await analyze(prefix + endpoints + placement)).length, 0, placement);
});

test('emission before registration, external execution and runtime version remain unknown', async () => {
  const result = await analyze(prefix + 'bus.emit("ready"); bus.on("ready", () => {});');
  assert.equal(units(result).length, 3);
  for (const unit of units(result)) {
    assert.deepEqual(unit.facts.filter(fact => fact.term === 'transport-binding.condition').map(fact => fact.value.value).sort(), [...rules.conditions].sort());
    assert.equal(unit.facts.some(fact => /version|order|immutable|executed|delivered/.test(fact.term)), false);
  }
  assert.ok(!facts(result).some(fact => fact.kind === 'relation'));
});

test('HTTP and RPC strings, names and paths cannot manufacture transport bindings', async () => {
  for (const source of [
    'fetch("/ready"); server.get("/ready", () => {});',
    'rpc.send("ready"); rpc.register("ready", () => {});',
    'const bus = { on() {}, emit() {} }; ' + endpoints,
  ]) assert.equal(facts(await analyze(source, { path: 'http/events/EventEmitter.ts' })).length, 0);
  const result = await analyze(prefix + endpoints + ' fetch("ready"); rpc.send("ready");');
  assert.equal(units(result).length, 3);
});

test('UTF8 and CRLF locators remain exact after renaming with TSX source', async () => {
  const source = '// \u4e2d\ud83d\ude00\r\n' + prefix.replace('\n', '\r\n').replaceAll('bus', 'r\u00e9seau')
    + endpoints.replaceAll('bus', 'r\u00e9seau') + '\r\nconst element = <div/>;';
  const result = await analyze(source, { path: 'elsewhere/renamed.tsx', language: 'tsx' });
  assert.equal(units(result).length, 3);
  for (const unit of units(result)) {
    assert.ok(text(source, transportBindingSpan(unit.evidence.span)).length);
    for (const key of ['allocation', 'import', 'owner', 'receiver', 'event-literal', 'callback']) if (field(unit, key)) assert.ok(text(source, field(unit, key)).length);
  }
  assert.equal(text(source, field(units(result, 'event-listener')[0], 'receiver')), 'r\u00e9seau');
});

test('parse errors, incomplete views and every budget failure leave no transport facts', async () => {
  const invalid = await analyze(prefix + endpoints + ' function broken( {');
  assert.equal(facts(invalid).length, 0);
  assert.notEqual(report(invalid).state, 'complete');
  const incomplete = await analyze(prefix + endpoints + ' export { other } from "./external";');
  assert.equal(report(incomplete).state, 'partial'); assert.equal(facts(incomplete).length, 0);
  for (const limits of [
    { maxFacts: 1 }, { maxFacts: 15 }, { maxFacts: 40 }, { maxResultBytes: 1800 },
    { maxWork: 50 }, { maxWork: 2000 }, { maxValueBytes: 32 }, { maxDeclarations: 1 }, { maxDepth: 4 },
  ]) {
    const result = await analyze(prefix + endpoints, { limits });
    assert.equal(facts(result).length, 0, JSON.stringify(limits));
    assert.notEqual(report(result).state, 'complete', JSON.stringify(limits));
    assert.ok(Buffer.byteLength(canonicalJSON(result)) <= (limits.maxResultBytes ?? 8 * 1024 * 1024));
  }
  const overInstances = await analyze(prefix + endpoints + Array.from({ length: rules.maxInstances }, (_, i) => `const b${i} = new Emitter();`).join(''));
  assert.equal(report(overInstances).state, 'truncated'); assert.equal(facts(overInstances).length, 0);
  const overEndpoints = await analyze(prefix + 'bus.emit("ready");'.repeat(rules.maxEndpoints + 1));
  assert.equal(report(overEndpoints).state, 'truncated'); assert.equal(facts(overEndpoints).length, 0);
  const overFacts = await analyze('import { EventEmitter as Emitter } from "node:events";' + Array.from({ length: 16 }, (_, i) => `const b${i} = new Emitter(); b${i}.on("ready", () => {}); b${i}.on("ready", () => {}); b${i}.on("ready", () => {});`).join(''));
  assert.equal(report(overFacts).state, 'truncated'); assert.equal(facts(overFacts).length, 0);
  assert.ok(report(overFacts).diagnostics.some(item => item.code === 'transport-binding.fact-limit'));
  const work = await analyze(prefix + endpoints + 'unrelated;'.repeat(1600));
  assert.equal(report(work).state, 'truncated'); assert.equal(facts(work).length, 0);
  assert.ok(report(work).diagnostics.some(item => item.code === 'transport-binding.work-limit'));
  const depth = await analyze(prefix + endpoints + 'const nested = ' + '('.repeat(70) + 'value' + ')'.repeat(70) + ';');
  assert.equal(report(depth).state, 'truncated'); assert.equal(facts(depth).length, 0);
  const plugin = createTransportBindingPlugin({ implementationDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64) });
  const emitted = [];
  const tooLarge = plugin.analyze({ document: { source: 'x'.repeat(rules.maxSourceBytes + 1) }, view: { state: 'complete', limits: { maxDiagnostics: 32, maxValueBytes: 1024 } }, budget: { step() {} } }, { role: value => emitted.push(value), property: value => emitted.push(value) });
  assert.equal(tooLarge.state, 'truncated'); assert.deepEqual(emitted, []);
  const source = prefix + endpoints, params = sourceParams(source);
  const manifest = structuredClone(await annotationManifest());
  manifest.plugins = manifest.plugins.filter(plugin => plugin.id === 'transport-binding');
  const { id, ...body } = manifest;
  manifest.id = sha256(canonicalJSON(body));
  const engine = createAnnotationEngine({ manifest, plugins: [createTransportBindingPlugin(manifest.plugins[0])], digest: sha256 });
  const document = { source, sourceHash: params.sourceHash, relativePath: params.relativePath, language: params.language };
  let checks = 0;
  const cancelled = await inspectSource(params, source, tree => engine.analyze(document, createTypeScriptView({ tree, ...document, limits: manifest.limits }), { cancelled: () => ++checks > 30 }));
  assert.equal(report(cancelled).state, 'truncated'); assert.equal(facts(cancelled).length, 0);
});
