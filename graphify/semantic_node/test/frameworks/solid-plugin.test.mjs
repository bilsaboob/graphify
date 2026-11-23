import { loadModule, parse, hash } from '../helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
const { createSolidPlugin, solidReturnContracts } = await loadModule('src/frameworks/solid/index.ts');
const { createAnnotationEngine, ANNOTATION_LIMITS, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');

const plugin = createSolidPlugin({ implementationDigest: hash('solid-code'), configurationDigest: hash('solid-configuration') });
function analyze(source, options = {}) {
  const language = options.language ?? 'tsx';
  const document = { source, sourceHash: hash(source), relativePath: 'fixture.tsx', language };
  const parsed = parse(source, language);
  let view;
  try { view = createTypeScriptView({ tree: parsed.tree, ...document, returnContracts: options.returnContracts ?? solidReturnContracts, ...(options.viewLimits ? { limits: options.viewLimits } : {}) }); }
  finally { parsed.close(); }
  const plugins = options.plugins ?? [plugin];
  const descriptor = { version: 1, core: { version: '1', implementationDigest: hash('core') }, view: { id: 'typescript', version: 1, implementationDigest: hash('view') }, parserDigest: hash('parser'), plugins: plugins.map((item) => item.descriptor), limits: { ...ANNOTATION_LIMITS, ...options.limits } };
  const manifest = { ...descriptor, id: hash(canonicalJSON(descriptor)) };
  const result = createAnnotationEngine({ manifest, plugins, digest: hash }).analyze(document, view, options.cancelled ? { cancelled: options.cancelled } : undefined);
  validateAnnotationResult(result, manifest, source);
  assert(!result.reports.some((report) => report.state === 'failed'), JSON.stringify(result.reports));
  return result;
}
const decl = (r, name) => r.declarations.find((item) => item.name === name);
const facts = (r, name, term) => r.facts.filter((item) => item.subject === decl(r,name)?.key && (!term || item.term === `solid.${term}`));
const roles = (r, term) => r.facts.filter((item) => item.kind === 'role' && item.term === `solid.${term}`).map((item) => r.declarations.find((declaration) => declaration.key === item.subject)).sort((a,b)=>a.span.startByte-b.span.startByte).map((item)=>item.name);
const slice = (source, fact) => Buffer.from(source).subarray(fact.evidence.span.startByte,fact.evidence.span.endByte).toString();

test('two signals have exact distinct accessor/setter pairing and invoked alias call targets', () => {
  const source=`import {createSignal as signal} from '@fst/components-fst-solid/solid-js';
    function setup(){ const [first,setFirst]=signal(0); const [second,setSecond]=signal(1);
      const write=setFirst; first(); second(); setFirst(2); setSecond(3); write(4); }`;
  const r=analyze(source);
  assert.equal(r.state,'complete',JSON.stringify(r));
  assert.deepEqual(roles(r,'signal-accessor'),['first','second']);
  assert.deepEqual(roles(r,'signal-setter'),['setFirst','setSecond','write']);
  assert.equal(facts(r,'setFirst','setter-for')[0].target.key,decl(r,'first').key);
  assert.equal(facts(r,'setSecond','setter-for')[0].target.key,decl(r,'second').key);
  assert.equal(facts(r,'write','setter-for')[0].target.key,decl(r,'first').key);
  assert.equal(facts(r,'write','alias-of')[0].target.key,decl(r,'setFirst').key);
  const reads=facts(r,'setup','signal-read'), writes=facts(r,'setup','signal-write');
  assert.equal(reads.length,2); assert.equal(writes.length,3);
  for(const [name,code] of [['setFirst','setFirst(2)'],['setSecond','setSecond(3)'],['write','write(4)']]) {
    const fact=writes.find((item)=>item.target.key===decl(r,name).key);
    assert.equal(slice(source,fact),code);
  }
});

test('namespace imports, destructured factory aliases and literal/return projections preserve identity', () => {
  const r=analyze(`import * as S from 'solid-js'; const {createSignal:make}=S;
    const tuple=make(0); const alias=tuple; const [get,set]=alias;
    const [{nested:[read,write]}]=[{nested:make(1)}];
    const [,onlySetter]=S.createSignal(2); set(1); write(2); onlySetter(3);`);
  assert.equal(r.state,'complete',JSON.stringify(r.diagnostics));
  assert.deepEqual(roles(r,'signal-accessor'),['get','read']);
  assert.deepEqual(roles(r,'signal-setter'),['set','write','onlySetter']);
  assert.equal(facts(r,'onlySetter','setter-for').length,0);
  assert.equal(facts(r,'write','setter-for')[0].target.key,decl(r,'read').key);
});

test('store pairs and direct nested property reads/updater calls retain occurrence evidence', () => {
  const source=`import * as Store from '@fst/components-fst-solid/solid-js/store';
    function setup(){const [state,update]=Store.createStore({user:{name:'A'}});
      const patch=update; const alias=state; const name=state.user.name; const other=alias['user'];
      update('user','name','B'); patch('user',{name:'C'});}`;
  const r=analyze(source);
  assert.equal(r.state,'complete',JSON.stringify(r.reports));
  assert.deepEqual(roles(r,'store'),['state','alias']);
  assert.deepEqual(roles(r,'store-updater'),['update','patch']);
  for(const name of ['update','patch']) assert.equal(facts(r,name,'updater-for')[0].target.key,decl(r,'state').key);
  assert.equal(slice(source,facts(r,'name','store-read')[0]),'state.user.name');
  assert.equal(facts(r,'name','store-read')[0].target.key,decl(r,'state').key);
  assert.equal(slice(source,facts(r,'other','store-read')[0]),"alias['user']");
  for(const name of ['update','patch']) assert(facts(r,'setup','store-update').some((item)=>item.target.key===decl(r,name).key));
});

test('splitProps binds disjoint literal groups/remainder to the exact props expression', () => {
  const r=analyze(`import {splitProps as split} from 'solid-js';
    function component(props){ const [local,style,rest]=split(props,['title','children'],['class'] as const);
      const alias=local; const [{title},others]=split(props,['title']); }`);
  assert.equal(r.state,'complete',JSON.stringify(r));
  assert.deepEqual(roles(r,'props-partition'),['local','style','alias']);
  assert.deepEqual(roles(r,'props-remainder'),['rest','others']);
  assert.deepEqual(roles(r,'prop'),['title']);
  assert.deepEqual(facts(r,'local','included-key').map((item)=>item.value.value).sort(),['children','title']);
  assert.deepEqual(facts(r,'rest','excluded-key').map((item)=>item.value.value).sort(),['children','class','title']);
  assert.equal(facts(r,'title','prop-key')[0].value.value,'title');
  for(const name of ['local','style','rest','alias','title','others']) assert.equal(facts(r,name,'props-source')[0].target.text,'props');
});

test('splitProps with no groups is a single props remainder',()=>{
  const r=analyze("import {splitProps} from '@fst/components-fst-solid/solid-js'; const [remaining]=splitProps(props);");
  assert.equal(r.state,'complete');
  assert.deepEqual(roles(r,'props-remainder'),['remaining']);
  assert.equal(facts(r,'remaining','props-source')[0].target.text,'props');
});

test('parenthesized getter/setter aliases retain known tuple projections',()=>{
  const r=analyze("import {createSignal} from 'solid-js'; const tuple=createSignal(0); const [get,set]=tuple; const alias=set; (get)(); (alias as Setter)(1);");
  assert.equal(r.state,'complete',JSON.stringify(r.diagnostics));
  assert.equal(r.facts.filter((item)=>item.term==='solid.signal-read').length,1);
  assert.equal(r.facts.filter((item)=>item.term==='solid.signal-write').length,1);
});

test('static numeric object keys preserve pair identity on an array return',()=>{
  const r=analyze("import {createSignal} from 'solid-js'; const {'0':get,'1':set}=createSignal(0); set(1);");
  assert.equal(r.state,'complete');
  assert.equal(facts(r,'set','setter-for')[0].target.key,decl(r,'get').key);
});

test('whole signal and store pairs retain creation evidence and safe numeric slot calls', () => {
  const source = `import {createSignal} from 'solid-js';import {createStore} from 'solid-js/store';
    function setup(){const first=createSignal('');const second=createSignal('');const store=createStore({});
      first[0]();second[1]('next');store[1]('x',1);}`;
  const r = analyze(source);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  assert.deepEqual(roles(r, 'signal-pair'), ['first', 'second']);
  assert.deepEqual(roles(r, 'store-pair'), ['store']);
  for (const name of ['first', 'second', 'store']) {
    assert.equal(facts(r, name, 'created-by').length, 1);
    assert(facts(r, name, 'return-contract')[0].value.value.includes('later slot identity requires'));
  }
  assert.equal(slice(source, facts(r, 'setup', 'signal-read')[0]), 'first[0]()');
  assert.equal(slice(source, facts(r, 'setup', 'signal-write')[0]), "second[1]('next')");
  assert.equal(slice(source, facts(r, 'setup', 'store-update')[0]), "store[1]('x',1)");
});

test('whole-pair creation is not a guarantee of live slots after mutation, escape or unknown indexing', () => {
  for (const unsafe of ['pair[1]=other;', 'const alias=pair;alias[1]=other;', 'escape(pair);']) {
    const r = analyze(`import {createSignal} from 'solid-js';function setup(){const pair=createSignal(0);${unsafe}pair[0]();pair[1](1);}`);
    assert.equal(facts(r, 'setup', 'signal-read').length, 0, unsafe);
    assert.equal(facts(r, 'setup', 'signal-write').length, 0, unsafe);
  }
  const r = analyze(`import {createSignal} from 'solid-js';const pair=createSignal(0);pair[index](1);pair[2](1);pair?.[1](1);pair(1);`);
  assert.equal(r.facts.filter(f => ['solid.signal-read','solid.signal-write'].includes(f.term)).length, 0);
  for (const prefix of ["import type {createSignal} from 'solid-js';", "import {createSignal} from './foreign';", 'function createSignal(){}']) {
    const r = analyze(`${prefix}const pair=createSignal();pair[1](1);`);
    assert.equal(roles(r, 'signal-pair').length, 0);
    assert.equal(r.facts.filter(f => f.term === 'solid.signal-write').length, 0);
  }
});

for(const [label,body] of [
  ['wrong module',"import {createSignal} from 'unrelated'; const [get,set]=createSignal();"],
  ['suffix path',"import {createSignal} from './anything/solid-js'; const [get,set]=createSignal();"],
  ['invented package path',"import {createSignal} from 'other/@fst/components-fst-solid/solid-js'; const [get,set]=createSignal();"],
  ['wrong root',"import {createSignal} from '@fst/components-fst-solid'; const [get,set]=createSignal();"],
  ['wrong store module',"import {createStore} from 'solid-js'; const [get,set]=createStore();"],
  ['type-only',"import type {createSignal} from 'solid-js'; const [get,set]=createSignal();"],
  ['type-only specifier',"import {type createSignal} from 'solid-js'; const [get,set]=createSignal();"],
  ['parameter shadow',"import {createSignal} from 'solid-js'; function f(createSignal){const [get,set]=createSignal();}"],
  ['TDZ shadow',"import {createSignal} from 'solid-js'; {const [get,set]=createSignal(); const createSignal=other;}"],
  ['var hoist',"import {createSignal} from 'solid-js'; function f(){const [get,set]=createSignal(); var createSignal=other;}"],
  ['mutation',"import {createSignal} from 'solid-js'; createSignal=other; const [get,set]=createSignal();"],
  ['namespace mutation',"import * as S from 'solid-js'; S.createSignal=other; const [get,set]=S.createSignal();"],
  ['namespace alias mutation',"import * as S from 'solid-js'; const Alias=S; Alias.createSignal=other; const [get,set]=S.createSignal();"],
  ['mutable factory alias',"import {createSignal} from 'solid-js'; let make=createSignal; const [get,set]=make();"],
  ['unknown factory',"function createSignal(){return [];} const [get,set]=createSignal();"],
  ['default',"import {createSignal} from 'solid-js'; const [get,set=other]=createSignal();"],
  ['rest',"import {createSignal} from 'solid-js'; const [get,...set]=createSignal();"],
  ['escaped tuple',"import {createSignal} from 'solid-js'; const tuple=createSignal(); escape(tuple); const [get,set]=tuple;"],
]) test(`unsupported origin/pattern does not create signal roles: ${label}`,()=>{
  const r=analyze(body);
  assert.equal(r.state, ['default', 'rest'].includes(label) ? 'partial' : 'complete');
  const binding = decl(r, 'get').binding;
  assert(binding);
  assert.equal(binding.value, 'unknown');
  assert.equal(binding.source.kind, 'expression');
  assert.equal(roles(r,'signal-accessor').length,0);
  assert.equal(roles(r,'signal-setter').length,0);
});

for(const [label,keys] of [
  ['dynamic','keys'], ['spreads',"[...keys]"], ['computed element','[key]'],
  ['duplicate within group',"['x','x']"], ['overlapping groups',"['x'],['x']"],
  ['numeric equivalent overlap',"[1],['1']"], ['holes',"[, 'x']"], ['unknown alias','literalKeys'],
]) test(`splitProps ${label} remains partial without partition facts`,()=>{
  const r=analyze(`import {splitProps} from 'solid-js'; const literalKeys=['x']; const [local,rest]=splitProps(props,${keys});`);
  assert.equal(r.state,'partial');
  assert.equal(roles(r,'props-partition').length,0);
  assert.equal(roles(r,'props-remainder').length,0);
});

test('shadowed or reassigned setter aliases never become writer facts',()=>{
  const source=`import {createSignal} from 'solid-js'; const [get,set]=createSignal(0);
    const alias=set; alias=other; alias(1); function nested(set){set(2);} set(3);`;
  const r=analyze(source);
  assert.equal(r.facts.filter((item)=>item.term==='solid.signal-write').length,0);
  assert.equal(roles(r,'signal-setter').length,0);
  assert.equal(r.state,'complete');
  assert.equal(decl(r, 'set').binding.value, 'unknown');
});

test('setters called in their TDZ and through optional/property calls are not direct writers',()=>{
  const source=`import {createSignal} from 'solid-js'; set(0); const [get,set]=createSignal(1);
    set?.(2); set.call(null,3); function nested(set){set(4);} set(5);`;
  const r=analyze(source);
  const writes=r.facts.filter((item)=>item.term==='solid.signal-write');
  assert.equal(writes.length,1);
  assert.equal(slice(source,writes[0]),'set(5)');
});

test('member tuple assignment is explicitly unsupported, not fictional stable class state',()=>{
  const r=analyze(`import {createStore} from 'solid-js/store'; class State {store;update;
    init(){[this.store,this.update]=createStore({}); this.update('x',1); return this.store.x;}}`);
  assert.equal(r.state,'partial');
  assert(r.diagnostics.some((item)=>item.code==='typescript.destructuring-assignment'));
  assert.equal(r.facts.length,0);
});

test('plugins compose independently without suppressing unrelated adapter diagnostics',async()=>{
  const {createFstSolidPlugin}=await loadModule('src/frameworks/fst-solid/index.ts');
  const fst=createFstSolidPlugin({implementationDigest:hash('fst'),configurationDigest:hash('fst-config')});
  const source=`import {component} from '@fst/components-fst-solid/app/component';
    import {createSignal,onCleanup} from '@fst/components-fst-solid/solid-js';
    export const ColorEditorExample=component(()=>{const [opaque,setOpaque]=createSignal('#d49e6b');
      const [committed,setCommitted]=createSignal(''); onCleanup(()=>{});
      function save(){setOpaque('#fff');setCommitted(opaque());}
      return <button onClick={save}>{opaque()}{committed()}</button>;},{name:'ColorEditorExample'});`;
  const r=analyze(source,{plugins:[plugin,fst]});
  assert.equal(r.state,'complete',JSON.stringify(r));
  assert(r.reports.every((item)=>item.state==='complete'));
  assert(r.facts.some((item)=>item.term==='fst-solid.component'));
  assert(r.facts.some((item)=>item.term==='solid.signal-write'));
  const unknown = analyze(source+' const [unsupported]=unknown();',{plugins:[fst,plugin]});
  assert.equal(unknown.state,'complete');
  assert.equal(decl(unknown, 'unsupported').binding.source.text, 'unknown()');
  assert.equal(decl(unknown, 'unsupported').binding.value, 'unknown');
  assert(!unknown.facts.some(f => f.subject === decl(unknown, 'unsupported').key));
});

test('source Unicode/CRLF, work, byte and cancellation ceilings remain valid',()=>{
  const source="\uFEFF// \u{1f680}\r\nimport {createSignal} from 'solid-js'; const [get,set]=createSignal('\u{1f642}'); set('\u{1f642}');\r\n";
  const r=analyze(source);
  assert.equal(slice(source,r.facts.find((item)=>item.term==='solid.signal-write')),"set('\u{1f642}')");
  for(const limits of [{maxWork:300},{maxFacts:1},{maxResultBytes:4096}]) {
    const r=analyze(source.repeat(1)+Array.from({length:10},(_,index)=>`const [get${index},set${index}]=createSignal(${index});`).join('\n'),{limits});
    assert.equal(r.state,'truncated');
    assert(Buffer.byteLength(canonicalJSON(r))<=(limits.maxResultBytes??ANNOTATION_LIMITS.maxResultBytes));
  }
  assert.equal(analyze(source,{viewLimits:{maxWork:1}}).state,'truncated');
  assert.equal(analyze(source,{cancelled:()=>true}).state,'truncated');
  assert.equal(analyze(source+' const broken = (').facts.length,0);
  assert.equal(analyze(source,{returnContracts:[]}).state,'partial');
});

test('oversized keys, references and groups report partial without invalid facts',()=>{
  const long='<'.repeat(50000);
  for(const source of [
    `import {createSignal} from 'solid-js'; const [get,set]=createSignal('${long}');`,
    `import {splitProps} from 'solid-js'; const [local,rest]=splitProps(props,['${long}']);`,
    `import {splitProps} from 'solid-js'; const [local,rest]=splitProps(props,[${Array.from({length:65},(_,i)=>`'k${i}'`).join(',')}]);`,
    `import {splitProps} from 'solid-js'; const [local,rest]=splitProps(props,['bad\\0key']);`,
  ]) assert.equal(analyze(source).state,'partial');
});

test('Solid has its own vocabulary and no executable framework or parser imports',async()=>{
  assert.throws(()=>createSolidPlugin({implementationDigest:'fake',configurationDigest:'fake'}));
  assert.equal(plugin.descriptor.id,'solid');
  for(const terms of [plugin.descriptor.roles,plugin.descriptor.properties,plugin.descriptor.relations]) for(const term of terms) assert(term.id.startsWith('solid.'));
  for(const file of ['index.ts','contracts.ts','vocabulary.ts','semantics.ts']) {
    const source=await readFile(new URL(`../../src/frameworks/solid/${file}`,import.meta.url),'utf8');
    for(const match of source.matchAll(/^(?:import|export)\b[^\n]*\bfrom\s*['"]([^'"]+)['"]/gm)) assert(match[1].startsWith('./')||['#core','#core/wire','#typescript'].includes(match[1]),match[1]);
    assert(!/\b(?:eval|Function|require|fetch)\s*\(/.test(source));
  }
});

for(const [label,setup] of [
  ['return tuple alias', 'const tuple=createSignal();const alias=tuple;Object.assign(tuple,{1:other});const [get,set]=alias;'],
  ['factory object alias', 'const box={make:createSignal};const alias=box;Object.assign(box,{make:other});const {make}=alias;const [get,set]=make();'],
  ['nested object reference', 'const base={nested:{make:createSignal}};const {nested}=base;mutate(base);const {make}=nested;const [get,set]=make();'],
  ['nested object member escape', 'const base={nested:{make:createSignal}};const {nested}=base;Object.assign(base.nested,{make:other});const {make}=nested;const [get,set]=make();'],
  ['nested array reference', 'const base=[[createSignal]];const [nested]=base;mutate(base);const [make]=nested;const [get,set]=make();'],
  ['deferred outer alias read', 'const box={make:createSignal};const alias=box;function render(){const {make}=alias;const [get,set]=make();set(1);} Object.assign(box,{make:other});render();'],
]) test(`review: ${label} does not fabricate signal provenance`,()=>{
  const r=analyze(`import {createSignal} from 'solid-js';${setup}set(1);`);
  assert.equal(r.state,'complete');
  assert.equal(decl(r, 'get').binding.value, 'unknown');
  assert.deepEqual(roles(r,'signal-accessor'),[]);
  assert.deepEqual(roles(r,'signal-setter'),[]);
  assert(!r.facts.some((item)=>item.term==='solid.signal-write'));
});

test('review: callable snapshots survive later container escapes',()=>{
  for(const setup of [
    'const tuple=createSignal();const [get,set]=tuple;mutate(tuple);',
    'const tuple=createSignal();const alias=tuple;const [get,set]=alias;Object.assign(tuple,{1:other});',
    'const box={make:createSignal};const {make}=box;mutate(box);const [get,set]=make();',
    'const box={nested:{make:createSignal}};const {nested}=box;const {make}=nested;mutate(box);const [get,set]=make();',
    'const box=[[createSignal]];const [[make]]=box;mutate(box);const [get,set]=make();',
  ]) {
    const r=analyze(`import {createSignal} from 'solid-js';${setup}set(1);`);
    assert.equal(r.state,'complete',setup);
    assert.deepEqual(roles(r,'signal-accessor'),['get'],setup);
    assert.deepEqual(roles(r,'signal-setter'),['set'],setup);
    assert.equal(facts(r,'set','setter-for')[0].target.key,decl(r,'get').key);
    assert.equal(r.facts.filter((item)=>item.term==='solid.signal-write').length,1);
  }
});

test('review: ordinary scalar files do not pay per-const Solid projection budgets',()=>{
  const source=Array.from({length:200},(_,index)=>`const v${index}=${index};`).join('\n');
  const r=analyze(source);
  assert.equal(r.state,'complete');
  assert.equal(r.reports[0].state,'not-applicable');
  assert.equal(r.facts.length,0);
});

test('review: one signal among unrelated scalar declarations remains complete and bounded',()=>{
  const unrelated=Array.from({length:200},(_,index)=>`const v${index}=${index};`).join('\n');
  const source=`import {createSignal} from 'solid-js';${unrelated}const [get,set]=createSignal();set(1);`;
  for(const limits of [undefined,{maxWork:10000}]) {
    const r=analyze(source,{limits});
    assert.equal(r.state,'complete');
    assert.deepEqual(roles(r,'signal-accessor'),['get']);
    assert.deepEqual(roles(r,'signal-setter'),['set']);
    assert.equal(r.facts.filter((item)=>item.term==='solid.signal-write').length,1);
  }
  assert.equal(analyze(source,{limits:{maxWork:300}}).state,'truncated');
});

test('review: numeric splitProps key groups are partial rather than string-coerced partitions',()=>{
  const r=analyze("import {splitProps} from 'solid-js';const [local,rest]=splitProps({1:'value'},[1]);");
  assert.equal(r.state,'partial');
  assert.deepEqual(roles(r,'props-partition'),[]);
  assert.deepEqual(roles(r,'props-remainder'),[]);
  assert(!r.facts.some((item)=>['solid.included-key','solid.excluded-key'].includes(item.term)));
  const valid=analyze("import {splitProps} from 'solid-js';const [{1:value},rest]=splitProps({1:'value'},['1']);");
  assert.equal(valid.state,'complete');
  assert.equal(facts(valid,'value','prop-key')[0].value.value,'1');
});
