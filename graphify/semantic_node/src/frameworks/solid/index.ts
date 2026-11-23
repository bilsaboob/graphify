import type { AnnotationPlugin, ReadonlyDeclaration as Declaration } from '#core';
import { canonicalJSON, type AnnotationDiagnostic, type FactEvidence, type Reference } from '#core/wire';
import type { SyntaxNode, TypeScriptView, ValueProjection } from '#typescript';
import { solidRule } from './contracts.js';
import { descriptor, type SolidProperty, type SolidRelation, type SolidRole } from './vocabulary.js';
import { analyzeSemantics, solidJSXContext, type SolidCall, type SolidHandle } from './semantics.js';
export { solidReturnContracts } from './contracts.js';
export type { SolidProperty, SolidRelation, SolidRole } from './vocabulary.js';

interface Handle { declaration: Declaration; node: SyntaxNode; projection: ValueProjection; slot: number; role: SolidRole }
const callKey = (node: SyntaxNode) => `${node.startIndex}:${node.endIndex}`;

/** Bounded, file-local reviewed contracts. Never loads or executes source libraries. */
export function createSolidPlugin(digests: { implementationDigest: string; configurationDigest: string }): AnnotationPlugin<TypeScriptView> {
  return {
    descriptor: descriptor(digests),
    analyze({ view, budget }, emitter) {
      if (view.state === 'truncated' || view.state === 'unsupported' || view.state === 'failed') return { state: view.state };
      const diagnostics: AnnotationDiagnostic[] = [];
      let matched = false, partial = false;
      const diagnose = (code: string, message: string, node: SyntaxNode) => {
        partial = true;
        if (diagnostics.length < 16 && !diagnostics.some((item) => item.code === code)) diagnostics.push({ code, message, span: view.span(node) });
      };
      const evidence = (node: SyntaxNode, ruleId: string): Omit<FactEvidence, 'pluginId'> => ({ ruleId, basis: 'import-bound', span: view.span(node) });
      const bounded = (value: unknown) => {
        let bytes = 0;
        for (const point of canonicalJSON(value)) { const code = point.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
        return bytes <= view.limits.maxValueBytes;
      };
      const relation = (subject: Declaration, term: SolidRelation, target: Reference, node: SyntaxNode, rule: string) => {
        budget.step();
        if (!bounded(target)) { diagnose('solid.reference-limit', 'Source reference exceeds the bounded wire value size.', node); return; }
        matched = true; emitter.relation(subject.key, term, target, evidence(node, rule));
      };
      const property = (subject: Declaration, term: SolidProperty, value: string, node: SyntaxNode) => {
        budget.step();
        if (!bounded({ kind: 'string', value }) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || [...value].some((point) => { const code = point.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) {
          diagnose('solid.key-limit', 'A semantic value is outside the bounded wire string contract.', node); return;
        }
        matched = true; emitter.property(subject.key, term, 'literal', { kind: 'string', value }, evidence(node, 'declared-contract'));
      };
      const handles = new Map<string, Handle>(), groups = new Map<string, Handle[]>(), factories = new Map<string, SolidCall>(), calls: SolidCall[] = [];
      for (const node of view.nodes) {
        budget.step();
        if (node.type !== 'call_expression' || !node.fields.function || node.tokens.includes('?.')) continue;
        const origin = view.resolve(node.fields.function);
        const rule = origin.kind === 'import' ? solidRule(origin.module, origin.name + (origin.member ? `.${origin.member}` : '')) : undefined;
        if (rule) {
          if (['onMount', 'onCleanup'].includes(rule.name)) {
            const args = node.fields.arguments?.children.filter(child => child.type !== 'comment') ?? [];
            if (args.length !== 1 || args[0]?.type === 'spread_element') {
              diagnose('solid.call-shape', 'Lifecycle registration requires one explicit callback argument.', node);
              continue;
            }
          }
          calls.push({ node, rule }); if (rule.result) factories.set(callKey(node), { node, rule });
        }
      }
      if (calls.some((entry) => entry.rule.name.startsWith('query.'))) {
        let escapedQuery = false;
        for (const node of view.nodes) {
          budget.step();
          if (!['identifier', 'member_expression'].includes(node.type)) continue;
          const origin = view.resolve(node);
          if (origin.kind !== 'import' || origin.module !== '@solidjs/router' || origin.name !== 'query' || origin.member) continue;
          const binding = view.binding(node);
          if (binding?.kind === 'import' && node.startIndex >= binding.node.startIndex && node.endIndex <= binding.node.endIndex) continue;
          let at = node, parent = view.parent(at);
          while (parent && ['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression'].includes(parent.type)) { budget.step(); at = parent; parent = view.parent(at); }
          if (parent?.type === 'variable_declarator' && parent.fields.value?.startIndex === at.startIndex && view.parent(parent)?.tokens.includes('const')) continue;
          if (parent?.type === 'call_expression' && parent.fields.function?.startIndex === at.startIndex && !parent.tokens.includes('?.')) continue;
          if (parent?.type === 'member_expression' && parent.fields.object?.startIndex === at.startIndex && !parent.tokens.includes('?.')) {
            const member = view.resolve(parent), call = view.parent(parent);
            if (member.kind === 'import' && member.member && solidRule(member.module, `${member.name}.${member.member}`) && call?.type === 'call_expression' && call.fields.function?.startIndex === parent.startIndex && !call.tokens.includes('?.')) continue;
          }
          escapedQuery = true; break;
        }
        if (escapedQuery) for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.rule.name.startsWith('query.')) {
          diagnose('solid.call-shape', 'Imported query namespace members may have escaped or been replaced.', calls[i]!.node); calls.splice(i, 1);
        }
      }
      const hasJSX = view.nodes.some((node) => node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element');
      const jsxContext = hasJSX && solidJSXContext(view, budget);
      if (!calls.length && !hasJSX) return partial ? { state: 'partial', diagnostics } : { state: 'not-applicable' };
      for (const declaration of view.declarations) {
        budget.step();
        if (declaration.kind !== 'const') continue;
        const node = view.declarationNode(declaration.key);
        if (!node) continue;
        // Ordinary scalar declarations still do not pay for projection queries.
        if (node.type === 'variable_declarator') {
          const initial = node.fields.value && view.unwrap(node.fields.value);
          if (!initial || (!['identifier', 'undefined', 'member_expression', 'subscript_expression'].includes(initial.type) &&
            !(initial.type === 'call_expression' && factories.get(callKey(initial))?.rule.slots?.['']))) continue;
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
        let role = factory.rule.slots?.[projection.path.map(String).join('.')];
        if (projection.contract === 'solid.split-props' && projection.partitions && projection.path.length) role = projection.path.length === 2 ? 'solid.prop' : slot === projection.partitions.keys.length ? 'solid.props-remainder' : 'solid.props-partition';
        if (projection.contract === 'solid.merge-props' && projection.path.length === 1) role = 'solid.prop';
        if (!role) continue;
        const handle: Handle = { declaration, node, projection, slot, role };
        handles.set(declaration.key, handle);
        const key = callKey(projection.initializer), group = groups.get(key) ?? [];
        group.push(handle); groups.set(key, group);
        matched = true; emitter.role(declaration.key, role, evidence(node, 'return-binding'));
        relation(declaration, 'solid.factory', view.resolve(projection.initializer.fields.function!), node, 'return-binding');
        relation(declaration, 'solid.created-by', view.reference(projection.initializer), node, 'return-binding');
        if (role === 'solid.signal-pair' || role === 'solid.store-pair') property(declaration, 'solid.return-contract', 'authored two-slot result; later slot identity requires mutation and escape proof', node);
        if (factory.rule.name === 'onCleanup') {
          const argument = projection.initializer.fields.arguments?.children.find((item) => item.type !== 'comment');
          if (argument) relation(declaration, 'solid.returned-callback', view.reference(argument), node, 'same-cleanup-callback');
          property(declaration, 'solid.return-contract', factory.rule.boundary!, node);
        }
        if (projection.partitions) {
          relation(declaration, 'solid.props-source', view.reference(projection.partitions.source), node, 'props-partition');
          property(declaration, 'solid.partition-index', String(slot), node);
          if (projection.path.length === 2) property(declaration, 'solid.prop-key', String(projection.path[1]), node);
          else {
            const remainder = slot === projection.partitions.keys.length;
            for (const key of remainder ? projection.partitions.keys.flat() : projection.partitions.keys[slot]!) property(declaration, remainder ? 'solid.excluded-key' : 'solid.included-key', key, node);
          }
        }
      }
      for (const [key, factory] of factories) {
        budget.step();
        const group = groups.get(key);
        if (!group?.length) {
          const parent = view.parent(factory.node);
          const returned = parent?.type === 'return_statement' || (parent?.type === 'arrow_function' && parent.fields.body?.startIndex === factory.node.startIndex);
          if (!returned && ['createSignal', 'createStore', 'splitProps'].includes(factory.rule.name)) diagnose('solid.unsupported-binding', 'Factory result has no proven stable supported binding projection.', factory.node);
          continue;
        }
        group.sort((a, b) => a.declaration.span.startByte - b.declaration.span.startByte);
        const canonical = new Map<string, Handle>();
        for (const handle of group) {
          budget.step();
          const path = JSON.stringify(handle.projection.path.map((key, i) => i === 0 && /^\d+$/.test(String(key)) ? Number(key) : key)), first = canonical.get(path);
          if (!first) canonical.set(path, handle);
          else relation(handle.declaration, 'solid.alias-of', { kind: 'declaration', key: first.declaration.key }, handle.node, 'stable-alias');
        }
        const read = canonical.get('[0]');
        if (read && ['solid.signal-accessor', 'solid.store'].includes(read.role)) for (const handle of group) {
          budget.step();
          if (handle.slot === 1 && handle.projection.path.length === 1) relation(handle.declaration, read.role === 'solid.signal-accessor' ? 'solid.setter-for' : 'solid.updater-for', { kind: 'declaration', key: read.declaration.key }, handle.node, 'return-pair');
        }
        if (read && ['solid.resource', 'solid.transition-pending'].includes(read.role)) for (const handle of group) {
          budget.step();
          if (handle.slot === 1) relation(handle.declaration, read.role === 'solid.resource' ? 'solid.resource-for' : 'solid.transition-for', { kind: 'declaration', key: read.declaration.key }, handle.node, 'return-pair');
        }
      }
      const invoked = (node: SyntaxNode): Handle | undefined => {
        const binding = view.binding(node);
        if (!binding?.available || !binding.stable || binding.typeOnly || !binding.declaration) return undefined;
        return handles.get(binding.declaration);
      };
      const handle = (input: SyntaxNode): SolidHandle | undefined => {
        const node = view.unwrap(input), known = invoked(node);
        if (known) return known;
        if (!['member_expression', 'subscript_expression'].includes(node.type) || !node.fields.object || node.tokens.includes('?.')) return undefined;
        const base = invoked(view.unwrap(node.fields.object));
        if (!base) return undefined;
        budget.step(512);
        const projection = view.project(node), factory = projection && factories.get(callKey(projection.initializer));
        const role = projection && factory?.rule.slots?.[projection.path.map(String).join('.')];
        return role && projection ? { declaration: base.declaration, role, projection } : undefined;
      };
      for (const node of view.nodes) {
        budget.step();
        if (node.type === 'call_expression' && node.fields.function && !node.tokens.includes('?.')) {
          const fn = view.unwrap(node.fields.function), bound = handle(fn), owner = view.owner(node);
          if (!bound || !owner) continue;
          const term = bound.role === 'solid.signal-accessor' ? 'solid.signal-read' : bound.role === 'solid.signal-setter' ? 'solid.signal-write' : bound.role === 'solid.store-updater' ? 'solid.store-update' :
            ['solid.accessor', 'solid.resource', 'solid.children', 'solid.transition-pending'].includes(bound.role) ? 'solid.accessor-read' :
            ['solid.selector', 'solid.reaction', 'solid.on-callback', 'solid.resource-mutator', 'solid.resource-refetch', 'solid.transition-start', 'solid.cleanup-callback', 'solid.disposer', 'solid.query', 'solid.action'].includes(bound.role) ? 'solid.handle-call' : undefined;
          if (term) relation(owner, term, view.reference(fn), node, 'direct-invocation');
        }
        if (!['member_expression', 'subscript_expression'].includes(node.type) || node.tokens.includes('?.')) continue;
        const parent = view.parent(node);
        if (parent && ['member_expression', 'subscript_expression'].includes(parent.type) && parent.fields.object?.startIndex === node.startIndex) continue;
        let target = node, context = parent;
        while (context && ['parenthesized_expression', 'as_expression', 'non_null_expression', 'satisfies_expression'].includes(context.type)) { budget.step(); target = context; context = view.parent(context); }
        if (context && ((['assignment_expression', 'augmented_assignment_expression'].includes(context.type) && context.fields.left?.startIndex === target.startIndex) || context.type === 'update_expression' || (context.type === 'unary_expression' && context.tokens.includes('delete')))) continue;
        let base = node;
        while (['member_expression', 'subscript_expression'].includes(base.type) && base.fields.object && !base.tokens.includes('?.')) { budget.step(); base = view.unwrap(base.fields.object); }
        const storeHandle = invoked(base), owner = view.owner(node);
        if (storeHandle?.role === 'solid.store' && owner) relation(owner, 'solid.store-read', view.reference(base), node, 'direct-store-read');
      }
      analyzeSemantics({ view, budget, calls, handle, relation, property, diagnose }, jsxContext);
      return { state: partial ? 'partial' : matched ? 'complete' : 'not-applicable', diagnostics };
    },
  };
}
