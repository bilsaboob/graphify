import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const config = Object.freeze({ bundle: true, platform: 'node', target: 'node20', format: 'esm', charset: 'ascii', legalComments: 'none', sourcemap: false });

export async function sourceDigest() {
  const files = ['build.mjs', 'package.json', 'package-lock.json', 'module_catalog.json'];
  async function collect(path) {
    for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Build sources cannot be symlinks');
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(name);
    }
  }
  await collect('src');
  const hash = createHash('sha256').update('graphify.semantic.build.v1\0').update(JSON.stringify({ config, esbuildVersion }));
  for (const file of files.sort()) {
    const bytes = await readFile(resolve(root, file));
    hash.update(`\0${file}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

export async function buildWorker() {
  const digest = await sourceDigest();
  const output = await build({
    ...config,
    absWorkingDir: root,
    entryPoints: ['src/worker.ts'],
    outfile: 'worker.mjs',
    write: false,
    metafile: true,
    logLevel: 'silent',
    define: { GRAPHIFY_IMPLEMENTATION_DIGEST: JSON.stringify(digest) },
  });
  const packageRoot = await realpath(root);
  for (const input of Object.keys(output.metafile.inputs)) {
    const path = await realpath(resolve(root, input));
    const name = relative(packageRoot, path);
    if (isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`) || (!name.startsWith(`src${sep}`) && name !== 'module_catalog.json')) {
      throw new Error('Worker inputs must be owned package sources');
    }
  }
  const standard = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
  for (const item of Object.values(output.metafile.outputs)) for (const dependency of item.imports) {
    if (!dependency.external || !dependency.path.startsWith('node:') || !standard.has(dependency.path.slice(5))) {
      throw new Error('Worker has a nonstandard runtime dependency');
    }
  }
  if (digest !== await sourceDigest()) throw new Error('Build sources changed during bundling');
  const bytes = output.outputFiles[0].contents;
  await writeFile(resolve(root, 'worker.mjs'), bytes);
  return { fingerprint: digest, sources: Object.keys(output.metafile.inputs).length, bytes: bytes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildWorker()));
}
