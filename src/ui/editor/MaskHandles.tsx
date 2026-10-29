import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { Mask, MaskGeometry } from '@/core/recipe/schema';
import { liveRecipe, useEditor } from '@/state/editor';
import { colors } from '../theme';
import { imageToScreen, screenToImage, type ViewTransform } from './viewMath';

const DOT = 26;

function commitMask() {
  const r = liveRecipe.value;
  if (r) useEditor.getState().commit(r);
}

type Field = 'p1' | 'p2' | 'center' | 'radiusX' | 'radiusY';

/** Draggable handles for linear and radial gradient masks. */
export function MaskHandles({ view, mask }: { view: SharedValue<ViewTransform>; mask: Mask }) {
  const id = mask.id;
  const start = useSharedValue<MaskGeometry>(mask.geometry);

  const geo = (): MaskGeometry | null => {
    'worklet';
    const m = liveRecipe.value?.masks.find((x) => x.id === id);
    return m ? m.geometry : null;
  };
  const setGeo = (g: MaskGeometry) => {
    'worklet';
    const r = liveRecipe.value;
    if (!r) return;
    liveRecipe.set({ ...r, masks: r.masks.map((m) => (m.id === id ? { ...m, geometry: g } : m)) });
  };

  const drag = (field: Field) =>
    Gesture.Pan()
      .minDistance(0)
      .onBegin(() => {
        const g = geo();
        if (g) start.set(g);
      })
      .onUpdate((e) => {
        const v = view.value;
        const s = start.value;
        // gesture delta mapped into normalized image space (follows rotation, flips and crop)
        const [ax, ay] = imageToScreen(v, 0, 0);
        const [dx, dy] = screenToImage(v, ax + e.translationX, ay + e.translationY);
        if (field === 'p1') setGeo({ ...s, x1: s.x1 + dx, y1: s.y1 + dy });
        else if (field === 'p2') setGeo({ ...s, x2: s.x2 + dx, y2: s.y2 + dy });
        else if (field === 'center') {
          setGeo({ ...s, cx: s.cx + dx, cy: s.cy + dy, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy });
        } else if (field === 'radiusX') setGeo({ ...s, rx: Math.max(0.02, s.rx + dx) });
        else setGeo({ ...s, ry: Math.max(0.02, s.ry + dy) });
      })
      .onEnd(() => scheduleOnRN(commitMask));

  const at = (pick: (g: MaskGeometry) => [number, number]) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAnimatedStyle(() => {
      const g = geo();
      if (!g) return { opacity: 0 };
      const [x, y] = pick(g);
      const [sx, sy] = imageToScreen(view.value, x, y);
      return { opacity: 1, transform: [{ translateX: sx - DOT / 2 }, { translateY: sy - DOT / 2 }] };
    });

  // pickers run inside useAnimatedStyle on the UI thread, so they must be worklets too
  const p1 = at((g) => {
    'worklet';
    return [g.x1, g.y1];
  });
  const p2 = at((g) => {
    'worklet';
    return [g.x2, g.y2];
  });
  const center = at((g) => {
    'worklet';
    return [g.cx, g.cy];
  });
  const rx = at((g) => {
    'worklet';
    return [g.cx + g.rx, g.cy];
  });
  const ry = at((g) => {
    'worklet';
    return [g.cx, g.cy + g.ry];
  });

  // guide line between linear points
  const line = useAnimatedStyle(() => {
    const g = geo();
    if (!g) return { opacity: 0 };
    const [ax, ay] = imageToScreen(view.value, g.x1, g.y1);
    const [bx, by] = imageToScreen(view.value, g.x2, g.y2);
    const len = Math.hypot(bx - ax, by - ay);
    return {
      opacity: 1,
      width: len,
      transform: [{ translateX: (ax + bx) / 2 - len / 2 }, { translateY: (ay + by) / 2 }, { rotate: `${Math.atan2(by - ay, bx - ax)}rad` }],
    };
  });

  const handles: [Field, ReturnType<typeof at>][] =
    mask.type === 'linear' ? [['p1', p1], ['p2', p2]] : [['center', center], ['radiusX', rx], ['radiusY', ry]];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {mask.type === 'linear' && <Animated.View pointerEvents="none" style={[styles.line, line]} />}
      {handles.map(([f, style]) => (
        <GestureDetector key={f} gesture={drag(f)}>
          <Animated.View style={[styles.dot, f === 'center' || f === 'p1' ? styles.primary : null, style]} />
        </GestureDetector>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 2,
    borderColor: colors.text,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  primary: { backgroundColor: colors.accent },
  line: { position: 'absolute', left: 0, top: 0, height: 1.5, backgroundColor: 'rgba(255,255,255,0.8)' },
});
