import type { AnnotationLimits } from '#core/wire';
import type { ConstantObject, ConstantResult, LexicalBinding, SyntaxNode, ValueProjection } from './types.js';

const unknown = (reason: string): ConstantResult => Object.freeze({ known: false, reason });
const primitive = (value: string | number | boolean | null | undefined, resolution: 'literal' | 'constant' = 'literal'): ConstantResult => Object.freeze({ known: true, value, resolution });

/** Decode source literals without eval, Function, JSON coercion or user-defined hooks. */
export function decodeString(text: string): string | undefined {
  const quote = text[0];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || text.at(-1) !== quote) return undefined;
  return decodeFragment(text.slice(1, -1));
}
export function decodeIdentifier(text: string): string {
  return text.includes('\\') ? decodeString(`"${text}"`) ?? text : text;
}
function decodeFragment(text: string): string | undefined {
  let value = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== '\\') { value += c === '\r' ? (text[i + 1] === '\n' ? (i++, '\n') : '\n') : c; continue; }
    const next = text[++i];
    if (next === undefined) return undefined;
    if (next === '\n') continue;
    if (next === '\r') { if (text[i + 1] === '\n') i++; continue; }
    const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    if (Object.hasOwn(simple, next)) {
      if (next === '0' && /[0-9]/.test(text[i + 1] ?? '')) return undefined;
      value += simple[next]; continue;
    }
    if (/[1-9]/.test(next)) return undefined;
    if (next === 'x' || next === 'u') {
      const braced = next === 'u' && text[i + 1] === '{';
      const end = braced ? text.indexOf('}', i + 2) : i + (next === 'x' ? 2 : 4) + 1;
      const digits = text.slice(i + (braced ? 2 : 1), end);
      if (end < 0 || !/^[0-9a-f]+$/i.test(digits) || (!braced && digits.length !== (next === 'x' ? 2 : 4))) return undefined;
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff) return undefined;
      value += String.fromCodePoint(point); i = braced ? end : end - 1; continue;
    }
    value += next;
  }
  return value;
}

interface Queries {
  text(node: SyntaxNode): string;
  unwrap(node: SyntaxNode): SyntaxNode;
  binding(node: SyntaxNode): LexicalBinding | undefined;
  stableObject(node: SyntaxNode): boolean;
  project(node: SyntaxNode): ValueProjection | undefined;
  limits: AnnotationLimits;
}

export function createConstantQueries(query: Queries): {
  constant(node: SyntaxNode): ConstantResult;
  constantProperty(node: SyntaxNode, key: string): ConstantResult;
} {
  const { text, unwrap, binding, limits } = query;
  const constant = (input: SyntaxNode): ConstantResult => {
    let work = 0;
    const active = new Set<SyntaxNode>();
    const bounded = (value: ConstantResult) => value.known && typeof value.value === 'string' && value.value.length * 3 > limits.maxValueBytes ? unknown('value-limit') : value;
    const evaluate = (inputNode: SyntaxNode, depth: number): ConstantResult => {
      if (++work > Math.min(limits.maxWork, 512) || depth > Math.min(limits.maxDepth, 24)) return unknown('constant-limit');
      const node = unwrap(inputNode);
      if (active.has(node)) return unknown('constant-cycle');
      active.add(node);
      try {
        const source = text(node);
        if (node.type === 'string') { const value = decodeString(source); return value === undefined ? unknown('string-escape') : bounded(primitive(value)); }
        if (node.type === 'true' || node.type === 'false') return primitive(node.type === 'true');
        if (node.type === 'null') return primitive(null);
        if (node.type === 'number') {
          if (source.endsWith('n')) return unknown('bigint');
          const value = Number(source.replaceAll('_', ''));
          return Number.isFinite(value) ? primitive(value) : unknown('number');
        }
        if (node.type === 'identifier' || node.type === 'undefined' || node.type === 'shorthand_property_identifier') {
          const found = binding(node);
          if (source === 'undefined' && !found) return primitive(undefined);
          if (!found?.available || found.kind !== 'const' || !found.stable) return unknown('mutable-or-unresolved-binding');
          const projection = !found.initializer ? query.project(node) : undefined;
          const initial = found.initializer ?? (projection?.path.length === 0 ? projection.initializer : undefined);
          if (!initial || initial === node) return unknown('mutable-or-unresolved-binding');
          const result = evaluate(initial, depth + 1);
          if (!result.known) return result;
          if (typeof result.value === 'object' && result.value !== null && !query.stableObject(node)) return unknown('mutable-or-escaped-object');
          return Object.freeze({ ...result, resolution: 'constant' });
        }
        if (node.type === 'template_string') {
          let value = '', cursor = node.startIndex + 1;
          const substitutions = node.children.filter((child) => child.type === 'template_substitution');
          for (const substitution of substitutions) {
            const raw = source.slice(cursor - node.startIndex, substitution.startIndex - node.startIndex);
            const fragment = decodeFragment(raw), argument = substitution.children[0];
            const result = argument && evaluate(argument, depth + 1);
            if (fragment === undefined || !result?.known || (typeof result.value === 'object' && result.value !== null)) return unknown('template-expression');
            value += fragment + String(result.value); cursor = substitution.endIndex;
            if (value.length * 3 > limits.maxValueBytes) return unknown('value-limit');
          }
          const tail = decodeFragment(source.slice(cursor - node.startIndex, -1));
          return tail === undefined ? unknown('template-escape') : bounded(primitive(value + tail, substitutions.length ? 'constant' : 'literal'));
        }
        if (node.type === 'unary_expression') {
          const arg = node.fields.argument ?? node.children[0];
          const value = arg && evaluate(arg, depth + 1);
          if (!value?.known || (typeof value.value === 'object' && value.value !== null)) return unknown('unary-expression');
          const operator = node.tokens[0];
          if (operator === 'void') return primitive(undefined, 'constant');
          if (operator === '!') return primitive(!value.value, 'constant');
          if (operator === '-' && typeof value.value === 'number') return primitive(-value.value, 'constant');
          if (operator === '+' && typeof value.value === 'number') return primitive(value.value, 'constant');
          return unknown('unary-operator');
        }
        if (node.type === 'binary_expression' && node.tokens.includes('+')) {
          const left = node.fields.left && evaluate(node.fields.left, depth + 1), right = node.fields.right && evaluate(node.fields.right, depth + 1);
          if (!left?.known || !right?.known) return unknown('binary-expression');
          const a = left.value, b = right.value;
          if (typeof a === 'object' || typeof b === 'object') return unknown('object-coercion');
          if (typeof a === 'string' || typeof b === 'string') return bounded(primitive(String(a) + String(b), 'constant'));
          if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a + b)) return primitive(a + b, 'constant');
          return unknown('binary-operands');
        }
        if (node.type === 'object') {
          let properties: Record<string, ConstantResult> = Object.create(null), unknownKeys = false;
          for (const child of node.children) {
            if (++work > Math.min(limits.maxWork, 512)) return unknown('constant-limit');
            if (child.type === 'comment') continue;
            if (child.type === 'spread_element') {
              const argument = child.children[0], value = argument && evaluate(argument, depth + 1);
              if (value?.known && value.value !== null && typeof value.value === 'object') {
                if (value.value.unknownKeys) { properties = Object.create(null); unknownKeys = true; }
                for (const [key, result] of Object.entries(value.value.properties)) properties[key] = result.known ? Object.freeze({ ...result, resolution: 'constant' }) : result;
              } else { properties = Object.create(null); unknownKeys = true; }
              continue;
            }
            if (child.type === 'shorthand_property_identifier') { properties[decodeIdentifier(text(child))] = evaluate(child, depth + 1); continue; }
            const key = child.fields.key;
            if (child.type !== 'pair' || !key || !['property_identifier', 'string', 'number'].includes(key.type)) {
              properties = Object.create(null); unknownKeys = true; continue;
            }
            const name = key.type === 'string' ? decodeString(text(key)) : decodeIdentifier(text(key));
            if (name === undefined || name === '__proto__') { properties = Object.create(null); unknownKeys = true; continue; }
            properties[name] = child.fields.value ? evaluate(child.fields.value, depth + 1) : unknown('property-value');
          }
          const value: ConstantObject = Object.freeze({ kind: 'object', properties: Object.freeze(properties), unknownKeys });
          return Object.freeze({ known: true, resolution: 'constant', value });
        }
        if (node.type === 'member_expression' && !node.tokens.includes('?.') && node.fields.object && node.fields.property) {
          const object = evaluate(node.fields.object, depth + 1);
          if (object.known && typeof object.value === 'object' && object.value !== null) {
            const result = object.value.properties[decodeIdentifier(text(node.fields.property))];
            return result?.known ? Object.freeze({ ...result, resolution: 'constant' }) : result ?? unknown('unknown-property');
          }
        }
        return unknown('unsupported-expression');
      } finally { active.delete(node); }
    };
    return evaluate(input, 0);
  };
  return {
    constant,
    constantProperty: (node, key) => {
      const result = constant(node);
      if (!result.known || typeof result.value !== 'object' || result.value === null) return unknown('unknown-options');
      const property = result.value.properties[key] ?? (result.value.unknownKeys ? unknown('unknown-spread-or-key') : unknown('absent'));
      return property.known && unwrap(node).type !== 'object' ? Object.freeze({ ...property, resolution: 'constant' }) : property;
    },
  };
}
