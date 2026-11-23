import { loadModule } from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createAnnotationEngine } = await loadModule('src/core/index.ts');
const { ANNOTATION_LIMITS, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/wire.ts');
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
import { parse, hash } from './helpers.mjs';

function analyze(source, options = {}) {
  const parsed = parse(source);
  let view;
  try { view = createTypeScriptView({ tree: parsed.tree, source, sourceHash: hash(source), relativePath: 'binding.tsx', language: 'tsx', ...options }); }
  finally { parsed.close(); }
  const content = { version: 1, core: { version: '1', implementationDigest: hash('core') }, view: { id: 'typescript', version: 1, implementationDigest: hash('view') }, parserDigest: hash('parser'), plugins: [], limits: { ...ANNOTATION_LIMITS, ...options.limits } };
  const manifest = { ...content, id: hash(canonicalJSON(content)) };
  const result = createAnnotationEngine({ manifest, digest: hash, plugins: [] }).analyze({ source, sourceHash: hash(source), relativePath: 'binding.tsx', language: 'tsx' }, view);
  validateAnnotationResult(JSON.parse(canonicalJSON(result)), manifest, source);
  return { view, result, manifest, declaration: name => result.declarations.find(d => d.name === name) };
}
const sourceText = (source, span) => Buffer.from(source).subarray(span.startByte, span.endByte).toString();

test('dynamic property, computed-key, nested iterator, conditional default and rest-copy operations survive AnnotationResult', () => {
  const source = '// \u{1f680}\r\nconst { x: [, value = fallback()], [brand]: other, ...rest } = await load();';
  const { result, declaration, view } = analyze(source);
  assert.equal(result.state, 'complete');
  const value = declaration('value').binding, rest = declaration('rest').binding, other = declaration('other').binding;
  assert.deepEqual(value.operations.map(op => op.kind), ['property', 'iterator', 'default']);
  assert.equal(value.operations[0].key, 'x');
  assert.equal(value.operations[1].index, 1);
  assert.equal(value.operations[2].value.text, 'fallback()');
  assert.equal(other.operations[0].key.text, 'brand');
  assert.deepEqual(rest.operations[0].excludedKeys.map(key => typeof key === 'string' ? key : key.text), ['x', 'brand']);
  for (const d of result.declarations.filter(d => d.binding)) {
    const b = d.binding;
    assert.equal(b.value, 'unknown');
    assert.equal(b.source.text, 'await load()');
    assert.equal(sourceText(source, b.sourceSpan), b.source.text);
    assert.deepEqual(b.sourceSpan, b.source.span);
    assert.equal(view.initializerProjection(d.key).complete, false);
    assert.equal(b.shapes, undefined);
    assert(Object.isFrozen(view.declarations.find(item => item.key === d.key).binding.operations));
  }
});

test('array holes and rest retain iterator positions, not numeric property identity', () => {
  const { declaration, view } = analyze('const [, first, , ...tail] = arbitraryIterable;');
  assert.equal(declaration('first').binding.operations[0].kind, 'iterator');
  assert.equal(declaration('first').binding.operations[0].index, 1);
  assert.equal(declaration('tail').binding.operations[0].kind, 'iterator-rest');
  assert.equal(declaration('tail').binding.operations[0].index, 3);
  assert.equal(view.initializerProjection(declaration('first').key).complete, false);
  const emptyRest = analyze('const {...rest}=unknown;').declaration('rest').binding;
  assert.deepEqual(emptyRest.operations[0].excludedKeys, []);
});

test('object shorthand defaults are conditional operations even when literal values are present', () => {
  for (const initializer of ['{}', '{value:undefined}', '{value:1}', 'getters']) {
    const { declaration, view } = analyze(`const {value=effect()}=${initializer}; use(value);`);
    assert.deepEqual(declaration('value').binding.operations.map(op => op.kind), ['property', 'default']);
    assert.equal(declaration('value').binding.operations[1].value.text, 'effect()');
    const usage = view.nodes.find(n => n.type === 'arguments' && view.text(n) === '(value)').children[0];
    assert.equal(view.constant(usage).known, false);
  }
});

test('local fresh returns and bounded conditional tuples describe shape without value or purity proof', () => {
  const cases = [
    ['function path(){ inspect(); if(bad) fail(); return {source, name, explicit: test()}; } const {name}=path();', 'name', 'object', ['source', 'name', 'explicit']],
    ['const parsePart=(raw)=>{const part=raw.trim();while(scan(part)) mutate();return {baseKey, bracketExprs};}; const {baseKey}=parsePart(input);', 'baseKey', 'object', ['baseKey', 'bracketExprs']],
    ['function harness(){const ctx={run(){return 0;}}; const statements=[];return {ctx,statements};}const {ctx}=harness();', 'ctx', 'object', ['ctx', 'statements']],
    ['const pair=()=>[unknown(),other()];const [first]=pair();', 'first', 'tuple', 2],
    ['function pair(){if(flag)return [a,b];else return [c];}const [first]=pair();', 'first', 'tuple', 2],
  ];
  for (const [source, name, kind, expected] of cases) {
    const { declaration, view } = analyze(source);
    const d = declaration(name), shapes = d.binding.shapes;
    assert.equal(shapes[0].kind, kind, source);
    assert.deepEqual(kind === 'object' ? shapes[0].keys : shapes[0].length, expected, source);
    assert.equal(sourceText(source, shapes[0].span)[0], kind === 'object' ? '{' : '[');
    assert.equal(view.initializerProjection(d.key).complete, false, source);
    assert.equal(d.binding.value, 'unknown');
  }
  for (const source of ['const [x]=flag?[first,second]:[];', 'function pair(){if(flag)return [first,second];return [];}const [x]=pair();']) {
    const { declaration, view } = analyze(source);
    assert.deepEqual(declaration('x').binding.shapes.map(shape=>shape.length), [2,0]);
    assert.equal(view.initializerProjection(declaration('x').key).complete, false);
  }
});

for (const source of [
  'function pair(){if(flag)return [1];}const [x]=pair();',
  'function pair(){if(flag)return unknown;return [1];}const [x]=pair();',
  'function pair(){try{return [1];}finally{return unknown;}}const [x]=pair();',
  'function pair(){for(const item of items){if(item)return unknown;}return [1];}const [x]=pair();',
  'async function pair(){return [1];}const [x]=pair();',
  'function* pair(){return [1];}const [x]=pair();',
  'function pair(){return pair();}const [x]=pair();',
  'const pair=()=>[1];pair=other;const [x]=pair();',
  'const pair=()=>[1];function use(pair){const [x]=pair();}',
  'const pair=()=>unknown;const [x]=pair();',
  'const [x]=flag?[1]:unknown;',
  'const [x]=[...unknown];',
  'const {x}={get x(){return 1;}};',
  'const {x}={...unknown,x:1};',
  'const object={x:1};mutate(object);const {x}=object;',
  'const object={x:1};object.x=2;const {x}=object;',
  'const tuple=[1];const [x]=mutate(tuple)?tuple:[];',
  'const object={x:1};const {x}=mutate(object)?object:{};',
]) test(`unsupported shape stays absent while source operations remain: ${source}`, () => {
  const { result, declaration } = analyze(source);
  assert.equal(result.state, 'complete');
  assert.equal(declaration('x').binding.shapes, undefined);
  assert.equal(declaration('x').binding.value, 'unknown');
});

test('shape observations capture the source before later escapes but after conditional side effects', () => {
  const before=analyze('const tuple=[1];const [x]=flag?tuple:[];mutate(tuple);');
  assert.deepEqual(before.declaration('x').binding.shapes.map(shape=>shape.length),[1,0]);
  const after=analyze('const tuple=[1];const [x]=mutate(tuple)?tuple:[];');
  assert.equal(after.declaration('x').binding.shapes,undefined);
});

test('shape alternative, key, tuple and local traversal limits omit whole summaries, not prefixes', () => {
  const choices = values => values.length === 1 ? values[0] : `(flag?${choices(values.slice(0,Math.floor(values.length/2)))}:${choices(values.slice(Math.floor(values.length/2)))})`;
  for(const count of [16,17]) {
    const {declaration}=analyze(`const [x]=${choices(Array(count).fill('[1]'))};`);
    assert.equal(declaration('x').binding.shapes?.length,count===16?16:undefined);
  }
  for(const count of [64,65]) {
    const tuple=analyze(`const [x]=[${Array(count).fill('1').join(',')}];`);
    assert.equal(tuple.declaration('x').binding.shapes?.[0].length,count===64?64:undefined);
    const object=analyze(`const {x}={${Array.from({length:count},(_,i)=>`k${i}:unknown`).join(',')}};`);
    assert.equal(object.declaration('x').binding.shapes?.[0].keys.length,count===64?64:undefined);
  }
  const large=analyze(`function make(){${'effect();'.repeat(180)}return {x:1};}const {x}=make();`);
  assert.equal(large.declaration('x').binding.shapes,undefined);
  assert.equal(large.result.state,'complete');
});

test('local pattern writes share RHS snapshot provenance and never sequentially fold swaps', () => {
  const source = 'let [row]=await query(); [row]=await next(); let read=left,write=right; for(let i=0;i<2;i++){[read,write]=[write,read];} use(read,write,row);';
  const { result, declaration, view } = analyze(source);
  assert.equal(result.state, 'complete');
  assert.equal(declaration('row').binding.source.text, 'await query()');
  assert.equal(declaration('row').writes[0].source.text, 'await next()');
  const read = declaration('read').writes[0], write = declaration('write').writes[0];
  assert.deepEqual(read.source, write.source);
  assert.deepEqual(read.patternSpan, write.patternSpan);
  assert.equal(read.source.text, '[write,read]');
  assert.deepEqual([read.operations[0].index, write.operations[0].index], [0,1]);
  const call = view.nodes.find(n=>n.type==='call_expression' && view.text(n.fields.function)==='use');
  for(const argument of call.fields.arguments.children) assert.equal(view.constant(argument).known,false);
  assert.equal(view.initializerProjection(declaration('row').key).complete,false);
});

test('computed symbol declarations retain authored expression identity with no string name', () => {
  const { result, declaration } = analyze('const brand=Symbol("brand"); interface Repo {readonly [brand]: unknown;} class List { [Symbol.iterator](){return iterator;} }');
  assert.equal(result.state,'complete');
  const computed = result.declarations.filter(d=>d.computedName).sort((a,b)=>a.span.startByte-b.span.startByte);
  assert.deepEqual(computed.map(d=>d.computedName.text),['brand','Symbol.iterator']);
  assert(computed.every(d=>d.name===undefined && d.computedName.kind==='expression'));
  assert.equal(computed[0].owner,declaration('Repo').key);
  assert.equal(computed[1].owner,declaration('List').key);
});

test('structural limits, lost declarations, cancellation and unsupported write targets remain explicit', () => {
  const deep = `const ${'['.repeat(25)}x${']'.repeat(25)}=unknown;`;
  assert.notEqual(analyze(deep).result.state,'complete');
  const rest = `const {${Array.from({length:65},(_,i)=>'k'+i).join(',')},...rest}=unknown;`;
  assert.equal(analyze(rest).result.state,'partial');
  assert.equal(analyze('const [x]=unknown;', {cancelled:()=>true}).result.state,'truncated');
  assert.notEqual(analyze('const [x,y]=unknown;', {limits:{maxDeclarations:2}}).result.state,'complete');
  assert.equal(analyze('const [x]=unknown;', {limits:{maxValueBytes:256}}).result.state,'partial');
  const tiny=analyze('const [x]=unknown;', {limits:{maxValueBytes:1}}).result;
  assert.equal(tiny.state,'partial');
  assert.deepEqual(tiny.diagnostics,[]);
  for(const source of ['[unknown]=rows;','class C {x;run(){[this.x]=rows;}}','for([row] of rows){}']) {
    assert.equal(analyze(source).result.state,'partial');
  }
  const writes = analyze('let x;'+Array.from({length:65},()=> '[x]=rows;').join(''));
  assert.equal(writes.result.state,'partial');
  assert.equal(writes.declaration('x').writes.length,64);
});
