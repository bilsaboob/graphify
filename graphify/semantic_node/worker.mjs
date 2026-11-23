// src/worker.ts
import { createHash as createHash2 } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/canonical.ts
var CanonicalLimitError = class extends Error {
};
function canonicalJSON(value4) {
  const seen = /* @__PURE__ */ new Set();
  let nodes = 0;
  let bytes = 0;
  const append = (text2) => {
    bytes += utf8Length(text2);
    if (bytes > ANNOTATION_LIMITS.maxResultBytes) throw new CanonicalLimitError("Canonical JSON exceeds byte limit");
    return text2;
  };
  const visit = (item, depth) => {
    if (++nodes > ANNOTATION_LIMITS.maxWork || depth > ANNOTATION_LIMITS.maxDepth) throw new CanonicalLimitError("Canonical JSON exceeds structural limit");
    if (item === null) return append("null");
    if (typeof item === "boolean") return append(item ? "true" : "false");
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new Error("Invalid JSON integer");
      return append(String(item));
    }
    if (typeof item === "string") {
      if (item.length > ANNOTATION_LIMITS.maxResultBytes) throw new CanonicalLimitError("Canonical JSON exceeds byte limit");
      validUnicode(item);
      return append(JSON.stringify(item).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
    }
    if (typeof item !== "object" || seen.has(item)) throw new Error("Invalid JSON value");
    seen.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > ANNOTATION_LIMITS.maxWork) throw new CanonicalLimitError("Canonical JSON exceeds structural limit");
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) {
        throw new Error("Invalid JSON array");
      }
      const values = [];
      append("[]");
      for (let index = 0; index < item.length; index++) {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property?.enumerable || !("value" in property)) throw new Error("Invalid JSON array element");
        if (index) append(",");
        values.push(visit(property.value, depth + 1));
      }
      result = `[${values.join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid JSON object");
      const keys = Reflect.ownKeys(item);
      if (keys.some((key3) => typeof key3 !== "string" || !/^[\x20-\x7e]*$/.test(key3))) {
        throw new Error("Invalid JSON object key");
      }
      const entries = [];
      append("{}");
      for (const key3 of keys.sort()) {
        const property = Object.getOwnPropertyDescriptor(item, key3);
        if (!property.enumerable || !("value" in property)) throw new Error("Invalid JSON object property");
        if (entries.length) append(",");
        append(":");
        entries.push(`${visit(key3, depth + 1)}:${visit(property.value, depth + 1)}`);
      }
      result = `{${entries.join(",")}}`;
    }
    seen.delete(item);
    return result;
  };
  return visit(value4, 0);
}
function validUnicode(text2) {
  for (let index = 0; index < text2.length; index++) {
    const unit = text2.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const next = text2.charCodeAt(++index);
      if (!(next >= 56320 && next <= 57343)) throw new Error("Invalid Unicode");
    } else if (unit >= 56320 && unit <= 57343) {
      throw new Error("Invalid Unicode");
    }
  }
}
function utf8Length(text2) {
  let bytes = 0;
  for (const char of text2) {
    const point = char.codePointAt(0);
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return bytes;
}

// src/core/validation.ts
var states = ["complete", "not-applicable", "partial", "unsupported", "truncated", "failed"];
var hashPattern = /^[a-f0-9]{64}$/;
var identifierPattern = /^[A-Za-z][A-Za-z0-9._:/-]*$/;
function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value4, required, optional5 = []) {
  requireValid(value4 !== null && typeof value4 === "object" && !Array.isArray(value4), "Expected object");
  const prototype = Object.getPrototypeOf(value4);
  requireValid(prototype === Object.prototype || prototype === null, "Invalid object prototype");
  const keys = Reflect.ownKeys(value4);
  for (const key3 of keys) {
    requireValid(typeof key3 === "string" && (required.includes(key3) || optional5.includes(key3)), "Unknown object property");
    const property = Object.getOwnPropertyDescriptor(value4, key3);
    requireValid(property.enumerable && "value" in property && property.value !== void 0, "Invalid object property");
  }
  requireValid(required.every((key3) => Object.hasOwn(value4, key3)), "Missing object property");
  return value4;
}
function array(value4, limit) {
  requireValid(Array.isArray(value4) && value4.length <= limit, "Invalid array or array limit");
  return value4;
}
function text(value4, max = 2048, empty = false) {
  requireValid(typeof value4 === "string" && (empty || value4.length > 0) && value4.length <= max, "Invalid text");
  validUnicode(value4);
  requireValid(utf8Length(value4) <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value4), "Invalid text");
}
function identifier(value4, max = 128) {
  text(value4, max);
  requireValid(identifierPattern.test(value4), "Invalid identifier");
}
function integer(value4, min, max) {
  requireValid(typeof value4 === "number" && Number.isSafeInteger(value4) && !Object.is(value4, -0) && value4 >= min && value4 <= max, "Invalid integer");
}
function hash(value4) {
  requireValid(typeof value4 === "string" && hashPattern.test(value4), "Invalid digest");
}
function coverage(value4) {
  requireValid(states.includes(value4), "Invalid coverage state");
}
function relativePath(value4) {
  text(value4, 2048);
  requireValid(!/[\\:\x00-\x1f\x7f]/.test(value4) && value4.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Invalid relative path");
}
function uniqueStrings(value4, max, check) {
  const items = array(value4, max);
  const seen = /* @__PURE__ */ new Set();
  for (const item of items) {
    check(item);
    requireValid(!seen.has(item), "Duplicate entry");
    seen.add(item);
  }
}
function pluginDescriptor(value4, manifestView) {
  const plugin = object(value4, ["id", "version", "implementationDigest", "configurationDigest", "languages", "view", "roles", "properties", "relations"]);
  text(plugin.id, 64);
  requireValid(/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id) && !["core", "wire"].includes(plugin.id), "Invalid plugin namespace");
  text(plugin.version, 64);
  hash(plugin.implementationDigest);
  hash(plugin.configurationDigest);
  uniqueStrings(plugin.languages, 32, (language) => identifier(language, 64));
  requireValid(plugin.languages.length > 0, "Empty plugin languages");
  const view = object(plugin.view, ["id", "version"]);
  requireValid(view.id === manifestView.id && view.version === manifestView.version, "Unsupported plugin view");
  const terms = /* @__PURE__ */ new Set();
  for (const category of ["roles", "properties", "relations"]) {
    for (const entry of array(plugin[category], 256)) {
      const term = object(entry, category === "properties" ? ["id", "label", "valueKind", "multiple"] : ["id", "label"], ["description"]);
      text(term.id, 128);
      requireValid(term.id.startsWith(`${plugin.id}.`) && /^[a-z][a-z0-9.-]*$/.test(term.id.slice(plugin.id.length + 1)), "Foreign vocabulary namespace");
      requireValid(!terms.has(term.id), "Duplicate vocabulary term");
      terms.add(term.id);
      text(term.label);
      if ("description" in term) text(term.description);
      if (category === "properties") {
        requireValid(["string", "boolean", "integer", "reference"].includes(term.valueKind), "Invalid property value kind");
        requireValid(typeof term.multiple === "boolean", "Invalid property cardinality");
      }
    }
  }
}
function validateAnnotationManifest(manifest, digest2) {
  const encoded = canonicalJSON(manifest);
  const value4 = object(manifest, ["version", "id", "core", "view", "parserDigest", "plugins", "limits"]);
  requireValid(value4.version === 1, "Unsupported annotation version");
  hash(value4.id);
  const core = object(value4.core, ["version", "implementationDigest"], ["configurationDigest"]);
  text(core.version, 64);
  hash(core.implementationDigest);
  if (core.configurationDigest !== void 0) hash(core.configurationDigest);
  const view = object(value4.view, ["id", "version", "implementationDigest"], ["configurationDigest"]);
  identifier(view.id);
  integer(view.version, 1, Number.MAX_SAFE_INTEGER);
  hash(view.implementationDigest);
  if (view.configurationDigest !== void 0) hash(view.configurationDigest);
  hash(value4.parserDigest);
  const limits = object(value4.limits, Object.keys(ANNOTATION_LIMITS));
  for (const key3 of Object.keys(ANNOTATION_LIMITS)) {
    integer(limits[key3], 1, ANNOTATION_LIMITS[key3]);
  }
  requireValid(utf8Length(encoded) <= limits.maxManifestBytes, "Manifest byte limit exceeded");
  const plugins = array(value4.plugins, limits.maxPlugins);
  const seen = /* @__PURE__ */ new Set();
  for (const plugin of plugins) {
    pluginDescriptor(plugin, view);
    requireValid(!seen.has(plugin.id), "Duplicate plugin");
    seen.add(plugin.id);
  }
  if (digest2) {
    const { id, ...content } = value4;
    const calculated = digest2(canonicalJSON(content));
    hash(calculated);
    requireValid(id === calculated, "Manifest identity mismatch");
  }
}
function sourceCoordinates(source, maxBytes) {
  requireValid(typeof source === "string" && source.length <= maxBytes, "Source byte limit exceeded");
  validUnicode(source);
  const offsets = /* @__PURE__ */ new Map();
  const lines = [];
  let bytes = 0;
  let offset = 0;
  let line = 1;
  for (const char of source) {
    offsets.set(bytes, offset);
    const length = utf8Length(char);
    for (let byte = 0; byte < length; byte++) lines[bytes++] = line;
    if (char === "\n") line++;
    offset += char.length;
  }
  offsets.set(bytes, offset);
  lines[bytes] = line;
  requireValid(bytes <= maxBytes, "Source byte limit exceeded");
  return { source, bytes, offsets, lines };
}
function span(value4, maxBytes, coordinates) {
  const item = object(value4, ["startByte", "endByte", "startLine", "endLine"]);
  integer(item.startByte, 0, coordinates?.bytes ?? maxBytes);
  integer(item.endByte, item.startByte, coordinates?.bytes ?? maxBytes);
  integer(item.startLine, 1, maxBytes + 1);
  integer(item.endLine, item.startLine, maxBytes + 1);
  if (coordinates) {
    requireValid(coordinates.offsets.has(item.startByte) && coordinates.offsets.has(item.endByte), "Span splits UTF-8 character");
    requireValid(item.startLine === coordinates.lines[item.startByte] && item.endLine === coordinates.lines[item.endByte > item.startByte ? item.endByte - 1 : item.startByte], "Span line mismatch");
  }
}
function contains(outer, inner) {
  return outer.startByte <= inner.startByte && outer.endByte >= inner.endByte && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}
function validateDeclarations(declarations, manifest, coordinates) {
  const result = /* @__PURE__ */ new Map();
  for (const entry of array(declarations, manifest.limits.maxDeclarations)) {
    const declaration = object(entry, ["key", "kind", "span", "exports"], ["name", "owner", "nameSpan", "binding", "writes", "computedName"]);
    text(declaration.key);
    requireValid(!/[\x00-\x1f\x7f]/.test(declaration.key), "Invalid declaration key");
    identifier(declaration.kind);
    if ("name" in declaration) text(declaration.name);
    if ("owner" in declaration) text(declaration.owner);
    span(declaration.span, manifest.limits.maxSourceBytes, coordinates);
    if ("nameSpan" in declaration) {
      span(declaration.nameSpan, manifest.limits.maxSourceBytes, coordinates);
      requireValid(contains(declaration.span, declaration.nameSpan), "Name span outside declaration");
    }
    uniqueStrings(declaration.exports, 256, (item) => text(item));
    requireValid(!result.has(declaration.key), "Duplicate declaration key");
    result.set(declaration.key, entry);
  }
  for (const declaration of result.values()) {
    if (declaration.binding !== void 0) {
      validateBinding(declaration.binding, manifest, coordinates);
      requireValid(contains(declaration.binding.patternSpan, declaration.nameSpan ?? declaration.span), "Binding target outside pattern");
    }
    if (declaration.writes !== void 0) {
      const writes3 = array(declaration.writes, 64);
      requireValid(writes3.length > 0, "Empty writes");
      const seen2 = /* @__PURE__ */ new Set();
      for (const write of writes3) {
        validateBinding(write, manifest, coordinates);
        const key3 = canonicalJSON(write);
        requireValid(!seen2.has(key3), "Duplicate write");
        seen2.add(key3);
      }
    }
    if (declaration.computedName !== void 0) {
      validateSourceExpression(declaration.computedName, manifest, coordinates);
      requireValid(declaration.name === void 0 && contains(declaration.span, declaration.computedName.span), "Invalid computed name");
    }
    const seen = /* @__PURE__ */ new Set([declaration.key]);
    let current = declaration;
    while (current.owner !== void 0) {
      const owner = result.get(current.owner);
      requireValid(owner && !seen.has(owner.key), "Missing or cyclic declaration owner");
      requireValid(contains(owner.span, current.span), "Declaration outside owner");
      seen.add(owner.key);
      requireValid(seen.size <= manifest.limits.maxDepth, "Declaration depth exceeded");
      current = owner;
    }
  }
  return result;
}
function validateSourceExpression(value4, manifest, coordinates) {
  validateReference(value4, manifest, /* @__PURE__ */ new Map(), coordinates);
  requireValid(value4.kind === "expression", "Binding evidence requires an exact source expression");
}
function validateBinding(value4, manifest, coordinates) {
  const item = object(value4, ["source", "sourceSpan", "patternSpan", "operations", "value"], ["shapes"]);
  requireValid(item.value === "unknown", "Structural binding is not value proof");
  validateSourceExpression(item.source, manifest, coordinates);
  span(item.sourceSpan, manifest.limits.maxSourceBytes, coordinates);
  span(item.patternSpan, manifest.limits.maxSourceBytes, coordinates);
  requireValid(canonicalJSON(item.source.span) === canonicalJSON(item.sourceSpan), "Binding source span mismatch");
  const operations = array(item.operations, Math.min(24, manifest.limits.maxDepth));
  requireValid(operations.length > 0, "Empty binding operations");
  for (const entry of operations) {
    const op = object(entry, ["kind", "span"], ["key", "index", "value", "excludedKeys"]);
    span(op.span, manifest.limits.maxSourceBytes, coordinates);
    requireValid(contains(item.patternSpan, op.span), "Operation outside binding pattern");
    switch (op.kind) {
      case "property":
        object(op, ["kind", "span", "key"]);
        text(op.key, 2048, true);
        break;
      case "computed-property":
        object(op, ["kind", "span", "key"]);
        validateSourceExpression(op.key, manifest, coordinates);
        requireValid(contains(op.span, op.key.span), "Computed key outside operation");
        break;
      case "iterator":
      case "iterator-rest":
        object(op, ["kind", "span", "index"]);
        integer(op.index, 0, 511);
        break;
      case "default":
        object(op, ["kind", "span", "value"]);
        validateSourceExpression(op.value, manifest, coordinates);
        requireValid(contains(op.span, op.value.span), "Default outside operation");
        break;
      case "object-rest":
        object(op, ["kind", "span", "excludedKeys"]);
        for (const key3 of array(op.excludedKeys, 64)) {
          if (typeof key3 === "string") text(key3, 2048, true);
          else {
            validateSourceExpression(key3, manifest, coordinates);
            requireValid(contains(item.patternSpan, key3.span), "Excluded key outside pattern");
          }
        }
        break;
      default:
        throw new Error("Invalid binding operation");
    }
  }
  if ("shapes" in item) {
    const shapes2 = array(item.shapes, 16);
    requireValid(shapes2.length > 0, "Empty binding shapes");
    for (const entry of shapes2) {
      const shape = object(entry, ["kind", "span"], ["keys", "length"]);
      span(shape.span, manifest.limits.maxSourceBytes, coordinates);
      if (shape.kind === "object") {
        object(shape, ["kind", "span", "keys"]);
        uniqueStrings(shape.keys, 64, (key3) => text(key3, 2048, true));
      } else {
        requireValid(shape.kind === "tuple", "Invalid binding shape");
        object(shape, ["kind", "span", "length"]);
        integer(shape.length, 0, 64);
      }
    }
  }
  requireValid(utf8Length(canonicalJSON(item)) <= manifest.limits.maxValueBytes, "Binding evidence byte limit exceeded");
}
function validateDiagnostic(value4, manifest, coordinates) {
  const item = object(value4, ["code", "message"], ["span"]);
  identifier(item.code);
  text(item.message, manifest.limits.maxValueBytes);
  if ("span" in item) span(item.span, manifest.limits.maxSourceBytes, coordinates);
}
function validateReference(value4, manifest, declarations, coordinates) {
  const item = object(value4, ["kind"], ["key", "module", "name", "member", "text", "span"]);
  switch (item.kind) {
    case "declaration":
      object(item, ["kind", "key"]);
      text(item.key);
      requireValid(declarations.has(item.key), "Unknown declaration reference");
      break;
    case "import":
      object(item, ["kind", "module", "name"], ["member"]);
      text(item.module, manifest.limits.maxValueBytes);
      text(item.name, manifest.limits.maxValueBytes);
      if ("member" in item) text(item.member, manifest.limits.maxValueBytes);
      break;
    case "expression":
    case "type":
      object(item, ["kind", "text", "span"]);
      text(item.text, manifest.limits.maxValueBytes);
      span(item.span, manifest.limits.maxSourceBytes, coordinates);
      if (coordinates) {
        requireValid(item.text === coordinates.source.slice(coordinates.offsets.get(item.span.startByte), coordinates.offsets.get(item.span.endByte)), "Reference text mismatch");
      }
      break;
    default:
      throw new Error("Invalid reference kind");
  }
  requireValid(utf8Length(canonicalJSON(item)) <= manifest.limits.maxValueBytes, "Reference byte limit exceeded");
}
function validateFact(value4, plugin, manifest, declarations, coordinates) {
  const item = object(value4, ["kind", "subject", "term", "evidence"], ["resolution", "value", "target"]);
  text(item.subject);
  text(item.term, 128);
  const subject = declarations.get(item.subject);
  requireValid(subject, "Unknown fact subject");
  const evidence = object(item.evidence, ["pluginId", "ruleId", "basis", "span"]);
  requireValid(evidence.pluginId === plugin.id, "Invalid fact provenance");
  identifier(evidence.ruleId);
  requireValid(["syntax", "import-bound", "convention"].includes(evidence.basis), "Invalid evidence basis");
  span(evidence.span, manifest.limits.maxSourceBytes, coordinates);
  requireValid(contains(subject.span, evidence.span), "Evidence outside subject");
  switch (item.kind) {
    case "role":
      object(item, ["kind", "subject", "term", "evidence"]);
      requireValid(plugin.roles.some((term) => term.id === item.term), "Unknown role");
      break;
    case "property": {
      object(item, ["kind", "subject", "term", "evidence", "resolution"], ["value"]);
      const term = plugin.properties.find((term2) => term2.id === item.term);
      requireValid(term, "Unknown property");
      requireValid(["literal", "constant", "expression", "absent"].includes(item.resolution), "Invalid value resolution");
      if (item.resolution === "absent" || item.resolution === "expression") {
        requireValid(!("value" in item), "Unresolved property has a value");
      } else {
        const property = object(item.value, ["kind", "value"]);
        requireValid(property.kind === term.valueKind, "Invalid property value kind");
        switch (property.kind) {
          case "string":
            text(property.value, manifest.limits.maxValueBytes, true);
            break;
          case "boolean":
            requireValid(typeof property.value === "boolean", "Invalid boolean");
            break;
          case "integer":
            integer(property.value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
            break;
          case "reference":
            validateReference(property.value, manifest, declarations, coordinates);
            break;
        }
        requireValid(utf8Length(canonicalJSON(property)) <= manifest.limits.maxValueBytes, "Value byte limit exceeded");
      }
      break;
    }
    case "relation":
      object(item, ["kind", "subject", "term", "evidence", "target"]);
      requireValid(plugin.relations.some((term) => term.id === item.term), "Unknown relation");
      validateReference(item.target, manifest, declarations, coordinates);
      break;
    default:
      throw new Error("Invalid fact kind");
  }
}
function checkCardinality(fact, term, values) {
  if (fact.kind !== "property" || !term || term.multiple) return;
  const key3 = canonicalJSON([fact.subject, fact.term]);
  const value4 = canonicalJSON(fact.value === void 0 ? { resolution: fact.resolution } : { resolution: fact.resolution, value: fact.value });
  const previous = values.get(key3);
  requireValid(previous === void 0 || previous === value4, "Conflicting single-valued property");
  values.set(key3, value4);
}
function validateAnnotationResult(result, manifest, source) {
  validateAnnotationManifest(manifest);
  requireValid(utf8Length(canonicalJSON(result)) <= manifest.limits.maxResultBytes, "Result byte limit exceeded");
  const value4 = object(result, ["version", "analysisSetId", "sourceHash", "relativePath", "language", "state", "declarations", "facts", "reports", "diagnostics"]);
  requireValid(value4.version === 1 && value4.analysisSetId === manifest.id, "Annotation contract mismatch");
  hash(value4.sourceHash);
  relativePath(value4.relativePath);
  identifier(value4.language, 64);
  coverage(value4.state);
  const coordinates = source === void 0 ? void 0 : sourceCoordinates(source, manifest.limits.maxSourceBytes);
  const declarations = validateDeclarations(value4.declarations, manifest, coordinates);
  const plugins = new Map(manifest.plugins.map((plugin) => [plugin.id, plugin]));
  const reports = /* @__PURE__ */ new Map();
  let diagnostics = 0;
  const checkDiagnostics = (items) => {
    const seen2 = /* @__PURE__ */ new Set();
    for (const diagnostic of array(items, manifest.limits.maxDiagnostics)) {
      validateDiagnostic(diagnostic, manifest, coordinates);
      const key3 = canonicalJSON(diagnostic);
      requireValid(!seen2.has(key3), "Duplicate diagnostic");
      seen2.add(key3);
      requireValid(++diagnostics <= manifest.limits.maxDiagnostics, "Diagnostic limit exceeded");
    }
  };
  checkDiagnostics(value4.diagnostics);
  for (const entry of array(value4.reports, manifest.limits.maxPlugins)) {
    const report = object(entry, ["pluginId", "state", "diagnostics"]);
    text(report.pluginId, 64);
    coverage(report.state);
    requireValid(plugins.has(report.pluginId) && !reports.has(report.pluginId), "Unknown or duplicate plugin report");
    const plugin = plugins.get(report.pluginId);
    requireValid(plugin.languages.includes(value4.language) || report.state === "not-applicable", "Unsupported plugin language");
    reports.set(report.pluginId, report.state);
    checkDiagnostics(report.diagnostics);
  }
  requireValid(reports.size === plugins.size, "Missing plugin report");
  const seen = /* @__PURE__ */ new Set();
  const propertyValues = /* @__PURE__ */ new Map();
  for (const entry of array(value4.facts, manifest.limits.maxFacts)) {
    const fact = object(entry, ["kind", "subject", "term", "evidence"], ["resolution", "value", "target"]);
    const evidence = object(fact.evidence, ["pluginId", "ruleId", "basis", "span"]);
    const plugin = plugins.get(evidence.pluginId);
    requireValid(plugin, "Unknown fact plugin");
    validateFact(entry, plugin, manifest, declarations, coordinates);
    requireValid(!["failed", "unsupported", "not-applicable"].includes(reports.get(plugin.id)), "Facts contradict plugin report");
    const key3 = canonicalJSON(entry);
    requireValid(!seen.has(key3), "Duplicate fact");
    seen.add(key3);
    checkCardinality(entry, plugin.properties.find((term) => term.id === entry.term), propertyValues);
  }
  const reportStates = [...reports.values()];
  if (value4.state === "complete" || value4.state === "not-applicable") {
    requireValid(reportStates.every((state) => state === "complete" || state === "not-applicable"), "Incomplete reports hidden by result");
  }
  if (value4.state === "not-applicable") requireValid(seen.size === 0 && reportStates.every((state) => state === "not-applicable"), "Invalid not-applicable result");
  if (value4.state === "unsupported" || value4.state === "failed") {
    requireValid(seen.size === 0 && reportStates.every((state) => ["unsupported", "failed", "not-applicable"].includes(state)), "Facts contradict base coverage");
  }
  if (reportStates.includes("failed")) requireValid(["partial", "failed", "unsupported"].includes(value4.state), "Failed plugin hidden by result");
}

// src/core/wire.ts
var ANNOTATION_LIMITS = Object.freeze({
  maxSourceBytes: 256 * 1024,
  maxDeclarations: 2048,
  maxFacts: 4096,
  maxDiagnostics: 32,
  maxResultBytes: 8 * 1024 * 1024,
  maxManifestBytes: 64 * 1024,
  maxPlugins: 8,
  maxWork: 2e6,
  maxDepth: 128,
  maxValueBytes: 256 * 1024
});

// src/analysis.ts
import { createHash } from "node:crypto";

// src/core/engine.ts
function compare(left, right) {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (; ; ) {
    const x = a.next();
    const y = b.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const difference = x.value.codePointAt(0) - y.value.codePointAt(0);
    if (difference) return difference;
  }
}
function sortedUnique(items) {
  const entries = /* @__PURE__ */ new Map();
  for (const item of items) entries.set(canonicalJSON(item), item);
  return [...entries].sort(([a], [b]) => compare(a, b)).map(([, item]) => item);
}
function clone(value4) {
  return JSON.parse(canonicalJSON(value4));
}
function readonlySnapshot(value4) {
  const immutable = /* @__PURE__ */ new WeakMap();
  let containers = 0;
  let edges = 0;
  const snapshot = (root4, initial = false) => {
    const seen = /* @__PURE__ */ new Map();
    const pending = [];
    const visit = (item) => {
      if (item === null || typeof item !== "object") {
        requireValid(["undefined", "string", "number", "boolean"].includes(typeof item) || item === null, "Invalid language view value");
        return item;
      }
      const existing = seen.get(item) ?? immutable.get(item);
      if (existing) return existing;
      requireValid(++containers <= ANNOTATION_LIMITS.maxWork * 4, "Language view exceeds container limit");
      const prototype = Object.getPrototypeOf(item);
      requireValid(Array.isArray(item) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "Language view must contain plain data");
      const copy = Array.isArray(item) ? [] : /* @__PURE__ */ Object.create(null);
      seen.set(item, copy);
      pending.push([item, copy]);
      return copy;
    };
    const result = visit(root4);
    for (let index = 0; index < pending.length; index++) {
      const [item, copy] = pending[index];
      for (const key3 of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key3 === "length") continue;
        requireValid(++edges <= ANNOTATION_LIMITS.maxWork * 16, "Language view exceeds edge limit");
        requireValid(typeof key3 === "string", "Invalid language view property");
        const property = Object.getOwnPropertyDescriptor(item, key3);
        requireValid(property.enumerable && "value" in property, "Language view accessors are not supported");
        const entry = property.value;
        Object.defineProperty(copy, key3, {
          enumerable: true,
          value: typeof entry === "function" ? Object.freeze((...args) => snapshot(Reflect.apply(entry, copy, args))) : visit(entry)
        });
      }
      Object.freeze(copy);
    }
    for (const [item, copy] of pending) {
      if (initial || Object.isFrozen(item)) immutable.set(item, copy);
    }
    return result;
  };
  return snapshot(value4, true);
}
var BudgetStop = class extends Error {
  diagnostic;
  constructor(resource, accounted, limit) {
    super("Annotation budget exhausted");
    this.diagnostic = { code: "core.budget-limit", message: `resource=${resource} accounted=${accounted} limit=${limit}` };
  }
};
function createAnnotationEngine(options) {
  requireValid(typeof options.digest === "function", "Digest is required");
  const digest2 = options.digest;
  validateAnnotationManifest(options.manifest, digest2);
  const manifest = readonlySnapshot(clone(options.manifest));
  const limits = manifest.limits;
  requireValid(Array.isArray(options.plugins) && options.plugins.length === manifest.plugins.length, "Plugin registry mismatch");
  const registry = /* @__PURE__ */ new Map();
  for (const plugin of options.plugins) {
    const descriptor3 = manifest.plugins.find((item) => item.id === plugin.descriptor.id);
    requireValid(descriptor3 && canonicalJSON(descriptor3) === canonicalJSON(plugin.descriptor), "Plugin descriptor mismatch");
    requireValid(!registry.has(descriptor3.id) && typeof plugin.analyze === "function", "Duplicate or invalid plugin");
    registry.set(descriptor3.id, Object.freeze({ descriptor: descriptor3, analyze: plugin.analyze }));
  }
  const plugins = [...registry.values()].sort((a, b) => compare(a.descriptor.id, b.descriptor.id));
  return Object.freeze({
    analyze(document, view, analyzeOptions) {
      object(document, ["source", "sourceHash", "relativePath", "language"]);
      hash(document.sourceHash);
      relativePath(document.relativePath);
      identifier(document.language, 64);
      const coordinates = sourceCoordinates(document.source, limits.maxSourceBytes);
      requireValid(digest2(document.source) === document.sourceHash, "Source identity mismatch");
      requireValid(view.id === manifest.view.id && view.version === manifest.view.version && view.language === document.language, "Language view mismatch");
      coverage(view.state);
      requireValid(Array.isArray(view.declarations) && Array.isArray(view.diagnostics), "Invalid language view");
      if (analyzeOptions !== void 0) {
        object(analyzeOptions, [], ["cancelled"]);
        requireValid(analyzeOptions.cancelled === void 0 || typeof analyzeOptions.cancelled === "function", "Invalid cancellation callback");
      }
      let cancelled = false;
      const isCancelled = () => {
        cancelled ||= analyzeOptions?.cancelled?.() === true;
        return cancelled;
      };
      let consumedWork = 0;
      let baseTruncated = view.state === "truncated";
      let baseStop;
      let remainingBytes;
      let diagnosticCount = 0;
      const result = {
        version: 1,
        analysisSetId: manifest.id,
        sourceHash: document.sourceHash,
        relativePath: document.relativePath,
        language: document.language,
        state: "not-applicable",
        declarations: [],
        facts: [],
        reports: plugins.map((plugin) => ({ pluginId: plugin.descriptor.id, state: "not-applicable", diagnostics: [] })),
        diagnostics: []
      };
      remainingBytes = limits.maxResultBytes - utf8Length(canonicalJSON(result));
      requireValid(remainingBytes >= 0, "Result limit cannot contain the annotation envelope");
      const retainBytes = (item, count) => {
        const bytes = utf8Length(canonicalJSON(item)) + (count ? 1 : 0);
        if (bytes > remainingBytes) return false;
        remainingBytes -= bytes;
        return true;
      };
      const hardManifest = { ...manifest, limits: { ...limits, maxDeclarations: ANNOTATION_LIMITS.maxDeclarations, maxDepth: ANNOTATION_LIMITS.maxDepth } };
      let known = /* @__PURE__ */ new Map();
      let inventoryExceeded = view.declarations.length > ANNOTATION_LIMITS.maxDeclarations;
      if (inventoryExceeded) baseStop = new BudgetStop("declarations", view.declarations.length, ANNOTATION_LIMITS.maxDeclarations);
      if (!inventoryExceeded) {
        try {
          known = validateDeclarations(clone(view.declarations), hardManifest, coordinates);
        } catch (error) {
          if (!(error instanceof CanonicalLimitError)) throw error;
          inventoryExceeded = true;
        }
      }
      baseTruncated ||= inventoryExceeded;
      for (const declaration of known.values()) declaration.exports.sort(compare);
      const retained = /* @__PURE__ */ new Map();
      for (const declaration of [...known.values()].sort((a, b) => compare(a.key, b.key))) {
        if (retained.has(declaration.key)) continue;
        const chain = [];
        let current = declaration;
        let depth = 0;
        while (current) {
          depth++;
          if (!retained.has(current.key)) chain.unshift(current);
          current = current.owner === void 0 ? void 0 : known.get(current.owner);
        }
        const stop = isCancelled() ? new BudgetStop("cancelled", 1, 0) : depth > limits.maxDepth ? new BudgetStop("depth", depth, limits.maxDepth) : consumedWork + depth > limits.maxWork ? new BudgetStop("work", consumedWork + depth, limits.maxWork) : retained.size + chain.length > limits.maxDeclarations ? new BudgetStop("declarations", retained.size + chain.length, limits.maxDeclarations) : void 0;
        if (stop) {
          baseStop ??= stop;
          baseTruncated = true;
          continue;
        }
        consumedWork += depth;
        const bytes = chain.reduce((sum, item) => sum + utf8Length(canonicalJSON(item)) + 1, 0) - (retained.size ? 0 : 1);
        if (bytes > remainingBytes) {
          baseStop ??= new BudgetStop("result-bytes", limits.maxResultBytes - remainingBytes + bytes, limits.maxResultBytes);
          baseTruncated = true;
          continue;
        }
        remainingBytes -= bytes;
        for (const item of chain) retained.set(item.key, item);
      }
      result.declarations = [...retained.values()].sort((a, b) => compare(a.key, b.key));
      const appendDiagnostics = (items, target) => {
        let truncated = items.length > limits.maxDiagnostics;
        for (const item of sortedUnique(items.slice(0, ANNOTATION_LIMITS.maxDiagnostics))) {
          validateDiagnostic(item, manifest, coordinates);
          if (diagnosticCount >= limits.maxDiagnostics || !retainBytes(item, target.length)) {
            truncated = true;
          } else {
            target.push(clone(item));
            diagnosticCount++;
          }
        }
        return truncated;
      };
      const baseDiagnostics = baseStop && utf8Length(baseStop.diagnostic.message) <= limits.maxValueBytes ? [baseStop.diagnostic, ...view.diagnostics] : view.diagnostics;
      baseTruncated = appendDiagnostics(baseDiagnostics, result.diagnostics) || baseTruncated;
      const immutableDocument = readonlySnapshot({ ...document });
      const immutableView = readonlySnapshot({ ...view, declarations: [...retained.values()] });
      for (let index = 0; index < plugins.length; index++) {
        const plugin = plugins[index];
        const report = result.reports[index];
        if (!plugin.descriptor.languages.includes(document.language)) continue;
        if (view.state === "unsupported" || view.state === "failed" || view.state === "not-applicable") {
          report.state = view.state;
          continue;
        }
        if (inventoryExceeded) {
          report.state = "truncated";
          continue;
        }
        let truncated = false;
        let invalid = false;
        let stopped = false;
        let consumedDepth = 0;
        let active = true;
        let stopReason;
        const buffer = /* @__PURE__ */ new Map();
        const propertyValues = /* @__PURE__ */ new Map();
        const bytesBefore = remainingBytes;
        const reserve = utf8Length(canonicalJSON(new BudgetStop("result-bytes", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).diagnostic)) + 1;
        const reservedBytes = diagnosticCount < limits.maxDiagnostics && remainingBytes >= reserve && limits.maxValueBytes >= reserve ? reserve : 0;
        remainingBytes -= reservedBytes;
        const stop = (resource, accounted, limit) => {
          truncated = true;
          return stopReason ??= new BudgetStop(resource, accounted, limit);
        };
        const budget = Object.freeze({
          step(amount = 1) {
            integer(amount, 1, Number.MAX_SAFE_INTEGER);
            if (!active || stopped) throw stopReason ?? new BudgetStop("inactive", 1, 0);
            if (isCancelled()) {
              stopped = true;
              throw stop("cancelled", 1, 0);
            }
            if (consumedWork + amount > limits.maxWork) {
              stopped = true;
              throw stop("work", consumedWork + amount, limits.maxWork);
            }
            consumedWork += amount;
          },
          depth(depth) {
            integer(depth, 0, Number.MAX_SAFE_INTEGER);
            budget.step();
            if (depth > limits.maxDepth) {
              stopped = true;
              throw stop("depth", depth, limits.maxDepth);
            }
            consumedDepth = Math.max(consumedDepth, depth);
          },
          isCancelled() {
            if (!active || isCancelled()) {
              stopped = true;
              stop("cancelled", 1, 0);
              return true;
            }
            return false;
          },
          get consumedWork() {
            return consumedWork;
          },
          get consumedDepth() {
            return consumedDepth;
          }
        });
        const emit = (data, evidence) => {
          if (!active || invalid) return false;
          budget.step();
          try {
            object(evidence, ["ruleId", "basis", "span"]);
            const candidate = { ...data, evidence: { ...evidence, pluginId: plugin.descriptor.id } };
            validateFact(candidate, plugin.descriptor, manifest, known, coordinates);
            const fact = clone(candidate);
            checkCardinality(fact, plugin.descriptor.properties.find((term) => term.id === fact.term), propertyValues);
            const target = fact.kind === "relation" ? fact.target : fact.kind === "property" && fact.value?.kind === "reference" ? fact.value.value : void 0;
            if (!retained.has(fact.subject) || target?.kind === "declaration" && !retained.has(target.key)) {
              stop("retained-declarations", known.size, retained.size);
              return false;
            }
            const key3 = canonicalJSON(fact);
            if (buffer.has(key3)) return true;
            const count = result.facts.length + buffer.size;
            if (count >= limits.maxFacts) {
              stop("facts", count + 1, limits.maxFacts);
              return false;
            }
            const bytes = utf8Length(key3) + (count ? 1 : 0);
            if (bytes > remainingBytes) {
              stop("result-bytes", limits.maxResultBytes - remainingBytes + bytes, limits.maxResultBytes);
              return false;
            }
            remainingBytes -= bytes;
            buffer.set(key3, fact);
            return true;
          } catch {
            invalid = true;
            return false;
          }
        };
        const emitter = Object.freeze({
          role: (subject, term, evidence) => emit({ kind: "role", subject, term }, evidence),
          property: (subject, term, resolution, value4, evidence) => emit(value4 === void 0 ? { kind: "property", subject, term, resolution } : { kind: "property", subject, term, resolution, value: value4 }, evidence),
          relation: (subject, term, target, evidence) => emit({ kind: "relation", subject, term, target }, evidence)
        });
        let diagnostics = [];
        try {
          budget.step();
          const outcome = plugin.analyze(Object.freeze({ document: immutableDocument, view: immutableView, budget }), emitter);
          if (outcome !== void 0) {
            object(outcome, [], ["state", "diagnostics"]);
            if (outcome.state !== void 0) coverage(outcome.state);
            if (outcome.diagnostics !== void 0) {
              requireValid(Array.isArray(outcome.diagnostics), "Invalid plugin diagnostics");
              diagnostics = clone(outcome.diagnostics.slice(0, ANNOTATION_LIMITS.maxDiagnostics));
              truncated ||= outcome.diagnostics.length > limits.maxDiagnostics;
              for (const item of diagnostics) validateDiagnostic(item, manifest, coordinates);
            }
          }
          report.state = outcome?.state ?? (buffer.size ? "complete" : "not-applicable");
          if (report.state === "failed" || buffer.size && ["not-applicable", "unsupported"].includes(report.state)) invalid = true;
        } catch (error) {
          if (error instanceof BudgetStop) {
            truncated = true;
            stopReason ??= error;
          } else invalid = true;
        } finally {
          active = false;
        }
        if (invalid) {
          remainingBytes = bytesBefore;
          report.state = "failed";
          diagnostics = [{ code: "plugin-failed", message: "Plugin analysis failed." }];
          if (utf8Length(diagnostics[0].message) > limits.maxValueBytes) diagnostics = [];
        } else {
          remainingBytes += reservedBytes;
          if (truncated) report.state = "truncated";
          result.facts.push(...buffer.values());
          if (stopReason && utf8Length(stopReason.diagnostic.message) <= limits.maxValueBytes) {
            appendDiagnostics([stopReason.diagnostic], report.diagnostics);
          }
        }
        if (appendDiagnostics(diagnostics, report.diagnostics) && report.state !== "failed") report.state = "truncated";
      }
      result.facts = sortedUnique(result.facts);
      if (view.state === "unsupported" || view.state === "failed") result.state = view.state;
      else if (result.reports.some((report) => report.state === "failed") || view.state === "partial") result.state = "partial";
      else if (baseTruncated || cancelled || result.reports.some((report) => report.state === "truncated")) result.state = "truncated";
      else if (result.reports.some((report) => report.state === "partial" || report.state === "unsupported")) result.state = "partial";
      else result.state = view.state === "not-applicable" ? "not-applicable" : "complete";
      validateAnnotationResult(result, manifest, document.source);
      return result;
    }
  });
}

// src/typescript/values.ts
var unknown = (reason) => Object.freeze({ known: false, reason });
var primitive = (value4, resolution = "literal") => Object.freeze({ known: true, value: value4, resolution });
function decodeString(text2) {
  const quote = text2[0];
  if (quote !== '"' && quote !== "'" && quote !== "`" || text2.at(-1) !== quote) return void 0;
  return decodeFragment(text2.slice(1, -1));
}
function decodeIdentifier(text2) {
  return text2.includes("\\") ? decodeString(`"${text2}"`) ?? text2 : text2;
}
function decodeFragment(text2) {
  let value4 = "";
  for (let i = 0; i < text2.length; i++) {
    const c = text2[i];
    if (c !== "\\") {
      value4 += c === "\r" ? text2[i + 1] === "\n" ? (i++, "\n") : "\n" : c;
      continue;
    }
    const next = text2[++i];
    if (next === void 0) return void 0;
    if (next === "\n") continue;
    if (next === "\r") {
      if (text2[i + 1] === "\n") i++;
      continue;
    }
    const simple = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", v: "\v", "0": "\0" };
    if (Object.hasOwn(simple, next)) {
      if (next === "0" && /[0-9]/.test(text2[i + 1] ?? "")) return void 0;
      value4 += simple[next];
      continue;
    }
    if (/[1-9]/.test(next)) return void 0;
    if (next === "x" || next === "u") {
      const braced = next === "u" && text2[i + 1] === "{";
      const end = braced ? text2.indexOf("}", i + 2) : i + (next === "x" ? 2 : 4) + 1;
      const digits = text2.slice(i + (braced ? 2 : 1), end);
      if (end < 0 || !/^[0-9a-f]+$/i.test(digits) || !braced && digits.length !== (next === "x" ? 2 : 4)) return void 0;
      const point = Number.parseInt(digits, 16);
      if (point > 1114111) return void 0;
      value4 += String.fromCodePoint(point);
      i = braced ? end : end - 1;
      continue;
    }
    value4 += next;
  }
  return value4;
}
function createConstantQueries(query) {
  const { text: text2, unwrap, binding, limits } = query;
  const constant = (input) => {
    let work = 0;
    const active = /* @__PURE__ */ new Set();
    const bounded = (value4) => value4.known && typeof value4.value === "string" && value4.value.length * 3 > limits.maxValueBytes ? unknown("value-limit") : value4;
    const evaluate = (inputNode, depth) => {
      if (++work > Math.min(limits.maxWork, 512) || depth > Math.min(limits.maxDepth, 24)) return unknown("constant-limit");
      const node = unwrap(inputNode);
      if (active.has(node)) return unknown("constant-cycle");
      active.add(node);
      try {
        const source = text2(node);
        if (node.type === "string") {
          const value4 = decodeString(source);
          return value4 === void 0 ? unknown("string-escape") : bounded(primitive(value4));
        }
        if (node.type === "true" || node.type === "false") return primitive(node.type === "true");
        if (node.type === "null") return primitive(null);
        if (node.type === "number") {
          if (source.endsWith("n")) return unknown("bigint");
          const value4 = Number(source.replaceAll("_", ""));
          return Number.isFinite(value4) ? primitive(value4) : unknown("number");
        }
        if (node.type === "identifier" || node.type === "undefined" || node.type === "shorthand_property_identifier") {
          const found = binding(node);
          if (source === "undefined" && !found) return primitive(void 0);
          if (!found?.available || found.kind !== "const" || !found.stable) return unknown("mutable-or-unresolved-binding");
          const projection = !found.initializer ? query.project(node) : void 0;
          const initial = found.initializer ?? (projection?.path.length === 0 ? projection.initializer : void 0);
          if (!initial || initial === node) return unknown("mutable-or-unresolved-binding");
          const result = evaluate(initial, depth + 1);
          if (!result.known) return result;
          if (typeof result.value === "object" && result.value !== null && !query.stableObject(node)) return unknown("mutable-or-escaped-object");
          return Object.freeze({ ...result, resolution: "constant" });
        }
        if (node.type === "template_string") {
          let value4 = "", cursor = node.startIndex + 1;
          const substitutions = node.children.filter((child) => child.type === "template_substitution");
          for (const substitution of substitutions) {
            const raw = source.slice(cursor - node.startIndex, substitution.startIndex - node.startIndex);
            const fragment = decodeFragment(raw), argument = substitution.children[0];
            const result = argument && evaluate(argument, depth + 1);
            if (fragment === void 0 || !result?.known || typeof result.value === "object" && result.value !== null) return unknown("template-expression");
            value4 += fragment + String(result.value);
            cursor = substitution.endIndex;
            if (value4.length * 3 > limits.maxValueBytes) return unknown("value-limit");
          }
          const tail = decodeFragment(source.slice(cursor - node.startIndex, -1));
          return tail === void 0 ? unknown("template-escape") : bounded(primitive(value4 + tail, substitutions.length ? "constant" : "literal"));
        }
        if (node.type === "unary_expression") {
          const arg = node.fields.argument ?? node.children[0];
          const value4 = arg && evaluate(arg, depth + 1);
          if (!value4?.known || typeof value4.value === "object" && value4.value !== null) return unknown("unary-expression");
          const operator = node.tokens[0];
          if (operator === "void") return primitive(void 0, "constant");
          if (operator === "!") return primitive(!value4.value, "constant");
          if (operator === "-" && typeof value4.value === "number") return primitive(-value4.value, "constant");
          if (operator === "+" && typeof value4.value === "number") return primitive(value4.value, "constant");
          return unknown("unary-operator");
        }
        if (node.type === "binary_expression" && node.tokens.includes("+")) {
          const left = node.fields.left && evaluate(node.fields.left, depth + 1), right = node.fields.right && evaluate(node.fields.right, depth + 1);
          if (!left?.known || !right?.known) return unknown("binary-expression");
          const a = left.value, b = right.value;
          if (typeof a === "object" || typeof b === "object") return unknown("object-coercion");
          if (typeof a === "string" || typeof b === "string") return bounded(primitive(String(a) + String(b), "constant"));
          if (typeof a === "number" && typeof b === "number" && Number.isFinite(a + b)) return primitive(a + b, "constant");
          return unknown("binary-operands");
        }
        if (node.type === "object") {
          let properties4 = /* @__PURE__ */ Object.create(null), unknownKeys = false;
          for (const child of node.children) {
            if (++work > Math.min(limits.maxWork, 512)) return unknown("constant-limit");
            if (child.type === "comment") continue;
            if (child.type === "spread_element") {
              const argument = child.children[0], value5 = argument && evaluate(argument, depth + 1);
              if (value5?.known && value5.value !== null && typeof value5.value === "object") {
                if (value5.value.unknownKeys) {
                  properties4 = /* @__PURE__ */ Object.create(null);
                  unknownKeys = true;
                }
                for (const [key4, result] of Object.entries(value5.value.properties)) properties4[key4] = result.known ? Object.freeze({ ...result, resolution: "constant" }) : result;
              } else {
                properties4 = /* @__PURE__ */ Object.create(null);
                unknownKeys = true;
              }
              continue;
            }
            if (child.type === "shorthand_property_identifier") {
              properties4[decodeIdentifier(text2(child))] = evaluate(child, depth + 1);
              continue;
            }
            const key3 = child.fields.key;
            if (child.type !== "pair" || !key3 || !["property_identifier", "string", "number"].includes(key3.type)) {
              properties4 = /* @__PURE__ */ Object.create(null);
              unknownKeys = true;
              continue;
            }
            const name = key3.type === "string" ? decodeString(text2(key3)) : decodeIdentifier(text2(key3));
            if (name === void 0 || name === "__proto__") {
              properties4 = /* @__PURE__ */ Object.create(null);
              unknownKeys = true;
              continue;
            }
            properties4[name] = child.fields.value ? evaluate(child.fields.value, depth + 1) : unknown("property-value");
          }
          const value4 = Object.freeze({ kind: "object", properties: Object.freeze(properties4), unknownKeys });
          return Object.freeze({ known: true, resolution: "constant", value: value4 });
        }
        if (node.type === "member_expression" && !node.tokens.includes("?.") && node.fields.object && node.fields.property) {
          const object4 = evaluate(node.fields.object, depth + 1);
          if (object4.known && typeof object4.value === "object" && object4.value !== null) {
            const result = object4.value.properties[decodeIdentifier(text2(node.fields.property))];
            return result?.known ? Object.freeze({ ...result, resolution: "constant" }) : result ?? unknown("unknown-property");
          }
        }
        return unknown("unsupported-expression");
      } finally {
        active.delete(node);
      }
    };
    return evaluate(input, 0);
  };
  return {
    constant,
    constantProperty: (node, key3) => {
      const result = constant(node);
      if (!result.known || typeof result.value !== "object" || result.value === null) return unknown("unknown-options");
      const property = result.value.properties[key3] ?? (result.value.unknownKeys ? unknown("unknown-spread-or-key") : unknown("absent"));
      return property.known && unwrap(node).type !== "object" ? Object.freeze({ ...property, resolution: "constant" }) : property;
    }
  };
}

// src/typescript/projections.ts
function createProjectionQueries(query, supplied = []) {
  const { unwrap, text: text2, name, limits } = query;
  const optional5 = (node) => node.tokens.includes("?.") || node.children.some((child) => child.type === "optional_chain");
  const maxWork = Math.min(limits.maxWork, 512), maxDepth = Math.min(limits.maxDepth, 24);
  const contracts = /* @__PURE__ */ new Map();
  const namespaceCalls = /* @__PURE__ */ new Map();
  const ids = /* @__PURE__ */ new Set();
  let metadataWork = 0;
  const shape = (value4, depth) => {
    if (++metadataWork > 2048 || depth > 24) throw new Error("Return contract metadata limit exceeded");
    if (value4.kind === "value") return Object.freeze({ kind: "value" });
    if (value4.kind === "record") return Object.freeze({ kind: "record", value: shape(value4.value, depth + 1) });
    if (value4.kind === "tuple" && value4.items.length <= 64) return Object.freeze({ kind: "tuple", items: Object.freeze(value4.items.map((item) => shape(item, depth + 1))) });
    if (value4.kind === "object" && Object.keys(value4.properties).length <= 64) {
      const properties4 = /* @__PURE__ */ Object.create(null);
      for (const [key3, item] of Object.entries(value4.properties)) {
        if (key3.length > limits.maxValueBytes) throw new Error("Return contract key limit exceeded");
        properties4[key3] = shape(item, depth + 1);
      }
      return Object.freeze({ kind: "object", properties: Object.freeze(properties4) });
    }
    if (value4.kind === "key-partitions" && depth === 0 && Number.isSafeInteger(value4.sourceArgument) && value4.sourceArgument >= 0 && Number.isSafeInteger(value4.keysFromArgument) && value4.keysFromArgument > value4.sourceArgument && value4.keysFromArgument <= 16) return Object.freeze({ ...value4 });
    throw new Error("Invalid return contract shape");
  };
  const observations = (value4) => {
    const integer2 = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 16 && !Object.is(n, -0);
    const member = (name2) => /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name2);
    const fields = (item, names) => Object.keys(item).length === names.length && Object.keys(item).every((key3) => names.includes(key3));
    const step = () => {
      if (++metadataWork > 2048) throw new Error("Return contract metadata limit exceeded");
    };
    if (!fields(value4, ["factoryArities", "uses"]) || value4.factoryArities.length < 1 || value4.factoryArities.length > 16 || value4.uses.length < 1 || value4.uses.length > 16 || new Set(value4.factoryArities).size !== value4.factoryArities.length || !value4.factoryArities.every(integer2)) throw new Error("Invalid handle identity observations");
    const factoryArities = Object.freeze(value4.factoryArities.map((arity) => {
      step();
      return arity;
    }));
    const seen = /* @__PURE__ */ new Set();
    const uses = value4.uses.map((use) => {
      step();
      if (use.kind === "receiver-call" && fields(use, ["kind", "member", "arity"]) && member(use.member) && integer2(use.arity)) return Object.freeze({ ...use });
      if (use.kind === "jsx-member" && fields(use, ["kind", "member"]) && member(use.member)) return Object.freeze({ ...use });
      if (use.kind === "call-argument" && fields(use, ["kind", "origins", "index", "arity"]) && integer2(use.index) && integer2(use.arity) && use.index < use.arity && use.origins.length > 0 && use.origins.length <= 16) {
        const origins3 = use.origins.map((origin) => {
          step();
          if (!fields(origin, ["module", "name"]) || !origin.module || !member(origin.name) || origin.module.length > 4096 || origin.module.startsWith(".") || origin.module.startsWith("/") || origin.module.includes("\\")) throw new Error("Invalid identity consumer origin");
          return Object.freeze({ ...origin });
        });
        if (new Set(origins3.map((origin) => JSON.stringify(origin))).size !== origins3.length) throw new Error("Duplicate identity consumer origin");
        return Object.freeze({ ...use, origins: Object.freeze(origins3) });
      }
      throw new Error("Invalid handle identity use");
    });
    for (const use of uses) {
      const key3 = JSON.stringify(use);
      if (seen.has(key3)) throw new Error("Duplicate handle identity use");
      seen.add(key3);
    }
    return Object.freeze({ factoryArities, uses: Object.freeze(uses) });
  };
  if (supplied.length > 128) throw new Error("Return contract count limit exceeded");
  for (const contract of supplied) {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(contract.id) || ids.has(contract.id) || contract.origins.length < 1 || contract.origins.length > 16) throw new Error("Invalid return contract identity");
    if (contract.invocation !== void 0 && !["call", "construct"].includes(contract.invocation)) throw new Error("Invalid return contract invocation");
    ids.add(contract.id);
    const result = shape(contract.result, 0);
    const identityObservations = contract.identityObservations && observations(contract.identityObservations);
    const namespaceCall = (module, name2, arities) => {
      const key3 = JSON.stringify([module, name2]);
      namespaceCalls.set(key3, /* @__PURE__ */ new Set([...namespaceCalls.get(key3) ?? [], ...arities]));
    };
    if (identityObservations) {
      if (contract.invocation !== "construct") for (const origin of contract.origins) namespaceCall(origin.module, origin.name, identityObservations.factoryArities);
      for (const use of identityObservations.uses) if (use.kind === "call-argument") for (const origin of use.origins) namespaceCall(origin.module, origin.name, [use.arity]);
    }
    for (const origin of contract.origins) {
      if (++metadataWork > 2048 || !origin.module || !origin.name || origin.module.length + origin.name.length > 4096 || origin.module.startsWith(".") || origin.module.startsWith("/") || origin.module.includes("\\")) throw new Error("Invalid return contract origin");
      const key3 = JSON.stringify([contract.invocation ?? "call", origin.module, origin.name]);
      if (contracts.has(key3)) throw new Error("Conflicting return contract origins");
      contracts.set(key3, Object.freeze({ id: contract.id, origins: Object.freeze([]), result, ...identityObservations ? { identityObservations } : {} }));
    }
  }
  const hasIdentityObservations = [...contracts.values()].some((contract) => contract.identityObservations);
  const staticKey = (node) => {
    if (node.type === "computed_property_name") {
      const value5 = node.children[0] && unwrap(node.children[0]);
      return value5 && ["string", "number"].includes(value5.type) ? staticKey(value5) : void 0;
    }
    if (node.type === "number") {
      const value5 = Number(text2(node).replaceAll("_", ""));
      return Number.isSafeInteger(value5) && value5 >= 0 ? value5 : void 0;
    }
    const value4 = name(node);
    return value4 !== void 0 && value4.length * 3 <= limits.maxValueBytes ? value4 : void 0;
  };
  const patternProjections = (input) => {
    const projections = [];
    let work = 0, complete = true;
    const visit = (node, path, depth) => {
      if (++work > maxWork || depth > maxDepth || !query.step()) {
        complete = false;
        return;
      }
      if (["identifier", "undefined", "shorthand_property_identifier_pattern"].includes(node.type)) {
        projections.push(Object.freeze({ node, path: Object.freeze([...path]) }));
        return;
      }
      if (node.type === "required_parameter") {
        const pattern = node.fields.pattern ?? node.fields.name;
        if (!pattern || node.fields.value) {
          complete = false;
          return;
        }
        visit(pattern, path, depth + 1);
        return;
      }
      if (node.type === "array_pattern") {
        const elements = query.elements(node);
        for (let index = 0; index < elements.length; index++) {
          if (++work > maxWork || !query.step()) {
            complete = false;
            break;
          }
          const item = elements[index];
          if (item) visit(item, [...path, index], depth + 1);
        }
        return;
      }
      if (node.type === "object_pattern") {
        for (const item of node.children) {
          if (++work > maxWork || !query.step()) {
            complete = false;
            break;
          }
          if (item.type === "comment") continue;
          if (item.type === "shorthand_property_identifier_pattern") {
            const key3 = staticKey(item);
            if (key3 === void 0) complete = false;
            else visit(item, [...path, key3], depth + 1);
          } else if (item.type === "pair_pattern" && item.fields.key && item.fields.value) {
            const key3 = staticKey(item.fields.key);
            if (key3 === void 0) complete = false;
            else visit(item.fields.value, [...path, key3], depth + 1);
          } else complete = false;
        }
        return;
      }
      complete = false;
    };
    visit(unwrap(input), [], 0);
    return Object.freeze({ complete, projections: Object.freeze(projections) });
  };
  const observe = (node, timing = "start") => timing === "start" ? { node, offset: node.startIndex } : { node, offset: Math.max(node.startIndex, (node.fields.arguments ?? node).endIndex - 1), delivery: node.fields.arguments ?? node };
  const project = (input, inputPath = [], referenceObservation) => {
    let work = 0;
    const active = /* @__PURE__ */ new Set();
    const step = (depth) => ++work <= maxWork && depth <= maxDepth && query.step();
    const args = (node) => {
      const values = node.fields.arguments?.children.filter((item) => item.type !== "comment");
      return values && values.length <= 16 && !values.some((item) => item.type === "spread_element") ? values : void 0;
    };
    const canonicalImport = (inputNode, observation, depth) => {
      const origin = query.resolve(inputNode);
      if (origin.kind !== "import" || origin.member || origin.name === "*") return void 0;
      const namespace = (input2, depth2) => {
        if (!step(depth2)) return void 0;
        const node = unwrap(input2), binding = query.binding(node);
        if (node.type !== "identifier" || !binding?.stable || !binding.available || binding.typeOnly) return void 0;
        if (binding.origin?.name === "*") return binding.origin.module;
        const source = binding.declaration ? query.source(binding.declaration) : void 0;
        return binding.kind === "const" && source?.complete && !source.path.length ? namespace(source.initializer, depth2 + 1) : void 0;
      };
      const stable = (input2, depth2) => {
        if (!step(depth2)) return false;
        const node = unwrap(input2);
        if (node.type === "member_expression" && !optional5(node) && node.fields.object && node.fields.property) return stable(node.fields.object, depth2 + 1);
        const binding = query.binding(node);
        if (!binding?.available || !binding.stable || binding.typeOnly) return false;
        const module = namespace(node, depth2 + 1);
        const preservesNamespace = module ? (occurrence, jsxTag) => {
          if (!step(depth2 + 1) || jsxTag || occurrence.type !== "call_expression" || optional5(occurrence)) return false;
          const fn = occurrence.fields.function && unwrap(occurrence.fields.function), arguments_ = args(occurrence);
          if (fn?.type !== "member_expression" || optional5(fn) || !fn.fields.object || !fn.fields.property || !arguments_ || namespace(fn.fields.object, depth2 + 1) !== module) return false;
          const member = name(fn.fields.property);
          return !!member && !!namespaceCalls.get(JSON.stringify([module, member]))?.has(arguments_.length);
        } : void 0;
        if (!query.stableObject(node, observation.node, observation.offset, observation.delivery, preservesNamespace)) return false;
        if (binding.origin) return true;
        const source = binding.declaration ? query.source(binding.declaration) : void 0;
        return binding.kind === "const" && !!source?.complete && stable(source.initializer, depth2 + 1);
      };
      return stable(inputNode, depth) ? origin : void 0;
    };
    const handleIdentity = (inputNode, observation, depth) => {
      if (!step(depth)) return void 0;
      const node = unwrap(inputNode), binding = query.binding(node);
      if (node.type === "identifier" && binding?.kind === "const" && binding.available && binding.stable && !binding.typeOnly) {
        const source = binding.declaration ? query.source(binding.declaration) : void 0;
        return source?.complete && !source.path.length ? handleIdentity(source.initializer, observation, depth + 1) : void 0;
      }
      const callee = node.type === "new_expression" ? node.fields.constructor : node.type === "call_expression" ? node.fields.function : void 0;
      if (!callee || optional5(node) || optional5(unwrap(callee))) return void 0;
      const origin = canonicalImport(callee, observation, depth + 1), arguments_ = args(node);
      const contract = origin && contracts.get(JSON.stringify([node.type === "new_expression" ? "construct" : "call", origin.module, origin.name]));
      return contract?.identityObservations && arguments_ && contract.identityObservations.factoryArities.includes(arguments_.length) ? { contract, factory: node } : void 0;
    };
    const preservesIdentity = (node, observation, depth) => {
      if (!hasIdentityObservations) return void 0;
      const identity = handleIdentity(node, observation, depth + 1);
      if (!identity) return void 0;
      const sameHandle = (input2) => {
        const candidate = handleIdentity(input2, observation, depth + 1);
        return candidate?.factory === identity.factory && candidate.contract.id === identity.contract.id;
      };
      return (occurrence, jsxTag) => {
        if (!step(depth + 1)) return false;
        for (const use of identity.contract.identityObservations.uses) {
          if (!step(depth + 1)) return false;
          if (use.kind === "receiver-call" && occurrence.type === "call_expression" && !optional5(occurrence)) {
            const fn = occurrence.fields.function && unwrap(occurrence.fields.function), arguments_ = args(occurrence);
            if (fn?.type === "member_expression" && !optional5(fn) && fn.fields.object && fn.fields.property && name(fn.fields.property) === use.member && arguments_?.length === use.arity && sameHandle(fn.fields.object)) return true;
          }
          if (use.kind === "call-argument" && occurrence.type === "arguments") {
            const call = query.callForArguments(occurrence);
            const arguments_ = call && args(call), argument = arguments_?.[use.index];
            if (!call?.fields.function || optional5(call) || arguments_?.length !== use.arity || !argument || !sameHandle(argument)) continue;
            const origin = canonicalImport(call.fields.function, observe(call, "before-call"), depth + 1);
            if (origin && use.origins.some((expected) => expected.module === origin.module && expected.name === origin.name)) return true;
          }
          if (use.kind === "jsx-member" && jsxTag && ["jsx_opening_element", "jsx_self_closing_element"].includes(occurrence.type)) {
            const tag = occurrence.fields.name;
            if (tag?.type === "member_expression" && !optional5(tag) && tag.fields.object && tag.fields.property && name(tag.fields.property) === use.member && sameHandle(tag.fields.object)) return true;
          }
        }
        return false;
      };
    };
    const result = (initializer, path, extra = {}) => Object.freeze({ initializer, path: Object.freeze([...path]), complete: true, ...extra });
    const followsShape = (value4, path, depth) => {
      if (!step(depth)) return false;
      if (!path.length) return true;
      const key3 = path[0];
      if (value4.kind === "record") return String(key3).length * 3 <= limits.maxValueBytes && followsShape(value4.value, path.slice(1), depth + 1);
      if (value4.kind === "tuple") {
        const index = typeof key3 === "number" ? key3 : /^(0|[1-9][0-9]*)$/.test(key3) ? Number(key3) : -1;
        const child = value4.items[index];
        return !!child && followsShape(child, path.slice(1), depth + 1);
      }
      if (value4.kind === "object") {
        const child = Object.hasOwn(value4.properties, String(key3)) ? value4.properties[String(key3)] : void 0;
        return !!child && followsShape(child, path.slice(1), depth + 1);
      }
      return false;
    };
    const visit = (inputNode, path, depth, observedAt) => {
      if (!step(depth) || path.length > maxDepth) return void 0;
      const node = unwrap(inputNode);
      const observation = node.startIndex > observedAt.offset ? observe(node) : observedAt;
      if (active.has(node)) return void 0;
      active.add(node);
      try {
        if (["identifier", "undefined", "shorthand_property_identifier"].includes(node.type)) {
          const binding = query.binding(node);
          if (binding) {
            if (!binding.available || binding.typeOnly || !binding.stable) return void 0;
            const preserves = path.length || referenceObservation ? preservesIdentity(node, observation, depth) : void 0;
            if (referenceObservation && !query.stableObject(node, observation.node, observation.offset, observation.delivery, preserves)) return void 0;
            const source = binding.declaration && query.source(binding.declaration);
            if (source) {
              if (!source.complete || (path.length > 0 || referenceObservation) && !query.stableObject(node, observation.node, observation.offset, observation.delivery, preserves)) return void 0;
              return visit(source.initializer, [...source.path, ...path], depth + 1, path.length || referenceObservation ? observation : observe(source.initializer));
            }
            if (binding.initializer && binding.kind === "const") return visit(binding.initializer, path, depth + 1, path.length || referenceObservation ? observation : observe(binding.initializer));
            if (path.length && binding.origin?.name === "*" && path.length === 1 && typeof path[0] === "string") return result(node, path);
          }
          return path.length ? void 0 : result(node, path);
        }
        if (node.type === "member_expression" && !optional5(node) && node.fields.object && node.fields.property) {
          const key4 = staticKey(node.fields.property);
          return key4 === void 0 ? void 0 : visit(node.fields.object, [key4, ...path], depth + 1, observation);
        }
        if (node.type === "subscript_expression" && !optional5(node) && node.fields.object && node.fields.index) {
          const key4 = staticKey(unwrap(node.fields.index));
          if (!["string", "number"].includes(unwrap(node.fields.index).type)) return void 0;
          return key4 === void 0 ? void 0 : visit(node.fields.object, [key4, ...path], depth + 1, observation);
        }
        const callee = node.type === "new_expression" ? node.fields.constructor : node.fields.function;
        if (["call_expression", "new_expression"].includes(node.type) && callee && !optional5(node) && !optional5(unwrap(callee))) {
          const origin = query.resolve(callee);
          const contract = origin.kind === "import" && !origin.member ? contracts.get(JSON.stringify([node.type === "new_expression" ? "construct" : "call", origin.module, origin.name])) : void 0;
          if (!contract) return path.length ? void 0 : result(node, path);
          if (contract.identityObservations && !handleIdentity(node, observation, depth + 1)) return path.length ? void 0 : result(node, path);
          if (node.type === "new_expression") {
            const constructed = observe(node, "before-call");
            if (!project(callee, [], constructed.offset > observation.offset ? constructed : observation)) return void 0;
          }
          if ((node.fields.arguments?.children.length ?? 0) > maxWork) return void 0;
          const args2 = node.fields.arguments?.children.filter((item) => item.type !== "comment") ?? [];
          if (args2.some((item) => item.type === "spread_element")) return void 0;
          if (contract.result.kind !== "key-partitions") return followsShape(contract.result, path, depth + 1) ? result(node, path, { contract: contract.id }) : void 0;
          const source = args2[contract.result.sourceArgument], groups = args2.slice(contract.result.keysFromArgument);
          if (!source || groups.length > 16) return void 0;
          const claimed = /* @__PURE__ */ new Set(), keys = [];
          let keyBytes = 0;
          for (const group of groups) {
            if (!step(depth + 1)) return void 0;
            const literal = unwrap(group);
            if (literal.type !== "array") return void 0;
            if (query.elements(literal).length > 64) return void 0;
            const values = [];
            for (const element of query.elements(literal)) {
              if (!step(depth + 1) || !element) return void 0;
              const keyNode = unwrap(element);
              const key4 = keyNode.type === "string" ? decodeString(text2(keyNode)) : void 0;
              if (key4 === void 0) return void 0;
              keyBytes += key4.length * 3;
              if (claimed.has(key4) || claimed.size >= 64 || keyBytes > limits.maxValueBytes) return void 0;
              claimed.add(key4);
              values.push(key4);
            }
            keys.push(Object.freeze(values));
          }
          if (path.length) {
            const index = typeof path[0] === "number" ? path[0] : /^(0|[1-9][0-9]*)$/.test(path[0]) ? Number(path[0]) : -1;
            if (index < 0 || index > keys.length || path.length > 2) return void 0;
            if (path.length === 2 && (index === keys.length ? claimed.has(String(path[1])) : !keys[index].includes(String(path[1])))) return void 0;
          }
          return result(node, path, { contract: contract.id, partitions: Object.freeze({ source, keys: Object.freeze(keys) }) });
        }
        if (!path.length) return result(node, path);
        const key3 = path[0];
        if (node.type === "array") {
          const items = query.elements(node);
          if (items.length > maxWork) return void 0;
          if (items.some((item2) => item2?.type === "spread_element")) return void 0;
          const index = typeof key3 === "number" ? key3 : /^(0|[1-9][0-9]*)$/.test(key3) ? Number(key3) : -1;
          const item = items[index];
          return item ? visit(item, path.slice(1), depth + 1, path.length > 1 || referenceObservation ? observation : observe(item)) : void 0;
        }
        if (node.type === "object") {
          let selected;
          for (const item of node.children) {
            if (!step(depth + 1)) return void 0;
            if (item.type === "comment") continue;
            if (item.type === "spread_element") {
              const value4 = item.children.find((child) => child.type !== "comment");
              selected = value4 ? visit(value4, path, depth + 1, observation) : void 0;
              continue;
            }
            if (item.type === "shorthand_property_identifier") {
              if (name(item) === String(key3)) selected = visit(item, path.slice(1), depth + 1, path.length > 1 || referenceObservation ? observation : observe(item));
              continue;
            }
            if (item.type !== "pair" || !item.fields.key || !item.fields.value) {
              selected = void 0;
              continue;
            }
            const property = staticKey(item.fields.key);
            if (property === "__proto__") return void 0;
            if (property === void 0) selected = void 0;
            else if (String(property) === String(key3)) selected = visit(item.fields.value, path.slice(1), depth + 1, path.length > 1 || referenceObservation ? observation : observe(item.fields.value));
          }
          return selected;
        }
        return void 0;
      } finally {
        active.delete(node);
      }
    };
    return visit(input, inputPath, 0, referenceObservation ?? observe(input));
  };
  const referenceStable = (input, observation, timing = "start") => {
    const value4 = project(input, [], observe(observation, timing));
    if (!value4 || value4.path.length) return false;
    const node = value4.initializer;
    if (["identifier", "undefined", "shorthand_property_identifier"].includes(node.type)) return !!query.binding(node)?.available;
    if (["call_expression", "new_expression"].includes(node.type)) return !!value4.contract;
    return ["object", "array", "string", "number", "true", "false", "null", "arrow_function", "function_expression", "function_declaration", "generator_function", "generator_function_declaration", "method_definition"].includes(node.type);
  };
  return { patternProjections, project, referenceStable };
}

// src/typescript/bindings.ts
function createBindingQueries(query) {
  const { limits, unwrap, name, span: span2, text: text2 } = query;
  const maxWork = Math.min(limits.maxWork, 512), maxDepth = Math.min(limits.maxDepth, 24);
  const byteLength = (value4) => {
    let bytes = 0;
    for (const point of value4) {
      const n = point.codePointAt(0);
      bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
    }
    return bytes;
  };
  const validText = (value4) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value4);
  const expression = (node) => ({ kind: "expression", text: text2(node), span: span2(node) });
  const staticKey = (node) => {
    if (node.type === "number") {
      const value5 = Number(text2(node).replaceAll("_", ""));
      return Number.isFinite(value5) ? String(value5) : void 0;
    }
    if (node.type === "computed_property_name") {
      const value5 = node.children.find((child) => child.type !== "comment");
      return value5 && ["string", "number"].includes(unwrap(value5).type) ? staticKey(unwrap(value5)) : void 0;
    }
    const value4 = name(node);
    return value4 !== void 0 && byteLength(value4) <= 2048 && validText(value4) ? value4 : void 0;
  };
  const key3 = (node) => {
    const literal = staticKey(node);
    if (literal !== void 0) return literal;
    const value4 = node.type === "computed_property_name" && node.children.find((child) => child.type !== "comment");
    return value4 ? expression(value4) : void 0;
  };
  const fits = (value4) => {
    const valid = (item) => typeof item === "string" ? validText(item) : !item || typeof item !== "object" || Object.values(item).every(valid);
    try {
      return valid(value4) && byteLength(canonicalJSON(value4)) <= limits.maxValueBytes;
    } catch {
      return false;
    }
  };
  const shapes2 = (input) => {
    let work = 0;
    const active = /* @__PURE__ */ new Set();
    const step = (depth) => ++work <= maxWork && depth <= maxDepth && query.step();
    const merge = (left, right) => left && right && left.length + right.length <= 16 ? [...left, ...right] : void 0;
    const visit = (inputNode, depth, observation) => {
      if (!step(depth)) return void 0;
      const node = unwrap(inputNode);
      const observed = node.startIndex > observation.startIndex ? node : observation;
      if (active.has(node)) return void 0;
      active.add(node);
      try {
        if (node.type === "array") {
          const elements = query.elements(node);
          return elements.length <= 64 && elements.every((item) => item?.type !== "spread_element") ? [{ kind: "tuple", span: span2(node), length: elements.length }] : void 0;
        }
        if (node.type === "object") {
          const keys = [];
          for (const child of node.children) {
            if (!step(depth + 1)) return void 0;
            if (child.type === "comment") continue;
            const property = child.type === "shorthand_property_identifier" ? staticKey(child) : child.type === "pair" && child.fields.key ? staticKey(child.fields.key) : void 0;
            if (property === void 0 || property === "__proto__") return void 0;
            if (!keys.includes(property)) keys.push(property);
            if (keys.length > 64) return void 0;
          }
          return [{ kind: "object", span: span2(node), keys }];
        }
        if (node.type === "ternary_expression" && node.fields.consequence && node.fields.alternative) {
          return merge(visit(node.fields.consequence, depth + 1, observed), visit(node.fields.alternative, depth + 1, observed));
        }
        if (node.type === "identifier") {
          const binding = query.binding(node);
          if (binding?.kind === "const" && binding.stable && binding.available && !binding.typeOnly && binding.initializer && query.stableObject(node, observed)) {
            return visit(binding.initializer, depth + 1, observed);
          }
        }
        if (node.type === "call_expression" && node.fields.function && !node.tokens.includes("?.")) {
          const callable = (input2, depth2) => {
            if (!step(depth2)) return void 0;
            const value4 = unwrap(input2);
            if (["function_declaration", "function_expression", "arrow_function"].includes(value4.type)) return value4;
            const binding = value4.type === "identifier" && query.binding(value4);
            if (!binding || !binding.available || !binding.stable || binding.typeOnly) return void 0;
            if (binding.kind === "function") return binding.node;
            if (binding.kind === "const" && binding.initializer) return callable(binding.initializer, depth2 + 1);
            return void 0;
          };
          const fn = callable(node.fields.function, depth + 1), body = fn?.fields.body;
          if (!fn || !body || fn.tokens.includes("async") || fn.tokens.includes("*")) return void 0;
          if (body.type !== "statement_block") return visit(body, depth + 1, body);
          const returns = [];
          let valid = true;
          const flow = (statement, depth2) => {
            if (!step(depth2)) {
              valid = false;
              return false;
            }
            if (statement.type === "return_statement") {
              const value4 = statement.children.find((child) => child.type !== "comment");
              const result = value4 && visit(value4, depth2 + 1, value4);
              if (!result || returns.length + result.length > 16) valid = false;
              else returns.push(...result);
              return true;
            }
            if (statement.type === "throw_statement") return true;
            if (statement.type === "statement_block") {
              for (const child of statement.children) if (flow(child, depth2 + 1)) return true;
              return false;
            }
            if (statement.type === "if_statement" && statement.fields.consequence) {
              const left = flow(statement.fields.consequence, depth2 + 1);
              const alternative = statement.fields.alternative;
              const right = alternative ? flow(alternative, depth2 + 1) : false;
              return left && right;
            }
            if (statement.type === "else_clause") {
              const child = statement.children.find((child2) => child2.type !== "comment");
              return child ? flow(child, depth2 + 1) : false;
            }
            if (["function_declaration", "class_declaration", "comment", "empty_statement"].includes(statement.type)) return false;
            const inspect = (child, depth3) => {
              if (!step(depth3)) {
                valid = false;
                return;
              }
              if (["function_expression", "arrow_function", "function_declaration", "method_definition", "class", "class_declaration"].includes(child.type)) return;
              if (["return_statement", "try_statement", "yield_expression"].includes(child.type)) {
                valid = false;
                return;
              }
              for (const nested of child.children) inspect(nested, depth3 + 1);
            };
            inspect(statement, depth2 + 1);
            return false;
          };
          const terminates = flow(body, depth + 1);
          return valid && terminates && returns.length ? returns : void 0;
        }
        return void 0;
      } finally {
        active.delete(node);
      }
    };
    return visit(input, 0, input);
  };
  const pattern = (input, source) => {
    let work = 0, complete = true;
    const bindings = [];
    const alternatives = shapes2(source);
    const visit = (inputNode, operations, depth) => {
      if (++work > maxWork || depth > maxDepth || operations.length > maxDepth || !query.step()) {
        complete = false;
        return;
      }
      const node = unwrap(inputNode);
      if (["identifier", "undefined", "shorthand_property_identifier_pattern"].includes(node.type)) {
        const evidence = { source: expression(source), sourceSpan: span2(source), patternSpan: span2(input), operations, value: "unknown", ...alternatives ? { shapes: alternatives } : {} };
        if (!operations.length || !fits(evidence)) {
          complete = false;
          return;
        }
        bindings.push({ node, evidence });
        return;
      }
      if (["assignment_pattern", "object_assignment_pattern"].includes(node.type)) {
        const left = node.fields.left ?? node.children[0], right = node.fields.right ?? node.children.at(-1);
        if (!left || !right || left === right) {
          complete = false;
          return;
        }
        visit(left, [...operations, { kind: "default", span: span2(node), value: expression(right) }], depth + 1);
        return;
      }
      if (node.type === "array_pattern") {
        const items = query.elements(node);
        for (let index = 0; index < items.length; index++) {
          if (++work > maxWork || !query.step()) {
            complete = false;
            break;
          }
          const item = items[index];
          if (!item) continue;
          const rest = item.type === "rest_pattern", target = rest ? item.children.find((child) => child.type !== "comment") : item;
          if (!target || rest && index !== items.length - 1) {
            complete = false;
            continue;
          }
          visit(target, [...operations, { kind: rest ? "iterator-rest" : "iterator", span: span2(item), index }], depth + 1);
        }
        return;
      }
      if (node.type === "object_pattern") {
        const excludedKeys = [];
        for (const item of node.children) {
          if (++work > maxWork || !query.step()) {
            complete = false;
            break;
          }
          if (item.type === "comment") continue;
          if (item.type === "rest_pattern") {
            const target2 = item.children.find((child) => child.type !== "comment");
            if (!target2 || excludedKeys.length > 64) complete = false;
            else visit(target2, [...operations, { kind: "object-rest", span: span2(item), excludedKeys: [...excludedKeys] }], depth + 1);
            continue;
          }
          const keyNode = item.type === "pair_pattern" ? item.fields.key : item.type === "object_assignment_pattern" ? item.fields.left ?? item.children[0] : item;
          const property = keyNode && key3(keyNode);
          const target = item.type === "pair_pattern" ? item.fields.value : item;
          if (property === void 0 || !target) {
            complete = false;
            continue;
          }
          excludedKeys.push(property);
          visit(target, [...operations, typeof property === "string" ? { kind: "property", span: span2(item), key: property } : { kind: "computed-property", span: span2(item), key: property }], depth + 1);
        }
        return;
      }
      complete = false;
    };
    visit(input, [], 0);
    return { complete: complete && bindings.length > 0, bindings };
  };
  return { pattern };
}

// module_catalog.json
var module_catalog_default = {
  MODULE_FAMILIES: [
    "@fst/components-fst-solid",
    "@fst/components-fst-disco-ui",
    "@fst/components-fst-solid-icons",
    "@fst/components-fst-solid-threejs",
    "solid-js",
    "@solidjs/router"
  ],
  MODULE_ALIAS_TARGETS: [
    "@fst/components-fst-solid",
    "@fst/components-fst-disco-ui",
    "@fst/components-fst-solid-icons",
    "@fst/components-fst-solid-threejs",
    "solid-js",
    "@solidjs/router",
    "@fst/components-fst-solid/app",
    "@fst/components-fst-solid/app/component",
    "@fst/components-fst-solid/app/state",
    "@fst/components-fst-solid/app/state/onChange",
    "@fst/components-fst-solid/app/state/state",
    "@fst/components-fst-solid/app/state/state.list",
    "@fst/components-fst-solid/app/state/confirmation",
    "@fst/components-fst-solid/app/form",
    "@fst/components-fst-solid/app/scope",
    "@fst/components-fst-solid/app/scope/itemScope",
    "@fst/components-fst-solid/app/field",
    "@fst/components-fst-solid/app/fieldBinding",
    "@fst/components-fst-solid/app/model",
    "@fst/components-fst-solid/app/load",
    "@fst/components-fst-solid/app/fragment",
    "@fst/components-fst-solid/app/props",
    "@fst/components-fst-solid/app/dom/hooks",
    "@fst/components-fst-solid/app/dom/extendedDom",
    "@fst/components-fst-solid/app/action",
    "@fst/components-fst-solid/app/router",
    "@fst/components-fst-solid/app/backendApi",
    "@fst/components-fst-solid/hooks/value",
    "@fst/components-fst-solid/hooks/delayed",
    "@fst/components-fst-solid/hooks/timer",
    "@fst/components-fst-solid/hooks/documentEvent",
    "@fst/components-fst-solid/hooks/windowEvent",
    "@fst/components-fst-solid/hooks/windowSize",
    "@fst/components-fst-solid/hooks/mouse",
    "@fst/components-fst-solid/hooks/resize",
    "@fst/components-fst-solid/hooks/reorder",
    "@fst/components-fst-solid/animation/Show",
    "@fst/components-fst-solid/animation/Animate",
    "@fst/components-fst-solid/signalr",
    "@fst/components-fst-solid/signalr/onMessageHook",
    "@fst/components-fst-solid/signalr/hub",
    "@fst/components-fst-solid/signalr/api",
    "@fst/components-fst-solid/http/api",
    "@fst/components-fst-solid/http/retry",
    "@fst/components-fst-solid/webview/interop",
    "@fst/components-fst-solid/async",
    "@fst/components-fst-solid/async/promise",
    "@fst/components-fst-solid/async/delay",
    "@fst/components-fst-solid/collections/array",
    "@fst/components-fst-solid/cn",
    "@fst/components-fst-solid/cn/cnExtract",
    "@fst/components-fst-solid/cache/IndexDbCache",
    "@fst/components-fst-solid/session/sessionStorage",
    "@fst/components-fst-solid/solid-js",
    "@fst/components-fst-solid/solid-js/store",
    "@fst/components-fst-solid/solid-js/web",
    "@fst/components-fst-disco-ui/components",
    "@fst/components-fst-disco-ui/theme",
    "@fst/components-fst-solid-icons/assets",
    "@fst/components-fst-solid-icons/components",
    "@fst/components-fst-solid-threejs/Canvas",
    "@fst/components-fst-solid-threejs/scene",
    "@fst/components-fst-solid-threejs/scene/scenegraph",
    "@fst/components-fst-solid-threejs/utils",
    "@fst/components-fst-solid-threejs/assets",
    "@fst/components-fst-solid-threejs/effects",
    "solid-js/store",
    "solid-js/web"
  ]
};

// src/typescript/module-aliases.ts
var MODULE_FAMILIES = Object.freeze(module_catalog_default.MODULE_FAMILIES);
var MODULE_ALIAS_TARGETS = Object.freeze(module_catalog_default.MODULE_ALIAS_TARGETS);
var targets = new Set(MODULE_ALIAS_TARGETS);
var bareModule = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
var within = (module, prefix) => module === prefix || module.startsWith(`${prefix}/`);
function normalizeModuleAliases(input = {}) {
  requireValid(input !== null && typeof input === "object" && !Array.isArray(input), "Invalid module aliases");
  const value4 = object(input, [], Object.keys(input));
  const keys = Object.keys(value4).sort();
  requireValid(keys.length <= 64 && canonicalJSON(value4).length <= 4096, "Module alias limit exceeded");
  for (const key3 of keys) {
    requireValid(key3.length <= 256 && bareModule.test(key3), "Invalid module alias prefix");
    requireValid(!MODULE_FAMILIES.some((root4) => within(key3, root4) || within(root4, key3)), "Canonical module identities cannot be aliased");
    requireValid(typeof value4[key3] === "string" && targets.has(value4[key3]), "Unsupported module alias target");
  }
  return Object.freeze(Object.fromEntries(keys.map((key3) => [key3, value4[key3]])));
}
function createModuleIdentity(moduleAliases) {
  const prefixes = Object.keys(moduleAliases).sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
  return (module) => {
    const prefix = prefixes.find((prefix2) => within(module, prefix2));
    if (prefix === void 0) return module;
    requireValid(bareModule.test(module), "Unsupported aliased module specifier");
    return moduleAliases[prefix] + module.slice(prefix.length);
  };
}

// src/typescript/index.ts
var functions = /* @__PURE__ */ new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function", "method_definition", "function_signature", "method_signature", "abstract_method_signature"]);
var classes = /* @__PURE__ */ new Set(["class_declaration", "abstract_class_declaration", "class"]);
var wrappers = /* @__PURE__ */ new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "type_assertion", "non_null_expression", "instantiation_expression"]);
function createTypeScriptView(options) {
  const { source, language, relativePath: relativePath2, sourceHash } = options;
  const canonicalModule = createModuleIdentity(normalizeModuleAliases(options.moduleAliases));
  if (source.length > ANNOTATION_LIMITS.maxSourceBytes) throw new Error("TypeScript source byte limit exceeded");
  const limits = { ...ANNOTATION_LIMITS };
  for (const key3 of Object.keys(limits)) {
    const value4 = options.limits?.[key3];
    if (value4 !== void 0) {
      if (!Number.isSafeInteger(value4) || value4 < 1 || value4 > limits[key3]) throw new Error("Invalid TypeScript view limit");
      limits[key3] = value4;
    }
  }
  if (language !== "typescript" && language !== "tsx") throw new Error("Unsupported TypeScript view language");
  let state = "complete";
  let work = 0;
  const diagnostics = [];
  const note = (code, message, next = "partial") => {
    if (utf8Length2(message) <= limits.maxValueBytes && !diagnostics.some((d) => d.code === code) && diagnostics.length < limits.maxDiagnostics) diagnostics.push({ code, message });
    if (state === "complete" || next === "truncated" || next === "unsupported") state = next;
  };
  const tick = (amount = 1) => {
    work += amount;
    if (options.cancelled?.()) {
      note("typescript.cancelled", "Analysis cancelled.", "truncated");
      return false;
    }
    if (work > limits.maxWork) {
      note("typescript.work-limit", `resource=work accounted=${work} limit=${limits.maxWork}`, "truncated");
      return false;
    }
    return true;
  };
  const bytes = new Uint32Array(source.length + 1);
  const lines = new Uint32Array(source.length + 1);
  let byte = 0, line = 1;
  for (let i = 0; i < source.length; i++) {
    bytes[i] = byte;
    lines[i] = line;
    const code = source.charCodeAt(i);
    if (code >= 55296 && code <= 56319 && source.charCodeAt(i + 1) >= 56320 && source.charCodeAt(i + 1) <= 57343) {
      bytes[++i] = byte;
      lines[i] = line;
      byte += 4;
    } else byte += code < 128 ? 1 : code < 2048 ? 2 : 3;
    if (code === 10) line++;
  }
  bytes[source.length] = byte;
  lines[source.length] = line;
  if (byte > limits.maxSourceBytes) throw new Error("TypeScript source byte limit exceeded");
  const span2 = (node) => Object.freeze({
    startByte: bytes[node.startIndex],
    endByte: bytes[node.endIndex],
    startLine: lines[node.startIndex],
    endLine: lines[Math.max(node.startIndex, node.endIndex - 1)]
  });
  const text2 = (node) => source.slice(node.startIndex, node.endIndex);
  const name = (node) => node.type === "string" ? decodeString(text2(node)) : ["identifier", "undefined", "type_identifier", "property_identifier", "private_property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"].includes(node.type) ? decodeIdentifier(text2(node)) : void 0;
  const parents = /* @__PURE__ */ new Map();
  const arrayElements = /* @__PURE__ */ new Map();
  const nodes = [];
  const rawRoot = "rootNode" in options.tree ? options.tree.rootNode : options.tree;
  if (rawRoot.hasError) note("typescript.parse-error", "Recovered syntax is not eligible for verified framework facts.", "unsupported");
  const copy = (raw, depth) => {
    if (!Number.isInteger(raw.startIndex) || !Number.isInteger(raw.endIndex) || raw.startIndex < 0 || raw.endIndex < raw.startIndex || raw.endIndex > source.length) throw new Error("Invalid supplied syntax span");
    const children = [], tokens = [], elements = [];
    let elementIndex = 0;
    const fields = /* @__PURE__ */ Object.create(null);
    const node = { type: raw.type, startIndex: raw.startIndex, endIndex: raw.endIndex, children, fields, tokens };
    nodes.push(node);
    if (raw.isMissing || raw.type === "ERROR") note("typescript.parse-error", "Recovered syntax is not eligible for verified framework facts.", "unsupported");
    if (depth >= limits.maxDepth) note("typescript.depth-limit", `resource=syntax-depth accounted=${depth} limit=${limits.maxDepth}`, "truncated");
    else if (tick()) for (let i = 0; i < raw.childCount; i++) {
      if (!tick()) break;
      const child = raw.child(i);
      if (!child) continue;
      if (!child.isNamed) {
        tokens.push(child.type);
        if (child.type === "," && ["array", "array_pattern"].includes(raw.type)) {
          elements[elementIndex] ??= null;
          elementIndex++;
        }
        continue;
      }
      const normalized = copy(child, depth + 1);
      children.push(normalized);
      parents.set(normalized, node);
      if (["array", "array_pattern"].includes(raw.type) && normalized.type !== "comment") elements[elementIndex] = normalized;
      const field = raw.fieldNameForChild(i);
      if (field && !fields[field]) fields[field] = normalized;
    }
    Object.freeze(children);
    Object.freeze(fields);
    Object.freeze(tokens);
    if (["array", "array_pattern"].includes(raw.type)) arrayElements.set(node, Object.freeze(elements));
    return Object.freeze(node);
  };
  const root4 = copy(rawRoot, 0);
  const nodeKey2 = (node) => `${node.type}:${node.startIndex}:${node.endIndex}`;
  const originals = new Map(nodes.map((node) => [nodeKey2(node), node]));
  const original = (node) => {
    const result = originals.get(nodeKey2(node));
    if (!result) throw new Error("Node is not part of this TypeScript view");
    return result;
  };
  const modules = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    if (!["import_statement", "export_statement"].includes(node.type) || !node.fields.source) continue;
    const sourceNode = node.fields.source;
    const module = sourceNode.type === "string" ? decodeString(text2(sourceNode)) : void 0;
    if (module === void 0) continue;
    try {
      modules.set(sourceNode, canonicalModule(module));
    } catch {
      note("typescript.module-alias-specifier", "Aliased module specifier is outside the supported bare-module syntax.", "unsupported");
    }
  }
  const moduleIdentity = (node) => modules.get(original(node));
  const unwrap = (input) => {
    let node = original(input);
    for (let i = 0; i < limits.maxDepth && wrappers.has(node.type); i++) {
      const next = node.fields.expression ?? (node.type === "type_assertion" ? node.children.at(-1) : node.children[0]);
      if (!next || next === node) break;
      node = next;
    }
    return node;
  };
  const declarations = [];
  const declarationByKey = /* @__PURE__ */ new Map();
  const declarationNodes = /* @__PURE__ */ new Map();
  const nodeDeclarations = /* @__PURE__ */ new Map();
  const scopes = /* @__PURE__ */ new Map();
  const bindingSources = /* @__PURE__ */ new Map();
  const declarationBindings = /* @__PURE__ */ new Map();
  let constructing = true;
  const projectionQueries = createProjectionQueries({
    text: text2,
    name,
    unwrap,
    limits,
    binding: (node) => bindingAt(node),
    resolve: (node) => resolve2(node),
    source: (key3) => bindingSources.get(key3),
    elements: (node) => arrayElements.get(original(node)) ?? [],
    callForArguments: (node) => {
      const parent = parents.get(original(node));
      return parent?.type === "call_expression" && parent.fields.arguments === original(node) ? parent : void 0;
    },
    stableObject: (node, observation, offset, delivery, preservesIdentity) => stableObject(node, observation, offset, delivery, preservesIdentity),
    step: () => !constructing || tick()
  }, options.returnContracts);
  const rootScope = { functionScope: true, bindings: /* @__PURE__ */ new Map() };
  const addBinding = (binding) => {
    binding.name = decodeIdentifier(binding.name);
    const existing = binding.scope.bindings.get(binding.name) ?? [];
    existing.push(binding);
    binding.scope.bindings.set(binding.name, existing);
    if (binding.declaration) declarationBindings.set(binding.declaration, binding);
  };
  const add2 = (node, kind, nameNode, owner, exports = []) => {
    if (declarations.length >= limits.maxDeclarations) {
      note("typescript.declaration-limit", "Declaration limit reached.", "truncated");
      return void 0;
    }
    const range = span2(node);
    const key3 = `d:${kind}:${range.startByte}:${range.endByte}:${owner ? span2(declarationNodes.get(owner.key)).startByte : 0}`;
    const name2 = nameNode && (nameNode.type === "string" ? decodeString(text2(nameNode)) : decodeIdentifier(text2(nameNode)));
    if (name2 !== void 0 && (utf8Length2(name2) > Math.min(2048, limits.maxValueBytes) || !wellFormed(name2))) {
      note("typescript.name-limit", "Declaration name exceeds the metadata or Unicode limit.");
      return void 0;
    }
    const declaration = { key: key3, kind, span: range, exports: exports.map(decodeIdentifier) };
    if (name2) {
      declaration.name = name2;
      declaration.nameSpan = span2(nameNode);
    }
    if (owner) declaration.owner = owner.key;
    declarations.push(declaration);
    declarationByKey.set(key3, declaration);
    declarationNodes.set(key3, node);
    if (!nodeDeclarations.has(node)) nodeDeclarations.set(node, declaration);
    return declaration;
  };
  const patternNames = (node) => {
    if (node.type === "this" || node.type === "comment") return [];
    if (["identifier", "undefined", "shorthand_property_identifier_pattern", "type_identifier"].includes(node.type)) return [node];
    if (node.type === "pair_pattern") return node.fields.value ? patternNames(node.fields.value) : [];
    if (["assignment_pattern", "object_assignment_pattern"].includes(node.type)) return node.fields.left ? patternNames(node.fields.left) : node.children[0] ? patternNames(node.children[0]) : [];
    if (["object_pattern", "array_pattern", "rest_pattern", "required_parameter", "optional_parameter"].includes(node.type)) {
      const pattern = node.fields.pattern ?? node.fields.name;
      return pattern ? patternNames(pattern) : node.children.filter((n) => n.type !== "type_annotation").flatMap(patternNames);
    }
    note("typescript.binding-pattern", "Unsupported binding pattern remains unresolved.");
    return [];
  };
  const walk = (node, scope, owner, exported = []) => {
    if (!tick()) return;
    scopes.set(node, scope);
    if (node.type === "import_statement") {
      const moduleNode = node.fields.source;
      const module = moduleNode && moduleIdentity(moduleNode);
      const clause = node.children.find((n) => n.type === "import_clause");
      if (module && clause) {
        const typeOnly = node.tokens.includes("type");
        for (const part of clause.children) {
          const importBinding = (nameNode, imported, onlyType) => addBinding({ name: text2(nameNode), kind: "import", node: nameNode, origin: { kind: "import", module, name: imported }, typeOnly: onlyType, valueOnly: false, scope, stable: true, availableFrom: 0 });
          if (part.type === "identifier") importBinding(part, "default", typeOnly);
          else if (part.type === "namespace_import") {
            const name2 = part.children.at(-1);
            if (name2) importBinding(name2, "*", typeOnly);
          } else if (part.type === "named_imports") for (const specifier of part.children) {
            const imported = specifier.fields.name, local = specifier.fields.alias ?? imported;
            if (imported && local) importBinding(local, decodeString(text2(imported)) ?? decodeIdentifier(text2(imported)), typeOnly || specifier.tokens.includes("type"));
          }
        }
      }
    }
    if (node.type === "export_statement") {
      if (node.fields.source) note("typescript.re-export", "Re-export targets are not resolved across files.");
      const declaration = node.fields.declaration, value4 = node.fields.value;
      if (declaration) {
        walk(declaration, scope, owner, node.tokens.includes("default") ? ["default"] : ["*"]);
        return;
      }
      if (value4 && value4.type !== "identifier") {
        const declaration2 = add2(value4, classes.has(value4.type) ? "class" : functions.has(value4.type) ? "function" : "default", value4.fields.name, owner, ["default"]);
        walk(value4, scope, declaration2 ?? owner);
        return;
      }
    }
    let own = nodeDeclarations.get(node);
    if (!own && exported.includes("default") && !node.fields.name && (classes.has(node.type) || functions.has(node.type))) own = add2(node, classes.has(node.type) ? "class" : "function", void 0, owner, ["default"]);
    if (!own && (classes.has(node.type) || functions.has(node.type) || ["interface_declaration", "type_alias_declaration", "enum_declaration", "public_field_definition", "property_signature"].includes(node.type))) {
      const name2 = node.fields.name;
      const member = ["method_definition", "method_signature", "abstract_method_signature", "public_field_definition", "property_signature"].includes(node.type);
      if (name2 && name2.type !== "computed_property_name") {
        const kind = classes.has(node.type) ? "class" : node.type === "interface_declaration" ? "interface" : node.type === "type_alias_declaration" ? "type" : node.type === "enum_declaration" ? "enum" : member ? functions.has(node.type) ? "method" : "property" : "function";
        own = add2(node, kind, name2, owner, exported.includes("*") ? [text2(name2)] : [...exported]);
        if (!member && own && !["function_expression", "generator_function", "class"].includes(node.type)) {
          const isType = kind === "type" || kind === "interface";
          addBinding({ name: text2(name2), kind: isType ? "type" : kind === "class" ? "class" : "function", node, declaration: own.key, typeOnly: isType, valueOnly: kind === "function", scope, stable: true, availableFrom: kind === "class" ? node.endIndex : 0 });
        }
      } else if (name2 && member) {
        const expression2 = name2.children.find((child) => child.type !== "comment");
        const computedName = expression2 && { kind: "expression", text: text2(expression2), span: span2(expression2) };
        if (computedName && wellFormed(computedName.text) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(computedName.text) && utf8Length2(canonicalJSON(computedName)) <= limits.maxValueBytes) {
          own = add2(node, functions.has(node.type) ? "method" : "property", void 0, owner);
          if (own) {
            own.computedName = computedName;
            own.nameSpan = span2(name2);
          }
        } else note("typescript.computed-member", "Computed member source exceeds the retained evidence limit.");
      }
    }
    if (node.type === "variable_declarator") {
      const pattern = node.fields.name, initializer = node.fields.value, container = parents.get(node);
      const kind = container?.tokens.includes("const") ? "const" : container?.tokens.includes("let") ? "let" : "var";
      const projection = pattern && projectionQueries.patternProjections(pattern);
      const paths = new Map(projection?.projections.map((item) => [item.node, item.path]));
      let target = scope;
      if (kind === "var") while (!target.functionScope && target.parent) target = target.parent;
      for (const name2 of pattern ? patternNames(pattern) : []) {
        const decl = add2(pattern === name2 ? node : name2, kind, name2, owner, exported.includes("*") ? [text2(name2)] : [...exported]);
        if (decl) {
          addBinding({ name: text2(name2), kind, node, nameNode: name2, declaration: decl.key, ...initializer && pattern === name2 ? { initializer } : {}, typeOnly: false, valueOnly: true, scope: target, stable: kind === "const", availableFrom: node.endIndex });
          if (initializer) {
            bindingSources.set(decl.key, Object.freeze({ initializer, path: paths.get(name2) ?? Object.freeze([]), complete: !!projection?.complete && paths.has(name2) }));
          }
        }
        if (!own && pattern === name2) own = decl;
      }
    }
    let childScope = scope;
    if (functions.has(node.type) || classes.has(node.type) || ["statement_block", "for_statement", "for_in_statement", "catch_clause", "switch_body", "internal_module", "interface_declaration", "type_alias_declaration"].includes(node.type)) {
      childScope = { parent: scope, functionScope: functions.has(node.type), bindings: /* @__PURE__ */ new Map() };
      for (const parameter of node.fields.type_parameters?.children ?? []) {
        const name2 = parameter.fields.name;
        if (name2) addBinding({ name: text2(name2), kind: "type", node: name2, typeOnly: true, valueOnly: false, scope: childScope, stable: true, availableFrom: 0 });
      }
      if ((node.type === "function_expression" || node.type === "generator_function" || classes.has(node.type)) && node.fields.name) {
        addBinding({ name: text2(node.fields.name), kind: classes.has(node.type) ? "class" : "function", node, ...own ? { declaration: own.key } : {}, typeOnly: false, valueOnly: !classes.has(node.type), scope: childScope, stable: true, availableFrom: classes.has(node.type) ? node.fields.body?.startIndex ?? node.endIndex : 0 });
      }
      const params = node.fields.parameters ?? node.fields.parameter;
      const patterns = params?.type === "formal_parameters" ? params.children : params ? [params] : [];
      for (const param of patterns) for (const name2 of patternNames(param)) addBinding({ name: text2(name2), kind: "parameter", node: name2, typeOnly: false, valueOnly: true, scope: childScope, stable: false, availableFrom: 0 });
      if (node.type === "catch_clause" && node.fields.parameter) for (const name2 of patternNames(node.fields.parameter)) addBinding({ name: text2(name2), kind: "parameter", node: name2, typeOnly: false, valueOnly: true, scope: childScope, stable: false, availableFrom: 0 });
      if (node.type === "for_in_statement" && node.fields.left && node.tokens.some((token) => ["const", "let", "var"].includes(token))) {
        const kind = node.tokens.includes("const") ? "const" : node.tokens.includes("let") ? "let" : "var";
        let target = childScope;
        if (kind === "var") while (!target.functionScope && target.parent) target = target.parent;
        for (const name2 of patternNames(node.fields.left)) {
          const decl = add2(name2, kind, name2, owner);
          addBinding({ name: text2(name2), kind, node: name2, ...decl ? { declaration: decl.key } : {}, typeOnly: false, valueOnly: true, scope: target, stable: false, availableFrom: 0 });
        }
      }
    }
    for (const child of node.children) walk(child, childScope, own ?? owner, ["lexical_declaration", "variable_declaration", "ambient_declaration"].includes(node.type) ? exported : []);
  };
  if (root4.endIndex > root4.startIndex) add2(root4, "module");
  walk(root4, rootScope);
  const lookup = (node, space = "value") => {
    let scope = scopes.get(original(node));
    while (scope) {
      const candidates = scope.bindings.get(decodeIdentifier(text2(node)));
      const matches = candidates?.filter((b) => space === "value" ? !b.typeOnly || b.kind === "import" : !b.valueOnly);
      if (matches?.length) return matches.length === 1 ? matches[0] : void 0;
      scope = scope.parent;
    }
    return void 0;
  };
  const ownerOf = (node) => {
    let cursor = original(node);
    while (cursor) {
      const decl = nodeDeclarations.get(cursor);
      if (decl) return decl;
      cursor = parents.get(cursor);
    }
    return void 0;
  };
  const unsafeObjects = /* @__PURE__ */ new Set();
  const unstableClassObjects = /* @__PURE__ */ new Set();
  const escapes = /* @__PURE__ */ new Map();
  const identityEscapes = /* @__PURE__ */ new Map();
  const aliasEscapes = [];
  const carriedReferences = (node) => {
    if (["member_expression", "subscript_expression"].includes(node.type)) return node.fields.object ? [node.fields.object] : [];
    if (node.type === "binary_expression" && node.tokens.some((token) => ["&&", "||", "??"].includes(token))) return [node.fields.left, node.fields.right].filter((item) => !!item);
    if (node.type === "ternary_expression") return [node.fields.consequence, node.fields.alternative].filter((item) => !!item);
    if (node.type === "sequence_expression") {
      const last = node.children.filter((item) => item.type !== "comment").at(-1);
      return last ? [last] : [];
    }
    if (["await_expression", "yield_expression", "jsx_expression"].includes(node.type)) return node.children.filter((item) => item.type !== "comment");
    return [];
  };
  const propagateEscape = (binding, occurrence, identityOnly = false) => {
    const seen = /* @__PURE__ */ new Set();
    const pending = [binding];
    while (pending.length && seen.size < limits.maxDepth && tick()) {
      const alias = pending.pop();
      if (alias.kind !== "const" || seen.has(alias)) continue;
      seen.add(alias);
      const source2 = alias.initializer ?? (alias.declaration && bindingSources.get(alias.declaration)?.initializer);
      if (!source2) continue;
      const references4 = [source2];
      while (references4.length && tick()) {
        const initial = unwrap(references4.pop());
        if (initial.type !== "identifier") {
          references4.push(...carriedReferences(initial));
          continue;
        }
        const origin = lookup(initial);
        if (!origin) continue;
        if (occurrence === void 0) unsafeObjects.add(origin);
        else {
          const map = identityOnly ? identityEscapes : escapes, positions = map.get(origin) ?? [];
          positions.push(occurrence);
          map.set(origin, positions);
        }
        pending.push(origin);
      }
    }
    if (pending.length) note("typescript.work-limit", "Reference escape propagation exceeds bounded alias traversal.", "truncated");
  };
  for (const node of nodes) {
    if (!tick()) break;
    if (!["identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"].includes(node.type)) continue;
    const binding = lookup(node);
    if (!binding || binding.node.fields.name === node || binding.node === node || binding.nameNode === node) continue;
    let at = node, parent = parents.get(at);
    while (parent) {
      const grandparent = parents.get(parent);
      const tagged = parent.type === "template_substitution" && grandparent?.type === "template_string" && parents.get(grandparent)?.fields.arguments === grandparent;
      const templateArguments = parent.type === "template_string" && grandparent?.fields.arguments === parent;
      const jsxValue = parent.type === "jsx_attribute" && parent.children[1] === at;
      const spreadArgument = parent.type === "spread_element" && !!grandparent && ["arguments", "jsx_expression"].includes(grandparent.type);
      if (!(wrappers.has(parent.type) || carriedReferences(parent).includes(at) || tagged || templateArguments || jsxValue || spreadArgument || ["array_pattern", "object_pattern", "pair_pattern", "rest_pattern"].includes(parent.type) || ["assignment_pattern", "object_assignment_pattern"].includes(parent.type) && (parent.fields.left ?? parent.children[0]) === at)) break;
      at = parent;
      parent = grandparent;
    }
    if (parent && (["assignment_expression", "augmented_assignment_expression", "for_in_statement"].includes(parent.type) && parent.fields.left === at || parent.type === "update_expression" || parent.type === "unary_expression" && parent.tokens.includes("delete"))) {
      if (at === node || wrappers.has(at.type) || ["array_pattern", "object_pattern"].includes(at.type) || binding.kind === "import" || binding.kind === "const") binding.stable = false;
      unsafeObjects.add(binding);
      propagateEscape(binding);
      let alias = binding;
      for (let i = 0; i < limits.maxDepth && alias.kind === "const"; i++) {
        const source2 = alias.initializer ?? (alias.declaration && bindingSources.get(alias.declaration)?.initializer);
        if (!source2) break;
        let initial = unwrap(source2);
        while (["member_expression", "subscript_expression"].includes(initial.type) && initial.fields.object) initial = unwrap(initial.fields.object);
        if (initial.type !== "identifier") break;
        const origin = lookup(initial);
        if (!origin || origin === alias) break;
        unsafeObjects.add(origin);
        if (origin.kind === "import" || origin.kind === "const") origin.stable = false;
        if (origin.kind === "class" && ["member_expression", "subscript_expression"].includes(unwrap(at).type)) {
          origin.stable = false;
          if (origin.declaration) unstableClassObjects.add(origin.declaration);
          note("typescript.mutated-class-alias", "A class object written through an alias is not a stable value origin.");
        }
        alias = origin;
      }
    } else if (parent?.type === "arguments" || parent?.type === "call_expression" && (parent.fields.arguments === at || parent.fields.function === at && ["member_expression", "subscript_expression"].includes(unwrap(at).type)) || parent && ["jsx_element", "jsx_fragment", "jsx_opening_element", "jsx_self_closing_element"].includes(parent.type) && parent.fields.name !== at) {
      const list = escapes.get(binding) ?? [];
      list.push(parent);
      escapes.set(binding, list);
      aliasEscapes.push({ binding, occurrence: parent });
    } else if (parent && ["jsx_opening_element", "jsx_self_closing_element"].includes(parent.type) && parent.fields.name === at) {
      const list = identityEscapes.get(binding) ?? [];
      list.push(parent);
      identityEscapes.set(binding, list);
      aliasEscapes.push({ binding, occurrence: parent, identityOnly: true });
    } else if (parent && !["spread_element", "template_substitution", "binary_expression", "ternary_expression", "sequence_expression", "unary_expression", "export_specifier", "export_statement", "type_annotation", "generic_type"].includes(parent.type)) {
      const safeAlias = parent.type === "variable_declarator" && unwrap(parent.fields.value ?? parent) === unwrap(at) && parents.get(parent)?.tokens.includes("const");
      const jsxTag = ["jsx_opening_element", "jsx_closing_element", "jsx_self_closing_element"].includes(parent.type) && parent.fields.name === at;
      const directCall = parent.type === "call_expression" && parent.fields.function === at || parent.type === "new_expression" && parent.fields.constructor === at;
      if (!safeAlias && !jsxTag && !directCall) {
        unsafeObjects.add(binding);
        if (parent.type !== "call_expression" || parent.fields.function !== at) aliasEscapes.push({ binding });
      }
    }
  }
  const bindingAt = (node, space = "value") => {
    const binding = lookup(unwrap(node), space);
    if (!binding) return void 0;
    const { name: name2, kind, declaration, initializer, origin, typeOnly, stable } = binding;
    let available = space === "type" || node.startIndex >= binding.availableFrom || kind === "function" || kind === "import";
    if (available && space === "value" && kind === "class" && node.startIndex >= binding.node.startIndex && node.endIndex <= binding.node.endIndex) {
      let cursor = original(node);
      while (cursor && cursor !== binding.node) {
        const member = parents.get(cursor), body = member && parents.get(member);
        if (cursor.type === "computed_property_name" && body?.type === "class_body" && parents.get(body) === binding.node) {
          available = false;
          break;
        }
        cursor = member;
      }
    }
    return Object.freeze({ name: name2, kind, node: binding.node, ...declaration ? { declaration } : {}, ...initializer ? { initializer } : {}, ...origin ? { origin: Object.freeze({ ...origin }) } : {}, typeOnly, stable: stable && !(declaration && unstableClassObjects.has(declaration)), available });
  };
  const expression = (node, space) => ({ kind: space === "type" ? "type" : "expression", text: text2(node), span: span2(node) });
  const reference = (input, space = "value") => {
    const node = unwrap(input), binding = bindingAt(node, space);
    const declared = nodeDeclarations.get(node);
    if (declared && (functions.has(node.type) || classes.has(node.type))) return { kind: "declaration", key: declared.key };
    if (binding?.available && !(space === "value" && binding.typeOnly)) {
      if (binding.origin) return { ...binding.origin };
      if (binding.declaration) return { kind: "declaration", key: binding.declaration };
    }
    return expression(input, space);
  };
  const resolve2 = (input, space = "value", seen = /* @__PURE__ */ new Set()) => {
    const node = unwrap(input);
    if (seen.size >= limits.maxDepth || seen.has(node)) return expression(input, space);
    seen.add(node);
    if (["member_expression", "nested_type_identifier"].includes(node.type)) {
      const object4 = node.fields.object ?? node.fields.module, property = node.fields.property ?? node.fields.name;
      if (object4 && property && !node.tokens.includes("?.")) {
        const origin = resolve2(object4, space, seen);
        if (origin.kind === "import" && origin.name === "*" && !origin.member) return { kind: "import", module: origin.module, name: decodeIdentifier(text2(property)) };
        if (origin.kind === "import" && origin.name !== "*") return { ...origin, member: origin.member ? `${origin.member}.${decodeIdentifier(text2(property))}` : decodeIdentifier(text2(property)) };
      }
    }
    const binding = bindingAt(node, space);
    if (binding && space === "value" && !binding.stable) return expression(input, space);
    if (binding?.available && binding.stable && !(space === "value" && binding.typeOnly) && binding.initializer) {
      const initial = unwrap(binding.initializer);
      if (["identifier", "member_expression", "nested_type_identifier"].includes(initial.type)) return resolve2(initial, space, seen);
    }
    if (space === "value" && binding?.available && binding.stable && !binding.typeOnly && binding.declaration) {
      const source2 = bindingSources.get(binding.declaration);
      if (source2?.complete && source2.path.length) {
        const projected = projectionQueries.project(source2.initializer, source2.path);
        if (projected && projected.initializer !== node) {
          if (!projected.path.length) return resolve2(projected.initializer, space, seen);
          const origin = resolve2(projected.initializer, space, seen);
          if (origin.kind === "import" && origin.name === "*" && !origin.member && projected.path.length === 1 && typeof projected.path[0] === "string") return { kind: "import", module: origin.module, name: projected.path[0] };
        }
      }
    }
    return reference(input, space);
  };
  for (const node of nodes) if (node.type === "export_statement" && !node.fields.source) {
    const value4 = node.fields.value;
    if (value4?.type === "identifier" && node.tokens.includes("default")) {
      const target = lookup(value4)?.declaration, decl = target && declarationByKey.get(target);
      if (decl && !decl.exports.includes("default")) decl.exports.push("default");
    }
    const clause = node.children.find((n) => n.type === "export_clause");
    for (const specifier of clause?.children ?? []) {
      const name2 = specifier.fields.name, alias = specifier.fields.alias ?? name2;
      if (!name2 || !alias) continue;
      const typeOnly = node.tokens.includes("type") || specifier.tokens.includes("type");
      const target = (lookup(name2, typeOnly ? "type" : "value") ?? lookup(name2, "type"))?.declaration;
      const decl = target && declarationByKey.get(target);
      const exported = decodeString(text2(alias)) ?? decodeIdentifier(text2(alias));
      if (decl && !decl.exports.includes(exported)) {
        if (decl.exports.length >= 256 || utf8Length2(exported) > Math.min(2048, limits.maxValueBytes) || !wellFormed(exported)) note("typescript.export-limit", "Export aliases exceed the wire limit.", "truncated");
        else decl.exports.push(exported);
      }
    }
  }
  const functionScope = (scope) => {
    while (scope?.parent && !scope.functionScope) scope = scope.parent;
    return scope;
  };
  const stableObject = (node, observation = node, offset = observation.startIndex, delivery, preservesIdentity) => {
    const binding = lookup(node);
    if (!binding || unsafeObjects.has(binding)) return false;
    const observedScope = functionScope(scopes.get(original(observation))), declaredScope = functionScope(binding.scope);
    const unsafe = (escape, jsxTag) => (!delivery || escape !== original(delivery)) && (observedScope !== declaredScope || functionScope(scopes.get(escape)) !== declaredScope || escape.endIndex <= offset) && !preservesIdentity?.(escape, jsxTag);
    return !(escapes.get(binding) ?? []).some((escape) => unsafe(escape, false)) && (!preservesIdentity || !(identityEscapes.get(binding) ?? []).some((escape) => unsafe(escape, true)));
  };
  for (const { binding, occurrence, identityOnly } of aliasEscapes) {
    if (!tick()) break;
    const source2 = binding.declaration ? bindingSources.get(binding.declaration) : void 0;
    const value4 = source2?.complete && projectionQueries.project(source2.initializer, source2.path);
    if (value4 && !value4.path.length && ["string", "number", "true", "false", "null"].includes(value4.initializer.type)) continue;
    propagateEscape(binding, occurrence, identityOnly);
  }
  const initializerProjection = (key3) => {
    const source2 = bindingSources.get(key3), binding = declarationBindings.get(key3);
    return source2 && Object.freeze({ ...source2, complete: !!(source2.complete && binding?.stable && projectionQueries.project(source2.initializer, source2.path)) });
  };
  const bindingQueries = createBindingQueries({
    text: text2,
    name,
    span: span2,
    unwrap,
    limits,
    binding: bindingAt,
    stableObject,
    elements: (node) => arrayElements.get(original(node)) ?? [],
    step: tick
  });
  for (const node of nodes) {
    if (!tick()) break;
    const declaration = node.type === "variable_declarator";
    const pattern = declaration ? node.fields.name : ["assignment_expression", "for_in_statement"].includes(node.type) ? node.fields.left : void 0;
    if (!pattern || !["array_pattern", "object_pattern"].includes(unwrap(pattern).type) || node.tokens.some((token) => ["const", "let", "var"].includes(token))) continue;
    const source2 = declaration ? node.fields.value : node.type === "assignment_expression" ? node.fields.right : void 0;
    const evidence = source2 && bindingQueries.pattern(pattern, source2);
    let complete = !!evidence?.complete;
    for (const item of evidence?.bindings ?? []) {
      const target = declaration ? nodeDeclarations.get(item.node) : declarationByKey.get(lookup(item.node)?.declaration ?? "");
      if (!target) {
        complete = false;
        continue;
      }
      if (declaration) target.binding = item.evidence;
      else if ((target.writes?.length ?? 0) < 64) (target.writes ??= []).push(item.evidence);
      else complete = false;
    }
    if (!complete) note(
      declaration ? "typescript.destructuring-value" : "typescript.destructuring-assignment",
      "Binding operations or targets exceed supported source-evidence bounds; runtime values remain unknown."
    );
  }
  const query = {
    text: text2,
    unwrap,
    binding: bindingAt,
    limits,
    stableObject: (node) => stableObject(node) && projectionQueries.referenceStable(node, node),
    project: projectionQueries.project
  };
  const constants = createConstantQueries(query);
  constructing = false;
  const freeze2 = (value4) => {
    if (!value4 || typeof value4 !== "object" || Object.isFrozen(value4)) return;
    for (const child of Object.values(value4)) freeze2(child);
    Object.freeze(value4);
  };
  for (const declaration of declarations) freeze2(declaration);
  for (const diagnostic of diagnostics) Object.freeze(diagnostic);
  Object.freeze(declarations);
  Object.freeze(diagnostics);
  Object.freeze(nodes);
  return Object.freeze({
    id: "typescript",
    version: 1,
    language,
    relativePath: relativePath2,
    sourceHash,
    source,
    limits: Object.freeze(limits),
    root: root4,
    nodes,
    declarations,
    state,
    diagnostics,
    text: text2,
    name,
    moduleIdentity,
    span: span2,
    parent: (node) => parents.get(original(node)),
    unwrap,
    declarationNode: (key3) => declarationNodes.get(key3),
    declarationAt: (node) => nodeDeclarations.get(original(node)),
    owner: ownerOf,
    binding: bindingAt,
    resolve: resolve2,
    reference,
    initializerProjection,
    ...projectionQueries,
    ...constants
  });
}
function utf8Length2(value4) {
  let size = 0;
  for (const point of value4) {
    const n = point.codePointAt(0);
    size += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
  }
  return size;
}
function wellFormed(value4) {
  for (const point of value4) {
    const code = point.codePointAt(0);
    if (code >= 55296 && code <= 57343) return false;
  }
  return true;
}

// src/frameworks/fst-solid/core-rules.ts
var root = "@fst/components-fst-solid";
var catalogue = /* @__PURE__ */ new Map();
var publicNames = /* @__PURE__ */ new Map();
var origins = /* @__PURE__ */ new Map();
function add(paths, entries) {
  for (const path of paths) for (const [name, rule3] of Object.entries(entries)) {
    const module = `${root}/${path}`;
    catalogue.set(`${module}\0${name}`, Object.freeze(rule3));
    const names = publicNames.get(module) ?? /* @__PURE__ */ new Set();
    names.add(name.split(".")[0]);
    publicNames.set(module, names);
    if (rule3.result && !name.includes(".")) {
      const key3 = `${rule3.result}:${rule3.construct ? "construct" : "call"}`;
      const list = origins.get(key3) ?? [];
      list.push({ module, name });
      origins.set(key3, list);
    }
  }
}
var rule = (operation, callbacks = [], sources = []) => ({ operation, callbacks, sources });
add(["hooks/value"], {
  value: { operation: "value.create", result: "value", sources: [0, 1] },
  switchValue: { operation: "value.switch-create", result: "accessor", sources: [0], callbacks: [0], policy: "read-only-accessor-case-results-invoked-during-setup" },
  lazyValueList: { operation: "list.lazy-create", result: "value", callbacks: [0], sources: [0], policy: "explicit-load" }
});
add(["hooks/delayed"], {
  delayedValue: { operation: "value.delayed-create", result: "delayed-value", sources: [1, 2], keys: [0] },
  delayedToggle: { operation: "toggle.delayed-create", result: "toggle-pair", sources: [1, 2], keys: [0] },
  delayedAction: { operation: "action.scheduler-create", result: "scheduler", options: { argument: 0, literals: ["multiple"] } }
});
add(["hooks/timer"], {
  useTimeout: { operation: "timer.timeout-register", result: "cancel", callbacks: [0], keys: [1], policy: "owner-cleanup-and-returned-clear-no-unregister" },
  useInterval: { operation: "timer.interval-register", result: "cancel", callbacks: [0], keys: [1], policy: "owner-cleanup-and-returned-clear-no-unregister" }
});
for (const [path, name, target] of [["hooks/documentEvent", "onDocumentEvent", "document"], ["hooks/windowEvent", "useWindowEvent", "window"]]) {
  add([path], { [name]: { operation: `event.${target}-register`, keys: [0], callbacks: [1], sources: [2], policy: "cleanup-request-without-capture-options" } });
}
add(["hooks/windowSize"], { useWindowSize: { operation: "window.size-observe", result: "accessor", policy: "owner-cleanup-request" } });
add(["hooks/mouse"], {
  useMouseHover: { operation: "mouse.hover-observe", result: "hover-value", sources: [0], options: { argument: 1, callbacks: ["callback", "isInside"], literals: ["checkVisible"] }, policy: "owner-cleanup-request" },
  onMouseClickOutside: { operation: "mouse.outside-click-register", result: "removable", callbacks: [1], sources: [0], policy: "owner-cleanup-and-manual-remove-request" }
});
add(["hooks/resize"], {
  onResize: { operation: "resize.observe", result: "resize-observer", sources: [0], callbacks: [1], policy: "manual-disconnect" },
  observeHeightChange: { operation: "height.observe", result: "disposable", sources: [0], callbacks: [1], policy: "manual-dispose" }
});
add(["hooks/reorder"], {
  createReorderInteraction: { operation: "reorder.create", result: "reorder", options: { argument: 0, callbacks: ["start"], sources: ["element", "disabled", "invalidation"], literals: ["threshold"] }, policy: "requires-owner-cleanup-request" }
});
add(["app/field", "app"], {
  field: { operation: "field.create-contract", result: "field", sources: [0], options: { argument: 1, literals: ["bindInitialValue", "name"] } },
  resolveTextFieldOrText: { operation: "field.resolve-conditional-pair", result: "field-text-pair", sources: [0], policy: "nullable-field-or-untyped-value" }
});
add(["app/component", "app"], {
  setContextData: { operation: "context.provide", keys: [0], sources: [1] },
  getContextData: { operation: "context.lookup", keys: [0], sources: [1], policy: "current-then-ancestors" },
  getContextDataLike: { operation: "context.prefix-lookup", keys: [0], sources: [1], policy: "nearest-prefix-current-then-ancestors; stop-with-null-on-ambiguity; depth-argument-limits-contexts; nullish-depth-default-500; no-merged-ancestors" },
  clearContextData: { operation: "context.remove-request", keys: [0] },
  getOrSetContextData: { operation: "context.lookup-or-provide", keys: [0], callbacks: [1], policy: "current-then-ancestors" },
  newScopedContext: { operation: "context.create-scoped", keys: [0], callbacks: [1], policy: "provide-current-no-disposal-guarantee" },
  useContextOrNewScoped: { operation: "context.reuse-or-create-scoped", keys: [0], callbacks: [1], sources: [2], policy: "current-then-ancestors" },
  useContextFromParent: { operation: "context.lookup", keys: [0], sources: [1], policy: "current-then-ancestors-with-current-prefix-fallback" },
  useContextFromParentOrNewScoped: { operation: "context.lookup-or-create", keys: [0], callbacks: [1], sources: [2], policy: "current-then-ancestors-with-current-prefix-fallback" },
  useGlobalContext: { operation: "context.reuse-or-create-global", keys: [0], callbacks: [1], policy: "global-store-no-disposal-guarantee" },
  resolveChildren: { operation: "children.normalize", result: "accessor", sources: [0] },
  useView: { operation: "view.create", result: "view", callbacks: [0], policy: "replaceable-root-manual-dispose" },
  useRootViewRenderer: { operation: "view.capture-renderer", result: "root-renderer", policy: "captured-owner-manual-result-dispose" },
  elemRef: { operation: "dom.content-ref-create", result: "accessor", policy: "first-non-fst-content-element" },
  elemRefFst: { operation: "dom.wrapper-ref-create", result: "accessor", policy: "fst-wrapper-element" }
});
add(["app/state", "app/state/state", "app"], {
  newStateObj: { operation: "model.proxy-create", result: "model", sources: [0, 1], policy: "proxy-request" }
});
add(["app/state", "app/state/state.list", "app"], {
  "List.new": { operation: "list.raw-create", result: "raw-list", sources: [0], policy: "raw-list-not-yet-reactive" },
  "List.from": { operation: "list.derive", result: "list", callbacks: [0, 1], sources: [0], policy: "proxy-list-source-replacement" }
});
add(["app/model"], {
  "Model.new": { operation: "model.proxy-create", result: "model", sources: [0], policy: "returns-proxy" },
  createModel: { operation: "model.raw-create", result: "raw-model", sources: [0], policy: "raw-object-with-proxy-member" }
});
add(["app/scope", "app/scope/itemScope"], {
  useScopeSelectedBoundTo: { operation: "selection.bind-one-way", sources: [0, 1], callbacks: [2], policy: "requested-binding-not-synchronization-guarantee" },
  useScopeSelectedBound: { operation: "selection.bind-two-way", sources: [0, 1], callbacks: [2, 3], policy: "requested-binding-not-synchronization-guarantee" }
});
add(["app/load", "app"], {
  onInit: { operation: "initialization.register", callbacks: [0], policy: "effect-initialization-not-dom-mount" },
  load: { operation: "loader.create", result: "loader", callbacks: [0], policy: "effect-started-loader" },
  LoadGroup: { operation: "load-group.create", result: "load-group", construct: true, sources: [0, 2], keys: [1], borrowed: { value: 0 } },
  LoadSequence: { operation: "load-sequence.create", result: "load-sequence", construct: true, sources: [0], callbacks: [1] },
  lazyListLoadGroup: { operation: "load-group.lazy-list-create", result: "lazy-load-group", sources: [1], keys: [0], callbacks: [2], backing: "load-group" },
  useResetLoadGroupOnInit: { operation: "load-group.reset-on-init", sources: [0], options: { argument: 1, literals: ["delay", "resetScope"] } }
});
add(["app/fragment"], { useFragment: { operation: "fragment.normalize", result: "fragment", sources: [0, 1], options: { argument: 0, callbacks: ["render"], literals: ["class"] }, policy: "cached-until-explicit-rerender" } });
add(["app/props"], { usePropValue: { operation: "prop.normalize", result: "prop-value", sources: [0, 1], policy: "hasValue-tests-original-input-presence" } });
add(["app/dom/hooks"], {
  onEnter: { operation: "dom.enter-register", callbacks: [0], policy: "dom-visibility-enter" },
  onExit: { operation: "dom.exit-register", callbacks: [0], policy: "dom-visibility-exit-not-component-post-render" }
});
add(["app/dom/extendedDom"], {
  onDomElemAdded: { operation: "dom.added-register", result: "removable", options: { argument: 0, callbacks: ["callback", "match"], sources: ["parent"], literals: ["id"] }, policy: "manual-remove" },
  findFstElem: { operation: "dom.lookup", sources: [0], keys: [1] }
});
add(["animation/Show"], {
  withVisibility: { operation: "visibility.provide", result: "visibility" },
  useVisibility: { operation: "visibility.lookup", result: "visibility", policy: "context-lookup-runtime-provider-unknown" }
});
add(["animation/Animate"], {
  usePageAnimations: { operation: "animation.context-reuse-or-create", result: "animator" },
  animationSpec: { operation: "animation.specify", sources: [0, 1], callbacks: [2], keys: [3] }
});
add(["app/action"], {
  action: { operation: "action.create", result: "action", callbacks: [0], policy: "status-not-permission-enforcement-arguments-array" },
  confirmAction: { operation: "action.confirmable-create", result: "action", options: { argument: 0, callbacks: ["request", "begin", "cancel", "confirm", "complete"], literals: ["completeDelay"] }, policy: "confirmation-request-workflow" }
});
add(["app/state", "app/state/confirmation", "app"], { ConfirmationRequest: { operation: "confirmation.create", result: "confirmation", construct: true } });
add(["app/router"], {
  defineRoutes: { operation: "routes.define", sources: [0], policy: "authored-route-metadata-not-runtime-match" },
  defineNavGroups: { operation: "navigation.groups-define", sources: [0] },
  useRouting: { operation: "routing.lookup", result: "routing", policy: "runtime-context-provider-unknown" },
  useRouterState: { operation: "routing.state-lookup", result: "router-state", policy: "location-state-value-not-accessor" },
  useOnNavigate: { operation: "navigation.observe", callbacks: [0], policy: "owner-cleanup-request" },
  getCurrentNavEntry: { operation: "navigation.entry-read", sources: [0] },
  updateRouterSideNavItemId: { operation: "navigation.side-item-write-request", sources: [0], keys: [1] }
});
add(["signalr", "signalr/onMessageHook"], Object.fromEntries(["onHubMessage", "onHubConnectionClosed", "onHubConnectionConnected", "onHubConnectionReconnected"].map((name) => [name, {
  operation: `subscription.${name}`,
  sources: [0],
  callbacks: [1],
  policy: "owner-cleanup-remove-request"
}])));
add(["signalr", "signalr/hub"], { signalRHub: { operation: "hub.create", result: "hub", options: { argument: 0, sources: ["url"] }, policy: "connection-request-not-connected-proof" } });
add(["signalr", "signalr/api"], { signalRApi: { operation: "transport.signalr-create", result: "remote-api", sources: [0], options: { argument: 1, literals: ["apiPath"] } } });
add(["app/backendApi", "app"], { backendApi: { operation: "transport.backend-create", result: "remote-api", keys: [0], policy: "external-service-target-unresolved" } });
add(["http/api"], { httpApi: { operation: "transport.http-create", result: "remote-api", sources: [0], options: { argument: 1, sources: ["baseUrl", "authentication"] }, policy: "authored-endpoints-not-network-success" } });
add(["webview/interop"], { invokeOnWebViewReady: { operation: "webview.ready-register", callbacks: [0], policy: "immediate-or-queued-by-environment" } });
add(["async", "async/promise"], {
  promise: { operation: "deferred.create", result: "deferred", options: { argument: 0, callbacks: ["onResolve", "onReject"] }, policy: "custom-thenable-not-native-promise" },
  resolvePromise: rule("async.normalize", [], [0])
});
add(["async", "async/delay"], { delay: { operation: "async.delay-request", keys: [0] }, delaySinceLast: { operation: "async.elapsed-delay-request", keys: [0], sources: [1] } });
add(["http/retry"], { invokeWithRetry: { operation: "retry.invoke-request", callbacks: [0], options: { argument: 1, literals: ["maxRetries", "maxTotalMs", "initialDelayMs"] }, policy: "delay-budget-not-execution-deadline" } });
add(["collections/array"], { forEachAsync: { operation: "collection.concurrent-callbacks", sources: [0], callbacks: [1], forwards: [0], policy: "all-started-before-await" }, onArrayChange: { operation: "collection.change-request", sources: [0, 1, 2], callbacks: [3], forwards: [0, 1, 2], policy: "boolean-and-reference-payload-not-guaranteed" } });
add(["cn", "cn/cnExtract"], { cnExtract: { operation: "classes.partition", result: "classes-pair", sources: [0, 1] } });
add(["cache/IndexDbCache"], {
  IndexedDbCache: { operation: "cache.create", result: "cache", construct: true, options: { argument: 0, literals: ["dbName", "storeName", "version"] } },
  getAndInitCacheDb: { operation: "cache.reuse-or-create", result: "cache", keys: [0], backing: "cache", shared: "cache" },
  initGlobalCache: { operation: "cache.global-initialize", result: "cache", backing: "cache", shared: "cache" },
  getGlobalCache: { operation: "cache.global-get-or-create", result: "cache", backing: "cache", shared: "cache" }
});
add(["session/sessionStorage"], {
  getOrAddSessionValue: { operation: "session.read-or-write", keys: [0], callbacks: [1] },
  getSessionValue: { operation: "session.read", keys: [0] },
  setSessionValue: { operation: "session.write-request", keys: [0], sources: [1] },
  clearSessionValues: { operation: "session.clear-request" }
});
var handleMethods = {
  value: {
    get: rule("value.untracked-read"),
    set: { ...rule("value.explicit-write-request", [], [0]), forwards: [0] },
    onChange: { ...rule("value.pre-commit-observe", [0]), result: "self", policy: "cleanup-request-not-unsubscribe-proof" },
    load: rule("value.load-request", [], [0, 1]),
    loaded: rule("value.loaded-read"),
    isLoaded: rule("value.is-loaded-read"),
    refreshOnChange: { ...rule("value.replace-derivation", [0], [0]), result: "self" }
  },
  "delayed-value": {
    get: rule("value.untracked-read"),
    set: { ...rule("value.delayed-write-request", [], [0]), forwards: [0] },
    setNow: { ...rule("value.immediate-write-request", [], [0]), forwards: [0] },
    cancelChange: rule("value.cancel-pending-request"),
    onChange: { ...rule("value.pre-commit-observe", [0]), result: "self", policy: "cleanup-request-not-unsubscribe-proof" },
    load: rule("value.load-request", [], [0, 1]),
    loaded: rule("value.loaded-read"),
    isLoaded: rule("value.is-loaded-read")
  },
  field: {
    map: { ...rule("field.map-same-handle", [0]), result: "self" },
    refreshOn: { ...rule("field.refresh-dependency", [], [0]), result: "self" },
    update: { ...rule("field.merge-write-request", [], [0]), forwards: [0] },
    get: { operation: "field.metadata-read", keys: [0] },
    set: { operation: "field.metadata-write-request", keys: [0], sources: [1] },
    with: { operation: "field.metadata-assign-request", keys: [0], sources: [1], result: "self" },
    withAnimation: { operation: "field.animation-metadata-assign-request", sources: [0], result: "self" },
    onMountedEditor: { operation: "field.editor-mounted-observe", callbacks: [0], result: "self" },
    removeOnChange: { ...rule("field.remove-change-observer-request", [0]), result: "self" },
    removeOnSet: { ...rule("field.remove-set-observer-request", [0]), result: "self" },
    dispose: { operation: "field.dispose-request", policy: "guard-only-not-full-resource-release" },
    onChange: { operation: "field.pre-commit-observe", callbacks: [0], result: "self" },
    onSet: { operation: "field.post-commit-observe", callbacks: [0], result: "self" }
  },
  form: {
    field: { operation: "form.field-access", result: "field", keys: [0] },
    form: { operation: "form.subform-prefix", result: "subform", keys: [0], policy: "facade-not-new-owner" },
    setFieldValue: { operation: "form.field-write-request", keys: [0], sources: [1] },
    onChange: { operation: "form.member-observe", keys: [0], callbacks: [1], policy: "deferred" },
    onReady: rule("form.ready-observe", [0])
  },
  subform: { field: { operation: "form.prefixed-field-access", result: "field", keys: [0] } },
  state: { onChange: { operation: "state.member-observe", keys: [0], callbacks: [1], policy: "initial-and-change" }, onReady: rule("state.ready-observe", [0]), init: rule("state.configure", [0]) },
  scope: {
    onReady: rule("scope.ready-observe", [0]),
    init: rule("scope.configure", [0]),
    onSelectedChange: rule("selection.selected-observe", [0]),
    onActiveChange: rule("selection.active-observe", [0]),
    onClicked: rule("selection.clicked-observe", [0]),
    setSelected: rule("selection.select-request", [], [0, 1]),
    setActive: rule("selection.activate-request", [], [0, 1]),
    setClicked: rule("selection.click-request", [], [0, 1]),
    setHovered: rule("selection.hover-request", [], [0]),
    setAll: rule("selection.items-replace-request", [], [0]),
    setMarked: { ...rule("selection.set-marked-request", [], [0]), policy: "implementation-writes-all-not-marked" },
    reset: rule("selection.reset-request")
  },
  loader: { then: { ...rule("loader.completion-observe", [0]), result: "self", policy: "callback-receives-loader-on-success-or-error" }, isLoading: rule("loader.loading-read", [], [0]), isLoaded: rule("loader.loaded-read", [], [0]), isLoadingError: rule("loader.error-status-read"), isLoadingSuccess: rule("loader.success-status-read") },
  "load-group": { complete: rule("load-group.complete-request") },
  "lazy-load-group": { complete: rule("load-group.complete-request"), resetOnInit: { ...rule("load-group.reset-on-init", [], [0]), result: "self" } },
  "load-sequence": { load: rule("load-sequence.invoke-request"), reset: rule("load-sequence.reset-request", [], [0]), complete: rule("load-sequence.complete-request"), onCompleted: { ...rule("load-sequence.complete-observe", [0]), result: "self" } },
  list: { set: rule("list.replace-request", [], [0]), setAt: rule("list.item-write-request", [], [0, 1]), add: rule("list.add-request", [], [0]), push: rule("list.push-request", [], [0]), pop: rule("list.pop-request"), shift: rule("list.shift-request"), unshift: rule("list.unshift-request", [], [0]), splice: rule("list.splice-request", [], [0, 1, 2]), reverse: rule("list.reverse-request"), asArray: rule("list.array-read"), filter: rule("list.filter", [0]), map: rule("list.map", [0]), at: rule("list.item-read", [], [0]) },
  view: { render: { ...rule("view.render-replace-root", [], [0]), forwards: [0], policy: "props-input-previous-root-dispose-request" }, dispose: rule("view.dispose-request") },
  "root-view": { dispose: { operation: "view.dispose-request", policy: "manual-result-dispose" } },
  "prop-value": { hasValue: { operation: "prop.original-presence-read", policy: "not-accessor-result-presence" } },
  removable: { remove: rule("subscription.remove-request") },
  disposable: { dispose: rule("resource.dispose-request") },
  "resize-observer": { disconnect: rule("resize.disconnect-request"), unobserve: rule("resize.unobserve-request", [], [0]), observe: rule("resize.observe-request", [], [0]) },
  visibility: { onChange: { ...rule("visibility.before-change-observe", [0]), result: "disposable" }, show: rule("visibility.show-request", [], [0]), toggle: rule("visibility.toggle-request") },
  animator: { animation: rule("animation.define", [], [0]), create: { ...rule("animation.create", [1], [0]), result: "animation-instance" }, controls: { operation: "animation.controls-create", result: "animation-controls" } },
  "animation-instance": { dispose: rule("animation.dispose-request"), play: { operation: "animation.instance-play-request", keys: [0], sources: [1] } },
  "animation-controls": { play: { operation: "animation.play-request", keys: [0], sources: [1] }, playEnter: rule("animation.enter-request"), playExit: rule("animation.exit-request"), attach: rule("animation.attach", [], [0, 1]), onPlay: rule("animation.play-observe", [0]) },
  action: { enabledWhen: { ...rule("action.enabled-status-observe", [0]), result: "self", policy: "not-execution-permission" }, isEnabled: rule("action.enabled-status-read"), isExecuting: rule("action.executing-status-read") },
  scheduler: { reset: { operation: "action.cancel-scheduled-request", keys: [0] }, isPending: { operation: "action.pending-read", keys: [0] } },
  confirmation: { activate: { ...rule("confirmation.activate-request", [], [0]), result: "self" }, response: { operation: "confirmation.response-read", result: "deferred" }, completion: { operation: "confirmation.completion-read", result: "deferred" }, confirm: rule("confirmation.confirm-request", [], [0]), cancel: rule("confirmation.cancel-request", [], [0]), complete: rule("confirmation.complete-request", [], [0]), reset: rule("confirmation.reset-request"), onCompletion: { ...rule("confirmation.completion-observe", [0]), result: "self", policy: "cleanup-request-not-correct-callback-removal-proof" } },
  routing: { navigateTo: { operation: "navigation.to-request", keys: [0], sources: [1] }, navigateBack: rule("navigation.back-request", [], [0]), navigateForward: rule("navigation.forward-request"), navigateBackTo: { operation: "navigation.back-to-request", keys: [0] }, onNavigate: { ...rule("navigation.observe", [0]), policy: "manual-unsubscribe-may-return-undefined" }, currentPath: rule("navigation.current-path-read"), matchRoute: rule("navigation.match-request", [], [0]) },
  hub: { onMessage: { operation: "hub.message-register", options: { argument: 0, callbacks: ["callback"] }, policy: "manual-remove-may-return-undefined" }, onConnectionClosed: { operation: "hub.closed-register", options: { argument: 0, callbacks: ["callback"] } }, onConnectionConnected: { operation: "hub.connected-register", options: { argument: 0, callbacks: ["callback"] } }, onConnectionReconnected: { operation: "hub.reconnected-register", options: { argument: 0, callbacks: ["callback"] } }, connect: rule("hub.connect-request"), disconnect: rule("hub.disconnect-request"), sendMessage: rule("hub.send-request", [], [0]), makeApiInvocation: { operation: "hub.api-request", keys: [0, 1], sources: [2] } },
  deferred: { resolve: rule("deferred.resolve-request", [], [0]), reject: rule("deferred.reject-request", [], [0]), reset: rule("deferred.reset-request"), done: rule("deferred.done-read"), then: { ...rule("deferred.then-register", [0, 1]), policy: "custom-thenable-callback-result-discarded" }, catch: rule("deferred.catch-register", [0]), finally: rule("deferred.finally-register", [0]) },
  cache: { getUrlResource: { operation: "cache.resource-get-or-fetch", keys: [0, 1], policy: "creates-object-url-no-auto-release-proof" }, removeUrlResource: { operation: "cache.resource-remove-request", keys: [0, 1] }, saveData: { operation: "cache.data-save-request", keys: [0, 2], sources: [1] }, getData: { operation: "cache.data-read", keys: [0, 1] }, pruneOtherVersions: { operation: "cache.prune-request", keys: [0, 1] }, clearAll: rule("cache.clear-request"), deleteDatabase: rule("cache.delete-request") }
};
var value = Object.freeze({ kind: "value" });
var handleParts = {
  "toggle-pair": { "0": "accessor", "1": "cancel" },
  "field-text-pair": { "0": "nullable-field", "1": "nullable-untyped-value" },
  "classes-pair": { "0": "class-list", "1": "nullable-class-list" },
  reorder: { phase: "accessor", cancel: "cancel" },
  "raw-model": { $proxy: "proxy-result" },
  "proxy-result": { instance: "model" },
  "load-group": { value: "value", completion: "deferred" },
  "lazy-load-group": { value: "value", completion: "deferred" },
  "load-sequence": { completion: "deferred" },
  "root-view": { dispose: "cancel", view: "rendered-value" }
};
function methodsFor(kind) {
  if (kind === "raw-list") return handleMethods.list;
  if (kind === "item-scope") return handleMethods.scope;
  if (kind === "hover-value") return { ...handleMethods.value, update: rule("mouse.hover-update-request", [], [0, 1]), setHover: rule("mouse.hover-write-request", [], [0]) };
  return Object.hasOwn(handleMethods, kind) ? handleMethods[kind] : void 0;
}
var shapeFor = (kind) => {
  if (["toggle-pair", "field-text-pair", "classes-pair"].includes(kind)) return { kind: "tuple", items: [value, value] };
  if (kind === "reorder") return { kind: "object", properties: { phase: value, cancel: value } };
  const keys = [...Object.keys(methodsFor(kind) ?? {}), ...Object.keys(handleParts[kind] ?? {})];
  return keys.length ? { kind: "object", properties: Object.fromEntries(keys.map((key3) => [key3, value])) } : value;
};
var fstReturnContracts = Object.freeze([...origins].flatMap(([key3, entries]) => {
  const [kind, invocation] = key3.split(":");
  const result = [];
  for (let index = 0; index < entries.length; index += 16) result.push(Object.freeze({ id: `fst-solid.${kind}${invocation === "construct" ? "-construct" : ""}${index ? `-${index}` : ""}`, origins: Object.freeze(entries.slice(index, index + 16)), result: shapeFor(kind), ...invocation === "construct" ? { invocation } : {} }));
  return result;
}));
function coreRule(module, name) {
  return catalogue.get(`${module}\0${name}`);
}
function coreImport(module, name) {
  return publicNames.get(module)?.has(name) ?? false;
}

// src/frameworks/fst-solid/vocabulary.ts
var roles = {
  component: "FST Component",
  state: "FST State",
  form: "FST Form",
  scope: "FST Scope",
  "item-scope": "FST Item Scope",
  field: "FST Field",
  "field-binding": "Borrowed Field Binding",
  "lifecycle-hook": "Declared Lifecycle Hook",
  "registration": "Explicit Registration",
  "api-handle": "Reviewed FST API Handle",
  "component-factory": "Authored Component Factory"
};
var properties = {
  name: ["Trace Name", false],
  "design-name": ["Design Name", false],
  "design-concept": ["Design Concept", false],
  "field-path": ["Literal Field Path", false],
  "lifetime-operation": ["Requested Lifetime Operation", true],
  "lookup-policy": ["Requested Lookup Policy", true],
  "instance-kind": ["Instance Construction", true],
  "hook-kind": ["Declared Hook Contract", false],
  "registration-kind": ["Registration API", true],
  "observation-phase": ["Field Observation Phase", true],
  "field-operation": ["Field Invocation", true],
  "field-dispatch": ["Conditional Field Invocation Contract", true],
  "list-contribution": ["Ordered List Item Contribution", true],
  "ownership": ["Binding Ownership", false],
  "change-argument": ["OnChangeArgs Snapshot Binding", true],
  "children-change-argument": ["Children Change Snapshot Binding", true],
  "api-operation": ["Explicit API Operation", true],
  "api-policy": ["Reviewed API Boundary", true],
  "handle-kind": ["Reviewed Return Handle Kind", false],
  "key": ["Literal API Key Or Delay", true],
  "option": ["Literal API Option", true],
  "callback-binding": ["Callback Payload Binding", true],
  "route-entry": ["Authored Route Entry", true],
  "route-path": ["Authored Route Path", true],
  "component-return": ["Component Construction Boundary", true]
};
var relations = {
  "factory": "Declared Factory Import",
  "implemented-by": "Renderer",
  "props-type": "Props Type",
  "extends": "Declared Base",
  "type-argument": "Generic Type Argument",
  "lifetime-target": "Lifetime Call Target",
  "form-origin": "Form Expression",
  "field-path-expression": "Field Path Expression",
  "field-type": "Field Type Reference",
  "value-type": "Value Type",
  "borrows": "Borrowed Field Source",
  "callback": "Registered Callback",
  "observes": "Explicit Dependency",
  "field-target": "Field Call Target",
  "field-argument": "Conditional Field Argument Expression",
  "field-write-options": "Conditional Field Write Options",
  "list-item-source": "List Item Or Iterable Expression",
  "list-construction": "Containing List Construction",
  "change-argument-source": "OnChangeArgs Snapshot Dependency",
  "operation-target": "Direct API Operation Target",
  "source": "Explicit API Input",
  "key-expression": "API Key Or Delay Expression",
  "callback-source": "Callback Payload Source",
  "subform-origin": "Subform Prefix Expression",
  "route-component": "Authored Route Component",
  "route-option": "Authored Route Option",
  "route-definition": "Authored Route Definition",
  "returns-component": "Returned Component Construction",
  "returned-renderer": "Returned Component Renderer",
  "returned-options": "Returned Component Options Expression"
};
function descriptor(digests) {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error("FST plugin requires build-supplied content digests");
  return {
    id: "fst-solid",
    version: "1",
    ...digests,
    languages: ["typescript", "tsx"],
    view: { id: "typescript", version: 1 },
    roles: Object.entries(roles).map(([name, label]) => ({ id: `fst-solid.${name}`, label })),
    properties: Object.entries(properties).map(([name, [label, multiple]]) => ({ id: `fst-solid.${name}`, label, multiple, valueKind: "string" })),
    relations: Object.entries(relations).map(([name, label]) => ({ id: `fst-solid.${name}`, label }))
  };
}
var root2 = "@fst/components-fst-solid";
var catalogue2 = Object.freeze({
  [`${root2}/app/component`]: ["component", "componentWithChildren", "onComponentCleanup"],
  [`${root2}/app/state`]: ["State", "onChange", "onChangeDelayed", "resolveChildrenOnChange"],
  [`${root2}/app/state/onChange`]: ["onChange", "onChangeDelayed", "resolveChildrenOnChange"],
  [`${root2}/app/form`]: ["Form", "FormField"],
  [`${root2}/app/scope`]: ["Scope", "ItemScope"],
  [`${root2}/app/field`]: ["field", "Field"],
  [`${root2}/app/fieldBinding`]: ["InputField", "useFieldBinding"],
  [`${root2}/app`]: ["component", "componentWithChildren", "onComponentCleanup", "State", "onChange", "onChangeDelayed", "resolveChildrenOnChange", "field", "Field", "InputField", "useFieldBinding"],
  [`${root2}/solid-js`]: ["onCleanup", "onMount"]
});
function canonicalApi(module, name) {
  return Object.hasOwn(catalogue2, module) && catalogue2[module]?.includes(name) || coreImport(module, name) ? name : void 0;
}

// src/frameworks/fst-solid/core-analysis.ts
var functions2 = /* @__PURE__ */ new Set(["arrow_function", "function_expression", "function_declaration", "generator_function", "generator_function_declaration"]);
var keyOf = (node) => `${node.startIndex}:${node.endIndex}`;
function analyzeCore(context) {
  const { view, budget, role, relation, diagnose, safeString } = context;
  const property = (owner, term, value4, node, rule3, resolution) => {
    if (!safeString(value4)) {
      diagnose("fst-solid.core-limit", "API metadata exceeds the bounded wire string contract.", node);
      return;
    }
    context.property(owner, term, value4, node, rule3, resolution);
  };
  const argsOf = (node) => node.fields.arguments?.children.filter((child) => child.type !== "comment") ?? [];
  const access = (input) => {
    const node = view.unwrap(input);
    if (node.tokens.includes("?.") || !node.fields.object) return void 0;
    const key3 = node.type === "member_expression" ? node.fields.property : node.type === "subscript_expression" ? node.fields.index : void 0;
    const name = key3 && (node.type !== "subscript_expression" || key3.type === "string") ? view.name(key3) : void 0;
    return name === void 0 ? void 0 : { object: node.fields.object, name };
  };
  const imported = (input) => {
    const reference = view.resolve(input);
    if (reference.kind === "import" && !reference.member) {
      const rule3 = coreRule(reference.module, reference.name);
      if (rule3) return rule3;
    }
    const member = access(input);
    const base = member && view.resolve(member.object);
    return base?.kind === "import" && !base.member ? coreRule(base.module, `${base.name}.${member.name}`) : void 0;
  };
  const calls2 = view.nodes.filter((node) => node.type === "call_expression" || node.type === "new_expression");
  const direct = /* @__PURE__ */ new Map();
  for (const node of calls2) {
    budget.step();
    if (node.tokens.includes("?.") || node.children.some((child) => child.type === "optional_chain")) continue;
    const fn = node.fields.function ?? node.fields.constructor;
    const rule3 = fn && imported(fn);
    if (rule3 && !!rule3.construct === (node.type === "new_expression")) direct.set(node, rule3);
  }
  const analyzeReceivers = direct.size > 0 || context.hasFamilies;
  const bindings = /* @__PURE__ */ new Map();
  const borrowedInputs = /* @__PURE__ */ new Map();
  const constructed = /* @__PURE__ */ new Map();
  const constructionProofs = /* @__PURE__ */ new Map();
  const active = /* @__PURE__ */ new Set();
  const knownFunction = (input) => {
    if (!input) return false;
    let node = view.unwrap(input);
    for (let depth = 0; depth < 16; depth++) {
      budget.step();
      if (functions2.has(node.type)) return true;
      const binding = view.binding(node);
      if (!binding?.stable || !binding.available || binding.typeOnly) return false;
      const next = binding.initializer ?? (binding.kind === "function" && binding.declaration ? view.declarationNode(binding.declaration) : void 0);
      if (!next) return false;
      node = view.unwrap(next);
    }
    return false;
  };
  const method = (handle2, name) => {
    const rules = methodsFor(handle2.kind);
    return rules && Object.hasOwn(rules, name) ? rules[name] : void 0;
  };
  const make = (kind, node) => ({ kind, creation: node, root: keyOf(node), reference: view.reference(node) });
  const partOf = (receiver, name, depth) => {
    const borrowed = direct.get(receiver.creation)?.borrowed;
    if (borrowed && Object.hasOwn(borrowed, name)) {
      const input = argsOf(receiver.creation)[borrowed[name]];
      return input ? handle(input, depth + 1) : void 0;
    }
    const kind = handleParts[receiver.kind]?.[name];
    return kind ? { ...receiver, kind } : void 0;
  };
  const observeConstruction = (node, result) => {
    if (!result?.constructed) return result ?? void 0;
    if (!constructionProofs.has(node)) {
      budget.step(512);
      constructionProofs.set(node, view.project(node)?.contract?.startsWith("fst-solid.") ?? false);
    }
    return constructionProofs.get(node) ? result : void 0;
  };
  const handle = (input, depth = 0) => {
    budget.step();
    if (depth > 16) {
      diagnose("fst-solid.core-limit", "Handle provenance exceeds the bounded local depth.", input);
      return;
    }
    const node = view.unwrap(input), reference = view.reference(node);
    const binding = view.binding(node);
    if (binding) {
      if (!binding.available || !binding.stable || binding.typeOnly || binding.kind !== "const" || !binding.declaration) return;
      const key3 = binding.declaration;
      if (active.has(key3)) return;
      if (bindings.has(key3)) {
        const found = observeConstruction(node, bindings.get(key3));
        return found ? { ...found, reference } : void 0;
      }
      active.add(key3);
      let result = binding.initializer ? handle(binding.initializer, depth + 1) : void 0;
      if (!binding.initializer) {
        budget.step(512);
        const source = view.initializerProjection(key3);
        if (source?.complete) {
          budget.step(512);
          const projection = view.project(node);
          if (projection?.contract?.startsWith("fst-solid.") && projection.path.length <= 1) {
            const origin = handle(projection.initializer, depth + 1);
            if (origin) result = projection.path.length ? partOf(origin, String(projection.path[0]), depth) : origin;
          }
        }
      }
      active.delete(key3);
      bindings.set(key3, result ?? null);
      const observed = observeConstruction(node, result);
      return observed ? { ...observed, reference } : void 0;
    }
    const rule3 = direct.get(node);
    if (rule3?.result) {
      if (rule3.operation === "list.raw-create" && unsafeConstructors.has("raw-list")) return;
      if (argsOf(node).some((arg) => arg.type === "spread_element")) return;
      if (!rule3.construct) return { ...make(rule3.result, node), ...rule3.shared ? { root: `shared:${rule3.shared}` } : {}, ...rule3.backing ? { constructionKind: rule3.backing } : rule3.result === "raw-list" ? { constructionKind: "raw-list" } : {} };
      if (constructed.has(node)) return constructed.get(node) ?? void 0;
      budget.step(512);
      const projection = view.project(node);
      const result = projection?.contract?.startsWith("fst-solid.") ? { ...make(rule3.result, node), constructed: true, constructionKind: rule3.result } : void 0;
      constructed.set(node, result ?? null);
      if (result && rule3.borrowed) borrowedInputs.set(result.root, Object.values(rule3.borrowed).flatMap((index) => argsOf(node)[index] ? [argsOf(node)[index]] : []));
      return result;
    }
    const family = context.family(node);
    if (family) return { ...make(family.kind, family.origin), reference, raw: family.raw };
    const member = access(node);
    if (member) {
      const receiver = handle(member.object, depth + 1);
      const part = receiver && partOf(receiver, member.name, depth);
      if (part) return { ...part, reference };
    }
    if (node.type !== "call_expression" || !node.fields.function) return;
    const accessFn = access(node.fields.function);
    if (accessFn) {
      const receiver = handle(accessFn.object, depth + 1), contract = receiver && method(receiver, accessFn.name);
      if (!receiver || !contract) return;
      if (["state", "form", "scope", "item-scope"].includes(receiver.kind) && !context.family(accessFn.object, accessFn.name)) return;
      if (contract.result === "subform" && !context.family(accessFn.object, "field")) return;
      if (contract.result === "self") return { ...receiver, reference };
      if (["value", "delayed-value", "hover-value"].includes(receiver.kind) && accessFn.name === "load" && knownFunction(argsOf(node)[0])) return { ...receiver, reference };
      if (contract.result) return { ...make(contract.result, node), root: receiver.root, ...receiver.constructionKind ? { constructionKind: receiver.constructionKind } : {} };
    } else {
      const receiver = handle(node.fields.function, depth + 1);
      if (receiver?.kind === "root-renderer") return make("root-view", node);
    }
    return;
  };
  const unsafe = /* @__PURE__ */ new Set();
  const unsafeConstructors = /* @__PURE__ */ new Set();
  let receiverProofsLimited = false;
  const taint = (input, seen = /* @__PURE__ */ new Set()) => {
    budget.step();
    const node = view.unwrap(input);
    if (seen.has(node)) return;
    const found = handle(node);
    if (found) {
      if (unsafe.has(found.root)) return;
      unsafe.add(found.root);
      for (const input2 of borrowedInputs.get(found.root) ?? []) taint(input2, seen);
      return;
    }
    if (node.type === "call_expression" || node.type === "new_expression") {
      for (const index of Object.values(direct.get(node)?.borrowed ?? {})) {
        const input2 = argsOf(node)[index];
        if (input2) taint(input2, seen);
      }
      return;
    }
    if (node.type.startsWith("jsx_")) {
      const pending = [node];
      while (pending.length) {
        budget.step();
        const child = pending.pop();
        if (child.type === "jsx_expression") for (const value4 of child.children) taint(value4, seen);
        else pending.push(...child.children);
      }
      return;
    }
    if (node.type === "pair" && node.fields.value) {
      taint(node.fields.value, seen);
      return;
    }
    if (["string", "number", "true", "false", "null", "comment", "property_identifier"].includes(node.type)) return;
    if (seen.size >= 4096) {
      receiverProofsLimited = true;
      diagnose("fst-solid.core-limit", `resource=receiver-escape-nodes accounted=${seen.size + 1} limit=4096; receiver operations are omitted.`, input);
      return;
    }
    seen.add(node);
    if (functions2.has(node.type)) {
      const body = node.fields.body;
      if (!body) return;
      if (body.type !== "statement_block") taint(body, seen);
      else {
        const pending = [...body.children];
        while (pending.length) {
          budget.step();
          const child = pending.pop();
          if (child.type === "return_statement") for (const value4 of child.children) taint(value4, seen);
          else if (!functions2.has(child.type)) pending.push(...child.children);
        }
      }
      return;
    }
    if (["member_expression", "subscript_expression"].includes(node.type) && node.fields.object) {
      taint(node.fields.object, seen);
      return;
    }
    const binding = view.binding(node);
    if (binding) {
      if (binding.origin) {
        const listFactory = coreRule(binding.origin.module, `${binding.origin.name === "*" ? "List" : binding.origin.name}.new`);
        if (listFactory?.operation === "list.raw-create") unsafeConstructors.add("raw-list");
        const constructor = coreRule(binding.origin.module, binding.origin.name);
        if (constructor?.construct && constructor.result) unsafeConstructors.add(constructor.result);
        if (binding.origin.name === "*") for (const contract of fstReturnContracts) {
          budget.step();
          if (contract.invocation === "construct") for (const origin of contract.origins) {
            if (origin.module !== binding.origin.module) continue;
            const candidate = coreRule(origin.module, origin.name);
            if (candidate?.result) unsafeConstructors.add(candidate.result);
          }
        }
      }
      if (binding.initializer) taint(binding.initializer, seen);
      else if (binding.kind === "const" && binding.declaration) {
        budget.step(512);
        const projection = view.initializerProjection(binding.declaration);
        if (projection) taint(projection.initializer, seen);
      } else if (binding.kind === "function" && binding.declaration) {
        const fn = view.declarationNode(binding.declaration);
        if (fn) taint(fn, seen);
      }
      return;
    }
    for (const child of node.type === "pair" && node.fields.value ? [node.fields.value] : node.children) taint(child, seen);
  };
  for (const node of analyzeReceivers ? view.nodes : []) {
    budget.step();
    if (["assignment_expression", "augmented_assignment_expression", "update_expression", "for_in_statement"].includes(node.type) || node.type === "unary_expression" && node.tokens.includes("delete")) {
      const left = node.fields.left ?? node.fields.argument;
      if (left) taint(left);
      if (node.fields.right) taint(node.fields.right);
    }
    if (node.type === "return_statement") for (const value4 of node.children) taint(value4);
    if (node.type === "jsx_expression") for (const value4 of node.children) taint(value4);
  }
  for (const node of analyzeReceivers ? calls2 : []) {
    budget.step();
    const fn = node.fields.function ?? node.fields.constructor;
    if (!fn) continue;
    const directRule = direct.get(node), args = argsOf(node);
    if (directRule) {
      for (const index of directRule.forwards ?? []) if (args[index]) taint(args[index]);
      continue;
    }
    const member = access(fn), receiver = member && handle(member.object);
    if (member?.name === "asScoped" && context.family(node)) continue;
    const command = member?.name === "then" && access(member.object);
    if (command && context.command(command.object, command.name)) continue;
    if (receiver && !method(receiver, member.name) && receiver.kind !== "remote-api") taint(member.object);
    const directHandle = !member && handle(fn);
    const contract = receiver && method(receiver, member.name);
    if (contract) {
      for (const index of contract.forwards ?? []) if (args[index]) taint(args[index]);
      continue;
    }
    if (directHandle) {
      const forwarded = directHandle.kind === "action" || ["value", "delayed-value", "hover-value", "field"].includes(directHandle.kind) ? args : directHandle.kind === "root-renderer" ? args.slice(1) : [];
      for (const arg of forwarded) taint(arg);
      continue;
    }
    if (member && !receiver) taint(member.object);
    if (!member && ["member_expression", "subscript_expression"].includes(fn.type) && fn.fields.object) taint(fn.fields.object);
    for (const arg of argsOf(node)) taint(arg);
  }
  const usable = (node) => {
    const found = handle(node);
    return found && !receiverProofsLimited && !unsafe.has(found.root) && !(found.constructionKind && unsafeConstructors.has(found.constructionKind)) ? found : void 0;
  };
  const literal = (owner, node, term, anchor = node) => {
    budget.step(512);
    const value4 = view.constant(node);
    if (value4.known && (typeof value4.value === "string" || typeof value4.value === "number" || typeof value4.value === "boolean")) {
      const text2 = String(value4.value);
      if (safeString(text2)) property(owner, term, text2, anchor, "core-literal", node.startIndex >= anchor.startIndex && node.endIndex <= anchor.endIndex ? value4.resolution : "constant");
      else diagnose("fst-solid.core-limit", "Literal metadata exceeds the wire string limit.", anchor);
    }
  };
  const projected = (node, name) => {
    budget.step(512);
    const result = view.project(node, [name]);
    if (!result || result.path.length) return void 0;
    let object4 = view.unwrap(node);
    for (let depth = 0; depth < 16 && object4.type !== "object"; depth++) {
      budget.step();
      const binding = view.binding(object4);
      if (!binding?.available || !binding.stable || binding.kind !== "const" || !binding.initializer) break;
      object4 = view.unwrap(binding.initializer);
    }
    if (object4.type === "object") {
      let selected;
      for (const child of object4.children) {
        budget.step();
        if (child.type === "shorthand_property_identifier" && view.name(child) === name) selected = child;
        const key3 = child.fields.key;
        const keyNode = key3?.type === "computed_property_name" ? key3.children[0] : key3;
        if (child.type === "pair" && keyNode && view.name(keyNode) === name) selected = child.fields.value;
      }
      if (selected) return selected;
    }
    return result.initializer;
  };
  const emit = (owner, node, rule3, target, args) => {
    property(owner, "fst-solid.api-operation", rule3.operation, node, "core-call");
    relation(owner, "fst-solid.operation-target", view.reference(target), node, "core-call");
    if (rule3.policy) property(owner, "fst-solid.api-policy", rule3.policy, node, "core-contract");
    for (const index of rule3.callbacks ?? []) if (args[index]) relation(owner, "fst-solid.callback", view.reference(args[index]), node, "core-callback");
    for (const index of rule3.sources ?? []) if (args[index]) relation(owner, "fst-solid.source", view.reference(args[index]), node, "core-source");
    for (const index of rule3.keys ?? []) if (args[index]) {
      relation(owner, "fst-solid.key-expression", view.reference(args[index]), node, "core-key");
      literal(owner, args[index], "fst-solid.key");
    }
    const options = rule3.options && args[rule3.options.argument];
    if (options && rule3.options) {
      for (const name of [...rule3.options.callbacks ?? [], ...rule3.options.sources ?? []]) {
        const value4 = projected(options, name);
        if (!value4) continue;
        const term = rule3.options.callbacks?.includes(name) ? "fst-solid.callback" : "fst-solid.source";
        relation(owner, term, view.reference(value4), node, `core-option-${name}`);
      }
      for (const name of rule3.options.literals ?? []) {
        budget.step(512);
        const value4 = view.constantProperty(options, name);
        if (value4.known && ["string", "number", "boolean"].includes(typeof value4.value)) {
          const text2 = `${name}=${String(value4.value)}`;
          if (safeString(text2)) property(owner, "fst-solid.option", text2, node, "core-options", value4.resolution);
        }
      }
    }
  };
  const callbackBinding = (callback2, source, kind, allowed = []) => {
    let fn = view.unwrap(callback2);
    for (let depth = 0; depth < 16 && !functions2.has(fn.type); depth++) {
      budget.step();
      const binding = view.binding(fn);
      if (!binding?.available || !binding.stable) return;
      const next = binding.initializer ?? (binding.kind === "function" && binding.declaration ? view.declarationNode(binding.declaration) : void 0);
      if (!next) return;
      fn = view.unwrap(next);
    }
    if (!functions2.has(fn.type)) return;
    const parameters = fn.fields.parameters ?? fn.fields.parameter;
    const parameter = parameters?.type === "formal_parameters" ? parameters.children.find((child) => child.type !== "comment") : parameters;
    if (!parameter) return;
    const pattern = view.patternProjections(parameter);
    if (!pattern.complete || pattern.projections.some(({ path }) => path.length > 1 || path.length === 1 && !allowed.includes(String(path[0])))) return;
    for (const binding of pattern.projections) {
      const owner = view.owner(binding.node), name = view.name(binding.node);
      if (!owner || !name || !safeString(name)) continue;
      property(owner, "fst-solid.callback-binding", `${name}:${kind}${binding.path.length ? `.${String(binding.path[0])}` : ""}`, binding.node, "core-callback-binding");
      relation(owner, "fst-solid.callback-source", view.reference(source), binding.node, "core-callback-binding");
    }
  };
  const routeDefinitions = (owner, node, input, groups) => {
    budget.step(512);
    const result = view.project(input);
    const object4 = result?.path.length === 0 ? result.initializer : void 0;
    if (object4?.type !== "object") {
      diagnose("fst-solid.core-shape", "Route definitions require a bounded static object.", node);
      return;
    }
    if (object4.children.length > 32) {
      diagnose("fst-solid.core-limit", "Route definitions exceed the bounded entry count.", node);
      return;
    }
    const entryName = (entry) => {
      const key3 = entry.fields.key;
      const unwrapped = key3?.type === "computed_property_name" ? key3.children[0] : key3;
      if (key3?.type === "computed_property_name" && unwrapped?.type !== "string") return void 0;
      return unwrapped && view.name(unwrapped);
    };
    const names = /* @__PURE__ */ new Set(), duplicates = /* @__PURE__ */ new Set();
    for (const entry of object4.children) {
      if (entry.type === "comment") continue;
      const name = entryName(entry);
      if (entry.type !== "pair" || name === void 0) {
        diagnose("fst-solid.core-shape", "Dynamic route keys or spreads may replace other entries; the table is not enumerated.", node);
        return;
      }
      if (names.has(name)) duplicates.add(name);
      names.add(name);
    }
    if (duplicates.size) diagnose("fst-solid.core-shape", "Duplicate route entries are not correlated with earlier source anchors.", node);
    for (const entry of object4.children) {
      budget.step();
      if (entry.type === "comment") continue;
      const name = entryName(entry);
      if (entry.type !== "pair" || !name || !entry.fields.value) {
        diagnose("fst-solid.core-shape", "Dynamic route entries are not enumerated.", node);
        continue;
      }
      if (duplicates.has(name)) continue;
      const value4 = projected(input, name);
      if (!value4) continue;
      let definition = view.unwrap(value4);
      for (let depth = 0; depth < 16 && definition.type !== "object"; depth++) {
        budget.step();
        const binding = view.binding(definition);
        if (!binding?.available || !binding.stable || binding.kind !== "const" || !binding.initializer) break;
        definition = view.unwrap(binding.initializer);
      }
      if (definition.type === "object") {
        const keys = /* @__PURE__ */ new Set();
        let unresolved = false;
        for (const child of definition.children) {
          budget.step();
          if (child.type === "comment") continue;
          const key3 = child.type === "shorthand_property_identifier" ? view.name(child) : entryName(child);
          if (key3 === void 0 || keys.has(key3) || !["pair", "shorthand_property_identifier"].includes(child.type)) {
            unresolved = true;
            break;
          }
          keys.add(key3);
        }
        if (unresolved) {
          diagnose("fst-solid.core-shape", "Duplicate or dynamic route options are not correlated with a declaration.", node);
          continue;
        }
      }
      const entryOwner = view.owner(entry);
      if (!entryOwner) continue;
      relation(owner, "fst-solid.route-definition", view.reference(value4), node, "core-routes");
      property(entryOwner, "fst-solid.route-entry", name, entry, "core-routes");
      if (!groups) {
        const component = projected(value4, "component");
        if (component) relation(entryOwner, "fst-solid.route-component", view.reference(component), entry, "core-route-component");
      }
      for (const prop of groups ? ["name", "navPath"] : ["id", "path", "home", "defaultPathArgs", "navGroup", "preloadComponent"]) {
        const item = projected(value4, prop);
        if (!item) continue;
        relation(entryOwner, "fst-solid.route-option", view.reference(item), entry, `core-route-${prop}`);
        if (prop === "path") literal(entryOwner, item, "fst-solid.route-path", entry);
      }
    }
  };
  for (const node of analyzeReceivers ? calls2 : []) {
    budget.step();
    if (node.tokens.includes("?.")) continue;
    const fn = node.fields.function ?? node.fields.constructor;
    if (!fn) continue;
    const args = argsOf(node), owner = view.owner(node);
    if (!owner) continue;
    const directRule = direct.get(node);
    if (directRule) {
      const itemSequence = directRule.operation === "list.raw-create" && node.type === "call_expression";
      if (itemSequence && (receiverProofsLimited || unsafeConstructors.has("raw-list"))) {
        diagnose("fst-solid.core-shape", "List factory identity is not proven after a constructor escape, mutation or bounded proof limit.", node);
        continue;
      }
      if (args.some((arg) => arg.type === "spread_element") && !itemSequence) {
        diagnose("fst-solid.core-shape", "Spread arguments do not establish positional API contracts.", node);
        continue;
      }
      emit(owner, node, itemSequence ? { ...directRule, sources: [] } : directRule.operation === "collection.change-request" && knownFunction(args[2]) ? { ...directRule, callbacks: [2], sources: [0, 1] } : directRule, fn, args);
      if (itemSequence) {
        property(owner, "fst-solid.api-policy", "ordered variadic contributions; spread iterables expand at runtime; final item count, values and normal completion unproven", node, "list-item-sequence");
        for (const [index, arg] of args.entries()) {
          budget.step();
          const spread = arg.type === "spread_element", input = spread ? arg.children.find((child) => child.type !== "comment") : arg;
          if (!input) {
            diagnose("fst-solid.core-shape", "List item contribution has no inspectable source expression.", arg);
            continue;
          }
          property(owner, "fst-solid.list-contribution", `${index}:${spread ? "spread-iterable" : "item"}`, arg, "list-item-sequence");
          relation(owner, "fst-solid.list-item-source", { kind: "expression", text: view.text(input), span: view.span(input) }, arg, "list-item-sequence");
          relation(owner, "fst-solid.list-construction", { kind: "expression", text: view.text(node), span: view.span(node) }, arg, "list-item-sequence");
        }
      }
      const assigned = context.assigned(node);
      if (assigned && directRule.result && handle(node)) {
        role(assigned, "fst-solid.api-handle", node, "core-return");
        property(assigned, "fst-solid.handle-kind", directRule.result, node, "core-return");
      }
      if (directRule.operation === "routes.define" || directRule.operation === "navigation.groups-define") {
        if (args[0]) routeDefinitions(owner, node, args[0], directRule.operation === "navigation.groups-define");
      }
      if (directRule.operation === "load-sequence.create" && args[1]) callbackBinding(args[1], node, "load-sequence-entry", ["loadGroup", "index", "isLast", "isFirst"]);
      if (["value.create", "fragment.normalize"].includes(directRule.operation) && knownFunction(args[0])) relation(owner, "fst-solid.callback", view.reference(args[0]), node, "core-initial-derivation");
      if (directRule.operation === "value.delayed-create" && knownFunction(args[1])) relation(owner, "fst-solid.callback", view.reference(args[1]), node, "core-initial-derivation");
      if (directRule.operation === "value.switch-create") {
        if (args.length > 17) diagnose("fst-solid.core-limit", "Switch cases exceed bounded case enumeration.", node);
        for (const entry of args.slice(1, 17)) {
          if (entry.type !== "array") continue;
          const parts = entry.children.filter((child) => child.type !== "comment");
          if (parts.length !== 2 || parts.some((part) => part.type === "spread_element")) continue;
          budget.step(1024);
          if (!view.project(entry, [0]) || !view.project(entry, [1])) continue;
          emit(owner, entry, { operation: "value.switch-case", sources: [0, 1], callbacks: knownFunction(parts[0]) ? [0] : [] }, parts[0], parts);
        }
      }
      continue;
    }
    const member = access(fn), receiver = member && usable(member.object);
    if (member && receiver) {
      let contract2 = method(receiver, member.name);
      if (contract2 && ["state", "form", "scope", "item-scope"].includes(receiver.kind) && !context.family(member.object, member.name)) contract2 = void 0;
      if (!contract2 && receiver.kind === "remote-api" && !member.name.startsWith("$") && !member.name.startsWith("_")) contract2 = { operation: "transport.method-request", sources: args.map((_, i) => i), policy: "remote-target-unresolved" };
      if (!contract2 || args.some((arg) => arg.type === "spread_element")) continue;
      if (["value", "delayed-value", "hover-value"].includes(receiver.kind) && member.name === "load") {
        contract2 = knownFunction(args[0]) ? { operation: "value.configure-loader", callbacks: [0], options: { argument: 1, literals: ["explicit", "delay"] } } : { operation: args.length ? "value.load-configure-or-invoke" : "value.invoke-loader", sources: [0, 1] };
      }
      emit(owner, node, contract2, member.object, args);
      if (receiver.kind === "subform") relation(owner, "fst-solid.subform-origin", view.reference(receiver.creation), node, "core-subform");
      if (args[0] && ["onSelectedChange", "onActiveChange", "onClicked"].includes(member.name)) callbackBinding(args[0], member.object, "selection-event", [member.name === "onSelectedChange" ? "selected" : member.name === "onActiveChange" ? "active" : "clicked", "args"]);
      if (args[0] && member.name === "onChange" && ["value", "delayed-value", "hover-value"].includes(receiver.kind)) callbackBinding(args[0], member.object, "pre-commit-value", ["value", "oldValue"]);
      continue;
    }
    if (member?.name === "then" && !receiver) {
      const command = access(member.object), state = command && usable(command.object);
      if (state?.kind === "state" && !state.raw && args[0] && context.command(command.object, command.name)) emit(owner, node, { operation: "state.method-completion-observe", callbacks: [0], policy: "successful-invocation-observer-not-promise-chain" }, member.object, args);
    }
    const invoked = !member && usable(fn);
    if (!invoked) continue;
    let contract;
    if (["value", "delayed-value", "hover-value"].includes(invoked.kind)) {
      budget.step(512);
      const constant = args[0] && view.constant(args[0]);
      const operation = !args.length || constant?.known && constant.value === void 0 ? "value.tracked-read" : constant?.known || knownFunction(args[0]) ? "value.write-request" : "value.call-read-or-write";
      contract = { operation, sources: args.length ? [0] : [] };
    } else if (["accessor", "prop-value", "loader"].includes(invoked.kind)) contract = { operation: `${invoked.kind}.read` };
    else if (invoked.kind === "cancel") contract = { operation: "cleanup.invoke-request", policy: "not-owner-cleanup-unregistration" };
    else if (invoked.kind === "action") contract = { operation: "action.invoke-request", sources: args.map((_, index) => index), policy: "parameters-delivered-as-array-no-enabled-enforcement" };
    else if (invoked.kind === "scheduler") {
      budget.step(512);
      const first = args[0] && view.constant(args[0]);
      contract = first?.known && typeof first.value === "number" ? { operation: "action.schedule-request", keys: [0, 2], callbacks: [1] } : first?.known && typeof first.value === "string" ? { operation: "action.schedule-request", keys: [0, 1, 3], callbacks: [2] } : { operation: "action.schedule-unknown-overload", sources: args.map((_, index) => index) };
    } else if (invoked.kind === "fragment") contract = { operation: "fragment.render-request", keys: [0], policy: "cached-unless-explicit-rerender" };
    else if (invoked.kind === "root-renderer") contract = { operation: "view.render-root-request", sources: [0, 1], callbacks: knownFunction(args[0]) ? [0] : [], policy: "manual-result-dispose" };
    if (contract && !args.some((arg) => arg.type === "spread_element")) emit(owner, node, contract, fn, args);
  }
  for (const node of calls2) {
    if (node.type !== "call_expression" || !node.fields.function) continue;
    const origin = view.resolve(node.fields.function);
    if (origin.kind !== "import" || origin.member || !["component", "componentWithChildren"].includes(origin.name) || !["@fst/components-fst-solid/app", "@fst/components-fst-solid/app/component"].includes(origin.module)) continue;
    const owner = view.owner(node), options = argsOf(node)[1];
    if (!owner || !options) continue;
    const callback2 = projected(options, "onExit");
    if (callback2) emit(owner, node, { operation: "component.post-render-register", callbacks: [0], policy: "not-unmount-or-visibility-exit" }, node.fields.function, [callback2]);
  }
}

// src/frameworks/fst-solid/family-safety.ts
var functions3 = /* @__PURE__ */ new Set(["function_expression", "function_declaration", "generator_function", "generator_function_declaration"]);
var proxyHooks = ["isIgnoredProxyMember", "buildMember", "build", "buildClassProxyMembers"];
function familySafety(view, budget, classes2, lifetimeNames2) {
  const changes = /* @__PURE__ */ new Map();
  const staticChanges = /* @__PURE__ */ new Map();
  let limited = false;
  const mark = (root4, name = "*", staticsOnly = false) => {
    for (const info of [root4.info, ...root4.peers ?? []]) {
      for (const map of staticsOnly ? [staticChanges] : root4.kind === "class" ? [changes, staticChanges] : [changes]) {
        const names = map.get(info.declaration.key) ?? /* @__PURE__ */ new Set();
        names.add(name === "__proto__" ? "*" : name);
        map.set(info.declaration.key, names);
      }
    }
  };
  const memberName = (node) => {
    const key3 = node.type === "member_expression" ? node.fields.property : node.type === "subscript_expression" ? node.fields.index : node.fields.name;
    return key3 && (node.type !== "subscript_expression" || key3.type === "string") ? view.name(key3) : void 0;
  };
  const classThis = (node) => {
    for (let cursor = view.parent(node); cursor; cursor = view.parent(cursor)) {
      budget.step();
      if (functions3.has(cursor.type) || cursor.type === "class_static_block") return;
      if (cursor.type !== "method_definition" && cursor.type !== "public_field_definition") continue;
      if (!cursor.tokens.includes("static") && cursor.type === "method_definition" && memberName(cursor) !== "constructor") return;
      const body = view.parent(cursor), owner = body && view.parent(body), declaration = owner && view.declarationAt(owner);
      const info = declaration && classes2.get(declaration.key);
      return info ? { info, kind: cursor.tokens.includes("static") ? "class" : "instance" } : void 0;
    }
    return;
  };
  const rootOf = (input, seen = /* @__PURE__ */ new Set()) => {
    budget.step();
    const node = view.unwrap(input);
    if (seen.has(node)) return;
    if (seen.size >= 24) {
      limited = true;
      return;
    }
    seen.add(node);
    if (node.type === "this") return classThis(node);
    const binding = view.binding(node);
    if (binding) {
      const info = binding.declaration && classes2.get(binding.declaration);
      if (info) return { info, kind: "class" };
      if (binding.origin) {
        const origin = binding.origin;
        const supported = Object.entries({ State: "state", Form: "form", Scope: "scope", ItemScope: "item-scope" }).filter(([name]) => (origin.name === name || origin.name === "*") && canonicalApi(origin.module, name) === name).map(([, family]) => family);
        const peers = [...classes2.values()].filter((candidate) => supported.includes(candidate.family));
        if (peers[0]) return { info: peers[0], peers: peers.slice(1), kind: "class" };
      }
      if (binding.kind === "const" && binding.initializer) return rootOf(binding.initializer, seen);
      return;
    }
    if (["member_expression", "subscript_expression"].includes(node.type) && node.fields.object) {
      const root4 = rootOf(node.fields.object, seen);
      if (root4?.kind === "class" && memberName(node) === "prototype") return { ...root4, kind: "prototype" };
    }
    return;
  };
  const expose = (input, seen = /* @__PURE__ */ new Set()) => {
    budget.step();
    const node = view.unwrap(input);
    if (seen.has(node)) return;
    if (node.type === "binary_expression" && node.tokens.includes("instanceof")) {
      if (node.fields.left) expose(node.fields.left, seen);
      return;
    }
    if (["string", "number", "true", "false", "null", "comment", "property_identifier"].includes(node.type)) return;
    if (node.type === "pair" && node.fields.value) {
      expose(node.fields.value, seen);
      return;
    }
    if (node.type.startsWith("jsx_")) {
      const pending = [node];
      while (pending.length) {
        budget.step();
        const child = pending.pop();
        if (child.type === "jsx_expression") for (const value4 of child.children) expose(value4, seen);
        else pending.push(...child.children);
      }
      return;
    }
    if (seen.size >= 4096) {
      limited = true;
      return;
    }
    seen.add(node);
    const root4 = rootOf(node);
    if (root4) {
      mark(root4);
      return;
    }
    const binding = view.binding(node);
    if (binding) {
      if (binding.kind === "const" && binding.initializer) expose(binding.initializer, seen);
      return;
    }
    if (node.type === "call_expression" || node.type === "new_expression") return;
    if (functions3.has(node.type) || node.type === "arrow_function") {
      const body = node.fields.body;
      if (body?.type !== "statement_block") {
        if (body) expose(body, seen);
        return;
      }
      const pending = [...body.children];
      while (pending.length) {
        budget.step();
        const child = pending.pop();
        if (child.type === "return_statement") for (const value4 of child.children) expose(value4, seen);
        else if (!functions3.has(child.type) && child.type !== "arrow_function") pending.push(...child.children);
      }
      return;
    }
    if (["member_expression", "subscript_expression"].includes(node.type) && node.fields.object) {
      expose(node.fields.object, seen);
      return;
    }
    for (const child of node.type === "pair" && node.fields.value ? [node.fields.value] : node.children) expose(child, seen);
  };
  const write = (input) => {
    const node = view.unwrap(input);
    if (["member_expression", "subscript_expression"].includes(node.type) && node.fields.object) {
      const root4 = rootOf(node.fields.object), name = memberName(node);
      if (root4?.kind === "class") {
        if (name === "prototype" || name === void 0 || name === "__proto__") mark(root4);
        else mark(root4, name, true);
      } else if (root4) mark(root4, name);
      else expose(node.fields.object);
      return;
    }
    for (const child of node.type === "pair_pattern" && node.fields.value ? [node.fields.value] : node.children) write(child);
  };
  if (classes2.size) for (const node of view.nodes) {
    budget.step();
    if (["assignment_expression", "augmented_assignment_expression", "update_expression", "for_in_statement"].includes(node.type) || node.type === "unary_expression" && node.tokens.includes("delete")) {
      const target = node.fields.left ?? node.fields.argument;
      if (target) write(target);
      if (node.fields.right) expose(node.fields.right);
    }
    if (node.type === "jsx_expression") for (const value4 of node.children) expose(value4);
    if (node.type !== "call_expression" && node.type !== "new_expression") continue;
    const fn = node.fields.function ?? node.fields.constructor;
    if (fn?.fields.object) {
      const root4 = rootOf(fn.fields.object), name = memberName(fn);
      if (root4?.kind === "prototype") mark(root4);
      if (root4?.kind === "class" && (!name || !lifetimeNames2.has(name))) mark(root4);
      if (root4?.kind === "instance") {
        const declared = root4.info.node.fields.body?.children.some((child) => memberName(child) === name);
        if (declared || !["field", "form", "onReady", "onChange"].includes(name ?? "")) mark(root4);
      }
    }
    for (const arg of node.fields.arguments?.children ?? []) {
      if (fn && memberName(fn) === "asScoped" && fn.fields.object && rootOf(fn.fields.object)?.kind === "class") continue;
      expose(arg);
    }
  }
  const changedIn = (map, info, name) => {
    if (limited) return true;
    for (let current = info; current; current = current.base) {
      budget.step();
      if (map.get(current.declaration.key)?.has("*") || map.get(current.declaration.key)?.has(name)) return true;
    }
    return false;
  };
  const changed = (info, name) => changedIn(changes, info, name);
  const staticChanged = (info, name) => changedIn(staticChanges, info, name);
  const customProxy = (info) => {
    if (proxyHooks.some((name) => changed(info, name))) return true;
    for (let current = info; current; current = current.base) {
      budget.step();
      if (current.node.fields.body?.children.some((child) => !child.tokens.includes("static") && (child.fields.name?.type === "computed_property_name" || proxyHooks.includes(memberName(child) ?? "")))) return true;
    }
    return false;
  };
  return { changed, staticChanged, customProxy };
}

// src/frameworks/fst-solid/index.ts
var families = { State: "state", Form: "form", Scope: "scope", ItemScope: "item-scope" };
var lifetime = {
  state: ["new", "newScoped", "use", "useOrNull", "useOrNewScoped", "useGlobal", "asScoped"],
  form: ["new", "newScoped", "use", "useOrNewScoped", "useGlobal", "asScoped"],
  scope: ["newScoped", "use", "useOrNewScoped"],
  "item-scope": ["newScoped", "use"]
};
var lifetimeNames = new Set(Object.values(lifetime).flat());
var functions4 = /* @__PURE__ */ new Set(["arrow_function", "function_expression", "function_declaration", "generator_function", "generator_function_declaration"]);
function createFstSolidPlugin(digests) {
  return {
    descriptor: descriptor(digests),
    analyze({ view, budget }, emitter) {
      if (view.state === "truncated" || view.state === "unsupported" || view.state === "failed") return { state: view.state };
      if (!view.nodes.some((node) => node.type === "import_statement" && node.fields.source && view.moduleIdentity(node.fields.source)?.startsWith("@fst/components-fst-solid/"))) return { state: "not-applicable" };
      const diagnostics = [];
      let matched = false, partial = false;
      const diagnose = (code, message, node) => {
        partial = true;
        if (diagnostics.length < 16 && !diagnostics.some((item) => item.code === code)) diagnostics.push({ code, message, span: view.span(node) });
      };
      const evidence = (node, ruleId, basis = "import-bound") => ({ ruleId, basis, span: view.span(node) });
      const wireSize = (value4) => {
        let bytes = 0;
        for (const point of canonicalJSON(value4)) {
          const code = point.codePointAt(0);
          bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
        }
        return bytes;
      };
      const role = (subject2, term, node, rule3) => {
        matched = true;
        emitter.role(subject2.key, term, evidence(node, rule3));
      };
      const property = (subject2, term, value4, node, rule3, resolution = "literal") => {
        matched = true;
        emitter.property(subject2.key, term, resolution, { kind: "string", value: value4 }, evidence(node, rule3));
      };
      const relation = (subject2, term, target, node, rule3, basis = "import-bound") => {
        budget.step();
        if (wireSize(target) > view.limits.maxValueBytes) {
          diagnose("fst-solid.reference-limit", "Source reference exceeds the bounded wire value size.", node);
          return;
        }
        matched = true;
        emitter.relation(subject2.key, term, target, evidence(node, rule3, basis));
      };
      const api = (input, space = "value") => {
        if (!input) return void 0;
        const origin = view.resolve(input, space);
        return origin.kind === "import" && !origin.member ? canonicalApi(origin.module, origin.name) : void 0;
      };
      const argumentsOf = (node) => node.fields.arguments?.children.filter((child) => child.type !== "comment") ?? [];
      const member = (node) => {
        const value4 = view.unwrap(node);
        if (value4.type !== "member_expression" || value4.tokens.includes("?.")) return void 0;
        const object4 = value4.fields.object, property2 = value4.fields.property;
        return object4 && property2 ? { object: object4, name: view.name(property2) ?? view.text(property2) } : void 0;
      };
      const declarationMap = new Map(view.declarations.map((declaration) => [declaration.key, declaration]));
      const classes2 = /* @__PURE__ */ new Map();
      const classify = (declaration, seen = /* @__PURE__ */ new Set()) => {
        budget.step();
        budget.depth(seen.size);
        if (classes2.has(declaration.key)) return classes2.get(declaration.key);
        if (declaration.kind !== "class" || seen.has(declaration.key) || seen.size >= 24) return void 0;
        seen.add(declaration.key);
        const node = view.declarationNode(declaration.key);
        const heritage = node?.children.find((child) => child.type === "class_heritage");
        const extension = heritage?.children.find((child) => child.type === "extends_clause");
        const base = extension?.fields.value;
        if (!node || !base) return void 0;
        const name = api(base), resolved = view.resolve(base);
        const parent = resolved.kind === "declaration" && declarationMap.get(resolved.key);
        const inherited = parent ? classify(parent, seen) : void 0;
        const family = name && Object.hasOwn(families, name) ? families[name] : inherited?.family;
        if (!family) return void 0;
        const info = { declaration, node, family, ...inherited ? { base: inherited } : {} };
        classes2.set(declaration.key, info);
        role(declaration, `fst-solid.${family}`, base, inherited ? "local-base-family" : "base-family");
        relation(declaration, "fst-solid.extends", resolved, base, "base-family");
        for (const type of extension?.fields.type_arguments?.children ?? []) relation(declaration, "fst-solid.type-argument", view.reference(type, "type"), type, "base-types", "syntax");
        return info;
      };
      for (const declaration of view.declarations) {
        if (declaration.kind !== "class" || classify(declaration)) continue;
        const node = view.declarationNode(declaration.key);
        const base = node?.children.find((child) => child.type === "class_heritage")?.children.find((child) => child.type === "extends_clause")?.fields.value;
        if (!base) continue;
        const resolved = view.resolve(base);
        if (resolved.kind === "import" || resolved.kind === "declaration") diagnose("fst-solid.unresolved-base", "Base-family heritage is not proven through a bounded local canonical inheritance chain.", base);
      }
      const classOf = (node) => {
        const reference = view.resolve(node);
        return reference.kind === "declaration" ? classes2.get(reference.key) : void 0;
      };
      const overrides = (info, name, isStatic) => {
        for (let current = info; current; current = current.base) {
          budget.step();
          if (current.node.fields.body?.children.some((child) => {
            budget.step();
            if (isStatic && child.type === "class_static_block") return true;
            const memberName = view.declarationAt(child)?.name ?? (child.fields.name && view.name(child.fields.name));
            return child.tokens.includes("static") === isStatic && (child.fields.name?.type === "computed_property_name" || memberName === name);
          })) return true;
        }
        return false;
      };
      const safety = familySafety(view, budget, classes2, lifetimeNames);
      const inheritedMethod = (info, name) => !overrides(info, name, false) && !safety.changed(info, name) && !safety.changed(info, "buildMember") && !safety.changed(info, "build") && !overrides(info, "buildMember", false) && !overrides(info, "build", false);
      const staticCall = (node) => {
        if (node.type !== "call_expression" || !node.fields.function) return void 0;
        const access = member(node.fields.function);
        const info = access && classOf(access.object);
        if (!access || !info || !lifetime[info.family].includes(access.name)) return void 0;
        if (overrides(info, access.name, true) || safety.staticChanged(info, access.name)) {
          diagnose("fst-solid.static-override", "A local override, mutation or escape prevents an inherited lifetime API claim.", node);
          return void 0;
        }
        return { info, name: access.name, object: access.object };
      };
      const instance = (input, seen = /* @__PURE__ */ new Set(), reportThis = false) => {
        budget.step();
        budget.depth(seen.size);
        if (seen.size >= 24) return void 0;
        const node = view.unwrap(input), ref = view.reference(node);
        if (node.type === "this") {
          let cursor = view.parent(node);
          while (cursor) {
            budget.step();
            if (functions4.has(cursor.type) && cursor.type !== "arrow_function" || cursor.type === "class_static_block" || cursor.type === "computed_property_name") break;
            if (cursor.type === "method_definition" || cursor.type === "public_field_definition") {
              const body = view.parent(cursor);
              if (cursor.tokens.includes("static") || body?.type !== "class_body") break;
              const owner = view.parent(body), decl = owner && view.declarationAt(owner), info = decl && classes2.get(decl.key);
              if (info) return { classInfo: info, reference: ref, raw: true, origin: cursor };
              break;
            }
            if (["class_declaration", "abstract_class_declaration", "class"].includes(cursor.type)) break;
            cursor = view.parent(cursor);
          }
          if (reportThis) diagnose("fst-solid.unresolved-this", "This receiver is not proven to be a local FST instance.", node);
          return void 0;
        }
        const direct = staticCall(node);
        if (direct) {
          if (direct.name === "asScoped") {
            const input2 = argumentsOf(node)[0];
            const original = input2 && input2.type !== "spread_element" ? instance(input2, seen, reportThis) : void 0;
            return original?.classInfo.declaration.key === direct.info.declaration.key ? { ...original, reference: ref } : void 0;
          }
          return { classInfo: direct.info, reference: ref, raw: !["new", "newScoped"].includes(direct.name), origin: node };
        }
        if (node.type === "new_expression" && node.fields.constructor) {
          const info = classOf(node.fields.constructor);
          if (info) return { classInfo: info, reference: ref, raw: true, origin: node };
        }
        const binding = view.binding(node);
        if (binding?.kind === "const" && binding.available && binding.stable && binding.initializer && binding.declaration && !seen.has(binding.declaration)) {
          seen.add(binding.declaration);
          const target = instance(binding.initializer, seen, reportThis);
          if (target) return { ...target, reference: ref };
        }
        return void 0;
      };
      const field = (input, seen = /* @__PURE__ */ new Set()) => {
        budget.step();
        budget.depth(seen.size);
        if (seen.size >= 24) return void 0;
        const node = view.unwrap(input), reference = view.reference(node);
        if (node.type === "call_expression" && node.fields.function) {
          if (api(node.fields.function) === "field") return { reference, creation: node };
          const access = member(node.fields.function);
          if (access?.name === "field") {
            const value4 = instance(access.object, /* @__PURE__ */ new Set(), true);
            if (value4?.classInfo.family === "form" && inheritedMethod(value4.classInfo, "field")) return { reference, creation: node, origin: access.object };
          }
          if (access && ["onChange", "onSet", "map"].includes(access.name)) {
            const original = field(access.object, seen);
            if (original) {
              budget.step(512);
              return view.project(node.fields.function) ? original : { ...original, unprovenMethod: true };
            }
          }
        }
        const binding = view.binding(node);
        if (binding?.kind === "const" && binding.available && binding.stable && binding.initializer && binding.declaration && !seen.has(binding.declaration)) {
          seen.add(binding.declaration);
          const result = field(binding.initializer, seen);
          if (result) return { ...result, reference };
        }
        return void 0;
      };
      const assigned = (call) => {
        let cursor = call;
        for (let i = 0; i < 64; i++) {
          budget.step();
          const decl = view.declarationAt(cursor);
          if (decl) return decl;
          const parent = view.parent(cursor);
          if (!parent) return void 0;
          if (["parenthesized_expression", "as_expression", "satisfies_expression", "type_assertion", "non_null_expression", "instantiation_expression"].includes(parent.type)) {
            cursor = parent;
            continue;
          }
          if (["variable_declarator", "public_field_definition"].includes(parent.type) && parent.fields.value?.startIndex === cursor.startIndex) return view.declarationAt(parent);
          return void 0;
        }
        return void 0;
      };
      const subject = (node, fallback) => view.owner(node) ?? (fallback?.kind === "declaration" ? declarationMap.get(fallback.key) : void 0);
      const safeString = (value4) => {
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value4)) return false;
        for (const point of value4) {
          const code = point.codePointAt(0);
          if (code >= 55296 && code <= 57343) return false;
        }
        return wireSize({ kind: "string", value: value4 }) <= view.limits.maxValueBytes;
      };
      const stringOption = (owner, node, key3, term, anchor) => {
        if (!node) {
          emitter.property(owner.key, term, "absent", void 0, evidence(anchor, "component-options"));
          return;
        }
        budget.step(512);
        const value4 = view.constantProperty(node, key3);
        if (value4.known && typeof value4.value === "string" && safeString(value4.value)) property(owner, term, value4.value, node, "component-options", value4.resolution);
        else if (!value4.known && value4.reason === "absent") emitter.property(owner.key, term, "absent", void 0, evidence(node, "component-options"));
        else {
          emitter.property(owner.key, term, "expression", void 0, evidence(node, "component-options"));
          diagnose("fst-solid.dynamic-options", "Component metadata is not a proven bounded string constant.", node);
        }
      };
      const changeArguments = (owner, dependencies, callback2, mode = "onChange") => {
        const inputs = dependencies.children.filter((child) => child.type !== "comment");
        const punctuation = (start, end) => view.source.slice(start, end).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "").trim();
        if (!inputs.length || inputs.length > (mode === "onChange" ? 4 : 3) || mode === "resolveChildrenOnChange" && inputs.length < 2 || inputs.some((input, index) => input.type === "spread_element" || punctuation(index ? inputs[index - 1].endIndex : dependencies.startIndex + 1, input.startIndex) !== (index ? "," : "")) || !["", ","].includes(punctuation(inputs.at(-1).endIndex, dependencies.endIndex - 1))) {
          diagnose("fst-solid.dynamic-dependencies", "Callback projections require the supported explicit dependency arity without holes or spreads.", dependencies);
          return;
        }
        let fn = view.unwrap(callback2);
        const seen = /* @__PURE__ */ new Set();
        while (!functions4.has(fn.type) && seen.size < 24 && !seen.has(fn)) {
          budget.step();
          seen.add(fn);
          const binding = view.binding(fn);
          if (!binding?.available || !binding.stable) return;
          const next = binding.initializer ?? (binding.kind === "function" && binding.declaration ? view.declarationNode(binding.declaration) : void 0);
          if (!next) return;
          fn = view.unwrap(next);
        }
        if (!functions4.has(fn.type)) return;
        const parameters = fn.fields.parameters ?? fn.fields.parameter;
        const parameter = parameters?.type === "formal_parameters" ? parameters.children.find((child) => child.type !== "comment") : parameters;
        if (!parameter) return;
        const projected = view.patternProjections(parameter);
        if (!projected.complete || projected.projections.some(({ path }) => path.length > 1 || path.length === 1 && (typeof path[0] !== "number" || path[0] >= inputs.length))) {
          diagnose("fst-solid.callback-pattern", "Only bounded positional callback bindings are projected to change snapshots.", parameter);
          return;
        }
        for (const { node, path } of projected.projections) {
          budget.step();
          if (path.length !== 1 || typeof path[0] !== "number") continue;
          const name = view.name(node), dependency = inputs[path[0]];
          if (!name || !dependency || !safeString(name)) continue;
          const bindingOwner = view.owner(node) ?? owner;
          property(bindingOwner, mode === "resolveChildrenOnChange" && path[0] === 0 ? "fst-solid.children-change-argument" : "fst-solid.change-argument", name, node, "change-argument");
          relation(bindingOwner, "fst-solid.change-argument-source", view.reference(dependency), node, "change-argument");
        }
      };
      for (const declaration of view.declarations) {
        budget.step();
        const node = view.declarationNode(declaration.key);
        if (!node) continue;
        if (declaration.kind === "method" && declaration.owner) {
          const info = classes2.get(declaration.owner);
          if (info && !node.tokens.some((token) => ["static", "get", "set"].includes(token))) {
            const name = declaration.name;
            const hook = info.family === "form" && ["init", "save", "submit", "validate", "errors"].includes(name ?? "") ? `form.${name}` : ["state", "scope", "item-scope"].includes(info.family) && name === "initLoad" ? `${info.family}.initLoad` : void 0;
            if (hook) {
              role(declaration, "fst-solid.lifecycle-hook", node, "method-hook");
              property(declaration, "fst-solid.hook-kind", hook, node, "method-hook");
            }
            if (hook && ["scope", "item-scope"].includes(info.family)) property(declaration, "fst-solid.api-policy", "initialization-enabled effect requests initLoad through webview readiness; completion flags set in finally; invocation, success and scheduling unproven", node, "scope-initialization");
            else if (info.family === "state" && name === "init") property(declaration, "fst-solid.hook-kind", "state.init-configuration-override", node, "state-configuration");
          }
        }
        const value4 = node.fields.value && view.unwrap(node.fields.value);
        if (value4) {
          const handle = field(value4);
          if (handle) {
            if (handle.unprovenMethod) property(declaration, "fst-solid.api-policy", "authored Field source lineage only; fluent method and returned callable identity unproven", value4, "field-creation");
            else role(declaration, "fst-solid.field", value4, "field-creation");
            if (handle.origin) {
              relation(declaration, "fst-solid.form-origin", view.reference(handle.origin), value4, "form-field");
              const path = argumentsOf(handle.creation)[0];
              if (path) relation(declaration, "fst-solid.field-path-expression", view.reference(path), value4, "form-field", "syntax");
              budget.step(512);
              const literal = path && view.constant(path);
              if (literal?.known && typeof literal.value === "string" && safeString(literal.value)) property(declaration, "fst-solid.field-path", literal.value, value4, "form-field", path.startIndex >= value4.startIndex && path.endIndex <= value4.endIndex ? literal.resolution : "constant");
              else {
                emitter.property(declaration.key, "fst-solid.field-path", "expression", void 0, evidence(value4, "form-field"));
                diagnose("fst-solid.dynamic-field-path", "Field path remains an expression, not a resolved TypeScript property.", value4);
              }
            }
            for (const type of handle.creation.fields.type_arguments?.children ?? []) relation(declaration, "fst-solid.value-type", view.reference(type, "type"), value4, "field-value-type", "syntax");
          }
        }
      }
      for (const node of view.nodes) {
        budget.step();
        if (node.type === "generic_type" || node.type === "type_identifier") {
          const name = node.type === "generic_type" ? node.fields.name : node;
          const typeApi = api(name, "type");
          if (typeApi === "Field" || typeApi === "InputField" || typeApi === "FormField") {
            if (node.type === "type_identifier" && view.parent(node)?.type === "generic_type") continue;
            const owner2 = subject(node);
            if (owner2) {
              relation(owner2, "fst-solid.field-type", view.resolve(name, "type"), node, "field-type", "syntax");
              for (const type of node.fields.type_arguments?.children ?? []) relation(owner2, "fst-solid.value-type", view.reference(type, "type"), type, "field-type", "syntax");
            }
          }
        }
        if (node.type === "new_expression" && node.fields.constructor) {
          const info = classOf(node.fields.constructor), owner2 = subject(node);
          if (info && owner2) {
            property(owner2, "fst-solid.instance-kind", "raw-constructor", node, "raw-construction");
            relation(owner2, "fst-solid.lifetime-target", { kind: "declaration", key: info.declaration.key }, node, "raw-construction");
          } else if (["Field", "InputField", "FormField"].includes(api(node.fields.constructor, "type") ?? "")) diagnose("fst-solid.type-construction", "Field type references are not runtime constructors.", node);
          continue;
        }
        if (node.type !== "call_expression" || !node.fields.function) continue;
        const fn = node.fields.function, args = argumentsOf(node), called = api(fn), access = member(fn);
        if (called === "component" || called === "componentWithChildren") {
          const owner2 = assigned(node);
          if (!args[0] || args.some((arg) => arg.type === "spread_element")) {
            diagnose("fst-solid.component-shape", "Component constructions require an explicit renderer without positional spreads.", node);
            continue;
          }
          if (!owner2) {
            let value4 = node, parent = view.parent(value4);
            while (parent && ["parenthesized_expression", "as_expression", "satisfies_expression", "type_assertion", "non_null_expression"].includes(parent.type)) {
              budget.step();
              value4 = parent;
              parent = view.parent(value4);
            }
            let factory = parent?.type === "arrow_function" && parent.fields.body === value4 ? parent : void 0;
            if (parent?.type === "return_statement") {
              for (let at = view.parent(parent); at; at = view.parent(at)) {
                budget.step();
                if (functions4.has(at.type) || at.type === "method_definition") {
                  factory = at;
                  break;
                }
              }
            }
            const factoryOwner = factory && !factory.tokens.includes("async") && !factory.type.includes("generator") && !factory.tokens.includes("*") ? view.declarationAt(factory) ?? assigned(factory) : void 0;
            if (!factoryOwner) {
              diagnose("fst-solid.component-shape", "Construction is not a directly assigned component or a declared synchronous factory return.", node);
              continue;
            }
            role(factoryOwner, "fst-solid.component-factory", node, "returned-component-construction");
            relation(factoryOwner, "fst-solid.returns-component", view.reference(node), node, "returned-component-construction");
            relation(factoryOwner, "fst-solid.factory", view.resolve(fn), fn, "returned-component-construction");
            relation(factoryOwner, "fst-solid.returned-renderer", view.reference(args[0]), args[0], "returned-component-construction");
            if (args[1]) relation(factoryOwner, "fst-solid.returned-options", view.reference(args[1]), args[1], "returned-component-construction", "syntax");
            property(factoryOwner, "fst-solid.component-return", "authored construction; metadata evaluated per invocation; other returns and callers not inferred", node, "returned-component-construction");
            continue;
          }
          role(owner2, "fst-solid.component", node, "component-factory");
          relation(owner2, "fst-solid.factory", view.resolve(fn), fn, "component-factory");
          relation(owner2, "fst-solid.implemented-by", view.reference(args[0]), args[0], "component-renderer");
          for (const type of node.fields.type_arguments?.children ?? []) relation(owner2, "fst-solid.props-type", view.reference(type, "type"), type, "component-props", "syntax");
          if (!node.fields.type_arguments) {
            const ref = view.reference(args[0]);
            const declared = ref.kind === "declaration" ? view.declarationNode(ref.key) : void 0;
            const renderer = view.unwrap(declared?.fields.value ?? declared ?? args[0]);
            const parameter = renderer.fields.parameters?.children[0] ?? renderer.fields.parameter;
            const type = parameter?.fields.type?.children[0];
            if (type) relation(owner2, "fst-solid.props-type", view.reference(type, "type"), args[0], "renderer-props", "syntax");
          }
          stringOption(owner2, args[1], "name", "fst-solid.name", node);
          stringOption(owner2, args[1], "designName", "fst-solid.design-name", node);
          stringOption(owner2, args[1], "designConcept", "fst-solid.design-concept", node);
          continue;
        }
        const inherited = staticCall(node);
        if (inherited) {
          const owner2 = subject(node, { kind: "declaration", key: inherited.info.declaration.key });
          if (owner2) {
            const operation = { new: "create-standalone", newScoped: "create-scoped", use: "require-existing", useOrNull: "optional-existing", useOrNewScoped: "reuse-or-create-scoped", useGlobal: "reuse-or-create-global", asScoped: "provide-existing" };
            property(owner2, "fst-solid.lifetime-operation", operation[inherited.name], node, "lifetime-call");
            relation(owner2, "fst-solid.lifetime-target", { kind: "declaration", key: inherited.info.declaration.key }, node, "lifetime-call");
            if (["use", "useOrNull", "useOrNewScoped"].includes(inherited.name)) property(owner2, "fst-solid.lookup-policy", ["state", "form"].includes(inherited.info.family) ? "scoped-with-global-fallback" : "scoped-only", node, "lifetime-call");
          }
        } else if (access && lifetimeNames.has(access.name) && api(access.object) !== "List") {
          const origin = view.resolve(access.object), declared = view.reference(access.object);
          if (origin.kind === "import" || declared.kind === "declaration" && classes2.has(declared.key)) diagnose("fst-solid.unresolved-lifetime", "The receiver or family API is not a proven inherited lifetime operation.", node);
        }
        const owner = subject(node);
        if (called === "field" && owner) {
          property(owner, "fst-solid.field-operation", "construct-standalone", node, "field-creation");
          relation(owner, "fst-solid.factory", view.resolve(fn), fn, "field-creation");
        }
        if (access?.name === "field" && owner) {
          const handle2 = field(node);
          if (handle2?.origin) {
            property(owner, "fst-solid.field-operation", "access-form-field", node, "form-field");
            relation(owner, "fst-solid.form-origin", view.reference(handle2.origin), node, "form-field");
            if (args[0]) relation(owner, "fst-solid.field-path-expression", view.reference(args[0]), node, "form-field", "syntax");
          }
        }
        if (access?.name === "form" && instance(access.object)?.classInfo.family === "form") diagnose("fst-solid.subform-expression", "Subform traversal remains an unresolved form expression in this file-local slice.", node);
        if (called === "useFieldBinding") {
          if (!owner || !args[0]) {
            diagnose("fst-solid.unattached-registration", "A binding call without a containing declaration is not represented.", node);
            continue;
          }
          const assignedOwner = assigned(node) ?? owner;
          role(assignedOwner, "fst-solid.field-binding", node, "field-binding");
          property(assignedOwner, "fst-solid.ownership", "borrowed-no-disposal", node, "field-binding");
          relation(assignedOwner, "fst-solid.borrows", view.reference(args[0]), args[0], "field-binding");
        }
        if (called && ["onChange", "onChangeDelayed", "resolveChildrenOnChange", "onCleanup", "onComponentCleanup", "onMount"].includes(called)) {
          if (!owner) {
            diagnose("fst-solid.unattached-registration", "A registration without a containing declaration is not represented.", node);
            continue;
          }
          role(owner, "fst-solid.registration", node, "registration");
          const contract = called === "onCleanup" ? "solid.content-or-effect-cleanup" : called === "onComponentCleanup" ? "fst.wrapper-cleanup" : called === "onMount" ? "solid.content-mount" : called === "onChangeDelayed" ? "explicit-delayed-dependency-watch" : called === "resolveChildrenOnChange" ? "explicit-children-dependency-watch" : "explicit-dependency-watch";
          property(owner, "fst-solid.registration-kind", contract, node, "registration");
          const watch = ["onChange", "onChangeDelayed", "resolveChildrenOnChange"].includes(called);
          const callback2 = args[called === "onChangeDelayed" ? 2 : watch ? 1 : 0];
          if (callback2) relation(owner, "fst-solid.callback", view.reference(callback2), callback2, "registration");
          if (watch) {
            const dependencies = args[called === "onChangeDelayed" ? 1 : 0];
            const deps = dependencies && view.unwrap(dependencies);
            if (deps?.type === "array" && !deps.children.some((child) => child.type === "spread_element")) {
              for (const dep of deps.children.filter((child) => child.type !== "comment")) relation(owner, "fst-solid.observes", view.reference(dep), dep, "explicit-dependencies", "syntax");
              if (callback2) changeArguments(owner, deps, callback2, called);
            } else if (deps) {
              relation(owner, "fst-solid.observes", view.reference(deps), deps, "explicit-dependencies", "syntax");
              diagnose("fst-solid.dynamic-dependencies", "Only explicit dependency arrays are enumerated; reactive dependency discovery is not performed.", deps);
            }
          }
        }
        if (access && ["onChange", "onSet"].includes(access.name)) {
          const handle2 = field(access.object), target2 = subject(node, handle2?.reference);
          if (handle2 && target2) {
            role(target2, "fst-solid.registration", node, "field-observer");
            property(target2, "fst-solid.observation-phase", access.name === "onChange" ? "pre-commit" : "post-commit", node, "field-observer");
            relation(target2, "fst-solid.field-target", handle2.reference, access.object, "field-observer");
            if (args[0]) relation(target2, "fst-solid.callback", view.reference(args[0]), args[0], "field-observer");
          }
        }
        if (access?.name === "init" && owner) {
          const receiver = instance(access.object);
          if (receiver?.classInfo.family === "state" && inheritedMethod(receiver.classInfo, "init")) {
            property(owner, "fst-solid.registration-kind", "state.init-configuration", node, "state-configuration");
            if (args[0]) relation(owner, "fst-solid.callback", view.reference(args[0]), args[0], "state-configuration");
          }
        }
        const handle = field(fn), target = subject(node, handle?.reference);
        if (handle && target) {
          if (handle.unprovenMethod) {
            diagnose("fst-solid.unknown-field-value", "Fluent Field invocation requires a proven, unescaped method result.", node);
            continue;
          }
          if (args.some((arg) => arg.type === "spread_element") || node.tokens.includes("?.") || node.children.some((child) => child.type === "optional_chain")) {
            diagnose("fst-solid.unknown-field-value", "Field dispatch requires an unconditional call with explicit argument positions.", node);
            continue;
          }
          budget.step(512);
          const value4 = args[0] && view.constant(args[0]);
          const read = args.length === 0 || value4?.known && value4.value === void 0;
          const write = value4?.known && value4.value !== void 0 || args[0] && functions4.has(view.unwrap(args[0]).type);
          if (read || write) property(target, "fst-solid.field-operation", read ? "read" : "write-request", node, "field-invocation");
          else if (args[0]) {
            property(target, "fst-solid.field-operation", "conditional-read-or-write-request", node, "field-invocation");
            property(target, "fst-solid.field-dispatch", "argument[0] === undefined: read; otherwise: write request (function inputs are updaters); branch, value, completion and disposal state unproven", node, "field-invocation");
            relation(target, "fst-solid.field-argument", { kind: "expression", text: view.text(args[0]), span: view.span(args[0]) }, node, "field-invocation");
            if (args[1]) relation(target, "fst-solid.field-write-options", { kind: "expression", text: view.text(args[1]), span: view.span(args[1]) }, node, "field-invocation");
          }
          relation(target, "fst-solid.field-target", handle.reference, fn, "field-invocation");
        }
      }
      analyzeCore({
        view,
        budget,
        hasFamilies: classes2.size > 0,
        role,
        property,
        relation,
        diagnose,
        safeString,
        assigned,
        family(input, method) {
          if (!classes2.size) return void 0;
          const value4 = instance(input);
          if (!value4 || method && !inheritedMethod(value4.classInfo, method)) return void 0;
          return { kind: value4.classInfo.family, raw: value4.raw, origin: value4.origin };
        },
        command(input, name) {
          if (!classes2.size || name.startsWith("_") || name.startsWith("$") || name.startsWith("#") || ["constructor", "init", "build", "buildMember", "onChange"].includes(name)) return false;
          const value4 = instance(input);
          return !!value4 && !value4.raw && value4.classInfo.family === "state" && !safety.customProxy(value4.classInfo) && !safety.changed(value4.classInfo, name) && !!value4.classInfo.node.fields.body?.children.some((child) => child.type === "method_definition" && !child.tokens.some((token) => ["static", "get", "set"].includes(token)) && child.fields.name && view.name(child.fields.name) === name);
        }
      });
      return { state: partial ? "partial" : matched ? "complete" : "not-applicable", diagnostics };
    }
  };
}

// src/frameworks/fst-solid/components-contracts.ts
var disco = "@fst/components-fst-disco-ui";
var icons = "@fst/components-fst-solid-icons";
var three = "@fst/components-fst-solid-threejs";
var componentNames = ["TextBox", "TextArea", "Checkbox", "CheckboxItem", "Switch", "SwitchItem", "Slider", "Select", "SelectItem", "SelectOption", "ColorEditor", "MarkdownEditor", "ContextMenu", "Popover", "ModalHost", "ToastHost"];
var overlayNames = ["useModal", "openModal", "openConfirmationModal", "useToasts", "showToast", "dismissToast", "removeToast", "initToasts", "tooltip", "focusring"];
var themeNames = ["applyDiscoTheme", "resolveDiscoTheme"];
var iconAssets = ["loadIconDef", "resolveIconDef", "configureIconAssetLoading", "getIconAssetLoadingConfig", "resolveIconAssetUrl", "getIconAssetShape", "clearIconAssetCache", "getIconAssetCacheSnapshot"];
var canvas = ["Canvas3d", "Scene", "Canvas3dState", "SceneState"];
var scene = ["Scene3d", "SceneNode", "GLTFMeshNode", "GLTFMeshAnimation", "setupCameraControls", "useCameraControls", "getCameraPosFocusOnBoneWithZoom", "getCameraPosFocusBetweenBonesWithZoom"];
var scenegraph = ["SceneGraphCanvas", "SceneGraphRuntime", "createSceneGraphRuntimeData", "createSceneGraphHtmlSceneOverlayBridge", "SceneGraphHtmlSceneOverlayHost"];
var utils = ["loadGLTF", "loadTexture", "loaderFn", "setDecoderPathGLTF"];
var effects = ["setupMaterialFogEffect", "setupVolumetricFogEffect", "setupVolumetricCloudsEffect", "setupSsaoEffect", "setupPencilOutlineEffect", "setupPencilLinesEffect"];
var catalogue3 = {
  [disco]: [...componentNames, ...overlayNames, ...themeNames],
  [`${disco}/components`]: [...componentNames, ...overlayNames],
  [`${disco}/theme`]: themeNames,
  [icons]: [...iconAssets, "SvgIcon", "Icon"],
  [`${icons}/assets`]: iconAssets,
  [`${icons}/components`]: ["SvgIcon", "Icon"],
  [three]: [...canvas, ...scene, ...scenegraph, ...utils, ...effects, "AssetsManager"],
  [`${three}/Canvas`]: canvas,
  [`${three}/scene`]: [...scene, ...scenegraph],
  [`${three}/scene/scenegraph`]: scenegraph,
  [`${three}/utils`]: utils,
  [`${three}/assets`]: ["AssetsManager"],
  [`${three}/effects`]: effects
};
function componentsApi(module, name) {
  return Object.hasOwn(catalogue3, module) && catalogue3[module].includes(name) ? name : void 0;
}
var value2 = Object.freeze({ kind: "value" });
var object2 = (...names) => Object.freeze({ kind: "object", properties: Object.freeze(Object.fromEntries(names.map((name) => [name, value2]))) });
var cameraMethods = ["setCameraFocusPoint", "setCameraDistance", "setCameraFocusOnObject", "setCameraFocusTopDown", "getCameraState", "setCameraState", "resetCameraState", "getCameraOrbitAngles", "setCameraOrbitLimits", "addCameraControlEndListener", "isCameraUserControlling"];
var animationMethods = ["addAnimations", "isPlayingAnimation", "pose", "playAnimation", "stopAnimation", "pauseAnimation", "resumeAnimation", "playAnimationLayered", "poseLayered", "stopLayer", "setLayerWeight", "pauseLayer", "resumeLayer", "fadeOutLayer", "tweenLayerWeight", "stopLayerTween", "dispose"];
var shapes = [
  [["useModal"], object2("openModal", "openConfirmationModal")],
  [["useToasts"], object2("showToast", "dismissToast")],
  [["showToast"], object2("id")],
  [["openModal", "openConfirmationModal", "initToasts", "tooltip", "focusring", "applyDiscoTheme", "loaderFn", "loadGLTF", "loadTexture", "loadIconDef", "resolveIconDef"], value2],
  [["setupCameraControls", "useCameraControls"], object2(...cameraMethods)],
  [["setupMaterialFogEffect", "setupVolumetricFogEffect", "setupVolumetricCloudsEffect"], object2("dispose")],
  [["setupSsaoEffect", "setupPencilOutlineEffect", "setupPencilLinesEffect"], value2],
  [["createSceneGraphHtmlSceneOverlayBridge"], object2("registerHtmlScene", "bindOverlayEntry", "entries")],
  [["getIconAssetShape"], object2("shape", "assetShape", "family", "name", "path")],
  [["configureIconAssetLoading", "getIconAssetLoadingConfig"], object2("baseUrl", "resolver", "fetch")],
  [["resolveDiscoTheme"], object2("mode", "colors")],
  [["getCameraPosFocusOnBoneWithZoom", "getCameraPosFocusBetweenBonesWithZoom"], Object.freeze({ kind: "tuple", items: Object.freeze([value2, value2]) })]
];
var assetMethods = object2("loadTexture", "loadGltf", "loadGLTF");
var constructShapes = [
  ["AssetsManager", assetMethods],
  ["SceneGraphRuntime", object2("attach", "setDocument", "getNodeById", "getCamera", "setCamera", "dispose")],
  ["Scene3d", Object.freeze({ kind: "object", properties: Object.freeze({ add: value2, remove: value2, addRenderListener: value2, dispose: value2, assets: assetMethods }) })],
  ["SceneNode", object2("dispose")],
  ["GLTFMeshNode", Object.freeze({ kind: "object", properties: Object.freeze({ animation: object2(...animationMethods), dispose: value2 }) })],
  ["GLTFMeshAnimation", object2(...animationMethods)]
];
var origins2 = (name) => Object.freeze(Object.entries(catalogue3).filter(([, exports]) => exports.includes(name)).map(([module]) => Object.freeze({ module, name })));
var fstComponentsReturnContracts = Object.freeze([
  ...shapes.flatMap(([names, result]) => names.map((name) => Object.freeze({ id: `fst-components.${name.toLowerCase()}`, origins: origins2(name), result }))),
  ...constructShapes.map(([name, result]) => Object.freeze({ id: `fst-components.construct.${name.toLowerCase()}`, invocation: "construct", origins: origins2(name), result }))
]);
var calls = {
  useModal: { role: "overlay", result: "{openModal,openConfirmationModal};captured-owner", handle: "modal-api" },
  openModal: { role: "overlay", result: "ModalClose(reason?);callable", handle: "modal-close" },
  openConfirmationModal: { role: "overlay", result: "Promise<void>;false-confirm-keeps-open;cancel-rejects-ModalCancelledError" },
  useToasts: { role: "overlay", result: "{showToast,dismissToast};captured-owner", handle: "toasts-api" },
  showToast: { role: "overlay", result: "ToastHandle;callable-dismiss;readonly-id", handle: "toast-handle" },
  dismissToast: { role: "overlay", result: "void" },
  removeToast: { role: "overlay", result: "void;alias-of-dismissToast" },
  initToasts: { role: "registration", result: "cleanup-function", handle: "disposer", cleanup: "explicit-call-or-conditional-owner-cleanup" },
  tooltip: { role: "dom-effect", result: "disposer-function", handle: "disposer", cleanup: "explicit-call-or-conditional-owner-cleanup" },
  focusring: { role: "dom-effect", result: "disposer-function", handle: "disposer", cleanup: "explicit-call-or-conditional-owner-cleanup" },
  applyDiscoTheme: { role: "dom-effect", result: "idempotent-restore-function", handle: "disposer", cleanup: "explicit-only;no-owner-registration" },
  resolveDiscoTheme: { role: "dom-effect", result: "{mode,colors}" },
  loadIconDef: { role: "asset-request", result: "Promise<IconDef|null>" },
  resolveIconDef: { role: "asset-request", result: "Promise<IconDef|null>" },
  configureIconAssetLoading: { role: "asset-request", result: "IconAssetLoadingConfig-copy" },
  getIconAssetLoadingConfig: { role: "asset-request", result: "IconAssetLoadingConfig-copy" },
  resolveIconAssetUrl: { role: "asset-request", result: "string;resolver-or-configured-url" },
  getIconAssetShape: { role: "asset-request", result: "{shape,assetShape,family,name,path}" },
  clearIconAssetCache: { role: "asset-request", result: "void;not-cancellation" },
  getIconAssetCacheSnapshot: { role: "asset-request", result: "IconAssetCacheSnapshotEntry[];not-live-state" },
  loadGLTF: { role: "asset-request", result: "Promise<GLTFData|GLTFData[]>;input-shape-dependent" },
  loadTexture: { role: "asset-request", result: "Promise<Texture>;raw-resource" },
  loaderFn: { role: "asset-request", result: "(LoaderCtor,...urls)=>Promise<results[]>", handle: "loader" },
  setDecoderPathGLTF: { role: "asset-request", result: "void;decoder-path-configuration" },
  setupMaterialFogEffect: { role: "resource", result: "MaterialFogEffect", handle: "effect", cleanup: "explicit-dispose-request;listener-and-material-restoration" },
  setupVolumetricFogEffect: { role: "resource", result: "VolumetricFogEffectPass", handle: "effect", cleanup: "explicit-dispose-request;not-composer-removal" },
  setupVolumetricCloudsEffect: { role: "resource", result: "VolumetricCloudsEffectPass", handle: "effect", cleanup: "explicit-dispose-request;not-composer-removal" },
  setupSsaoEffect: { role: "resource", result: "Promise<void>;pipeline-replacement" },
  setupPencilOutlineEffect: { role: "resource", result: "Promise<void>;pipeline-replacement" },
  setupPencilLinesEffect: { role: "resource", result: "Promise<void>;pipeline-replacement" },
  createSceneGraphRuntimeData: { role: "runtime", result: "SceneGraphRuntimeData;not-live-scene", handle: "runtime-data" },
  createSceneGraphHtmlSceneOverlayBridge: { role: "registration", result: "SceneGraphHtmlSceneOverlayBridgeImpl", handle: "bridge" },
  setupCameraControls: { role: "camera", result: "camera-controller;registered-scene-node", handle: "camera" },
  useCameraControls: { role: "camera", result: "camera-controller-or-null;named-node-lookup;not-Solid-context", handle: "camera" },
  getCameraPosFocusOnBoneWithZoom: { role: "camera", result: "[Vector3-position,Vector3-target];shape-only" },
  getCameraPosFocusBetweenBonesWithZoom: { role: "camera", result: "[Vector3-position,Vector3-target];shape-only" }
};
var constructors = {
  Scene3d: { role: "scene", result: "Scene3d", handle: "scene", cleanup: "dispose-method-empty;no-GPU-cleanup-guarantee" },
  SceneNode: { role: "scene", result: "SceneNode", handle: "scene-node" },
  AssetsManager: { role: "asset-request", result: "AssetsManager;no-dispose-API", handle: "assets-manager" },
  SceneGraphRuntime: { role: "runtime", result: "SceneGraphRuntime", handle: "runtime" },
  GLTFMeshNode: { role: "animation", result: "GLTFMeshNode", handle: "mesh" },
  GLTFMeshAnimation: { role: "animation", result: "GLTFMeshAnimation", handle: "animation", cleanup: "dispose-does-not-cancel-layer-tweens" }
};
function memberContract(kind, name) {
  if (kind === "modal-api" && ["openModal", "openConfirmationModal"].includes(name)) return calls[name];
  if (kind === "toasts-api" && ["showToast", "dismissToast"].includes(name)) return calls[name];
  if (kind === "scene" && name === "add") return { role: "scene", result: "same-node-argument" };
  if (kind === "scene" && name === "addRenderListener") return { role: "registration", result: "{priority,dispose}", handle: "render-listener", cleanup: "explicit-listener-dispose" };
  if (kind === "scene" && ["remove", "dispose"].includes(name)) return { role: "scene", result: name === "dispose" ? "void;empty-implementation;no-GPU-cleanup-guarantee" : "void" };
  if (kind === "assets-manager" && ["loadGltf", "loadGLTF", "loadTexture"].includes(name)) return { role: "asset-request", result: name === "loadTexture" ? "Promise<TextureAssetEntry>;texture-optional;failure-swallowed" : "Promise<GltfAssetEntry>;failure-evicts-and-rethrows" };
  if (kind === "bridge" && name === "registerHtmlScene") return { role: "registration", result: "{updateConfig,updateProjection,requestCapture,dispose}", handle: "html-registration" };
  if (kind === "bridge" && name === "bindOverlayEntry") return { role: "registration", result: "unbind-function", handle: "disposer" };
  if (kind === "html-registration" && ["updateConfig", "updateProjection", "requestCapture", "dispose"].includes(name)) return { role: "registration", result: "void" };
  if (kind === "runtime" && ["attach", "setDocument", "getNodeById", "getCamera", "setCamera", "dispose"].includes(name)) return { role: "runtime", result: name === "getNodeById" ? "SceneGraphRuntimeNodeHandle|null;transient" : name === "getCamera" ? "SceneGraphCameraJson" : "void", ...name === "getNodeById" ? { handle: "runtime-node" } : {} };
  if (kind === "runtime-node" && name === "captureSnapshot") return { role: "resource", result: "{texture,width,height,dispose}|null", handle: "snapshot" };
  if (kind === "camera" && cameraMethods.includes(name)) return { role: "camera", result: name === "addCameraControlEndListener" ? "{dispose};pending-registration-not-guaranteed-removed" : name === "getCameraState" ? "{position,target}|null" : name === "getCameraOrbitAngles" ? "{azimuthAngle,polarAngle}|null" : name === "isCameraUserControlling" ? "boolean" : "same-controller", ...name === "addCameraControlEndListener" ? { handle: "camera-listener" } : name.startsWith("set") || name === "resetCameraState" ? { handle: "camera" } : {} };
  if (kind === "animation" && animationMethods.includes(name)) return { role: "animation", result: ["playAnimationLayered", "poseLayered"].includes(name) ? "AnimationAction|null" : name === "addAnimations" ? "number" : name === "isPlayingAnimation" ? "boolean" : "void", ...name === "dispose" ? { cleanup: "does-not-cancel-layer-tweens;stopLayerTween-is-explicit" } : {} };
  if (["effect", "render-listener", "camera-listener", "snapshot", "scene-node", "mesh"].includes(kind) && name === "dispose") return { role: "handle", result: "void;explicit-disposal-request-only" };
  return void 0;
}

// src/frameworks/fst-solid/components-vocabulary.ts
var roles2 = {
  control: "Input Control Usage",
  overlay: "Overlay Usage",
  "dom-effect": "Reversible DOM Effect Usage",
  "asset-request": "Asset API Request",
  scene: "Scene Usage",
  registration: "Explicit Registration",
  resource: "Resource Contract",
  runtime: "Scenegraph Runtime",
  camera: "Camera Controller",
  animation: "Animation Controller",
  handle: "Returned Handle",
  "callback-payload": "Callback Payload Binding"
};
var properties2 = {
  api: "Reviewed Public API",
  operation: "Requested Operation",
  "result-contract": "Declared Result Contract",
  "callback-contract": "Declared Callback Contract",
  "callback-binding": "Callback Binding Name",
  "callback-path": "Callback Payload Path",
  prop: "Authored Property",
  literal: "Authored Literal",
  ownership: "Ownership Contract",
  cleanup: "Cleanup Contract",
  requirement: "Required Context",
  qualification: "Source Qualification",
  "jsx-contribution": "Ordered JSX Prop Contribution",
  "props-contract": "JSX Props Resolution Contract",
  "conditional-prop-contract": "Conditional Public Prop Contract"
};
var relations2 = {
  import: "Qualified Public Import",
  target: "Requested Operation Target",
  input: "Authored Input",
  field: "Borrowed Field Expression",
  value: "Controlled Value Expression",
  checked: "Controlled Checked Expression",
  callback: "Authored Callback",
  "created-by": "Handle Origin",
  "argument-source": "Callback Contract Source",
  document: "Scenegraph Document",
  "scene-target": "Scene Expression",
  options: "Authored Options",
  "spread-source": "Forwarded JSX Source",
  "forwarded-prop": "Forwarded JSX Property Expression",
  "jsx-contribution-source": "Authored JSX Contribution Source",
  "jsx-element": "Containing JSX Element Occurrence"
};
function componentsDescriptor(digests) {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error("FST components plugin requires build-supplied content digests");
  return {
    id: "fst-components",
    version: "1",
    ...digests,
    languages: ["typescript", "tsx"],
    view: { id: "typescript", version: 1 },
    roles: Object.entries(roles2).map(([name, label]) => ({ id: `fst-components.${name}`, label })),
    properties: Object.entries(properties2).map(([name, label]) => ({ id: `fst-components.${name}`, label, multiple: true, valueKind: "string" })),
    relations: Object.entries(relations2).map(([name, label]) => ({ id: `fst-components.${name}`, label }))
  };
}

// src/frameworks/fst-solid/components.ts
var functions5 = /* @__PURE__ */ new Set(["arrow_function", "function_expression", "function_declaration"]);
var key = (node) => `${node.startIndex}:${node.endIndex}`;
var controls = {
  TextBox: ["value", "onInput", "string"],
  TextArea: ["value", "onInput", "string"],
  Checkbox: ["checked", "onChange", "boolean"],
  CheckboxItem: ["checked", "onChange", "boolean"],
  Switch: ["checked", "onChange", "boolean"],
  SwitchItem: ["checked", "onChange", "boolean"],
  Slider: ["value", "onInput", "number"],
  Select: ["value", "onChange", "NonNullable<T extends string|number>"],
  SelectItem: ["value", "onChange", "NonNullable<T extends string|number>"],
  ColorEditor: ["value", "onInput", "normalized-hex-string"],
  MarkdownEditor: ["value", "onInput", "string"]
};
var jsxNames = /* @__PURE__ */ new Set([...Object.keys(controls), "SelectOption", "ContextMenu", "Popover", "ModalHost", "ToastHost", "SvgIcon", "Icon", "Canvas3d", "Scene", "SceneGraphCanvas", "SceneGraphHtmlSceneOverlayHost"]);
function createFstComponentsPlugin(digests) {
  return {
    descriptor: componentsDescriptor(digests),
    analyze({ view, budget }, emitter) {
      if (["truncated", "unsupported", "failed"].includes(view.state)) return { state: view.state };
      const diagnostics = [];
      let matched = false, partial = false;
      const diagnose = (code, message, node) => {
        partial = true;
        if (diagnostics.length < 8 && !diagnostics.some((item) => item.code === code)) diagnostics.push({ code, message, span: view.span(node) });
      };
      const bounded = (value4) => {
        let bytes = 0;
        for (const point of canonicalJSON(value4)) {
          const n = point.codePointAt(0);
          bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
        }
        return bytes <= view.limits.maxValueBytes;
      };
      const evidence = (node, ruleId) => ({ ruleId, basis: "import-bound", span: view.span(node) });
      const role = (term, node) => {
        budget.step();
        const owner = view.owner(node);
        if (!owner) return;
        matched = true;
        emitter.role(owner.key, term, evidence(node, "public-contract"));
      };
      const property = (term, value4, node, resolution = "literal") => {
        budget.step();
        const owner = view.owner(node);
        if (!owner) return;
        if (!bounded({ kind: "string", value: value4 }) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value4) || [...value4].some((point) => {
          const n = point.codePointAt(0);
          return n >= 55296 && n <= 57343;
        })) {
          diagnose("fst-components.value-limit", "Contract text exceeds the bounded wire value contract.", node);
          return;
        }
        matched = true;
        emitter.property(owner.key, term, resolution, { kind: "string", value: value4 }, evidence(node, "public-contract"));
      };
      const relation = (term, target, node) => {
        budget.step();
        const owner = view.owner(node);
        if (!owner) return;
        if (!bounded(target)) {
          diagnose("fst-components.reference-limit", "Source reference exceeds the bounded wire value size.", node);
          return;
        }
        matched = true;
        emitter.relation(owner.key, term, target, evidence(node, "public-contract"));
      };
      const api = (node) => {
        if (!node) return void 0;
        const origin = view.resolve(node);
        return origin.kind === "import" && !origin.member ? componentsApi(origin.module, origin.name) : void 0;
      };
      const argsOf = (node) => node.fields.arguments?.children.filter((child) => child.type !== "comment") ?? [];
      const access = (node) => {
        node = view.unwrap(node);
        if (node.type !== "member_expression" || node.tokens.includes("?.") || !node.fields.object || !node.fields.property) return void 0;
        const name = view.name(node.fields.property);
        return name ? { object: node.fields.object, name } : void 0;
      };
      const jsx = [];
      const callNodes = [];
      let relevant = false;
      for (const node of view.nodes) {
        budget.step();
        if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
          const tag = node.fields.name, name = api(tag);
          if (tag && name) {
            jsx.push({ node, name, tag });
            relevant = true;
          }
        }
        if (node.type === "call_expression" || node.type === "new_expression") {
          callNodes.push(node);
          if (api(node.fields.function ?? node.fields.constructor)) relevant = true;
        }
      }
      if (!relevant) return { state: "not-applicable" };
      const projections = /* @__PURE__ */ new Map();
      const project = (node, path = []) => {
        const cacheKey = `${key(node)}:${JSON.stringify(path)}`;
        if (projections.has(cacheKey)) return projections.get(cacheKey);
        budget.step(512);
        const result = view.project(node, path);
        projections.set(cacheKey, result);
        return result;
      };
      const parameterKinds = /* @__PURE__ */ new Map();
      const unsafe = /* @__PURE__ */ new Set();
      const unsafeFactories = /* @__PURE__ */ new Set();
      const escapedImports = /* @__PURE__ */ new Set();
      const constructorEscaped = (node) => {
        budget.step();
        if (!node) return false;
        const origin = view.resolve(node);
        return origin.kind === "import" && (escapedImports.has(JSON.stringify([origin.module, origin.name])) || escapedImports.has(JSON.stringify([origin.module, "*"])));
      };
      let receiverProofsLimited = false;
      const taint = (input, seen = /* @__PURE__ */ new Set()) => {
        budget.step();
        if (seen.has(key(input))) return;
        if (seen.size >= 32) {
          receiverProofsLimited = true;
          diagnose("fst-components.call-shape", "Receiver escape analysis exceeded the bounded syntax shape; receiver operations are omitted.", input);
          return;
        }
        const node = view.unwrap(input);
        if (node.type.endsWith("_pattern") && node.children.length > 0 || ["object", "array", "spread_element", "pair", "arrow_function", "function_expression", "function_declaration", "method_definition", "statement_block", "return_statement", "ternary_expression", "binary_expression", "sequence_expression", "await_expression", "yield_expression", "template_substitution", "jsx_expression"].includes(node.type)) {
          seen.add(key(input));
          const selected = ["pair", "pair_pattern"].includes(node.type) ? node.fields.value : ["assignment_pattern", "object_assignment_pattern"].includes(node.type) ? node.fields.left : void 0;
          for (const child of selected ? [selected] : node.children) taint(child, seen);
          return;
        }
        if (["member_expression", "subscript_expression"].includes(node.type) && node.fields.object) {
          seen.add(key(input));
          taint(node.fields.object, seen);
          return;
        }
        const binding = view.binding(node);
        if (!binding || seen.has(key(binding.node))) return;
        if (binding.origin) escapedImports.add(JSON.stringify([binding.origin.module, binding.origin.name]));
        const projected = project(node);
        if (projected?.contract?.startsWith("fst-components.")) unsafeFactories.add(key(projected.initializer));
        seen.add(key(binding.node));
        unsafe.add(key(binding.node));
        if (binding.kind === "const" && binding.initializer) taint(binding.initializer, seen);
        else if (binding.kind === "const" && binding.declaration) {
          budget.step(512);
          const source = view.initializerProjection(binding.declaration);
          if (source) taint(source.initializer, seen);
        } else if (binding.kind === "function" && binding.declaration) {
          const fn = view.declarationNode(binding.declaration);
          if (fn?.fields.body) taint(fn.fields.body, seen);
        }
      };
      for (const node of view.nodes) {
        budget.step();
        if ((node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") && !jsxNames.has(api(node.fields.name) ?? "")) {
          for (const child of node.children) {
            if (child.type === "jsx_attribute" && child.children[1]) taint(child.children[1]);
            if (child.type === "jsx_expression") taint(child);
          }
          const element = view.parent(node);
          if (element?.type === "jsx_element") {
            for (const child of element.children) if (child.type === "jsx_expression") taint(child);
          }
        }
        if (node.type === "return_statement" || node.type === "yield_expression") for (const child of node.children) taint(child);
        if (node.type === "public_field_definition" && node.fields.value) taint(node.fields.value);
        if (node.type === "arrow_function" && node.fields.body && node.fields.body.type !== "statement_block") taint(node.fields.body);
        if (["assignment_expression", "augmented_assignment_expression", "update_expression", "for_in_statement"].includes(node.type) || node.type === "unary_expression" && node.tokens.includes("delete")) {
          const left = node.fields.left ?? node.fields.argument;
          if (left) taint(left);
          if (node.fields.right) taint(node.fields.right);
        }
      }
      const memberIdentity = (identity2, name) => {
        if (identity2.method) return void 0;
        if (identity2.kind === "setup-payload" && name === "scene") return { ...identity2, kind: "scene" };
        if (identity2.kind === "setup-payload" && name === "invalidateRender") return { ...identity2, kind: "invalidate" };
        if (identity2.kind === "modal-payload" && name === "close") return { ...identity2, kind: "modal-close" };
        if (identity2.kind === "mesh" && name === "animation") return { ...identity2, kind: "animation" };
        if (identity2.kind === "scene" && name === "assets") return { ...identity2, kind: "assets-manager" };
        return memberContract(identity2.kind, name) ? { ...identity2, method: name } : void 0;
      };
      const identity = (input, depth = 0, seen = /* @__PURE__ */ new Set()) => {
        budget.step();
        if (receiverProofsLimited || depth > 16 || seen.has(key(input))) return void 0;
        seen = new Set(seen);
        seen.add(key(input));
        const node = view.unwrap(input), binding = view.binding(node);
        if (binding) {
          if (!binding.available || binding.typeOnly || unsafe.has(key(binding.node))) return void 0;
          if (binding.kind === "parameter") return parameterKinds.get(key(binding.node));
          if (!binding.stable || binding.kind !== "const") return void 0;
          const projected = project(node);
          if (projected?.contract?.startsWith("fst-components.")) {
            if (unsafeFactories.has(key(projected.initializer))) return void 0;
            const name = api(projected.initializer.fields.function ?? projected.initializer.fields.constructor);
            const handle = name && (projected.initializer.type === "new_expression" ? constructors[name] : calls[name])?.handle;
            if (!handle) return void 0;
            let result = { kind: handle, origin: projected.initializer };
            for (const part of projected.path) {
              if (!result || typeof part !== "string") return void 0;
              result = memberIdentity(result, part);
            }
            if (!result?.method && projected.initializer.type === "new_expression" && constructorEscaped(projected.initializer.fields.constructor)) return void 0;
            return result;
          }
          if (binding.initializer) return identity(binding.initializer, depth + 1, seen);
          return void 0;
        }
        const member = access(node);
        if (member) {
          const base = identity(member.object, depth + 1, seen);
          if (!base) return void 0;
          let at = node, parent = view.parent(at);
          while (parent?.type === "member_expression" && parent.fields.object === at) {
            budget.step();
            at = parent;
            parent = view.parent(at);
          }
          const direct = parent?.type === "call_expression" && parent.fields.function === at;
          const root4 = project(member.object);
          if (!direct && root4?.contract?.startsWith("fst-components.") && !project(member.object, [member.name])) return void 0;
          return memberIdentity(base, member.name);
        }
        if (node.type === "new_expression") {
          const name = api(node.fields.constructor), handle = name && constructors[name]?.handle;
          return handle && !constructorEscaped(node.fields.constructor) && project(node)?.contract?.startsWith("fst-components.construct.") ? { kind: handle, origin: node } : void 0;
        }
        if (node.type === "call_expression" && !node.tokens.includes("?.")) {
          if (argsOf(node).some((arg) => arg.type === "spread_element")) return void 0;
          const invocation = invoke(node, depth + 1, seen);
          if (invocation?.contract.handle) return { kind: invocation.contract.handle, origin: node };
          if (invocation?.receiver?.kind === "scene" && invocation.name === "add" && argsOf(node)[0]) return identity(argsOf(node)[0], depth + 1, seen);
        }
        return void 0;
      };
      const invoke = (node, depth = 0, seen = /* @__PURE__ */ new Set()) => {
        budget.step();
        if (depth > 16 || node.tokens.includes("?.")) return void 0;
        const fn = node.fields.function ?? node.fields.constructor;
        if (!fn) return void 0;
        const name = api(fn), contract = name && (node.type === "new_expression" ? constructors[name] : calls[name]);
        if (name && contract) return { name, contract, target: fn };
        if (node.type !== "call_expression") return void 0;
        const handle = identity(fn, depth + 1, seen);
        if (!handle) return void 0;
        if (handle.method) {
          const contract2 = memberContract(handle.kind, handle.method);
          return contract2 ? { name: handle.method, contract: contract2, target: access(fn)?.object ?? fn, receiver: handle } : void 0;
        }
        const result = handle.kind === "loader" ? "Promise<results[]>;argument-length-list" : ["modal-close", "toast-handle", "disposer", "invalidate"].includes(handle.kind) ? "void;requested-operation-only" : void 0;
        return result ? { name: handle.kind === "invalidate" ? "invalidateRender" : handle.kind === "loader" ? "load-results" : handle.kind === "modal-close" ? "close" : handle.kind === "toast-handle" ? "dismiss" : "dispose", contract: { role: "handle", result }, target: fn, receiver: handle } : void 0;
      };
      const literal = (input, anchor, name) => {
        const node = view.unwrap(input);
        if (!["identifier", "string", "number", "true", "false", "null", "template_string", "binary_expression", "unary_expression"].includes(node.type)) return;
        budget.step(["string", "number", "true", "false", "null"].includes(node.type) ? 8 : 512);
        const result = view.constant(input);
        if (result.known && (result.value === null || ["string", "number", "boolean"].includes(typeof result.value))) property("fst-components.literal", `${name}=${String(result.value)}`, anchor, result.resolution);
      };
      const functionNode = (input) => {
        let node = view.unwrap(input);
        const seen = /* @__PURE__ */ new Set();
        while (!functions5.has(node.type) && seen.size < 16 && !seen.has(key(node))) {
          budget.step();
          seen.add(key(node));
          const binding = view.binding(node);
          if (!binding?.available || !binding.stable || binding.typeOnly) return void 0;
          const next = binding.initializer ?? (binding.kind === "function" && binding.declaration ? view.declarationNode(binding.declaration) : void 0);
          if (!next) return void 0;
          node = view.unwrap(next);
        }
        return functions5.has(node.type) ? node : void 0;
      };
      const callback2 = (input, contract, anchor, source, payload = {}) => {
        relation("fst-components.callback", view.reference(input), anchor);
        property("fst-components.callback-contract", contract, anchor);
        if (contract.slice(contract.indexOf("("), contract.indexOf("(") + 2) === "()") return;
        const fn = functionNode(input);
        if (!fn) return;
        const params = fn.fields.parameters ?? fn.fields.parameter;
        const first = params?.type === "formal_parameters" ? params.children.find((child) => child.type !== "comment") : params;
        if (!first) return;
        budget.step(16);
        const projections2 = view.patternProjections(first);
        if (!projections2.complete || projections2.projections.length > 16) {
          diagnose("fst-components.callback-pattern", "Only bounded static callback parameter patterns are represented.", first);
          return;
        }
        for (const item of projections2.projections) {
          budget.step();
          const name = view.name(item.node);
          if (!name) continue;
          role("fst-components.callback-payload", item.node);
          property("fst-components.callback-binding", name, item.node);
          property("fst-components.callback-path", ["0", ...item.path].join("."), item.node);
          property("fst-components.callback-contract", contract, item.node);
          relation("fst-components.argument-source", source, item.node);
          const kind = payload[item.path.join(".")];
          if (kind && view.unwrap(input) === fn) parameterKinds.set(key(item.node), { kind, origin: anchor });
        }
      };
      const objectProperties = (input) => {
        const result = /* @__PURE__ */ new Map();
        if (!input) return result;
        const projected = project(input);
        const node = projected && !projected.path.length ? view.unwrap(projected.initializer) : view.unwrap(input);
        if (node.type !== "object" || node.children.length > 64) return result;
        for (const child of node.children) {
          budget.step();
          if (child.type === "comment") continue;
          if (child.type === "pair" && child.fields.key && child.fields.value) {
            const name = view.name(child.fields.key);
            if (!name || child.fields.key.type === "computed_property_name") return /* @__PURE__ */ new Map();
            result.set(name, child.fields.value);
          } else if (child.type === "shorthand_property_identifier") {
            const name = view.name(child);
            if (name) result.set(name, child);
          } else return /* @__PURE__ */ new Map();
        }
        if (view.unwrap(input) !== node) {
          for (const name of result.keys()) if (!project(input, [name])) result.delete(name);
        }
        return result;
      };
      const optionCallbacks = (input, names, anchor, source) => {
        for (const [name, value4] of objectProperties(input)) {
          if (Object.hasOwn(names, name)) callback2(value4, `${name}:${names[name]}`, value4, source);
        }
      };
      const spreadProperties = (input, observation, seen = /* @__PURE__ */ new Set()) => {
        budget.step(512);
        if (seen.size >= 16 || !view.referenceStable(input, observation, "before-call")) return void 0;
        const projected = project(input);
        const object4 = projected && !projected.path.length ? view.unwrap(projected.initializer) : void 0;
        if (!object4 || object4.type !== "object" || seen.has(object4) || object4.children.length > 64) return void 0;
        const active = new Set(seen);
        active.add(object4);
        const result = /* @__PURE__ */ new Map();
        for (const child of object4.children) {
          budget.step();
          if (child.type === "comment") continue;
          if (child.type === "spread_element") {
            const value4 = child.children.find((item) => item.type !== "comment");
            const nested = value4 && spreadProperties(value4, observation, active);
            if (!nested) return void 0;
            for (const [name, value5] of nested) result.set(name, value5);
          } else if (child.type === "shorthand_property_identifier") result.set(view.text(child), child);
          else {
            const name = child.fields.key && child.fields.key.type !== "computed_property_name" && view.name(child.fields.key);
            if (child.type !== "pair" || !name || name === "__proto__" || !child.fields.value) return void 0;
            result.set(name, child.fields.value);
          }
          if (result.size > 64) return void 0;
        }
        return result;
      };
      for (const { node, name, tag } of jsx) {
        budget.step();
        const input = controls[name];
        if (!jsxNames.has(name)) continue;
        role(input ? "fst-components.control" : ["SvgIcon", "Icon"].includes(name) ? "fst-components.asset-request" : name.includes("Scene") || name === "Canvas3d" ? "fst-components.scene" : "fst-components.overlay", node);
        property("fst-components.api", name, node);
        relation("fst-components.import", view.resolve(tag), node);
        if (name === "MarkdownEditor") property("fst-components.qualification", "Zen-public-export;absent-from-inspected-Funtasia-barrel", node);
        if (name === "SelectOption") property("fst-components.requirement", "containing-Select", node);
        if (name === "Scene") property("fst-components.requirement", "Canvas3dState-required;SceneState-provided;setup-return-awaited-not-cleanup", node);
        if (name === "Canvas3d") property("fst-components.cleanup", "frames-observer-listeners-only;no-context-dispose-call", node);
        const attributes = /* @__PURE__ */ new Map();
        const seen = /* @__PURE__ */ new Set();
        const parent = view.parent(node), observation = node.type === "jsx_opening_element" && parent?.type === "jsx_element" ? parent : node;
        const sequenceSupported = !!input || name === "Popover";
        const hasSpreads = node.children.some((child) => child.type === "jsx_expression" && child.children.some((value4) => value4.type === "spread_element"));
        let ordinal = 0, group = 0, unresolvedSpread = false;
        const contribution = (attr, kind, value4) => {
          property("fst-components.jsx-contribution", `${ordinal++}:group=${group}:${kind}`, attr);
          relation("fst-components.jsx-contribution-source", { kind: "expression", text: view.text(value4), span: view.span(value4) }, attr);
          relation("fst-components.jsx-element", { kind: "expression", text: view.text(node), span: view.span(node) }, attr);
        };
        if (hasSpreads && sequenceSupported) {
          property("fst-components.props-contract", "authored groups and order, not compiler lowering proof; Solid lazy merge uses last-non-undefined property precedence, object-literal flattening uses own-property precedence; nested children supply the final children property; effective keys, values, getters and child normalization not evaluated", node);
          if (input) {
            property("fst-components.conditional-prop-contract", `field: if selected, borrowed Field with no disposal transfer; ${input[0]}: controlled input candidate; final field/value ownership mode unproven`, node);
            property("fst-components.conditional-prop-contract", `${input[1]}: if selected and notified, callback(${input[2]}); value-not-native-event; handler identity and delivery unproven`, node);
            if (name === "ColorEditor") property("fst-components.conditional-prop-contract", "onCommit: if selected and notified, callback(normalized-hex-string); notification-not-second-field-write; handler identity and delivery unproven", node);
            if (name === "MarkdownEditor") property("fst-components.conditional-prop-contract", "apiRef: if selected, callback(MarkdownEditorHandle|undefined); cleared-on-cleanup; handler identity and execution unproven", node);
          } else {
            property("fst-components.conditional-prop-contract", "open: controlled visibility input; anchor: native element or undefined; onOpenChange: if selected and notified, callback(boolean), dismissal requests false; final bindings and visibility unproven", node);
          }
        }
        for (const attr of node.children) {
          budget.step();
          if (attr.type === "jsx_expression") {
            const value5 = attr.children.find((child) => child.type === "spread_element")?.children.find((child) => child.type !== "comment");
            if (!value5) continue;
            group++;
            if (hasSpreads && sequenceSupported) contribution(attr, "spread", value5);
            group++;
            seen.clear();
            relation("fst-components.spread-source", view.reference(value5), attr);
            const fields = spreadProperties(value5, observation);
            if (!fields) {
              attributes.clear();
              seen.clear();
              unresolvedSpread = true;
              property("fst-components.qualification", "forwarded props have unknown keys; earlier props may be overridden", attr);
              if (!sequenceSupported) diagnose("fst-components.dynamic-props", "This API has no reviewed conditional prop-resolution contract for unknown forwarded keys.", attr);
              continue;
            }
            property("fst-components.qualification", "forwarded own properties; authored override order; values are not runtime constants", attr);
            for (const [prop2, value6] of fields) attributes.set(prop2, { attr, group: group - 1, value: value6, spread: true, fallback: unresolvedSpread || attributes.has(prop2) });
            continue;
          }
          if (attr.type !== "jsx_attribute" || !attr.children[0]) continue;
          const prop = view.name(attr.children[0]);
          if (!prop) continue;
          if (hasSpreads && sequenceSupported) contribution(attr, `attribute:${prop}`, attr);
          if (seen.has(prop)) {
            attributes.delete(prop);
            diagnose("fst-components.dynamic-props", "Duplicate JSX property overrides are not inferred.", attr);
            continue;
          }
          seen.add(prop);
          const raw = attr.children[1], value4 = raw?.type === "jsx_expression" ? raw.children.find((child) => child.type !== "comment") : raw;
          attributes.set(prop, { attr, group, raw, value: value4, fallback: unresolvedSpread || attributes.has(prop) && attributes.get(prop).group !== group });
        }
        if (hasSpreads && sequenceSupported && observation !== node) for (const child of observation.children) {
          budget.step();
          if (child !== node && !["jsx_closing_element", "comment"].includes(child.type) && (child.type !== "jsx_text" || view.text(child).trim())) contribution(child, "nested-child-source", child);
        }
        for (const [prop, { attr, raw, value: value4, spread, fallback }] of attributes) {
          budget.step();
          if (fallback && value4) {
            budget.step(512);
            const known = view.constant(value4), fn = functionNode(value4);
            if (!(known.known && known.value !== void 0) && !(fn && view.referenceStable(value4, observation, "before-call"))) continue;
          }
          if (spread && value4) {
            const pair2 = view.parent(value4);
            relation("fst-components.forwarded-prop", view.reference(pair2?.type === "pair" && pair2.fields.value === value4 ? pair2 : value4), attr);
          }
          if (!value4) {
            if (input && prop === "checked" || name === "Popover" && prop === "open") {
              property("fst-components.prop", prop, node);
              property("fst-components.literal", `${prop}=true`, node);
              relation(prop === "checked" ? "fst-components.checked" : "fst-components.input", view.reference(attr), node);
            }
            continue;
          }
          const literalSafe = spread || raw?.type !== "string" || !/[&\\\r\n]/.test(view.text(raw));
          if (input && (prop === "field" || prop === input[0])) {
            property("fst-components.prop", prop, node);
            relation(`fst-components.${prop}`, view.reference(value4), node);
            if (prop === "field") property("fst-components.ownership", "borrowed-field;user-write-contract;no-field-disposal", node);
            else if (literalSafe) literal(value4, node, prop);
          }
          if (input && prop === input[1]) callback2(value4, `${name}.${prop}(${input[2]});value-not-native-event`, node, view.resolve(tag));
          if (name === "ColorEditor" && prop === "onCommit") callback2(value4, "ColorEditor.onCommit(normalized-hex-string);notification-not-second-field-write", node, view.resolve(tag));
          if (name === "MarkdownEditor" && prop === "apiRef") {
            callback2(value4, "MarkdownEditor.apiRef(MarkdownEditorHandle|undefined);cleared-on-cleanup", node, view.resolve(tag));
            property("fst-components.ownership", "borrowed-editor-handle;no-destroy-ownership", node);
          }
          if (name === "Scene" && prop === "setup") callback2(value4, "Scene.setup({scene:IScene,invalidateRender:()=>void});awaited-not-cleanup", node, view.resolve(tag), { "": "setup-payload", scene: "scene", invalidateRender: "invalidate" });
          if (name === "SceneGraphCanvas" && ["onRuntimeReady", "onRuntimeDispose"].includes(prop)) callback2(value4, `${prop}(SceneGraphRuntime);component-managed`, node, view.resolve(tag), { "": "runtime" });
          if (name === "Popover" && prop === "onOpenChange") callback2(value4, "Popover.onOpenChange(boolean);dismissal-requests-false", node, view.resolve(tag));
          if (name === "ContextMenu" && prop === "onClose") callback2(value4, "ContextMenu.onClose();close-request-before-selection-action", node, view.resolve(tag));
          if (name === "ContextMenu" && prop === "items") {
            const items = view.unwrap(value4);
            if (items.type === "array" && items.children.length <= 32 && !items.children.some((item) => item.type === "spread_element")) for (const item of items.children) optionCallbacks(item, { onSelect: "()=>void;after-close-request" }, attr, view.resolve(tag));
          }
          const authored = ["SvgIcon", "Icon"].includes(name) && prop === "shape" || name === "Popover" && ["open", "anchor"].includes(prop) || name === "ContextMenu" && ["position", "items"].includes(prop) || name === "SceneGraphCanvas" && ["document", "assetBaseUrl"].includes(prop) || name === "SceneGraphHtmlSceneOverlayHost" && prop === "bridge" || ["ColorEditor", "MarkdownEditor"].includes(name) && prop === "resetKey";
          if (authored) {
            property("fst-components.prop", prop, node);
            relation(prop === "document" ? "fst-components.document" : "fst-components.input", view.reference(value4), node);
            if (literalSafe) literal(value4, node, prop);
          }
          if (name === "SceneGraphCanvas" && ["assetUrlResolver", "htmlComponentResolver"].includes(prop)) callback2(value4, prop === "assetUrlResolver" ? "(assetKey,purpose)=>string;not-executed" : "component-definition-resolver;not-executed", node, view.resolve(tag));
          if (name === "SceneGraphHtmlSceneOverlayHost" && prop === "componentResolver") callback2(value4, "component-definition-resolver;not-executed", node, view.resolve(tag));
        }
      }
      for (const node of callNodes) {
        budget.step();
        if (invoke(node)) continue;
        const fn = node.fields.function && view.unwrap(node.fields.function);
        const receiver = fn && ["member_expression", "subscript_expression"].includes(fn.type) ? fn.fields.object : void 0;
        if (receiver) taint(receiver);
        for (const arg of argsOf(node)) taint(arg);
      }
      for (const node of callNodes) {
        budget.step();
        const found = invoke(node);
        if (!found) continue;
        const { name, contract, target, receiver } = found, args = argsOf(node);
        if (args.some((arg) => arg.type === "spread_element")) {
          diagnose("fst-components.call-shape", "Spread call arguments are not assigned positional contracts.", node);
          continue;
        }
        role(`fst-components.${contract.role}`, node);
        property("fst-components.api", receiver ? `${receiver.kind}.${name}` : name, node);
        property("fst-components.operation", `${name}-request`, node);
        property("fst-components.result-contract", contract.result, node);
        relation(receiver ? "fst-components.target" : "fst-components.import", receiver ? view.reference(target) : view.resolve(target), node);
        if (contract.handle) {
          role("fst-components.handle", node);
          relation("fst-components.created-by", view.reference(target), node);
        }
        if (contract.cleanup) property("fst-components.cleanup", contract.cleanup, node);
        if (receiver?.method && node.fields.function && !access(node.fields.function)) property("fst-components.qualification", "captured-method-request;this-binding-and-success-unproven", node);
        if (["useModal", "useToasts"].includes(name)) property("fst-components.ownership", "owner-captured-at-call;not-host-binding", node);
        const source = receiver ? view.reference(target) : view.resolve(target);
        for (const [index, arg] of args.entries()) {
          if (index >= 8) {
            diagnose("fst-components.call-shape", "Only the first eight explicit argument references are retained.", node);
            break;
          }
          relation(index === 0 && (name.startsWith("setup") || name === "useCameraControls" || name === "attach") ? "fst-components.scene-target" : index === 0 && ["SceneGraphRuntime", "createSceneGraphRuntimeData", "setDocument"].includes(name) ? "fst-components.document" : "fst-components.input", view.reference(arg), arg);
          literal(arg, arg, `arg${index}`);
        }
        if (["tooltip", "focusring"].includes(name) && args[1]) callback2(args[1], name === "tooltip" ? "()=>JSX.Element|[bottom:boolean,JSX.Element];not-visibility" : "()=>number|true", args[1], source);
        if (name === "openModal" && args[0]) callback2(args[0], "content({close:ModalClose})", args[0], source, { "": "modal-payload", close: "modal-close" });
        if (name === "openModal") optionCallbacks(args[1], { onClose: "(ModalCloseReason)=>void" }, node, source);
        if (name === "openConfirmationModal") optionCallbacks(args[0], { onConfirm: "()=>void|boolean|Promise<void|boolean>;false-keeps-open", onCancel: "()=>void|Promise<void>" }, node, source);
        if (name === "showToast") optionCallbacks(args[0], { onClick: "()=>void", onClose: "()=>void" }, node, source);
        if (["configureIconAssetLoading", "loadIconDef", "resolveIconDef", "resolveIconAssetUrl"].includes(name)) optionCallbacks(args[name === "configureIconAssetLoading" ? 0 : 1], { resolver: "(IconAssetShape)=>string|URL|null|undefined", fetch: "fetch-contract;not-executed" }, node, source);
        if (name === "loadGLTF" && !receiver && args[3]) callback2(args[3], "(GLTFLoader)=>void", args[3], source);
        if (name === "loaderFn") {
          if (args[0]) callback2(args[0], "(Loader)=>void", args[0], source);
          if (args[1]) callback2(args[1], "(ProgressEvent)=>void", args[1], source);
        }
        if (receiver?.kind === "scene" && name === "add") optionCallbacks(args[1], { onAdded: "({scene,node})=>void" }, node, source);
        if (receiver?.kind === "scene" && name === "addRenderListener") optionCallbacks(args[0], { onBeforeRenderScene: "({delta:number})=>void", onAfterRenderScene: "({delta:number})=>void" }, node, source);
        if (name === "SceneGraphRuntime") optionCallbacks(args[1], { assetUrlResolver: "(assetKey,purpose)=>string", onRenderInvalidated: "()=>void", onNodeLoaded: "(nodeId:string)=>void" }, node, source);
        if (receiver?.kind === "bridge" && name === "registerHtmlScene") optionCallbacks(args[1], { onTextureCanvas: "(HTMLCanvasElement)=>void", onCaptureSizeChanged: "(width:number,height:number)=>void" }, node, source);
        if (name === "addCameraControlEndListener" && args[0]) callback2(args[0], "()=>void;pending-registration-disposal-not-guaranteed", args[0], source);
        if (receiver?.kind === "animation") {
          const options = args[["poseLayered", "playAnimationLayered"].includes(name) ? 1 : name === "tweenLayerWeight" ? 3 : -1];
          optionCallbacks(options, { trackMask: "(trackName:string)=>boolean", onUpdate: "({startWeight,weight,pct})=>void", onComplete: "()=>void" }, node, source);
          const layer = objectProperties(options).get("layerKey");
          if (layer) literal(layer, node, "layerKey");
        }
      }
      return { state: partial ? "partial" : matched ? "complete" : "not-applicable", diagnostics };
    }
  };
}

// src/frameworks/solid/contracts.ts
var value3 = Object.freeze({ kind: "value" });
var pair = Object.freeze({ kind: "tuple", items: Object.freeze([value3, value3]) });
var object3 = (properties4) => ({ kind: "object", properties: properties4 });
var record = { kind: "record", value: value3 };
var root3 = ["solid-js", "@fst/components-fst-solid/solid-js"];
var store = ["solid-js/store", "@fst/components-fst-solid/solid-js/store"];
var web = ["solid-js/web"];
var wrappedWeb = [...web, "@fst/components-fst-solid/solid-js/web"];
var router = ["@solidjs/router"];
var accumulator = "return is next accumulator, not cleanup";
var callback = (index, role, parameters = [], reads2, returns) => ({ index, role, parameters, ...reads2 ? { reads: reads2 } : {}, ...returns ? { returns } : {} });
var accessor = { "": "solid.accessor" };
var rule2 = (name, modules, rest = {}) => ({ name, modules, ...rest });
var freeze = (input) => {
  if (input && typeof input === "object" && !Object.isFrozen(input)) {
    for (const item of Object.values(input)) freeze(item);
    Object.freeze(input);
  }
  return input;
};
var solidApiRules = freeze([
  rule2("createSignal", root3, { result: pair, slots: { "": "solid.signal-pair", "0": "solid.signal-accessor", "1": "solid.signal-setter" } }),
  rule2("createStore", store, { result: pair, slots: { "": "solid.store-pair", "0": "solid.store", "1": "solid.store-updater" } }),
  rule2("splitProps", root3, { result: { kind: "key-partitions", sourceArgument: 0, keysFromArgument: 1 } }),
  rule2("createMemo", root3, { result: value3, slots: accessor, callbacks: [callback(0, "memo derivation", ["previous result"], "tracked", accumulator)] }),
  rule2("createSelector", root3, { result: value3, slots: { "": "solid.selector" }, callbacks: [callback(0, "selector source", [], "tracked"), callback(1, "selector equality", ["key", "source value"])] }),
  rule2("createDeferred", root3, { result: value3, slots: accessor, sources: [0], boundary: "deferred accessor; no inferred scheduler order" }),
  rule2("createReaction", root3, { result: value3, slots: { "": "solid.reaction" }, callbacks: [callback(0, "reaction invalidation", [], "untracked")] }),
  ...["createEffect", "createComputed", "createRenderEffect"].map((name) => rule2(name, root3, { callbacks: [callback(0, `${name} callback`, ["previous accumulator"], "tracked", accumulator)] })),
  rule2("on", root3, { result: value3, slots: { "": "solid.on-callback" }, boundary: "explicit dependency accessors; callback receives values and is untracked" }),
  rule2("untrack", root3, { callbacks: [callback(0, "untracked synchronous body", [], "untracked")], boundary: "tracking suppressed; ownership not removed" }),
  rule2("batch", root3, { callbacks: [callback(0, "synchronous batch body", [], "batch")], boundary: "batch scope stops at suspension; no inferred flush order" }),
  rule2("createRoot", root3, { callbacks: [callback(0, "root body", ["root disposer"])], sources: [1], boundary: "declared root; returned value is callback result, not necessarily disposer" }),
  rule2("getOwner", root3, { result: value3, slots: { "": "solid.owner" }, boundary: "captured owner may be null" }),
  rule2("runWithOwner", root3, { callbacks: [callback(1, "borrowed-owner synchronous body")], sources: [0], boundary: "restores owner, not tracking; does not transfer disposal" }),
  rule2("onCleanup", root3, { result: value3, slots: { "": "solid.cleanup-callback" }, callbacks: [callback(0, "current-owner cleanup")], boundary: "same callback returned; manual call does not unregister owner cleanup; owner-bound cleanup request, not wrapper lifetime or observed disposal" }),
  rule2("onMount", root3, { callbacks: [callback(0, "mount effect body", [], "untracked", "callback return is not cleanup registration")], boundary: "client effect invokes callback untracked after initial render; server onMount is a no-op; mount, owner and scheduling not observed" }),
  rule2("createContext", root3, {
    result: object3({ Provider: value3, defaultValue: value3, id: value3 }),
    slots: { "": "solid.context" },
    sources: [0],
    identityObservations: { factoryArities: [0, 1, 2], uses: [
      { kind: "call-argument", origins: root3.map((module) => ({ module, name: "useContext" })), index: 0, arity: 1 },
      { kind: "jsx-member", member: "Provider" }
    ] }
  }),
  rule2("useContext", root3, { sources: [0], boundary: "context lookup request; no closest-provider inference" }),
  rule2("createResource", root3, { result: { kind: "tuple", items: [object3({ state: value3, loading: value3, error: value3, latest: value3 }), object3({ mutate: value3, refetch: value3 })] }, slots: { "0": "solid.resource", "1": "solid.resource-actions", "1.mutate": "solid.resource-mutator", "1.refetch": "solid.resource-refetch" } }),
  rule2("useTransition", root3, { result: pair, slots: { "0": "solid.transition-pending", "1": "solid.transition-start" } }),
  rule2("startTransition", root3, { callbacks: [callback(0, "transition work")], boundary: "requested transition; no completion or scheduler inference" }),
  rule2("produce", store, { result: value3, slots: { "": "solid.store-modifier" }, callbacks: [callback(0, "store draft mutation", ["mutable draft"])] }),
  rule2("reconcile", store, { result: value3, slots: { "": "solid.store-modifier" }, sources: [0] }),
  rule2("createMutable", store, { result: record, slots: { "": "solid.mutable-store" }, sources: [0] }),
  rule2("modifyMutable", store, { sources: [0, 1], boundary: "explicit mutable store modifier application" }),
  rule2("unwrap", store, { result: value3, slots: { "": "solid.raw-store" }, sources: [0], boundary: "raw store alias; not an immutable deep copy" }),
  rule2("mergeProps", [...root3, ...web], { result: record, slots: { "": "solid.merged-props" }, boundary: "shallow lazy sources; last non-undefined property wins; no eager folding" }),
  rule2("children", root3, {
    result: object3({ toArray: value3 }),
    slots: { "": "solid.children" },
    callbacks: [callback(0, "resolved children source", [], "tracked")],
    identityObservations: { factoryArities: [1], uses: [{ kind: "receiver-call", member: "toArray", arity: 0 }] }
  }),
  rule2("lazy", root3, { result: object3({ preload: value3 }), slots: { "": "solid.lazy-component" }, callbacks: [callback(0, "lazy module loader")], boundary: "lazy module request; no inferred loading/completion" }),
  rule2("mapArray", root3, { result: value3, slots: accessor, sources: [0], callbacks: [{ ...callback(1, "item mapping", ["item value", "index accessor"]), arity: "index-accessor" }] }),
  rule2("indexArray", root3, { result: value3, slots: accessor, sources: [0], callbacks: [callback(1, "index mapping", ["item accessor", "index value"])] }),
  rule2("catchError", root3, { callbacks: [callback(0, "protected synchronous body"), callback(1, "error handler", ["error"])], boundary: "error boundary request; not arbitrary async catch" }),
  rule2("from", root3, { result: value3, slots: accessor, sources: [0], callbacks: [callback(0, "external producer", ["signal setter"], void 0, "producer returns cleanup callback")] }),
  rule2("observable", root3, { result: object3({ subscribe: value3 }), slots: { "": "solid.observable" }, sources: [0] }),
  ...["For", "Index", "Show", "Match", "Switch", "ErrorBoundary", "Suspense", "SuspenseList"].map((name) => rule2(name, [...root3, ...web], { jsx: true })),
  rule2("Dynamic", wrappedWeb, { jsx: true }),
  rule2("Portal", wrappedWeb, { jsx: true }),
  rule2("createDynamic", web, { sources: [0, 1], callbacks: [callback(0, "dynamic component accessor")] }),
  ...["render", "hydrate"].map((name) => rule2(name, name === "render" ? wrappedWeb : web, { result: value3, slots: { "": "solid.disposer" }, sources: [1], callbacks: [callback(0, "render body")], boundary: `${name} mount request; returned disposer is explicit` })),
  ...["renderToString", "renderToStringAsync", "renderToStream"].map((name) => rule2(name, name === "renderToString" ? wrappedWeb : web, { callbacks: [callback(0, "server render body")], boundary: `${name} request; server and client execution differ` })),
  rule2("getRequestEvent", web, { result: object3({ request: value3, locals: record }), slots: { "": "solid.request-event" }, boundary: "request event may be absent outside server request" }),
  ...["NoHydration", "Hydration", "HydrationScript"].map((name) => rule2(name, web, { jsx: true })),
  ...["query", "cache"].map((name) => rule2(name, router, { result: object3({ key: value3, keyFor: value3 }), slots: { "": "solid.query" }, callbacks: [callback(0, "router query fetcher")], sources: [1] })),
  rule2("revalidate", router, { sources: [0], boundary: "revalidation request, not cache-hit/invalidation proof" }),
  ...["get", "set", "delete", "clear"].map((name) => rule2(`query.${name}`, router, { sources: name === "clear" ? [] : name === "set" ? [0, 1] : [0], boundary: "explicit query cache operation; no cache-state inference" })),
  rule2("action", router, { result: object3({ url: value3, with: value3 }), slots: { "": "solid.action" }, callbacks: [callback(0, "router action body")], sources: [1] }),
  rule2("useAction", router, { result: value3, slots: { "": "solid.action" }, sources: [0] }),
  ...["useSubmission", "useSubmissions"].map((name) => rule2(name, router, { sources: [0], callbacks: [callback(1, "submission filter", ["action input"])] })),
  ...["createAsync", "createAsyncStore"].map((name) => rule2(name, router, { result: object3({ latest: value3 }), slots: accessor, callbacks: [callback(0, "router async source")], boundary: "returns accessor with latest; not a plain store object" })),
  ...["redirect", "reload", "json"].map((name) => rule2(name, router, { sources: [0], boundary: "router response helper; no route convention inference" }))
]);
var contractId = (name) => `solid.${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
var identities = new Map(solidApiRules.flatMap((entry) => entry.modules.map((module) => [JSON.stringify([module, entry.name]), entry])));
var solidRule = (module, name) => identities.get(JSON.stringify([module, name]));
var solidReturnContracts = freeze(solidApiRules.filter((entry) => entry.result).map((entry) => ({ id: contractId(entry.name), origins: entry.modules.map((module) => ({ module, name: entry.name })), result: entry.result, ...entry.identityObservations ? { identityObservations: entry.identityObservations } : {} })));

// src/frameworks/solid/vocabulary.ts
var roles3 = {
  "signal-accessor": "Solid Signal Accessor",
  "signal-setter": "Solid Signal Setter",
  "signal-pair": "Authored Signal Pair",
  "store-pair": "Authored Store Pair",
  store: "Solid Store",
  "store-updater": "Solid Store Updater",
  "props-partition": "Solid Props Partition",
  "props-remainder": "Solid Remaining Props",
  prop: "Solid Projected Prop",
  accessor: "Derived or Bridged Accessor",
  selector: "Key Selector",
  reaction: "Reaction Tracker",
  "on-callback": "Explicit Dependency Callback",
  owner: "Captured Possibly-Null Owner",
  context: "Context Identity",
  "cleanup-callback": "Returned Cleanup Callback",
  resource: "Resource Accessor",
  "resource-actions": "Resource Actions",
  "resource-mutator": "Resource Mutator",
  "resource-refetch": "Resource Refetch",
  "transition-pending": "Transition Pending Accessor",
  "transition-start": "Transition Starter",
  "store-modifier": "Store Modifier",
  "mutable-store": "Mutable Store",
  "raw-store": "Unwrapped Store Alias",
  "merged-props": "Lazy Shallow Merged Props",
  children: "Resolved Children Accessor",
  "lazy-component": "Lazy Component",
  observable: "Observable Bridge",
  disposer: "Explicit Disposer",
  "request-event": "Optional Server Request Event",
  query: "Router Query Handle",
  action: "Router Action Handle"
};
var properties3 = {
  "partition-index": ["Props Tuple Slot", false],
  "included-key": ["Included Prop Key", true],
  "excluded-key": ["Excluded Prop Key", true],
  "prop-key": ["Projected Prop Key", false],
  boundary: ["Declared Boundary", true],
  "callback-role": ["Callback Contract", true],
  "parameter-role": ["Callback Parameter Contract", true],
  "return-contract": ["Declared Return Semantics", true],
  option: ["Authored Static Option", true],
  "jsx-mode": ["Authored JSX Binding Mode", true],
  "callback-dispatch": ["Conditional Render Child Dispatch", true],
  "callback-argument-contract": ["Conditional Render Child Argument", true],
  "jsx-contribution": ["Ordered JSX Prop Contribution", true],
  "jsx-props-contract": ["JSX Props Resolution Contract", true],
  "dynamic-dispatch": ["Conditional Dynamic Component Dispatch", true]
};
var relations3 = {
  factory: "Declared Solid Factory Import",
  "created-by": "Factory Call",
  "setter-for": "Sets Signal Accessor",
  "updater-for": "Updates Store",
  "alias-of": "Stable Binding Alias",
  "props-source": "Partitioned Props Expression",
  "signal-read": "Signal Accessor Call",
  "signal-write": "Signal Setter Call",
  "store-read": "Store Property Read",
  "store-update": "Store Updater Call",
  "api-call": "Qualified API Call",
  "accessor-read": "Accessor Call",
  "handle-call": "Direct Handle Call",
  callback: "Declared Callback",
  source: "Explicit Source Expression",
  "parameter-source": "Callback Value Source",
  "potential-read": "Direct Potential Tracked Read",
  "untracked-read": "Direct Accessor Call in Untracked Body",
  "batch-write": "Direct Setter or Updater Call in Batch Body",
  "resource-for": "Resource Action For Accessor",
  "transition-for": "Starts Pending Transition",
  "resource-status": "Resource Status Property Read",
  "owner-source": "Explicit Owner Argument",
  "context-source": "Explicit Context Identity",
  "merge-source": "Ordered Lazy Props Source",
  "returned-callback": "Returns Same Callback",
  "store-target": "Explicit Store Operation Target",
  "modifier-source": "Explicit Store Modifier",
  "event-handler": "Native Event Handler",
  "event-data": "Native Bound Event Data",
  "jsx-binding": "Native JSX Binding Expression",
  "jsx-overridden": "Possibly Overridden JSX Attribute",
  "render-child": "Conditional Child Source Expression",
  "conditional-callback": "Conditional Render Child Candidate",
  "jsx-contribution-source": "Authored JSX Contribution Source",
  "jsx-element": "Containing JSX Element Occurrence",
  "dynamic-component": "Dynamic Component Expression",
  "provider-context": "Context Provider Identity",
  "module-source": "Literal Lazy Module Request",
  "key-source": "Authored Router Key",
  "action-source": "Associated Router Action"
};
function descriptor2(digests) {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error("Solid plugin requires build-supplied content digests");
  return {
    id: "solid",
    version: "1",
    ...digests,
    languages: ["typescript", "tsx"],
    view: { id: "typescript", version: 1 },
    roles: Object.entries(roles3).map(([name, label]) => ({ id: `solid.${name}`, label })),
    properties: Object.entries(properties3).map(([name, [label, multiple]]) => ({ id: `solid.${name}`, label, multiple, valueKind: "string" })),
    relations: Object.entries(relations3).map(([name, label]) => ({ id: `solid.${name}`, label }))
  };
}

// src/frameworks/solid/semantics.ts
var functions6 = /* @__PURE__ */ new Set(["arrow_function", "function_expression", "function_declaration", "generator_function", "generator_function_declaration", "method_definition"]);
var reads = /* @__PURE__ */ new Set(["solid.signal-accessor", "solid.accessor", "solid.resource", "solid.children", "solid.transition-pending", "solid.selector"]);
var writes = /* @__PURE__ */ new Set(["solid.signal-setter", "solid.store-updater", "solid.resource-mutator"]);
var methods = {
  "solid.resource-actions": ["mutate", "refetch"],
  "solid.observable": ["subscribe"],
  "solid.lazy-component": ["preload"],
  "solid.children": ["toArray"],
  "solid.query": ["keyFor"],
  "solid.action": ["with"]
};
var bindingOnly = /* @__PURE__ */ new Set(["createSignal", "createStore", "splitProps"]);
var contextModules = /* @__PURE__ */ new Set(["solid-js", "@fst/components-fst-solid/solid-js"]);
function solidJSXContext(view, budget) {
  for (const node of view.nodes) {
    budget.step();
    if (node.type === "comment" && /@jsxImportSource\s+(?:solid-js|@fst\/components-fst-solid\/solid-js)(?:\s|\*\/|$)/.test(view.text(node))) return true;
  }
  return false;
}
function analyzeSemantics(ctx, jsxContext) {
  const { view, budget, relation, property, diagnose, handle } = ctx;
  const nativeContext = (input) => {
    if (jsxContext) return true;
    let node = input;
    for (let depth = 0; node && depth < 64; depth++, node = view.parent(node)) {
      budget.step();
      if (node.type === "call_expression" && node.fields.function) {
        const origin = view.resolve(node.fields.function);
        if (origin.kind === "import" && !origin.member && origin.module === "@fst/components-fst-solid/app/component" && ["component", "componentWithChildren"].includes(origin.name)) {
          const renderer = node.fields.arguments?.children.find((item) => item.type !== "comment");
          if (renderer && functions6.has(view.unwrap(renderer).type) && input.startIndex >= renderer.startIndex && input.endIndex <= renderer.endIndex) return true;
        }
      }
      const annotation = node.fields.type ?? node.fields.return_type;
      if (annotation) {
        const stack = [annotation];
        for (let count = 0; stack.length && count < 64; count++) {
          budget.step();
          const type = stack.pop(), origin = view.resolve(type, "type");
          if (origin.kind === "import" && contextModules.has(origin.module) && ["Component", "ParentComponent", "FlowComponent", "VoidComponent", "JSX"].includes(origin.name)) return true;
          stack.push(...type.children);
        }
      }
    }
    return false;
  };
  const argsOf = (node) => node.fields.arguments?.children.filter((item) => item.type !== "comment") ?? [];
  const source = (owner, node, anchor, term = "solid.source") => {
    if (owner && node) relation(owner, term, view.reference(node), anchor, "explicit-source");
  };
  const fnOf = (input) => {
    let node = view.unwrap(input);
    const seen = /* @__PURE__ */ new Set();
    while (!functions6.has(node.type) && seen.size < 24 && !seen.has(node)) {
      budget.step();
      seen.add(node);
      const binding = view.binding(node);
      if (!binding?.available || !binding.stable || binding.typeOnly) return void 0;
      const next = binding.initializer ?? (binding.kind === "function" && binding.declaration ? view.declarationNode(binding.declaration) : void 0);
      if (!next) return void 0;
      node = view.unwrap(next);
    }
    return functions6.has(node.type) ? node : void 0;
  };
  const parametersOf = (fn) => {
    const parameters = fn.fields.parameters ?? fn.fields.parameter;
    const list = parameters?.type === "formal_parameters" ? parameters.children : parameters ? [parameters] : [];
    return list.filter((item) => item.type !== "comment" && (item.fields.pattern ?? item.fields.name ?? item).type !== "this");
  };
  const callbackObservation = (anchor) => {
    const parent = view.parent(anchor);
    return anchor.type === "jsx_opening_element" && parent?.type === "jsx_element" ? parent : anchor;
  };
  const array2 = (input) => {
    const node = view.unwrap(input), items = node.children.filter((item) => item.type !== "comment");
    if (node.type !== "array" || items.length > 16) return void 0;
    const punctuation = (a, b) => view.source.slice(a, b).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "").trim();
    if (items.some((item, i) => item.type === "spread_element" || punctuation(i ? items[i - 1].endIndex : node.startIndex + 1, item.startIndex) !== (i ? "," : ""))) return void 0;
    return ["", ","].includes(punctuation(items.at(-1)?.endIndex ?? node.startIndex + 1, node.endIndex - 1)) ? items : void 0;
  };
  const fields = (input) => {
    if (!input) return void 0;
    let node = view.unwrap(input);
    if (node.type !== "object") {
      budget.step(512);
      const current = view.constant(node);
      if (!current.known || typeof current.value !== "object" || current.value === null) return void 0;
      budget.step(512);
      const p = view.project(node);
      if (!p || p.path.length) return void 0;
      node = p.initializer;
    }
    if (node.type !== "object" || node.children.length > 32) return void 0;
    const result = /* @__PURE__ */ new Map();
    for (const child of node.children) {
      budget.step();
      if (child.type === "comment") continue;
      if (child.type === "shorthand_property_identifier") {
        result.set(view.text(child), child);
        continue;
      }
      const key3 = child.fields.key && view.name(child.fields.key);
      if (child.type !== "pair" || !key3 || !child.fields.value) return void 0;
      result.set(key3, child.fields.value);
    }
    return result;
  };
  const direct = (fn, mode) => {
    if (fn.type.includes("generator") || fn.tokens.includes("*")) return;
    const body = fn.fields.body;
    if (!body) return;
    const stack = [body];
    while (stack.length) {
      budget.step();
      const node = stack.pop();
      if (node.type === "await_expression" || node.type === "yield_expression") break;
      if (functions6.has(node.type) || node.type === "class" || node.type === "class_declaration") continue;
      if (node.type === "call_expression" && node.fields.function && !node.tokens.includes("?.")) {
        const pending = [...node.children];
        let suspends = false;
        while (pending.length) {
          budget.step();
          const child = pending.pop();
          if (functions6.has(child.type)) continue;
          if (["await_expression", "yield_expression"].includes(child.type)) {
            suspends = true;
            break;
          }
          pending.push(...child.children);
        }
        const target = view.unwrap(node.fields.function), value4 = handle(target), owner = view.owner(node);
        const term = value4 && (reads.has(value4.role) && mode !== "batch" ? mode === "tracked" ? "solid.potential-read" : "solid.untracked-read" : writes.has(value4.role) && mode === "batch" ? "solid.batch-write" : void 0);
        if (!suspends && term && owner) relation(owner, term, view.reference(target), node, "direct-callback-call");
      }
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  };
  const callback2 = (input, anchor, spec, dependencies) => {
    if (!input) return void 0;
    const value4 = view.unwrap(input);
    if (["object", "array", "regex", "template_string"].includes(value4.type) || value4.type === "unary_expression" && value4.tokens.includes("void")) return void 0;
    budget.step(512);
    if (view.constant(input).known) return void 0;
    const fn = fnOf(input);
    let labels = spec.parameters;
    if (spec.arity) {
      let arity;
      budget.step(512);
      if (fn && view.referenceStable(input, callbackObservation(anchor), "before-call")) {
        const list2 = parametersOf(fn);
        if (list2.length <= 16) {
          arity = 0;
          for (const parameter of list2) {
            const pattern = parameter.fields.pattern ?? parameter.fields.name ?? parameter;
            if (parameter.fields.value || ["assignment_pattern", "rest_pattern"].includes(pattern.type)) break;
            arity++;
          }
        }
      }
      if (arity === void 0 && spec.arity === "positive" && ["Show render child", "Match render child"].includes(spec.role)) {
        const owner2 = view.owner(anchor);
        if (owner2) {
          relation(owner2, "solid.conditional-callback", { kind: "expression", text: view.text(input), span: view.span(input) }, anchor, "conditional-child-dispatch");
          property(owner2, "solid.callback-dispatch", `${spec.role}: when selected, typeof child === function && child.length > 0 invokes child untracked; otherwise renders child value; when not selected, ${spec.role.startsWith("Show") ? "uses fallback" : "Switch selects another Match or fallback"}; callable identity, length and branch unproven`, anchor);
          property(owner2, "solid.callback-argument-contract", `conditional argument[0]: ${labels?.[0] ?? "condition value when keyed, guarded condition accessor otherwise"}; accessors are guarded by the active branch; not a parameter binding`, anchor);
        }
        return void 0;
      }
      if (arity === void 0) diagnose("solid.callback-shape", "Arity-dependent callback dispatch requires a stable local function object.", anchor);
      if (spec.arity === "positive" && !arity) return void 0;
      if (spec.arity === "index-accessor" && (arity === void 0 || arity <= 1)) labels = labels?.slice(0, 1);
    }
    source(view.owner(anchor), input, anchor, "solid.callback");
    if (!fn) return void 0;
    const owner = view.owner(fn);
    if (owner) {
      property(owner, "solid.callback-role", spec.role, fn);
      if (spec.returns) property(owner, "solid.return-contract", spec.returns, fn);
    }
    const list = parametersOf(fn);
    for (let index = 0; index < Math.min(list.length, labels?.length ?? 0, 8); index++) {
      budget.step(512);
      const parameter = list[index], pattern = parameter.type === "optional_parameter" && !parameter.fields.value ? parameter.fields.pattern ?? parameter.fields.name ?? parameter : parameter;
      const projected = view.patternProjections(pattern);
      if (!projected.complete || projected.projections.length > 32) {
        diagnose("solid.callback-shape", "Callback bindings require bounded static patterns without defaults or rest.", parameter);
        continue;
      }
      for (const entry of projected.projections) {
        const subject = view.owner(entry.node) ?? owner;
        if (!subject) continue;
        if (entry.path.length && labels[index].includes("accessor")) {
          diagnose("solid.callback-shape", "Destructured function properties are not whole accessor parameters.", entry.node);
          continue;
        }
        const path = entry.path.length ? `.${entry.path.join(".")}` : "";
        property(subject, "solid.parameter-role", `${view.text(entry.node)}: ${labels[index]}${path}`, entry.node);
        if (dependencies && index < 2) {
          const dependency = entry.path.length === 1 && typeof entry.path[0] === "number" ? dependencies[entry.path[0]] : !entry.path.length && dependencies.length === 1 ? dependencies[0] : void 0;
          source(subject, dependency, entry.node, "solid.parameter-source");
        }
      }
    }
    if (spec.reads) direct(fn, spec.reads);
    return fn;
  };
  const options = (input, anchor, names) => {
    const map = fields(input), owner = view.owner(anchor);
    if (!map) return;
    for (const name of names) {
      const value4 = map.get(name);
      if (!value4 || !owner) continue;
      source(owner, value4, anchor);
      budget.step(512);
      const literal = view.constant(value4);
      if (literal.known && (typeof literal.value === "string" || typeof literal.value === "boolean" || typeof literal.value === "number")) property(owner, "solid.option", `${name}=${String(literal.value)}`, anchor);
    }
  };
  for (const { node, rule: rule3 } of ctx.calls) {
    budget.step();
    const args = argsOf(node), owner = view.owner(node), name = rule3.name;
    if (args.length > 32 || args.some((item) => item.type === "spread_element")) {
      diagnose("solid.call-shape", "API arguments require bounded explicit positions without spreads.", node);
      continue;
    }
    if (!bindingOnly.has(name) && owner) {
      relation(owner, "solid.api-call", view.resolve(node.fields.function), node, "qualified-api");
      if (rule3.boundary) property(owner, "solid.boundary", rule3.boundary, node);
    }
    for (const spec of rule3.callbacks ?? []) if (name !== "from") callback2(args[spec.index], node, spec);
    for (const index of rule3.sources ?? []) source(
      owner,
      args[index],
      node,
      name === "runWithOwner" || name === "createRoot" ? "solid.owner-source" : name === "useContext" ? "solid.context-source" : ["query", "cache", "revalidate", "query.get", "query.delete"].includes(name) || name === "query.set" && index === 0 ? "solid.key-source" : ["useAction", "useSubmission", "useSubmissions"].includes(name) ? "solid.action-source" : "solid.source"
    );
    if (name === "on") {
      const deps = args[0] && (view.unwrap(args[0]).type === "array" ? array2(args[0]) : [args[0]]);
      if (!deps) diagnose("solid.callback-shape", "Explicit dependency arrays require bounded static slots without holes or spreads.", node);
      else for (const dep of deps) source(owner, dep, node);
      callback2(args[1], node, { index: 1, role: "on value callback (untracked)", parameters: ["current dependency values", "previous dependency values or undefined", "previous returned accumulator"], reads: "untracked", returns: "next accumulator, not cleanup" }, deps);
      options(args[2], node, ["defer"]);
    }
    if (name === "createResource") {
      const knownOptions = args[1] && fields(args[1]);
      const hasSource = args.length >= 3 || args.length === 2 && !!fnOf(args[1]);
      if (args.length === 2 && !knownOptions && !hasSource) {
        diagnose("solid.call-shape", "Two-argument resource overload requires a proven fetcher function or options object.", node);
        continue;
      }
      const fetcher = args[hasSource ? 1 : 0], settings = args[hasSource ? 2 : 1];
      if (hasSource) source(owner, args[0], node);
      callback2(fetcher, node, { index: 0, role: "resource fetcher", parameters: [hasSource ? "source value" : "true source value", "fetcher info (value and refetching)"] });
      const map = fields(settings);
      callback2(map?.get("storage"), node, { index: 0, role: "resource storage factory", parameters: ["initial stored value"], returns: "accessor/setter pair" });
      options(settings, node, ["initialValue", "deferStream", "ssrLoadFrom"]);
    }
    if (name === "mergeProps") for (const [index, arg] of args.entries()) {
      source(owner, arg, arg, "solid.merge-source");
      if (owner) property(owner, "solid.option", `merge source ${index}`, arg);
    }
    if (name === "modifyMutable") {
      source(owner, args[0], node, "solid.store-target");
      source(owner, args[1], node, "solid.modifier-source");
    }
    if (name === "createDynamic") source(owner, args[0], node, "solid.dynamic-component");
    if (name === "from") {
      budget.step(512);
      if (!args[0] || !view.referenceStable(args[0], node, "before-call")) diagnose("solid.call-shape", "Producer subscription dispatch requires a stable reference after argument evaluation.", node);
      else {
        const producer = fields(args[0]);
        if (producer?.has("subscribe")) callback2(producer.get("subscribe"), node, { index: 0, role: "external subscription producer", parameters: ["next value callback"], returns: "cleanup callback or unsubscribe object" });
        else if (fnOf(args[0]) && rule3.callbacks?.[0]) callback2(args[0], node, rule3.callbacks[0]);
      }
    }
    if (name === "lazy" && args[0]) {
      const fn = fnOf(args[0]), body = fn?.fields.body;
      if (body) {
        const value4 = body.type === "statement_block" ? body.children.find((item) => item.type === "return_statement")?.children[0] : body;
        if (value4?.type === "call_expression" && value4.fields.function?.type === "import") {
          const module = argsOf(value4)[0];
          if (module?.type === "string") source(owner, module, node, "solid.module-source");
        }
      }
    }
    if (["createMemo", "createDeferred", "reconcile"].includes(name)) {
      const settings = args[name === "createMemo" ? 2 : 1], map = fields(settings);
      if (name !== "reconcile") callback2(map?.get("equals"), node, { index: 0, role: "equality comparator", parameters: ["previous value", "next value"] });
      options(settings, node, name === "reconcile" ? ["key", "merge"] : name === "createDeferred" ? ["equals", "timeoutMs"] : ["equals"]);
    }
    if (name === "renderToStream") {
      const map = fields(args[1]);
      for (const key3 of ["onCompleteShell", "onCompleteAll"]) callback2(map?.get(key3), node, { index: 0, role: `server ${key3}`, parameters: ["stream info (write)"] });
    }
  }
  for (const node of view.nodes) {
    budget.step();
    if (node.type === "call_expression" && node.fields.function && !node.tokens.includes("?.")) {
      const fn = view.unwrap(node.fields.function), bound = handle(fn), args = argsOf(node), owner2 = view.owner(node);
      if (bound?.role === "solid.reaction") callback2(args[0], node, { index: 0, role: "reaction tracked body", reads: "tracked" });
      if (bound?.role === "solid.transition-start") callback2(args[0], node, { index: 0, role: "transition work" });
      if (bound?.role === "solid.store-updater" && args.length) {
        const last = args.at(-1), modifier = handle(last), expression = view.unwrap(last);
        const origin2 = expression.type === "call_expression" && expression.fields.function ? view.resolve(expression.fields.function) : void 0;
        const api = origin2?.kind === "import" && !origin2.member ? solidRule(origin2.module, origin2.name) : void 0;
        source(owner2, last, node, modifier?.role === "solid.store-modifier" || api && ["produce", "reconcile"].includes(api.name) ? "solid.modifier-source" : "solid.source");
        for (let index = 0; owner2 && index < Math.min(args.length - 1, 16); index++) {
          source(owner2, args[index], node);
          budget.step(512);
          const key3 = view.constant(args[index]);
          if (key3.known && (typeof key3.value === "string" || typeof key3.value === "number")) property(owner2, "solid.option", `store path ${index}=${key3.value}`, node);
        }
      }
      if (fn.type === "member_expression" && fn.fields.object && fn.fields.property && !fn.tokens.includes("?.")) {
        const base = handle(fn.fields.object), method = view.name(fn.fields.property);
        if (base && method && methods[base.role]?.includes(method)) {
          budget.step(512);
          const projected = view.project(fn);
          if (projected?.contract && projected.contract === base.projection.contract && owner2) {
            if (!bound) relation(owner2, "solid.handle-call", view.reference(fn), node, "declared-handle-member");
            if (base.role === "solid.observable" && method === "subscribe") {
              if (args[0] && fnOf(args[0])) callback2(args[0], node, { index: 0, role: "observable observer", parameters: ["next value"] });
              else {
                source(owner2, args[0], node);
                budget.step(512);
                if (args[0] && view.referenceStable(args[0], node, "before-call")) callback2(fields(args[0])?.get("next"), node, { index: 0, role: "observable next observer", parameters: ["next value"] });
              }
            }
          } else if (owner2) diagnose("solid.call-shape", "Declared handle member is not proven after a receiver escape or mutation.", node);
        }
      }
    }
    if (node.type === "member_expression" && node.fields.object && node.fields.property && !node.tokens.includes("?.")) {
      const base = handle(node.fields.object), name = view.name(node.fields.property), owner2 = view.owner(node);
      if (base?.role === "solid.resource" && owner2 && name && ["loading", "error", "state", "latest"].includes(name)) {
        budget.step(512);
        if (view.project(node)) {
          source(owner2, node.fields.object, node, "solid.resource-status");
          property(owner2, "solid.option", `resource.${name}`, node);
        }
      }
    }
    if (!["jsx_opening_element", "jsx_self_closing_element"].includes(node.type) || !node.fields.name) continue;
    const tag = node.fields.name, owner = view.owner(node), origin = view.resolve(tag);
    const rule3 = origin.kind === "import" && !origin.member ? solidRule(origin.module, origin.name) : void 0;
    const attributes = /* @__PURE__ */ new Map();
    const superseded = /* @__PURE__ */ new Set(), duplicates = /* @__PURE__ */ new Set(), spreads = [], overridden = [];
    for (const item of node.children) {
      budget.step();
      if (item.type === "jsx_expression") {
        spreads.push(item);
        for (const name2 of attributes.keys()) superseded.add(name2);
        for (const attr of attributes.values()) overridden.push(attr.node);
        attributes.clear();
        continue;
      }
      if (item.type !== "jsx_attribute" || !item.children[0]) continue;
      const expression = item.children[1], value4 = expression?.type === "jsx_expression" ? expression.children.find((child2) => child2.type !== "comment") : expression;
      const name = view.text(item.children[0]);
      if (attributes.has(name)) {
        duplicates.add(name);
        superseded.add(name);
        attributes.delete(name);
        continue;
      }
      superseded.delete(name);
      attributes.set(name, { node: item, value: value4 });
    }
    const prop = (name) => {
      if (!attributes.has(name) && (spreads.length || superseded.has(name))) diagnose("solid.jsx-shape", `JSX ${name} is not proven after spread or duplicate props.`, node);
      return attributes.get(name)?.value;
    };
    const recordSpreads = () => {
      for (const attr of overridden) source(owner, attr, attr, "solid.jsx-overridden");
      for (const spread of spreads) {
        const argument = spread.children.find((item) => item.type === "spread_element")?.children.find((item) => item.type !== "comment");
        source(owner, argument, spread);
        if (owner) property(owner, "solid.jsx-mode", "spread props (dynamic keys; authored order retained; final effective values unproven)", spread);
      }
    };
    const parent = view.parent(node);
    const children = node.type === "jsx_opening_element" && parent?.type === "jsx_element" && parent.children.find((item) => item.type === "jsx_opening_element") === node ? parent.children.filter((item) => !["jsx_opening_element", "jsx_closing_element", "comment"].includes(item.type) && !(item.type === "jsx_text" && !view.text(item).trim()) && !(item.type === "jsx_expression" && item.children.every((child2) => child2.type === "comment"))) : [];
    const child = children.length === 1 && children[0].type === "jsx_expression" ? children[0].children.find((item) => item.type !== "comment") : void 0;
    if (rule3?.jsx && owner) {
      relation(owner, "solid.api-call", origin, node, "qualified-jsx");
      recordSpreads();
      if (["For", "Index"].includes(rule3.name)) {
        source(owner, prop("each"), node);
        callback2(children.length ? child : prop("children"), node, { index: 0, role: `${rule3.name} children`, parameters: rule3.name === "For" ? ["item value", "index accessor"] : ["item accessor", "index value"], ...rule3.name === "For" ? { arity: "index-accessor" } : {} });
      }
      if (["Show", "Match"].includes(rule3.name)) {
        source(owner, prop("when"), node);
        const keyed = attributes.get("keyed");
        const unknownKeyed = !keyed && (spreads.length > 0 || superseded.has("keyed"));
        if (unknownKeyed) prop("keyed");
        const mode = unknownKeyed ? "condition value or accessor (dynamic keyed)" : !keyed ? "condition accessor" : !keyed.value || view.text(keyed.value) === "true" ? "condition value (keyed)" : view.text(keyed.value) === "false" ? "condition accessor" : "condition value or accessor (dynamic keyed)";
        const rendered = children.length ? child : prop("children");
        source(owner, rendered, node, "solid.render-child");
        callback2(rendered, node, { index: 0, role: `${rule3.name} render child`, parameters: [mode], reads: "untracked", arity: "positive" });
      }
      if (rule3.name === "ErrorBoundary") callback2(prop("fallback"), node, { index: 0, role: "error fallback", parameters: ["error", "reset callback"] });
      if (rule3.name === "Dynamic") {
        if (!spreads.length) source(owner, prop("component"), node, "solid.dynamic-component");
        else {
          let ordinal = 0, group = 0;
          const contribution = (item, kind, input) => {
            property(owner, "solid.jsx-contribution", `${ordinal++}:group=${group}:${kind}`, item);
            relation(owner, "solid.jsx-contribution-source", { kind: "expression", text: view.text(input), span: view.span(input) }, item, "dynamic-prop-sequence");
            relation(owner, "solid.jsx-element", { kind: "expression", text: view.text(node), span: view.span(node) }, item, "dynamic-prop-sequence");
          };
          for (const item of node.children) {
            budget.step();
            if (item.type === "jsx_attribute" && item.children[0]) contribution(item, `attribute:${view.text(item.children[0])}`, item);
            else if (item.type === "jsx_expression") {
              const input = item.children.find((child2) => child2.type === "spread_element")?.children.find((child2) => child2.type !== "comment");
              if (input) {
                group++;
                contribution(item, "spread", input);
                group++;
              }
            }
          }
          for (const child2 of children) contribution(child2, "nested-child-source", child2);
          property(owner, "solid.jsx-props-contract", "authored groups and order, not compiler lowering proof; Solid lazy merge uses last-non-undefined property precedence, object-literal flattening uses own-property precedence; nested children supply the final children property; effective keys, values, getters and child normalization not evaluated", node);
          property(owner, "solid.dynamic-dispatch", "effective component is removed from forwarded props; function selects component invocation, string selects intrinsic element, other types yield no rendered value; final component, branch, output and execution success unproven", node);
          if (duplicates.size) diagnose("solid.jsx-shape", "Duplicate authored JSX attributes remain unsupported by the ordered Dynamic contract.", node);
        }
      }
      if (rule3.name === "Portal") {
        source(owner, prop("mount"), node);
        source(owner, prop("ref"), node);
        property(owner, "solid.boundary", "DOM relocation does not change owner ancestry", node);
      }
      if (["Suspense", "SuspenseList", "NoHydration", "Hydration", "HydrationScript"].includes(rule3.name)) {
        property(owner, "solid.boundary", `${rule3.name} authored render boundary; no scheduling guarantee`, node);
        for (const name of ["fallback", "revealOrder", "tail"]) source(owner, prop(name), node);
      }
    }
    if (tag.type === "member_expression" && tag.fields.object && tag.fields.property && view.name(tag.fields.property) === "Provider") {
      const context = handle(tag.fields.object);
      if (owner && context?.role === "solid.context") {
        recordSpreads();
        budget.step(512);
        if (view.project(tag)) {
          source(owner, tag.fields.object, node, "solid.provider-context");
          source(owner, prop("value"), node);
        } else diagnose("solid.jsx-shape", "Provider member identity is not proven after a receiver escape.", node);
      }
    }
    if (!/^[a-z][a-z0-9:_-]*$/.test(view.text(tag)) || !owner || !nativeContext(node)) continue;
    recordSpreads();
    if ([...superseded].some((name) => name === "ref" || name === "innerHTML" || name.startsWith("use:") || /^on(?::|capture:|[A-Za-z])/.test(name))) diagnose("solid.jsx-shape", "Native JSX bindings before a spread or duplicate attribute are not proven.", node);
    for (const [name, attr] of attributes) {
      const value4 = attr.value;
      if (name.startsWith("use:")) {
        property(owner, "solid.jsx-mode", "native directive (element, value accessor)", attr.node);
        const directive = attr.node.children[0]?.children[1];
        source(owner, directive, attr.node, "solid.jsx-binding");
        source(owner, value4, attr.node);
        callback2(directive, attr.node, { index: 0, role: "native directive", parameters: ["native element", "directive value accessor"] });
      } else if (name === "ref") {
        source(owner, value4, attr.node, "solid.jsx-binding");
        callback2(value4, attr.node, { index: 0, role: "native ref callback", parameters: ["native element"] });
      } else if (name === "innerHTML") {
        source(owner, value4, attr.node, "solid.jsx-binding");
        property(owner, "solid.jsx-mode", "raw innerHTML assignment (not escaped text)", attr.node);
      } else if (/^on(?::|capture:|[A-Za-z])/.test(name) && value4) {
        property(owner, "solid.jsx-mode", name, attr.node);
        let target = value4, data;
        const nativeName = name.startsWith("on:") || name.startsWith("oncapture:");
        if (view.unwrap(value4).type === "array") {
          const tuple = array2(value4);
          if (nativeName || tuple?.length !== 2) {
            diagnose("solid.jsx-shape", "Native event tuple requires exactly [handler, data] on an ordinary onEvent attribute.", attr.node);
            continue;
          }
          target = tuple[0];
          data = tuple[1];
        } else if (name.startsWith("on:") && view.unwrap(value4).type === "object") {
          const listener = fields(value4), fn = listener?.get("handleEvent");
          if (!fn) {
            diagnose("solid.jsx-shape", "Native listener object requires explicit handleEvent and bounded options.", attr.node);
            continue;
          }
          target = fn;
          options(value4, attr.node, ["capture", "passive", "once", "signal"]);
        } else if (view.unwrap(value4).type === "object") {
          diagnose("solid.jsx-shape", "Listener option objects are supported only for explicit on: events.", attr.node);
          continue;
        }
        source(owner, target, attr.node, "solid.event-handler");
        source(owner, data, attr.node, "solid.event-data");
        callback2(target, attr.node, { index: 0, role: data ? "bound native event handler" : "native event handler", parameters: data ? ["bound data", "native event"] : ["native event"] });
      }
    }
  }
  for (const node of view.nodes) {
    budget.step();
    if (node.type !== "comment" || !/@once\b/.test(view.text(node))) continue;
    const expression = view.parent(node), owner = expression && view.owner(expression);
    if (expression?.type === "jsx_expression" && owner && nativeContext(expression)) property(owner, "solid.jsx-mode", "@once requested; compiler-transform dependent", expression);
  }
}

// src/frameworks/solid/index.ts
var callKey = (node) => `${node.startIndex}:${node.endIndex}`;
function createSolidPlugin(digests) {
  return {
    descriptor: descriptor2(digests),
    analyze({ view, budget }, emitter) {
      if (view.state === "truncated" || view.state === "unsupported" || view.state === "failed") return { state: view.state };
      const diagnostics = [];
      let matched = false, partial = false;
      const diagnose = (code, message, node) => {
        partial = true;
        if (diagnostics.length < 16 && !diagnostics.some((item) => item.code === code)) diagnostics.push({ code, message, span: view.span(node) });
      };
      const evidence = (node, ruleId) => ({ ruleId, basis: "import-bound", span: view.span(node) });
      const bounded = (value4) => {
        let bytes = 0;
        for (const point of canonicalJSON(value4)) {
          const code = point.codePointAt(0);
          bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
        }
        return bytes <= view.limits.maxValueBytes;
      };
      const relation = (subject, term, target, node, rule3) => {
        budget.step();
        if (!bounded(target)) {
          diagnose("solid.reference-limit", "Source reference exceeds the bounded wire value size.", node);
          return;
        }
        matched = true;
        emitter.relation(subject.key, term, target, evidence(node, rule3));
      };
      const property = (subject, term, value4, node) => {
        budget.step();
        if (!bounded({ kind: "string", value: value4 }) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value4) || [...value4].some((point) => {
          const code = point.codePointAt(0);
          return code >= 55296 && code <= 57343;
        })) {
          diagnose("solid.key-limit", "A semantic value is outside the bounded wire string contract.", node);
          return;
        }
        matched = true;
        emitter.property(subject.key, term, "literal", { kind: "string", value: value4 }, evidence(node, "declared-contract"));
      };
      const handles = /* @__PURE__ */ new Map(), groups = /* @__PURE__ */ new Map(), factories = /* @__PURE__ */ new Map(), calls2 = [];
      for (const node of view.nodes) {
        budget.step();
        if (node.type !== "call_expression" || !node.fields.function || node.tokens.includes("?.")) continue;
        const origin = view.resolve(node.fields.function);
        const rule3 = origin.kind === "import" ? solidRule(origin.module, origin.name + (origin.member ? `.${origin.member}` : "")) : void 0;
        if (rule3) {
          if (["onMount", "onCleanup"].includes(rule3.name)) {
            const args = node.fields.arguments?.children.filter((child) => child.type !== "comment") ?? [];
            if (args.length !== 1 || args[0]?.type === "spread_element") {
              diagnose("solid.call-shape", "Lifecycle registration requires one explicit callback argument.", node);
              continue;
            }
          }
          calls2.push({ node, rule: rule3 });
          if (rule3.result) factories.set(callKey(node), { node, rule: rule3 });
        }
      }
      if (calls2.some((entry) => entry.rule.name.startsWith("query."))) {
        let escapedQuery = false;
        for (const node of view.nodes) {
          budget.step();
          if (!["identifier", "member_expression"].includes(node.type)) continue;
          const origin = view.resolve(node);
          if (origin.kind !== "import" || origin.module !== "@solidjs/router" || origin.name !== "query" || origin.member) continue;
          const binding = view.binding(node);
          if (binding?.kind === "import" && node.startIndex >= binding.node.startIndex && node.endIndex <= binding.node.endIndex) continue;
          let at = node, parent = view.parent(at);
          while (parent && ["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression"].includes(parent.type)) {
            budget.step();
            at = parent;
            parent = view.parent(at);
          }
          if (parent?.type === "variable_declarator" && parent.fields.value?.startIndex === at.startIndex && view.parent(parent)?.tokens.includes("const")) continue;
          if (parent?.type === "call_expression" && parent.fields.function?.startIndex === at.startIndex && !parent.tokens.includes("?.")) continue;
          if (parent?.type === "member_expression" && parent.fields.object?.startIndex === at.startIndex && !parent.tokens.includes("?.")) {
            const member = view.resolve(parent), call = view.parent(parent);
            if (member.kind === "import" && member.member && solidRule(member.module, `${member.name}.${member.member}`) && call?.type === "call_expression" && call.fields.function?.startIndex === parent.startIndex && !call.tokens.includes("?.")) continue;
          }
          escapedQuery = true;
          break;
        }
        if (escapedQuery) {
          for (let i = calls2.length - 1; i >= 0; i--) if (calls2[i].rule.name.startsWith("query.")) {
            diagnose("solid.call-shape", "Imported query namespace members may have escaped or been replaced.", calls2[i].node);
            calls2.splice(i, 1);
          }
        }
      }
      const hasJSX = view.nodes.some((node) => node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element");
      const jsxContext = hasJSX && solidJSXContext(view, budget);
      if (!calls2.length && !hasJSX) return partial ? { state: "partial", diagnostics } : { state: "not-applicable" };
      for (const declaration of view.declarations) {
        budget.step();
        if (declaration.kind !== "const") continue;
        const node = view.declarationNode(declaration.key);
        if (!node) continue;
        if (node.type === "variable_declarator") {
          const initial = node.fields.value && view.unwrap(node.fields.value);
          if (!initial || !["identifier", "undefined", "member_expression", "subscript_expression"].includes(initial.type) && !(initial.type === "call_expression" && factories.get(callKey(initial))?.rule.slots?.[""])) continue;
        }
        if (!factories.size) continue;
        budget.step(512);
        const source = view.initializerProjection(declaration.key);
        if (!source?.complete) continue;
        budget.step(512);
        const projection = view.project(source.initializer, source.path);
        if (!projection?.contract) continue;
        const factory = factories.get(callKey(projection.initializer));
        if (!factory) continue;
        const slot = projection.path.length ? Number(projection.path[0]) : -1;
        let role = factory.rule.slots?.[projection.path.map(String).join(".")];
        if (projection.contract === "solid.split-props" && projection.partitions && projection.path.length) role = projection.path.length === 2 ? "solid.prop" : slot === projection.partitions.keys.length ? "solid.props-remainder" : "solid.props-partition";
        if (projection.contract === "solid.merge-props" && projection.path.length === 1) role = "solid.prop";
        if (!role) continue;
        const handle2 = { declaration, node, projection, slot, role };
        handles.set(declaration.key, handle2);
        const key3 = callKey(projection.initializer), group = groups.get(key3) ?? [];
        group.push(handle2);
        groups.set(key3, group);
        matched = true;
        emitter.role(declaration.key, role, evidence(node, "return-binding"));
        relation(declaration, "solid.factory", view.resolve(projection.initializer.fields.function), node, "return-binding");
        relation(declaration, "solid.created-by", view.reference(projection.initializer), node, "return-binding");
        if (role === "solid.signal-pair" || role === "solid.store-pair") property(declaration, "solid.return-contract", "authored two-slot result; later slot identity requires mutation and escape proof", node);
        if (factory.rule.name === "onCleanup") {
          const argument = projection.initializer.fields.arguments?.children.find((item) => item.type !== "comment");
          if (argument) relation(declaration, "solid.returned-callback", view.reference(argument), node, "same-cleanup-callback");
          property(declaration, "solid.return-contract", factory.rule.boundary, node);
        }
        if (projection.partitions) {
          relation(declaration, "solid.props-source", view.reference(projection.partitions.source), node, "props-partition");
          property(declaration, "solid.partition-index", String(slot), node);
          if (projection.path.length === 2) property(declaration, "solid.prop-key", String(projection.path[1]), node);
          else {
            const remainder = slot === projection.partitions.keys.length;
            for (const key4 of remainder ? projection.partitions.keys.flat() : projection.partitions.keys[slot]) property(declaration, remainder ? "solid.excluded-key" : "solid.included-key", key4, node);
          }
        }
      }
      for (const [key3, factory] of factories) {
        budget.step();
        const group = groups.get(key3);
        if (!group?.length) {
          const parent = view.parent(factory.node);
          const returned = parent?.type === "return_statement" || parent?.type === "arrow_function" && parent.fields.body?.startIndex === factory.node.startIndex;
          if (!returned && ["createSignal", "createStore", "splitProps"].includes(factory.rule.name)) diagnose("solid.unsupported-binding", "Factory result has no proven stable supported binding projection.", factory.node);
          continue;
        }
        group.sort((a, b) => a.declaration.span.startByte - b.declaration.span.startByte);
        const canonical = /* @__PURE__ */ new Map();
        for (const handle2 of group) {
          budget.step();
          const path = JSON.stringify(handle2.projection.path.map((key4, i) => i === 0 && /^\d+$/.test(String(key4)) ? Number(key4) : key4)), first = canonical.get(path);
          if (!first) canonical.set(path, handle2);
          else relation(handle2.declaration, "solid.alias-of", { kind: "declaration", key: first.declaration.key }, handle2.node, "stable-alias");
        }
        const read = canonical.get("[0]");
        if (read && ["solid.signal-accessor", "solid.store"].includes(read.role)) for (const handle2 of group) {
          budget.step();
          if (handle2.slot === 1 && handle2.projection.path.length === 1) relation(handle2.declaration, read.role === "solid.signal-accessor" ? "solid.setter-for" : "solid.updater-for", { kind: "declaration", key: read.declaration.key }, handle2.node, "return-pair");
        }
        if (read && ["solid.resource", "solid.transition-pending"].includes(read.role)) for (const handle2 of group) {
          budget.step();
          if (handle2.slot === 1) relation(handle2.declaration, read.role === "solid.resource" ? "solid.resource-for" : "solid.transition-for", { kind: "declaration", key: read.declaration.key }, handle2.node, "return-pair");
        }
      }
      const invoked = (node) => {
        const binding = view.binding(node);
        if (!binding?.available || !binding.stable || binding.typeOnly || !binding.declaration) return void 0;
        return handles.get(binding.declaration);
      };
      const handle = (input) => {
        const node = view.unwrap(input), known = invoked(node);
        if (known) return known;
        if (!["member_expression", "subscript_expression"].includes(node.type) || !node.fields.object || node.tokens.includes("?.")) return void 0;
        const base = invoked(view.unwrap(node.fields.object));
        if (!base) return void 0;
        budget.step(512);
        const projection = view.project(node), factory = projection && factories.get(callKey(projection.initializer));
        const role = projection && factory?.rule.slots?.[projection.path.map(String).join(".")];
        return role && projection ? { declaration: base.declaration, role, projection } : void 0;
      };
      for (const node of view.nodes) {
        budget.step();
        if (node.type === "call_expression" && node.fields.function && !node.tokens.includes("?.")) {
          const fn = view.unwrap(node.fields.function), bound = handle(fn), owner2 = view.owner(node);
          if (!bound || !owner2) continue;
          const term = bound.role === "solid.signal-accessor" ? "solid.signal-read" : bound.role === "solid.signal-setter" ? "solid.signal-write" : bound.role === "solid.store-updater" ? "solid.store-update" : ["solid.accessor", "solid.resource", "solid.children", "solid.transition-pending"].includes(bound.role) ? "solid.accessor-read" : ["solid.selector", "solid.reaction", "solid.on-callback", "solid.resource-mutator", "solid.resource-refetch", "solid.transition-start", "solid.cleanup-callback", "solid.disposer", "solid.query", "solid.action"].includes(bound.role) ? "solid.handle-call" : void 0;
          if (term) relation(owner2, term, view.reference(fn), node, "direct-invocation");
        }
        if (!["member_expression", "subscript_expression"].includes(node.type) || node.tokens.includes("?.")) continue;
        const parent = view.parent(node);
        if (parent && ["member_expression", "subscript_expression"].includes(parent.type) && parent.fields.object?.startIndex === node.startIndex) continue;
        let target = node, context = parent;
        while (context && ["parenthesized_expression", "as_expression", "non_null_expression", "satisfies_expression"].includes(context.type)) {
          budget.step();
          target = context;
          context = view.parent(context);
        }
        if (context && (["assignment_expression", "augmented_assignment_expression"].includes(context.type) && context.fields.left?.startIndex === target.startIndex || context.type === "update_expression" || context.type === "unary_expression" && context.tokens.includes("delete"))) continue;
        let base = node;
        while (["member_expression", "subscript_expression"].includes(base.type) && base.fields.object && !base.tokens.includes("?.")) {
          budget.step();
          base = view.unwrap(base.fields.object);
        }
        const storeHandle = invoked(base), owner = view.owner(node);
        if (storeHandle?.role === "solid.store" && owner) relation(owner, "solid.store-read", view.reference(base), node, "direct-store-read");
      }
      analyzeSemantics({ view, budget, calls: calls2, handle, relation, property, diagnose }, jsxContext);
      return { state: partial ? "partial" : matched ? "complete" : "not-applicable", diagnostics };
    }
  };
}

// src/producers/implementation-vocabulary.ts
var implementationRules = {
  version: 1,
  spanEncoding: "s:utf8-start:utf8-end:start-line:end-line",
  rules: ["local-outcome-v1", "local-write-v1", "environment-read-v1", "test-registration-v1", "test-assertion-v1"],
  testModules: ["bun:test", "vitest", "node:test"],
  assertModules: ["node:assert", "node:assert/strict"],
  processModules: ["process", "node:process"],
  maxUnits: 128,
  maxFacts: 2048,
  maxKeyBytes: 128,
  maxContextDepth: 64
};
var roles4 = {
  return: "Local Return Statement",
  throw: "Local Throw Statement",
  assignment: "Direct Assignment",
  update: "Direct Update",
  "config-read": "Qualified Environment Read",
  test: "Authored Test Registration",
  assertion: "Authored Assertion"
};
var spans = {
  owner: "Lexical Callable Span",
  value: "Value Expression Span",
  target: "Write Target Span",
  "if-true": "Enclosing If True Predicate Span",
  "if-false": "Enclosing If False Predicate Span",
  "conditional-true": "Enclosing Conditional True Predicate Span",
  "conditional-false": "Enclosing Conditional False Predicate Span",
  fallback: "Fallback Expression Span",
  "fallback-expression": "Complete Defaulting Expression Span",
  callback: "Registered Test Callback Span",
  "test-name": "Test Name Expression Span",
  actual: "Asserted Expression Span",
  expected: "Expected Expression Span",
  "test-owner": "Exact Test Callback Span"
};
var strings = {
  condition: "Source Evidence Limitation",
  operator: "Parsed Write Operator",
  "config-key": "Static Environment Key",
  "config-source": "Environment API",
  "config-provenance": "Environment Provenance",
  "fallback-semantics": "Defaulting Semantics",
  runner: "Imported Test Runner",
  api: "Imported Registration API",
  matcher: "Parsed Assertion Matcher",
  "async-mode": "Parsed Assertion Async Mode"
};
var booleans = { negated: "Parsed Matcher Negation", awaited: "Directly Awaited Assertion", "unit-complete": "Complete Source Unit" };
function implementationSpan(span2) {
  return `s:${span2.startByte}:${span2.endByte}:${span2.startLine}:${span2.endLine}`;
}
function implementationDescriptor(digests) {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error("Implementation plugin requires build-supplied digests");
  return {
    id: "implementation",
    version: "1",
    ...digests,
    languages: ["typescript", "tsx"],
    view: { id: "typescript", version: 1 },
    roles: Object.entries(roles4).map(([name, label]) => ({ id: `implementation.${name}`, label })),
    // Cardinality is per subject in wire v1, but these properties are per occurrence.
    properties: [
      ...Object.entries(spans).map(([name, label]) => ({ id: `implementation.${name}`, label, description: "Exact source span locator; never an evaluated value or embedded source text.", multiple: true, valueKind: "string" })),
      ...Object.entries(strings).map(([name, label]) => ({ id: `implementation.${name}`, label, multiple: true, valueKind: "string" })),
      ...Object.entries(booleans).map(([name, label]) => ({ id: `implementation.${name}`, label, multiple: true, valueKind: "boolean" }))
    ],
    relations: []
  };
}

// src/producers/implementation-plugin.ts
var callables = /* @__PURE__ */ new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function", "method_definition"]);
var wrappers2 = /* @__PURE__ */ new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "type_assertion", "non_null_expression"]);
var members = /* @__PURE__ */ new Set(["member_expression", "subscript_expression"]);
var writes2 = /* @__PURE__ */ new Set(["assignment_expression", "augmented_assignment_expression", "update_expression"]);
var operators = /* @__PURE__ */ new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=", "++", "--"]);
var expectMatchers = {
  toBe: 1,
  toEqual: 1,
  toStrictEqual: 1,
  toContain: 1,
  toHaveLength: 1,
  toMatch: 1,
  toBeTruthy: 0,
  toBeFalsy: 0,
  toBeNull: 0,
  toBeUndefined: 0,
  toBeDefined: 0
};
var assertMatchers = { ok: 1, equal: 2, notEqual: 2, strictEqual: 2, notStrictEqual: 2, deepEqual: 2, notDeepEqual: 2, deepStrictEqual: 2, notDeepStrictEqual: 2, match: 2, doesNotMatch: 2 };
var same = (a, b) => !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
var optional = (node) => node.tokens.includes("?.") || node.children.some((child) => child.type === "optional_chain");
var safeKey = (key3) => key3 !== void 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key3) && Buffer.byteLength(key3) <= implementationRules.maxKeyBytes;
function createImplementationPlugin(digests) {
  return {
    descriptor: implementationDescriptor(digests),
    analyze({ view, budget }, emitter) {
      if (["truncated", "unsupported", "failed"].includes(view.state)) return { state: view.state };
      let partial = false, truncated = false, stopped = false, units = 0, facts = 0;
      const diagnostics = [];
      const diagnose = (code, node) => {
        partial = true;
        if (diagnostics.some((item) => item.code === `implementation.${code}`)) return;
        const message = "Source form is outside the reviewed implementation evidence contract.";
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) {
          truncated = true;
          return;
        }
        diagnostics.push({ code: `implementation.${code}`, message, span: view.span(node) });
      };
      const locator = (node) => implementationSpan(view.span(node));
      const args = (node) => node.fields.arguments?.children.filter((child) => child.type !== "comment") ?? [];
      const outer = (node) => {
        let at = node, parent = view.parent(at);
        while (parent && wrappers2.has(parent.type)) {
          budget.step();
          at = parent;
          parent = view.parent(at);
        }
        return { at, parent };
      };
      const owner = (node) => {
        let at = view.parent(node), depth = 0;
        while (at) {
          budget.step();
          if (++depth > implementationRules.maxContextDepth) {
            truncated = true;
            return;
          }
          if (callables.has(at.type)) return at;
          at = view.parent(at);
        }
      };
      const context = (node) => {
        const properties4 = [["condition", "source-only"]];
        let child = node, parent = view.parent(node), depth = 0;
        while (parent) {
          budget.step();
          if (++depth > implementationRules.maxContextDepth) {
            truncated = true;
            properties4.push(["condition", "context-depth-limit"]);
            break;
          }
          if (callables.has(parent.type)) {
            properties4.push(["owner", locator(parent)]);
            break;
          }
          if (parent.type === "if_statement" || parent.type === "ternary_expression") {
            const predicate = parent.fields.condition;
            const polarity = same(child, parent.fields.consequence) ? "true" : same(child, parent.fields.alternative) ? "false" : void 0;
            if (predicate && polarity) properties4.push([`${parent.type === "if_statement" ? "if" : "conditional"}-${polarity}`, locator(predicate)]);
          }
          const boundary = ["for_statement", "for_in_statement", "while_statement", "do_statement"].includes(parent.type) ? "loop-context" : ["try_statement", "catch_clause", "finally_clause"].includes(parent.type) ? "try-context" : ["switch_statement", "switch_case", "switch_default"].includes(parent.type) ? "switch-context" : parent.type === "binary_expression" && parent.tokens.some((token) => ["&&", "||", "??"].includes(token)) && same(child, parent.fields.right) ? "short-circuit-context" : void 0;
          if (boundary) {
            properties4.push(["condition", boundary]);
            diagnose("control-context", node);
          }
          child = parent;
          parent = view.parent(parent);
        }
        return properties4;
      };
      const emit = (node, role, ruleId, basis, properties4) => {
        if (stopped) return;
        const subject = view.owner(node);
        if (!subject) {
          diagnose("owner-unavailable", node);
          return;
        }
        const all = [...context(node), ...properties4, ["unit-complete", true]];
        if (++units > implementationRules.maxUnits || facts + all.length + 1 > implementationRules.maxFacts) {
          truncated = stopped = true;
          diagnose("unit-limit", node);
          return;
        }
        const values = all.map(([, value4]) => typeof value4 === "string" ? { kind: "string", value: value4 } : { kind: "boolean", value: value4 });
        if (values.some((value4) => Buffer.byteLength(canonicalJSON(value4)) > view.limits.maxValueBytes)) {
          diagnose("value-limit", node);
          return;
        }
        const evidence = { ruleId, basis, span: view.span(node) };
        facts++;
        if (!emitter.role(subject.key, `implementation.${role}`, evidence)) {
          stopped = truncated = true;
          return;
        }
        for (let i = 0; i < all.length; i++) {
          budget.step();
          facts++;
          if (!emitter.property(subject.key, `implementation.${all[i][0]}`, "literal", values[i], evidence)) {
            stopped = truncated = true;
            return;
          }
        }
      };
      const staticKey = (node) => {
        budget.step(512);
        const constant = view.constant(node);
        if (!constant.known || typeof constant.value !== "string" || !safeKey(constant.value)) return;
        return constant.value;
      };
      const memberName = (node) => {
        if (node.type === "member_expression" && node.fields.property) return view.name(node.fields.property);
        if (node.type === "subscript_expression" && node.fields.index) return staticKey(node.fields.index);
      };
      const optionalReceiver = (node) => {
        let at = view.unwrap(node);
        while (members.has(at.type) && at.fields.object) {
          if (optional(at)) return true;
          budget.step();
          at = view.unwrap(at.fields.object);
        }
        return optional(at);
      };
      const origin = (node) => {
        budget.step(512);
        const result = view.resolve(node);
        return result.kind === "import" ? result : void 0;
      };
      let declaredProcess = view.declarations.some((item) => item.name === "process");
      let replacedMetaEnv = false;
      for (const node of view.nodes) {
        budget.step();
        if (view.name(node) === "process") {
          let child = node, parent = view.parent(child), depth = 0;
          while (parent && ++depth <= implementationRules.maxContextDepth) {
            budget.step();
            if (["formal_parameters", "required_parameter", "optional_parameter", "import_clause", "catch_clause"].includes(parent.type) || callables.has(parent.type) && same(parent.fields.parameter, child)) {
              declaredProcess = true;
              break;
            }
            if (["statement_block", "program"].includes(parent.type)) break;
            child = parent;
            parent = view.parent(parent);
          }
        }
        const target = writes2.has(node.type) ? node.fields.left ?? node.fields.argument : node.type === "unary_expression" && node.tokens.includes("delete") ? node.children[0] : void 0;
        if (!target) continue;
        const at = view.unwrap(target);
        if (view.name(at) === "process") declaredProcess = true;
        if (members.has(at.type) && memberName(at) === "env" && at.fields.object) {
          const base = view.unwrap(at.fields.object);
          if (view.name(base) === "process") declaredProcess = true;
          if (base.type === "meta_property") replacedMetaEnv = true;
        }
      }
      const environment = (input) => {
        const node = view.unwrap(input);
        if (members.has(node.type) && memberName(node) === "env" && node.fields.object) {
          const base = view.unwrap(node.fields.object);
          if (base.type === "meta_property" && /^import\s*\.\s*meta$/.test(view.text(base))) {
            if (replacedMetaEnv || optionalReceiver(node)) {
              diagnose("config-pattern", node);
              return;
            }
            return { source: "import.meta.env", provenance: "syntax", basis: "syntax" };
          }
          if (base.type === "identifier" && view.name(base) === "process" && !view.binding(base)) {
            if (declaredProcess || optionalReceiver(node)) {
              diagnose("config-pattern", node);
              return;
            }
            return { source: "process.env", provenance: "ambient-assumed", basis: "convention" };
          }
        }
        if (node.type !== "identifier" && !members.has(node.type)) return;
        const bound = origin(node);
        if (bound && implementationRules.processModules.some((module) => module === bound.module) && (bound.name === "env" && !bound.member || bound.name === "default" && bound.member === "env")) {
          if (optionalReceiver(node)) {
            diagnose("config-pattern", node);
            return;
          }
          return { source: "process.env", provenance: "import-bound", basis: "import-bound" };
        }
      };
      const envProperties = (env, key3) => [
        ["config-key", key3],
        ["config-source", env.source],
        ["config-provenance", env.provenance],
        ["condition", env.provenance === "ambient-assumed" ? "ambient-api-assumed" : env.source === "import.meta.env" ? "environment-provenance-unproven" : "import-contract-not-runtime"]
      ];
      const fallback = (node) => {
        const { at, parent } = outer(node);
        if (parent?.type === "binary_expression" && same(parent.fields.left, at) && parent.fields.right) {
          const operator = parent.tokens.find((token) => token === "??" || token === "||");
          if (operator) return [["fallback", locator(parent.fields.right)], ["fallback-expression", locator(parent)], ["fallback-semantics", operator === "??" ? "nullish" : "falsy"]];
        }
        return [];
      };
      const registrations = /* @__PURE__ */ new Map();
      const registrationCalls = /* @__PURE__ */ new Set();
      for (const node of view.nodes) {
        budget.step();
        if (stopped) break;
        if (node.type !== "call_expression" || !node.fields.function) continue;
        const bound = origin(node.fields.function);
        if (!bound || !implementationRules.testModules.some((module) => module === bound.module)) continue;
        const api = bound.name === "default" && bound.module === "node:test" ? "test" : bound.name;
        if (!["test", "it"].includes(api)) continue;
        registrationCalls.add(locator(node));
        const parameters = args(node), callback2 = parameters[1] && view.unwrap(parameters[1]);
        if (bound.member || optional(node) || optionalReceiver(node.fields.function) || parameters.length !== 2 || !callback2 || !["arrow_function", "function_expression"].includes(callback2.type)) {
          diagnose("test-shape", node);
          continue;
        }
        registrations.set(locator(callback2), { runner: bound.module, api });
        emit(node, "test", "test-registration-v1", "import-bound", [["runner", bound.module], ["api", api], ["callback", locator(callback2)], ["test-name", locator(parameters[0])]]);
      }
      for (const node of view.nodes) {
        budget.step();
        if (stopped) break;
        if (node.type === "return_statement" || node.type === "throw_statement") {
          const value4 = node.children.find((child) => child.type !== "comment");
          emit(node, node.type === "return_statement" ? "return" : "throw", "local-outcome-v1", "syntax", value4 ? [["value", locator(value4)]] : []);
        } else if (writes2.has(node.type)) {
          const target = node.fields.left ?? node.fields.argument, value4 = node.fields.right;
          const operator = node.tokens.find((token) => operators.has(token));
          if (!target || !operator || ["object_pattern", "array_pattern"].includes(target.type)) {
            diagnose("write-shape", node);
            continue;
          }
          emit(node, node.type === "update_expression" ? "update" : "assignment", "local-write-v1", "syntax", [["target", locator(target)], ["operator", operator], ...value4 ? [["value", locator(value4)]] : []]);
        }
        if (members.has(node.type) && node.fields.object) {
          const env = environment(node.fields.object);
          if (env) {
            const { at, parent: parent2 } = outer(node);
            const write = parent2 && (writes2.has(parent2.type) && (same(parent2.fields.left, at) || same(parent2.fields.argument, at)) || parent2.type === "unary_expression" && parent2.tokens.includes("delete"));
            if (write) continue;
            const key3 = memberName(node);
            if (!safeKey(key3) || optional(node)) {
              diagnose("config-key", node);
              continue;
            }
            emit(node, "config-read", "environment-read-v1", env.basis, [...envProperties(env, key3), ...fallback(node)]);
          }
          if (memberName(node) === "env" && environment(node)) {
            const { at, parent: parent2 } = outer(node);
            const keyRead = parent2 && members.has(parent2.type) && same(parent2.fields.object, at);
            const pattern = parent2?.type === "variable_declarator" && parent2.fields.name?.type === "object_pattern" && same(parent2.fields.value, at);
            if (!keyRead && !pattern) diagnose("config-pattern", node);
          }
        }
        if (node.type === "variable_declarator" && node.fields.value && node.fields.name?.type === "object_pattern") {
          const env = environment(node.fields.value);
          if (env) for (const element of node.fields.name.children) {
            budget.step();
            if (element.type === "comment") continue;
            let key3, defaultValue;
            if (element.type === "shorthand_property_identifier_pattern") key3 = view.name(element);
            else if (element.type === "object_assignment_pattern") {
              key3 = element.fields.left && view.name(element.fields.left);
              defaultValue = element.fields.right;
            } else if (element.type === "pair_pattern" && element.fields.key) {
              key3 = element.fields.key.type === "computed_property_name" ? element.fields.key.children[0] && staticKey(element.fields.key.children[0]) : view.name(element.fields.key);
              const value4 = element.fields.value;
              if (value4?.type === "assignment_pattern") defaultValue = value4.fields.right;
              else if (value4?.type !== "identifier") key3 = void 0;
            }
            if (!safeKey(key3)) {
              diagnose("config-pattern", element);
              continue;
            }
            emit(element, "config-read", "environment-read-v1", env.basis, [...envProperties(env, key3), ...defaultValue ? [["fallback", locator(defaultValue)], ["fallback-expression", locator(element)], ["fallback-semantics", "undefined"]] : []]);
          }
        }
        if (node.type !== "call_expression" || !node.fields.function || registrationCalls.has(locator(node))) continue;
        const fn = view.unwrap(node.fields.function), parameters = args(node);
        let matcher, actual, expected, negated = false, asyncMode = "sync", recognized = false;
        if (fn.type === "member_expression" && fn.fields.object && fn.fields.property) {
          matcher = view.name(fn.fields.property);
          let base = view.unwrap(fn.fields.object);
          const modifiers = [];
          let optionalModifier = false;
          while (base.type === "member_expression" && base.fields.object && base.fields.property && modifiers.length < 4) {
            budget.step();
            optionalModifier ||= optional(base);
            modifiers.unshift(view.name(base.fields.property) ?? "");
            base = view.unwrap(base.fields.object);
          }
          if (base.type === "call_expression" && base.fields.function) {
            const bound = origin(base.fields.function);
            recognized = !!bound && ["bun:test", "vitest"].includes(bound.module) && bound.name === "expect";
            if (recognized) {
              const values = args(base);
              const validModifiers = modifiers.length <= 2 && new Set(modifiers).size === modifiers.length && modifiers.every((item) => ["not", "resolves", "rejects"].includes(item)) && !(modifiers.includes("resolves") && modifiers.includes("rejects"));
              if (bound.member || !matcher || !Object.hasOwn(expectMatchers, matcher) || parameters.length !== expectMatchers[matcher] || values.length !== 1 || !validModifiers || optionalModifier || optional(base) || optional(fn) || optionalReceiver(base.fields.function)) {
                diagnose("assertion-shape", node);
                continue;
              }
              actual = values[0];
              expected = parameters[0];
              negated = modifiers.includes("not");
              asyncMode = modifiers.find((item) => item !== "not") ?? "sync";
            }
          }
        }
        if (!recognized) {
          const bound = origin(fn);
          if (bound && implementationRules.assertModules.some((module) => module === bound.module)) {
            recognized = true;
            matcher = bound.name === "default" || bound.name === "*" || bound.name === "strict" ? bound.member ?? "ok" : bound.member ? `${bound.name}.${bound.member}` : bound.name;
            if (!Object.hasOwn(assertMatchers, matcher) || parameters.length !== assertMatchers[matcher]) {
              diagnose("assertion-shape", node);
              continue;
            }
            actual = parameters[0];
            expected = parameters[1];
            negated = matcher.startsWith("not") || matcher === "doesNotMatch";
          }
        }
        if (!recognized || !actual || !matcher) continue;
        if (optional(node) || optionalReceiver(fn) || parameters.some((item) => item.type === "spread_element")) {
          diagnose("assertion-shape", node);
          continue;
        }
        const callable = owner(node), test = callable && registrations.get(locator(callable));
        if (!callable || !test) {
          diagnose("assertion-owner", node);
          continue;
        }
        const { parent } = outer(node);
        emit(node, "assertion", "test-assertion-v1", "import-bound", [["test-owner", locator(callable)], ["actual", locator(actual)], ...expected ? [["expected", locator(expected)]] : [], ["matcher", matcher], ["negated", negated], ["async-mode", asyncMode], ["awaited", parent?.type === "await_expression"]]);
      }
      return { state: truncated ? "truncated" : partial ? "partial" : facts ? "complete" : "not-applicable", diagnostics };
    }
  };
}

// src/producers/transport-binding-vocabulary.ts
var transportBindingRules = {
  version: 1,
  spanEncoding: "s:utf8-start:utf8-end:start-line:end-line",
  rules: ["node-event-instance-v1", "node-event-listener-v1", "node-event-emission-v1"],
  module: "node:events",
  importedName: "EventEmitter",
  excludedEvents: ["error", "newListener", "removeListener"],
  conditions: ["lexical-binding-only", "standard-node-api-assumed", "runtime-version-not-captured", "registration-order-unknown", "execution-unknown", "external-mutation-unknown"],
  maxSourceBytes: 256 * 1024,
  maxWork: 1e5,
  maxDepth: 64,
  maxInstances: 16,
  maxEndpoints: 48,
  maxFacts: 1024,
  maxEventKeyBytes: 128,
  maxEmissionArguments: 16,
  maxPairCandidates: 1024,
  maxCorrespondences: 64
};
var roles5 = { "event-instance": "Qualified Event Allocation", "event-listener": "Qualified Event Listener", "event-emission": "Qualified Event Emission" };
var references = { declaration: "Exact Local Allocation Declaration", "import-reference": "Direct Constructor Import" };
var spans2 = { allocation: "Allocation Span", import: "Named Import Specifier Span", receiver: "Direct Receiver Span", "event-literal": "Event Literal Span", callback: "Inline Arrow Callback Span", owner: "Lexical Callable Or Module Span" };
var strings2 = { "event-key": "Exact ASCII Event Key", condition: "Lexical Qualification Limitation" };
var integers = { "endpoint-count": "Full Qualified Allocation Endpoint Count" };
var booleans2 = { "inventory-complete": "Qualified File-Local Reference Inventory", "unit-complete": "Complete Evidence Unit" };
function transportBindingSpan(span2) {
  return `s:${span2.startByte}:${span2.endByte}:${span2.startLine}:${span2.endLine}`;
}
function transportBindingDescriptor(digests) {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error("Transport binding plugin requires build-supplied digests");
  return {
    id: "transport-binding",
    version: "1",
    ...digests,
    languages: ["typescript", "tsx"],
    view: { id: "typescript", version: 1 },
    roles: Object.entries(roles5).map(([name, label]) => ({ id: `transport-binding.${name}`, label })),
    properties: [
      ...Object.entries(references).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: "reference" })),
      ...Object.entries(spans2).map(([name, label]) => ({ id: `transport-binding.${name}`, label, description: "Exact source span locator; never embedded source text.", multiple: true, valueKind: "string" })),
      ...Object.entries(strings2).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: "string" })),
      ...Object.entries(integers).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: "integer" })),
      ...Object.entries(booleans2).map(([name, label]) => ({ id: `transport-binding.${name}`, label, multiple: true, valueKind: "boolean" }))
    ],
    relations: []
  };
}

// src/producers/transport-binding-plugin.ts
var callables2 = /* @__PURE__ */ new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function"]);
var identifierTypes = /* @__PURE__ */ new Set(["identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]);
var same2 = (a, b) => !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
var optional2 = (node) => node.tokens.includes("?.") || node.children.some((child) => child.type === "optional_chain");
function createTransportBindingPlugin(digests) {
  return {
    descriptor: transportBindingDescriptor(digests),
    analyze({ document, view, budget }, emitter) {
      if (view.state !== "complete") return { state: view.state };
      let work = 0, partial = false, truncated = false;
      const diagnostics = [];
      const stop = Symbol("transport-binding-limit");
      const diagnose = (code, node) => {
        partial = true;
        if (diagnostics.some((item) => item.code === `transport-binding.${code}`)) return;
        const message = "File-local transport qualification is incomplete or outside the reviewed contract.";
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) {
          truncated = true;
          return;
        }
        diagnostics.push({ code: `transport-binding.${code}`, message, ...node ? { span: view.span(node) } : {} });
      };
      const limit = (code) => {
        truncated = true;
        diagnose(code);
        throw stop;
      };
      const step = (amount = 1) => {
        work += amount;
        if (work > transportBindingRules.maxWork) limit("work-limit");
        budget.step(amount);
      };
      const locator = (node) => transportBindingSpan(view.span(node));
      const args = (node) => node.fields.arguments?.children.filter((child) => child.type !== "comment") ?? [];
      const binding = (node) => {
        step(transportBindingRules.maxDepth);
        return view.binding(node);
      };
      const endpointOwner = (node) => {
        let child = node, parent = view.parent(child), owner;
        if (!parent || !(parent.type === "expression_statement" || parent.type === "arrow_function" && same2(parent.fields.body, child))) return;
        while (parent) {
          step();
          if (callables2.has(parent.type)) {
            if (!same2(parent.fields.body, child)) return;
            owner ??= parent;
          } else if (!["expression_statement", "statement_block", "program", "variable_declarator", "lexical_declaration", "export_statement", "arguments", "call_expression", "parenthesized_expression"].includes(parent.type)) return;
          child = parent;
          parent = view.parent(parent);
        }
        return owner ?? view.root;
      };
      const staged = [];
      try {
        if (Buffer.byteLength(document.source) > transportBindingRules.maxSourceBytes) limit("source-limit");
        const pending = [[view.root, 0]];
        while (pending.length) {
          const [node, depth] = pending.pop();
          step();
          if (depth > transportBindingRules.maxDepth) limit("depth-limit");
          for (const child of node.children) pending.push([child, depth + 1]);
        }
        const nodeKey2 = (node) => `${node.type}:${node.startIndex}:${node.endIndex}`;
        const imports = /* @__PURE__ */ new Map();
        const importedNames = /* @__PURE__ */ new Set();
        let constructorVeto = false;
        for (const node of view.nodes) {
          step();
          if (identifierTypes.has(node.type) && ["require", "eval"].includes(view.name(node) ?? "")) constructorVeto = true;
          if (node.type === "call_expression") {
            const first = args(node)[0], fn = node.fields.function;
            if (fn?.type === "import" || fn?.fields.property && ["getBuiltinModule", "require", "eval"].includes(view.name(fn.fields.property) ?? "")) constructorVeto = true;
            const endpoint = fn?.type === "member_expression" && fn.fields.property && ["on", "emit"].includes(view.name(fn.fields.property) ?? "");
            if (!endpoint && first?.type === "string" && [transportBindingRules.module, "events"].includes(view.name(first) ?? "")) constructorVeto = true;
          }
          if (node.type !== "import_statement" || !node.fields.source) continue;
          const module = view.moduleIdentity(node.fields.source);
          if (module === "node:module" || module === "module") constructorVeto = true;
          if (module !== transportBindingRules.module && module !== "events") continue;
          if (node.tokens.includes("type")) continue;
          const clause = node.children.find((child) => child.type === "import_clause");
          for (const part of clause?.children ?? []) {
            step();
            if (part.type !== "named_imports") {
              constructorVeto = true;
              continue;
            }
            for (const specifier of part.children) {
              step();
              if (specifier.type === "comment" || specifier.tokens.includes("type")) continue;
              const name = specifier.fields.name, local = specifier.fields.alias ?? name;
              if (module !== transportBindingRules.module || !name || name.type !== "identifier" || view.name(name) !== transportBindingRules.importedName || !local || local.type !== "identifier") {
                constructorVeto = true;
                continue;
              }
              imports.set(nodeKey2(local), specifier);
              importedNames.add(nodeKey2(name));
            }
          }
        }
        if (!imports.size) return { state: "not-applicable" };
        const importFor = (node) => imports.get(nodeKey2(node));
        const instances = [];
        const retained = new Set(view.declarations.map((declaration) => declaration.key));
        for (const node of view.nodes) {
          step();
          if (node.type !== "new_expression" || node.fields.constructor?.type !== "identifier") continue;
          const origin = binding(node.fields.constructor);
          if (!origin || origin.kind !== "import" || origin.typeOnly) continue;
          const imported = importFor(origin.node);
          if (!imported) continue;
          const declarationNode = view.parent(node), container = declarationNode && view.parent(declarationNode);
          const name = declarationNode?.fields.name;
          const declaration = declarationNode && view.declarationAt(declarationNode);
          if (!origin.stable || !origin.available || !node.fields.arguments || args(node).length || node.fields.type_arguments || optional2(node) || declarationNode?.type !== "variable_declarator" || !same2(declarationNode.fields.value, node) || name?.type !== "identifier" || container?.type !== "lexical_declaration" || !container.tokens.includes("const") || !same2(view.parent(container), view.root) || !declaration || declaration.kind !== "const" || declaration.exports.length) {
            constructorVeto = true;
            diagnose("allocation-shape", node);
            continue;
          }
          if (!retained.has(declaration.key)) limit("inventory-limit");
          if (instances.length >= transportBindingRules.maxInstances) limit("instance-limit");
          instances.push({ node: declarationNode, name, allocation: node, declaration: declaration.key, imported, endpoints: [], veto: false });
        }
        let endpoints = 0;
        for (const node of view.nodes) {
          step();
          if (!identifierTypes.has(node.type)) continue;
          const parent = view.parent(node);
          if (view.name(node) === "eval" && parent?.type === "call_expression" && same2(parent.fields.function, node)) {
            constructorVeto = true;
            diagnose("dynamic-scope", node);
          }
          const origin = binding(node);
          if (origin?.kind === "import" && importFor(origin.node)) {
            if (same2(node, origin.node) || importedNames.has(nodeKey2(node))) continue;
            if (!origin.stable || !origin.available || !instances.some((instance2) => same2(instance2.allocation.fields.constructor, node))) {
              constructorVeto = true;
              diagnose("constructor-use", node);
            }
            continue;
          }
          const instance = instances.find((item) => origin?.declaration === item.declaration);
          if (!instance) {
            if (!origin) {
              for (const item of instances) if (view.name(node) === view.name(item.name)) {
                item.veto = true;
                diagnose("ambiguous-reference", node);
              }
            }
            continue;
          }
          if (same2(node, instance.name)) continue;
          const call = parent && view.parent(parent);
          const values = call ? args(call) : [];
          const method = parent?.fields.property && view.name(parent.fields.property);
          const event = values[0], callback2 = method === "on" ? values[1] : void 0;
          const raw = event?.type === "string" ? view.text(event) : "";
          const key3 = raw.slice(1, -1);
          const owner = call && endpointOwner(call);
          if (!origin?.available || !origin.stable || node.type !== "identifier" || parent?.type !== "member_expression" || !same2(parent.fields.object, node) || optional2(parent) || call?.type !== "call_expression" || !same2(call.fields.function, parent) || optional2(call) || call.fields.type_arguments || !owner || !["on", "emit"].includes(method ?? "") || !event || !/^(?:"[\x20-\x21\x23-\x5b\x5d-\x7e]+"|'[\x20-\x26\x28-\x5b\x5d-\x7e]+')$/.test(raw) || Buffer.byteLength(key3) > transportBindingRules.maxEventKeyBytes || transportBindingRules.excludedEvents.some((value4) => value4 === key3) || values.some((value4) => value4.type === "spread_element") || (method === "on" ? values.length !== 2 || callback2?.type !== "arrow_function" : values.length > transportBindingRules.maxEmissionArguments)) {
            instance.veto = true;
            diagnose("receiver-use", node);
            continue;
          }
          if (++endpoints > transportBindingRules.maxEndpoints) limit("endpoint-limit");
          instance.endpoints.push({ node: call, receiver: node, event, key: key3, ...callback2 ? { callback: callback2 } : {}, owner });
        }
        if (constructorVeto) diagnose("constructor-use");
        if (constructorVeto || instances.some((instance) => instance.veto)) return { state: truncated ? "truncated" : "partial", diagnostics };
        const string = (value4) => ({ kind: "string", value: value4 });
        let facts = 0;
        for (const instance of instances) {
          step();
          if (!instance.endpoints.length) continue;
          const common = [
            ["declaration", { kind: "reference", value: { kind: "declaration", key: instance.declaration } }],
            ["import-reference", { kind: "reference", value: { kind: "import", module: transportBindingRules.module, name: transportBindingRules.importedName } }],
            ["allocation", string(locator(instance.allocation))],
            ["import", string(locator(instance.imported))],
            ...transportBindingRules.conditions.map((condition) => ["condition", string(condition)])
          ];
          const units = [
            { node: instance.allocation, role: "event-instance", ruleId: transportBindingRules.rules[0], properties: [["owner", string(locator(view.root))], ["endpoint-count", { kind: "integer", value: instance.endpoints.length }]] },
            ...instance.endpoints.map((endpoint) => ({ node: endpoint.node, role: endpoint.callback ? "event-listener" : "event-emission", ruleId: endpoint.callback ? transportBindingRules.rules[1] : transportBindingRules.rules[2], properties: [
              ["owner", string(locator(endpoint.owner))],
              ["receiver", string(locator(endpoint.receiver))],
              ["event-literal", string(locator(endpoint.event))],
              ["event-key", string(endpoint.key)],
              ...endpoint.callback ? [["callback", string(locator(endpoint.callback))]] : []
            ] }))
          ];
          for (const unit of units) {
            const subject = view.owner(unit.node)?.key ?? limit("inventory-limit");
            if (!retained.has(subject)) limit("inventory-limit");
            const properties4 = [...common, ...unit.properties, ["inventory-complete", { kind: "boolean", value: true }], ["unit-complete", { kind: "boolean", value: true }]];
            facts += properties4.length + 1;
            if (facts > transportBindingRules.maxFacts) limit("fact-limit");
            if (properties4.some(([, value4]) => Buffer.byteLength(canonicalJSON(value4)) > view.limits.maxValueBytes)) limit("value-limit");
            staged.push({ ...unit, subject, properties: properties4 });
          }
        }
        for (const unit of staged) {
          step();
          const evidence = { ruleId: unit.ruleId, basis: "import-bound", span: view.span(unit.node) };
          if (!emitter.role(unit.subject, `transport-binding.${unit.role}`, evidence)) limit("output-limit");
          for (const [property, value4] of unit.properties) {
            step();
            if (!emitter.property(unit.subject, `transport-binding.${property}`, "literal", value4, evidence)) limit("output-limit");
          }
        }
      } catch (error) {
        if (error !== stop) throw error;
      }
      return { state: truncated ? "truncated" : partial ? "partial" : staged.length ? "complete" : "not-applicable", diagnostics };
    }
  };
}

// src/producers/validation-contract-vocabulary.ts
var validationContractRules = {
  version: 1,
  spanEncoding: "s:utf8-start:utf8-end:start-line:end-line",
  rules: ["zod-object-parse-v1", "zod-object-safe-parse-v1", "zod-value-kind-v1", "zod-minimum-v1", "zod-maximum-v1"],
  module: "zod",
  importedName: "z",
  reviewedAPI: "zod-v4.1.12",
  contractID: "zod-v4.1.12-primitive-object-v1",
  reviewedSources: [
    "https://raw.githubusercontent.com/colinhacks/zod/v4.1.12/packages/zod/src/v4/core/checks.ts",
    "https://raw.githubusercontent.com/colinhacks/zod/v4.1.12/packages/zod/src/v4/core/parse.ts"
  ],
  conditions: ["reviewed-api-assumed", "reviewed-zod-utf16-api-assumed", "installed-version-not-captured", "external-mutation-not-observed", "execution-not-observed"],
  limitations: ["unknown-object-keys-not-strict", "number-finiteness-not-claimed", "number-integrality-not-claimed"],
  modes: { parse: { condition: "normal-validation-return", returnTarget: "return" }, safeParse: { condition: "success-true", returnTarget: "return.data" } },
  predicates: ["value_kind", "minimum", "maximum"],
  valueKinds: ["string", "number", "boolean"],
  metrics: ["value-kind", "utf16-length", "numeric-value"],
  numericLiteral: "-?[ \\t\\r\\n]*(0|[1-9][0-9]*)",
  maxSourceBytes: 256 * 1024,
  maxWork: 1e5,
  maxDepth: 64,
  maxFields: 8,
  maxUses: 8,
  maxAtoms: 128,
  maxFacts: 1024,
  maxFieldKeyBytes: 128,
  maxIdentifierBytes: 128
};
var roles6 = { "validation-use": "Qualified Inline Validation Use", "validation-predicate": "Source-Declared Validation Predicate" };
var references2 = { "import-reference": "Exact Named Zod Import" };
var spans3 = { import: "Named Import Specifier", owner: "Exact Lexical Callable", parameter: "Required Parameter Identifier", argument: "Exact Parameter Argument", schema: "Inline Object Schema Call", call: "Validation Call", return: "Sole Return Or Arrow Expression", key: "Field Key", type: "Primitive Method", method: "Validation Or Predicate Method", bound: "Numeric Bound Literal" };
var strings3 = { mode: "Parse Mode", "return-target": "Conditional Return Target", condition: "Reviewed Contract Condition", "field-key": "Identifier Field Key", predicate: "Closed Predicate Kind", "value-kind": "Closed Primitive Kind", metric: "Closed Predicate Metric" };
var integers2 = { "predicate-count": "Complete Use Predicate Census", "use-count": "Complete Source Use Census", "bound-value": "Literal Safe Integer Bound" };
var booleans3 = { "inventory-complete": "Full Import Usage Inventory", "unit-complete": "Whole Qualified Evidence Unit" };
function validationContractSpan(span2) {
  return `s:${span2.startByte}:${span2.endByte}:${span2.startLine}:${span2.endLine}`;
}
function validationContractDescriptor(digests) {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error("Validation contract plugin requires build-supplied digests");
  return {
    id: "validation-contract",
    version: "1",
    ...digests,
    languages: ["typescript", "tsx"],
    view: { id: "typescript", version: 1 },
    roles: Object.entries(roles6).map(([name, label]) => ({ id: `validation-contract.${name}`, label })),
    properties: [
      ...Object.entries(references2).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: "reference" })),
      ...Object.entries(spans3).map(([name, label]) => ({ id: `validation-contract.${name}`, label, description: "Exact source span locator, never embedded source text.", multiple: true, valueKind: "string" })),
      ...Object.entries(strings3).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: "string" })),
      ...Object.entries(integers2).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: "integer" })),
      ...Object.entries(booleans3).map(([name, label]) => ({ id: `validation-contract.${name}`, label, multiple: true, valueKind: "boolean" }))
    ],
    relations: []
  };
}

// src/producers/validation-contract-plugin.ts
var same3 = (a, b) => !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
var nodeKey = (node) => `${node.type}:${node.startIndex}:${node.endIndex}`;
var identifiers = /* @__PURE__ */ new Set(["identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]);
var dynamicReferences = /* @__PURE__ */ new Set(["eval", "Function", "require", "getBuiltinModule", "createRequire"]);
var ambientObjects = /* @__PURE__ */ new Set(["globalThis", "global", "window", "self", "module"]);
var optional3 = (node) => node.tokens.includes("?.") || node.children.some((child) => child.type === "optional_chain");
function createValidationContractPlugin(digests) {
  return {
    descriptor: validationContractDescriptor(digests),
    analyze({ document, view, budget }, emitter) {
      if (view.state !== "complete") return { state: view.state };
      let work = 0, truncated = false, veto = false;
      const diagnostics = [];
      const stop = Symbol("validation-contract-limit");
      const diagnose = (code, node) => {
        veto = true;
        if (diagnostics.some((item) => item.code === `validation-contract.${code}`)) return;
        const message = "File-local validation qualification is incomplete or outside the reviewed contract.";
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) {
          truncated = true;
          return;
        }
        diagnostics.push({ code: `validation-contract.${code}`, message, ...node ? { span: view.span(node) } : {} });
      };
      const limit = (code) => {
        truncated = true;
        diagnose(code);
        throw stop;
      };
      const step = (amount = 1) => {
        work += amount;
        if (work > validationContractRules.maxWork) limit("work-limit");
        budget.step(amount);
      };
      const binding = (node) => {
        step(validationContractRules.maxDepth);
        return view.binding(node);
      };
      const children = (node) => node.children.filter((child) => child.type !== "comment");
      const identifier2 = (node) => /^[$A-Z_a-z][$\w]*$/.test(view.text(node)) && Buffer.byteLength(view.text(node)) <= validationContractRules.maxIdentifierBytes;
      const dynamicExposure = (node) => {
        if (identifiers.has(node.type)) {
          const name2 = view.name(node) ?? "";
          if (dynamicReferences.has(name2) || ambientObjects.has(name2)) return true;
          if (name2 === "process") {
            const env = view.parent(node), access = env && view.parent(env);
            return !(env?.type === "member_expression" && same3(env.fields.object, node) && !optional3(env) && env.fields.property && view.name(env.fields.property) === "env" && access?.type === "member_expression" && same3(access.fields.object, env) && !optional3(access) && access.fields.property?.type === "property_identifier");
          }
        }
        const property = node.type === "member_expression" ? node.fields.property : node.type === "subscript_expression" ? node.fields.index : node.type === "pair_pattern" ? node.fields.key : void 0;
        const name = property && view.name(property);
        return node.type === "import" || !!name && (dynamicReferences.has(name) || name === "constructor");
      };
      const args = (node) => node.fields.arguments ? children(node.fields.arguments) : [];
      const memberCall = (node) => {
        if (!node || node.type !== "call_expression" || !node.fields.arguments || node.fields.type_arguments || optional3(node)) return;
        const fn = node.fields.function;
        if (fn?.type !== "member_expression" || optional3(fn) || fn.fields.property?.type !== "property_identifier" || !fn.fields.object) return;
        return { receiver: fn.fields.object, method: fn.fields.property, name: view.text(fn.fields.property), args: args(node) };
      };
      const staged = [];
      try {
        if (Buffer.byteLength(document.source) > validationContractRules.maxSourceBytes) limit("source-limit");
        const pending = [[view.root, 0]];
        while (pending.length) {
          const [node, depth] = pending.pop();
          step();
          if (depth > validationContractRules.maxDepth) limit("depth-limit");
          for (const child of node.children) pending.push([child, depth + 1]);
        }
        const imports = /* @__PURE__ */ new Map(), importTokens = /* @__PURE__ */ new Set(), importNames = /* @__PURE__ */ new Set();
        for (const node of view.nodes) {
          step();
          if (dynamicExposure(node)) diagnose("dynamic-scope", node);
          if (node.type !== "import_statement" || !node.fields.source || node.tokens.includes("type")) continue;
          const module = view.moduleIdentity(node.fields.source);
          if (module === "node:module" || module === "module") diagnose("dynamic-scope", node);
          if (module !== validationContractRules.module && !module?.startsWith("zod/")) continue;
          const clause = node.children.find((child) => child.type === "import_clause");
          for (const part of clause ? children(clause) : []) {
            if (part.type !== "named_imports") {
              diagnose("import-shape", part);
              continue;
            }
            for (const specifier of children(part)) {
              step();
              if (specifier.tokens.includes("type")) continue;
              const name = specifier.fields.name, local = specifier.fields.alias ?? name;
              if (module !== validationContractRules.module || !name || view.text(name) !== validationContractRules.importedName || name.type !== "identifier" || local?.type !== "identifier" || !identifier2(local)) {
                diagnose("import-shape", specifier);
                continue;
              }
              imports.set(nodeKey(local), specifier);
              importNames.add(view.name(local));
              importTokens.add(nodeKey(local));
              importTokens.add(nodeKey(name));
            }
          }
        }
        if (!imports.size) return { state: "not-applicable" };
        const importedAt = (node) => {
          if (node.type !== "identifier") return;
          const origin = binding(node);
          if (origin?.kind === "import" && !origin.typeOnly && origin.available && origin.stable) return imports.get(nodeKey(origin.node));
        };
        const allowed = /* @__PURE__ */ new Set(), uses = [];
        const retained = new Set(view.declarations.map((declaration) => declaration.key));
        let atomCount = 0;
        for (const node of view.nodes) {
          step();
          const call = memberCall(node);
          if (!call || call.name !== "parse" && call.name !== "safeParse") continue;
          const schema = memberCall(call.receiver);
          if (!schema || schema.name !== "object") continue;
          const imported = importedAt(schema.receiver);
          if (!imported) continue;
          const shape = schema.args[0];
          if (schema.args.length !== 1 || shape?.type !== "object" || call.args.length !== 1 || call.args[0]?.type !== "identifier") {
            diagnose("schema-shape", node);
            continue;
          }
          let returned = node, owner = view.parent(node);
          if (owner?.type === "return_statement") {
            returned = owner;
            const block = view.parent(owner);
            owner = block && view.parent(block);
            if (block?.type !== "statement_block" || children(block).length !== 1 || !owner || !same3(owner.fields.body, block)) {
              diagnose("owner-shape", node);
              continue;
            }
          } else if (owner?.type !== "arrow_function" || !same3(owner.fields.body, node)) {
            diagnose("owner-shape", node);
            continue;
          }
          if (!["function_declaration", "function_expression", "arrow_function"].includes(owner.type) || owner.tokens.includes("async") || owner.fields.type_parameters) {
            diagnose("owner-shape", owner);
            continue;
          }
          const formal = owner.fields.parameters ?? owner.fields.parameter;
          const parameters = formal?.type === "formal_parameters" ? children(formal) : formal ? [formal] : [];
          const parameter = parameters[0]?.type === "required_parameter" ? parameters[0].fields.pattern : parameters[0];
          if (parameters.length !== 1 || parameter?.type !== "identifier" || !identifier2(parameter) || parameters[0]?.fields.value || parameters[0]?.tokens.includes("?") || parameters[0]?.tokens.includes("=")) {
            diagnose("parameter-shape", owner);
            continue;
          }
          const argument = call.args[0], origin = binding(argument);
          if (origin?.kind !== "parameter" || !origin.available || !same3(origin.node, parameter) || view.text(argument) !== view.text(parameter)) {
            diagnose("argument-binding", argument);
            continue;
          }
          let ancestor = view.parent(owner), placement = true;
          while (ancestor) {
            step();
            if (["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "try_statement", "catch_clause", "switch_statement", "ternary_expression", "binary_expression", "method_definition", "class_static_block"].includes(ancestor.type)) placement = false;
            ancestor = view.parent(ancestor);
          }
          if (!placement) {
            diagnose("owner-placement", owner);
            continue;
          }
          const fields = children(shape);
          if (fields.length > validationContractRules.maxFields) limit("field-limit");
          if (!fields.length) {
            diagnose("schema-shape", shape);
            continue;
          }
          const keys = /* @__PURE__ */ new Set(), atoms = [], accepted = [schema.receiver];
          let valid = true;
          for (const field of fields) {
            step();
            const key3 = field.fields.key, value4 = field.fields.value;
            const keyText = key3 ? view.text(key3) : "";
            if (field.type !== "pair" || key3?.type !== "property_identifier" || !/^[$A-Z_a-z][$\w]*$/.test(keyText) || Buffer.byteLength(keyText) > validationContractRules.maxFieldKeyBytes || keyText === "__proto__" || keys.has(keyText) || !value4) {
              valid = false;
              break;
            }
            keys.add(keyText);
            let current = value4, primitive2 = memberCall(current);
            const bounds = [];
            const methods2 = /* @__PURE__ */ new Set();
            while (primitive2 && ["min", "max"].includes(primitive2.name)) {
              step();
              const bound = primitive2.args[0];
              const negative = bound?.type === "unary_expression" && bound.tokens.length === 1 && bound.tokens[0] === "-";
              const number = negative ? bound.fields.argument : bound;
              const raw = number?.type === "number" ? view.text(number) : "";
              const numeric = Number(raw) * (negative ? -1 : 1);
              if (primitive2.args.length !== 1 || !bound || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(numeric) || methods2.has(primitive2.name)) {
                valid = false;
                break;
              }
              if (negative && !/^-[ \t\r\n]*(0|[1-9][0-9]*)$/.test(view.text(bound))) {
                valid = false;
                break;
              }
              methods2.add(primitive2.name);
              bounds.push({ node: current, method: primitive2.method, bound, value: numeric === 0 ? 0 : numeric, predicate: primitive2.name === "min" ? "minimum" : "maximum" });
              current = primitive2.receiver;
              primitive2 = memberCall(current);
            }
            if (!valid || !primitive2 || !["string", "number", "boolean"].includes(primitive2.name) || primitive2.args.length || !same3(importedAt(primitive2.receiver), imported)) {
              valid = false;
              break;
            }
            const kind = primitive2.name;
            if (bounds.length && kind === "boolean" || kind === "string" && bounds.some((bound) => bound.value < 0)) {
              valid = false;
              break;
            }
            atoms.push({ node: current, key: key3, type: primitive2.method, method: primitive2.method, kind, predicate: "value_kind" });
            for (const bound of bounds.reverse()) atoms.push({ ...bound, key: key3, type: primitive2.method, kind });
            accepted.push(primitive2.receiver);
          }
          if (!valid) {
            diagnose("predicate-shape", shape);
            continue;
          }
          if (uses.length >= validationContractRules.maxUses) limit("use-limit");
          atomCount += atoms.length;
          if (atomCount > validationContractRules.maxAtoms) limit("atom-limit");
          const subject = view.owner(node)?.key ?? limit("inventory-limit");
          if (!retained.has(subject)) limit("inventory-limit");
          for (const identifier3 of accepted) allowed.add(nodeKey(identifier3));
          uses.push({ node, schema: call.receiver, method: call.method, mode: call.name, imported, owner, parameter, argument, returned, atoms, subject });
        }
        for (const node of view.nodes) {
          step();
          if (!identifiers.has(node.type) || importTokens.has(nodeKey(node))) continue;
          const origin = binding(node);
          if (origin?.kind === "import" && imports.has(nodeKey(origin.node))) {
            if (!origin.stable || !origin.available || origin.typeOnly || !allowed.has(nodeKey(node))) diagnose("import-use", node);
          } else if (!origin && importNames.has(view.name(node) ?? "")) diagnose("ambiguous-reference", node);
        }
        if (veto) return { state: truncated ? "truncated" : "partial", diagnostics };
        const string = (value4) => ({ kind: "string", value: value4 });
        const span2 = (node) => string(validationContractSpan(view.span(node)));
        let facts = 0;
        const stage = (use, node, role, ruleId, properties4) => {
          properties4.push(["unit-complete", { kind: "boolean", value: true }]);
          facts += properties4.length + 1;
          if (facts > validationContractRules.maxFacts) limit("fact-limit");
          if (properties4.some(([, value4]) => Buffer.byteLength(canonicalJSON(value4)) > view.limits.maxValueBytes)) limit("value-limit");
          staged.push({ node, subject: use.subject, role, ruleId, properties: properties4 });
        };
        for (const use of uses) {
          step();
          stage(use, use.node, "validation-use", use.mode === "parse" ? validationContractRules.rules[0] : validationContractRules.rules[1], [
            ["import-reference", { kind: "reference", value: { kind: "import", module: validationContractRules.module, name: validationContractRules.importedName } }],
            ["import", span2(use.imported)],
            ["owner", span2(use.owner)],
            ["parameter", span2(use.parameter)],
            ["argument", span2(use.argument)],
            ["schema", span2(use.schema)],
            ["call", span2(use.node)],
            ["return", span2(use.returned)],
            ["method", span2(use.method)],
            ["mode", string(use.mode)],
            ["return-target", string(validationContractRules.modes[use.mode].returnTarget)],
            ["predicate-count", { kind: "integer", value: use.atoms.length }],
            ["use-count", { kind: "integer", value: uses.length }],
            ...[...validationContractRules.conditions, validationContractRules.modes[use.mode].condition].map((condition) => ["condition", string(condition)]),
            ["inventory-complete", { kind: "boolean", value: true }]
          ]);
          for (const atom of use.atoms) {
            step();
            stage(use, atom.node, "validation-predicate", atom.predicate === "value_kind" ? validationContractRules.rules[2] : atom.predicate === "minimum" ? validationContractRules.rules[3] : validationContractRules.rules[4], [
              ["call", span2(use.node)],
              ["field-key", string(view.text(atom.key))],
              ["key", span2(atom.key)],
              ["type", span2(atom.type)],
              ["method", span2(atom.method)],
              ["predicate", string(atom.predicate)],
              ["value-kind", string(atom.kind)],
              ["metric", string(atom.predicate === "value_kind" ? "value-kind" : atom.kind === "string" ? "utf16-length" : "numeric-value")],
              ...atom.bound ? [["bound", span2(atom.bound)], ["bound-value", { kind: "integer", value: atom.value }]] : []
            ]);
          }
        }
        for (const unit of staged) {
          step();
          const evidence = { ruleId: unit.ruleId, basis: "import-bound", span: view.span(unit.node) };
          if (!emitter.role(unit.subject, `validation-contract.${unit.role}`, evidence)) limit("output-limit");
          for (const [property, value4] of unit.properties) {
            step();
            if (!emitter.property(unit.subject, `validation-contract.${property}`, "literal", value4, evidence)) limit("output-limit");
          }
        }
      } catch (error) {
        if (error !== stop) throw error;
      }
      return { state: truncated ? "truncated" : veto ? "partial" : staged.length ? "complete" : "not-applicable", diagnostics };
    }
  };
}

// src/producers/dispatch-binding-vocabulary.ts
var dispatchBindingRules = {
  version: 1,
  spanEncoding: "s:utf8-start:utf8-end:start-line:end-line",
  rules: ["elysia-app-v1", "elysia-route-v1", "elysia-handle-v1", "trpc-router-v1", "trpc-procedure-v1", "trpc-caller-v1", "trpc-call-v1"],
  http: { module: "elysia", name: "Elysia", assumption: "elysia-1.3.21-in-process-v1", methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] },
  rpc: { module: "@trpc/server", name: "initTRPC", assumption: "trpc-11.4.3-in-process-v1", kinds: ["query", "mutation"], reserved: ["__proto__", "constructor", "prototype", "then", "call", "apply", "_def", "createCaller"] },
  request: { module: "undici", name: "Request", reviewedAPI: "undici-7.13.0-request", origins: ["ambient-fetch", "undici-named"] },
  reviewedSources: [
    "https://raw.githubusercontent.com/elysiajs/elysia/1.3.21/src/index.ts",
    "https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/initTRPC.ts",
    "https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/procedureBuilder.ts",
    "https://raw.githubusercontent.com/trpc/trpc/v11.4.3/packages/server/src/unstable-core-do-not-import/router.ts",
    "https://raw.githubusercontent.com/nodejs/undici/v7.13.0/lib/web/fetch/request.js"
  ],
  conditions: ["lexical-binding-only", "reviewed-api-assumed", "installed-version-not-captured", "execution-not-observed", "external-mutation-not-observed", "runtime-not-observed", "registration-order-unknown", "registered-at-dispatch-required", "potential-correspondence-only"],
  httpConditions: ["standard-request-api-assumed", "deployment-not-observed", "url-origin-not-a-binding"],
  rpcConditions: ["input-result-semantics-unknown", "procedure-kind-not-side-effect-proof", "network-serialization-not-implied"],
  pathPattern: "^/(?:[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)?$",
  maxSourceBytes: 256 * 1024,
  maxWork: 1e5,
  maxDepth: 64,
  maxFamilies: 8,
  maxEndpoints: 32,
  maxFacts: 2048,
  maxArguments: 16,
  maxCallersPerFamily: 1,
  maxPathBytes: 256,
  maxURLBytes: 1024,
  maxIdentifierBytes: 128,
  maxPairCandidates: 1024,
  maxPairs: 64
};
var roles7 = { "dispatch-family": "Qualified In-Process Binding Family", "dispatch-handler": "Registered In-Process Handler", "dispatch-caller": "Exact Local RPC Caller", "dispatch-call": "Potential In-Process Dispatch" };
var references3 = { declaration: "Exact Family Declaration", "import-reference": "Exact Framework Import", "initializer-declaration": "RPC Initializer Declaration", "caller-declaration": "Exact Caller Declaration", "request-import-reference": "Named Request Import" };
var spans4 = { allocation: "Family Allocation", import: "Named Import Specifier", initializer: "RPC Initialization", owner: "Lexical Callable Or Module", receiver: "Direct Receiver", selector: "Path URL Or Procedure Selector", method: "API Method Token", "method-literal": "Explicit Request Method", handler: "Inline Handler", argument: "Exact Argument", request: "Request Allocation", "request-constructor": "Request Constructor", "request-import": "Request Import Specifier", caller: "Caller Allocation", context: "Empty Caller Context" };
var strings4 = { family: "Closed Dispatch Family", "api-assumption": "Reviewed API Assumption", "http-method": "Exact HTTP Method", path: "Simple Path Only", "procedure-key": "Exact Procedure Key", "procedure-kind": "Declared Procedure Kind", "request-origin": "Qualified Request Origin", condition: "Conditional Qualification Limitation" };
var integers3 = { "family-count": "Whole Source Family Census", "endpoint-count": "Whole Family Endpoint Census", "caller-count": "Whole Family Caller Census", "argument-count": "Exact Argument Census" };
var booleans4 = { "inventory-complete": "Complete File-Local Use Inventory", "unit-complete": "Complete Evidence Unit" };
function dispatchBindingSpan(span2) {
  return `s:${span2.startByte}:${span2.endByte}:${span2.startLine}:${span2.endLine}`;
}
function dispatchBindingDescriptor(digests) {
  if (!/^[0-9a-f]{64}$/.test(digests.implementationDigest) || !/^[0-9a-f]{64}$/.test(digests.configurationDigest)) throw new Error("Dispatch binding plugin requires build-supplied digests");
  return {
    id: "dispatch-binding",
    version: "1",
    ...digests,
    languages: ["typescript", "tsx"],
    view: { id: "typescript", version: 1 },
    roles: Object.entries(roles7).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label })),
    properties: [
      ...Object.entries(references3).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: "reference" })),
      ...Object.entries(spans4).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, description: "Exact source locator, never embedded source text.", multiple: true, valueKind: "string" })),
      ...Object.entries(strings4).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: "string" })),
      ...Object.entries(integers3).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: "integer" })),
      ...Object.entries(booleans4).map(([name, label]) => ({ id: `dispatch-binding.${name}`, label, multiple: true, valueKind: "boolean" }))
    ],
    relations: []
  };
}

// src/producers/dispatch-binding-plugin.ts
var same4 = (a, b) => !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
var key2 = (node) => `${node.type}:${node.startIndex}:${node.endIndex}`;
var identifiers2 = /* @__PURE__ */ new Set(["identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]);
var callables3 = /* @__PURE__ */ new Set(["function_declaration", "function_expression", "arrow_function"]);
var dynamicReferences2 = /* @__PURE__ */ new Set(["eval", "Function", "require", "getBuiltinModule", "createRequire"]);
var ambientObjects2 = /* @__PURE__ */ new Set(["globalThis", "global", "window", "self", "module"]);
var optional4 = (node) => node.tokens.includes("?.") || node.children.some((child) => child.type === "optional_chain");
function createDispatchBindingPlugin(digests) {
  return {
    descriptor: dispatchBindingDescriptor(digests),
    analyze({ document, view, budget }, emitter) {
      if (view.state !== "complete") return { state: view.state };
      let work = 0, veto = false, truncated = false, endpointCount = 0;
      const diagnostics = [], stop = Symbol("dispatch-binding-limit");
      const diagnose = (code, node) => {
        veto = true;
        if (diagnostics.some((item) => item.code === `dispatch-binding.${code}`)) return;
        const message = "File-local dispatch qualification is incomplete or outside the reviewed in-process contract.";
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) {
          truncated = true;
          return;
        }
        diagnostics.push({ code: `dispatch-binding.${code}`, message, ...node ? { span: view.span(node) } : {} });
      };
      const limit = (code) => {
        truncated = true;
        diagnose(code);
        throw stop;
      };
      const step = (amount = 1) => {
        work += amount;
        if (work > dispatchBindingRules.maxWork) limit("work-limit");
        budget.step(amount);
      };
      const binding = (node) => {
        step(dispatchBindingRules.maxDepth);
        return view.binding(node);
      };
      const children = (node) => node.children.filter((child) => child.type !== "comment");
      const args = (node) => node.fields.arguments ? children(node.fields.arguments) : [];
      const string = (value4) => ({ kind: "string", value: value4 });
      const integer2 = (value4) => ({ kind: "integer", value: value4 });
      const span2 = (node) => string(dispatchBindingSpan(view.span(node)));
      const reference = (declaration) => ({ kind: "reference", value: { kind: "declaration", key: declaration } });
      const identifier2 = (node) => /^[$A-Z_a-z][$\w]*$/.test(view.text(node)) && Buffer.byteLength(view.text(node)) <= dispatchBindingRules.maxIdentifierBytes;
      const literal = (node) => {
        const raw = node?.type === "string" ? view.text(node) : "";
        return /^(?:"[\x20-\x21\x23-\x5b\x5d-\x7e]*"|'[\x20-\x26\x28-\x5b\x5d-\x7e]*')$/.test(raw) ? raw.slice(1, -1) : void 0;
      };
      const path = (value4) => value4 !== void 0 && Buffer.byteLength(value4) <= dispatchBindingRules.maxPathBytes && /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(value4);
      const member = (node) => {
        if (node?.type !== "member_expression" || optional4(node) || node.fields.property?.type !== "property_identifier" || !identifier2(node.fields.property) || !node.fields.object) return;
        return { receiver: node.fields.object, method: node.fields.property, name: view.text(node.fields.property) };
      };
      const call = (node) => {
        if (node?.type !== "call_expression" || !node.fields.arguments || node.fields.type_arguments || optional4(node)) return;
        const target = member(node.fields.function);
        return target && { ...target, args: args(node) };
      };
      const dynamicExposure = (node) => {
        if (identifiers2.has(node.type)) {
          const name2 = view.name(node) ?? "";
          if (dynamicReferences2.has(name2) || ambientObjects2.has(name2)) return true;
          if (name2 === "process") {
            const env = view.parent(node), access = env && view.parent(env);
            return !(env?.type === "member_expression" && same4(env.fields.object, node) && !optional4(env) && env.fields.property && view.name(env.fields.property) === "env" && access?.type === "member_expression" && same4(access.fields.object, env) && !optional4(access) && access.fields.property?.type === "property_identifier");
          }
        }
        const property = node.type === "member_expression" ? node.fields.property : node.type === "subscript_expression" ? node.fields.index : node.type === "pair_pattern" ? node.fields.key : void 0;
        const name = property && view.name(property);
        return node.type === "import" || !!name && (dynamicReferences2.has(name) || name === "constructor");
      };
      const owner = (node, registration = false) => {
        let child = node, parent = view.parent(node), result;
        if (!registration && parent?.type === "await_expression") {
          child = parent;
          parent = view.parent(parent);
        }
        if (!parent || !(parent.type === "expression_statement" || !registration && (parent.type === "return_statement" || parent.type === "arrow_function" && same4(parent.fields.body, child) || parent.type === "variable_declarator" && same4(parent.fields.value, child)))) return;
        while (parent) {
          step();
          if (callables3.has(parent.type)) {
            if (!same4(parent.fields.body, child)) return;
            result ??= parent;
          } else if (!["program", "statement_block", "expression_statement", "return_statement", "variable_declarator", "lexical_declaration", "export_statement"].includes(parent.type)) return;
          child = parent;
          parent = view.parent(parent);
        }
        return result ?? view.root;
      };
      const staged = [];
      try {
        if (Buffer.byteLength(document.source) > dispatchBindingRules.maxSourceBytes) limit("source-limit");
        const pending = [[view.root, 0]];
        while (pending.length) {
          const [node, depth] = pending.pop();
          step();
          if (depth > dispatchBindingRules.maxDepth) limit("depth-limit");
          for (const child of node.children) pending.push([child, depth + 1]);
        }
        const imports = /* @__PURE__ */ new Map(), importTokens = /* @__PURE__ */ new Set(), names = /* @__PURE__ */ new Set();
        for (const node of view.nodes) {
          step();
          if (dynamicExposure(node)) diagnose("dynamic-scope", node);
          if (node.type !== "import_statement" || !node.fields.source || node.tokens.includes("type")) continue;
          const module = view.moduleIdentity(node.fields.source);
          if (module === "node:module" || module === "module" || module === "node:vm" || module === "vm") diagnose("dynamic-scope", node);
          const api = [dispatchBindingRules.http, dispatchBindingRules.rpc, dispatchBindingRules.request].find((api2) => module === api2.module);
          if (!api) {
            if (module && [dispatchBindingRules.http, dispatchBindingRules.rpc, dispatchBindingRules.request].some((api2) => module.startsWith(`${api2.module}/`))) diagnose("import-shape", node);
            continue;
          }
          const clause = node.children.find((child) => child.type === "import_clause");
          if (!clause) {
            diagnose("import-shape", node);
            continue;
          }
          for (const part of children(clause)) {
            step();
            if (part.type !== "named_imports") {
              diagnose("import-shape", part);
              continue;
            }
            for (const specifier of children(part)) {
              step();
              if (specifier.tokens.includes("type")) continue;
              const imported = specifier.fields.name, local2 = specifier.fields.alias ?? imported;
              if (imported?.type !== "identifier" || view.text(imported) !== api.name || local2?.type !== "identifier" || !identifier2(local2)) {
                diagnose("import-shape", specifier);
                continue;
              }
              imports.set(key2(local2), { node: specifier, module: api.module, name: api.name });
              importTokens.add(key2(local2));
              importTokens.add(key2(imported));
              names.add(view.name(local2));
            }
          }
        }
        if (![...imports.values()].some((imported) => imported.module !== dispatchBindingRules.request.module)) return { state: "not-applicable" };
        const allowed = /* @__PURE__ */ new Set(), declarations = /* @__PURE__ */ new Set(), tracked = /* @__PURE__ */ new Set();
        const retained = new Set(view.declarations.map((declaration) => declaration.key));
        const importedAt = (node, module) => {
          if (node?.type !== "identifier" || !identifier2(node)) return;
          const origin = binding(node), imported = origin?.kind === "import" ? imports.get(key2(origin.node)) : void 0;
          return origin?.available && origin.stable && !origin.typeOnly && imported?.module === module ? imported : void 0;
        };
        const local = (allocation) => {
          const node = view.parent(allocation), container = node && view.parent(node), name = node?.fields.name;
          const declaration = node && view.declarationAt(node);
          if (node?.type !== "variable_declarator" || !same4(node.fields.value, allocation) || name?.type !== "identifier" || !identifier2(name) || container?.type !== "lexical_declaration" || !container.tokens.includes("const") || !same4(view.parent(container), view.root) || !declaration || declaration.kind !== "const" || declaration.exports.length) {
            diagnose("allocation-shape", allocation);
            return;
          }
          if (!retained.has(declaration.key)) limit("inventory-limit");
          tracked.add(declaration.key);
          declarations.add(key2(name));
          names.add(view.name(name));
          return { node, name, allocation, declaration: declaration.key };
        };
        const declarationOf = (node) => {
          if (node?.type !== "identifier" || !identifier2(node)) return;
          const origin = binding(node);
          return origin?.available && origin.stable ? origin.declaration : void 0;
        };
        const families2 = [], initializers = [];
        const addFamily = (family) => {
          if (families2.length >= dispatchBindingRules.maxFamilies) limit("family-limit");
          families2.push(family);
        };
        const addEndpoint = (family, endpoint) => {
          if (++endpointCount > dispatchBindingRules.maxEndpoints) limit("endpoint-limit");
          family.endpoints.push(endpoint);
        };
        const argumentProperties = (values) => [["argument-count", integer2(values.length)], ...values.map((value4) => ["argument", span2(value4)])];
        for (const node of view.nodes) {
          step();
          const ctor = node.fields.constructor, imported = node.type === "new_expression" ? importedAt(ctor, dispatchBindingRules.http.module) : void 0;
          if (imported && ctor) {
            if (!node.fields.arguments || args(node).length || node.fields.type_arguments || optional4(node)) {
              diagnose("allocation-shape", node);
              continue;
            }
            const declaration = local(node);
            if (declaration) {
              allowed.add(key2(ctor));
              addFamily({ ...declaration, imported, kind: "elysia-http", endpoints: [] });
            }
          }
          const invocation = call(node), initImport = invocation?.name === "create" ? importedAt(invocation.receiver, dispatchBindingRules.rpc.module) : void 0;
          if (invocation && initImport) {
            if (invocation.args.length) {
              diagnose("initializer-shape", node);
              continue;
            }
            const declaration = local(node);
            if (declaration) {
              if (initializers.length >= dispatchBindingRules.maxFamilies) limit("family-limit");
              allowed.add(key2(invocation.receiver));
              initializers.push({ ...declaration, imported: initImport });
            }
          }
        }
        for (const node of view.nodes) {
          step();
          const invocation = call(node);
          if (!invocation || invocation.name !== "router") continue;
          const declaration = declarationOf(invocation.receiver), initializer = initializers.find((init) => init.declaration === declaration);
          if (!initializer) continue;
          const shape = invocation.args[0], bindingLocal = local(node);
          if (!bindingLocal || invocation.args.length !== 1 || shape?.type !== "object" || !children(shape).length) {
            diagnose("router-shape", node);
            continue;
          }
          const family = { ...bindingLocal, imported: initializer.imported, initializer, kind: "trpc-rpc", endpoints: [] }, keys = /* @__PURE__ */ new Set();
          for (const field of children(shape)) {
            step();
            const selector = field.fields.key, procedure = field.fields.value, invocation2 = call(procedure);
            const builder = invocation2 && member(invocation2.receiver), handler = invocation2?.args[0];
            if (field.type !== "pair" || selector?.type !== "property_identifier" || !identifier2(selector) || dispatchBindingRules.rpc.reserved.some((value4) => value4 === view.text(selector)) || keys.has(view.text(selector)) || !procedure || !invocation2 || !dispatchBindingRules.rpc.kinds.some((kind) => kind === invocation2.name) || invocation2.args.length !== 1 || handler?.type !== "arrow_function" || !builder || builder.name !== "procedure" || declarationOf(builder.receiver) !== initializer.declaration) {
              diagnose("procedure-shape", field);
              continue;
            }
            keys.add(view.text(selector));
            allowed.add(key2(builder.receiver));
            addEndpoint(family, { node: procedure, owner: view.root, role: "dispatch-handler", ruleId: dispatchBindingRules.rules[4], properties: [
              ["receiver", span2(builder.receiver)],
              ["selector", span2(selector)],
              ["method", span2(invocation2.method)],
              ["handler", span2(handler)],
              ["procedure-key", string(view.text(selector))],
              ["procedure-kind", string(invocation2.name)],
              ...argumentProperties(invocation2.args)
            ] });
          }
          allowed.add(key2(invocation.receiver));
          addFamily(family);
        }
        for (const node of view.nodes) {
          step();
          const invocation = call(node);
          if (!invocation || invocation.name !== "createCaller") continue;
          const declaration = declarationOf(invocation.receiver), family = families2.find((family2) => family2.kind === "trpc-rpc" && family2.declaration === declaration);
          if (!family) continue;
          const context = invocation.args[0], bindingLocal = local(node);
          if (!bindingLocal || family.caller || invocation.args.length !== 1 || context?.type !== "object" || children(context).length) {
            diagnose("caller-shape", node);
            continue;
          }
          family.caller = bindingLocal;
          family.context = context;
          family.callerReceiver = invocation.receiver;
          family.callerMethod = invocation.method;
          allowed.add(key2(invocation.receiver));
        }
        for (const node of view.nodes) {
          step();
          const invocation = call(node);
          if (!invocation) continue;
          const declaration = declarationOf(invocation.receiver), family = declaration && families2.find((family2) => family2.kind === "elysia-http" ? family2.declaration === declaration : family2.caller?.declaration === declaration);
          if (!family) continue;
          const values = invocation.args;
          if (family.kind === "trpc-rpc") {
            const lexicalOwner2 = owner(node);
            if (!lexicalOwner2 || values.length > dispatchBindingRules.maxArguments || values.some((value4) => value4.type === "spread_element") || !family.endpoints.some((endpoint) => endpoint.role === "dispatch-handler" && endpoint.properties.some(([property, value4]) => property === "procedure-key" && value4.kind === "string" && value4.value === invocation.name))) {
              diagnose("caller-use", node);
              continue;
            }
            allowed.add(key2(invocation.receiver));
            addEndpoint(family, { node, owner: lexicalOwner2, role: "dispatch-call", ruleId: dispatchBindingRules.rules[6], properties: [
              ["receiver", span2(invocation.receiver)],
              ["selector", span2(invocation.method)],
              ["method", span2(invocation.method)],
              ["procedure-key", string(invocation.name)],
              ["caller", span2(family.caller.allocation)],
              ["caller-declaration", reference(family.caller.declaration)],
              ...argumentProperties(values)
            ] });
            continue;
          }
          const method = invocation.name.toUpperCase();
          if (dispatchBindingRules.http.methods.some((value4) => value4 === method) && invocation.name === method.toLowerCase()) {
            const selector = values[0], handler = values[1], value4 = literal(selector), lexicalOwner2 = owner(node, true);
            if (!lexicalOwner2 || values.length !== 2 || !selector || !path(value4) || handler?.type !== "arrow_function" || family.endpoints.some((endpoint) => endpoint.properties.some(([property, item]) => property === "path" && item.kind === "string" && item.value === value4) && endpoint.properties.some(([property, item]) => property === "http-method" && item.kind === "string" && item.value === method) && endpoint.role === "dispatch-handler")) {
              diagnose("route-shape", node);
              continue;
            }
            allowed.add(key2(invocation.receiver));
            addEndpoint(family, { node, owner: lexicalOwner2, role: "dispatch-handler", ruleId: dispatchBindingRules.rules[1], properties: [
              ["receiver", span2(invocation.receiver)],
              ["selector", span2(selector)],
              ["method", span2(invocation.method)],
              ["handler", span2(handler)],
              ["http-method", string(method)],
              ["path", string(value4)],
              ...argumentProperties(values)
            ] });
            continue;
          }
          if (invocation.name !== "handle") {
            diagnose("receiver-use", node);
            continue;
          }
          const request = values[0], ctor = request?.fields.constructor, lexicalOwner = owner(node);
          const requestImport = importedAt(ctor, dispatchBindingRules.request.module);
          const ambient = ctor?.type === "identifier" && view.text(ctor) === "Request" && !binding(ctor);
          const requestArgs = request ? args(request) : [], url = literal(requestArgs[0]);
          const parsed = url && Buffer.byteLength(url) <= dispatchBindingRules.maxURLBytes ? /^https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::([0-9]{1,5}))?(\/[^?#]*)$/.exec(url) : null;
          const host = parsed?.[1], port = parsed?.[2], requestPath = parsed?.[3];
          const hostValid = host && (/^[A-Za-z0-9]+(?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && host.split(".").every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) && (/[A-Za-z]/.test(host) || /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255)));
          let httpMethod = "GET", methodLiteral, validOptions = true;
          if (requestArgs[1]) {
            const options = requestArgs[1], fields = children(options), field = fields[0];
            methodLiteral = field?.fields.value;
            const explicit = literal(methodLiteral);
            if (options.type !== "object" || fields.length !== 1 || field?.type !== "pair" || field.fields.key?.type !== "property_identifier" || view.text(field.fields.key) !== "method" || !dispatchBindingRules.http.methods.some((value4) => value4 === explicit)) validOptions = false;
            else httpMethod = explicit;
          }
          if (!lexicalOwner || values.length !== 1 || request?.type !== "new_expression" || !request.fields.arguments || request.fields.type_arguments || optional4(request) || !ctor || !requestImport && !ambient || requestArgs.length < 1 || requestArgs.length > 2 || !validOptions || !hostValid || port && Number(port) > 65535 || !path(requestPath)) {
            diagnose("request-shape", node);
            continue;
          }
          allowed.add(key2(invocation.receiver));
          allowed.add(key2(ctor));
          addEndpoint(family, { node, owner: lexicalOwner, role: "dispatch-call", ruleId: dispatchBindingRules.rules[2], properties: [
            ["receiver", span2(invocation.receiver)],
            ["selector", span2(requestArgs[0])],
            ["method", span2(invocation.method)],
            ["request", span2(request)],
            ["request-constructor", span2(ctor)],
            ["request-origin", string(requestImport ? "undici-named" : "ambient-fetch")],
            ["http-method", string(httpMethod)],
            ["path", string(requestPath)],
            ...argumentProperties(values),
            ...methodLiteral ? [["method-literal", span2(methodLiteral)]] : [],
            ...requestImport ? [["request-import", span2(requestImport.node)], ["request-import-reference", { kind: "reference", value: { kind: "import", module: dispatchBindingRules.request.module, name: dispatchBindingRules.request.name } }]] : []
          ] });
        }
        for (const node of view.nodes) {
          step();
          if (!identifiers2.has(node.type) || importTokens.has(key2(node)) || declarations.has(key2(node))) continue;
          const origin = binding(node), imported = origin?.kind === "import" && imports.has(key2(origin.node));
          if (imported || origin?.declaration && tracked.has(origin.declaration)) {
            if (!origin?.available || !origin.stable || origin.typeOnly || !allowed.has(key2(node))) diagnose("binding-use", node);
          } else if (!origin && (names.has(view.name(node) ?? "") || view.name(node) === "Request") && !allowed.has(key2(node))) diagnose("ambiguous-reference", node);
        }
        if (veto) return { state: truncated ? "truncated" : "partial", diagnostics };
        let facts = 0;
        const stage = (family, node, lexicalOwner, role, ruleId, properties4, subject) => {
          const owning = subject ?? view.owner(lexicalOwner)?.key ?? limit("inventory-limit");
          if (!retained.has(owning)) limit("inventory-limit");
          const all = [
            ["declaration", reference(family.declaration)],
            ["import-reference", { kind: "reference", value: { kind: "import", module: family.imported.module, name: family.imported.name } }],
            ["import", span2(family.imported.node)],
            ["allocation", span2(family.allocation)],
            ["owner", span2(lexicalOwner)],
            ["family", string(family.kind)],
            ["api-assumption", string(family.kind === "elysia-http" ? dispatchBindingRules.http.assumption : dispatchBindingRules.rpc.assumption)],
            ...family.initializer ? [["initializer-declaration", reference(family.initializer.declaration)], ["initializer", span2(family.initializer.allocation)]] : [],
            ...[...dispatchBindingRules.conditions, ...family.kind === "elysia-http" ? dispatchBindingRules.httpConditions : dispatchBindingRules.rpcConditions].map((condition) => ["condition", string(condition)]),
            ...properties4,
            ["inventory-complete", { kind: "boolean", value: true }],
            ["unit-complete", { kind: "boolean", value: true }]
          ];
          facts += all.length + 1;
          if (facts > Math.min(dispatchBindingRules.maxFacts, view.limits.maxFacts)) limit("fact-limit");
          if (all.some(([, value4]) => Buffer.byteLength(canonicalJSON(value4)) > view.limits.maxValueBytes)) limit("value-limit");
          staged.push({ node, subject: owning, role, ruleId, properties: all });
        };
        for (const family of families2) {
          step();
          stage(family, family.allocation, view.root, "dispatch-family", family.kind === "elysia-http" ? dispatchBindingRules.rules[0] : dispatchBindingRules.rules[3], [
            ["family-count", integer2(families2.length)],
            ["endpoint-count", integer2(family.endpoints.length)],
            ["caller-count", integer2(family.caller ? 1 : 0)]
          ], family.declaration);
          if (family.caller) stage(family, family.caller.allocation, view.root, "dispatch-caller", dispatchBindingRules.rules[5], [
            ["caller", span2(family.caller.allocation)],
            ["caller-declaration", reference(family.caller.declaration)],
            ["receiver", span2(family.callerReceiver)],
            ["method", span2(family.callerMethod)],
            ["context", span2(family.context)],
            ...argumentProperties([family.context])
          ], family.caller.declaration);
          for (const endpoint of family.endpoints) stage(family, endpoint.node, endpoint.owner, endpoint.role, endpoint.ruleId, endpoint.properties);
        }
        for (const unit of staged) {
          step();
          const evidence = { ruleId: unit.ruleId, basis: "import-bound", span: view.span(unit.node) };
          if (!emitter.role(unit.subject, `dispatch-binding.${unit.role}`, evidence)) limit("output-limit");
          for (const [property, value4] of unit.properties) {
            step();
            if (!emitter.property(unit.subject, `dispatch-binding.${property}`, "literal", value4, evidence)) limit("output-limit");
          }
        }
      } catch (error) {
        if (error !== stop) throw error;
      }
      return { state: truncated ? "truncated" : veto ? "partial" : staged.length ? "complete" : "not-applicable", diagnostics };
    }
  };
}

// src/analysis.ts
function createAnalyzer(options) {
  const digest2 = (value4) => createHash("sha256").update(value4).digest("hex");
  const suppliedConfiguration = object(options.configuration === void 0 ? {} : options.configuration, [], ["limits", "moduleAliases"]);
  requireValid(Buffer.byteLength(canonicalJSON(suppliedConfiguration)) <= 4096, "Configuration limit exceeded");
  const moduleAliases = normalizeModuleAliases(suppliedConfiguration.moduleAliases);
  const supplied = object(suppliedConfiguration.limits === void 0 ? {} : suppliedConfiguration.limits, [], Object.keys(ANNOTATION_LIMITS));
  const limits = { ...ANNOTATION_LIMITS };
  for (const [key3, value4] of Object.entries(supplied)) {
    if (typeof value4 !== "number" || !Number.isSafeInteger(value4) || value4 < 1 || value4 > limits[key3]) throw new Error(`Invalid analyzer limit: ${key3}`);
    limits[key3] = value4;
  }
  const configuration = Object.freeze({ moduleAliases });
  const normalizedConfiguration = canonicalJSON({ limits, moduleAliases });
  requireValid(Buffer.byteLength(normalizedConfiguration) <= 4096, "Normalized configuration limit exceeded");
  const digests = { implementationDigest: options.implementationDigest, configurationDigest: digest2(normalizedConfiguration) };
  const plugins = [
    createFstSolidPlugin(digests),
    createSolidPlugin(digests),
    createFstComponentsPlugin(digests),
    createImplementationPlugin(digests),
    createTransportBindingPlugin(digests),
    createValidationContractPlugin(digests),
    createDispatchBindingPlugin(digests)
  ];
  const body = {
    version: 1,
    core: { version: "1", ...digests },
    view: { id: "typescript", version: 1, ...digests },
    parserDigest: options.parserDigest,
    plugins: plugins.map((plugin) => plugin.descriptor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    limits
  };
  const manifest = { ...body, id: digest2(canonicalJSON(body)) };
  validateAnnotationManifest(manifest, digest2);
  const pending = [manifest];
  while (pending.length) {
    const value4 = pending.pop();
    for (const child of Object.values(value4)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(value4);
  }
  const engine = createAnnotationEngine({ manifest, plugins, digest: digest2 });
  const returnContracts = [...solidReturnContracts, ...fstReturnContracts, ...fstComponentsReturnContracts];
  const grouped = /* @__PURE__ */ new Set(["transport-binding", "validation-contract", "dispatch-binding"]);
  return Object.freeze({
    manifest,
    configuration,
    analyze(document, tree) {
      const language = document.language;
      if (language !== "typescript" && language !== "tsx") throw new Error("Unsupported source language");
      if (Buffer.byteLength(document.source) > limits.maxSourceBytes || digest2(document.source) !== document.sourceHash) throw new Error("Source snapshot mismatch");
      const view = createTypeScriptView({ tree, ...document, language, limits, returnContracts, moduleAliases });
      const result = engine.analyze(document, view);
      const rejected = new Set(result.reports.filter((report) => grouped.has(report.pluginId) && report.state !== "complete").map((report) => report.pluginId));
      result.facts = result.facts.filter((fact) => !rejected.has(fact.evidence.pluginId));
      validateAnnotationResult(result, manifest, document.source);
      return result;
    }
  });
}

// src/build-info.ts
var implementationDigest = "693794fee2077d742ec99e3b3b87436175155993a00ecc651979bc99c500adb7";

// src/syntax.ts
var SYNTAX_LIMITS = Object.freeze({ maxNodes: 1e5, maxDepth: 256 });
var DetachedNode = class {
  constructor(type, startIndex, endIndex, startPosition, endPosition, isNamed, isMissing, hasError, source, entries) {
    this.type = type;
    this.startIndex = startIndex;
    this.endIndex = endIndex;
    this.startPosition = startPosition;
    this.endPosition = endPosition;
    this.isNamed = isNamed;
    this.isMissing = isMissing;
    this.#source = source;
    this.#entries = entries;
    this.hasError = hasError || isMissing || type === "ERROR";
  }
  #source;
  #entries;
  hasError;
  parent = null;
  previousSibling = null;
  nextSibling = null;
  previousNamedSibling = null;
  nextNamedSibling = null;
  children = [];
  namedChildren = [];
  get text() {
    return this.#source.slice(this.startIndex, this.endIndex);
  }
  get childCount() {
    return this.children.length;
  }
  get namedChildCount() {
    return this.namedChildren.length;
  }
  child(index) {
    return this.children[index] ?? null;
  }
  namedChild(index) {
    return this.namedChildren[index] ?? null;
  }
  childForFieldName(name) {
    return this.#entries.find((child) => child.field === name)?.node ?? null;
  }
  fieldNameForChild(index) {
    return this.#entries[index]?.field ?? null;
  }
};
function decodeTree(raw, source, limits = {}) {
  sourceCoordinates(source, ANNOTATION_LIMITS.maxSourceBytes);
  const maxNodes = limits.maxNodes ?? SYNTAX_LIMITS.maxNodes;
  const maxDepth = limits.maxDepth ?? SYNTAX_LIMITS.maxDepth;
  integer(maxNodes, 1, SYNTAX_LIMITS.maxNodes);
  integer(maxDepth, 1, SYNTAX_LIMITS.maxDepth);
  const lines = [0];
  for (let index = 0; index < source.length; index++) if (source.charCodeAt(index) === 10) lines.push(index + 1);
  const point = (input, index) => {
    const value4 = object(input, ["row", "column"]);
    integer(value4.row, 0, lines.length - 1);
    integer(value4.column, 0, source.length);
    let low = 0, high = lines.length;
    while (low + 1 < high) {
      const middle = low + high >>> 1;
      if (lines[middle] <= index) low = middle;
      else high = middle;
    }
    requireValid(value4.row === low && value4.column === index - lines[low], "Syntax point does not match source");
    const before = source.charCodeAt(index - 1), at = source.charCodeAt(index);
    requireValid(!(before >= 55296 && before <= 56319 && at >= 56320 && at <= 57343), "Syntax span splits UTF-16 character");
    return Object.freeze({ row: value4.row, column: value4.column });
  };
  const seen = /* @__PURE__ */ new Set();
  const pending = [];
  const create = (input, depth) => {
    requireValid(depth <= maxDepth, "Syntax depth limit exceeded");
    requireValid(pending.length < maxNodes, "Syntax node limit exceeded");
    const value4 = object(input, ["type", "startIndex", "endIndex", "startPosition", "endPosition", "hasError", "isMissing", "isNamed", "children"]);
    requireValid(!seen.has(value4), "Cyclic or shared syntax node");
    seen.add(value4);
    requireValid(typeof value4.type === "string" && /^[\x20-\x7e]{1,128}$/.test(value4.type), "Invalid syntax type");
    integer(value4.startIndex, 0, source.length);
    integer(value4.endIndex, value4.startIndex, source.length);
    for (const key3 of ["hasError", "isMissing", "isNamed"]) requireValid(typeof value4[key3] === "boolean", "Invalid syntax flags");
    requireValid(!value4.isMissing || value4.startIndex === value4.endIndex, "Missing syntax node has source text");
    requireValid(Array.isArray(value4.children) && value4.children.length <= maxNodes, "Invalid syntax children");
    const entries = [];
    const node = new DetachedNode(
      value4.type,
      value4.startIndex,
      value4.endIndex,
      point(value4.startPosition, value4.startIndex),
      point(value4.endPosition, value4.endIndex),
      value4.isNamed,
      value4.isMissing,
      value4.hasError,
      source,
      entries
    );
    pending.push({ raw: value4.children, node, entries, depth });
    return node;
  };
  const rootNode = create(raw, 0);
  requireValid(rootNode.type === "program" && rootNode.isNamed, "Unsupported syntax root");
  requireValid(/^\s*$/u.test(source.slice(0, rootNode.startIndex)) && /^\s*$/u.test(source.slice(rootNode.endIndex)), "Syntax root omits source");
  for (let index = 0; index < pending.length; index++) {
    const { raw: children, node, entries, depth } = pending[index];
    let previous = null, previousNamed = null;
    for (const entry of children) {
      const child = object(entry, ["field", "node"]);
      requireValid(child.field === null || typeof child.field === "string" && /^[a-z_][a-z0-9_]{0,127}$/.test(child.field), "Invalid syntax field");
      const next = create(child.node, depth + 1);
      requireValid(next.startIndex >= (previous?.endIndex ?? node.startIndex) && next.endIndex <= node.endIndex, "Unordered or out-of-parent syntax span");
      next.parent = node;
      next.previousSibling = previous;
      next.previousNamedSibling = previousNamed;
      if (previous) previous.nextSibling = next;
      if (next.isNamed) {
        if (previousNamed) previousNamed.nextNamedSibling = next;
        previousNamed = next;
      }
      previous = next;
      entries.push(Object.freeze({ field: child.field, node: next }));
    }
    let nextNamed = null;
    for (let index2 = entries.length - 1; index2 >= 0; index2--) {
      const child = entries[index2].node;
      child.nextNamedSibling = nextNamed;
      if (child.isNamed) nextNamed = child;
    }
    node.children = Object.freeze(entries.map((child) => child.node));
    node.namedChildren = Object.freeze(node.children.filter((child) => child.isNamed));
    Object.freeze(entries);
  }
  for (let index = pending.length - 1; index >= 0; index--) {
    const node = pending[index].node;
    node.hasError ||= node.children.some((child) => child.hasError);
    Object.freeze(node);
  }
  return Object.freeze({ rootNode });
}

// src/worker.ts
var PROTOCOL_LIMITS = Object.freeze({
  maxRequestBytes: 16 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxDocuments: 16,
  maxSourceBytes: 1024 * 1024,
  maxNodes: 25e4,
  maxJSONDepth: SYNTAX_LIMITS.maxDepth * 3 + 16,
  readTimeoutMs: 3e4,
  analysisTimeoutMs: 6e4
});
var SUPPORTED_PARSER = Object.freeze({ id: "tree-sitter-typescript", version: "0.23.2", coordinateEncoding: "utf16" });
var digest = (value4) => createHash2("sha256").update(value4).digest("hex");
var ProtocolError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function checked(code, message, run) {
  try {
    return run();
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(code, message);
  }
}
function processRequest(input) {
  const deadline = performance.now() + PROTOCOL_LIMITS.analysisTimeoutMs;
  const request = checked("invalid-request", "Invalid semantic request envelope.", () => {
    const value4 = object(input, ["version", "parser", "documents"], ["options"]);
    requireValid(value4.version === 1, "Unsupported protocol version");
    requireValid(Array.isArray(value4.documents) && value4.documents.length <= PROTOCOL_LIMITS.maxDocuments, "Document limit exceeded");
    if (value4.options !== void 0) {
      const options = object(value4.options, [], ["limits", "moduleAliases"]);
      requireValid(Buffer.byteLength(canonicalJSON(options)) <= 4096, "Configuration limit exceeded");
    }
    return value4;
  });
  const parser = checked("invalid-parser", "Invalid parser descriptor.", () => {
    const value4 = object(request.parser, ["id", "version", "runtimeVersion", "coordinateEncoding"]);
    text(value4.id, 128);
    text(value4.version, 64);
    text(value4.runtimeVersion, 64);
    requireValid(value4.coordinateEncoding === "utf16", "Unsupported coordinate encoding");
    return value4;
  });
  if (parser.id !== SUPPORTED_PARSER.id || parser.version !== SUPPORTED_PARSER.version) {
    throw new ProtocolError("unsupported-parser", "The parser grammar is not qualified for this semantic engine.");
  }
  const analyzer = checked("invalid-configuration", "Invalid semantic analysis configuration.", () => createAnalyzer({
    implementationDigest,
    parserDigest: digest(canonicalJSON(parser)),
    ...request.options === void 0 ? {} : { configuration: request.options }
  }));
  validateAnnotationManifest(analyzer.manifest, digest);
  const response = { version: 1, producer: { id: "graphify.frameworks", version: "1", fingerprint: implementationDigest, configuration: analyzer.configuration }, manifest: analyzer.manifest, documents: [] };
  let responseBytes = Buffer.byteLength(JSON.stringify(response)) + 1;
  const paths = /* @__PURE__ */ new Set();
  let sourceBytes = 0, nodes = 0;
  for (const inputDocument of request.documents) {
    if (performance.now() > deadline) throw new ProtocolError("analysis-timeout", "Semantic request processing deadline exceeded.");
    const value4 = checked("invalid-document", "Invalid source identity, source limit, or relative path.", () => {
      const value5 = object(inputDocument, ["source", "sourceHash", "relativePath", "language", "tree"]);
      relativePath(value5.relativePath);
      hash(value5.sourceHash);
      requireValid(typeof value5.source === "string", "Source must be text");
      const coordinates = sourceCoordinates(value5.source, analyzer.manifest.limits.maxSourceBytes);
      sourceBytes += coordinates.bytes;
      requireValid(sourceBytes <= PROTOCOL_LIMITS.maxSourceBytes, "Aggregate source limit exceeded");
      requireValid(digest(value5.source) === value5.sourceHash, "Source identity mismatch");
      requireValid(!paths.has(value5.relativePath), "Duplicate source path");
      paths.add(value5.relativePath);
      return { source: value5.source, sourceHash: value5.sourceHash, relativePath: value5.relativePath, language: value5.language, tree: value5.tree };
    });
    if (value4.language !== "typescript" && value4.language !== "tsx") throw new ProtocolError("unsupported-language", "Only TypeScript and TSX source snapshots are supported.");
    const tree = checked("invalid-tree", "Malformed syntax tree, inconsistent coordinates, or syntax limit exceeded.", () => {
      requireValid(nodes < PROTOCOL_LIMITS.maxNodes, "Aggregate syntax limit exceeded");
      const tree2 = decodeTree(value4.tree, value4.source, { maxNodes: Math.min(SYNTAX_LIMITS.maxNodes, PROTOCOL_LIMITS.maxNodes - nodes) });
      const pending = [tree2.rootNode];
      while (pending.length) {
        const node = pending.pop();
        nodes++;
        for (const child of node.children) pending.push(child);
      }
      return tree2;
    });
    const document = { source: value4.source, sourceHash: value4.sourceHash, relativePath: value4.relativePath, language: value4.language };
    const result = checked("analysis-failed", "Semantic analysis could not produce a validated result.", () => {
      const result2 = analyzer.analyze(document, tree);
      validateAnnotationResult(result2, analyzer.manifest, document.source);
      return result2;
    });
    if (performance.now() > deadline) throw new ProtocolError("analysis-timeout", "Semantic request processing deadline exceeded.");
    const retained = { source: document.source, result };
    responseBytes += Buffer.byteLength(JSON.stringify(retained)) + (response.documents.length ? 1 : 0);
    if (responseBytes > PROTOCOL_LIMITS.maxResponseBytes) throw new ProtocolError("response-limit", "Semantic response byte limit exceeded.");
    response.documents.push(retained);
  }
  return response;
}
async function readRequest() {
  const parts = [];
  let size = 0;
  const timeout = setTimeout(() => process.stdin.destroy(new ProtocolError("request-timeout", "Semantic request read deadline exceeded.")), PROTOCOL_LIMITS.readTimeoutMs);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > PROTOCOL_LIMITS.maxRequestBytes) throw new ProtocolError("request-limit", "Semantic request byte limit exceeded.");
      parts.push(chunk);
    }
    return checked("invalid-json", "Expected one bounded UTF-8 JSON request.", () => {
      const encoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
      let depth = 0, quoted = false, escaped = false, stringStart = 0;
      const containers = [];
      for (let index = 0; index < encoded.length; index++) {
        const character = encoded[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') {
            quoted = false;
            let next = index + 1;
            while (next < encoded.length && /[\t\n\r ]/.test(encoded[next])) next++;
            const keys = containers.at(-1);
            if (keys && encoded[next] === ":") {
              const key3 = JSON.parse(encoded.slice(stringStart, index + 1));
              requireValid(!keys.has(key3), "Duplicate JSON object key");
              keys.add(key3);
            }
          }
        } else if (character === '"') {
          quoted = true;
          stringStart = index;
        } else if (character === "{" || character === "[") {
          requireValid(++depth <= PROTOCOL_LIMITS.maxJSONDepth, "JSON depth limit exceeded");
          containers.push(character === "{" ? /* @__PURE__ */ new Set() : null);
        } else if (character === "}" || character === "]") {
          depth--;
          containers.pop();
        }
      }
      return JSON.parse(encoded);
    });
  } finally {
    clearTimeout(timeout);
  }
}
async function main() {
  try {
    if (Number(process.versions.node.split(".")[0]) < 20) throw new ProtocolError("unsupported-runtime", "Node.js 20 or newer is required.");
    if (process.argv.length !== 2) throw new ProtocolError("invalid-arguments", "This worker accepts one JSON request on standard input, with no arguments.");
    const result = processRequest(await readRequest());
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) + 1 > PROTOCOL_LIMITS.maxResponseBytes) throw new ProtocolError("response-limit", "Semantic response byte limit exceeded.");
    process.stdout.write(`${encoded}
`);
  } catch (error) {
    const failure = error instanceof ProtocolError ? error : new ProtocolError("worker-failed", "The semantic worker failed.");
    process.stderr.write(`${JSON.stringify({ version: 1, error: { code: failure.code, message: failure.message } })}
`);
    process.exitCode = 1;
    process.stdin.destroy();
  }
}
if (import.meta.url.startsWith("file:") && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on("error", () => {
    process.exitCode = 1;
  });
  await main();
}
export {
  PROTOCOL_LIMITS,
  SUPPORTED_PARSER,
  processRequest
};
