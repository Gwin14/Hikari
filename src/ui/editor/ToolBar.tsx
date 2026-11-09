import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ToolId } from '@/state/editor';
import { Icon, type IconName } from '../Icon';
import { tick } from '../kit';
import { colors, radius, space, type } from '../theme';

export const TOOLS: { id: ToolId; icon: IconName; label: string }[] = [
  { id: 'presets', icon: 'toolPresets', label: 'tools.presets' },
  { id: 'versions', icon: 'toolVersions', label: 'tools.versions' },
  { id: 'auto', icon: 'toolAuto', label: 'tools.auto' },
  { id: 'light', icon: 'toolLight', label: 'tools.light' },
  { id: 'color', icon: 'toolColor', label: 'tools.color' },
  { id: 'curves', icon: 'toolCurves', label: 'tools.curves' },
  { id: 'hsl', icon: 'toolHsl', label: 'tools.hsl' },
  { id: 'grading', icon: 'toolGrading', label: 'tools.grading' },
  { id: 'masks', icon: 'toolMasks', label: 'tools.masks' },
  { id: 'retouch', icon: 'toolRetouch', label: 'tools.retouch' },
  { id: 'geometry', icon: 'toolGeometry', label: 'tools.geometry' },
  { id: 'detail', icon: 'toolDetail', label: 'tools.detail' },
  { id: 'optics', icon: 'toolOptics', label: 'tools.optics' },
  { id: 'effects', icon: 'toolEffects', label: 'tools.effects' },
  { id: 'lut', icon: 'toolLut', label: 'tools.lut' },
  { id: 'raw', icon: 'toolRaw', label: 'tools.raw' },
];

/** Where the dock draws a divider: looks | tone & colour | local | finishing. */
const GROUP_STARTS = new Set<ToolId>(['light', 'masks', 'geometry']);

export function toolMeta(id: ToolId) {
  return TOOLS.find((x) => x.id === id) ?? TOOLS[0];
}

/** The tool dock under the panel: icon over label, the active tool inked in the accent. */
export function ToolBar({ value, onChange, showRaw }: { value: ToolId; onChange(t: ToolId): void; showRaw: boolean }) {
  const { t } = useTranslation();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bar}>
      {TOOLS.filter((x) => x.id !== 'raw' || showRaw).map((tool) => {
        const on = tool.id === value;
        return (
          <Fragment key={tool.id}>
            {GROUP_STARTS.has(tool.id) && <View style={styles.divider} />}
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t(tool.label)}
              style={({ pressed }) => [styles.tool, pressed && !on && { opacity: 0.6 }]}
              onPress={() => {
                if (on) return;
                tick();
                onChange(tool.id);
              }}
            >
              <View style={[styles.iconWrap, on && styles.iconOn]}>
                <Icon name={tool.icon} size={20} color={on ? colors.accent : colors.textDim} weight={on ? 'semibold' : 'regular'} />
              </View>
              <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1}>
                {t(tool.label)}
              </Text>
            </Pressable>
          </Fragment>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.sm, alignItems: 'center' },
  tool: { width: 66, alignItems: 'center', paddingTop: space.sm, paddingBottom: space.xs, gap: space.xs },
  iconWrap: { width: 48, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  iconOn: { backgroundColor: colors.accentSoft },
  label: { color: colors.textDim, ...type.caption2, fontSize: 10, fontWeight: '600' },
  labelOn: { color: colors.text },
  divider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: colors.separator, marginHorizontal: space.xs, marginBottom: space.md },
});
