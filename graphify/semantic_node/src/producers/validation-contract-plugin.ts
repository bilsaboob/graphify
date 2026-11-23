import type { AnnotationPlugin } from '#core';
import { canonicalJSON, type AnnotationDiagnostic, type FactValue } from '#core/wire';
import type { SyntaxNode, TypeScriptView } from '#typescript';
import { validationContractDescriptor, validationContractRules as rules, validationContractSpan, type ValidationContractProperty, type ValidationContractRole } from './validation-contract-vocabulary.js';

const same = (a: SyntaxNode | undefined, b: SyntaxNode | undefined) => !!a && !!b && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
const nodeKey = (node: SyntaxNode) => `${node.type}:${node.startIndex}:${node.endIndex}`;
const identifiers = new Set(['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern']);
const dynamicReferences = new Set(['eval', 'Function', 'require', 'getBuiltinModule', 'createRequire']);
const ambientObjects = new Set(['globalThis', 'global', 'window', 'self', 'module']);
const optional = (node: SyntaxNode) => node.tokens.includes('?.') || node.children.some(child => child.type === 'optional_chain');
type Property = [ValidationContractProperty, FactValue];
type Atom = { node: SyntaxNode; key: SyntaxNode; type: SyntaxNode; method: SyntaxNode; kind: 'string' | 'number' | 'boolean'; predicate: 'value_kind' | 'minimum' | 'maximum'; bound?: SyntaxNode; value?: number };
type Use = { node: SyntaxNode; schema: SyntaxNode; method: SyntaxNode; mode: 'parse' | 'safeParse'; imported: SyntaxNode; owner: SyntaxNode; parameter: SyntaxNode; argument: SyntaxNode; returned: SyntaxNode; atoms: Atom[]; subject: string };

/** Source-only, bounded lexical qualification. No package loading or evaluation. */
export function createValidationContractPlugin(digests: { implementationDigest: string; configurationDigest: string }): AnnotationPlugin<TypeScriptView> {
  return {
    descriptor: validationContractDescriptor(digests),
    analyze({ document, view, budget }, emitter) {
      if (view.state !== 'complete') return { state: view.state };
      let work = 0, truncated = false, veto = false;
      const diagnostics: AnnotationDiagnostic[] = [];
      const stop = Symbol('validation-contract-limit');
      const diagnose = (code: string, node?: SyntaxNode) => {
        veto = true;
        if (diagnostics.some(item => item.code === `validation-contract.${code}`)) return;
        const message = 'File-local validation qualification is incomplete or outside the reviewed contract.';
        if (diagnostics.length >= view.limits.maxDiagnostics || Buffer.byteLength(message) > view.limits.maxValueBytes) { truncated = true; return; }
        diagnostics.push({ code: `validation-contract.${code}`, message, ...(node ? { span: view.span(node) } : {}) });
      };
      const limit = (code: string): never => { truncated = true; diagnose(code); throw stop; };
      const step = (amount = 1) => { work += amount; if (work > rules.maxWork) limit('work-limit'); budget.step(amount); };
      const binding = (node: SyntaxNode) => { step(rules.maxDepth); return view.binding(node); };
      const children = (node: SyntaxNode) => node.children.filter(child => child.type !== 'comment');
      const identifier = (node: SyntaxNode) => /^[$A-Z_a-z][$\w]*$/.test(view.text(node)) && Buffer.byteLength(view.text(node)) <= rules.maxIdentifierBytes;
      const dynamicExposure = (node: SyntaxNode): boolean => {
        // Reject exposure, not just invocation: an ambient object or evaluator
        // can escape through aliases, patterns, optional or unknown computed keys.
        // Deliberately conservative for shadowed names; this is not a sandbox.
        if (identifiers.has(node.type)) {
          const name = view.name(node) ?? '';
          if (dynamicReferences.has(name) || ambientObjects.has(name)) return true;
          if (name === 'process') {
            const env = view.parent(node), access = env && view.parent(env);
            // Retain ordinary process.env.KEY syntax, not the loader-capable
            // process object, an extracted env object or a computed env lookup.
            return !(env?.type === 'member_expression' && same(env.fields.object, node) && !optional(env) && env.fields.property && view.name(env.fields.property) === 'env' &&
              access?.type === 'member_expression' && same(access.fields.object, env) && !optional(access) && access.fields.property?.type === 'property_identifier');
          }
        }
        const property = node.type === 'member_expression' ? node.fields.property : node.type === 'subscript_expression' ? node.fields.index : node.type === 'pair_pattern' ? node.fields.key : undefined;
        const name = property && view.name(property);
        return node.type === 'import' || !!name && (dynamicReferences.has(name) || name === 'constructor');
      };
      const args = (node: SyntaxNode) => node.fields.arguments ? children(node.fields.arguments) : [];
      const memberCall = (node: SyntaxNode | undefined) => {
        if (!node || node.type !== 'call_expression' || !node.fields.arguments || node.fields.type_arguments || optional(node)) return;
        const fn = node.fields.function;
        if (fn?.type !== 'member_expression' || optional(fn) || fn.fields.property?.type !== 'property_identifier' || !fn.fields.object) return;
        return { receiver: fn.fields.object, method: fn.fields.property, name: view.text(fn.fields.property), args: args(node) };
      };
      const staged: { node: SyntaxNode; subject: string; ruleId: string; role: ValidationContractRole; properties: Property[] }[] = [];
      try {
        if (Buffer.byteLength(document.source) > rules.maxSourceBytes) limit('source-limit');
        const pending: [SyntaxNode, number][] = [[view.root, 0]];
        while (pending.length) {
          const [node, depth] = pending.pop()!;
          step();
          if (depth > rules.maxDepth) limit('depth-limit');
          for (const child of node.children) pending.push([child, depth + 1]);
        }
        const imports = new Map<string, SyntaxNode>(), importTokens = new Set<string>(), importNames = new Set<string>();
        for (const node of view.nodes) {
          step();
          if (dynamicExposure(node)) diagnose('dynamic-scope', node);
          if (node.type !== 'import_statement' || !node.fields.source || node.tokens.includes('type')) continue;
          const module = view.moduleIdentity(node.fields.source);
          if (module === 'node:module' || module === 'module') diagnose('dynamic-scope', node);
          if (module !== rules.module && !module?.startsWith('zod/')) continue;
          const clause = node.children.find(child => child.type === 'import_clause');
          for (const part of clause ? children(clause) : []) {
            if (part.type !== 'named_imports') { diagnose('import-shape', part); continue; }
            for (const specifier of children(part)) {
              step();
              if (specifier.tokens.includes('type')) continue;
              const name = specifier.fields.name, local = specifier.fields.alias ?? name;
              if (module !== rules.module || !name || view.text(name) !== rules.importedName || name.type !== 'identifier' || local?.type !== 'identifier' || !identifier(local)) { diagnose('import-shape', specifier); continue; }
              imports.set(nodeKey(local), specifier); importNames.add(view.name(local)!);
              importTokens.add(nodeKey(local)); importTokens.add(nodeKey(name));
            }
          }
        }
        if (!imports.size) return { state: 'not-applicable' };
        const importedAt = (node: SyntaxNode) => {
          if (node.type !== 'identifier') return;
          const origin = binding(node);
          if (origin?.kind === 'import' && !origin.typeOnly && origin.available && origin.stable) return imports.get(nodeKey(origin.node));
        };
        const allowed = new Set<string>(), uses: Use[] = [];
        const retained = new Set(view.declarations.map(declaration => declaration.key));
        let atomCount = 0;
        for (const node of view.nodes) {
          step();
          const call = memberCall(node);
          if (!call || call.name !== 'parse' && call.name !== 'safeParse') continue;
          const schema = memberCall(call.receiver);
          if (!schema || schema.name !== 'object') continue;
          const imported = importedAt(schema.receiver);
          if (!imported) continue;
          const shape = schema.args[0];
          if (schema.args.length !== 1 || shape?.type !== 'object' || call.args.length !== 1 || call.args[0]?.type !== 'identifier') { diagnose('schema-shape', node); continue; }
          let returned = node, owner = view.parent(node);
          if (owner?.type === 'return_statement') {
            returned = owner;
            const block = view.parent(owner);
            owner = block && view.parent(block);
            if (block?.type !== 'statement_block' || children(block).length !== 1 || !owner || !same(owner.fields.body, block)) { diagnose('owner-shape', node); continue; }
          } else if (owner?.type !== 'arrow_function' || !same(owner.fields.body, node)) { diagnose('owner-shape', node); continue; }
          if (!['function_declaration', 'function_expression', 'arrow_function'].includes(owner.type) || owner.tokens.includes('async') || owner.fields.type_parameters) { diagnose('owner-shape', owner); continue; }
          const formal = owner.fields.parameters ?? owner.fields.parameter;
          const parameters = formal?.type === 'formal_parameters' ? children(formal) : formal ? [formal] : [];
          const parameter = parameters[0]?.type === 'required_parameter' ? parameters[0].fields.pattern : parameters[0];
          if (parameters.length !== 1 || parameter?.type !== 'identifier' || !identifier(parameter) || parameters[0]?.fields.value || parameters[0]?.tokens.includes('?') || parameters[0]?.tokens.includes('=')) { diagnose('parameter-shape', owner); continue; }
          const argument = call.args[0], origin = binding(argument);
          // Parameters are deliberately not stable in the view; the sole-return
          // grammar proves no intervening local write without asserting immutability.
          if (origin?.kind !== 'parameter' || !origin.available || !same(origin.node, parameter) || view.text(argument) !== view.text(parameter)) { diagnose('argument-binding', argument); continue; }
          let ancestor = view.parent(owner), placement = true;
          while (ancestor) {
            step();
            if (['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'try_statement', 'catch_clause', 'switch_statement', 'ternary_expression', 'binary_expression', 'method_definition', 'class_static_block'].includes(ancestor.type)) placement = false;
            ancestor = view.parent(ancestor);
          }
          if (!placement) { diagnose('owner-placement', owner); continue; }
          const fields = children(shape);
          if (fields.length > rules.maxFields) limit('field-limit');
          if (!fields.length) { diagnose('schema-shape', shape); continue; }
          const keys = new Set<string>(), atoms: Atom[] = [], accepted = [schema.receiver];
          let valid = true;
          for (const field of fields) {
            step();
            const key = field.fields.key, value = field.fields.value;
            const keyText = key ? view.text(key) : '';
            if (field.type !== 'pair' || key?.type !== 'property_identifier' || !/^[$A-Z_a-z][$\w]*$/.test(keyText) || Buffer.byteLength(keyText) > rules.maxFieldKeyBytes || keyText === '__proto__' || keys.has(keyText) || !value) { valid = false; break; }
            keys.add(keyText);
            let current = value, primitive = memberCall(current);
            const bounds: { node: SyntaxNode; method: SyntaxNode; bound: SyntaxNode; value: number; predicate: 'minimum' | 'maximum' }[] = [];
            const methods = new Set<string>();
            while (primitive && ['min', 'max'].includes(primitive.name)) {
              step();
              const bound = primitive.args[0];
              const negative = bound?.type === 'unary_expression' && bound.tokens.length === 1 && bound.tokens[0] === '-';
              const number = negative ? bound.fields.argument : bound;
              const raw = number?.type === 'number' ? view.text(number) : '';
              const numeric = Number(raw) * (negative ? -1 : 1);
              if (primitive.args.length !== 1 || !bound || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(numeric) || methods.has(primitive.name)) { valid = false; break; }
              if (negative && !/^-[ \t\r\n]*(0|[1-9][0-9]*)$/.test(view.text(bound))) { valid = false; break; }
              methods.add(primitive.name);
              bounds.push({ node: current, method: primitive.method, bound, value: numeric === 0 ? 0 : numeric, predicate: primitive.name === 'min' ? 'minimum' : 'maximum' });
              current = primitive.receiver; primitive = memberCall(current);
            }
            if (!valid || !primitive || !['string', 'number', 'boolean'].includes(primitive.name) || primitive.args.length || !same(importedAt(primitive.receiver), imported)) { valid = false; break; }
            const kind = primitive.name as Atom['kind'];
            if (bounds.length && kind === 'boolean' || kind === 'string' && bounds.some(bound => bound.value < 0)) { valid = false; break; }
            atoms.push({ node: current, key, type: primitive.method, method: primitive.method, kind, predicate: 'value_kind' });
            for (const bound of bounds.reverse()) atoms.push({ ...bound, key, type: primitive.method, kind });
            accepted.push(primitive.receiver);
          }
          if (!valid) { diagnose('predicate-shape', shape); continue; }
          if (uses.length >= rules.maxUses) limit('use-limit');
          atomCount += atoms.length;
          if (atomCount > rules.maxAtoms) limit('atom-limit');
          const subject = view.owner(node)?.key ?? limit('inventory-limit');
          if (!retained.has(subject)) limit('inventory-limit');
          for (const identifier of accepted) allowed.add(nodeKey(identifier));
          uses.push({ node, schema: call.receiver, method: call.method, mode: call.name, imported, owner, parameter, argument, returned, atoms, subject });
        }
        // All imported-name uses, including those after a valid parse, must be
        // inventory members. Do not chase aliases or infer purity from const.
        for (const node of view.nodes) {
          step();
          if (!identifiers.has(node.type) || importTokens.has(nodeKey(node))) continue;
          const origin = binding(node);
          if (origin?.kind === 'import' && imports.has(nodeKey(origin.node))) {
            if (!origin.stable || !origin.available || origin.typeOnly || !allowed.has(nodeKey(node))) diagnose('import-use', node);
          } else if (!origin && importNames.has(view.name(node) ?? '')) diagnose('ambiguous-reference', node);
        }
        if (veto) return { state: truncated ? 'truncated' : 'partial', diagnostics };
        const string = (value: string): FactValue => ({ kind: 'string', value });
        const span = (node: SyntaxNode) => string(validationContractSpan(view.span(node)));
        let facts = 0;
        const stage = (use: Use, node: SyntaxNode, role: ValidationContractRole, ruleId: string, properties: Property[]) => {
          properties.push(['unit-complete', { kind: 'boolean', value: true }]);
          facts += properties.length + 1;
          if (facts > rules.maxFacts) limit('fact-limit');
          if (properties.some(([, value]) => Buffer.byteLength(canonicalJSON(value)) > view.limits.maxValueBytes)) limit('value-limit');
          staged.push({ node, subject: use.subject, role, ruleId, properties });
        };
        for (const use of uses) {
          step();
          stage(use, use.node, 'validation-use', use.mode === 'parse' ? rules.rules[0] : rules.rules[1], [
            ['import-reference', { kind: 'reference', value: { kind: 'import', module: rules.module, name: rules.importedName } }],
            ['import', span(use.imported)], ['owner', span(use.owner)], ['parameter', span(use.parameter)], ['argument', span(use.argument)], ['schema', span(use.schema)], ['call', span(use.node)], ['return', span(use.returned)], ['method', span(use.method)],
            ['mode', string(use.mode)], ['return-target', string(rules.modes[use.mode].returnTarget)],
            ['predicate-count', { kind: 'integer', value: use.atoms.length }], ['use-count', { kind: 'integer', value: uses.length }],
            ...[...rules.conditions, rules.modes[use.mode].condition].map(condition => ['condition', string(condition)] as Property),
            ['inventory-complete', { kind: 'boolean', value: true }],
          ]);
          for (const atom of use.atoms) {
            step();
            stage(use, atom.node, 'validation-predicate', atom.predicate === 'value_kind' ? rules.rules[2] : atom.predicate === 'minimum' ? rules.rules[3] : rules.rules[4], [
              ['call', span(use.node)], ['field-key', string(view.text(atom.key))], ['key', span(atom.key)], ['type', span(atom.type)], ['method', span(atom.method)],
              ['predicate', string(atom.predicate)], ['value-kind', string(atom.kind)], ['metric', string(atom.predicate === 'value_kind' ? 'value-kind' : atom.kind === 'string' ? 'utf16-length' : 'numeric-value')],
              ...(atom.bound ? [['bound', span(atom.bound)], ['bound-value', { kind: 'integer', value: atom.value! }]] as Property[] : []),
            ]);
          }
        }
        // No output until the source census is complete. Composition removes this
        // plugin's whole source output on truncation (wire v1 has no transaction).
        for (const unit of staged) {
          step();
          const evidence = { ruleId: unit.ruleId, basis: 'import-bound' as const, span: view.span(unit.node) };
          if (!emitter.role(unit.subject, `validation-contract.${unit.role}`, evidence)) limit('output-limit');
          for (const [property, value] of unit.properties) {
            step();
            if (!emitter.property(unit.subject, `validation-contract.${property}`, 'literal', value, evidence)) limit('output-limit');
          }
        }
      } catch (error) { if (error !== stop) throw error; }
      return { state: truncated ? 'truncated' : veto ? 'partial' : staged.length ? 'complete' : 'not-applicable', diagnostics };
    },
  };
}
