import { loadModule } from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createAnnotationEngine } = await loadModule('src/core/index.ts');
const { ANNOTATION_LIMITS, canonicalJSON, validateAnnotationManifest, validateAnnotationResult } = await loadModule('src/core/wire.ts');
import { copy, descriptor, digest, fixture, manifest, rolePlugin, sourceSpan } from './core-fixtures.mjs';

function analyze(plugins = [], limits = {}, input = fixture(), cancelled) {
  const contract = manifest(plugins, limits);
  const engine = createAnnotationEngine({ manifest: contract, plugins, digest });
  const result = engine.analyze(input.document, input.view, cancelled ? { cancelled } : undefined);
  validateAnnotationResult(result, contract, input.document.source);
  return { result, contract, engine };
}

test('canonical JSON sorts ASCII keys and matches Go HTML/Unicode escaping', () => {
  const value = { z: '<>&\u2028\u2029', a: [0, true, null, '\u{1f600}', '\b\f\n\r\t'] };
  const encoded = '{"a":[0,true,null,"\u{1f600}","\\b\\f\\n\\r\\t"],"z":"\\u003c\\u003e\\u0026\\u2028\\u2029"}';
  assert.equal(canonicalJSON(value), encoded);
  assert.equal(digest(canonicalJSON(value)), digest(encoded));
  assert.equal(canonicalJSON({ '2': 2, '10': 10, a: 1 }), '{"10":10,"2":2,"a":1}');
  assert.equal(canonicalJSON({ a: Number.MAX_SAFE_INTEGER, b: Number.MIN_SAFE_INTEGER }), '{"a":9007199254740991,"b":-9007199254740991}');
});

test('canonical JSON rejects ambiguous or executable data without calling accessors', () => {
  let called = false;
  const accessor = { get a() { called = true; return 1; } };
  const circular = {}; circular.self = circular;
  const sparse = []; sparse.length = 1;
  const symbol = { [Symbol('hidden')]: 1 };
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const arrayProperty = []; arrayProperty.extra = true;
  for (const value of [undefined, -0, 0.5, Infinity, NaN, 2 ** 53, 1n, '\ud800', '\udc00', { '\u00e9': 1 }, new Date(), new Map(), () => {}, accessor, circular, sparse, symbol, hidden, arrayProperty, { a: undefined }]) {
    assert.throws(() => canonicalJSON(value));
  }
  assert.equal(called, false);
  const shared = { a: 1 };
  assert.equal(canonicalJSON([shared, shared]), '[{"a":1},{"a":1}]');
});

test('manifest identity is exactly SHA256 of canonical content excluding id', () => {
  const value = manifest([descriptor()]);
  validateAnnotationManifest(value, digest);
  validateAnnotationManifest(value);
  const changed = copy(value); changed.core.version = '2.0.0';
  assert.throws(() => validateAnnotationManifest(changed, digest), /identity/);
  assert.throws(() => validateAnnotationManifest(value, () => 'wrong'), /digest/);
});

test('generic core and view configuration digests are optional but hash-validated and manifest-bound', () => {
  const original = manifest();
  validateAnnotationManifest(original, digest);
  for (const section of ['core', 'view']) {
    const configured = copy(original);
    configured[section].configurationDigest = digest('declared configuration');
    assert.throws(() => validateAnnotationManifest(configured, digest), /identity/);
    const { id, ...body } = configured;
    configured.id = digest(canonicalJSON(body));
    validateAnnotationManifest(configured, digest);
    const input = fixture();
    const result = createAnnotationEngine({ manifest: configured, plugins: [], digest }).analyze(input.document, input.view);
    assert.equal(result.analysisSetId, configured.id);
    assert.notEqual(result.analysisSetId, original.id);
    for (const invalid of [null, false, 1, {}, 'abc', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      const changed = copy(configured);
      changed[section].configurationDigest = invalid;
      assert.throws(() => validateAnnotationManifest(changed), `${section}: ${JSON.stringify(invalid)}`);
    }
  }
});

test('manifest rejects unknown keys, types, contracts, duplicate terms and foreign namespaces', () => {
  const changes = [
    m => { m.unknown = true; }, m => { m.version = 2; }, m => { m.core.extra = true; },
    m => { m.plugins[0].view.version = 2; }, m => { m.plugins.push(copy(m.plugins[0])); },
    m => { m.plugins[0].roles[0].id = 'other.role'; }, m => { m.plugins[0].id = 'core'; },
    m => { m.plugins[0].properties[0].id = m.plugins[0].roles[0].id; },
    m => { m.plugins[0].properties[0].multiple = 'false'; }, m => { m.plugins[0].properties[0].valueKind = 'object'; },
    m => { m.plugins[0].languages.push('fixture'); }, m => { m.plugins[0].languages = []; },
    m => { m.plugins[0].implementationDigest = 'a'.repeat(63); }, m => { m.view.version = -0; },
    m => { m.plugins[0].roles[0].label = '\udfff'; }, m => { m.plugins[0].roles[0].handler = 'script'; },
  ];
  for (const change of changes) {
    const value = manifest([descriptor()]); change(value);
    assert.throws(() => validateAnnotationManifest(value), change.toString());
  }
});

test('all manifest limits are positive safe integers bounded by frozen hard ceilings', () => {
  for (const [key, maximum] of Object.entries(ANNOTATION_LIMITS)) {
    for (const value of [0, -1, -0, maximum + 1, 1.5, '1', null]) {
      const data = manifest(); data.limits[key] = value;
      assert.throws(() => validateAnnotationManifest(data), `${key}:${value}`);
    }
  }
  assert.throws(() => validateAnnotationManifest(manifest([], { maxManifestBytes: 1 })));
});

test('empty registry is a complete independent declaration consumer', () => {
  const { result, contract } = analyze();
  assert.equal(result.state, 'complete');
  assert.equal(result.declarations.length, 3);
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.reports, []);
  validateAnnotationResult(result, contract); // Browser read-only validation has no source I/O.
});

test('two unrelated plugins have deterministic registry-order independent output', () => {
  const first = rolePlugin('exports');
  const second = rolePlugin('documentation');
  const contract = manifest([first, second]);
  const input = fixture();
  const a = createAnnotationEngine({ manifest: contract, plugins: [first, second], digest }).analyze(input.document, input.view);
  const b = createAnnotationEngine({ manifest: contract, plugins: [second, first], digest }).analyze(input.document, input.view);
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  assert.equal(a.facts.length, 4);
  assert.deepEqual(a.reports.map(report => report.pluginId), ['documentation', 'exports']);
  assert.equal(a.state, 'complete');
});

test('second consumer renders only descriptor labels and generic facts', () => {
  const { result, contract } = analyze([rolePlugin('catalogue')]);
  const labels = new Map(contract.plugins.flatMap(plugin => plugin.roles.map(term => [term.id, term.label])));
  const projected = result.declarations.map(declaration => ({
    name: declaration.name ?? declaration.kind,
    roles: result.facts.filter(fact => fact.subject === declaration.key && fact.kind === 'role').map(fact => labels.get(fact.term)),
  }));
  assert.deepEqual(projected, [{ name: 'alpha', roles: ['Exported'] }, { name: 'beta', roles: ['Exported'] }, { name: 'module', roles: [] }]);
});

test('registry requires the exact reviewed descriptor and every selected plugin', () => {
  const plugin = rolePlugin(); const contract = manifest([plugin]);
  assert.throws(() => createAnnotationEngine({ manifest: contract, plugins: [], digest }));
  assert.throws(() => createAnnotationEngine({ manifest: contract, plugins: [rolePlugin('other')], digest }));
  plugin.descriptor.roles[0].label = 'Changed';
  assert.throws(() => createAnnotationEngine({ manifest: contract, plugins: [plugin], digest }));
});

test('unsupported parse cannot emit verified facts; unsupported language is not applicable', () => {
  const input = fixture(); input.view.state = 'unsupported';
  const plugin = rolePlugin();
  plugin.analyze = () => { throw new Error('must not execute'); };
  const { result } = analyze([plugin], {}, input);
  assert.equal(result.state, 'unsupported'); assert.equal(result.reports[0].state, 'unsupported');
  assert.deepEqual(result.facts, []);
  plugin.descriptor.languages = ['another'];
  const absent = analyze([plugin]).result;
  assert.equal(absent.state, 'complete'); assert.equal(absent.reports[0].state, 'not-applicable');
});

test('ordinary throws discard only that plugin buffer with sanitized failure', () => {
  const failing = rolePlugin('a-failing');
  failing.analyze = ({ view }, emitter) => {
    emitter.role('a', 'a-failing.exported', { ruleId: 'one', basis: 'syntax', span: view.declarations[0].span });
    throw new Error('private source: credential should not escape');
  };
  const { result } = analyze([failing, rolePlugin('b-working')]);
  assert.equal(result.state, 'partial'); assert.equal(result.declarations.length, 3);
  assert.equal(result.facts.length, 2); assert.equal(result.reports[0].state, 'failed');
  assert.doesNotMatch(canonicalJSON(result), /credential|private source/);
});

test('unknown subjects, targets, properties, value types and forged provenance fail a whole plugin', () => {
  const input = fixture();
  const badEmissions = [
    e => e.role('unknown', 'sample.exported', input.evidence),
    e => e.role('a', 'foreign.exported', input.evidence),
    e => e.role('a', 'sample.exported', { ...input.evidence, pluginId: 'other' }),
    e => e.role('a', 'sample.exported', { ...input.evidence, arbitrary: true }),
    e => e.relation('a', 'sample.uses', { kind: 'declaration', key: 'missing' }, input.evidence),
    e => e.property('a', 'sample.label', 'literal', { kind: 'integer', value: 1 }, input.evidence),
    e => e.property('a', 'sample.label', 'expression', { kind: 'string', value: 'guess' }, input.evidence),
    e => e.property('a', 'sample.label', 'literal', undefined, input.evidence),
    e => e.property('a', 'sample.count', 'literal', { kind: 'integer', value: -0 }, input.evidence),
    e => e.role('a', 'sample.exported', { ...input.evidence, span: input.view.declarations[2].span }),
  ];
  for (const bad of badEmissions) {
    const plugin = rolePlugin();
    plugin.analyze = (_, emitter) => {
      assert.equal(emitter.role('a', 'sample.exported', input.evidence), true);
      assert.equal(bad(emitter), false);
    };
    const { result } = analyze([plugin], {}, input);
    assert.equal(result.reports[0].state, 'failed', bad.toString()); assert.deepEqual(result.facts, []);
  }
});

test('all value kinds and explicit uncertainty remain closed and typed', () => {
  const input = fixture(); const plugin = rolePlugin();
  plugin.analyze = (_, e) => {
    e.property('a', 'sample.label', 'literal', { kind: 'string', value: '<label>' }, input.evidence);
    e.property('a', 'sample.enabled', 'constant', { kind: 'boolean', value: false }, input.evidence);
    e.property('a', 'sample.count', 'literal', { kind: 'integer', value: 7 }, input.evidence);
    e.property('a', 'sample.origin', 'constant', { kind: 'reference', value: { kind: 'import', module: 'package', name: 'original', member: 'member' } }, input.evidence);
    e.property('b', 'sample.label', 'expression', undefined, { ...input.evidence, span: input.view.declarations[2].span });
    e.property('b', 'sample.count', 'absent', undefined, { ...input.evidence, span: input.view.declarations[2].span });
  };
  const { result } = analyze([plugin], {}, input);
  assert.equal(result.facts.length, 6); assert.equal(result.state, 'complete');
});

test('emitter copies aliases and attributes provenance without exposing mutable results', () => {
  const input = fixture(); const plugin = rolePlugin();
  const evidence = copy(input.evidence); const value = { kind: 'string', value: 'first' };
  let retainedEmitter;
  plugin.analyze = (_, emitter) => {
    retainedEmitter = emitter;
    emitter.property('a', 'sample.label', 'literal', value, evidence);
    value.value = 'changed'; evidence.ruleId = 'changed'; evidence.span.startByte = 123;
  };
  const { result } = analyze([plugin], {}, input);
  assert.equal(result.facts[0].value.value, 'first'); assert.equal(result.facts[0].evidence.ruleId, 'export-rule');
  assert.equal(result.facts[0].evidence.pluginId, 'sample');
  assert.equal(retainedEmitter.role('a', 'sample.exported', input.evidence), false);
});

test('dedupe is exact; conflicting single-valued properties never overwrite', () => {
  const input = fixture(); const plugin = rolePlugin();
  plugin.analyze = (_, e) => {
    e.role('a', 'sample.exported', input.evidence); e.role('a', 'sample.exported', input.evidence);
  };
  assert.equal(analyze([plugin], {}, input).result.facts.length, 1);
  plugin.analyze = (_, e) => {
    e.property('a', 'sample.label', 'literal', { kind: 'string', value: 'first' }, input.evidence);
    e.property('a', 'sample.label', 'literal', { kind: 'string', value: 'second' }, input.evidence);
  };
  const { result } = analyze([plugin], {}, input);
  assert.equal(result.reports[0].state, 'failed'); assert.equal(result.facts.length, 0);
});

test('declarations, spans, exports, extension data and method results are immutable across plugins', () => {
  const input = fixture();
  input.view.extra = { array: [{ value: 1 }] };
  const methodResult = { span: copy(input.evidence.span) };
  input.view.lookup = () => methodResult;
  const attacking = rolePlugin('a-mutating');
  attacking.analyze = ({ document, view }) => {
    assert.throws(() => { document.source = 'changed'; });
    assert.throws(() => { view.declarations[0].span.endByte = 1; });
    assert.throws(() => { view.declarations[0].exports.push('extra'); });
    assert.throws(() => { view.declarations.push({}); });
    assert.throws(() => { view.extra.array[0].value = 2; });
    assert.throws(() => { view.lookup().span.startByte = 9; });
    assert.throws(() => { view.lookup.extra = 'mutated method'; });
    throw new Error('mutation failed');
  };
  const checking = rolePlugin('b-checking');
  const originalAnalyze = checking.analyze;
  checking.analyze = (context, emitter) => {
    assert.equal(context.view.lookup().span.startByte, 0);
    assert.equal(context.view.extra.array[0].value, 1);
    originalAnalyze(context, emitter);
  };
  const { result } = analyze([attacking, checking], {}, input);
  assert.equal(result.facts.length, 2); assert.equal(result.state, 'partial');
  assert.equal(input.view.extra.array[0].value, 1); assert.equal(methodResult.span.startByte, 0);
});

test('fact, declaration, byte, work, depth and diagnostic caps are explicit and reference-safe', () => {
  const plugin = rolePlugin();
  assert.equal(analyze([plugin], { maxFacts: 1 }).result.state, 'truncated');
  const limited = analyze([plugin], { maxDeclarations: 2 }).result;
  assert.equal(limited.declarations.length, 2); assert.ok(limited.declarations.some(d => d.key === 'root'));
  assert.equal(limited.state, 'truncated');
  const work = analyze([plugin], { maxWork: 1 }).result;
  assert.equal(work.state, 'truncated'); assert.equal(work.reports[0].state, 'truncated');
  const depth = analyze([plugin], { maxDepth: 1 }).result;
  assert.equal(depth.state, 'truncated'); assert.deepEqual(depth.declarations.map(d => d.key), ['root']);
  const bytes = analyze([plugin], { maxResultBytes: 850 }).result;
  assert.equal(bytes.state, 'truncated'); assert.ok(Buffer.byteLength(canonicalJSON(bytes)) <= 850);
  plugin.analyze = () => ({ diagnostics: Array.from({ length: 40 }, (_, index) => ({ code: `code-${index}`, message: 'bounded' })) });
  const diagnostic = analyze([plugin], { maxDiagnostics: 2 }).result;
  assert.equal(diagnostic.state, 'truncated'); assert.equal(diagnostic.reports[0].diagnostics.length, 2);
});

test('plugin cooperative depth and work stops preserve a valid partial buffer', () => {
  const input = fixture(); const plugin = rolePlugin();
  let counters;
  plugin.analyze = ({ budget }, emitter) => {
    emitter.role('a', 'sample.exported', input.evidence);
    counters = budget;
    budget.depth(ANNOTATION_LIMITS.maxDepth + 1);
  };
  const { result } = analyze([plugin], {}, input);
  assert.equal(result.reports[0].state, 'truncated'); assert.equal(result.facts.length, 1);
  assert.ok(counters.consumedWork > 0); assert.equal(counters.consumedDepth, 0);
  assert.throws(() => { counters.consumedWork = 0; });
});

test('cancellation is cooperative, sticky, explicit, and never a failed absence', () => {
  let checks = 0;
  const { result } = analyze([rolePlugin()], {}, fixture(), () => ++checks > 4);
  assert.equal(result.state, 'truncated'); assert.equal(result.reports[0].state, 'truncated');
  const immediate = analyze([rolePlugin()], {}, fixture(), () => true).result;
  assert.equal(immediate.state, 'truncated'); assert.deepEqual(immediate.facts, []);
});

test('base declaration hard overflow is explicit, not a dangling owner prefix', () => {
  const input = fixture();
  input.view.declarations = Array.from({ length: ANNOTATION_LIMITS.maxDeclarations + 1 }, (_, index) => ({
    key: `key-${index}`, kind: 'constant', span: input.evidence.span, exports: [],
  }));
  const { result } = analyze([], {}, input);
  assert.equal(result.state, 'truncated'); assert.deepEqual(result.declarations, []);
});

test('UTF8 BOM, CRLF, astral characters and exact reference text are checked', () => {
  const input = fixture('\ufeffconst emoji = "\u{1f600}";\r\nconst next = emoji;\n');
  const plugin = rolePlugin();
  const start = input.document.source.indexOf('emoji');
  const reference = { kind: 'expression', text: 'emoji', span: sourceSpan(input.document.source, start, start + 5) };
  plugin.analyze = (_, e) => e.relation('a', 'sample.uses', reference, input.evidence) && undefined;
  const { result, contract } = analyze([plugin], {}, input);
  assert.equal(result.facts.length, 1);
  const wrong = copy(result); wrong.declarations[0].span.startByte = 1;
  assert.throws(() => validateAnnotationResult(wrong, contract, input.document.source), /UTF-8/);
  const wrongLine = copy(result); wrongLine.declarations[0].span.endLine++;
  assert.throws(() => validateAnnotationResult(wrongLine, contract, input.document.source), /line/);
  const wrongText = copy(result); wrongText.facts[0].target.text = 'alias';
  assert.throws(() => validateAnnotationResult(wrongText, contract, input.document.source), /text mismatch/);
});

test('owner cycles and unknown owners fail, while relation cycles are legal graph data', () => {
  const input = fixture();
  const plugin = rolePlugin();
  plugin.analyze = (_, e) => {
    e.relation('a', 'sample.uses', { kind: 'declaration', key: 'b' }, input.evidence);
    e.relation('b', 'sample.uses', { kind: 'declaration', key: 'a' }, { ...input.evidence, span: input.view.declarations[2].span });
  };
  assert.equal(analyze([plugin], {}, input).result.facts.length, 2);
  input.view.declarations[0].owner = 'a';
  assert.throws(() => analyze([], {}, input), /cyclic|outside/);
  input.view.declarations[0].owner = 'missing';
  assert.throws(() => analyze([], {}, input), /owner/);
});

test('result validator rejects unknown keys, duplicate facts and hidden failures', () => {
  const { result, contract } = analyze([rolePlugin()]);
  const changes = [
    r => { r.script = 'run'; }, r => { r.declarations[0].extra = 1; }, r => { r.declarations.push(copy(r.declarations[0])); },
    r => { r.facts.push(copy(r.facts[0])); }, r => { r.reports = []; },
    r => { r.facts[0].evidence.pluginId = 'unknown'; }, r => { r.facts[0].evidence.ruleId = null; },
    r => { r.reports[0].state = 'failed'; }, r => { r.reports[0].pluginId = 'unknown'; },
    r => { r.analysisSetId = digest('other'); }, r => { r.relativePath = '../private'; },
    r => { r.relativePath = 'D:/private'; }, r => { r.sourceHash = 'invalid'; }, r => { r.language = 1; },
  ];
  for (const change of changes) { const invalid = copy(result); change(invalid); assert.throws(() => validateAnnotationResult(invalid, contract), change.toString()); }
  const hidden = copy(result); hidden.facts = []; hidden.reports[0].state = 'failed';
  assert.throws(() => validateAnnotationResult(hidden, contract), /Incomplete|Failed/);
});

test('bad base inputs and source identity fail before invoking a plugin', () => {
  const plugin = rolePlugin(); const contract = manifest([plugin]);
  const engine = createAnnotationEngine({ manifest: contract, plugins: [plugin], digest });
  for (const change of [
    i => { i.document.sourceHash = digest('wrong'); }, i => { i.view.version = 2; },
    i => { i.view.language = 'unknown'; }, i => { i.view.declarations[1].exports.push('alpha'); },
    i => { i.document.relativePath = '/absolute'; }, i => { i.document.source = '\ud800'; },
  ]) { const input = fixture(); change(input); assert.throws(() => engine.analyze(input.document, input.view)); }
});

test('deep immutable syntax-like DAGs preserve aliases without container-depth false failures', () => {
  const input = fixture();
  const nodes = [];
  let root;
  for (let depth = 0; depth < 64; depth++) {
    root = Object.freeze({
      type: 'nested', startIndex: 0, endIndex: 1,
      children: Object.freeze(root ? [root] : []),
      fields: Object.freeze(root ? { child: root } : {}), tokens: Object.freeze([]),
    });
    nodes.push(root);
  }
  input.view.root = root;
  input.view.nodes = Object.freeze(nodes);
  input.view.lookup = () => root;
  const plugin = rolePlugin();
  plugin.analyze = ({ view, budget }) => {
    assert.equal(view.root, view.nodes.at(-1));
    assert.equal(view.lookup(), view.root);
    let current = view.root;
    let depth = 0;
    while (current) {
      budget.step();
      assert.equal(current.children[0], current.fields.child);
      assert.throws(() => current.children.push({}));
      depth++;
      current = current.children[0];
    }
    assert.equal(depth, 64);
  };
  assert.equal(analyze([plugin], {}, input).result.state, 'complete');
});

test('wide normalized view counts graph containers, not every scalar as semantic work', () => {
  const input = fixture();
  input.view.nodes = Object.freeze(Array.from({ length: 20_000 }, (_, index) => Object.freeze({
    type: 'identifier', startIndex: index, endIndex: index + 1,
    children: Object.freeze([]), fields: Object.freeze({}), tokens: Object.freeze(['identifier']),
  })));
  const { result } = analyze([], {}, input);
  assert.equal(result.state, 'complete');
});

test('observing cancellation and returning void cannot masquerade as not-applicable', () => {
  const plugin = rolePlugin();
  let observed = false;
  let checks = 0;
  plugin.analyze = ({ budget }) => { observed = budget.isCancelled(); };
  const { result } = analyze([plugin], {}, fixture(), () => ++checks >= 4);
  assert.equal(observed, true);
  assert.equal(result.reports[0].state, 'truncated');
});

test('bounded emitter honors a reduced 512KiB result before reaching fact count cap', () => {
  const input = fixture(); const plugin = rolePlugin();
  let accepted = 0;
  plugin.analyze = (_, emitter) => {
    for (let index = 0; index < 5000; index++) {
      if (emitter.role('a', 'sample.exported', { ...input.evidence, ruleId: `rule-${index}` })) accepted++;
    }
  };
  const { result } = analyze([plugin], { maxResultBytes: 512 * 1024 }, input);
  assert.equal(result.state, 'truncated');
  assert.equal(result.facts.length, accepted);
  assert.ok(accepted > 0 && accepted < ANNOTATION_LIMITS.maxFacts);
  assert.ok(Buffer.byteLength(canonicalJSON(result)) <= ANNOTATION_LIMITS.maxResultBytes);
});

test('oversize base inventories truncate explicitly before invoking plugins', () => {
  const input = fixture();
  input.view.declarations = Array.from({ length: 2000 }, (_, index) => ({
    key: `key-${index}`, kind: 'constant', name: 'x'.repeat(300), span: input.evidence.span,
    exports: Array.from({ length: 5 }, (_, i) => `${i}${'x'.repeat(1024)}`),
  }));
  const plugin = rolePlugin();
  plugin.analyze = () => { throw new Error('must not execute with unavailable base'); };
  const { result } = analyze([plugin], {}, input);
  assert.equal(result.state, 'truncated'); assert.equal(result.reports[0].state, 'truncated');
  assert.deepEqual(result.declarations, []);
});

test('failed reports cannot turn into absence through plugin return values or diagnostic overflow', () => {
  const input = fixture();
  for (const outcome of [{ state: 'failed' }, { state: 'not-applicable' }, { state: 'unsupported' }, { arbitrary: true }, Promise.resolve()]) {
    const plugin = rolePlugin();
    plugin.analyze = (_, emitter) => { emitter.role('a', 'sample.exported', input.evidence); return outcome; };
    const { result } = analyze([plugin], { maxDiagnostics: 1 }, input);
    assert.equal(result.state, 'partial'); assert.equal(result.reports[0].state, 'failed'); assert.equal(result.facts.length, 0);
  }
});

test('single-valued equivalent evidence coexists; multiple values and source refs remain typed', () => {
  const input = fixture(); const plugin = rolePlugin();
  plugin.descriptor.properties[0].multiple = true;
  plugin.analyze = (_, emitter) => {
    emitter.property('a', 'sample.label', 'literal', { kind: 'string', value: '' }, input.evidence);
    emitter.property('a', 'sample.label', 'literal', { kind: 'string', value: 'second' }, input.evidence);
    emitter.property('a', 'sample.count', 'literal', { kind: 'integer', value: 1 }, input.evidence);
    emitter.property('a', 'sample.count', 'literal', { kind: 'integer', value: 1 }, { ...input.evidence, ruleId: 'other' });
  };
  assert.equal(analyze([plugin], {}, input).result.facts.length, 4);
});

test('result diagnostics reject exact duplicate records and aggregate overflow', () => {
  const { result, contract } = analyze([rolePlugin()], { maxDiagnostics: 1 });
  const diagnostic = { code: 'message', message: 'text' };
  result.diagnostics.push(diagnostic);
  result.reports[0].diagnostics.push(diagnostic);
  assert.throws(() => validateAnnotationResult(result, contract), /Diagnostic limit/);
  result.reports[0].diagnostics = [];
  result.diagnostics.push(diagnostic);
  const defaultContract = manifest([descriptor()]);
  result.analysisSetId = defaultContract.id;
  assert.throws(() => validateAnnotationResult(result, defaultContract), /Duplicate diagnostic/);
});

test('plugin method this cannot mutate the registry or poison future analyses', () => {
  const input = fixture(); const plugin = rolePlugin('a-mutating');
  plugin.analyze = function () { this.descriptor = descriptor('forged'); };
  const { result, engine } = analyze([plugin, rolePlugin('b-working')], {}, input);
  assert.equal(result.state, 'partial'); assert.equal(result.reports[0].state, 'failed');
  assert.equal(result.facts.length, 2);
  assert.equal(canonicalJSON(engine.analyze(input.document, input.view)), canonicalJSON(result));
});

test('canonical record ordering is UTF8 lexical rather than locale or UTF16 order', () => {
  const input = fixture();
  input.view.declarations = [
    { key: '\u{10000}', kind: 'constant', span: input.evidence.span, exports: ['\u{10000}', '\ue000'] },
    { key: '\ue000', kind: 'constant', span: input.evidence.span, exports: [] },
  ];
  const { result } = analyze([], {}, input);
  assert.deepEqual(result.declarations.map(declaration => declaration.key), ['\ue000', '\u{10000}']);
  assert.deepEqual(result.declarations[1].exports, ['\ue000', '\u{10000}']);
});

test('dropping a known reference target is truncation rather than an invalid dangling fact', () => {
  const input = fixture(); const plugin = rolePlugin();
  plugin.analyze = (_, e) => { assert.equal(e.relation('a', 'sample.uses', { kind: 'declaration', key: 'b' }, input.evidence), false); };
  const { result } = analyze([plugin], { maxDeclarations: 2 }, input);
  assert.equal(result.reports[0].state, 'truncated');
  assert.deepEqual(result.declarations.map(declaration => declaration.key), ['a', 'root']);
  assert.deepEqual(result.facts, []);
});

test('failed buffers release byte and fact capacity for independently successful plugins', () => {
  const input = fixture();
  const failure = rolePlugin('a-failing');
  failure.analyze = (_, e) => {
    e.role('a', 'a-failing.exported', input.evidence);
    throw new Error('discard');
  };
  const { result } = analyze([failure, rolePlugin('b-working')], { maxFacts: 1 }, input);
  assert.equal(result.reports[0].state, 'failed');
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].evidence.pluginId, 'b-working');
});

test('source, value and impossible result-envelope limits fail closed', () => {
  assert.throws(() => analyze([], { maxSourceBytes: 1 }), /Source byte limit/);
  assert.throws(() => analyze([], { maxResultBytes: 1 }), /envelope/);
  const input = fixture(); const plugin = rolePlugin();
  plugin.analyze = (_, e) => e.property('a', 'sample.label', 'literal', { kind: 'string', value: 'x'.repeat(2048) }, input.evidence) && undefined;
  const { result } = analyze([plugin], { maxValueBytes: 2048 }, input);
  assert.equal(result.state, 'partial'); assert.equal(result.reports[0].state, 'failed');
  assert.equal(result.facts.length, 0);
});

test('capacity ceilings admit large exact references and results without removing finite bounds', () => {
  assert.deepEqual(ANNOTATION_LIMITS, {
    maxSourceBytes: 262144, maxDeclarations: 2048, maxFacts: 4096, maxDiagnostics: 32,
    maxResultBytes: 8388608, maxManifestBytes: 65536, maxPlugins: 8, maxWork: 2000000,
    maxDepth: 128, maxValueBytes: 262144,
  });
  const source = `()=>{${'/* callback */'.repeat(3000)}}`;
  const input = fixture(source), plugin = rolePlugin();
  const reference = { kind: 'expression', text: source, span: sourceSpan(source) };
  plugin.analyze = (_, e) => {
    for (let i = 0; i < 20; i++) e.relation('a', 'sample.uses', reference, { ...input.evidence, ruleId: `large-${i}` });
  };
  const { result } = analyze([plugin], {}, input);
  assert.equal(result.state, 'complete');
  assert.equal(result.facts.length, 20);
  assert(Buffer.byteLength(canonicalJSON(result)) > 512 * 1024);
  assert.equal(result.facts[0].target.text, source);
  assert.throws(() => canonicalJSON('x'.repeat(ANNOTATION_LIMITS.maxResultBytes)), /byte limit/);
  assert.equal(analyze([plugin], { maxValueBytes: 2048 }, input).result.reports[0].state, 'failed');
});

test('budget stops retain resource accounting using the existing strict diagnostic shape', () => {
  const input = fixture(), plugin = rolePlugin();
  let accounted;
  plugin.analyze = ({ budget }, e) => {
    e.role('a', 'sample.exported', input.evidence);
    accounted = budget.consumedWork + 100;
    budget.step(100);
  };
  const work = analyze([plugin], { maxWork: 50 }, input).result;
  assert.equal(work.facts.length, 1);
  assert.deepEqual(work.reports[0].diagnostics, [{ code: 'core.budget-limit', message: `resource=work accounted=${accounted} limit=50` }]);
  plugin.analyze = ({ budget }) => budget.depth(129);
  assert.equal(analyze([plugin]).result.reports[0].diagnostics[0].message, 'resource=depth accounted=129 limit=128');
  const cancelled = analyze([plugin], {}, input, () => true).result;
  assert(cancelled.diagnostics.some(d => d.message === 'resource=cancelled accounted=1 limit=0'));
  const facts = analyze([rolePlugin()], { maxFacts: 1 }).result;
  assert(facts.reports[0].diagnostics.some(d => d.message === 'resource=facts accounted=2 limit=1'));
  plugin.analyze = (_, e) => {
    for (let i = 0; i < 100; i++) e.role('a', 'sample.exported', { ...input.evidence, ruleId: `bytes-${i}` });
  };
  const bytes = analyze([plugin], { maxResultBytes: 1600 }, input).result;
  assert(bytes.reports[0].diagnostics.some(d => /^resource=result-bytes accounted=\d+ limit=1600$/.test(d.message)));
  assert(Buffer.byteLength(canonicalJSON(bytes)) <= 1600);
});
