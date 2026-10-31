import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, type ComponentProps, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { getBool } from '@/state/prefs';
import { colors, common, curve, font, radius, raised, space } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export const tick = () => {
  if (getBool('haptics', true)) Haptics.selectionAsync();
};

/** Outcome haptic (export/batch finished), paired with the visual change. */
export const notifySuccess = () => {
  if (getBool('haptics', true)) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Pressable that settles to 0.97 on press-in: the press feedback for buttons and cards. */
export function PressableScale(props: Omit<ComponentProps<typeof Pressable>, 'style'> & { style?: StyleProp<ViewStyle> }) {
  const { style, onPressIn, onPressOut, ...rest } = props;
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        scale.set(withTiming(0.97, { duration: 110, easing: EASE_OUT }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withTiming(1, { duration: 160, easing: EASE_OUT }));
        onPressOut?.(e);
      }}
      style={[style, animated]}
    />
  );
}

export function IconButton(props: {
  icon: IconName;
  onPress?: () => void;
  onLongPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  size?: number;
  color?: string;
  active?: boolean;
  disabled?: boolean;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const color = props.disabled ? colors.textFaint : props.active ? colors.accent : (props.color ?? colors.text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={8}
      disabled={props.disabled}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      onPressIn={props.onPressIn}
      onPressOut={props.onPressOut}
      style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }, props.style]}
    >
      <Ionicons name={props.icon} size={props.size ?? 22} color={color} />
    </Pressable>
  );
}

export function Segmented<T extends string | number>(props: {
  options: readonly { value: T; label: string }[];
  value: NoInfer<T>;
  onChange(v: NoInfer<T>): void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.segmented, props.style]}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => {
              tick();
              props.onChange(o.value);
            }}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip(props: { label: string; active?: boolean; onPress?: () => void; icon?: IconName; color?: string }) {
  return (
    <Pressable
      onPress={() => {
        tick();
        props.onPress?.();
      }}
      style={({ pressed }) => [styles.chip, props.active && styles.chipOn, pressed && { opacity: 0.7 }]}
    >
      {props.icon && <Ionicons name={props.icon} size={14} color={props.active ? colors.bg : (props.color ?? colors.textDim)} />}
      <Text style={[styles.chipText, props.active && styles.chipTextOn]}>{props.label}</Text>
    </Pressable>
  );
}

export function ChipRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chipRow, style]}>
      {children}
    </ScrollView>
  );
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionTitleText}>{title}</Text>
      {right}
    </View>
  );
}

export function ToggleRow(props: { label: string; value: boolean; onChange(v: boolean): void; hint?: string; icon?: IconName }) {
  return (
    <View style={styles.row}>
      {props.icon && <Ionicons name={props.icon} size={20} color={colors.textDim} style={{ marginRight: space.md }} />}
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{props.label}</Text>
        {props.hint ? <Text style={styles.rowHint}>{props.hint}</Text> : null}
      </View>
      <Switch
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ true: colors.accent, false: colors.surface3 }}
        thumbColor={colors.text}
      />
    </View>
  );
}

export function ListRow(props: {
  label: string;
  value?: string;
  icon?: IconName;
  onPress?: () => void;
  destructive?: boolean;
  chevron?: boolean;
  /** Checkmark for single-choice lists (language, album). */
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.selected === undefined ? undefined : { selected: props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface2 }]}
    >
      {props.icon && (
        <Ionicons name={props.icon} size={20} color={props.destructive ? colors.danger : colors.textDim} style={{ marginRight: space.md }} />
      )}
      <Text style={[styles.rowLabel, { flex: 1 }, props.destructive && { color: colors.danger }]}>{props.label}</Text>
      {props.value ? <Text style={styles.rowValue}>{props.value}</Text> : null}
      {props.selected ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null}
      {props.chevron !== false && props.onPress ? <Ionicons name="chevron-forward" size={16} color={colors.textFaint} /> : null}
    </Pressable>
  );
}

export function Button(props: { label: string; onPress(): void; primary?: boolean; icon?: IconName; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, props.primary && styles.buttonPrimary, props.disabled && { opacity: 0.4 }, props.style]}
    >
      {props.icon && <Ionicons name={props.icon} size={18} color={props.primary ? colors.bg : colors.text} />}
      <Text style={[styles.buttonText, props.primary && { color: colors.bg }]} numberOfLines={1}>
        {props.label}
      </Text>
    </PressableScale>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Labelled text field: the label sits above, never inside as a placeholder. */
export function Field({ label, style, ...input }: TextInputProps & { label: string }) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput placeholderTextColor={colors.textFaint} selectionColor={colors.accent} {...input} style={styles.input} />
    </View>
  );
}

/** Composed empty / error / permission state: icon, title, one line of guidance, optional action. */
export function EmptyState(props: { icon: IconName; title: string; body?: string; action?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.empty, props.style]}>
      <View style={styles.emptyIcon}>
        <Ionicons name={props.icon} size={30} color={colors.textDim} />
      </View>
      <Text style={styles.emptyTitle}>{props.title}</Text>
      {props.body ? <Text style={styles.emptyBody}>{props.body}</Text> : null}
      {props.action ? <View style={{ marginTop: space.sm }}>{props.action}</View> : null}
    </View>
  );
}

/** Determinate progress (export, batch). Animates scaleX only. */
export function ProgressBar({ value }: { value: number }) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    const v = Math.max(0, Math.min(1, value));
    p.set(reduceMotion ? v : withTiming(v, { duration: 250, easing: EASE_OUT }));
  }, [value, p, reduceMotion]);
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: p.get() }] }));
  return (
    <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <Animated.View style={[styles.trackFill, fill]} />
    </View>
  );
}

const styles = StyleSheet.create({
  iconBtn: { padding: 6, alignItems: 'center', justifyContent: 'center' },
  segmented: { flexDirection: 'row', backgroundColor: colors.surface2, borderRadius: radius.md, padding: 2, ...curve },
  segment: { flex: 1, minHeight: 32, justifyContent: 'center', alignItems: 'center', borderRadius: radius.md - 2, ...curve },
  segmentOn: { backgroundColor: colors.surface3, boxShadow: raised },
  segmentText: { color: colors.textDim, fontSize: font.sm, fontWeight: '500' },
  segmentTextOn: { color: colors.text },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { color: colors.textDim, fontSize: font.sm, fontWeight: '600' },
  chipTextOn: { color: colors.bg },
  chipRow: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sectionTitleText: { color: colors.textFaint, fontSize: font.xs, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 48,
  },
  rowLabel: { color: colors.text, fontSize: font.md },
  rowHint: { color: colors.textDim, fontSize: font.xs, marginTop: 2 },
  rowValue: { color: colors.textDim, fontSize: font.md, marginRight: space.sm },
  button: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 22,
    minHeight: 50,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonText: { color: colors.text, fontSize: font.md, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    ...curve,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  field: { gap: 6 },
  fieldLabel: common.label,
  input: {
    backgroundColor: colors.surface2,
    color: colors.text,
    borderRadius: radius.md,
    ...curve,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: font.md,
  },
  empty: { alignItems: 'center', paddingHorizontal: space.xl, gap: space.sm },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    ...curve,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  emptyTitle: { color: colors.text, fontSize: font.lg, fontWeight: '700', textAlign: 'center' },
  emptyBody: { color: colors.textDim, fontSize: font.md, lineHeight: 21, textAlign: 'center', maxWidth: 320 },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surface3, overflow: 'hidden', alignSelf: 'stretch' },
  trackFill: { ...StyleSheet.absoluteFill, backgroundColor: colors.accent, transformOrigin: 'left' },
});
