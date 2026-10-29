import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { rotatedSize } from '@/core/pipeline/geometry';
import type { Geometry } from '@/core/recipe/schema';
import { liveInputs, liveRecipe, useEditor } from '@/state/editor';
import { colors } from '../theme';
import { outToScreen, type ViewTransform } from './viewMath';

type Crop = Geometry['crop'];
const MIN = 0.05;
const HANDLE = 44;

function commitCrop() {
  const r = liveRecipe.value;
  if (r) useEditor.getState().commit(r);
}

/**
 * Crop rectangle drawn over the full (uncropped, straightened) frame. Corners resize with an
 * optional aspect lock, dragging inside moves the rectangle.
 */
export function CropOverlay({ view }: { view: SharedValue<ViewTransform> }) {
  const start = useSharedValue<Crop>({ x: 0, y: 0, w: 1, h: 1 });

  const setCrop = (c: Crop) => {
    'worklet';
    const r = liveRecipe.value;
    if (r) liveRecipe.set({ ...r, geometry: { ...r.geometry, crop: c } });
  };

  /** aspect is w/h in pixels; converted to normalized-frame units. */
  const normAspect = () => {
    'worklet';
    const r = liveRecipe.value;
    const inp = liveInputs.value;
    if (!r || !inp || !r.geometry.aspect) return 0;
    const [fw, fh] = rotatedSize(inp.frame.width, inp.frame.height, r.geometry.rotate90);
    return (r.geometry.aspect * fh) / fw;
  };

  const corner = (cx: 0 | 1, cy: 0 | 1) =>
    Gesture.Pan()
      .minDistance(0)
      .onBegin(() => {
        const r = liveRecipe.value;
        if (r) start.set(r.geometry.crop);
      })
      .onUpdate((e) => {
        const v = view.value;
        const dx = e.translationX / (v.outW * v.s);
        const dy = e.translationY / (v.outH * v.s);
        const s = start.value;
        let x0 = s.x;
        let y0 = s.y;
        let x1 = s.x + s.w;
        let y1 = s.y + s.h;
        if (cx === 0) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx));
        else x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
        if (cy === 0) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy));
        else y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
        const a = normAspect();
        if (a > 0) {
          // keep the dragged width, derive height, clamp inside the frame
          let w = x1 - x0;
          let h = w / a;
          if (h > 1) {
            h = 1;
            w = h * a;
          }
          if (cy === 0) y0 = Math.max(0, y1 - h);
          else y1 = Math.min(1, y0 + h);
          h = y1 - y0;
          w = h * a;
          if (cx === 0) x0 = x1 - w;
          else x1 = x0 + w;
        }
        setCrop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      })
      .onEnd(() => scheduleOnRN(commitCrop));

  const move = Gesture.Pan()
    .onBegin(() => {
      const r = liveRecipe.value;
      if (r) start.set(r.geometry.crop);
    })
    .onUpdate((e) => {
      const v = view.value;
      const s = start.value;
      const x = Math.max(0, Math.min(1 - s.w, s.x + e.translationX / (v.outW * v.s)));
      const y = Math.max(0, Math.min(1 - s.h, s.y + e.translationY / (v.outH * v.s)));
      setCrop({ ...s, x, y });
    })
    .onEnd(() => scheduleOnRN(commitCrop));

  const rect = useAnimatedStyle(() => {
    const v = view.value;
    const c = liveRecipe.value?.geometry.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const [x0, y0] = outToScreen(v, c.x * v.outW, c.y * v.outH);
    const [x1, y1] = outToScreen(v, (c.x + c.w) * v.outW, (c.y + c.h) * v.outH);
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  });

  // dim everything outside the crop with four panels
  const shade = (side: 'top' | 'bottom' | 'left' | 'right') =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAnimatedStyle(() => {
      const v = view.value;
      const c = liveRecipe.value?.geometry.crop ?? { x: 0, y: 0, w: 1, h: 1 };
      const [x0, y0] = outToScreen(v, c.x * v.outW, c.y * v.outH);
      const [x1, y1] = outToScreen(v, (c.x + c.w) * v.outW, (c.y + c.h) * v.outH);
      if (side === 'top') return { left: 0, right: 0, top: 0, height: Math.max(0, y0) };
      if (side === 'bottom') return { left: 0, right: 0, top: y1, bottom: 0 };
      if (side === 'left') return { left: 0, width: Math.max(0, x0), top: y0, height: y1 - y0 };
      return { left: x1, right: 0, top: y0, height: y1 - y0 };
    });
  const shades = [shade('top'), shade('bottom'), shade('left'), shade('right')];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {shades.map((s, i) => (
        <Animated.View key={i} pointerEvents="none" style={[styles.shade, s]} />
      ))}
      <Animated.View style={[styles.rect, rect]}>
        <GestureDetector gesture={move}>
          <View style={StyleSheet.absoluteFill}>
            <View style={[styles.gridV, { left: '33.33%' }]} />
            <View style={[styles.gridV, { left: '66.66%' }]} />
            <View style={[styles.gridH, { top: '33.33%' }]} />
            <View style={[styles.gridH, { top: '66.66%' }]} />
          </View>
        </GestureDetector>
        {([0, 1] as const).flatMap((cx) =>
          ([0, 1] as const).map((cy) => (
            <GestureDetector key={`${cx}${cy}`} gesture={corner(cx, cy)}>
              <View
                style={[
                  styles.handle,
                  cx === 0 ? { left: -HANDLE / 2 } : { right: -HANDLE / 2 },
                  cy === 0 ? { top: -HANDLE / 2 } : { bottom: -HANDLE / 2 },
                ]}
              >
                <View
                  style={[
                    styles.cornerMark,
                    cx === 0 ? { left: HANDLE / 2 - 2 } : { right: HANDLE / 2 - 2 },
                    cy === 0 ? { top: HANDLE / 2 - 2 } : { bottom: HANDLE / 2 - 2 },
                    {
                      borderLeftWidth: cx === 0 ? 3 : 0,
                      borderRightWidth: cx === 1 ? 3 : 0,
                      borderTopWidth: cy === 0 ? 3 : 0,
                      borderBottomWidth: cy === 1 ? 3 : 0,
                    },
                  ]}
                />
              </View>
            </GestureDetector>
          )),
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  shade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.6)' },
  rect: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.5)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.5)' },
  handle: { position: 'absolute', width: HANDLE, height: HANDLE },
  cornerMark: { position: 'absolute', width: 20, height: 20, borderColor: colors.text },
});
