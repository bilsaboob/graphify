// These contracts use only ASCII object keys and normalized safe integers.
// Limits also bound callers of the canonicalizer before schema validation.
export class CanonicalLimitError extends Error {}

export function canonicalJSON(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const append = (text: string): string => {
    bytes += utf8Length(text);
    if (bytes > ANNOTATION_LIMITS.maxResultBytes) throw new CanonicalLimitError('Canonical JSON exceeds byte limit');
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > ANNOTATION_LIMITS.maxWork || depth > ANNOTATION_LIMITS.maxDepth) throw new CanonicalLimitError('Canonical JSON exceeds structural limit');
    if (item === null) return append('null');
    if (typeof item === 'boolean') return append(item ? 'true' : 'false');
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new Error('Invalid JSON integer');
      return append(String(item));
    }
    if (typeof item === 'string') {
      if (item.length > ANNOTATION_LIMITS.maxResultBytes) throw new CanonicalLimitError('Canonical JSON exceeds byte limit');
      validUnicode(item);
      return append(JSON.stringify(item).replace(/[<>&\u2028\u2029]/g, char =>
        `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
    }
    if (typeof item !== 'object' || seen.has(item)) throw new Error('Invalid JSON value');
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (item.length > ANNOTATION_LIMITS.maxWork) throw new CanonicalLimitError('Canonical JSON exceeds structural limit');
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) {
        throw new Error('Invalid JSON array');
      }
      const values: string[] = [];
      append('[]');
      for (let index = 0; index < item.length; index++) {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property?.enumerable || !('value' in property)) throw new Error('Invalid JSON array element');
        if (index) append(',');
        values.push(visit(property.value, depth + 1));
      }
      result = `[${values.join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid JSON object');
      const keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== 'string' || !/^[\x20-\x7e]*$/.test(key))) {
        throw new Error('Invalid JSON object key');
      }
      const entries: string[] = [];
      append('{}');
      for (const key of (keys as string[]).sort()) {
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        if (!property.enumerable || !('value' in property)) throw new Error('Invalid JSON object property');
        if (entries.length) append(',');
        append(':');
        entries.push(`${visit(key, depth + 1)}:${visit(property.value, depth + 1)}`);
      }
      result = `{${entries.join(',')}}`;
    }
    seen.delete(item);
    return result;
  };
  return visit(value, 0);
}

export function validUnicode(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('Invalid Unicode');
    }
  }
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}
import { ANNOTATION_LIMITS } from './wire.js';
