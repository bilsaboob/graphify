import { loadModule, parse, hash } from '../helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
const { createSolidPlugin, solidReturnContracts } = await loadModule('src/frameworks/solid/index.ts');
const { createAnnotationEngine, ANNOTATION_LIMITS, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');
const plugin=createSolidPlugin({implementationDigest:hash('broad-solid'),configurationDigest:hash('broad-config')});
function analyze(source,limits={}) {
  const document={source,sourceHash:hash(source),relativePath:'broad.tsx',language:'tsx'},parsed=parse(source);
  let view;try {view=createTypeScriptView({tree:parsed.tree,...document,returnContracts:solidReturnContracts});}finally{parsed.close();}
  const descriptor={version:1,core:{version:'1',implementationDigest:hash('core')},view:{id:'typescript',version:1,implementationDigest:hash('view')},parserDigest:hash('parser'),plugins:[plugin.descriptor],limits:{...ANNOTATION_LIMITS,...limits}};
  const manifest={...descriptor,id:hash(canonicalJSON(descriptor))};
  const result=createAnnotationEngine({manifest,plugins:[plugin],digest:hash}).analyze(document,view);
  validateAnnotationResult(result,manifest,source);
  assert(!result.reports.some((item)=>item.state==='failed'),JSON.stringify(result.reports));
  return {result,view};
}
const facts=(r,term)=>r.facts.filter((f)=>f.term===`solid.${term}`);
const values=(r,term)=>facts(r,term).map((f)=>f.value?.value);
const role=(r,name,term)=>facts(r,term).some((f)=>r.declarations.find((d)=>d.key===f.subject)?.name===name);
const text=(source,f)=>Buffer.from(source).subarray(f.evidence.span.startByte,f.evidence.span.endByte).toString();
const complete=(source)=>{const {result}=analyze(source);assert.equal(result.state,'complete',JSON.stringify(result.diagnostics));return result;};

test('memo, selector, deferred and reaction whole-return handles survive const aliases',()=>{
  const source=`import * as S from 'solid-js';function setup(){const [get,set]=S.createSignal(0);
    const memo=S.createMemo(prev=>get()+prev,0);const alias=memo;const select=S.createSelector(get,(key,value)=>key===value);
    const delayed=S.createDeferred(memo,{timeoutMs:20});const track=S.createReaction(()=>set(2));
    alias();select(1);delayed();track(()=>get());}`;
  const r=complete(source);
  for(const name of ['memo','alias','delayed'])assert(role(r,name,'accessor'));
  assert(role(r,'select','selector'));assert(role(r,'track','reaction'));
  assert(facts(r,'accessor-read').some((f)=>text(source,f)==='alias()'));
  assert(values(r,'return-contract').some((v)=>v.includes('accumulator, not cleanup')));
  assert(facts(r,'potential-read').length>=2);
});

test('effect family return values are accumulators and callback reads stop at nested functions and await',()=>{
  const source=`import {createSignal,createEffect,createComputed,createRenderEffect,untrack,batch} from 'solid-js';
    function setup(){const [get,set]=createSignal(0);createEffect(async prev=>{get();const later=()=>get();untrack(()=>get());await promise;get();return ()=>set(1);});
    createComputed(prev=>get()+prev,0);createRenderEffect(prev=>get()+prev,0);batch(async()=>{set(2);const later=()=>set(3);await promise;set(4);});}`;
  const r=complete(source);
  assert.equal(facts(r,'potential-read').length,3);
  assert.equal(facts(r,'untracked-read').length,1);
  assert.deepEqual(facts(r,'batch-write').map((f)=>text(source,f)),['set(2)']);
  assert.equal(values(r,'return-contract').filter((v)=>v.includes('not cleanup')).length,3);
  assert(!r.facts.some((f)=>/cleanup/.test(f.term)));
});

test('on maps current/previous VALUE slots and defer without accessor or snapshot semantics',()=>{
  const source=`import {on,createEffect,createSignal} from 'solid-js';function setup(){const [a,setA]=createSignal(0);const [b,setB]=createSignal(1);
    function changed([av,bv],[oldA,oldB],previous){return av+bv;}
    const effect=on([a,b],changed,{defer:true});createEffect(effect);}`;
  const r=complete(source),params=values(r,'parameter-role');
  assert(params.some((v)=>v==='av: current dependency values.0'));
  assert(params.some((v)=>v==='oldB: previous dependency values or undefined.1'));
  assert(!params.some((v)=>/snapshot|dependency accessor/.test(v)));
  assert.equal(facts(r,'parameter-source').length,4);
  assert(values(r,'option').includes('defer=true'));
});

test('roots and borrowed owners differ from tracking and cleanup returns the identical callback',()=>{
  const source=`import {createRoot,getOwner,runWithOwner,onCleanup,untrack} from '@fst/components-fst-solid/solid-js';
    function setup(){createRoot(dispose=>{const owner=getOwner();runWithOwner(owner,()=>work());function clean(){}const manual=onCleanup(clean);manual();untrack(()=>work());return dispose;});}`;
  const r=complete(source);
  assert(role(r,'owner','owner'));assert(role(r,'manual','cleanup-callback'));
  const edge=facts(r,'returned-callback')[0];assert.equal(edge.target.key,r.declarations.find((d)=>d.name==='clean').key);
  assert(values(r,'return-contract').some((v)=>v.includes('does not unregister')));
  assert(values(r,'boundary').some((v)=>v.includes('ownership not removed')));
  assert(values(r,'parameter-role').includes('dispose: root disposer'));
});

test('context provider/useContext edges retain explicit identity without closest-provider claims',()=>{
  const r=complete(`import {createContext,useContext} from 'solid-js';function App(){const C=createContext('default');
    const rendered=<C.Provider value={provided}><div/></C.Provider>;const value=useContext(C);return rendered;}`);
  assert(role(r,'C','context'));assert.equal(facts(r,'provider-context').length,1);assert.equal(facts(r,'context-source').length,1);
});

test('reviewed children toArray can be observed repeatedly without inferring returned array contents',()=>{
  for(const module of ['solid-js','@fst/components-fst-solid/solid-js']) {
    const source=`import {children,Show} from '${module}';function Checkbox(props){const content=children(()=>props.children);return <><input aria-label={content.toArray().length?undefined:'Checkbox'}/><Show when={content.toArray().length>0}><label>{content()}</label></Show></>;}`;
    const {result:r,view}=analyze(source);
    assert.equal(r.state,'complete',JSON.stringify(r.diagnostics));
    assert.equal(facts(r,'handle-call').filter(f=>text(source,f)==='content.toArray()').length,2);
    const calls=view.nodes.filter(n=>n.type==='call_expression'&&view.text(n.fields.function)==='content.toArray');
    for(const call of calls){assert.equal(view.constant(call).known,false);assert.equal(view.project(call,[0]),undefined);}
    assert(!values(r,'return-contract').some(value=>/pure|immutable array/.test(value)));
  }
});

test('canonical useContext and Provider preserve handle identity across consumers and lexical scopes',()=>{
  for(const module of ['solid-js','@fst/components-fst-solid/solid-js']) {
    const source=`import * as S from '${module}';const C=S.createContext(defaultValue);const Alias=C;function useValue(){return S.useContext(Alias);}const App=()=> <C.Provider value={provided}><Alias.Provider value={other}/></C.Provider>;`;
    const r=complete(source);
    assert.equal(facts(r,'context-source').length,1);
    assert.equal(facts(r,'provider-context').length,2);
    assert(!r.facts.some(f=>/resolved-context|closest-provider/.test(f.term)));
  }
});

test('reviewed identity uses retain timing and never erase an unknown later escape',()=>{
  const source=`import {children,createContext,useContext} from 'solid-js';function setup(){const h=children(()=>source);h.toArray();h.toArray();escape(h);h.toArray();const C=createContext();useContext(C);const first=<C.Provider value={v}/>;escape(C);const second=<C.Provider value={v}/>;}`;
  const r=analyze(source).result;
  assert.equal(facts(r,'handle-call').filter(f=>text(source,f)==='h.toArray()').length,2);
  assert.equal(facts(r,'provider-context').length,1);
  const diagnostics=r.reports.flatMap(report=>report.diagnostics);
  assert(diagnostics.some(d=>d.code==='solid.call-shape'));
  assert(diagnostics.some(d=>d.code==='solid.jsx-shape'));
});

test('writes deletes reassignment and unknown cross-scope escapes veto handle member identity',()=>{
  for(const mutation of ['h.toArray=other;','delete h.toArray;','h=other;','const alias=h;alias.toArray=other;','function later(){escape(h);}']) {
    const source=`import {children} from 'solid-js';const h=children(()=>source);h.toArray();${mutation}h.toArray();`;
    assert.equal(facts(analyze(source).result,'handle-call').length,0,mutation);
  }
  for(const mutation of ['C.Provider=other;','delete C.Provider;','C=other;','function later(){escape(C);}']) {
    const source=`import {createContext,useContext} from 'solid-js';const C=createContext();useContext(C);${mutation}const App=()=> <C.Provider value={v}/>;`;
    assert.equal(facts(analyze(source).result,'provider-context').length,0,mutation);
  }
});

test('noncanonical context consumers and non-reviewed JSX positions remain escapes',()=>{
  for(const [imports,operation] of [
    ["import {useContext} from 'other';",'useContext(C);'],
    ["import type {useContext} from 'solid-js';",'useContext(C);'],
    ["import {useContext} from 'solid-js';",'useContext(C,extra);'],
    ["import {useContext} from 'solid-js';",'useContext(other,C);'],
    ["import {useContext} from 'solid-js';",'useContext(...[C]);'],
    ["import {useContext} from 'solid-js';",'useContext?.(C);'],
    ["import {useContext} from 'solid-js';",'useContext((escape(C),C));'],
    ["import * as S from 'solid-js';",'S.useContext=other;S.useContext(C);'],
    ["import * as S from 'solid-js';",'escape(S);S.useContext(C);'],
    ['', 'function consume(useContext){useContext(C);}'],
    ['', 'const first=<C.Other/>;'],
    ['', 'const first=<C.Provider value={C}/>;'],
    ['', 'const first=<Other value={C}/>;'],
  ]) {
    const source=`import {createContext} from 'solid-js';${imports}const C=createContext();${operation}const later=<C.Provider value={v}/>;`;
    const last=source.lastIndexOf('<C.Provider');
    assert(!facts(analyze(source).result,'provider-context').some(f=>f.evidence.span.startByte===last),operation);
  }
});

test('method name, shape annotations, getter proxies and changed factories do not grant observations',()=>{
  for(const setup of [
    "import {children} from 'other';const h=children(()=>source);",
    "import type {children} from 'solid-js';const h=children(()=>source);",
    "import {children} from 'solid-js';const h=new Proxy(children(()=>source),traps);",
    "import {children} from 'solid-js';const h=unknown as ReturnType<typeof children>;",
    "import {children} from 'solid-js';const box={get value(){return children(()=>source);}};const h=box.value;",
    "import * as S from 'solid-js';S.children=other;const h=S.children(()=>source);",
    "import * as S from 'solid-js';escape(S);const h=S.children(()=>source);",
  ])assert.equal(facts(analyze(`${setup}h.toArray();h.toArray();`).result,'handle-call').length,0,setup);
  const shadow=analyze("import {children} from 'solid-js';function setup(children){const h=children(()=>source);h.toArray();h.toArray();}").result;
  assert.equal(facts(shadow,'handle-call').length,0);
});

test('only the exact reviewed factory and observation arities qualify',()=>{
  for(const operation of ['h.toArray(extra);','h.toArray(...args);','h?.toArray();','h.toArray?.();','h.other();','h["toArray"]();']) {
    const source=`import {children} from 'solid-js';const h=children(()=>source);${operation}h.toArray();`;
    assert(!facts(analyze(source).result,'handle-call').some(f=>f.evidence.span.startByte===source.lastIndexOf('h.toArray()')),operation);
  }
  for(const factory of ['children()','children(source,extra)','children(...args)','children?.(source)']) {
    const source=`import {children} from 'solid-js';const h=${factory};h.toArray();h.toArray();`;
    assert.equal(facts(analyze(source).result,'handle-call').length,0,factory);
  }
  const metadata=solidReturnContracts.filter(c=>c.identityObservations);
  assert.deepEqual(metadata.map(c=>c.id).sort(),['solid.children','solid.create-context']);
  assert(metadata.every(c=>Object.isFrozen(c.identityObservations)&&Object.isFrozen(c.identityObservations.uses)));
});

test('resource nested actions pair with accessor and fetcher info/storage contracts are explicit',()=>{
  const source=`import {createResource,createSignal} from 'solid-js';function setup(){
    const [resource,{mutate,refetch}]=createResource(id,async (key,{value,refetching})=>fetcher(key),{storage:initial=>createSignal(initial),deferStream:true});
    resource();mutate('next');refetch('refresh');const loading=resource.loading;}`;
  const r=complete(source);
  assert(role(r,'resource','resource'));assert(role(r,'mutate','resource-mutator'));assert(role(r,'refetch','resource-refetch'));
  assert.equal(facts(r,'resource-for').length,2);
  assert(values(r,'parameter-role').some((v)=>v.startsWith('refetching: fetcher info')));
  assert(values(r,'callback-role').includes('resource storage factory'));
  assert(facts(r,'handle-call').some((f)=>text(source,f)==="refetch('refresh')"));
});

test('transition handles and Suspense carry requested boundary semantics',()=>{
  const r=complete(`import {useTransition,startTransition,Suspense,SuspenseList} from 'solid-js';function App(){const [pending,start]=useTransition();start(()=>work());startTransition(()=>work());return <SuspenseList revealOrder="forwards"><Suspense fallback={<p/>}>{pending()}</Suspense></SuspenseList>;}`);
  assert(role(r,'pending','transition-pending'));assert(role(r,'start','transition-start'));
  assert.equal(facts(r,'transition-for').length,1);assert(values(r,'boundary').some((v)=>v.startsWith('Suspense authored')));
});

test('store modifier/mutable/unwrap operations remain explicit, not deep immutable snapshots',()=>{
  const r=complete(`import {createStore,produce,reconcile,createMutable,modifyMutable,unwrap} from 'solid-js/store';function setup(){
    const [state,setState]=createStore({x:1});const modifier=produce(draft=>{draft.x=2;});setState('nested',modifier);
    const replacement=reconcile({x:3},{merge:true});const mutable=createMutable({x:1});modifyMutable(mutable,replacement);const raw=unwrap(mutable);}`);
  assert(role(r,'modifier','store-modifier'));assert(role(r,'mutable','mutable-store'));assert(role(r,'raw','raw-store'));
  assert.equal(facts(r,'store-target').length,1);assert(values(r,'parameter-role').includes('draft: mutable draft'));
  assert(values(r,'boundary').some((v)=>v.includes('not an immutable deep copy')));
});

test('mergeProps preserves ordered lazy sources and symbolic properties, never eager spread semantics',()=>{
  const source=`import {mergeProps,children} from 'solid-js';function setup(){const merged=mergeProps({name:'first'},{name:undefined},props);const {name}=merged;const resolved=children(()=>props.children);use(name);resolved();}`;
  const {result:r,view}=analyze(source);assert.equal(r.state,'complete');
  assert.equal(facts(r,'merge-source').length,3);assert(role(r,'merged','merged-props'));assert(role(r,'resolved','children'));
  assert(values(r,'boundary').some((v)=>v.includes('last non-undefined')));
  const use=view.nodes.find((n)=>n.type==='call_expression'&&view.text(n.fields.function)==='use');assert.equal(view.constant(use.fields.arguments.children[0]).known,false);
});

test('lazy module references, mapping inversion, conditional keyed props and dynamic dispatch',()=>{
  const r=complete(`import {lazy,mapArray,indexArray,For,Index,Show,Match} from 'solid-js';import {Dynamic,createDynamic} from 'solid-js/web';
    const Lazy=lazy(()=>import('./Panel'));function App(){const mapped=mapArray(items,(item,index)=>item);const indexed=indexArray(items,(item,index)=>item());
    createDynamic(()=>Lazy,{x:1});return <><For each={items}>{(item,index)=><i/>}</For><Index each={items}>{(item,index)=><i/>}</Index><Show when={value} keyed>{item=><i/>}</Show><Match when={value}>{item=><i/>}</Match><Dynamic component={Lazy}/></>;}`);
  assert(role(r,'Lazy','lazy-component'));assert.equal(facts(r,'module-source').length,1);
  const params=values(r,'parameter-role');for(const expected of ['item: item value','index: index accessor','item: item accessor','index: index value','item: condition value (keyed)','item: condition accessor']) assert(params.includes(expected),expected);
  assert.equal(facts(r,'dynamic-component').length,2);
});

test('ErrorBoundary/catchError and external observable bridges have distinct callback payloads',()=>{
  const r=complete(`import {ErrorBoundary,catchError,from,observable,createSignal} from 'solid-js';function App(){const [get,set]=createSignal(0);
    catchError(()=>work(),error=>report(error));const incoming=from(setter=>{subscribe(setter);return ()=>stop();});const external=observable(get);external.subscribe(value=>report(value));incoming();
    return <ErrorBoundary fallback={(error,reset)=><button onClick={reset}/>}>content</ErrorBoundary>;}`);
  assert(role(r,'incoming','accessor'));assert(role(r,'external','observable'));
  assert(values(r,'parameter-role').includes('reset: reset callback'));assert(values(r,'parameter-role').includes('setter: signal setter'));
  assert(values(r,'callback-role').includes('observable observer'));
});

test('qualified native JSX directives/ref/events/listener options/innerHTML/once use exact attribute sites',()=>{
  const source=`/** @jsxImportSource solid-js */function tip(element,value){}function handler(data,event){}function ref(element){}
    const App=()=> <div use:tip={content} ref={ref} onClick={[handler,data]} on:click={{handleEvent:event=>report(event),capture:true,passive:true}} innerHTML={html}>{/* @once */ name()}</div>;`;
  const r=complete(source);
  const event=facts(r,'event-handler').find((f)=>text(source,f).startsWith('onClick'));
  assert.equal(event.target.key,r.declarations.find((d)=>d.name==='handler').key);
  assert.equal(text(source,event),text(source,facts(r,'event-data')[0]));
  for(const expected of ['element: native element','value: directive value accessor','data: bound data','event: native event']) assert(values(r,'parameter-role').includes(expected),expected);
  assert(values(r,'option').includes('capture=true'));assert(values(r,'jsx-mode').some((v)=>v.startsWith('@once')));
});

test('native JSX requires compiler/FST-renderer/Solid-type provenance, never a coincidental import',()=>{
  for(const prefix of ['',"import React from 'react';import {createSignal} from 'solid-js';","import {createSignal} from 'solid-js';","/** @jsxImportSource preact */import {createSignal} from 'solid-js';"]) {
    const r=analyze(`${prefix}const App=()=> <button onClick={[handler,data]}/>;`).result;
    assert.equal(facts(r,'event-handler').length,0,prefix);
  }
  const typed=complete("import type {Component} from 'solid-js';const App:Component=()=> <button onClick={[handler,data]}/>;");
  assert.equal(facts(typed,'event-handler').length,1);
  const fst=complete("import {component} from '@fst/components-fst-solid/app/component';const App=component(()=> <button onClick={[handler,data]}/>);");assert.equal(facts(fst,'event-handler').length,1);
  const custom=analyze("/** @jsxImportSource solid-js */const App=()=> <Widget onClick={[handler,data]}/>;").result;assert.equal(facts(custom,'event-handler').length,0);
});

test('overridable Dynamic props retain authored and forwarded sources without claiming the final component', () => {
  const source = `import {Dynamic} from 'solid-js/web';const View=()=> <Dynamic component={Known} {...native}/>;`;
  const {result:r} = analyze(source);
  assert.equal(r.state, 'complete');
  assert.equal(facts(r, 'dynamic-component').length, 0);
  assert(facts(r, 'source').some(f => f.target.text === 'native'));
  assert.equal(facts(r, 'jsx-overridden')[0].target.text, 'component={Known}');
  assert.equal(text(source, facts(r, 'jsx-overridden')[0]), 'component={Known}');
  assert(values(r, 'jsx-mode').some(value => value.includes('dynamic keys')));
  const {result:safeOrder} = analyze(`import {Dynamic} from 'solid-js/web';const View=()=> <Dynamic {...native} component={Known}/>;`);
  assert.equal(facts(safeOrder, 'dynamic-component').length, 0);
  assert(values(safeOrder, 'jsx-props-contract').some(value => value.includes('last-non-undefined')));
  assert.equal(facts(safeOrder, 'jsx-overridden').length, 0);
});

test('dynamic conditional child expressions retain source without inventing callback parameters', () => {
  const {result:r} = analyze(`import {Show} from 'solid-js';const View=()=> <Show when={ready}>{makeChild(value)}</Show>;`);
  assert.equal(r.state, 'complete');
  assert(values(r, 'callback-dispatch').some(value => value.includes('typeof child === function && child.length > 0')));
  assert.equal(facts(r, 'conditional-callback')[0].target.text, 'makeChild(value)');
  assert.equal(facts(r, 'render-child')[0].target.text, 'makeChild(value)');
  assert.equal(values(r, 'parameter-role').length, 0);
  assert.equal(facts(r, 'untracked-read').length, 0);
  assert.equal(facts(r, 'callback').length, 0);
});

test('Dynamic contribution order and element identity survive repeated sources, groups and children', () => {
  const source = `import {Dynamic as D} from 'solid-js/web';const View=()=> <>
    <D component={One} {...props} id="x" {...props} component={maybe}>{child()}</D>
    <D {...props} component={undefined}/></>;`;
  const r = complete(source), contributions = facts(r, 'jsx-contribution').sort((a,b)=>a.evidence.span.startByte-b.evidence.span.startByte);
  assert.deepEqual(contributions.map(f=>f.value.value), ['0:group=0:attribute:component','1:group=1:spread','2:group=2:attribute:id','3:group=3:spread','4:group=4:attribute:component','5:group=4:nested-child-source','0:group=1:spread','1:group=2:attribute:component']);
  assert.equal(new Set(facts(r, 'jsx-element').map(f=>f.target.span.startByte)).size, 2);
  assert.equal(facts(r, 'dynamic-dispatch').length, 2);
  assert.equal(facts(r, 'dynamic-component').length, 0);
  for (const fact of facts(r, 'jsx-contribution-source')) {
    assert.equal(Buffer.from(source).subarray(fact.target.span.startByte,fact.target.span.endByte).toString(),fact.target.text);
    assert(facts(r, 'jsx-element').some(element=>element.evidence.span.startByte===fact.evidence.span.startByte));
  }
});

test('Dynamic conditional contracts require canonical identity and do not clear duplicate or other JSX gaps', () => {
  for (const prefix of ["import {Dynamic} from './foreign';", "import type {Dynamic} from 'solid-js/web';", 'function Dynamic(){}']) {
    const r=analyze(`${prefix}const View=()=> <Dynamic component={One} {...props}/>;`).result;
    assert.equal(facts(r,'dynamic-dispatch').length,0,prefix);
  }
  const duplicate=analyze(`import {Dynamic} from 'solid-js/web';const View=()=> <Dynamic component={One} component={Two} {...props}/>;`).result;
  assert.equal(duplicate.state,'partial');
  assert(duplicate.reports[0].diagnostics.some(d=>d.code==='solid.jsx-shape'));
  const other=analyze(`import {For} from 'solid-js';const View=()=> <For each={items} {...props}/>;`).result;
  assert.equal(other.state,'partial');
  assert.equal(facts(other,'dynamic-dispatch').length,0);
});

test('conditional child ABI never fabricates parameters or body reads when callback identity or arity is unknown', () => {
  for(const mutation of ["Object.defineProperty(child,'length',{value:0});", 'escape(child);']) {
    const r=complete(`import {Show,createSignal} from 'solid-js';const [get]=createSignal(0);function child(value){return get();}${mutation}const View=()=> <Show when={ready}>{child}</Show>;`);
    assert.equal(facts(r,'conditional-callback').length,1);
    assert.equal(facts(r,'callback').length,0);
    assert.equal(facts(r,'parameter-role').length,0);
    assert.equal(facts(r,'untracked-read').length,0);
  }
  const r=complete(`import {Show,Match} from 'solid-js';const View=()=> <><Show keyed when={ready}>{make()}</Show><Match when={other}>{make()}</Match></>;`);
  assert.equal(facts(r,'conditional-callback').length,2);
  assert(values(r,'callback-argument-contract').some(value=>value.includes('condition value (keyed)')));
  assert(values(r,'callback-dispatch').some(value=>value.includes('Switch selects another Match')));
  for(const prefix of ["import {Show} from './foreign';", "import type {Show} from 'solid-js';", 'function Show(){}']) {
    assert.equal(facts(analyze(`${prefix}const View=()=> <Show when={ready}>{make()}</Show>;`).result,'conditional-callback').length,0);
  }
});

test('JSX spread sources are explicit and later authored handlers retain exact precedence', () => {
  const source = '/** @jsxImportSource solid-js */ function click(event){} const App=()=> <button {...native} onClick={click} ref={element=>attach(element)}/>;';
  const r = complete(source);
  assert.equal(facts(r, 'event-handler').length, 1);
  assert.equal(text(source, facts(r, 'event-handler')[0]), 'onClick={click}');
  assert(values(r, 'parameter-role').includes('event: native event'));
  assert(values(r, 'jsx-mode').some(value => value.includes('spread props (dynamic keys')));
  assert(facts(r, 'source').some(f => f.target.text === 'native'));
  for (const attributes of ['onClick={click} {...native}', 'onClick={click} onClick={other}', '{...native} onClick={click} {...later}']) {
    const negative = analyze(`/** @jsxImportSource solid-js */ function click(event){} const App=()=> <button ${attributes}/>;`).result;
    assert.equal(negative.state, 'partial', attributes);
    assert.equal(facts(negative, 'event-handler').length, 0, attributes);
    assert(negative.reports[0].diagnostics.some(d => d.code === 'solid.jsx-shape'));
  }
});

test('control JSX precedence and erased this parameters preserve callback arity safety', () => {
  const r = complete("import {For} from 'solid-js'; function item(this: void, value, index){return index();} const App=()=> <For {...props} each={items}>{item}</For>;");
  assert(values(r, 'parameter-role').includes('value: item value'));
  assert(values(r, 'parameter-role').includes('index: index accessor'));
  assert(!values(r, 'parameter-role').some(value => value.startsWith('this:')));
  const uncertain = analyze("import {Show} from 'solid-js';const App=()=> <Show when={ready} {...props}>{value=>value()}</Show>;").result;
  assert.equal(uncertain.state, 'partial');
  assert(!values(uncertain, 'parameter-role').includes('value: condition accessor'));
  const overwritten = analyze("import {For} from 'solid-js';function item(value,index){return index();} const App=()=> <For children={item} {...props} each={items}/>;").result;
  assert(!values(overwritten, 'parameter-role').includes('index: index accessor'));
  assert.equal(overwritten.state, 'partial');
  const multiple = complete("import {For} from 'solid-js';const App=()=> <For each={items}>{(value,index)=>index()}<span/></For>;");
  assert(!values(multiple, 'parameter-role').includes('index: index accessor'));
  const mutated = analyze("import {For} from 'solid-js';function item(value,index){return index();}Object.defineProperty(item,'length',{value:1});const App=()=> <For {...props} each={items}>{item}</For>;").result;
  assert(!values(mutated, 'parameter-role').includes('index: index accessor'));
});

test('nested self-closing controls keep explicit children callbacks separate from enclosing children', () => {
  for (const [tag, props, expected] of [
    ['For', 'each={items}', ['value: item value', 'index: index accessor']],
    ['Index', 'each={items}', ['value: item accessor', 'index: index value']],
    ['Show', 'when={ready}', ['value: condition accessor']],
    ['Match', 'when={ready}', ['value: condition accessor']],
  ]) {
    const control = `<${tag} children={item} ${props}/>`;
    for (const markup of [control, `<div>${control}</div>`, `<section><div>{outer}${control}<span/></div></section>`]) {
      const r = complete(`import {${tag}} from 'solid-js';function item(value,index){return value;}function outer(outside){return outside;}const App=()=> ${markup};`);
      assert.deepEqual(values(r, 'parameter-role').sort(), [...expected].sort(), markup);
      assert.equal(facts(r, 'callback')[0].target.key, r.declarations.find(d => d.name === 'item').key);
    }
  }
});

test('only a control own authored children override its explicit children prop', () => {
  for (const spread of ['', '{...props}']) {
    const prefix = "import {For} from 'solid-js';function fallback(oldValue,oldIndex){return oldIndex();}function item(value,index){return index();}";
    const r = complete(`${prefix}const App=()=> <div><For children={fallback} ${spread} each={items}>{item}</For></div>;`);
    assert.deepEqual(values(r, 'parameter-role').sort(), ['index: index accessor', 'value: item value']);
    assert.equal(facts(r, 'callback')[0].target.key, r.declarations.find(d => d.name === 'item').key);
    const textChild = complete(`${prefix}const App=()=> <div><For children={fallback} ${spread} each={items}>content</For></div>;`);
    assert.equal(facts(textChild, 'callback').length, 0);
    assert.equal(facts(textChild, 'parameter-role').length, 0);
  }
});

test('nested children props preserve unknown-spread precedence and callback arity safety', () => {
  const prefix = "import {For} from 'solid-js';function item(value,index){return index();}";
  const r = complete(`${prefix}const App=()=> <div><For {...props} children={item} each={items}/></div>;`);
  assert(values(r, 'parameter-role').includes('index: index accessor'));
  for (const attributes of ['children={item} {...props}', '{...props} children={item} {...later}', 'children={item} children={other}']) {
    const overwritten = analyze(`${prefix}const App=()=> <div><For ${attributes} each={items}/></div>;`).result;
    assert.equal(overwritten.state, 'partial', attributes);
    assert.equal(facts(overwritten, 'callback').length, 0, attributes);
    assert.equal(facts(overwritten, 'parameter-role').length, 0, attributes);
    assert(overwritten.reports[0].diagnostics.some(d => d.code === 'solid.jsx-shape'));
  }
  for (const mutation of ["Object.defineProperty(item,'length',{value:1});", 'escape(item);']) {
    const unsafe = analyze(`${prefix}${mutation}const App=()=> <div><For {...props} children={item} each={items}/></div>;`).result;
    assert(!values(unsafe, 'parameter-role').includes('index: index accessor'));
    assert(unsafe.reports[0].diagnostics.some(d => d.code === 'solid.callback-shape'));
  }
  for (const parameter of ['index=0', '...index']) {
    const short = complete(`import {For} from 'solid-js';function item(value,${parameter}){return value;}const App=()=> <div><For {...props} children={item} each={items}/></div>;`);
    assert.deepEqual(values(short, 'parameter-role'), ['value: item value']);
  }
});

test('web render/hydrate/server/Portal APIs respect exact wrapper exports',()=>{
  const r=complete(`import {render,hydrate,renderToString,renderToStringAsync,renderToStream,getRequestEvent,Portal,NoHydration} from 'solid-js/web';function App(){
    const dispose=render(()=> <div/>,mount);const stop=hydrate(()=> <div/>,mount);renderToString(()=> <div/>);renderToStringAsync(()=> <div/>);renderToStream(()=> <div/>,{onCompleteAll:info=>write(info)});
    const request=getRequestEvent();dispose();stop();return <Portal mount={mount}><NoHydration><p/></NoHydration></Portal>;}`);
  assert(role(r,'dispose','disposer'));assert(role(r,'request','request-event'));assert(values(r,'boundary').some((v)=>v.includes('DOM relocation')));
  const negative=analyze("import {hydrate,createDynamic,getRequestEvent} from '@fst/components-fst-solid/solid-js/web';function App(){hydrate(fn,node);createDynamic(fn,{});getRequestEvent();}").result;assert.equal(negative.facts.length,0);
});

test('router 0.15.4 data APIs are separate exact origins with accessor/query/action contracts',()=>{
  const r=complete(`import {query,cache,revalidate,action,useAction,useSubmission,useSubmissions,createAsync,createAsyncStore,redirect,reload,json} from '@solidjs/router';
    function setup(){const get=query(async id=>fetcher(id),'item');const old=cache(async()=>fetcher(),'old');const save=action(async data=>submit(data),'save');const run=useAction(save);
    useSubmission(save);useSubmissions(save,input=>true);const value=createAsync(()=>get(1));const stored=createAsyncStore(()=>get(2));revalidate(get.keyFor(1));run(data);value();stored();redirect('/next');reload();json({ok:true});}`);
  assert(role(r,'get','query'));assert(role(r,'save','action'));assert(role(r,'value','accessor'));assert(role(r,'stored','accessor'));
  assert(facts(r,'key-source').length>=3);assert.equal(facts(r,'action-source').length,3);
  const negative=analyze("import {query,createAsync} from 'solid-js';const get=query(fn,'name');const value=createAsync(get);").result;assert.equal(negative.facts.length,0);
  assert.equal(analyze("import {GET} from '@solidjs/start/http';export const result=GET(fn);").result.facts.length,0);
});

test('broader handles still reject shadowing, type-only imports, mutation, TDZ and optional calls',()=>{
  for(const body of [
    "import type {createMemo} from 'solid-js';const value=createMemo(fn);value();",
    "import {createMemo} from 'solid-js';function f(createMemo){const value=createMemo(fn);value();}",
    "import {createMemo} from 'solid-js';const value=createMemo(fn);value=other;value();",
    "import {createMemo} from 'solid-js';{const value=createMemo(fn);const createMemo=other;value();}",
    "import {createMemo} from 'other/solid-js';const value=createMemo(fn);value();",
    "import {createMemo} from 'solid-js';const value=createMemo?.(fn);value();",
  ]) { const r=analyze(body).result;assert.equal(facts(r,'accessor').length,0,body);assert.equal(facts(r,'accessor-read').length,0,body); }
});

test('contracts are deeply frozen; stress callbacks and byte/work ceilings stay bounded',()=>{
  const visit=(item)=>{if(item&&typeof item==='object'){assert(Object.isFrozen(item));for(const value of Object.values(item))visit(value);}};visit(solidReturnContracts);
  const constants=Array.from({length:250},(_,i)=>`const c${i}=${i};`).join('\n');
  const source=`import {createSignal,createMemo,createEffect,batch} from 'solid-js';${constants}function setup(){const [get,set]=createSignal(0);const value=createMemo(()=>get());createEffect(()=>value());batch(()=>set(1));}`;
  assert.equal(analyze(source).result.state,'complete');assert.equal(analyze(source,{maxWork:300}).result.state,'truncated');
  const small=analyze(source,{maxResultBytes:8192}).result;assert.equal(small.state,'truncated');assert(Buffer.byteLength(canonicalJSON(small))<=8192);
  const large=analyze(`import {createMemo} from 'solid-js';const value=createMemo(()=> '${'x'.repeat(3000)}');`).result;assert.equal(large.state,'complete');
  const oversize=analyze(`import {createMemo} from 'solid-js';const value=createMemo(()=> '${'<'.repeat(50000)}');`).result;
  assert.equal(oversize.state,'partial');assert(oversize.reports[0].diagnostics.some(d=>d.code==='solid.reference-limit'));
});

test('await inside a call argument does not become a synchronous batch write',()=>{
  const source=`import {createSignal,batch} from 'solid-js';function setup(){const [get,set]=createSignal(0);batch(async()=>{set(await promise);set(2);});}`;
  const r=complete(source);assert.equal(facts(r,'batch-write').length,0);
});

test('known member calls are exact and later receiver escapes stay conservative',()=>{
  const source=`import {createResource} from 'solid-js';function setup(){const [resource,actions]=createResource(async()=>1);actions.mutate(1);actions.refetch();}`;
  const r=analyze(source).result;
  assert.equal(r.state,'partial');assert(facts(r,'handle-call').some((f)=>text(source,f)==='actions.mutate(1)'));
  assert(!facts(r,'handle-call').some((f)=>text(source,f)==='actions.refetch()'));
  const escaped=analyze(`import {createContext} from 'solid-js';function App(){const C=createContext();escape(C);return <C.Provider value={v}/>;}`).result;
  assert.equal(escaped.state,'partial');assert.equal(facts(escaped,'provider-context').length,0);
});

test('resource statuses are reads and ambiguous overloads never invent fetcher positions',()=>{
  const r=complete(`import {createResource} from 'solid-js';function setup(){const [resource]=createResource(async()=>1);resource();const loading=resource.loading;}`);
  assert.equal(facts(r,'resource-status').length,1);
  const ambiguous=analyze(`import {createResource} from 'solid-js';function setup(){const [resource]=createResource(fetcher,unknownOptions);}`).result;
  assert.equal(ambiguous.state,'partial');assert.equal(facts(ambiguous,'callback').length,0);
});

test('external subscription and observable object payloads are not treated as function callbacks',()=>{
  const r=complete(`import {from,observable,createSignal} from 'solid-js';function setup(){const [get,set]=createSignal(0);const value=from({subscribe:next=>subscribe(next)});const external=observable(get);external.subscribe({next:value=>report(value),error:error=>report(error)});}`);
  const roles=values(r,'callback-role');assert(roles.includes('external subscription producer'));assert(roles.includes('observable next observer'));assert(!roles.includes('observable error observer'));
});

test('dynamic callback patterns and unsafe JSX props are partial, with no false tuple handlers',()=>{
  for(const source of [
    "import {on} from 'solid-js';function setup(){on([,a],([value])=>value);}",
    "import {on} from 'solid-js';function setup(){on(a,(value=0)=>value);}",
    "/** @jsxImportSource solid-js */const App=()=> <button onClick={[handler,data]} {...unknown}/>;",
    "/** @jsxImportSource solid-js */const App=()=> <button onClick={[handler,data]} onClick={other}/>;",
    "/** @jsxImportSource solid-js */const App=()=> <button on:click={[handler,data]}/>;",
    "/** @jsxImportSource solid-js */const App=()=> <button onClick={{handleEvent:handler}}/>;",
  ]) {const r=analyze(source).result;assert.equal(r.state,'partial',source);assert.equal(facts(r,'event-handler').length,0,source);}
});

test('resource method snapshots retain exact invoked aliases without unsafe later projections',()=>{
  const source=`import {createResource} from 'solid-js';function setup(){const [resource,actions]=createResource(async()=>1);const mutate=actions.mutate;escape(actions);mutate(1);}`;
  const r=complete(source);assert(role(r,'mutate','resource-mutator'));
  assert.equal(facts(r,'handle-call').filter((f)=>text(source,f)==='mutate(1)').length,1);
  const late=analyze(`import {createResource} from 'solid-js';function setup(){const [resource,actions]=createResource(async()=>1);escape(actions);const mutate=actions.mutate;mutate(1);}`).result;
  assert(!role(late,'mutate','resource-mutator'));assert.equal(facts(late,'handle-call').length,0);
});

test('router namespace cache helpers are qualified operations, not guessed cache state',()=>{
  const source=`import * as Router from '@solidjs/router';function setup(){Router.query.set('key',value);Router.query.get('key');Router.query.delete('key');Router.query.clear();}`;
  const r=complete(source);
  assert.equal(facts(r,'api-call').length,4);assert(facts(r,'api-call').every((f)=>f.target.kind==='import'&&f.target.name==='query'&&f.target.member));
  const escaped=analyze("import {query} from '@solidjs/router';function setup(){Object.assign(query,{get:other});query.get('key');}").result;
  assert.equal(escaped.state,'partial');assert.equal(facts(escaped,'api-call').length,0);
});

test('FST renderer context does not leak into option callbacks',()=>{
  const r=analyze("import {component} from '@fst/components-fst-solid/app/component';const App=component(()=>null,{other:()=> <button onClick={[handler,data]}/>});").result;
  assert.equal(facts(r,'event-handler').length,0);
});

test('object methods and generator bodies are not direct tracked callback reads',()=>{
  const source=`import {createSignal,createEffect} from 'solid-js';function setup(){const [get,set]=createSignal(0);createEffect(()=>{const deferred={read(){get();},get value(){return get();}};get();});createEffect(function*(){get();yield 1;});}`;
  const r=complete(source);assert.equal(facts(r,'potential-read').length,1);
});

test('option callbacks and router keys follow only the verified overload positions',()=>{
  const source=`import {renderToString,renderToStream} from 'solid-js/web';import {reconcile} from 'solid-js/store';import {query} from '@solidjs/router';function setup(){renderToString(()=>null,{onCompleteAll:wrong});renderToStream(()=>null,{onError:wrong,onCompleteAll:info=>write(info)});const update=reconcile(value,{equals:wrong});query.set('key',value);}`;
  const r=complete(source),roles=values(r,'callback-role');assert(!roles.includes('server onError'));assert.equal(roles.filter((v)=>v==='server onCompleteAll').length,1);assert(!roles.includes('equality comparator'));
  assert.equal(facts(r,'key-source').length,1);
});

test('review6: logical context escapes never retain Provider identity',()=>{
  for(const expression of ['C && C','C || fallback','C ?? fallback','flag ? C : fallback']) {
    const r=analyze(`import {createContext} from 'solid-js';const C=createContext();escape(${expression});const View=()=> <C.Provider value={v}/>;`).result;
    assert.equal(facts(r,'provider-context').length,0,expression);
  }
});

test('review6: zero effective arity Show/Match children are not invoked untracked',()=>{
  for(const component of ['Show','Match']) for(const signature of ['()','(value=fallback)','(...values)']) {
    const source=`import {${component},createSignal} from 'solid-js';function App(){const [get,set]=createSignal(0);return <${component} when={true}>{${signature}=>get()}</${component}>;}`;
    const r=analyze(source).result;
    assert.equal(facts(r,'untracked-read').length,0,`${component}${signature}`);
    assert(!values(r,'callback-role').includes(`${component} render child`));
  }
});

test('review6: mapArray/For index accessor requires effective arity above one',()=>{
  for(const signature of ['(item=fallback,index)','(item,index=fallback)','(item,...index)']) {
    for(const body of [`mapArray(items,${signature}=>index());`,`const View=()=> <For each={items}>{${signature}=>index()}</For>;`]) {
      const r=analyze(`import {mapArray,For} from 'solid-js';function setup(){${body}}`).result;
      assert(!values(r,'parameter-role').some((v)=>v.startsWith('index: index accessor')),signature);
    }
  }
});

test('review6: optional/this parameters are erased correctly and nested defaults do not lower outer arity',()=>{
  const r=analyze(`import {mapArray} from 'solid-js';function setup(){
    mapArray(items,(item?:Item,index?:Index)=>index());
    mapArray(items,function(this:Context,item,index){return index();});
    mapArray(items,({name=fallback},index)=>index());}`).result;
  assert.equal(values(r,'parameter-role').filter((v)=>v==='index: index accessor').length,3);
});

test('review6: callable metadata escapes invalidate arity-dependent branches but not opaque invocation facts',()=>{
  for(const mutation of ["Object.defineProperty(render,'length',{value:0});",'escape(render);',"const alias=render;Object.defineProperty(alias,'length',{value:0});"]) {
    const r=analyze(`import {Show,createSignal} from 'solid-js';function App(){const [get,set]=createSignal(0);function render(value){return get();}${mutation}return <Show when={true}>{render}</Show>;}`).result;
    assert.equal(facts(r,'untracked-read').length,0,mutation);
  }
  const r=analyze(`import {mapArray} from 'solid-js';function render(item,index){return index();}mapArray(items,render,Object.defineProperty(render,'length',{value:0}));`).result;
  assert(!values(r,'parameter-role').includes('index: index accessor'));
});

test('review6: destructured callable properties are not labelled whole accessor parameters',()=>{
  const r=analyze(`import {For,Show} from 'solid-js';function App(){return <><For each={items}>{(item,{name})=>name}</For><Show when={value}>{({name})=>name}</Show></>;}`).result;
  assert(!values(r,'parameter-role').some((v)=>v.startsWith('name:')&&v.includes('accessor')));
});

test('review6: observable only consumes a function or next, never error/complete',()=>{
  const r=complete(`import {observable,createSignal} from 'solid-js';function setup(){const [get,set]=createSignal(0);const external=observable(get);external.subscribe({error:e=>recover(e),complete:done=>finish(done)});}`);
  assert.equal(facts(r,'callback').length,0);
  assert(!values(r,'parameter-role').some((v)=>/^(e|done):/.test(v)));
});

test('review6: from does not mistake a subscribable or escaped function for a callable producer',()=>{
  for(const mutation of ['producer.subscribe=next=>subscribe(next);',"Object.assign(producer,{subscribe:next=>subscribe(next)});",'escape(producer);']) {
    const r=analyze(`import {from} from 'solid-js';function producer(setter){unused(setter);}${mutation}const value=from(producer);`).result;
    assert(!values(r,'callback-role').includes('external producer'),mutation);
    assert(!values(r,'parameter-role').includes('setter: signal setter'),mutation);
  }
  const r=analyze(`import {from} from 'solid-js';function producer(setter){unused(setter);}const value=from(producer,Object.defineProperty(producer,'subscribe',{value:other}));`).result;
  assert(!values(r,'callback-role').includes('external producer'));
});

test('review6: from object dispatch is checked after other arguments, not at the first argument token',()=>{
  const r=analyze(`import {from} from 'solid-js';const producer={subscribe:next=>subscribe(next)};const value=from(producer,mutate(producer));`).result;
  assert(!values(r,'callback-role').includes('external subscription producer'));
});

test('review6: disabled comparator sentinels are options, not callbacks',()=>{
  const r=complete(`import {createMemo,createDeferred} from 'solid-js';const off=false;function setup(){const memo=createMemo(()=>1,undefined,{equals:off});const slow=createDeferred(memo,{equals:false});}`);
  assert.equal(facts(r,'callback').length,1);assert.equal(values(r,'option').filter((v)=>v==='equals=false').length,2);
  const other=analyze(`import {createMemo} from 'solid-js';function setup(){createMemo(()=>1,undefined,{equals:null});createMemo(()=>1,undefined,{equals:undefined});createMemo(()=>1,undefined,{equals:opaqueComparator});}`).result;
  assert(!facts(other,'callback').some((f)=>f.target.kind==='expression'&&['null','undefined'].includes(f.target.text)));
  assert(facts(other,'callback').some((f)=>f.target.kind==='expression'&&f.target.text==='opaqueComparator'));
  const shadowed=complete(`import {createMemo} from 'solid-js';function setup(undefined){createMemo(()=>1,0,{equals:undefined});}`);
  assert(facts(shadowed,'callback').some((f)=>f.target.kind==='expression'&&f.target.text==='undefined'));
});

test('review6: clean named callback aliases retain proven arity and callable producer dispatch',()=>{
  const source=`import {Show,For,from} from 'solid-js';function render(value){return value;}const alias=render;function map(item,index){return item;}const mapAlias=map;function producer(setter){subscribe(setter);}const input=producer;const result=from(input);function View(){return <><Show when={true}>{alias}</Show><For each={items}>{mapAlias}</For></>;}`;
  const r=complete(source);
  assert(values(r,'callback-role').includes('Show render child'));
  assert(values(r,'parameter-role').includes('index: index accessor'));
  assert(values(r,'callback-role').includes('external producer'));
});
