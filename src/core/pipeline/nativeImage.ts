import { ColorType, ImageFormat, type ImageInfo, type SkImage } from '@shopify/react-native-skia';
import { installOnUIRuntime } from 'expo';
import { createEditorSurface, hasNativeRenderer, type EditorSurfaceObject, type RenderImageObject, type RenderInputsRecord } from 'hikari-native';
import { getUIRuntimeHolder } from 'react-native-worklets';

import type { RenderInputs } from './render';
import type { NativeFrameInputs } from './nativeFrame';

/**
 * Where the native renderer exists, images are GPU textures it owns. NativeImage gives them the
 * small part of SkImage the app uses, so code above the render layer needs no platform branches.
 * It is only ever handled by that code or by the native branches in pipeline/.
 */
class NativeImage {
  constructor(readonly native: RenderImageObject) {}

  width = () => this.native.width;
  height = () => this.native.height;

  getImageInfo() {
    return { colorType: this.native.isFloat ? ColorType.RGBA_F16 : ColorType.RGBA_8888 } as ImageInfo;
  }

  readPixels(x: number, y: number, info: ImageInfo): Uint8Array | Float32Array {
    if (info.colorType === ColorType.RGBA_F32) {
      const bytes = this.native.readFloats(x, y, info.width, info.height);
      const out = new Float32Array(bytes.byteLength / 4);
      new Uint8Array(out.buffer).set(bytes);
      return out;
    }
    return this.native.readRgba8(x, y, info.width, info.height);
  }

  encodeToBytes(format: ImageFormat = ImageFormat.PNG, quality = 100): Uint8Array {
    return this.native.encode(format === ImageFormat.JPEG ? 'jpeg' : 'png', quality);
  }
}

export const toImage = (native: RenderImageObject) => new NativeImage(native) as unknown as SkImage;
export const nativeOf = (image: SkImage) => (image as unknown as NativeImage).native;

/** Texture slots a fragment shader has for masks (see FrameLayout.maskSlots). */
const MASK_SLOTS = 24;

/** The native inputs of a render, and the plain data frame packing needs. */
export function describeInputs(inp: RenderInputs): { record: RenderInputsRecord; frame: NativeFrameInputs } {
  const maskSlots: Record<string, number> = {};
  const masks: number[] = [];
  for (const [id, image] of Object.entries(inp.maskTextures).slice(0, MASK_SLOTS)) {
    maskSlots[id] = masks.length;
    masks.push(nativeOf(image).id);
  }
  return {
    record: {
      source: nativeOf(inp.source).id,
      cleaned: nativeOf(inp.cleaned ?? inp.source).id,
      blurN: nativeOf(inp.blurN).id,
      blurS: nativeOf(inp.blurS).id,
      blurM: nativeOf(inp.blurM).id,
      blurL: nativeOf(inp.blurL).id,
      curve: inp.curve ? nativeOf(inp.curve).id : null,
      lut: inp.lut ? nativeOf(inp.lut.image).id : null,
      masks,
    },
    frame: { frame: inp.frame, maskSlots, lutSize: inp.lut ? inp.lut.size : 0 },
  };
}

let surface: EditorSurfaceObject | null = null;

/** The object the editor's native view draws, also reachable from the UI runtime. */
export function editorSurface(): EditorSurfaceObject {
  if (!surface) {
    // makes Expo's native objects callable from worklets
    installOnUIRuntime(getUIRuntimeHolder());
    surface = createEditorSurface();
  }
  return surface;
}

export const editorSurfaceId = () =>
  hasNativeRenderer ? (editorSurface() as unknown as { __expo_shared_object_id__: number }).__expo_shared_object_id__ : 0;

/**
 * Hands a frame to the editor surface, synchronously on the UI thread. Expo offers no public way
 * to reach a SharedObject from a worklet yet, so this resolves it through the hook its worklet
 * support installs on the UI runtime.
 */
export function pushEditorFrame(surfaceId: number, frame: number[]) {
  'worklet';
  const g = globalThis as unknown as {
    expo: { SharedObject: { __resolveInWorklet(id: number): EditorSurfaceObject } };
    __hikariSurface?: { id: number; object: EditorSurfaceObject };
  };
  if (g.__hikariSurface?.id !== surfaceId) g.__hikariSurface = { id: surfaceId, object: g.expo.SharedObject.__resolveInWorklet(surfaceId) };
  g.__hikariSurface.object.setFrame(frame);
}
