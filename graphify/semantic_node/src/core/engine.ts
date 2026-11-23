import { CanonicalLimitError, canonicalJSON, utf8Length } from './canonical.js';
import {
  checkCardinality, coverage, hash, identifier, integer, object, relativePath, requireValid,
  sourceCoordinates, validateAnnotationManifest, validateAnnotationResult, validateDeclarations,
  validateDiagnostic, validateFact,
} from './validation.js';
import { ANNOTATION_LIMITS } from './wire.js';
import type {
  AnnotationDiagnostic, AnnotationFact, AnnotationManifest, AnnotationResult, CoverageState, Declaration,
  Digest, FactEvidence, FactValue, PluginDescriptor, PluginReport, Reference, ValueResolution,
} from './wire.js';

export interface AnalysisDocument {
  source: string;
  sourceHash: string;
  relativePath: string;
  language: string;
}

type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
export type ReadonlyDeclaration = ReadonlyData<Declaration>;

export interface LanguageView {
  readonly id: string;
  readonly version: number;
  readonly language: string;
  readonly declarations: readonly ReadonlyDeclaration[];
  readonly state: CoverageState;
  readonly diagnostics: readonly AnnotationDiagnostic[];
}

export interface AnalysisBudget {
  step(amount?: number): void;
  depth(depth: number): void;
  isCancelled(): boolean;
  /** Total retained base-declaration/traversal/emission work for this analysis. */
  readonly consumedWork: number;
  /** Greatest admitted depth for this plugin. */
  readonly consumedDepth: number;
}

export interface FactEmitter {
  role(subject: string, term: string, evidence: Omit<FactEvidence, 'pluginId'>): boolean;
  property(subject: string, term: string, resolution: ValueResolution, value: FactValue | undefined, evidence: Omit<FactEvidence, 'pluginId'>): boolean;
  relation(subject: string, term: string, target: Reference, evidence: Omit<FactEvidence, 'pluginId'>): boolean;
}

export interface AnnotationPlugin<V extends LanguageView = LanguageView> {
  descriptor: PluginDescriptor;
  analyze(context: { document: Readonly<AnalysisDocument>; view: V; budget: AnalysisBudget }, emitter: FactEmitter): void | {
    state?: CoverageState;
    diagnostics?: AnnotationDiagnostic[];
  };
}

export interface AnnotationEngine<V extends LanguageView = LanguageView> {
  analyze(document: AnalysisDocument, view: V, options?: { cancelled?: () => boolean }): AnnotationResult;
}

function compare(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (difference) return difference;
  }
}

function sortedUnique<T>(items: readonly T[]): T[] {
  const entries = new Map<string, T>();
  for (const item of items) entries.set(canonicalJSON(item), item);
  return [...entries].sort(([a], [b]) => compare(a, b)).map(([, item]) => item);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJSON(value)) as T;
}

// This is an immutable data/method facade, not a sandbox for unreviewed code.
// Query results are copied too, so a retained alias cannot mutate the next plugin.
function readonlySnapshot<T>(value: T): T {
  const immutable = new WeakMap<object, object>();
  let containers = 0;
  let edges = 0;
  const snapshot = (root: unknown, initial = false): unknown => {
    const seen = new Map<object, object>();
    const pending: [object, object][] = [];
    const visit = (item: unknown): unknown => {
      if (item === null || typeof item !== 'object') {
        requireValid(['undefined', 'string', 'number', 'boolean'].includes(typeof item) || item === null, 'Invalid language view value');
        return item;
      }
      const existing = seen.get(item) ?? immutable.get(item);
      if (existing) return existing;
      // A language node commonly has children/fields/tokens containers. These
      // graph bounds are separate from semantic traversal/declaration depth.
      requireValid(++containers <= ANNOTATION_LIMITS.maxWork * 4, 'Language view exceeds container limit');
      const prototype = Object.getPrototypeOf(item);
      requireValid(Array.isArray(item) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, 'Language view must contain plain data');
      const copy: object = Array.isArray(item) ? [] : Object.create(null) as object;
      seen.set(item, copy);
      pending.push([item, copy]);
      return copy;
    };
    const result = visit(root);
    for (let index = 0; index < pending.length; index++) {
      const [item, copy] = pending[index]!;
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        requireValid(++edges <= ANNOTATION_LIMITS.maxWork * 16, 'Language view exceeds edge limit');
        requireValid(typeof key === 'string', 'Invalid language view property');
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        requireValid(property.enumerable && 'value' in property, 'Language view accessors are not supported');
        const entry = property.value as unknown;
        Object.defineProperty(copy, key, {
          enumerable: true,
          value: typeof entry === 'function'
            ? Object.freeze((...args: unknown[]) => snapshot(Reflect.apply(entry, copy, args)))
            : visit(entry),
        });
      }
      Object.freeze(copy);
    }
    for (const [item, copy] of pending) {
      if (initial || Object.isFrozen(item)) immutable.set(item, copy);
    }
    return result;
  };
  return snapshot(value, true) as T;
}

class BudgetStop extends Error {
  readonly diagnostic: AnnotationDiagnostic;
  constructor(resource: string, accounted: number, limit: number) {
    super('Annotation budget exhausted');
    this.diagnostic = { code: 'core.budget-limit', message: `resource=${resource} accounted=${accounted} limit=${limit}` };
  }
}

export function createAnnotationEngine<V extends LanguageView = LanguageView>(options: {
  manifest: AnnotationManifest;
  plugins: readonly AnnotationPlugin<V>[];
  digest: Digest;
}): AnnotationEngine<V> {
  requireValid(typeof options.digest === 'function', 'Digest is required');
  const digest = options.digest;
  validateAnnotationManifest(options.manifest, digest);
  const manifest = readonlySnapshot(clone(options.manifest));
  const limits = manifest.limits;
  requireValid(Array.isArray(options.plugins) && options.plugins.length === manifest.plugins.length, 'Plugin registry mismatch');
  const registry = new Map<string, { descriptor: PluginDescriptor; analyze: AnnotationPlugin<V>['analyze'] }>();
  for (const plugin of options.plugins) {
    const descriptor = manifest.plugins.find(item => item.id === plugin.descriptor.id);
    requireValid(descriptor && canonicalJSON(descriptor) === canonicalJSON(plugin.descriptor), 'Plugin descriptor mismatch');
    requireValid(!registry.has(descriptor.id) && typeof plugin.analyze === 'function', 'Duplicate or invalid plugin');
    registry.set(descriptor.id, Object.freeze({ descriptor, analyze: plugin.analyze }));
  }
  const plugins = [...registry.values()].sort((a, b) => compare(a.descriptor.id, b.descriptor.id));

  return Object.freeze({
    analyze(document: AnalysisDocument, view: V, analyzeOptions?: { cancelled?: () => boolean }): AnnotationResult {
      object(document, ['source', 'sourceHash', 'relativePath', 'language']);
      hash(document.sourceHash);
      relativePath(document.relativePath);
      identifier(document.language, 64);
      const coordinates = sourceCoordinates(document.source, limits.maxSourceBytes);
      requireValid(digest(document.source) === document.sourceHash, 'Source identity mismatch');
      requireValid(view.id === manifest.view.id && view.version === manifest.view.version && view.language === document.language, 'Language view mismatch');
      coverage(view.state);
      requireValid(Array.isArray(view.declarations) && Array.isArray(view.diagnostics), 'Invalid language view');
      if (analyzeOptions !== undefined) {
        object(analyzeOptions, [], ['cancelled']);
        requireValid(analyzeOptions.cancelled === undefined || typeof analyzeOptions.cancelled === 'function', 'Invalid cancellation callback');
      }
      let cancelled = false;
      const isCancelled = (): boolean => {
        cancelled ||= analyzeOptions?.cancelled?.() === true;
        return cancelled;
      };
      let consumedWork = 0;
      let baseTruncated = view.state === 'truncated';
      let baseStop: BudgetStop | undefined;
      let remainingBytes: number;
      let diagnosticCount = 0;
      const result: AnnotationResult = {
        version: 1, analysisSetId: manifest.id, sourceHash: document.sourceHash,
        relativePath: document.relativePath, language: document.language, state: 'not-applicable',
        declarations: [], facts: [], reports: plugins.map(plugin => ({ pluginId: plugin.descriptor.id, state: 'not-applicable', diagnostics: [] })), diagnostics: [],
      };
      // Reserve the longest coverage labels before accepting records. No accepted
      // declaration is later evicted, so owner and fact references remain valid.
      remainingBytes = limits.maxResultBytes - utf8Length(canonicalJSON(result));
      requireValid(remainingBytes >= 0, 'Result limit cannot contain the annotation envelope');
      const retainBytes = (item: unknown, count: number): boolean => {
        const bytes = utf8Length(canonicalJSON(item)) + (count ? 1 : 0);
        if (bytes > remainingBytes) return false;
        remainingBytes -= bytes;
        return true;
      };

      const hardManifest: AnnotationManifest = { ...manifest, limits: { ...limits, maxDeclarations: ANNOTATION_LIMITS.maxDeclarations, maxDepth: ANNOTATION_LIMITS.maxDepth } };
      let known = new Map<string, Declaration>();
      let inventoryExceeded = view.declarations.length > ANNOTATION_LIMITS.maxDeclarations;
      if (inventoryExceeded) baseStop = new BudgetStop('declarations', view.declarations.length, ANNOTATION_LIMITS.maxDeclarations);
      if (!inventoryExceeded) {
        try {
          known = validateDeclarations(clone(view.declarations), hardManifest, coordinates);
        } catch (error) {
          if (!(error instanceof CanonicalLimitError)) throw error;
          inventoryExceeded = true;
        }
      }
      baseTruncated ||= inventoryExceeded;
      for (const declaration of known.values()) declaration.exports.sort(compare);
      const retained = new Map<string, Declaration>();
      for (const declaration of [...known.values()].sort((a, b) => compare(a.key, b.key))) {
        if (retained.has(declaration.key)) continue;
        const chain: Declaration[] = [];
        let current: Declaration | undefined = declaration;
        let depth = 0;
        while (current) {
          depth++;
          if (!retained.has(current.key)) chain.unshift(current);
          current = current.owner === undefined ? undefined : known.get(current.owner);
        }
        const stop = isCancelled() ? new BudgetStop('cancelled', 1, 0)
          : depth > limits.maxDepth ? new BudgetStop('depth', depth, limits.maxDepth)
          : consumedWork + depth > limits.maxWork ? new BudgetStop('work', consumedWork + depth, limits.maxWork)
          : retained.size + chain.length > limits.maxDeclarations ? new BudgetStop('declarations', retained.size + chain.length, limits.maxDeclarations) : undefined;
        if (stop) {
          baseStop ??= stop;
          baseTruncated = true;
          continue;
        }
        consumedWork += depth;
        const bytes = chain.reduce((sum, item) => sum + utf8Length(canonicalJSON(item)) + 1, 0) - (retained.size ? 0 : 1);
        if (bytes > remainingBytes) {
          baseStop ??= new BudgetStop('result-bytes', limits.maxResultBytes - remainingBytes + bytes, limits.maxResultBytes);
          baseTruncated = true;
          continue;
        }
        remainingBytes -= bytes;
        for (const item of chain) retained.set(item.key, item);
      }
      result.declarations = [...retained.values()].sort((a, b) => compare(a.key, b.key));

      const appendDiagnostics = (items: readonly AnnotationDiagnostic[], target: AnnotationDiagnostic[]): boolean => {
        let truncated = items.length > limits.maxDiagnostics;
        for (const item of sortedUnique(items.slice(0, ANNOTATION_LIMITS.maxDiagnostics))) {
          validateDiagnostic(item, manifest, coordinates);
          if (diagnosticCount >= limits.maxDiagnostics || !retainBytes(item, target.length)) {
            truncated = true;
          } else {
            target.push(clone(item));
            diagnosticCount++;
          }
        }
        return truncated;
      };
      const baseDiagnostics = baseStop && utf8Length(baseStop.diagnostic.message) <= limits.maxValueBytes ? [baseStop.diagnostic, ...view.diagnostics] : view.diagnostics;
      baseTruncated = appendDiagnostics(baseDiagnostics, result.diagnostics) || baseTruncated;
      const immutableDocument = readonlySnapshot({ ...document });
      // Build the same facade once, without exposing the mutable result arrays.
      const immutableView = readonlySnapshot({ ...view, declarations: [...retained.values()] }) as V;

      for (let index = 0; index < plugins.length; index++) {
        const plugin = plugins[index]!;
        const report: PluginReport = result.reports[index]!;
        if (!plugin.descriptor.languages.includes(document.language)) continue;
        if (view.state === 'unsupported' || view.state === 'failed' || view.state === 'not-applicable') {
          report.state = view.state;
          continue;
        }
        if (inventoryExceeded) {
          report.state = 'truncated';
          continue;
        }
        let truncated = false;
        let invalid = false;
        let stopped = false;
        let consumedDepth = 0;
        let active = true;
        let stopReason: BudgetStop | undefined;
        const buffer = new Map<string, AnnotationFact>();
        const propertyValues = new Map<string, string>();
        const bytesBefore = remainingBytes;
        // Keep a small diagnostic slot available when accepted facts fill the envelope.
        const reserve = utf8Length(canonicalJSON(new BudgetStop('result-bytes', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).diagnostic)) + 1;
        const reservedBytes = diagnosticCount < limits.maxDiagnostics && remainingBytes >= reserve && limits.maxValueBytes >= reserve ? reserve : 0;
        remainingBytes -= reservedBytes;
        const stop = (resource: string, accounted: number, limit: number): BudgetStop => {
          truncated = true;
          return stopReason ??= new BudgetStop(resource, accounted, limit);
        };
        const budget: AnalysisBudget = Object.freeze({
          step(amount = 1): void {
            integer(amount, 1, Number.MAX_SAFE_INTEGER);
            if (!active || stopped) throw stopReason ?? new BudgetStop('inactive', 1, 0);
            if (isCancelled()) {
              stopped = true;
              throw stop('cancelled', 1, 0);
            }
            if (consumedWork + amount > limits.maxWork) {
              stopped = true;
              throw stop('work', consumedWork + amount, limits.maxWork);
            }
            consumedWork += amount;
          },
          depth(depth: number): void {
            integer(depth, 0, Number.MAX_SAFE_INTEGER);
            budget.step();
            if (depth > limits.maxDepth) {
              stopped = true;
              throw stop('depth', depth, limits.maxDepth);
            }
            consumedDepth = Math.max(consumedDepth, depth);
          },
          isCancelled(): boolean {
            if (!active || isCancelled()) {
              stopped = true;
              stop('cancelled', 1, 0);
              return true;
            }
            return false;
          },
          get consumedWork(): number { return consumedWork; },
          get consumedDepth(): number { return consumedDepth; },
        });
        const emit = (data: Omit<AnnotationFact, 'evidence'> & Record<string, unknown>, evidence: Omit<FactEvidence, 'pluginId'>): boolean => {
          if (!active || invalid) return false;
          budget.step();
          try {
            object(evidence, ['ruleId', 'basis', 'span']);
            const candidate = { ...data, evidence: { ...evidence, pluginId: plugin.descriptor.id } };
            validateFact(candidate, plugin.descriptor, manifest, known, coordinates);
            const fact = clone(candidate);
            checkCardinality(fact, plugin.descriptor.properties.find(term => term.id === fact.term), propertyValues);
            const target = fact.kind === 'relation' ? fact.target : fact.kind === 'property' && fact.value?.kind === 'reference' ? fact.value.value : undefined;
            if (!retained.has(fact.subject) || (target?.kind === 'declaration' && !retained.has(target.key))) {
              stop('retained-declarations', known.size, retained.size);
              return false;
            }
            const key = canonicalJSON(fact);
            if (buffer.has(key)) return true;
            const count = result.facts.length + buffer.size;
            if (count >= limits.maxFacts) {
              stop('facts', count + 1, limits.maxFacts);
              return false;
            }
            const bytes = utf8Length(key) + (count ? 1 : 0);
            if (bytes > remainingBytes) {
              stop('result-bytes', limits.maxResultBytes - remainingBytes + bytes, limits.maxResultBytes);
              return false;
            }
            remainingBytes -= bytes;
            buffer.set(key, fact);
            return true;
          } catch {
            invalid = true;
            return false;
          }
        };
        const emitter: FactEmitter = Object.freeze<FactEmitter>({
          role: (subject, term, evidence) => emit({ kind: 'role', subject, term }, evidence),
          property: (subject, term, resolution, value, evidence) => emit(value === undefined
            ? { kind: 'property', subject, term, resolution }
            : { kind: 'property', subject, term, resolution, value }, evidence),
          relation: (subject, term, target, evidence) => emit({ kind: 'relation', subject, term, target }, evidence),
        });
        let diagnostics: AnnotationDiagnostic[] = [];
        try {
          budget.step();
          const outcome = plugin.analyze(Object.freeze({ document: immutableDocument, view: immutableView, budget }), emitter);
          if (outcome !== undefined) {
            object(outcome, [], ['state', 'diagnostics']);
            if (outcome.state !== undefined) coverage(outcome.state);
            if (outcome.diagnostics !== undefined) {
              requireValid(Array.isArray(outcome.diagnostics), 'Invalid plugin diagnostics');
              diagnostics = clone(outcome.diagnostics.slice(0, ANNOTATION_LIMITS.maxDiagnostics));
              truncated ||= outcome.diagnostics.length > limits.maxDiagnostics;
              for (const item of diagnostics) validateDiagnostic(item, manifest, coordinates);
            }
          }
          report.state = outcome?.state ?? (buffer.size ? 'complete' : 'not-applicable');
          if (report.state === 'failed' || (buffer.size && ['not-applicable', 'unsupported'].includes(report.state))) invalid = true;
        } catch (error) {
          if (error instanceof BudgetStop) { truncated = true; stopReason ??= error; }
          else invalid = true;
        } finally {
          active = false;
        }
        if (invalid) {
          remainingBytes = bytesBefore;
          report.state = 'failed';
          diagnostics = [{ code: 'plugin-failed', message: 'Plugin analysis failed.' }];
          // The coverage flag remains authoritative even with a one-byte value cap.
          if (utf8Length(diagnostics[0]!.message) > limits.maxValueBytes) diagnostics = [];
        } else {
          remainingBytes += reservedBytes;
          if (truncated) report.state = 'truncated';
          result.facts.push(...buffer.values());
          if (stopReason && utf8Length(stopReason.diagnostic.message) <= limits.maxValueBytes) {
            appendDiagnostics([stopReason.diagnostic], report.diagnostics);
          }
        }
        if (appendDiagnostics(diagnostics, report.diagnostics) && report.state !== 'failed') report.state = 'truncated';
      }

      result.facts = sortedUnique(result.facts);
      if (view.state === 'unsupported' || view.state === 'failed') result.state = view.state;
      else if (result.reports.some(report => report.state === 'failed') || view.state === 'partial') result.state = 'partial';
      else if (baseTruncated || cancelled || result.reports.some(report => report.state === 'truncated')) result.state = 'truncated';
      else if (result.reports.some(report => report.state === 'partial' || report.state === 'unsupported')) result.state = 'partial';
      else result.state = view.state === 'not-applicable' ? 'not-applicable' : 'complete';
      validateAnnotationResult(result, manifest, document.source);
      return result;
    },
  });
}
