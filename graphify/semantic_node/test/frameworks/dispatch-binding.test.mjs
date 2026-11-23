import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule, hash as sha256 } from '../helpers.mjs';
import { analyzeSource, annotationManifest, inspectSource, sourceParams } from './harness.mjs';
const { createDispatchBindingPlugin } = await loadModule('src/producers/dispatch-binding-plugin.ts');
const { dispatchBindingDescriptor, dispatchBindingRules: rules, dispatchBindingSpan } = await loadModule('src/producers/dispatch-binding-vocabulary.ts');
const { createAnnotationEngine, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');

const httpImport = 'import { Elysia as Server } from "elysia";\n';
const http = 'const app = new Server(); app.get("/ready", () => "private-response"); app.handle(new Request("https://private.invalid/ready"));';
const rpcImport = 'import { initTRPC as init } from "@trpc/server";\n';
const rpc = 'const t = init.create(); const router = t.router({ ready: t.procedure.query(() => "private-result"), save: t.procedure.mutation(input => input) }); const caller = router.createCaller({}); caller.ready(); caller.save("private-input", payload);';
const facts = result => result.facts.filter(fact => fact.evidence.pluginId === 'dispatch-binding');
const report = result => result.reports.find(report => report.pluginId === 'dispatch-binding');
const field = (unit, name) => unit.facts.find(fact => fact.term === `dispatch-binding.${name}`)?.value?.value;
const fields = (unit, name) => unit.facts.filter(fact => fact.term === `dispatch-binding.${name}`).map(fact => fact.value.value);
function units(result, role) {
  const grouped = new Map();
  for (const fact of facts(result)) {
    const id = canonicalJSON({ subject: fact.subject, evidence: fact.evidence });
    const unit = grouped.get(id) ?? { subject: fact.subject, evidence: fact.evidence, facts: [] };
    unit.facts.push(fact); grouped.set(id, unit);
  }
  return [...grouped.values()].filter(unit => field(unit, 'unit-complete') === true && (!role || unit.facts.some(fact => fact.kind === 'role' && fact.term === `dispatch-binding.${role}`)));
}
function text(source, locator) {
  assert.match(locator, /^s:\d+:\d+:\d+:\d+$/);
  const [, start, end, startLine, endLine] = locator.split(':').map(Number), bytes = Buffer.from(source);
  assert.equal(bytes.subarray(0, start).toString('utf8').split('\n').length, startLine);
  assert.equal(bytes.subarray(0, end).toString('utf8').replace(/\n$/, '').split('\n').length, endLine);
  return bytes.subarray(start, end).toString('utf8');
}
function analyze(source, options = {}) {
  return analyzeSource(source, { relativePath: options.path ?? 'neutral/dispatch-binding.ts', language: options.language ?? 'typescript', limits: options.limits });
}

test('actual parse-only Elysia fixture qualifies exact app, route and Request evidence without origins', async () => {
  const source = httpImport + http, result = await analyze(source);
  assert.equal(report(result).state, 'complete', JSON.stringify(report(result)));
  assert.equal(units(result).length, 3);
  const family = units(result, 'dispatch-family')[0], route = units(result, 'dispatch-handler')[0], request = units(result, 'dispatch-call')[0];
  assert.equal(text(source, field(family, 'allocation')), 'new Server()');
  assert.equal(text(source, field(family, 'import')), 'Elysia as Server');
  assert.deepEqual(field(family, 'import-reference'), {kind:'import', module:'elysia', name:'Elysia'});
  assert.equal(field(family, 'family-count'), 1); assert.equal(field(family, 'endpoint-count'), 2); assert.equal(field(family, 'caller-count'), 0);
  assert.equal(text(source, field(route, 'receiver')), 'app'); assert.equal(text(source, field(route, 'selector')), '"/ready"');
  assert.equal(text(source, field(route, 'handler')), '() => "private-response"');
  assert.equal(text(source, field(request, 'selector')), '"https://private.invalid/ready"');
  assert.equal(text(source, field(request, 'request')), 'new Request("https://private.invalid/ready")');
  assert.equal(text(source, field(request, 'request-constructor')), 'Request');
  assert.equal(field(request, 'request-origin'), 'ambient-fetch'); assert.equal(field(request, 'method-literal'), undefined);
  for (const endpoint of [route, request]) {
    assert.equal(field(endpoint, 'http-method'), 'GET'); assert.equal(field(endpoint, 'path'), '/ready');
    assert.deepEqual(field(endpoint, 'declaration'), field(family, 'declaration'));
    assert.equal(field(endpoint, 'allocation'), field(family, 'allocation'));
    assert.equal(field(endpoint, 'argument-count'), fields(endpoint, 'argument').length);
    assert.equal(field(endpoint, 'inventory-complete'), true);
  }
  assert.ok(facts(result).every(fact => fact.kind !== 'relation' && fact.evidence.basis === 'import-bound'));
  assert.ok(!JSON.stringify(facts(result)).includes('private-'));
  assert.ok(!JSON.stringify(facts(result)).includes('private.invalid'));
});

test('all seven explicit HTTP methods and named undici Request aliases retain exact syntax', async () => {
  const source = httpImport + 'import {Request as Incoming} from "undici"; const app = new Server();'
    + rules.http.methods.map(method => `app.${method.toLowerCase()}('/${method}', () => {}); app.handle(new Incoming('http://127.0.0.1:3000/${method}', {method:'${method}'}));`).join('\n');
  const result = await analyze(source);
  assert.equal(report(result).state, 'complete'); assert.equal(units(result, 'dispatch-call').length, 7);
  assert.equal(field(units(result, 'dispatch-family')[0], 'endpoint-count'), 14);
  for (const unit of units(result, 'dispatch-call')) {
    assert.equal(text(source, field(unit, 'request-constructor')), 'Incoming');
    assert.equal(text(source, field(unit, 'request-import')), 'Request as Incoming');
    assert.equal(field(unit, 'request-origin'), 'undici-named');
    assert.deepEqual(field(unit, 'request-import-reference'), {kind:'import', module:'undici', name:'Request'});
    assert.equal(text(source, field(unit, 'method-literal')), `'${field(unit, 'http-method')}'`);
  }
  const plain = await analyze((httpImport + http).replaceAll('Server', 'Elysia').replace('Elysia as Elysia', 'Elysia').replaceAll('app', 'renamedApp'));
  assert.equal(units(plain).length, 3);
});

test('actual parse-only tRPC fixture binds initializer, router, caller, procedure and call locators', async () => {
  const source = rpcImport + rpc, result = await analyze(source);
  assert.equal(report(result).state, 'complete'); assert.equal(units(result).length, 6);
  const family = units(result, 'dispatch-family')[0], caller = units(result, 'dispatch-caller')[0];
  assert.equal(field(family, 'family'), 'trpc-rpc'); assert.equal(field(family, 'endpoint-count'), 4); assert.equal(field(family, 'caller-count'), 1);
  assert.equal(text(source, field(family, 'initializer')), 'init.create()');
  assert.match(text(source, field(family, 'allocation')), /^t\.router\(/);
  assert.equal(text(source, field(caller, 'caller')), 'router.createCaller({})');
  assert.equal(text(source, field(caller, 'context')), '{}');
  assert.equal(field(caller, 'argument-count'), 1);
  assert.deepEqual(field(caller, 'declaration'), field(family, 'declaration'));
  for (const endpoint of units(result).filter(unit => ['trpc-procedure-v1','trpc-call-v1'].includes(unit.evidence.ruleId))) {
    assert.deepEqual(field(endpoint, 'initializer-declaration'), field(family, 'initializer-declaration'));
    assert.deepEqual(field(endpoint, 'declaration'), field(family, 'declaration'));
    assert.equal(text(source, field(endpoint, 'selector')), field(endpoint, 'procedure-key'));
    assert.equal(field(endpoint, 'argument-count'), fields(endpoint, 'argument').length);
  }
  for (const call of units(result, 'dispatch-call')) {
    assert.deepEqual(field(call, 'caller-declaration'), field(caller, 'caller-declaration'));
    assert.equal(field(call, 'caller'), field(caller, 'caller'));
    assert.equal(field(call, 'procedure-kind'), undefined, 'caller method names do not invent resolver semantics');
  }
  assert.deepEqual(units(result, 'dispatch-handler').map(unit => field(unit, 'procedure-kind')).sort(), ['mutation','query']);
  assert.ok(!JSON.stringify(facts(result)).includes('private-'));
  const renamed = await analyze((rpcImport + rpc).replace('initTRPC as init', 'initTRPC').replace('init.create', 'initTRPC.create').replaceAll('router', 'service').replaceAll('t.service', 't.router').replaceAll('caller', 'client'));
  assert.equal(units(renamed).length, 6);
});

test('matching names on separate app/router allocations remain independent with no worker joins', async () => {
  const secondHTTP = http.replaceAll('app', 'otherApp');
  const secondRPC = rpc.replaceAll('router', 'otherRouter').replaceAll('t.otherRouter', 'otherT.router').replaceAll('const t ', 'const otherT ').replaceAll('t.procedure', 'otherT.procedure').replaceAll('caller', 'otherCaller');
  const result = await analyze(httpImport + http + secondHTTP + rpcImport + rpc + secondRPC);
  assert.equal(report(result).state, 'complete');
  const families = units(result, 'dispatch-family'); assert.equal(families.length, 4);
  assert.equal(new Set(families.map(unit => field(unit, 'allocation'))).size, 4);
  assert.equal(new Set(families.map(unit => field(unit, 'declaration').key)).size, 4);
  for (const family of families) {
    assert.equal(field(family, 'family-count'), 4);
    const endpoints = units(result).filter(unit => ['dispatch-handler','dispatch-call'].some(role => unit.facts.some(fact => fact.term === `dispatch-binding.${role}`)) && field(unit, 'declaration').key === field(family, 'declaration').key);
    assert.equal(endpoints.length, field(family, 'endpoint-count'));
    assert.ok(endpoints.every(unit => field(unit, 'allocation') === field(family, 'allocation')));
  }
  assert.ok(facts(result).every(fact => fact.kind !== 'relation'));
});

test('HTTP origin and strings never bind deployments or manufacture dispatch matches', async () => {
  const source = httpImport + http.replace('.get(', '.post(') + 'fetch("https://private.invalid/ready"); rpc.send("ready");';
  const result = await analyze(source);
  assert.equal(report(result).state, 'complete'); assert.equal(units(result, 'dispatch-call').length, 1);
  assert.equal(field(units(result, 'dispatch-handler')[0], 'http-method'), 'POST');
  assert.equal(field(units(result, 'dispatch-call')[0], 'http-method'), 'GET');
  const origins = await analyze(httpImport + http + 'app.handle(new Request("https://different.invalid/ready"));');
  assert.equal(units(origins, 'dispatch-call').length, 2);
  assert.equal(new Set(units(origins, 'dispatch-call').map(unit => field(unit, 'allocation'))).size, 1);
  const noMatch = await analyze(httpImport + http.replace('private.invalid/ready', 'private.invalid/elsewhere'));
  assert.equal(field(units(noMatch, 'dispatch-call')[0], 'path'), '/elsewhere');
  assert.equal(field(units(noMatch, 'dispatch-handler')[0], 'path'), '/ready');
  assert.equal(facts(await analyze('fetch("/ready"); server.get("/ready",()=>{}); rpc.call("ready");')).length, 0);
});

test('imports, shadows, factories, aliases, options and exports cannot qualify allocations', async () => {
  for (const source of [
    httpImport.replace('"elysia"','"fake"') + http,
    httpImport.replace('import {','import type {') + http,
    httpImport.replace('Elysia as Server','type Elysia as Server') + http,
    'import Server from "elysia";' + http,
    'import * as Server from "elysia";' + http,
    'class Server {}' + http,
    httpImport + http.replace('new Server()', 'factory()'),
    httpImport + http.replace('new Server()', 'new Server({prefix:"/api"})'),
    httpImport + http.replace('new Server()', '(new Server())'),
    httpImport + http.replace('new Server()', 'new Server'),
    httpImport + http.replace('const app', 'let app'),
    httpImport + http.replace('const app', 'export const app'),
    httpImport + http + 'export {app};',
    httpImport + 'function build(Server) {' + http + '}',
    httpImport + http.replace('app.get', 'alias.get') + 'const alias=app;',
    rpcImport.replace('"@trpc/server"','"fake"') + rpc,
    rpcImport.replace('import {','import type {') + rpc,
    rpcImport + rpc.replace('init.create()', 'init.create({})'),
    rpcImport + rpc.replace('const t', 'export const t'),
    rpcImport + rpc.replace('const router', 'export const router'),
    rpcImport + rpc.replace('const caller', 'export const caller'),
  ]) assert.equal(facts(await analyze(source)).length, 0, source);
  const shadow = await analyze(httpImport + http + 'function other(app) {app.get("/unrelated",()=>{});}');
  assert.equal(units(shadow).length, 3);
});

test('Request must be ambient unshadowed or the direct reviewed named import', async () => {
  for (const extra of [
    'class Request {}', 'const Request = Fake;', 'import {Request} from "fake";',
    'import Request from "undici";', 'import type {Request} from "undici";',
    'const Alias = Request;', 'Request.prototype.method = replacement;', 'Object.assign(Request, overrides);',
  ]) assert.equal(facts(await analyze(httpImport + extra + http)).length, 0, extra);
  assert.equal(facts(await analyze(httpImport + 'const app=new Server(); app.get("/ready",()=>{}); function send(Request){app.handle(new Request("https://local.test/ready"));}')).length, 0);
  for (const request of [
    'new Request(relativeURL)', 'new Request("/ready")', 'new Request("https://local.test/ready", {})',
    'new Request("https://local.test/ready", {method:"get"})', 'new Request("https://local.test/ready", {method:"PATCH",body:secret})',
    'new Request("https://local.test/ready", {method:method})', 'new Request("https://local.test/ready", {"method":"GET"})',
    'new Request("https://local.test/ready", {...options})', 'new Request("https://local.test/ready", {method:"GET",method:"POST"})',
    'new globalThis.Request("https://local.test/ready")', 'request',
  ]) assert.equal(facts(await analyze(httpImport + 'const app=new Server();app.get("/ready",()=>{});app.handle(' + request + ');')).length, 0, request);
});

test('unsupported paths, mounting, hooks, route competition and callbacks veto the whole inventory', async () => {
  for (const extra of [
    'app.get("/ready",()=>{});', 'app.get("/ready", handler);', 'app.get("/other",function(){});',
    'app.get("/other",()=>{},options);', 'app.use(plugin);', 'app.group("/api",group);',
    'app.mount("/api",handler);', 'app.guard(options);', 'app.onBeforeHandle(hook);',
    'app.get("/next",()=>{}).post("/chained",()=>{});', 'app["get"]("/other",()=>{});',
    'app?.get("/other",()=>{});', 'app.get?.("/other",()=>{});',
  ]) assert.equal(facts(await analyze(httpImport + http + extra)).length, 0, extra);
  for (const path of ['/wild/*','/users/:id','/query?x=private','/hash#private','/escaped%2fkey','/trailing/','//double','/../up','/name.json','/space here','/\u00e9','/'+'x'.repeat(256)]) {
    assert.equal(facts(await analyze(httpImport + http.replace('"/ready"', JSON.stringify(path)))).length, 0, path);
  }
  for (const url of ['https://user:private@local.test/ready','https://local.test/ready?secret=value','https://local.test/ready#private','https://local.test/%72eady','https://local.test','https://[::1]/ready','https://local.test:65536/ready','https://999.0.0.1/ready','ftp://local.test/ready']) {
    assert.equal(facts(await analyze(httpImport + http.replace('https://private.invalid/ready', url))).length, 0, url);
  }
});

test('RPC middleware, transforms, subrouters, numeric keys and ambiguous caller families are unsupported', async () => {
  for (const changed of [
    rpc.replace('t.procedure.query', 't.procedure.use(middleware).query'),
    rpc.replace('t.procedure.query', 't.procedure.input(schema).query'),
    rpc.replace('t.procedure.query', 't.procedure.output(schema).query'),
    rpc.replace('t.procedure.query', 't.procedure.subscription'),
    rpc.replace('ready: t.procedure.query', '1: t.procedure.query'),
    rpc.replace('ready: t.procedure.query', '"ready": t.procedure.query'),
    rpc.replace('ready: t.procedure.query', '[name]: t.procedure.query'),
    rpc.replace('ready: t.procedure.query', 'then: t.procedure.query'),
    rpc.replace('save: t.procedure.mutation', 'ready: t.procedure.mutation'),
    rpc.replace('ready: t.procedure.query(() => "private-result")', 'ready: t.router({nested:t.procedure.query(()=>{})})'),
    rpc.replace('ready: t.procedure.query(() => "private-result")', 'ready: otherProcedure'),
    rpc.replace('t.router({', 't.router({...shared,'),
    rpc.replace('router.createCaller({})', 'router.createCaller(context)'),
    rpc.replace('router.createCaller({})', 'router.createCaller(()=>({}))'),
    rpc.replace('router.createCaller({})', 'router.createCaller({user:secret})'),
    rpc.replace('caller.ready()', 'caller.missing()'),
    rpc.replace('caller.ready()', 'caller["ready"]()'),
    rpc.replace('caller.ready()', 'caller?.ready()'),
    rpc.replace('caller.ready()', 'caller.ready?.()'),
    rpc.replace('caller.ready()', 'caller.ready(...values)'),
    rpc + 'const another = router.createCaller({});',
    rpc + 'const other = t.router({wrong:t.procedure.query(()=>{})}); const wrongCaller=other.createCaller({});wrongCaller.ready();',
    rpc + 't.mergeRouters(router,other);',
  ]) assert.equal(facts(await analyze(rpcImport + changed)).length, 0, changed);
});

test('full-source mutation, escape, extraction and inert dynamic-evaluation references veto all new facts', async () => {
  for (const extra of [
    'app = other;', 'app.get = other;', 'delete app.handle;', 'Object.assign(app, overrides);',
    'Server.prototype.handle = other;', 'Server = Other;', 'const Creator=Server;',
    'const receiver=app;', 'const method=app.handle;', 'const {handle}=app;', 'unknown(app);',
    'function leak(){return app;}', 'const escaped={app};',
    'globalThis.eval(inertText);', 'globalThis["eval"](inertText);', 'const run=globalThis.eval;',
    'globalThis?.[key](inertText);', 'const ambient=globalThis;', 'const make=Function;',
    'const {constructor:make}=(()=>{});', 'const load=require;', 'import(moduleName);',
    'const load=process.getBuiltinModule;', 'const load=module["require"];',
  ]) {
    const result = await analyze(httpImport + http + extra);
    assert.equal(facts(result).length, 0, extra); assert.notEqual(report(result).state, 'complete', extra);
  }
  for (const extra of ['const alias=t;', 'const alias=router;', 'const alias=caller;', 'unknown(router);', 'caller.ready=other;', 'router._def.procedures=other;', 't.procedure=other;', 'init.create=other;', 'const get=caller.ready;', 'function leak(){return caller;}']) {
    assert.equal(facts(await analyze(rpcImport + rpc + extra)).length, 0, extra);
  }
});

test('registration order and execution remain conditions; branches and unsupported placements are rejected', async () => {
  const source = httpImport + 'const app=new Server(); app.handle(new Request("https://local.test/ready")); app.get("/ready",()=>{});';
  const result = await analyze(source); assert.equal(units(result).length, 3);
  for (const unit of units(result)) assert.deepEqual(fields(unit,'condition').sort(), [...rules.conditions,...rules.httpConditions].sort());
  const rpcResult = await analyze(rpcImport + rpc);
  for (const unit of units(rpcResult)) assert.deepEqual(fields(unit,'condition').sort(), [...rules.conditions,...rules.rpcConditions].sort());
  const call = 'app.handle(new Request("https://local.test/ready"))';
  for (const placement of [`if (ready) ${call};`, `for (;;) {${call};}`, `while (ready) {${call};}`, `try {${call};} catch {}`, `ready && ${call};`, `unknown(${call});`, `class Owner { send(){return ${call};}}`]) {
    assert.equal(facts(await analyze(httpImport + http + placement)).length, 0, placement);
  }
  for (const placement of [`export function send(){return ${call};}`, `const send=()=>${call};`, `const response=await ${call};`]) {
    const result = await analyze(httpImport + http + placement);
    assert.equal(units(result,'dispatch-call').length, 2, placement);
  }
});

test('UTF8 CRLF and TSX source locators remain exact without source bodies or private paths', async () => {
  const source = '// \u4e2d\ud83d\ude00\r\n' + httpImport.replace('\n','\r\n') + http.replace('"private-response"','<div/>') + '\r\n' + rpcImport + rpc;
  const result = await analyze(source,{path:'private/elsewhere.tsx',language:'tsx'});
  assert.equal(report(result).state, 'complete');
  for (const unit of units(result)) {
    assert.ok(text(source, dispatchBindingSpan(unit.evidence.span)).length);
    for (const property of ['allocation','import','initializer','owner','receiver','selector','method','method-literal','handler','argument','request','request-constructor','request-import','caller','context']) {
      for (const locator of fields(unit,property)) assert.ok(text(source,locator).length);
    }
  }
  const encoded = JSON.stringify(facts(result)); assert.ok(!encoded.includes('private/')); assert.ok(!encoded.includes('private-')); assert.ok(!encoded.includes('private.invalid'));
});

test('comments and trailing commas preserve exact bounded syntax without runtime evaluation', async () => {
  const source='import {Elysia as Server,} from "elysia"; const app=new Server(/*none*/);'
    + 'app.get(/*path*/"/ready",()=>{},); app.handle(new Request("https://local.test/ready",{method:"GET",},),);'
    + 'import {initTRPC as init,} from "@trpc/server";const t=init.create(/*none*/);'
    + 'const router=t.router({ready:t.procedure.query(()=>{},),});const caller=router.createCaller({/*empty*/},);caller.ready(payload,);';
  const result=await analyze(source);
  assert.equal(report(result).state,'complete'); assert.equal(units(result,'dispatch-family').length,2);
  assert.equal(units(result,'dispatch-handler').length,2); assert.equal(units(result,'dispatch-call').length,2);
  for(const unit of units(result)) for(const locator of fields(unit,'argument')) assert.ok(text(source,locator).length);
});

test('source, inventory, work, depth, family, endpoint and output limits never leave partial units', async () => {
  const source = httpImport + http;
  for (const suffix of ['function broken( {', 'export {other} from "external";']) assert.equal(facts(await analyze(source + suffix)).length, 0);
  for (const limits of [{maxFacts:1},{maxFacts:50},{maxFacts:80},{maxWork:50},{maxWork:1000},{maxDepth:4},{maxDeclarations:1},{maxValueBytes:32},{maxResultBytes:1800}]) {
    const result = await analyze(source,{limits}); assert.equal(facts(result).length,0,JSON.stringify(limits)); assert.notEqual(report(result).state,'complete',JSON.stringify(limits));
  }
  const eight = await analyze(httpImport + Array.from({length:8},(_,i)=>`const app${i}=new Server();`).join(''));
  assert.equal(units(eight,'dispatch-family').length,8);
  for (const unit of units(eight)) assert.equal(field(unit,'family-count'),8);
  const thirtyTwo=await analyze(httpImport+'const app=new Server();'+Array.from({length:32},(_,i)=>`app.get('/p${i}',()=>{});`).join(''));
  assert.equal(field(units(thirtyTwo,'dispatch-family')[0],'endpoint-count'),32);
  const sixteen=await analyze(rpcImport+rpc.replace('caller.ready()', 'caller.ready('+Array.from({length:16},()=> 'value').join(',')+')'));
  assert.equal(field(units(sixteen,'dispatch-call').find(unit=>field(unit,'procedure-key')==='ready'),'argument-count'),16);
  for (const input of [
    httpImport + Array.from({length:9},(_,i)=>`const app${i}=new Server();`).join(''),
    httpImport + 'const app=new Server();' + Array.from({length:33},(_,i)=>`app.get('/p${i}',()=>{});`).join(''),
    source + 'unrelated;'.repeat(1600),
    source + 'const nested=' + '('.repeat(70) + 'value' + ')'.repeat(70) + ';',
    rpcImport + rpc.replace('caller.ready()', 'caller.ready(' + Array.from({length:17},()=> 'value').join(',') + ')'),
  ]) { const result=await analyze(input); assert.equal(facts(result).length,0); assert.notEqual(report(result).state,'complete'); }
  const manifest=structuredClone(await annotationManifest()), params=sourceParams(source);
  manifest.plugins=manifest.plugins.filter(plugin=>plugin.id==='dispatch-binding');
  const {id,...body}=manifest; manifest.id=sha256(canonicalJSON(body));
  const plugin=createDispatchBindingPlugin(manifest.plugins[0]), emitted=[];
  const oversized=plugin.analyze({document:{source:'x'.repeat(rules.maxSourceBytes+1)},view:{state:'complete',limits:{maxDiagnostics:32,maxValueBytes:1024}},budget:{step(){}}},{role:value=>emitted.push(value),property:value=>emitted.push(value)});
  assert.equal(oversized.state,'truncated'); assert.deepEqual(emitted,[]);
  const engine=createAnnotationEngine({manifest,plugins:[plugin],digest:sha256}); let checks=0;
  const document={source,sourceHash:params.sourceHash,relativePath:params.relativePath,language:params.language};
  const cancelled=await inspectSource(params,source,tree=>engine.analyze(document,createTypeScriptView({tree,...document,limits:manifest.limits}),{cancelled:()=>++checks>30}));
  assert.equal(report(cancelled).state,'truncated'); assert.equal(facts(cancelled).length,0);
});

test('deterministic producer ordering retains a full dispatch census or none across shared budget boundaries', async () => {
  const source = httpImport + http;
  const baseline = facts(await analyze(source));
  assert.equal(baseline.length, 88);
  let completed = 0, truncated = 0;
  for (const limits of [
    ...[500, 1000, 1500, 1800, 2000, 3000].map(maxWork => ({ maxWork })),
    ...[1, 40, 80, 87, 88, 89, 120].map(maxFacts => ({ maxFacts })),
  ]) {
    const result = await analyze(source, { limits });
    if (report(result).state === 'complete') {
      completed++;
      assert.deepEqual(facts(result), baseline, JSON.stringify(limits));
    } else {
      truncated++;
      assert.equal(facts(result).length, 0, JSON.stringify(limits));
    }
  }
  assert(completed > 0 && truncated > 0);
});
