import { loadModule, parse, hash } from '../helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
const { createAnnotationEngine, ANNOTATION_LIMITS, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');
const { createFstSolidPlugin, fstReturnContracts } = await loadModule('src/frameworks/fst-solid/index.ts');
const plugin = createFstSolidPlugin({ implementationDigest: hash('core-rules'), configurationDigest: hash('core-contracts') });
function analyze(source, limits = {}) {
  const document = { source, sourceHash: hash(source), relativePath: 'core.tsx', language: 'tsx' };
  const parsed = parse(source);
  let view;
  try { view = createTypeScriptView({ ...document, tree: parsed.tree, returnContracts: fstReturnContracts }); }
  finally { parsed.close(); }
  const descriptor = { version: 1, core: { version: '1', implementationDigest: hash('core') }, view: { id: 'typescript', version: 1, implementationDigest: hash('view') }, parserDigest: hash('parser'), plugins: [plugin.descriptor], limits: { ...ANNOTATION_LIMITS, ...limits } };
  const manifest = { ...descriptor, id: hash(canonicalJSON(descriptor)) };
  const result = createAnnotationEngine({ manifest, plugins: [plugin], digest: hash }).analyze(document, view);
  validateAnnotationResult(result, manifest, source);
  assert(!result.reports.some((report) => report.state === 'failed'), JSON.stringify(result.reports));
  return result;
}
const facts = (r, term) => r.facts.filter((fact) => fact.term === `fst-solid.${term}`);
const operations = (r) => facts(r, 'api-operation').map((fact) => fact.value.value);
const has = (r, ...expected) => { for (const operation of expected) assert(operations(r).includes(operation), `${operation}: ${JSON.stringify(operations(r))}`); };
const spanText = (source, fact) => Buffer.from(source).subarray(fact.evidence.span.startByte, fact.evidence.span.endByte).toString('utf8');
const nameOf = (r, ref) => ref.kind === 'declaration' ? r.declarations.find((d) => d.key === ref.key)?.name : ref.name ?? ref.text;

test('values separate tracked/untracked reads, explicit writes, loader configuration and derivation', () => {
  const source = `import {value, switchValue} from '@fst/components-fst-solid/hooks/value';
    const initial=()=>1, changed=(arg)=>arg.value;
    const v=value(initial); v(); v(undefined); v(dynamic); v.get(); v.set(undefined);
    v.onChange(changed); v.load(()=>Promise.resolve(2),{explicit:true}); v.load(); v.refreshOnChange(initial);
    const sw=switchValue(initial, [1,()=>2]); sw();`;
  const r = analyze(source);
  has(r, 'value.create', 'value.switch-create', 'value.tracked-read', 'value.call-read-or-write', 'value.untracked-read', 'value.explicit-write-request', 'value.pre-commit-observe', 'value.configure-loader', 'value.invoke-loader', 'value.replace-derivation');
  assert(facts(r, 'option').some((f) => f.value.value === 'explicit=true'));
  assert(facts(r, 'callback-binding').some((f) => f.value.value === 'arg:pre-commit-value'));
  assert(facts(r, 'operation-target').some((f) => nameOf(r, f.target) === 'v' && spanText(source, f) === 'v.set(undefined)'));
});

test('delayed values and action schedulers describe requested timing without cancellation guarantees', () => {
  const r = analyze(`import {delayedValue, delayedAction} from '@fst/components-fst-solid/hooks/delayed';
    const v=delayedValue(200,''); v.set('later'); v.setNow('now'); v.cancelChange();
    const schedule=delayedAction({multiple:true}); schedule('save',400,()=>save(),true);`);
  has(r, 'value.delayed-create', 'value.delayed-write-request', 'value.immediate-write-request', 'value.cancel-pending-request', 'action.scheduler-create', 'action.schedule-request');
  assert(facts(r, 'option').some((f) => f.value.value === 'multiple=true'));
});

test('fluent Field conditional calls require method identity, not only an original Field source', () => {
  for(const method of ['map','onChange','onSet']) {
    const source=`import {field} from '@fst/components-fst-solid/app/field';const original=field('');const chained=original.${method}(value=>value);chained(dynamic);`;
    assert(facts(analyze(source),'field-dispatch').length>0,method);
    for(const mutation of ['escape(original);',`original.${method}=other;`,`const alias=original;alias.${method}=other;`]) {
      const r=analyze(source.replace('const chained=',`${mutation}const chained=`));
      assert.equal(facts(r,'field-dispatch').length,0,`${method}: ${mutation}`);
      assert(!facts(r,'field-operation').some(f=>['read','write-request'].includes(f.value?.value)),mutation);
    }
  }
});

test('field metadata, merge/update, transforms and cleanup are separate operations', () => {
  const r = analyze(`import {field} from '@fst/components-fst-solid/app/field';
    const f=field({x:0},{bindInitialValue:true}); const mapped=f.map(v=>v);
    mapped.refreshOn(()=>source); mapped.update({x:1}); mapped.get('editor'); mapped.set('editor',editor);
    mapped.with('custom',value); mapped.removeOnChange(callback); mapped.removeOnSet(callback); mapped.dispose();`);
  has(r, 'field.map-same-handle', 'field.refresh-dependency', 'field.merge-write-request', 'field.metadata-read', 'field.metadata-write-request', 'field.metadata-assign-request', 'field.remove-change-observer-request', 'field.remove-set-observer-request', 'field.dispose-request');
  assert(!operations(r).includes('value.explicit-write-request'));
  assert(facts(r, 'api-policy').some((f) => f.value.value === 'guard-only-not-full-resource-release'));
});

test('subform facades retain exact prefix expressions without inventing a new Form lifetime', () => {
  const r = analyze(`import {Form} from '@fst/components-fst-solid/app/form'; class F extends Form<F,{}>{}
    const form=F.new(); const sub=form.form('address'); const f=sub.field('city'); f.update('name'); form.setFieldValue('title','new');`);
  has(r, 'form.subform-prefix', 'form.prefixed-field-access', 'field.merge-write-request', 'form.field-write-request');
  assert(facts(r, 'subform-origin').length > 0);
  assert(facts(r, 'api-policy').some((f) => f.value.value === 'facade-not-new-owner'));
});

test('state/form readiness and command completion are not Promise chains', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state'; import {Form} from '@fst/components-fst-solid/app/form';
    class S extends State<S>{ save(){return 1} } class F extends Form<F,{}>{}
    const s=S.new(); s.onChange('title',v=>v); s.onReady(()=>{}); s.save.then(result=>result);
    const f=F.new(); f.onChange('title',v=>v); f.onReady(()=>{});`);
  has(r, 'state.member-observe', 'state.ready-observe', 'state.method-completion-observe', 'form.member-observe', 'form.ready-observe');
  assert(facts(r, 'api-policy').some((f) => f.value.value === 'successful-invocation-observer-not-promise-chain'));
});

test('selection bindings and object callback payloads retain source and correct named-callback owner', () => {
  const r = analyze(`import {Scope,useScopeSelectedBound,useScopeSelectedBoundTo} from '@fst/components-fst-solid/app/scope';
    class S extends Scope<S,{}>{} const scope=S.newScoped();
    const changed=({selected,args})=>selected();
    useScopeSelectedBoundTo(scope,()=>current,item=>item); useScopeSelectedBound(scope,()=>current,item=>save(item));
    scope.onSelectedChange(changed); scope.setSelected(next); scope.setMarked(items);`);
  has(r, 'selection.bind-one-way', 'selection.bind-two-way', 'selection.selected-observe', 'selection.select-request', 'selection.set-marked-request');
  assert(facts(r, 'callback-binding').some((f) => f.value.value === 'selected:selection-event.selected'));
  assert(facts(r, 'api-policy').some((f) => f.value.value === 'implementation-writes-all-not-marked'));
});

test('context keys and factories are authored references, never a resolved provider graph', () => {
  const r = analyze(`import {setContextData,getContextData,clearContextData,newScopedContext,useContextFromParent,useGlobalContext} from '@fst/components-fst-solid/app/component';
    setContextData('x',value); getContextData('x'); clearContextData('x'); newScopedContext('x',()=>value);
    useContextFromParent('x'); useGlobalContext('g',()=>value);`);
  has(r, 'context.provide', 'context.lookup', 'context.remove-request', 'context.create-scoped', 'context.reuse-or-create-global');
  assert(facts(r, 'api-policy').some((f) => f.value.value === 'current-then-ancestors-with-current-prefix-fallback'));
});

test('event, mouse, resize and timer subscriptions keep cleanup kinds explicit', () => {
  const r = analyze(`import {useTimeout,useInterval} from '@fst/components-fst-solid/hooks/timer';
    import {onDocumentEvent} from '@fst/components-fst-solid/hooks/documentEvent'; import {useWindowEvent} from '@fst/components-fst-solid/hooks/windowEvent';
    import {onResize,observeHeightChange} from '@fst/components-fst-solid/hooks/resize'; import {useMouseHover,onMouseClickOutside} from '@fst/components-fst-solid/hooks/mouse';
    const stop=useTimeout(()=>save(),100); stop(); useInterval(()=>poll(),200);
    onDocumentEvent('keydown',event=>handle(event),{capture:true}); useWindowEvent('resize',()=>{});
    const ro=onResize(element,entry=>{}); ro.disconnect(); const height=observeHeightChange(element,()=>{}); height.dispose();
    const hover=useMouseHover(()=>element,{callback:()=>{},checkVisible:true}); hover(); hover.setHover(true);
    const outside=onMouseClickOutside(()=>element,()=>close()); outside.remove();`);
  has(r, 'timer.timeout-register', 'timer.interval-register', 'cleanup.invoke-request', 'event.document-register', 'event.window-register', 'resize.observe', 'resize.disconnect-request', 'height.observe', 'resource.dispose-request', 'mouse.hover-observe', 'mouse.hover-write-request', 'mouse.outside-click-register', 'subscription.remove-request');
});

test('route definitions connect exact path/component references; preload/load are not invoked facts', () => {
  const source = `import {defineRoutes,defineNavGroups,useRouting,useOnNavigate} from '@fst/components-fst-solid/app/router';
    const Page=()=>null; const routes=defineRoutes({home:{path:'/home',component:Page,preload:fetcher,load:fetcher}});
    defineNavGroups({primary:{name:'Main',navPath:'/'}}); const router=useRouting(); router.navigateTo('/home',{id:1}); router.navigateBack(); useOnNavigate(event=>{});`;
  const r = analyze(source);
  has(r, 'routes.define', 'navigation.groups-define', 'navigation.to-request', 'navigation.back-request', 'navigation.observe');
  assert(facts(r, 'route-component').some((f) => nameOf(r, f.target) === 'Page'));
  assert(facts(r, 'route-path').some((f) => f.value.value === '/home'));
  assert(!facts(r, 'callback').some((f) => nameOf(r, f.target) === 'fetcher'));
});

test('models and lists preserve raw versus proxy and explicit derivation boundaries', () => {
  const r = analyze(`import {Model,createModel} from '@fst/components-fst-solid/app/model'; import {List,newStateObj} from '@fst/components-fst-solid/app/state';
    const proxy=Model.new({x:1}); const raw=createModel({x:1}); newStateObj(raw);
    const plain=List.new(1,2); plain.push(3); const derived=List.from(()=>items,x=>x); derived.set(next);`);
  has(r, 'model.proxy-create', 'model.raw-create', 'list.raw-create', 'list.derive', 'list.push-request', 'list.replace-request');
  assert(facts(r, 'api-policy').some((f) => f.value.value === 'raw-object-with-proxy-member'));
});

test('canonical List variadic contributions retain order, kind, expression and containing occurrence', () => {
  const source = `import {List} from '@fst/components-fst-solid/app/state';function use(){
    const a=List.new(first,...items,last,...items);const b=List.new(...items);a.push(next);}`;
  const r = analyze(source);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  const ordered = term => facts(r, term).sort((a,b) => a.evidence.span.startByte - b.evidence.span.startByte);
  assert.deepEqual(ordered('list-contribution').map(f => f.value.value), ['0:item', '1:spread-iterable', '2:item', '3:spread-iterable', '0:spread-iterable']);
  assert.deepEqual(ordered('list-item-source').map(f => f.target.text), ['first', 'items', 'last', 'items', 'items']);
  assert.equal(new Set(facts(r, 'list-item-source').map(f => f.target.span.startByte)).size, 5);
  assert.equal(new Set(facts(r, 'list-construction').map(f => f.target.span.startByte)).size, 2);
  for (const fact of facts(r, 'list-item-source')) {
    assert.equal(Buffer.from(source).subarray(fact.target.span.startByte, fact.target.span.endByte).toString(), fact.target.text);
    assert(facts(r, 'list-construction').some(call => call.evidence.span.startByte === fact.evidence.span.startByte && call.target.span.startByte <= fact.evidence.span.startByte && call.target.span.endByte >= fact.evidence.span.endByte));
  }
  assert.equal(operations(r).filter(op => op === 'list.raw-create').length, 2);
  assert(!operations(r).includes('list.push-request'));
  assert.equal(facts(r, 'api-handle').length, 0);
  assert(facts(r, 'api-policy').some(f => f.value.value.includes('final item count, values and normal completion unproven')));
});

test('variadic contribution support is not a constructor-wide or name-only spread exemption', () => {
  for (const source of [
    `import {List} from './foreign';const a=List.new(...items);`,
    `import type {List} from '@fst/components-fst-solid/app/state';const a=List.new(...items);`,
    `import {List} from '@fst/components-fst-solid/app/state';function f(List){return List.new(...items)}`,
    `import {List} from '@fst/components-fst-solid/app/state';const Alias=List;Alias.new=other;const a=Alias.new(...items);`,
    `import {List} from '@fst/components-fst-solid/app/state';consume(List);const a=List.new(...items);`,
    `import {List} from '@fst/components-fst-solid/app/state';const a=List.new?.(...items);`,
  ]) assert.equal(facts(analyze(source), 'list-contribution').length, 0, source);
  const r = analyze(`import {List} from '@fst/components-fst-solid/app/state';
    import {Model} from '@fst/components-fst-solid/app/model';import {value} from '@fst/components-fst-solid/hooks/value';
    const a=List.from(...items);const b=Model.new(...items);const c=value(...items);`);
  assert.equal(facts(r, 'list-contribution').length, 0);
  assert.equal(r.state, 'partial');
  assert(r.reports[0].diagnostics.some(d => d.code === 'fst-solid.core-shape'));
});

test('loading groups, sequences, effect loader and lazy lists carry distinct contracts', () => {
  const r = analyze(`import {load,LoadGroup,LoadSequence,lazyListLoadGroup,useResetLoadGroupOnInit} from '@fst/components-fst-solid/app/load';
    import {lazyValueList} from '@fst/components-fst-solid/hooks/value';
    const pending=load(()=>fetcher()); pending.then(loader=>loader()); pending();
    const items=lazyValueList(()=>fetchItems()); items.load();
    const group=new LoadGroup(items,'items',scope); group.complete();
    const lazy=lazyListLoadGroup('items',scope,()=>fetchItems()); lazy.resetOnInit({delay:10});
    const sequence=new LoadSequence([group],({loadGroup,index})=>loadGroup.complete()); sequence.load(); sequence.onCompleted(()=>{});
    useResetLoadGroupOnInit(group,{resetScope:true});`);
  has(r, 'loader.create', 'loader.completion-observe', 'loader.read', 'list.lazy-create', 'value.invoke-loader', 'load-group.create', 'load-group.complete-request', 'load-group.lazy-list-create', 'load-group.reset-on-init', 'load-sequence.create', 'load-sequence.invoke-request', 'load-sequence.complete-observe');
  assert(facts(r, 'callback-binding').some((f) => f.value.value === 'loadGroup:load-sequence-entry.loadGroup'));
});

test('fragments/views/refs and props retain manual root disposal and original presence semantics', () => {
  const r = analyze(`import {useFragment} from '@fst/components-fst-solid/app/fragment'; import {usePropValue} from '@fst/components-fst-solid/app/props';
    import {useView,useRootViewRenderer,elemRef,elemRefFst,resolveChildren} from '@fst/components-fst-solid/app/component';
    const fragment=useFragment({render:()=>null,class:'slot'}); fragment(true); const prop=usePropValue(()=>input,'fallback'); prop.hasValue();
    const view=useView(()=>null); view.render({name:'slot'}); view.dispose(); const render=useRootViewRenderer(); const root=render(()=>null); root.dispose();
    const native=elemRef(); native(); elemRefFst(); resolveChildren(()=>null);`);
  has(r, 'fragment.normalize', 'fragment.render-request', 'prop.normalize', 'prop.original-presence-read', 'view.create', 'view.render-replace-root', 'view.dispose-request', 'view.capture-renderer', 'view.render-root-request', 'dom.content-ref-create', 'dom.wrapper-ref-create', 'children.normalize');
});

test('post-render component callback is distinct from DOM exit, visibility and animation hooks', () => {
  const r = analyze(`import {component} from '@fst/components-fst-solid/app/component'; import {onEnter,onExit} from '@fst/components-fst-solid/app/dom/hooks';
    import {onDomElemAdded} from '@fst/components-fst-solid/app/dom/extendedDom'; import {withVisibility} from '@fst/components-fst-solid/animation/Show';
    import {usePageAnimations} from '@fst/components-fst-solid/animation/Animate';
    const C=component(()=>null,{onExit:()=>post(),onRendered:()=>never()}); onEnter(()=>{}); onExit(()=>{});
    const hook=onDomElemAdded({id:'pane',callback:el=>{}}); hook.remove();
    const visible=withVisibility(); visible.onChange(show=>{}); visible.show(false); const animator=usePageAnimations(); const controls=animator.controls(); controls.play('enter');`);
  has(r, 'component.post-render-register', 'dom.enter-register', 'dom.exit-register', 'dom.added-register', 'visibility.provide', 'visibility.before-change-observe', 'visibility.show-request', 'animation.controls-create', 'animation.play-request');
  assert(!facts(r, 'callback').some((f) => f.target.text?.includes('never')));
});

test('actions and confirmation requests do not imply permission enforcement or native Promise semantics', () => {
  const r = analyze(`import {action,confirmAction} from '@fst/components-fst-solid/app/action'; import {ConfirmationRequest} from '@fst/components-fst-solid/app/state';
    const save=action(args=>persist(args),{enabled:false}); save.enabledWhen(()=>allowed); save(1,2);
    const request=new ConfirmationRequest(); request.onCompletion(()=>{}); request.confirm();
    const confirm=confirmAction({request:()=>request,confirm:()=>save(),cancel:()=>cancel(),completeDelay:100}); confirm();`);
  has(r, 'action.create', 'action.enabled-status-observe', 'action.invoke-request', 'confirmation.create', 'confirmation.completion-observe', 'confirmation.confirm-request', 'action.confirmable-create');
});

test('SignalR and transport requests retain source APIs without resolving remote implementations', () => {
  const r = analyze(`import {signalRHub,onHubMessage,signalRApi} from '@fst/components-fst-solid/signalr';
    import {backendApi} from '@fst/components-fst-solid/app'; import {httpApi} from '@fst/components-fst-solid/http/api';
    import {invokeOnWebViewReady} from '@fst/components-fst-solid/webview/interop';
    const hub=signalRHub({url:'/hub'}); onHubMessage(hub,msg=>{}); hub.onMessage({callback:msg=>{}}); hub.connect();
    const api=signalRApi(hub,{apiPath:'orders'}); api.save(order); const backend=backendApi('OrderService'); backend.Load(id);
    const http=httpApi(spec,{baseUrl:'/api'}); http.fetch(id); invokeOnWebViewReady(()=>{});`);
  has(r, 'hub.create', 'subscription.onHubMessage', 'hub.message-register', 'hub.connect-request', 'transport.signalr-create', 'transport.backend-create', 'transport.http-create', 'transport.method-request', 'webview.ready-register');
});

test('async, retry, collection and persistent-key helpers emit only explicit contracts', () => {
  const r = analyze(`import {promise,delay,delaySinceLast} from '@fst/components-fst-solid/async'; import {invokeWithRetry} from '@fst/components-fst-solid/http/retry';
    import {forEachAsync} from '@fst/components-fst-solid/collections/array'; import {getAndInitCacheDb} from '@fst/components-fst-solid/cache/IndexDbCache';
    import {getSessionValue,setSessionValue} from '@fst/components-fst-solid/session/sessionStorage';
    const deferred=promise(); deferred.then(value=>value); deferred.resolve(1); deferred.reset(); delay(10); delaySinceLast(20,last);
    invokeWithRetry(()=>request(),{maxRetries:3,maxTotalMs:100}); forEachAsync(items,item=>save(item));
    const cache=getAndInitCacheDb('records'); cache.getUrlResource('/asset','v1'); cache.saveData('key',payload); cache.clearAll(); getSessionValue('id'); setSessionValue('id','next');`);
  has(r, 'deferred.create', 'deferred.then-register', 'deferred.resolve-request', 'deferred.reset-request', 'async.delay-request', 'retry.invoke-request', 'collection.concurrent-callbacks', 'cache.reuse-or-create', 'cache.resource-get-or-fetch', 'cache.data-save-request', 'cache.clear-request', 'session.read', 'session.write-request');
});

test('reviewed pair contracts project only known slots; nullable Field slots are not Field handles', () => {
  const r = analyze(`import {delayedToggle} from '@fst/components-fst-solid/hooks/delayed'; import {cnExtract} from '@fst/components-fst-solid/cn';
    import {resolveTextFieldOrText} from '@fst/components-fst-solid/app/field';
    const [read,reset]=delayedToggle(100,'',()=>text); read(); reset();
    const [remaining,extracted]=cnExtract('bg-red',['bg-']); const [maybeField,maybeText]=resolveTextFieldOrText(input); maybeField.update('x');`);
  has(r, 'toggle.delayed-create', 'accessor.read', 'cleanup.invoke-request', 'classes.partition', 'field.resolve-conditional-pair');
  assert(!operations(r).includes('field.merge-write-request'));
  assert(!r.diagnostics.some((d) => d.code === 'typescript.destructuring-value'));
});

test('delayed and children change snapshots extend existing bounded parameter mapping', () => {
  const r = analyze(`import {onChangeDelayed,resolveChildrenOnChange} from '@fst/components-fst-solid/app/state';
    const cb=([one,two])=>one(); onChangeDelayed(100,[a,b],cb); resolveChildrenOnChange([children,value],([child,val])=>child.accept());`);
  assert(facts(r, 'change-argument').some((f) => f.value.value === 'one'));
  assert(facts(r, 'change-argument').some((f) => f.value.value === 'val'));
  assert(facts(r, 'children-change-argument').some((f) => f.value.value === 'child'));
});

for (const [label, source] of [
  ['wrong module', `import {value} from 'other'; const v=value(0); v.set(1);`],
  ['root package', `import {value} from '@fst/components-fst-solid'; const v=value(0); v.set(1);`],
  ['type-only', `import type {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0); v.set(1);`],
  ['shadowed factory', `import {value} from '@fst/components-fst-solid/hooks/value'; function f(value){const v=value(0);v.set(1)}`],
  ['mutable factory', `import {value} from '@fst/components-fst-solid/hooks/value'; let make=value;make=other;const v=make(0);v.set(1);`],
  ['receiver mutation', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);v.set=other;v.set(1);`],
  ['receiver alias mutation', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);const alias=v;alias.set=other;v.set(1);`],
  ['unknown escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);mutate(v);v.set(1);`],
  ['alias escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);const alias=v;mutate(alias);v.set(1);`],
  ['nested object escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);mutate({nested:{v}});v.set(1);`],
  ['array alias escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);const stored=[v];mutate(stored);v.set(1);`],
  ['closure escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);mutate(()=>v);v.set(1);`],
  ['named closure escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);function expose(){return v} mutate(expose);v.set(1);`],
  ['external storage', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);external.value=v;v.set(1);`],
  ['JSX prop escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);const child=<Foreign value={v}/>;v.set(1);`],
  ['JSX spread escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);const child=<Foreign {...{value:v}}/>;v.set(1);`],
  ['sequence escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);mutate((0,v));v.set(1);`],
  ['await escape', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);mutate(await v);v.set(1);`],
  ['array member assignment', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);[v.set]=[other];v.set(1);`],
  ['object member assignment', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);({set:v.set}=other);v.set(1);`],
  ['unknown receiver method', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);v.unknown();v.set(1);`],
  ['computed receiver method', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);const get='set';v[get](1);v.set(1);`],
  ['unrelated receiver', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=other();v.set(1);`],
  ['function parameter', `import {value} from '@fst/components-fst-solid/hooks/value'; function run(v){v.set(1)}`],
  ['default destructuring', `import {delayedToggle} from '@fst/components-fst-solid/hooks/delayed'; const [a=other,b]=delayedToggle(1,0,()=>1);a();`],
  ['spread factory', `import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(...args);v.set(1);`],
]) test(`core negative: ${label}`, () => {
  const r = analyze(source);
  assert(!operations(r).some((operation) => ['value.explicit-write-request', 'accessor.read'].includes(operation)), JSON.stringify(operations(r)));
});

test('unknown APIs and inert documented members do not acquire contracts', () => {
  const r = analyze(`import {delayedValue} from '@fst/components-fst-solid/hooks/delayed'; import {Model} from '@fst/components-fst-solid/app';
    const d=delayedValue(1,''); d.refreshOnChange(()=>{}); Model.new({});
    import {LoadGroup} from '@fst/components-fst-solid/app/load'; const g=new LoadGroup(value); g.load();`);
  assert(!operations(r).some((operation) => ['value.replace-derivation', 'model.proxy-create', 'load-group.invoke-request'].includes(operation)));
});

test('computed identifiers are never mistaken for their spelling as property names', () => {
  const r = analyze(`import {value} from '@fst/components-fst-solid/hooks/value'; import {List} from '@fst/components-fst-solid/app/state';
    const v=value(0); const get='set',from='new'; v[get](1); List[from](1);`);
  assert(!operations(r).includes('value.untracked-read'));
  assert(!operations(r).includes('list.derive'));
});

test('switchValue is read-only and scheduler overloads associate the actual callback position', () => {
  const source = `import {switchValue} from '@fst/components-fst-solid/hooks/value'; import {delayedAction} from '@fst/components-fst-solid/hooks/delayed';
    const read=switchValue(()=>state,[1,()=>text]); read();
    const schedule=delayedAction(); const callback=()=>{}; schedule(100,callback,false); schedule('save',200,callback); schedule.reset('save'); schedule.isPending();`;
  const r = analyze(source);
  has(r, 'accessor.read', 'value.switch-case', 'action.cancel-scheduled-request', 'action.pending-read');
  assert(!operations(r).includes('value.explicit-write-request'));
  const callbacks = facts(r, 'callback').filter((f) => spanText(source, f).startsWith('schedule('));
  assert.equal(callbacks.length, 2);
  assert(callbacks.every((f) => nameOf(r, f.target) === 'callback'));
});

test('route entries have distinct occurrence anchors, including definitions passed by alias', () => {
  const source = `import {defineRoutes} from '@fst/components-fst-solid/app/router';
    const A=()=>null,B=()=>null; const entries={first:{path:'/a',component:A},second:{path:'/b',component:B}}; const routes=defineRoutes(entries);`;
  const r = analyze(source);
  assert.deepEqual(facts(r, 'route-component').map((f) => [spanText(source, f), nameOf(r, f.target)]).sort(), [
    ["first:{path:'/a',component:A}", 'A'], ["second:{path:'/b',component:B}", 'B'],
  ]);
});

test('canonical namespace and immutable aliases retain handle provenance through literal projections', () => {
  const r = analyze(`import * as Hooks from '@fst/components-fst-solid/hooks/value'; const make=Hooks.value;
    const original=make(0); const alias=original; alias.set(1);
    const {v}={v:make(2)}; v.set(3);`);
  assert.equal(operations(r).filter((op) => op === 'value.explicit-write-request').length, 2);
});

test('constructor contracts distinguish new from call without inventing unbound method invocations', () => {
  assert(fstReturnContracts.some((contract) => contract.id === 'fst-solid.load-group-construct' && contract.invocation === 'construct'));
  const r = analyze(`import {LoadGroup} from '@fst/components-fst-solid/app/load'; import {value} from '@fst/components-fst-solid/hooks/value';
    const {complete}=new LoadGroup(input); complete(); const wrong=LoadGroup(input); const invalid=new value(0); invalid.set(1);`);
  assert.equal(operations(r).filter((op) => op === 'load-group.create').length, 1);
  assert(!operations(r).includes('value.explicit-write-request'));
  assert(!operations(r).includes('load-group.complete-request'));
});

test('constructor prototype replacement never proves original instance method contracts', () => {
  for (const mutation of ['LoadGroup.prototype.complete=other;', 'const prototype=LoadGroup.prototype; prototype.complete=other;']) {
    const r = analyze(`import {LoadGroup} from '@fst/components-fst-solid/app/load'; ${mutation} const group=new LoadGroup(input); group.complete();`);
    assert(!operations(r).includes('load-group.complete-request'), JSON.stringify(operations(r)));
  }
  const escaped = analyze(`import {LoadGroup} from '@fst/components-fst-solid/app/load'; const group=new LoadGroup(input); mutate(LoadGroup.prototype); group.complete();`);
  assert(!operations(escaped).includes('load-group.complete-request'));
});

test('subclass overrides cannot leak inherited return handles through field or subform chains', () => {
  const r = analyze(`import {Form} from '@fst/components-fst-solid/app/form'; import {State} from '@fst/components-fst-solid/app/state';
    class F extends Form<F,{}>{field(){return foreign}} const f=F.new();
    const direct=f.field('x'); direct.update(1); const prefixed=f.form('address').field('x'); prefixed.update(1);
    class S extends State<S>{get save(){return ()=>1}} const s=S.new(); s.save.then(()=>{});`);
  assert(!operations(r).includes('field.merge-write-request'));
  assert(!operations(r).includes('state.method-completion-observe'));
});

test('foreign selection payload keys and unsupported watch arities are not mapped', () => {
  const r = analyze(`import {Scope} from '@fst/components-fst-solid/app/scope'; import {onChangeDelayed,resolveChildrenOnChange} from '@fst/components-fst-solid/app/state';
    class S extends Scope<S,{}>{} const scope=S.newScoped(); scope.onSelectedChange(({active})=>active());
    onChangeDelayed(1,[a,b,c,d],([first])=>first()); resolveChildrenOnChange([a],([child])=>child());`);
  assert.equal(facts(r, 'callback-binding').length, 0);
  assert.equal(facts(r, 'change-argument').length, 0);
  assert.equal(facts(r, 'children-change-argument').length, 0);
});

test('oversized route tables and malformed literal names remain partial, not invalid', () => {
  const r = analyze(`import {defineRoutes} from '@fst/components-fst-solid/app/router'; defineRoutes({${Array.from({length: 33}, (_, i) => `r${i}:{path:'/${i}'}`).join(',')}});`);
  assert(r.reports[0].diagnostics.some((d) => d.code === 'fst-solid.core-limit'));
  const hostile = analyze(`import {defineRoutes} from '@fst/components-fst-solid/app/router'; defineRoutes({'\\ud800':{path:'ok'}});`);
  assert(hostile.reports[0].diagnostics.some((d) => d.code === 'fst-solid.core-limit'));
});

test('ordinary Solid/FST renderers do not incur escape-limit diagnostics', () => {
  for (const extra of ['', "import {value} from '@fst/components-fst-solid/hooks/value'; const v=value(0);"]) {
    const r = analyze(`${extra} import {component} from '@fst/components-fst-solid/app/component';
      import {createSignal,onCleanup} from '@fst/components-fst-solid/solid-js';
      export const ColorEditorExample=component(()=>{const [opaque,setOpaque]=createSignal('#d49e6b');
        const [committed,setCommitted]=createSignal(''); onCleanup(()=>{});
        function save(){setOpaque('#fff');setCommitted(opaque());}
        return <button onClick={save}>{opaque()}{committed()}</button>;},{name:'ColorEditorExample'});`);
    assert.equal(r.reports[0].state, 'complete', JSON.stringify(r.reports));
  }
});

test('large JSX render returns are not an unknown-code escape of every receiver read', () => {
  const r = analyze(`import {component} from '@fst/components-fst-solid/app/component'; import {value} from '@fst/components-fst-solid/hooks/value';
    const v=value('text'); const C=component(()=>{return <div>${'<span>{v()}</span>'.repeat(80)}</div>});`, {maxWork: 100000});
  assert(!r.reports[0].diagnostics.some((d) => d.code === 'fst-solid.core-limit'), JSON.stringify(r.reports));
  assert.equal(operations(r).filter((operation) => operation === 'value.tracked-read').length, 80);
});

test('view props, router state, deferred options and confirmation response respect runtime signatures', () => {
  const source = `import {useView} from '@fst/components-fst-solid/app/component'; import {useRouterState} from '@fst/components-fst-solid/app/router';
    import {promise} from '@fst/components-fst-solid/async'; import {ConfirmationRequest} from '@fst/components-fst-solid/app/state';
    const view=useView(()=>null); const props={name:'x'}; view.render(props);
    const state=useRouterState(); state(); const resolved=()=>{}; const deferred=promise({onResolve:resolved}); deferred.done();
    const request=new ConfirmationRequest(); const response=request.response(); response.then(()=>{});`;
  const r = analyze(source);
  assert(!facts(r, 'callback').some((f) => spanText(source, f) === 'view.render(props)'));
  assert(!operations(r).includes('accessor.read'));
  assert(facts(r, 'callback').some((f) => nameOf(r, f.target) === 'resolved'));
  has(r, 'confirmation.response-read', 'deferred.then-register', 'deferred.done-read');
});

test('two same-owner handles have exact, separate occurrence targets rather than inferred owner joins', () => {
  const source = `import {value} from '@fst/components-fst-solid/hooks/value'; function run(){const a=value(0),b=value(1);a.set(2);b.set(3);}`;
  const r = analyze(source);
  const writes = facts(r, 'operation-target').filter((f) => ['a.set(2)', 'b.set(3)'].includes(spanText(source, f)));
  assert.deepEqual(writes.map((f) => [spanText(source, f), nameOf(r, f.target)]).sort(), [['a.set(2)', 'a'], ['b.set(3)', 'b']]);
});

test('large unrelated files remain not-applicable and mixed files avoid per-scalar projection costs', () => {
  const scalars = Array.from({length: 350}, (_, i) => `const v${i}=${i};`).join('\n');
  const unrelated = analyze(scalars, {maxWork: 20000});
  assert.equal(unrelated.reports[0].state, 'not-applicable');
  assert.equal(unrelated.state, 'complete');
  const mixed = analyze(`import {value} from '@fst/components-fst-solid/hooks/value'; ${scalars} const val=value(0); val.set(1);`, {maxWork: 20000});
  assert.equal(mixed.state, 'complete', JSON.stringify(mixed.reports));
  has(mixed, 'value.explicit-write-request');
});

test('work/fact/byte ceilings retain valid bounded evidence', () => {
  const source = `import {value} from '@fst/components-fst-solid/hooks/value'; ${Array.from({length: 40}, (_, i) => `const x${i}=value(0); x${i}.set(1);`).join('\n')}`;
  for (const limits of [{maxWork: 200}, {maxFacts: 8}, {maxResultBytes: 4096}]) assert.equal(analyze(source, limits).state, 'truncated');
});

test('dynamic route keys, oversized maps, hostile names and spread calls never fabricate literal entries', () => {
  const r = analyze(`import {defineRoutes} from '@fst/components-fst-solid/app/router'; import {value} from '@fst/components-fst-solid/hooks/value';
    defineRoutes({[unknown]:{path:'/x'}}); defineRoutes(dynamic); value(...args);`);
  assert.equal(facts(r, 'route-path').length, 0);
  assert(r.reports[0].diagnostics.some((d) => d.code === 'fst-solid.core-shape'));
});

test('review: recognized callback forwarding invalidates supplied handle methods, not unrelated handles', () => {
  const r = analyze(`import {value} from '@fst/components-fst-solid/hooks/value'; import {forEachAsync} from '@fst/components-fst-solid/collections/array';
    const v=value(0),safe=value(0); forEachAsync([v],x=>{x.set=()=>0}); v.set(1); safe.set(2);`);
  const writes = facts(r, 'operation-target').filter((f) => nameOf(r, f.target) === 'v' && f.evidence.ruleId === 'core-call');
  assert.equal(writes.length, 0);
  assert(facts(r, 'operation-target').some((f) => nameOf(r, f.target) === 'safe'));
});

test('review: action invocation forwards supplied handles to its callback', () => {
  const r = analyze(`import {value} from '@fst/components-fst-solid/hooks/value'; import {action} from '@fst/components-fst-solid/app/action';
    const v=value(0); const run=action(([arg])=>{arg.set=()=>0}); run(v); v.set(1);`);
  assert(!operations(r).includes('value.explicit-write-request'));
  has(r, 'action.invoke-request');
});

for (const [label, body, suffix = ''] of [
  ['constructor assignment', `constructor(){super();this.onReady=()=>this.asApi()}`],
  ['constructor computed assignment', `constructor(){super();this[key]=replacement}`],
  ['constructor assign helper', `constructor(){super();Object.assign(this,{onReady:replacement})}`],
  ['constructor this escape', `constructor(){super();install(this)}`],
  ['constructor alias escape', `constructor(){super();const self=this;install({self})}`],
  ['prototype replacement', '', 'S.prototype.onReady=replacement;'],
  ['prototype alias replacement', '', 'const proto=S.prototype;proto.onReady=replacement;'],
  ['prototype assign helper', '', 'Object.assign(S.prototype,{onReady:replacement});'],
  ['prototype escape', '', 'install(S.prototype);'],
]) test(`review: inherited family method rejects ${label}`, () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state'; class S extends State<S>{${body}} ${suffix} const s=S.new();s.onReady(()=>{});`);
  assert(!operations(r).includes('state.ready-observe'), JSON.stringify(operations(r)));
});

test('review: constructor data initialization does not block unrelated inherited methods', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state'; class S extends State<S>{constructor(){super();this.title='initial'}} const s=S.new();s.onReady(()=>{});`);
  has(r, 'state.ready-observe');
});

for (const mutation of [
  `class F extends Form<F,{}>{constructor(){super();this.field=()=>foreign}}`,
  `class F extends Form<F,{}>{} F.prototype.field=()=>foreign;`,
]) test('review: replaced inherited Form.field produces neither inherited handle nor write evidence', () => {
  const r = analyze(`import {Form} from '@fst/components-fst-solid/app/form'; ${mutation} const form=F.new();const f=form.field('x');f.update(1);f(1);`);
  assert(!operations(r).includes('field.merge-write-request'));
  assert(!facts(r, 'field-operation').some((f) => ['access-form-field', 'write-request'].includes(f.value?.value)));
});

test('review: factory-backed cache and lazy load-group handles depend on their constructors', () => {
  const r = analyze(`import {IndexedDbCache,getGlobalCache} from '@fst/components-fst-solid/cache/IndexDbCache';
    import {LoadGroup,lazyListLoadGroup} from '@fst/components-fst-solid/app/load';
    IndexedDbCache.prototype.clearAll=async()=>{}; LoadGroup.prototype.complete=()=>{};
    const cache=getGlobalCache();cache.clearAll();const group=lazyListLoadGroup('x',scope,loader);group.complete();`);
  assert(!operations(r).includes('cache.clear-request'));
  assert(!operations(r).includes('load-group.complete-request'));
});

for (const mutation of ['v.set=()=>0;', 'g.value.set=()=>0;', 'escape(g);']) test(`review: borrowed LoadGroup value preserves taint identity: ${mutation}`, () => {
  const r = analyze(`import {value} from '@fst/components-fst-solid/hooks/value';import {LoadGroup} from '@fst/components-fst-solid/app/load';
    const v=value(0);const g=new LoadGroup(v);${mutation}g.value.set(1);v.set(2);`);
  assert(!operations(r).includes('value.explicit-write-request'), JSON.stringify(operations(r)));
});

test('review: a verified borrowed LoadGroup value remains usable without mutation', () => {
  const r = analyze(`import {value} from '@fst/components-fst-solid/hooks/value';import {LoadGroup} from '@fst/components-fst-solid/app/load';const v=value(0);const g=new LoadGroup(v);g.value.set(1);v.set(2);`);
  assert.equal(operations(r).filter((op) => op === 'value.explicit-write-request').length, 2);
});

test('review: unknown LoadGroup input is not fabricated as a value handle', () => {
  const r = analyze(`import {LoadGroup} from '@fst/components-fst-solid/app/load';const g=new LoadGroup(unknown);g.value.set(1);`);
  assert(!operations(r).includes('value.explicit-write-request'));
});

test('review: shared cache factory results are not independent mutation roots', () => {
  const r = analyze(`import {getGlobalCache} from '@fst/components-fst-solid/cache/IndexDbCache';const first=getGlobalCache(),second=getGlobalCache();first.clearAll=async()=>{};second.clearAll();`);
  assert(!operations(r).includes('cache.clear-request'));
});

test('review: independent cache constructor results are not accidentally joined', () => {
  const r = analyze(`import {IndexedDbCache} from '@fst/components-fst-solid/cache/IndexDbCache';const first=new IndexedDbCache(),second=new IndexedDbCache();first.clearAll=async()=>{};second.clearAll();`);
  has(r, 'cache.clear-request');
});

for (const customization of [
  `protected isIgnoredProxyMember(n){return n==='save'}`,
  `protected buildMember(){return foreign}`,
  `constructor(){super();this.buildMember=foreign}`,
]) test('review: custom proxy construction cannot prove native command.then semantics', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state';class S extends State<S>{save(){} ${customization}}const s=S.new();s.save.then(()=>{});`);
  assert(!operations(r).includes('state.method-completion-observe'));
});

test('review: asScoped retains raw input provenance instead of manufacturing a proxy', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state';class S extends State<S>{save(){}}const s=S.asScoped(new S());s.save.then(()=>{});`);
  assert(!operations(r).includes('state.method-completion-observe'));
});

test('review: asScoped preserves a proven proxy and its mutation identity', () => {
  const good = analyze(`import {State} from '@fst/components-fst-solid/app/state';class S extends State<S>{save(){}}const original=S.new();const scoped=S.asScoped(original);scoped.save.then(()=>{});`);
  has(good, 'state.method-completion-observe');
  const bad = analyze(`import {State} from '@fst/components-fst-solid/app/state';class S extends State<S>{}const original=S.new();const scoped=S.asScoped(original);scoped.onReady=()=>{};original.onReady(()=>{});`);
  assert(!operations(bad).includes('state.ready-observe'));
});

for (const [factory, definition] of [
  ['defineRoutes', `home:{path:'/a',component:A},home:{path:'/b',component:B}`],
  ['defineNavGroups', `home:{name:'first',navPath:'/a'},home:{name:'last',navPath:'/b'}`],
]) test(`review: duplicate ${factory} entries never mix earlier anchors with later values`, () => {
  const r = analyze(`import {${factory}} from '@fst/components-fst-solid/app/router';const A=()=>null,B=()=>null;const source={${definition}};const alias=source;${factory}(alias);`);
  assert.equal(facts(r, 'route-entry').length, 0);
  assert.equal(facts(r, 'route-component').length, 0);
  assert.equal(facts(r, 'route-path').length, 0);
  assert(r.reports[0].diagnostics.some((d) => d.code === 'fst-solid.core-shape'));
});

test('review: nested duplicate route options are unresolved while unrelated unique entries stay exact', () => {
  const source = `import {defineRoutes} from '@fst/components-fst-solid/app/router';const A=()=>null,B=()=>null;
    const duplicate={path:'/a',component:A,path:'/b',component:B};defineRoutes({bad:duplicate,good:{path:'/ok',component:A}});`;
  const r = analyze(source);
  assert.deepEqual(facts(r, 'route-component').map((f) => [spanText(source, f),nameOf(r,f.target)]), [["good:{path:'/ok',component:A}",'A']]);
});

test('review: literal computed duplicates and unknown computed route keys cannot relabel earlier entries', () => {
  for (const key of ["['home']", '[dynamic]']) {
    const r = analyze(`import {defineRoutes} from '@fst/components-fst-solid/app/router';const A=()=>null,B=()=>null;defineRoutes({home:{path:'/a',component:A},${key}:{path:'/b',component:B}});`);
    assert.equal(facts(r, 'route-component').length, 0);
    assert.equal(facts(r, 'route-path').length, 0);
  }
});

test('review: imported base prototype changes invalidate every affected local family', () => {
  for (const statement of ["State.prototype.onReady=replacement;", "Object.setPrototypeOf(S.prototype,foreign);"]) {
    const r = analyze(`import {State} from '@fst/components-fst-solid/app/state';class S extends State<S>{}${statement}const s=S.new();s.onReady(()=>{});`);
    assert(!operations(r).includes('state.ready-observe'));
  }
  const namespaced = analyze(`import * as Family from '@fst/components-fst-solid/app/state';class S extends Family.State<S>{}Family.State.prototype.onReady=replacement;const s=S.new();s.onReady(()=>{});`);
  assert(!operations(namespaced).includes('state.ready-observe'));
});

test('review: backing constructor namespace aliases and escapes invalidate shared factories', () => {
  const r = analyze(`import * as Cache from '@fst/components-fst-solid/cache/IndexDbCache';const proto=Cache.IndexedDbCache.prototype;escape(proto);const c=Cache.getGlobalCache();c.clearAll();`);
  assert(!operations(r).includes('cache.clear-request'));
});

test('review: borrowing still propagates escape when wrapper method proof is unavailable', () => {
  const r = analyze(`import {value} from '@fst/components-fst-solid/hooks/value';import {LoadGroup} from '@fst/components-fst-solid/app/load';
    LoadGroup.prototype.complete=foreign;const v=value(0);const {value:borrowed}=new LoadGroup(v);escape(borrowed);v.set(1);`);
  assert(!operations(r).includes('value.explicit-write-request'));
});

test('review: application ancestry with proxy customization stays unresolved, not an inherited command proof', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state';class Base extends State<Base>{protected buildMember(){return foreign}}class S extends Base{save(){}}const s=S.new();s.save.then(()=>{});`);
  assert(!operations(r).includes('state.method-completion-observe'));
});

test('review: large unrelated renderer syntax does not disable a safe family receiver', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state';import {component} from '@fst/components-fst-solid/app/component';
    class S extends State<S>{}const s=S.new();const C=component(()=> <div>${'<span>text</span>'.repeat(80)}</div>);s.onReady(()=>{});`);
  has(r, 'state.ready-observe');
});

test('ordinary wide escape inspection preserves safe receivers but never escaped handles', () => {
  const prefix = "import {value} from '@fst/components-fst-solid/hooks/value';const v=value(0);";
  const entries = Array.from({ length: 300 }, () => '{label:"item"}').join(',');
  const safe = analyze(`${prefix} unknown([${entries}]);v.set(1);`);
  has(safe, 'value.explicit-write-request');
  assert(!safe.reports[0].diagnostics.some(d => d.code === 'fst-solid.core-limit'));
  const escaped = analyze(`${prefix} unknown([${entries},{nested:v}]);v.set(1);`);
  assert(!operations(escaped).includes('value.explicit-write-request'));
  const limited = analyze(`${prefix} unknown([${'{label:0},'.repeat(4200)}]);v.set(1);`);
  assert(limited.reports[0].diagnostics.some(d => d.code === 'fst-solid.core-limit' && /resource=receiver-escape-nodes accounted=4097 limit=4096/.test(d.message)));
  assert(!operations(limited).includes('value.explicit-write-request'));
});
