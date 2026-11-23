import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJSON, validateAnnotationManifest, validateAnnotationResult } from '#core/wire';
import { hash, object, relativePath, requireValid, sourceCoordinates, text } from '#core/validation';
import { createAnalyzer } from './analysis.js';
import { implementationDigest } from './build-info.js';
import { decodeTree, SYNTAX_LIMITS } from './syntax.js';
import type { SourceNode } from './syntax.js';

export const PROTOCOL_LIMITS = Object.freeze({
  maxRequestBytes: 16 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxDocuments: 16,
  maxSourceBytes: 1024 * 1024,
  maxNodes: 250_000,
  maxJSONDepth: SYNTAX_LIMITS.maxDepth * 3 + 16,
  readTimeoutMs: 30_000,
  analysisTimeoutMs: 60_000,
});
export const SUPPORTED_PARSER = Object.freeze({ id: 'tree-sitter-typescript', version: '0.23.2', coordinateEncoding: 'utf16' });
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

class ProtocolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function checked<T>(code: string, message: string, run: () => T): T {
  try { return run(); }
  catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError(code, message); }
}

/** One request, no discovery or execution. Empty documents is a manifest-only query. */
export function processRequest(input: unknown) {
  const deadline = performance.now() + PROTOCOL_LIMITS.analysisTimeoutMs;
  const request = checked('invalid-request', 'Invalid semantic request envelope.', () => {
    const value = object(input, ['version', 'parser', 'documents'], ['options']);
    requireValid(value.version === 1, 'Unsupported protocol version');
    requireValid(Array.isArray(value.documents) && value.documents.length <= PROTOCOL_LIMITS.maxDocuments, 'Document limit exceeded');
    if (value.options !== undefined) {
      const options = object(value.options, [], ['limits', 'moduleAliases']);
      requireValid(Buffer.byteLength(canonicalJSON(options)) <= 4096, 'Configuration limit exceeded');
    }
    return value;
  });
  const parser = checked('invalid-parser', 'Invalid parser descriptor.', () => {
    const value = object(request.parser, ['id', 'version', 'runtimeVersion', 'coordinateEncoding']);
    text(value.id, 128); text(value.version, 64); text(value.runtimeVersion, 64);
    requireValid(value.coordinateEncoding === 'utf16', 'Unsupported coordinate encoding');
    return value;
  });
  if (parser.id !== SUPPORTED_PARSER.id || parser.version !== SUPPORTED_PARSER.version) {
    throw new ProtocolError('unsupported-parser', 'The parser grammar is not qualified for this semantic engine.');
  }
  const analyzer = checked('invalid-configuration', 'Invalid semantic analysis configuration.', () => createAnalyzer({
    implementationDigest, parserDigest: digest(canonicalJSON(parser)),
    ...(request.options === undefined ? {} : { configuration: request.options as object }),
  }));
  validateAnnotationManifest(analyzer.manifest, digest);
  const response = { version: 1, producer: { id: 'graphify.frameworks', version: '1', fingerprint: implementationDigest, configuration: analyzer.configuration }, manifest: analyzer.manifest, documents: [] as { source: string; result: ReturnType<typeof analyzer.analyze> }[] };
  let responseBytes = Buffer.byteLength(JSON.stringify(response)) + 1;
  const paths = new Set<string>();
  let sourceBytes = 0, nodes = 0;
  for (const inputDocument of request.documents as unknown[]) {
    if (performance.now() > deadline) throw new ProtocolError('analysis-timeout', 'Semantic request processing deadline exceeded.');
    const value = checked('invalid-document', 'Invalid source identity, source limit, or relative path.', () => {
      const value = object(inputDocument, ['source', 'sourceHash', 'relativePath', 'language', 'tree']);
      relativePath(value.relativePath);
      hash(value.sourceHash);
      requireValid(typeof value.source === 'string', 'Source must be text');
      const coordinates = sourceCoordinates(value.source, analyzer.manifest.limits.maxSourceBytes);
      sourceBytes += coordinates.bytes;
      requireValid(sourceBytes <= PROTOCOL_LIMITS.maxSourceBytes, 'Aggregate source limit exceeded');
      requireValid(digest(value.source) === value.sourceHash, 'Source identity mismatch');
      requireValid(!paths.has(value.relativePath), 'Duplicate source path');
      paths.add(value.relativePath);
      return { source: value.source, sourceHash: value.sourceHash, relativePath: value.relativePath, language: value.language, tree: value.tree };
    });
    if (value.language !== 'typescript' && value.language !== 'tsx') throw new ProtocolError('unsupported-language', 'Only TypeScript and TSX source snapshots are supported.');
    const tree = checked('invalid-tree', 'Malformed syntax tree, inconsistent coordinates, or syntax limit exceeded.', () => {
      requireValid(nodes < PROTOCOL_LIMITS.maxNodes, 'Aggregate syntax limit exceeded');
      const tree = decodeTree(value.tree, value.source, { maxNodes: Math.min(SYNTAX_LIMITS.maxNodes, PROTOCOL_LIMITS.maxNodes - nodes) });
      const pending: SourceNode[] = [tree.rootNode];
      while (pending.length) {
        const node = pending.pop()!;
        nodes++;
        for (const child of node.children) pending.push(child);
      }
      return tree;
    });
    const document = { source: value.source, sourceHash: value.sourceHash, relativePath: value.relativePath, language: value.language };
    const result = checked('analysis-failed', 'Semantic analysis could not produce a validated result.', () => {
      const result = analyzer.analyze(document, tree);
      validateAnnotationResult(result, analyzer.manifest, document.source);
      return result;
    });
    if (performance.now() > deadline) throw new ProtocolError('analysis-timeout', 'Semantic request processing deadline exceeded.');
    const retained = { source: document.source, result };
    responseBytes += Buffer.byteLength(JSON.stringify(retained)) + (response.documents.length ? 1 : 0);
    if (responseBytes > PROTOCOL_LIMITS.maxResponseBytes) throw new ProtocolError('response-limit', 'Semantic response byte limit exceeded.');
    response.documents.push(retained);
  }
  return response;
}

async function readRequest(): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => process.stdin.destroy(new ProtocolError('request-timeout', 'Semantic request read deadline exceeded.')), PROTOCOL_LIMITS.readTimeoutMs);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > PROTOCOL_LIMITS.maxRequestBytes) throw new ProtocolError('request-limit', 'Semantic request byte limit exceeded.');
      parts.push(chunk);
    }
    return checked('invalid-json', 'Expected one bounded UTF-8 JSON request.', () => {
      const encoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      let depth = 0, quoted = false, escaped = false, stringStart = 0;
      const containers: (Set<string> | null)[] = [];
      for (let index = 0; index < encoded.length; index++) {
        const character = encoded[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') {
            quoted = false;
            let next = index + 1;
            while (next < encoded.length && /[\t\n\r ]/.test(encoded[next]!)) next++;
            const keys = containers.at(-1);
            if (keys && encoded[next] === ':') {
              const key: string = JSON.parse(encoded.slice(stringStart, index + 1));
              requireValid(!keys.has(key), 'Duplicate JSON object key');
              keys.add(key);
            }
          }
        } else if (character === '"') { quoted = true; stringStart = index; }
        else if (character === '{' || character === '[') {
          requireValid(++depth <= PROTOCOL_LIMITS.maxJSONDepth, 'JSON depth limit exceeded');
          containers.push(character === '{' ? new Set() : null);
        } else if (character === '}' || character === ']') { depth--; containers.pop(); }
      }
      return JSON.parse(encoded);
    });
  } finally { clearTimeout(timeout); }
}

async function main(): Promise<void> {
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new ProtocolError('unsupported-runtime', 'Node.js 20 or newer is required.');
    if (process.argv.length !== 2) throw new ProtocolError('invalid-arguments', 'This worker accepts one JSON request on standard input, with no arguments.');
    const result = processRequest(await readRequest());
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) + 1 > PROTOCOL_LIMITS.maxResponseBytes) throw new ProtocolError('response-limit', 'Semantic response byte limit exceeded.');
    process.stdout.write(`${encoded}\n`);
  } catch (error) {
    const failure = error instanceof ProtocolError ? error : new ProtocolError('worker-failed', 'The semantic worker failed.');
    process.stderr.write(`${JSON.stringify({ version: 1, error: { code: failure.code, message: failure.message } })}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => { process.exitCode = 1; });
  await main();
}
