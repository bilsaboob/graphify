import { ANNOTATION_LIMITS } from '#core/wire';
import { integer, object, requireValid, sourceCoordinates } from '#core/validation';

export const SYNTAX_LIMITS = Object.freeze({ maxNodes: 100_000, maxDepth: 256 });
export interface Point { readonly row: number; readonly column: number }

/** Protocol v1 root encoding. Include anonymous tokens and null field names.
 * All indices and columns are UTF-16 code units; rows and columns are zero-based.
 * Source text is supplied once, outside the tree, and is never normalized. */
export interface EncodedNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: Point;
  endPosition: Point;
  hasError: boolean;
  isMissing: boolean;
  isNamed: boolean;
  children: { field: string | null; node: EncodedNode }[];
}

export interface SourceNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: Point;
  readonly endPosition: Point;
  readonly text: string;
  readonly hasError: boolean;
  readonly isMissing: boolean;
  readonly isNamed: boolean;
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly children: readonly SourceNode[];
  readonly namedChildren: readonly SourceNode[];
  readonly parent: SourceNode | null;
  readonly previousSibling: SourceNode | null;
  readonly nextSibling: SourceNode | null;
  readonly previousNamedSibling: SourceNode | null;
  readonly nextNamedSibling: SourceNode | null;
  child(index: number): SourceNode | null;
  namedChild(index: number): SourceNode | null;
  childForFieldName(name: string): SourceNode | null;
  fieldNameForChild(index: number): string | null;
}
export interface SourceTree { readonly rootNode: SourceNode }

interface Child { field: string | null; node: DetachedNode }
class DetachedNode implements SourceNode {
  readonly #source: string;
  readonly #entries: Child[];
  hasError: boolean;
  parent: DetachedNode | null = null;
  previousSibling: DetachedNode | null = null;
  nextSibling: DetachedNode | null = null;
  previousNamedSibling: DetachedNode | null = null;
  nextNamedSibling: DetachedNode | null = null;
  children: readonly DetachedNode[] = [];
  namedChildren: readonly DetachedNode[] = [];
  constructor(
    readonly type: string, readonly startIndex: number, readonly endIndex: number,
    readonly startPosition: Point, readonly endPosition: Point,
    readonly isNamed: boolean, readonly isMissing: boolean, hasError: boolean,
    source: string, entries: Child[],
  ) {
    this.#source = source;
    this.#entries = entries;
    this.hasError = hasError || isMissing || type === 'ERROR';
  }
  get text(): string { return this.#source.slice(this.startIndex, this.endIndex); }
  get childCount(): number { return this.children.length; }
  get namedChildCount(): number { return this.namedChildren.length; }
  child(index: number): SourceNode | null { return this.children[index] ?? null; }
  namedChild(index: number): SourceNode | null { return this.namedChildren[index] ?? null; }
  childForFieldName(name: string): SourceNode | null { return this.#entries.find(child => child.field === name)?.node ?? null; }
  fieldNameForChild(index: number): string | null { return this.#entries[index]?.field ?? null; }
}

/** Validate before exposing any methods. No parser, filesystem, execution or edit capability. */
export function decodeTree(raw: unknown, source: string, limits: { maxNodes?: number; maxDepth?: number } = {}): SourceTree {
  sourceCoordinates(source, ANNOTATION_LIMITS.maxSourceBytes);
  const maxNodes = limits.maxNodes ?? SYNTAX_LIMITS.maxNodes;
  const maxDepth = limits.maxDepth ?? SYNTAX_LIMITS.maxDepth;
  integer(maxNodes, 1, SYNTAX_LIMITS.maxNodes);
  integer(maxDepth, 1, SYNTAX_LIMITS.maxDepth);
  const lines = [0];
  for (let index = 0; index < source.length; index++) if (source.charCodeAt(index) === 10) lines.push(index + 1);
  const point = (input: unknown, index: number): Point => {
    const value = object(input, ['row', 'column']);
    integer(value.row, 0, lines.length - 1);
    integer(value.column, 0, source.length);
    let low = 0, high = lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle]! <= index) low = middle; else high = middle;
    }
    requireValid(value.row === low && value.column === index - lines[low]!, 'Syntax point does not match source');
    const before = source.charCodeAt(index - 1), at = source.charCodeAt(index);
    requireValid(!(before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff), 'Syntax span splits UTF-16 character');
    return Object.freeze({ row: value.row, column: value.column });
  };
  const seen = new Set<object>();
  const pending: { raw: unknown; node: DetachedNode; entries: Child[]; depth: number }[] = [];
  const create = (input: unknown, depth: number): DetachedNode => {
    requireValid(depth <= maxDepth, 'Syntax depth limit exceeded');
    requireValid(pending.length < maxNodes, 'Syntax node limit exceeded');
    const value = object(input, ['type', 'startIndex', 'endIndex', 'startPosition', 'endPosition', 'hasError', 'isMissing', 'isNamed', 'children']);
    requireValid(!seen.has(value), 'Cyclic or shared syntax node');
    seen.add(value);
    requireValid(typeof value.type === 'string' && /^[\x20-\x7e]{1,128}$/.test(value.type), 'Invalid syntax type');
    integer(value.startIndex, 0, source.length);
    integer(value.endIndex, value.startIndex, source.length);
    for (const key of ['hasError', 'isMissing', 'isNamed']) requireValid(typeof value[key] === 'boolean', 'Invalid syntax flags');
    requireValid(!value.isMissing || value.startIndex === value.endIndex, 'Missing syntax node has source text');
    requireValid(Array.isArray(value.children) && value.children.length <= maxNodes, 'Invalid syntax children');
    const entries: Child[] = [];
    const node = new DetachedNode(value.type, value.startIndex, value.endIndex,
      point(value.startPosition, value.startIndex), point(value.endPosition, value.endIndex),
      value.isNamed as boolean, value.isMissing as boolean, value.hasError as boolean, source, entries);
    pending.push({ raw: value.children, node, entries, depth });
    return node;
  };
  const rootNode = create(raw, 0);
  requireValid(rootNode.type === 'program' && rootNode.isNamed, 'Unsupported syntax root');
  requireValid(/^\s*$/u.test(source.slice(0, rootNode.startIndex)) && /^\s*$/u.test(source.slice(rootNode.endIndex)), 'Syntax root omits source');
  for (let index = 0; index < pending.length; index++) {
    const { raw: children, node, entries, depth } = pending[index]!;
    let previous: DetachedNode | null = null, previousNamed: DetachedNode | null = null;
    for (const entry of children as unknown[]) {
      const child = object(entry, ['field', 'node']);
      requireValid(child.field === null || typeof child.field === 'string' && /^[a-z_][a-z0-9_]{0,127}$/.test(child.field), 'Invalid syntax field');
      const next = create(child.node, depth + 1);
      requireValid(next.startIndex >= (previous?.endIndex ?? node.startIndex) && next.endIndex <= node.endIndex, 'Unordered or out-of-parent syntax span');
      next.parent = node;
      next.previousSibling = previous;
      next.previousNamedSibling = previousNamed;
      if (previous) previous.nextSibling = next;
      if (next.isNamed) {
        if (previousNamed) previousNamed.nextNamedSibling = next;
        previousNamed = next;
      }
      previous = next;
      entries.push(Object.freeze({ field: child.field as string | null, node: next }));
    }
    let nextNamed: DetachedNode | null = null;
    for (let index = entries.length - 1; index >= 0; index--) {
      const child = entries[index]!.node;
      child.nextNamedSibling = nextNamed;
      if (child.isNamed) nextNamed = child;
    }
    node.children = Object.freeze(entries.map(child => child.node));
    node.namedChildren = Object.freeze(node.children.filter(child => child.isNamed));
    Object.freeze(entries);
  }
  for (let index = pending.length - 1; index >= 0; index--) {
    const node = pending[index]!.node;
    node.hasError ||= node.children.some(child => child.hasError);
    Object.freeze(node);
  }
  return Object.freeze({ rootNode });
}
