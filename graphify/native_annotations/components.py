"""Native public component-library usage, ownership and value contracts."""

import re

from .jsx import (
    PROPS_CONTRACT,
    args_of,
    bounded,
    expression,
    first_child,
    function_node,
    js_string,
    key,
    spread_argument,
    valid_string,
)


_ROLES = {
    "control": "Input Control Usage",
    "overlay": "Overlay Usage",
    "dom-effect": "Reversible DOM Effect Usage",
    "asset-request": "Asset API Request",
    "scene": "Scene Usage",
    "registration": "Explicit Registration",
    "resource": "Resource Contract",
    "runtime": "Scenegraph Runtime",
    "camera": "Camera Controller",
    "animation": "Animation Controller",
    "handle": "Returned Handle",
    "callback-payload": "Callback Payload Binding",
}
_PROPERTIES = {
    "api": "Reviewed Public API",
    "operation": "Requested Operation",
    "result-contract": "Declared Result Contract",
    "callback-contract": "Declared Callback Contract",
    "callback-binding": "Callback Binding Name",
    "callback-path": "Callback Payload Path",
    "prop": "Authored Property",
    "literal": "Authored Literal",
    "ownership": "Ownership Contract",
    "cleanup": "Cleanup Contract",
    "requirement": "Required Context",
    "qualification": "Source Qualification",
    "jsx-contribution": "Ordered JSX Prop Contribution",
    "props-contract": "JSX Props Resolution Contract",
    "conditional-prop-contract": "Conditional Public Prop Contract",
}
_RELATIONS = {
    "import": "Qualified Public Import",
    "target": "Requested Operation Target",
    "input": "Authored Input",
    "field": "Borrowed Field Expression",
    "value": "Controlled Value Expression",
    "checked": "Controlled Checked Expression",
    "callback": "Authored Callback",
    "created-by": "Handle Origin",
    "argument-source": "Callback Contract Source",
    "document": "Scenegraph Document",
    "scene-target": "Scene Expression",
    "options": "Authored Options",
    "spread-source": "Forwarded JSX Source",
    "forwarded-prop": "Forwarded JSX Property Expression",
    "jsx-contribution-source": "Authored JSX Contribution Source",
    "jsx-element": "Containing JSX Element Occurrence",
}
DESCRIPTOR = {
    "id": "fst-components",
    "version": "1",
    "languages": ["typescript", "tsx"],
    "view": {"id": "typescript", "version": 1},
    "roles": [{"id": f"fst-components.{name}", "label": label} for name, label in _ROLES.items()],
    "properties": [
        {"id": f"fst-components.{name}", "label": label, "multiple": True, "valueKind": "string"}
        for name, label in _PROPERTIES.items()
    ],
    "relations": [
        {"id": f"fst-components.{name}", "label": label} for name, label in _RELATIONS.items()
    ],
}

_DISCO = "@fst/components-fst-disco-ui"
_ICONS = "@fst/components-fst-solid-icons"
_THREE = "@fst/components-fst-solid-threejs"
_COMPONENTS = "TextBox TextArea Checkbox CheckboxItem Switch SwitchItem Slider Select SelectItem SelectOption ColorEditor MarkdownEditor ContextMenu Popover ModalHost ToastHost".split()
_OVERLAYS = "useModal openModal openConfirmationModal useToasts showToast dismissToast removeToast initToasts tooltip focusring".split()
_THEMES = ["applyDiscoTheme", "resolveDiscoTheme"]
_ICON_ASSETS = "loadIconDef resolveIconDef configureIconAssetLoading getIconAssetLoadingConfig resolveIconAssetUrl getIconAssetShape clearIconAssetCache getIconAssetCacheSnapshot".split()
_CANVAS = "Canvas3d Scene Canvas3dState SceneState".split()
_SCENE = "Scene3d SceneNode GLTFMeshNode GLTFMeshAnimation setupCameraControls useCameraControls getCameraPosFocusOnBoneWithZoom getCameraPosFocusBetweenBonesWithZoom".split()
_SCENEGRAPH = "SceneGraphCanvas SceneGraphRuntime createSceneGraphRuntimeData createSceneGraphHtmlSceneOverlayBridge SceneGraphHtmlSceneOverlayHost".split()
_UTILS = "loadGLTF loadTexture loaderFn setDecoderPathGLTF".split()
_EFFECTS = "setupMaterialFogEffect setupVolumetricFogEffect setupVolumetricCloudsEffect setupSsaoEffect setupPencilOutlineEffect setupPencilLinesEffect".split()
_CATALOGUE = {
    _DISCO: _COMPONENTS + _OVERLAYS + _THEMES,
    _DISCO + "/components": _COMPONENTS + _OVERLAYS,
    _DISCO + "/theme": _THEMES,
    _ICONS: _ICON_ASSETS + ["SvgIcon", "Icon"],
    _ICONS + "/assets": _ICON_ASSETS,
    _ICONS + "/components": ["SvgIcon", "Icon"],
    _THREE: _CANVAS + _SCENE + _SCENEGRAPH + _UTILS + _EFFECTS + ["AssetsManager"],
    _THREE + "/Canvas": _CANVAS,
    _THREE + "/scene": _SCENE + _SCENEGRAPH,
    _THREE + "/scene/scenegraph": _SCENEGRAPH,
    _THREE + "/utils": _UTILS,
    _THREE + "/assets": ["AssetsManager"],
    _THREE + "/effects": _EFFECTS,
}
_CAMERA_METHODS = "setCameraFocusPoint setCameraDistance setCameraFocusOnObject setCameraFocusTopDown getCameraState setCameraState resetCameraState getCameraOrbitAngles setCameraOrbitLimits addCameraControlEndListener isCameraUserControlling".split()
_ANIMATION_METHODS = "addAnimations isPlayingAnimation pose playAnimation stopAnimation pauseAnimation resumeAnimation playAnimationLayered poseLayered stopLayer setLayerWeight pauseLayer resumeLayer fadeOutLayer tweenLayerWeight stopLayerTween dispose".split()
_VALUE = {"kind": "value"}


def _object(*names):
    return {"kind": "object", "properties": {name: _VALUE for name in names}}


_SHAPES = [
    (["useModal"], _object("openModal", "openConfirmationModal")),
    (["useToasts"], _object("showToast", "dismissToast")),
    (["showToast"], _object("id")),
    (
        "openModal openConfirmationModal initToasts tooltip focusring applyDiscoTheme loaderFn loadGLTF loadTexture loadIconDef resolveIconDef".split(),
        _VALUE,
    ),
    (["setupCameraControls", "useCameraControls"], _object(*_CAMERA_METHODS)),
    (_EFFECTS[:3], _object("dispose")),
    (_EFFECTS[3:], _VALUE),
    (
        ["createSceneGraphHtmlSceneOverlayBridge"],
        _object("registerHtmlScene", "bindOverlayEntry", "entries"),
    ),
    (["getIconAssetShape"], _object("shape", "assetShape", "family", "name", "path")),
    (
        ["configureIconAssetLoading", "getIconAssetLoadingConfig"],
        _object("baseUrl", "resolver", "fetch"),
    ),
    (["resolveDiscoTheme"], _object("mode", "colors")),
    (
        ["getCameraPosFocusOnBoneWithZoom", "getCameraPosFocusBetweenBonesWithZoom"],
        {"kind": "tuple", "items": [_VALUE, _VALUE]},
    ),
]
_ASSET_METHODS = _object("loadTexture", "loadGltf", "loadGLTF")
_CONSTRUCT_SHAPES = [
    ("AssetsManager", _ASSET_METHODS),
    (
        "SceneGraphRuntime",
        _object("attach", "setDocument", "getNodeById", "getCamera", "setCamera", "dispose"),
    ),
    (
        "Scene3d",
        {
            "kind": "object",
            "properties": {
                "add": _VALUE,
                "remove": _VALUE,
                "addRenderListener": _VALUE,
                "dispose": _VALUE,
                "assets": _ASSET_METHODS,
            },
        },
    ),
    ("SceneNode", _object("dispose")),
    (
        "GLTFMeshNode",
        {
            "kind": "object",
            "properties": {"animation": _object(*_ANIMATION_METHODS), "dispose": _VALUE},
        },
    ),
    ("GLTFMeshAnimation", _object(*_ANIMATION_METHODS)),
]
RETURN_CONTRACTS = [
    {
        "id": f"fst-components.{name.lower()}",
        "origins": [
            {"module": module, "name": name}
            for module, exports in _CATALOGUE.items()
            if name in exports
        ],
        "result": result,
    }
    for names, result in _SHAPES
    for name in names
] + [
    {
        "id": f"fst-components.construct.{name.lower()}",
        "invocation": "construct",
        "origins": [
            {"module": module, "name": name}
            for module, exports in _CATALOGUE.items()
            if name in exports
        ],
        "result": result,
    }
    for name, result in _CONSTRUCT_SHAPES
]


def _contract(role, result, handle=None, cleanup=None):
    return {
        "role": role,
        "result": result,
        **({"handle": handle} if handle else {}),
        **({"cleanup": cleanup} if cleanup else {}),
    }


_CALLS = {
    "useModal": _contract(
        "overlay", "{openModal,openConfirmationModal};captured-owner", "modal-api"
    ),
    "openModal": _contract("overlay", "ModalClose(reason?);callable", "modal-close"),
    "openConfirmationModal": _contract(
        "overlay", "Promise<void>;false-confirm-keeps-open;cancel-rejects-ModalCancelledError"
    ),
    "useToasts": _contract("overlay", "{showToast,dismissToast};captured-owner", "toasts-api"),
    "showToast": _contract("overlay", "ToastHandle;callable-dismiss;readonly-id", "toast-handle"),
    "dismissToast": _contract("overlay", "void"),
    "removeToast": _contract("overlay", "void;alias-of-dismissToast"),
    "initToasts": _contract(
        "registration", "cleanup-function", "disposer", "explicit-call-or-conditional-owner-cleanup"
    ),
    "tooltip": _contract(
        "dom-effect", "disposer-function", "disposer", "explicit-call-or-conditional-owner-cleanup"
    ),
    "focusring": _contract(
        "dom-effect", "disposer-function", "disposer", "explicit-call-or-conditional-owner-cleanup"
    ),
    "applyDiscoTheme": _contract(
        "dom-effect",
        "idempotent-restore-function",
        "disposer",
        "explicit-only;no-owner-registration",
    ),
    "resolveDiscoTheme": _contract("dom-effect", "{mode,colors}"),
    "loadIconDef": _contract("asset-request", "Promise<IconDef|null>"),
    "resolveIconDef": _contract("asset-request", "Promise<IconDef|null>"),
    "configureIconAssetLoading": _contract("asset-request", "IconAssetLoadingConfig-copy"),
    "getIconAssetLoadingConfig": _contract("asset-request", "IconAssetLoadingConfig-copy"),
    "resolveIconAssetUrl": _contract("asset-request", "string;resolver-or-configured-url"),
    "getIconAssetShape": _contract("asset-request", "{shape,assetShape,family,name,path}"),
    "clearIconAssetCache": _contract("asset-request", "void;not-cancellation"),
    "getIconAssetCacheSnapshot": _contract(
        "asset-request", "IconAssetCacheSnapshotEntry[];not-live-state"
    ),
    "loadGLTF": _contract("asset-request", "Promise<GLTFData|GLTFData[]>;input-shape-dependent"),
    "loadTexture": _contract("asset-request", "Promise<Texture>;raw-resource"),
    "loaderFn": _contract("asset-request", "(LoaderCtor,...urls)=>Promise<results[]>", "loader"),
    "setDecoderPathGLTF": _contract("asset-request", "void;decoder-path-configuration"),
    "setupMaterialFogEffect": _contract(
        "resource",
        "MaterialFogEffect",
        "effect",
        "explicit-dispose-request;listener-and-material-restoration",
    ),
    "setupVolumetricFogEffect": _contract(
        "resource",
        "VolumetricFogEffectPass",
        "effect",
        "explicit-dispose-request;not-composer-removal",
    ),
    "setupVolumetricCloudsEffect": _contract(
        "resource",
        "VolumetricCloudsEffectPass",
        "effect",
        "explicit-dispose-request;not-composer-removal",
    ),
    **{name: _contract("resource", "Promise<void>;pipeline-replacement") for name in _EFFECTS[3:]},
    "createSceneGraphRuntimeData": _contract(
        "runtime", "SceneGraphRuntimeData;not-live-scene", "runtime-data"
    ),
    "createSceneGraphHtmlSceneOverlayBridge": _contract(
        "registration", "SceneGraphHtmlSceneOverlayBridgeImpl", "bridge"
    ),
    "setupCameraControls": _contract("camera", "camera-controller;registered-scene-node", "camera"),
    "useCameraControls": _contract(
        "camera", "camera-controller-or-null;named-node-lookup;not-Solid-context", "camera"
    ),
    "getCameraPosFocusOnBoneWithZoom": _contract(
        "camera", "[Vector3-position,Vector3-target];shape-only"
    ),
    "getCameraPosFocusBetweenBonesWithZoom": _contract(
        "camera", "[Vector3-position,Vector3-target];shape-only"
    ),
}
_CONSTRUCTORS = {
    "Scene3d": _contract(
        "scene", "Scene3d", "scene", "dispose-method-empty;no-GPU-cleanup-guarantee"
    ),
    "SceneNode": _contract("scene", "SceneNode", "scene-node"),
    "AssetsManager": _contract("asset-request", "AssetsManager;no-dispose-API", "assets-manager"),
    "SceneGraphRuntime": _contract("runtime", "SceneGraphRuntime", "runtime"),
    "GLTFMeshNode": _contract("animation", "GLTFMeshNode", "mesh"),
    "GLTFMeshAnimation": _contract(
        "animation", "GLTFMeshAnimation", "animation", "dispose-does-not-cancel-layer-tweens"
    ),
}
_FUNCTIONS = frozenset(("arrow_function", "function_expression", "function_declaration"))
_CONTROLS = {
    "TextBox": ("value", "onInput", "string"),
    "TextArea": ("value", "onInput", "string"),
    "Checkbox": ("checked", "onChange", "boolean"),
    "CheckboxItem": ("checked", "onChange", "boolean"),
    "Switch": ("checked", "onChange", "boolean"),
    "SwitchItem": ("checked", "onChange", "boolean"),
    "Slider": ("value", "onInput", "number"),
    "Select": ("value", "onChange", "NonNullable<T extends string|number>"),
    "SelectItem": ("value", "onChange", "NonNullable<T extends string|number>"),
    "ColorEditor": ("value", "onInput", "normalized-hex-string"),
    "MarkdownEditor": ("value", "onInput", "string"),
}
_JSX_NAMES = set(_CONTROLS) | {
    "SelectOption",
    "ContextMenu",
    "Popover",
    "ModalHost",
    "ToastHost",
    "SvgIcon",
    "Icon",
    "Canvas3d",
    "Scene",
    "SceneGraphCanvas",
    "SceneGraphHtmlSceneOverlayHost",
}


def _member_contract(kind, name):
    if kind == "modal-api" and name in ("openModal", "openConfirmationModal"):
        return _CALLS[name]
    if kind == "toasts-api" and name in ("showToast", "dismissToast"):
        return _CALLS[name]
    if kind == "scene":
        if name == "add":
            return _contract("scene", "same-node-argument")
        if name == "addRenderListener":
            return _contract(
                "registration", "{priority,dispose}", "render-listener", "explicit-listener-dispose"
            )
        if name in ("remove", "dispose"):
            return _contract(
                "scene",
                "void;empty-implementation;no-GPU-cleanup-guarantee"
                if name == "dispose"
                else "void",
            )
    if kind == "assets-manager" and name in ("loadGltf", "loadGLTF", "loadTexture"):
        return _contract(
            "asset-request",
            "Promise<TextureAssetEntry>;texture-optional;failure-swallowed"
            if name == "loadTexture"
            else "Promise<GltfAssetEntry>;failure-evicts-and-rethrows",
        )
    if kind == "bridge":
        if name == "registerHtmlScene":
            return _contract(
                "registration",
                "{updateConfig,updateProjection,requestCapture,dispose}",
                "html-registration",
            )
        if name == "bindOverlayEntry":
            return _contract("registration", "unbind-function", "disposer")
    if kind == "html-registration" and name in (
        "updateConfig",
        "updateProjection",
        "requestCapture",
        "dispose",
    ):
        return _contract("registration", "void")
    if kind == "runtime" and name in (
        "attach",
        "setDocument",
        "getNodeById",
        "getCamera",
        "setCamera",
        "dispose",
    ):
        return _contract(
            "runtime",
            "SceneGraphRuntimeNodeHandle|null;transient"
            if name == "getNodeById"
            else "SceneGraphCameraJson"
            if name == "getCamera"
            else "void",
            "runtime-node" if name == "getNodeById" else None,
        )
    if kind == "runtime-node" and name == "captureSnapshot":
        return _contract("resource", "{texture,width,height,dispose}|null", "snapshot")
    if kind == "camera" and name in _CAMERA_METHODS:
        return _contract(
            "camera",
            "{dispose};pending-registration-not-guaranteed-removed"
            if name == "addCameraControlEndListener"
            else "{position,target}|null"
            if name == "getCameraState"
            else "{azimuthAngle,polarAngle}|null"
            if name == "getCameraOrbitAngles"
            else "boolean"
            if name == "isCameraUserControlling"
            else "same-controller",
            "camera-listener"
            if name == "addCameraControlEndListener"
            else "camera"
            if name.startswith("set") or name == "resetCameraState"
            else None,
        )
    if kind == "animation" and name in _ANIMATION_METHODS:
        return _contract(
            "animation",
            "AnimationAction|null"
            if name in ("playAnimationLayered", "poseLayered")
            else "number"
            if name == "addAnimations"
            else "boolean"
            if name == "isPlayingAnimation"
            else "void",
            cleanup="does-not-cancel-layer-tweens;stopLayerTween-is-explicit"
            if name == "dispose"
            else None,
        )
    if (
        kind in ("effect", "render-listener", "camera-listener", "snapshot", "scene-node", "mesh")
        and name == "dispose"
    ):
        return _contract("handle", "void;explicit-disposal-request-only")
    return None


def analyze(view, budget, emitter):
    if view.state in ("truncated", "unsupported", "failed"):
        return {"state": view.state, "diagnostics": []}
    diagnostics, matched = [], False

    def diagnose(code, message, node):
        if len(diagnostics) < 8 and not any(item["code"] == code for item in diagnostics):
            diagnostics.append({"code": code, "message": message, "span": view.span(node)})

    def evidence(node):
        return {"ruleId": "public-contract", "basis": "import-bound", "span": view.span(node)}

    def role(term, node):
        nonlocal matched
        budget.step()
        owner = view.owner(node)
        if owner:
            matched = True
            emitter.role(owner["key"], term, evidence(node))

    def property_(term, value, node, resolution="literal"):
        nonlocal matched
        budget.step()
        owner = view.owner(node)
        if not owner:
            return
        if not valid_string(view, value):
            diagnose(
                "fst-components.value-limit",
                "Contract text exceeds the bounded wire value contract.",
                node,
            )
            return
        matched = True
        emitter.property(
            owner["key"], term, resolution, {"kind": "string", "value": value}, evidence(node)
        )

    def relation(term, target, node):
        nonlocal matched
        budget.step()
        owner = view.owner(node)
        if not owner:
            return
        if not bounded(view, target):
            diagnose(
                "fst-components.reference-limit",
                "Source reference exceeds the bounded wire value size.",
                node,
            )
            return
        matched = True
        emitter.relation(owner["key"], term, target, evidence(node))

    def api(node):
        if node is None:
            return None
        origin = view.resolve(node)
        return (
            origin["name"]
            if origin.get("kind") == "import"
            and not origin.get("member")
            and origin["name"] in _CATALOGUE.get(origin["module"], ())
            else None
        )

    def access(node):
        node = view.unwrap(node)
        if (
            node.type != "member_expression"
            or "?." in node.tokens
            or not node.fields.get("object")
            or not node.fields.get("property")
        ):
            return None
        name = view.name(node.fields["property"])
        return (node.fields["object"], name) if name else None

    jsx, call_nodes, relevant = [], [], False
    for node in view.nodes:
        budget.step()
        if node.type in ("jsx_opening_element", "jsx_self_closing_element"):
            tag = node.fields.get("name")
            name = api(tag)
            if tag and name:
                jsx.append((node, name, tag))
                relevant = True
        if node.type in ("call_expression", "new_expression"):
            call_nodes.append(node)
            if api(node.fields.get("function") or node.fields.get("constructor")):
                relevant = True
    if not relevant:
        return {"state": "not-applicable", "diagnostics": []}
    projections, parameter_kinds = {}, {}
    unsafe, unsafe_factories, escaped_imports = set(), set(), set()
    receiver_proofs_limited = False

    def project(node, path=()):
        cache_key = key(node), tuple(path)
        if cache_key not in projections:
            budget.step(512)
            projections[cache_key] = view.project(node, list(path))
        return projections[cache_key]

    def constructor_escaped(node):
        budget.step()
        if node is None:
            return False
        origin = view.resolve(node)
        return origin.get("kind") == "import" and (
            (origin["module"], origin["name"]) in escaped_imports
            or (origin["module"], "*") in escaped_imports
        )

    def taint(input_node, seen=None):
        nonlocal receiver_proofs_limited
        budget.step()
        if seen is None:
            seen = set()
        if key(input_node) in seen:
            return
        if len(seen) >= 32:
            receiver_proofs_limited = True
            diagnose(
                "fst-components.call-shape",
                "Receiver escape analysis exceeded the bounded syntax shape; receiver operations are omitted.",
                input_node,
            )
            return
        node = view.unwrap(input_node)
        if (node.type.endswith("_pattern") and node.children) or node.type in (
            "object",
            "array",
            "spread_element",
            "pair",
            "arrow_function",
            "function_expression",
            "function_declaration",
            "method_definition",
            "statement_block",
            "return_statement",
            "ternary_expression",
            "binary_expression",
            "sequence_expression",
            "await_expression",
            "yield_expression",
            "template_substitution",
            "jsx_expression",
        ):
            seen.add(key(input_node))
            selected = (
                node.fields.get("value")
                if node.type in ("pair", "pair_pattern")
                else node.fields.get("left")
                if node.type in ("assignment_pattern", "object_assignment_pattern")
                else None
            )
            for child in [selected] if selected else node.children:
                taint(child, seen)
            return
        if node.type in ("member_expression", "subscript_expression") and node.fields.get("object"):
            seen.add(key(input_node))
            taint(node.fields["object"], seen)
            return
        binding = view.binding(node)
        if not binding or key(binding["node"]) in seen:
            return
        if binding.get("origin"):
            escaped_imports.add((binding["origin"]["module"], binding["origin"]["name"]))
        projected = project(node)
        if projected and projected.get("contract", "").startswith("fst-components."):
            unsafe_factories.add(key(projected["initializer"]))
        seen.add(key(binding["node"]))
        unsafe.add(key(binding["node"]))
        if binding["kind"] == "const" and binding.get("initializer"):
            taint(binding["initializer"], seen)
        elif binding["kind"] == "const" and binding.get("declaration"):
            budget.step(512)
            source = view.initializerProjection(binding["declaration"])
            if source:
                taint(source["initializer"], seen)
        elif binding["kind"] == "function" and binding.get("declaration"):
            fn = view.declarationNode(binding["declaration"])
            if fn and fn.fields.get("body"):
                taint(fn.fields["body"], seen)

    for node in view.nodes:
        budget.step()
        if (
            node.type in ("jsx_opening_element", "jsx_self_closing_element")
            and api(node.fields.get("name")) not in _JSX_NAMES
        ):
            for child in node.children:
                if child.type == "jsx_attribute" and len(child.children) > 1:
                    taint(child.children[1])
                if child.type == "jsx_expression":
                    taint(child)
            element = view.parent(node)
            if element and element.type == "jsx_element":
                for child in element.children:
                    if child.type == "jsx_expression":
                        taint(child)
        if node.type in ("return_statement", "yield_expression"):
            for child in node.children:
                taint(child)
        if node.type == "public_field_definition" and node.fields.get("value"):
            taint(node.fields["value"])
        if (
            node.type == "arrow_function"
            and node.fields.get("body")
            and node.fields["body"].type != "statement_block"
        ):
            taint(node.fields["body"])
        if node.type in (
            "assignment_expression",
            "augmented_assignment_expression",
            "update_expression",
            "for_in_statement",
        ) or (node.type == "unary_expression" and "delete" in node.tokens):
            left = node.fields.get("left") or node.fields.get("argument")
            if left:
                taint(left)
            if node.fields.get("right"):
                taint(node.fields["right"])

    def member_identity(identity, name):
        if identity.get("method"):
            return None
        kind = {
            ("setup-payload", "scene"): "scene",
            ("setup-payload", "invalidateRender"): "invalidate",
            ("modal-payload", "close"): "modal-close",
            ("mesh", "animation"): "animation",
            ("scene", "assets"): "assets-manager",
        }.get((identity["kind"], name))
        if kind:
            return {**identity, "kind": kind}
        return {**identity, "method": name} if _member_contract(identity["kind"], name) else None

    def identity(input_node, depth=0, seen=frozenset()):
        budget.step()
        if receiver_proofs_limited or depth > 16 or key(input_node) in seen:
            return None
        seen = seen | {key(input_node)}
        node = view.unwrap(input_node)
        binding = view.binding(node)
        if binding:
            if (
                not binding.get("available")
                or binding.get("typeOnly")
                or key(binding["node"]) in unsafe
            ):
                return None
            if binding["kind"] == "parameter":
                return parameter_kinds.get(key(binding["node"]))
            if not binding.get("stable") or binding["kind"] != "const":
                return None
            projected = project(node)
            if projected and projected.get("contract", "").startswith("fst-components."):
                initial = projected["initializer"]
                if key(initial) in unsafe_factories:
                    return None
                name = api(initial.fields.get("function") or initial.fields.get("constructor"))
                handle = (
                    (_CONSTRUCTORS if initial.type == "new_expression" else _CALLS)
                    .get(name, {})
                    .get("handle")
                    if name
                    else None
                )
                if not handle:
                    return None
                result = {"kind": handle, "origin": initial}
                for part in projected["path"]:
                    if not result or not isinstance(part, str):
                        return None
                    result = member_identity(result, part)
                if (
                    not (result or {}).get("method")
                    and initial.type == "new_expression"
                    and constructor_escaped(initial.fields.get("constructor"))
                ):
                    return None
                return result
            return (
                identity(binding["initializer"], depth + 1, seen)
                if binding.get("initializer")
                else None
            )
        member = access(node)
        if member:
            object_node, name = member
            base = identity(object_node, depth + 1, seen)
            if base is None:
                return None
            current, parent = node, view.parent(node)
            while (
                parent
                and parent.type == "member_expression"
                and parent.fields.get("object") is current
            ):
                budget.step()
                current, parent = parent, view.parent(parent)
            direct = (
                parent
                and parent.type == "call_expression"
                and parent.fields.get("function") is current
            )
            root = project(object_node)
            if (
                not direct
                and root
                and root.get("contract", "").startswith("fst-components.")
                and not project(object_node, [name])
            ):
                return None
            return member_identity(base, name)
        if node.type == "new_expression":
            name = api(node.fields.get("constructor"))
            handle = _CONSTRUCTORS.get(name, {}).get("handle") if name else None
            projected = (
                project(node)
                if handle and not constructor_escaped(node.fields.get("constructor"))
                else None
            )
            return (
                {"kind": handle, "origin": node}
                if projected
                and projected.get("contract", "").startswith("fst-components.construct.")
                else None
            )
        if node.type == "call_expression" and "?." not in node.tokens:
            args = args_of(node)
            if any(arg.type == "spread_element" for arg in args):
                return None
            invocation = invoke(node, depth + 1, seen)
            if invocation:
                if invocation["contract"].get("handle"):
                    return {"kind": invocation["contract"]["handle"], "origin": node}
                if (
                    invocation.get("receiver", {}).get("kind") == "scene"
                    and invocation["name"] == "add"
                    and args
                ):
                    return identity(args[0], depth + 1, seen)
        return None

    def invoke(node, depth=0, seen=frozenset()):
        budget.step()
        if depth > 16 or "?." in node.tokens:
            return None
        fn = node.fields.get("function") or node.fields.get("constructor")
        if fn is None:
            return None
        name = api(fn)
        contract = (
            (_CONSTRUCTORS if node.type == "new_expression" else _CALLS).get(name) if name else None
        )
        if name and contract:
            return {"name": name, "contract": contract, "target": fn}
        if node.type != "call_expression":
            return None
        handle = identity(fn, depth + 1, seen)
        if handle is None:
            return None
        if handle.get("method"):
            contract = _member_contract(handle["kind"], handle["method"])
            member = access(fn)
            return (
                {
                    "name": handle["method"],
                    "contract": contract,
                    "target": member[0] if member else fn,
                    "receiver": handle,
                }
                if contract
                else None
            )
        kind = handle["kind"]
        result = (
            "Promise<results[]>;argument-length-list"
            if kind == "loader"
            else "void;requested-operation-only"
            if kind in ("modal-close", "toast-handle", "disposer", "invalidate")
            else None
        )
        return (
            {
                "name": {
                    "invalidate": "invalidateRender",
                    "loader": "load-results",
                    "modal-close": "close",
                    "toast-handle": "dismiss",
                }.get(kind, "dispose"),
                "contract": _contract("handle", result),
                "target": fn,
                "receiver": handle,
            }
            if result
            else None
        )

    def literal(input_node, anchor, name):
        node = view.unwrap(input_node)
        if node.type not in (
            "identifier",
            "string",
            "number",
            "true",
            "false",
            "null",
            "template_string",
            "binary_expression",
            "unary_expression",
        ):
            return
        budget.step(8 if node.type in ("string", "number", "true", "false", "null") else 512)
        result = view.constant(input_node)
        if (
            result.get("known")
            and "value" in result
            and (result["value"] is None or type(result["value"]) in (str, int, float, bool))
        ):
            property_(
                "fst-components.literal",
                f"{name}={js_string(result['value'])}",
                anchor,
                result["resolution"],
            )

    def fn_of(node):
        return function_node(view, budget, node, _FUNCTIONS, 16)

    def callback(input_node, contract, anchor, source, payload=None):
        relation("fst-components.callback", view.reference(input_node), anchor)
        property_("fst-components.callback-contract", contract, anchor)
        if contract[contract.find("(") : contract.find("(") + 2] == "()":
            return
        fn = fn_of(input_node)
        if fn is None:
            return
        params = fn.fields.get("parameters") or fn.fields.get("parameter")
        first = first_child(params) if params and params.type == "formal_parameters" else params
        if first is None:
            return
        budget.step(16)
        projected = view.patternProjections(first)
        if not projected["complete"] or len(projected["projections"]) > 16:
            diagnose(
                "fst-components.callback-pattern",
                "Only bounded static callback parameter patterns are represented.",
                first,
            )
            return
        for item in projected["projections"]:
            budget.step()
            name = view.name(item["node"])
            if not name:
                continue
            role("fst-components.callback-payload", item["node"])
            property_("fst-components.callback-binding", name, item["node"])
            property_(
                "fst-components.callback-path",
                ".".join(["0", *map(str, item["path"])]),
                item["node"],
            )
            property_("fst-components.callback-contract", contract, item["node"])
            relation("fst-components.argument-source", source, item["node"])
            kind = (payload or {}).get(".".join(map(str, item["path"])))
            if kind and view.unwrap(input_node) is fn:
                parameter_kinds[key(item["node"])] = {"kind": kind, "origin": anchor}

    def object_properties(input_node):
        result = {}
        if input_node is None:
            return result
        projected = project(input_node)
        node = (
            view.unwrap(projected["initializer"])
            if projected and not projected["path"]
            else view.unwrap(input_node)
        )
        if node.type != "object" or len(node.children) > 64:
            return result
        for child in node.children:
            budget.step()
            if child.type == "comment":
                continue
            if child.type == "pair" and child.fields.get("key") and child.fields.get("value"):
                name = view.name(child.fields["key"])
                if not name or child.fields["key"].type == "computed_property_name":
                    return {}
                result[name] = child.fields["value"]
            elif child.type == "shorthand_property_identifier":
                name = view.name(child)
                if name:
                    result[name] = child
            else:
                return {}
        if view.unwrap(input_node) is not node:
            result = {name: value for name, value in result.items() if project(input_node, [name])}
        return result

    def option_callbacks(input_node, names, anchor, source):
        for name, value in object_properties(input_node).items():
            if name in names:
                callback(value, f"{name}:{names[name]}", value, source)

    def spread_properties(input_node, observation, seen=frozenset()):
        budget.step(512)
        if len(seen) >= 16 or not view.referenceStable(input_node, observation, "before-call"):
            return None
        projected = project(input_node)
        node = (
            view.unwrap(projected["initializer"]) if projected and not projected["path"] else None
        )
        if node is None or node.type != "object" or key(node) in seen or len(node.children) > 64:
            return None
        active, result = seen | {key(node)}, {}
        for child in node.children:
            budget.step()
            if child.type == "comment":
                continue
            if child.type == "spread_element":
                value = first_child(child)
                nested = spread_properties(value, observation, active) if value else None
                if nested is None:
                    return None
                result.update(nested)
            elif child.type == "shorthand_property_identifier":
                result[view.text(child)] = child
            else:
                name = (
                    view.name(child.fields["key"])
                    if child.fields.get("key")
                    and child.fields["key"].type != "computed_property_name"
                    else None
                )
                if (
                    child.type != "pair"
                    or not name
                    or name == "__proto__"
                    or not child.fields.get("value")
                ):
                    return None
                result[name] = child.fields["value"]
            if len(result) > 64:
                return None
        return result

    for node, name, tag in jsx:
        budget.step()
        control = _CONTROLS.get(name)
        if name not in _JSX_NAMES:
            continue
        role(
            "fst-components.control"
            if control
            else "fst-components.asset-request"
            if name in ("SvgIcon", "Icon")
            else "fst-components.scene"
            if "Scene" in name or name == "Canvas3d"
            else "fst-components.overlay",
            node,
        )
        property_("fst-components.api", name, node)
        relation("fst-components.import", view.resolve(tag), node)
        if name == "MarkdownEditor":
            property_(
                "fst-components.qualification",
                "Zen-public-export;absent-from-inspected-Funtasia-barrel",
                node,
            )
        if name == "SelectOption":
            property_("fst-components.requirement", "containing-Select", node)
        if name == "Scene":
            property_(
                "fst-components.requirement",
                "Canvas3dState-required;SceneState-provided;setup-return-awaited-not-cleanup",
                node,
            )
        if name == "Canvas3d":
            property_(
                "fst-components.cleanup",
                "frames-observer-listeners-only;no-context-dispose-call",
                node,
            )
        attributes, seen = {}, set()
        parent = view.parent(node)
        observation = (
            parent
            if node.type == "jsx_opening_element" and parent and parent.type == "jsx_element"
            else node
        )
        sequence_supported = control is not None or name == "Popover"
        has_spreads = any(
            child.type == "jsx_expression"
            and any(value.type == "spread_element" for value in child.children)
            for child in node.children
        )
        ordinal, group, unresolved_spread = 0, 0, False

        def contribution(attr, kind, value):
            nonlocal ordinal
            property_("fst-components.jsx-contribution", f"{ordinal}:group={group}:{kind}", attr)
            ordinal += 1
            relation("fst-components.jsx-contribution-source", expression(view, value), attr)
            relation("fst-components.jsx-element", expression(view, node), attr)

        if has_spreads and sequence_supported:
            property_("fst-components.props-contract", PROPS_CONTRACT, node)
            if control:
                property_(
                    "fst-components.conditional-prop-contract",
                    f"field: if selected, borrowed Field with no disposal transfer; {control[0]}: controlled input candidate; final field/value ownership mode unproven",
                    node,
                )
                property_(
                    "fst-components.conditional-prop-contract",
                    f"{control[1]}: if selected and notified, callback({control[2]}); value-not-native-event; handler identity and delivery unproven",
                    node,
                )
                if name == "ColorEditor":
                    property_(
                        "fst-components.conditional-prop-contract",
                        "onCommit: if selected and notified, callback(normalized-hex-string); notification-not-second-field-write; handler identity and delivery unproven",
                        node,
                    )
                if name == "MarkdownEditor":
                    property_(
                        "fst-components.conditional-prop-contract",
                        "apiRef: if selected, callback(MarkdownEditorHandle|undefined); cleared-on-cleanup; handler identity and execution unproven",
                        node,
                    )
            else:
                property_(
                    "fst-components.conditional-prop-contract",
                    "open: controlled visibility input; anchor: native element or undefined; onOpenChange: if selected and notified, callback(boolean), dismissal requests false; final bindings and visibility unproven",
                    node,
                )
        for attr in node.children:
            budget.step()
            if attr.type == "jsx_expression":
                value = spread_argument(attr)
                if value is None:
                    continue
                group += 1
                if has_spreads and sequence_supported:
                    contribution(attr, "spread", value)
                group += 1
                seen.clear()
                relation("fst-components.spread-source", view.reference(value), attr)
                fields = spread_properties(value, observation)
                if fields is None:
                    attributes.clear()
                    seen.clear()
                    unresolved_spread = True
                    property_(
                        "fst-components.qualification",
                        "forwarded props have unknown keys; earlier props may be overridden",
                        attr,
                    )
                    if not sequence_supported:
                        diagnose(
                            "fst-components.dynamic-props",
                            "This API has no reviewed conditional prop-resolution contract for unknown forwarded keys.",
                            attr,
                        )
                    continue
                property_(
                    "fst-components.qualification",
                    "forwarded own properties; authored override order; values are not runtime constants",
                    attr,
                )
                for prop, value in fields.items():
                    attributes[prop] = {
                        "attr": attr,
                        "group": group - 1,
                        "value": value,
                        "spread": True,
                        "fallback": unresolved_spread or prop in attributes,
                    }
                continue
            if attr.type != "jsx_attribute" or not attr.children:
                continue
            prop = view.name(attr.children[0])
            if not prop:
                continue
            if has_spreads and sequence_supported:
                contribution(attr, f"attribute:{prop}", attr)
            if prop in seen:
                attributes.pop(prop, None)
                diagnose(
                    "fst-components.dynamic-props",
                    "Duplicate JSX property overrides are not inferred.",
                    attr,
                )
                continue
            seen.add(prop)
            raw = attr.children[1] if len(attr.children) > 1 else None
            value = first_child(raw) if raw and raw.type == "jsx_expression" else raw
            attributes[prop] = {
                "attr": attr,
                "group": group,
                "raw": raw,
                "value": value,
                "fallback": unresolved_spread
                or (prop in attributes and attributes[prop]["group"] != group),
            }
        if has_spreads and sequence_supported and observation is not node:
            for child in observation.children:
                budget.step()
                if (
                    child is not node
                    and child.type not in ("jsx_closing_element", "comment")
                    and (child.type != "jsx_text" or view.text(child).strip())
                ):
                    contribution(child, "nested-child-source", child)
        for prop, attribute in attributes.items():
            budget.step()
            attr, value, raw = attribute["attr"], attribute.get("value"), attribute.get("raw")
            if attribute.get("fallback") and value:
                budget.step(512)
                known, fn = view.constant(value), fn_of(value)
                if not (known.get("known") and "value" in known) and not (
                    fn and view.referenceStable(value, observation, "before-call")
                ):
                    continue
            if attribute.get("spread") and value:
                pair = view.parent(value)
                relation(
                    "fst-components.forwarded-prop",
                    view.reference(
                        pair
                        if pair and pair.type == "pair" and pair.fields.get("value") is value
                        else value
                    ),
                    attr,
                )
            if value is None:
                if (control and prop == "checked") or (name == "Popover" and prop == "open"):
                    property_("fst-components.prop", prop, node)
                    property_("fst-components.literal", f"{prop}=true", node)
                    relation(
                        "fst-components.checked" if prop == "checked" else "fst-components.input",
                        view.reference(attr),
                        node,
                    )
                continue
            literal_safe = (
                attribute.get("spread")
                or raw is None
                or raw.type != "string"
                or not re.search(r"[&\\\r\n]", view.text(raw))
            )
            if control and prop in ("field", control[0]):
                property_("fst-components.prop", prop, node)
                relation(f"fst-components.{prop}", view.reference(value), node)
                if prop == "field":
                    property_(
                        "fst-components.ownership",
                        "borrowed-field;user-write-contract;no-field-disposal",
                        node,
                    )
                elif literal_safe:
                    literal(value, node, prop)
            if control and prop == control[1]:
                callback(
                    value,
                    f"{name}.{prop}({control[2]});value-not-native-event",
                    node,
                    view.resolve(tag),
                )
            if name == "ColorEditor" and prop == "onCommit":
                callback(
                    value,
                    "ColorEditor.onCommit(normalized-hex-string);notification-not-second-field-write",
                    node,
                    view.resolve(tag),
                )
            if name == "MarkdownEditor" and prop == "apiRef":
                callback(
                    value,
                    "MarkdownEditor.apiRef(MarkdownEditorHandle|undefined);cleared-on-cleanup",
                    node,
                    view.resolve(tag),
                )
                property_(
                    "fst-components.ownership", "borrowed-editor-handle;no-destroy-ownership", node
                )
            if name == "Scene" and prop == "setup":
                callback(
                    value,
                    "Scene.setup({scene:IScene,invalidateRender:()=>void});awaited-not-cleanup",
                    node,
                    view.resolve(tag),
                    {"": "setup-payload", "scene": "scene", "invalidateRender": "invalidate"},
                )
            if name == "SceneGraphCanvas" and prop in ("onRuntimeReady", "onRuntimeDispose"):
                callback(
                    value,
                    f"{prop}(SceneGraphRuntime);component-managed",
                    node,
                    view.resolve(tag),
                    {"": "runtime"},
                )
            if name == "Popover" and prop == "onOpenChange":
                callback(
                    value,
                    "Popover.onOpenChange(boolean);dismissal-requests-false",
                    node,
                    view.resolve(tag),
                )
            if name == "ContextMenu" and prop == "onClose":
                callback(
                    value,
                    "ContextMenu.onClose();close-request-before-selection-action",
                    node,
                    view.resolve(tag),
                )
            if name == "ContextMenu" and prop == "items":
                items = view.unwrap(value)
                if (
                    items.type == "array"
                    and len(items.children) <= 32
                    and not any(item.type == "spread_element" for item in items.children)
                ):
                    for item in items.children:
                        option_callbacks(
                            item,
                            {"onSelect": "()=>void;after-close-request"},
                            attr,
                            view.resolve(tag),
                        )
            authored = (
                (name in ("SvgIcon", "Icon") and prop == "shape")
                or (name == "Popover" and prop in ("open", "anchor"))
                or (name == "ContextMenu" and prop in ("position", "items"))
                or (name == "SceneGraphCanvas" and prop in ("document", "assetBaseUrl"))
                or (name == "SceneGraphHtmlSceneOverlayHost" and prop == "bridge")
                or (name in ("ColorEditor", "MarkdownEditor") and prop == "resetKey")
            )
            if authored:
                property_("fst-components.prop", prop, node)
                relation(
                    "fst-components.document" if prop == "document" else "fst-components.input",
                    view.reference(value),
                    node,
                )
                if literal_safe:
                    literal(value, node, prop)
            if name == "SceneGraphCanvas" and prop in ("assetUrlResolver", "htmlComponentResolver"):
                callback(
                    value,
                    "(assetKey,purpose)=>string;not-executed"
                    if prop == "assetUrlResolver"
                    else "component-definition-resolver;not-executed",
                    node,
                    view.resolve(tag),
                )
            if name == "SceneGraphHtmlSceneOverlayHost" and prop == "componentResolver":
                callback(
                    value, "component-definition-resolver;not-executed", node, view.resolve(tag)
                )

    # Escapes invalidate later receiver requests even inside deferred callbacks.
    for node in call_nodes:
        budget.step()
        if invoke(node):
            continue
        fn = view.unwrap(node.fields["function"]) if node.fields.get("function") else None
        receiver = (
            fn.fields.get("object")
            if fn and fn.type in ("member_expression", "subscript_expression")
            else None
        )
        if receiver:
            taint(receiver)
        for arg in args_of(node):
            taint(arg)
    for node in call_nodes:
        budget.step()
        found = invoke(node)
        if not found:
            continue
        name, contract, target, receiver = (
            found["name"],
            found["contract"],
            found["target"],
            found.get("receiver"),
        )
        args = args_of(node)
        if any(arg.type == "spread_element" for arg in args):
            diagnose(
                "fst-components.call-shape",
                "Spread call arguments are not assigned positional contracts.",
                node,
            )
            continue
        role(f"fst-components.{contract['role']}", node)
        property_("fst-components.api", f"{receiver['kind']}.{name}" if receiver else name, node)
        property_("fst-components.operation", f"{name}-request", node)
        property_("fst-components.result-contract", contract["result"], node)
        relation(
            "fst-components.target" if receiver else "fst-components.import",
            view.reference(target) if receiver else view.resolve(target),
            node,
        )
        if contract.get("handle"):
            role("fst-components.handle", node)
            relation("fst-components.created-by", view.reference(target), node)
        if contract.get("cleanup"):
            property_("fst-components.cleanup", contract["cleanup"], node)
        if (
            receiver
            and receiver.get("method")
            and node.fields.get("function")
            and not access(node.fields["function"])
        ):
            property_(
                "fst-components.qualification",
                "captured-method-request;this-binding-and-success-unproven",
                node,
            )
        if name in ("useModal", "useToasts"):
            property_("fst-components.ownership", "owner-captured-at-call;not-host-binding", node)
        source = view.reference(target) if receiver else view.resolve(target)
        for index, arg in enumerate(args):
            if index >= 8:
                diagnose(
                    "fst-components.call-shape",
                    "Only the first eight explicit argument references are retained.",
                    node,
                )
                break
            term = (
                "fst-components.scene-target"
                if index == 0
                and (name.startswith("setup") or name in ("useCameraControls", "attach"))
                else "fst-components.document"
                if index == 0
                and name in ("SceneGraphRuntime", "createSceneGraphRuntimeData", "setDocument")
                else "fst-components.input"
            )
            relation(term, view.reference(arg), arg)
            literal(arg, arg, f"arg{index}")
        if name in ("tooltip", "focusring") and len(args) > 1:
            callback(
                args[1],
                "()=>JSX.Element|[bottom:boolean,JSX.Element];not-visibility"
                if name == "tooltip"
                else "()=>number|true",
                args[1],
                source,
            )
        if name == "openModal":
            if args:
                callback(
                    args[0],
                    "content({close:ModalClose})",
                    args[0],
                    source,
                    {"": "modal-payload", "close": "modal-close"},
                )
            option_callbacks(
                args[1] if len(args) > 1 else None,
                {"onClose": "(ModalCloseReason)=>void"},
                node,
                source,
            )
        if name == "openConfirmationModal":
            option_callbacks(
                args[0] if args else None,
                {
                    "onConfirm": "()=>void|boolean|Promise<void|boolean>;false-keeps-open",
                    "onCancel": "()=>void|Promise<void>",
                },
                node,
                source,
            )
        if name == "showToast":
            option_callbacks(
                args[0] if args else None,
                {"onClick": "()=>void", "onClose": "()=>void"},
                node,
                source,
            )
        if name in (
            "configureIconAssetLoading",
            "loadIconDef",
            "resolveIconDef",
            "resolveIconAssetUrl",
        ):
            index = 0 if name == "configureIconAssetLoading" else 1
            option_callbacks(
                args[index] if len(args) > index else None,
                {
                    "resolver": "(IconAssetShape)=>string|URL|null|undefined",
                    "fetch": "fetch-contract;not-executed",
                },
                node,
                source,
            )
        if name == "loadGLTF" and not receiver and len(args) > 3:
            callback(args[3], "(GLTFLoader)=>void", args[3], source)
        if name == "loaderFn":
            if args:
                callback(args[0], "(Loader)=>void", args[0], source)
            if len(args) > 1:
                callback(args[1], "(ProgressEvent)=>void", args[1], source)
        if receiver and receiver["kind"] == "scene" and name == "add":
            option_callbacks(
                args[1] if len(args) > 1 else None,
                {"onAdded": "({scene,node})=>void"},
                node,
                source,
            )
        if receiver and receiver["kind"] == "scene" and name == "addRenderListener":
            option_callbacks(
                args[0] if args else None,
                {
                    "onBeforeRenderScene": "({delta:number})=>void",
                    "onAfterRenderScene": "({delta:number})=>void",
                },
                node,
                source,
            )
        if name == "SceneGraphRuntime":
            option_callbacks(
                args[1] if len(args) > 1 else None,
                {
                    "assetUrlResolver": "(assetKey,purpose)=>string",
                    "onRenderInvalidated": "()=>void",
                    "onNodeLoaded": "(nodeId:string)=>void",
                },
                node,
                source,
            )
        if receiver and receiver["kind"] == "bridge" and name == "registerHtmlScene":
            option_callbacks(
                args[1] if len(args) > 1 else None,
                {
                    "onTextureCanvas": "(HTMLCanvasElement)=>void",
                    "onCaptureSizeChanged": "(width:number,height:number)=>void",
                },
                node,
                source,
            )
        if name == "addCameraControlEndListener" and args:
            callback(
                args[0], "()=>void;pending-registration-disposal-not-guaranteed", args[0], source
            )
        if receiver and receiver["kind"] == "animation":
            index = (
                1
                if name in ("poseLayered", "playAnimationLayered")
                else 3
                if name == "tweenLayerWeight"
                else -1
            )
            options = args[index] if 0 <= index < len(args) else None
            option_callbacks(
                options,
                {
                    "trackMask": "(trackName:string)=>boolean",
                    "onUpdate": "({startWeight,weight,pct})=>void",
                    "onComplete": "()=>void",
                },
                node,
                source,
            )
            layer = object_properties(options).get("layerKey")
            if layer:
                literal(layer, node, "layerKey")
    return {
        "state": "partial" if diagnostics else "complete" if matched else "not-applicable",
        "diagnostics": diagnostics,
    }
