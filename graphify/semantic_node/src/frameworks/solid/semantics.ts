import type { AnalysisBudget, ReadonlyDeclaration as Declaration } from '#core';
import type { Reference } from '#core/wire';
import type { SyntaxNode, TypeScriptView, ValueProjection } from '#typescript';
import { solidRule, type CallbackRule, type SolidApiRule } from './contracts.js';
import type { SolidProperty, SolidRelation, SolidRole } from './vocabulary.js';

export interface SolidHandle { declaration: Declaration; role: SolidRole; projection: ValueProjection }
export interface SolidCall { node: SyntaxNode; rule: SolidApiRule }
interface Context {
  view: TypeScriptView;
  budget: AnalysisBudget;
  calls: readonly SolidCall[];
  handle(node: SyntaxNode): SolidHandle | undefined;
  relation(subject: Declaration, term: SolidRelation, target: Reference, node: SyntaxNode, rule: string): void;
  property(subject: Declaration, term: SolidProperty, value: string, node: SyntaxNode): void;
  diagnose(code: string, message: string, node: SyntaxNode): void;
}
const functions = new Set(['arrow_function', 'function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration', 'method_definition']);
const reads = new Set<SolidRole>(['solid.signal-accessor', 'solid.accessor', 'solid.resource', 'solid.children', 'solid.transition-pending', 'solid.selector']);
const writes = new Set<SolidRole>(['solid.signal-setter', 'solid.store-updater', 'solid.resource-mutator']);
const methods: Partial<Record<SolidRole, readonly string[]>> = {
  'solid.resource-actions': ['mutate', 'refetch'], 'solid.observable': ['subscribe'],
  'solid.lazy-component': ['preload'], 'solid.children': ['toArray'], 'solid.query': ['keyFor'], 'solid.action': ['with'],
};
const bindingOnly = new Set(['createSignal', 'createStore', 'splitProps']);
const contextModules = new Set(['solid-js', '@fst/components-fst-solid/solid-js']);

/** File-level compiler context; imported control contracts are handled separately. */
export function solidJSXContext(view: TypeScriptView, budget: AnalysisBudget): boolean {
  for (const node of view.nodes) {
    budget.step();
    if (node.type === 'comment' && /@jsxImportSource\s+(?:solid-js|@fst\/components-fst-solid\/solid-js)(?:\s|\*\/|$)/.test(view.text(node))) return true;
  }
  return false;
}

export function analyzeSemantics(ctx: Context, jsxContext: boolean): void {
  const { view, budget, relation, property, diagnose, handle } = ctx;
  const nativeContext = (input: SyntaxNode): boolean => {
    if (jsxContext) return true;
    let node: SyntaxNode | undefined = input;
    for (let depth = 0; node && depth < 64; depth++, node = view.parent(node)) {
      budget.step();
      if (node.type === 'call_expression' && node.fields.function) {
        const origin = view.resolve(node.fields.function);
        if (origin.kind === 'import' && !origin.member && origin.module === '@fst/components-fst-solid/app/component' && ['component', 'componentWithChildren'].includes(origin.name)) {
          const renderer = node.fields.arguments?.children.find((item) => item.type !== 'comment');
          if (renderer && functions.has(view.unwrap(renderer).type) && input.startIndex >= renderer.startIndex && input.endIndex <= renderer.endIndex) return true;
        }
      }
      const annotation = node.fields.type ?? node.fields.return_type;
      if (annotation) {
        const stack = [annotation];
        for (let count = 0; stack.length && count < 64; count++) {
          budget.step();
          const type = stack.pop()!, origin = view.resolve(type, 'type');
          if (origin.kind === 'import' && contextModules.has(origin.module) && ['Component', 'ParentComponent', 'FlowComponent', 'VoidComponent', 'JSX'].includes(origin.name)) return true;
          stack.push(...type.children);
        }
      }
    }
    return false;
  };
  const argsOf = (node: SyntaxNode) => node.fields.arguments?.children.filter((item) => item.type !== 'comment') ?? [];
  const source = (owner: Declaration | undefined, node: SyntaxNode | undefined, anchor: SyntaxNode, term: SolidRelation = 'solid.source') => {
    if (owner && node) relation(owner, term, view.reference(node), anchor, 'explicit-source');
  };
  const fnOf = (input: SyntaxNode): SyntaxNode | undefined => {
    let node = view.unwrap(input);
    const seen = new Set<SyntaxNode>();
    while (!functions.has(node.type) && seen.size < 24 && !seen.has(node)) {
      budget.step(); seen.add(node);
      const binding = view.binding(node);
      if (!binding?.available || !binding.stable || binding.typeOnly) return undefined;
      const next = binding.initializer ?? (binding.kind === 'function' && binding.declaration ? view.declarationNode(binding.declaration) : undefined);
      if (!next) return undefined;
      node = view.unwrap(next);
    }
    return functions.has(node.type) ? node : undefined;
  };
  const parametersOf = (fn: SyntaxNode): readonly SyntaxNode[] => {
    const parameters = fn.fields.parameters ?? fn.fields.parameter;
    const list = parameters?.type === 'formal_parameters' ? parameters.children : parameters ? [parameters] : [];
    return list.filter((item) => item.type !== 'comment' && (item.fields.pattern ?? item.fields.name ?? item).type !== 'this');
  };
  const callbackObservation = (anchor: SyntaxNode): SyntaxNode => {
    const parent = view.parent(anchor);
    return anchor.type === 'jsx_opening_element' && parent?.type === 'jsx_element' ? parent : anchor;
  };
  const array = (input: SyntaxNode): readonly SyntaxNode[] | undefined => {
    const node = view.unwrap(input), items = node.children.filter((item) => item.type !== 'comment');
    if (node.type !== 'array' || items.length > 16) return undefined;
    const punctuation = (a: number, b: number) => view.source.slice(a, b).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '').trim();
    if (items.some((item, i) => item.type === 'spread_element' || punctuation(i ? items[i - 1]!.endIndex : node.startIndex + 1, item.startIndex) !== (i ? ',' : ''))) return undefined;
    return ['', ','].includes(punctuation(items.at(-1)?.endIndex ?? node.startIndex + 1, node.endIndex - 1)) ? items : undefined;
  };
  const fields = (input: SyntaxNode | undefined): ReadonlyMap<string, SyntaxNode> | undefined => {
    if (!input) return undefined;
    let node = view.unwrap(input);
    if (node.type !== 'object') {
      budget.step(512);
      const current = view.constant(node);
      if (!current.known || typeof current.value !== 'object' || current.value === null) return undefined;
      budget.step(512);
      const p = view.project(node);
      if (!p || p.path.length) return undefined;
      node = p.initializer;
    }
    if (node.type !== 'object' || node.children.length > 32) return undefined;
    const result = new Map<string, SyntaxNode>();
    for (const child of node.children) {
      budget.step();
      if (child.type === 'comment') continue;
      if (child.type === 'shorthand_property_identifier') { result.set(view.text(child), child); continue; }
      const key = child.fields.key && view.name(child.fields.key);
      if (child.type !== 'pair' || !key || !child.fields.value) return undefined;
      result.set(key, child.fields.value);
    }
    return result;
  };
  const direct = (fn: SyntaxNode, mode: NonNullable<CallbackRule['reads']>) => {
    if (fn.type.includes('generator') || fn.tokens.includes('*')) return;
    const body = fn.fields.body;
    if (!body) return;
    const stack = [body];
    while (stack.length) {
      budget.step();
      const node = stack.pop()!;
      if (node.type === 'await_expression' || node.type === 'yield_expression') break;
      if (functions.has(node.type) || node.type === 'class' || node.type === 'class_declaration') continue;
      if (node.type === 'call_expression' && node.fields.function && !node.tokens.includes('?.')) {
        const pending = [...node.children];
        let suspends = false;
        while (pending.length) {
          budget.step();
          const child = pending.pop()!;
          if (functions.has(child.type)) continue;
          if (['await_expression', 'yield_expression'].includes(child.type)) { suspends = true; break; }
          pending.push(...child.children);
        }
        const target = view.unwrap(node.fields.function), value = handle(target), owner = view.owner(node);
        const term = value && (reads.has(value.role) && mode !== 'batch' ? mode === 'tracked' ? 'solid.potential-read' : 'solid.untracked-read' : writes.has(value.role) && mode === 'batch' ? 'solid.batch-write' : undefined);
        if (!suspends && term && owner) relation(owner, term, view.reference(target), node, 'direct-callback-call');
      }
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    }
  };
  const callback = (input: SyntaxNode | undefined, anchor: SyntaxNode, spec: CallbackRule, dependencies?: readonly SyntaxNode[]): SyntaxNode | undefined => {
    if (!input) return undefined;
    const value = view.unwrap(input);
    if (['object', 'array', 'regex', 'template_string'].includes(value.type) || (value.type === 'unary_expression' && value.tokens.includes('void'))) return undefined;
    budget.step(512);
    if (view.constant(input).known) return undefined;
    const fn = fnOf(input);
    let labels = spec.parameters;
    if (spec.arity) {
      let arity: number | undefined;
      budget.step(512);
      if (fn && view.referenceStable(input, callbackObservation(anchor), 'before-call')) {
        const list = parametersOf(fn);
        if (list.length <= 16) {
          arity = 0;
          for (const parameter of list) {
            const pattern = parameter.fields.pattern ?? parameter.fields.name ?? parameter;
            if (parameter.fields.value || ['assignment_pattern', 'rest_pattern'].includes(pattern.type)) break;
            arity++;
          }
        }
      }
      if (arity === undefined && spec.arity === 'positive' && ['Show render child', 'Match render child'].includes(spec.role)) {
        const owner = view.owner(anchor);
        if (owner) {
          relation(owner, 'solid.conditional-callback', { kind: 'expression', text: view.text(input), span: view.span(input) }, anchor, 'conditional-child-dispatch');
          property(owner, 'solid.callback-dispatch', `${spec.role}: when selected, typeof child === function && child.length > 0 invokes child untracked; otherwise renders child value; when not selected, ${spec.role.startsWith('Show') ? 'uses fallback' : 'Switch selects another Match or fallback'}; callable identity, length and branch unproven`, anchor);
          property(owner, 'solid.callback-argument-contract', `conditional argument[0]: ${labels?.[0] ?? 'condition value when keyed, guarded condition accessor otherwise'}; accessors are guarded by the active branch; not a parameter binding`, anchor);
        }
        return undefined;
      }
      if (arity === undefined) diagnose('solid.callback-shape', 'Arity-dependent callback dispatch requires a stable local function object.', anchor);
      if (spec.arity === 'positive' && !arity) return undefined;
      if (spec.arity === 'index-accessor' && (arity === undefined || arity <= 1)) labels = labels?.slice(0, 1);
    }
    source(view.owner(anchor), input, anchor, 'solid.callback');
    if (!fn) return undefined;
    const owner = view.owner(fn);
    if (owner) {
      property(owner, 'solid.callback-role', spec.role, fn);
      if (spec.returns) property(owner, 'solid.return-contract', spec.returns, fn);
    }
    const list = parametersOf(fn);
    for (let index = 0; index < Math.min(list.length, labels?.length ?? 0, 8); index++) {
      budget.step(512);
      const parameter = list[index]!, pattern = parameter.type === 'optional_parameter' && !parameter.fields.value ? parameter.fields.pattern ?? parameter.fields.name ?? parameter : parameter;
      const projected = view.patternProjections(pattern);
      if (!projected.complete || projected.projections.length > 32) { diagnose('solid.callback-shape', 'Callback bindings require bounded static patterns without defaults or rest.', parameter); continue; }
      for (const entry of projected.projections) {
        const subject = view.owner(entry.node) ?? owner;
        if (!subject) continue;
        if (entry.path.length && labels![index]!.includes('accessor')) {
          diagnose('solid.callback-shape', 'Destructured function properties are not whole accessor parameters.', entry.node); continue;
        }
        const path = entry.path.length ? `.${entry.path.join('.')}` : '';
        property(subject, 'solid.parameter-role', `${view.text(entry.node)}: ${labels![index]}${path}`, entry.node);
        if (dependencies && index < 2) {
          const dependency = entry.path.length === 1 && typeof entry.path[0] === 'number' ? dependencies[entry.path[0]] : !entry.path.length && dependencies.length === 1 ? dependencies[0] : undefined;
          source(subject, dependency, entry.node, 'solid.parameter-source');
        }
      }
    }
    if (spec.reads) direct(fn, spec.reads);
    return fn;
  };
  const options = (input: SyntaxNode | undefined, anchor: SyntaxNode, names: readonly string[]) => {
    const map = fields(input), owner = view.owner(anchor);
    if (!map) return;
    for (const name of names) {
      const value = map.get(name);
      if (!value || !owner) continue;
      source(owner, value, anchor);
      budget.step(512);
      const literal = view.constant(value);
      if (literal.known && (typeof literal.value === 'string' || typeof literal.value === 'boolean' || typeof literal.value === 'number')) property(owner, 'solid.option', `${name}=${String(literal.value)}`, anchor);
    }
  };
  for (const { node, rule } of ctx.calls) {
    budget.step();
    const args = argsOf(node), owner = view.owner(node), name = rule.name;
    if (args.length > 32 || args.some((item) => item.type === 'spread_element')) { diagnose('solid.call-shape', 'API arguments require bounded explicit positions without spreads.', node); continue; }
    if (!bindingOnly.has(name) && owner) {
      relation(owner, 'solid.api-call', view.resolve(node.fields.function!), node, 'qualified-api');
      if (rule.boundary) property(owner, 'solid.boundary', rule.boundary, node);
    }
    for (const spec of rule.callbacks ?? []) if (name !== 'from') callback(args[spec.index], node, spec);
    for (const index of rule.sources ?? []) source(owner, args[index], node,
      name === 'runWithOwner' || name === 'createRoot' ? 'solid.owner-source' : name === 'useContext' ? 'solid.context-source' :
      (['query', 'cache', 'revalidate', 'query.get', 'query.delete'].includes(name) || (name === 'query.set' && index === 0)) ? 'solid.key-source' : ['useAction', 'useSubmission', 'useSubmissions'].includes(name) ? 'solid.action-source' : 'solid.source');
    if (name === 'on') {
      const deps = args[0] && (view.unwrap(args[0]).type === 'array' ? array(args[0]) : [args[0]]);
      if (!deps) diagnose('solid.callback-shape', 'Explicit dependency arrays require bounded static slots without holes or spreads.', node);
      else for (const dep of deps) source(owner, dep, node);
      callback(args[1], node, { index: 1, role: 'on value callback (untracked)', parameters: ['current dependency values', 'previous dependency values or undefined', 'previous returned accumulator'], reads: 'untracked', returns: 'next accumulator, not cleanup' }, deps);
      options(args[2], node, ['defer']);
    }
    if (name === 'createResource') {
      const knownOptions = args[1] && fields(args[1]);
      const hasSource = args.length >= 3 || (args.length === 2 && !!fnOf(args[1]!));
      if (args.length === 2 && !knownOptions && !hasSource) {
        diagnose('solid.call-shape', 'Two-argument resource overload requires a proven fetcher function or options object.', node); continue;
      }
      const fetcher = args[hasSource ? 1 : 0], settings = args[hasSource ? 2 : 1];
      if (hasSource) source(owner, args[0], node);
      callback(fetcher, node, { index: 0, role: 'resource fetcher', parameters: [hasSource ? 'source value' : 'true source value', 'fetcher info (value and refetching)'] });
      const map = fields(settings);
      callback(map?.get('storage'), node, { index: 0, role: 'resource storage factory', parameters: ['initial stored value'], returns: 'accessor/setter pair' });
      options(settings, node, ['initialValue', 'deferStream', 'ssrLoadFrom']);
    }
    if (name === 'mergeProps') for (const [index, arg] of args.entries()) {
      source(owner, arg, arg, 'solid.merge-source');
      if (owner) property(owner, 'solid.option', `merge source ${index}`, arg);
    }
    if (name === 'modifyMutable') {
      source(owner, args[0], node, 'solid.store-target'); source(owner, args[1], node, 'solid.modifier-source');
    }
    if (name === 'createDynamic') source(owner, args[0], node, 'solid.dynamic-component');
    if (name === 'from') {
      budget.step(512);
      if (!args[0] || !view.referenceStable(args[0], node, 'before-call')) diagnose('solid.call-shape', 'Producer subscription dispatch requires a stable reference after argument evaluation.', node);
      else {
        const producer = fields(args[0]);
        if (producer?.has('subscribe')) callback(producer.get('subscribe'), node, { index: 0, role: 'external subscription producer', parameters: ['next value callback'], returns: 'cleanup callback or unsubscribe object' });
        else if (fnOf(args[0]) && rule.callbacks?.[0]) callback(args[0], node, rule.callbacks[0]);
      }
    }
    if (name === 'lazy' && args[0]) {
      const fn = fnOf(args[0]), body = fn?.fields.body;
      if (body) {
        const value = body.type === 'statement_block' ? body.children.find((item) => item.type === 'return_statement')?.children[0] : body;
        if (value?.type === 'call_expression' && value.fields.function?.type === 'import') {
          const module = argsOf(value)[0];
          if (module?.type === 'string') source(owner, module, node, 'solid.module-source');
        }
      }
    }
    if (['createMemo', 'createDeferred', 'reconcile'].includes(name)) {
      const settings = args[name === 'createMemo' ? 2 : 1], map = fields(settings);
      if (name !== 'reconcile') callback(map?.get('equals'), node, { index: 0, role: 'equality comparator', parameters: ['previous value', 'next value'] });
      options(settings, node, name === 'reconcile' ? ['key', 'merge'] : name === 'createDeferred' ? ['equals', 'timeoutMs'] : ['equals']);
    }
    if (name === 'renderToStream') {
      const map = fields(args[1]);
      for (const key of ['onCompleteShell', 'onCompleteAll']) callback(map?.get(key), node, { index: 0, role: `server ${key}`, parameters: ['stream info (write)'] });
    }
  }
  for (const node of view.nodes) {
    budget.step();
    if (node.type === 'call_expression' && node.fields.function && !node.tokens.includes('?.')) {
      const fn = view.unwrap(node.fields.function), bound = handle(fn), args = argsOf(node), owner = view.owner(node);
      if (bound?.role === 'solid.reaction') callback(args[0], node, { index: 0, role: 'reaction tracked body', reads: 'tracked' });
      if (bound?.role === 'solid.transition-start') callback(args[0], node, { index: 0, role: 'transition work' });
      if (bound?.role === 'solid.store-updater' && args.length) {
        const last = args.at(-1)!, modifier = handle(last), expression = view.unwrap(last);
        const origin = expression.type === 'call_expression' && expression.fields.function ? view.resolve(expression.fields.function) : undefined;
        const api = origin?.kind === 'import' && !origin.member ? solidRule(origin.module, origin.name) : undefined;
        source(owner, last, node, modifier?.role === 'solid.store-modifier' || (api && ['produce', 'reconcile'].includes(api.name)) ? 'solid.modifier-source' : 'solid.source');
        for (let index = 0; owner && index < Math.min(args.length - 1, 16); index++) {
          source(owner, args[index], node);
          budget.step(512);
          const key = view.constant(args[index]!);
          if (key.known && (typeof key.value === 'string' || typeof key.value === 'number')) property(owner, 'solid.option', `store path ${index}=${key.value}`, node);
        }
      }
      if (fn.type === 'member_expression' && fn.fields.object && fn.fields.property && !fn.tokens.includes('?.')) {
        const base = handle(fn.fields.object), method = view.name(fn.fields.property);
        if (base && method && methods[base.role]?.includes(method)) {
          budget.step(512);
          const projected = view.project(fn);
          if (projected?.contract && projected.contract === base.projection.contract && owner) {
            if (!bound) relation(owner, 'solid.handle-call', view.reference(fn), node, 'declared-handle-member');
            if (base.role === 'solid.observable' && method === 'subscribe') {
              if (args[0] && fnOf(args[0])) callback(args[0], node, { index: 0, role: 'observable observer', parameters: ['next value'] });
              else {
                source(owner, args[0], node);
                budget.step(512);
                if (args[0] && view.referenceStable(args[0], node, 'before-call')) callback(fields(args[0])?.get('next'), node, { index: 0, role: 'observable next observer', parameters: ['next value'] });
              }
            }
          } else if (owner) diagnose('solid.call-shape', 'Declared handle member is not proven after a receiver escape or mutation.', node);
        }
      }
    }
    if (node.type === 'member_expression' && node.fields.object && node.fields.property && !node.tokens.includes('?.')) {
      const base = handle(node.fields.object), name = view.name(node.fields.property), owner = view.owner(node);
      if (base?.role === 'solid.resource' && owner && name && ['loading', 'error', 'state', 'latest'].includes(name)) {
        budget.step(512);
        if (view.project(node)) { source(owner, node.fields.object, node, 'solid.resource-status'); property(owner, 'solid.option', `resource.${name}`, node); }
      }
    }
    if (!['jsx_opening_element', 'jsx_self_closing_element'].includes(node.type) || !node.fields.name) continue;
    const tag = node.fields.name, owner = view.owner(node), origin = view.resolve(tag);
    const rule = origin.kind === 'import' && !origin.member ? solidRule(origin.module, origin.name) : undefined;
    const attributes = new Map<string, { node: SyntaxNode; value: SyntaxNode | undefined }>();
    const superseded = new Set<string>(), duplicates = new Set<string>(), spreads: SyntaxNode[] = [], overridden: SyntaxNode[] = [];
    for (const item of node.children) {
      budget.step();
      if (item.type === 'jsx_expression') {
        spreads.push(item);
        for (const name of attributes.keys()) superseded.add(name);
        for (const attr of attributes.values()) overridden.push(attr.node);
        attributes.clear();
        continue;
      }
      if (item.type !== 'jsx_attribute' || !item.children[0]) continue;
      const expression = item.children[1], value = expression?.type === 'jsx_expression' ? expression.children.find((child) => child.type !== 'comment') : expression;
      const name = view.text(item.children[0]);
      if (attributes.has(name)) { duplicates.add(name); superseded.add(name); attributes.delete(name); continue; }
      superseded.delete(name);
      attributes.set(name, { node: item, value });
    }
    const prop = (name: string) => {
      if (!attributes.has(name) && (spreads.length || superseded.has(name))) diagnose('solid.jsx-shape', `JSX ${name} is not proven after spread or duplicate props.`, node);
      return attributes.get(name)?.value;
    };
    const recordSpreads = () => {
      for (const attr of overridden) source(owner, attr, attr, 'solid.jsx-overridden');
      for (const spread of spreads) {
        const argument = spread.children.find((item) => item.type === 'spread_element')?.children.find((item) => item.type !== 'comment');
        source(owner, argument, spread);
        if (owner) property(owner, 'solid.jsx-mode', 'spread props (dynamic keys; authored order retained; final effective values unproven)', spread);
      }
    };
    const parent = view.parent(node);
    const children = node.type === 'jsx_opening_element' && parent?.type === 'jsx_element' && parent.children.find((item) => item.type === 'jsx_opening_element') === node
      ? parent.children.filter((item) => !['jsx_opening_element', 'jsx_closing_element', 'comment'].includes(item.type) && !(item.type === 'jsx_text' && !view.text(item).trim()) && !(item.type === 'jsx_expression' && item.children.every((child) => child.type === 'comment'))) : [];
    const child = children.length === 1 && children[0]!.type === 'jsx_expression' ? children[0]!.children.find((item) => item.type !== 'comment') : undefined;
    if (rule?.jsx && owner) {
      relation(owner, 'solid.api-call', origin, node, 'qualified-jsx');
      recordSpreads();
      if (['For', 'Index'].includes(rule.name)) {
        source(owner, prop('each'), node);
        callback(children.length ? child : prop('children'), node, { index: 0, role: `${rule.name} children`, parameters: rule.name === 'For' ? ['item value', 'index accessor'] : ['item accessor', 'index value'], ...(rule.name === 'For' ? { arity: 'index-accessor' as const } : {}) });
      }
      if (['Show', 'Match'].includes(rule.name)) {
        source(owner, prop('when'), node);
        const keyed = attributes.get('keyed');
        const unknownKeyed = !keyed && (spreads.length > 0 || superseded.has('keyed'));
        if (unknownKeyed) prop('keyed');
        const mode = unknownKeyed ? 'condition value or accessor (dynamic keyed)' : !keyed ? 'condition accessor' : !keyed.value || view.text(keyed.value) === 'true' ? 'condition value (keyed)' : view.text(keyed.value) === 'false' ? 'condition accessor' : 'condition value or accessor (dynamic keyed)';
        const rendered = children.length ? child : prop('children');
        source(owner, rendered, node, 'solid.render-child');
        callback(rendered, node, { index: 0, role: `${rule.name} render child`, parameters: [mode], reads: 'untracked', arity: 'positive' });
      }
      if (rule.name === 'ErrorBoundary') callback(prop('fallback'), node, { index: 0, role: 'error fallback', parameters: ['error', 'reset callback'] });
      if (rule.name === 'Dynamic') {
        if (!spreads.length) source(owner, prop('component'), node, 'solid.dynamic-component');
        else {
          let ordinal = 0, group = 0;
          const contribution = (item: SyntaxNode, kind: string, input: SyntaxNode) => {
            property(owner, 'solid.jsx-contribution', `${ordinal++}:group=${group}:${kind}`, item);
            relation(owner, 'solid.jsx-contribution-source', { kind: 'expression', text: view.text(input), span: view.span(input) }, item, 'dynamic-prop-sequence');
            relation(owner, 'solid.jsx-element', { kind: 'expression', text: view.text(node), span: view.span(node) }, item, 'dynamic-prop-sequence');
          };
          for (const item of node.children) {
            budget.step();
            if (item.type === 'jsx_attribute' && item.children[0]) contribution(item, `attribute:${view.text(item.children[0])}`, item);
            else if (item.type === 'jsx_expression') {
              const input = item.children.find(child => child.type === 'spread_element')?.children.find(child => child.type !== 'comment');
              if (input) { group++; contribution(item, 'spread', input); group++; }
            }
          }
          for (const child of children) contribution(child, 'nested-child-source', child);
          property(owner, 'solid.jsx-props-contract', 'authored groups and order, not compiler lowering proof; Solid lazy merge uses last-non-undefined property precedence, object-literal flattening uses own-property precedence; nested children supply the final children property; effective keys, values, getters and child normalization not evaluated', node);
          property(owner, 'solid.dynamic-dispatch', 'effective component is removed from forwarded props; function selects component invocation, string selects intrinsic element, other types yield no rendered value; final component, branch, output and execution success unproven', node);
          if (duplicates.size) diagnose('solid.jsx-shape', 'Duplicate authored JSX attributes remain unsupported by the ordered Dynamic contract.', node);
        }
      }
      if (rule.name === 'Portal') { source(owner, prop('mount'), node); source(owner, prop('ref'), node); property(owner, 'solid.boundary', 'DOM relocation does not change owner ancestry', node); }
      if (['Suspense', 'SuspenseList', 'NoHydration', 'Hydration', 'HydrationScript'].includes(rule.name)) {
        property(owner, 'solid.boundary', `${rule.name} authored render boundary; no scheduling guarantee`, node);
        for (const name of ['fallback', 'revealOrder', 'tail']) source(owner, prop(name), node);
      }
    }
    if (tag.type === 'member_expression' && tag.fields.object && tag.fields.property && view.name(tag.fields.property) === 'Provider') {
      const context = handle(tag.fields.object);
      if (owner && context?.role === 'solid.context') {
        recordSpreads();
        budget.step(512);
        if (view.project(tag)) { source(owner, tag.fields.object, node, 'solid.provider-context'); source(owner, prop('value'), node); }
        else diagnose('solid.jsx-shape', 'Provider member identity is not proven after a receiver escape.', node);
      }
    }
    if (!/^[a-z][a-z0-9:_-]*$/.test(view.text(tag)) || !owner || !nativeContext(node)) continue;
    recordSpreads();
    if ([...superseded].some((name) => name === 'ref' || name === 'innerHTML' || name.startsWith('use:') || /^on(?::|capture:|[A-Za-z])/.test(name))) diagnose('solid.jsx-shape', 'Native JSX bindings before a spread or duplicate attribute are not proven.', node);
    for (const [name, attr] of attributes) {
      const value = attr.value;
      if (name.startsWith('use:')) {
        property(owner, 'solid.jsx-mode', 'native directive (element, value accessor)', attr.node);
        const directive = attr.node.children[0]?.children[1];
        source(owner, directive, attr.node, 'solid.jsx-binding'); source(owner, value, attr.node);
        callback(directive, attr.node, { index: 0, role: 'native directive', parameters: ['native element', 'directive value accessor'] });
      } else if (name === 'ref') {
        source(owner, value, attr.node, 'solid.jsx-binding');
        callback(value, attr.node, { index: 0, role: 'native ref callback', parameters: ['native element'] });
      } else if (name === 'innerHTML') {
        source(owner, value, attr.node, 'solid.jsx-binding'); property(owner, 'solid.jsx-mode', 'raw innerHTML assignment (not escaped text)', attr.node);
      } else if (/^on(?::|capture:|[A-Za-z])/.test(name) && value) {
        property(owner, 'solid.jsx-mode', name, attr.node);
        let target = value, data: SyntaxNode | undefined;
        const nativeName = name.startsWith('on:') || name.startsWith('oncapture:');
        if (view.unwrap(value).type === 'array') {
          const tuple = array(value);
          if (nativeName || tuple?.length !== 2) { diagnose('solid.jsx-shape', 'Native event tuple requires exactly [handler, data] on an ordinary onEvent attribute.', attr.node); continue; }
          target = tuple[0]!; data = tuple[1];
        } else if (name.startsWith('on:') && view.unwrap(value).type === 'object') {
          const listener = fields(value), fn = listener?.get('handleEvent');
          if (!fn) { diagnose('solid.jsx-shape', 'Native listener object requires explicit handleEvent and bounded options.', attr.node); continue; }
          target = fn; options(value, attr.node, ['capture', 'passive', 'once', 'signal']);
        } else if (view.unwrap(value).type === 'object') {
          diagnose('solid.jsx-shape', 'Listener option objects are supported only for explicit on: events.', attr.node); continue;
        }
        source(owner, target, attr.node, 'solid.event-handler'); source(owner, data, attr.node, 'solid.event-data');
        callback(target, attr.node, { index: 0, role: data ? 'bound native event handler' : 'native event handler', parameters: data ? ['bound data', 'native event'] : ['native event'] });
      }
    }
  }
  for (const node of view.nodes) {
    budget.step();
    if (node.type !== 'comment' || !/@once\b/.test(view.text(node))) continue;
    const expression = view.parent(node), owner = expression && view.owner(expression);
    if (expression?.type === 'jsx_expression' && owner && nativeContext(expression)) property(owner, 'solid.jsx-mode', '@once requested; compiler-transform dependent', expression);
  }
}
