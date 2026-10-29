import { Canvas, Circle, RadialGradient, SweepGradient, vec } from '@shopify/react-native-skia';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { GradeWheel, Recipe } from '@/core/recipe/schema';
import { liveRecipe, useEditor } from '@/state/editor';
import { colors } from '../theme';

const SIZE = 168;
const R = SIZE / 2;

type Zone = 'shadows' | 'midtones' | 'highlights' | 'global';

/** Hue/saturation wheel for color grading; double tap resets the zone. */
export function ColorWheel({ zone, recipe }: { zone: Zone; recipe: Recipe }) {
  const w = recipe.grading[zone];
  const pos = useSharedValue(toXY(w));

  const setLive = (hue: number, sat: number) => {
    'worklet';
    const r = liveRecipe.value;
    if (!r) return;
    const cur = r.grading[zone];
    liveRecipe.set({ ...r, grading: { ...r.grading, [zone]: { ...cur, hue, sat } } });
  };
  const commit = () => {
    const r = liveRecipe.value;
    if (r) useEditor.getState().commit(r);
  };
  const reset = () => useEditor.getState().update((r) => ({ ...r, grading: { ...r.grading, [zone]: { hue: 0, sat: 0, lum: r.grading[zone].lum } } }));

  const pan = Gesture.Pan()
    .minDistance(0)
    .onUpdate((e) => {
      let x = e.x - R;
      let y = e.y - R;
      const d = Math.hypot(x, y);
      if (d > R) {
        x = (x / d) * R;
        y = (y / d) * R;
      }
      pos.set({ x, y });
      const hue = ((Math.atan2(-y, x) * 180) / Math.PI + 360) % 360;
      const sat = Math.min(100, (Math.min(d, R) / R) * 100);
      setLive(hue, sat);
    })
    .onEnd(() => scheduleOnRN(commit));
  const tap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      pos.set({ x: 0, y: 0 });
      scheduleOnRN(reset);
    });

  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: pos.value.x + R - 11 }, { translateY: pos.value.y + R - 11 }] }));

  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={Gesture.Simultaneous(pan, tap)}>
        <View style={{ width: SIZE, height: SIZE }}>
          <Canvas style={{ width: SIZE, height: SIZE }}>
            <Circle cx={R} cy={R} r={R}>
              <SweepGradient
                c={vec(R, R)}
                colors={['#FF4040', '#FF40FF', '#4040FF', '#40FFFF', '#40FF40', '#FFFF40', '#FF4040']}
              />
            </Circle>
            <Circle cx={R} cy={R} r={R}>
              <RadialGradient c={vec(R, R)} r={R} colors={['rgba(128,128,128,1)', 'rgba(128,128,128,0)']} />
            </Circle>
          </Canvas>
          <Animated.View style={[styles.knob, knob]} pointerEvents="none" />
        </View>
      </GestureDetector>
    </View>
  );
}

function toXY(w: GradeWheel) {
  const a = (w.hue * Math.PI) / 180;
  const d = (w.sat / 100) * R;
  return { x: Math.cos(a) * d, y: -Math.sin(a) * d };
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 12 },
  knob: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.text,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
});
