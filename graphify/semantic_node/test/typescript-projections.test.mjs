import { loadModule } from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, hash } from './helpers.mjs';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');

const contracts = [{ id: 'fixture.pair', origins: [{ module: 'fixture', name: 'pair' }], result: { kind: 'tuple', items: [{ kind: 'value' }, { kind: 'object', properties: { nested: { kind: 'value' } } }] } }];
function view(source, options = {}) {
  const parsed = parse(source);
  try { return createTypeScriptView({ tree: parsed.tree, source, language: 'tsx', relativePath: 'fixture.tsx', sourceHash: hash(source), returnContracts: contracts, ...options }); }
  finally { parsed.close(); }
}
const sourceOf = (v, name) => v.initializerProjection(v.declarations.find((item) => item.name === name).key);
const call = (v, name) => v.nodes.find((item) => item.type === 'call_expression' && v.text(item.fields.function) === name);

test('literal destructuring preserves raw nested paths, holes and exact identifier spans', () => {
  const source = '// \u{1f680}\r\nconst [ , { renamed: [ , value], other }] = [0,{renamed:[0,42],other:"ok"}]; use(value,other);';
  const v = view(source);
  assert.equal(v.state, 'complete');
  const projection = sourceOf(v, 'value');
  assert.deepEqual(projection.path, [1, 'renamed', 1]);
  assert.equal(v.text(projection.initializer), '[0,{renamed:[0,42],other:"ok"}]');
  assert.equal(projection.complete, true);
  const normalized = v.project(projection.initializer, projection.path);
  assert.equal(v.text(normalized.initializer), '42');
  assert.deepEqual(normalized.path, []);
  const [value, other] = call(v, 'use').fields.arguments.children;
  assert.equal(v.constant(value).value, 42);
  assert.equal(v.constant(other).value, 'ok');
  for (const item of v.patternProjections(v.nodes.find((item) => item.type === 'array_pattern')).projections) {
    const span = v.span(item.node);
    assert.equal(Buffer.from(source).subarray(span.startByte,span.endByte).toString(),v.text(item.node));
    assert(Object.isFrozen(item.path));
  }
});

test('trusted nested contract, import aliases, namespace destructuring and immutable return aliases', () => {
  const v = view(`import * as lib from 'fixture'; const {pair:make}=lib;
    const result=make(); const alias=result; const [first,{nested:last}]=alias; use(last);`);
  assert.equal(v.state,'complete',JSON.stringify(v.diagnostics));
  assert.deepEqual(v.resolve(call(v,'make').fields.function),{kind:'import',module:'fixture',name:'pair'});
  for(const [name,path] of [['first',[0]],['last',[1,'nested']]]) {
    const raw=sourceOf(v,name), normalized=v.project(raw.initializer,raw.path);
    assert.equal(raw.complete,true);
    assert.equal(normalized.contract,'fixture.pair');
    assert.equal(v.text(normalized.initializer),'make()');
    assert.deepEqual(normalized.path,path);
  }
});

test('parameter projection is independent of initializer and does not invent public declarations', () => {
  const v=view('function callback([first, , {value:second}]: Slots) {}');
  const parameter=v.nodes.find((item)=>item.type==='required_parameter');
  const projected=v.patternProjections(JSON.parse(JSON.stringify(parameter)));
  assert.equal(projected.complete,true);
  assert.deepEqual(projected.projections.map((item)=>[v.text(item.node),item.path]),[['first',[0]],['second',[2,'value']]]);
  assert(!v.declarations.some((item)=>['first','second'].includes(item.name)));
  for(const source of ['function callback([first=0]) {}','function callback([...rest]) {}','function callback(value=[]) {}','function callback(value?:[]) {}']) {
    const v=view(source), parameter=v.nodes.find((item)=>['required_parameter','optional_parameter'].includes(item.type));
    assert.equal(v.patternProjections(parameter).complete,false,source);
  }
});

for(const source of [
  'const [x]=unknown();', 'const {x}=unknown;', 'const [x=0]=[1];', 'const [...x]=[1];',
  'const {[key]:x}={x:1};', 'const [x]=[...source];', 'const {x}={x:1,...source};',
  'const {x}={get x(){return 1}};', 'let [x]=[1];', 'const [x]=[1]; x=2;',
  'const tuple=[1]; tuple[0]=2; const [x]=tuple;',
  'const tuple=[1]; const alias=tuple; alias[0]=2; const [x]=tuple;',
  'const tuple=[1]; escape(tuple); const [x]=tuple;',
  'const [x]=later; const later=[1];',
  'const tuple=[{nested:1}]; const [obj]=tuple; const holder={obj}; holder.obj.nested=2; const [{nested:x}]=tuple;',
  'const tuple=[{nested:1}]; const [obj]=tuple; mutate(obj); const [{nested:x}]=tuple;',
]) test(`structural evidence does not promote an unsafe value projection: ${source}`,()=>{
  const v=view(source);
  assert.equal(v.state,'complete');
  assert.equal(v.declarations.find(item=>item.name==='x').binding.value,'unknown');
  const raw=sourceOf(v,'x');
  assert(raw);
  assert.equal(raw.complete,false);
});

test('no return contracts means no recognition; arbitrary relative suffix origins stay unknown',()=>{
  const v=view("import {pair} from 'fixture'; const [x]=pair();",{returnContracts:[]});
  assert.equal(sourceOf(v,'x').complete,false);
  assert.equal(v.declarations.find(item=>item.name==='x').binding.value,'unknown');
  for(const module of ['./fixture','anything/fixture','@other/fixture']) assert.equal(sourceOf(view(`import {pair} from '${module}'; const [x]=pair();`),'x').complete,false);
});

test('member tuple assignments remain explicit partial and cannot initialize field provenance',()=>{
  const v=view("import {pair} from 'fixture'; class C { read; write; init(){ [this.read,this.write]=pair(); } }");
  assert.equal(v.state,'partial');
  assert(v.diagnostics.some((item)=>item.code==='typescript.destructuring-assignment'));
  assert.equal(sourceOf(v,'read'),undefined);
});

test('destructuring assignment writes invalidate scalar and namespace aliases',()=>{
  for(const mutation of ['[make]=[other];','({make}=other);','[make=other]=[];','({make=other}=value);','for(make of values){}','for([make] of values){}']) {
    const v=view(`import {pair} from 'fixture'; const make=pair; ${mutation} const [x]=make();`);
    assert.equal(v.state,mutation==='for([make] of values){}'?'partial':'complete');
    assert.equal(sourceOf(v,'x').complete,false);
    assert.notEqual(v.resolve(call(v,'make').fields.function).kind,'import');
  }
});

test('static literal computed keys are bounded projections, not dynamic evaluation',()=>{
  const v=view('const {["x"]:value}={x:1}; use(value);');
  assert.equal(v.state,'complete');
  assert.deepEqual(sourceOf(v,'value').path,['x']);
  assert.equal(v.constant(call(v,'use').fields.arguments.children[0]).value,1);
});

test('authored destructuring properties after spreads retain exact value and import identity', () => {
  for (const initializer of ['{...unknown,x:42}', '{[unknown]:0,x:42}', '{...{x:42}}', '{x:1,...{x:42}}']) {
    const v = view(`const {x}=${initializer}; use(x);`);
    assert.equal(v.state, 'complete', initializer);
    assert.equal(v.constant(call(v, 'use').fields.arguments.children[0]).value, 42);
  }
  const v = view("import {pair} from 'fixture'; const {make}={...unknown,make:pair}; const [x]=make();");
  assert.equal(v.state, 'complete');
  assert.equal(v.resolve(call(v, 'make').fields.function).name, 'pair');
  for (const source of [
    'const {x}={x:42,...unknown};use(x);',
    'const {x}={x:42,[unknown]:0};use(x);',
    'const base={x:42};mutate(base);const {x}={...base};use(x);',
    'const base={x:42};const {x}={...base};x=0;use(x);',
    'const {x}={get x(){return 42}};use(x);',
  ]) {
    const v = view(source);
    assert.equal(v.state, 'complete', source);
    assert.equal(v.declarations.find(item=>item.name==='x').binding.value,'unknown');
    assert.equal(v.constant(call(v, 'use').fields.arguments.children[0]).known, false, source);
  }
});

test('empty and hole-only patterns do not hide unknown factory coverage',()=>{
  for(const pattern of ['[]','[,]','{}']) assert.equal(view(`const ${pattern}=unknown();`).state,'partial');
});

test('contract queries obey bounded metadata, source bytes, work and depth',()=>{
  const source="import {pair} from 'fixture'; const [x]=pair();";
  assert.equal(view(source,{limits:{maxWork:1}}).state,'truncated');
  assert.throws(()=>view(source,{limits:{maxSourceBytes:10}}));
  assert.throws(()=>view(source,{returnContracts:[...contracts,...contracts]}));
  assert.throws(()=>view(source,{returnContracts:[{...contracts[0],origins:[{module:'../fixture',name:'pair'}]}]}));
  const deeplyNested=`const ${'['.repeat(30)}value${']'.repeat(30)}=${'['.repeat(30)}1${']'.repeat(30)};`;
  assert.notEqual(view(deeplyNested).state,'complete');
});

for(const [label,source] of [
  ['object alias', "const base={name:'before'}; const alias=base; mutate(base); const {name}=alias; use(name);"],
  ['array alias', "const base=['before']; const alias=base; mutate(base); const [name]=alias; use(name);"],
  ['nested object', "const base={nested:{name:'before'}}; const {nested}=base; mutate(base); const {name}=nested; use(name);"],
  ['nested array', "const base=[['before']]; const [nested]=base; mutate(base); const [name]=nested; use(name);"],
  ['nested member escape', "const base={nested:{name:'before'}}; const {nested}=base; Object.assign(base.nested,{name:'after'}); const {name}=nested; use(name);"],
  ['alias chain', "const base={nested:{name:'before'}}; const {nested}=base; const alias=nested; const last=(alias as Value); mutate(base); const {name}=last; use(name);"],
  ['deferred read', "const base={name:'before'}; const alias=base; function read(){const {name}=alias;use(name);} mutate(base); read();"],
  ['deferred mutation', "const base={name:'before'}; const alias=base; change(); const {name}=alias; function change(){mutate(base);} use(name);"],
]) test(`review: ${label} cannot project stale properties after a reachable escape`,()=>{
  const v=view(source);
  assert.equal(v.state,'complete');
  assert.equal(v.declarations.find(item=>item.name==='name').binding.value,'unknown');
  assert.equal(sourceOf(v,'name').complete,false);
  assert.equal(v.constant(call(v,'use').fields.arguments.children[0]).known,false);
});

test('review: object constants through reference aliases use the current observation',()=>{
  for(const setup of [
    "const base={name:'before'};const alias=base;mutate(base);",
    "const base={nested:{name:'before'}};const {alias}= {alias:base};mutate(base);",
    "const base={nested:{name:'before'}};const {nested:alias}=base;mutate(base);",
  ]) {
    const v=view(`${setup} use(alias);`);
    assert.equal(v.constant(call(v,'use').fields.arguments.children[0]).known,false,setup);
  }
});

test('review: primitive snapshots captured before parent escapes remain known',()=>{
  for(const source of [
    "const base={name:'before'};const alias=base;const {name}=alias;mutate(base);use(name);",
    "const base={nested:{name:'before'}};const {nested}=base;const {name}=nested;mutate(base);use(name);",
    "const base=[['before']];const [nested]=base;const [name]=nested;mutate(base);use(name);",
    "const base={name:'before'};const {name}=base;function later(){use(name);} mutate(base);later();",
  ]) {
    const v=view(source);
    assert.equal(v.state,'complete',source);
    assert.equal(v.constant(call(v,'use').fields.arguments.children[0]).value,'before',source);
  }
});

test('opaque record contracts preserve symbolic paths but never fold values',()=>{
  const contract={id:'fixture.record',origins:[{module:'fixture',name:'record'}],result:{kind:'record',value:{kind:'value'}}};
  const v=view("import {record} from 'fixture';const result=record({x:1});const {x}=result;use(x);",{returnContracts:[contract]});
  assert.equal(v.state,'complete');
  assert.equal(v.project(sourceOf(v,'x').initializer,['x']).contract,'fixture.record');
  assert.equal(v.constant(call(v,'use').fields.arguments.children[0]).known,false);
  contract.result.value.kind='invalid';
  assert.equal(sourceOf(v,'x').complete,true);
});

test('construct contracts require exact qualified constructor invocation and safe receiver lookup',()=>{
  const contract={id:'fixture.construct',invocation:'construct',origins:[{module:'fixture',name:'Thing'}],result:{kind:'object',properties:{run:{kind:'value'}}}};
  const v=view("import {Thing as T} from 'fixture';const instance=new T();instance.run();instance.run();",{returnContracts:[contract]});
  const calls=v.nodes.filter((item)=>item.type==='call_expression');
  assert.equal(v.project(calls[0].fields.function).contract,'fixture.construct');
  assert.equal(v.project(calls[1].fields.function),undefined,'earlier unknown receiver method may mutate its members');
  assert.equal(sourceOf(view("import {Thing} from 'fixture';const {run}=Thing();",{returnContracts:[contract]}),'run').complete,false);
  assert.equal(sourceOf(view("import {pair} from 'fixture';const [x]=new pair();"),'x').complete,false);
  for(const body of ['const instance=new Thing();escape(instance);const {run}=instance;','let instance=new Thing();const {run}=instance;']) assert.equal(sourceOf(view(`import {Thing} from 'fixture';${body}`,{returnContracts:[contract]}),'run').complete,false);
});

test('composed contract count, depth, invocation and metadata work remain bounded',()=>{
  const contracts=Array.from({length:128},(_,i)=>({id:`fixture.c${i}`,origins:[{module:'fixture',name:`f${i}`}],result:{kind:'value'}}));
  assert.equal(view('const n=1;',{returnContracts:contracts}).state,'complete');
  assert.throws(()=>view('const n=1;',{returnContracts:[...contracts,{...contracts[0],id:'fixture.extra'}]}));
  assert.throws(()=>view('const n=1;',{returnContracts:[{...contracts[0],invocation:'both'}]}));
  const heavy=contracts.map((c)=>({...c,result:{kind:'tuple',items:Array.from({length:32},()=>({kind:'value'}))}}));
  assert.throws(()=>view('const n=1;',{returnContracts:heavy}),/metadata limit/);
  let nested={kind:'value'};for(let i=0;i<25;i++)nested={kind:'record',value:nested};
  assert.throws(()=>view('const n=1;',{returnContracts:[{...contracts[0],result:nested}]}),/metadata limit/);
  assert.equal(view('const n=1;',{returnContracts:contracts,limits:{maxWork:1}}).state,'truncated');
});

test('const static member aliases retain observation timing without stale nested writes',()=>{
  const clean=view("const base={nested:{name:'before'}};const alias=(base.nested as Value);const {name}=alias;use(name);");
  assert.equal(clean.state,'complete');assert.equal(clean.constant(call(clean,'use').fields.arguments.children[0]).value,'before');
  for(const mutation of ["alias.name='after';",'mutate(alias);','mutate(base);']) {
    const v=view(`const base={nested:{name:'before'}};const alias=base.nested;${mutation}const {name}=base.nested;use(name);`);
    assert.equal(v.state,'complete',mutation);assert.equal(sourceOf(v,'name').complete,false);assert.equal(v.constant(call(v,'use').fields.arguments.children[0]).known,false,mutation);
  }
});

test('nested namespace references retain all exact imported member segments',()=>{
  const v=view("import * as lib from 'fixture';lib.Tools.run();");
  assert.deepEqual(v.resolve(call(v,'lib.Tools.run').fields.function),{kind:'import',module:'fixture',name:'Tools',member:'run'});
  const bad=view("import * as lib from 'fixture';lib.Tools=other;lib.Tools.run();");
  assert.notEqual(bad.resolve(call(bad,'lib.Tools.run').fields.function).kind,'import');
});

test('construct projections reject replaced or escaped prototypes, including constructor aliases',()=>{
  const contract={id:'fixture.construct',invocation:'construct',origins:[{module:'fixture',name:'Thing'}],result:{kind:'object',properties:{run:{kind:'value'}}}};
  for(const mutation of [
    'Thing.prototype.run=other;',
    'const proto=Thing.prototype;proto.run=other;',
    'mutate(Thing.prototype);',
    'const proto=Thing.prototype;mutate(proto);',
  ]) {
    const v=view(`import {Thing} from 'fixture';const Alias=Thing;${mutation}const instance=new Alias();instance.run();`,{returnContracts:[contract]});
    assert.equal(v.project(call(v,'instance.run').fields.function),undefined,mutation);
  }
  const later=view("import {Thing} from 'fixture';const instance=new Thing();mutate(Thing.prototype);instance.run();",{returnContracts:[contract]});
  assert.equal(later.project(call(later,'instance.run').fields.function),undefined);
  const captured=view("import {Thing} from 'fixture';const instance=new Thing();const {run}=instance;mutate(Thing.prototype);use(run);",{returnContracts:[contract]});
  assert.equal(captured.project(call(captured,'use').fields.arguments.children[0]).contract,'fixture.construct');
});

test('review6: reference-preserving expressions propagate prototype escapes, not primitive arithmetic',()=>{
  const contract={id:'fixture.construct',invocation:'construct',origins:[{module:'fixture',name:'Thing'}],result:{kind:'object',properties:{run:{kind:'value'}}}};
  for(const escape of [
    'mutate(Thing.prototype || fallback);', 'mutate(flag && Thing.prototype);', 'mutate(Thing.prototype ?? fallback);',
    'const proto=Thing.prototype;mutate(proto || fallback);', 'const proto=Thing.prototype || fallback;mutate(proto);',
    'const proto=flag ? Thing.prototype : fallback;mutate(proto);', 'mutate((0,Thing.prototype));',
    'tag`value ${Thing.prototype}`;', 'const jsx=<Foreign value={Thing.prototype || fallback}/>;',
  ]) {
    const v=view(`import {Thing} from 'fixture';${escape}const instance=new Thing();instance.run();`,{returnContracts:[contract]});
    assert.equal(v.project(call(v,'instance.run').fields.function),undefined,escape);
  }
  for(const safe of ['observe(Thing.prototype === other);','observe(Thing.prototype + suffix);','observe(`value ${Thing.prototype}`);','observe(Thing.prototype ? 1 : 2);']) {
    const v=view(`import {Thing} from 'fixture';${safe}const instance=new Thing();instance.run();`,{returnContracts:[contract]});
    assert.equal(v.project(call(v,'instance.run').fields.function)?.contract,'fixture.construct',safe);
  }
});

test('review6: constructor prototype proof occurs after argument evaluation and preserves earlier snapshots',()=>{
  const contract={id:'fixture.construct',invocation:'construct',origins:[{module:'fixture',name:'Thing'}],result:{kind:'object',properties:{run:{kind:'value'}}}};
  for(const source of [
    "import {Thing} from 'fixture';const {run}=new Thing(mutate(Thing.prototype));use(run);",
    "import {Thing} from 'fixture';new Thing(mutate(Thing.prototype)).run();",
    "import {Thing} from 'fixture';const Ctor=Thing;const proto=Thing.prototype;const {run}=new Ctor(mutate(proto));use(run);",
    "import {Thing} from 'fixture';function setup(){const {run}=new Thing(mutate(Thing.prototype));use(run);}",
  ]) {
    const v=view(source,{returnContracts:[contract]});
    const usage=call(v,'use')?.fields.arguments.children[0]??v.nodes.find((n)=>n.type==='call_expression'&&n.fields.function.type==='member_expression').fields.function;
    assert.equal(v.project(usage),undefined,source);
  }
  const v=view("import {Thing} from 'fixture';const {run}=new Thing();mutate(Thing.prototype);use(run);",{returnContracts:[contract]});
  assert.equal(v.project(call(v,'use').fields.arguments.children[0])?.contract,'fixture.construct');
});

test('review6: reference shape observation keeps real scope and excludes only current call delivery',()=>{
  const v=view('function setup(){function callback(value){} accept(callback,mutate(callback));}');
  const accept=call(v,'accept'), argument=accept.fields.arguments.children[0];
  assert.equal(v.referenceStable(argument,accept),true);
  assert.equal(v.referenceStable(argument,accept,'before-call'),false);
  assert.equal(v.referenceStable(JSON.parse(JSON.stringify(argument)),JSON.parse(JSON.stringify(accept)),'before-call'),false);
  const clean=view('function callback(value){} function setup(){accept(callback);}');
  const usage=call(clean,'accept');assert.equal(clean.referenceStable(usage.fields.arguments.children[0],usage,'before-call'),true);
});
