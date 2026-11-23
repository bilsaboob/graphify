import type { AnnotationPlugin } from '#core';
import { canonicalJSON, type AnnotationDiagnostic, type FactValue } from '#core/wire';
import type { SyntaxNode, TypeScriptView } from '#typescript';
import { transportBindingDescriptor, transportBindingRules as rules, transportBindingSpan, type TransportBindingProperty, type TransportBindingRole } from './transport-binding-vocabulary.js';

const callables = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function', 'arrow_function']);
const identifierTypes = new Set(['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern']);
const same = (a: SyntaxNode | undefined, b: SyntaxNode | undefined) => !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
const optional = (node: SyntaxNode) => node.tokens.includes('?.') || node.children.some(child => child.type === 'optional_chain');
type Property = [TransportBindingProperty, FactValue];
type Endpoint = { node: SyntaxNode; receiver: SyntaxNode; event: SyntaxNode; key: string; callback?: SyntaxNode; owner: SyntaxNode };
type Instance = { node: SyntaxNode; name: SyntaxNode; allocation: SyntaxNode; declaration: string; imported: SyntaxNode; endpoints: Endpoint[]; veto: boolean };

/** No compiler, import execution, project I/O, runtime version or pairing. */
export function createTransportBindingPlugin(digests: { implementationDigest: string; configurationDigest: string }): AnnotationPlugin<TypeScriptView> {
  return {
    descriptor: transportBindingDescriptor(digests),
    analyze({ document, view, budget }, emitter) {
      if (view.state !== 'complete') return { state: view.state };
      let work = 0, partial = false, truncated = false;
      const diagnostics: AnnotationDiagnostic[] = [];
      const stop = Symbol('transport-binding-limit');
      const diagnose = (code: string, node?: SyntaxNode) => {
        partial = true;
        if (diagnostics.some(item => item.code === `transport-binding.${code}`)) return;
        const message = 'File-local transport qualification is incomplete or outside the reviewed contract.';
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) { truncated = true; return; }
        diagnostics.push({ code: `transport-binding.${code}`, message, ...(node ? { span: view.span(node) } : {}) });
      };
      const limit = (code: string): never => { truncated = true; diagnose(code); throw stop; };
      const step = (amount = 1) => {
        work += amount;
        if (work > rules.maxWork) limit('work-limit');
        budget.step(amount);
      };
      const locator = (node: SyntaxNode) => transportBindingSpan(view.span(node));
      const args = (node: SyntaxNode) => node.fields.arguments?.children.filter(child => child.type !== 'comment') ?? [];
      const binding = (node: SyntaxNode) => { step(rules.maxDepth); return view.binding(node); };
      // Only a direct statement or an arrow expression body is admitted. Every
      // enclosing creation context is checked too; no branch condition is dropped.
      const endpointOwner = (node: SyntaxNode): SyntaxNode | undefined => {
        let child = node, parent = view.parent(child), owner: SyntaxNode | undefined;
        if (!parent || !(parent.type === 'expression_statement' || parent.type === 'arrow_function' && same(parent.fields.body, child))) return;
        while (parent) {
          step();
          if (callables.has(parent.type)) {
            if (!same(parent.fields.body, child)) return;
            owner ??= parent;
          } else if (!['expression_statement', 'statement_block', 'program', 'variable_declarator', 'lexical_declaration', 'export_statement', 'arguments', 'call_expression', 'parenthesized_expression'].includes(parent.type)) return;
          child = parent; parent = view.parent(parent);
        }
        return owner ?? view.root;
      };
      const staged: { subject: string; node: SyntaxNode; role: TransportBindingRole; ruleId: string; properties: Property[] }[] = [];
      try {
        if (Buffer.byteLength(document.source) > rules.maxSourceBytes) limit('source-limit');
        // Check the entire detached tree before using any lexical binding. The
        // language view must also have completed its declaration/reference scan.
        const pending: [SyntaxNode, number][] = [[view.root, 0]];
        while (pending.length) {
          const [node, depth] = pending.pop()!;
          step();
          if (depth > rules.maxDepth) limit('depth-limit');
          for (const child of node.children) pending.push([child, depth + 1]);
        }
        const nodeKey = (node: SyntaxNode) => `${node.type}:${node.startIndex}:${node.endIndex}`;
        const imports = new Map<string, SyntaxNode>();
        const importedNames = new Set<string>();
        let constructorVeto = false;
        for (const node of view.nodes) {
          step();
          if (identifierTypes.has(node.type) && ['require', 'eval'].includes(view.name(node) ?? '')) constructorVeto = true;
          if (node.type === 'call_expression') {
            const first = args(node)[0], fn = node.fields.function;
            if (fn?.type === 'import' || fn?.fields.property && ['getBuiltinModule', 'require', 'eval'].includes(view.name(fn.fields.property) ?? '')) constructorVeto = true;
            const endpoint = fn?.type === 'member_expression' && fn.fields.property && ['on', 'emit'].includes(view.name(fn.fields.property) ?? '');
            // A second builtin acquisition (including require/import aliases)
            // escapes this deliberately single-import-form inventory.
            if (!endpoint && first?.type === 'string' && [rules.module, 'events'].includes(view.name(first) ?? '')) constructorVeto = true;
          }
          if (node.type !== 'import_statement' || !node.fields.source) continue;
          const module = view.moduleIdentity(node.fields.source);
          if (module === 'node:module' || module === 'module') constructorVeto = true;
          if (module !== rules.module && module !== 'events') continue;
          if (node.tokens.includes('type')) continue;
          const clause = node.children.find(child => child.type === 'import_clause');
          for (const part of clause?.children ?? []) {
            step();
            if (part.type !== 'named_imports') { constructorVeto = true; continue; }
            for (const specifier of part.children) {
              step();
              if (specifier.type === 'comment' || specifier.tokens.includes('type')) continue;
              const name = specifier.fields.name, local = specifier.fields.alias ?? name;
              if (module !== rules.module || !name || name.type !== 'identifier' || view.name(name) !== rules.importedName || !local || local.type !== 'identifier') { constructorVeto = true; continue; }
              imports.set(nodeKey(local), specifier);
              importedNames.add(nodeKey(name));
            }
          }
        }
        if (!imports.size) return { state: 'not-applicable' };
        const importFor = (node: SyntaxNode) => imports.get(nodeKey(node));
        const instances: Instance[] = [];
        const retained = new Set(view.declarations.map(declaration => declaration.key));
        for (const node of view.nodes) {
          step();
          if (node.type !== 'new_expression' || node.fields.constructor?.type !== 'identifier') continue;
          const origin = binding(node.fields.constructor);
          if (!origin || origin.kind !== 'import' || origin.typeOnly) continue;
          const imported = importFor(origin.node);
          if (!imported) continue;
          const declarationNode = view.parent(node), container = declarationNode && view.parent(declarationNode);
          const name = declarationNode?.fields.name;
          const declaration = declarationNode && view.declarationAt(declarationNode);
          if (!origin.stable || !origin.available || !node.fields.arguments || args(node).length || node.fields.type_arguments || optional(node) ||
            declarationNode?.type !== 'variable_declarator' || !same(declarationNode.fields.value, node) || name?.type !== 'identifier' ||
            container?.type !== 'lexical_declaration' || !container.tokens.includes('const') || !same(view.parent(container), view.root) ||
            !declaration || declaration.kind !== 'const' || declaration.exports.length) {
            constructorVeto = true; diagnose('allocation-shape', node); continue;
          }
          if (!retained.has(declaration.key)) limit('inventory-limit');
          if (instances.length >= rules.maxInstances) limit('instance-limit');
          instances.push({ node: declarationNode, name, allocation: node, declaration: declaration.key, imported, endpoints: [], veto: false });
        }
        let endpoints = 0;
        for (const node of view.nodes) {
          step();
          if (!identifierTypes.has(node.type)) continue;
          const parent = view.parent(node);
          // Direct eval can observe local bindings without an identifier use.
          if (view.name(node) === 'eval' && parent?.type === 'call_expression' && same(parent.fields.function, node)) { constructorVeto = true; diagnose('dynamic-scope', node); }
          const origin = binding(node);
          if (origin?.kind === 'import' && importFor(origin.node)) {
            if (same(node, origin.node) || importedNames.has(nodeKey(node))) continue;
            if (!origin.stable || !origin.available || !instances.some(instance => same(instance.allocation.fields.constructor, node))) { constructorVeto = true; diagnose('constructor-use', node); }
            continue;
          }
          const instance = instances.find(item => origin?.declaration === item.declaration);
          if (!instance) {
            if (!origin) for (const item of instances) if (view.name(node) === view.name(item.name)) { item.veto = true; diagnose('ambiguous-reference', node); }
            continue;
          }
          if (same(node, instance.name)) continue;
          const call = parent && view.parent(parent);
          const values = call ? args(call) : [];
          const method = parent?.fields.property && view.name(parent.fields.property);
          const event = values[0], callback = method === 'on' ? values[1] : undefined;
          const raw = event?.type === 'string' ? view.text(event) : '';
          const key = raw.slice(1, -1);
          const owner = call && endpointOwner(call);
          if (!origin?.available || !origin.stable || node.type !== 'identifier' || parent?.type !== 'member_expression' || !same(parent.fields.object, node) || optional(parent) ||
            call?.type !== 'call_expression' || !same(call.fields.function, parent) || optional(call) || call.fields.type_arguments || !owner ||
            !['on', 'emit'].includes(method ?? '') || !event || !/^(?:"[\x20-\x21\x23-\x5b\x5d-\x7e]+"|'[\x20-\x26\x28-\x5b\x5d-\x7e]+')$/.test(raw) ||
            Buffer.byteLength(key) > rules.maxEventKeyBytes || rules.excludedEvents.some(value => value === key) || values.some(value => value.type === 'spread_element') ||
            (method === 'on' ? values.length !== 2 || callback?.type !== 'arrow_function' : values.length > rules.maxEmissionArguments)) {
            instance.veto = true; diagnose('receiver-use', node); continue;
          }
          if (++endpoints > rules.maxEndpoints) limit('endpoint-limit');
          instance.endpoints.push({ node: call, receiver: node, event, key, ...(callback ? { callback } : {}), owner });
        }
        if (constructorVeto) diagnose('constructor-use');
        // An escaped sibling allocation can expose the same constructor or
        // prototype. Do not certify another allocation by ignoring that use.
        if (constructorVeto || instances.some(instance => instance.veto)) return { state: truncated ? 'truncated' : 'partial', diagnostics };
        const string = (value: string): FactValue => ({ kind: 'string', value });
        let facts = 0;
        for (const instance of instances) {
          step();
          if (!instance.endpoints.length) continue;
          const common: Property[] = [
            ['declaration', { kind: 'reference', value: { kind: 'declaration', key: instance.declaration } }],
            ['import-reference', { kind: 'reference', value: { kind: 'import', module: rules.module, name: rules.importedName } }],
            ['allocation', string(locator(instance.allocation))], ['import', string(locator(instance.imported))],
            ...rules.conditions.map(condition => ['condition', string(condition)] as Property),
          ];
          const units = [
            { node: instance.allocation, role: 'event-instance' as const, ruleId: rules.rules[0], properties: [['owner', string(locator(view.root))], ['endpoint-count', { kind: 'integer', value: instance.endpoints.length }]] as Property[] },
            ...instance.endpoints.map(endpoint => ({ node: endpoint.node, role: endpoint.callback ? 'event-listener' as const : 'event-emission' as const, ruleId: endpoint.callback ? rules.rules[1] : rules.rules[2], properties: [
              ['owner', string(locator(endpoint.owner))], ['receiver', string(locator(endpoint.receiver))], ['event-literal', string(locator(endpoint.event))], ['event-key', string(endpoint.key)],
              ...(endpoint.callback ? [['callback', string(locator(endpoint.callback))] as Property] : []),
            ] as Property[] })),
          ];
          for (const unit of units) {
            const subject = view.owner(unit.node)?.key ?? limit('inventory-limit');
            if (!retained.has(subject)) limit('inventory-limit');
            const properties: Property[] = [...common, ...unit.properties, ['inventory-complete', { kind: 'boolean', value: true }], ['unit-complete', { kind: 'boolean', value: true }]];
            facts += properties.length + 1;
            if (facts > rules.maxFacts) limit('fact-limit');
            if (properties.some(([, value]) => Buffer.byteLength(canonicalJSON(value)) > view.limits.maxValueBytes)) limit('value-limit');
            staged.push({ ...unit, subject, properties });
          }
        }
        // No completion markers reach the emitter until every file-local use has
        // been checked. Composition drops this plugin's whole source unit on any
        // emission/output limit, because wire v1 has no transactional emitter.
        for (const unit of staged) {
          step();
          const evidence = { ruleId: unit.ruleId, basis: 'import-bound' as const, span: view.span(unit.node) };
          if (!emitter.role(unit.subject, `transport-binding.${unit.role}`, evidence)) limit('output-limit');
          for (const [property, value] of unit.properties) {
            step();
            if (!emitter.property(unit.subject, `transport-binding.${property}`, 'literal', value, evidence)) limit('output-limit');
          }
        }
      } catch (error) {
        if (error !== stop) throw error;
      }
      return { state: truncated ? 'truncated' : partial ? 'partial' : staged.length ? 'complete' : 'not-applicable', diagnostics };
    },
  };
}
