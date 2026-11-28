"""Safe, bounded literal evaluation; no source expression is executed."""

from __future__ import annotations

import math
import re


UNDEFINED = object()


def unknown(reason):
    return {"known": False, "reason": reason}


def primitive(value=UNDEFINED, resolution="literal"):
    result = {"known": True, "resolution": resolution}
    if value is not UNDEFINED:
        if isinstance(value, float) and value.is_integer() and abs(value) <= 2**53 - 1 and (value != 0 or math.copysign(1, value) > 0):
            value = int(value)
        result["value"] = value
    return result


def decodeFragment(text):
    parts, index = [], 0
    simple = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
    while index < len(text):
        char = text[index]
        index += 1
        if char != "\\":
            if char == "\r":
                if index < len(text) and text[index] == "\n":
                    index += 1
                char = "\n"
            parts.append(char)
            continue
        if index == len(text):
            return None
        char = text[index]
        index += 1
        if char == "\n":
            continue
        if char == "\r":
            if index < len(text) and text[index] == "\n":
                index += 1
            continue
        if char in simple:
            if char == "0" and index < len(text) and text[index] in "0123456789":
                return None
            parts.append(simple[char])
            continue
        if char in "123456789":
            return None
        if char in ("x", "u"):
            braced = char == "u" and index < len(text) and text[index] == "{"
            start = index + 1 if braced else index
            end = text.find("}", start) if braced else index + (2 if char == "x" else 4)
            digits = text[start:end]
            if end < 0 or end > len(text) or not re.fullmatch(r"[0-9a-fA-F]+", digits):
                return None
            point = int(digits, 16)
            if point > 0x10ffff:
                return None
            parts.append(chr(point))
            index = end + 1 if braced else end
            continue
        parts.append(char)
    # JS escape pairs represent one Unicode scalar; lone surrogates are retained
    # until the evidence validator rejects them, never silently replaced.
    value = "".join(parts)
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def decodeString(text):
    if len(text) < 2 or text[0] not in ("'", '"', "`") or text[-1] != text[0]:
        return None
    return decodeFragment(text[1:-1])


def decodeIdentifier(text):
    if "\\" in text:
        value = decodeString('"' + text + '"')
        if value is not None:
            return value
    return text


def number(text):
    source = text.replace("_", "")
    try:
        value = float(int(source, 0)) if source.lower().startswith(("0x", "0o", "0b")) else float(source)
    except (ValueError, OverflowError):
        return None
    if not math.isfinite(value):
        return None
    return int(value) if value.is_integer() and abs(value) <= 2**53 - 1 and (value != 0 or math.copysign(1, value) > 0) else value


def js_string(value):
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        if value == 0:
            return "0"
        if isinstance(value, int):
            return str(value)
        # Python and JS use the same shortest round-trippable double digits,
        # but JS switches to exponential notation only outside [1e-6, 1e21).
        sign = "-" if value < 0 else ""
        mantissa, _, exponent = repr(abs(value)).lower().partition("e")
        whole, _, fraction = mantissa.partition(".")
        digits = (whole + fraction).lstrip("0").rstrip("0")
        position = len(whole) + int(exponent or 0)
        if whole == "0":
            position -= len(whole + fraction) - len((whole + fraction).lstrip("0"))
        if 1e-6 <= abs(value) < 1e21:
            if position <= 0:
                return sign + "0." + "0" * -position + digits
            if position >= len(digits):
                return sign + digits + "0" * (position - len(digits))
            return sign + digits[:position] + "." + digits[position:]
        power = position - 1
        return sign + digits[0] + ("." + digits[1:] if len(digits) > 1 else "") + "e" + ("+" if power >= 0 else "") + str(power)
    return str(value)


class ConstantQueries:
    def __init__(self, view):
        self.view = view

    def constant(self, input):
        view, active, work = self.view, set(), 0
        max_work, max_depth = min(view.limits["maxWork"], 512), min(view.limits["maxDepth"], 24)

        def bounded(result):
            value = result.get("value")
            return unknown("value-limit") if isinstance(value, str) and len(value.encode("utf-16-le", "surrogatepass")) // 2 * 3 > view.limits["maxValueBytes"] else result

        def evaluate(input_node, depth):
            nonlocal work
            work += 1
            if work > max_work or depth > max_depth:
                return unknown("constant-limit")
            node = view.unwrap(input_node)
            if node in active:
                return unknown("constant-cycle")
            active.add(node)
            try:
                source = view.text(node)
                if node.type == "string":
                    value = decodeString(source)
                    return unknown("string-escape") if value is None else bounded(primitive(value))
                if node.type in ("true", "false"):
                    return primitive(node.type == "true")
                if node.type == "null":
                    return primitive(None)
                if node.type == "number":
                    if source.endswith("n"):
                        return unknown("bigint")
                    value = number(source)
                    return primitive(value) if value is not None else unknown("number")
                if node.type in ("identifier", "undefined", "shorthand_property_identifier"):
                    binding = view.binding(node)
                    if source == "undefined" and binding is None:
                        return primitive()
                    if not binding or not binding["available"] or binding["kind"] != "const" or not binding["stable"]:
                        return unknown("mutable-or-unresolved-binding")
                    projection = view.project(node) if not binding.get("initializer") else None
                    initial = binding.get("initializer") or (projection["initializer"] if projection and not projection["path"] else None)
                    if initial is None or initial is node:
                        return unknown("mutable-or-unresolved-binding")
                    result = evaluate(initial, depth + 1)
                    if not result["known"]:
                        return result
                    if isinstance(result.get("value"), dict) and not (view.stableObject(node) and view.referenceStable(node, node)):
                        return unknown("mutable-or-escaped-object")
                    return {**result, "resolution": "constant"}
                if node.type == "template_string":
                    value, cursor = "", node.startIndex + 1
                    substitutions = [child for child in node.children if child.type == "template_substitution"]
                    for substitution in substitutions:
                        fragment = decodeFragment(view.slice_bytes(cursor, substitution.startIndex))
                        argument = next(iter(substitution.children), None)
                        result = evaluate(argument, depth + 1) if argument else None
                        if fragment is None or not result or not result["known"] or isinstance(result.get("value"), dict):
                            return unknown("template-expression")
                        value += fragment + js_string(result.get("value", UNDEFINED))
                        cursor = substitution.endIndex
                        if len(value) * 3 > view.limits["maxValueBytes"]:
                            return unknown("value-limit")
                    tail = decodeFragment(view.slice_bytes(cursor, node.endIndex - 1))
                    return unknown("template-escape") if tail is None else bounded(primitive(value + tail, "constant" if substitutions else "literal"))
                if node.type == "unary_expression":
                    argument = node.fields.get("argument") or next(iter(node.children), None)
                    result = evaluate(argument, depth + 1) if argument else None
                    if not result or not result["known"] or isinstance(result.get("value"), dict):
                        return unknown("unary-expression")
                    value = result.get("value", UNDEFINED)
                    operator = next(iter(node.tokens), None)
                    if operator == "void":
                        return primitive(resolution="constant")
                    if operator == "!":
                        return primitive(value is UNDEFINED or not value, "constant")
                    if operator in ("-", "+") and type(value) in (int, float):
                        return primitive(-float(value) if operator == "-" else value, "constant")
                    return unknown("unary-operator")
                if node.type == "binary_expression" and "+" in node.tokens:
                    left = evaluate(node.fields["left"], depth + 1) if node.fields.get("left") else None
                    right = evaluate(node.fields["right"], depth + 1) if node.fields.get("right") else None
                    if not left or not right or not left["known"] or not right["known"]:
                        return unknown("binary-expression")
                    a, b = left.get("value", UNDEFINED), right.get("value", UNDEFINED)
                    if a is None or b is None or isinstance(a, dict) or isinstance(b, dict):
                        return unknown("object-coercion")
                    if isinstance(a, str) or isinstance(b, str):
                        return bounded(primitive(js_string(a) + js_string(b), "constant"))
                    if type(a) in (int, float) and type(b) in (int, float) and math.isfinite(float(a) + float(b)):
                        return primitive(float(a) + float(b), "constant")
                    return unknown("binary-operands")
                if node.type == "object":
                    properties, unknown_keys = {}, False
                    for child in node.children:
                        work += 1
                        if work > max_work:
                            return unknown("constant-limit")
                        if child.type == "comment":
                            continue
                        if child.type == "spread_element":
                            argument = next(iter(child.children), None)
                            result = evaluate(argument, depth + 1) if argument else None
                            value = result.get("value") if result and result["known"] else None
                            if isinstance(value, dict):
                                if value["unknownKeys"]:
                                    properties, unknown_keys = {}, True
                                properties.update({key: {**item, "resolution": "constant"} if item["known"] else item for key, item in value["properties"].items()})
                            else:
                                properties, unknown_keys = {}, True
                            continue
                        if child.type == "shorthand_property_identifier":
                            properties[decodeIdentifier(view.text(child))] = evaluate(child, depth + 1)
                            continue
                        key = child.fields.get("key")
                        if child.type != "pair" or not key or key.type not in ("property_identifier", "string", "number"):
                            properties, unknown_keys = {}, True
                            continue
                        name = decodeString(view.text(key)) if key.type == "string" else decodeIdentifier(view.text(key))
                        if name is None or name == "__proto__":
                            properties, unknown_keys = {}, True
                            continue
                        properties[name] = evaluate(child.fields["value"], depth + 1) if child.fields.get("value") else unknown("property-value")
                    return {"known": True, "resolution": "constant", "value": {"kind": "object", "properties": properties, "unknownKeys": unknown_keys}}
                if node.type == "member_expression" and "?." not in node.tokens and node.fields.get("object") and node.fields.get("property"):
                    obj = evaluate(node.fields["object"], depth + 1)
                    if obj["known"] and isinstance(obj.get("value"), dict):
                        result = obj["value"]["properties"].get(decodeIdentifier(view.text(node.fields["property"])))
                        return {**result, "resolution": "constant"} if result and result["known"] else result or unknown("unknown-property")
                return unknown("unsupported-expression")
            finally:
                active.remove(node)

        return evaluate(input, 0)

    def constantProperty(self, node, key):
        result = self.constant(node)
        if not result["known"] or not isinstance(result.get("value"), dict):
            return unknown("unknown-options")
        value = result["value"]
        prop = value["properties"].get(key, unknown("unknown-spread-or-key" if value["unknownKeys"] else "absent"))
        return {**prop, "resolution": "constant"} if prop["known"] and self.view.unwrap(node).type != "object" else prop
