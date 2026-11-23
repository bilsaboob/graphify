import type { AnnotationPlugin } from '#core';
import { canonicalJSON, type AnnotationDiagnostic, type FactEvidence, type Reference } from '#core/wire';
import type { ProjectionKey, SyntaxNode, TypeScriptView, ValueProjection } from '#typescript';
import { calls, componentsApi, constructors, memberContract, type CallContract } from './components-contracts.js';
import { componentsDescriptor, type FstComponentsProperty, type FstComponentsRelation, type FstComponentsRole } from './components-vocabulary.js';
export { fstComponentsReturnContracts } from './components-contracts.js';
export type { FstComponentsProperty, FstComponentsRelation, FstComponentsRole } from './components-vocabulary.js';

interface Identity { kind: string; origin: SyntaxNode; method?: string }
interface Invocation { name: string; contract: CallContract; target: SyntaxNode; receiver?: Identity }
const functions = new Set(['arrow_function', 'function_expression', 'function_declaration']);
const key = (node: SyntaxNode) => `${node.startIndex}:${node.endIndex}`;
const controls: Readonly<Record<string, [string, string, string]>> = {
  TextBox: ['value', 'onInput', 'string'], TextArea: ['value', 'onInput', 'string'],
  Checkbox: ['checked', 'onChange', 'boolean'], CheckboxItem: ['checked', 'onChange', 'boolean'],
  Switch: ['checked', 'onChange', 'boolean'], SwitchItem: ['checked', 'onChange', 'boolean'],
  Slider: ['value', 'onInput', 'number'], Select: ['value', 'onChange', 'NonNullable<T extends string|number>'], SelectItem: ['value', 'onChange', 'NonNullable<T extends string|number>'],
  ColorEditor: ['value', 'onInput', 'normalized-hex-string'], MarkdownEditor: ['value', 'onInput', 'string'],
};
const jsxNames = new Set([...Object.keys(controls), 'SelectOption', 'ContextMenu', 'Popover', 'ModalHost', 'ToastHost', 'SvgIcon', 'Icon', 'Canvas3d', 'Scene', 'SceneGraphCanvas', 'SceneGraphHtmlSceneOverlayHost']);

/** Public consumer contracts only. No UI/runtime imports, loader execution or
 * cross-file type inference. Every operation retains its own source occurrence. */
export function createFstComponentsPlugin(digests: { implementationDigest: string; configurationDigest: string }): AnnotationPlugin<TypeScriptView> {
  return {
    descriptor: componentsDescriptor(digests),
    analyze({ view, budget }, emitter) {
      if (['truncated', 'unsupported', 'failed'].includes(view.state)) return { state: view.state };
      const diagnostics: AnnotationDiagnostic[] = [];
      let matched = false, partial = false;
      const diagnose = (code: string, message: string, node: SyntaxNode) => {
        partial = true;
        if (diagnostics.length < 8 && !diagnostics.some((item) => item.code === code)) diagnostics.push({ code, message, span: view.span(node) });
      };
      const bounded = (value: unknown) => {
        let bytes = 0;
        for (const point of canonicalJSON(value)) { const n = point.codePointAt(0)!; bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; }
        return bytes <= view.limits.maxValueBytes;
      };
      const evidence = (node: SyntaxNode, ruleId: string): Omit<FactEvidence, 'pluginId'> => ({ ruleId, basis: 'import-bound', span: view.span(node) });
      const role = (term: FstComponentsRole, node: SyntaxNode) => {
        budget.step(); const owner = view.owner(node); if (!owner) return;
        matched = true; emitter.role(owner.key, term, evidence(node, 'public-contract'));
      };
      const property = (term: FstComponentsProperty, value: string, node: SyntaxNode, resolution: 'literal' | 'constant' = 'literal') => {
        budget.step(); const owner = view.owner(node); if (!owner) return;
        if (!bounded({ kind: 'string', value }) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || [...value].some((point) => { const n = point.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) {
          diagnose('fst-components.value-limit', 'Contract text exceeds the bounded wire value contract.', node); return;
        }
        matched = true; emitter.property(owner.key, term, resolution, { kind: 'string', value }, evidence(node, 'public-contract'));
      };
      const relation = (term: FstComponentsRelation, target: Reference, node: SyntaxNode) => {
        budget.step(); const owner = view.owner(node); if (!owner) return;
        if (!bounded(target)) { diagnose('fst-components.reference-limit', 'Source reference exceeds the bounded wire value size.', node); return; }
        matched = true; emitter.relation(owner.key, term, target, evidence(node, 'public-contract'));
      };
      const api = (node: SyntaxNode | undefined) => {
        if (!node) return undefined;
        const origin = view.resolve(node);
        return origin.kind === 'import' && !origin.member ? componentsApi(origin.module, origin.name) : undefined;
      };
      const argsOf = (node: SyntaxNode) => node.fields.arguments?.children.filter((child) => child.type !== 'comment') ?? [];
      const access = (node: SyntaxNode) => {
        node = view.unwrap(node);
        if (node.type !== 'member_expression' || node.tokens.includes('?.') || !node.fields.object || !node.fields.property) return undefined;
        const name = view.name(node.fields.property);
        return name ? { object: node.fields.object, name } : undefined;
      };
      const jsx: { node: SyntaxNode; name: string; tag: SyntaxNode }[] = [];
      const callNodes: SyntaxNode[] = [];
      let relevant = false;
      for (const node of view.nodes) {
        budget.step();
        if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
          const tag = node.fields.name, name = api(tag);
          if (tag && name) { jsx.push({ node, name, tag }); relevant = true; }
        }
        if (node.type === 'call_expression' || node.type === 'new_expression') {
          callNodes.push(node);
          if (api(node.fields.function ?? node.fields.constructor)) relevant = true;
        }
      }
      // No whole-declaration projection scan: ordinary scalar constants are cheap.
      if (!relevant) return { state: 'not-applicable' };

      const projections = new Map<string, ValueProjection | undefined>();
      const project = (node: SyntaxNode, path: readonly ProjectionKey[] = []) => {
        const cacheKey = `${key(node)}:${JSON.stringify(path)}`;
        if (projections.has(cacheKey)) return projections.get(cacheKey);
        budget.step(512);
        const result = view.project(node, path); projections.set(cacheKey, result); return result;
      };
      const parameterKinds = new Map<string, Identity>();
      const unsafe = new Set<string>();
      const unsafeFactories = new Set<string>();
      const escapedImports = new Set<string>();
      const constructorEscaped = (node: SyntaxNode | undefined) => {
        budget.step(); if (!node) return false;
        const origin = view.resolve(node);
        return origin.kind === 'import' && (escapedImports.has(JSON.stringify([origin.module, origin.name])) || escapedImports.has(JSON.stringify([origin.module, '*'])));
      };
      let receiverProofsLimited = false;
      const taint = (input: SyntaxNode, seen = new Set<string>()) => {
        budget.step();
        if (seen.has(key(input))) return;
        if (seen.size >= 32) { receiverProofsLimited = true; diagnose('fst-components.call-shape', 'Receiver escape analysis exceeded the bounded syntax shape; receiver operations are omitted.', input); return; }
        const node = view.unwrap(input);
        if ((node.type.endsWith('_pattern') && node.children.length > 0) || ['object', 'array', 'spread_element', 'pair', 'arrow_function', 'function_expression', 'function_declaration', 'method_definition', 'statement_block', 'return_statement', 'ternary_expression', 'binary_expression', 'sequence_expression', 'await_expression', 'yield_expression', 'template_substitution', 'jsx_expression'].includes(node.type)) {
          seen.add(key(input));
          // Assignment targets are syntax, not the supported subset of binding projections.
          const selected = ['pair', 'pair_pattern'].includes(node.type) ? node.fields.value : ['assignment_pattern', 'object_assignment_pattern'].includes(node.type) ? node.fields.left : undefined;
          for (const child of selected ? [selected] : node.children) taint(child, seen);
          return;
        }
        if (['member_expression', 'subscript_expression'].includes(node.type) && node.fields.object) {
          seen.add(key(input)); taint(node.fields.object, seen);
          return;
        }
        const binding = view.binding(node);
        if (!binding || seen.has(key(binding.node))) return;
        if (binding.origin) escapedImports.add(JSON.stringify([binding.origin.module, binding.origin.name]));
        const projected = project(node);
        if (projected?.contract?.startsWith('fst-components.')) unsafeFactories.add(key(projected.initializer));
        seen.add(key(binding.node)); unsafe.add(key(binding.node));
        if (binding.kind === 'const' && binding.initializer) taint(binding.initializer, seen);
        else if (binding.kind === 'const' && binding.declaration) {
          budget.step(512); const source = view.initializerProjection(binding.declaration);
          if (source) taint(source.initializer, seen);
        }
        else if (binding.kind === 'function' && binding.declaration) {
          const fn = view.declarationNode(binding.declaration);
          if (fn?.fields.body) taint(fn.fields.body, seen);
        }
      };
      for (const node of view.nodes) {
        budget.step();
        if ((node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') && !jsxNames.has(api(node.fields.name) ?? '')) {
          // Foreign components can synchronously inspect props, spreads and children.
          for (const child of node.children) {
            if (child.type === 'jsx_attribute' && child.children[1]) taint(child.children[1]);
            if (child.type === 'jsx_expression') taint(child);
          }
          const element = view.parent(node);
          if (element?.type === 'jsx_element') for (const child of element.children) if (child.type === 'jsx_expression') taint(child);
        }
        if (node.type === 'return_statement' || node.type === 'yield_expression') for (const child of node.children) taint(child);
        if (node.type === 'public_field_definition' && node.fields.value) taint(node.fields.value);
        if (node.type === 'arrow_function' && node.fields.body && node.fields.body.type !== 'statement_block') taint(node.fields.body);
        if (['assignment_expression', 'augmented_assignment_expression', 'update_expression', 'for_in_statement'].includes(node.type) || (node.type === 'unary_expression' && node.tokens.includes('delete'))) {
          const left = node.fields.left ?? node.fields.argument;
          if (left) taint(left);
          if (node.fields.right) taint(node.fields.right);
        }
      }
      const memberIdentity = (identity: Identity, name: string): Identity | undefined => {
        if (identity.method) return undefined;
        if (identity.kind === 'setup-payload' && name === 'scene') return { ...identity, kind: 'scene' };
        if (identity.kind === 'setup-payload' && name === 'invalidateRender') return { ...identity, kind: 'invalidate' };
        if (identity.kind === 'modal-payload' && name === 'close') return { ...identity, kind: 'modal-close' };
        if (identity.kind === 'mesh' && name === 'animation') return { ...identity, kind: 'animation' };
        if (identity.kind === 'scene' && name === 'assets') return { ...identity, kind: 'assets-manager' };
        return memberContract(identity.kind, name) ? { ...identity, method: name } : undefined;
      };
      const identity = (input: SyntaxNode, depth = 0, seen = new Set<string>()): Identity | undefined => {
        budget.step(); if (receiverProofsLimited || depth > 16 || seen.has(key(input))) return undefined;
        seen = new Set(seen); seen.add(key(input));
        const node = view.unwrap(input), binding = view.binding(node);
        if (binding) {
          if (!binding.available || binding.typeOnly || unsafe.has(key(binding.node))) return undefined;
          if (binding.kind === 'parameter') return parameterKinds.get(key(binding.node));
          if (!binding.stable || binding.kind !== 'const') return undefined;
          // Generic projections retain the use-site mutation/escape checks for
          // destructured methods and aliases of public object return contracts.
          const projected = project(node);
          if (projected?.contract?.startsWith('fst-components.')) {
            if (unsafeFactories.has(key(projected.initializer))) return undefined;
            const name = api(projected.initializer.fields.function ?? projected.initializer.fields.constructor);
            const handle = name && (projected.initializer.type === 'new_expression' ? constructors[name] : calls[name])?.handle;
            if (!handle) return undefined;
            let result: Identity | undefined = { kind: handle, origin: projected.initializer };
            for (const part of projected.path) { if (!result || typeof part !== 'string') return undefined; result = memberIdentity(result, part); }
            // A captured method is a value snapshot; an instance still depends on
            // the constructor/prototype not escaping before this later request.
            if (!result?.method && projected.initializer.type === 'new_expression' && constructorEscaped(projected.initializer.fields.constructor)) return undefined;
            return result;
          }
          if (binding.initializer) return identity(binding.initializer, depth + 1, seen);
          return undefined;
        }
        const member = access(node);
        if (member) {
          const base = identity(member.object, depth + 1, seen);
          if (!base) return undefined;
          // Only the reviewed direct method calls preserve these method identities.
          // Captured method aliases still require the generic observed-use proof.
          let at = node, parent = view.parent(at);
          while (parent?.type === 'member_expression' && parent.fields.object === at) { budget.step(); at = parent; parent = view.parent(at); }
          const direct = parent?.type === 'call_expression' && parent.fields.function === at;
          const root = project(member.object);
          if (!direct && root?.contract?.startsWith('fst-components.') && !project(member.object, [member.name])) return undefined;
          return memberIdentity(base, member.name);
        }
        if (node.type === 'new_expression') {
          const name = api(node.fields.constructor), handle = name && constructors[name]?.handle;
          return handle && !constructorEscaped(node.fields.constructor) && project(node)?.contract?.startsWith('fst-components.construct.') ? { kind: handle, origin: node } : undefined;
        }
        if (node.type === 'call_expression' && !node.tokens.includes('?.')) {
          if (argsOf(node).some((arg) => arg.type === 'spread_element')) return undefined;
          const invocation = invoke(node, depth + 1, seen);
          if (invocation?.contract.handle) return { kind: invocation.contract.handle, origin: node };
          if (invocation?.receiver?.kind === 'scene' && invocation.name === 'add' && argsOf(node)[0]) return identity(argsOf(node)[0]!, depth + 1, seen);
        }
        return undefined;
      };
      const invoke = (node: SyntaxNode, depth = 0, seen = new Set<string>()): Invocation | undefined => {
        budget.step(); if (depth > 16 || node.tokens.includes('?.')) return undefined;
        const fn = node.fields.function ?? node.fields.constructor;
        if (!fn) return undefined;
        const name = api(fn), contract = name && (node.type === 'new_expression' ? constructors[name] : calls[name]);
        if (name && contract) return { name, contract, target: fn };
        if (node.type !== 'call_expression') return undefined;
        const handle = identity(fn, depth + 1, seen);
        if (!handle) return undefined;
        if (handle.method) {
          const contract = memberContract(handle.kind, handle.method);
          return contract ? { name: handle.method, contract, target: access(fn)?.object ?? fn, receiver: handle } : undefined;
        }
        const result = handle.kind === 'loader' ? 'Promise<results[]>;argument-length-list' : ['modal-close', 'toast-handle', 'disposer', 'invalidate'].includes(handle.kind) ? 'void;requested-operation-only' : undefined;
        return result ? { name: handle.kind === 'invalidate' ? 'invalidateRender' : handle.kind === 'loader' ? 'load-results' : handle.kind === 'modal-close' ? 'close' : handle.kind === 'toast-handle' ? 'dismiss' : 'dispose', contract: { role: 'handle', result }, target: fn, receiver: handle } : undefined;
      };
      const literal = (input: SyntaxNode, anchor: SyntaxNode, name: string) => {
        const node = view.unwrap(input);
        if (!['identifier', 'string', 'number', 'true', 'false', 'null', 'template_string', 'binary_expression', 'unary_expression'].includes(node.type)) return;
        budget.step(['string', 'number', 'true', 'false', 'null'].includes(node.type) ? 8 : 512);
        const result = view.constant(input);
        if (result.known && (result.value === null || ['string', 'number', 'boolean'].includes(typeof result.value))) property('fst-components.literal', `${name}=${String(result.value)}`, anchor, result.resolution);
      };
      const functionNode = (input: SyntaxNode): SyntaxNode | undefined => {
        let node = view.unwrap(input); const seen = new Set<string>();
        while (!functions.has(node.type) && seen.size < 16 && !seen.has(key(node))) {
          budget.step(); seen.add(key(node));
          const binding = view.binding(node);
          if (!binding?.available || !binding.stable || binding.typeOnly) return undefined;
          const next = binding.initializer ?? (binding.kind === 'function' && binding.declaration ? view.declarationNode(binding.declaration) : undefined);
          if (!next) return undefined;
          node = view.unwrap(next);
        }
        return functions.has(node.type) ? node : undefined;
      };
      const callback = (input: SyntaxNode, contract: string, anchor: SyntaxNode, source: Reference, payload: Readonly<Record<string, string>> = {}) => {
        relation('fst-components.callback', view.reference(input), anchor);
        property('fst-components.callback-contract', contract, anchor);
        if (contract.slice(contract.indexOf('('), contract.indexOf('(') + 2) === '()') return;
        const fn = functionNode(input); if (!fn) return;
        const params = fn.fields.parameters ?? fn.fields.parameter;
        const first = params?.type === 'formal_parameters' ? params.children.find((child) => child.type !== 'comment') : params;
        if (!first) return;
        budget.step(16);
        const projections = view.patternProjections(first);
        if (!projections.complete || projections.projections.length > 16) { diagnose('fst-components.callback-pattern', 'Only bounded static callback parameter patterns are represented.', first); return; }
        for (const item of projections.projections) {
          budget.step(); const name = view.name(item.node); if (!name) continue;
          role('fst-components.callback-payload', item.node);
          property('fst-components.callback-binding', name, item.node);
          property('fst-components.callback-path', ['0', ...item.path].join('.'), item.node);
          property('fst-components.callback-contract', contract, item.node);
          relation('fst-components.argument-source', source, item.node);
          const kind = payload[item.path.join('.')];
          // Named callbacks can also be invoked elsewhere. Their parameter facts
          // describe this registration, but do not prove all receiver usages.
          if (kind && view.unwrap(input) === fn) parameterKinds.set(key(item.node), { kind, origin: anchor });
        }
      };
      const objectProperties = (input: SyntaxNode | undefined): Map<string, SyntaxNode> => {
        const result = new Map<string, SyntaxNode>(); if (!input) return result;
        const projected = project(input);
        const node = projected && !projected.path.length ? view.unwrap(projected.initializer) : view.unwrap(input);
        if (node.type !== 'object' || node.children.length > 64) return result;
        for (const child of node.children) {
          budget.step(); if (child.type === 'comment') continue;
          if (child.type === 'pair' && child.fields.key && child.fields.value) {
            const name = view.name(child.fields.key);
            if (!name || child.fields.key.type === 'computed_property_name') return new Map();
            result.set(name, child.fields.value);
          } else if (child.type === 'shorthand_property_identifier') { const name = view.name(child); if (name) result.set(name, child); }
          else return new Map();
        }
        // A named options object's contents must be observed at this use, not at
        // an earlier alias initializer. Query each property before trusting it.
        if (view.unwrap(input) !== node) for (const name of result.keys()) if (!project(input, [name])) result.delete(name);
        return result;
      };
      const optionCallbacks = (input: SyntaxNode | undefined, names: Readonly<Record<string, string>>, anchor: SyntaxNode, source: Reference) => {
        for (const [name, value] of objectProperties(input)) {
          if (Object.hasOwn(names, name)) callback(value, `${name}:${names[name]}`, value, source);
        }
      };
      const spreadProperties = (input: SyntaxNode, observation: SyntaxNode, seen = new Set<SyntaxNode>()): Map<string, SyntaxNode> | undefined => {
        budget.step(512);
        if (seen.size >= 16 || !view.referenceStable(input, observation, 'before-call')) return undefined;
        const projected = project(input);
        const object = projected && !projected.path.length ? view.unwrap(projected.initializer) : undefined;
        if (!object || object.type !== 'object' || seen.has(object) || object.children.length > 64) return undefined;
        const active = new Set(seen); active.add(object);
        const result = new Map<string, SyntaxNode>();
        for (const child of object.children) {
          budget.step();
          if (child.type === 'comment') continue;
          if (child.type === 'spread_element') {
            const value = child.children.find(item => item.type !== 'comment');
            const nested = value && spreadProperties(value, observation, active);
            if (!nested) return undefined;
            for (const [name, value] of nested) result.set(name, value);
          } else if (child.type === 'shorthand_property_identifier') result.set(view.text(child), child);
          else {
            const name = child.fields.key && child.fields.key.type !== 'computed_property_name' && view.name(child.fields.key);
            if (child.type !== 'pair' || !name || name === '__proto__' || !child.fields.value) return undefined;
            result.set(name, child.fields.value);
          }
          if (result.size > 64) return undefined;
        }
        return result;
      };

      for (const { node, name, tag } of jsx) {
        budget.step();
        const input = controls[name];
        if (!jsxNames.has(name)) continue;
        role(input ? 'fst-components.control' : ['SvgIcon', 'Icon'].includes(name) ? 'fst-components.asset-request' : name.includes('Scene') || name === 'Canvas3d' ? 'fst-components.scene' : 'fst-components.overlay', node);
        property('fst-components.api', name, node); relation('fst-components.import', view.resolve(tag), node);
        if (name === 'MarkdownEditor') property('fst-components.qualification', 'Zen-public-export;absent-from-inspected-Funtasia-barrel', node);
        if (name === 'SelectOption') property('fst-components.requirement', 'containing-Select', node);
        if (name === 'Scene') property('fst-components.requirement', 'Canvas3dState-required;SceneState-provided;setup-return-awaited-not-cleanup', node);
        if (name === 'Canvas3d') property('fst-components.cleanup', 'frames-observer-listeners-only;no-context-dispose-call', node);
        const attributes = new Map<string, { attr: SyntaxNode; group: number; value?: SyntaxNode | undefined; raw?: SyntaxNode | undefined; spread?: boolean; fallback?: boolean }>();
        const seen = new Set<string>();
        const parent = view.parent(node), observation = node.type === 'jsx_opening_element' && parent?.type === 'jsx_element' ? parent : node;
        const sequenceSupported = !!input || name === 'Popover';
        const hasSpreads = node.children.some(child => child.type === 'jsx_expression' && child.children.some(value => value.type === 'spread_element'));
        let ordinal = 0, group = 0, unresolvedSpread = false;
        const contribution = (attr: SyntaxNode, kind: string, value: SyntaxNode) => {
          property('fst-components.jsx-contribution', `${ordinal++}:group=${group}:${kind}`, attr);
          relation('fst-components.jsx-contribution-source', { kind: 'expression', text: view.text(value), span: view.span(value) }, attr);
          relation('fst-components.jsx-element', { kind: 'expression', text: view.text(node), span: view.span(node) }, attr);
        };
        if (hasSpreads && sequenceSupported) {
          property('fst-components.props-contract', 'authored groups and order, not compiler lowering proof; Solid lazy merge uses last-non-undefined property precedence, object-literal flattening uses own-property precedence; nested children supply the final children property; effective keys, values, getters and child normalization not evaluated', node);
          if (input) {
            property('fst-components.conditional-prop-contract', `field: if selected, borrowed Field with no disposal transfer; ${input[0]}: controlled input candidate; final field/value ownership mode unproven`, node);
            property('fst-components.conditional-prop-contract', `${input[1]}: if selected and notified, callback(${input[2]}); value-not-native-event; handler identity and delivery unproven`, node);
            if (name === 'ColorEditor') property('fst-components.conditional-prop-contract', 'onCommit: if selected and notified, callback(normalized-hex-string); notification-not-second-field-write; handler identity and delivery unproven', node);
            if (name === 'MarkdownEditor') property('fst-components.conditional-prop-contract', 'apiRef: if selected, callback(MarkdownEditorHandle|undefined); cleared-on-cleanup; handler identity and execution unproven', node);
          } else {
            property('fst-components.conditional-prop-contract', 'open: controlled visibility input; anchor: native element or undefined; onOpenChange: if selected and notified, callback(boolean), dismissal requests false; final bindings and visibility unproven', node);
          }
        }
        for (const attr of node.children) {
          budget.step();
          if (attr.type === 'jsx_expression') {
            const value = attr.children.find(child => child.type === 'spread_element')?.children.find(child => child.type !== 'comment');
            if (!value) continue;
            group++;
            if (hasSpreads && sequenceSupported) contribution(attr, 'spread', value);
            group++;
            seen.clear();
            relation('fst-components.spread-source', view.reference(value), attr);
            const fields = spreadProperties(value, observation);
            if (!fields) {
              attributes.clear(); seen.clear();
              unresolvedSpread = true;
              property('fst-components.qualification', 'forwarded props have unknown keys; earlier props may be overridden', attr);
              if (!sequenceSupported) diagnose('fst-components.dynamic-props', 'This API has no reviewed conditional prop-resolution contract for unknown forwarded keys.', attr);
              continue;
            }
            property('fst-components.qualification', 'forwarded own properties; authored override order; values are not runtime constants', attr);
            for (const [prop, value] of fields) attributes.set(prop, { attr, group: group - 1, value, spread: true, fallback: unresolvedSpread || attributes.has(prop) });
            continue;
          }
          if (attr.type !== 'jsx_attribute' || !attr.children[0]) continue;
          const prop = view.name(attr.children[0]); if (!prop) continue;
          if (hasSpreads && sequenceSupported) contribution(attr, `attribute:${prop}`, attr);
          if (seen.has(prop)) { attributes.delete(prop); diagnose('fst-components.dynamic-props', 'Duplicate JSX property overrides are not inferred.', attr); continue; }
          seen.add(prop);
          const raw = attr.children[1], value = raw?.type === 'jsx_expression' ? raw.children.find(child => child.type !== 'comment') : raw;
          attributes.set(prop, { attr, group, raw, value, fallback: unresolvedSpread || attributes.has(prop) && attributes.get(prop)!.group !== group });
        }
        if (hasSpreads && sequenceSupported && observation !== node) for (const child of observation.children) {
          budget.step();
          if (child !== node && !['jsx_closing_element', 'comment'].includes(child.type) && (child.type !== 'jsx_text' || view.text(child).trim())) contribution(child, 'nested-child-source', child);
        }
        for (const [prop, { attr, raw, value, spread, fallback }] of attributes) {
          budget.step();
          if (fallback && value) {
            budget.step(512);
            const known = view.constant(value), fn = functionNode(value);
            if (!(known.known && known.value !== undefined) && !(fn && view.referenceStable(value, observation, 'before-call'))) continue;
          }
          if (spread && value) {
            const pair = view.parent(value);
            relation('fst-components.forwarded-prop', view.reference(pair?.type === 'pair' && pair.fields.value === value ? pair : value), attr);
          }
          if (!value) {
            if ((input && prop === 'checked') || (name === 'Popover' && prop === 'open')) {
              property('fst-components.prop', prop, node); property('fst-components.literal', `${prop}=true`, node);
              relation(prop === 'checked' ? 'fst-components.checked' : 'fst-components.input', view.reference(attr), node);
            }
            continue;
          }
          // JSX entities, backslashes and multiline whitespace are not JS string escapes.
          const literalSafe = spread || raw?.type !== 'string' || !/[&\\\r\n]/.test(view.text(raw));
          if (input && (prop === 'field' || prop === input[0])) {
            property('fst-components.prop', prop, node);
            relation(`fst-components.${prop}` as FstComponentsRelation, view.reference(value), node);
            if (prop === 'field') property('fst-components.ownership', 'borrowed-field;user-write-contract;no-field-disposal', node);
            else if (literalSafe) literal(value, node, prop);
          }
          if (input && prop === input[1]) callback(value, `${name}.${prop}(${input[2]});value-not-native-event`, node, view.resolve(tag));
          if (name === 'ColorEditor' && prop === 'onCommit') callback(value, 'ColorEditor.onCommit(normalized-hex-string);notification-not-second-field-write', node, view.resolve(tag));
          if (name === 'MarkdownEditor' && prop === 'apiRef') {
            callback(value, 'MarkdownEditor.apiRef(MarkdownEditorHandle|undefined);cleared-on-cleanup', node, view.resolve(tag));
            property('fst-components.ownership', 'borrowed-editor-handle;no-destroy-ownership', node);
          }
          if (name === 'Scene' && prop === 'setup') callback(value, 'Scene.setup({scene:IScene,invalidateRender:()=>void});awaited-not-cleanup', node, view.resolve(tag), { '': 'setup-payload', scene: 'scene', invalidateRender: 'invalidate' });
          if (name === 'SceneGraphCanvas' && ['onRuntimeReady', 'onRuntimeDispose'].includes(prop)) callback(value, `${prop}(SceneGraphRuntime);component-managed`, node, view.resolve(tag), { '': 'runtime' });
          if (name === 'Popover' && prop === 'onOpenChange') callback(value, 'Popover.onOpenChange(boolean);dismissal-requests-false', node, view.resolve(tag));
          if (name === 'ContextMenu' && prop === 'onClose') callback(value, 'ContextMenu.onClose();close-request-before-selection-action', node, view.resolve(tag));
          if (name === 'ContextMenu' && prop === 'items') {
            const items = view.unwrap(value);
            if (items.type === 'array' && items.children.length <= 32 && !items.children.some((item) => item.type === 'spread_element')) for (const item of items.children) optionCallbacks(item, { onSelect: '()=>void;after-close-request' }, attr, view.resolve(tag));
          }
          const authored = (['SvgIcon', 'Icon'].includes(name) && prop === 'shape') || (name === 'Popover' && ['open', 'anchor'].includes(prop)) || (name === 'ContextMenu' && ['position', 'items'].includes(prop)) || (name === 'SceneGraphCanvas' && ['document', 'assetBaseUrl'].includes(prop)) || (name === 'SceneGraphHtmlSceneOverlayHost' && prop === 'bridge') || (['ColorEditor', 'MarkdownEditor'].includes(name) && prop === 'resetKey');
          if (authored) { property('fst-components.prop', prop, node); relation(prop === 'document' ? 'fst-components.document' : 'fst-components.input', view.reference(value), node); if (literalSafe) literal(value, node, prop); }
          if (name === 'SceneGraphCanvas' && ['assetUrlResolver', 'htmlComponentResolver'].includes(prop)) callback(value, prop === 'assetUrlResolver' ? '(assetKey,purpose)=>string;not-executed' : 'component-definition-resolver;not-executed', node, view.resolve(tag));
          if (name === 'SceneGraphHtmlSceneOverlayHost' && prop === 'componentResolver') callback(value, 'component-definition-resolver;not-executed', node, view.resolve(tag));
        }
      }

      // Unknown argument escapes can replace methods on a retained object. Be
      // conservative even across deferred callbacks; never use name-only trust.
      for (const node of callNodes) {
        budget.step(); if (invoke(node)) continue;
        const fn = node.fields.function && view.unwrap(node.fields.function);
        const receiver = fn && ['member_expression', 'subscript_expression'].includes(fn.type) ? fn.fields.object : undefined;
        if (receiver) taint(receiver);
        for (const arg of argsOf(node)) taint(arg);
      }
      for (const node of callNodes) {
        budget.step();
        const found = invoke(node); if (!found) continue;
        const { name, contract, target, receiver } = found, args = argsOf(node);
        if (args.some((arg) => arg.type === 'spread_element')) { diagnose('fst-components.call-shape', 'Spread call arguments are not assigned positional contracts.', node); continue; }
        role(`fst-components.${contract.role}`, node); property('fst-components.api', receiver ? `${receiver.kind}.${name}` : name, node);
        property('fst-components.operation', `${name}-request`, node); property('fst-components.result-contract', contract.result, node);
        relation(receiver ? 'fst-components.target' : 'fst-components.import', receiver ? view.reference(target) : view.resolve(target), node);
        if (contract.handle) { role('fst-components.handle', node); relation('fst-components.created-by', view.reference(target), node); }
        if (contract.cleanup) property('fst-components.cleanup', contract.cleanup, node);
        if (receiver?.method && node.fields.function && !access(node.fields.function)) property('fst-components.qualification', 'captured-method-request;this-binding-and-success-unproven', node);
        if (['useModal', 'useToasts'].includes(name)) property('fst-components.ownership', 'owner-captured-at-call;not-host-binding', node);
        const source = receiver ? view.reference(target) : view.resolve(target);
        for (const [index, arg] of args.entries()) {
          if (index >= 8) { diagnose('fst-components.call-shape', 'Only the first eight explicit argument references are retained.', node); break; }
          relation(index === 0 && (name.startsWith('setup') || name === 'useCameraControls' || name === 'attach') ? 'fst-components.scene-target' : index === 0 && ['SceneGraphRuntime', 'createSceneGraphRuntimeData', 'setDocument'].includes(name) ? 'fst-components.document' : 'fst-components.input', view.reference(arg), arg);
          literal(arg, arg, `arg${index}`);
        }
        if (['tooltip', 'focusring'].includes(name) && args[1]) callback(args[1], name === 'tooltip' ? '()=>JSX.Element|[bottom:boolean,JSX.Element];not-visibility' : '()=>number|true', args[1], source);
        if (name === 'openModal' && args[0]) callback(args[0], 'content({close:ModalClose})', args[0], source, { '': 'modal-payload', close: 'modal-close' });
        if (name === 'openModal') optionCallbacks(args[1], { onClose: '(ModalCloseReason)=>void' }, node, source);
        if (name === 'openConfirmationModal') optionCallbacks(args[0], { onConfirm: '()=>void|boolean|Promise<void|boolean>;false-keeps-open', onCancel: '()=>void|Promise<void>' }, node, source);
        if (name === 'showToast') optionCallbacks(args[0], { onClick: '()=>void', onClose: '()=>void' }, node, source);
        if (['configureIconAssetLoading', 'loadIconDef', 'resolveIconDef', 'resolveIconAssetUrl'].includes(name)) optionCallbacks(args[name === 'configureIconAssetLoading' ? 0 : 1], { resolver: '(IconAssetShape)=>string|URL|null|undefined', fetch: 'fetch-contract;not-executed' }, node, source);
        if (name === 'loadGLTF' && !receiver && args[3]) callback(args[3], '(GLTFLoader)=>void', args[3], source);
        if (name === 'loaderFn') { if (args[0]) callback(args[0], '(Loader)=>void', args[0], source); if (args[1]) callback(args[1], '(ProgressEvent)=>void', args[1], source); }
        if (receiver?.kind === 'scene' && name === 'add') optionCallbacks(args[1], { onAdded: '({scene,node})=>void' }, node, source);
        if (receiver?.kind === 'scene' && name === 'addRenderListener') optionCallbacks(args[0], { onBeforeRenderScene: '({delta:number})=>void', onAfterRenderScene: '({delta:number})=>void' }, node, source);
        if (name === 'SceneGraphRuntime') optionCallbacks(args[1], { assetUrlResolver: '(assetKey,purpose)=>string', onRenderInvalidated: '()=>void', onNodeLoaded: '(nodeId:string)=>void' }, node, source);
        if (receiver?.kind === 'bridge' && name === 'registerHtmlScene') optionCallbacks(args[1], { onTextureCanvas: '(HTMLCanvasElement)=>void', onCaptureSizeChanged: '(width:number,height:number)=>void' }, node, source);
        if (name === 'addCameraControlEndListener' && args[0]) callback(args[0], '()=>void;pending-registration-disposal-not-guaranteed', args[0], source);
        if (receiver?.kind === 'animation') {
          const options = args[['poseLayered', 'playAnimationLayered'].includes(name) ? 1 : name === 'tweenLayerWeight' ? 3 : -1];
          optionCallbacks(options, { trackMask: '(trackName:string)=>boolean', onUpdate: '({startWeight,weight,pct})=>void', onComplete: '()=>void' }, node, source);
          const layer = objectProperties(options).get('layerKey'); if (layer) literal(layer, node, 'layerKey');
        }
      }
      return { state: partial ? 'partial' : matched ? 'complete' : 'not-applicable', diagnostics };
    },
  };
}
