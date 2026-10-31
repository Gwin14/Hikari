import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { BottomTabBarHeightContext } from 'expo-router/tabs';
import { useContext, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PhotoItem } from '@/core/sources/types';
import { useLibrary, type FilterId, type SortId, type ViewFilter } from '@/state/library';
import { Chip, ChipRow, IconButton } from './kit';
import { colors, curve, font, radius, space } from './theme';

/** Header shared by the Gallery and Folders browsers so both modes look the same. */
export function BrowserHeader(props: { title: string; subtitle?: string; onTitlePress?: () => void; left?: ReactNode; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
      {props.left}
      <Pressable
        style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.6 }]}
        onPress={props.onTitlePress}
        disabled={!props.onTitlePress}
        accessibilityRole={props.onTitlePress ? 'button' : 'header'}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.title} numberOfLines={1}>
            {props.title}
          </Text>
          {props.onTitlePress && (
            <View style={styles.titleChevron}>
              <Ionicons name="chevron-down" size={14} color={colors.text} />
            </View>
          )}
        </View>
        {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
      </Pressable>
      {props.right}
    </View>
  );
}

const FILTERS: FilterId[] = ['all', 'edited', 'raw', 'pairs', 'picks', 'favorites', 'rejected'];
const SORTS: SortId[] = ['newest', 'oldest', 'name'];

export function FilterBar({ value, onChange }: { value: ViewFilter; onChange(v: ViewFilter): void }) {
  const { t } = useTranslation();
  const sortLabel = { newest: t('filter.sortNewest'), oldest: t('filter.sortOldest'), name: t('filter.sortName') };
  return (
    <ChipRow>
      {FILTERS.map((f) => (
        <Chip key={f} label={t(`filter.${f}`)} active={value.filter === f} onPress={() => onChange({ ...value, filter: f })} />
      ))}
      <Chip
        icon="star"
        label={value.minRating ? t('filter.rating', { n: value.minRating }) : '★'}
        active={value.minRating > 0}
        onPress={() => onChange({ ...value, minRating: (value.minRating + 1) % 6 })}
      />
      <Chip
        icon="swap-vertical"
        label={sortLabel[value.sort]}
        onPress={() => onChange({ ...value, sort: SORTS[(SORTS.indexOf(value.sort) + 1) % SORTS.length] })}
      />
    </ChipRow>
  );
}

/** Bottom action bar while multi-selecting: batch export, paste edits, culling. */
export function SelectionBar({ items }: { items: PhotoItem[] }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // inside the tabs the bar floats above the (absolute) tab bar; elsewhere above the home indicator
  const tabBar = useContext(BottomTabBarHeightContext) ?? 0;
  const selection = useLibrary((s) => s.selection);
  const selecting = useLibrary((s) => s.selecting);
  const { clearSelection, selectAll, setMeta } = useLibrary.getState();
  if (!selecting) return null;
  const chosen = items.filter((i) => selection.has(i.key));
  const exportSel = () => router.push({ pathname: '/export', params: { keys: chosen.map((c) => c.key).join('\n') } });
  const pasteSel = () => router.push({ pathname: '/batch', params: { keys: chosen.map((c) => c.key).join('\n') } });
  return (
    <Animated.View
      entering={FadeInDown.duration(200)}
      exiting={FadeOutDown.duration(150)}
      style={[styles.selBar, { bottom: (tabBar || insets.bottom) + space.sm }]}
    >
      {Platform.OS === 'ios' && <BlurView tint="systemChromeMaterialDark" intensity={90} style={StyleSheet.absoluteFill} />}
      <IconButton icon="close" onPress={clearSelection} label={t('common.cancel')} />
      <Text style={styles.selCount}>{t('common.selected', { count: chosen.length })}</Text>
      <IconButton icon="checkmark-done" onPress={() => selectAll(items.map((i) => i.key))} label={t('common.all')} />
      <IconButton icon="flag" onPress={() => chosen.forEach((c) => setMeta(c, { flag: 1 }))} label={t('culling.pick')} />
      <IconButton icon="close-circle" onPress={() => chosen.forEach((c) => setMeta(c, { flag: -1 }))} label={t('culling.reject')} />
      <IconButton icon="clipboard" onPress={pasteSel} disabled={!chosen.length} label={t('editor.paste')} />
      <IconButton icon="share-outline" onPress={exportSel} disabled={!chosen.length} active label={t('export.title')} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
    backgroundColor: colors.bg,
  },
  title: { color: colors.text, fontSize: 34, fontWeight: '700', letterSpacing: -0.6, flexShrink: 1 },
  titleChevron: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  subtitle: { color: colors.textDim, fontSize: font.sm, fontWeight: '500', marginTop: 2, fontVariant: ['tabular-nums'] },
  selBar: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.xl,
    ...curve,
    overflow: 'hidden',
    backgroundColor: Platform.OS === 'ios' ? 'transparent' : colors.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  selCount: { flex: 1, color: colors.text, fontSize: font.md, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
