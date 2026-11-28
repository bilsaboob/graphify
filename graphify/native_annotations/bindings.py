"""Destructuring evaluation descriptors, never proof of resulting values."""

from __future__ import annotations

import re

from graphify.framework_evidence import canonical_json

from .values import js_string, number


_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class BindingQueries:
    def __init__(self, view):
        self.view = view
        self.maxWork, self.maxDepth = min(view.limits["maxWork"], 512), min(view.limits["maxDepth"], 24)

    def staticKey(self, node):
        view = self.view
        if node.type == "number":
            value = number(view.text(node))
            return js_string(value) if value is not None else None
        if node.type == "computed_property_name":
            value = next((child for child in node.children if child.type != "comment"), None)
            return self.staticKey(view.unwrap(value)) if value and view.unwrap(value).type in ("string", "number") else None
        value = view.name(node)
        try:
            return value if value is not None and len(value.encode("utf-8")) <= 2048 and not _CONTROL.search(value) else None
        except UnicodeError:
            return None

    def key(self, node):
        literal = self.staticKey(node)
        if literal is not None:
            return literal
        value = next((child for child in node.children if child.type != "comment"), None) if node.type == "computed_property_name" else None
        return self.view._expression(value) if value else None

    def fits(self, value):
        def valid(item):
            if isinstance(item, str):
                return not _CONTROL.search(item)
            if isinstance(item, dict):
                return all(valid(value) for value in item.values())
            if isinstance(item, list):
                return all(valid(value) for value in item)
            return True

        try:
            return valid(value) and len(canonical_json(value).encode("utf-8")) <= self.view.limits["maxValueBytes"]
        except (ValueError, UnicodeError):
            return False

    def shapes(self, input):
        view, work, active = self.view, 0, set()

        def step(depth):
            nonlocal work
            work += 1
            return work <= self.maxWork and depth <= self.maxDepth and view._tick()

        def visit(input_node, depth, observation):
            if not step(depth):
                return None
            node = view.unwrap(input_node)
            observed = node if node.startIndex > observation.startIndex else observation
            if node in active:
                return None
            active.add(node)
            try:
                if node.type == "array":
                    elements = view.elements(node)
                    return [{"kind": "tuple", "span": view.span(node), "length": len(elements)}] if len(elements) <= 64 and not any(item and item.type == "spread_element" for item in elements) else None
                if node.type == "object":
                    keys = []
                    for child in node.children:
                        if not step(depth + 1):
                            return None
                        if child.type == "comment":
                            continue
                        prop = self.staticKey(child) if child.type == "shorthand_property_identifier" else self.staticKey(child.fields["key"]) if child.type == "pair" and child.fields.get("key") else None
                        if prop is None or prop == "__proto__":
                            return None
                        if prop not in keys:
                            keys.append(prop)
                        if len(keys) > 64:
                            return None
                    return [{"kind": "object", "span": view.span(node), "keys": keys}]
                if node.type == "ternary_expression" and node.fields.get("consequence") and node.fields.get("alternative"):
                    left = visit(node.fields["consequence"], depth + 1, observed)
                    right = visit(node.fields["alternative"], depth + 1, observed)
                    return [*left, *right] if left and right and len(left) + len(right) <= 16 else None
                if node.type == "identifier":
                    binding = view.binding(node)
                    if binding and binding["kind"] == "const" and binding["stable"] and binding["available"] and not binding["typeOnly"] and binding.get("initializer") and view.stableObject(node, observed):
                        return visit(binding["initializer"], depth + 1, observed)
                if node.type == "call_expression" and node.fields.get("function") and "?." not in node.tokens:
                    def callable(input, depth):
                        if not step(depth):
                            return None
                        value = view.unwrap(input)
                        if value.type in ("function_declaration", "function_expression", "arrow_function"):
                            return value
                        binding = view.binding(value) if value.type == "identifier" else None
                        if not binding or not binding["available"] or not binding["stable"] or binding["typeOnly"]:
                            return None
                        if binding["kind"] == "function":
                            return binding["node"]
                        if binding["kind"] == "const" and binding.get("initializer"):
                            return callable(binding["initializer"], depth + 1)
                        return None

                    fn = callable(node.fields["function"], depth + 1)
                    body = fn.fields.get("body") if fn else None
                    if not fn or not body or "async" in fn.tokens or "*" in fn.tokens:
                        return None
                    if body.type != "statement_block":
                        return visit(body, depth + 1, body)
                    returns, valid = [], True

                    def flow(statement, depth):
                        nonlocal valid
                        if not step(depth):
                            valid = False
                            return False
                        if statement.type == "return_statement":
                            value = next((child for child in statement.children if child.type != "comment"), None)
                            result = visit(value, depth + 1, value) if value else None
                            if not result or len(returns) + len(result) > 16:
                                valid = False
                            else:
                                returns.extend(result)
                            return True
                        if statement.type == "throw_statement":
                            return True
                        if statement.type == "statement_block":
                            for child in statement.children:
                                if flow(child, depth + 1):
                                    return True
                            return False
                        if statement.type == "if_statement" and statement.fields.get("consequence"):
                            left = flow(statement.fields["consequence"], depth + 1)
                            alternative = statement.fields.get("alternative")
                            right = flow(alternative, depth + 1) if alternative else False
                            return left and right
                        if statement.type == "else_clause":
                            child = next((child for child in statement.children if child.type != "comment"), None)
                            return flow(child, depth + 1) if child else False
                        if statement.type in ("function_declaration", "class_declaration", "comment", "empty_statement"):
                            return False

                        def inspect(child, depth):
                            nonlocal valid
                            if not step(depth):
                                valid = False
                                return
                            if child.type in ("function_expression", "arrow_function", "function_declaration", "method_definition", "class", "class_declaration"):
                                return
                            if child.type in ("return_statement", "try_statement", "yield_expression"):
                                valid = False
                                return
                            for nested in child.children:
                                inspect(nested, depth + 1)

                        inspect(statement, depth + 1)
                        return False

                    terminates = flow(body, depth + 1)
                    return returns if valid and terminates and returns else None
                return None
            finally:
                active.remove(node)

        return visit(input, 0, input)

    def pattern(self, input, source):
        view, work, complete, bindings = self.view, 0, True, []
        alternatives = self.shapes(source)

        def visit(input_node, operations, depth):
            nonlocal work, complete
            work += 1
            if work > self.maxWork or depth > self.maxDepth or len(operations) > self.maxDepth or not view._tick():
                complete = False
                return
            node = view.unwrap(input_node)
            if node.type in ("identifier", "undefined", "shorthand_property_identifier_pattern"):
                evidence = {"source": view._expression(source), "sourceSpan": view.span(source), "patternSpan": view.span(input), "operations": operations, "value": "unknown"}
                if alternatives:
                    evidence["shapes"] = alternatives
                if not operations or not self.fits(evidence):
                    complete = False
                    return
                bindings.append({"node": node, "evidence": evidence})
                return
            if node.type in ("assignment_pattern", "object_assignment_pattern"):
                left = node.fields.get("left") or next(iter(node.children), None)
                right = node.fields.get("right") or (node.children[-1] if node.children else None)
                if not left or not right or left is right:
                    complete = False
                else:
                    visit(left, [*operations, {"kind": "default", "span": view.span(node), "value": view._expression(right)}], depth + 1)
                return
            if node.type == "array_pattern":
                items = view.elements(node)
                for index, item in enumerate(items):
                    work += 1
                    if work > self.maxWork or not view._tick():
                        complete = False
                        break
                    if not item:
                        continue
                    rest = item.type == "rest_pattern"
                    target = next((child for child in item.children if child.type != "comment"), None) if rest else item
                    if not target or (rest and index != len(items) - 1):
                        complete = False
                        continue
                    visit(target, [*operations, {"kind": "iterator-rest" if rest else "iterator", "span": view.span(item), "index": index}], depth + 1)
                return
            if node.type == "object_pattern":
                excluded_keys = []
                for item in node.children:
                    work += 1
                    if work > self.maxWork or not view._tick():
                        complete = False
                        break
                    if item.type == "comment":
                        continue
                    if item.type == "rest_pattern":
                        target = next((child for child in item.children if child.type != "comment"), None)
                        if not target or len(excluded_keys) > 64:
                            complete = False
                        else:
                            visit(target, [*operations, {"kind": "object-rest", "span": view.span(item), "excludedKeys": list(excluded_keys)}], depth + 1)
                        continue
                    key_node = item.fields.get("key") if item.type == "pair_pattern" else item.fields.get("left") or next(iter(item.children), None) if item.type == "object_assignment_pattern" else item
                    prop = self.key(key_node) if key_node else None
                    target = item.fields.get("value") if item.type == "pair_pattern" else item
                    if prop is None or not target:
                        complete = False
                        continue
                    excluded_keys.append(prop)
                    visit(target, [*operations, {"kind": "property" if isinstance(prop, str) else "computed-property", "span": view.span(item), "key": prop}], depth + 1)
                return
            complete = False

        visit(input, [], 0)
        return {"complete": complete and bool(bindings), "bindings": bindings}
