import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { sourceDigest } from '../build.mjs';
import { hash, loadModule, packageRoot, parse } from './helpers.mjs';

const { processRequest, PROTOCOL_LIMITS } = await loadModule('src/worker.ts');
const { canonicalJSON, validateAnnotationManifest, validateAnnotationResult } = await loadModule('src/core/wire.ts');
const fixture = (source = 'export const answer = 42;', language = 'typescript') => {
  const parsed = parse(source, language);
  return { version: 1, parser: parsed.parser, documents: [{ source, sourceHash: hash(source), relativePath: `not-on-disk/input.${language === 'tsx' ? 'tsx' : 'ts'}`, language, tree: parsed.serialized }] };
};
function invoke(input, worker = resolve(packageRoot, 'worker.mjs'), args = [], cwd = packageRoot) {
  const { NODE_OPTIONS, ...env } = process.env;
  return spawnSync(process.execPath, [worker, ...args], {
    input: typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input),
    encoding: 'utf8', cwd, env, maxBuffer: 34 * 1024 * 1024, timeout: 30_000,
  });
}
function failure(request, code) {
  const run = invoke(request);
  assert.equal(run.status, 1, run.error?.message ?? run.stderr);
  assert.equal(run.stdout, '');
  const result = JSON.parse(run.stderr);
  assert.equal(result.version, 1);
  assert.equal(result.error.code, code);
  assert(!result.error.message.includes('SECRET'));
}

test('bundled JSON protocol validates its full wire and binds owned source, parser and configuration identities', async () => {
  const request = fixture('\uFEFF// \u{1f680}\r\nexport const \u03b1 = "\u{1f642}";\r\n');
  const run = invoke(request);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const result = JSON.parse(run.stdout);
  assert.equal(run.stdout, `${JSON.stringify(result)}\n`);
  assert(Buffer.byteLength(run.stdout) <= PROTOCOL_LIMITS.maxResponseBytes);
  assert.equal(result.version, 1);
  assert.deepEqual(result.producer, { id: 'graphify.frameworks', version: '1', fingerprint: await sourceDigest(), configuration: { moduleAliases: {} } });
  validateAnnotationManifest(result.manifest, hash);
  assert.equal(result.manifest.plugins.length, 7);
  assert.equal(result.manifest.parserDigest, hash(canonicalJSON(request.parser)));
  for (const item of result.documents) {
    validateAnnotationResult(item.result, result.manifest, item.source);
    assert.equal(item.source, request.documents[0].source);
    assert.equal(item.result.state, 'complete');
    const declaration = item.result.declarations.find(item => item.name === '\u03b1');
    assert.equal(Buffer.from(item.source).subarray(declaration.nameSpan.startByte, declaration.nameSpan.endByte).toString(), '\u03b1');
  }
  const changedParser = structuredClone(request); changedParser.parser.runtimeVersion += '-qualified-snapshot';
  assert.notEqual(processRequest(changedParser).manifest.id, result.manifest.id);
  const changedOptions = structuredClone(request); changedOptions.options = { limits: { maxWork: 1_000_000 } };
  assert.notEqual(processRequest(changedOptions).manifest.id, result.manifest.id);
  assert.equal(processRequest(changedOptions).producer.fingerprint, result.producer.fingerprint);
  assert.equal(invoke(request).stdout, run.stdout);
});

test('empty document batch queries the actual manifest without pretending to parse a source', () => {
  const request = fixture(); request.documents = [];
  const result = processRequest(request);
  assert.deepEqual(result.documents, []);
  validateAnnotationManifest(result.manifest, hash);
});

test('worker is self-contained outside the checkout and never executes source or discovers its imports', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'graphify-semantic-'));
  try {
    const worker = join(folder, 'worker.mjs');
    await copyFile(resolve(packageRoot, 'worker.mjs'), worker);
    const request = fixture('import missing from "./does-not-exist"; process.exit(99); throw new Error("must not execute"); export const value = missing;');
    const run = invoke(request, worker, [], folder);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).documents[0].result.sourceHash, request.documents[0].sourceHash);
    const aliased = fixture('import {State} from "renamed-sdk/app/state"; export class Example extends State {}');
    aliased.options = { moduleAliases: { 'renamed-sdk': '@fst/components-fst-solid' } };
    const aliasRun = invoke(aliased, worker, [], folder);
    assert.equal(aliasRun.status, 0, aliasRun.stderr);
    assert(JSON.parse(aliasRun.stdout).documents[0].result.facts.some(fact => fact.term === 'fst-solid.state'));
    const bundle = await readFile(worker, 'utf8');
    assert.doesNotMatch(bundle, /(?:from\s*|import\s*\()['"]@fst\/codeintel/);
    assert.doesNotMatch(bundle, /node:(?:fs|child_process|https?|net)/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('malformed protocol, unsupported parsers and source identity failures are JSON stderr only', () => {
  for (const input of ['', '{}{}', '[1]', '{"SECRET":', Buffer.from([0xff]), '['.repeat(PROTOCOL_LIMITS.maxJSONDepth + 1)]) failure(input, input === '[1]' ? 'invalid-request' : 'invalid-json');
  for (const [edit, code] of [
    [value => { value.version = 2; }, 'invalid-request'],
    [value => { value.extra = true; }, 'invalid-request'],
    [value => { value.parser.version = 'unknown-SECRET'; }, 'unsupported-parser'],
    [value => { value.parser.id = 'other'; }, 'unsupported-parser'],
    [value => { value.parser.coordinateEncoding = 'utf8'; }, 'invalid-parser'],
    [value => { value.documents[0].sourceHash = '0'.repeat(64); }, 'invalid-document'],
    [value => { value.documents[0].relativePath = '../SECRET'; }, 'invalid-document'],
    [value => { value.documents[0].relativePath = 'C:/SECRET'; }, 'invalid-document'],
    [value => { value.documents[0].relativePath = 'dir\\SECRET'; }, 'invalid-document'],
    [value => { value.documents[0].relativePath = '/absolute'; }, 'invalid-document'],
    [value => { value.documents[0].relativePath = 'a//b'; }, 'invalid-document'],
    [value => { value.documents[0].relativePath = 'a/./b'; }, 'invalid-document'],
    [value => { value.documents[0].source = '\ud800'; }, 'invalid-document'],
    [value => { value.documents[0].language = 'javascript'; }, 'unsupported-language'],
    [value => { value.documents[0].tree.endPosition.column++; }, 'invalid-tree'],
    [value => { value.documents[0].tree.children = {}; }, 'invalid-tree'],
    [value => { value.documents.push(value.documents[0]); }, 'invalid-document'],
    [value => { value.documents = Array(PROTOCOL_LIMITS.maxDocuments + 1).fill(value.documents[0]); }, 'invalid-request'],
    [value => { value.options = { moduleAliases: { SECRET: 'anything' } }; }, 'invalid-configuration'],
    [value => { value.options = { limits: { maxWork: 2_000_001 } }; }, 'invalid-configuration'],
    [value => { value.options = { limits: { maxSourceBytes: 1 } }; }, 'invalid-document'],
  ]) {
    const request = fixture(); edit(request); failure(request, code);
  }
  const run = invoke(fixture(), undefined, ['--arbitrary']);
  assert.equal(run.status, 1); assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).error.code, 'invalid-arguments');
});

test('request byte ceiling is enforced while reading rather than after parsing', () => {
  failure(' '.repeat(PROTOCOL_LIMITS.maxRequestBytes + 1), 'request-limit');
});

test('parser recovery and reduced budgets stay unsupported/truncated, never fabricated complete', () => {
  const broken = processRequest(fixture('const broken = ('));
  assert.equal(broken.documents[0].result.state, 'unsupported');
  assert.deepEqual(broken.documents[0].result.facts, []);
  const request = fixture('import {createSignal} from "solid-js"; export const [read, write] = createSignal(1);');
  const complete = processRequest(request);
  assert(complete.documents[0].result.facts.length > 0);
  for (const limits of [{ maxFacts: 1 }, { maxWork: 1 }, { maxDeclarations: 1 }, { maxDepth: 1 }]) {
    const result = processRequest({ ...request, options: { limits } });
    assert.notEqual(result.documents[0].result.state, 'complete');
    validateAnnotationResult(result.documents[0].result, result.manifest, request.documents[0].source);
  }
});
