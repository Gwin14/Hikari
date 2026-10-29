import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ToolId } from '@/state/editor';
import { tick, type IconName } from '../kit';
import { colors, radius, space } from '../theme';

export const TOOLS: { id: ToolId; icon: IconName; label: string }[] = [
  { id: 'presets', icon: 'albums-outline', label: 'tools.presets' },
  { id: 'versions', icon: 'git-branch-outline', label: 'tools.versions' },
  { id: 'auto', icon: 'sparkles-outline', label: 'tools.auto' },
  { id: 'light', icon: 'sunny-outline', label: 'tools.light' },
  { id: 'color', icon: 'thermometer-outline', label: 'tools.color' },
  { id: 'curves', icon: 'analytics-outline', label: 'tools.curves' },
  { id: 'hsl', icon: 'color-palette-outline', label: 'tools.hsl' },
  { id: 'grading', icon: 'color-filter-outline', label: 'tools.grading' },
  { id: 'masks', icon: 'layers-outline', label: 'tools.masks' },
  { id: 'detail', icon: 'aperture-outline', label: 'tools.detail' },
  { id: 'geometry', icon: 'crop-outline', label: 'tools.geometry' },
  { id: 'optics', icon: 'eye-outline', label: 'tools.optics' },
  { id: 'effects', icon: 'film-outline', label: 'tools.effects' },
  { id: 'lut', icon: 'cube-outline', label: 'tools.lut' },
  { id: 'raw', icon: 'hardware-chip-outline', label: 'tools.raw' },
];

export function ToolBar({ value, onChange, showRaw }: { value: ToolId; onChange(t: ToolId): void; showRaw: boolean }) {
  const { t } = useTranslation();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bar}>
      {TOOLS.filter((x) => x.id !== 'raw' || showRaw).map((tool) => {
        const on = tool.id === value;
        return (
          <Pressable
            key={tool.id}
            style={styles.tool}
            onPress={() => {
              tick();
              onChange(tool.id);
            }}
          >
            <View style={[styles.iconWrap, on && styles.iconOn]}>
              <Ionicons name={tool.icon} size={21} color={on ? colors.accent : colors.textDim} />
            </View>
            <Text style={[styles.label, on && { color: colors.accent }]} numberOfLines={1}>
              {t(tool.label)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.sm, gap: 2 },
  tool: { width: 64, alignItems: 'center', paddingVertical: space.sm, gap: 3 },
  iconWrap: { width: 44, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  iconOn: { backgroundColor: colors.accentSoft },
  label: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
});
