"""Bounded source-only TypeScript queries over the caller's native syntax tree."""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field
import re

from graphify.framework_config import normalize_module_aliases
from graphify.framework_evidence import ANNOTATION_LIMITS, canonical_json

from .values import ConstantQueries, decodeIdentifier, decodeString
from .projections import ProjectionQueries
from .bindings import BindingQueries


FUNCTIONS = frozenset(("function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function", "method_definition", "function_signature", "method_signature", "abstract_method_signature"))
CLASSES = frozenset(("class_declaration", "abstract_class_declaration", "class"))
WRAPPERS = frozenset(("parenthesized_expression", "as_expression", "satisfies_expression", "type_assertion", "non_null_expression", "instantiation_expression"))
_BARE_MODULE = re.compile(r"(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*\Z")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Node:
    """Identity-cached native node; syntax containers are materialized on demand."""

    __slots__ = ("native", "_view", "type", "startIndex", "endIndex", "_children", "_fields", "_tokens", "_expanded")

    def __init__(self, native, view):
        self.native = native
        self._view = view
        self.type = native.type
        self.startIndex = native.start_byte
        self.endIndex = native.end_byte
        self._children = self._fields = self._tokens = None
        self._expanded = False

    @property
    def children(self):
        if self._children is None:
            cache = self._view._nodes
            self._children = tuple(cache[child.id] for child in self.native.named_children if child.id in cache) if self._expanded else ()
        return self._children

    @property
    def fields(self):
        if self._fields is None:
            fields = {}
            if self._expanded:
                cache = self._view._nodes
                for index, child in enumerate(self.native.children):
                    if child.is_named and child.id in cache:
                        name = self.native.field_name_for_child(index)
                        if name and name not in fields:
                            fields[name] = cache[child.id]
            self._fields = fields
        return self._fields

    @property
    def tokens(self):
        if self._tokens is None:
            self._tokens = tuple(child.type for child in self.native.children if not child.is_named) if self._expanded else ()
        return self._tokens


SyntaxNode = Node


@dataclass(eq=False, slots=True)
class _Scope:
    parent: _Scope | None = None
    functionScope: bool = False
    bindings: dict = field(default_factory=dict)


@dataclass(eq=False, slots=True)
class _Binding:
    name: str
    kind: str
    node: Node
    scope: _Scope
    typeOnly: bool = False
    valueOnly: bool = False
    stable: bool = True
    availableFrom: int = 0
    nameNode: Node | None = None
    declaration: str | None = None
    initializer: Node | None = None
    origin: dict | None = None


class TypeScriptView:
    id = "typescript"
    version = 1

    def __init__(self, source: bytes, tree, *, relative_path: str, language: str,
                 source_hash: str, limits: dict, module_aliases: dict, return_contracts: list):
        if not isinstance(source, bytes) or language not in ("typescript", "tsx"):
            raise ValueError("Invalid TypeScript source or language")
        self.raw_source = source
        self.source = source.decode("utf-8", errors="strict")
        self.language, self.relativePath, self.sourceHash = language, relative_path, source_hash
        self.limits = dict(ANNOTATION_LIMITS)
        if not isinstance(limits, dict) or limits.keys() - self.limits.keys():
            raise ValueError("Invalid TypeScript view limits")
        for key, value in limits.items():
            if type(value) is not int or not 1 <= value <= self.limits[key]:
                raise ValueError("Invalid TypeScript view limit")
            self.limits[key] = value
        if len(source) > self.limits["maxSourceBytes"]:
            raise ValueError("TypeScript source byte limit exceeded")
        aliases = normalize_module_aliases(module_aliases)
        prefixes = sorted(aliases, key=lambda key: (-len(key), key))
        self._tree = tree
        self.state, self.diagnostics, self._work = "complete", [], 0
        self._constructing = True
        self._lines = [0] + [match.end() for match in re.finditer(b"\n", source)]
        self._nodes, self.nodes = {}, []
        raw_root = tree.root_node if hasattr(tree, "root_node") else tree
        pending = [(raw_root, 0)]
        if raw_root.has_error:
            self._note("typescript.parse-error", "Recovered syntax is not eligible for verified framework facts.", "unsupported")
        while pending:
            raw, depth = pending.pop()
            if raw.start_byte < 0 or raw.end_byte < raw.start_byte or raw.end_byte > len(source):
                raise ValueError("Invalid supplied syntax span")
            node = Node(raw, self)
            self._nodes[raw.id] = node
            self.nodes.append(node)
            if raw.is_missing or raw.type == "ERROR":
                self._note("typescript.parse-error", "Recovered syntax is not eligible for verified framework facts.", "unsupported")
            if depth >= self.limits["maxDepth"]:
                self._note("typescript.depth-limit", f"resource=syntax-depth accounted={depth} limit={self.limits['maxDepth']}", "truncated")
            elif self._tick(1 + raw.child_count):
                node._expanded = True
                pending.extend((child, depth + 1) for child in reversed(raw.named_children))
            else:
                break
        self.root = self._nodes[raw_root.id]
        self._modules, self._elements = {}, {}
        for node in self.nodes:
            if node.type not in ("import_statement", "export_statement"):
                continue
            source_node = node.fields.get("source")
            module = decodeString(self.text(source_node)) if source_node and source_node.type == "string" else None
            if module is None:
                continue
            prefix = next((key for key in prefixes if module == key or module.startswith(key + "/")), None)
            if prefix is not None:
                if not _BARE_MODULE.fullmatch(module):
                    self._note("typescript.module-alias-specifier", "Aliased module specifier is outside the supported bare-module syntax.", "unsupported")
                    continue
                module = aliases[prefix] + module[len(prefix):]
            self._modules[source_node] = module
        self.declarations = []
        self._declarations, self._declaration_nodes, self._node_declarations = {}, {}, {}
        self._scopes, self._binding_sources, self._declaration_bindings = {}, {}, {}
        self._unsafe_objects, self._unstable_class_objects = set(), set()
        self._escapes, self._identity_escapes = {}, {}
        self._projections = ProjectionQueries(self, return_contracts)
        if self.root.endIndex > self.root.startIndex:
            self._add(self.root, "module")
        self._walk(self.root, _Scope(functionScope=True))
        self._collect_mutations()
        self._collect_exports()
        self._collect_binding_evidence()
        self._constants = ConstantQueries(self)
        self._constructing = False

    def _note(self, code, message, state="partial"):
        if len(message.encode("utf-8")) <= self.limits["maxValueBytes"] and len(self.diagnostics) < self.limits["maxDiagnostics"] and not any(item["code"] == code for item in self.diagnostics):
            self.diagnostics.append({"code": code, "message": message})
        if self.state == "complete" or state in ("truncated", "unsupported"):
            self.state = state

    def _tick(self, amount=1):
        self._work += amount
        if self._work > self.limits["maxWork"]:
            self._note("typescript.work-limit", f"resource=work accounted={self._work} limit={self.limits['maxWork']}", "truncated")
            return False
        return True

    def _step(self):
        return not self._constructing or self._tick()

    def _original(self, node):
        if not isinstance(node, Node) or node._view is not self:
            raise ValueError("Node is not part of this TypeScript view")
        return node

    def slice_bytes(self, start, end):
        return self.raw_source[start:end].decode("utf-8", errors="strict")

    def text(self, node):
        node = self._original(node)
        return self.slice_bytes(node.startIndex, node.endIndex)

    def name(self, node):
        if node.type == "string":
            return decodeString(self.text(node))
        if node.type in ("identifier", "undefined", "type_identifier", "property_identifier", "private_property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"):
            return decodeIdentifier(self.text(node))
        return None

    def moduleIdentity(self, node):
        return self._modules.get(self._original(node))

    def span(self, node):
        node = self._original(node)
        return {"startByte": node.startIndex, "endByte": node.endIndex,
                "startLine": bisect_right(self._lines, node.startIndex),
                "endLine": bisect_right(self._lines, max(node.startIndex, node.endIndex - 1))}

    def parent(self, node):
        parent = self._original(node).native.parent
        return self._nodes.get(parent.id) if parent is not None else None

    def unwrap(self, node):
        node = self._original(node)
        for _ in range(self.limits["maxDepth"]):
            if node.type not in WRAPPERS:
                break
            next_node = node.fields.get("expression")
            if next_node is None and node.children:
                next_node = node.children[-1] if node.type == "type_assertion" else node.children[0]
            if next_node is None or next_node is node:
                break
            node = next_node
        return node

    def declarationNode(self, key):
        return self._declaration_nodes.get(key)

    def declarationAt(self, node):
        return self._node_declarations.get(self._original(node))

    def owner(self, node):
        cursor = self._original(node)
        while cursor is not None:
            declaration = self._node_declarations.get(cursor)
            if declaration is not None:
                return declaration
            cursor = self.parent(cursor)
        return None

    def elements(self, node):
        node = self._original(node)
        if node not in self._elements:
            elements, index = [], 0
            if node._expanded and node.type in ("array", "array_pattern"):
                for raw in node.native.children:
                    if not raw.is_named and raw.type == ",":
                        if len(elements) <= index:
                            elements.append(None)
                        index += 1
                    elif raw.is_named and raw.type != "comment" and raw.id in self._nodes:
                        while len(elements) <= index:
                            elements.append(None)
                        elements[index] = self._nodes[raw.id]
            self._elements[node] = tuple(elements)
        return self._elements[node]

    def _add_binding(self, binding):
        binding.name = decodeIdentifier(binding.name)
        binding.scope.bindings.setdefault(binding.name, []).append(binding)
        if binding.declaration:
            self._declaration_bindings[binding.declaration] = binding

    def _add(self, node, kind, name_node=None, owner=None, exports=()):
        if len(self.declarations) >= self.limits["maxDeclarations"]:
            self._note("typescript.declaration-limit", "Declaration limit reached.", "truncated")
            return None
        span = self.span(node)
        owner_start = self._declaration_nodes[owner["key"]].startIndex if owner else 0
        key = f"d:{kind}:{span['startByte']}:{span['endByte']}:{owner_start}"
        name = (decodeString(self.text(name_node)) if name_node.type == "string" else decodeIdentifier(self.text(name_node))) if name_node else None
        try:
            valid = name is None or len(name.encode("utf-8")) <= min(2048, self.limits["maxValueBytes"])
        except UnicodeError:
            valid = False
        if not valid:
            self._note("typescript.name-limit", "Declaration name exceeds the metadata or Unicode limit.")
            return None
        declaration = {"key": key, "kind": kind, "span": span, "exports": [decodeIdentifier(item) for item in exports]}
        if name:
            declaration.update(name=name, nameSpan=self.span(name_node))
        if owner:
            declaration["owner"] = owner["key"]
        self.declarations.append(declaration)
        self._declarations[key] = declaration
        self._declaration_nodes[key] = node
        self._node_declarations.setdefault(node, declaration)
        return declaration

    def _pattern_names(self, node):
        if node.type in ("this", "comment"):
            return []
        if node.type in ("identifier", "undefined", "shorthand_property_identifier_pattern", "type_identifier"):
            return [node]
        if node.type == "pair_pattern":
            value = node.fields.get("value")
            return self._pattern_names(value) if value else []
        if node.type in ("assignment_pattern", "object_assignment_pattern"):
            left = node.fields.get("left") or next(iter(node.children), None)
            return self._pattern_names(left) if left else []
        if node.type in ("object_pattern", "array_pattern", "rest_pattern", "required_parameter", "optional_parameter"):
            pattern = node.fields.get("pattern") or node.fields.get("name")
            return self._pattern_names(pattern) if pattern else [name for child in node.children if child.type != "type_annotation" for name in self._pattern_names(child)]
        self._note("typescript.binding-pattern", "Unsupported binding pattern remains unresolved.")
        return []

    def _walk(self, node, scope, owner=None, exported=()):
        if not self._tick():
            return
        self._scopes[node] = scope
        if node.type == "import_statement":
            source = node.fields.get("source")
            module = self.moduleIdentity(source) if source else None
            clause = next((child for child in node.children if child.type == "import_clause"), None)
            if module and clause:
                type_only = "type" in node.tokens

                def imported(name_node, name, only_type):
                    self._add_binding(_Binding(self.text(name_node), "import", name_node, scope,
                                               typeOnly=only_type, origin={"kind": "import", "module": module, "name": name}))

                for part in clause.children:
                    if part.type == "identifier":
                        imported(part, "default", type_only)
                    elif part.type == "namespace_import" and part.children:
                        imported(part.children[-1], "*", type_only)
                    elif part.type == "named_imports":
                        for specifier in part.children:
                            name = specifier.fields.get("name")
                            local = specifier.fields.get("alias") or name
                            if name and local:
                                value = decodeString(self.text(name))
                                imported(local, value if value is not None else decodeIdentifier(self.text(name)), type_only or "type" in specifier.tokens)
        if node.type == "export_statement":
            if node.fields.get("source"):
                self._note("typescript.re-export", "Re-export targets are not resolved across files.")
            declaration, value = node.fields.get("declaration"), node.fields.get("value")
            if declaration:
                self._walk(declaration, scope, owner, ["default"] if "default" in node.tokens else ["*"])
                return
            if value and value.type != "identifier":
                declaration = self._add(value, "class" if value.type in CLASSES else "function" if value.type in FUNCTIONS else "default", value.fields.get("name"), owner, ["default"])
                self._walk(value, scope, declaration or owner)
                return
        own = self._node_declarations.get(node)
        if not own and "default" in exported and not node.fields.get("name") and node.type in CLASSES | FUNCTIONS:
            own = self._add(node, "class" if node.type in CLASSES else "function", owner=owner, exports=["default"])
        if not own and node.type in CLASSES | FUNCTIONS | {"interface_declaration", "type_alias_declaration", "enum_declaration", "public_field_definition", "property_signature"}:
            name = node.fields.get("name")
            member = node.type in ("method_definition", "method_signature", "abstract_method_signature", "public_field_definition", "property_signature")
            if name and name.type != "computed_property_name":
                kind = "class" if node.type in CLASSES else "interface" if node.type == "interface_declaration" else "type" if node.type == "type_alias_declaration" else "enum" if node.type == "enum_declaration" else ("method" if node.type in FUNCTIONS else "property") if member else "function"
                own = self._add(node, kind, name, owner, [self.text(name)] if "*" in exported else exported)
                if not member and own and node.type not in ("function_expression", "generator_function", "class"):
                    is_type = kind in ("type", "interface")
                    self._add_binding(_Binding(self.text(name), "type" if is_type else "class" if kind == "class" else "function", node, scope, typeOnly=is_type, valueOnly=kind == "function", declaration=own["key"], availableFrom=node.endIndex if kind == "class" else 0))
            elif name and member:
                expression = next((child for child in name.children if child.type != "comment"), None)
                computed = self._expression(expression) if expression else None
                if computed and not _CONTROL.search(computed["text"]) and len(canonical_json(computed).encode("utf-8")) <= self.limits["maxValueBytes"]:
                    own = self._add(node, "method" if node.type in FUNCTIONS else "property", owner=owner)
                    if own:
                        own.update(computedName=computed, nameSpan=self.span(name))
                else:
                    self._note("typescript.computed-member", "Computed member source exceeds the retained evidence limit.")
        if node.type == "variable_declarator":
            pattern, initializer, container = node.fields.get("name"), node.fields.get("value"), self.parent(node)
            kind = "const" if container and "const" in container.tokens else "let" if container and "let" in container.tokens else "var"
            projection = self.patternProjections(pattern) if pattern else None
            paths = {item["node"]: item["path"] for item in projection["projections"]} if projection else {}
            target = scope
            if kind == "var":
                while not target.functionScope and target.parent:
                    target = target.parent
            for name in self._pattern_names(pattern) if pattern else []:
                declaration = self._add(node if pattern is name else name, kind, name, owner, [self.text(name)] if "*" in exported else exported)
                if declaration:
                    self._add_binding(_Binding(self.text(name), kind, node, target, nameNode=name, declaration=declaration["key"], initializer=initializer if pattern is name else None, valueOnly=True, stable=kind == "const", availableFrom=node.endIndex))
                    if initializer:
                        self._binding_sources[declaration["key"]] = {"initializer": initializer, "path": paths.get(name, []), "complete": bool(projection and projection["complete"] and name in paths)}
                if not own and pattern is name:
                    own = declaration
        child_scope = scope
        if node.type in FUNCTIONS | CLASSES | {"statement_block", "for_statement", "for_in_statement", "catch_clause", "switch_body", "internal_module", "interface_declaration", "type_alias_declaration"}:
            child_scope = _Scope(scope, node.type in FUNCTIONS)
            parameters = node.fields.get("type_parameters")
            for parameter in parameters.children if parameters else ():
                name = parameter.fields.get("name")
                if name:
                    self._add_binding(_Binding(self.text(name), "type", name, child_scope, typeOnly=True))
            name = node.fields.get("name")
            if name and (node.type in ("function_expression", "generator_function") or node.type in CLASSES):
                body = node.fields.get("body")
                self._add_binding(_Binding(self.text(name), "class" if node.type in CLASSES else "function", node, child_scope, declaration=own["key"] if own else None, valueOnly=node.type not in CLASSES, availableFrom=(body.startIndex if body else node.endIndex) if node.type in CLASSES else 0))
            params = node.fields.get("parameters") or node.fields.get("parameter")
            patterns = params.children if params and params.type == "formal_parameters" else [params] if params else []
            for param in patterns:
                for name in self._pattern_names(param):
                    self._add_binding(_Binding(self.text(name), "parameter", name, child_scope, valueOnly=True, stable=False))
            # Catch parameters are already included through the parameter field.
            if node.type == "for_in_statement" and node.fields.get("left") and any(token in node.tokens for token in ("const", "let", "var")):
                kind = "const" if "const" in node.tokens else "let" if "let" in node.tokens else "var"
                target = child_scope
                if kind == "var":
                    while not target.functionScope and target.parent:
                        target = target.parent
                for name in self._pattern_names(node.fields["left"]):
                    declaration = self._add(name, kind, name, owner)
                    self._add_binding(_Binding(self.text(name), kind, name, target, declaration=declaration["key"] if declaration else None, valueOnly=True, stable=False))
        for child in node.children:
            self._walk(child, child_scope, own or owner, exported if node.type in ("lexical_declaration", "variable_declaration", "ambient_declaration") else ())

    def _lookup(self, node, space="value"):
        scope = self._scopes.get(self._original(node))
        name = decodeIdentifier(self.text(node))
        while scope:
            candidates = scope.bindings.get(name, ())
            matches = [binding for binding in candidates if not binding.typeOnly or binding.kind == "import"] if space == "value" else [binding for binding in candidates if not binding.valueOnly]
            if matches:
                return matches[0] if len(matches) == 1 else None
            scope = scope.parent
        return None

    def binding(self, node, space="value"):
        binding = self._lookup(self.unwrap(node), space)
        if binding is None:
            return None
        available = space == "type" or node.startIndex >= binding.availableFrom or binding.kind in ("function", "import")
        if available and space == "value" and binding.kind == "class" and node.startIndex >= binding.node.startIndex and node.endIndex <= binding.node.endIndex:
            cursor = node
            while cursor and cursor is not binding.node:
                member = self.parent(cursor)
                body = self.parent(member) if member else None
                if cursor.type == "computed_property_name" and body and body.type == "class_body" and self.parent(body) is binding.node:
                    available = False
                    break
                cursor = member
        result = {"name": binding.name, "kind": binding.kind, "node": binding.node,
                  "typeOnly": binding.typeOnly, "stable": binding.stable and binding.declaration not in self._unstable_class_objects, "available": available}
        for key in ("declaration", "initializer", "origin"):
            value = getattr(binding, key)
            if value is not None:
                result[key] = dict(value) if key == "origin" else value
        return result

    def _expression(self, node, space="value"):
        return {"kind": "type" if space == "type" else "expression", "text": self.text(node), "span": self.span(node)}

    def reference(self, input, space="value"):
        node = self.unwrap(input)
        binding, declared = self.binding(node, space), self._node_declarations.get(node)
        if declared and node.type in FUNCTIONS | CLASSES:
            return {"kind": "declaration", "key": declared["key"]}
        if binding and binding["available"] and not (space == "value" and binding["typeOnly"]):
            if binding.get("origin"):
                return dict(binding["origin"])
            if binding.get("declaration"):
                return {"kind": "declaration", "key": binding["declaration"]}
        return self._expression(input, space)

    def resolve(self, input, space="value", _seen=None):
        seen = set() if _seen is None else _seen
        node = self.unwrap(input)
        if len(seen) >= self.limits["maxDepth"] or node in seen:
            return self._expression(input, space)
        seen.add(node)
        if node.type in ("member_expression", "nested_type_identifier"):
            obj = node.fields.get("object") or node.fields.get("module")
            prop = node.fields.get("property") or node.fields.get("name")
            if obj and prop and "?." not in node.tokens:
                origin = self.resolve(obj, space, seen)
                if origin["kind"] == "import":
                    member = decodeIdentifier(self.text(prop))
                    if origin["name"] == "*" and not origin.get("member"):
                        return {"kind": "import", "module": origin["module"], "name": member}
                    if origin["name"] != "*":
                        return {**origin, "member": origin["member"] + "." + member if origin.get("member") else member}
        binding = self.binding(node, space)
        if binding and space == "value" and not binding["stable"]:
            return self._expression(input, space)
        if binding and binding["available"] and binding["stable"] and not (space == "value" and binding["typeOnly"]):
            if binding.get("initializer"):
                initial = self.unwrap(binding["initializer"])
                if initial.type in ("identifier", "member_expression", "nested_type_identifier"):
                    return self.resolve(initial, space, seen)
            if space == "value" and binding.get("declaration"):
                source = self._binding_sources.get(binding["declaration"])
                if source and source["complete"] and source["path"]:
                    projected = self.project(source["initializer"], source["path"])
                    if projected and projected["initializer"] is not node:
                        if not projected["path"]:
                            return self.resolve(projected["initializer"], space, seen)
                        origin = self.resolve(projected["initializer"], space, seen)
                        if origin["kind"] == "import" and origin["name"] == "*" and not origin.get("member") and len(projected["path"]) == 1 and isinstance(projected["path"][0], str):
                            return {"kind": "import", "module": origin["module"], "name": projected["path"][0]}
        return self.reference(input, space)

    def _collect_exports(self):
        for node in self.nodes:
            if node.type != "export_statement" or node.fields.get("source"):
                continue
            value = node.fields.get("value")
            if value and value.type == "identifier" and "default" in node.tokens:
                binding = self._lookup(value)
                declaration = self._declarations.get(binding.declaration) if binding else None
                if declaration and "default" not in declaration["exports"]:
                    declaration["exports"].append("default")
            clause = next((child for child in node.children if child.type == "export_clause"), None)
            for specifier in clause.children if clause else ():
                name = specifier.fields.get("name")
                alias = specifier.fields.get("alias") or name
                if not name or not alias:
                    continue
                only_type = "type" in node.tokens or "type" in specifier.tokens
                binding = self._lookup(name, "type" if only_type else "value") or self._lookup(name, "type")
                declaration = self._declarations.get(binding.declaration) if binding else None
                exported = decodeString(self.text(alias))
                if exported is None:
                    exported = decodeIdentifier(self.text(alias))
                if declaration and exported not in declaration["exports"]:
                    try:
                        valid = len(exported.encode("utf-8")) <= min(2048, self.limits["maxValueBytes"])
                    except UnicodeError:
                        valid = False
                    if len(declaration["exports"]) >= 256 or not valid:
                        self._note("typescript.export-limit", "Export aliases exceed the wire limit.", "truncated")
                    else:
                        declaration["exports"].append(exported)

    def _carried(self, node):
        if node.type in ("member_expression", "subscript_expression"):
            return [node.fields["object"]] if node.fields.get("object") else []
        if node.type == "binary_expression" and any(token in node.tokens for token in ("&&", "||", "??")):
            return [node.fields[key] for key in ("left", "right") if node.fields.get(key)]
        if node.type == "ternary_expression":
            return [node.fields[key] for key in ("consequence", "alternative") if node.fields.get(key)]
        if node.type == "sequence_expression":
            return [child for child in node.children if child.type != "comment"][-1:]
        if node.type in ("await_expression", "yield_expression", "jsx_expression"):
            return [child for child in node.children if child.type != "comment"]
        return []

    def _propagate_escape(self, binding, occurrence=None, identity_only=False):
        seen, pending = set(), [binding]
        while pending and len(seen) < self.limits["maxDepth"] and self._tick():
            alias = pending.pop()
            if alias.kind != "const" or alias in seen:
                continue
            seen.add(alias)
            source = alias.initializer or self._binding_sources.get(alias.declaration, {}).get("initializer")
            if not source:
                continue
            references = [source]
            while references and self._tick():
                initial = self.unwrap(references.pop())
                if initial.type != "identifier":
                    references.extend(self._carried(initial))
                    continue
                origin = self._lookup(initial)
                if origin is None:
                    continue
                if occurrence is None:
                    self._unsafe_objects.add(origin)
                else:
                    (self._identity_escapes if identity_only else self._escapes).setdefault(origin, []).append(occurrence)
                pending.append(origin)
        if pending:
            self._note("typescript.work-limit", "Reference escape propagation exceeds bounded alias traversal.", "truncated")

    def _collect_mutations(self):
        alias_escapes = []
        for node in self.nodes:
            if not self._tick():
                break
            if node.type not in ("identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"):
                continue
            binding = self._lookup(node)
            if not binding or binding.node.fields.get("name") is node or binding.node is node or binding.nameNode is node:
                continue
            at, parent = node, self.parent(node)
            while parent:
                grandparent = self.parent(parent)
                great = self.parent(grandparent) if grandparent else None
                tagged = parent.type == "template_substitution" and grandparent and grandparent.type == "template_string" and great and great.fields.get("arguments") is grandparent
                template_args = parent.type == "template_string" and grandparent and grandparent.fields.get("arguments") is parent
                jsx_value = parent.type == "jsx_attribute" and len(parent.children) > 1 and parent.children[1] is at
                spread = parent.type == "spread_element" and grandparent and grandparent.type in ("arguments", "jsx_expression")
                if not (parent.type in WRAPPERS or at in self._carried(parent) or tagged or template_args or jsx_value or spread or parent.type in ("array_pattern", "object_pattern", "pair_pattern", "rest_pattern") or (parent.type in ("assignment_pattern", "object_assignment_pattern") and (parent.fields.get("left") or next(iter(parent.children), None)) is at)):
                    break
                at, parent = parent, grandparent
            if parent and ((parent.type in ("assignment_expression", "augmented_assignment_expression", "for_in_statement") and parent.fields.get("left") is at) or parent.type == "update_expression" or (parent.type == "unary_expression" and "delete" in parent.tokens)):
                if at is node or at.type in WRAPPERS or at.type in ("array_pattern", "object_pattern") or binding.kind in ("import", "const"):
                    binding.stable = False
                self._unsafe_objects.add(binding)
                self._propagate_escape(binding)
                alias = binding
                for _ in range(self.limits["maxDepth"]):
                    if alias.kind != "const":
                        break
                    source = alias.initializer or self._binding_sources.get(alias.declaration, {}).get("initializer")
                    if not source:
                        break
                    initial = self.unwrap(source)
                    while initial.type in ("member_expression", "subscript_expression") and initial.fields.get("object"):
                        initial = self.unwrap(initial.fields["object"])
                    if initial.type != "identifier":
                        break
                    origin = self._lookup(initial)
                    if not origin or origin is alias:
                        break
                    self._unsafe_objects.add(origin)
                    if origin.kind in ("import", "const"):
                        origin.stable = False
                    if origin.kind == "class" and self.unwrap(at).type in ("member_expression", "subscript_expression"):
                        origin.stable = False
                        if origin.declaration:
                            self._unstable_class_objects.add(origin.declaration)
                        self._note("typescript.mutated-class-alias", "A class object written through an alias is not a stable value origin.")
                    alias = origin
            elif parent and (parent.type == "arguments" or (parent.type == "call_expression" and (parent.fields.get("arguments") is at or (parent.fields.get("function") is at and self.unwrap(at).type in ("member_expression", "subscript_expression")))) or (parent.type in ("jsx_element", "jsx_fragment", "jsx_opening_element", "jsx_self_closing_element") and parent.fields.get("name") is not at)):
                self._escapes.setdefault(binding, []).append(parent)
                alias_escapes.append((binding, parent, False))
            elif parent and parent.type in ("jsx_opening_element", "jsx_self_closing_element") and parent.fields.get("name") is at:
                self._identity_escapes.setdefault(binding, []).append(parent)
                alias_escapes.append((binding, parent, True))
            elif parent and parent.type not in ("spread_element", "template_substitution", "binary_expression", "ternary_expression", "sequence_expression", "unary_expression", "export_specifier", "export_statement", "type_annotation", "generic_type"):
                container = self.parent(parent)
                safe_alias = parent.type == "variable_declarator" and self.unwrap(parent.fields.get("value") or parent) is self.unwrap(at) and container and "const" in container.tokens
                jsx_tag = parent.type in ("jsx_opening_element", "jsx_closing_element", "jsx_self_closing_element") and parent.fields.get("name") is at
                direct_call = (parent.type == "call_expression" and parent.fields.get("function") is at) or (parent.type == "new_expression" and parent.fields.get("constructor") is at)
                if not safe_alias and not jsx_tag and not direct_call:
                    self._unsafe_objects.add(binding)
                    if parent.type != "call_expression" or parent.fields.get("function") is not at:
                        alias_escapes.append((binding, None, False))
        for binding, occurrence, identity_only in alias_escapes:
            if not self._tick():
                break
            source = self._binding_sources.get(binding.declaration)
            value = self.project(source["initializer"], source["path"]) if source and source["complete"] else None
            if value and not value["path"] and value["initializer"].type in ("string", "number", "true", "false", "null"):
                continue
            self._propagate_escape(binding, occurrence, identity_only)

    @staticmethod
    def _function_scope(scope):
        while scope and scope.parent and not scope.functionScope:
            scope = scope.parent
        return scope

    def stableObject(self, node, observation=None, offset=None, delivery=None, preservesIdentity=None):
        observation = node if observation is None else observation
        offset = observation.startIndex if offset is None else offset
        binding = self._lookup(node)
        if not binding or binding in self._unsafe_objects:
            return False
        observed_scope = self._function_scope(self._scopes.get(observation))
        declared_scope = self._function_scope(binding.scope)

        def unsafe(escape, jsx_tag):
            return escape is not delivery and (observed_scope is not declared_scope or self._function_scope(self._scopes.get(escape)) is not declared_scope or escape.endIndex <= offset) and not (preservesIdentity and preservesIdentity(escape, jsx_tag))

        return not any(unsafe(escape, False) for escape in self._escapes.get(binding, ())) and (not preservesIdentity or not any(unsafe(escape, True) for escape in self._identity_escapes.get(binding, ())))

    def _collect_binding_evidence(self):
        queries = BindingQueries(self)
        for node in self.nodes:
            if not self._tick():
                break
            declaration = node.type == "variable_declarator"
            pattern = node.fields.get("name") if declaration else node.fields.get("left") if node.type in ("assignment_expression", "for_in_statement") else None
            if not pattern or self.unwrap(pattern).type not in ("array_pattern", "object_pattern") or any(token in node.tokens for token in ("const", "let", "var")):
                continue
            source = node.fields.get("value") if declaration else node.fields.get("right") if node.type == "assignment_expression" else None
            evidence = queries.pattern(pattern, source) if source else None
            complete = bool(evidence and evidence["complete"])
            for item in evidence["bindings"] if evidence else ():
                binding = self._lookup(item["node"]) if not declaration else None
                target = self._node_declarations.get(item["node"]) if declaration else self._declarations.get(binding.declaration) if binding else None
                if target is None:
                    complete = False
                elif declaration:
                    target["binding"] = item["evidence"]
                elif len(target.get("writes", ())) < 64:
                    target.setdefault("writes", []).append(item["evidence"])
                else:
                    complete = False
            if not complete:
                self._note("typescript.destructuring-value" if declaration else "typescript.destructuring-assignment", "Binding operations or targets exceed supported source-evidence bounds; runtime values remain unknown.")

    def initializerProjection(self, key):
        source, binding = self._binding_sources.get(key), self._declaration_bindings.get(key)
        return {**source, "path": list(source["path"]), "complete": bool(source["complete"] and binding and binding.stable and self.project(source["initializer"], source["path"]))} if source else None

    def patternProjections(self, node):
        return self._projections.patternProjections(node)

    def project(self, node, path=()):
        return self._projections.project(node, path)

    def referenceStable(self, node, observation, timing="start"):
        return self._projections.referenceStable(node, observation, timing)

    def constant(self, node):
        return self._constants.constant(node)

    def constantProperty(self, node, key):
        return self._constants.constantProperty(node, key)
