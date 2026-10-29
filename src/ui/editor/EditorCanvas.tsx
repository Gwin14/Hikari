import { AlphaType, Canvas, ColorType, Path, Picture, Skia, type SkPath } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { isAiMask } from '@/core/pipeline/masks';
import { drawRecipe } from '@/core/pipeline/render';
import type { BrushStroke, Mask } from '@/core/recipe/schema';
import { liveInputs, liveRecipe, useEditor } from '@/state/editor';
import { colors } from '../theme';
import { CropOverlay } from './CropOverlay';
import { MaskHandles } from './MaskHandles';
import { makeView, outToScreen, screenLongEdge, screenToImage, viewGeometry, type ViewTransform } from './viewMath';

export interface BrushSettings {
  size: number;
  hardness: number;
  flow: number;
  erase: boolean;
}

/**
 * GPU canvas. The picture is recorded on the UI thread from the live recipe, so slider
 * drags re-render without touching the JS thread.
 */
export function EditorCanvas({ brush }: { brush: SharedValue<BrushSettings> }) {
  const tool = useEditor((s) => s.tool);
  const compare = useEditor((s) => s.compare);
  const showClipping = useEditor((s) => s.showClipping);
  const activeMaskId = useEditor((s) => s.activeMaskId);
  const maskOverlay = useEditor((s) => s.maskOverlay);
  const recipe = useEditor((s) => s.recipe);
  const maskBrushing = useEditor((s) => s.maskBrushing);
  const activeMask = recipe?.masks.find((m) => m.id === activeMaskId) ?? null;

  const vw = useSharedValue(0);
  const vh = useSharedValue(0);
  const zoom = useSharedValue(1);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const startZoom = useSharedValue(1);
  const startPan = useSharedValue({ x: 0, y: 0 });
  const holdOriginal = useSharedValue(0);
  const splitX = useSharedValue(0.5);
  const compareMode = useSharedValue(0);
  const clip = useSharedValue(0);
  const overlayId = useSharedValue<string | null>(null);
  const cropMode = useSharedValue(false);
  const strokePts = useSharedValue<number[]>([]);

  const isCrop = tool === 'geometry';
  const removing = tool === 'retouch';
  const painting =
    removing ||
    (tool === 'masks' &&
      !!activeMask &&
      (activeMask.type === 'brush' || activeMask.type === 'object' || (isAiMask(activeMask) && maskBrushing)));
  const picking = tool === 'masks' && activeMask?.type === 'color';

  useEffect(() => {
    compareMode.set(compare === 'split' ? 2 : 0);
    clip.set(showClipping ? 1 : 0);
    overlayId.set(tool === 'masks' && maskOverlay ? activeMaskId : null);
    cropMode.set(isCrop);
    if (isCrop) {
      zoom.set(withTiming(1));
      panX.set(withTiming(0));
      panY.set(withTiming(0));
    }
  }, [compare, showClipping, activeMaskId, maskOverlay, tool, isCrop, compareMode, clip, overlayId, cropMode, zoom, panX, panY]);

  const view = useDerivedValue<ViewTransform>(() =>
    makeView(liveRecipe.value, liveInputs.value, vw.value, vh.value, zoom.value, panX.value, panY.value, cropMode.value),
  );

  const picture = useDerivedValue(() => {
    const rec = Skia.PictureRecorder();
    const c = rec.beginRecording(Skia.XYWHRect(0, 0, Math.max(1, vw.value), Math.max(1, vh.value)));
    const r = liveRecipe.value;
    const inp = liveInputs.value;
    const v = view.value;
    if (r && inp && v.ok) {
      const shown = cropMode.value ? { ...r, geometry: viewGeometry(r, true) } : r;
      c.save();
      c.translate(v.vw / 2 + v.panX, v.vh / 2 + v.panY);
      c.scale(v.zoom, v.zoom);
      c.translate(-v.vw / 2, -v.vh / 2);
      c.translate(v.x, v.y);
      c.scale(v.s, v.s);
      if (holdOriginal.value) {
        drawRecipe(c, inp, shown, { original: true });
      } else {
        drawRecipe(c, inp, shown, { clip: clip.value === 1, overlayMask: overlayId.value });
        if (compareMode.value === 2) {
          // split view: original on the left of the divider
          const sx = (splitX.value * v.vw - v.panX - v.vw / 2) / v.zoom + v.vw / 2;
          const ox = (sx - v.x) / v.s;
          c.save();
          c.clipRect(Skia.XYWHRect(0, 0, Math.max(0, ox), v.outH), 1, true);
          drawRecipe(c, inp, shown, { original: true });
          c.restore();
        }
      }
      c.restore();
    }
    return rec.finishRecordingAsPicture();
  });

  // live brush stroke preview
  const strokePath = useDerivedValue<SkPath>(() => {
    const pb = Skia.PathBuilder.Make();
    const p = strokePts.value;
    if (p.length >= 2) {
      pb.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) pb.lineTo(p[i], p[i + 1]);
    }
    return pb.build();
  });
  const strokeWidth = useDerivedValue(() => Math.max(2, brush.value.size * screenLongEdge(view.value)));
  const removeMode = useSharedValue(false);
  useEffect(() => {
    removeMode.set(removing);
  }, [removing, removeMode]);
  const strokeColor = useDerivedValue(() =>
    removeMode.value ? 'rgba(255,255,255,0.55)' : brush.value.erase ? 'rgba(80,160,255,0.45)' : 'rgba(255,70,90,0.45)',
  );

  const onLayout = (e: LayoutChangeEvent) => {
    vw.set(e.nativeEvent.layout.width);
    vh.set(e.nativeEvent.layout.height);
  };

  // ---------------------------------------------------------------- gestures
  const clampPan = () => {
    'worklet';
    const v = view.value;
    const maxX = Math.max(0, (v.outW * v.s * zoom.value - v.vw) / 2 + 40);
    const maxY = Math.max(0, (v.outH * v.s * zoom.value - v.vh) / 2 + 40);
    panX.set(Math.max(-maxX, Math.min(maxX, panX.value)));
    panY.set(Math.max(-maxY, Math.min(maxY, panY.value)));
  };

  const pinch = Gesture.Pinch()
    .enabled(!isCrop)
    .onBegin(() => {
      startZoom.set(zoom.value);
    })
    .onUpdate((e) => {
      zoom.set(Math.max(1, Math.min(12, startZoom.value * e.scale)));
      clampPan();
    })
    .onEnd(() => {
      if (zoom.value < 1.05) {
        zoom.set(withTiming(1));
        panX.set(withTiming(0));
        panY.set(withTiming(0));
      }
    });

  const pan = Gesture.Pan()
    .enabled(!isCrop)
    .minPointers(painting ? 2 : 1)
    .onBegin(() => {
      startPan.set({ x: panX.value, y: panY.value });
    })
    .onUpdate((e) => {
      if (zoom.value <= 1.01 && compareMode.value !== 2) return;
      if (compareMode.value === 2 && zoom.value <= 1.01) {
        splitX.set(Math.max(0, Math.min(1, e.absoluteX / Math.max(1, vw.value))));
        return;
      }
      panX.set(startPan.value.x + e.translationX);
      panY.set(startPan.value.y + e.translationY);
      clampPan();
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .enabled(!isCrop && !painting)
    .onEnd((e) => {
      if (zoom.value > 1.05) {
        zoom.set(withTiming(1));
        panX.set(withTiming(0));
        panY.set(withTiming(0));
      } else {
        // zoom to ~1:1 of the preview around the tapped point
        const v = view.value;
        const target = Math.min(12, Math.max(2.5, 1 / v.s));
        zoom.set(withTiming(target));
        panX.set(withTiming((v.vw / 2 - e.x) * (target - 1)));
        panY.set(withTiming((v.vh / 2 - e.y) * (target - 1)));
      }
    });

  const hold = Gesture.LongPress()
    .enabled(!isCrop && !painting)
    .minDuration(220)
    .maxDistance(30)
    .onStart(() => {
      holdOriginal.set(1);
    })
    .onFinalize(() => {
      holdOriginal.set(0);
    });

  const addStroke = (pts: number[], b: BrushSettings) => {
    if (pts.length < 2) return;
    if (removing) {
      useEditor.getState().addRetouch({ points: pts, size: b.size, hardness: 1, flow: 1, erase: false });
      return;
    }
    if (!activeMaskId) return;
    const stroke: BrushStroke = { points: pts, size: b.size, hardness: b.hardness, flow: b.flow, erase: b.erase };
    useEditor.getState().updateMask(activeMaskId, (m: Mask) => ({ ...m, strokes: [...m.strokes, stroke] }));
  };

  const paint = Gesture.Pan()
    .enabled(painting)
    .maxPointers(1)
    .minDistance(0)
    .onBegin((e) => {
      strokePts.set([e.x, e.y]);
    })
    .onUpdate((e) => {
      const p = strokePts.value;
      const lx = p[p.length - 2];
      const ly = p[p.length - 1];
      if ((e.x - lx) ** 2 + (e.y - ly) ** 2 > 9) strokePts.set([...p, e.x, e.y]);
    })
    .onEnd(() => {
      const v = view.value;
      const p = strokePts.value;
      const norm: number[] = [];
      for (let i = 0; i < p.length; i += 2) {
        const [nx, ny] = screenToImage(v, p[i], p[i + 1]);
        norm.push(nx, ny);
      }
      scheduleOnRN(addStroke, norm, brush.value);
    })
    .onFinalize(() => {
      strokePts.set([]);
    });

  const pickColor = (nx: number, ny: number) => {
    const { inputs, activeMaskId: id } = useEditor.getState();
    if (!inputs || !id) return;
    const x = Math.round(Math.max(0, Math.min(1, nx)) * (inputs.source.width() - 1));
    const y = Math.round(Math.max(0, Math.min(1, ny)) * (inputs.source.height() - 1));
    const px = inputs.source.readPixels(x, y, { width: 1, height: 1, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
    if (!px) return;
    const isFloat = px instanceof Float32Array;
    const [r, g, b] = isFloat ? [px[0], px[1], px[2]] : [px[0] / 255, px[1] / 255, px[2] / 255];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d > 1e-4) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    const hue = ((h * 60) + 360) % 360;
    useEditor.getState().updateMask(id, (m) => ({ ...m, range: { ...m.range, enabled: true, hue, sat: mx > 0 ? d / mx : 0 } }));
  };

  const pickTap = Gesture.Tap()
    .enabled(picking)
    .onEnd((e) => {
      const [nx, ny] = screenToImage(view.value, e.x, e.y);
      scheduleOnRN(pickColor, nx, ny);
    });

  const gestures = Gesture.Race(paint, Gesture.Simultaneous(pinch, pan), Gesture.Exclusive(doubleTap, pickTap, hold));

  const dividerStyle = useAnimatedStyle(() => ({
    opacity: compareMode.value === 2 ? 1 : 0,
    transform: [{ translateX: splitX.value * vw.value - 1 }],
  }));

  const imageFrame = useAnimatedStyle(() => {
    const v = view.value;
    const [x0, y0] = outToScreen(v, 0, 0);
    const [x1, y1] = outToScreen(v, v.outW, v.outH);
    return { left: x0, top: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  });

  return (
    <View style={styles.root} onLayout={onLayout}>
      <GestureDetector gesture={gestures}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <Canvas style={StyleSheet.absoluteFill}>
            <Picture picture={picture} />
            {painting && <Path path={strokePath} style="stroke" strokeWidth={strokeWidth} strokeCap="round" strokeJoin="round" color={strokeColor} />}
          </Canvas>
          <Animated.View pointerEvents="none" style={[styles.frame, imageFrame]} />
        </View>
      </GestureDetector>
      <Animated.View pointerEvents="none" style={[styles.divider, dividerStyle]} />
      {isCrop && <CropOverlay view={view} />}
      {tool === 'masks' && activeMask && (activeMask.type === 'linear' || activeMask.type === 'radial') && (
        <MaskHandles view={view} mask={activeMask} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, overflow: 'hidden' },
  frame: { position: 'absolute' },
  divider: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.text },
});
