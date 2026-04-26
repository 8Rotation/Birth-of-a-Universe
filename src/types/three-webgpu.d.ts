/**
 * Type declarations for three/webgpu and three/tsl subpath exports.
 * Three.js r183 exports these but @types/three doesn't include types.
 *
 * TSL (Three Shading Language) functions return opaque ShaderNode objects
 * that compose via method chaining / nesting. We use a nominal type alias
 * rather than `any` so call sites are at least self-documenting.
 */

type ShaderNodeInput = ShaderNodeObject | number | string | boolean;

interface ShaderNodeObject {
  /** Brand — prevents accidental assignment from unrelated values. */
  readonly __brand?: "ShaderNodeObject";
  readonly x: ShaderNodeObject;
  readonly y: ShaderNodeObject;
  readonly z: ShaderNodeObject;
  readonly w: ShaderNodeObject;
  readonly r: ShaderNodeObject;
  readonly g: ShaderNodeObject;
  readonly b: ShaderNodeObject;
  readonly a: ShaderNodeObject;
  readonly xy: ShaderNodeObject;
  readonly xyz: ShaderNodeObject;
  readonly rgb: ShaderNodeObject;
  value: any;
  add(...args: ShaderNodeInput[]): ShaderNodeObject;
  sub(...args: ShaderNodeInput[]): ShaderNodeObject;
  mul(...args: ShaderNodeInput[]): ShaderNodeObject;
  div(...args: ShaderNodeInput[]): ShaderNodeObject;
  oneMinus(): ShaderNodeObject;
  negate(): ShaderNodeObject;
  toFloat(): ShaderNodeObject;
  getTextureNode(name: string): ShaderNodeObject;
  setSize(width: number, height: number): void;
  dispose(): void;
  /** Three's TSL node surface is runtime-composed; keep an escape hatch for upstream gaps. */
  [key: string]: any;
}

declare module "three/webgpu" {
  export * from "three";

  import type {
    Scene,
    Camera,
    WebGLRendererParameters,
    ColorSpace,
    ToneMapping,
  } from "three";

  export class WebGPURenderer {
    constructor(parameters?: WebGLRendererParameters & { forceWebGL?: boolean });
    init(): Promise<void>;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(ratio: number): void;
    setAnimationLoop(callback: ((time: number) => void) | null): void;
    render(scene: Scene, camera: Camera): void;
    dispose(): void;
    readonly domElement: HTMLCanvasElement;
    toneMapping: ToneMapping;
    toneMappingExposure: number;
    outputColorSpace: ColorSpace;
    setClearColor(color: number | string, alpha?: number): void;
    autoClear: boolean;
    info: { render: { calls: number; triangles: number }; memory: { geometries: number } };
    getSize(target: { width: number; height: number }): { width: number; height: number };
  }

  export class RenderPipeline {
    constructor(renderer: WebGPURenderer);
    outputNode: any;
    render(): void;
    renderAsync(): Promise<void>;
    setSize(width: number, height: number): void;
  }

  /** @deprecated Use RenderPipeline instead */
  export class PostProcessing extends RenderPipeline {
    constructor(renderer: WebGPURenderer, outputNode?: any);
  }

  export class StorageBufferAttribute {
    constructor(array: Float32Array, itemSize: number);
  }

  export class StorageInstancedBufferAttribute extends StorageBufferAttribute {
    constructor(array: Float32Array, itemSize: number);
  }

  export class NodeMaterial {
    constructor(params?: any);
    positionNode: any;
    colorNode: any;
    opacityNode: any;
    fragmentNode: any;
    transparent: boolean;
    blending: any;
    depthWrite: boolean;
    side: any;
    alphaTest: number;
    needsUpdate: boolean;
  }

  export class PointsNodeMaterial {
    constructor(params?: any);
    size: number;
    sizeAttenuation: boolean;
    transparent: boolean;
    blending: any;
    depthWrite: boolean;
    colorNode: any;
    sizeNode: any;
    positionNode: any;
    fragmentNode: any;
    vertexColorNode: any;
    opacityNode: any;
    needsUpdate: boolean;
  }

  export class SpriteNodeMaterial {
    constructor(params?: any);
    colorNode: any;
    opacityNode: any;
    sizeNode: any;
    transparent: boolean;
    blending: any;
    depthWrite: boolean;
  }

  export class MeshBasicNodeMaterial {
    constructor(params?: any);
    colorNode: any;
    opacityNode: any;
    transparent: boolean;
    blending: any;
    depthWrite: boolean;
    side: any;
    color: any;
    needsUpdate: boolean;
  }

  export class QuadMesh {
    constructor(material?: any);
    render(renderer: WebGPURenderer): void;
  }
}

declare module "three/tsl" {
  type N = ShaderNodeObject;
  export function pass(scene: any, camera: any, options?: any): N;
  export function float(v: number): N;
  export function vec2(x: ShaderNodeInput, y?: ShaderNodeInput): N;
  export function vec3(x: ShaderNodeInput, y?: ShaderNodeInput, z?: ShaderNodeInput): N;
  export function vec4(x: ShaderNodeInput, y?: ShaderNodeInput, z?: ShaderNodeInput, w?: ShaderNodeInput): N;
  export function color(r: ShaderNodeInput, g?: ShaderNodeInput, b?: ShaderNodeInput): N;
  export function uniform(value: any): N;
  export function attribute(name: string, type?: string): N;
  export function texture(map: any, uv?: N): N;
  export function uv(): N;
  export function add(...args: ShaderNodeInput[]): N;
  export function mul(...args: ShaderNodeInput[]): N;
  export function mix(a: ShaderNodeInput, b: ShaderNodeInput, t: ShaderNodeInput): N;
  export function clamp(v: ShaderNodeInput, min: ShaderNodeInput, max: ShaderNodeInput): N;
  export function smoothstep(edge0: ShaderNodeInput, edge1: ShaderNodeInput, x: ShaderNodeInput): N;
  export function max(a: ShaderNodeInput, b: ShaderNodeInput): N;
  export function min(a: ShaderNodeInput, b: ShaderNodeInput): N;
  export function pow(base: ShaderNodeInput, exp: ShaderNodeInput): N;
  export function sqrt(v: ShaderNodeInput): N;
  export function abs(v: ShaderNodeInput): N;
  export function log(v: ShaderNodeInput): N;
  export function exp(v: ShaderNodeInput): N;
  export function sin(v: ShaderNodeInput): N;
  export function cos(v: ShaderNodeInput): N;
  export function normalize(v: N): N;
  export function length(v: N): N;
  export function dot(a: N, b: N): N;
  export function cross(a: N, b: N): N;
  export function select(condition: N, a: ShaderNodeInput, b: ShaderNodeInput): N;
  export function step(edge: ShaderNodeInput, x: ShaderNodeInput): N;
  export function mod(x: ShaderNodeInput, y: ShaderNodeInput): N;
  export function instancedBufferAttribute(attr: any, type?: string, stride?: number, offset?: number): N;
  export function instancedDynamicBufferAttribute(attr: any, type?: string, stride?: number, offset?: number): N;
  export function Discard(conditional?: N): N;
  export const time: N;
  export const deltaTime: N;
  export const positionLocal: N;
  export const positionWorld: N;
  export const cameraPosition: N;
  export const instanceIndex: N;
  export function luminance(color: N): N;
  export const output: N;
  export const emissive: N;
  export function mrt(config: any): N;
  export function renderOutput(color: N, ...args: any[]): N;
  export function passTexture(pass: N, texture: N): N;
  export function Fn(fn: (...args: any[]) => any): (...args: any[]) => N;
  export const screenUV: N;
}

declare module "three/addons/tsl/display/BloomNode.js" {
  export function bloom(inputNode: ShaderNodeObject, strength?: number, radius?: number, threshold?: number): ShaderNodeObject;
  export default any;
}

declare module "three/addons/controls/OrbitControls.js" {
  import type { Camera } from "three";
  export class OrbitControls {
    constructor(camera: Camera, domElement?: HTMLElement);
    enabled: boolean;
    enableDamping: boolean;
    dampingFactor: number;
    enableZoom: boolean;
    enablePan: boolean;
    enableRotate: boolean;
    minDistance: number;
    maxDistance: number;
    target: import("three").Vector3;
    update(): void;
    dispose(): void;
  }
}


