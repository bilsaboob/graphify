import type { AnalysisBudget, ReadonlyDeclaration as Declaration } from '#core';
import type { Reference } from '#core/wire';
import type { SyntaxNode, TypeScriptView } from '#typescript';
import { coreRule, fstReturnContracts, handleParts, methodsFor, type CoreRule } from './core-rules.js';
import type { FstSolidProperty, FstSolidRelation, FstSolidRole } from './vocabulary.js';

export interface CoreContext {
  view: TypeScriptView;
  budget: AnalysisBudget;
  hasFamilies: boolean;
  role(owner: Declaration, term: FstSolidRole, node: SyntaxNode, rule: string): void;
  property(owner: Declaration, term: FstSolidProperty, value: string, node: SyntaxNode, rule: string, resolution?: 'literal' | 'constant'): void;
  relation(owner: Declaration, term: FstSolidRelation, target: Reference, node: SyntaxNode, rule: string, basis?: 'import-bound' | 'syntax' | 'convention'): void;
  diagnose(code: string, message: string, node: SyntaxNode): void;
  safeString(value: string): boolean;
  assigned(node: SyntaxNode): Declaration | undefined;
  family(node: SyntaxNode, method?: string): { kind: string; raw: boolean; origin: SyntaxNode } | undefined;
  command(node: SyntaxNode, name: string): boolean;
}
interface Handle { kind: string; creation: SyntaxNode; root: string; reference: Reference; raw?: boolean; constructed?: boolean; constructionKind?: string }
const functions = new Set(['arrow_function', 'function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration']);
const keyOf = (node: SyntaxNode) => `${node.startIndex}:${node.endIndex}`;

/** Import/receiver-qualified calls; all edges describe source requests, not runtime success. */
export function analyzeCore(context: CoreContext): void {
  const { view, budget, role, relation, diagnose, safeString } = context;
  const property: CoreContext['property'] = (owner, term, value, node, rule, resolution) => {
    if (!safeString(value)) { diagnose('fst-solid.core-limit', 'API metadata exceeds the bounded wire string contract.', node); return; }
    context.property(owner, term, value, node, rule, resolution);
  };
  const argsOf = (node: SyntaxNode) => node.fields.arguments?.children.filter((child) => child.type !== 'comment') ?? [];
  const access = (input: SyntaxNode) => {
    const node = view.unwrap(input);
    if (node.tokens.includes('?.') || !node.fields.object) return undefined;
    const key = node.type === 'member_expression' ? node.fields.property : node.type === 'subscript_expression' ? node.fields.index : undefined;
    const name = key && (node.type !== 'subscript_expression' || key.type === 'string') ? view.name(key) : undefined;
    return name === undefined ? undefined : { object: node.fields.object, name };
  };
  const imported = (input: SyntaxNode) => {
    const reference = view.resolve(input);
    if (reference.kind === 'import' && !reference.member) {
      const rule = coreRule(reference.module, reference.name);
      if (rule) return rule;
    }
    const member = access(input);
    const base = member && view.resolve(member.object);
    return base?.kind === 'import' && !base.member ? coreRule(base.module, `${base.name}.${member!.name}`) : undefined;
  };
  const calls = view.nodes.filter((node) => node.type === 'call_expression' || node.type === 'new_expression');
  const direct = new Map<SyntaxNode, CoreRule>();
  for (const node of calls) {
    budget.step();
    if (node.tokens.includes('?.') || node.children.some(child => child.type === 'optional_chain')) continue;
    const fn = node.fields.function ?? node.fields.constructor;
    const rule = fn && imported(fn);
    if (rule && !!rule.construct === (node.type === 'new_expression')) direct.set(node, rule);
  }
  const analyzeReceivers = direct.size > 0 || context.hasFamilies;
  const bindings = new Map<string, Handle | null>();
  const borrowedInputs = new Map<string, readonly SyntaxNode[]>();
  const constructed = new Map<SyntaxNode, Handle | null>();
  const constructionProofs = new Map<SyntaxNode, boolean>();
  const active = new Set<string>();
  const knownFunction = (input: SyntaxNode | undefined): boolean => {
    if (!input) return false;
    let node = view.unwrap(input);
    for (let depth = 0; depth < 16; depth++) {
      budget.step();
      if (functions.has(node.type)) return true;
      const binding = view.binding(node);
      if (!binding?.stable || !binding.available || binding.typeOnly) return false;
      const next = binding.initializer ?? (binding.kind === 'function' && binding.declaration ? view.declarationNode(binding.declaration) : undefined);
      if (!next) return false;
      node = view.unwrap(next);
    }
    return false;
  };
  const method = (handle: Handle, name: string): CoreRule | undefined => {
    const rules = methodsFor(handle.kind);
    return rules && Object.hasOwn(rules, name) ? rules[name] : undefined;
  };
  const make = (kind: string, node: SyntaxNode): Handle => ({ kind, creation: node, root: keyOf(node), reference: view.reference(node) });
  const partOf = (receiver: Handle, name: string, depth: number): Handle | undefined => {
    const borrowed = direct.get(receiver.creation)?.borrowed;
    if (borrowed && Object.hasOwn(borrowed, name)) {
      const input = argsOf(receiver.creation)[borrowed[name]!];
      return input ? handle(input, depth + 1) : undefined;
    }
    const kind = handleParts[receiver.kind]?.[name];
    return kind ? { ...receiver, kind } : undefined;
  };
  const observeConstruction = (node: SyntaxNode, result: Handle | null | undefined): Handle | undefined => {
    if (!result?.constructed) return result ?? undefined;
    if (!constructionProofs.has(node)) {
      budget.step(512);
      constructionProofs.set(node, view.project(node)?.contract?.startsWith('fst-solid.') ?? false);
    }
    return constructionProofs.get(node) ? result : undefined;
  };
  const handle = (input: SyntaxNode, depth = 0): Handle | undefined => {
    budget.step();
    if (depth > 16) { diagnose('fst-solid.core-limit', 'Handle provenance exceeds the bounded local depth.', input); return; }
    const node = view.unwrap(input), reference = view.reference(node);
    const binding = view.binding(node);
    if (binding) {
      if (!binding.available || !binding.stable || binding.typeOnly || binding.kind !== 'const' || !binding.declaration) return;
      const key = binding.declaration;
      if (active.has(key)) return;
      if (bindings.has(key)) { const found = observeConstruction(node, bindings.get(key)); return found ? { ...found, reference } : undefined; }
      active.add(key);
      let result = binding.initializer ? handle(binding.initializer, depth + 1) : undefined;
      if (!binding.initializer) {
        // Only queried for a destructured binding actually used by a supported call.
        budget.step(512);
        const source = view.initializerProjection(key);
        if (source?.complete) {
          budget.step(512);
          const projection = view.project(node);
          if (projection?.contract?.startsWith('fst-solid.') && projection.path.length <= 1) {
            const origin = handle(projection.initializer, depth + 1);
            if (origin) result = projection.path.length ? partOf(origin, String(projection.path[0]), depth) : origin;
          }
        }
      }
      active.delete(key);
      bindings.set(key, result ?? null);
      const observed = observeConstruction(node, result);
      return observed ? { ...observed, reference } : undefined;
    }
    const rule = direct.get(node);
    if (rule?.result) {
      if (rule.operation === 'list.raw-create' && unsafeConstructors.has('raw-list')) return;
      if (argsOf(node).some((arg) => arg.type === 'spread_element')) return;
      if (!rule.construct) return { ...make(rule.result, node), ...(rule.shared ? { root: `shared:${rule.shared}` } : {}), ...(rule.backing ? { constructionKind: rule.backing } : rule.result === 'raw-list' ? { constructionKind: 'raw-list' } : {}) };
      if (constructed.has(node)) return constructed.get(node) ?? undefined;
      budget.step(512);
      const projection = view.project(node);
      const result = projection?.contract?.startsWith('fst-solid.') ? { ...make(rule.result, node), constructed: true, constructionKind: rule.result } : undefined;
      constructed.set(node, result ?? null);
      if (result && rule.borrowed) borrowedInputs.set(result.root, Object.values(rule.borrowed).flatMap((index) => argsOf(node)[index] ? [argsOf(node)[index]!] : []));
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
    if (node.type !== 'call_expression' || !node.fields.function) return;
    const accessFn = access(node.fields.function);
    if (accessFn) {
      const receiver = handle(accessFn.object, depth + 1), contract = receiver && method(receiver, accessFn.name);
      if (!receiver || !contract) return;
      if (['state', 'form', 'scope', 'item-scope'].includes(receiver.kind) && !context.family(accessFn.object, accessFn.name)) return;
      if (contract.result === 'subform' && !context.family(accessFn.object, 'field')) return;
      if (contract.result === 'self') return { ...receiver, reference };
      if (['value', 'delayed-value', 'hover-value'].includes(receiver.kind) && accessFn.name === 'load' && knownFunction(argsOf(node)[0])) return { ...receiver, reference };
      if (contract.result) return { ...make(contract.result, node), root: receiver.root, ...(receiver.constructionKind ? { constructionKind: receiver.constructionKind } : {}) };
    } else {
      const receiver = handle(node.fields.function, depth + 1);
      if (receiver?.kind === 'root-renderer') return make('root-view', node);
    }
    return;
  };

  // Passing a handle to unknown code can replace its methods. Be conservative even
  // across nested callbacks; source order is not a runtime ordering proof.
  const unsafe = new Set<string>();
  const unsafeConstructors = new Set<string>();
  let receiverProofsLimited = false;
  const taint = (input: SyntaxNode, seen = new Set<SyntaxNode>()) => {
    budget.step();
    const node = view.unwrap(input);
    if (seen.has(node)) return;
    const found = handle(node);
    if (found) {
      if (unsafe.has(found.root)) return;
      unsafe.add(found.root);
      // The wrapper exposes the original input. This is a private invalidation
      // dependency, not a public alias between the wrapper and its contained value.
      for (const input of borrowedInputs.get(found.root) ?? []) taint(input, seen);
      return;
    }
    // Calls expose only a proven return handle; their arguments are checked in
    // the separate call pass. JSX exposes expressions, not tag/attribute syntax.
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      // Even when construction cannot prove a method shape, exposing a reviewed
      // borrowing wrapper may expose its input. Do not drop that dependency.
      for (const index of Object.values(direct.get(node)?.borrowed ?? {})) {
        const input = argsOf(node)[index];
        if (input) taint(input, seen);
      }
      return;
    }
    if (node.type.startsWith('jsx_')) {
      const pending = [node];
      while (pending.length) {
        budget.step();
        const child = pending.pop()!;
        if (child.type === 'jsx_expression') for (const value of child.children) taint(value, seen);
        else pending.push(...child.children);
      }
      return;
    }
    if (node.type === 'pair' && node.fields.value) { taint(node.fields.value, seen); return; }
    if (['string', 'number', 'true', 'false', 'null', 'comment', 'property_identifier'].includes(node.type)) return;
    if (seen.size >= 4096) {
      receiverProofsLimited = true;
      diagnose('fst-solid.core-limit', `resource=receiver-escape-nodes accounted=${seen.size + 1} limit=4096; receiver operations are omitted.`, input);
      return;
    }
    seen.add(node);
    // Escaping a closure exposes its returned values, not every local receiver it
    // reads. Unknown argument/storage effects inside its body are scanned below.
    if (functions.has(node.type)) {
      const body = node.fields.body;
      if (!body) return;
      if (body.type !== 'statement_block') taint(body, seen);
      else {
        const pending = [...body.children];
        while (pending.length) {
          budget.step();
          const child = pending.pop()!;
          if (child.type === 'return_statement') for (const value of child.children) taint(value, seen);
          else if (!functions.has(child.type)) pending.push(...child.children);
        }
      }
      return;
    }
    if (['member_expression', 'subscript_expression'].includes(node.type) && node.fields.object) { taint(node.fields.object, seen); return; }
    const binding = view.binding(node);
    if (binding) {
      if (binding.origin) {
        const listFactory = coreRule(binding.origin.module, `${binding.origin.name === '*' ? 'List' : binding.origin.name}.new`);
        if (listFactory?.operation === 'list.raw-create') unsafeConstructors.add('raw-list');
        const constructor = coreRule(binding.origin.module, binding.origin.name);
        if (constructor?.construct && constructor.result) unsafeConstructors.add(constructor.result);
        if (binding.origin.name === '*') for (const contract of fstReturnContracts) {
          budget.step();
          if (contract.invocation === 'construct') for (const origin of contract.origins) {
            if (origin.module !== binding.origin.module) continue;
            const candidate = coreRule(origin.module, origin.name);
            if (candidate?.result) unsafeConstructors.add(candidate.result);
          }
        }
      }
      if (binding.initializer) taint(binding.initializer, seen);
      else if (binding.kind === 'const' && binding.declaration) {
        budget.step(512);
        const projection = view.initializerProjection(binding.declaration);
        if (projection) taint(projection.initializer, seen);
      }
      else if (binding.kind === 'function' && binding.declaration) {
        const fn = view.declarationNode(binding.declaration);
        if (fn) taint(fn, seen);
      }
      return;
    }
    // Includes nested object/array storage and closures handed to unknown code.
    for (const child of node.type === 'pair' && node.fields.value ? [node.fields.value] : node.children) taint(child, seen);
  };
  for (const node of analyzeReceivers ? view.nodes : []) {
    budget.step();
    if (['assignment_expression', 'augmented_assignment_expression', 'update_expression', 'for_in_statement'].includes(node.type) || node.type === 'unary_expression' && node.tokens.includes('delete')) {
      const left = node.fields.left ?? node.fields.argument;
      if (left) taint(left);
      if (node.fields.right) taint(node.fields.right);
    }
    if (node.type === 'return_statement') for (const value of node.children) taint(value);
    if (node.type === 'jsx_expression') for (const value of node.children) taint(value);
  }
  for (const node of analyzeReceivers ? calls : []) {
    budget.step();
    const fn = node.fields.function ?? node.fields.constructor;
    if (!fn) continue;
    const directRule = direct.get(node), args = argsOf(node);
    if (directRule) {
      for (const index of directRule.forwards ?? []) if (args[index]) taint(args[index]!);
      continue;
    }
    const member = access(fn), receiver = member && handle(member.object);
    if (member?.name === 'asScoped' && context.family(node)) continue;
    const command = member?.name === 'then' && access(member.object);
    if (command && context.command(command.object, command.name)) continue;
    if (receiver && !method(receiver, member!.name) && receiver.kind !== 'remote-api') taint(member!.object);
    const directHandle = !member && handle(fn);
    const contract = receiver && method(receiver, member!.name);
    if (contract) {
      for (const index of contract.forwards ?? []) if (args[index]) taint(args[index]!);
      continue;
    }
    if (directHandle) {
      const forwarded = directHandle.kind === 'action' || ['value', 'delayed-value', 'hover-value', 'field'].includes(directHandle.kind) ? args
        : directHandle.kind === 'root-renderer' ? args.slice(1) : [];
      for (const arg of forwarded) taint(arg);
      continue;
    }
    if (member && !receiver) taint(member.object);
    if (!member && ['member_expression', 'subscript_expression'].includes(fn.type) && fn.fields.object) taint(fn.fields.object);
    for (const arg of argsOf(node)) taint(arg);
  }
  const usable = (node: SyntaxNode) => {
    const found = handle(node);
    return found && !receiverProofsLimited && !unsafe.has(found.root) && !(found.constructionKind && unsafeConstructors.has(found.constructionKind)) ? found : undefined;
  };
  const literal = (owner: Declaration, node: SyntaxNode, term: FstSolidProperty, anchor = node) => {
    budget.step(512);
    const value = view.constant(node);
    if (value.known && (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean')) {
      const text = String(value.value);
      if (safeString(text)) property(owner, term, text, anchor, 'core-literal', node.startIndex >= anchor.startIndex && node.endIndex <= anchor.endIndex ? value.resolution : 'constant');
      else diagnose('fst-solid.core-limit', 'Literal metadata exceeds the wire string limit.', anchor);
    }
  };
  const projected = (node: SyntaxNode, name: string) => {
    budget.step(512);
    const result = view.project(node, [name]);
    if (!result || result.path.length) return undefined;
    // Projection proves the property; retain its source identifier so a renderer
    // or callback is linked to its declaration, not just the normalized body.
    let object = view.unwrap(node);
    for (let depth = 0; depth < 16 && object.type !== 'object'; depth++) {
      budget.step();
      const binding = view.binding(object);
      if (!binding?.available || !binding.stable || binding.kind !== 'const' || !binding.initializer) break;
      object = view.unwrap(binding.initializer);
    }
    if (object.type === 'object') {
      let selected: SyntaxNode | undefined;
      for (const child of object.children) {
        budget.step();
        if (child.type === 'shorthand_property_identifier' && view.name(child) === name) selected = child;
        const key = child.fields.key;
        const keyNode = key?.type === 'computed_property_name' ? key.children[0] : key;
        if (child.type === 'pair' && keyNode && view.name(keyNode) === name) selected = child.fields.value;
      }
      if (selected) return selected;
    }
    return result.initializer;
  };
  const emit = (owner: Declaration, node: SyntaxNode, rule: CoreRule, target: SyntaxNode, args: readonly SyntaxNode[]) => {
    property(owner, 'fst-solid.api-operation', rule.operation, node, 'core-call');
    relation(owner, 'fst-solid.operation-target', view.reference(target), node, 'core-call');
    if (rule.policy) property(owner, 'fst-solid.api-policy', rule.policy, node, 'core-contract');
    for (const index of rule.callbacks ?? []) if (args[index]) relation(owner, 'fst-solid.callback', view.reference(args[index]!), node, 'core-callback');
    for (const index of rule.sources ?? []) if (args[index]) relation(owner, 'fst-solid.source', view.reference(args[index]!), node, 'core-source');
    for (const index of rule.keys ?? []) if (args[index]) {
      relation(owner, 'fst-solid.key-expression', view.reference(args[index]!), node, 'core-key');
      literal(owner, args[index]!, 'fst-solid.key');
    }
    const options = rule.options && args[rule.options.argument];
    if (options && rule.options) {
      for (const name of [...rule.options.callbacks ?? [], ...rule.options.sources ?? []]) {
        const value = projected(options, name);
        if (!value) continue;
        const term = rule.options.callbacks?.includes(name) ? 'fst-solid.callback' : 'fst-solid.source';
        relation(owner, term, view.reference(value), node, `core-option-${name}`);
      }
      for (const name of rule.options.literals ?? []) {
        budget.step(512);
        const value = view.constantProperty(options, name);
        if (value.known && ['string', 'number', 'boolean'].includes(typeof value.value)) {
          const text = `${name}=${String(value.value)}`;
          if (safeString(text)) property(owner, 'fst-solid.option', text, node, 'core-options', value.resolution);
        }
      }
    }
  };
  const callbackBinding = (callback: SyntaxNode, source: SyntaxNode, kind: string, allowed: readonly string[] = []) => {
    let fn = view.unwrap(callback);
    for (let depth = 0; depth < 16 && !functions.has(fn.type); depth++) {
      budget.step();
      const binding = view.binding(fn);
      if (!binding?.available || !binding.stable) return;
      const next = binding.initializer ?? (binding.kind === 'function' && binding.declaration ? view.declarationNode(binding.declaration) : undefined);
      if (!next) return;
      fn = view.unwrap(next);
    }
    if (!functions.has(fn.type)) return;
    const parameters = fn.fields.parameters ?? fn.fields.parameter;
    const parameter = parameters?.type === 'formal_parameters' ? parameters.children.find((child) => child.type !== 'comment') : parameters;
    if (!parameter) return;
    const pattern = view.patternProjections(parameter);
    if (!pattern.complete || pattern.projections.some(({ path }) => path.length > 1 || path.length === 1 && !allowed.includes(String(path[0])))) return;
    for (const binding of pattern.projections) {
      const owner = view.owner(binding.node), name = view.name(binding.node);
      if (!owner || !name || !safeString(name)) continue;
      property(owner, 'fst-solid.callback-binding', `${name}:${kind}${binding.path.length ? `.${String(binding.path[0])}` : ''}`, binding.node, 'core-callback-binding');
      relation(owner, 'fst-solid.callback-source', view.reference(source), binding.node, 'core-callback-binding');
    }
  };
  const routeDefinitions = (owner: Declaration, node: SyntaxNode, input: SyntaxNode, groups: boolean) => {
    // Definitions are static own object members only. No getters/spreads/dynamic IDs.
    budget.step(512);
    const result = view.project(input);
    const object = result?.path.length === 0 ? result.initializer : undefined;
    if (object?.type !== 'object') { diagnose('fst-solid.core-shape', 'Route definitions require a bounded static object.', node); return; }
    if (object.children.length > 32) { diagnose('fst-solid.core-limit', 'Route definitions exceed the bounded entry count.', node); return; }
    const entryName = (entry: SyntaxNode) => {
      const key = entry.fields.key;
      const unwrapped = key?.type === 'computed_property_name' ? key.children[0] : key;
      if (key?.type === 'computed_property_name' && unwrapped?.type !== 'string') return undefined;
      return unwrapped && view.name(unwrapped);
    };
    const names = new Set<string>(), duplicates = new Set<string>();
    for (const entry of object.children) {
      if (entry.type === 'comment') continue;
      const name = entryName(entry);
      if (entry.type !== 'pair' || name === undefined) {
        diagnose('fst-solid.core-shape', 'Dynamic route keys or spreads may replace other entries; the table is not enumerated.', node);
        return;
      }
      if (names.has(name)) duplicates.add(name);
      names.add(name);
    }
    if (duplicates.size) diagnose('fst-solid.core-shape', 'Duplicate route entries are not correlated with earlier source anchors.', node);
    for (const entry of object.children) {
      budget.step();
      if (entry.type === 'comment') continue;
      const name = entryName(entry);
      if (entry.type !== 'pair' || !name || !entry.fields.value) { diagnose('fst-solid.core-shape', 'Dynamic route entries are not enumerated.', node); continue; }
      if (duplicates.has(name)) continue;
      // Query through the original object to retain alias mutation/escape checks.
      const value = projected(input, name);
      if (!value) continue;
      let definition = view.unwrap(value);
      for (let depth = 0; depth < 16 && definition.type !== 'object'; depth++) {
        budget.step();
        const binding = view.binding(definition);
        if (!binding?.available || !binding.stable || binding.kind !== 'const' || !binding.initializer) break;
        definition = view.unwrap(binding.initializer);
      }
      if (definition.type === 'object') {
        const keys = new Set<string>();
        let unresolved = false;
        for (const child of definition.children) {
          budget.step();
          if (child.type === 'comment') continue;
          const key = child.type === 'shorthand_property_identifier' ? view.name(child) : entryName(child);
          if (key === undefined || keys.has(key) || !['pair', 'shorthand_property_identifier'].includes(child.type)) { unresolved = true; break; }
          keys.add(key);
        }
        if (unresolved) { diagnose('fst-solid.core-shape', 'Duplicate or dynamic route options are not correlated with a declaration.', node); continue; }
      }
      const entryOwner = view.owner(entry);
      if (!entryOwner) continue;
      relation(owner, 'fst-solid.route-definition', view.reference(value), node, 'core-routes');
      property(entryOwner, 'fst-solid.route-entry', name, entry, 'core-routes');
      if (!groups) {
        const component = projected(value, 'component');
        if (component) relation(entryOwner, 'fst-solid.route-component', view.reference(component), entry, 'core-route-component');
      }
      for (const prop of groups ? ['name', 'navPath'] : ['id', 'path', 'home', 'defaultPathArgs', 'navGroup', 'preloadComponent']) {
        const item = projected(value, prop);
        if (!item) continue;
        relation(entryOwner, 'fst-solid.route-option', view.reference(item), entry, `core-route-${prop}`);
        if (prop === 'path') literal(entryOwner, item, 'fst-solid.route-path', entry);
      }
    }
  };

  for (const node of analyzeReceivers ? calls : []) {
    budget.step();
    if (node.tokens.includes('?.')) continue;
    const fn = node.fields.function ?? node.fields.constructor;
    if (!fn) continue;
    const args = argsOf(node), owner = view.owner(node);
    if (!owner) continue;
    const directRule = direct.get(node);
    if (directRule) {
      const itemSequence = directRule.operation === 'list.raw-create' && node.type === 'call_expression';
      if (itemSequence && (receiverProofsLimited || unsafeConstructors.has('raw-list'))) {
        diagnose('fst-solid.core-shape', 'List factory identity is not proven after a constructor escape, mutation or bounded proof limit.', node);
        continue;
      }
      if (args.some((arg) => arg.type === 'spread_element') && !itemSequence) { diagnose('fst-solid.core-shape', 'Spread arguments do not establish positional API contracts.', node); continue; }
      emit(owner, node, itemSequence ? { ...directRule, sources: [] } : directRule.operation === 'collection.change-request' && knownFunction(args[2])
        ? { ...directRule, callbacks: [2], sources: [0, 1] } : directRule, fn, args);
      if (itemSequence) {
        property(owner, 'fst-solid.api-policy', 'ordered variadic contributions; spread iterables expand at runtime; final item count, values and normal completion unproven', node, 'list-item-sequence');
        for (const [index, arg] of args.entries()) {
          budget.step();
          const spread = arg.type === 'spread_element', input = spread ? arg.children.find(child => child.type !== 'comment') : arg;
          if (!input) { diagnose('fst-solid.core-shape', 'List item contribution has no inspectable source expression.', arg); continue; }
          property(owner, 'fst-solid.list-contribution', `${index}:${spread ? 'spread-iterable' : 'item'}`, arg, 'list-item-sequence');
          relation(owner, 'fst-solid.list-item-source', { kind: 'expression', text: view.text(input), span: view.span(input) }, arg, 'list-item-sequence');
          relation(owner, 'fst-solid.list-construction', { kind: 'expression', text: view.text(node), span: view.span(node) }, arg, 'list-item-sequence');
        }
      }
      const assigned = context.assigned(node);
      if (assigned && directRule.result && handle(node)) {
        role(assigned, 'fst-solid.api-handle', node, 'core-return');
        property(assigned, 'fst-solid.handle-kind', directRule.result, node, 'core-return');
      }
      if (directRule.operation === 'routes.define' || directRule.operation === 'navigation.groups-define') {
        if (args[0]) routeDefinitions(owner, node, args[0], directRule.operation === 'navigation.groups-define');
      }
      if (directRule.operation === 'load-sequence.create' && args[1]) callbackBinding(args[1], node, 'load-sequence-entry', ['loadGroup', 'index', 'isLast', 'isFirst']);
      if (['value.create', 'fragment.normalize'].includes(directRule.operation) && knownFunction(args[0])) relation(owner, 'fst-solid.callback', view.reference(args[0]!), node, 'core-initial-derivation');
      if (directRule.operation === 'value.delayed-create' && knownFunction(args[1])) relation(owner, 'fst-solid.callback', view.reference(args[1]!), node, 'core-initial-derivation');
      if (directRule.operation === 'value.switch-create') {
        if (args.length > 17) diagnose('fst-solid.core-limit', 'Switch cases exceed bounded case enumeration.', node);
        for (const entry of args.slice(1, 17)) {
          if (entry.type !== 'array') continue;
          const parts = entry.children.filter((child) => child.type !== 'comment');
          if (parts.length !== 2 || parts.some((part) => part.type === 'spread_element')) continue;
          budget.step(1024);
          if (!view.project(entry, [0]) || !view.project(entry, [1])) continue;
          emit(owner, entry, { operation: 'value.switch-case', sources: [0, 1], callbacks: knownFunction(parts[0]) ? [0] : [] }, parts[0]!, parts);
        }
      }
      continue;
    }
    const member = access(fn), receiver = member && usable(member.object);
    if (member && receiver) {
      let contract = method(receiver, member.name);
      if (contract && ['state', 'form', 'scope', 'item-scope'].includes(receiver.kind) && !context.family(member.object, member.name)) contract = undefined;
      if (!contract && receiver.kind === 'remote-api' && !member.name.startsWith('$') && !member.name.startsWith('_')) contract = { operation: 'transport.method-request', sources: args.map((_, i) => i), policy: 'remote-target-unresolved' };
      if (!contract || args.some((arg) => arg.type === 'spread_element')) continue;
      if (['value', 'delayed-value', 'hover-value'].includes(receiver.kind) && member.name === 'load') {
        contract = knownFunction(args[0]) ? { operation: 'value.configure-loader', callbacks: [0], options: { argument: 1, literals: ['explicit', 'delay'] } } : { operation: args.length ? 'value.load-configure-or-invoke' : 'value.invoke-loader', sources: [0, 1] };
      }
      emit(owner, node, contract, member.object, args);
      if (receiver.kind === 'subform') relation(owner, 'fst-solid.subform-origin', view.reference(receiver.creation), node, 'core-subform');
      if (args[0] && ['onSelectedChange', 'onActiveChange', 'onClicked'].includes(member.name)) callbackBinding(args[0], member.object, 'selection-event', [member.name === 'onSelectedChange' ? 'selected' : member.name === 'onActiveChange' ? 'active' : 'clicked', 'args']);
      if (args[0] && member.name === 'onChange' && ['value', 'delayed-value', 'hover-value'].includes(receiver.kind)) callbackBinding(args[0], member.object, 'pre-commit-value', ['value', 'oldValue']);
      continue;
    }
    // State proxy method.then is an invocation observer, not Promise chaining.
    if (member?.name === 'then' && !receiver) {
      const command = access(member.object), state = command && usable(command.object);
      if (state?.kind === 'state' && !state.raw && args[0] && context.command(command!.object, command!.name)) emit(owner, node, { operation: 'state.method-completion-observe', callbacks: [0], policy: 'successful-invocation-observer-not-promise-chain' }, member.object, args);
    }
    const invoked = !member && usable(fn);
    if (!invoked) continue;
    let contract: CoreRule | undefined;
    if (['value', 'delayed-value', 'hover-value'].includes(invoked.kind)) {
      budget.step(512);
      const constant = args[0] && view.constant(args[0]);
      const operation = !args.length || constant?.known && constant.value === undefined ? 'value.tracked-read' : constant?.known || knownFunction(args[0]) ? 'value.write-request' : 'value.call-read-or-write';
      contract = { operation, sources: args.length ? [0] : [] };
    } else if (['accessor', 'prop-value', 'loader'].includes(invoked.kind)) contract = { operation: `${invoked.kind}.read` };
    else if (invoked.kind === 'cancel') contract = { operation: 'cleanup.invoke-request', policy: 'not-owner-cleanup-unregistration' };
    else if (invoked.kind === 'action') contract = { operation: 'action.invoke-request', sources: args.map((_, index) => index), policy: 'parameters-delivered-as-array-no-enabled-enforcement' };
    else if (invoked.kind === 'scheduler') {
      budget.step(512);
      const first = args[0] && view.constant(args[0]);
      contract = first?.known && typeof first.value === 'number' ? { operation: 'action.schedule-request', keys: [0, 2], callbacks: [1] }
        : first?.known && typeof first.value === 'string' ? { operation: 'action.schedule-request', keys: [0, 1, 3], callbacks: [2] }
        : { operation: 'action.schedule-unknown-overload', sources: args.map((_, index) => index) };
    }
    else if (invoked.kind === 'fragment') contract = { operation: 'fragment.render-request', keys: [0], policy: 'cached-unless-explicit-rerender' };
    else if (invoked.kind === 'root-renderer') contract = { operation: 'view.render-root-request', sources: [0, 1], callbacks: knownFunction(args[0]) ? [0] : [], policy: 'manual-result-dispose' };
    if (contract && !args.some((arg) => arg.type === 'spread_element')) emit(owner, node, contract, fn, args);
  }

  // Component option onExit is a post-render callback, unlike /app/dom/hooks onExit.
  for (const node of calls) {
    if (node.type !== 'call_expression' || !node.fields.function) continue;
    const origin = view.resolve(node.fields.function);
    if (origin.kind !== 'import' || origin.member || !['component', 'componentWithChildren'].includes(origin.name) || !['@fst/components-fst-solid/app', '@fst/components-fst-solid/app/component'].includes(origin.module)) continue;
    const owner = view.owner(node), options = argsOf(node)[1];
    if (!owner || !options) continue;
    const callback = projected(options, 'onExit');
    if (callback) emit(owner, node, { operation: 'component.post-render-register', callbacks: [0], policy: 'not-unmount-or-visibility-exit' }, node.fields.function, [callback]);
  }
}
