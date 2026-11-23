import { loadModule, parse, hash } from '../helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
const { createFstComponentsPlugin, fstComponentsReturnContracts } = await loadModule('src/frameworks/fst-solid/components.ts');
const { createAnnotationEngine, ANNOTATION_LIMITS, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');
const digests = { implementationDigest: hash('components-test-code'), configurationDigest: hash('components-test-config') };
const plugin = createFstComponentsPlugin(digests);
function analyze(source, options = {}) {
  const document = { source, sourceHash: hash(source), relativePath: 'components.tsx', language: 'tsx' };
  const parsed = parse(source, 'tsx');
  let view;
  try { view = createTypeScriptView({ tree: parsed.tree, ...document, returnContracts: fstComponentsReturnContracts, ...(options.viewLimits ? { limits: options.viewLimits } : {}) }); }
  finally { parsed.close(); }
  const descriptor = { version: 1, core: { version: '1', implementationDigest: hash('core') }, view: { id: 'typescript', version: 1, implementationDigest: hash('view') }, parserDigest: hash('parser'), plugins: [plugin.descriptor], limits: { ...ANNOTATION_LIMITS, ...options.limits } };
  const manifest = { ...descriptor, id: hash(canonicalJSON(descriptor)) };
  const result = createAnnotationEngine({ manifest, plugins: [plugin], digest: hash }).analyze(document, view, options.cancelled ? { cancelled: options.cancelled } : undefined);
  validateAnnotationResult(result, manifest, source);
  assert(!result.reports.some((report) => report.state === 'failed'), JSON.stringify(result.reports));
  return result;
}
const facts = (r, term) => r.facts.filter((fact) => fact.term === `fst-components.${term}`);
const values = (r, term) => facts(r, term).map((fact) => fact.value?.value);
const has = (r, term, text) => assert(values(r, term).some((value) => value?.includes(text)), `${term}: ${text}\n${JSON.stringify(values(r, term))}`);
const text = (source, fact) => Buffer.from(source).subarray(fact.evidence.span.startByte, fact.evidence.span.endByte).toString();
const D = '@fst/components-fst-disco-ui', I = '@fst/components-fst-solid-icons', T = '@fst/components-fst-solid-threejs';

test('separate descriptor and immutable generic return contracts have no runtime dependencies', () => {
  assert.equal(plugin.descriptor.id, 'fst-components');
  assert(plugin.descriptor.roles.every((term) => term.id.startsWith('fst-components.')));
  assert(Object.isFrozen(fstComponentsReturnContracts));
  assert.throws(() => createFstComponentsPlugin({ ...digests, implementationDigest: 'bad' }));
  assert(fstComponentsReturnContracts.every((contract) => contract.origins.every((origin) => !origin.module.includes('/components/Modal') && !origin.module.endsWith('/loaders'))));
});

for (const [name, prop, callback, payload] of [
  ['TextBox', 'value', 'onInput', 'string'], ['TextArea', 'value', 'onInput', 'string'],
  ['Checkbox', 'checked', 'onChange', 'boolean'], ['Switch', 'checked', 'onChange', 'boolean'],
  ['Slider', 'value', 'onInput', 'number'], ['Select', 'value', 'onChange', 'NonNullable'],
  ['ColorEditor', 'value', 'onInput', 'normalized-hex-string'], ['MarkdownEditor', 'value', 'onInput', 'string'],
]) test(`imported ${name} control has exact field/value and typed callback contracts`, () => {
  const source = `import {${name} as C} from '${D}/components'; const field=external; const View=()=> <><C field={field} ${callback}={next=>accept(next)}/><C ${prop}={condition?one:two}/></>;`;
  const r = analyze(source);
  assert.equal(r.state, 'complete');
  assert.equal(facts(r, 'field').length, 1); assert.equal(facts(r, prop).length, 1);
  has(r, 'callback-contract', `${callback}(${payload}`);
  has(r, 'ownership', 'borrowed-field');
  assert.equal(facts(r, 'literal').length, 0);
  assert.equal(facts(r, prop)[0].target.text, 'condition?one:two');
  const field = facts(r, 'field')[0], cb = facts(r, 'callback')[0];
  assert.deepEqual(field.evidence.span, cb.evidence.span);
  assert(text(source, field).startsWith('<C field='));
  assert.notDeepEqual(field.evidence.span, facts(r, prop)[0].evidence.span);
});

test('ColorEditor commit is notification; Zen MarkdownEditor apiRef borrows and clears its handle', () => {
  const r = analyze(`import {ColorEditor,MarkdownEditor} from '${D}'; const View=()=> <><ColorEditor field={color} onCommit={hex=>save(hex)}/><MarkdownEditor value={text} apiRef={handle=>use(handle)}/></>;`);
  has(r, 'callback-contract', 'notification-not-second-field-write');
  has(r, 'callback-contract', 'MarkdownEditorHandle|undefined'); has(r, 'ownership', 'borrowed-editor-handle');
  has(r, 'qualification', 'Zen-public-export;absent-from-inspected-Funtasia');
  assert(!r.facts.some((f) => f.term.includes('write') || f.value?.value === 'write'));
});

test('JSX unknown spreads, duplicates and foreign components never invent property facts', () => {
  const r = analyze(`import {TextBox} from '${D}'; const View=()=> <><TextBox field={f} {...unknown}/><TextBox value="a" value="b"/><Foreign.TextBox field={f}/></>;`);
  assert.equal(facts(r, 'field').length, 0); assert.equal(facts(r, 'value').length, 0);
  assert(r.reports[0].diagnostics.some((d) => d.code === 'fst-components.dynamic-props'));
});

test('literal forwarded props retain callback/value sources and authored override order', () => {
  const source = `import {ColorEditor} from '${D}'; const props={value:'#123456',onInput:hex=>hex.toUpperCase()};
    const alias=props; const View=()=> <ColorEditor {...alias} value="#abcdef"/>;`;
  const r = analyze(source);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  has(r, 'literal', 'value=#abcdef');
  assert(!values(r, 'literal').includes('value=#123456'));
  has(r, 'callback-contract', 'ColorEditor.onInput(normalized-hex-string)');
  assert.equal(facts(r, 'spread-source').length, 1);
  assert.equal(facts(r, 'forwarded-prop').length, 1);
  assert.equal(facts(r, 'forwarded-prop')[0].target.text, 'onInput:hex=>hex.toUpperCase()');
  assert.equal(text(source, facts(r, 'callback')[0]), '<ColorEditor {...alias} value="#abcdef"/>');
});

test('known spreads preserve earlier props they do not override and nested spreads use last own value', () => {
  const r = analyze(`import {Select,Popover} from '${D}'; const popup={portal:true};
    const first={open:false};const options={...first,open:true,onOpenChange:open=>use(open)};
    const View=()=> <><Select field={field} {...popup} onChange={value=>use(value)}/><Popover {...options} anchor={anchor}/></>;`);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  assert.equal(facts(r, 'field').length, 1);
  has(r, 'literal', 'open=true');
  assert(!values(r, 'literal').includes('open=false'));
  has(r, 'callback-contract', 'Select.onChange');
  has(r, 'callback-contract', 'Popover.onOpenChange');
});

test('unknown forwarded keys retain uncertainty but do not erase later explicit callbacks', () => {
  const r = analyze(`import {TextBox} from '${D}';const View=()=> <TextBox value="old" {...unknown} onInput={next=>use(next)}/>;`);
  assert.equal(r.state, 'complete');
  assert.equal(facts(r, 'value').length, 0);
  assert.equal(facts(r, 'spread-source').length, 1);
  has(r, 'qualification', 'unknown keys');
  has(r, 'callback-contract', 'TextBox.onInput');
  has(r, 'props-contract', 'last-non-undefined');
  has(r, 'conditional-prop-contract', 'handler identity and delivery unproven');
  assert.equal(facts(r, 'jsx-contribution').length, 3);
});

for (const [name, definition, before, after] of [
  ['getter', "const props={get value(){return 'old'}};", '', ''],
  ['computed', "const props={[key]:'old'};", '', ''],
  ['prototype', "const props={__proto__:other,value:'old'};", '', ''],
  ['mutation', "const props={value:'old'};", 'props.value=next;', ''],
  ['alias mutation', "const props={value:'old'};const alias=props;", 'alias.value=next;', ''],
  ['escape', "const props={value:'old'};", 'escape(props);', ''],
  ['later evaluation', "const props={value:'old'};", '', 'ignored={mutate(props)}'],
]) test(`forwarded props reject unsafe ${name}`, () => {
  const r = analyze(`import {TextBox} from '${D}';${definition}${before}const View=()=> <TextBox {...props} ${after}/>;`);
  assert.equal(facts(r, 'value').length, 0);
  assert.equal(r.state, 'complete');
  assert.equal(facts(r, 'spread-source').length, 1);
  has(r, 'props-contract', 'keys, values, getters');
  assert.equal(facts(r, 'callback').length, 0);
});

test('conditional control props retain element and contribution identity without uncertain final bindings', () => {
  const source=`import {TextBox,Popover} from '${D}';const View=()=> <>
    <TextBox field={original} {...props} onInput={handler} {...props} value={maybe}/>
    <Popover {...props} anchor={undefined}>{child}</Popover></>;`;
  const r=analyze(source);
  assert.equal(r.state,'complete',JSON.stringify(r.reports));
  const contributions=facts(r,'jsx-contribution').sort((a,b)=>a.evidence.span.startByte-b.evidence.span.startByte);
  assert.deepEqual(contributions.map(f=>f.value.value),['0:group=0:attribute:field','1:group=1:spread','2:group=2:attribute:onInput','3:group=3:spread','4:group=4:attribute:value','0:group=1:spread','1:group=2:attribute:anchor','2:group=2:nested-child-source']);
  assert.equal(new Set(facts(r,'jsx-element').map(f=>f.target.span.startByte)).size,2);
  for(const term of ['field','value','input','callback','callback-payload']) assert.equal(facts(r,term).length,0,term);
  has(r,'conditional-prop-contract','callback(string)');
  has(r,'conditional-prop-contract','dismissal requests false');
  for(const fact of facts(r,'jsx-contribution-source')) assert.equal(Buffer.from(source).subarray(fact.target.span.startByte,fact.target.span.endByte).toString(),fact.target.text);
});

test('conditional prop contracts are not generic spread suppression for unreviewed APIs or invalid imports', () => {
  for(const prefix of [`import {TextBox} from './foreign';`,`import type {TextBox} from '${D}';`,'function TextBox(){}']) {
    const r=analyze(`${prefix}const View=()=> <TextBox {...props}/>;`);
    assert.equal(facts(r,'props-contract').length,0);
    assert.equal(facts(r,'jsx-contribution').length,0);
  }
  const r=analyze(`import {ContextMenu} from '${D}';const View=()=> <ContextMenu {...props}/>;`);
  assert.equal(r.state,'partial');
  assert(r.reports[0].diagnostics.some(d=>d.code==='fst-components.dynamic-props'));
  assert.equal(facts(r,'props-contract').length,0);
});

test('known spread keys do not prove a final binding when undefined fallback is possible', () => {
  for(const attributes of ['field={first} {...{field:maybe}}','{...{field:first}} field={maybe}','onInput={first} {...{onInput:maybe}}','field={first} {...{other:1}} field={maybe}']) {
    const r=analyze(`import {TextBox} from '${D}';const View=()=> <TextBox ${attributes}/>;`);
    assert.equal(r.state,'complete');
    assert.equal(facts(r,'field').length,0,attributes);
    assert.equal(facts(r,'callback').length,0,attributes);
    has(r,'props-contract','object-literal flattening');
  }
});

test('boolean shorthand records authored true, not a fabricated runtime expression', () => {
  const r = analyze(`import {Checkbox,Popover} from '${D}';const V=()=> <><Checkbox checked/><Popover open anchor={element} onOpenChange={next=>update(next)}/></>;`);
  has(r, 'literal', 'checked=true'); has(r, 'literal', 'open=true');
  assert.equal(facts(r, 'checked')[0].target.text, 'checked');
});

test('JSX entity and backslash strings stay source references instead of JS-decoded constants', () => {
  const r = analyze(`import {TextBox} from '${D}';const V=()=> <><TextBox value="a&amp;b"/><TextBox value="\\n"/></>;`);
  assert.equal(facts(r, 'value').length, 2); assert.equal(facts(r, 'literal').length, 0);
});

test('namespace aliases qualify their own JSX even inside mixed React source, not unrelated tags', () => {
  const r = analyze(`import React from 'react'; import * as UI from '${D}'; const Control=UI.TextBox; const Other=React.TextBox; const View=()=> <><Control value="literal"/><Other value="wrong"/><input value="native"/></>;`);
  assert.equal(facts(r, 'value').length, 1); has(r, 'literal', 'value=literal');
});

test('owner-captured modal and toast methods keep callable return identities', () => {
  const r = analyze(`import {useModal,useToasts,initToasts} from '${D}';
    const {openModal,openConfirmationModal:confirm}=useModal(); const toasts=useToasts();
    const close=openModal(({close})=>{close('cancel');return null}); close('programmatic');
    const promise=confirm({onConfirm:()=>false}); const toast=toasts.showToast({onClose:()=>{}}); toast(); toasts.dismissToast(toast.id);
    const cleanup=initToasts(element); cleanup();`);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  has(r, 'ownership', 'owner-captured-at-call'); has(r, 'result-contract', 'ModalClose(reason?)');
  has(r, 'result-contract', 'Promise<void>;false-confirm-keeps-open;cancel-rejects');
  has(r, 'result-contract', 'ToastHandle;callable-dismiss;readonly-id');
  has(r, 'api', 'modal-close.close'); has(r, 'api', 'toast-handle.dismiss'); has(r, 'api', 'disposer.dispose');
});

test('DOM targets have separate conditional-owner and explicit-theme cleanup contracts', () => {
  const r = analyze(`import {tooltip,focusring} from '${D}/components'; import {applyDiscoTheme} from '${D}/theme';
    const tip=tooltip(element,()=>[true,'help']); const focus=focusring(element,()=>4); const restore=applyDiscoTheme(element,theme); tip();focus();restore();`);
  has(r, 'cleanup', 'conditional-owner-cleanup'); has(r, 'cleanup', 'explicit-only;no-owner-registration');
  has(r, 'callback-contract', '[bottom:boolean,JSX.Element];not-visibility');
  assert.equal(values(r, 'api').filter((v) => v === 'disposer.dispose').length, 3);
});

test('icon public assets, configuration, cache and SvgIcon record references not cache state', () => {
  const r = analyze(`import {loadIconDef,resolveIconDef,configureIconAssetLoading,resolveIconAssetUrl,getIconAssetShape,clearIconAssetCache,getIconAssetCacheSnapshot} from '${I}/assets'; import {SvgIcon} from '${I}/components';
    configureIconAssetLoading({baseUrl:'/local',resolver:shape=>'/icons/'+shape.path}); const a=loadIconDef('tb/TbMenu2'); const b=resolveIconDef(definition); resolveIconAssetUrl('tb/TbMenu2'); const {family,path}=getIconAssetShape('tb/TbMenu2'); clearIconAssetCache(); getIconAssetCacheSnapshot(); const View=()=> <SvgIcon shape={condition?'tb/A':'tb/B'}/>;`);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  has(r, 'result-contract', 'Promise<IconDef|null>'); has(r, 'callback-contract', 'IconAssetShape');
  has(r, 'result-contract', 'not-cancellation'); has(r, 'result-contract', 'not-live-state');
  assert(facts(r, 'input').some((f) => f.target.text === `condition?'tb/A':'tb/B'`));
  assert(!values(r, 'literal').some((v) => v.includes('shape=tb/A')));
});

test('Scene setup payload proves inline scene receiver, node return, listener handle and delta callback', () => {
  const source = `import {Canvas3d,Scene} from '${T}/Canvas'; import {SceneNode} from '${T}/scene';
    const View=()=> <Canvas3d><Scene setup={({scene,invalidateRender})=>{const node=scene.add(new SceneNode(),{name:'mesh',onAdded:({node})=>use(node)});const sub=scene.addRenderListener({onBeforeRenderScene:({delta})=>tick(delta)});sub.dispose();invalidateRender();}}/></Canvas3d>;`;
  const r = analyze(source);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  has(r, 'requirement', 'Canvas3dState-required'); has(r, 'cleanup', 'no-context-dispose-call');
  has(r, 'api', 'scene.add'); has(r, 'api', 'render-listener.dispose'); has(r, 'api', 'invalidate.invalidateRender');
  has(r, 'callback-contract', 'delta:number'); has(r, 'result-contract', 'same-node-argument');
  assert(facts(r, 'target').some((f) => text(source, f) === 'sub.dispose()'));
});

test('Three raw loaders and AssetsManager entry promises are distinct', () => {
  const r = analyze(`import {loadGLTF,loadTexture,loaderFn} from '${T}/utils'; import {AssetsManager} from '${T}/assets';
    const raw=loadTexture('image'); loadGLTF(['one','two'],true,false,loader=>extend(loader)); const load=loaderFn(loader=>extend(loader)); load(Loader,'one','two');
    const assets=new AssetsManager(); const texture=assets.loadTexture('image'); const model=assets.loadGltf('model');`);
  has(r, 'result-contract', 'Promise<Texture>;raw-resource'); has(r, 'result-contract', 'Promise<GLTFData|GLTFData[]>');
  has(r, 'result-contract', 'Promise<TextureAssetEntry>;texture-optional;failure-swallowed');
  has(r, 'result-contract', 'Promise<GltfAssetEntry>;failure-evicts-and-rethrows');
  has(r, 'api', 'loader.load-results');
});

test('controlled overlays retain state and close/action contract without asserting visibility', () => {
  const r = analyze(`import {ContextMenu,Popover} from '${D}'; const View=()=> <><Popover open={active} anchor={element} onOpenChange={next=>set(next)}/><ContextMenu position={point} onClose={()=>close()} items={[{label:'Run',onSelect:()=>run()}]}/></>;`);
  has(r, 'prop', 'open'); has(r, 'prop', 'anchor'); has(r, 'prop', 'position');
  has(r, 'callback-contract', 'dismissal-requests-false'); has(r, 'callback-contract', 'onSelect:()=>void;after-close-request');
});

test('effect objects have explicit disposal, Promise<void> setup does not', () => {
  const r = analyze(`import {setupMaterialFogEffect,setupVolumetricFogEffect,setupVolumetricCloudsEffect,setupSsaoEffect,setupPencilLinesEffect} from '${T}/effects';
    const fog=setupMaterialFogEffect(scene); fog.dispose(); const pass=setupVolumetricFogEffect(scene); pass.dispose(); setupVolumetricCloudsEffect(scene);
    const noHandle=setupSsaoEffect(scene); noHandle.dispose(); setupPencilLinesEffect(scene);`);
  assert.equal(values(r, 'api').filter((v) => v === 'effect.dispose').length, 2);
  has(r, 'result-contract', 'Promise<void>;pipeline-replacement'); has(r, 'cleanup', 'not-composer-removal');
});

test('scenegraph document, runtime callbacks and overlay bridge preserve explicit registrations', () => {
  const r = analyze(`import {createSceneGraphRuntimeData,SceneGraphRuntime,SceneGraphCanvas,createSceneGraphHtmlSceneOverlayBridge} from '${T}/scene/scenegraph';
    const data=createSceneGraphRuntimeData(document); const runtime=new SceneGraphRuntime(data);runtime.attach(scene);runtime.setDocument(next);const node=runtime.getNodeById('hero');const snapshot=node.captureSnapshot();snapshot.dispose();runtime.dispose();
    const bridge=createSceneGraphHtmlSceneOverlayBridge();const entry=bridge.registerHtmlScene(config,{onTextureCanvas:canvas=>paint(canvas)});entry.requestCapture();entry.dispose();const unbind=bridge.bindOverlayEntry('hero',binding);unbind();
    const View=()=> <SceneGraphCanvas document={document} onRuntimeReady={live=>live.setDocument(next)} onRuntimeDispose={live=>notify(live)}/>;`);
  has(r, 'result-contract', 'SceneGraphRuntimeData;not-live-scene'); has(r, 'api', 'runtime.attach');
  has(r, 'result-contract', 'SceneGraphRuntimeNodeHandle|null;transient'); has(r, 'api', 'snapshot.dispose');
  has(r, 'api', 'html-registration.requestCapture'); has(r, 'api', 'html-registration.dispose');
  has(r, 'callback-contract', 'onRuntimeReady(SceneGraphRuntime);component-managed');
  assert(facts(r, 'document').length >= 3);
});

test('camera lookup, listener handles, shape-only pairs and animation clip/layer requests', () => {
  const r = analyze(`import {setupCameraControls,useCameraControls,getCameraPosFocusOnBoneWithZoom,GLTFMeshNode} from '${T}/scene';
    const camera=setupCameraControls(scene);const listener=camera.addCameraControlEndListener(()=>{});listener.dispose();camera.setCameraDistance(3);useCameraControls(scene);
    const [position,target]=getCameraPosFocusOnBoneWithZoom(45,bone);const mesh=new GLTFMeshNode({gltf});mesh.animation.playAnimation('walk');mesh.animation.poseLayered('idle',{layerKey:'upper',trackMask:name=>true});mesh.animation.tweenLayerWeight('upper',1,200,{onUpdate:({weight,pct})=>tick(weight,pct)});mesh.animation.stopLayerTween('upper');mesh.animation.dispose();`);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  has(r, 'result-contract', 'named-node-lookup;not-Solid-context'); has(r, 'api', 'camera-listener.dispose');
  has(r, 'result-contract', 'shape-only'); has(r, 'api', 'animation.playAnimation'); has(r, 'literal', 'layerKey=upper');
  has(r, 'callback-contract', 'startWeight,weight,pct'); has(r, 'cleanup', 'does-not-cancel-layer-tweens');
});

for (const [label, source] of [
  ['wrong origin', `import {loadTexture,TextBox} from 'foreign';loadTexture('x');const V=()=> <TextBox field={x}/>;`],
  ['invalid Disco deep path', `import {openModal} from '${D}/components/Modal';openModal(()=>null);`],
  ['empty Three loaders and commented useLoader', `import {loadGLTF,useLoader} from '${T}/loaders';loadGLTF('x');useLoader('x');`],
  ['private icon factory', `import {icon,glyph,parseColor} from '${D}';icon('x');glyph('x');parseColor('x');`],
  ['foreign Three receiver', `import {loadTexture} from '${T}/utils';const value=other();value.dispose();value.loadTexture('x');`],
  ['shadowing', `import {openModal} from '${D}';function f(openModal){openModal(()=>null)}`],
  ['type only', `import type {openModal} from '${D}';openModal(()=>null);`],
  ['TDZ', `import {openModal} from '${D}';function f(){openModal(()=>null);const openModal=other;}`],
  ['namespace mutation', `import * as UI from '${D}';UI.openModal=other;UI.openModal(()=>null);`],
]) test(`negative public identity: ${label}`, () => assert.equal(analyze(source).facts.length, 0));

test('mutated members, escaped aliases and late assignments do not authorize receiver operations', () => {
  const r = analyze(`import {useModal,useToasts} from '${D}';import {AssetsManager} from '${T}/assets';
    const modal=useModal();modal.openModal=other;modal.openModal(()=>null);
    const toasts=useToasts();const alias=toasts;Object.assign(toasts,{showToast:other});alias.showToast({});
    let assets;assets=new AssetsManager();assets.loadTexture('x');`);
  assert(!values(r, 'api').some((v) => v === 'modal-api.openModal' || v === 'toasts-api.showToast' || v === 'assets-manager.loadTexture'));
});

test('inline callback scene provenance is invalidated by assignment, member mutation and unknown escape', () => {
  for (const mutation of ['scene=other', 'scene.add=other', 'mutate(scene)', 'const alias=scene;alias.add=other', 'mutate({scene})', 'const box={scene};mutate(box)', 'const box={scene};const {scene:alias}=box;alias.add=other', 'outside.value=scene', 'mutate(()=>scene)', 'mutate(flag?scene:other)', 'scene[key]()', 'mutate({get value(){return scene}})', 'function give(){return scene};mutate(give)']) {
    const r = analyze(`import {Scene} from '${T}/Canvas'; const V=()=> <Scene setup={({scene})=>{${mutation};scene.add(node)}}/>;`);
    assert(!values(r, 'api').includes('scene.add'), mutation);
  }
});

test('constructor contracts are construction-only and reject mutated or escaped instances', () => {
  for (const source of [
    `const assets=AssetsManager();assets.loadTexture('x');`,
    `const assets=new AssetsManager();assets.loadTexture=other;assets.loadTexture('x');`,
    `const assets=new AssetsManager();const alias=assets;mutate(assets);alias.loadTexture('x');`,
    `const assets=new AssetsManager();assets.unknownMethod();assets.loadTexture('x');`,
    `const assets=new AssetsManager();outside.value=assets;assets.loadTexture('x');`,
    `const assets=new AssetsManager();assets[key]();assets.loadTexture('x');`,
  ]) {
    const r = analyze(`import {AssetsManager} from '${T}/assets';${source}`);
    assert(!values(r, 'api').includes('assets-manager.loadTexture'), source);
  }
  const r = analyze(`import {openModal} from '${D}';const wrong=new openModal(()=>null);wrong();`);
  assert.equal(r.facts.length, 0);
});

test('constructor nested member projection supports animation aliases without arbitrary method matching', () => {
  const r = analyze(`import {GLTFMeshNode} from '${T}/scene';const mesh=new GLTFMeshNode({gltf});const {animation}=mesh;animation.playAnimation('walk');`);
  has(r, 'api', 'animation.playAnimation');
});

test('returning or storing handles does not prove later deferred receiver methods', () => {
  for (const escape of ['return {assets,run}', 'class Box { value=assets };publish(Box)', 'return {get assets(){return assets},run}']) {
    const r = analyze(`import {AssetsManager} from '${T}/assets';function make(){const assets=new AssetsManager();const run=()=>assets.loadTexture('x');${escape}}`);
    assert(!values(r, 'api').includes('assets-manager.loadTexture'), escape);
  }
});

test('named callback parameters retain own evidence but do not prove arbitrary receiver calls', () => {
  const r = analyze(`import {Scene} from '${T}/Canvas';const setup=({scene})=>{scene.add(node)};const V=()=> <Scene setup={setup}/>;setup(other);`);
  has(r, 'callback-binding', 'scene'); assert(!values(r, 'api').includes('scene.add'));
  assert.equal(r.state, 'complete');
});

test('unsupported callback defaults and spread call arguments produce stable partial diagnostics', () => {
  const r = analyze(`import {Scene} from '${T}/Canvas';import {openModal} from '${D}';const V=()=> <Scene setup={({scene}=fallback)=>scene.add(node)}/>;const close=openModal(...args);close();`);
  assert(r.reports[0].diagnostics.some((d) => d.code === 'fst-components.callback-pattern'));
  assert(r.reports[0].diagnostics.some((d) => d.code === 'fst-components.call-shape'));
  assert(!values(r, 'api').includes('scene.add')); assert(!values(r, 'api').includes('modal-close.close'));
});

test('review: assignment patterns taint member roots including nested default and rest targets', () => {
  for (const mutation of [
    '[scene.add]=[other]',
    '({add:scene.add}=replacement)',
    '({scene}=replacement)',
    '([scene=other]=replacement)',
    '[[scene.add=other],...scene.rest]=replacement',
    '({nested:{add:scene.add=other},...scene.rest}=replacement)',
    '([scene["add"]]=replacement)',
    '({[key]:scene.add}=replacement)',
    'const alias=scene;({add:alias.add}=replacement)',
  ]) {
    const source = `import {Scene} from '${T}/Canvas';const V=()=> <Scene setup={({scene})=>{${mutation};scene.add(node)}}/>;`;
    const r = analyze(source);
    assert(!values(r, 'api').includes('scene.add'), mutation);
    assert(!r.facts.some((fact) => text(source, fact) === 'scene.add(node)'), mutation);
    has(r, 'callback-contract', 'Scene.setup');
  }
  const r = analyze(`import {Scene} from '${T}/Canvas';const V=()=> <Scene setup={payload=>{({add:payload.scene.add}=replacement);payload.scene.add(node)}}/>;`);
  assert(!values(r, 'api').includes('scene.add'));
});

test('review: foreign JSX attributes, spreads and children expose inline receiver parameters', () => {
  for (const child of [
    '<Foreign value={scene}/>',
    '<Foreign value={{nested:[scene]}}/>',
    '<Foreign {...{value:scene}}/>',
    '<Foreign>{scene}</Foreign>',
    '<Foreign><>{scene}</></Foreign>',
    '<Foreign value={()=>scene}/>',
    '<Foreign value={(0,scene)}/>',
    '<foreign-element value={scene}/>',
  ]) {
    const source = `import {Scene} from '${T}/Canvas';const V=()=> <Scene setup={({scene})=>{const child=${child};scene.add(node)}}/>;`;
    const r = analyze(source);
    assert(!values(r, 'api').includes('scene.add'), child);
    assert(!r.facts.some((fact) => text(source, fact) === 'scene.add(node)'), child);
  }
});

test('review: sequence, await and type wrappers cannot hide receivers from unknown calls', () => {
  for (const escape of [
    'mutate((0,scene))',
    'mutate(await scene)',
    'mutate((await scene).assets)',
    'mutate((0,scene).assets)',
    'mutate({nested:[await (0,scene)]})',
    'mutate(((0,scene) as unknown)!)',
    'const alias=(0,scene);mutate(alias)',
    'mutate(()=> (0,scene))',
    'tag`${scene}`',
  ]) {
    const source = `import {Scene} from '${T}/Canvas';const V=()=> <Scene setup={async({scene})=>{${escape};scene.add(node)}}/>;`;
    const r = analyze(source);
    assert(!values(r, 'api').includes('scene.add'), escape);
    assert(!r.facts.some((fact) => text(source, fact) === 'scene.add(node)'), escape);
  }
});

test('review: foreign JSX and wrapped escapes invalidate constructor-backed aliases', () => {
  for (const escape of [
    'const child=<Foreign value={assets}/>',
    'const alias=assets;const props={value:alias};const child=<Foreign {...props}/>',
    'const child=<Foreign>{()=>assets}</Foreign>',
    'mutate((0,assets))',
    'mutate(await assets)',
  ]) {
    const source = `import {AssetsManager} from '${T}/assets';async function run(){const assets=new AssetsManager();${escape};assets.loadTexture('x')}`;
    const r = analyze(source);
    assert(!values(r, 'api').includes('assets-manager.loadTexture'), escape);
    assert(!r.facts.some((fact) => text(source, fact) === "assets.loadTexture('x')"), escape);
    has(r, 'api', 'AssetsManager');
  }
});

test('review: tainted patterns and JSX do not suppress independent proven receiver operations', () => {
  const source = `import {Scene} from '${T}/Canvas';const V=()=> <><Scene setup={({scene})=>{[scene.add]=[other];scene.add(node)}}/><Scene setup={({scene:exposed})=>{const child=<Foreign value={exposed}/>;exposed.add(node)}}/><Scene setup={({scene:safe})=>{[unrelated.add]=[other];safe.add(node)}}/></>;`;
  const r = analyze(source);
  assert.deepEqual(facts(r, 'api').filter((fact) => fact.value.value === 'scene.add').map((fact) => text(source, fact)), ['safe.add(node)']);
});

test('review: method functions never inherit their receiver catalogue', () => {
  for (const [setup, invalidCall] of [
    [`import {useModal} from '${D}';const api=useModal();`, 'api.openModal.openModal(()=>null)'],
    [`import {useModal} from '${D}';const api=useModal();const open=api.openModal;`, 'open.openModal(()=>null)'],
    [`import {useToasts} from '${D}';const api=useToasts();`, 'api.showToast.showToast({})'],
    [`import {setupMaterialFogEffect} from '${T}/effects';const fog=setupMaterialFogEffect(scene);`, 'fog.dispose.dispose()'],
    [`import {setupCameraControls} from '${T}/scene';const camera=setupCameraControls(scene);`, 'camera.setCameraDistance.addCameraControlEndListener(()=>{})'],
    [`import {useModal} from '${D}';const api=useModal();`, 'api.openModal.bind(null)(()=>null)'],
  ]) {
    const source = `${setup}${invalidCall};`;
    const r = analyze(source);
    assert(!r.facts.some((fact) => text(source, fact) === invalidCall), invalidCall);
    assert(!values(r, 'result-contract').some((value) => value.includes('ModalClose(reason?)') || value.includes('ToastHandle;')), invalidCall);
  }
});

test('review: direct and captured method requests retain distinct returned handles and toast IDs', () => {
  const r = analyze(`import {useModal,useToasts} from '${D}';import {setupMaterialFogEffect,setupCameraControls} from '${T}';
    const modal=useModal();const open=modal.openModal;const close=open(()=>null);close();modal.openModal(()=>null);
    const toasts=useToasts();const show=toasts.showToast;const toast=show({});const id=toast.id;toasts.dismissToast(id);toast();
    const fog=setupMaterialFogEffect(scene);const dispose=fog.dispose;dispose();
    const camera=setupCameraControls(scene);camera.setCameraDistance(2).setCameraDistance(3);`);
  has(r, 'api', 'modal-api.openModal'); has(r, 'api', 'modal-close.close');
  has(r, 'api', 'toasts-api.showToast'); has(r, 'api', 'toasts-api.dismissToast'); has(r, 'api', 'toast-handle.dismiss');
  has(r, 'result-contract', 'ToastHandle;callable-dismiss;readonly-id');
  has(r, 'api', 'effect.dispose'); has(r, 'result-contract', 'explicit-disposal-request-only');
  has(r, 'qualification', 'captured-method-request;this-binding-and-success-unproven');
  assert.equal(values(r, 'api').filter((value) => value === 'camera.setCameraDistance').length, 2);
});

test('review: C cannot bypass generic constructor proof after a prototype escape', () => {
  for (const [imports, setup, escape] of [
    [`import {AssetsManager} from '${T}/assets';`, 'const assets=new AssetsManager()', 'mutate(AssetsManager.prototype)'],
    [`import {AssetsManager} from '${T}/assets';`, 'const Ctor=AssetsManager;const assets=new Ctor()', 'mutate(AssetsManager.prototype)'],
    [`import * as Three from '${T}/assets';`, 'const assets=new Three.AssetsManager()', 'const proto=Three.AssetsManager.prototype;mutate(proto)'],
  ]) {
    const source = `${imports}${setup};${escape};assets.loadTexture('x');`;
    const r = analyze(source);
    assert(!values(r, 'api').includes('assets-manager.loadTexture'), escape);
  }
  const r = analyze(`import {AssetsManager} from '${T}/assets';const assets=new AssetsManager();const load=assets.loadTexture;mutate(AssetsManager.prototype);load('x');`);
  has(r, 'api', 'assets-manager.loadTexture');
});

test('BOM, CRLF and astral Unicode retain exact opening-element and callback source spans', () => {
  const source = `\uFEFF// \u{1f680}\r\nimport {TextBox} from '${D}';\r\nconst V=()=> <TextBox value="\u{1f642}" onInput={name=>log(name)}/>;`;
  const r = analyze(source);
  has(r, 'literal', 'value=\u{1f642}');
  assert.equal(text(source, facts(r, 'value')[0]), '<TextBox value="\u{1f642}" onInput={name=>log(name)}/>');
  assert.equal(text(source, facts(r, 'callback-binding')[0]), 'name');
});

test('budgets, cancellation, parse errors and oversized references fail boundedly', () => {
  const source = `import {TextBox} from '${D}';const V=()=> <TextBox value={text} onInput={next=>update(next)}/>;`;
  assert.equal(analyze(source, { limits: { maxFacts: 1 } }).state, 'truncated');
  assert.equal(analyze(source, { cancelled: () => true }).state, 'truncated');
  assert.equal(analyze(source + ' const broken=(').facts.length, 0);
  const large = `import {TextBox} from '${D}';const V=()=> <TextBox onInput={()=>{${'const x=0;'.repeat(250)}}}/>;`;
  assert.equal(analyze(large).state, 'complete');
  const r = analyze(large, { viewLimits: { maxValueBytes: 2048 }, limits: { maxValueBytes: 2048 } });
  assert(r.reports[0].diagnostics.some((d) => d.code === 'fst-components.reference-limit'));
});

test('large ordinary const files skip projections, including an irrelevant imported API', () => {
  const plain = Array.from({ length: 200 }, (_, i) => `const v${i}=${i};`).join('');
  for (const source of [plain, `import {TextBox} from '${D}';${plain}`]) {
    const r = analyze(source, { limits: { maxWork: 10000 } });
    assert.equal(r.state, 'complete'); assert.equal(r.reports[0].state, 'not-applicable'); assert.equal(r.facts.length, 0);
  }
  assert.equal(analyze(`${plain}import {loadIconDef} from '${I}';loadIconDef('tb/TbMenu2');`, { limits: { maxWork: 15000 } }).state, 'complete');
});
