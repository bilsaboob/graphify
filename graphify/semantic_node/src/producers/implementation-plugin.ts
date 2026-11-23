import type { AnnotationPlugin } from '#core';
import { canonicalJSON, type AnnotationDiagnostic, type EvidenceBasis, type FactValue } from '#core/wire';
import type { SyntaxNode, TypeScriptView } from '#typescript';
import { implementationDescriptor, implementationRules as rules, implementationSpan, type ImplementationProperty, type ImplementationRole } from './implementation-vocabulary.js';

const callables = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function', 'arrow_function', 'method_definition']);
const wrappers = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'type_assertion', 'non_null_expression']);
const members = new Set(['member_expression', 'subscript_expression']);
const writes = new Set(['assignment_expression', 'augmented_assignment_expression', 'update_expression']);
const operators = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=', '++', '--']);
const expectMatchers: Record<string, number> = {
  toBe: 1, toEqual: 1, toStrictEqual: 1, toContain: 1, toHaveLength: 1, toMatch: 1,
  toBeTruthy: 0, toBeFalsy: 0, toBeNull: 0, toBeUndefined: 0, toBeDefined: 0,
};
const assertMatchers: Record<string, number> = { ok: 1, equal: 2, notEqual: 2, strictEqual: 2, notStrictEqual: 2, deepEqual: 2, notDeepEqual: 2, deepStrictEqual: 2, notDeepStrictEqual: 2, match: 2, doesNotMatch: 2 };
type Property = [ImplementationProperty, string | boolean];
type Env = { source: 'process.env' | 'import.meta.env'; provenance: 'import-bound' | 'ambient-assumed' | 'syntax'; basis: EvidenceBasis };
const same = (a: SyntaxNode | undefined, b: SyntaxNode | undefined) => !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
const optional = (node: SyntaxNode) => node.tokens.includes('?.') || node.children.some(child => child.type === 'optional_chain');
const safeKey = (key: string | undefined): key is string => key !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && Buffer.byteLength(key) <= rules.maxKeyBytes;

/** Reviewed, file-local syntax only. No compiler, project imports, I/O or execution. */
export function createImplementationPlugin(digests: { implementationDigest: string; configurationDigest: string }): AnnotationPlugin<TypeScriptView> {
  return {
    descriptor: implementationDescriptor(digests),
    analyze({ view, budget }, emitter) {
      if (['truncated', 'unsupported', 'failed'].includes(view.state)) return { state: view.state };
      let partial = false, truncated = false, stopped = false, units = 0, facts = 0;
      const diagnostics: AnnotationDiagnostic[] = [];
      const diagnose = (code: string, node: SyntaxNode) => {
        partial = true;
        if (diagnostics.some(item => item.code === `implementation.${code}`)) return;
        const message = 'Source form is outside the reviewed implementation evidence contract.';
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) { truncated = true; return; }
        diagnostics.push({ code: `implementation.${code}`, message, span: view.span(node) });
      };
      const locator = (node: SyntaxNode) => implementationSpan(view.span(node));
      const args = (node: SyntaxNode) => node.fields.arguments?.children.filter(child => child.type !== 'comment') ?? [];
      const outer = (node: SyntaxNode) => {
        let at = node, parent = view.parent(at);
        while (parent && wrappers.has(parent.type)) { budget.step(); at = parent; parent = view.parent(at); }
        return { at, parent };
      };
      const owner = (node: SyntaxNode): SyntaxNode | undefined => {
        let at = view.parent(node), depth = 0;
        while (at) {
          budget.step();
          if (++depth > rules.maxContextDepth) { truncated = true; return; }
          if (callables.has(at.type)) return at;
          at = view.parent(at);
        }
      };
      const context = (node: SyntaxNode): Property[] => {
        const properties: Property[] = [['condition', 'source-only']];
        let child = node, parent = view.parent(node), depth = 0;
        while (parent) {
          budget.step();
          if (++depth > rules.maxContextDepth) { truncated = true; properties.push(['condition', 'context-depth-limit']); break; }
          if (callables.has(parent.type)) { properties.push(['owner', locator(parent)]); break; }
          if (parent.type === 'if_statement' || parent.type === 'ternary_expression') {
            const predicate = parent.fields.condition;
            const polarity = same(child, parent.fields.consequence) ? 'true' : same(child, parent.fields.alternative) ? 'false' : undefined;
            if (predicate && polarity) properties.push([`${parent.type === 'if_statement' ? 'if' : 'conditional'}-${polarity}`, locator(predicate)]);
          }
          const boundary = ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'].includes(parent.type) ? 'loop-context'
            : ['try_statement', 'catch_clause', 'finally_clause'].includes(parent.type) ? 'try-context'
            : ['switch_statement', 'switch_case', 'switch_default'].includes(parent.type) ? 'switch-context'
            : parent.type === 'binary_expression' && parent.tokens.some(token => ['&&', '||', '??'].includes(token)) && same(child, parent.fields.right) ? 'short-circuit-context' : undefined;
          if (boundary) { properties.push(['condition', boundary]); diagnose('control-context', node); }
          child = parent; parent = view.parent(parent);
        }
        return properties;
      };
      const emit = (node: SyntaxNode, role: ImplementationRole, ruleId: string, basis: EvidenceBasis, properties: Property[]) => {
        if (stopped) return;
        const subject = view.owner(node);
        if (!subject) { diagnose('owner-unavailable', node); return; }
        const all = [...context(node), ...properties, ['unit-complete', true] as Property];
        if (++units > rules.maxUnits || facts + all.length + 1 > rules.maxFacts) { truncated = stopped = true; diagnose('unit-limit', node); return; }
        const values: FactValue[] = all.map(([, value]) => typeof value === 'string' ? { kind: 'string', value } : { kind: 'boolean', value });
        if (values.some(value => Buffer.byteLength(canonicalJSON(value)) > view.limits.maxValueBytes)) { diagnose('value-limit', node); return; }
        const evidence = { ruleId, basis, span: view.span(node) };
        facts++;
        if (!emitter.role(subject.key, `implementation.${role}`, evidence)) { stopped = truncated = true; return; }
        for (let i = 0; i < all.length; i++) {
          budget.step(); facts++;
          if (!emitter.property(subject.key, `implementation.${all[i]![0]}`, 'literal', values[i], evidence)) { stopped = truncated = true; return; }
        }
      };
      const staticKey = (node: SyntaxNode): string | undefined => {
        budget.step(512);
        const constant = view.constant(node);
        if (!constant.known || typeof constant.value !== 'string' || !safeKey(constant.value)) return;
        return constant.value;
      };
      const memberName = (node: SyntaxNode): string | undefined => {
        if (node.type === 'member_expression' && node.fields.property) return view.name(node.fields.property);
        if (node.type === 'subscript_expression' && node.fields.index) return staticKey(node.fields.index);
      };
      const optionalReceiver = (node: SyntaxNode): boolean => {
        let at = view.unwrap(node);
        while (members.has(at.type) && at.fields.object) {
          if (optional(at)) return true;
          budget.step(); at = view.unwrap(at.fields.object);
        }
        return optional(at);
      };
      const origin = (node: SyntaxNode) => {
        budget.step(512);
        const result = view.resolve(node);
        return result.kind === 'import' ? result : undefined;
      };
      // Duplicate/ambiguous declarations must not turn a failed binding lookup
      // into a purported global. This intentionally over-rejects ambient use.
      let declaredProcess = view.declarations.some(item => item.name === 'process');
      let replacedMetaEnv = false;
      for (const node of view.nodes) {
        budget.step();
        if (view.name(node) === 'process') {
          let child = node, parent = view.parent(child), depth = 0;
          while (parent && ++depth <= rules.maxContextDepth) {
            budget.step();
            if (['formal_parameters', 'required_parameter', 'optional_parameter', 'import_clause', 'catch_clause'].includes(parent.type) || callables.has(parent.type) && same(parent.fields.parameter, child)) { declaredProcess = true; break; }
            if (['statement_block', 'program'].includes(parent.type)) break;
            child = parent; parent = view.parent(parent);
          }
        }
        const target = writes.has(node.type) ? node.fields.left ?? node.fields.argument : node.type === 'unary_expression' && node.tokens.includes('delete') ? node.children[0] : undefined;
        if (!target) continue;
        const at = view.unwrap(target);
        if (view.name(at) === 'process') declaredProcess = true;
        if (members.has(at.type) && memberName(at) === 'env' && at.fields.object) {
          const base = view.unwrap(at.fields.object);
          if (view.name(base) === 'process') declaredProcess = true;
          if (base.type === 'meta_property') replacedMetaEnv = true;
        }
      }
      const environment = (input: SyntaxNode): Env | undefined => {
        const node = view.unwrap(input);
        if (members.has(node.type) && memberName(node) === 'env' && node.fields.object) {
          const base = view.unwrap(node.fields.object);
          if (base.type === 'meta_property' && /^import\s*\.\s*meta$/.test(view.text(base))) {
            if (replacedMetaEnv || optionalReceiver(node)) { diagnose('config-pattern', node); return; }
            return { source: 'import.meta.env', provenance: 'syntax', basis: 'syntax' };
          }
          if (base.type === 'identifier' && view.name(base) === 'process' && !view.binding(base)) {
            if (declaredProcess || optionalReceiver(node)) { diagnose('config-pattern', node); return; }
            return { source: 'process.env', provenance: 'ambient-assumed', basis: 'convention' };
          }
        }
        if (node.type !== 'identifier' && !members.has(node.type)) return;
        const bound = origin(node);
        if (bound && rules.processModules.some(module => module === bound.module) && (bound.name === 'env' && !bound.member || bound.name === 'default' && bound.member === 'env')) {
          if (optionalReceiver(node)) { diagnose('config-pattern', node); return; }
          return { source: 'process.env', provenance: 'import-bound', basis: 'import-bound' };
        }
      };
      const envProperties = (env: Env, key: string): Property[] => [
        ['config-key', key], ['config-source', env.source], ['config-provenance', env.provenance],
        ['condition', env.provenance === 'ambient-assumed' ? 'ambient-api-assumed' : env.source === 'import.meta.env' ? 'environment-provenance-unproven' : 'import-contract-not-runtime'],
      ];
      const fallback = (node: SyntaxNode): Property[] => {
        const { at, parent } = outer(node);
        if (parent?.type === 'binary_expression' && same(parent.fields.left, at) && parent.fields.right) {
          const operator = parent.tokens.find(token => token === '??' || token === '||');
          if (operator) return [['fallback', locator(parent.fields.right)], ['fallback-expression', locator(parent)], ['fallback-semantics', operator === '??' ? 'nullish' : 'falsy']];
        }
        return [];
      };
      const registrations = new Map<string, { runner: string; api: string }>();
      const registrationCalls = new Set<string>();
      for (const node of view.nodes) {
        budget.step();
        if (stopped) break;
        if (node.type !== 'call_expression' || !node.fields.function) continue;
        const bound = origin(node.fields.function);
        if (!bound || !rules.testModules.some(module => module === bound.module)) continue;
        const api = bound.name === 'default' && bound.module === 'node:test' ? 'test' : bound.name;
        if (!['test', 'it'].includes(api)) continue;
        registrationCalls.add(locator(node));
        const parameters = args(node), callback = parameters[1] && view.unwrap(parameters[1]);
        if (bound.member || optional(node) || optionalReceiver(node.fields.function) || parameters.length !== 2 || !callback || !['arrow_function', 'function_expression'].includes(callback.type)) { diagnose('test-shape', node); continue; }
        registrations.set(locator(callback), { runner: bound.module, api });
        emit(node, 'test', 'test-registration-v1', 'import-bound', [['runner', bound.module], ['api', api], ['callback', locator(callback)], ['test-name', locator(parameters[0]!)]]);
      }
      for (const node of view.nodes) {
        budget.step();
        if (stopped) break;
        if (node.type === 'return_statement' || node.type === 'throw_statement') {
          const value = node.children.find(child => child.type !== 'comment');
          emit(node, node.type === 'return_statement' ? 'return' : 'throw', 'local-outcome-v1', 'syntax', value ? [['value', locator(value)]] : []);
        } else if (writes.has(node.type)) {
          const target = node.fields.left ?? node.fields.argument, value = node.fields.right;
          const operator = node.tokens.find(token => operators.has(token));
          if (!target || !operator || ['object_pattern', 'array_pattern'].includes(target.type)) { diagnose('write-shape', node); continue; }
          emit(node, node.type === 'update_expression' ? 'update' : 'assignment', 'local-write-v1', 'syntax', [['target', locator(target)], ['operator', operator], ...(value ? [['value', locator(value)] as Property] : [])]);
        }
        if (members.has(node.type) && node.fields.object) {
          const env = environment(node.fields.object);
          if (env) {
            const { at, parent } = outer(node);
            const write = parent && (writes.has(parent.type) && (same(parent.fields.left, at) || same(parent.fields.argument, at)) || parent.type === 'unary_expression' && parent.tokens.includes('delete'));
            if (write) continue;
            const key = memberName(node);
            if (!safeKey(key) || optional(node)) { diagnose('config-key', node); continue; }
            emit(node, 'config-read', 'environment-read-v1', env.basis, [...envProperties(env, key), ...fallback(node)]);
          }
          if (memberName(node) === 'env' && environment(node)) {
            const { at, parent } = outer(node);
            const keyRead = parent && members.has(parent.type) && same(parent.fields.object, at);
            const pattern = parent?.type === 'variable_declarator' && parent.fields.name?.type === 'object_pattern' && same(parent.fields.value, at);
            if (!keyRead && !pattern) diagnose('config-pattern', node);
          }
        }
        if (node.type === 'variable_declarator' && node.fields.value && node.fields.name?.type === 'object_pattern') {
          const env = environment(node.fields.value);
          if (env) for (const element of node.fields.name.children) {
            budget.step();
            if (element.type === 'comment') continue;
            let key: string | undefined, defaultValue: SyntaxNode | undefined;
            if (element.type === 'shorthand_property_identifier_pattern') key = view.name(element);
            else if (element.type === 'object_assignment_pattern') { key = element.fields.left && view.name(element.fields.left); defaultValue = element.fields.right; }
            else if (element.type === 'pair_pattern' && element.fields.key) {
              key = element.fields.key.type === 'computed_property_name' ? element.fields.key.children[0] && staticKey(element.fields.key.children[0]) : view.name(element.fields.key);
              const value = element.fields.value;
              if (value?.type === 'assignment_pattern') defaultValue = value.fields.right;
              else if (value?.type !== 'identifier') key = undefined;
            }
            if (!safeKey(key)) { diagnose('config-pattern', element); continue; }
            emit(element, 'config-read', 'environment-read-v1', env.basis, [...envProperties(env, key), ...(defaultValue ? [['fallback', locator(defaultValue)], ['fallback-expression', locator(element)], ['fallback-semantics', 'undefined']] as Property[] : [])]);
          }
        }
        if (node.type !== 'call_expression' || !node.fields.function || registrationCalls.has(locator(node))) continue;
        const fn = view.unwrap(node.fields.function), parameters = args(node);
        let matcher: string | undefined, actual: SyntaxNode | undefined, expected: SyntaxNode | undefined, negated = false, asyncMode = 'sync', recognized = false;
        if (fn.type === 'member_expression' && fn.fields.object && fn.fields.property) {
          matcher = view.name(fn.fields.property);
          let base = view.unwrap(fn.fields.object);
          const modifiers: string[] = [];
          let optionalModifier = false;
          while (base.type === 'member_expression' && base.fields.object && base.fields.property && modifiers.length < 4) {
            budget.step(); optionalModifier ||= optional(base); modifiers.unshift(view.name(base.fields.property) ?? ''); base = view.unwrap(base.fields.object);
          }
          if (base.type === 'call_expression' && base.fields.function) {
            const bound = origin(base.fields.function);
            recognized = !!bound && ['bun:test', 'vitest'].includes(bound.module) && bound.name === 'expect';
            if (recognized) {
              const values = args(base);
              const validModifiers = modifiers.length <= 2 && new Set(modifiers).size === modifiers.length && modifiers.every(item => ['not', 'resolves', 'rejects'].includes(item)) && !(modifiers.includes('resolves') && modifiers.includes('rejects'));
              if (bound!.member || !matcher || !Object.hasOwn(expectMatchers, matcher) || parameters.length !== expectMatchers[matcher] || values.length !== 1 || !validModifiers || optionalModifier || optional(base) || optional(fn) || optionalReceiver(base.fields.function)) { diagnose('assertion-shape', node); continue; }
              actual = values[0]; expected = parameters[0]; negated = modifiers.includes('not'); asyncMode = modifiers.find(item => item !== 'not') ?? 'sync';
            }
          }
        }
        if (!recognized) {
          const bound = origin(fn);
          if (bound && rules.assertModules.some(module => module === bound.module)) {
            recognized = true;
            matcher = bound.name === 'default' || bound.name === '*' || bound.name === 'strict' ? bound.member ?? 'ok' : bound.member ? `${bound.name}.${bound.member}` : bound.name;
            if (!Object.hasOwn(assertMatchers, matcher) || parameters.length !== assertMatchers[matcher]) { diagnose('assertion-shape', node); continue; }
            actual = parameters[0]; expected = parameters[1]; negated = matcher.startsWith('not') || matcher === 'doesNotMatch';
          }
        }
        if (!recognized || !actual || !matcher) continue;
        if (optional(node) || optionalReceiver(fn) || parameters.some(item => item.type === 'spread_element')) { diagnose('assertion-shape', node); continue; }
        const callable = owner(node), test = callable && registrations.get(locator(callable));
        if (!callable || !test) { diagnose('assertion-owner', node); continue; }
        const { parent } = outer(node);
        emit(node, 'assertion', 'test-assertion-v1', 'import-bound', [['test-owner', locator(callable)], ['actual', locator(actual)], ...(expected ? [['expected', locator(expected)] as Property] : []), ['matcher', matcher], ['negated', negated], ['async-mode', asyncMode], ['awaited', parent?.type === 'await_expression']]);
      }
      return { state: truncated ? 'truncated' : partial ? 'partial' : facts ? 'complete' : 'not-applicable', diagnostics };
    },
  };
}
