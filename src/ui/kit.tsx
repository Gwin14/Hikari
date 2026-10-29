import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { getBool } from '@/state/prefs';
import { colors, font, radius, space } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export const tick = () => {
  if (getBool('haptics', true)) Haptics.selectionAsync();
};

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

export function ToggleRow(props: { label: string; value: boolean; onChange(v: boolean): void; hint?: string }) {
  return (
    <View style={styles.row}>
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
}) {
  return (
    <Pressable onPress={props.onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface2 }]}>
      {props.icon && (
        <Ionicons name={props.icon} size={20} color={props.destructive ? colors.danger : colors.textDim} style={{ marginRight: space.md }} />
      )}
      <Text style={[styles.rowLabel, { flex: 1 }, props.destructive && { color: colors.danger }]}>{props.label}</Text>
      {props.value ? <Text style={styles.rowValue}>{props.value}</Text> : null}
      {props.chevron !== false && props.onPress ? <Ionicons name="chevron-forward" size={16} color={colors.textFaint} /> : null}
    </Pressable>
  );
}

export function Button(props: { label: string; onPress(): void; primary?: boolean; icon?: IconName; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.primary && styles.buttonPrimary,
        (pressed || props.disabled) && { opacity: 0.6 },
        props.style,
      ]}
    >
      {props.icon && <Ionicons name={props.icon} size={18} color={props.primary ? colors.bg : colors.text} />}
      <Text style={[styles.buttonText, props.primary && { color: colors.bg }]}>{props.label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  iconBtn: { padding: 6, alignItems: 'center', justifyContent: 'center' },
  segmented: { flexDirection: 'row', backgroundColor: colors.surface2, borderRadius: radius.md, padding: 2 },
  segment: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: radius.md - 2 },
  segmentOn: { backgroundColor: colors.surface3, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
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
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonText: { color: colors.text, fontSize: font.md, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
});
