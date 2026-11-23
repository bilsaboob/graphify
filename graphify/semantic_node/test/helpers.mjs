import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sourceDigest } from '../build.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const hash = value => createHash('sha256').update(value).digest('hex');
const modules = new Map();
export function loadModule(path) {
  if (!modules.has(path)) modules.set(path, (async () => {
    const output = await build({
      absWorkingDir: packageRoot, entryPoints: [path], bundle: true, platform: 'node',
      format: 'esm', target: 'node20', write: false, logLevel: 'silent',
      define: { GRAPHIFY_IMPLEMENTATION_DIGEST: JSON.stringify(await sourceDigest()) },
    });
    return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`);
  })());
  return modules.get(path);
}

const { decodeTree } = await loadModule('src/syntax.ts');
const parsed = new Map();
// Exercise the production Python serializer, not a second parser or a Node WASM asset.
const parserProgram = String.raw`
import json, sys
from graphify.framework_analysis import parser_descriptor, serialize_tree
value = json.load(sys.stdin)
json.dump({'parser': parser_descriptor(), 'tree': serialize_tree(value['source'], value['language'])}, sys.stdout, ensure_ascii=True)
`;
export function parse(source, language = 'tsx') {
  const key = JSON.stringify([source, language]);
  if (!parsed.has(key)) {
    const project = resolve(packageRoot, '../..');
    const python = process.env.GRAPHIFY_TEST_PYTHON ?? resolve(project, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    const encoded = JSON.parse(execFileSync(python, ['-B', '-c', parserProgram], {
      cwd: project, input: JSON.stringify({ source, language }), encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '' },
    }));
    parsed.set(key, { ...encoded, normalized: decodeTree(encoded.tree, source) });
  }
  const result = parsed.get(key);
  return { tree: result.normalized, serialized: structuredClone(result.tree), parser: { ...result.parser }, close() {} };
}
