/**
 * Type declarations for three/webgpu and three/tsl subpath exports.
 * Three.js r183 exports these but @types/three doesn't include types.
 *
 * TSL (Three Shading Language) functions return opaque ShaderNode objects
 * that compose via method chaining / nesting. We use a nominal type alias
 * rather than `any` so call sites are at least self-documenting.
 */

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface ShaderNodeObject {
  /** Brand — prevents accidental assignment from unrelated values. */
  readonly __brand?: "ShaderNodeObject";
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
  export function vec2(x: N | number, y?: N | number): N;
  export function vec3(x: N | number, y?: N | number, z?: N | number): N;
  export function vec4(x: N | number, y?: N | number, z?: N | number, w?: N | number): N;
  export function color(r: N | number | string, g?: N | number, b?: N | number): N;
  export function uniform(value: any): N;
  export function attribute(name: string, type?: string): N;
  export function texture(map: any, uv?: N): N;
  export function uv(): N;
  export function add(...args: (N | number)[]): N;
  export function mul(...args: (N | number)[]): N;
  export function mix(a: N | number, b: N | number, t: N | number): N;
  export function clamp(v: N | number, min: N | number, max: N | number): N;
  export function smoothstep(edge0: N | number, edge1: N | number, x: N | number): N;
  export function max(a: N | number, b: N | number): N;
  export function min(a: N | number, b: N | number): N;
  export function pow(base: N | number, exp: N | number): N;
  export function sqrt(v: N | number): N;
  export function abs(v: N | number): N;
  export function log(v: N | number): N;
  export function exp(v: N | number): N;
  export function sin(v: N | number): N;
  export function cos(v: N | number): N;
  export function normalize(v: N): N;
  export function length(v: N): N;
  export function dot(a: N, b: N): N;
  export function cross(a: N, b: N): N;
  export function select(condition: N, a: N | number, b: N | number): N;
  export function step(edge: N | number, x: N | number): N;
  export function mod(x: N | number, y: N | number): N;
  export function instancedBufferAttribute(attr: any, type?: string, stride?: number, offset?: number): N;
  export function instancedDynamicBufferAttribute(attr: any, type?: string, stride?: number, offset?: number): N;
  export function Discard(conditional?: N): N;
  export const time: N;
  export const deltaTime: N;
  export const positionLocal: N;
  export const positionWorld: N;
  export const cameraPosition: N;
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


