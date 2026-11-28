"""Lossless, source-owned framework evidence and graph-only readers.

This is a closed version-1 contract, not generic graph metadata. Wire records are
validated again when read from persisted graphs. No source files, compiler, model,
symbol-name resolver, sanitizer, or ordinary edge deduplicator participates here.
Unredacted credential-shaped source or evidence is rejected. Sanitized snapshots
have their own hash and explicit redaction provenance, never the original hash.

Limits reject entire inputs rather than clipping records. Reader pages count the
whole JSON response (``response_json``); an indivisible record that cannot fit is
reported as unsupported with the required size. Source excerpts alone are sliced,
at UTF-8 boundaries, with explicit byte continuation.
"""

from __future__ import annotations

import bisect
import copy
import hashlib
import json
import re
import weakref
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, NotRequired, TypedDict, cast

from graphify.framework_config import (
    MAX_ALIAS_PREFIX_LENGTH,
    MAX_OPTIONS_BYTES,
    FrameworkConfigurationError,
    normalize_analysis_options,
    normalize_module_aliases,
)
from graphify.security import (
    SOURCE_REDACTION_MASKS, SOURCE_REDACTION_POLICY, SOURCE_REDACTION_REGEX_MASKS, redact_secrets,
)


SEMANTIC_EVIDENCE_KEY = "semantic_evidence"
VERSION = 1
MAX_SAFE_INTEGER = (1 << 53) - 1
ANNOTATION_LIMITS = {
    "maxSourceBytes": 256 * 1024,
    "maxDeclarations": 2048,
    "maxFacts": 4096,
    "maxDiagnostics": 32,
    "maxResultBytes": 8 * 1024 * 1024,
    "maxManifestBytes": 64 * 1024,
    "maxPlugins": 32,
    "maxWork": 2_000_000,
    "maxDepth": 128,
    "maxValueBytes": 256 * 1024,
}

CoverageState = Literal[
    "complete", "not-applicable", "partial", "unsupported", "truncated", "failed"
]


class SourceSpan(TypedDict):
    startByte: int
    endByte: int
    startLine: int
    endLine: int


class DeclarationReference(TypedDict):
    kind: Literal["declaration"]
    key: str


class ImportReference(TypedDict):
    kind: Literal["import"]
    module: str
    name: str
    member: NotRequired[str]


class ExpressionReference(TypedDict):
    kind: Literal["expression"]
    text: str
    span: SourceSpan


class TypeReference(TypedDict):
    kind: Literal["type"]
    text: str
    span: SourceSpan


Reference = DeclarationReference | ImportReference | ExpressionReference | TypeReference


class StringValue(TypedDict):
    kind: Literal["string"]
    value: str


class BooleanValue(TypedDict):
    kind: Literal["boolean"]
    value: bool


class IntegerValue(TypedDict):
    kind: Literal["integer"]
    value: int


class ReferenceValue(TypedDict):
    kind: Literal["reference"]
    value: Reference


FactValue = StringValue | BooleanValue | IntegerValue | ReferenceValue


class FactEvidence(TypedDict):
    pluginId: str
    ruleId: str
    basis: Literal["syntax", "import-bound", "convention"]
    span: SourceSpan


class FactBase(TypedDict):
    subject: str
    term: str
    evidence: FactEvidence


class RoleFact(FactBase):
    kind: Literal["role"]


class PropertyFact(FactBase):
    kind: Literal["property"]
    resolution: Literal["literal", "constant", "expression", "absent"]
    value: NotRequired[FactValue]


class RelationFact(FactBase):
    kind: Literal["relation"]
    target: Reference


AnnotationFact = RoleFact | PropertyFact | RelationFact


class PropertyOperation(TypedDict):
    kind: Literal["property"]
    span: SourceSpan
    key: str


class ComputedPropertyOperation(TypedDict):
    kind: Literal["computed-property"]
    span: SourceSpan
    key: ExpressionReference


class IteratorOperation(TypedDict):
    kind: Literal["iterator", "iterator-rest"]
    span: SourceSpan
    index: int


class DefaultOperation(TypedDict):
    kind: Literal["default"]
    span: SourceSpan
    value: ExpressionReference


class RestOperation(TypedDict):
    kind: Literal["object-rest"]
    span: SourceSpan
    excludedKeys: list[str | ExpressionReference]


BindingOperation = (
    PropertyOperation
    | ComputedPropertyOperation
    | IteratorOperation
    | DefaultOperation
    | RestOperation
)


class ObjectShape(TypedDict):
    kind: Literal["object"]
    span: SourceSpan
    keys: list[str]


class TupleShape(TypedDict):
    kind: Literal["tuple"]
    span: SourceSpan
    length: int


class BindingOperationDescriptor(TypedDict):
    source: ExpressionReference
    sourceSpan: SourceSpan
    patternSpan: SourceSpan
    operations: list[BindingOperation]
    value: Literal["unknown"]
    shapes: NotRequired[list[ObjectShape | TupleShape]]


class Declaration(TypedDict):
    key: str
    kind: str
    span: SourceSpan
    exports: list[str]
    name: NotRequired[str]
    owner: NotRequired[str]
    nameSpan: NotRequired[SourceSpan]
    binding: NotRequired[BindingOperationDescriptor]
    writes: NotRequired[list[BindingOperationDescriptor]]
    computedName: NotRequired[ExpressionReference]


class AnnotationDiagnostic(TypedDict):
    code: str
    message: str
    span: NotRequired[SourceSpan]


class PluginReport(TypedDict):
    pluginId: str
    state: CoverageState
    diagnostics: list[AnnotationDiagnostic]


class VocabularyTerm(TypedDict):
    id: str
    label: str
    description: NotRequired[str]


class PropertyTerm(VocabularyTerm):
    valueKind: Literal["string", "boolean", "integer", "reference"]
    multiple: bool


class ViewDescriptor(TypedDict):
    id: str
    version: int


class ViewImplementation(ViewDescriptor):
    implementationDigest: str
    configurationDigest: str


class CoreImplementation(TypedDict):
    version: str
    implementationDigest: str
    configurationDigest: str


class AnnotationLimits(TypedDict):
    maxSourceBytes: int
    maxDeclarations: int
    maxFacts: int
    maxDiagnostics: int
    maxResultBytes: int
    maxManifestBytes: int
    maxPlugins: int
    maxWork: int
    maxDepth: int
    maxValueBytes: int


class PluginDescriptor(TypedDict):
    id: str
    version: str
    implementationDigest: str
    configurationDigest: str
    languages: list[str]
    view: ViewDescriptor
    roles: list[VocabularyTerm]
    properties: list[PropertyTerm]
    relations: list[VocabularyTerm]


class AnnotationManifest(TypedDict):
    version: Literal[1]
    id: str
    core: CoreImplementation
    view: ViewImplementation
    parserDigest: str
    plugins: list[PluginDescriptor]
    limits: AnnotationLimits


class AnnotationResult(TypedDict):
    version: Literal[1]
    analysisSetId: str
    sourceHash: str
    relativePath: str
    language: str
    state: CoverageState
    declarations: list[Declaration]
    facts: list[AnnotationFact]
    reports: list[PluginReport]
    diagnostics: list[AnnotationDiagnostic]


class ProducerConfiguration(TypedDict):
    moduleAliases: dict[str, str]


class Producer(TypedDict):
    id: Literal["graphify.frameworks"]
    version: Literal["1"]
    fingerprint: str
    configuration: ProducerConfiguration


class SourceRedaction(TypedDict):
    version: Literal[1]
    policy: str
    originalSourceHash: str
    ranges: list[SourceSpan]


class SourceDocument(TypedDict):
    source: str
    result: AnnotationResult
    redaction: NotRequired[SourceRedaction]


class FrameworkEvidencePayload(TypedDict):
    version: Literal[1]
    producer: Producer
    manifest: AnnotationManifest
    documents: list[SourceDocument]


class EvidenceDocument(SourceDocument):
    producer: Producer


class StoredDocument(EvidenceDocument):
    retained: NotRequired[EvidenceDocument]
    refreshFailed: NotRequired[Literal[True]]


class EvidenceStore(TypedDict):
    version: Literal[1]
    manifests: dict[str, AnnotationManifest]
    producers: dict[str, Producer]
    documents: dict[str, StoredDocument]


class EvidenceValidationError(ValueError):
    """Untrusted evidence does not satisfy the closed, bounded contract."""


@dataclass(frozen=True)
class EvidenceLimits:
    """Host bounds, independent of the smaller per-document manifest bounds.

    Defaults allow a 10,000-source corpus, a 32-MiB worker batch, a 256-MiB
    retained store, and 64-KiB reader pages. Callers may lower or raise these
    within the explicit ceilings below; over-limit evidence is never clipped.
    ``max_response_bytes`` is the allowed ceiling, not a requested page size.
    """

    max_payload_bytes: int = 32 * 1024 * 1024
    max_store_bytes: int = 256 * 1024 * 1024
    max_documents: int = 10_000
    max_manifests: int = 256
    max_work: int = 16_000_000
    max_depth: int = 128
    max_response_bytes: int = 1024 * 1024
    response_bytes: int = 64 * 1024
    max_page_items: int = 200
    excerpt_bytes: int = 4096

    def __post_init__(self) -> None:
        ceilings = {
            "max_payload_bytes": 256 * 1024 * 1024,
            "max_store_bytes": 1024 * 1024 * 1024,
            "max_documents": 100_000,
            "max_manifests": 4096,
            "max_work": 64_000_000,
            "max_depth": 128,
            "max_response_bytes": 8 * 1024 * 1024,
            "response_bytes": self.max_response_bytes,
            "max_page_items": 10_000,
            "excerpt_bytes": ANNOTATION_LIMITS["maxSourceBytes"],
        }
        for name, maximum in ceilings.items():
            _integer(getattr(self, name), 1, maximum)
        _require(self.response_bytes >= 256, "Response budget must be at least 256 bytes")
        _require(self.excerpt_bytes >= 4, "Excerpt budget must allow one UTF-8 character")


_HASH = re.compile(r"[a-f0-9]{64}\Z")
_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9._:/-]*\Z")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_STATES = ("complete", "not-applicable", "partial", "unsupported", "truncated", "failed")
_GOOD = ("complete", "not-applicable")
_CATEGORIES = {"role": "roles", "property": "properties", "relation": "relations"}


def _require(condition: Any, message: str) -> None:
    if not condition:
        raise EvidenceValidationError(message)


def _object(value: Any, required: tuple | list, optional: tuple = ()) -> dict[str, Any]:
    _require(type(value) is dict, "Expected a plain JSON object")
    _require(all(type(key) is str for key in value), "Invalid object key")
    _require(set(required) <= value.keys(), "Missing object property")
    _require(value.keys() <= set(required) | set(optional), "Unknown object property")
    return value


def _array(value: Any, maximum: int) -> list[Any]:
    _require(type(value) is list and len(value) <= maximum, "Invalid array or array limit")
    return value


def _utf8(value: str) -> bytes:
    try:
        return value.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise EvidenceValidationError("Invalid Unicode") from exc


def _text(value: Any, maximum: int = 2048, *, empty: bool = False) -> str:
    _require(type(value) is str and (empty or bool(value)), "Invalid text")
    _require(len(value) <= maximum and len(_utf8(value)) <= maximum, "Text byte limit")
    _require(not _CONTROL.search(value), "Invalid text control character")
    _require(redact_secrets(value) == value, "Credential-shaped evidence cannot be persisted")
    return value


def _integer(value: Any, minimum: int, maximum: int) -> int:
    _require(type(value) is int and minimum <= value <= maximum, "Invalid integer or limit")
    return value


def _enum(value: Any, values: tuple | dict) -> str:
    _require(type(value) is str and value in values, "Invalid enum value")
    return value


def _identifier(value: Any, maximum: int = 128) -> str:
    _text(value, maximum)
    _require(_IDENTIFIER.fullmatch(value), "Invalid identifier")
    return value


def _hash(value: Any) -> str:
    _require(type(value) is str and _HASH.fullmatch(value), "Invalid SHA256 digest")
    return value


def _path(value: Any) -> str:
    _text(value)
    _require(not re.search(r"[\\:\x00-\x1f\x7f]", value), "Invalid relative path")
    _require(
        all(part not in ("", ".", "..") for part in value.split("/")), "Noncanonical relative path"
    )
    return value


_JSON_ESCAPES = re.compile(r'["\\\x00-\x1f<>&\u2028\u2029]')
_JSON_ESCAPE_BYTES = {
    '"': 1, "\\": 1, "\b": 1, "\t": 1, "\n": 1, "\f": 1, "\r": 1,
    "\u2028": 3, "\u2029": 3,
}


def _canonical_string_bytes(value: str, maximum: int) -> int:
    """Size the exact wire string without allocating an unbounded escaped copy."""
    size = len(value) + 2
    _require(size <= maximum, "JSON byte limit exceeded")
    if not value.isascii():
        size = 2
        for start in range(0, len(value), 4096):
            size += len(_utf8(value[start:start + 4096]))
            _require(size <= maximum, "JSON byte limit exceeded")
    for match in _JSON_ESCAPES.finditer(value):
        size += _JSON_ESCAPE_BYTES.get(match[0], 5)
        _require(size <= maximum, "JSON byte limit exceeded")
    return size


def canonical_json(
    value: Any,
    *,
    max_bytes: int = ANNOTATION_LIMITS["maxResultBytes"],
    max_work: int = ANNOTATION_LIMITS["maxWork"],
    max_depth: int = 128,
) -> str:
    """Version-1 canonical JSON: safe integers and HTML/line-separator escaping.

    Manifest keys are ASCII by schema. Store path keys may be Unicode; Python's
    code-point ordering defines their store-local content identity.
    """
    seen: set[int] = set()
    strings: dict[str, int] = {}
    work = 0
    size = 0

    def string_size(text: str) -> int:
        if len(text) > 256:
            return _canonical_string_bytes(text, max_bytes - size)
        cached = strings.get(text)
        if cached is not None:
            return cached
        result = _canonical_string_bytes(text, max_bytes - size)
        # Repeated wire keys and vocabulary dominate retained stores. Bound this
        # call-local cache, excluding large source and expression strings.
        if len(strings) < 4096:
            strings[text] = result
        return result

    def visit(item: Any, depth: int) -> None:
        nonlocal work, size
        work += 1
        if not (work <= max_work and depth <= max_depth):
            raise EvidenceValidationError("JSON structural limit exceeded")
        kind = type(item)
        if item is None:
            size += 4
        elif kind is bool:
            size += 4 if item else 5
        elif kind is int:
            if not -MAX_SAFE_INTEGER <= item <= MAX_SAFE_INTEGER:
                raise EvidenceValidationError("Invalid integer or limit")
            size += len(str(item))
        elif kind is str:
            size += string_size(item)
        else:
            if kind not in (dict, list) or id(item) in seen:
                raise EvidenceValidationError("Invalid JSON value")
            count = len(item)
            if not count <= max_work:
                raise EvidenceValidationError("JSON structural limit exceeded")
            seen.add(id(item))
            # Count delimiters, commas and colons before descending. Object keys
            # still consume one work unit and one depth level, just like values.
            size += 2 + max(0, count - 1) + (count if kind is dict else 0)
            if not size <= max_bytes:
                raise EvidenceValidationError("JSON byte limit exceeded")
            if kind is list:
                for child in item:
                    visit(child, depth + 1)
            else:
                work += count
                if not work <= max_work or count and not depth + 1 <= max_depth:
                    raise EvidenceValidationError("JSON structural limit exceeded")
                for key, child in item.items():
                    if type(key) is not str:
                        raise EvidenceValidationError("Invalid JSON object key")
                    size += string_size(key)
                    if not size <= max_bytes:
                        raise EvidenceValidationError("JSON byte limit exceeded")
                    visit(child, depth + 1)
            seen.remove(id(item))
        if not size <= max_bytes:
            raise EvidenceValidationError("JSON byte limit exceeded")

    try:
        visit(value, 0)
        # Preflight proves the output bound and excludes cycles, subclasses,
        # floats and invalid Unicode before the C encoder allocates its result.
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                             separators=(",", ":"), check_circular=False)
    except RecursionError as exc:
        raise EvidenceValidationError("JSON structural limit exceeded") from exc
    for char, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                          ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        encoded = encoded.replace(char, escaped)
    return encoded


def _digest(value: Any, limits: EvidenceLimits | None = None) -> str:
    settings = (
        {}
        if limits is None
        else {
            "max_bytes": limits.max_store_bytes,
            "max_work": limits.max_work,
            "max_depth": limits.max_depth,
        }
    )
    return hashlib.sha256(_utf8(canonical_json(value, **settings))).hexdigest()


def _json_input(value: Any, maximum: int, limits: EvidenceLimits) -> Any:
    if type(value) in (str, bytes):
        _require(len(value) <= maximum, "JSON input byte limit exceeded")
        if type(value) is bytes:
            try:
                value = value.decode("utf-8", errors="strict")
            except UnicodeError as exc:
                raise EvidenceValidationError("Invalid JSON UTF-8") from exc
        _require(len(_utf8(value)) <= maximum, "JSON input byte limit exceeded")

        def pairs(items: list) -> dict:
            result: dict = {}
            for key, item in items:
                _require(key not in result, "Duplicate JSON key")
                result[key] = item
            return result

        try:
            value = json.loads(value, object_pairs_hook=pairs)
        except (ValueError, RecursionError) as exc:
            raise EvidenceValidationError(f"Invalid JSON: {exc}") from exc
    canonical_json(value, max_bytes=maximum, max_work=limits.max_work, max_depth=limits.max_depth)
    return value


def _unique_strings(value: Any, maximum: int, check: Any = _text) -> list:
    items = _array(value, maximum)
    seen = set()
    for item in items:
        check(item)
        _require(item not in seen, "Duplicate string")
        seen.add(item)
    return items


def _producer(value: Any, manifest: Mapping[str, Any] | None = None) -> None:
    _object(value, ("id", "version", "fingerprint", "configuration"))
    _require(
        value["id"] == "graphify.frameworks" and value["version"] == "1",
        "Unsupported evidence producer/version",
    )
    _hash(value["fingerprint"])
    configuration = _object(value["configuration"], ("moduleAliases",))
    try:
        aliases = normalize_module_aliases(configuration["moduleAliases"])
    except FrameworkConfigurationError as exc:
        raise EvidenceValidationError(str(exc)) from exc
    for prefix, target in aliases.items():
        _text(prefix, MAX_ALIAS_PREFIX_LENGTH)
        _text(target, MAX_OPTIONS_BYTES)
    if manifest is not None:
        _require(
            all(
                digest == value["fingerprint"]
                for digest in (
                    manifest["core"]["implementationDigest"],
                    manifest["view"]["implementationDigest"],
                    *(plugin["implementationDigest"] for plugin in manifest["plugins"]),
                )
            ),
            "Producer fingerprint disagrees with manifest",
        )
        try:
            options = normalize_analysis_options(
                {"limits": manifest["limits"], "moduleAliases": aliases},
                max_limits=ANNOTATION_LIMITS,
            )
        except FrameworkConfigurationError as exc:
            raise EvidenceValidationError(str(exc)) from exc
        configuration_digest = _digest(options)
        _require(
            all(
                digest == configuration_digest
                for digest in (
                    manifest["core"]["configurationDigest"],
                    manifest["view"]["configurationDigest"],
                    *(plugin["configurationDigest"] for plugin in manifest["plugins"]),
                )
            ),
            "Producer configuration disagrees with manifest",
        )


def _manifest(value: Any) -> None:
    _object(value, ("version", "id", "core", "view", "parserDigest", "plugins", "limits"))
    _require(
        type(value["version"]) is int and value["version"] == 1,
        "Unsupported annotation manifest version",
    )
    _hash(value["id"])
    core = _object(value["core"], ("version", "implementationDigest", "configurationDigest"))
    _text(core["version"], 64)
    _hash(core["implementationDigest"])
    _hash(core["configurationDigest"])
    view = _object(value["view"], ("id", "version", "implementationDigest", "configurationDigest"))
    _identifier(view["id"])
    _integer(view["version"], 1, MAX_SAFE_INTEGER)
    _hash(view["implementationDigest"])
    _hash(view["configurationDigest"])
    _hash(value["parserDigest"])
    bounds = _object(value["limits"], list(ANNOTATION_LIMITS))
    for key, maximum in ANNOTATION_LIMITS.items():
        _integer(bounds[key], 1, maximum)
    # maxWork is the producer's analysis budget, not its JSON serialization work.
    canonical_json(value, max_bytes=bounds["maxManifestBytes"])
    seen = set()
    for plugin in _array(value["plugins"], bounds["maxPlugins"]):
        _object(
            plugin,
            (
                "id",
                "version",
                "implementationDigest",
                "configurationDigest",
                "languages",
                "view",
                "roles",
                "properties",
                "relations",
            ),
        )
        pid = _text(plugin["id"], 64)
        _require(
            re.fullmatch(r"[a-z][a-z0-9-]{0,63}", pid) and pid not in ("core", "wire"),
            "Invalid plugin namespace",
        )
        _require(pid not in seen, "Duplicate plugin")
        seen.add(pid)
        _text(plugin["version"], 64)
        _hash(plugin["implementationDigest"])
        _hash(plugin["configurationDigest"])
        _require(
            _unique_strings(plugin["languages"], 32, lambda x: _identifier(x, 64)),
            "Empty plugin languages",
        )
        pview = _object(plugin["view"], ("id", "version"))
        _integer(pview["version"], 1, MAX_SAFE_INTEGER)
        _require(pview == {"id": view["id"], "version": view["version"]}, "Unsupported plugin view")
        terms = set()
        for category in _CATEGORIES.values():
            for term in _array(plugin[category], 256):
                fields = (
                    ("id", "label", "valueKind", "multiple")
                    if category == "properties"
                    else ("id", "label")
                )
                _object(term, fields, ("description",))
                tid = _text(term["id"], 128)
                _require(
                    tid.startswith(pid + ".")
                    and re.fullmatch(r"[a-z][a-z0-9.-]*", tid[len(pid) + 1 :]),
                    "Foreign vocabulary namespace",
                )
                _require(tid not in terms, "Duplicate vocabulary term")
                terms.add(tid)
                _text(term["label"])
                if "description" in term:
                    _text(term["description"])
                if category == "properties":
                    _enum(term["valueKind"], ("string", "boolean", "integer", "reference"))
                    _require(type(term["multiple"]) is bool, "Invalid property cardinality")
    _require(
        value["id"] == _digest({k: v for k, v in value.items() if k != "id"}),
        "Manifest identity mismatch",
    )


class _Coordinates:
    def __init__(self, source: Any, maximum: int):
        _require(type(source) is str and len(source) <= maximum, "Source byte limit exceeded")
        self.data = _utf8(source)
        _require(len(self.data) <= maximum, "Source byte limit exceeded")
        _require(redact_secrets(source) == source, "Credential-shaped source cannot be persisted")
        self.boundaries = {0}
        self.lines = [0]
        offset = 0
        for char in source:
            offset += len(char.encode("utf-8"))
            self.boundaries.add(offset)
            if char == "\n":
                self.lines.append(offset)

    def line(self, offset: int) -> int:
        return bisect.bisect_right(self.lines, offset)

    def span(self, value: Any) -> dict:
        _object(value, ("startByte", "endByte", "startLine", "endLine"))
        start = _integer(value["startByte"], 0, len(self.data))
        end = _integer(value["endByte"], start, len(self.data))
        _integer(value["startLine"], 1, len(self.data) + 1)
        _integer(value["endLine"], value["startLine"], len(self.data) + 1)
        _require(start in self.boundaries and end in self.boundaries, "Span splits UTF-8 character")
        _require(
            value["startLine"] == self.line(start)
            and value["endLine"] == self.line(end - 1 if end > start else start),
            "Span line mismatch",
        )
        return value


def validate_redaction(source: str, redaction: Any) -> SourceRedaction:
    """Validate the safe snapshot and its non-secret transformation record."""
    _object(redaction, ("version", "policy", "originalSourceHash", "ranges"))
    _require(type(redaction["version"]) is int and redaction["version"] == 1, "Unsupported redaction version")
    _require(redaction["policy"] == SOURCE_REDACTION_POLICY, "Unsupported source redaction policy")
    _hash(redaction["originalSourceHash"])
    coords = _Coordinates(source, ANNOTATION_LIMITS["maxSourceBytes"])
    _require(
        redaction["originalSourceHash"] != hashlib.sha256(coords.data).hexdigest(),
        "Redaction must not claim the original source hash for changed text",
    )
    ranges = _array(redaction["ranges"], 4096)
    _require(bool(ranges), "Empty source redaction record")
    allowed = set(SOURCE_REDACTION_MASKS.values()) | set(SOURCE_REDACTION_REGEX_MASKS.values()) | {"\r", "\n"}
    previous_end = -1
    for value in ranges:
        span = coords.span(value)
        _require(span["startByte"] >= previous_end and span["endByte"] > span["startByte"], "Invalid redaction range ordering")
        fragment = coords.data[span["startByte"]:span["endByte"]].decode("utf-8")
        _require(all(character in allowed for character in fragment), "Redaction range contains unmasked text")
        _require(any(character not in {"\r", "\n"} for character in fragment), "Empty credential redaction")
        previous_end = span["endByte"]
    return cast(SourceRedaction, copy.deepcopy(redaction))


def _contains(outer: Mapping[str, Any], inner: Mapping[str, Any]) -> bool:
    return (
        outer["startByte"] <= inner["startByte"] <= inner["endByte"] <= outer["endByte"]
        and outer["startLine"] <= inner["startLine"] <= inner["endLine"] <= outer["endLine"]
    )


def _reference(
    value: Any, declarations: dict, coords: _Coordinates, bounds: dict, *, expression: bool = False
) -> None:
    _object(value, ("kind",), ("key", "module", "name", "member", "text", "span"))
    kind = _enum(value["kind"], ("declaration", "import", "expression", "type"))
    _require(not expression or kind == "expression", "Binding requires source expression")
    if kind == "declaration":
        _object(value, ("kind", "key"))
        _text(value["key"])
        _require(value["key"] in declarations, "Unknown declaration reference")
    elif kind == "import":
        _object(value, ("kind", "module", "name"), ("member",))
        for key in ("module", "name", "member"):
            if key in value:
                _text(value[key], bounds["maxValueBytes"])
    else:
        _object(value, ("kind", "text", "span"))
        _text(value["text"], bounds["maxValueBytes"])
        span = coords.span(value["span"])
        _require(
            value["text"] == coords.data[span["startByte"] : span["endByte"]].decode("utf-8"),
            "Reference text mismatch",
        )
    canonical_json(value, max_bytes=bounds["maxValueBytes"])


def _binding(value: Any, coords: _Coordinates, bounds: dict) -> None:
    _object(value, ("source", "sourceSpan", "patternSpan", "operations", "value"), ("shapes",))
    _require(value["value"] == "unknown", "Binding is not runtime value proof")
    _reference(value["source"], {}, coords, bounds, expression=True)
    coords.span(value["sourceSpan"])
    pattern = coords.span(value["patternSpan"])
    _require(value["source"]["span"] == value["sourceSpan"], "Binding source span mismatch")
    operations = _array(value["operations"], min(24, bounds["maxDepth"]))
    _require(operations, "Empty binding operations")
    for op in operations:
        _object(op, ("kind", "span"), ("key", "index", "value", "excludedKeys"))
        _require(_contains(pattern, coords.span(op["span"])), "Operation outside binding pattern")
        kind = _enum(
            op["kind"],
            (
                "property",
                "computed-property",
                "iterator",
                "iterator-rest",
                "default",
                "object-rest",
            ),
        )
        if kind == "property":
            _object(op, ("kind", "span", "key"))
            _text(op["key"], empty=True)
        elif kind in ("computed-property", "default"):
            key = "key" if kind == "computed-property" else "value"
            _object(op, ("kind", "span", key))
            _reference(op[key], {}, coords, bounds, expression=True)
            _require(_contains(op["span"], op[key]["span"]), "Expression outside operation")
        elif kind in ("iterator", "iterator-rest"):
            _object(op, ("kind", "span", "index"))
            _integer(op["index"], 0, 511)
        else:
            _object(op, ("kind", "span", "excludedKeys"))
            for key in _array(op["excludedKeys"], 64):
                if type(key) is str:
                    _text(key, empty=True)
                else:
                    _reference(key, {}, coords, bounds, expression=True)
                    _require(_contains(pattern, key["span"]), "Excluded key outside pattern")
    if "shapes" in value:
        _require(value["shapes"], "Empty binding shapes")
        for shape in _array(value["shapes"], 16):
            _object(shape, ("kind", "span"), ("keys", "length"))
            coords.span(shape["span"])
            if shape["kind"] == "object":
                _object(shape, ("kind", "span", "keys"))
                _unique_strings(shape["keys"], 64, lambda x: _text(x, empty=True))
            else:
                _require(shape["kind"] == "tuple", "Invalid binding shape")
                _object(shape, ("kind", "span", "length"))
                _integer(shape["length"], 0, 64)
    canonical_json(value, max_bytes=bounds["maxValueBytes"])


def _validated_json_key(value: Any) -> str:
    """Internal equality only, after bounded JSON preflight; never a wire digest."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":"), check_circular=False)


def _result(value: Any, manifest: dict, source: Any) -> None:
    _object(
        value,
        (
            "version",
            "analysisSetId",
            "sourceHash",
            "relativePath",
            "language",
            "state",
            "declarations",
            "facts",
            "reports",
            "diagnostics",
        ),
    )
    bounds = manifest["limits"]
    canonical_json(value, max_bytes=bounds["maxResultBytes"])
    _require(
        type(value["version"]) is int
        and value["version"] == 1
        and value["analysisSetId"] == manifest["id"],
        "Annotation contract mismatch",
    )
    _hash(value["sourceHash"])
    _path(value["relativePath"])
    _identifier(value["language"], 64)
    _enum(value["state"], _STATES)
    coords = _Coordinates(source, bounds["maxSourceBytes"])
    _require(hashlib.sha256(coords.data).hexdigest() == value["sourceHash"], "Source hash mismatch")
    declarations: dict[str, dict[str, Any]] = {}
    for decl in _array(value["declarations"], bounds["maxDeclarations"]):
        _object(
            decl,
            ("key", "kind", "span", "exports"),
            ("name", "owner", "nameSpan", "binding", "writes", "computedName"),
        )
        key = _text(decl["key"])
        _require(not re.search(r"[\x00-\x1f\x7f]", key), "Invalid declaration key")
        _require(key not in declarations, "Duplicate declaration key")
        declarations[key] = decl
        _identifier(decl["kind"])
        coords.span(decl["span"])
        for field in ("name", "owner"):
            if field in decl:
                _text(decl[field])
        if "nameSpan" in decl:
            _require(
                _contains(decl["span"], coords.span(decl["nameSpan"])),
                "Name span outside declaration",
            )
        _unique_strings(decl["exports"], 256)
        if "binding" in decl:
            _binding(decl["binding"], coords, bounds)
            _require(
                _contains(decl["binding"]["patternSpan"], decl.get("nameSpan", decl["span"])),
                "Binding target outside pattern",
            )
        if "writes" in decl:
            _require(decl["writes"], "Empty writes")
            seen_writes = set()
            for write in _array(decl["writes"], 64):
                _binding(write, coords, bounds)
                identity = canonical_json(write)
                _require(identity not in seen_writes, "Duplicate write")
                seen_writes.add(identity)
        if "computedName" in decl:
            _reference(decl["computedName"], {}, coords, bounds, expression=True)
            _require(
                "name" not in decl and _contains(decl["span"], decl["computedName"]["span"]),
                "Invalid computed name",
            )
    for decl in declarations.values():
        current = decl
        seen_owners = {decl["key"]}
        while "owner" in current:
            owner = declarations.get(current["owner"])
            if owner is None or owner["key"] in seen_owners:
                raise EvidenceValidationError("Missing or cyclic declaration owner")
            _require(_contains(owner["span"], current["span"]), "Declaration outside owner")
            seen_owners.add(owner["key"])
            _require(len(seen_owners) <= bounds["maxDepth"], "Declaration depth exceeded")
            current = owner

    plugins = {p["id"]: p for p in manifest["plugins"]}
    reports: dict = {}
    diagnostic_count = 0

    def diagnostics(items: Any) -> None:
        nonlocal diagnostic_count
        seen = set()
        for diagnostic in _array(items, bounds["maxDiagnostics"]):
            _object(diagnostic, ("code", "message"), ("span",))
            _identifier(diagnostic["code"])
            _text(diagnostic["message"], bounds["maxValueBytes"])
            if "span" in diagnostic:
                coords.span(diagnostic["span"])
            key = canonical_json(diagnostic)
            _require(key not in seen, "Duplicate diagnostic")
            seen.add(key)
            diagnostic_count += 1
            _require(diagnostic_count <= bounds["maxDiagnostics"], "Diagnostic limit exceeded")

    diagnostics(value["diagnostics"])
    for report in _array(value["reports"], bounds["maxPlugins"]):
        _object(report, ("pluginId", "state", "diagnostics"))
        pid = _text(report["pluginId"], 64)
        _enum(report["state"], _STATES)
        _require(pid in plugins and pid not in reports, "Unknown or duplicate plugin report")
        _require(
            value["language"] in plugins[pid]["languages"] or report["state"] == "not-applicable",
            "Unsupported plugin language",
        )
        diagnostics(report["diagnostics"])
        reports[pid] = report["state"]
    _require(reports.keys() == plugins.keys(), "Missing plugin report")
    seen_facts = set()
    property_values = {}
    for fact in _array(value["facts"], bounds["maxFacts"]):
        _object(fact, ("kind", "subject", "term", "evidence"), ("resolution", "value", "target"))
        kind = _enum(fact["kind"], _CATEGORIES)
        subject = _text(fact["subject"])
        _require(subject in declarations, "Unknown fact subject")
        _text(fact["term"], 128)
        evidence = _object(fact["evidence"], ("pluginId", "ruleId", "basis", "span"))
        pid = _text(evidence["pluginId"], 64)
        _require(pid in plugins, "Unknown fact plugin")
        _identifier(evidence["ruleId"])
        _enum(evidence["basis"], ("syntax", "import-bound", "convention"))
        _require(
            _contains(declarations[subject]["span"], coords.span(evidence["span"])),
            "Evidence outside subject",
        )
        term = next((t for t in plugins[pid][_CATEGORIES[kind]] if t["id"] == fact["term"]), None)
        if term is None:
            raise EvidenceValidationError("Unknown vocabulary term")
        if kind == "role":
            _object(fact, ("kind", "subject", "term", "evidence"))
        elif kind == "relation":
            _object(fact, ("kind", "subject", "term", "evidence", "target"))
            _reference(fact["target"], declarations, coords, bounds)
        else:
            _object(fact, ("kind", "subject", "term", "evidence", "resolution"), ("value",))
            resolution = _enum(fact["resolution"], ("literal", "constant", "expression", "absent"))
            if resolution in ("expression", "absent"):
                _require("value" not in fact, "Unresolved property has a value")
            else:
                prop = _object(fact.get("value"), ("kind", "value"))
                _require(prop["kind"] == term["valueKind"], "Invalid property value kind")
                if prop["kind"] == "string":
                    _text(prop["value"], bounds["maxValueBytes"], empty=True)
                elif prop["kind"] == "boolean":
                    _require(type(prop["value"]) is bool, "Invalid boolean")
                elif prop["kind"] == "integer":
                    _integer(prop["value"], -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
                else:
                    _reference(prop["value"], declarations, coords, bounds)
                canonical_json(prop, max_bytes=bounds["maxValueBytes"])
            if not term["multiple"]:
                property_key = (subject, fact["term"])
                property_value = _validated_json_key(
                    {k: fact[k] for k in ("resolution", "value") if k in fact}
                )
                _require(
                    property_key not in property_values
                    or property_values[property_key] == property_value,
                    "Conflicting single-valued property",
                )
                property_values[property_key] = property_value
        _require(
            reports[pid] not in ("failed", "unsupported", "not-applicable"),
            "Facts contradict plugin report",
        )
        identity = _validated_json_key(fact)
        _require(identity not in seen_facts, "Duplicate exact fact")
        seen_facts.add(identity)
    states = list(reports.values())
    if value["state"] in _GOOD:
        _require(all(s in _GOOD for s in states), "Incomplete reports hidden by result")
    if value["state"] == "not-applicable":
        _require(
            not seen_facts and all(s == "not-applicable" for s in states),
            "Invalid not-applicable result",
        )
    if value["state"] in ("failed", "unsupported"):
        _require(
            not seen_facts
            and all(s in ("failed", "unsupported", "not-applicable") for s in states),
            "Facts contradict base coverage",
        )
    if "failed" in states:
        _require(
            value["state"] in ("partial", "failed", "unsupported"), "Failed plugin hidden by result"
        )


def validate_payload(payload: Any, *, limits: EvidenceLimits | None = None) -> EvidenceStore:
    """Validate one Node response and return a detached, lossless store fragment."""
    limits = limits or EvidenceLimits()
    payload = _json_input(payload, limits.max_payload_bytes, limits)
    _object(payload, ("version", "producer", "manifest", "documents"))
    _require(
        type(payload["version"]) is int and payload["version"] == 1, "Unsupported payload version"
    )
    _producer(payload["producer"])
    _manifest(payload["manifest"])
    _producer(payload["producer"], payload["manifest"])
    documents = {}
    for entry in _array(payload["documents"], limits.max_documents):
        _object(entry, ("source", "result"), ("redaction",))
        _result(entry["result"], payload["manifest"], entry["source"])
        if "redaction" in entry:
            validate_redaction(entry["source"], entry["redaction"])
        path = entry["result"]["relativePath"]
        _require(path not in documents, "Conflicting duplicate source ownership")
        documents[path] = {"producer": payload["producer"], **entry}
    return validate_store(
        {
            "version": 1,
            "manifests": {payload["manifest"]["id"]: payload["manifest"]},
            "producers": {payload["manifest"]["id"]: payload["producer"]},
            "documents": documents,
        },
        limits=limits,
    )


def validate_store(store: Any, *, limits: EvidenceLimits | None = None) -> EvidenceStore:
    """Fail closed on persisted evidence, including retained prior snapshots."""
    limits = limits or EvidenceLimits()
    store = _object(
        _json_input(store, limits.max_store_bytes, limits),
        ("version", "manifests", "producers", "documents"),
    )
    _require(type(store["version"]) is int and store["version"] == 1, "Unsupported store version")
    manifests: dict[str, dict[str, Any]] = store["manifests"]
    _require(
        type(manifests) is dict and len(manifests) <= limits.max_manifests, "Manifest store limit"
    )
    for mid, manifest in manifests.items():
        _manifest(manifest)
        _require(mid == manifest["id"], "Manifest map identity mismatch")
    producers: dict[str, dict[str, Any]] = store["producers"]
    _require(
        type(producers) is dict and producers.keys() == manifests.keys(),
        "Producer/manifest ownership mismatch",
    )
    for mid, producer in producers.items():
        _producer(producer, manifests[mid])
    documents: dict[str, dict[str, Any]] = store["documents"]
    _require(
        type(documents) is dict and len(documents) <= limits.max_documents, "Document store limit"
    )

    def document(entry: Any, path: str, *, head: bool) -> None:
        _object(
            entry, ("producer", "source", "result"),
            ("redaction", "retained", "refreshFailed") if head else ("redaction",),
        )
        _producer(entry["producer"])
        result: dict[str, Any] = entry["result"]
        _require(
            type(result) is dict
            and type(result.get("analysisSetId")) is str
            and result["analysisSetId"] in manifests,
            "Unknown document manifest",
        )
        _result(result, manifests[result["analysisSetId"]], entry["source"])
        if "redaction" in entry:
            validate_redaction(entry["source"], entry["redaction"])
        _producer(entry["producer"], manifests[result["analysisSetId"]])
        _require(
            entry["producer"] == producers[result["analysisSetId"]],
            "Document producer disagrees with manifest provenance",
        )
        _require(path == result["relativePath"], "Document source ownership mismatch")

    for path, entry in documents.items():
        _path(path)
        document(entry, path, head=True)
        if "refreshFailed" in entry:
            _require(entry["refreshFailed"] is True, "Invalid refresh failure marker")
        if "retained" in entry:
            document(entry["retained"], path, head=False)
            _require(
                _complete(entry["retained"]) and not _complete(entry),
                "Invalid retained complete snapshot",
            )
    return cast(EvidenceStore, copy.deepcopy(store))


def _complete(document: Mapping[str, Any]) -> bool:
    result = document["result"]
    return (
        not document.get("refreshFailed")
        and result["state"] in _GOOD
        and not result["diagnostics"]
        and all(r["state"] in _GOOD and not r["diagnostics"] for r in result["reports"])
    )


def merge_evidence(
    previous: Any,
    incoming: Any = None,
    *,
    replaced_sources: Any = (),
    deleted_sources: Any = (),
    failed_sources: Any = (),
    limits: EvidenceLimits | None = None,
) -> EvidenceStore:
    """Merge by explicit source ownership, never by absence in a partial batch.

    Changed existing sources require ``replaced_sources`` (or ``failed_sources``
    for a failed attempt). Missing replacements preserve existing snapshots and
    mark refresh failure. Partial/failed heads retain a prior complete snapshot;
    retrieval never mistakes that retained snapshot for current evidence.
    Only ``deleted_sources`` authorizes removal. Inputs are never mutated.
    """
    limits = limits or EvidenceLimits()
    empty = {"version": 1, "manifests": {}, "producers": {}, "documents": {}}
    old = validate_store(empty if previous is None else previous, limits=limits)
    new = validate_store(empty if incoming is None else incoming, limits=limits)

    def paths(items: Any) -> set:
        _require(
            type(items) in (list, tuple, set, frozenset), "Expected explicit source collection"
        )
        _require(len(items) <= limits.max_documents, "Source ownership limit")
        return {_path(item) for item in items}

    replaced, deleted, failed = (
        paths(replaced_sources),
        paths(deleted_sources),
        paths(failed_sources),
    )
    _require(
        not deleted & (replaced | failed | new["documents"].keys()),
        "Conflicting deleted source ownership",
    )
    for mid, manifest in new["manifests"].items():
        _require(
            mid not in old["manifests"] or old["manifests"][mid] == manifest,
            "Manifest content conflict",
        )
        old["manifests"][mid] = manifest
        _require(
            mid not in old["producers"] or old["producers"][mid] == new["producers"][mid],
            "Producer provenance conflict",
        )
        old["producers"][mid] = new["producers"][mid]
    for path in deleted:
        old["documents"].pop(path, None)
    for path, entry in new["documents"].items():
        prior = old["documents"].get(path)
        if prior is not None and prior != entry:
            _require(
                path in replaced | failed, "Source/producer conflict without replacement ownership"
            )
        if path in failed:
            entry["refreshFailed"] = True
        if prior is not None and not _complete(entry):
            retained = (
                EvidenceDocument(
                    producer=prior["producer"], source=prior["source"], result=prior["result"]
                )
                if _complete(prior)
                else prior.get("retained")
            )
            if retained is not None and _complete(prior) and "redaction" in prior:
                retained["redaction"] = copy.deepcopy(prior["redaction"])
            if retained is not None:
                entry["retained"] = retained
        old["documents"][path] = entry
    for path in (replaced | failed) - new["documents"].keys():
        if path in old["documents"]:
            entry = old["documents"][path]
            if _complete(entry):
                entry["retained"] = EvidenceDocument(
                    producer=copy.deepcopy(entry["producer"]),
                    source=entry["source"],
                    result=copy.deepcopy(entry["result"]),
                )
                if "redaction" in entry:
                    entry["retained"]["redaction"] = copy.deepcopy(entry["redaction"])
            entry["refreshFailed"] = True
    return validate_store(old, limits=limits)


def attach_evidence(graph: Any, store: Any, *, limits: EvidenceLimits | None = None) -> None:
    """Attach only after full validation; do not route through metadata sanitizers."""
    validated = validate_store(store, limits=limits)
    _require(hasattr(graph, "graph") and type(graph.graph) is dict, "Expected NetworkX graph")
    graph.graph[SEMANTIC_EVIDENCE_KEY] = validated


def extract_evidence(graph: Any, *, limits: EvidenceLimits | None = None) -> EvidenceStore | None:
    """Return a validated defensive copy, or None when the lane was never indexed."""
    _require(hasattr(graph, "graph") and type(graph.graph) is dict, "Expected NetworkX graph")
    if SEMANTIC_EVIDENCE_KEY not in graph.graph:
        return None
    return validate_store(graph.graph[SEMANTIC_EVIDENCE_KEY], limits=limits)


# One graph only, invalidated by bounded content hashing, not mutable-object identity.
# Reader responses are copied before returning so they cannot mutate this snapshot.
_reader_snapshot: tuple | None = None


def _remember_evidence(graph: Any, validated: EvidenceStore, limits: EvidenceLimits | None = None, *, digest: str | None = None) -> None:
    """Seed the reader from an already validated load, without validating it twice."""
    global _reader_snapshot
    limits = limits or EvidenceLimits()

    def released(reference):
        global _reader_snapshot
        if _reader_snapshot is not None and _reader_snapshot[0] is reference:
            _reader_snapshot = None

    try:
        reference = weakref.ref(graph, released)
    except TypeError:
        return
    source = graph.graph[SEMANTIC_EVIDENCE_KEY]
    _reader_snapshot = (reference, source, limits, digest or _digest(source, limits), validated)


def _read_evidence_snapshot(graph: Any, limits: EvidenceLimits) -> tuple[EvidenceStore | None, str]:
    _require(hasattr(graph, "graph") and type(graph.graph) is dict, "Expected NetworkX graph")
    if SEMANTIC_EVIDENCE_KEY not in graph.graph:
        return None, ""
    source = graph.graph[SEMANTIC_EVIDENCE_KEY]
    digest = _digest(source, limits)
    cached = _reader_snapshot
    if cached is not None and cached[0]() is graph and cached[1] is source and cached[2] == limits and cached[3] == digest:
        return cached[4], digest
    store = validate_store(source, limits=limits)
    _remember_evidence(graph, store, limits, digest=digest)
    return store, digest


def response_json(response: dict) -> str:
    """The budgeted public encoding (also bounds ordinary compact JSON encodings)."""
    return json.dumps(response, ensure_ascii=True, allow_nan=False, indent=2)


def _response_size(response: dict) -> int:
    return len(response_json(response).encode("utf-8"))


def _budget(max_bytes: int | None, limits: EvidenceLimits) -> int:
    return _integer(
        limits.response_bytes if max_bytes is None else max_bytes, 256, limits.max_response_bytes
    )


def _unsupported(reason: str, budget: int, **details: Any) -> dict:
    response = {"version": 1, "status": "unsupported", "reason": reason, **details}
    if _response_size(response) > budget:
        response = {"version": 1, "status": "unsupported", "reason": reason}
    _require(_response_size(response) <= budget, "Response budget cannot encode a failure")
    return response


def _coverage(entry: Mapping[str, Any]) -> dict:
    result = entry["result"]
    complete = _complete(entry) and "redaction" not in entry
    state = (
        "failed"
        if entry.get("refreshFailed")
        else "partial"
        if result["state"] in _GOOD and not complete
        else result["state"]
    )
    coverage = {
        "reportedState": result["state"],
        "effectiveState": state,
        "complete": complete,
        "diagnostics": result["diagnostics"],
        "reports": result["reports"],
        "refreshFailed": bool(entry.get("refreshFailed")),
        "sourceFreshness": (
            "refresh-failed-current-source-unknown"
            if entry.get("refreshFailed")
            else "captured-snapshot-only"
        ),
        "retainedPreviousComplete": "retained" in entry,
        "scope": "source-analysis-only; not runtime execution or whole-program completeness",
    }
    if "redaction" in entry:
        coverage["sourceFidelity"] = "redacted"
        coverage["redactedRangeCount"] = len(entry["redaction"]["ranges"])
    return coverage


def _source_reference(entry: Mapping[str, Any]) -> str:
    # Hash separately so an exactly maxResultBytes result remains addressable.
    identity = [entry["producer"], _digest(entry["result"])]
    if "redaction" in entry:
        identity.append(entry["redaction"])
    return "gfe1:source:" + _digest(identity)


def _record_reference(source_ref: str, kind: str, record: Mapping[str, Any]) -> str:
    return f"gfe1:{kind}:" + _digest([source_ref, _digest(record)])


def _identity(entry: Mapping[str, Any]) -> dict:
    result = entry["result"]
    identity = {
        "relativePath": result["relativePath"],
        "sourceHash": result["sourceHash"],
        "analysisSetId": result["analysisSetId"],
        "producer": entry["producer"],
    }
    if "redaction" in entry:
        identity["redaction"] = {
            "policy": entry["redaction"]["policy"],
            "originalSourceHash": entry["redaction"]["originalSourceHash"],
            "rangeCount": len(entry["redaction"]["ranges"]),
            "coordinatesPreserved": ["utf8-bytes", "utf16-units", "lines"],
            "literalValues": "redacted values do not describe the original literals",
        }
    return identity


def _terms(manifest: Mapping[str, Any]) -> dict:
    return {
        (plugin["id"], kind, term["id"]): term
        for plugin in manifest["plugins"]
        for kind, category in _CATEGORIES.items()
        for term in plugin[category]
    }


def _cursor(scope: str, index: int) -> str:
    return f"gfc1:{scope}:{index}"


def _cursor_index(cursor: Any, scope: str, total: int) -> int | None:
    if cursor is None:
        return 0
    if type(cursor) is not str:
        return None
    match = re.fullmatch(r"gfc1:([a-f0-9]{64}):([0-9]{1,10})", cursor)
    if match is None or match[1] != scope:
        return None
    index = int(match[2])
    return index if index <= total else None


def query_semantics(
    graph: Any,
    query: str = "",
    *,
    path: str | None = None,
    plugin: str | None = None,
    symbol: str | None = None,
    limit: int = 20,
    cursor: str | None = None,
    max_bytes: int | None = None,
    limits: EvidenceLimits | None = None,
) -> dict:
    """Search retained evidence, without resolving names to code implementations.

    Query is case-insensitive token containment, path is exact or directory prefix,
    plugin is an exact ID, symbol is an exact declaration key/name/export. Sources
    with no facts remain discoverable so failed/unsupported coverage stays visible.
    """
    limits = limits or EvidenceLimits()
    budget = _budget(max_bytes, limits)
    _text(query, empty=True)
    if path is not None:
        _path(path)
    if plugin is not None:
        _text(plugin, 64)
    if symbol is not None:
        _text(symbol)
    _integer(limit, 1, limits.max_page_items)
    try:
        store, store_digest = _read_evidence_snapshot(graph, limits)
    except EvidenceValidationError:
        return _unsupported("invalid-semantic-evidence", budget)
    if store is None:
        return _unsupported("semantic-evidence-not-indexed", budget)
    scope = _digest(["query", store_digest, query, path, plugin, symbol])
    words = query.casefold().split()
    candidates = []
    terms_by_manifest = {}
    for relative_path, entry in sorted(store["documents"].items()):
        if path is not None and relative_path != path and not relative_path.startswith(path + "/"):
            continue
        result = entry["result"]
        manifest = store["manifests"][result["analysisSetId"]]
        if plugin is not None and not any(p["id"] == plugin for p in manifest["plugins"]):
            continue
        declarations = result["declarations"]
        if symbol is not None:
            declarations = [declaration for declaration in declarations
                            if symbol in [declaration["key"], declaration.get("name"), *declaration["exports"]]]
            if not declarations:
                continue
        manifest_id = result["analysisSetId"]
        if manifest_id not in terms_by_manifest:
            terms_by_manifest[manifest_id] = _terms(manifest)
        terms = terms_by_manifest[manifest_id]
        source_ref = None
        if symbol is None and all(word in relative_path.casefold() for word in words):
            source_ref = _source_reference(entry)
            candidates.append(
                {
                    "kind": "source",
                    "reference": source_ref,
                    **_identity(entry),
                    "coverage": _coverage(entry),
                    "declarationCount": len(result["declarations"]),
                    "factCount": len(result["facts"]),
                }
            )
        facts_by_subject: dict[str, list] = {}
        for fact in result["facts"]:
            if plugin is None or fact["evidence"]["pluginId"] == plugin:
                facts_by_subject.setdefault(fact["subject"], []).append(fact)
        for declaration in declarations:
            facts = facts_by_subject.get(declaration["key"], [])
            if plugin is not None and not facts:
                continue
            vocabulary = {
                (f["evidence"]["pluginId"], f["kind"], f["term"]): terms[
                    (f["evidence"]["pluginId"], f["kind"], f["term"])
                ]
                for f in facts
            }
            if words:
                haystack = canonical_json(
                    [relative_path, declaration, facts, list(vocabulary.values())],
                    max_bytes=limits.max_store_bytes,
                    max_work=limits.max_work,
                    max_depth=limits.max_depth,
                ).casefold()
                if not all(word in haystack for word in words):
                    continue
            if source_ref is None:
                source_ref = _source_reference(entry)
            candidates.append(
                {
                    "kind": "declaration",
                    "reference": _record_reference(source_ref, "declaration", declaration),
                    "sourceReference": source_ref,
                    **_identity(entry),
                    "declaration": declaration,
                    "coverage": _coverage(entry),
                    "factCount": len(facts),
                    "vocabulary": [
                        {"pluginId": key[0], "kind": key[1], **term}
                        for key, term in sorted(vocabulary.items())
                    ],
                }
            )
    offset = _cursor_index(cursor, scope, len(candidates))
    if offset is None:
        return _unsupported("stale-or-invalid-continuation", budget)
    response = {
        "version": 1,
        "status": "ok",
        "matches": [],
        "total": len(candidates),
        "truncated": offset < len(candidates),
        "continuation": _cursor(scope, offset) if offset < len(candidates) else None,
    }
    if _response_size(response) > budget:
        return _unsupported(
            "response-budget-too-small", budget, requiredBytes=_response_size(response)
        )
    for candidate in candidates[offset : offset + limit]:
        next_index = offset + len(response["matches"]) + 1
        attempt = {
            **response,
            "matches": [*response["matches"], candidate],
            "truncated": next_index < len(candidates),
            "continuation": _cursor(scope, next_index) if next_index < len(candidates) else None,
        }
        if _response_size(attempt) > budget:
            if not response["matches"]:
                return _unsupported(
                    "indivisible-evidence-exceeds-budget",
                    budget,
                    requiredBytes=_response_size(attempt),
                    continuation=_cursor(scope, offset),
                )
            break
        response = attempt
    return copy.deepcopy(response)


def _excerpt(
    entry: Mapping[str, Any], span: Mapping[str, Any], maximum: int, start: int | None
) -> dict:
    data = entry["source"].encode("utf-8")
    coords = _Coordinates(entry["source"], ANNOTATION_LIMITS["maxSourceBytes"])
    start = _integer(
        span["startByte"] if start is None else start, span["startByte"], span["endByte"]
    )
    _require(start in coords.boundaries, "Excerpt starts inside UTF-8 character")
    end = min(start + maximum, span["endByte"])
    while end not in coords.boundaries:
        end -= 1
    excerpt = {
        "trust": "untrusted-source-data",
        "startByte": start,
        "endByte": end,
        "startLine": coords.line(start),
        "endLine": coords.line(end - 1 if end > start else start),
        "text": data[start:end].decode("utf-8"),
        "truncated": end < span["endByte"],
        "nextStartByte": end if end < span["endByte"] else None,
        "sourceEndByte": span["endByte"],
    }
    if "redaction" in entry:
        excerpt["sourceKind"] = "redacted-source-snapshot"
        excerpt["redactions"] = [
            value for value in entry.get("redaction", {}).get("ranges", [])
            if value["startByte"] < end and value["endByte"] > start
        ]
    return excerpt


def _reference_meaning(
    reference: Mapping[str, Any], source_ref: str, declarations: Mapping[str, Any]
) -> dict:
    kind = reference["kind"]
    if kind == "declaration":
        target = declarations[reference["key"]]
        return {
            "kind": kind,
            "reference": _record_reference(source_ref, "declaration", target),
            "key": target["key"],
            "resolution": "exact-local-declaration; not runtime value identity",
        }
    return {"kind": kind, "resolution": "source-reference-only; implementation-body-unresolved"}


def inspect_semantics(
    graph: Any,
    reference: str,
    *,
    cursor: str | None = None,
    max_bytes: int | None = None,
    excerpt_bytes: int | None = None,
    excerpt_start: int | None = None,
    limits: EvidenceLimits | None = None,
) -> dict:
    """Inspect an exact content handle, grouping facts without deduplication.

    Retained prior snapshots are not current lookup candidates. A changed source,
    analysis set, producer, or record invalidates its former handles. Local refs
    resolve only to local declarations; imports/types/expressions never acquire
    guessed implementation bodies. Every fact and dependency is an atomic unit.
    """
    limits = limits or EvidenceLimits()
    budget = _budget(max_bytes, limits)
    excerpt_limit = _integer(
        limits.excerpt_bytes if excerpt_bytes is None else excerpt_bytes,
        4,
        ANNOTATION_LIMITS["maxSourceBytes"],
    )
    if type(reference) is not str or not re.fullmatch(
        r"gfe1:(source|declaration|fact):[a-f0-9]{64}", reference
    ):
        return _unsupported("invalid-evidence-reference", budget)
    try:
        store, store_digest = _read_evidence_snapshot(graph, limits)
    except EvidenceValidationError:
        return _unsupported("invalid-semantic-evidence", budget)
    if store is None:
        return _unsupported("semantic-evidence-not-indexed", budget)
    requested_kind = reference.split(":")[1]
    found: tuple[StoredDocument, str, str, Any] | None = None
    for entry in store["documents"].values():
        source_ref = _source_reference(entry)
        if reference == source_ref:
            found = (entry, source_ref, "source", None)
            break
        if requested_kind == "source":
            continue
        for kind, records in (
            ("declaration", entry["result"]["declarations"]),
            ("fact", entry["result"]["facts"]),
        ):
            if kind != requested_kind:
                continue
            for record in records:
                if reference == _record_reference(source_ref, kind, record):
                    found = (entry, source_ref, kind, record)
                    break
            if found is not None:
                break
        if found is not None:
            break
    if found is None:
        return _unsupported("stale-or-unknown-evidence-reference", budget)
    entry, source_ref, kind, selected = found
    if selected is None and kind != "source":
        return _unsupported("invalid-evidence-reference", budget)
    result = entry["result"]
    manifest = store["manifests"][result["analysisSetId"]]
    terms = _terms(manifest)
    declarations = {d["key"]: d for d in result["declarations"]}
    keys = (
        set(declarations)
        if selected is None
        else {selected["key"] if kind == "declaration" else selected["subject"]}
    )
    selected_facts = [
        f for f in result["facts"] if f["subject"] in keys and (kind != "fact" or f == selected)
    ]
    units = []
    for declaration in result["declarations"]:
        if declaration["key"] in keys:
            units.append((declaration["key"], None))
            units.extend(
                (declaration["key"], f)
                for f in selected_facts
                if f["subject"] == declaration["key"]
            )
    coords = _Coordinates(entry["source"], manifest["limits"]["maxSourceBytes"])
    span = (
        {"startByte": 0, "endByte": len(coords.data)}
        if selected is None
        else selected["span"]
        if kind == "declaration"
        else selected["evidence"]["span"]
    )
    scope = _digest(["inspect", store_digest, reference, excerpt_limit, excerpt_start])
    offset = _cursor_index(cursor, scope, len(units))
    if offset is None:
        return _unsupported("stale-or-invalid-continuation", budget)
    response = {
        "version": 1,
        "status": "ok",
        "reference": reference,
        "sourceReference": source_ref,
        "kind": kind,
        **_identity(entry),
        "coverage": _coverage(entry),
        "excerpt": _excerpt(entry, span, excerpt_limit, excerpt_start),
        "unknowns": [
            "Source evidence does not establish runtime execution, values, purity, or deployment.",
            "Import, type and expression references are not resolved implementation bodies.",
            "Module aliases declare API identity, not verified package contents, versions, or runtime equivalence.",
        ],
        "groups": [],
        "totalRecords": len(units),
        "truncated": offset < len(units),
        "continuation": _cursor(scope, offset) if offset < len(units) else None,
    }
    if "redaction" in entry:
        response["unknowns"].append(
            "Credentials were masked before analysis; literal-dependent facts describe the redacted view, not original values."
        )
    if _response_size(response) > budget:
        return _unsupported(
            "inspection-context-exceeds-budget", budget, requiredBytes=_response_size(response)
        )
    added = 0
    for key, fact in units[offset : offset + limits.max_page_items]:
        attempt = copy.deepcopy(response)
        group = next((g for g in attempt["groups"] if g["declaration"]["key"] == key), None)
        if group is None:
            declaration = declarations[key]
            related = []
            if "owner" in declaration:
                related.append(
                    _reference_meaning(
                        {"kind": "declaration", "key": declaration["owner"]},
                        source_ref,
                        declarations,
                    )
                )
            group = {
                "reference": _record_reference(source_ref, "declaration", declaration),
                "declaration": declaration,
                "roles": [],
                "properties": [],
                "relations": [],
                "relatedDeclarations": related,
            }
            attempt["groups"].append(group)
        if fact is not None:
            item = {
                "reference": _record_reference(source_ref, "fact", fact),
                "fact": fact,
                "vocabulary": terms[(fact["evidence"]["pluginId"], fact["kind"], fact["term"])],
            }
            target = (
                fact["target"]
                if fact["kind"] == "relation"
                else fact.get("value", {}).get("value")
                if fact["kind"] == "property" and fact.get("value", {}).get("kind") == "reference"
                else None
            )
            if target is not None:
                meaning = _reference_meaning(target, source_ref, declarations)
                item["targetEvidence"] = meaning
                if target["kind"] == "declaration" and meaning not in group["relatedDeclarations"]:
                    group["relatedDeclarations"].append(meaning)
            group[_CATEGORIES[fact["kind"]]].append(item)
        next_index = offset + added + 1
        attempt["truncated"] = next_index < len(units)
        attempt["continuation"] = _cursor(scope, next_index) if next_index < len(units) else None
        if _response_size(attempt) > budget:
            if added == 0:
                return _unsupported(
                    "indivisible-evidence-exceeds-budget",
                    budget,
                    requiredBytes=_response_size(attempt),
                    continuation=_cursor(scope, offset),
                )
            break
        response = attempt
        added += 1
    return copy.deepcopy(response)
