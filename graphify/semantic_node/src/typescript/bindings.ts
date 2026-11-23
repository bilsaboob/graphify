import { canonicalJSON } from '#core/wire';
import type { AnnotationLimits, BindingKey, BindingOperation, BindingOperationDescriptor, BindingShape, Reference, SourceSpan } from '#core/wire';
import type { LexicalBinding, SyntaxNode } from './types.js';

interface Queries {
  limits: AnnotationLimits;
  text(node: SyntaxNode): string;
  name(node: SyntaxNode): string | undefined;
  span(node: SyntaxNode): SourceSpan;
  unwrap(node: SyntaxNode): SyntaxNode;
  binding(node: SyntaxNode): LexicalBinding | undefined;
  elements(node: SyntaxNode): readonly (SyntaxNode | null)[];
  stableObject(node: SyntaxNode, observation: SyntaxNode): boolean;
  step(): boolean;
}

/** This lane records evaluation operations, not values. It must never feed the
 * identity/constant projection lane, even when all syntax was retained. */
export function createBindingQueries(query: Queries) {
  const { limits, unwrap, name, span, text } = query;
  const maxWork = Math.min(limits.maxWork, 512), maxDepth = Math.min(limits.maxDepth, 24);
  const byteLength = (value: string) => {
    let bytes = 0;
    for (const point of value) { const n = point.codePointAt(0)!; bytes += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4; }
    return bytes;
  };
  const validText = (value: string) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  const expression = (node: SyntaxNode): Extract<Reference, { kind: 'expression' }> => ({ kind: 'expression', text: text(node), span: span(node) });
  const staticKey = (node: SyntaxNode): string | undefined => {
    if (node.type === 'number') {
      const value = Number(text(node).replaceAll('_', ''));
      return Number.isFinite(value) ? String(value) : undefined;
    }
    if (node.type === 'computed_property_name') {
      const value = node.children.find(child => child.type !== 'comment');
      return value && ['string', 'number'].includes(unwrap(value).type) ? staticKey(unwrap(value)) : undefined;
    }
    const value = name(node);
    return value !== undefined && byteLength(value) <= 2048 && validText(value) ? value : undefined;
  };
  const key = (node: SyntaxNode): BindingKey | undefined => {
    const literal = staticKey(node);
    if (literal !== undefined) return literal;
    const value = node.type === 'computed_property_name' && node.children.find(child => child.type !== 'comment');
    return value ? expression(value) : undefined;
  };
  const fits = (value: unknown) => {
    const valid = (item: unknown): boolean => typeof item === 'string' ? validText(item)
      : !item || typeof item !== 'object' || Object.values(item).every(valid);
    try { return valid(value) && byteLength(canonicalJSON(value)) <= limits.maxValueBytes; }
    catch { return false; }
  };
  const shapes = (input: SyntaxNode): BindingShape[] | undefined => {
    let work = 0;
    const active = new Set<SyntaxNode>();
    const step = (depth: number) => ++work <= maxWork && depth <= maxDepth && query.step();
    const merge = (left: BindingShape[] | undefined, right: BindingShape[] | undefined) =>
      left && right && left.length + right.length <= 16 ? [...left, ...right] : undefined;
    const visit = (inputNode: SyntaxNode, depth: number, observation: SyntaxNode): BindingShape[] | undefined => {
      if (!step(depth)) return undefined;
      const node = unwrap(inputNode);
      const observed = node.startIndex > observation.startIndex ? node : observation;
      if (active.has(node)) return undefined;
      active.add(node);
      try {
        if (node.type === 'array') {
          const elements = query.elements(node);
          return elements.length <= 64 && elements.every(item => item?.type !== 'spread_element')
            ? [{ kind: 'tuple', span: span(node), length: elements.length }] : undefined;
        }
        if (node.type === 'object') {
          const keys: string[] = [];
          for (const child of node.children) {
            if (!step(depth + 1)) return undefined;
            if (child.type === 'comment') continue;
            const property = child.type === 'shorthand_property_identifier' ? staticKey(child)
              : child.type === 'pair' && child.fields.key ? staticKey(child.fields.key) : undefined;
            if (property === undefined || property === '__proto__') return undefined;
            if (!keys.includes(property)) keys.push(property);
            if (keys.length > 64) return undefined;
          }
          return [{ kind: 'object', span: span(node), keys }];
        }
        if (node.type === 'ternary_expression' && node.fields.consequence && node.fields.alternative) {
          return merge(visit(node.fields.consequence, depth + 1, observed), visit(node.fields.alternative, depth + 1, observed));
        }
        if (node.type === 'identifier') {
          const binding = query.binding(node);
          if (binding?.kind === 'const' && binding.stable && binding.available && !binding.typeOnly && binding.initializer && query.stableObject(node, observed)) {
            return visit(binding.initializer, depth + 1, observed);
          }
        }
        if (node.type === 'call_expression' && node.fields.function && !node.tokens.includes('?.')) {
          const callable = (input: SyntaxNode, depth: number): SyntaxNode | undefined => {
            if (!step(depth)) return undefined;
            const value = unwrap(input);
            if (['function_declaration', 'function_expression', 'arrow_function'].includes(value.type)) return value;
            const binding = value.type === 'identifier' && query.binding(value);
            if (!binding || !binding.available || !binding.stable || binding.typeOnly) return undefined;
            if (binding.kind === 'function') return binding.node;
            if (binding.kind === 'const' && binding.initializer) return callable(binding.initializer, depth + 1);
            return undefined;
          };
          const fn = callable(node.fields.function, depth + 1), body = fn?.fields.body;
          if (!fn || !body || fn.tokens.includes('async') || fn.tokens.includes('*')) return undefined;
          if (body.type !== 'statement_block') return visit(body, depth + 1, body);
          // Every normal exit must return a supported fresh shape. Calls and
          // throws are not executed or assumed pure; finally/loop control is not summarized.
          const returns: BindingShape[] = [];
          let valid = true;
          const flow = (statement: SyntaxNode, depth: number): boolean => {
            if (!step(depth)) { valid = false; return false; }
            if (statement.type === 'return_statement') {
              const value = statement.children.find(child => child.type !== 'comment');
              const result = value && visit(value, depth + 1, value);
              if (!result || returns.length + result.length > 16) valid = false;
              else returns.push(...result);
              return true;
            }
            if (statement.type === 'throw_statement') return true;
            if (statement.type === 'statement_block') {
              for (const child of statement.children) if (flow(child, depth + 1)) return true;
              return false;
            }
            if (statement.type === 'if_statement' && statement.fields.consequence) {
              const left = flow(statement.fields.consequence, depth + 1);
              const alternative = statement.fields.alternative;
              const right = alternative ? flow(alternative, depth + 1) : false;
              return left && right;
            }
            if (statement.type === 'else_clause') {
              const child = statement.children.find(child => child.type !== 'comment');
              return child ? flow(child, depth + 1) : false;
            }
            if (['function_declaration', 'class_declaration', 'comment', 'empty_statement'].includes(statement.type)) return false;
            // Traverse ordinary statements only to detect unmodelled exits. Do
            // not collect returns from nested callbacks, methods or classes.
            const inspect = (child: SyntaxNode, depth: number) => {
              if (!step(depth)) { valid = false; return; }
              if (['function_expression', 'arrow_function', 'function_declaration', 'method_definition', 'class', 'class_declaration'].includes(child.type)) return;
              if (['return_statement', 'try_statement', 'yield_expression'].includes(child.type)) { valid = false; return; }
              for (const nested of child.children) inspect(nested, depth + 1);
            };
            inspect(statement, depth + 1);
            return false;
          };
          const terminates = flow(body, depth + 1);
          return valid && terminates && returns.length ? returns : undefined;
        }
        return undefined;
      } finally { active.delete(node); }
    };
    return visit(input, 0, input);
  };
  const pattern = (input: SyntaxNode, source: SyntaxNode) => {
    let work = 0, complete = true;
    const bindings: { node: SyntaxNode; evidence: BindingOperationDescriptor }[] = [];
    const alternatives = shapes(source);
    const visit = (inputNode: SyntaxNode, operations: BindingOperation[], depth: number) => {
      if (++work > maxWork || depth > maxDepth || operations.length > maxDepth || !query.step()) { complete = false; return; }
      const node = unwrap(inputNode);
      if (['identifier', 'undefined', 'shorthand_property_identifier_pattern'].includes(node.type)) {
        const evidence: BindingOperationDescriptor = { source: expression(source), sourceSpan: span(source), patternSpan: span(input), operations, value: 'unknown', ...(alternatives ? { shapes: alternatives } : {}) };
        if (!operations.length || !fits(evidence)) { complete = false; return; }
        bindings.push({ node, evidence }); return;
      }
      if (['assignment_pattern', 'object_assignment_pattern'].includes(node.type)) {
        const left = node.fields.left ?? node.children[0], right = node.fields.right ?? node.children.at(-1);
        if (!left || !right || left === right) { complete = false; return; }
        visit(left, [...operations, { kind: 'default', span: span(node), value: expression(right) }], depth + 1); return;
      }
      if (node.type === 'array_pattern') {
        const items = query.elements(node);
        for (let index = 0; index < items.length; index++) {
          if (++work > maxWork || !query.step()) { complete = false; break; }
          const item = items[index];
          if (!item) continue;
          const rest = item.type === 'rest_pattern', target = rest ? item.children.find(child => child.type !== 'comment') : item;
          if (!target || rest && index !== items.length - 1) { complete = false; continue; }
          visit(target, [...operations, { kind: rest ? 'iterator-rest' : 'iterator', span: span(item), index }], depth + 1);
        }
        return;
      }
      if (node.type === 'object_pattern') {
        const excludedKeys: BindingKey[] = [];
        for (const item of node.children) {
          if (++work > maxWork || !query.step()) { complete = false; break; }
          if (item.type === 'comment') continue;
          if (item.type === 'rest_pattern') {
            const target = item.children.find(child => child.type !== 'comment');
            if (!target || excludedKeys.length > 64) complete = false;
            else visit(target, [...operations, { kind: 'object-rest', span: span(item), excludedKeys: [...excludedKeys] }], depth + 1);
            continue;
          }
          const keyNode = item.type === 'pair_pattern' ? item.fields.key : item.type === 'object_assignment_pattern' ? item.fields.left ?? item.children[0] : item;
          const property = keyNode && key(keyNode);
          const target = item.type === 'pair_pattern' ? item.fields.value : item;
          if (property === undefined || !target) { complete = false; continue; }
          excludedKeys.push(property);
          visit(target, [...operations, typeof property === 'string' ? { kind: 'property', span: span(item), key: property } : { kind: 'computed-property', span: span(item), key: property }], depth + 1);
        }
        return;
      }
      complete = false;
    };
    visit(input, [], 0);
    return { complete: complete && bindings.length > 0, bindings };
  };
  return { pattern };
}
