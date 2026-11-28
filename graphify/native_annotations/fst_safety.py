"""Private FST family invalidation, not public alias or execution evidence."""

from .fst_rules import canonical_api

_FUNCTIONS = {
    "function_expression",
    "function_declaration",
    "generator_function",
    "generator_function_declaration",
}
_PROXY_HOOKS = ("isIgnoredProxyMember", "buildMember", "build", "buildClassProxyMembers")


def family_safety(view, budget, classes, lifetime_names):
    changes, static_changes = {}, {}
    limited = False

    def mark(root, name="*", statics_only=False):
        for info in [root["info"], *root.get("peers", ())]:
            maps = (
                [static_changes]
                if statics_only
                else [changes, static_changes]
                if root["kind"] == "class"
                else [changes]
            )
            for mapping in maps:
                mapping.setdefault(info["declaration"]["key"], set()).add(
                    "*" if name in (None, "__proto__") else name
                )

    def member_name(node):
        key = node.fields.get(
            "property"
            if node.type == "member_expression"
            else "index"
            if node.type == "subscript_expression"
            else "name"
        )
        return (
            view.name(key)
            if key is not None and (node.type != "subscript_expression" or key.type == "string")
            else None
        )

    def class_this(node):
        cursor = view.parent(node)
        while cursor is not None:
            budget.step()
            if cursor.type in _FUNCTIONS or cursor.type == "class_static_block":
                return None
            if cursor.type in ("method_definition", "public_field_definition"):
                if (
                    "static" not in cursor.tokens
                    and cursor.type == "method_definition"
                    and member_name(cursor) != "constructor"
                ):
                    return None
                body = view.parent(cursor)
                owner = view.parent(body) if body is not None else None
                declaration = view.declarationAt(owner) if owner is not None else None
                info = classes.get(declaration["key"]) if declaration else None
                return (
                    {"info": info, "kind": "class" if "static" in cursor.tokens else "instance"}
                    if info
                    else None
                )
            cursor = view.parent(cursor)
        return None

    def root_of(input_node, seen=None):
        nonlocal limited
        budget.step()
        node = view.unwrap(input_node)
        seen = set() if seen is None else seen
        if id(node) in seen:
            return None
        if len(seen) >= 24:
            limited = True
            return None
        seen.add(id(node))
        if node.type == "this":
            return class_this(node)
        binding = view.binding(node)
        if binding:
            info = classes.get(binding.get("declaration"))
            if info:
                return {"info": info, "kind": "class"}
            origin = binding.get("origin")
            if origin:
                supported = [
                    family
                    for name, family in (
                        ("State", "state"),
                        ("Form", "form"),
                        ("Scope", "scope"),
                        ("ItemScope", "item-scope"),
                    )
                    if origin["name"] in (name, "*")
                    and canonical_api(origin["module"], name) == name
                ]
                peers = [
                    candidate for candidate in classes.values() if candidate["family"] in supported
                ]
                if peers:
                    return {"info": peers[0], "peers": peers[1:], "kind": "class"}
            # Writes deliberately follow unstable aliases as well.
            if binding["kind"] == "const" and binding.get("initializer") is not None:
                return root_of(binding["initializer"], seen)
            return None
        if (
            node.type in ("member_expression", "subscript_expression")
            and node.fields.get("object") is not None
        ):
            root = root_of(node.fields["object"], seen)
            if root and root["kind"] == "class" and member_name(node) == "prototype":
                return {**root, "kind": "prototype"}
        return None

    def expose(input_node, seen=None):
        nonlocal limited
        budget.step()
        node = view.unwrap(input_node)
        seen = set() if seen is None else seen
        if id(node) in seen:
            return
        if node.type == "binary_expression" and "instanceof" in node.tokens:
            if node.fields.get("left") is not None:
                expose(node.fields["left"], seen)
            return
        if node.type in (
            "string",
            "number",
            "true",
            "false",
            "null",
            "comment",
            "property_identifier",
        ):
            return
        if node.type == "pair" and node.fields.get("value") is not None:
            expose(node.fields["value"], seen)
            return
        if node.type.startswith("jsx_"):
            pending = [node]
            while pending:
                budget.step()
                child = pending.pop()
                if child.type == "jsx_expression":
                    for value in child.children:
                        expose(value, seen)
                else:
                    pending.extend(child.children)
            return
        if len(seen) >= 4096:
            limited = True
            return
        seen.add(id(node))
        root = root_of(node)
        if root:
            mark(root)
            return
        binding = view.binding(node)
        if binding:
            if binding["kind"] == "const" and binding.get("initializer") is not None:
                expose(binding["initializer"], seen)
            return
        if node.type in ("call_expression", "new_expression"):
            return
        if node.type in _FUNCTIONS or node.type == "arrow_function":
            body = node.fields.get("body")
            if body is None:
                return
            if body.type != "statement_block":
                expose(body, seen)
                return
            pending = list(body.children)
            while pending:
                budget.step()
                child = pending.pop()
                if child.type == "return_statement":
                    for value in child.children:
                        expose(value, seen)
                elif child.type not in _FUNCTIONS and child.type != "arrow_function":
                    pending.extend(child.children)
            return
        if (
            node.type in ("member_expression", "subscript_expression")
            and node.fields.get("object") is not None
        ):
            expose(node.fields["object"], seen)
            return
        for child in node.children:
            expose(child, seen)

    def write(input_node):
        budget.step()
        node = view.unwrap(input_node)
        if (
            node.type in ("member_expression", "subscript_expression")
            and node.fields.get("object") is not None
        ):
            root, name = root_of(node.fields["object"]), member_name(node)
            if root and root["kind"] == "class":
                if name in ("prototype", None, "__proto__"):
                    mark(root)
                else:
                    mark(root, name, True)
            elif root:
                mark(root, name if name is not None else "*")
            else:
                expose(node.fields["object"])
            return
        children = (
            [node.fields["value"]]
            if node.type == "pair_pattern" and node.fields.get("value") is not None
            else node.children
        )
        for child in children:
            write(child)

    for node in view.nodes if classes else ():
        budget.step()
        if (
            node.type
            in (
                "assignment_expression",
                "augmented_assignment_expression",
                "update_expression",
                "for_in_statement",
            )
            or node.type == "unary_expression"
            and "delete" in node.tokens
        ):
            target = node.fields.get("left") or node.fields.get("argument")
            if target is not None:
                write(target)
            if node.fields.get("right") is not None:
                expose(node.fields["right"])
        if node.type == "jsx_expression":
            for value in node.children:
                expose(value)
        if node.type not in ("call_expression", "new_expression"):
            continue
        fn = node.fields.get("function") or node.fields.get("constructor")
        if fn is not None and fn.fields.get("object") is not None:
            root, name = root_of(fn.fields["object"]), member_name(fn)
            if root and root["kind"] == "prototype":
                mark(root)
            if root and root["kind"] == "class" and (not name or name not in lifetime_names):
                mark(root)
            if root and root["kind"] == "instance":
                body = root["info"]["node"].fields.get("body")
                declared = body is not None and any(
                    member_name(child) == name for child in body.children
                )
                if declared or name not in ("field", "form", "onReady", "onChange"):
                    mark(root)
        arguments = node.fields.get("arguments")
        for arg in arguments.children if arguments is not None else ():
            if (
                fn is not None
                and member_name(fn) == "asScoped"
                and fn.fields.get("object") is not None
            ):
                root = root_of(fn.fields["object"])
                if root and root["kind"] == "class":
                    continue
            expose(arg)

    def changed_in(mapping, info, name):
        if limited:
            return True
        current = info
        while current:
            budget.step()
            names = mapping.get(current["declaration"]["key"], ())
            if "*" in names or name in names:
                return True
            current = current.get("base")
        return False

    def changed(info, name):
        return changed_in(changes, info, name)

    def static_changed(info, name):
        return changed_in(static_changes, info, name)

    def custom_proxy(info):
        if any(changed(info, name) for name in _PROXY_HOOKS):
            return True
        current = info
        while current:
            budget.step()
            body = current["node"].fields.get("body")
            for child in body.children if body is not None else ():
                name = child.fields.get("name")
                if "static" not in child.tokens and (
                    (name is not None and name.type == "computed_property_name")
                    or member_name(child) in _PROXY_HOOKS
                ):
                    return True
            current = current.get("base")
        return False

    return {"changed": changed, "staticChanged": static_changed, "customProxy": custom_proxy}
