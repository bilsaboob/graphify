"""Bounded native plugin execution and emission; no framework-specific rules."""

from __future__ import annotations

import hashlib
import json
import logging

from graphify.framework_evidence import _result


def _canonical(value) -> str:
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    for char in ("<", ">", "&", "\u2028", "\u2029"):
        text = text.replace(char, f"\\u{ord(char):04x}")
    return text


class BudgetExceeded(RuntimeError):
    pass


class Budget:
    def __init__(self, limits):
        self.limits = limits
        self.consumedWork = 0
        self.consumedDepth = 0

    def step(self, amount=1):
        self.consumedWork += amount
        if self.consumedWork > self.limits["maxWork"]:
            raise BudgetExceeded("work")

    def depth(self, depth):
        self.consumedDepth = max(self.consumedDepth, depth)
        if depth > self.limits["maxDepth"]:
            raise BudgetExceeded("depth")

    def isCancelled(self):
        return False


class Emitter:
    def __init__(self, descriptor, declarations, limits, remaining, budget):
        self.plugin_id = descriptor["id"]
        self.declarations = declarations
        self.limits = limits
        self.remaining = remaining
        self.budget = budget
        self.facts = {}
        self.properties = {p["id"]: p for p in descriptor["properties"]}
        self.values = {}
        self.truncated = False

    def _emit(self, fact, evidence):
        self.budget.step()
        if fact["subject"] not in self.declarations:
            self.truncated = True
            return False
        fact["evidence"] = {**evidence, "pluginId": self.plugin_id}
        key = _canonical(fact)
        if key in self.facts:
            return True
        size = len(key.encode("utf-8")) + 1
        if len(self.facts) >= self.remaining[0] or size > self.remaining[1]:
            self.truncated = True
            return False
        self.remaining[1] -= size
        self.facts[key] = fact
        return True

    def role(self, subject, term, evidence):
        return self._emit({"kind": "role", "subject": subject, "term": term}, evidence)

    def property(self, subject, term, resolution, value, evidence):
        fact = {"kind": "property", "subject": subject, "term": term, "resolution": resolution}
        if resolution not in ("expression", "absent"):
            fact["value"] = value
            if len(_canonical(value).encode("utf-8")) > self.limits["maxValueBytes"]:
                self.truncated = True
                return False
        if not self.properties[term]["multiple"]:
            key = (subject, term)
            identity = _canonical({k: fact[k] for k in ("resolution", "value") if k in fact})
            if key in self.values and self.values[key] != identity:
                raise ValueError("Conflicting single-valued annotation property")
            self.values[key] = identity
        return self._emit(fact, evidence)

    def relation(self, subject, term, target, evidence):
        if len(_canonical(target).encode("utf-8")) > self.limits["maxValueBytes"]:
            self.truncated = True
            return False
        if target.get("kind") == "declaration" and target.get("key") not in self.declarations:
            self.truncated = True
            return False
        return self._emit({"kind": "relation", "subject": subject, "term": term, "target": target}, evidence)


def analyze_source(source: bytes, tree, relative_path: str, language: str, run) -> dict:
    from . import plugins
    from .typescript import TypeScriptView

    limits = run.options["limits"]
    source_hash = hashlib.sha256(source).hexdigest()
    installed = plugins()
    contracts = [contract for plugin in installed for contract in getattr(plugin, "RETURN_CONTRACTS", ())]
    view = TypeScriptView(source, tree, relative_path=relative_path, language=language,
                          source_hash=source_hash, limits=limits,
                          module_aliases=run.options["moduleAliases"], return_contracts=contracts)
    result = {"version": 1, "analysisSetId": run.manifest["id"], "sourceHash": source_hash,
              "relativePath": relative_path, "language": language, "state": "not-applicable",
              "declarations": list(view.declarations), "facts": [], "reports": [], "diagnostics": []}
    diagnostics_left = limits["maxDiagnostics"]

    def retain_diagnostics(items):
        nonlocal diagnostics_left
        kept, seen = [], set()
        for item in items:
            key = _canonical(item)
            if key not in seen and diagnostics_left and len(item["message"].encode("utf-8")) <= limits["maxValueBytes"]:
                kept.append(item)
                diagnostics_left -= 1
                seen.add(key)
        return kept

    result["diagnostics"] = retain_diagnostics(view.diagnostics)
    declarations = {d["key"] for d in result["declarations"]}
    # Reserve diagnostics and coverage before emitting; prefixes remain bounded.
    remaining = [limits["maxFacts"], limits["maxResultBytes"] - len(_canonical(result).encode("utf-8")) - 4096]
    budget = Budget(limits)
    for plugin in installed:
        descriptor = plugin.DESCRIPTOR
        report = {"pluginId": descriptor["id"], "state": "not-applicable", "diagnostics": []}
        result["reports"].append(report)
        if language not in descriptor["languages"]:
            continue
        if view.state in ("unsupported", "failed", "truncated"):
            report["state"] = view.state
            continue
        emitter = Emitter(descriptor, declarations, limits, remaining, budget)
        before_bytes = remaining[1]
        try:
            outcome = plugin.analyze(view, budget, emitter) or {}
            report["state"] = outcome.get("state", "complete" if emitter.facts else "not-applicable")
            diagnostics = outcome.get("diagnostics", [])
            report["diagnostics"] = retain_diagnostics(diagnostics)
            if emitter.truncated or len(report["diagnostics"]) < len(diagnostics):
                report["state"] = "truncated"
        except BudgetExceeded:
            report["state"] = "truncated"
            report["diagnostics"] = retain_diagnostics([{"code": "core.budget-limit", "message": "Native annotation work or depth limit reached."}])
        except Exception:
            logging.getLogger(__name__).debug("Native annotation plugin failed: %s", descriptor["id"], exc_info=True)
            report["state"] = "failed"
            report["diagnostics"] = retain_diagnostics([{"code": "core.plugin-failed", "message": "Native annotation plugin failed; its facts were discarded."}])
        if report["state"] in ("failed", "unsupported", "not-applicable") or (getattr(plugin, "ATOMIC", False) and report["state"] != "complete"):
            remaining[1] = before_bytes
        else:
            result["facts"].extend(emitter.facts.values())
            remaining[0] -= len(emitter.facts)
    states = {report["state"] for report in result["reports"]}
    result["state"] = (
        view.state if view.state in ("unsupported", "failed") else
        "partial" if "failed" in states else
        "truncated" if "truncated" in states else
        "partial" if view.state == "partial" or states & {"partial", "unsupported"} else
        "not-applicable" if states == {"not-applicable"} else "complete"
    )
    result["facts"].sort(key=_canonical)
    _result(result, run.manifest, view.source)
    return {"producer": run.producer, "source": view.source, "result": result}
