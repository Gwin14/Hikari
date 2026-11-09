import * as Haptics from 'expo-haptics';
import { Children, Fragment, isValidElement, useEffect, type ComponentProps, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { getBool } from '@/state/prefs';
import { Icon, type IconName } from './Icon';
import { curve, radius, raised, space, tabular, type, useStyles, useTheme, type Palette } from './theme';

export type { IconName } from './Icon';

export const tick = () => {
  if (getBool('haptics', true)) Haptics.selectionAsync();
};

/** Snap / commit haptic (a value lands home, a mode toggles). */
export const thud = () => {
  if (getBool('haptics', true)) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

/** Outcome haptic (export/batch finished), paired with the visual change. */
export const notifySuccess = () => {
  if (getBool('haptics', true)) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Pressable that settles to 0.97 on press-in: the press feedback for buttons and cards. */
export function PressableScale(props: Omit<ComponentProps<typeof Pressable>, 'style'> & { style?: StyleProp<ViewStyle>; scaleTo?: number }) {
  const { style, onPressIn, onPressOut, scaleTo = 0.97, ...rest } = props;
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        scale.set(withTiming(scaleTo, { duration: 110, easing: EASE_OUT }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withTiming(1, { duration: 180, easing: EASE_OUT }));
        onPressOut?.(e);
      }}
      style={[style, animated]}
    />
  );
}

/**
 * Icon-only button. `plain` sits in a bar (opacity press), `glass` is a 36 pt disc that floats
 * over the photo, `filled` is a disc on a surface. Hit area is always at least 44 pt.
 */
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
  variant?: 'plain' | 'glass' | 'filled';
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  const variant = props.variant ?? 'plain';
  const color = props.disabled ? c.textFaint : props.active ? c.accentInk : (props.color ?? c.text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled, selected: props.active }}
      hitSlop={variant === 'plain' ? 6 : 4}
      disabled={props.disabled}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      onPressIn={props.onPressIn}
      onPressOut={props.onPressOut}
      style={({ pressed }) => [
        s.iconBtn,
        variant === 'glass' && s.iconGlass,
        variant === 'filled' && s.iconFilled,
        props.active && variant !== 'plain' && { backgroundColor: c.accentSoft },
        pressed && { opacity: 0.55 },
        props.style,
      ]}
    >
      <Icon name={props.icon} size={props.size ?? (variant === 'plain' ? 22 : 18)} color={color} weight={variant === 'plain' ? 'regular' : 'medium'} />
    </Pressable>
  );
}

/** Pill segmented control: 2–5 mutually exclusive options. */
export function Segmented<T extends string | number>(props: {
  options: readonly { value: T; label: string }[];
  value: NoInfer<T>;
  onChange(v: NoInfer<T>): void;
  style?: StyleProp<ViewStyle>;
}) {
  const s = useStyles(makeStyles);
  return (
    <View style={[s.segmented, props.style]} accessibilityRole="tablist">
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (on) return;
              tick();
              props.onChange(o.value);
            }}
            style={[s.segment, on && s.segmentOn]}
          >
            <Text style={[s.segmentText, on && s.segmentTextOn]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip(props: { label: string; active?: boolean; onPress?: () => void; icon?: IconName; color?: string; accessibilityLabel?: string }) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  const ink = props.active ? c.onAccent : (props.color ?? c.text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: !!props.active }}
      onPress={() => {
        tick();
        props.onPress?.();
      }}
      style={({ pressed }) => [s.chip, props.active && s.chipOn, pressed && !props.active && { backgroundColor: c.surface3 }]}
    >
      {props.icon && <Icon name={props.icon} size={14} color={ink} weight="semibold" />}
      <Text style={[s.chipText, { color: ink }]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ChipRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles(makeStyles);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[s.chipRow, style]}>
      {children}
    </ScrollView>
  );
}

/** Small header above a group or a block of controls. */
export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.sectionTitle}>
      <Text style={s.sectionTitleText} accessibilityRole="header">
        {title}
      </Text>
      {right}
    </View>
  );
}

/**
 * Inset grouped list section (Settings-style): an optional header, rows on a rounded surface
 * with inset hairline separators, and an optional footer explaining the group.
 */
export function Group({ title, footer, children, style }: { title?: string; footer?: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles(makeStyles);
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[s.group, style]}>
      {title ? (
        <Text style={s.groupTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <View style={s.groupCard}>
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {i > 0 && <View style={s.separator} />}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={s.groupFooter}>{footer}</Text> : null}
    </View>
  );
}

function RowIcon({ icon, color }: { icon: IconName; color: string }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.rowIcon}>
      <Icon name={icon} size={20} color={color} />
    </View>
  );
}

export function ToggleRow(props: { label: string; value: boolean; onChange(v: boolean): void; hint?: string; icon?: IconName; disabled?: boolean }) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={[s.row, props.disabled && { opacity: 0.4 }]}>
      {props.icon && <RowIcon icon={props.icon} color={c.textDim} />}
      <View style={{ flex: 1 }}>
        <Text style={s.rowLabel}>{props.label}</Text>
        {props.hint ? <Text style={s.rowHint}>{props.hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={props.label}
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onChange}
        trackColor={{ true: c.accent, false: c.surface3 }}
        thumbColor={process.env.EXPO_OS === 'android' ? (props.value ? c.onAccent : c.textDim) : undefined}
        ios_backgroundColor={c.surface3}
      />
    </View>
  );
}

export function ListRow(props: {
  label: string;
  value?: string;
  hint?: string;
  icon?: IconName;
  onPress?: () => void;
  destructive?: boolean;
  chevron?: boolean;
  /** Checkmark for single-choice lists (language, album). */
  selected?: boolean;
  right?: ReactNode;
}) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  const ink = props.destructive ? c.danger : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.selected === undefined ? { disabled: !props.onPress } : { selected: props.selected }}
      disabled={!props.onPress}
      onPress={props.onPress}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: c.surface2 }, !props.onPress && props.selected === undefined && !props.value && { opacity: 0.4 }]}
    >
      {props.icon && <RowIcon icon={props.icon} color={props.destructive ? c.danger : c.textDim} />}
      <View style={{ flex: 1 }}>
        <Text style={[s.rowLabel, { color: ink }]} numberOfLines={2}>
          {props.label}
        </Text>
        {props.hint ? (
          <Text style={s.rowHint} numberOfLines={1}>
            {props.hint}
          </Text>
        ) : null}
      </View>
      {props.value ? (
        <Text style={s.rowValue} numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      {props.right}
      {props.selected ? <Icon name="check" size={18} color={c.accentInk} weight="semibold" /> : null}
      {props.chevron !== false && props.onPress && props.selected === undefined ? <Icon name="chevron" size={14} color={c.textFaint} weight="semibold" /> : null}
    </Pressable>
  );
}

export function Button(props: {
  label: string;
  onPress(): void;
  primary?: boolean;
  icon?: IconName;
  disabled?: boolean;
  destructive?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  const ink = props.primary ? c.onAccent : props.destructive ? c.danger : c.text;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[s.button, props.primary && s.buttonPrimary, props.disabled && { opacity: 0.4 }, props.style]}
    >
      {props.icon && <Icon name={props.icon} size={18} color={ink} weight="semibold" />}
      <Text style={[s.buttonText, { color: ink }]} numberOfLines={1}>
        {props.label}
      </Text>
    </PressableScale>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles(makeStyles);
  return <View style={[s.card, style]}>{children}</View>;
}

/** Labelled text field: the label sits above, never inside as a placeholder. */
export function Field({ label, style, ...input }: TextInputProps & { label: string }) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={[s.field, style]}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={c.textFaint}
        selectionColor={c.accentInk}
        keyboardAppearance={c.scheme}
        accessibilityLabel={label}
        {...input}
        style={s.input}
      />
    </View>
  );
}

/** Composed empty / error / permission state: symbol, title, one line of guidance, optional action. */
export function EmptyState(props: { icon: IconName; title: string; body?: string; action?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={[s.empty, props.style]}>
      <View style={s.emptyIcon}>
        <Icon name={props.icon} size={34} color={c.textDim} weight="light" />
      </View>
      <Text style={s.emptyTitle}>{props.title}</Text>
      {props.body ? <Text style={s.emptyBody}>{props.body}</Text> : null}
      {props.action ? <View style={{ marginTop: space.md }}>{props.action}</View> : null}
    </View>
  );
}

/** Determinate progress (export, batch). Animates scaleX only. */
export function ProgressBar({ value }: { value: number }) {
  const s = useStyles(makeStyles);
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    const v = Math.max(0, Math.min(1, value));
    p.set(reduceMotion ? v : withTiming(v, { duration: 250, easing: EASE_OUT }));
  }, [value, p, reduceMotion]);
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: p.get() }] }));
  return (
    <View style={s.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <Animated.View style={[s.trackFill, fill]} />
    </View>
  );
}

/** Drag affordance on top of custom sheets. */
export function Grabber() {
  const s = useStyles(makeStyles);
  return <View style={s.grabber} />;
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    iconBtn: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
    iconGlass: { width: 40, height: 40, backgroundColor: c.glass, boxShadow: raised },
    iconFilled: { width: 36, height: 36, backgroundColor: c.surface2 },
    segmented: { flexDirection: 'row', backgroundColor: c.surface2, borderRadius: radius.pill, padding: 3, ...curve },
    segment: { flex: 1, minHeight: 32, paddingHorizontal: space.sm, justifyContent: 'center', alignItems: 'center', borderRadius: radius.pill, ...curve },
    segmentOn: { backgroundColor: c.scheme === 'dark' ? c.surface3 : c.surface, boxShadow: raised },
    segmentText: { color: c.textDim, ...type.footnote, fontWeight: '500' },
    segmentTextOn: { color: c.text, fontWeight: '600' },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs + 2,
      paddingHorizontal: 14,
      minHeight: 34,
      borderRadius: radius.pill,
      ...curve,
      backgroundColor: c.surface2,
    },
    chipOn: { backgroundColor: c.accent },
    chipText: { ...type.footnote, fontWeight: '600' },
    chipRow: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
    sectionTitle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      paddingBottom: space.xs,
      minHeight: 40,
    },
    sectionTitleText: { color: c.textDim, ...type.footnote, fontWeight: '600' },
    group: { gap: space.sm - 2 },
    groupTitle: { color: c.textDim, ...type.footnote, textTransform: 'uppercase', letterSpacing: 0.2, paddingHorizontal: space.lg },
    groupCard: { backgroundColor: c.surface, borderRadius: radius.card, ...curve, overflow: 'hidden' },
    groupFooter: { color: c.textDim, ...type.footnote, paddingHorizontal: space.lg },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.separator, marginLeft: space.lg },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 11, minHeight: 48 },
    rowIcon: { width: 24, alignItems: 'center' },
    rowLabel: { color: c.text, ...type.body },
    rowHint: { color: c.textDim, ...type.footnote, marginTop: 2 },
    rowValue: { color: c.textDim, ...type.body, maxWidth: '50%', ...tabular },
    button: {
      flexDirection: 'row',
      gap: space.sm,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.xxl,
      minHeight: 50,
      borderRadius: radius.pill,
      ...curve,
      backgroundColor: c.surface2,
    },
    buttonPrimary: { backgroundColor: c.accent },
    buttonText: { ...type.headline },
    card: { backgroundColor: c.surface, borderRadius: radius.card, ...curve, overflow: 'hidden' },
    field: { gap: space.xs + 2 },
    fieldLabel: { color: c.textDim, ...type.footnote, fontWeight: '500' },
    input: {
      backgroundColor: c.surface2,
      color: c.text,
      borderRadius: radius.tile,
      ...curve,
      paddingHorizontal: space.md,
      paddingVertical: 12,
      ...type.body,
      lineHeight: undefined,
    },
    empty: { alignItems: 'center', paddingHorizontal: space.xxxl, gap: space.sm },
    emptyIcon: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: c.surface2,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: space.sm,
    },
    emptyTitle: { color: c.text, ...type.title3, textAlign: 'center' },
    emptyBody: { color: c.textDim, ...type.subhead, textAlign: 'center', maxWidth: 320 },
    track: { height: 4, borderRadius: 2, backgroundColor: c.surface3, overflow: 'hidden', alignSelf: 'stretch' },
    trackFill: { ...StyleSheet.absoluteFill, backgroundColor: c.accent, transformOrigin: 'left' },
    grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 2.5, backgroundColor: c.surface3, marginTop: space.sm - 2 },
  });
