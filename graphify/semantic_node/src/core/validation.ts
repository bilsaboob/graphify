import { canonicalJSON, utf8Length, validUnicode } from './canonical.js';
import { ANNOTATION_LIMITS } from './wire.js';
import type {
  AnnotationDiagnostic, AnnotationFact, AnnotationManifest, AnnotationResult, CoverageState,
  BindingOperationDescriptor, Declaration, Digest, PluginDescriptor, PropertyTerm, Reference, SourceSpan,
} from './wire.js';

type ObjectValue = Record<string, unknown>;
const states: readonly CoverageState[] = ['complete', 'not-applicable', 'partial', 'unsupported', 'truncated', 'failed'];
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z][A-Za-z0-9._:/-]*$/;

export function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function object(value: unknown, required: readonly string[], optional: readonly string[] = []): ObjectValue {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  const prototype = Object.getPrototypeOf(value);
  requireValid(prototype === Object.prototype || prototype === null, 'Invalid object prototype');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    requireValid(typeof key === 'string' && (required.includes(key) || optional.includes(key)), 'Unknown object property');
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    requireValid(property.enumerable && 'value' in property && property.value !== undefined, 'Invalid object property');
  }
  requireValid(required.every(key => Object.hasOwn(value, key)), 'Missing object property');
  return value as ObjectValue;
}

function array(value: unknown, limit: number): unknown[] {
  requireValid(Array.isArray(value) && value.length <= limit, 'Invalid array or array limit');
  return value;
}

export function text(value: unknown, max = 2048, empty = false): asserts value is string {
  requireValid(typeof value === 'string' && (empty || value.length > 0) && value.length <= max, 'Invalid text');
  validUnicode(value);
  requireValid(utf8Length(value) <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Invalid text');
}

export function identifier(value: unknown, max = 128): asserts value is string {
  text(value, max);
  requireValid(identifierPattern.test(value), 'Invalid identifier');
}

export function integer(value: unknown, min: number, max: number): asserts value is number {
  requireValid(typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max, 'Invalid integer');
}

export function hash(value: unknown): asserts value is string {
  requireValid(typeof value === 'string' && hashPattern.test(value), 'Invalid digest');
}

export function coverage(value: unknown): asserts value is CoverageState {
  requireValid(states.includes(value as CoverageState), 'Invalid coverage state');
}

export function relativePath(value: unknown): asserts value is string {
  text(value, 2048);
  requireValid(!/[\\:\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Invalid relative path');
}

function uniqueStrings(value: unknown, max: number, check: (item: unknown) => void): void {
  const items = array(value, max);
  const seen = new Set<unknown>();
  for (const item of items) {
    check(item);
    requireValid(!seen.has(item), 'Duplicate entry');
    seen.add(item);
  }
}

function pluginDescriptor(value: unknown, manifestView: { id: unknown; version: unknown }): asserts value is PluginDescriptor {
  const plugin = object(value, ['id', 'version', 'implementationDigest', 'configurationDigest', 'languages', 'view', 'roles', 'properties', 'relations']);
  text(plugin.id, 64);
  requireValid(/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id) && !['core', 'wire'].includes(plugin.id), 'Invalid plugin namespace');
  text(plugin.version, 64);
  hash(plugin.implementationDigest);
  hash(plugin.configurationDigest);
  uniqueStrings(plugin.languages, 32, language => identifier(language, 64));
  requireValid((plugin.languages as unknown[]).length > 0, 'Empty plugin languages');
  const view = object(plugin.view, ['id', 'version']);
  requireValid(view.id === manifestView.id && view.version === manifestView.version, 'Unsupported plugin view');
  const terms = new Set<string>();
  for (const category of ['roles', 'properties', 'relations']) {
    for (const entry of array(plugin[category], 256)) {
      const term = object(entry, category === 'properties' ? ['id', 'label', 'valueKind', 'multiple'] : ['id', 'label'], ['description']);
      text(term.id, 128);
      requireValid(term.id.startsWith(`${plugin.id}.`) && /^[a-z][a-z0-9.-]*$/.test(term.id.slice(plugin.id.length + 1)), 'Foreign vocabulary namespace');
      requireValid(!terms.has(term.id), 'Duplicate vocabulary term');
      terms.add(term.id);
      text(term.label);
      if ('description' in term) text(term.description);
      if (category === 'properties') {
        requireValid(['string', 'boolean', 'integer', 'reference'].includes(term.valueKind as string), 'Invalid property value kind');
        requireValid(typeof term.multiple === 'boolean', 'Invalid property cardinality');
      }
    }
  }
}

export function validateAnnotationManifest(manifest: unknown, digest?: Digest): asserts manifest is AnnotationManifest {
  const encoded = canonicalJSON(manifest);
  const value = object(manifest, ['version', 'id', 'core', 'view', 'parserDigest', 'plugins', 'limits']);
  requireValid(value.version === 1, 'Unsupported annotation version');
  hash(value.id);
  const core = object(value.core, ['version', 'implementationDigest'], ['configurationDigest']);
  text(core.version, 64);
  hash(core.implementationDigest);
  if (core.configurationDigest !== undefined) hash(core.configurationDigest);
  const view = object(value.view, ['id', 'version', 'implementationDigest'], ['configurationDigest']);
  identifier(view.id);
  integer(view.version, 1, Number.MAX_SAFE_INTEGER);
  hash(view.implementationDigest);
  if (view.configurationDigest !== undefined) hash(view.configurationDigest);
  hash(value.parserDigest);
  const limits = object(value.limits, Object.keys(ANNOTATION_LIMITS));
  for (const key of Object.keys(ANNOTATION_LIMITS) as (keyof typeof ANNOTATION_LIMITS)[]) {
    integer(limits[key], 1, ANNOTATION_LIMITS[key]);
  }
  requireValid(utf8Length(encoded) <= (limits.maxManifestBytes as number), 'Manifest byte limit exceeded');
  const plugins = array(value.plugins, limits.maxPlugins as number);
  const seen = new Set<string>();
  for (const plugin of plugins) {
    pluginDescriptor(plugin, view as { id: unknown; version: unknown });
    requireValid(!seen.has(plugin.id), 'Duplicate plugin');
    seen.add(plugin.id);
  }
  if (digest) {
    const { id, ...content } = value;
    const calculated = digest(canonicalJSON(content));
    hash(calculated);
    requireValid(id === calculated, 'Manifest identity mismatch');
  }
}

export interface SourceCoordinates {
  readonly source: string;
  readonly bytes: number;
  readonly offsets: ReadonlyMap<number, number>;
  readonly lines: readonly number[];
}

export function sourceCoordinates(source: string, maxBytes: number): SourceCoordinates {
  requireValid(typeof source === 'string' && source.length <= maxBytes, 'Source byte limit exceeded');
  validUnicode(source);
  const offsets = new Map<number, number>();
  const lines: number[] = [];
  let bytes = 0;
  let offset = 0;
  let line = 1;
  for (const char of source) {
    offsets.set(bytes, offset);
    const length = utf8Length(char);
    for (let byte = 0; byte < length; byte++) lines[bytes++] = line;
    if (char === '\n') line++;
    offset += char.length;
  }
  offsets.set(bytes, offset);
  lines[bytes] = line;
  requireValid(bytes <= maxBytes, 'Source byte limit exceeded');
  return { source, bytes, offsets, lines };
}

export function span(value: unknown, maxBytes: number, coordinates?: SourceCoordinates): asserts value is SourceSpan {
  const item = object(value, ['startByte', 'endByte', 'startLine', 'endLine']);
  integer(item.startByte, 0, coordinates?.bytes ?? maxBytes);
  integer(item.endByte, item.startByte, coordinates?.bytes ?? maxBytes);
  integer(item.startLine, 1, maxBytes + 1);
  integer(item.endLine, item.startLine, maxBytes + 1);
  if (coordinates) {
    requireValid(coordinates.offsets.has(item.startByte) && coordinates.offsets.has(item.endByte), 'Span splits UTF-8 character');
    requireValid(item.startLine === coordinates.lines[item.startByte] && item.endLine === coordinates.lines[item.endByte > item.startByte ? item.endByte - 1 : item.startByte], 'Span line mismatch');
  }
}

export function contains(outer: SourceSpan, inner: SourceSpan): boolean {
  return outer.startByte <= inner.startByte && outer.endByte >= inner.endByte && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

export function validateDeclarations(
  declarations: unknown, manifest: AnnotationManifest, coordinates?: SourceCoordinates,
): Map<string, Declaration> {
  const result = new Map<string, Declaration>();
  for (const entry of array(declarations, manifest.limits.maxDeclarations)) {
    const declaration = object(entry, ['key', 'kind', 'span', 'exports'], ['name', 'owner', 'nameSpan', 'binding', 'writes', 'computedName']);
    text(declaration.key);
    requireValid(!/[\x00-\x1f\x7f]/.test(declaration.key), 'Invalid declaration key');
    identifier(declaration.kind);
    if ('name' in declaration) text(declaration.name);
    if ('owner' in declaration) text(declaration.owner);
    span(declaration.span, manifest.limits.maxSourceBytes, coordinates);
    if ('nameSpan' in declaration) {
      span(declaration.nameSpan, manifest.limits.maxSourceBytes, coordinates);
      requireValid(contains(declaration.span, declaration.nameSpan), 'Name span outside declaration');
    }
    uniqueStrings(declaration.exports, 256, item => text(item));
    requireValid(!result.has(declaration.key), 'Duplicate declaration key');
    result.set(declaration.key, entry as Declaration);
  }
  for (const declaration of result.values()) {
    if (declaration.binding !== undefined) {
      validateBinding(declaration.binding, manifest, coordinates);
      requireValid(contains(declaration.binding.patternSpan, declaration.nameSpan ?? declaration.span), 'Binding target outside pattern');
    }
    if (declaration.writes !== undefined) {
      const writes = array(declaration.writes, 64);
      requireValid(writes.length > 0, 'Empty writes');
      const seen = new Set<string>();
      for (const write of writes) {
        validateBinding(write, manifest, coordinates);
        const key = canonicalJSON(write);
        requireValid(!seen.has(key), 'Duplicate write');
        seen.add(key);
      }
    }
    if (declaration.computedName !== undefined) {
      validateSourceExpression(declaration.computedName, manifest, coordinates);
      requireValid(declaration.name === undefined && contains(declaration.span, declaration.computedName.span), 'Invalid computed name');
    }
    const seen = new Set<string>([declaration.key]);
    let current = declaration;
    while (current.owner !== undefined) {
      const owner = result.get(current.owner);
      requireValid(owner && !seen.has(owner.key), 'Missing or cyclic declaration owner');
      requireValid(contains(owner.span, current.span), 'Declaration outside owner');
      seen.add(owner.key);
      requireValid(seen.size <= manifest.limits.maxDepth, 'Declaration depth exceeded');
      current = owner;
    }
  }
  return result;
}

function validateSourceExpression(value: unknown, manifest: AnnotationManifest, coordinates?: SourceCoordinates): asserts value is Extract<Reference, { kind: 'expression' }> {
  validateReference(value, manifest, new Map(), coordinates);
  requireValid(value.kind === 'expression', 'Binding evidence requires an exact source expression');
}

export function validateBindingOperationDescriptor(value: unknown, manifest: AnnotationManifest, source?: string): asserts value is BindingOperationDescriptor {
  validateAnnotationManifest(manifest);
  validateBinding(value, manifest, source === undefined ? undefined : sourceCoordinates(source, manifest.limits.maxSourceBytes));
}

function validateBinding(value: unknown, manifest: AnnotationManifest, coordinates?: SourceCoordinates): void {
  const item = object(value, ['source', 'sourceSpan', 'patternSpan', 'operations', 'value'], ['shapes']);
  requireValid(item.value === 'unknown', 'Structural binding is not value proof');
  validateSourceExpression(item.source, manifest, coordinates);
  span(item.sourceSpan, manifest.limits.maxSourceBytes, coordinates);
  span(item.patternSpan, manifest.limits.maxSourceBytes, coordinates);
  requireValid(canonicalJSON(item.source.span) === canonicalJSON(item.sourceSpan), 'Binding source span mismatch');
  const operations = array(item.operations, Math.min(24, manifest.limits.maxDepth));
  requireValid(operations.length > 0, 'Empty binding operations');
  for (const entry of operations) {
    const op = object(entry, ['kind', 'span'], ['key', 'index', 'value', 'excludedKeys']);
    span(op.span, manifest.limits.maxSourceBytes, coordinates);
    requireValid(contains(item.patternSpan, op.span), 'Operation outside binding pattern');
    switch (op.kind) {
      case 'property': object(op, ['kind', 'span', 'key']); text(op.key, 2048, true); break;
      case 'computed-property':
        object(op, ['kind', 'span', 'key']);
        validateSourceExpression(op.key, manifest, coordinates);
        requireValid(contains(op.span, op.key.span), 'Computed key outside operation');
        break;
      case 'iterator': case 'iterator-rest':
        object(op, ['kind', 'span', 'index']); integer(op.index, 0, 511); break;
      case 'default':
        object(op, ['kind', 'span', 'value']);
        validateSourceExpression(op.value, manifest, coordinates);
        requireValid(contains(op.span, op.value.span), 'Default outside operation');
        break;
      case 'object-rest':
        object(op, ['kind', 'span', 'excludedKeys']);
        for (const key of array(op.excludedKeys, 64)) {
          if (typeof key === 'string') text(key, 2048, true);
          else {
            validateSourceExpression(key, manifest, coordinates);
            requireValid(contains(item.patternSpan, key.span), 'Excluded key outside pattern');
          }
        }
        break;
      default: throw new Error('Invalid binding operation');
    }
  }
  if ('shapes' in item) {
    const shapes = array(item.shapes, 16);
    requireValid(shapes.length > 0, 'Empty binding shapes');
    for (const entry of shapes) {
      const shape = object(entry, ['kind', 'span'], ['keys', 'length']);
      span(shape.span, manifest.limits.maxSourceBytes, coordinates);
      if (shape.kind === 'object') {
        object(shape, ['kind', 'span', 'keys']);
        uniqueStrings(shape.keys, 64, key => text(key, 2048, true));
      } else {
        requireValid(shape.kind === 'tuple', 'Invalid binding shape');
        object(shape, ['kind', 'span', 'length']); integer(shape.length, 0, 64);
      }
    }
  }
  requireValid(utf8Length(canonicalJSON(item)) <= manifest.limits.maxValueBytes, 'Binding evidence byte limit exceeded');
}

export function validateDiagnostic(value: unknown, manifest: AnnotationManifest, coordinates?: SourceCoordinates): asserts value is AnnotationDiagnostic {
  const item = object(value, ['code', 'message'], ['span']);
  identifier(item.code);
  text(item.message, manifest.limits.maxValueBytes);
  if ('span' in item) span(item.span, manifest.limits.maxSourceBytes, coordinates);
}

export function validateReference(value: unknown, manifest: AnnotationManifest, declarations: ReadonlyMap<string, Declaration>, coordinates?: SourceCoordinates): asserts value is Reference {
  const item = object(value, ['kind'], ['key', 'module', 'name', 'member', 'text', 'span']);
  switch (item.kind) {
    case 'declaration':
      object(item, ['kind', 'key']);
      text(item.key);
      requireValid(declarations.has(item.key), 'Unknown declaration reference');
      break;
    case 'import':
      object(item, ['kind', 'module', 'name'], ['member']);
      text(item.module, manifest.limits.maxValueBytes);
      text(item.name, manifest.limits.maxValueBytes);
      if ('member' in item) text(item.member, manifest.limits.maxValueBytes);
      break;
    case 'expression':
    case 'type':
      object(item, ['kind', 'text', 'span']);
      text(item.text, manifest.limits.maxValueBytes);
      span(item.span, manifest.limits.maxSourceBytes, coordinates);
      if (coordinates) {
        requireValid(item.text === coordinates.source.slice(coordinates.offsets.get(item.span.startByte), coordinates.offsets.get(item.span.endByte)), 'Reference text mismatch');
      }
      break;
    default: throw new Error('Invalid reference kind');
  }
  requireValid(utf8Length(canonicalJSON(item)) <= manifest.limits.maxValueBytes, 'Reference byte limit exceeded');
}

export function validateFact(
  value: unknown, plugin: PluginDescriptor, manifest: AnnotationManifest, declarations: ReadonlyMap<string, Declaration>,
  coordinates?: SourceCoordinates,
): asserts value is AnnotationFact {
  const item = object(value, ['kind', 'subject', 'term', 'evidence'], ['resolution', 'value', 'target']);
  text(item.subject);
  text(item.term, 128);
  const subject = declarations.get(item.subject);
  requireValid(subject, 'Unknown fact subject');
  const evidence = object(item.evidence, ['pluginId', 'ruleId', 'basis', 'span']);
  requireValid(evidence.pluginId === plugin.id, 'Invalid fact provenance');
  identifier(evidence.ruleId);
  requireValid(['syntax', 'import-bound', 'convention'].includes(evidence.basis as string), 'Invalid evidence basis');
  span(evidence.span, manifest.limits.maxSourceBytes, coordinates);
  requireValid(contains(subject.span, evidence.span), 'Evidence outside subject');
  switch (item.kind) {
    case 'role':
      object(item, ['kind', 'subject', 'term', 'evidence']);
      requireValid(plugin.roles.some(term => term.id === item.term), 'Unknown role');
      break;
    case 'property': {
      object(item, ['kind', 'subject', 'term', 'evidence', 'resolution'], ['value']);
      const term = plugin.properties.find(term => term.id === item.term);
      requireValid(term, 'Unknown property');
      requireValid(['literal', 'constant', 'expression', 'absent'].includes(item.resolution as string), 'Invalid value resolution');
      if (item.resolution === 'absent' || item.resolution === 'expression') {
        requireValid(!('value' in item), 'Unresolved property has a value');
      } else {
        const property = object(item.value, ['kind', 'value']);
        requireValid(property.kind === term.valueKind, 'Invalid property value kind');
        switch (property.kind) {
          case 'string': text(property.value, manifest.limits.maxValueBytes, true); break;
          case 'boolean': requireValid(typeof property.value === 'boolean', 'Invalid boolean'); break;
          case 'integer': integer(property.value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); break;
          case 'reference': validateReference(property.value, manifest, declarations, coordinates); break;
        }
        requireValid(utf8Length(canonicalJSON(property)) <= manifest.limits.maxValueBytes, 'Value byte limit exceeded');
      }
      break;
    }
    case 'relation':
      object(item, ['kind', 'subject', 'term', 'evidence', 'target']);
      requireValid(plugin.relations.some(term => term.id === item.term), 'Unknown relation');
      validateReference(item.target, manifest, declarations, coordinates);
      break;
    default: throw new Error('Invalid fact kind');
  }
}

export function checkCardinality(fact: AnnotationFact, term: PropertyTerm | undefined, values: Map<string, string>): void {
  if (fact.kind !== 'property' || !term || term.multiple) return;
  const key = canonicalJSON([fact.subject, fact.term]);
  const value = canonicalJSON(fact.value === undefined ? { resolution: fact.resolution } : { resolution: fact.resolution, value: fact.value });
  const previous = values.get(key);
  requireValid(previous === undefined || previous === value, 'Conflicting single-valued property');
  values.set(key, value);
}

export function validateAnnotationResult(result: unknown, manifest: AnnotationManifest, source?: string): asserts result is AnnotationResult {
  validateAnnotationManifest(manifest);
  requireValid(utf8Length(canonicalJSON(result)) <= manifest.limits.maxResultBytes, 'Result byte limit exceeded');
  const value = object(result, ['version', 'analysisSetId', 'sourceHash', 'relativePath', 'language', 'state', 'declarations', 'facts', 'reports', 'diagnostics']);
  requireValid(value.version === 1 && value.analysisSetId === manifest.id, 'Annotation contract mismatch');
  hash(value.sourceHash);
  relativePath(value.relativePath);
  identifier(value.language, 64);
  coverage(value.state);
  const coordinates = source === undefined ? undefined : sourceCoordinates(source, manifest.limits.maxSourceBytes);
  const declarations = validateDeclarations(value.declarations, manifest, coordinates);
  const plugins = new Map(manifest.plugins.map(plugin => [plugin.id, plugin]));
  const reports = new Map<string, CoverageState>();
  let diagnostics = 0;
  const checkDiagnostics = (items: unknown): void => {
    const seen = new Set<string>();
    for (const diagnostic of array(items, manifest.limits.maxDiagnostics)) {
      validateDiagnostic(diagnostic, manifest, coordinates);
      const key = canonicalJSON(diagnostic);
      requireValid(!seen.has(key), 'Duplicate diagnostic');
      seen.add(key);
      requireValid(++diagnostics <= manifest.limits.maxDiagnostics, 'Diagnostic limit exceeded');
    }
  };
  checkDiagnostics(value.diagnostics);
  for (const entry of array(value.reports, manifest.limits.maxPlugins)) {
    const report = object(entry, ['pluginId', 'state', 'diagnostics']);
    text(report.pluginId, 64);
    coverage(report.state);
    requireValid(plugins.has(report.pluginId) && !reports.has(report.pluginId), 'Unknown or duplicate plugin report');
    const plugin = plugins.get(report.pluginId)!;
    requireValid(plugin.languages.includes(value.language) || report.state === 'not-applicable', 'Unsupported plugin language');
    reports.set(report.pluginId, report.state);
    checkDiagnostics(report.diagnostics);
  }
  requireValid(reports.size === plugins.size, 'Missing plugin report');
  const seen = new Set<string>();
  const propertyValues = new Map<string, string>();
  for (const entry of array(value.facts, manifest.limits.maxFacts)) {
    const fact = object(entry, ['kind', 'subject', 'term', 'evidence'], ['resolution', 'value', 'target']);
    const evidence = object(fact.evidence, ['pluginId', 'ruleId', 'basis', 'span']);
    const plugin = plugins.get(evidence.pluginId as string);
    requireValid(plugin, 'Unknown fact plugin');
    validateFact(entry, plugin, manifest, declarations, coordinates);
    requireValid(!['failed', 'unsupported', 'not-applicable'].includes(reports.get(plugin.id)!), 'Facts contradict plugin report');
    const key = canonicalJSON(entry);
    requireValid(!seen.has(key), 'Duplicate fact');
    seen.add(key);
    checkCardinality(entry, plugin.properties.find(term => term.id === entry.term), propertyValues);
  }
  const reportStates = [...reports.values()];
  if (value.state === 'complete' || value.state === 'not-applicable') {
    requireValid(reportStates.every(state => state === 'complete' || state === 'not-applicable'), 'Incomplete reports hidden by result');
  }
  if (value.state === 'not-applicable') requireValid(seen.size === 0 && reportStates.every(state => state === 'not-applicable'), 'Invalid not-applicable result');
  if (value.state === 'unsupported' || value.state === 'failed') {
    requireValid(seen.size === 0 && reportStates.every(state => ['unsupported', 'failed', 'not-applicable'].includes(state)), 'Facts contradict base coverage');
  }
  if (reportStates.includes('failed')) requireValid(['partial', 'failed', 'unsupported'].includes(value.state), 'Failed plugin hidden by result');
}
