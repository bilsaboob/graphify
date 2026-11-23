import type { AnnotationLimits, Reference } from '#core/wire';
import type { InitializerProjection, LexicalBinding, PatternProjection, PatternProjections, ProjectionKey, ReturnContract, ReturnShape, SyntaxNode, ValueProjection } from './types.js';
import { decodeString } from './values.js';

interface Observation { node: SyntaxNode; offset: number; delivery?: SyntaxNode }
interface Queries {
  text(node: SyntaxNode): string;
  name(node: SyntaxNode): string | undefined;
  unwrap(node: SyntaxNode): SyntaxNode;
  binding(node: SyntaxNode): LexicalBinding | undefined;
  resolve(node: SyntaxNode): Reference;
  source(key: string): InitializerProjection | undefined;
  elements(node: SyntaxNode): readonly (SyntaxNode | null)[];
  callForArguments(node: SyntaxNode): SyntaxNode | undefined;
  stableObject(node: SyntaxNode, observation?: SyntaxNode, offset?: number, delivery?: SyntaxNode, preservesIdentity?: (occurrence: SyntaxNode, jsxTag: boolean) => boolean): boolean;
  step(): boolean;
  limits: AnnotationLimits;
}

/** Queries have a small local budget in addition to construction/plugin work budgets. */
export function createProjectionQueries(query: Queries, supplied: readonly ReturnContract[] = []) {
  const { unwrap, text, name, limits } = query;
  const optional = (node: SyntaxNode) => node.tokens.includes('?.') || node.children.some(child => child.type === 'optional_chain');
  const maxWork = Math.min(limits.maxWork, 512), maxDepth = Math.min(limits.maxDepth, 24);
  const contracts = new Map<string, ReturnContract>();
  const namespaceCalls = new Map<string, ReadonlySet<number>>();
  const ids = new Set<string>();
  let metadataWork = 0;
  const shape = (value: ReturnShape, depth: number): ReturnShape => {
    if (++metadataWork > 2048 || depth > 24) throw new Error('Return contract metadata limit exceeded');
    if (value.kind === 'value') return Object.freeze({ kind: 'value' });
    if (value.kind === 'record') return Object.freeze({ kind: 'record', value: shape(value.value, depth + 1) });
    if (value.kind === 'tuple' && value.items.length <= 64) return Object.freeze({ kind: 'tuple', items: Object.freeze(value.items.map((item) => shape(item, depth + 1))) });
    if (value.kind === 'object' && Object.keys(value.properties).length <= 64) {
      const properties: Record<string, ReturnShape> = Object.create(null);
      for (const [key, item] of Object.entries(value.properties)) {
        if (key.length > limits.maxValueBytes) throw new Error('Return contract key limit exceeded');
        properties[key] = shape(item, depth + 1);
      }
      return Object.freeze({ kind: 'object', properties: Object.freeze(properties) });
    }
    if (value.kind === 'key-partitions' && depth === 0 && Number.isSafeInteger(value.sourceArgument) && value.sourceArgument >= 0 && Number.isSafeInteger(value.keysFromArgument) && value.keysFromArgument > value.sourceArgument && value.keysFromArgument <= 16) return Object.freeze({ ...value });
    throw new Error('Invalid return contract shape');
  };
  const observations = (value: NonNullable<ReturnContract['identityObservations']>): NonNullable<ReturnContract['identityObservations']> => {
    const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 16 && !Object.is(n, -0);
    const member = (name: string) => /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name);
    const fields = (item: object, names: readonly string[]) => Object.keys(item).length === names.length && Object.keys(item).every(key => names.includes(key));
    const step = () => { if (++metadataWork > 2048) throw new Error('Return contract metadata limit exceeded'); };
    if (!fields(value, ['factoryArities', 'uses']) || value.factoryArities.length < 1 || value.factoryArities.length > 16 || value.uses.length < 1 || value.uses.length > 16 || new Set(value.factoryArities).size !== value.factoryArities.length || !value.factoryArities.every(integer)) throw new Error('Invalid handle identity observations');
    const factoryArities = Object.freeze(value.factoryArities.map(arity => { step(); return arity; }));
    const seen = new Set<string>();
    const uses = value.uses.map(use => {
      step();
      if (use.kind === 'receiver-call' && fields(use, ['kind', 'member', 'arity']) && member(use.member) && integer(use.arity)) return Object.freeze({ ...use });
      if (use.kind === 'jsx-member' && fields(use, ['kind', 'member']) && member(use.member)) return Object.freeze({ ...use });
      if (use.kind === 'call-argument' && fields(use, ['kind', 'origins', 'index', 'arity']) && integer(use.index) && integer(use.arity) && use.index < use.arity && use.origins.length > 0 && use.origins.length <= 16) {
        const origins = use.origins.map(origin => {
          step();
          if (!fields(origin, ['module', 'name']) || !origin.module || !member(origin.name) || origin.module.length > 4096 || origin.module.startsWith('.') || origin.module.startsWith('/') || origin.module.includes('\\')) throw new Error('Invalid identity consumer origin');
          return Object.freeze({ ...origin });
        });
        if (new Set(origins.map(origin => JSON.stringify(origin))).size !== origins.length) throw new Error('Duplicate identity consumer origin');
        return Object.freeze({ ...use, origins: Object.freeze(origins) });
      }
      throw new Error('Invalid handle identity use');
    });
    for (const use of uses) { const key = JSON.stringify(use); if (seen.has(key)) throw new Error('Duplicate handle identity use'); seen.add(key); }
    return Object.freeze({ factoryArities, uses: Object.freeze(uses) });
  };
  if (supplied.length > 128) throw new Error('Return contract count limit exceeded');
  for (const contract of supplied) {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(contract.id) || ids.has(contract.id) || contract.origins.length < 1 || contract.origins.length > 16) throw new Error('Invalid return contract identity');
    if (contract.invocation !== undefined && !['call', 'construct'].includes(contract.invocation)) throw new Error('Invalid return contract invocation');
    ids.add(contract.id);
    const result = shape(contract.result, 0);
    const identityObservations = contract.identityObservations && observations(contract.identityObservations);
    const namespaceCall = (module: string, name: string, arities: readonly number[]) => {
      const key = JSON.stringify([module, name]);
      namespaceCalls.set(key, new Set([...(namespaceCalls.get(key) ?? []), ...arities]));
    };
    if (identityObservations) {
      if (contract.invocation !== 'construct') for (const origin of contract.origins) namespaceCall(origin.module, origin.name, identityObservations.factoryArities);
      for (const use of identityObservations.uses) if (use.kind === 'call-argument') for (const origin of use.origins) namespaceCall(origin.module, origin.name, [use.arity]);
    }
    for (const origin of contract.origins) {
      if (++metadataWork > 2048 || !origin.module || !origin.name || origin.module.length + origin.name.length > 4096 || origin.module.startsWith('.') || origin.module.startsWith('/') || origin.module.includes('\\')) throw new Error('Invalid return contract origin');
      const key = JSON.stringify([contract.invocation ?? 'call', origin.module, origin.name]);
      if (contracts.has(key)) throw new Error('Conflicting return contract origins');
      contracts.set(key, Object.freeze({ id: contract.id, origins: Object.freeze([]), result, ...(identityObservations ? { identityObservations } : {}) }));
    }
  }
  const hasIdentityObservations = [...contracts.values()].some(contract => contract.identityObservations);
  const staticKey = (node: SyntaxNode): ProjectionKey | undefined => {
    if (node.type === 'computed_property_name') {
      const value = node.children[0] && unwrap(node.children[0]);
      return value && ['string', 'number'].includes(value.type) ? staticKey(value) : undefined;
    }
    if (node.type === 'number') {
      const value = Number(text(node).replaceAll('_', ''));
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    }
    const value = name(node);
    return value !== undefined && value.length * 3 <= limits.maxValueBytes ? value : undefined;
  };
  const patternProjections = (input: SyntaxNode): PatternProjections => {
    const projections: PatternProjection[] = [];
    let work = 0, complete = true;
    const visit = (node: SyntaxNode, path: readonly ProjectionKey[], depth: number) => {
      if (++work > maxWork || depth > maxDepth || !query.step()) { complete = false; return; }
      if (['identifier', 'undefined', 'shorthand_property_identifier_pattern'].includes(node.type)) {
        projections.push(Object.freeze({ node, path: Object.freeze([...path]) })); return;
      }
      if (node.type === 'required_parameter') {
        const pattern = node.fields.pattern ?? node.fields.name;
        if (!pattern || node.fields.value) { complete = false; return; }
        visit(pattern, path, depth + 1); return;
      }
      if (node.type === 'array_pattern') {
        const elements = query.elements(node);
        for (let index = 0; index < elements.length; index++) {
          if (++work > maxWork || !query.step()) { complete = false; break; }
          const item = elements[index];
          if (item) visit(item, [...path, index], depth + 1);
        }
        return;
      }
      if (node.type === 'object_pattern') {
        for (const item of node.children) {
          if (++work > maxWork || !query.step()) { complete = false; break; }
          if (item.type === 'comment') continue;
          if (item.type === 'shorthand_property_identifier_pattern') {
            const key = staticKey(item);
            if (key === undefined) complete = false;
            else visit(item, [...path, key], depth + 1);
          } else if (item.type === 'pair_pattern' && item.fields.key && item.fields.value) {
            const key = staticKey(item.fields.key);
            if (key === undefined) complete = false;
            else visit(item.fields.value, [...path, key], depth + 1);
          } else complete = false;
        }
        return;
      }
      complete = false;
    };
    visit(unwrap(input), [], 0);
    return Object.freeze({ complete, projections: Object.freeze(projections) });
  };
  const observe = (node: SyntaxNode, timing: 'start' | 'before-call' = 'start'): Observation => timing === 'start'
    ? { node, offset: node.startIndex }
    : { node, offset: Math.max(node.startIndex, (node.fields.arguments ?? node).endIndex - 1), delivery: node.fields.arguments ?? node };
  const project = (input: SyntaxNode, inputPath: readonly ProjectionKey[] = [], referenceObservation?: Observation): ValueProjection | undefined => {
    let work = 0;
    const active = new Set<SyntaxNode>();
    const step = (depth: number) => ++work <= maxWork && depth <= maxDepth && query.step();
    const args = (node: SyntaxNode) => {
      const values = node.fields.arguments?.children.filter(item => item.type !== 'comment');
      return values && values.length <= 16 && !values.some(item => item.type === 'spread_element') ? values : undefined;
    };
    const canonicalImport = (inputNode: SyntaxNode, observation: Observation, depth: number): Extract<Reference, { kind: 'import' }> | undefined => {
      const origin = query.resolve(inputNode);
      if (origin.kind !== 'import' || origin.member || origin.name === '*') return undefined;
      const namespace = (input: SyntaxNode, depth: number): string | undefined => {
        if (!step(depth)) return undefined;
        const node = unwrap(input), binding = query.binding(node);
        if (node.type !== 'identifier' || !binding?.stable || !binding.available || binding.typeOnly) return undefined;
        if (binding.origin?.name === '*') return binding.origin.module;
        const source = binding.declaration ? query.source(binding.declaration) : undefined;
        return binding.kind === 'const' && source?.complete && !source.path.length ? namespace(source.initializer, depth + 1) : undefined;
      };
      const stable = (input: SyntaxNode, depth: number): boolean => {
        if (!step(depth)) return false;
        const node = unwrap(input);
        if (node.type === 'member_expression' && !optional(node) && node.fields.object && node.fields.property) return stable(node.fields.object, depth + 1);
        const binding = query.binding(node);
        if (!binding?.available || !binding.stable || binding.typeOnly) return false;
        const module = namespace(node, depth + 1);
        // These exact functions do not mutate their canonical module receiver.
        // This does not make other namespace calls or passed arguments safe.
        const preservesNamespace = module ? (occurrence: SyntaxNode, jsxTag: boolean) => {
          if (!step(depth + 1) || jsxTag || occurrence.type !== 'call_expression' || optional(occurrence)) return false;
          const fn = occurrence.fields.function && unwrap(occurrence.fields.function), arguments_ = args(occurrence);
          if (fn?.type !== 'member_expression' || optional(fn) || !fn.fields.object || !fn.fields.property || !arguments_ || namespace(fn.fields.object, depth + 1) !== module) return false;
          const member = name(fn.fields.property);
          return !!member && !!namespaceCalls.get(JSON.stringify([module, member]))?.has(arguments_.length);
        } : undefined;
        if (!query.stableObject(node, observation.node, observation.offset, observation.delivery, preservesNamespace)) return false;
        if (binding.origin) return true;
        const source = binding.declaration ? query.source(binding.declaration) : undefined;
        return binding.kind === 'const' && !!source?.complete && stable(source.initializer, depth + 1);
      };
      return stable(inputNode, depth) ? origin : undefined;
    };
    // This is only a candidate identity. The ordinary projection traversal still
    // checks every alias for writes and every non-reviewed escape at observation.
    const handleIdentity = (inputNode: SyntaxNode, observation: Observation, depth: number): { contract: ReturnContract; factory: SyntaxNode } | undefined => {
      if (!step(depth)) return undefined;
      const node = unwrap(inputNode), binding = query.binding(node);
      if (node.type === 'identifier' && binding?.kind === 'const' && binding.available && binding.stable && !binding.typeOnly) {
        const source = binding.declaration ? query.source(binding.declaration) : undefined;
        return source?.complete && !source.path.length ? handleIdentity(source.initializer, observation, depth + 1) : undefined;
      }
      const callee = node.type === 'new_expression' ? node.fields.constructor : node.type === 'call_expression' ? node.fields.function : undefined;
      if (!callee || optional(node) || optional(unwrap(callee))) return undefined;
      const origin = canonicalImport(callee, observation, depth + 1), arguments_ = args(node);
      const contract = origin && contracts.get(JSON.stringify([node.type === 'new_expression' ? 'construct' : 'call', origin.module, origin.name]));
      return contract?.identityObservations && arguments_ && contract.identityObservations.factoryArities.includes(arguments_.length) ? { contract, factory: node } : undefined;
    };
    const preservesIdentity = (node: SyntaxNode, observation: Observation, depth: number): ((occurrence: SyntaxNode, jsxTag: boolean) => boolean) | undefined => {
      if (!hasIdentityObservations) return undefined;
      const identity = handleIdentity(node, observation, depth + 1);
      if (!identity) return undefined;
      const sameHandle = (input: SyntaxNode) => {
        const candidate = handleIdentity(input, observation, depth + 1);
        return candidate?.factory === identity.factory && candidate.contract.id === identity.contract.id;
      };
      return (occurrence, jsxTag) => {
        if (!step(depth + 1)) return false;
        for (const use of identity.contract.identityObservations!.uses) {
          if (!step(depth + 1)) return false;
          if (use.kind === 'receiver-call' && occurrence.type === 'call_expression' && !optional(occurrence)) {
            const fn = occurrence.fields.function && unwrap(occurrence.fields.function), arguments_ = args(occurrence);
            if (fn?.type === 'member_expression' && !optional(fn) && fn.fields.object && fn.fields.property && name(fn.fields.property) === use.member && arguments_?.length === use.arity && sameHandle(fn.fields.object)) return true;
          }
          if (use.kind === 'call-argument' && occurrence.type === 'arguments') {
            // The normalized arguments node has no parent capability. Its call
            // is supplied by the view alongside the exact argument occurrence.
            const call = query.callForArguments(occurrence);
            const arguments_ = call && args(call), argument = arguments_?.[use.index];
            if (!call?.fields.function || optional(call) || arguments_?.length !== use.arity || !argument || !sameHandle(argument)) continue;
            const origin = canonicalImport(call.fields.function, observe(call, 'before-call'), depth + 1);
            if (origin && use.origins.some(expected => expected.module === origin.module && expected.name === origin.name)) return true;
          }
          if (use.kind === 'jsx-member' && jsxTag && ['jsx_opening_element', 'jsx_self_closing_element'].includes(occurrence.type)) {
            const tag = occurrence.fields.name;
            if (tag?.type === 'member_expression' && !optional(tag) && tag.fields.object && tag.fields.property && name(tag.fields.property) === use.member && sameHandle(tag.fields.object)) return true;
          }
        }
        return false;
      };
    };
    const result = (initializer: SyntaxNode, path: readonly ProjectionKey[], extra: Pick<ValueProjection, 'contract' | 'partitions'> = {}): ValueProjection => Object.freeze({ initializer, path: Object.freeze([...path]), complete: true, ...extra });
    const followsShape = (value: ReturnShape, path: readonly ProjectionKey[], depth: number): boolean => {
      if (!step(depth)) return false;
      if (!path.length) return true;
      const key = path[0]!;
      if (value.kind === 'record') return String(key).length * 3 <= limits.maxValueBytes && followsShape(value.value, path.slice(1), depth + 1);
      if (value.kind === 'tuple') {
        const index = typeof key === 'number' ? key : /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
        const child = value.items[index];
        return !!child && followsShape(child, path.slice(1), depth + 1);
      }
      if (value.kind === 'object') {
        const child = Object.hasOwn(value.properties, String(key)) ? value.properties[String(key)] : undefined;
        return !!child && followsShape(child, path.slice(1), depth + 1);
      }
      return false;
    };
    const visit = (inputNode: SyntaxNode, path: readonly ProjectionKey[], depth: number, observedAt: Observation): ValueProjection | undefined => {
      if (!step(depth) || path.length > maxDepth) return undefined;
      const node = unwrap(inputNode);
      const observation = node.startIndex > observedAt.offset ? observe(node) : observedAt;
      if (active.has(node)) return undefined;
      active.add(node);
      try {
        if (['identifier', 'undefined', 'shorthand_property_identifier'].includes(node.type)) {
          const binding = query.binding(node);
          if (binding) {
            if (!binding.available || binding.typeOnly || !binding.stable) return undefined;
            const preserves = (path.length || referenceObservation) ? preservesIdentity(node, observation, depth) : undefined;
            if (referenceObservation && !query.stableObject(node, observation.node, observation.offset, observation.delivery, preserves)) return undefined;
            const source = binding.declaration && query.source(binding.declaration);
            if (source) {
              if (!source.complete || ((path.length > 0 || referenceObservation) && !query.stableObject(node, observation.node, observation.offset, observation.delivery, preserves))) return undefined;
              // Pending property reads observe the reference now; an already-bound
              // scalar/callable was captured when its initializer ran.
              return visit(source.initializer, [...source.path, ...path], depth + 1, path.length || referenceObservation ? observation : observe(source.initializer));
            }
            if (binding.initializer && binding.kind === 'const') return visit(binding.initializer, path, depth + 1, path.length || referenceObservation ? observation : observe(binding.initializer));
            if (path.length && binding.origin?.name === '*' && path.length === 1 && typeof path[0] === 'string') return result(node, path);
          }
          return path.length ? undefined : result(node, path);
        }
        if (node.type === 'member_expression' && !optional(node) && node.fields.object && node.fields.property) {
          const key = staticKey(node.fields.property);
          return key === undefined ? undefined : visit(node.fields.object, [key, ...path], depth + 1, observation);
        }
        if (node.type === 'subscript_expression' && !optional(node) && node.fields.object && node.fields.index) {
          const key = staticKey(unwrap(node.fields.index));
          if (!['string', 'number'].includes(unwrap(node.fields.index).type)) return undefined;
          return key === undefined ? undefined : visit(node.fields.object, [key, ...path], depth + 1, observation);
        }
        const callee = node.type === 'new_expression' ? node.fields.constructor : node.fields.function;
        if (['call_expression', 'new_expression'].includes(node.type) && callee && !optional(node) && !optional(unwrap(callee))) {
          const origin = query.resolve(callee);
          const contract = origin.kind === 'import' && !origin.member ? contracts.get(JSON.stringify([node.type === 'new_expression' ? 'construct' : 'call', origin.module, origin.name])) : undefined;
          if (!contract) return path.length ? undefined : result(node, path);
          if (contract.identityObservations && !handleIdentity(node, observation, depth + 1)) return path.length ? undefined : result(node, path);
          // Construction depends on a still-proven prototype as well as callable identity.
          if (node.type === 'new_expression') {
            const constructed = observe(node, 'before-call');
            if (!project(callee, [], constructed.offset > observation.offset ? constructed : observation)) return undefined;
          }
          if ((node.fields.arguments?.children.length ?? 0) > maxWork) return undefined;
          const args = node.fields.arguments?.children.filter((item) => item.type !== 'comment') ?? [];
          if (args.some((item) => item.type === 'spread_element')) return undefined;
          if (contract.result.kind !== 'key-partitions') return followsShape(contract.result, path, depth + 1) ? result(node, path, { contract: contract.id }) : undefined;
          const source = args[contract.result.sourceArgument], groups = args.slice(contract.result.keysFromArgument);
          if (!source || groups.length > 16) return undefined;
          const claimed = new Set<string>(), keys: (readonly string[])[] = [];
          let keyBytes = 0;
          for (const group of groups) {
            if (!step(depth + 1)) return undefined;
            const literal = unwrap(group);
            if (literal.type !== 'array') return undefined;
            if (query.elements(literal).length > 64) return undefined;
            const values: string[] = [];
            for (const element of query.elements(literal)) {
              if (!step(depth + 1) || !element) return undefined;
              const keyNode = unwrap(element);
              const key = keyNode.type === 'string' ? decodeString(text(keyNode)) : undefined;
              if (key === undefined) return undefined;
              keyBytes += key.length * 3;
              if (claimed.has(key) || claimed.size >= 64 || keyBytes > limits.maxValueBytes) return undefined;
              claimed.add(key); values.push(key);
            }
            keys.push(Object.freeze(values));
          }
          if (path.length) {
            const index = typeof path[0] === 'number' ? path[0] : /^(0|[1-9][0-9]*)$/.test(path[0]!) ? Number(path[0]) : -1;
            if (index < 0 || index > keys.length || path.length > 2) return undefined;
            if (path.length === 2 && (index === keys.length ? claimed.has(String(path[1])) : !keys[index]!.includes(String(path[1])))) return undefined;
          }
          return result(node, path, { contract: contract.id, partitions: Object.freeze({ source, keys: Object.freeze(keys) }) });
        }
        if (!path.length) return result(node, path);
        const key = path[0]!;
        if (node.type === 'array') {
          const items = query.elements(node);
          if (items.length > maxWork) return undefined;
          if (items.some((item) => item?.type === 'spread_element')) return undefined;
          const index = typeof key === 'number' ? key : /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
          const item = items[index];
          return item ? visit(item, path.slice(1), depth + 1, path.length > 1 || referenceObservation ? observation : observe(item)) : undefined;
        }
        if (node.type === 'object') {
          let selected: ValueProjection | undefined;
          for (const item of node.children) {
            if (!step(depth + 1)) return undefined;
            if (item.type === 'comment') continue;
            if (item.type === 'spread_element') {
              const value = item.children.find((child) => child.type !== 'comment');
              // A later authored own property wins even over unknown spread keys.
              selected = value ? visit(value, path, depth + 1, observation) : undefined;
              continue;
            }
            if (item.type === 'shorthand_property_identifier') {
              if (name(item) === String(key)) selected = visit(item, path.slice(1), depth + 1, path.length > 1 || referenceObservation ? observation : observe(item));
              continue;
            }
            if (item.type !== 'pair' || !item.fields.key || !item.fields.value) { selected = undefined; continue; }
            const property = staticKey(item.fields.key);
            if (property === '__proto__') return undefined;
            if (property === undefined) selected = undefined;
            else if (String(property) === String(key)) selected = visit(item.fields.value, path.slice(1), depth + 1, path.length > 1 || referenceObservation ? observation : observe(item.fields.value));
          }
          return selected;
        }
        return undefined;
      } finally { active.delete(node); }
    };
    return visit(input, inputPath, 0, referenceObservation ?? observe(input));
  };
  const referenceStable = (input: SyntaxNode, observation: SyntaxNode, timing: 'start' | 'before-call' = 'start'): boolean => {
    const value = project(input, [], observe(observation, timing));
    if (!value || value.path.length) return false;
    const node = value.initializer;
    if (['identifier', 'undefined', 'shorthand_property_identifier'].includes(node.type)) return !!query.binding(node)?.available;
    if (['call_expression', 'new_expression'].includes(node.type)) return !!value.contract;
    return ['object', 'array', 'string', 'number', 'true', 'false', 'null', 'arrow_function', 'function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration', 'method_definition'].includes(node.type);
  };
  return { patternProjections, project, referenceStable };
}
