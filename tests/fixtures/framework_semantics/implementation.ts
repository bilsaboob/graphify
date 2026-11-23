import proc from 'node:process';
import { test as register, expect as check } from 'vitest';

export function transform(input) {
  if (input.ready) {
    input.count += delta;
    return input;
  } else {
    throw failure;
  }
}
export const increment = () => { count++; return fallback; };
const region = proc.env.REGION ?? 'private-default-one';
const mode = proc.env.MODE || 'private-default-two';
const { TOKEN: token = 'private-default-three' } = proc.env;
const origin = import.meta.env.ORIGIN;

register('same title', () => { check(first).toBe(expectedFirst); });
register('same title', async () => { await check(second).resolves.not.toEqual(expectedSecond); });
