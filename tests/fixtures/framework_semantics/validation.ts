import { z as schema } from 'zod';

export function parse(input: unknown) {
  return schema.object({ name: schema.string().min(2).max(8), count: schema.number().min(-2).max(10), ok: schema.boolean() }).parse(input);
}

export const safe = (input: unknown) => schema.object({ name: schema.string().min(2).max(8), count: schema.number().min(-2).max(10), ok: schema.boolean() }).safeParse(input);
