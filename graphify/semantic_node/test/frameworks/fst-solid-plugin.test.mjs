import { loadModule, parse, hash } from '../helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
const { createFstSolidPlugin } = await loadModule('src/frameworks/fst-solid/index.ts');
const { createAnnotationEngine, ANNOTATION_LIMITS, canonicalJSON, validateAnnotationResult } = await loadModule('src/core/index.ts');

const plugin = createFstSolidPlugin({ implementationDigest: hash('fixture-plugin-code'), configurationDigest: hash('fixture-configuration') });
function analyze(source, options = {}) {
  const language = options.language ?? 'tsx';
  const document = { source, sourceHash: hash(source), relativePath: 'fixture.tsx', language };
  const parsed = parse(source, language);
  let view;
  try { view = createTypeScriptView({ tree: parsed.tree, ...document, ...(options.viewLimits ? { limits: options.viewLimits } : {}) }); }
  finally { parsed.close(); }
  const descriptor = { version: 1, core: {version:'1', implementationDigest:hash('fixture-core')}, view:{id:'typescript', version:1, implementationDigest:hash('fixture-view')}, parserDigest:hash('qualified-parser'), plugins:options.plugins ?? [plugin.descriptor], limits:{...ANNOTATION_LIMITS, ...options.limits} };
  const manifest = { ...descriptor, id:hash(canonicalJSON(descriptor)) };
  const engine = createAnnotationEngine({manifest, plugins:options.plugins ? [] : [plugin], digest:hash});
  const result = engine.analyze(document, view, options.cancelled ? { cancelled: options.cancelled } : undefined);
  validateAnnotationResult(result, manifest, source);
  assert.notEqual(result.state, 'failed', JSON.stringify(result.reports));
  assert(!result.reports.some((report) => report.state === 'failed'), JSON.stringify(result.reports));
  return result;
}
const declaration = (r, name) => r.declarations.find((d) => d.name === name);
const facts = (r, name, term) => r.facts.filter((f) => f.subject === declaration(r,name)?.key && (!term || f.term === `fst-solid.${term}`));
const roleNames = (r, term) => r.facts.filter((f) => f.kind === 'role' && f.term === `fst-solid.${term}`).map((f) => r.declarations.find((d) => d.key === f.subject)?.name);

test('designConcept preserves explicit keys, unqualified strings and dynamic uncertainty as evidence', () => {
  const source = `import {component} from '@fst/components-fst-solid/app/component';
const key = 'game:trading';
export const Trading = component(() => null, {designConcept:key});
export const Label = component(() => null, {designConcept:'Trading'});
export const Dynamic = component(() => null, {designConcept:unknownValue});`;
  const result = analyze(source);
  const qualified = facts(result, 'Trading', 'design-concept')[0];
  assert.equal(qualified.value.value, 'game:trading');
  assert.equal(qualified.resolution, 'constant');
  assert.equal(qualified.evidence.pluginId, 'fst-solid');
  assert(Buffer.from(source).subarray(qualified.evidence.span.startByte, qualified.evidence.span.endByte).toString().includes('designConcept'));
  assert.equal(facts(result, 'Label', 'design-concept')[0].value.value, 'Trading');
  assert.equal(facts(result, 'Dynamic', 'design-concept')[0].resolution, 'expression');
  assert.equal('conceptId' in qualified, false);
});

test('curated first slice covers separate roles, shared renderers, members and exact facts', async () => {
  const source = await readFile(new URL('./fixtures/first-slice.tsx', import.meta.url), 'utf8');
  const r = analyze(source);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  assert.deepEqual(roleNames(r, 'state'), ['EditorState']);
  assert.deepEqual(roleNames(r, 'form'), ['EditorForm']);
  assert.deepEqual(roleNames(r, 'scope'), ['RowScope']);
  assert.deepEqual(roleNames(r, 'item-scope'), ['RowItem']);
  assert.equal(roleNames(r, 'component').length, 4);
  for (const name of ['caption','title','standalone']) assert(roleNames(r, 'field').includes(name), name);
  const renderer = declaration(r,'renderCheckbox').key;
  for (const name of ['Checkbox','OtherCheckbox']) assert(facts(r,name,'implemented-by').some((f) => f.target.key === renderer));
  assert.equal(facts(r,'GroupedList','implemented-by')[0].target.kind, 'expression');
  assert.equal(facts(r,'Checkbox','name')[0].value.value, 'Checkbox');
  assert.equal(facts(r,'Checkbox','design-name')[0].value.value, 'controls/check');
  assert.equal(facts(r,'Checkbox','design-concept')[0].value.value, 'selection');
  assert(facts(r,'Props','field-type').length === 0); // Property declaration owns its type reference.
  assert(facts(r,'field','field-type').some((f) => f.target.name === 'InputField'));
  assert(facts(r,'binding','ownership').some((f) => f.value.value === 'borrowed-no-disposal'));
  assert(facts(r,'setup','observation-phase').some((f) => f.value.value === 'pre-commit'));
  assert(facts(r,'setup','observation-phase').some((f) => f.value.value === 'post-commit'));
  assert(facts(r,'setup','field-operation').some((f) => f.value.value === 'read'));
  assert(facts(r,'setup','field-operation').some((f) => f.value.value === 'write-request'));
  assert.equal(facts(r,'setup','observes').length, 2);
  assert(facts(r,'setup','registration-kind').some((f) => f.value.value === 'solid.content-or-effect-cleanup'));
  assert(facts(r,'setup','registration-kind').some((f) => f.value.value === 'fst.wrapper-cleanup'));
  assert(facts(r,'state','lookup-policy').length === 0);
  assert(facts(r,'scope','lookup-policy').some((f) => f.value.value === 'scoped-only'));
  assert(facts(r,'form','lookup-policy').some((f) => f.value.value === 'scoped-with-global-fallback'));
  assert(facts(r,'raw','instance-kind').some((f) => f.value.value === 'raw-constructor'));
});

test('namespace and immutable factory aliases are recognized without runtime imports', () => {
  const r = analyze(`import * as F from '@fst/components-fst-solid/app/component'; const make=F.component; const render=()=>null; export const C=make(render);`);
  assert.deepEqual(roleNames(r,'component'), ['C']);
  assert.equal(facts(r,'C','factory')[0].target.name,'component');
});

for (const [name, source] of [
  ['wrong module', `import {component} from 'other'; const C=component(()=>null);`],
  ['package root', `import {component} from '@fst/components-fst-solid'; const C=component(()=>null);`],
  ['local lookalike', `const component=(x)=>x; const C=component(()=>null);`],
  ['type-only', `import type {component} from '@fst/components-fst-solid/app/component'; const C=component(()=>null);`],
  ['parameter shadow', `import {component} from '@fst/components-fst-solid/app/component'; function f(component) { const C=component(()=>null); }`],
  ['TDZ shadow', `import {component} from '@fst/components-fst-solid/app/component'; { const C=component(()=>null); const component=other; }`],
  ['var hoist', `import {component} from '@fst/components-fst-solid/app/component'; function f() { const C=component(()=>null); var component=other; }`],
  ['function hoist', `import {component} from '@fst/components-fst-solid/app/component'; function f() { const C=component(()=>null); function component() {} }`],
  ['loop shadow', `import {component} from '@fst/components-fst-solid/app/component'; for(const component of factories) { const C=component(()=>null); }`],
  ['mutable alias', `import {component} from '@fst/components-fst-solid/app/component'; let make=component; make=other; const C=make(()=>null);`],
  ['namespace mutation', `import * as F from '@fst/components-fst-solid/app/component'; F.component=other; const C=F.component(()=>null);`],
  ['namespace alias mutation', `import * as F from '@fst/components-fst-solid/app/component'; const alias=F; alias.component=other; const C=F.component(()=>null);`],
  ['prototype module spelling', `import {component} from '__proto__'; const C=component(()=>null);`],
  ['nested factory', `import {component} from '@fst/components-fst-solid/app/component'; const create=()=>component(()=>null); const C=create();`],
]) test(`negative factory: ${name}`, () => assert.equal(roleNames(analyze(source),'component').length,0));

test('assertions, default exports, named generic functions and properties are distinct', () => {
  const r = analyze(`import {component} from '@fst/components-fst-solid/app/component';
    function render<T>(p:T) { return null; }
    export const A=(component(render,{name:'a'}) as Factory);
    class Holder { page = component(render, {name:'member'}); }
    export default component((() => null) as Renderer, {name:'default'});`);
  assert.equal(roleNames(r,'component').length,3);
  assert(facts(r,'page','implemented-by').some((f) => f.target.key === declaration(r,'render').key));
  assert(r.declarations.some((d) => d.exports.includes('default')));
});

test('safe metadata folding is literal/constant and override aware', () => {
  const r = analyze(`import {component} from '@fst/components-fst-solid/app/component';
    const suffix='nav'; const defaults={ name:'old', designName:'design' };
    const options={ ...defaults,name:\`workspace-\${suffix}\`,designConcept:'concept' };
    export const C=component(()=>null,options);`);
  assert.equal(facts(r,'C','name')[0].value.value,'workspace-nav');
  assert.equal(facts(r,'C','name')[0].resolution,'constant');
  assert.equal(facts(r,'C','design-name')[0].value.value,'design');
});

for (const [name, options] of [
  ['unknown spread','{name:"before",...dynamic}'],
  ['getter','{get name(){throw new Error("must not run")}}'],
  ['computed','{[key]:"value"}'],
  ['call','{name:execute()}'],
  ['non-string','{name:123}'],
]) test(`unresolved options: ${name}`, () => {
  const r = analyze(`import {component} from '@fst/components-fst-solid/app/component'; const C=component(()=>null,${options});`);
  assert.equal(r.reports[0].state,'partial');
  assert.equal(facts(r,'C','name')[0].resolution,'expression');
  assert.equal(facts(r,'C','name')[0].value,undefined);
});

test('explicit properties after unknown spread remain known; mutation/escape does not fold', () => {
  const r = analyze(`import {component} from '@fst/components-fst-solid/app/component';
    const options={name:'before'}; options.name=unknown;
    const A=component(()=>null,options); const B=component(()=>null,{...dynamic,name:'after'});`);
  assert.equal(facts(r,'A','name')[0].resolution,'expression');
  assert.equal(facts(r,'B','name')[0].value.value,'after');
});

test('family APIs and static overrides prevent unjustified lifetime facts', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state';
    import {Form} from '@fst/components-fst-solid/app/form'; import {Scope,ItemScope} from '@fst/components-fst-solid/app/scope';
    import {ApplicationState} from './application';
    class S extends State<S> { static newScoped(){return null} }
    class F extends Form<F,{}> {} class Sc extends Scope<Sc,{}> {} class I extends ItemScope<{}> {}
    const a=S.newScoped(); const b=F.useOrNull(); const c=Sc.useGlobal(); const d=I.useOrNewScoped(); const e=ApplicationState.newScoped();
    const valid=Sc.newScoped();`);
  for(const name of ['a','b','c','d','e']) assert.equal(facts(r,name,'lifetime-operation').length,0,name);
  assert.equal(facts(r,'valid','lifetime-operation')[0].value.value,'create-scoped');
  assert.equal(r.reports[0].state,'partial');
});

test('Form/Scope are not barrel exports and inherited application bases are unresolved', () => {
  const r = analyze(`import {Form,Scope} from '@fst/components-fst-solid/app'; import {ApplicationState} from './application';
    class A extends Form<A,{}> {} class B extends Scope<B,{}> {} class C extends ApplicationState {}`);
  for (const term of ['state','form','scope','item-scope']) assert.equal(roleNames(r,term).length,0);
  assert.equal(r.reports[0].state,'partial');
});

test('two form instances with equal path retain distinct origins', () => {
  const r = analyze(`import {Form} from '@fst/components-fst-solid/app/form'; class F extends Form<F,{}> {}
    const one=F.new(); const two=F.new(); const first=one.field('title'); const second=two.field('title');`);
  assert.equal(facts(r,'first','field-path')[0].value.value,'title');
  assert.equal(facts(r,'second','field-path')[0].value.value,'title');
  assert.equal(facts(r,'first','form-origin')[0].target.key,declaration(r,'one').key);
  assert.equal(facts(r,'second','form-origin')[0].target.key,declaration(r,'two').key);
});

test('type references are not Field construction and unknown call arity is not write', () => {
  const r = analyze(`import {field,type Field} from '@fst/components-fst-solid/app/field';
    const typed:Field<string>=external; const actual=field(''); actual(undefined); actual(dynamic);`);
  assert(!roleNames(r,'field').includes('typed'));
  assert(facts(r,'typed','field-type').some((f) => f.target.kind === 'import'));
  const operations=r.facts.filter((f) => f.term==='fst-solid.field-operation');
  assert(operations.some((f) => f.value?.value==='read'));
  assert(operations.some((f) => f.value?.value==='conditional-read-or-write-request'));
  assert(r.facts.some(f => f.term === 'fst-solid.field-argument' && f.target.text === 'dynamic'));
  assert(!operations.some((f) => f.value?.value==='write-request'));
});

test('State.init is configuration; Form.init is a declared lifecycle hook', () => {
  const r = analyze(`import {State} from '@fst/components-fst-solid/app/state'; import {Form} from '@fst/components-fst-solid/app/form';
    class S extends State<S> {} class F extends Form<F,{}> { init(){} }
    function setup(){ const state=S.new(); state.init(()=>{}); }`);
  assert(facts(r,'init','hook-kind').some((f) => f.value.value==='form.init'));
  assert(facts(r,'setup','registration-kind').some((f) => f.value.value==='state.init-configuration'));
});

test('module owns bare callsites and large expression references fail partial, not invalid', () => {
  const source = `import {component,onComponentCleanup} from '@fst/components-fst-solid/app/component'; onComponentCleanup(()=>{});
    const C=component(()=>{ ${'const x=0;'.repeat(250)} return null; });`;
  const ordinary = analyze(source);
  assert.equal(ordinary.state, 'complete');
  assert.equal(facts(ordinary, 'C', 'implemented-by').length, 1);
  const r = analyze(source, { viewLimits: { maxValueBytes: 2048 }, limits: { maxValueBytes: 2048 } });
  assert(r.declarations.some((d) => d.kind==='module'));
  assert(r.reports[0].diagnostics.some((d) => d.code==='fst-solid.reference-limit'));
  assert.equal(r.reports[0].state,'partial');
});

test('BOM CRLF and astral text retain exact wire evidence', () => {
  const source='\uFEFF// \u{1f680}\r\nimport {component} from "@fst/components-fst-solid/app/component";\r\nexport const C=component(()=> <div>\u{1f642}</div>,{name:"\u{1f642}"});\r\n';
  const r=analyze(source);
  assert.equal(facts(r,'C','name')[0].value.value,'\u{1f642}');
  const ref=facts(r,'C','implemented-by')[0].target;
  assert.equal(Buffer.from(source).subarray(ref.span.startByte,ref.span.endByte).toString('utf8'),ref.text);
});

test('parse errors suppress facts, budgets cancel/truncate safely, empty engine is generic', () => {
  const source=`import {component} from '@fst/components-fst-solid/app/component'; const C=component(()=>null);`;
  assert.equal(analyze(source+' const broken = (').facts.length,0);
  assert.equal(analyze(source,{limits:{maxFacts:1}}).state,'truncated');
  assert.equal(analyze(source,{cancelled:()=>true}).state,'truncated');
  assert.equal(analyze(source,{plugins:[]}).facts.length,0);
});

test('AST depth above 64 traverses the core facade; beyond 128 is honest truncation', () => {
  const source=`import {component} from '@fst/components-fst-solid/app/component'; const C=${'('.repeat(35)}component(()=>null)${')'.repeat(35)};`;
  assert.equal(analyze(source).reports[0].state,'complete');
  assert.equal(analyze(`const a=${'('.repeat(70)}1${')'.repeat(70)};`).state, 'complete');
  const deep=`const a=${'('.repeat(140)}1${')'.repeat(140)};`;
  assert.equal(analyze(deep).state,'truncated');
});

test('plugin digests must be build supplied, descriptor is typed and namespaced', () => {
  assert.throws(()=>createFstSolidPlugin({implementationDigest:'fake',configurationDigest:'fake'}));
  assert.equal(plugin.descriptor.id,'fst-solid');
  assert.equal(plugin.descriptor.version,'1');
  for(const terms of [plugin.descriptor.roles,plugin.descriptor.properties,plugin.descriptor.relations]) for(const term of terms) assert(term.id.startsWith('fst-solid.'));
});

test('named inline renderer has its own declaration and typed renderer supplies props reference', () => {
  const r=analyze(`import {component} from '@fst/components-fst-solid/app/component';
    type Props={label:string}; const C=component(function render(props:Props){return null});`);
  assert.equal(facts(r,'C','implemented-by')[0].target.key,declaration(r,'render').key);
  assert.equal(facts(r,'C','props-type')[0].target.key,declaration(r,'Props').key);
});

test('Field chains and immutable aliases preserve original paths without out-of-subject evidence', () => {
  const r=analyze(`import {Form} from '@fst/components-fst-solid/app/form'; class F extends Form<F,{}>{}
    const form=F.new(); const first=form.field('path').onSet(()=>{}); const second=first;`);
  for(const name of ['first','second']) {
    assert.equal(facts(r,name,'field-path')[0].value.value,'path');
    assert(facts(r,name,'form-origin').some((f)=>f.target.key===declaration(r,'form').key));
  }
  assert.equal(facts(r,'second','field-path')[0].resolution,'constant');
});

for (const [name, member, mutation] of [
  ['quoted',"static 'newScoped'(){}",''],
  ['computed','static [method](){}',''],
  ['static block','static { this.newScoped = other; }',''],
  ['property','static newScoped=other',''],
  ['external computed','','S[method]=other;'],
]) test(`static override blocks inherited claim: ${name}`, () => {
  const r=analyze(`import {State} from '@fst/components-fst-solid/app/state'; class S extends State<S>{${member}} ${mutation} const value=S.newScoped();`);
  assert.equal(facts(r,'value','lifetime-operation').length,0);
  assert.equal(r.reports[0].state,'partial');
});

test('dynamic paths retain exact expression and type-only Field construction is unsupported', () => {
  const r=analyze(`import {Form} from '@fst/components-fst-solid/app/form'; import {type Field} from '@fst/components-fst-solid/app/field';
    class F extends Form<F,{}>{} const form=F.new(); const value=form.field(path()); const invalid=new Field();`);
  assert.equal(facts(r,'value','field-path')[0].resolution,'expression');
  assert(facts(r,'value','field-path-expression').some((f)=>f.target.text==='path()'));
  assert(!roleNames(r,'field').includes('invalid'));
  assert(r.reports[0].diagnostics.some((d)=>d.code==='fst-solid.type-construction'));
});

test('method mutation and shadowed undefined do not fabricate Field writes or observers', () => {
  const r=analyze(`import {field} from '@fst/components-fst-solid/app/field';
    const changed=field(''); changed.onSet=unrelated; changed.onSet(()=>{});
    function f(undefined){ const value=field(''); value(undefined); }`);
  assert(!r.facts.some((f)=>f.term==='fst-solid.observation-phase'));
  assert(!r.facts.some((f)=>f.term==='fst-solid.field-operation'&&f.value?.value==='write-request'));
  assert(!r.facts.some((f)=>f.term==='fst-solid.field-operation'&&f.value?.value==='read'));
});

test('wire value, declaration, work and byte ceilings remain reference safe', () => {
  const source=`import {component} from '@fst/components-fst-solid/app/component'; ${Array.from({length:120},(_,i)=>`const C${i}=component(()=>null,{name:'C${i}'});`).join('\n')}`;
  for(const limits of [{maxDeclarations:20},{maxResultBytes:4096},{maxWork:300}]) {
    const r=analyze(source,{limits});
    assert.equal(r.state,'truncated');
    assert(Buffer.byteLength(canonicalJSON(r))<=(limits.maxResultBytes??ANNOTATION_LIMITS.maxResultBytes));
    const keys=new Set(r.declarations.map((d)=>d.key));
    for(const fact of r.facts) { assert(keys.has(fact.subject)); if(fact.target?.kind==='declaration') assert(keys.has(fact.target.key)); }
  }
});

test('unpaired escaped Unicode metadata is unresolved rather than invalid wire output', () => {
  const r=analyze(`import {component} from '@fst/components-fst-solid/app/component'; const C=component(()=>null,{name:'\\ud800'});`);
  assert.equal(facts(r,'C','name')[0].resolution,'expression');
  assert.equal(r.reports[0].state,'partial');
});

test('canonical escaped values and references honor the wire byte bound', () => {
  const r=analyze(`import {component} from '@fst/components-fst-solid/app/component'; const C=component(()=> '${'<'.repeat(50000)}',{name:'${'<'.repeat(50000)}'});`);
  assert.equal(facts(r,'C','name')[0].resolution,'expression');
  assert.equal(facts(r,'C','implemented-by').length,0);
  assert.equal(r.reports[0].state,'partial');
});

test('escaped namespace method names and shadowed aliases retain lexical meaning', () => {
  const r=analyze(`import * as F from '@fst/components-fst-solid/app/component';
    const C=F.\\u0063omponent(()=>null); function f(F){ const Bad=F.\\u0063omponent(()=>null); }`);
  assert.deepEqual(roleNames(r,'component'),['C']);
});

test('TypeScript mode uses the same grammar contract without JSX', () => {
  const r=analyze(`import {State} from '@fst/components-fst-solid/app/state'; export class S extends State<S>{} const value=S.newScoped();`,{language:'typescript'});
  assert.deepEqual(roleNames(r,'state'),['S']);
  assert.equal(facts(r,'value','lifetime-operation')[0].value.value,'create-scoped');
});

test('owned framework sources import only local analytical modules, never analyzed runtimes', async () => {
  for (const [directory, files] of [['typescript',['index.ts','types.ts','values.ts']],['frameworks/fst-solid',['index.ts','vocabulary.ts','core-rules.ts','core-analysis.ts','family-safety.ts','components.ts','components-contracts.ts','components-vocabulary.ts']]]) {
    for (const file of files) {
      const source=await readFile(new URL(`../../src/${directory}/${file}`,import.meta.url),'utf8');
      for(const match of source.matchAll(/^(?:import|export)\b[^\n]*\bfrom\s*['"]([^'"]+)['"]/gm)) assert(match[1].startsWith('./')||['#core','#core/wire','#typescript'].includes(match[1]),match[1]);
      assert(!/\b(?:eval|Function|require|fetch)\s*\(/.test(source));
      assert(!source.includes('ts.sys'));
    }
  }
});

test('subform traversal is explicitly partial rather than guessed field ownership', () => {
  const r=analyze(`import {Form} from '@fst/components-fst-solid/app/form'; class F extends Form<F,{}>{}
    const form=F.new(); const value=form.form('nested').field('name');`);
  assert(!roleNames(r,'field').includes('value'));
  assert(r.reports[0].diagnostics.some((d)=>d.code==='fst-solid.subform-expression'));
  assert.equal(r.reports[0].state,'partial');
});

test('audit: an earlier effect in options cannot publish a stale spread constant', () => {
  for (const setup of [
    "const C=component(()=>null,{ignored:mutate(opts),...opts});",
    "const options={ignored:mutate(opts),...opts}; const C=component(()=>null,options);",
  ]) {
    const r=analyze(`import {component} from '@fst/components-fst-solid/app/component'; const opts={name:'old'}; ${setup}`);
    assert.deepEqual(roleNames(r,'component'),['C']);
    assert.equal(facts(r,'C','name')[0].resolution,'expression');
    assert.equal(facts(r,'C','name')[0].value,undefined);
    assert.equal(r.reports[0].state,'partial');
  }
});

test('audit: static writes through class aliases suppress inherited lifetime facts', () => {
  for (const alias of ['const Alias=S;', 'const First=S; const Alias=(First as typeof S);']) {
    const r=analyze(`import {State} from '@fst/components-fst-solid/app/state'; class S extends State<S>{}
      ${alias} Alias.newScoped=(()=>null) as any; const x=S.newScoped();`);
    assert.deepEqual(roleNames(r,'state'),['S']);
    assert.equal(facts(r,'x','lifetime-operation').length,0);
    assert.equal(facts(r,'x','lifetime-target').length,0);
    assert.equal(r.reports[0].state,'partial');
  }
});

for (const [name, body] of [
  ['static field', "static field=(path:string)=>path; static x=this.field('title');"],
  ['static arrow field', "static field=(path:string)=>path; static run=()=>{const x=this.field('title');};"],
  ['static method', "static field=(path:string)=>path; static run(){const x=this.field('title');}"],
  ['static block', "static field=(path:string)=>path; static {const x=this.field('title');}"],
  ['object method', "run(){const object={field:(path:string)=>path,method(){const x=this.field('title');}};}"],
  ['arrow in object method', "run(){const object={field:(path:string)=>path,method(){const callback=()=>{const x=this.field('title');};}};}"],
  ['ordinary function', "run(){function callback(){const x=this.field('title');}}"],
  ['nested unrelated class', "run(){class Other {field=(path:string)=>path; run(){const x=this.field('title');}}}"],
]) test(`audit: ${name} this is not a Form instance`, () => {
  const r=analyze(`import {Form} from '@fst/components-fst-solid/app/form'; class F extends Form<F,{}>{${body}}`);
  assert.deepEqual(roleNames(r,'form'),['F']);
  assert.equal(roleNames(r,'field').length,0);
  assert(!r.facts.some((fact)=>['fst-solid.field-path','fst-solid.field-path-expression','fst-solid.form-origin'].includes(fact.term)));
  assert(!r.facts.some((fact)=>fact.term==='fst-solid.field-operation'&&fact.value?.value==='access-form-field'));
  assert.equal(r.reports[0].state,'partial');
});

test('audit: lexical arrows keep the enclosing Form instance receiver', () => {
  const r=analyze(`import {Form} from '@fst/components-fst-solid/app/form'; class F extends Form<F,{}>{
    direct=this.field('direct');
    run(){const normal=this.field('normal'); const callback=()=>{const x=this.field('arrow');};
      const object={callback:()=>{const y=this.field('object-arrow');}};}
  }`);
  assert.equal(r.reports[0].state,'complete');
  for (const [name,path] of [['direct','direct'],['normal','normal'],['x','arrow'],['y','object-arrow']]) {
    assert(roleNames(r,'field').includes(name));
    assert.equal(facts(r,name,'field-path')[0].value.value,path);
  }
});

test('audit2: member-object alias mutations leave metadata unresolved, not stale', () => {
  for(const alias of ['box.options','(box.options as Options)',"box['options']"]) {
    const r=analyze(`import {component} from '@fst/components-fst-solid/app/component';
      const box={options:{name:'old'}}; const alias=${alias}; alias.name='new';
      const C=component(()=>null,box.options);`);
    assert.deepEqual(roleNames(r,'component'),['C']);
    assert.equal(facts(r,'C','name')[0].resolution,'expression');
    assert.equal(facts(r,'C','name')[0].value,undefined);
    assert.equal(r.reports[0].state,'partial');
  }
});

test('audit2: class self lifetime calls resolve without admitting outer TDZ or computed names', () => {
  const r=analyze(`import {State} from '@fst/components-fst-solid/app/state';
    const before=S.new(); class S extends State<S>{
      static initial=S.new(); static create(){return S.new();} [S.new()](){}
    } const after=S.new();`);
  assert.deepEqual(roleNames(r,'state'),['S']);
  assert.equal(facts(r,'before','lifetime-operation').length,0);
  for(const name of ['initial','create','after']) {
    assert.equal(facts(r,name,'lifetime-operation')[0].value.value,'create-standalone');
    assert.equal(facts(r,name,'lifetime-target')[0].target.key,declaration(r,'S').key);
  }
  assert.equal(r.facts.filter((fact)=>fact.term==='fst-solid.lifetime-operation').length,3);
});

test('audit2: self binding does not bypass shadowing or declared and aliased static overrides', () => {
  for(const [member,after] of [
    ['static new(){return null;}', ''],
    ['', 'const Alias=S; Alias.new=(()=>null) as any;'],
    ['', 'const Alias=S; Alias[method]=other;'],
  ]) {
    const r=analyze(`import {State} from '@fst/components-fst-solid/app/state';
      class S extends State<S>{${member} static create(){return S.new();}} ${after}`);
    assert.equal(facts(r,'create','lifetime-operation').length,0);
    assert.equal(r.reports[0].state,'partial');
  }
  const shadowed=analyze(`import {State} from '@fst/components-fst-solid/app/state';
    class S extends State<S>{static create(S:unknown){return S.new();}}`);
  assert.equal(facts(shadowed,'create','lifetime-operation').length,0);
});

test('audit2: class-expression self names work without initializing the outer const early', () => {
  const r=analyze(`import {State} from '@fst/components-fst-solid/app/state';
    const Holder=class Inner extends State<Inner>{static early=Holder.new(); static create(){return Inner.new();}};
    const outside=Inner.new();`);
  assert.equal(facts(r,'early','lifetime-operation').length,0);
  assert.equal(facts(r,'outside','lifetime-operation').length,0);
  assert.equal(facts(r,'create','lifetime-operation')[0].value.value,'create-standalone');
});

test('audit2: forbidden metadata controls do not poison other component facts', () => {
  const forbidden=Array.from({length:32},(_,code)=>code).filter((code)=>![9,10,13].includes(code)).concat(127);
  const bad=forbidden.map((code)=>`const Bad${code}=component(()=>null,{name:'bad\\u${code.toString(16).padStart(4,'0')}name'});`).join('\n');
  const r=analyze(`import {component} from '@fst/components-fst-solid/app/component';
    const Good=component(()=>null,{name:'Good'}); ${bad}
    const BadDesign=component(()=>null,{designName:'bad\\0name',designConcept:'bad\\x7fname'});`);
  assert(roleNames(r,'component').includes('Good'));
  assert.equal(facts(r,'Good','name')[0].value.value,'Good');
  for(const code of forbidden) {
    assert.equal(facts(r,`Bad${code}`,'name')[0].resolution,'expression');
    assert.equal(facts(r,`Bad${code}`,'name')[0].value,undefined);
  }
  for(const term of ['design-name','design-concept']) assert.equal(facts(r,'BadDesign',term)[0].resolution,'expression');
  assert.equal(r.reports[0].state,'partial');
});

test('audit2: wire-allowed whitespace and Unicode metadata remain valid', () => {
  const r=analyze(`import {component} from '@fst/components-fst-solid/app/component';
    const Good=component(()=>null,{name:'ok\\t\\n\\r\\u0085\\u2028\\u2029\\u{1f680}',designName:''});`);
  assert.equal(r.reports[0].state,'complete');
  assert.equal(facts(r,'Good','name')[0].value.value,'ok\t\n\r\u0085\u2028\u2029\u{1f680}');
  assert.equal(facts(r,'Good','design-name')[0].value.value,'');
});

test('audit2: forbidden literal field-path controls stay unresolved without losing a good path', () => {
  const r=analyze(`import {Form} from '@fst/components-fst-solid/app/form'; class F extends Form<F,{}>{}
    const form=F.new(); const Good=form.field('title'); const Bad=form.field('bad\\0path');`);
  assert.equal(facts(r,'Good','field-path')[0].value.value,'title');
  assert.equal(facts(r,'Bad','field-path')[0].resolution,'expression');
  assert.equal(r.reports[0].state,'partial');
});

test('onChange callback slots describe change snapshots with exact dependency evidence', () => {
  const source=`import {onChange as watch} from '@fst/components-fst-solid/app/state';
    const first=()=>1, second=()=>2;
    function setup(){watch([first, /* dependency */ second,], ([one, two]) => { one.value; two.oldValue; });}`;
  const r=analyze(source), owner=declaration(r,'setup');
  assert.equal(r.state,'complete');
  const names=facts(r,'setup','change-argument');
  const sources=facts(r,'setup','change-argument-source');
  assert.deepEqual(names.map(f=>f.value.value).sort(),['one','two']);
  for(const [binding,dependency] of [['one','first'],['two','second']]) {
    const name=names.find(f=>f.value.value===binding);
    const edge=sources.find(f=>f.evidence.span.startByte===name.evidence.span.startByte);
    assert.equal(edge.subject,owner.key);
    assert.equal(edge.target.key,declaration(r,dependency).key);
    assert.equal(Buffer.from(source).subarray(edge.evidence.span.startByte,edge.evidence.span.endByte).toString(),binding);
    assert.equal(edge.evidence.basis,'import-bound');
  }
});

test('onChange callback aliases and omitted tuple slots preserve dependency positions', () => {
  const r=analyze(`import * as F from '@fst/components-fst-solid/app/state';
    const first=()=>1, second=()=>2, third=()=>3;
    const callback=([one,,three])=>{}; const alias=callback;
    function setup(){F.onChange([first,second,third],alias);}`);
  assert.equal(r.state,'complete');
  assert.deepEqual(facts(r,'callback','change-argument').map(f=>f.value.value).sort(),['one','three']);
  assert.deepEqual(facts(r,'callback','change-argument-source').map(f=>f.target.key).sort(),[declaration(r,'first').key,declaration(r,'third').key].sort());
});

for(const [name,dependencies,callback] of [
  ['dependency hole','[,second]','([one,two])=>{}'],
  ['dependency spread','[first,...others]','([one,two])=>{}'],
  ['default binding','[first,second]','([one=0,two])=>{}'],
  ['rest binding','[first,second]','([one,...rest])=>{}'],
  ['nested binding','[first,second]','([{value},two])=>{}'],
  ['out of range','[first]','([one,two])=>{}'],
]) test(`onChange does not invent snapshot slots for ${name}`,()=>{
  const r=analyze(`import {onChange} from '@fst/components-fst-solid/app/state';
    const first=()=>1,second=()=>2; function setup(){onChange(${dependencies},${callback});}`);
  assert.equal(facts(r,'setup','change-argument-source').length,0);
  assert.equal(r.state,'partial');
});

test('onChange callback slots require a canonical unshadowed import',()=>{
  for(const setup of [
    "import {onChange} from 'other'; function setup()",
    "import {onChange} from '@fst/components-fst-solid/app/state'; function setup(onChange)",
  ]) {
    const r=analyze(`${setup}{const first=()=>1;onChange([first],([value])=>{});}`);
    assert.equal(facts(r,'setup','change-argument-source').length,0);
  }
});

test('canonical List construction is not an unresolved family lifetime operation', () => {
  const r = analyze(`import {List,State} from '@fst/components-fst-solid/app/state';
    import {List as Foreign} from './other'; class Workspace extends State<Workspace> {
      first=List.new(...firstItems); second=List.new(...secondItems);
    } const other=Foreign.new();`);
  const diagnostic = r.reports[0].diagnostics.find(d => d.code === 'fst-solid.unresolved-lifetime');
  assert(diagnostic);
  assert.equal(diagnostic.span.startLine, 4);
  assert(!r.reports[0].diagnostics.some(d => d.code === 'fst-solid.core-shape'));
  assert.equal(facts(r, 'first', 'lifetime-operation').length, 0);
  const onlyList = analyze(`import {List} from '@fst/components-fst-solid/app/state';
    const one=List.new(...items); const two=List.new(...others);`);
  assert(!onlyList.reports[0].diagnostics.some(d => d.code === 'fst-solid.unresolved-lifetime'));
  assert.equal(onlyList.state, 'complete');
  assert.equal(onlyList.facts.filter(f => f.term === 'fst-solid.list-contribution').length, 2);
});

test('unknown Field inputs retain conditional dispatch and exact argument evidence per call', () => {
  const source = `import {field} from '@fst/components-fst-solid/app/field';
    function use(value,options){const f=field('');f(value,options);f(makeValue());f(value);}`;
  const r = analyze(source);
  const operations = facts(r, 'use', 'field-operation').filter(f => f.value.value === 'conditional-read-or-write-request');
  assert.equal(operations.length, 3);
  assert.equal(r.state, 'complete');
  assert(!facts(r, 'use', 'field-operation').some(f => ['read', 'write-request'].includes(f.value.value)));
  assert.deepEqual(facts(r, 'use', 'field-argument').map(f => f.target.text), ['value', 'makeValue()', 'value']);
  assert.equal(new Set(facts(r, 'use', 'field-argument').map(f => f.target.span.startByte)).size, 3);
  for (const fact of facts(r, 'use', 'field-argument')) {
    assert.equal(Buffer.from(source).subarray(fact.target.span.startByte, fact.target.span.endByte).toString(), fact.target.text);
    assert(operations.some(op => op.evidence.span.startByte === fact.evidence.span.startByte && op.evidence.span.endByte === fact.evidence.span.endByte));
  }
  assert.equal(facts(r, 'use', 'field-write-options')[0].target.text, 'options');
  assert(facts(r, 'use', 'field-dispatch').every(f => f.value.value.includes('argument[0] === undefined: read; otherwise: write request')));
});

test('conditional Field dispatch still requires canonical call identity and explicit positions', () => {
  for (const source of [
    `import {field} from './foreign';const f=field('');f(dynamic);`,
    `import type {Field} from '@fst/components-fst-solid/app/field';declare const f:Field<string>;f(dynamic);`,
    `import {field} from '@fst/components-fst-solid/app/field';function use(field){const f=field('');f(dynamic);}`,
    `import {field} from '@fst/components-fst-solid/app/field';let f=field('');f=other;f(dynamic);`,
    `import {field} from '@fst/components-fst-solid/app/field';const f=field('');f(...values);`,
    `import {field} from '@fst/components-fst-solid/app/field';const f=field('');f?.(dynamic);`,
  ]) {
    const r = analyze(source);
    assert(!r.facts.some(f => f.term === 'fst-solid.field-dispatch'), source);
    assert(!r.facts.some(f => f.term === 'fst-solid.field-operation' && ['read', 'write-request'].includes(f.value?.value)), source);
  }
});

test('local family inheritance retains immediate heritage and concrete lifetime targets', () => {
  const source = `import {Form} from '@fst/components-fst-solid/app/form';
    class ExampleForm extends Form<ExampleForm,{}> {}
    function setup(){class DerivedForm extends ExampleForm {}
      class Leaf extends DerivedForm {} const derived=Leaf.useOrNewScoped();
      const title=derived.field('title'); expect(derived instanceof Leaf);}`;
  const r = analyze(source);
  assert.deepEqual(roleNames(r, 'form'), ['ExampleForm', 'DerivedForm', 'Leaf']);
  assert.equal(facts(r, 'DerivedForm', 'extends')[0].target.key, declaration(r, 'ExampleForm').key);
  assert.equal(facts(r, 'Leaf', 'extends')[0].target.key, declaration(r, 'DerivedForm').key);
  assert.equal(facts(r, 'derived', 'lifetime-target')[0]?.target.key, declaration(r, 'Leaf').key);
  assert.equal(facts(r, 'title', 'field-path')[0]?.value.value, 'title');
  assert(!r.reports[0].diagnostics.some(d => d.code === 'fst-solid.unresolved-base'));
});

for (const [name, member, mutation] of [
  ['ancestor override', 'static newScoped(){return null}', ''],
  ['ancestor computed override', 'static [key](){}', ''],
  ['ancestor static block', 'static { this.newScoped=other; }', ''],
  ['ancestor direct write', '', 'Base.newScoped=other;'],
  ['ancestor alias write', '', 'const alias=Base; alias.newScoped=other;'],
  ['ancestor delete', '', 'delete Base.newScoped;'],
  ['ancestor escape', '', 'escape(Base);'],
  ['canonical base mutation', '', 'Form.newScoped=other;'],
  ['static method writes this', 'static poison(){this.newScoped=other}', 'Base.poison();'],
  ['static field writes this', 'static poison=(this.newScoped=other)', ''],
  ['unknown static method call', '', 'Base.configure();'],
]) test(`local inherited statics reject ${name}`, () => {
  const r = analyze(`import {Form} from '@fst/components-fst-solid/app/form';
    class Base extends Form<Base,{}>{${member}} class Derived extends Base{}
    ${mutation} const value=Derived.newScoped();`);
  assert.equal(facts(r, 'value', 'lifetime-operation').length, 0);
});

for (const [name, member, mutation] of [
  ['method override', 'field(){return other}', ''],
  ['build override', 'build(){return other}', ''],
  ['computed override', '[key](){}', ''],
  ['constructor assignment', 'constructor(){super();this.field=other;}', ''],
  ['field initializer assignment', 'poison=(this.field=other)', ''],
  ['prototype mutation', '', 'Base.prototype.field=other;'],
  ['prototype alias escape', '', 'const proto=Base.prototype; escape(proto);'],
]) test(`local inherited instance APIs reject ancestor ${name}`, () => {
  const r = analyze(`import {Form} from '@fst/components-fst-solid/app/form';
    class Base extends Form<Base,{}>{${member}} class Derived extends Base{}
    ${mutation} const value=Derived.new(); const title=value.field('title');`);
  assert.equal(facts(r, 'title', 'form-origin').length, 0);
  assert(!roleNames(r, 'field').includes('title'));
});

test('local inheritance does not guess imported, type-only, shadowed or unstable bases', () => {
  for (const body of [
    `import {Form} from './foreign'; class Base extends Form{} class Derived extends Base{}`,
    `import type {Form} from '@fst/components-fst-solid/app/form'; class Base extends Form{} class Derived extends Base{}`,
    `import {Form} from '@fst/components-fst-solid/app/form'; function f(Form){class Base extends Form{} class Derived extends Base{}}`,
    `import {Form} from '@fst/components-fst-solid/app/form'; class Base extends Form{} let Alias=Base; class Derived extends Alias{}`,
  ]) {
    const r = analyze(body);
    assert(!roleNames(r, 'form').includes('Derived'), body);
  }
});

test('ordinary nonfamily this reads are not attempted FST receiver operations', () => {
  const r = analyze(`import {Form} from '@fst/components-fst-solid/app/form';
    class Draft extends Form<Draft,{}>{} const form=Draft.new();
    const Native=window.ResizeObserver;window.ResizeObserver=class extends Native {
      targets=new Set();observe(target){this.targets.add(target);active.add(this)}
      disconnect(){this.targets.clear();active.delete(this)}
    };`);
  assert(!r.reports[0].diagnostics.some(d => d.code === 'fst-solid.unresolved-this'));
  assert.equal(facts(r, 'form', 'lifetime-operation').length, 1);
});

test('wide unrelated JSX does not exhaust local family safety before class creation', () => {
  const source = `import {Form} from '@fst/components-fst-solid/app/form';
    import {component} from '@fst/components-fst-solid/app/component';class F extends Form<F,{}>{}
    const View=component(props=>{const form=F.newScoped();return <div>${Array.from({length:180},(_,i)=>`<span>{props.p${i}}</span>`).join('')}</div>});`;
  const r = analyze(source);
  assert.equal(r.state, 'complete', JSON.stringify(r.reports));
  assert.equal(facts(r, 'form', 'lifetime-operation').length, 1);
  const escaped = analyze(source.replace('const form=F.newScoped()', 'escape(F);const form=F.newScoped()'));
  assert.equal(facts(escaped, 'form', 'lifetime-operation').length, 0);
});

test('returned component construction belongs to a factory, not a component or literal metadata', () => {
  const source = `import {component} from '@fst/components-fst-solid/app/component';
    function icon(name:string){return component((props)=>glyph(props,name),{name,designName:\`icons/\${name}\`});}
    const arrow=(name:string)=>component(()=>name,{name});
    const Made=icon('Check');`;
  const r = analyze(source);
  assert.deepEqual(roleNames(r, 'component-factory'), ['icon', 'arrow']);
  assert.equal(roleNames(r, 'component').length, 0);
  for (const name of ['icon', 'arrow']) {
    assert.equal(facts(r, name, 'name').length, 0);
    assert.equal(facts(r, name, 'implemented-by').length, 0);
    assert.equal(facts(r, name, 'returns-component').length, 1);
    assert.equal(facts(r, name, 'returned-renderer').length, 1);
    const options = facts(r, name, 'returned-options')[0];
    assert.equal(options.target.kind, 'expression');
    assert.equal(Buffer.from(source).subarray(options.target.span.startByte, options.target.span.endByte).toString(), options.target.text);
    assert(facts(r, name, 'component-return')[0].value.value.includes('metadata evaluated per invocation'));
  }
  assert.equal(r.state, 'complete');
});

test('construction returns do not conflate asynchronous or anonymous nested factory owners', () => {
  for (const body of [
    `async function make(){return component(()=>null)}`,
    `function* make(){return component(()=>null)}`,
    `const View=component(()=>()=>component(()=>null));`,
    `function make(component){return component(()=>null)}`,
    `let make=component;make=other;function factory(){return make(()=>null)}`,
  ]) {
    const r = analyze(`import {component} from '@fst/components-fst-solid/app/component';${body}`);
    assert.equal(roleNames(r, 'component-factory').length, 0, body);
  }
});
