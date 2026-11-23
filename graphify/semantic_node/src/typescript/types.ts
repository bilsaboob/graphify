import type { LanguageView, ReadonlyDeclaration } from '#core';
import type { AnnotationLimits, Reference, SourceSpan } from '#core/wire';
import type { ModuleAliases } from './module-aliases.js';

/** Structural input for the caller-supplied, qualified TypeScript syntax snapshot.
 * Indices are UTF-16 code units. The adapter never retains or exposes this object. */
export interface TreeSitterNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly hasError: boolean;
  readonly isMissing: boolean;
  readonly isNamed: boolean;
  readonly childCount: number;
  child(index: number): TreeSitterNode | null;
  fieldNameForChild(index: number): string | null;
}

/** Detached, deeply frozen syntax. No parser, tree, edit, delete or I/O capability. */
export interface SyntaxNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly children: readonly SyntaxNode[];
  readonly fields: { readonly [name: string]: SyntaxNode | undefined; readonly constructor?: SyntaxNode };
  readonly tokens: readonly string[];
}

export interface TypeScriptViewOptions {
  tree: { readonly rootNode: TreeSitterNode } | TreeSitterNode;
  source: string;
  language: 'typescript' | 'tsx';
  relativePath: string;
  sourceHash: string;
  limits?: Partial<AnnotationLimits>;
  cancelled?: () => boolean;
  /** Reviewed plugin metadata, composed before constructing the language view. */
  returnContracts?: readonly ReturnContract[];
  /** Explicit caller-declared library compatibility, never package resolution. */
  moduleAliases?: ModuleAliases;
}

export type ProjectionKey = string | number;
export type ReturnShape =
  | { readonly kind: 'value' }
  | { readonly kind: 'tuple'; readonly items: readonly ReturnShape[] }
  | { readonly kind: 'object'; readonly properties: Readonly<Record<string, ReturnShape>> }
  | { readonly kind: 'record'; readonly value: ReturnShape }
  | { readonly kind: 'key-partitions'; readonly sourceArgument: number; readonly keysFromArgument: number };

/** Exact import identities only; no package execution or path-suffix matching. */
export interface ReturnContract {
  readonly id: string;
  readonly invocation?: 'call' | 'construct';
  readonly origins: readonly { readonly module: string; readonly name: string }[];
  readonly result: ReturnShape;
  /** Reviewed uses preserve this returned handle's member identity only. They do
   * not establish purity, returned values, contents, or arbitrary object safety.
   * The listed factory/consumer calls also preserve their canonical import
   * namespace's API identities; no other namespace calls are covered. */
  readonly identityObservations?: {
    readonly factoryArities: readonly number[];
    readonly uses: readonly (
      | { readonly kind: 'receiver-call'; readonly member: string; readonly arity: number }
      | { readonly kind: 'call-argument'; readonly origins: readonly { readonly module: string; readonly name: string }[]; readonly index: number; readonly arity: number }
      | { readonly kind: 'jsx-member'; readonly member: string }
    )[];
  };
}

export interface PatternProjection {
  readonly node: SyntaxNode;
  readonly path: readonly ProjectionKey[];
}
export interface PatternProjections {
  readonly complete: boolean;
  readonly projections: readonly PatternProjection[];
}
export interface InitializerProjection {
  /** Original initializer and static binding path, even when not proven complete. */
  readonly initializer: SyntaxNode;
  readonly path: readonly ProjectionKey[];
  /** Strong projection eligibility, never implied by structural binding evidence. */
  readonly complete: boolean;
}
export interface ValueProjection extends InitializerProjection {
  readonly contract?: string;
  readonly partitions?: {
    readonly source: SyntaxNode;
    /** Explicit, disjoint key groups; the final tuple slot is their remainder. */
    readonly keys: readonly (readonly string[])[];
  };
}

export interface LexicalBinding {
  readonly name: string;
  readonly kind: 'import' | 'const' | 'let' | 'var' | 'function' | 'class' | 'type' | 'parameter';
  readonly node: SyntaxNode;
  readonly declaration?: string;
  readonly initializer?: SyntaxNode;
  readonly origin?: Extract<Reference, { kind: 'import' }>;
  readonly typeOnly: boolean;
  readonly available: boolean;
  readonly stable: boolean;
}

export type ConstantResult =
  | { readonly known: false; readonly reason: string }
  | { readonly known: true; readonly resolution: 'literal' | 'constant'; readonly value: string | number | boolean | null | undefined }
  | { readonly known: true; readonly resolution: 'constant'; readonly value: ConstantObject };

export interface ConstantObject {
  readonly kind: 'object';
  readonly properties: Readonly<Record<string, ConstantResult>>;
  readonly unknownKeys: boolean;
}

export interface TypeScriptView extends LanguageView {
  readonly id: 'typescript';
  readonly version: 1;
  readonly language: 'typescript' | 'tsx';
  readonly relativePath: string;
  readonly sourceHash: string;
  readonly source: string;
  readonly limits: Readonly<AnnotationLimits>;
  readonly root: SyntaxNode;
  /** Source-ordered inventory, including calls/types without embedding chunks. */
  readonly nodes: readonly SyntaxNode[];
  /** Exact source, never normalized. */
  text(node: SyntaxNode): string;
  /** Static identifier/property name with Unicode escapes decoded, not source text. */
  name(node: SyntaxNode): string | undefined;
  /** Canonical identity of a static import/export source string only. */
  moduleIdentity(node: SyntaxNode): string | undefined;
  /** UTF-8 half-open byte bounds; inclusive one-based display lines. */
  span(node: SyntaxNode): SourceSpan;
  parent(node: SyntaxNode): SyntaxNode | undefined;
  unwrap(node: SyntaxNode): SyntaxNode;
  declarationNode(key: string): SyntaxNode | undefined;
  declarationAt(node: SyntaxNode): ReadonlyDeclaration | undefined;
  /** Nearest lexical declaration; an anonymous callback is not a public symbol. */
  owner(node: SyntaxNode): ReadonlyDeclaration | undefined;
  /** Lexical resolution includes TDZ/hoisted shadowing, never project resolution. */
  binding(node: SyntaxNode, space?: 'value' | 'type'): LexicalBinding | undefined;
  /** Follows supported immutable aliases; imports remain unresolved cross-file references. */
  resolve(node: SyntaxNode, space?: 'value' | 'type'): Reference;
  /** Keeps a named local declaration distinct from its initializer. */
  reference(node: SyntaxNode, space?: 'value' | 'type'): Reference;
  /** Static pattern syntax, independent of an initializer. Holes retain their indices. */
  patternProjections(node: SyntaxNode): PatternProjections;
  /** Raw declaration provenance. Incomplete/unstable projections must not justify facts. */
  initializerProjection(key: string): InitializerProjection | undefined;
  /** Proven normalized projection through literals, contracts and immutable aliases. */
  project(node: SyntaxNode, path?: readonly ProjectionKey[]): ValueProjection | undefined;
  /** Checks tracked reference/member stability, not just immutable callable identity. */
  referenceStable(node: SyntaxNode, observation: SyntaxNode, timing?: 'start' | 'before-call'): boolean;
  /** Bounded safe primitives/templates/objects only; never executes expressions. */
  constant(node: SyntaxNode): ConstantResult;
  constantProperty(node: SyntaxNode, key: string): ConstantResult;
}
