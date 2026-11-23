import { loadModule } from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
import { parse, hash } from './helpers.mjs';

const value={kind:'value'};
const contracts=[
  {id:'fixture.children',origins:[{module:'fixture',name:'makeChildren'}],result:{kind:'object',properties:{toArray:value}},identityObservations:{factoryArities:[1],uses:[{kind:'receiver-call',member:'toArray',arity:0}]}},
  {id:'fixture.context',origins:[{module:'fixture',name:'makeContext'}],result:{kind:'object',properties:{Provider:value,defaultValue:value,id:value}},identityObservations:{factoryArities:[0,1,2],uses:[{kind:'call-argument',origins:[{module:'fixture',name:'observeContext'}],index:0,arity:1},{kind:'jsx-member',member:'Provider'}]}},
];
function view(source,options={}) {
  const parsed=parse(source);
  try{return createTypeScriptView({tree:parsed.tree,source,sourceHash:hash(source),relativePath:'identity.tsx',language:'tsx',returnContracts:contracts,...options});}
  finally{parsed.close();}
}
const calls=(v,name)=>v.nodes.filter(n=>n.type==='call_expression'&&n.fields.function&&v.text(n.fields.function)===name);
const members=(v,text)=>v.nodes.filter(n=>n.type==='member_expression'&&v.text(n)===text);
const projected=(v,text)=>members(v,text).map(n=>v.project(n)?.contract);

test('reviewed receiver calls preserve only exact canonical returned handle identity',()=>{
  for(const setup of [
    "import {makeChildren} from 'fixture';const h=makeChildren(()=>source);",
    "import {makeChildren as create} from 'fixture';const h=create(()=>source);",
    "import * as API from 'fixture';const make=API.makeChildren;const h=make(()=>source);",
    "import * as API from 'fixture';const {makeChildren:make}=API;const h=make(()=>source);",
  ]) {
    const v=view(`${setup}h.toArray();const alias=h;alias.toArray();h.toArray();`);
    assert.deepEqual(projected(v,'h.toArray'),['fixture.children','fixture.children'],setup);
    assert.deepEqual(projected(v,'alias.toArray'),['fixture.children'],setup);
    const last=calls(v,'h.toArray').at(-1);
    assert.equal(v.referenceStable(last.fields.function.fields.object,last),true);
    assert.equal(v.constant(last).known,false);
    assert.equal(v.project(last,[0]),undefined);
  }
  const v=view("import {makeChildren} from 'fixture';const h=makeChildren(()=>[1]);h.toArray();const [item]=h.toArray();");
  assert.equal(v.initializerProjection(v.declarations.find(d=>d.name==='item').key).complete,false);
  assert.equal(v.declarations.find(d=>d.name==='item').binding.value,'unknown');
});

test('reviewed context argument and Provider uses preserve identity across actual scopes',()=>{
  const v=view("import * as API from 'fixture';const make=API.makeContext,read=API.observeContext;const C=make();const Alias=C;function consume(){return read(Alias);}const App=()=> <C.Provider value={data}><Alias.Provider value={other}/></C.Provider>;");
  assert(projected(v,'C.Provider').every(x=>x==='fixture.context'));
  assert.deepEqual(projected(v,'Alias.Provider'),['fixture.context']);
  assert.equal(v.constant(calls(v,'read')[0]).known,false);
  assert.equal(v.project(calls(v,'read')[0],['member']),undefined);
  const repeated=view("import {makeChildren} from 'fixture';const h=makeChildren(()=>source);const left=()=>h.toArray();function right(){return h.toArray();}");
  assert.deepEqual(projected(repeated,'h.toArray'),['fixture.children','fixture.children']);
  const namespace=view("import * as API from 'fixture';const C=API.makeContext();function read(){return API.observeContext(C);}const App=()=> <C.Provider/>;");
  assert.deepEqual(projected(namespace,'C.Provider'),['fixture.context']);
});

test('identity observations are opt-in and do not make arbitrary lookalike values trusted',()=>{
  const plain=contracts.map(({identityObservations,...contract})=>contract);
  const v=view("import {makeChildren} from 'fixture';const h=makeChildren(()=>source);h.toArray();h.toArray();",{returnContracts:plain});
  assert.deepEqual(projected(v,'h.toArray'),['fixture.children',undefined]);
  for(const setup of [
    "import {makeChildren} from 'other';const h=makeChildren(()=>source);",
    "import type {makeChildren} from 'fixture';const h=makeChildren(()=>source);",
    "import {makeChildren} from 'fixture';const h=new Proxy(makeChildren(()=>source),traps);",
    "import {makeChildren} from 'fixture';const object={get value(){return makeChildren(()=>source);}};const h=object.value;",
    "const h=unknown as {toArray():unknown[]};",
    "import {makeChildren} from 'fixture';const h=makeChildren();",
    "import {makeChildren} from 'fixture';const h=makeChildren(()=>source,extra);",
    "import {makeChildren} from 'fixture';const h=makeChildren(...inputs);",
    "import {makeChildren} from 'fixture';const h=makeChildren?.(()=>source);",
  ]) {
    const candidate=view(`${setup}h.toArray();h.toArray();`);
    assert(projected(candidate,'h.toArray').every(x=>x===undefined),setup);
  }
  const shadow=view("import {makeChildren} from 'fixture';function setup(makeChildren){const h=makeChildren(()=>source);h.toArray();h.toArray();}");
  assert(projected(shadow,'h.toArray').every(x=>x===undefined));
});

test('receiver writes, deletes, reassignment and namespace overrides remain global vetoes',()=>{
  for(const mutation of ['h=other;','h.toArray=other;','delete h.toArray;','h.toArray++;','const alias=h;alias.toArray=other;']) {
    const v=view(`import {makeChildren} from 'fixture';const h=makeChildren(()=>source);h.toArray();${mutation}h.toArray();`);
    assert(projected(v,'h.toArray').every(x=>x===undefined),mutation);
  }
  for(const mutation of ['API.makeChildren=other;','delete API.makeChildren;','const alias=API;alias.makeChildren=other;']) {
    const v=view(`import * as API from 'fixture';const h=API.makeChildren(()=>source);h.toArray();${mutation}h.toArray();`);
    assert(projected(v,'h.toArray').every(x=>x===undefined),mutation);
  }
});

test('unknown escapes and non-reviewed receiver calls still stop later identity proof',()=>{
  for(const escape of [
    'escape(h);','const alias=h;escape(alias);','Object.defineProperty(h,"toArray",{get:other});',
    'h.other();','h.toArray(extra);','h.toArray(...inputs);','h.toArray?.();','h?.toArray();',
    'h["toArray"]();','h.toArray.call(h);','const {toArray}=h;escape(toArray);',
    'const element=<h.Other/>;','const element=<Foreign value={h}/>;',
  ]) {
    const v=view(`import {makeChildren} from 'fixture';const h=makeChildren(()=>source);h.toArray();${escape}h.toArray();`);
    assert.equal(v.project(calls(v,'h.toArray')[0].fields.function)?.contract,'fixture.children',escape);
    assert.equal(v.project(calls(v,'h.toArray').at(-1).fields.function),undefined,escape);
  }
  const deferred=view("import {makeChildren} from 'fixture';const h=makeChildren(()=>source);h.toArray();const later=()=>escape(h);h.toArray();");
  assert(projected(deferred,'h.toArray').every(x=>x===undefined));
  for(const source of [
    "import * as API from 'fixture';escape(API);const h=API.makeChildren(()=>source);h.toArray();",
    "import {makeChildren} from 'fixture';escape(makeChildren);const h=makeChildren(()=>source);h.toArray();",
    "import * as API from 'fixture';const h=API.makeChildren(()=>source);function later(){API.unknown();}h.toArray();",
    "import * as API from 'fixture';const h=API.makeChildren(()=>source);function later(){API.makeContext(API);}h.toArray();",
  ])assert(projected(view(source),'h.toArray').every(x=>x===undefined),source);
});

test('context consumer provenance, argument position, arity and JSX use are exact',()=>{
  for(const [imports,operation] of [
    ["import {observeContext} from 'other';",'observeContext(C);'],
    ["import type {observeContext} from 'fixture';",'observeContext(C);'],
    ["import {observeContext} from 'fixture';",'observeContext(other,C);'],
    ["import {observeContext} from 'fixture';",'observeContext(C,extra);'],
    ["import {observeContext} from 'fixture';",'observeContext(...[C]);'],
    ["import {observeContext} from 'fixture';",'observeContext?.(C);'],
    ["import {observeContext} from 'fixture';",'observeContext(C||fallback);'],
    ["import {observeContext} from 'fixture';",'observeContext.call(null,C);'],
    ["import * as API from 'fixture';",'API.observeContext=other;API.observeContext(C);'],
    ["import * as API from 'fixture';",'escape(API);API.observeContext(C);'],
    ['', 'function scope(observeContext){observeContext(C);}'],
    ['', 'const first=<C.Other/>;'],
    ['', 'const first=<C/>;'],
    ['', 'const first=<C.Provider value={C}/>;'],
    ['', 'const first=<C.Provider child={C}/>;'],
    ['', 'const first=<C.Provider>{C}</C.Provider>;'],
  ]) {
    const v=view(`import {makeContext} from 'fixture';${imports}const C=makeContext();${operation}const later=<C.Provider value={data}/>;`);
    assert.equal(v.project(members(v,'C.Provider').at(-1)),undefined,operation);
  }
});

test('reviewed observations do not erase unknown nested escapes during argument evaluation',()=>{
  for(const expression of ['(escape(C),C)','flag?C:other','unknown(C)']) {
    const v=view(`import {makeContext,observeContext} from 'fixture';const C=makeContext();observeContext(${expression});const later=<C.Provider value={data}/>;`);
    assert.equal(v.project(members(v,'C.Provider')[0]),undefined,expression);
  }
  const v=view("import {makeContext,observeContext} from 'fixture';const C=makeContext();observeContext(C);const before=<C.Provider value={data}/>;escape(C);const after=<C.Provider value={data}/>;");
  assert.deepEqual(projected(v,'C.Provider'),['fixture.context',undefined]);
});

test('identity observation metadata is immutable, finite and strictly shaped',()=>{
  const changes=[
    m=>{m.factoryArities=[];},m=>{m.factoryArities=Array.from({length:17},(_,i)=>i);},m=>{m.factoryArities=[1,1];},m=>{m.factoryArities=[-0];},
    m=>{m.uses=[];},m=>{m.uses=Array(17).fill(m.uses[0]);},m=>{m.uses=[m.uses[0],m.uses[0]];},
    m=>{m.uses[0].arity=17;},m=>{m.uses[0].member='*';},m=>{m.uses[0].pure=true;},m=>{m.pure=true;},
    m=>{m.uses=[{kind:'call-argument',origins:[{module:'./fixture',name:'read'}],index:0,arity:1}];},
    m=>{m.uses=[{kind:'call-argument',origins:[{module:'fixture',name:'read'}],index:1,arity:1}];},
  ];
  for(const change of changes){const supplied=structuredClone(contracts);change(supplied[0].identityObservations);assert.throws(()=>view('const x=1;',{returnContracts:supplied}),change.toString());}
  const supplied=structuredClone(contracts),v=view("import {makeChildren} from 'fixture';const h=makeChildren(()=>source);h.toArray();h.toArray();",{returnContracts:supplied});
  supplied[0].identityObservations.uses[0].member='other';
  assert.deepEqual(projected(v,'h.toArray'),['fixture.children','fixture.children']);
  const many=view("import {makeChildren} from 'fixture';const h=makeChildren(()=>source);"+'h.toArray();'.repeat(200));
  assert.equal(many.project(calls(many,'h.toArray').at(-1).fields.function),undefined);
});
