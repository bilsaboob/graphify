import assert from 'node:assert/strict';
import { loadModule, parse, hash } from '../helpers.mjs';

const { createAnalyzer } = await loadModule('src/analysis.ts');
const { validateAnnotationResult } = await loadModule('src/core/index.ts');
export const fixtureDigests = { implementationDigest: hash('test-only-owned-producer-fixture'), parserDigest: hash('test-only-qualified-parser-fixture') };
export const annotationManifest = () => createAnalyzer(fixtureDigests).manifest;
export const sourceParams = (source, options = {}) => ({ sourceHash: hash(source), relativePath: options.relativePath ?? 'fixture.ts', language: options.language ?? 'typescript' });
export function inspectSource(params, source, callback) {
  const parsed = parse(source, params.language);
  try { return callback(parsed.tree); }
  finally { parsed.close(); }
}
export function analyzeSource(source, options = {}) {
  const analyzer = createAnalyzer({ ...fixtureDigests, configuration: { limits: options.limits ?? {} } });
  const document = { source, ...sourceParams(source, options) };
  const result = inspectSource(document, source, tree => analyzer.analyze(document, tree));
  validateAnnotationResult(result, analyzer.manifest, source);
  assert(!result.reports.some(report => report.state === 'failed'), JSON.stringify(result.reports));
  return result;
}
