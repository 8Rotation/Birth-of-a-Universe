import * as THREE from "three";

interface AttributeResource {
  buffer?: GPUBuffer;
}

export interface ThreeWebGPUBackend {
  device?: GPUDevice;
  get?: (resource: unknown) => AttributeResource | undefined;
  utils?: {
    getPreferredCanvasFormat?: () => GPUTextureFormat;
  };
  _configureContext?: () => void;
  context?: {
    configure: (configuration: GPUCanvasConfiguration) => void;
  };
}

function backendFromRenderer(renderer: unknown): ThreeWebGPUBackend | undefined {
  return (renderer as { backend?: ThreeWebGPUBackend } | null | undefined)?.backend;
}

function backendFromRendererOrBackend(rendererOrBackend: unknown): ThreeWebGPUBackend | undefined {
  return backendFromRenderer(rendererOrBackend)
    ?? (rendererOrBackend as ThreeWebGPUBackend | null | undefined)
    ?? undefined;
}

function backendError(missing: string[]): Error {
  return new Error(
    `Three.js WebGPU backend private API is incompatible with this build ` +
    `(Three r${THREE.REVISION}). Missing: ${missing.join(", ")}`,
  );
}

export function probeThreeBackend(renderer: unknown): { compatible: boolean; version: string; missing: string[] } {
  const backend = backendFromRenderer(renderer);
  const missing: string[] = [];
  if (!backend) missing.push("renderer.backend");
  if (!backend?.device) missing.push("renderer.backend.device");
  if (typeof backend?.get !== "function") missing.push("renderer.backend.get(attribute)");
  return { compatible: missing.length === 0, version: THREE.REVISION, missing };
}

export function getThreeBackend(renderer: unknown): ThreeWebGPUBackend {
  const probe = probeThreeBackend(renderer);
  if (!probe.compatible) throw backendError(probe.missing);
  return backendFromRenderer(renderer)!;
}

export function getWebGPUDevice(renderer: unknown): GPUDevice {
  const backend = getThreeBackend(renderer);
  if (!backend.device) throw backendError(["renderer.backend.device"]);
  return backend.device;
}

export function getAttributeBuffer(rendererOrBackend: unknown, attr: unknown): GPUBuffer | undefined {
  return backendFromRendererOrBackend(rendererOrBackend)?.get?.(attr)?.buffer;
}
