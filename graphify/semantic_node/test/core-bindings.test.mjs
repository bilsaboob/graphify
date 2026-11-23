import { loadModule } from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createAnnotationEngine } = await loadModule('src/core/index.ts');
const { canonicalJSON, validateAnnotationResult, validateBindingOperationDescriptor } = await loadModule('src/core/wire.ts');
import { copy, digest, fixture, manifest, sourceSpan } from './core-fixtures.mjs';

function bindingFixture() {
  const source = 'const {x=other,...rest}=input;\n[x]=next;';
  const value = fixture(source), m = manifest();
  const at = (text) => sourceSpan(source, source.indexOf(text), source.indexOf(text)+text.length);
  const expr = (text) => ({kind:'expression',text,span:at(text)});
  value.view.declarations[1].nameSpan=at('x');
  value.view.declarations[1].binding = {source:expr('input'),sourceSpan:at('input'),patternSpan:at('{x=other,...rest}'),value:'unknown',operations:[{kind:'property',span:at('x=other'),key:'x'},{kind:'default',span:at('x=other'),value:expr('other')}]};
  const result = createAnnotationEngine({manifest:m,plugins:[],digest}).analyze(value.document,value.view);
  return {...value,m,result};
}

test('binding descriptors round trip canonically and remain optional', () => {
  const {result,m,document}=bindingFixture();
  assert.equal(result.state,'complete');
  const raw=canonicalJSON(result), decoded=JSON.parse(raw);
  validateAnnotationResult(decoded,m,document.source);
  assert.equal(canonicalJSON(decoded),raw);
  validateBindingOperationDescriptor(decoded.declarations.find(d=>d.key==='a').binding,m,document.source);
  delete decoded.declarations.find(d=>d.key==='a').binding;
  validateAnnotationResult(decoded,m,document.source);
});

test('strict binding validation rejects forged identity, bounds, shapes and source coordinates', () => {
  const changes = [
    b=>{b.complete=true;}, b=>{b.value='known';}, b=>{b.source={kind:'declaration',key:'a'};},
    b=>{b.source.text='wrong';}, b=>{b.sourceSpan.endByte--;}, b=>{b.patternSpan.endByte=1;},
    b=>{b.operations=[];}, b=>{b.operations=Array.from({length:25},()=>b.operations[0]);},
    b=>{b.operations[0].kind='getter-free';}, b=>{b.operations[0].key=null;},
    b=>{b.operations[0].key='x'.repeat(2049);}, b=>{b.operations[0].span=b.sourceSpan;},
    b=>{b.operations[1].value.text='unknown';},
    b=>{b.operations[0]={kind:'iterator',span:b.operations[0].span,index:512};},
    b=>{b.operations[0]={kind:'iterator',span:b.operations[0].span,index:-0};},
    b=>{b.operations[0]={kind:'computed-property',span:b.operations[0].span,key:{kind:'import',module:'lib',name:'key'}};},
    b=>{b.operations[0]={kind:'object-rest',span:b.operations[0].span,excludedKeys:Array(65).fill('x')};},
    b=>{b.operations[0]={kind:'object-rest',span:b.operations[0].span,excludedKeys:[b.source]};},
    b=>{b.shapes=[];}, b=>{b.shapes=Array.from({length:17},()=>({kind:'tuple',span:b.sourceSpan,length:1}));},
    b=>{b.shapes=[{kind:'tuple',span:b.sourceSpan,length:65}];},
    b=>{b.shapes=[{kind:'object',span:b.sourceSpan,keys:['x','x']}];},
    b=>{b.shapes=[{kind:'object',span:b.sourceSpan,keys:Array.from({length:65},(_,i)=>String(i))}];},
  ];
  for(const change of changes) {
    const {result,m,document}=bindingFixture(), b=result.declarations.find(d=>d.key==='a').binding;
    change(b);
    assert.throws(()=>validateAnnotationResult(result,m,document.source),change.toString());
  }
  const {result,m,document}=bindingFixture();
  const declaration=result.declarations.find(d=>d.key==='a');
  for(const field of [{writes:[]},{writes:Array(65).fill(declaration.binding)},{computedName:{kind:'expression',text:'wrong',span:declaration.span}}]) {
    const bad=copy(result); Object.assign(bad.declarations.find(d=>d.key==='a'),field);
    assert.throws(()=>validateAnnotationResult(bad,m,document.source));
  }
});

test('descriptor bytes are charged atomically with declarations, never silently removed', () => {
  const {document,view,result}=bindingFixture();
  const bytes=Buffer.byteLength(canonicalJSON(result));
  const m=manifest([],{maxResultBytes:bytes-1});
  const limited=createAnnotationEngine({manifest:m,plugins:[],digest}).analyze(document,view);
  assert.equal(limited.state,'truncated');
  assert(limited.declarations.every(d=>d.key!=='a'||d.binding?.value==='unknown'));
  validateAnnotationResult(limited,m,document.source);
});
