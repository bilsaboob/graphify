export const ANNOTATION_VERSION = 1 as const;

export const ANNOTATION_LIMITS = Object.freeze({
  maxSourceBytes: 256 * 1024,
  maxDeclarations: 2048,
  maxFacts: 4096,
  maxDiagnostics: 32,
  maxResultBytes: 8 * 1024 * 1024,
  maxManifestBytes: 64 * 1024,
  maxPlugins: 8,
  maxWork: 2_000_000,
  maxDepth: 128,
  maxValueBytes: 256 * 1024,
});

export type AnnotationLimits = { [Key in keyof typeof ANNOTATION_LIMITS]: number };
export type CoverageState = 'complete' | 'not-applicable' | 'partial' | 'unsupported' | 'truncated' | 'failed';
export type EvidenceBasis = 'syntax' | 'import-bound' | 'convention';
export type ValueResolution = 'literal' | 'constant' | 'expression' | 'absent';

export interface SourceSpan {
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

export interface Declaration {
  key: string;
  kind: string;
  name?: string;
  owner?: string;
  span: SourceSpan;
  nameSpan?: SourceSpan;
  exports: string[];
  /** Source operations only, never proof of the resulting value or identity. */
  binding?: BindingOperationDescriptor;
  writes?: BindingOperationDescriptor[];
  /** Computed identity is not a string-named property. */
  computedName?: Extract<Reference, { kind: 'expression' }>;
}

export type BindingKey = string | Extract<Reference, { kind: 'expression' }>;
/** Ordered source extraction steps. A default runs only for undefined; reads,
 * iteration and rest copies may invoke user code or fail at runtime. */
export type BindingOperation =
  | { kind: 'property'; span: SourceSpan; key: string }
  | { kind: 'computed-property'; span: SourceSpan; key: Extract<Reference, { kind: 'expression' }> }
  | { kind: 'iterator' | 'iterator-rest'; span: SourceSpan; index: number }
  | { kind: 'default'; span: SourceSpan; value: Extract<Reference, { kind: 'expression' }> }
  | { kind: 'object-rest'; span: SourceSpan; excludedKeys: BindingKey[] };

/** Fresh literal alternatives, conditional on normal completion. Tuple length does
 * not prove an element exists or that iteration uses the built-in iterator. */
export type BindingShape =
  | { kind: 'object'; span: SourceSpan; keys: string[] }
  | { kind: 'tuple'; span: SourceSpan; length: number };

export interface BindingOperationDescriptor {
  source: Extract<Reference, { kind: 'expression' }>;
  sourceSpan: SourceSpan;
  patternSpan: SourceSpan;
  operations: BindingOperation[];
  /** No runtime value, getter, iterator, default branch or purity is asserted. */
  value: 'unknown';
  /** Shapes of the source before extraction, not shapes of the bound value. */
  shapes?: BindingShape[];
}

export interface VocabularyTerm {
  id: string;
  label: string;
  description?: string;
}

export interface PropertyTerm extends VocabularyTerm {
  valueKind: 'string' | 'boolean' | 'integer' | 'reference';
  multiple: boolean;
}

export interface PluginDescriptor {
  id: string;
  version: string;
  implementationDigest: string;
  configurationDigest: string;
  languages: string[];
  view: { id: string; version: number };
  roles: VocabularyTerm[];
  properties: PropertyTerm[];
  relations: VocabularyTerm[];
}

export interface AnnotationManifest {
  version: typeof ANNOTATION_VERSION;
  id: string;
  core: { version: string; implementationDigest: string; configurationDigest?: string };
  view: { id: string; version: number; implementationDigest: string; configurationDigest?: string };
  parserDigest: string;
  plugins: PluginDescriptor[];
  limits: AnnotationLimits;
}

export type Reference =
  | { kind: 'declaration'; key: string }
  | { kind: 'import'; module: string; name: string; member?: string }
  | { kind: 'expression'; text: string; span: SourceSpan }
  | { kind: 'type'; text: string; span: SourceSpan };

export type FactValue =
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer'; value: number }
  | { kind: 'reference'; value: Reference };

export interface FactEvidence {
  pluginId: string;
  ruleId: string;
  basis: EvidenceBasis;
  span: SourceSpan;
}

interface FactBase {
  subject: string;
  term: string;
  evidence: FactEvidence;
}

export type AnnotationFact =
  | (FactBase & { kind: 'role' })
  | (FactBase & { kind: 'property'; resolution: ValueResolution; value?: FactValue })
  | (FactBase & { kind: 'relation'; target: Reference });

export interface AnnotationDiagnostic {
  code: string;
  message: string;
  span?: SourceSpan;
}

export interface PluginReport {
  pluginId: string;
  state: CoverageState;
  diagnostics: AnnotationDiagnostic[];
}

export interface AnnotationResult {
  version: typeof ANNOTATION_VERSION;
  analysisSetId: string;
  sourceHash: string;
  relativePath: string;
  language: string;
  state: CoverageState;
  declarations: Declaration[];
  facts: AnnotationFact[];
  reports: PluginReport[];
  diagnostics: AnnotationDiagnostic[];
}

export type Digest = (input: string | Uint8Array) => string;

export { canonicalJSON } from './canonical.js';
export { validateAnnotationManifest, validateAnnotationResult, validateBindingOperationDescriptor } from './validation.js';
