import type { AnnotationDiagnostic, AnnotationLimits, CoverageState, Declaration, Reference, SourceSpan } from '#core/wire';
import { ANNOTATION_LIMITS, canonicalJSON } from '#core/wire';
import { createConstantQueries, decodeIdentifier, decodeString } from './values.js';
import { createProjectionQueries } from './projections.js';
import { createBindingQueries } from './bindings.js';
import { createModuleIdentity, normalizeModuleAliases } from './module-aliases.js';
import type { InitializerProjection, LexicalBinding, SyntaxNode, TreeSitterNode, TypeScriptView, TypeScriptViewOptions } from './types.js';
export type { ConstantObject, ConstantResult, InitializerProjection, LexicalBinding, PatternProjection, PatternProjections, ProjectionKey, ReturnContract, ReturnShape, SyntaxNode, TreeSitterNode, TypeScriptView, TypeScriptViewOptions, ValueProjection } from './types.js';

const functions = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function', 'arrow_function', 'method_definition', 'function_signature', 'method_signature', 'abstract_method_signature']);
const classes = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const wrappers = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'type_assertion', 'non_null_expression', 'instantiation_expression']);
interface Scope { parent?: Scope; functionScope: boolean; bindings: Map<string, Binding[]> }
interface Binding {
  name: string; kind: LexicalBinding['kind']; node: SyntaxNode; nameNode?: SyntaxNode; declaration?: string;
  initializer?: SyntaxNode; origin?: Extract<Reference, { kind: 'import' }>;
  typeOnly: boolean; valueOnly: boolean; scope: Scope; stable: boolean; availableFrom: number;
}

/** Build only from the caller's exact snapshot and already-qualified parse. */
export function createTypeScriptView(options: TypeScriptViewOptions): TypeScriptView {
  const { source, language, relativePath, sourceHash } = options;
  const canonicalModule = createModuleIdentity(normalizeModuleAliases(options.moduleAliases));
  if (source.length > ANNOTATION_LIMITS.maxSourceBytes) throw new Error('TypeScript source byte limit exceeded');
  const limits = { ...ANNOTATION_LIMITS } as { -readonly [K in keyof AnnotationLimits]: number };
  for (const key of Object.keys(limits) as (keyof AnnotationLimits)[]) {
    const value = options.limits?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new Error('Invalid TypeScript view limit');
      limits[key] = value;
    }
  }
  if (language !== 'typescript' && language !== 'tsx') throw new Error('Unsupported TypeScript view language');
  let state: CoverageState = 'complete';
  let work = 0;
  const diagnostics: AnnotationDiagnostic[] = [];
  const note = (code: string, message: string, next: CoverageState = 'partial') => {
    if (utf8Length(message) <= limits.maxValueBytes && !diagnostics.some((d) => d.code === code) && diagnostics.length < limits.maxDiagnostics) diagnostics.push({ code, message });
    if (state === 'complete' || next === 'truncated' || next === 'unsupported') state = next;
  };
  const tick = (amount = 1) => {
    work += amount;
    if (options.cancelled?.()) { note('typescript.cancelled', 'Analysis cancelled.', 'truncated'); return false; }
    if (work > limits.maxWork) { note('typescript.work-limit', `resource=work accounted=${work} limit=${limits.maxWork}`, 'truncated'); return false; }
    return true;
  };
  // Normalized syntax indices are UTF-16; evidence spans are UTF-8. No TextEncoder/DOM dependency.
  const bytes = new Uint32Array(source.length + 1);
  const lines = new Uint32Array(source.length + 1);
  let byte = 0, line = 1;
  for (let i = 0; i < source.length; i++) {
    bytes[i] = byte; lines[i] = line;
    const code = source.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && source.charCodeAt(i + 1) >= 0xdc00 && source.charCodeAt(i + 1) <= 0xdfff) {
      bytes[++i] = byte; lines[i] = line; byte += 4;
    } else byte += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (code === 10) line++;
  }
  bytes[source.length] = byte; lines[source.length] = line;
  if (byte > limits.maxSourceBytes) throw new Error('TypeScript source byte limit exceeded');
  const span = (node: SyntaxNode): SourceSpan => Object.freeze({
    startByte: bytes[node.startIndex]!, endByte: bytes[node.endIndex]!,
    startLine: lines[node.startIndex]!, endLine: lines[Math.max(node.startIndex, node.endIndex - 1)]!,
  });
  const text = (node: SyntaxNode) => source.slice(node.startIndex, node.endIndex);
  const name = (node: SyntaxNode) => node.type === 'string' ? decodeString(text(node)) : ['identifier', 'undefined', 'type_identifier', 'property_identifier', 'private_property_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'].includes(node.type) ? decodeIdentifier(text(node)) : undefined;
  const parents = new Map<SyntaxNode, SyntaxNode>();
  const arrayElements = new Map<SyntaxNode, readonly (SyntaxNode | null)[]>();
  const nodes: SyntaxNode[] = [];
  const rawRoot = 'rootNode' in options.tree ? options.tree.rootNode : options.tree;
  if (rawRoot.hasError) note('typescript.parse-error', 'Recovered syntax is not eligible for verified framework facts.', 'unsupported');
  const copy = (raw: TreeSitterNode, depth: number): SyntaxNode => {
    if (!Number.isInteger(raw.startIndex) || !Number.isInteger(raw.endIndex) || raw.startIndex < 0 || raw.endIndex < raw.startIndex || raw.endIndex > source.length) throw new Error('Invalid supplied syntax span');
    const children: SyntaxNode[] = [], tokens: string[] = [], elements: (SyntaxNode | null)[] = [];
    let elementIndex = 0;
    const fields: { [name: string]: SyntaxNode | undefined; constructor?: SyntaxNode } = Object.create(null);
    const node: SyntaxNode = { type: raw.type, startIndex: raw.startIndex, endIndex: raw.endIndex, children, fields, tokens };
    nodes.push(node);
    if (raw.isMissing || raw.type === 'ERROR') note('typescript.parse-error', 'Recovered syntax is not eligible for verified framework facts.', 'unsupported');
    if (depth >= limits.maxDepth) note('typescript.depth-limit', `resource=syntax-depth accounted=${depth} limit=${limits.maxDepth}`, 'truncated');
    else if (tick()) for (let i = 0; i < raw.childCount; i++) {
      if (!tick()) break;
      const child = raw.child(i);
      if (!child) continue;
      if (!child.isNamed) {
        tokens.push(child.type);
        if (child.type === ',' && ['array', 'array_pattern'].includes(raw.type)) { elements[elementIndex] ??= null; elementIndex++; }
        continue;
      }
      const normalized = copy(child, depth + 1);
      children.push(normalized); parents.set(normalized, node);
      if (['array', 'array_pattern'].includes(raw.type) && normalized.type !== 'comment') elements[elementIndex] = normalized;
      const field = raw.fieldNameForChild(i);
      if (field && !fields[field]) fields[field] = normalized;
    }
    Object.freeze(children); Object.freeze(fields); Object.freeze(tokens);
    if (['array', 'array_pattern'].includes(raw.type)) arrayElements.set(node, Object.freeze(elements));
    return Object.freeze(node);
  };
  const root = copy(rawRoot, 0);
  const nodeKey = (node: SyntaxNode) => `${node.type}:${node.startIndex}:${node.endIndex}`;
  const originals = new Map(nodes.map((node) => [nodeKey(node), node]));
  const original = (node: SyntaxNode): SyntaxNode => {
    const result = originals.get(nodeKey(node));
    if (!result) throw new Error('Node is not part of this TypeScript view');
    return result;
  };
  const modules = new Map<SyntaxNode, string>();
  for (const node of nodes) {
    if (!['import_statement', 'export_statement'].includes(node.type) || !node.fields.source) continue;
    const sourceNode = node.fields.source;
    const module = sourceNode.type === 'string' ? decodeString(text(sourceNode)) : undefined;
    if (module === undefined) continue;
    try { modules.set(sourceNode, canonicalModule(module)); }
    catch { note('typescript.module-alias-specifier', 'Aliased module specifier is outside the supported bare-module syntax.', 'unsupported'); }
  }
  const moduleIdentity = (node: SyntaxNode) => modules.get(original(node));
  const unwrap = (input: SyntaxNode): SyntaxNode => {
    let node = original(input);
    for (let i = 0; i < limits.maxDepth && wrappers.has(node.type); i++) {
      const next = node.fields.expression ?? (node.type === 'type_assertion' ? node.children.at(-1) : node.children[0]);
      if (!next || next === node) break;
      node = next;
    }
    return node;
  };
  const declarations: Declaration[] = [];
  const declarationByKey = new Map<string, Declaration>();
  const declarationNodes = new Map<string, SyntaxNode>();
  const nodeDeclarations = new Map<SyntaxNode, Declaration>();
  const scopes = new Map<SyntaxNode, Scope>();
  const bindingSources = new Map<string, InitializerProjection>();
  const declarationBindings = new Map<string, Binding>();
  let constructing = true;
  const projectionQueries = createProjectionQueries({
    text, name, unwrap, limits, binding: (node) => bindingAt(node), resolve: (node) => resolve(node),
    source: (key) => bindingSources.get(key), elements: (node) => arrayElements.get(original(node)) ?? [],
    callForArguments: (node) => {
      const parent = parents.get(original(node));
      return parent?.type === 'call_expression' && parent.fields.arguments === original(node) ? parent : undefined;
    },
    stableObject: (node, observation, offset, delivery, preservesIdentity) => stableObject(node, observation, offset, delivery, preservesIdentity), step: () => !constructing || tick(),
  }, options.returnContracts);
  const rootScope: Scope = { functionScope: true, bindings: new Map() };
  const addBinding = (binding: Binding) => {
    binding.name = decodeIdentifier(binding.name);
    const existing = binding.scope.bindings.get(binding.name) ?? [];
    existing.push(binding); binding.scope.bindings.set(binding.name, existing);
    if (binding.declaration) declarationBindings.set(binding.declaration, binding);
  };
  const add = (node: SyntaxNode, kind: string, nameNode?: SyntaxNode, owner?: Declaration, exports: string[] = []) => {
    if (declarations.length >= limits.maxDeclarations) { note('typescript.declaration-limit', 'Declaration limit reached.', 'truncated'); return undefined; }
    const range = span(node);
    const key = `d:${kind}:${range.startByte}:${range.endByte}:${owner ? span(declarationNodes.get(owner.key)!).startByte : 0}`;
    const name = nameNode && (nameNode.type === 'string' ? decodeString(text(nameNode)) : decodeIdentifier(text(nameNode)));
    if (name !== undefined && (utf8Length(name) > Math.min(2048, limits.maxValueBytes) || !wellFormed(name))) { note('typescript.name-limit', 'Declaration name exceeds the metadata or Unicode limit.'); return undefined; }
    const declaration: Declaration = { key, kind, span: range, exports: exports.map(decodeIdentifier) };
    if (name) { declaration.name = name; declaration.nameSpan = span(nameNode!); }
    if (owner) declaration.owner = owner.key;
    declarations.push(declaration); declarationByKey.set(key, declaration); declarationNodes.set(key, node);
    if (!nodeDeclarations.has(node)) nodeDeclarations.set(node, declaration);
    return declaration;
  };
  const patternNames = (node: SyntaxNode): SyntaxNode[] => {
    // TypeScript's explicit this parameter is erased, not a runtime binding.
    if (node.type === 'this' || node.type === 'comment') return [];
    if (['identifier', 'undefined', 'shorthand_property_identifier_pattern', 'type_identifier'].includes(node.type)) return [node];
    if (node.type === 'pair_pattern') return node.fields.value ? patternNames(node.fields.value) : [];
    if (['assignment_pattern', 'object_assignment_pattern'].includes(node.type)) return node.fields.left ? patternNames(node.fields.left) : node.children[0] ? patternNames(node.children[0]) : [];
    if (['object_pattern', 'array_pattern', 'rest_pattern', 'required_parameter', 'optional_parameter'].includes(node.type)) {
      const pattern = node.fields.pattern ?? node.fields.name;
      return pattern ? patternNames(pattern) : node.children.filter((n) => n.type !== 'type_annotation').flatMap(patternNames);
    }
    note('typescript.binding-pattern', 'Unsupported binding pattern remains unresolved.'); return [];
  };
  const walk = (node: SyntaxNode, scope: Scope, owner?: Declaration, exported: string[] = []) => {
    if (!tick()) return;
    scopes.set(node, scope);
    if (node.type === 'import_statement') {
      const moduleNode = node.fields.source;
      const module = moduleNode && moduleIdentity(moduleNode);
      const clause = node.children.find((n) => n.type === 'import_clause');
      if (module && clause) {
        const typeOnly = node.tokens.includes('type');
        for (const part of clause.children) {
          const importBinding = (nameNode: SyntaxNode, imported: string, onlyType: boolean) => addBinding({ name: text(nameNode), kind: 'import', node: nameNode, origin: { kind: 'import', module, name: imported }, typeOnly: onlyType, valueOnly: false, scope, stable: true, availableFrom: 0 });
          if (part.type === 'identifier') importBinding(part, 'default', typeOnly);
          else if (part.type === 'namespace_import') { const name = part.children.at(-1); if (name) importBinding(name, '*', typeOnly); }
          else if (part.type === 'named_imports') for (const specifier of part.children) {
            const imported = specifier.fields.name, local = specifier.fields.alias ?? imported;
            if (imported && local) importBinding(local, decodeString(text(imported)) ?? decodeIdentifier(text(imported)), typeOnly || specifier.tokens.includes('type'));
          }
        }
      }
    }
    if (node.type === 'export_statement') {
      if (node.fields.source) note('typescript.re-export', 'Re-export targets are not resolved across files.');
      const declaration = node.fields.declaration, value = node.fields.value;
      if (declaration) { walk(declaration, scope, owner, node.tokens.includes('default') ? ['default'] : ['*']); return; }
      if (value && value.type !== 'identifier') {
        const declaration = add(value, classes.has(value.type) ? 'class' : functions.has(value.type) ? 'function' : 'default', value.fields.name, owner, ['default']);
        walk(value, scope, declaration ?? owner); return;
      }
    }
    let own = nodeDeclarations.get(node);
    if (!own && exported.includes('default') && !node.fields.name && (classes.has(node.type) || functions.has(node.type))) own = add(node, classes.has(node.type) ? 'class' : 'function', undefined, owner, ['default']);
    if (!own && (classes.has(node.type) || functions.has(node.type) || ['interface_declaration', 'type_alias_declaration', 'enum_declaration', 'public_field_definition', 'property_signature'].includes(node.type))) {
      const name = node.fields.name;
      const member = ['method_definition', 'method_signature', 'abstract_method_signature', 'public_field_definition', 'property_signature'].includes(node.type);
      if (name && name.type !== 'computed_property_name') {
        const kind = classes.has(node.type) ? 'class' : node.type === 'interface_declaration' ? 'interface' : node.type === 'type_alias_declaration' ? 'type' : node.type === 'enum_declaration' ? 'enum' : member ? (functions.has(node.type) ? 'method' : 'property') : 'function';
        own = add(node, kind, name, owner, exported.includes('*') ? [text(name)] : [...exported]);
        if (!member && own && !['function_expression', 'generator_function', 'class'].includes(node.type)) {
          const isType = kind === 'type' || kind === 'interface';
          addBinding({ name: text(name), kind: isType ? 'type' : kind === 'class' ? 'class' : 'function', node, declaration: own.key, typeOnly: isType, valueOnly: kind === 'function', scope, stable: true, availableFrom: kind === 'class' ? node.endIndex : 0 });
        }
      } else if (name && member) {
        const expression = name.children.find(child => child.type !== 'comment');
        const computedName = expression && { kind: 'expression' as const, text: text(expression), span: span(expression) };
        if (computedName && wellFormed(computedName.text) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(computedName.text) && utf8Length(canonicalJSON(computedName)) <= limits.maxValueBytes) {
          own = add(node, functions.has(node.type) ? 'method' : 'property', undefined, owner);
          if (own) { own.computedName = computedName; own.nameSpan = span(name); }
        } else note('typescript.computed-member', 'Computed member source exceeds the retained evidence limit.');
      }
    }
    if (node.type === 'variable_declarator') {
      const pattern = node.fields.name, initializer = node.fields.value, container = parents.get(node);
      const kind = container?.tokens.includes('const') ? 'const' : container?.tokens.includes('let') ? 'let' : 'var';
      const projection = pattern && projectionQueries.patternProjections(pattern);
      const paths = new Map(projection?.projections.map((item) => [item.node, item.path]));
      let target = scope;
      if (kind === 'var') while (!target.functionScope && target.parent) target = target.parent;
      for (const name of pattern ? patternNames(pattern) : []) {
        const decl = add(pattern === name ? node : name, kind, name, owner, exported.includes('*') ? [text(name)] : [...exported]);
        if (decl) {
          addBinding({ name: text(name), kind, node, nameNode: name, declaration: decl.key, ...(initializer && pattern === name ? { initializer } : {}), typeOnly: false, valueOnly: true, scope: target, stable: kind === 'const', availableFrom: node.endIndex });
          if (initializer) {
            bindingSources.set(decl.key, Object.freeze({ initializer, path: paths.get(name) ?? Object.freeze([]), complete: !!projection?.complete && paths.has(name) }));
          }
        }
        if (!own && pattern === name) own = decl;
      }
    }
    let childScope = scope;
    if (functions.has(node.type) || classes.has(node.type) || ['statement_block', 'for_statement', 'for_in_statement', 'catch_clause', 'switch_body', 'internal_module', 'interface_declaration', 'type_alias_declaration'].includes(node.type)) {
      childScope = { parent: scope, functionScope: functions.has(node.type), bindings: new Map() };
      for (const parameter of node.fields.type_parameters?.children ?? []) {
        const name = parameter.fields.name;
        if (name) addBinding({ name: text(name), kind: 'type', node: name, typeOnly: true, valueOnly: false, scope: childScope, stable: true, availableFrom: 0 });
      }
      if ((node.type === 'function_expression' || node.type === 'generator_function' || classes.has(node.type)) && node.fields.name) {
        addBinding({ name: text(node.fields.name), kind: classes.has(node.type) ? 'class' : 'function', node, ...(own ? { declaration: own.key } : {}), typeOnly: false, valueOnly: !classes.has(node.type), scope: childScope, stable: true, availableFrom: classes.has(node.type) ? node.fields.body?.startIndex ?? node.endIndex : 0 });
      }
      const params = node.fields.parameters ?? node.fields.parameter;
      const patterns = params?.type === 'formal_parameters' ? params.children : params ? [params] : [];
      for (const param of patterns) for (const name of patternNames(param)) addBinding({ name: text(name), kind: 'parameter', node: name, typeOnly: false, valueOnly: true, scope: childScope, stable: false, availableFrom: 0 });
      if (node.type === 'catch_clause' && node.fields.parameter) for (const name of patternNames(node.fields.parameter)) addBinding({ name: text(name), kind: 'parameter', node: name, typeOnly: false, valueOnly: true, scope: childScope, stable: false, availableFrom: 0 });
      if (node.type === 'for_in_statement' && node.fields.left && node.tokens.some((token) => ['const', 'let', 'var'].includes(token))) {
        const kind = node.tokens.includes('const') ? 'const' : node.tokens.includes('let') ? 'let' : 'var';
        let target = childScope;
        if (kind === 'var') while (!target.functionScope && target.parent) target = target.parent;
        for (const name of patternNames(node.fields.left)) {
          const decl = add(name, kind, name, owner);
          addBinding({ name: text(name), kind, node: name, ...(decl ? { declaration: decl.key } : {}), typeOnly: false, valueOnly: true, scope: target, stable: false, availableFrom: 0 });
        }
      }
    }
    for (const child of node.children) walk(child, childScope, own ?? owner, ['lexical_declaration', 'variable_declaration', 'ambient_declaration'].includes(node.type) ? exported : []);
  };
  if (root.endIndex > root.startIndex) add(root, 'module');
  walk(root, rootScope);
  const lookup = (node: SyntaxNode, space: 'value' | 'type' = 'value'): Binding | undefined => {
    let scope = scopes.get(original(node));
    while (scope) {
      const candidates = scope.bindings.get(decodeIdentifier(text(node)));
      // Type-only imports intentionally block value-origin promotion of invalid code.
      const matches = candidates?.filter((b) => space === 'value' ? !b.typeOnly || b.kind === 'import' : !b.valueOnly);
      if (matches?.length) return matches.length === 1 ? matches[0] : undefined;
      scope = scope.parent;
    }
    return undefined;
  };
  const ownerOf = (node: SyntaxNode): Declaration | undefined => {
    let cursor: SyntaxNode | undefined = original(node);
    while (cursor) { const decl = nodeDeclarations.get(cursor); if (decl) return decl; cursor = parents.get(cursor); }
    return undefined;
  };
  // A const binding does not make its object immutable. Reject writes and escapes other
  // than direct call arguments; constant folding separately checks prior argument escapes.
  const unsafeObjects = new Set<Binding>();
  const unstableClassObjects = new Set<string>();
  const escapes = new Map<Binding, SyntaxNode[]>();
  const identityEscapes = new Map<Binding, SyntaxNode[]>();
  const aliasEscapes: { binding: Binding; occurrence?: SyntaxNode; identityOnly?: boolean }[] = [];
  const carriedReferences = (node: SyntaxNode): readonly SyntaxNode[] => {
    if (['member_expression', 'subscript_expression'].includes(node.type)) return node.fields.object ? [node.fields.object] : [];
    if (node.type === 'binary_expression' && node.tokens.some((token) => ['&&', '||', '??'].includes(token))) return [node.fields.left, node.fields.right].filter((item): item is SyntaxNode => !!item);
    if (node.type === 'ternary_expression') return [node.fields.consequence, node.fields.alternative].filter((item): item is SyntaxNode => !!item);
    if (node.type === 'sequence_expression') { const last = node.children.filter((item) => item.type !== 'comment').at(-1); return last ? [last] : []; }
    if (['await_expression', 'yield_expression', 'jsx_expression'].includes(node.type)) return node.children.filter((item) => item.type !== 'comment');
    return [];
  };
  const propagateEscape = (binding: Binding, occurrence?: SyntaxNode, identityOnly = false) => {
    const seen = new Set<Binding>();
    const pending = [binding];
    while (pending.length && seen.size < limits.maxDepth && tick()) {
      const alias = pending.pop()!;
      if (alias.kind !== 'const' || seen.has(alias)) continue;
      seen.add(alias);
      const source = alias.initializer ?? (alias.declaration && bindingSources.get(alias.declaration)?.initializer);
      if (!source) continue;
      const references = [source];
      while (references.length && tick()) {
        const initial = unwrap(references.pop()!);
        if (initial.type !== 'identifier') { references.push(...carriedReferences(initial)); continue; }
        const origin = lookup(initial);
        if (!origin) continue;
        if (occurrence === undefined) unsafeObjects.add(origin);
        else { const map = identityOnly ? identityEscapes : escapes, positions = map.get(origin) ?? []; positions.push(occurrence); map.set(origin, positions); }
        pending.push(origin);
      }
    }
    if (pending.length) note('typescript.work-limit', 'Reference escape propagation exceeds bounded alias traversal.', 'truncated');
  };
  for (const node of nodes) {
    if (!tick()) break;
    if (!['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'].includes(node.type)) continue;
    const binding = lookup(node);
    if (!binding || binding.node.fields.name === node || binding.node === node || binding.nameNode === node) continue;
    let at = node, parent = parents.get(at);
    while (parent) {
      const grandparent = parents.get(parent);
      const tagged = parent.type === 'template_substitution' && grandparent?.type === 'template_string' && parents.get(grandparent)?.fields.arguments === grandparent;
      const templateArguments = parent.type === 'template_string' && grandparent?.fields.arguments === parent;
      const jsxValue = parent.type === 'jsx_attribute' && parent.children[1] === at;
      const spreadArgument = parent.type === 'spread_element' && !!grandparent && ['arguments', 'jsx_expression'].includes(grandparent.type);
      if (!(wrappers.has(parent.type) || carriedReferences(parent).includes(at) || tagged || templateArguments || jsxValue || spreadArgument ||
        ['array_pattern', 'object_pattern', 'pair_pattern', 'rest_pattern'].includes(parent.type) ||
        (['assignment_pattern', 'object_assignment_pattern'].includes(parent.type) && (parent.fields.left ?? parent.children[0]) === at))) break;
      at = parent; parent = grandparent;
    }
    if (parent && ((['assignment_expression', 'augmented_assignment_expression', 'for_in_statement'].includes(parent.type) && parent.fields.left === at) || parent.type === 'update_expression' || (parent.type === 'unary_expression' && parent.tokens.includes('delete')))) {
      if (at === node || wrappers.has(at.type) || ['array_pattern', 'object_pattern'].includes(at.type) || binding.kind === 'import' || binding.kind === 'const') binding.stable = false;
      unsafeObjects.add(binding);
      propagateEscape(binding);
      let alias = binding;
      for (let i = 0; i < limits.maxDepth && alias.kind === 'const'; i++) {
        const source = alias.initializer ?? (alias.declaration && bindingSources.get(alias.declaration)?.initializer);
        if (!source) break;
        let initial = unwrap(source);
        while (['member_expression', 'subscript_expression'].includes(initial.type) && initial.fields.object) initial = unwrap(initial.fields.object);
        if (initial.type !== 'identifier') break;
        const origin = lookup(initial);
        if (!origin || origin === alias) break;
        unsafeObjects.add(origin);
        if (origin.kind === 'import' || origin.kind === 'const') origin.stable = false;
        if (origin.kind === 'class' && ['member_expression', 'subscript_expression'].includes(unwrap(at).type)) {
          origin.stable = false;
          if (origin.declaration) unstableClassObjects.add(origin.declaration);
          note('typescript.mutated-class-alias', 'A class object written through an alias is not a stable value origin.');
        }
        alias = origin;
      }
    } else if (parent?.type === 'arguments' || (parent?.type === 'call_expression' && (parent.fields.arguments === at ||
      (parent.fields.function === at && ['member_expression', 'subscript_expression'].includes(unwrap(at).type)))) ||
      (parent && ['jsx_element', 'jsx_fragment', 'jsx_opening_element', 'jsx_self_closing_element'].includes(parent.type) && parent.fields.name !== at)) {
      const list = escapes.get(binding) ?? []; list.push(parent); escapes.set(binding, list);
      aliasEscapes.push({ binding, occurrence: parent });
    } else if (parent && ['jsx_opening_element', 'jsx_self_closing_element'].includes(parent.type) && parent.fields.name === at) {
      // JSX does not deliver a receiver as a normal call argument. Retain this
      // separately for reviewed handle-identity queries, not constant folding.
      const list = identityEscapes.get(binding) ?? []; list.push(parent); identityEscapes.set(binding, list);
      aliasEscapes.push({ binding, occurrence: parent, identityOnly: true });
    } else if (parent && !['spread_element', 'template_substitution', 'binary_expression', 'ternary_expression', 'sequence_expression', 'unary_expression', 'export_specifier', 'export_statement', 'type_annotation', 'generic_type'].includes(parent.type)) {
      const safeAlias = parent.type === 'variable_declarator' && unwrap(parent.fields.value ?? parent) === unwrap(at) && parents.get(parent)?.tokens.includes('const');
      const jsxTag = ['jsx_opening_element', 'jsx_closing_element', 'jsx_self_closing_element'].includes(parent.type) && parent.fields.name === at;
      const directCall = (parent.type === 'call_expression' && parent.fields.function === at) || (parent.type === 'new_expression' && parent.fields.constructor === at);
      if (!safeAlias && !jsxTag && !directCall) {
        unsafeObjects.add(binding);
        if (parent.type !== 'call_expression' || parent.fields.function !== at) aliasEscapes.push({ binding });
      }
    }
  }
  const bindingAt = (node: SyntaxNode, space: 'value' | 'type' = 'value'): LexicalBinding | undefined => {
    const binding = lookup(unwrap(node), space);
    if (!binding) return undefined;
    const { name, kind, declaration, initializer, origin, typeOnly, stable } = binding;
    let available = space === 'type' || node.startIndex >= binding.availableFrom || kind === 'function' || kind === 'import';
    if (available && space === 'value' && kind === 'class' && node.startIndex >= binding.node.startIndex && node.endIndex <= binding.node.endIndex) {
      // Computed member names run before the class self binding is initialized.
      let cursor: SyntaxNode | undefined = original(node);
      while (cursor && cursor !== binding.node) {
        const member = parents.get(cursor), body = member && parents.get(member);
        if (cursor.type === 'computed_property_name' && body?.type === 'class_body' && parents.get(body) === binding.node) { available = false; break; }
        cursor = member;
      }
    }
    return Object.freeze({ name, kind, node: binding.node, ...(declaration ? { declaration } : {}), ...(initializer ? { initializer } : {}), ...(origin ? { origin: Object.freeze({ ...origin }) } : {}), typeOnly, stable: stable && !(declaration && unstableClassObjects.has(declaration)), available });
  };
  const expression = (node: SyntaxNode, space: 'value' | 'type'): Reference => ({ kind: space === 'type' ? 'type' : 'expression', text: text(node), span: span(node) });
  const reference = (input: SyntaxNode, space: 'value' | 'type' = 'value'): Reference => {
    const node = unwrap(input), binding = bindingAt(node, space);
    const declared = nodeDeclarations.get(node);
    if (declared && (functions.has(node.type) || classes.has(node.type))) return { kind: 'declaration', key: declared.key };
    if (binding?.available && !(space === 'value' && binding.typeOnly)) {
      if (binding.origin) return { ...binding.origin };
      if (binding.declaration) return { kind: 'declaration', key: binding.declaration };
    }
    return expression(input, space);
  };
  const resolve = (input: SyntaxNode, space: 'value' | 'type' = 'value', seen = new Set<SyntaxNode>()): Reference => {
    const node = unwrap(input);
    if (seen.size >= limits.maxDepth || seen.has(node)) return expression(input, space);
    seen.add(node);
    if (['member_expression', 'nested_type_identifier'].includes(node.type)) {
      const object = node.fields.object ?? node.fields.module, property = node.fields.property ?? node.fields.name;
      if (object && property && !node.tokens.includes('?.')) {
        const origin = resolve(object, space, seen);
        if (origin.kind === 'import' && origin.name === '*' && !origin.member) return { kind: 'import', module: origin.module, name: decodeIdentifier(text(property)) };
        if (origin.kind === 'import' && origin.name !== '*') return { ...origin, member: origin.member ? `${origin.member}.${decodeIdentifier(text(property))}` : decodeIdentifier(text(property)) };
      }
    }
    const binding = bindingAt(node, space);
    if (binding && space === 'value' && !binding.stable) return expression(input, space);
    if (binding?.available && binding.stable && !(space === 'value' && binding.typeOnly) && binding.initializer) {
      const initial = unwrap(binding.initializer);
      if (['identifier', 'member_expression', 'nested_type_identifier'].includes(initial.type)) return resolve(initial, space, seen);
    }
    if (space === 'value' && binding?.available && binding.stable && !binding.typeOnly && binding.declaration) {
      const source = bindingSources.get(binding.declaration);
      if (source?.complete && source.path.length) {
        const projected = projectionQueries.project(source.initializer, source.path);
        if (projected && projected.initializer !== node) {
          if (!projected.path.length) return resolve(projected.initializer, space, seen);
          const origin = resolve(projected.initializer, space, seen);
          if (origin.kind === 'import' && origin.name === '*' && !origin.member && projected.path.length === 1 && typeof projected.path[0] === 'string') return { kind: 'import', module: origin.module, name: projected.path[0] };
        }
      }
    }
    return reference(input, space);
  };
  for (const node of nodes) if (node.type === 'export_statement' && !node.fields.source) {
    const value = node.fields.value;
    if (value?.type === 'identifier' && node.tokens.includes('default')) {
      const target = lookup(value)?.declaration, decl = target && declarationByKey.get(target);
      if (decl && !decl.exports.includes('default')) decl.exports.push('default');
    }
    const clause = node.children.find((n) => n.type === 'export_clause');
    for (const specifier of clause?.children ?? []) {
      const name = specifier.fields.name, alias = specifier.fields.alias ?? name;
      if (!name || !alias) continue;
      const typeOnly = node.tokens.includes('type') || specifier.tokens.includes('type');
      const target = (lookup(name, typeOnly ? 'type' : 'value') ?? lookup(name, 'type'))?.declaration;
      const decl = target && declarationByKey.get(target);
      const exported = decodeString(text(alias)) ?? decodeIdentifier(text(alias));
      if (decl && !decl.exports.includes(exported)) {
        if (decl.exports.length >= 256 || utf8Length(exported) > Math.min(2048, limits.maxValueBytes) || !wellFormed(exported)) note('typescript.export-limit', 'Export aliases exceed the wire limit.', 'truncated');
        else decl.exports.push(exported);
      }
    }
  }
  const functionScope = (scope: Scope | undefined) => {
    while (scope?.parent && !scope.functionScope) scope = scope.parent;
    return scope;
  };
  const stableObject = (node: SyntaxNode, observation: SyntaxNode = node, offset = observation.startIndex, delivery?: SyntaxNode, preservesIdentity?: (occurrence: SyntaxNode, jsxTag: boolean) => boolean) => {
    const binding = lookup(node);
    if (!binding || unsafeObjects.has(binding)) return false;
    const observedScope = functionScope(scopes.get(original(observation))), declaredScope = functionScope(binding.scope);
    // Source order does not establish execution order across function scopes.
    const unsafe = (escape: SyntaxNode, jsxTag: boolean) => (!delivery || escape !== original(delivery)) && (observedScope !== declaredScope ||
      functionScope(scopes.get(escape)) !== declaredScope || escape.endIndex <= offset) && !preservesIdentity?.(escape, jsxTag);
    return !(escapes.get(binding) ?? []).some(escape => unsafe(escape, false)) && (!preservesIdentity || !(identityEscapes.get(binding) ?? []).some(escape => unsafe(escape, true)));
  };
  for (const { binding, occurrence, identityOnly } of aliasEscapes) {
    if (!tick()) break;
    const source = binding.declaration ? bindingSources.get(binding.declaration) : undefined;
    const value = source?.complete && projectionQueries.project(source.initializer, source.path);
    // Passing a captured primitive cannot mutate its former container.
    if (value && !value.path.length && ['string', 'number', 'true', 'false', 'null'].includes(value.initializer.type)) continue;
    propagateEscape(binding, occurrence, identityOnly);
  }
  const initializerProjection = (key: string): InitializerProjection | undefined => {
    const source = bindingSources.get(key), binding = declarationBindings.get(key);
    return source && Object.freeze({ ...source, complete: !!(source.complete && binding?.stable && projectionQueries.project(source.initializer, source.path)) });
  };
  const bindingQueries = createBindingQueries({ text, name, span, unwrap, limits, binding: bindingAt, stableObject,
    elements: node => arrayElements.get(original(node)) ?? [], step: tick });
  for (const node of nodes) {
    if (!tick()) break;
    const declaration = node.type === 'variable_declarator';
    const pattern = declaration ? node.fields.name : ['assignment_expression', 'for_in_statement'].includes(node.type) ? node.fields.left : undefined;
    if (!pattern || !['array_pattern', 'object_pattern'].includes(unwrap(pattern).type) || node.tokens.some(token => ['const', 'let', 'var'].includes(token))) continue;
    const source = declaration ? node.fields.value : node.type === 'assignment_expression' ? node.fields.right : undefined;
    const evidence = source && bindingQueries.pattern(pattern, source);
    let complete = !!evidence?.complete;
    for (const item of evidence?.bindings ?? []) {
      const target = declaration ? nodeDeclarations.get(item.node) : declarationByKey.get(lookup(item.node)?.declaration ?? '');
      if (!target) { complete = false; continue; }
      if (declaration) target.binding = item.evidence;
      else if ((target.writes?.length ?? 0) < 64) (target.writes ??= []).push(item.evidence);
      else complete = false;
    }
    if (!complete) note(declaration ? 'typescript.destructuring-value' : 'typescript.destructuring-assignment',
      'Binding operations or targets exceed supported source-evidence bounds; runtime values remain unknown.');
  }
  const query = { text, unwrap, binding: bindingAt, limits,
    stableObject: (node: SyntaxNode) => stableObject(node) && projectionQueries.referenceStable(node, node),
    project: projectionQueries.project };
  const constants = createConstantQueries(query);
  constructing = false;
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  for (const declaration of declarations) freeze(declaration);
  for (const diagnostic of diagnostics) Object.freeze(diagnostic);
  Object.freeze(declarations); Object.freeze(diagnostics); Object.freeze(nodes);
  return Object.freeze({ id: 'typescript', version: 1, language, relativePath, sourceHash, source, limits: Object.freeze(limits), root, nodes,
    declarations, state, diagnostics, text, name, moduleIdentity, span, parent: (node: SyntaxNode) => parents.get(original(node)), unwrap,
    declarationNode: (key: string) => declarationNodes.get(key), declarationAt: (node: SyntaxNode) => nodeDeclarations.get(original(node)),
    owner: ownerOf, binding: bindingAt, resolve, reference, initializerProjection, ...projectionQueries, ...constants,
  });
}

function utf8Length(value: string): number {
  let size = 0;
  for (const point of value) { const n = point.codePointAt(0)!; size += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4; }
  return size;
}
function wellFormed(value: string): boolean {
  for (const point of value) { const code = point.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) return false; }
  return true;
}
