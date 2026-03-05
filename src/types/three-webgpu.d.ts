/**
 * Type declarations for three/webgpu and three/tsl subpath exports.
 * Three.js r183 exports these but @types/three doesn't include types.
 */

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

  export class QuadMesh {
    constructor(material?: any);
    render(renderer: WebGPURenderer): void;
  }
}

declare module "three/tsl" {
  export function pass(scene: any, camera: any, options?: any): any;
  export function float(v: number): any;
  export function vec2(x: any, y?: any): any;
  export function vec3(x: any, y?: any, z?: any): any;
  export function vec4(x: any, y?: any, z?: any, w?: any): any;
  export function color(r: any, g?: any, b?: any): any;
  export function uniform(value: any): any;
  export function attribute(name: string, type?: string): any;
  export function texture(map: any, uv?: any): any;
  export function uv(): any;
  export function add(...args: any[]): any;
  export function mul(...args: any[]): any;
  export function mix(a: any, b: any, t: any): any;
  export function clamp(v: any, min: any, max: any): any;
  export function smoothstep(edge0: any, edge1: any, x: any): any;
  export function max(a: any, b: any): any;
  export function min(a: any, b: any): any;
  export function pow(base: any, exp: any): any;
  export function sqrt(v: any): any;
  export function abs(v: any): any;
  export function log(v: any): any;
  export function exp(v: any): any;
  export function sin(v: any): any;
  export function cos(v: any): any;
  export function normalize(v: any): any;
  export function length(v: any): any;
  export function dot(a: any, b: any): any;
  export function cross(a: any, b: any): any;
  export function select(condition: any, a: any, b: any): any;
  export function instancedBufferAttribute(attr: any, type?: string, stride?: number, offset?: number): any;
  export function instancedDynamicBufferAttribute(attr: any, type?: string, stride?: number, offset?: number): any;
  export function Discard(conditional?: any): any;
  export const time: any;
  export const deltaTime: any;
  export const positionLocal: any;
  export const positionWorld: any;
  export const cameraPosition: any;
  export function luminance(color: any): any;
  export const output: any;
  export const emissive: any;
  export function mrt(config: any): any;
  export function renderOutput(color: any, ...args: any[]): any;
  export function passTexture(pass: any, texture: any): any;
  export function Fn(fn: (...args: any[]) => any): any;
}

declare module "three/addons/tsl/display/BloomNode.js" {
  export function bloom(inputNode: any, strength?: number, radius?: number, threshold?: number): any;
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

declare module "*.wgsl?raw" {
  const content: string;
  export default content;
}
