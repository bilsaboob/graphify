import type { AnalysisBudget } from '#core';
import type { SyntaxNode, TypeScriptView } from '#typescript';
import { canonicalApi } from './vocabulary.js';

interface FamilyClass { readonly declaration: { readonly key: string }; readonly node: SyntaxNode; readonly family: string; readonly base?: FamilyClass }
interface Root { readonly info: FamilyClass; readonly peers?: readonly FamilyClass[]; readonly kind: 'class' | 'prototype' | 'instance' }
const functions = new Set(['function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration']);
const proxyHooks = ['isIgnoredProxyMember', 'buildMember', 'build', 'buildClassProxyMembers'];

/** Private invalidation only: constructor writes and exposed prototypes are not alias facts. */
export function familySafety(view: TypeScriptView, budget: AnalysisBudget, classes: ReadonlyMap<string, FamilyClass>, lifetimeNames: ReadonlySet<string>) {
  const changes = new Map<string, Set<string>>();
  const staticChanges = new Map<string, Set<string>>();
  let limited = false;
  const mark = (root: Root, name = '*', staticsOnly = false) => {
    for (const info of [root.info, ...root.peers ?? []]) {
      for (const map of staticsOnly ? [staticChanges] : root.kind === 'class' ? [changes, staticChanges] : [changes]) {
        const names = map.get(info.declaration.key) ?? new Set<string>();
        names.add(name === '__proto__' ? '*' : name);
        map.set(info.declaration.key, names);
      }
    }
  };
  const memberName = (node: SyntaxNode) => {
    const key = node.type === 'member_expression' ? node.fields.property : node.type === 'subscript_expression' ? node.fields.index : node.fields.name;
    return key && (node.type !== 'subscript_expression' || key.type === 'string') ? view.name(key) : undefined;
  };
  const classThis = (node: SyntaxNode): Root | undefined => {
    for (let cursor = view.parent(node); cursor; cursor = view.parent(cursor)) {
      budget.step();
      if (functions.has(cursor.type) || cursor.type === 'class_static_block') return;
      if (cursor.type !== 'method_definition' && cursor.type !== 'public_field_definition') continue;
      if (!cursor.tokens.includes('static') && cursor.type === 'method_definition' && memberName(cursor) !== 'constructor') return;
      const body = view.parent(cursor), owner = body && view.parent(body), declaration = owner && view.declarationAt(owner);
      const info = declaration && classes.get(declaration.key);
      return info ? { info, kind: cursor.tokens.includes('static') ? 'class' : 'instance' } : undefined;
    }
    return;
  };
  const rootOf = (input: SyntaxNode, seen = new Set<SyntaxNode>()): Root | undefined => {
    budget.step();
    const node = view.unwrap(input);
    if (seen.has(node)) return;
    if (seen.size >= 24) { limited = true; return; }
    seen.add(node);
    if (node.type === 'this') return classThis(node);
    const binding = view.binding(node);
    if (binding) {
      const info = binding.declaration && classes.get(binding.declaration);
      if (info) return { info, kind: 'class' };
      if (binding.origin) {
        const origin = binding.origin;
        const supported = Object.entries({ State: 'state', Form: 'form', Scope: 'scope', ItemScope: 'item-scope' })
          .filter(([name]) => (origin.name === name || origin.name === '*') && canonicalApi(origin.module, name) === name)
          .map(([, family]) => family);
        const peers = [...classes.values()].filter((candidate) => supported.includes(candidate.family));
        if (peers[0]) return { info: peers[0], peers: peers.slice(1), kind: 'class' };
      }
      // Mutation invalidation intentionally also follows unstable const aliases.
      if (binding.kind === 'const' && binding.initializer) return rootOf(binding.initializer, seen);
      return;
    }
    if (['member_expression', 'subscript_expression'].includes(node.type) && node.fields.object) {
      const root = rootOf(node.fields.object, seen);
      if (root?.kind === 'class' && memberName(node) === 'prototype') return { ...root, kind: 'prototype' };
    }
    return;
  };
  const expose = (input: SyntaxNode, seen = new Set<SyntaxNode>()) => {
    budget.step();
    const node = view.unwrap(input);
    if (seen.has(node)) return;
    if (node.type === 'binary_expression' && node.tokens.includes('instanceof')) {
      if (node.fields.left) expose(node.fields.left, seen);
      return;
    }
    if (['string', 'number', 'true', 'false', 'null', 'comment', 'property_identifier'].includes(node.type)) return;
    if (node.type === 'pair' && node.fields.value) { expose(node.fields.value, seen); return; }
    if (node.type.startsWith('jsx_')) {
      const pending = [node];
      while (pending.length) {
        budget.step();
        const child = pending.pop()!;
        if (child.type === 'jsx_expression') for (const value of child.children) expose(value, seen);
        else pending.push(...child.children);
      }
      return;
    }
    if (seen.size >= 4096) { limited = true; return; }
    seen.add(node);
    const root = rootOf(node);
    if (root) { mark(root); return; }
    const binding = view.binding(node);
    if (binding) {
      if (binding.kind === 'const' && binding.initializer) expose(binding.initializer, seen);
      return;
    }
    if (node.type === 'call_expression' || node.type === 'new_expression') return;
    if (functions.has(node.type) || node.type === 'arrow_function') {
      const body = node.fields.body;
      if (body?.type !== 'statement_block') { if (body) expose(body, seen); return; }
      const pending = [...body.children];
      while (pending.length) {
        budget.step();
        const child = pending.pop()!;
        if (child.type === 'return_statement') for (const value of child.children) expose(value, seen);
        else if (!functions.has(child.type) && child.type !== 'arrow_function') pending.push(...child.children);
      }
      return;
    }
    if (['member_expression', 'subscript_expression'].includes(node.type) && node.fields.object) { expose(node.fields.object, seen); return; }
    for (const child of node.type === 'pair' && node.fields.value ? [node.fields.value] : node.children) expose(child, seen);
  };
  const write = (input: SyntaxNode) => {
    const node = view.unwrap(input);
    if (['member_expression', 'subscript_expression'].includes(node.type) && node.fields.object) {
      const root = rootOf(node.fields.object), name = memberName(node);
      if (root?.kind === 'class') { if (name === 'prototype' || name === undefined || name === '__proto__') mark(root); else mark(root, name, true); }
      else if (root) mark(root, name);
      else expose(node.fields.object);
      return;
    }
    // Pattern projections may be incomplete precisely because a member is written.
    for (const child of node.type === 'pair_pattern' && node.fields.value ? [node.fields.value] : node.children) write(child);
  };
  if (classes.size) for (const node of view.nodes) {
    budget.step();
    if (['assignment_expression', 'augmented_assignment_expression', 'update_expression', 'for_in_statement'].includes(node.type) || node.type === 'unary_expression' && node.tokens.includes('delete')) {
      const target = node.fields.left ?? node.fields.argument;
      if (target) write(target);
      if (node.fields.right) expose(node.fields.right);
    }
    if (node.type === 'jsx_expression') for (const value of node.children) expose(value);
    if (node.type !== 'call_expression' && node.type !== 'new_expression') continue;
    const fn = node.fields.function ?? node.fields.constructor;
    if (fn?.fields.object) {
      const root = rootOf(fn.fields.object), name = memberName(fn);
      if (root?.kind === 'prototype') mark(root);
      if (root?.kind === 'class' && (!name || !lifetimeNames.has(name))) mark(root);
      if (root?.kind === 'instance') {
        const declared = root.info.node.fields.body?.children.some((child) => memberName(child) === name);
        if (declared || !['field', 'form', 'onReady', 'onChange'].includes(name ?? '')) mark(root);
      }
    }
    for (const arg of node.fields.arguments?.children ?? []) {
      // asScoped supplies an existing object; it does not build or customize it.
      if (fn && memberName(fn) === 'asScoped' && fn.fields.object && rootOf(fn.fields.object)?.kind === 'class') continue;
      expose(arg);
    }
  }
  const changedIn = (map: ReadonlyMap<string, ReadonlySet<string>>, info: FamilyClass, name: string) => {
    if (limited) return true;
    for (let current: FamilyClass | undefined = info; current; current = current.base) {
      budget.step();
      if (map.get(current.declaration.key)?.has('*') || map.get(current.declaration.key)?.has(name)) return true;
    }
    return false;
  };
  const changed = (info: FamilyClass, name: string) => changedIn(changes, info, name);
  const staticChanged = (info: FamilyClass, name: string) => changedIn(staticChanges, info, name);
  const customProxy = (info: FamilyClass) => {
    if (proxyHooks.some((name) => changed(info, name))) return true;
    for (let current: FamilyClass | undefined = info; current; current = current.base) {
      budget.step();
      if (current.node.fields.body?.children.some((child) => !child.tokens.includes('static') &&
        (child.fields.name?.type === 'computed_property_name' || proxyHooks.includes(memberName(child) ?? '')))) return true;
    }
    return false;
  };
  return { changed, staticChanged, customProxy };
}
