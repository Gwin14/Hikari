import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PhotoItem } from '@/core/sources/types';
import { useLibrary, type FilterId, type SortId, type ViewFilter } from '@/state/library';
import { Chip, ChipRow, IconButton } from './kit';
import { colors, font, space } from './theme';

/** Header shared by the Gallery and Folders browsers so both modes look the same. */
export function BrowserHeader(props: { title: string; subtitle?: string; onTitlePress?: () => void; left?: ReactNode; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
      {props.left}
      <Pressable style={{ flex: 1 }} onPress={props.onTitlePress} disabled={!props.onTitlePress}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={styles.title} numberOfLines={1}>
            {props.title}
          </Text>
          {props.onTitlePress && <Ionicons name="chevron-down" size={18} color={colors.textDim} />}
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
  const selection = useLibrary((s) => s.selection);
  const selecting = useLibrary((s) => s.selecting);
  const { clearSelection, selectAll, setMeta } = useLibrary.getState();
  if (!selecting) return null;
  const chosen = items.filter((i) => selection.has(i.key));
  const exportSel = () => router.push({ pathname: '/export', params: { keys: chosen.map((c) => c.key).join('\n') } });
  const pasteSel = () => router.push({ pathname: '/batch', params: { keys: chosen.map((c) => c.key).join('\n') } });
  return (
    <View style={[styles.selBar, { paddingBottom: insets.bottom + 8 }]}>
      <IconButton icon="close" onPress={clearSelection} label={t('common.cancel')} />
      <Text style={styles.selCount}>{t('common.selected', { count: chosen.length })}</Text>
      <IconButton icon="checkmark-done" onPress={() => selectAll(items.map((i) => i.key))} label={t('common.all')} />
      <IconButton icon="flag" onPress={() => chosen.forEach((c) => setMeta(c, { flag: 1 }))} label={t('culling.pick')} />
      <IconButton icon="close-circle" onPress={() => chosen.forEach((c) => setMeta(c, { flag: -1 }))} label={t('culling.reject')} />
      <IconButton icon="clipboard" onPress={pasteSel} disabled={!chosen.length} label={t('editor.paste')} />
      <IconButton icon="share-outline" onPress={exportSel} disabled={!chosen.length} active label={t('export.title')} />
    </View>
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
  title: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: colors.textDim, fontSize: font.sm, marginTop: 2 },
  selBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  selCount: { flex: 1, color: colors.text, fontSize: font.md, fontWeight: '600' },
});
