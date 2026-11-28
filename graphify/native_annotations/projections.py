"""Static projections and reviewed return contracts, separate from value evidence."""

from __future__ import annotations

import re

from .values import decodeString, js_string, number


def _optional(node):
    return "?." in node.tokens or any(child.type == "optional_chain" for child in node.children)


def _index(key):
    if type(key) is int:
        return key
    if isinstance(key, str) and re.fullmatch(r"0|[1-9][0-9]*", key):
        return int(key)
    return -1


class ProjectionQueries:
    def __init__(self, view, supplied):
        self.view = view
        self.maxWork, self.maxDepth = min(view.limits["maxWork"], 512), min(view.limits["maxDepth"], 24)
        self.contracts, self.namespaceCalls = {}, {}
        ids, work = set(), 0

        def step():
            nonlocal work
            work += 1
            if work > 2048:
                raise ValueError("Return contract metadata limit exceeded")

        def integer(value):
            return type(value) is int and 0 <= value <= 16

        def member(value):
            return isinstance(value, str) and re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]{0,127}", value)

        def shape(value, depth):
            step()
            if depth > 24 or not isinstance(value, dict):
                raise ValueError("Invalid return contract shape")
            kind = value.get("kind")
            if kind == "value":
                return {"kind": kind}
            if kind == "record":
                return {"kind": kind, "value": shape(value["value"], depth + 1)}
            if kind == "tuple" and isinstance(value.get("items"), (list, tuple)) and len(value["items"]) <= 64:
                return {"kind": kind, "items": [shape(item, depth + 1) for item in value["items"]]}
            if kind == "object" and isinstance(value.get("properties"), dict) and len(value["properties"]) <= 64:
                properties = {}
                for key, item in value["properties"].items():
                    if not isinstance(key, str) or len(key) > view.limits["maxValueBytes"]:
                        raise ValueError("Return contract key limit exceeded")
                    properties[key] = shape(item, depth + 1)
                return {"kind": kind, "properties": properties}
            if kind == "key-partitions" and depth == 0 and integer(value.get("sourceArgument")) and integer(value.get("keysFromArgument")) and value["keysFromArgument"] > value["sourceArgument"]:
                return {"kind": kind, "sourceArgument": value["sourceArgument"], "keysFromArgument": value["keysFromArgument"]}
            raise ValueError("Invalid return contract shape")

        def observations(value):
            if not isinstance(value, dict) or set(value) != {"factoryArities", "uses"}:
                raise ValueError("Invalid handle identity observations")
            arities, uses = value["factoryArities"], value["uses"]
            if not isinstance(arities, (list, tuple)) or not 1 <= len(arities) <= 16 or not all(integer(n) for n in arities) or len(set(arities)) != len(arities) or not isinstance(uses, (list, tuple)) or not 1 <= len(uses) <= 16:
                raise ValueError("Invalid handle identity observations")
            for _ in arities:
                step()
            output = []
            for use in uses:
                step()
                kind = use.get("kind")
                if kind == "receiver-call" and set(use) == {"kind", "member", "arity"} and member(use["member"]) and integer(use["arity"]):
                    normalized = dict(use)
                elif kind == "jsx-member" and set(use) == {"kind", "member"} and member(use["member"]):
                    normalized = dict(use)
                elif kind == "call-argument" and set(use) == {"kind", "origins", "index", "arity"} and integer(use["index"]) and integer(use["arity"]) and use["index"] < use["arity"] and 1 <= len(use["origins"]) <= 16:
                    origins = []
                    for origin in use["origins"]:
                        step()
                        module = origin.get("module")
                        if set(origin) != {"module", "name"} or not isinstance(module, str) or not module or len(module) > 4096 or module.startswith((".", "/")) or "\\" in module or not member(origin["name"]):
                            raise ValueError("Invalid identity consumer origin")
                        if origin in origins:
                            raise ValueError("Duplicate identity consumer origin")
                        origins.append(dict(origin))
                    normalized = {**use, "origins": origins}
                else:
                    raise ValueError("Invalid handle identity use")
                if normalized in output:
                    raise ValueError("Duplicate handle identity use")
                output.append(normalized)
            return {"factoryArities": list(arities), "uses": output}

        if not isinstance(supplied, (list, tuple)) or len(supplied) > 128:
            raise ValueError("Return contract count limit exceeded")
        for contract in supplied:
            ident = contract.get("id")
            if not isinstance(ident, str) or not re.fullmatch(r"[a-z][a-z0-9.-]{0,127}", ident) or ident in ids or not 1 <= len(contract["origins"]) <= 16:
                raise ValueError("Invalid return contract identity")
            invocation = contract.get("invocation", "call")
            if invocation not in ("call", "construct"):
                raise ValueError("Invalid return contract invocation")
            ids.add(ident)
            result = shape(contract["result"], 0)
            identity = observations(contract["identityObservations"]) if "identityObservations" in contract else None
            if identity:
                if invocation != "construct":
                    for origin in contract["origins"]:
                        self.namespaceCalls.setdefault((origin["module"], origin["name"]), set()).update(identity["factoryArities"])
                for use in identity["uses"]:
                    if use["kind"] == "call-argument":
                        for origin in use["origins"]:
                            self.namespaceCalls.setdefault((origin["module"], origin["name"]), set()).add(use["arity"])
            for origin in contract["origins"]:
                step()
                module, name = origin.get("module"), origin.get("name")
                if not isinstance(module, str) or not isinstance(name, str) or not module or not name or len(module) + len(name) > 4096 or module.startswith((".", "/")) or "\\" in module:
                    raise ValueError("Invalid return contract origin")
                key = invocation, module, name
                if key in self.contracts:
                    raise ValueError("Conflicting return contract origins")
                self.contracts[key] = {"id": ident, "result": result, **({"identityObservations": identity} if identity else {})}
        self.hasIdentityObservations = any("identityObservations" in value for value in self.contracts.values())

    def staticKey(self, node):
        view = self.view
        if node.type == "computed_property_name":
            value = view.unwrap(node.children[0]) if node.children else None
            return self.staticKey(value) if value and value.type in ("string", "number") else None
        if node.type == "number":
            value = number(view.text(node))
            return int(value) if value is not None and 0 <= value <= 2**53 - 1 and int(value) == value else None
        value = view.name(node)
        return value if value is not None and len(value) * 3 <= view.limits["maxValueBytes"] else None

    def patternProjections(self, input):
        projections, work, complete = [], 0, True
        view = self.view

        def visit(node, path, depth):
            nonlocal work, complete
            work += 1
            if work > self.maxWork or depth > self.maxDepth or not view._step():
                complete = False
                return
            if node.type in ("identifier", "undefined", "shorthand_property_identifier_pattern"):
                projections.append({"node": node, "path": list(path)})
                return
            if node.type == "required_parameter":
                pattern = node.fields.get("pattern") or node.fields.get("name")
                if not pattern or node.fields.get("value"):
                    complete = False
                else:
                    visit(pattern, path, depth + 1)
                return
            if node.type == "array_pattern":
                for index, item in enumerate(view.elements(node)):
                    work += 1
                    if work > self.maxWork or not view._step():
                        complete = False
                        break
                    if item:
                        visit(item, [*path, index], depth + 1)
                return
            if node.type == "object_pattern":
                for item in node.children:
                    work += 1
                    if work > self.maxWork or not view._step():
                        complete = False
                        break
                    if item.type == "comment":
                        continue
                    if item.type == "shorthand_property_identifier_pattern":
                        key = self.staticKey(item)
                        if key is None:
                            complete = False
                        else:
                            visit(item, [*path, key], depth + 1)
                    elif item.type == "pair_pattern" and item.fields.get("key") and item.fields.get("value"):
                        key = self.staticKey(item.fields["key"])
                        if key is None:
                            complete = False
                        else:
                            visit(item.fields["value"], [*path, key], depth + 1)
                    else:
                        complete = False
                return
            complete = False

        visit(view.unwrap(input), [], 0)
        return {"complete": complete, "projections": projections}

    @staticmethod
    def observe(node, timing="start"):
        if timing == "start":
            return {"node": node, "offset": node.startIndex}
        if timing != "before-call":
            raise ValueError("Invalid reference observation timing")
        arguments = node.fields.get("arguments") or node
        return {"node": node, "offset": max(node.startIndex, arguments.endIndex - 1), "delivery": arguments}

    def project(self, input, input_path=(), reference_observation=None):
        view, work, active = self.view, 0, set()

        def step(depth):
            nonlocal work
            work += 1
            return work <= self.maxWork and depth <= self.maxDepth and view._step()

        def args(node):
            arguments = node.fields.get("arguments")
            if arguments is None or arguments.type != "arguments":
                return None
            values = [item for item in arguments.children if item.type != "comment"]
            return values if len(values) <= 16 and not any(item.type == "spread_element" for item in values) else None

        def canonical_import(input_node, observation, depth):
            origin = view.resolve(input_node)
            if origin["kind"] != "import" or origin.get("member") or origin["name"] == "*":
                return None

            def namespace(input, depth):
                if not step(depth):
                    return None
                node = view.unwrap(input)
                binding = view.binding(node)
                if node.type != "identifier" or not binding or not binding["stable"] or not binding["available"] or binding["typeOnly"]:
                    return None
                if binding.get("origin", {}).get("name") == "*":
                    return binding["origin"]["module"]
                source = view._binding_sources.get(binding.get("declaration"))
                return namespace(source["initializer"], depth + 1) if binding["kind"] == "const" and source and source["complete"] and not source["path"] else None

            def stable(input, depth):
                if not step(depth):
                    return False
                node = view.unwrap(input)
                if node.type == "member_expression" and not _optional(node) and node.fields.get("object") and node.fields.get("property"):
                    return stable(node.fields["object"], depth + 1)
                binding = view.binding(node)
                if not binding or not binding["available"] or not binding["stable"] or binding["typeOnly"]:
                    return False
                module = namespace(node, depth + 1)

                def preserves_namespace(occurrence, jsx_tag):
                    if not step(depth + 1) or jsx_tag or occurrence.type != "call_expression" or _optional(occurrence):
                        return False
                    fn = view.unwrap(occurrence.fields["function"]) if occurrence.fields.get("function") else None
                    arguments = args(occurrence)
                    if not fn or fn.type != "member_expression" or _optional(fn) or not fn.fields.get("object") or not fn.fields.get("property") or arguments is None or namespace(fn.fields["object"], depth + 1) != module:
                        return False
                    member = view.name(fn.fields["property"])
                    return bool(member and len(arguments) in self.namespaceCalls.get((module, member), ()))

                if not view.stableObject(node, observation["node"], observation["offset"], observation.get("delivery"), preserves_namespace if module else None):
                    return False
                if binding.get("origin"):
                    return True
                source = view._binding_sources.get(binding.get("declaration"))
                return binding["kind"] == "const" and bool(source and source["complete"] and stable(source["initializer"], depth + 1))

            return origin if stable(input_node, depth) else None

        def handle_identity(input_node, observation, depth):
            if not step(depth):
                return None
            node = view.unwrap(input_node)
            binding = view.binding(node)
            if node.type == "identifier" and binding and binding["kind"] == "const" and binding["available"] and binding["stable"] and not binding["typeOnly"]:
                source = view._binding_sources.get(binding.get("declaration"))
                return handle_identity(source["initializer"], observation, depth + 1) if source and source["complete"] and not source["path"] else None
            callee = node.fields.get("constructor") if node.type == "new_expression" else node.fields.get("function") if node.type == "call_expression" else None
            if not callee or _optional(node) or _optional(view.unwrap(callee)):
                return None
            origin, arguments = canonical_import(callee, observation, depth + 1), args(node)
            contract = self.contracts.get(("construct" if node.type == "new_expression" else "call", origin["module"], origin["name"])) if origin else None
            return {"contract": contract, "factory": node} if contract and contract.get("identityObservations") and arguments is not None and len(arguments) in contract["identityObservations"]["factoryArities"] else None

        def preserves_identity(node, observation, depth):
            if not self.hasIdentityObservations:
                return None
            identity = handle_identity(node, observation, depth + 1)
            if not identity:
                return None

            def same_handle(input):
                candidate = handle_identity(input, observation, depth + 1)
                return candidate and candidate["factory"] is identity["factory"] and candidate["contract"]["id"] == identity["contract"]["id"]

            def preserves(occurrence, jsx_tag):
                if not step(depth + 1):
                    return False
                for use in identity["contract"]["identityObservations"]["uses"]:
                    if not step(depth + 1):
                        return False
                    if use["kind"] == "receiver-call" and occurrence.type == "call_expression" and not _optional(occurrence):
                        fn = view.unwrap(occurrence.fields["function"]) if occurrence.fields.get("function") else None
                        arguments = args(occurrence)
                        if fn and fn.type == "member_expression" and not _optional(fn) and fn.fields.get("object") and fn.fields.get("property") and view.name(fn.fields["property"]) == use["member"] and arguments is not None and len(arguments) == use["arity"] and same_handle(fn.fields["object"]):
                            return True
                    if use["kind"] == "call-argument" and occurrence.type == "arguments":
                        call = view.parent(occurrence)
                        if not call or call.type != "call_expression" or call.fields.get("arguments") is not occurrence:
                            continue
                        arguments = args(call)
                        argument = arguments[use["index"]] if arguments is not None and len(arguments) > use["index"] else None
                        if not call.fields.get("function") or _optional(call) or arguments is None or len(arguments) != use["arity"] or not argument or not same_handle(argument):
                            continue
                        origin = canonical_import(call.fields["function"], self.observe(call, "before-call"), depth + 1)
                        if origin and any(expected["module"] == origin["module"] and expected["name"] == origin["name"] for expected in use["origins"]):
                            return True
                    if use["kind"] == "jsx-member" and jsx_tag and occurrence.type in ("jsx_opening_element", "jsx_self_closing_element"):
                        tag = occurrence.fields.get("name")
                        if tag and tag.type == "member_expression" and not _optional(tag) and tag.fields.get("object") and tag.fields.get("property") and view.name(tag.fields["property"]) == use["member"] and same_handle(tag.fields["object"]):
                            return True
                return False

            return preserves

        def result(initializer, path, **extra):
            return {"initializer": initializer, "path": list(path), "complete": True, **extra}

        def follows_shape(value, path, depth):
            if not step(depth):
                return False
            if not path:
                return True
            key = path[0]
            if value["kind"] == "record":
                return len(js_string(key)) * 3 <= view.limits["maxValueBytes"] and follows_shape(value["value"], path[1:], depth + 1)
            if value["kind"] == "tuple":
                index = _index(key)
                return 0 <= index < len(value["items"]) and follows_shape(value["items"][index], path[1:], depth + 1)
            if value["kind"] == "object":
                child = value["properties"].get(js_string(key))
                return bool(child and follows_shape(child, path[1:], depth + 1))
            return False

        def visit(input_node, path, depth, observed_at):
            if not step(depth) or len(path) > self.maxDepth:
                return None
            node = view.unwrap(input_node)
            observation = self.observe(node) if node.startIndex > observed_at["offset"] else observed_at
            if node in active:
                return None
            active.add(node)
            try:
                if node.type in ("identifier", "undefined", "shorthand_property_identifier"):
                    binding = view.binding(node)
                    if binding:
                        if not binding["available"] or binding["typeOnly"] or not binding["stable"]:
                            return None
                        preserves = preserves_identity(node, observation, depth) if path or reference_observation else None
                        if reference_observation and not view.stableObject(node, observation["node"], observation["offset"], observation.get("delivery"), preserves):
                            return None
                        source = view._binding_sources.get(binding.get("declaration"))
                        if source:
                            if not source["complete"] or ((path or reference_observation) and not view.stableObject(node, observation["node"], observation["offset"], observation.get("delivery"), preserves)):
                                return None
                            return visit(source["initializer"], [*source["path"], *path], depth + 1, observation if path or reference_observation else self.observe(source["initializer"]))
                        if binding.get("initializer") and binding["kind"] == "const":
                            return visit(binding["initializer"], path, depth + 1, observation if path or reference_observation else self.observe(binding["initializer"]))
                        if len(path) == 1 and isinstance(path[0], str) and binding.get("origin", {}).get("name") == "*":
                            return result(node, path)
                    return None if path else result(node, path)
                if node.type == "member_expression" and not _optional(node) and node.fields.get("object") and node.fields.get("property"):
                    key = self.staticKey(node.fields["property"])
                    return visit(node.fields["object"], [key, *path], depth + 1, observation) if key is not None else None
                if node.type == "subscript_expression" and not _optional(node) and node.fields.get("object") and node.fields.get("index"):
                    index = view.unwrap(node.fields["index"])
                    key = self.staticKey(index)
                    return visit(node.fields["object"], [key, *path], depth + 1, observation) if index.type in ("string", "number") and key is not None else None
                callee = node.fields.get("constructor") if node.type == "new_expression" else node.fields.get("function")
                if node.type in ("call_expression", "new_expression") and callee and not _optional(node) and not _optional(view.unwrap(callee)):
                    origin = view.resolve(callee)
                    contract = self.contracts.get(("construct" if node.type == "new_expression" else "call", origin["module"], origin["name"])) if origin["kind"] == "import" and not origin.get("member") else None
                    if not contract:
                        return None if path else result(node, path)
                    if contract.get("identityObservations") and not handle_identity(node, observation, depth + 1):
                        return None if path else result(node, path)
                    if node.type == "new_expression":
                        constructed = self.observe(node, "before-call")
                        if not self.project(callee, [], constructed if constructed["offset"] > observation["offset"] else observation):
                            return None
                    arguments_node = node.fields.get("arguments")
                    if arguments_node and (arguments_node.type != "arguments" or len(arguments_node.children) > self.maxWork):
                        return None
                    arguments = [item for item in arguments_node.children if item.type != "comment"] if arguments_node else []
                    if any(item.type == "spread_element" for item in arguments):
                        return None
                    shape = contract["result"]
                    if shape["kind"] != "key-partitions":
                        return result(node, path, contract=contract["id"]) if follows_shape(shape, path, depth + 1) else None
                    source = arguments[shape["sourceArgument"]] if len(arguments) > shape["sourceArgument"] else None
                    groups = arguments[shape["keysFromArgument"]:]
                    if not source or len(groups) > 16:
                        return None
                    claimed, keys, key_bytes = set(), [], 0
                    for group in groups:
                        if not step(depth + 1):
                            return None
                        literal = view.unwrap(group)
                        if literal.type != "array" or len(view.elements(literal)) > 64:
                            return None
                        values = []
                        for element in view.elements(literal):
                            if not step(depth + 1) or not element:
                                return None
                            key_node = view.unwrap(element)
                            key = decodeString(view.text(key_node)) if key_node.type == "string" else None
                            if key is None:
                                return None
                            key_bytes += len(key) * 3
                            if key in claimed or len(claimed) >= 64 or key_bytes > view.limits["maxValueBytes"]:
                                return None
                            claimed.add(key)
                            values.append(key)
                        keys.append(values)
                    if path:
                        index = _index(path[0])
                        if index < 0 or index > len(keys) or len(path) > 2:
                            return None
                        if len(path) == 2 and (js_string(path[1]) in claimed if index == len(keys) else js_string(path[1]) not in keys[index]):
                            return None
                    return result(node, path, contract=contract["id"], partitions={"source": source, "keys": keys})
                if not path:
                    return result(node, path)
                key = path[0]
                if node.type == "array":
                    items = view.elements(node)
                    if len(items) > self.maxWork or any(item and item.type == "spread_element" for item in items):
                        return None
                    index = _index(key)
                    item = items[index] if 0 <= index < len(items) else None
                    return visit(item, path[1:], depth + 1, observation if len(path) > 1 or reference_observation else self.observe(item)) if item else None
                if node.type == "object":
                    selected = None
                    for item in node.children:
                        if not step(depth + 1):
                            return None
                        if item.type == "comment":
                            continue
                        if item.type == "spread_element":
                            value = next((child for child in item.children if child.type != "comment"), None)
                            selected = visit(value, path, depth + 1, observation) if value else None
                            continue
                        if item.type == "shorthand_property_identifier":
                            if view.name(item) == js_string(key):
                                selected = visit(item, path[1:], depth + 1, observation if len(path) > 1 or reference_observation else self.observe(item))
                            continue
                        if item.type != "pair" or not item.fields.get("key") or not item.fields.get("value"):
                            selected = None
                            continue
                        prop = self.staticKey(item.fields["key"])
                        if prop == "__proto__":
                            return None
                        if prop is None:
                            selected = None
                        elif js_string(prop) == js_string(key):
                            value = item.fields["value"]
                            selected = visit(value, path[1:], depth + 1, observation if len(path) > 1 or reference_observation else self.observe(value))
                    return selected
                return None
            finally:
                active.remove(node)

        return visit(input, list(input_path), 0, reference_observation or self.observe(input))

    def referenceStable(self, input, observation, timing="start"):
        value = self.project(input, [], self.observe(observation, timing))
        if not value or value["path"]:
            return False
        node = value["initializer"]
        if node.type in ("identifier", "undefined", "shorthand_property_identifier"):
            return bool((self.view.binding(node) or {}).get("available"))
        if node.type in ("call_expression", "new_expression"):
            return bool(value.get("contract"))
        return node.type in ("object", "array", "string", "number", "true", "false", "null", "arrow_function", "function_expression", "function_declaration", "generator_function", "generator_function_declaration", "method_definition")
