import { createHash } from 'node:crypto';
import { createAnnotationEngine, type AnalysisDocument } from '#core';
import { ANNOTATION_LIMITS, canonicalJSON, validateAnnotationManifest, validateAnnotationResult, type AnnotationLimits, type AnnotationManifest } from '#core/wire';
import { createTypeScriptView } from '#typescript';
import { normalizeModuleAliases } from '#typescript/module-aliases';
import { object, requireValid } from '#core/validation';
import type { SourceTree } from './syntax.js';
import { createFstSolidPlugin, fstReturnContracts } from './frameworks/fst-solid/index.js';
import { createFstComponentsPlugin, fstComponentsReturnContracts } from './frameworks/fst-solid/components.js';
import { createSolidPlugin, solidReturnContracts } from './frameworks/solid/index.js';
import { createImplementationPlugin } from './producers/implementation-plugin.js';
import { createTransportBindingPlugin } from './producers/transport-binding-plugin.js';
import { createValidationContractPlugin } from './producers/validation-contract-plugin.js';
import { createDispatchBindingPlugin } from './producers/dispatch-binding-plugin.js';

/** Source-only composition. The build supplies its actual owned-source digest;
 * the caller supplies the qualified parser descriptor digest, not a path to code. */
export function createAnalyzer(options: { implementationDigest: string; parserDigest: string; configuration?: object }) {
  const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const suppliedConfiguration = object(options.configuration === undefined ? {} : options.configuration, [], ['limits', 'moduleAliases']);
  requireValid(Buffer.byteLength(canonicalJSON(suppliedConfiguration)) <= 4096, 'Configuration limit exceeded');
  const moduleAliases = normalizeModuleAliases(suppliedConfiguration.moduleAliases);
  const supplied = object(suppliedConfiguration.limits === undefined ? {} : suppliedConfiguration.limits, [], Object.keys(ANNOTATION_LIMITS));
  const limits: Record<keyof AnnotationLimits, number> = { ...ANNOTATION_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > limits[key as keyof typeof limits]) throw new Error(`Invalid analyzer limit: ${key}`);
    limits[key as keyof typeof limits] = value;
  }
  const configuration = Object.freeze({ moduleAliases });
  const normalizedConfiguration = canonicalJSON({ limits, moduleAliases });
  requireValid(Buffer.byteLength(normalizedConfiguration) <= 4096, 'Normalized configuration limit exceeded');
  const digests = { implementationDigest: options.implementationDigest, configurationDigest: digest(normalizedConfiguration) };
  const plugins = [
    createFstSolidPlugin(digests), createSolidPlugin(digests), createFstComponentsPlugin(digests),
    createImplementationPlugin(digests), createTransportBindingPlugin(digests),
    createValidationContractPlugin(digests), createDispatchBindingPlugin(digests),
  ];
  const body: Omit<AnnotationManifest, 'id'> = {
    version: 1,
    core: { version: '1', ...digests },
    view: { id: 'typescript', version: 1, ...digests },
    parserDigest: options.parserDigest,
    plugins: plugins.map(plugin => plugin.descriptor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    limits,
  };
  const manifest = { ...body, id: digest(canonicalJSON(body)) };
  validateAnnotationManifest(manifest, digest);
  const pending: object[] = [manifest];
  while (pending.length) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  const engine = createAnnotationEngine({ manifest, plugins, digest });
  const returnContracts = [...solidReturnContracts, ...fstReturnContracts, ...fstComponentsReturnContracts];
  const grouped = new Set(['transport-binding', 'validation-contract', 'dispatch-binding']);
  return Object.freeze({
    manifest,
    configuration,
    analyze(document: AnalysisDocument, tree: SourceTree) {
      const language = document.language;
      if (language !== 'typescript' && language !== 'tsx') throw new Error('Unsupported source language');
      if (Buffer.byteLength(document.source) > limits.maxSourceBytes || digest(document.source) !== document.sourceHash) throw new Error('Source snapshot mismatch');
      const view = createTypeScriptView({ tree, ...document, language, limits, returnContracts, moduleAliases });
      const result = engine.analyze(document, view);
      // These producers certify a whole-source census. A retained emission prefix
      // cannot certify a family, even if some unit-complete markers survived.
      const rejected = new Set(result.reports.filter(report => grouped.has(report.pluginId) && report.state !== 'complete').map(report => report.pluginId));
      result.facts = result.facts.filter(fact => !rejected.has(fact.evidence.pluginId));
      validateAnnotationResult(result, manifest, document.source);
      return result;
    },
  });
}
