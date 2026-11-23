import type { AnnotationPlugin } from '#core';
import { canonicalJSON, type AnnotationDiagnostic, type FactValue } from '#core/wire';
import type { SyntaxNode, TypeScriptView } from '#typescript';
import { dispatchBindingDescriptor, dispatchBindingRules as rules, dispatchBindingSpan, type DispatchBindingProperty, type DispatchBindingRole } from './dispatch-binding-vocabulary.js';

const same = (a: SyntaxNode | undefined, b: SyntaxNode | undefined) => !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
const key = (node: SyntaxNode) => `${node.type}:${node.startIndex}:${node.endIndex}`;
const identifiers = new Set(['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern']);
const callables = new Set(['function_declaration', 'function_expression', 'arrow_function']);
const dynamicReferences = new Set(['eval', 'Function', 'require', 'getBuiltinModule', 'createRequire']);
const ambientObjects = new Set(['globalThis', 'global', 'window', 'self', 'module']);
const optional = (node: SyntaxNode) => node.tokens.includes('?.') || node.children.some(child => child.type === 'optional_chain');
type Property = [DispatchBindingProperty, FactValue];
type Imported = { node: SyntaxNode; module: string; name: string };
type Local = { node: SyntaxNode; name: SyntaxNode; allocation: SyntaxNode; declaration: string };
type Initializer = Local & { imported: Imported };
type Endpoint = { node: SyntaxNode; owner: SyntaxNode; role: 'dispatch-handler' | 'dispatch-call'; ruleId: string; properties: Property[] };
type Family = Local & { imported: Imported; kind: 'elysia-http' | 'trpc-rpc'; initializer?: Initializer; endpoints: Endpoint[]; caller?: Local; callerReceiver?: SyntaxNode; callerMethod?: SyntaxNode; context?: SyntaxNode };

/** Inert syntax qualification only. Never imports indexed packages or creates pairs. */
export function createDispatchBindingPlugin(digests: { implementationDigest: string; configurationDigest: string }): AnnotationPlugin<TypeScriptView> {
  return {
    descriptor: dispatchBindingDescriptor(digests),
    analyze({ document, view, budget }, emitter) {
      if (view.state !== 'complete') return { state: view.state };
      let work = 0, veto = false, truncated = false, endpointCount = 0;
      const diagnostics: AnnotationDiagnostic[] = [], stop = Symbol('dispatch-binding-limit');
      const diagnose = (code: string, node?: SyntaxNode) => {
        veto = true;
        if (diagnostics.some(item => item.code === `dispatch-binding.${code}`)) return;
        const message = 'File-local dispatch qualification is incomplete or outside the reviewed in-process contract.';
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) { truncated = true; return; }
        diagnostics.push({ code: `dispatch-binding.${code}`, message, ...(node ? { span: view.span(node) } : {}) });
      };
      const limit = (code: string): never => { truncated = true; diagnose(code); throw stop; };
      const step = (amount = 1) => { work += amount; if (work > rules.maxWork) limit('work-limit'); budget.step(amount); };
      const binding = (node: SyntaxNode) => { step(rules.maxDepth); return view.binding(node); };
      const children = (node: SyntaxNode) => node.children.filter(child => child.type !== 'comment');
      const args = (node: SyntaxNode) => node.fields.arguments ? children(node.fields.arguments) : [];
      const string = (value: string): FactValue => ({ kind: 'string', value });
      const integer = (value: number): FactValue => ({ kind: 'integer', value });
      const span = (node: SyntaxNode): FactValue => string(dispatchBindingSpan(view.span(node)));
      const reference = (declaration: string): FactValue => ({ kind: 'reference', value: { kind: 'declaration', key: declaration } });
      const identifier = (node: SyntaxNode) => /^[$A-Z_a-z][$\w]*$/.test(view.text(node)) && Buffer.byteLength(view.text(node)) <= rules.maxIdentifierBytes;
      const literal = (node: SyntaxNode | undefined) => {
        const raw = node?.type === 'string' ? view.text(node) : '';
        return /^(?:"[\x20-\x21\x23-\x5b\x5d-\x7e]*"|'[\x20-\x26\x28-\x5b\x5d-\x7e]*')$/.test(raw) ? raw.slice(1, -1) : undefined;
      };
      const path = (value: string | undefined) => value !== undefined && Buffer.byteLength(value) <= rules.maxPathBytes && /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(value);
      const member = (node: SyntaxNode | undefined) => {
        if (node?.type !== 'member_expression' || optional(node) || node.fields.property?.type !== 'property_identifier' || !identifier(node.fields.property) || !node.fields.object) return;
        return { receiver: node.fields.object, method: node.fields.property, name: view.text(node.fields.property) };
      };
      const call = (node: SyntaxNode | undefined) => {
        if (node?.type !== 'call_expression' || !node.fields.arguments || node.fields.type_arguments || optional(node)) return;
        const target = member(node.fields.function);
        return target && { ...target, args: args(node) };
      };
      // A complete family census must also veto ambient evaluator exposure.
      const dynamicExposure = (node: SyntaxNode): boolean => {
        if (identifiers.has(node.type)) {
          const name = view.name(node) ?? '';
          if (dynamicReferences.has(name) || ambientObjects.has(name)) return true;
          if (name === 'process') {
            const env = view.parent(node), access = env && view.parent(env);
            return !(env?.type === 'member_expression' && same(env.fields.object, node) && !optional(env) && env.fields.property && view.name(env.fields.property) === 'env' &&
              access?.type === 'member_expression' && same(access.fields.object, env) && !optional(access) && access.fields.property?.type === 'property_identifier');
          }
        }
        const property = node.type === 'member_expression' ? node.fields.property : node.type === 'subscript_expression' ? node.fields.index : node.type === 'pair_pattern' ? node.fields.key : undefined;
        const name = property && view.name(property);
        return node.type === 'import' || !!name && (dynamicReferences.has(name) || name === 'constructor');
      };
      const owner = (node: SyntaxNode, registration = false): SyntaxNode | undefined => {
        let child = node, parent = view.parent(node), result: SyntaxNode | undefined;
        if (!registration && parent?.type === 'await_expression') { child = parent; parent = view.parent(parent); }
        if (!parent || !(parent.type === 'expression_statement' || !registration && (parent.type === 'return_statement' || parent.type === 'arrow_function' && same(parent.fields.body, child) || parent.type === 'variable_declarator' && same(parent.fields.value, child)))) return;
        while (parent) {
          step();
          if (callables.has(parent.type)) {
            if (!same(parent.fields.body, child)) return;
            result ??= parent;
          } else if (!['program', 'statement_block', 'expression_statement', 'return_statement', 'variable_declarator', 'lexical_declaration', 'export_statement'].includes(parent.type)) return;
          child = parent; parent = view.parent(parent);
        }
        return result ?? view.root;
      };
      const staged: { node: SyntaxNode; subject: string; role: DispatchBindingRole; ruleId: string; properties: Property[] }[] = [];
      try {
        if (Buffer.byteLength(document.source) > rules.maxSourceBytes) limit('source-limit');
        const pending: [SyntaxNode, number][] = [[view.root, 0]];
        while (pending.length) {
          const [node, depth] = pending.pop()!;
          step(); if (depth > rules.maxDepth) limit('depth-limit');
          for (const child of node.children) pending.push([child, depth + 1]);
        }
        const imports = new Map<string, Imported>(), importTokens = new Set<string>(), names = new Set<string>();
        for (const node of view.nodes) {
          step();
          if (dynamicExposure(node)) diagnose('dynamic-scope', node);
          if (node.type !== 'import_statement' || !node.fields.source || node.tokens.includes('type')) continue;
          const module = view.moduleIdentity(node.fields.source);
          if (module === 'node:module' || module === 'module' || module === 'node:vm' || module === 'vm') diagnose('dynamic-scope', node);
          const api = [rules.http, rules.rpc, rules.request].find(api => module === api.module);
          if (!api) {
            if (module && [rules.http, rules.rpc, rules.request].some(api => module.startsWith(`${api.module}/`))) diagnose('import-shape', node);
            continue;
          }
          const clause = node.children.find(child => child.type === 'import_clause');
          if (!clause) { diagnose('import-shape', node); continue; }
          for (const part of children(clause)) {
            step();
            if (part.type !== 'named_imports') { diagnose('import-shape', part); continue; }
            for (const specifier of children(part)) {
              step(); if (specifier.tokens.includes('type')) continue;
              const imported = specifier.fields.name, local = specifier.fields.alias ?? imported;
              if (imported?.type !== 'identifier' || view.text(imported) !== api.name || local?.type !== 'identifier' || !identifier(local)) { diagnose('import-shape', specifier); continue; }
              imports.set(key(local), { node: specifier, module: api.module, name: api.name });
              importTokens.add(key(local)); importTokens.add(key(imported)); names.add(view.name(local)!);
            }
          }
        }
        if (![...imports.values()].some(imported => imported.module !== rules.request.module)) return { state: 'not-applicable' };
        const allowed = new Set<string>(), declarations = new Set<string>(), tracked = new Set<string>();
        const retained = new Set(view.declarations.map(declaration => declaration.key));
        const importedAt = (node: SyntaxNode | undefined, module: string) => {
          if (node?.type !== 'identifier' || !identifier(node)) return;
          const origin = binding(node), imported = origin?.kind === 'import' ? imports.get(key(origin.node)) : undefined;
          return origin?.available && origin.stable && !origin.typeOnly && imported?.module === module ? imported : undefined;
        };
        const local = (allocation: SyntaxNode): Local | undefined => {
          const node = view.parent(allocation), container = node && view.parent(node), name = node?.fields.name;
          const declaration = node && view.declarationAt(node);
          if (node?.type !== 'variable_declarator' || !same(node.fields.value, allocation) || name?.type !== 'identifier' || !identifier(name) || container?.type !== 'lexical_declaration' || !container.tokens.includes('const') || !same(view.parent(container), view.root) || !declaration || declaration.kind !== 'const' || declaration.exports.length) { diagnose('allocation-shape', allocation); return; }
          if (!retained.has(declaration.key)) limit('inventory-limit');
          tracked.add(declaration.key); declarations.add(key(name)); names.add(view.name(name)!);
          return { node, name, allocation, declaration: declaration.key };
        };
        const declarationOf = (node: SyntaxNode | undefined) => {
          if (node?.type !== 'identifier' || !identifier(node)) return;
          const origin = binding(node);
          return origin?.available && origin.stable ? origin.declaration : undefined;
        };
        const families: Family[] = [], initializers: Initializer[] = [];
        const addFamily = (family: Family) => { if (families.length >= rules.maxFamilies) limit('family-limit'); families.push(family); };
        const addEndpoint = (family: Family, endpoint: Endpoint) => { if (++endpointCount > rules.maxEndpoints) limit('endpoint-limit'); family.endpoints.push(endpoint); };
        const argumentProperties = (values: readonly SyntaxNode[]): Property[] => [['argument-count', integer(values.length)], ...values.map(value => ['argument', span(value)] as Property)];
        for (const node of view.nodes) {
          step();
          const ctor = node.fields.constructor, imported = node.type === 'new_expression' ? importedAt(ctor, rules.http.module) : undefined;
          if (imported && ctor) {
            if (!node.fields.arguments || args(node).length || node.fields.type_arguments || optional(node)) { diagnose('allocation-shape', node); continue; }
            const declaration = local(node);
            if (declaration) { allowed.add(key(ctor)); addFamily({ ...declaration, imported, kind: 'elysia-http', endpoints: [] }); }
          }
          const invocation = call(node), initImport = invocation?.name === 'create' ? importedAt(invocation.receiver, rules.rpc.module) : undefined;
          if (invocation && initImport) {
            if (invocation.args.length) { diagnose('initializer-shape', node); continue; }
            const declaration = local(node);
            if (declaration) {
              if (initializers.length >= rules.maxFamilies) limit('family-limit');
              allowed.add(key(invocation.receiver)); initializers.push({ ...declaration, imported: initImport });
            }
          }
        }
        for (const node of view.nodes) {
          step();
          const invocation = call(node);
          if (!invocation || invocation.name !== 'router') continue;
          const declaration = declarationOf(invocation.receiver), initializer = initializers.find(init => init.declaration === declaration);
          if (!initializer) continue;
          const shape = invocation.args[0], bindingLocal = local(node);
          if (!bindingLocal || invocation.args.length !== 1 || shape?.type !== 'object' || !children(shape).length) { diagnose('router-shape', node); continue; }
          const family: Family = { ...bindingLocal, imported: initializer.imported, initializer, kind: 'trpc-rpc', endpoints: [] }, keys = new Set<string>();
          for (const field of children(shape)) {
            step();
            const selector = field.fields.key, procedure = field.fields.value, invocation = call(procedure);
            const builder = invocation && member(invocation.receiver), handler = invocation?.args[0];
            if (field.type !== 'pair' || selector?.type !== 'property_identifier' || !identifier(selector) || rules.rpc.reserved.some(value => value === view.text(selector)) || keys.has(view.text(selector)) || !procedure || !invocation || !rules.rpc.kinds.some(kind => kind === invocation.name) || invocation.args.length !== 1 || handler?.type !== 'arrow_function' || !builder || builder.name !== 'procedure' || declarationOf(builder.receiver) !== initializer.declaration) { diagnose('procedure-shape', field); continue; }
            keys.add(view.text(selector)); allowed.add(key(builder.receiver));
            addEndpoint(family, { node: procedure, owner: view.root, role: 'dispatch-handler', ruleId: rules.rules[4], properties: [
              ['receiver', span(builder.receiver)], ['selector', span(selector)], ['method', span(invocation.method)], ['handler', span(handler)], ['procedure-key', string(view.text(selector))], ['procedure-kind', string(invocation.name)], ...argumentProperties(invocation.args),
            ] });
          }
          allowed.add(key(invocation.receiver)); addFamily(family);
        }
        for (const node of view.nodes) {
          step();
          const invocation = call(node);
          if (!invocation || invocation.name !== 'createCaller') continue;
          const declaration = declarationOf(invocation.receiver), family = families.find(family => family.kind === 'trpc-rpc' && family.declaration === declaration);
          if (!family) continue;
          const context = invocation.args[0], bindingLocal = local(node);
          if (!bindingLocal || family.caller || invocation.args.length !== 1 || context?.type !== 'object' || children(context).length) { diagnose('caller-shape', node); continue; }
          family.caller = bindingLocal; family.context = context; family.callerReceiver = invocation.receiver; family.callerMethod = invocation.method;
          allowed.add(key(invocation.receiver));
        }
        for (const node of view.nodes) {
          step();
          const invocation = call(node);
          if (!invocation) continue;
          const declaration = declarationOf(invocation.receiver), family = declaration && families.find(family => family.kind === 'elysia-http' ? family.declaration === declaration : family.caller?.declaration === declaration);
          if (!family) continue;
          const values = invocation.args;
          if (family.kind === 'trpc-rpc') {
            const lexicalOwner = owner(node);
            if (!lexicalOwner || values.length > rules.maxArguments || values.some(value => value.type === 'spread_element') || !family.endpoints.some(endpoint => endpoint.role === 'dispatch-handler' && endpoint.properties.some(([property, value]) => property === 'procedure-key' && value.kind === 'string' && value.value === invocation.name))) { diagnose('caller-use', node); continue; }
            allowed.add(key(invocation.receiver));
            addEndpoint(family, { node, owner: lexicalOwner, role: 'dispatch-call', ruleId: rules.rules[6], properties: [
              ['receiver', span(invocation.receiver)], ['selector', span(invocation.method)], ['method', span(invocation.method)], ['procedure-key', string(invocation.name)], ['caller', span(family.caller!.allocation)], ['caller-declaration', reference(family.caller!.declaration)], ...argumentProperties(values),
            ] });
            continue;
          }
          const method = invocation.name.toUpperCase();
          if (rules.http.methods.some(value => value === method) && invocation.name === method.toLowerCase()) {
            const selector = values[0], handler = values[1], value = literal(selector), lexicalOwner = owner(node, true);
            if (!lexicalOwner || values.length !== 2 || !selector || !path(value) || handler?.type !== 'arrow_function' || family.endpoints.some(endpoint => endpoint.properties.some(([property, item]) => property === 'path' && item.kind === 'string' && item.value === value) && endpoint.properties.some(([property, item]) => property === 'http-method' && item.kind === 'string' && item.value === method) && endpoint.role === 'dispatch-handler')) { diagnose('route-shape', node); continue; }
            allowed.add(key(invocation.receiver));
            addEndpoint(family, { node, owner: lexicalOwner, role: 'dispatch-handler', ruleId: rules.rules[1], properties: [
              ['receiver', span(invocation.receiver)], ['selector', span(selector)], ['method', span(invocation.method)], ['handler', span(handler)], ['http-method', string(method)], ['path', string(value!)], ...argumentProperties(values),
            ] });
            continue;
          }
          if (invocation.name !== 'handle') { diagnose('receiver-use', node); continue; }
          const request = values[0], ctor = request?.fields.constructor, lexicalOwner = owner(node);
          const requestImport = importedAt(ctor, rules.request.module);
          const ambient = ctor?.type === 'identifier' && view.text(ctor) === 'Request' && !binding(ctor);
          const requestArgs = request ? args(request) : [], url = literal(requestArgs[0]);
          const parsed = url && Buffer.byteLength(url) <= rules.maxURLBytes ? /^https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::([0-9]{1,5}))?(\/[^?#]*)$/.exec(url) : null;
          const host = parsed?.[1], port = parsed?.[2], requestPath = parsed?.[3];
          const hostValid = host && (/^[A-Za-z0-9]+(?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && host.split('.').every(label => label.length <= 63 && !label.startsWith('-') && !label.endsWith('-')) && (/[A-Za-z]/.test(host) || /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(host) && host.split('.').every(part => Number(part) <= 255)));
          let httpMethod = 'GET', methodLiteral: SyntaxNode | undefined, validOptions = true;
          if (requestArgs[1]) {
            const options = requestArgs[1], fields = children(options), field = fields[0];
            methodLiteral = field?.fields.value;
            const explicit = literal(methodLiteral);
            if (options.type !== 'object' || fields.length !== 1 || field?.type !== 'pair' || field.fields.key?.type !== 'property_identifier' || view.text(field.fields.key) !== 'method' || !rules.http.methods.some(value => value === explicit)) validOptions = false;
            else httpMethod = explicit!;
          }
          if (!lexicalOwner || values.length !== 1 || request?.type !== 'new_expression' || !request.fields.arguments || request.fields.type_arguments || optional(request) || !ctor || (!requestImport && !ambient) || requestArgs.length < 1 || requestArgs.length > 2 || !validOptions || !hostValid || port && Number(port) > 65535 || !path(requestPath)) { diagnose('request-shape', node); continue; }
          allowed.add(key(invocation.receiver)); allowed.add(key(ctor));
          addEndpoint(family, { node, owner: lexicalOwner, role: 'dispatch-call', ruleId: rules.rules[2], properties: [
            ['receiver', span(invocation.receiver)], ['selector', span(requestArgs[0]!)], ['method', span(invocation.method)], ['request', span(request)], ['request-constructor', span(ctor)], ['request-origin', string(requestImport ? 'undici-named' : 'ambient-fetch')],
            ['http-method', string(httpMethod)], ['path', string(requestPath!)], ...argumentProperties(values),
            ...(methodLiteral ? [['method-literal', span(methodLiteral)]] as Property[] : []),
            ...(requestImport ? [['request-import', span(requestImport.node)], ['request-import-reference', { kind: 'reference', value: { kind: 'import', module: rules.request.module, name: rules.request.name } }]] as Property[] : []),
          ] });
        }
        // A complete lexical inventory includes unsupported uses after otherwise
        // valid endpoints, and ambient Request mutation/extraction. No alias chase.
        for (const node of view.nodes) {
          step();
          if (!identifiers.has(node.type) || importTokens.has(key(node)) || declarations.has(key(node))) continue;
          const origin = binding(node), imported = origin?.kind === 'import' && imports.has(key(origin.node));
          if (imported || origin?.declaration && tracked.has(origin.declaration)) {
            if (!origin?.available || !origin.stable || origin.typeOnly || !allowed.has(key(node))) diagnose('binding-use', node);
          } else if (!origin && (names.has(view.name(node) ?? '') || view.name(node) === 'Request') && !allowed.has(key(node))) diagnose('ambiguous-reference', node);
        }
        if (veto) return { state: truncated ? 'truncated' : 'partial', diagnostics };
        let facts = 0;
        const stage = (family: Family, node: SyntaxNode, lexicalOwner: SyntaxNode, role: DispatchBindingRole, ruleId: string, properties: Property[], subject?: string) => {
          const owning = subject ?? view.owner(lexicalOwner)?.key ?? limit('inventory-limit');
          if (!retained.has(owning)) limit('inventory-limit');
          const all: Property[] = [
            ['declaration', reference(family.declaration)], ['import-reference', { kind: 'reference', value: { kind: 'import', module: family.imported.module, name: family.imported.name } }], ['import', span(family.imported.node)], ['allocation', span(family.allocation)], ['owner', span(lexicalOwner)],
            ['family', string(family.kind)], ['api-assumption', string(family.kind === 'elysia-http' ? rules.http.assumption : rules.rpc.assumption)],
            ...(family.initializer ? [['initializer-declaration', reference(family.initializer.declaration)], ['initializer', span(family.initializer.allocation)]] as Property[] : []),
            ...[...rules.conditions, ...(family.kind === 'elysia-http' ? rules.httpConditions : rules.rpcConditions)].map(condition => ['condition', string(condition)] as Property),
            ...properties, ['inventory-complete', { kind: 'boolean', value: true }], ['unit-complete', { kind: 'boolean', value: true }],
          ];
          facts += all.length + 1;
          if (facts > Math.min(rules.maxFacts, view.limits.maxFacts)) limit('fact-limit');
          if (all.some(([, value]) => Buffer.byteLength(canonicalJSON(value)) > view.limits.maxValueBytes)) limit('value-limit');
          staged.push({ node, subject: owning, role, ruleId, properties: all });
        };
        for (const family of families) {
          step();
          stage(family, family.allocation, view.root, 'dispatch-family', family.kind === 'elysia-http' ? rules.rules[0] : rules.rules[3], [
            ['family-count', integer(families.length)], ['endpoint-count', integer(family.endpoints.length)], ['caller-count', integer(family.caller ? 1 : 0)],
          ], family.declaration);
          if (family.caller) stage(family, family.caller.allocation, view.root, 'dispatch-caller', rules.rules[5], [
            ['caller', span(family.caller.allocation)], ['caller-declaration', reference(family.caller.declaration)], ['receiver', span(family.callerReceiver!)], ['method', span(family.callerMethod!)], ['context', span(family.context!)], ...argumentProperties([family.context!]),
          ], family.caller.declaration);
          for (const endpoint of family.endpoints) stage(family, endpoint.node, endpoint.owner, endpoint.role, endpoint.ruleId, endpoint.properties);
        }
        // All qualification and census checks precede output. Composition discards
        // this entire plugin's source output if the wire-v1 emitter truncates.
        for (const unit of staged) {
          step();
          const evidence = { ruleId: unit.ruleId, basis: 'import-bound' as const, span: view.span(unit.node) };
          if (!emitter.role(unit.subject, `dispatch-binding.${unit.role}`, evidence)) limit('output-limit');
          for (const [property, value] of unit.properties) {
            step();
            if (!emitter.property(unit.subject, `dispatch-binding.${property}`, 'literal', value, evidence)) limit('output-limit');
          }
        }
      } catch (error) { if (error !== stop) throw error; }
      return { state: truncated ? 'truncated' : veto ? 'partial' : staged.length ? 'complete' : 'not-applicable', diagnostics };
    },
  };
}
