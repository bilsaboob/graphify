import type { ReturnContract, ReturnShape } from '#typescript';

const disco = '@fst/components-fst-disco-ui';
const icons = '@fst/components-fst-solid-icons';
const three = '@fst/components-fst-solid-threejs';
const componentNames = ['TextBox', 'TextArea', 'Checkbox', 'CheckboxItem', 'Switch', 'SwitchItem', 'Slider', 'Select', 'SelectItem', 'SelectOption', 'ColorEditor', 'MarkdownEditor', 'ContextMenu', 'Popover', 'ModalHost', 'ToastHost'];
const overlayNames = ['useModal', 'openModal', 'openConfirmationModal', 'useToasts', 'showToast', 'dismissToast', 'removeToast', 'initToasts', 'tooltip', 'focusring'];
const themeNames = ['applyDiscoTheme', 'resolveDiscoTheme'];
const iconAssets = ['loadIconDef', 'resolveIconDef', 'configureIconAssetLoading', 'getIconAssetLoadingConfig', 'resolveIconAssetUrl', 'getIconAssetShape', 'clearIconAssetCache', 'getIconAssetCacheSnapshot'];
const canvas = ['Canvas3d', 'Scene', 'Canvas3dState', 'SceneState'];
const scene = ['Scene3d', 'SceneNode', 'GLTFMeshNode', 'GLTFMeshAnimation', 'setupCameraControls', 'useCameraControls', 'getCameraPosFocusOnBoneWithZoom', 'getCameraPosFocusBetweenBonesWithZoom'];
const scenegraph = ['SceneGraphCanvas', 'SceneGraphRuntime', 'createSceneGraphRuntimeData', 'createSceneGraphHtmlSceneOverlayBridge', 'SceneGraphHtmlSceneOverlayHost'];
const utils = ['loadGLTF', 'loadTexture', 'loaderFn', 'setDecoderPathGLTF'];
const effects = ['setupMaterialFogEffect', 'setupVolumetricFogEffect', 'setupVolumetricCloudsEffect', 'setupSsaoEffect', 'setupPencilOutlineEffect', 'setupPencilLinesEffect'];

// Reviewed public barrels in Zen and Funtasia, not file suffixes or runtime imports.
// MarkdownEditor is additionally qualified at each occurrence as Zen-only.
const catalogue: Readonly<Record<string, readonly string[]>> = {
  [disco]: [...componentNames, ...overlayNames, ...themeNames], [`${disco}/components`]: [...componentNames, ...overlayNames], [`${disco}/theme`]: themeNames,
  [icons]: [...iconAssets, 'SvgIcon', 'Icon'], [`${icons}/assets`]: iconAssets, [`${icons}/components`]: ['SvgIcon', 'Icon'],
  [three]: [...canvas, ...scene, ...scenegraph, ...utils, ...effects, 'AssetsManager'],
  [`${three}/Canvas`]: canvas, [`${three}/scene`]: [...scene, ...scenegraph], [`${three}/scene/scenegraph`]: scenegraph,
  [`${three}/utils`]: utils, [`${three}/assets`]: ['AssetsManager'], [`${three}/effects`]: effects,
};
export function componentsApi(module: string, name: string): string | undefined {
  return Object.hasOwn(catalogue, module) && catalogue[module]!.includes(name) ? name : undefined;
}

const value: ReturnShape = Object.freeze({ kind: 'value' });
const object = (...names: string[]): ReturnShape => Object.freeze({ kind: 'object', properties: Object.freeze(Object.fromEntries(names.map((name) => [name, value]))) });
export const cameraMethods = ['setCameraFocusPoint', 'setCameraDistance', 'setCameraFocusOnObject', 'setCameraFocusTopDown', 'getCameraState', 'setCameraState', 'resetCameraState', 'getCameraOrbitAngles', 'setCameraOrbitLimits', 'addCameraControlEndListener', 'isCameraUserControlling'];
export const animationMethods = ['addAnimations', 'isPlayingAnimation', 'pose', 'playAnimation', 'stopAnimation', 'pauseAnimation', 'resumeAnimation', 'playAnimationLayered', 'poseLayered', 'stopLayer', 'setLayerWeight', 'pauseLayer', 'resumeLayer', 'fadeOutLayer', 'tweenLayerWeight', 'stopLayerTween', 'dispose'];

const shapes: readonly [readonly string[], ReturnShape][] = [
  [['useModal'], object('openModal', 'openConfirmationModal')],
  [['useToasts'], object('showToast', 'dismissToast')],
  [['showToast'], object('id')],
  [['openModal', 'openConfirmationModal', 'initToasts', 'tooltip', 'focusring', 'applyDiscoTheme', 'loaderFn', 'loadGLTF', 'loadTexture', 'loadIconDef', 'resolveIconDef'], value],
  [['setupCameraControls', 'useCameraControls'], object(...cameraMethods)],
  [['setupMaterialFogEffect', 'setupVolumetricFogEffect', 'setupVolumetricCloudsEffect'], object('dispose')],
  [['setupSsaoEffect', 'setupPencilOutlineEffect', 'setupPencilLinesEffect'], value],
  [['createSceneGraphHtmlSceneOverlayBridge'], object('registerHtmlScene', 'bindOverlayEntry', 'entries')],
  [['getIconAssetShape'], object('shape', 'assetShape', 'family', 'name', 'path')],
  [['configureIconAssetLoading', 'getIconAssetLoadingConfig'], object('baseUrl', 'resolver', 'fetch')],
  [['resolveDiscoTheme'], object('mode', 'colors')],
  [['getCameraPosFocusOnBoneWithZoom', 'getCameraPosFocusBetweenBonesWithZoom'], Object.freeze({ kind: 'tuple', items: Object.freeze([value, value]) })],
];
const assetMethods = object('loadTexture', 'loadGltf', 'loadGLTF');
const constructShapes: readonly [string, ReturnShape][] = [
  ['AssetsManager', assetMethods],
  ['SceneGraphRuntime', object('attach', 'setDocument', 'getNodeById', 'getCamera', 'setCamera', 'dispose')],
  ['Scene3d', Object.freeze({ kind: 'object', properties: Object.freeze({ add: value, remove: value, addRenderListener: value, dispose: value, assets: assetMethods }) })],
  ['SceneNode', object('dispose')],
  ['GLTFMeshNode', Object.freeze({ kind: 'object', properties: Object.freeze({ animation: object(...animationMethods), dispose: value }) })],
  ['GLTFMeshAnimation', object(...animationMethods)],
];
const origins = (name: string) => Object.freeze(Object.entries(catalogue).filter(([, exports]) => exports.includes(name)).map(([module]) => Object.freeze({ module, name })));

/** Compose before constructing the TypeScript view. Promises are opaque values,
 * not their awaited resources; callback payloads are separate from return shapes. */
export const fstComponentsReturnContracts: readonly ReturnContract[] = Object.freeze([
  ...shapes.flatMap(([names, result]) => names.map((name) => Object.freeze({ id: `fst-components.${name.toLowerCase()}`, origins: origins(name), result }))),
  ...constructShapes.map(([name, result]) => Object.freeze({ id: `fst-components.construct.${name.toLowerCase()}`, invocation: 'construct' as const, origins: origins(name), result })),
]);

export interface CallContract {
  role: 'overlay' | 'dom-effect' | 'asset-request' | 'scene' | 'registration' | 'resource' | 'runtime' | 'camera' | 'animation' | 'handle';
  result: string;
  handle?: string;
  cleanup?: string;
}
// Sources: Disco Modal/Toast/Tooltip/FocusRing/theme; Icons assets/index;
// Three utils/{gltf,texture,loader}, effects barrels and scene/{Camera,scenegraph}.
export const calls: Readonly<Record<string, CallContract>> = {
  useModal: { role: 'overlay', result: '{openModal,openConfirmationModal};captured-owner', handle: 'modal-api' },
  openModal: { role: 'overlay', result: 'ModalClose(reason?);callable', handle: 'modal-close' },
  openConfirmationModal: { role: 'overlay', result: 'Promise<void>;false-confirm-keeps-open;cancel-rejects-ModalCancelledError' },
  useToasts: { role: 'overlay', result: '{showToast,dismissToast};captured-owner', handle: 'toasts-api' },
  showToast: { role: 'overlay', result: 'ToastHandle;callable-dismiss;readonly-id', handle: 'toast-handle' },
  dismissToast: { role: 'overlay', result: 'void' }, removeToast: { role: 'overlay', result: 'void;alias-of-dismissToast' },
  initToasts: { role: 'registration', result: 'cleanup-function', handle: 'disposer', cleanup: 'explicit-call-or-conditional-owner-cleanup' },
  tooltip: { role: 'dom-effect', result: 'disposer-function', handle: 'disposer', cleanup: 'explicit-call-or-conditional-owner-cleanup' },
  focusring: { role: 'dom-effect', result: 'disposer-function', handle: 'disposer', cleanup: 'explicit-call-or-conditional-owner-cleanup' },
  applyDiscoTheme: { role: 'dom-effect', result: 'idempotent-restore-function', handle: 'disposer', cleanup: 'explicit-only;no-owner-registration' },
  resolveDiscoTheme: { role: 'dom-effect', result: '{mode,colors}' },
  loadIconDef: { role: 'asset-request', result: 'Promise<IconDef|null>' }, resolveIconDef: { role: 'asset-request', result: 'Promise<IconDef|null>' },
  configureIconAssetLoading: { role: 'asset-request', result: 'IconAssetLoadingConfig-copy' }, getIconAssetLoadingConfig: { role: 'asset-request', result: 'IconAssetLoadingConfig-copy' },
  resolveIconAssetUrl: { role: 'asset-request', result: 'string;resolver-or-configured-url' }, getIconAssetShape: { role: 'asset-request', result: '{shape,assetShape,family,name,path}' },
  clearIconAssetCache: { role: 'asset-request', result: 'void;not-cancellation' }, getIconAssetCacheSnapshot: { role: 'asset-request', result: 'IconAssetCacheSnapshotEntry[];not-live-state' },
  loadGLTF: { role: 'asset-request', result: 'Promise<GLTFData|GLTFData[]>;input-shape-dependent' }, loadTexture: { role: 'asset-request', result: 'Promise<Texture>;raw-resource' },
  loaderFn: { role: 'asset-request', result: '(LoaderCtor,...urls)=>Promise<results[]>', handle: 'loader' }, setDecoderPathGLTF: { role: 'asset-request', result: 'void;decoder-path-configuration' },
  setupMaterialFogEffect: { role: 'resource', result: 'MaterialFogEffect', handle: 'effect', cleanup: 'explicit-dispose-request;listener-and-material-restoration' },
  setupVolumetricFogEffect: { role: 'resource', result: 'VolumetricFogEffectPass', handle: 'effect', cleanup: 'explicit-dispose-request;not-composer-removal' },
  setupVolumetricCloudsEffect: { role: 'resource', result: 'VolumetricCloudsEffectPass', handle: 'effect', cleanup: 'explicit-dispose-request;not-composer-removal' },
  setupSsaoEffect: { role: 'resource', result: 'Promise<void>;pipeline-replacement' }, setupPencilOutlineEffect: { role: 'resource', result: 'Promise<void>;pipeline-replacement' }, setupPencilLinesEffect: { role: 'resource', result: 'Promise<void>;pipeline-replacement' },
  createSceneGraphRuntimeData: { role: 'runtime', result: 'SceneGraphRuntimeData;not-live-scene', handle: 'runtime-data' },
  createSceneGraphHtmlSceneOverlayBridge: { role: 'registration', result: 'SceneGraphHtmlSceneOverlayBridgeImpl', handle: 'bridge' },
  setupCameraControls: { role: 'camera', result: 'camera-controller;registered-scene-node', handle: 'camera' }, useCameraControls: { role: 'camera', result: 'camera-controller-or-null;named-node-lookup;not-Solid-context', handle: 'camera' },
  getCameraPosFocusOnBoneWithZoom: { role: 'camera', result: '[Vector3-position,Vector3-target];shape-only' }, getCameraPosFocusBetweenBonesWithZoom: { role: 'camera', result: '[Vector3-position,Vector3-target];shape-only' },
};

export const constructors: Readonly<Record<string, CallContract>> = {
  Scene3d: { role: 'scene', result: 'Scene3d', handle: 'scene', cleanup: 'dispose-method-empty;no-GPU-cleanup-guarantee' },
  SceneNode: { role: 'scene', result: 'SceneNode', handle: 'scene-node' },
  AssetsManager: { role: 'asset-request', result: 'AssetsManager;no-dispose-API', handle: 'assets-manager' },
  SceneGraphRuntime: { role: 'runtime', result: 'SceneGraphRuntime', handle: 'runtime' },
  GLTFMeshNode: { role: 'animation', result: 'GLTFMeshNode', handle: 'mesh' },
  GLTFMeshAnimation: { role: 'animation', result: 'GLTFMeshAnimation', handle: 'animation', cleanup: 'dispose-does-not-cancel-layer-tweens' },
};

export function memberContract(kind: string, name: string): CallContract | undefined {
  if (kind === 'modal-api' && ['openModal', 'openConfirmationModal'].includes(name)) return calls[name];
  if (kind === 'toasts-api' && ['showToast', 'dismissToast'].includes(name)) return calls[name];
  if (kind === 'scene' && name === 'add') return { role: 'scene', result: 'same-node-argument' };
  if (kind === 'scene' && name === 'addRenderListener') return { role: 'registration', result: '{priority,dispose}', handle: 'render-listener', cleanup: 'explicit-listener-dispose' };
  if (kind === 'scene' && ['remove', 'dispose'].includes(name)) return { role: 'scene', result: name === 'dispose' ? 'void;empty-implementation;no-GPU-cleanup-guarantee' : 'void' };
  if (kind === 'assets-manager' && ['loadGltf', 'loadGLTF', 'loadTexture'].includes(name)) return { role: 'asset-request', result: name === 'loadTexture' ? 'Promise<TextureAssetEntry>;texture-optional;failure-swallowed' : 'Promise<GltfAssetEntry>;failure-evicts-and-rethrows' };
  if (kind === 'bridge' && name === 'registerHtmlScene') return { role: 'registration', result: '{updateConfig,updateProjection,requestCapture,dispose}', handle: 'html-registration' };
  if (kind === 'bridge' && name === 'bindOverlayEntry') return { role: 'registration', result: 'unbind-function', handle: 'disposer' };
  if (kind === 'html-registration' && ['updateConfig', 'updateProjection', 'requestCapture', 'dispose'].includes(name)) return { role: 'registration', result: 'void' };
  if (kind === 'runtime' && ['attach', 'setDocument', 'getNodeById', 'getCamera', 'setCamera', 'dispose'].includes(name)) return { role: 'runtime', result: name === 'getNodeById' ? 'SceneGraphRuntimeNodeHandle|null;transient' : name === 'getCamera' ? 'SceneGraphCameraJson' : 'void', ...(name === 'getNodeById' ? { handle: 'runtime-node' } : {}) };
  if (kind === 'runtime-node' && name === 'captureSnapshot') return { role: 'resource', result: '{texture,width,height,dispose}|null', handle: 'snapshot' };
  if (kind === 'camera' && cameraMethods.includes(name)) return { role: 'camera', result: name === 'addCameraControlEndListener' ? '{dispose};pending-registration-not-guaranteed-removed' : name === 'getCameraState' ? '{position,target}|null' : name === 'getCameraOrbitAngles' ? '{azimuthAngle,polarAngle}|null' : name === 'isCameraUserControlling' ? 'boolean' : 'same-controller', ...(name === 'addCameraControlEndListener' ? { handle: 'camera-listener' } : name.startsWith('set') || name === 'resetCameraState' ? { handle: 'camera' } : {}) };
  if (kind === 'animation' && animationMethods.includes(name)) return { role: 'animation', result: ['playAnimationLayered', 'poseLayered'].includes(name) ? 'AnimationAction|null' : name === 'addAnimations' ? 'number' : name === 'isPlayingAnimation' ? 'boolean' : 'void', ...(name === 'dispose' ? { cleanup: 'does-not-cancel-layer-tweens;stopLayerTween-is-explicit' } : {}) };
  if (['effect', 'render-listener', 'camera-listener', 'snapshot', 'scene-node', 'mesh'].includes(kind) && name === 'dispose') return { role: 'handle', result: 'void;explicit-disposal-request-only' };
  return undefined;
}
