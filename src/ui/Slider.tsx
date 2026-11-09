import * as Haptics from 'expo-haptics';
import { memo, useCallback, useEffect } from 'react';
import { StyleSheet, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { getIn, setIn, type KeyPath } from '@/core/recipe/path';
import type { Recipe } from '@/core/recipe/schema';
import { getBool } from '@/state/prefs';
import { radius, space, tabular, type, useStyles, useTheme, type Palette } from './theme';

const AnimatedInput = Animated.createAnimatedComponent(TextInput);

export interface SliderProps {
  label: string;
  min: number;
  max: number;
  /** Value at the neutral position (also the double-tap reset value). */
  neutral?: number;
  step?: number;
  /** Decimal places shown. */
  decimals?: number;
  /** Track gradient colors for color sliders (left → right). */
  gradient?: [string, string] | [string, string, string];
  unit?: string;
  value: number;
  onCommit(v: number): void;
  /** Live updates on the UI thread (writes to the live recipe). */
  onLive?: (v: number) => void;
  disabled?: boolean;
}

const TRACK_H = 3;
const KNOB = 22;

function fmt(v: number, decimals: number, unit: string) {
  'worklet';
  const r = decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
  const signed = v > 0 && unit !== '' && unit !== 'K' ? `+${r}` : r;
  return unit === 'EV' ? (v > 0 ? `+${r}` : r) : signed;
}

/**
 * Precision slider. Dragging is relative (no jump on touch); moving the finger away from
 * the track gives fine control, a haptic tick marks the neutral point and double tap resets.
 */
export const Slider = memo(function Slider(p: SliderProps) {
  const { min, max, neutral = 0, step = 0, decimals = 0, unit = '' } = p;
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const accent = c.accentInk;
  const dim = c.textDim;
  // the knob stays white in both themes (a physical control), lifted by its shadow
  const knobIdle = '#FFFFFF';
  const width = useSharedValue(1);
  const value = useSharedValue(p.value);
  /** Unrounded value while dragging (keeps sub-step precision). */
  const start = useSharedValue(p.value);
  const active = useSharedValue(0);

  useEffect(() => {
    if (!active.value) {
      value.set(p.value);
      start.set(p.value);
    }
  }, [p.value, value, start, active]);

  const onLayout = (e: LayoutChangeEvent) => {
    width.set(Math.max(1, e.nativeEvent.layout.width - KNOB));
  };

  const haptic = useCallback(() => {
    if (getBool('haptics', true)) Haptics.selectionAsync();
  }, []);
  const commit = useCallback((v: number) => p.onCommit(v), [p]);
  const live = p.onLive;

  const lastX = useSharedValue(0);
  const pan = Gesture.Pan()
    .enabled(!p.disabled)
    .activeOffsetX([-4, 4])
    .failOffsetY([-18, 18])
    .onStart((e) => {
      active.set(1);
      lastX.set(e.translationX);
    })
    .onUpdate((e) => {
      // Incremental, so changing precision mid-drag never makes the value jump.
      // Dragging the finger away from the track (vertically) gives 4x finer control.
      const dx = e.translationX - lastX.value;
      lastX.set(e.translationX);
      const precision = Math.abs(e.translationY) > 40 ? 0.25 : 1;
      const raw = Math.min(max, Math.max(min, start.value + ((dx * precision) / width.value) * (max - min)));
      start.set(raw);
      const v = step > 0 ? Math.round(raw / step) * step : raw;
      const prev = value.value;
      if (v === prev) return;
      if ((prev - neutral) * (v - neutral) < 0 || (v === neutral && prev !== neutral)) scheduleOnRN(haptic);
      value.set(v);
      if (live) live(v);
    })
    .onEnd(() => {
      scheduleOnRN(commit, value.value);
    })
    .onFinalize(() => {
      active.set(0);
      start.set(value.value);
    });

  const tap = Gesture.Tap()
    .numberOfTaps(2)
    .enabled(!p.disabled)
    .onEnd(() => {
      value.set(neutral);
      start.set(neutral);
      if (live) live(neutral);
      scheduleOnRN(commit, neutral);
      scheduleOnRN(haptic);
    });

  const knob = useAnimatedStyle(() => ({
    transform: [{ translateX: ((value.value - min) / (max - min)) * width.value }, { scale: withTiming(active.value ? 1.15 : 1, { duration: 120 }) }],
    backgroundColor: knobIdle,
  }));
  const fill = useAnimatedStyle(() => {
    const pos = ((value.value - min) / (max - min)) * width.value;
    const zero = ((neutral - min) / (max - min)) * width.value;
    return { left: Math.min(pos, zero) + KNOB / 2, width: Math.abs(pos - zero) };
  });
  const textProps = useAnimatedProps(() => ({ text: fmt(value.value, decimals, unit) }) as never);
  const labelStyle = useAnimatedStyle(() => ({ color: active.value ? accent : dim }));
  const valueStyle = useAnimatedStyle(() => ({ color: active.value || value.value !== neutral ? accent : dim }));
  // bipolar sliders get a tick at the neutral point
  const centre = neutral > min && neutral < max ? (neutral - min) / (max - min) : null;

  return (
    <GestureDetector gesture={Gesture.Simultaneous(pan, tap)}>
      <View style={[styles.root, p.disabled && { opacity: 0.4 }]} collapsable={false}>
        <View style={styles.header}>
          <Animated.Text style={[styles.label, labelStyle]} numberOfLines={1}>
            {p.label}
          </Animated.Text>
          <AnimatedInput
            editable={false}
            pointerEvents="none"
            style={[styles.value, valueStyle]}
            defaultValue={fmt(p.value, decimals, unit)}
            animatedProps={textProps}
          />
        </View>
        <View style={styles.trackWrap} onLayout={onLayout}>
          <View style={[styles.track, p.gradient && { backgroundColor: 'transparent' }]}>
            {p.gradient && <GradientTrack colors={p.gradient} />}
          </View>
          {centre !== null && !p.gradient && (
            <View style={styles.tickTrack} pointerEvents="none">
              <View style={[styles.tick, { left: `${centre * 100}%` }]} />
            </View>
          )}
          {!p.gradient && <Animated.View style={[styles.fill, fill]} />}
          <Animated.View style={[styles.knob, knob]} />
        </View>
      </View>
    </GestureDetector>
  );
});

function GradientTrack({ colors: c }: { colors: string[] }) {
  return (
    <View style={[StyleSheet.absoluteFill, { flexDirection: 'row', borderRadius: 2, overflow: 'hidden' }]}>
      {c.map((col, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: col }} />
      ))}
    </View>
  );
}

/** Slider bound to a recipe key path: live on the UI thread, committed to history on release. */
export function RecipeSlider(
  props: Omit<SliderProps, 'value' | 'onCommit' | 'onLive'> & {
    path: KeyPath;
    recipe: Recipe;
    live: SharedValue<Recipe | null>;
    onCommit(path: KeyPath, v: number): void;
  },
) {
  const { path, recipe, live, onCommit, ...rest } = props;
  const value = (getIn(recipe, path) as number) ?? 0;
  const onLive = (v: number) => {
    'worklet';
    const r = live.value;
    if (r) live.set(setIn(r, path, v));
  };
  return <Slider {...rest} value={value} onLive={onLive} onCommit={(v) => onCommit(path, v)} />;
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    root: { paddingVertical: space.sm, paddingHorizontal: space.lg },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.xs },
    label: { ...type.subhead, fontWeight: '500', flex: 1 },
    value: { ...type.subhead, fontWeight: '600', ...tabular, minWidth: 56, textAlign: 'right', padding: 0 },
    trackWrap: { height: KNOB + 6, justifyContent: 'center' },
    track: {
      position: 'absolute',
      left: KNOB / 2,
      right: KNOB / 2,
      height: TRACK_H,
      borderRadius: radius.pill,
      backgroundColor: c.surface3,
    },
    tickTrack: { position: 'absolute', left: KNOB / 2, right: KNOB / 2, height: 10 },
    tick: { position: 'absolute', top: 0, width: 2, height: 10, marginLeft: -1, borderRadius: 1, backgroundColor: c.textFaint },
    fill: { position: 'absolute', height: TRACK_H, backgroundColor: c.accent, borderRadius: radius.pill },
    knob: {
      position: 'absolute',
      left: 0,
      width: KNOB,
      height: KNOB,
      borderRadius: KNOB / 2,
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
    },
  });
