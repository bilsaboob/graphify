import { loadModule } from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, hash } from './helpers.mjs';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');

function view(source, options = {}) {
  const language = options.language ?? 'tsx';
  const parsed = parse(source, language);
  try { return createTypeScriptView({ tree: parsed.tree, source, language, relativePath: 'fixture.tsx', sourceHash: hash(source), ...options }); }
  finally { parsed.close(); }
}
const find = (v, text, type) => v.nodes.find((node) => v.text(node) === text && (!type || type === node.type));
const call = (v, name) => v.nodes.find((node) => node.type === 'call_expression' && v.text(node.fields.function) === name);

test('erased this parameters and comments preserve actual parameter shadowing', () => {
  for (const parameter of ['this: Context, /* receiver */ factory: unknown', 'this: Context, ...factory: unknown[]']) {
    const v = view(`import {factory} from 'library'; function invoke(${parameter}) { return factory(); }`);
    assert.equal(v.state, 'complete', JSON.stringify(v.diagnostics));
    const name = call(v, 'factory').fields.function;
    assert.equal(v.binding(name).kind, 'parameter');
    assert.notEqual(v.resolve(name).kind, 'import');
    assert(!v.declarations.some(d => d.name === 'this'));
  }
});

test('larger expression values do not widen declaration-name and export metadata caps', () => {
  const v = view(`const ${'x'.repeat(2049)}=1;const value=1;export {value as ${'y'.repeat(2049)}};`);
  assert(v.diagnostics.some(d => d.code === 'typescript.name-limit'));
  assert(v.diagnostics.some(d => d.code === 'typescript.export-limit'));
  assert(v.declarations.every(d => (d.name?.length ?? 0) <= 2048 && d.exports.every(name => name.length <= 2048)));
});

test('detached frozen nodes survive parser deletion and do not expose mutation', () => {
  const v = view('export const x = 1;');
  assert.equal(v.state, 'complete');
  assert.equal(v.root.type, 'program');
  for (const value of [v, v.root, v.root.children, v.declarations, ...v.nodes]) assert(Object.isFrozen(value));
  assert.equal(v.root.delete, undefined);
  assert.equal(v.root.tree, undefined);
  assert.equal(v.root.edit, undefined);
  assert.throws(() => { v.root.type = 'changed'; });
  assert.equal(v.text(v.root), 'export const x = 1;');
});

test('exact UTF8 spans preserve BOM, CRLF, astral characters and inclusive lines', () => {
  const source = '\uFEFF// \u{1f680}\r\nexport const \u03b1 = "\u{1f642}";\r\nexport function render() {\r\n return \u03b1;\r\n}\r\n';
  const v = view(source);
  for (const node of v.nodes) {
    const span = v.span(node);
    assert.equal(Buffer.from(source).subarray(span.startByte, span.endByte).toString('utf8'), v.text(node));
    assert.equal(span.startLine, source.slice(0, node.startIndex).split('\n').length);
    assert.equal(span.endLine, source.slice(0, Math.max(node.startIndex, node.endIndex - 1)).split('\n').length);
  }
  assert.deepEqual(v.declarations.find((d) => d.name === '\u03b1').exports, ['\u03b1']);
});

test('inventory covers lists, destructuring, members, overloads, exports and default', () => {
  const v = view(`export const first = 1, second = 2;
    export const { renamed: third, fourth, nested: { fifth } } = unknown;
    export class Model { ordinary = 1; method() {} static count = 0; }
    export interface Props { field: string; method(): void; }
    export type T = Props;
    function render(x: string): string;
    function render(x: string) { return x; }
    export { first as Alias }; export default Model;`);
  const names = v.declarations.map((d) => d.name).filter(Boolean);
  for (const name of ['first', 'second', 'third', 'fourth', 'fifth', 'Model', 'ordinary', 'method', 'count', 'Props', 'field', 'T', 'render']) assert(names.includes(name), name);
  assert.equal(new Set(v.declarations.map((d) => d.key)).size, v.declarations.length);
  assert.equal(v.declarations.filter((d) => d.name === 'render').length, 2);
  assert.deepEqual(v.declarations.find((d) => d.name === 'first').exports, ['first', 'Alias']);
  assert.deepEqual(v.declarations.find((d) => d.name === 'Model').exports, ['Model', 'default']);
  assert.equal(v.state, 'complete');
  const fifth = v.declarations.find(d => d.name === 'fifth');
  assert.deepEqual(fifth.binding.operations.map(op => op.key), ['nested', 'fifth']);
  assert.equal(v.initializerProjection(fifth.key).complete, false);
});

test('keys are independent of relative context, source hash and unrelated limits', () => {
  const source = 'export const component = () => 1; class C { value = 1; }';
  const a = view(source), b = view(source, { relativePath: 'elsewhere.tsx', sourceHash: 'a'.repeat(64), limits: { maxFacts: 2 } });
  assert.deepEqual(a.declarations.map((d) => d.key), b.declarations.map((d) => d.key));
});

test('import aliases, namespace members, immutable alias and type-only spaces', () => {
  const v = view(`import {component as make, type Field} from 'library'; import * as lib from 'library';
    const alias = make; const one = alias(); const two = lib.component(); type T = Field<string>; const invalid = Field();`);
  assert.deepEqual(v.resolve(call(v, 'alias').fields.function), { kind: 'import', module: 'library', name: 'component' });
  assert.deepEqual(v.resolve(call(v, 'lib.component').fields.function), { kind: 'import', module: 'library', name: 'component' });
  assert.equal(v.resolve(call(v, 'Field').fields.function).kind, 'expression');
  const type = v.nodes.find((node) => node.type === 'generic_type').fields.name;
  assert.equal(v.resolve(type, 'type').kind, 'import');
});

for (const [name, body] of [
  ['parameter', 'function f(make) { const x = make(); }'],
  ['block TDZ', '{ const x = make(); const make = other; }'],
  ['function hoisting', 'function f() { const x = make(); function make() {} }'],
  ['var hoisting', 'function f() { const x = make(); if (true) { var make = other; } }'],
  ['catch parameter', 'try {} catch (make) { const x = make(); }'],
  ['loop binding', 'for (const make of values) { const x = make(); }'],
  ['assignment', 'make = other; const x = make();'],
]) test(`lexical ${name} does not resolve to the outer factory`, () => {
  const v = view(`import { make } from 'library'; ${body}`);
  assert.notEqual(v.resolve(call(v, 'make').fields.function).kind, 'import');
});

test('wrappers preserve expression identity and copied nodes resolve correctly', () => {
  const v = view(`import {make} from 'library'; const x = ((make as Factory))();`);
  const node = call(v, '((make as Factory))').fields.function;
  assert.equal(v.resolve(JSON.parse(JSON.stringify(node))).kind, 'import');
  assert.equal(v.owner(JSON.parse(JSON.stringify(node))).name, 'x');
});

test('safe constants respect spread ordering, templates and escapes without execution', () => {
  const v = view('const suffix = "view"; const base = { name: "old", designName: "design" }; const options = { ...base, name: `new-${suffix}`, designConcept: "x\\u{1f680}" }; use(options);');
  const options = call(v, 'use').fields.arguments.children[0];
  assert.equal(v.constantProperty(options, 'name').value, 'new-view');
  assert.equal(v.constantProperty(options, 'name').resolution, 'constant');
  assert.equal(v.constantProperty(options, 'designName').value, 'design');
  assert.equal(v.constantProperty(options, 'designName').resolution, 'constant');
  assert.equal(v.constantProperty(options, 'designConcept').value, 'x\u{1f680}');
  assert.equal(v.constantProperty(options, 'missing').reason, 'absent');
});

test('unknown spreads override earlier properties, explicit later properties override spreads', () => {
  const v = view('const a = {name:"known",...unknown}; const b = {...unknown,name:"later"}; use(a,b);');
  const [a,b] = call(v, 'use').fields.arguments.children;
  assert.equal(v.constantProperty(a, 'name').known, false);
  assert.equal(v.constantProperty(b, 'name').value, 'later');
});

for (const source of [
  'const options = { name: "safe" }; options.name = "mutated"; use(options);',
  'const options = { name: "safe" }; escape(options); use(options);',
  'const options = { get name() { throw new Error(); } }; use(options);',
  'const options = { [unknown]: "dynamic" }; use(options);',
  'const options = { name: execute() }; use(options);',
  'const options = { name: `prefix-${execute()}` }; use(options);',
]) test(`unsafe constant remains unknown: ${source}`, () => {
  const v = view(source);
  assert.equal(v.constantProperty(call(v, 'use').fields.arguments.children[0], 'name').known, false);
});

test('parse errors, cancellation, depth and declaration/work limits are explicit', () => {
  const broken=view('const broken = (');
  assert.equal(broken.state, 'unsupported');
  assert(Object.isFrozen(broken.diagnostics[0]));
  assert.equal(view('const a = 1;', { cancelled: () => true }).state, 'truncated');
  assert.equal(view('const a = 1;', { limits: { maxWork: 1 } }).state, 'truncated');
  assert.equal(view('const a=1,b=2,c=3;', { limits: { maxDeclarations: 2 } }).state, 'truncated');
  assert.equal(view(`const a = ${'('.repeat(140)}1${')'.repeat(140)};`).state, 'truncated');
  assert.throws(() => view('const x=1;', { limits: { maxWork: 2000001 } }));
});

test('named expressions do not shadow their outer scope; type parameters shadow imports', () => {
  const v = view(`import {make, type Field} from 'library';
    const local = function make() { return make(); }; const outside = make();
    type T<Field> = Field<string>; export {T};`);
  const calls = v.nodes.filter((node) => node.type === 'call_expression' && v.text(node.fields.function) === 'make');
  assert.equal(v.resolve(calls[0].fields.function).kind, 'declaration');
  assert.equal(v.resolve(calls[1].fields.function).kind, 'import');
  const type = v.nodes.find((node) => node.type === 'generic_type').fields.name;
  assert.equal(v.resolve(type,'type').kind, 'type');
  assert.deepEqual(v.declarations.find((d) => d.name === 'T').exports, ['T']);
});

test('anonymous default classes/functions are inventoried and reexports are partial', () => {
  for (const source of ['export default function() {}', 'export default class { method() {} }']) {
    const v = view(source);
    assert(v.declarations.some((d) => d.exports.includes('default')));
  }
  assert.equal(view("export { C } from './other';").state,'partial');
});

test('object escape through a property and namespace alias mutations are not constant origins', () => {
  const v=view('const options={name:"before"}; const box={options:options}; mutate(box); use(options);');
  assert.equal(v.constantProperty(call(v,'use').fields.arguments.children[0],'name').known,false);
  const aliased=view("import * as lib from 'library'; const alias=lib; alias.make=other; lib.make();");
  assert.notEqual(aliased.resolve(call(aliased,'lib.make').fields.function).kind,'import');
});

test('a field call argument named undefined observes lexical shadowing', () => {
  const v=view('function f(undefined) { consume(undefined); }');
  assert.equal(v.constant(call(v,'consume').fields.arguments.children[0]).known,false);
});

test('Unicode identifier escapes share lexical identity and option keys', () => {
  const v=view("import {make as \\u0063} from 'library'; function f(c){ const x=\\u0063(); } const options={name:'old',na\\u006de:unknown}; use(options);");
  assert.notEqual(v.resolve(call(v,'\\u0063').fields.function).kind,'import');
  assert.equal(v.constantProperty(call(v,'use').fields.arguments.children[0],'name').known,false);
});

test('audit: object escapes are checked at each read within an options expression', () => {
  for (const options of ['{ignored:mutate(opts),...opts}', '{ignored:mutate(opts),name:opts.name}']) {
    const v=view(`const opts={name:'old'}; use(${options});`);
    assert.equal(v.constantProperty(call(v,'use').fields.arguments.children[0],'name').known,false);
  }
  const before=view("const opts={name:'old'}; use({...opts,ignored:mutate(opts)});");
  assert.equal(before.constantProperty(call(before,'use').fields.arguments.children[0],'name').value,'old');
  const overridden=view("const opts={name:'old'}; use({ignored:mutate(opts),...opts,name:'explicit'});");
  assert.equal(overridden.constantProperty(call(overridden,'use').fields.arguments.children[0],'name').value,'explicit');
});

test('audit: member writes through a const alias invalidate the class origin', () => {
  const v=view('class S {} const Alias=S; Alias.newScoped=(()=>null) as any; const x=S.newScoped();');
  const receiver=call(v,'S.newScoped').fields.function.fields.object;
  assert.equal(v.binding(receiver).stable,false);
  assert.equal(v.resolve(receiver).kind,'expression');
  assert.equal(v.reference(receiver).kind,'declaration');
  assert.equal(v.state,'partial');
});

test('audit2: escaped member objects cannot retain stale constants', () => {
  for (const escape of [
    "const alias=box.options; alias.name='new';",
    "const alias=(box.options as Options); alias.name='new';",
    "const alias=box['options']; alias.name='new';",
    "const holder={alias:box.options}; holder.alias.name='new';",
    "function borrow(){return box.options;} const alias=borrow(); alias.name='new';",
    'mutate(box.options);',
  ]) {
    const v=view(`const box={options:{name:'old'}}; ${escape} use(box.options);`);
    assert.equal(v.constantProperty(call(v,'use').fields.arguments.children[0],'name').known,false,escape);
  }
});

test('audit2: direct member reads and primitive spread copies remain foldable', () => {
  for (const setup of ['', "const copy={...box.options}; copy.name='new';"]) {
    const v=view(`const box={options:{name:'old'}}; ${setup} use(box.options);`);
    assert.equal(v.constantProperty(call(v,'use').fields.arguments.children[0],'name').value,'old');
  }
});

test('audit2: class self binding is available in bodies but not outer TDZ or computed keys', () => {
  const v=view(`const before=S.new(); class S extends Base<S>{
    static initial=S.new(); static create(){return S.new();} [S.new()](){}
  } const after=S.new();`);
  const calls=v.nodes.filter((node)=>node.type==='call_expression'&&v.text(node.fields.function)==='S.new');
  assert.deepEqual(calls.map((node)=>v.resolve(node.fields.function.fields.object).kind),['expression','declaration','declaration','expression','declaration']);
  const key=v.declarations.find((d)=>d.name==='S').key;
  for(const index of [1,2,4]) assert.equal(v.resolve(calls[index].fields.function.fields.object).key,key);
  const heritage=view('class S extends S {}');
  const base=heritage.nodes.find((node)=>node.type==='extends_clause').fields.value;
  assert.equal(heritage.binding(base).available,false);
  assert.equal(heritage.resolve(base).kind,'expression');
});

test('audit2: a named class expression keeps its own binding private and its outer initializer unavailable', () => {
  const v=view(`const Holder=class Inner extends Base<Inner>{
    static unavailable=Holder.new(); static create(){return Inner.new();}
  }; const outside=Inner.new();`);
  const inner=v.nodes.filter((node)=>node.type==='call_expression'&&v.text(node.fields.function)==='Inner.new');
  assert.equal(v.resolve(call(v,'Holder.new').fields.function.fields.object).kind,'expression');
  assert.equal(v.resolve(inner[0].fields.function.fields.object).kind,'declaration');
  assert.equal(v.resolve(inner[1].fields.function.fields.object).kind,'expression');
});

test('audit2: alias writes invalidate both outer and class-self value origins', () => {
  const v=view(`class S {static create(){return S.newScoped();}}
    const Alias=S; Alias.newScoped=other; const outside=S.newScoped();`);
  const calls=v.nodes.filter((node)=>node.type==='call_expression'&&v.text(node.fields.function)==='S.newScoped');
  for(const node of calls) assert.equal(v.resolve(node.fields.function.fields.object).kind,'expression');
});
