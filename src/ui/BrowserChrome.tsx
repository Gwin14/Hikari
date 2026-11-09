import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, StyleSheet, Text, View } from 'react-native';

import type { PhotoItem } from '@/core/sources/types';
import { useLibrary, type FilterId, type SortId, type ViewFilter } from '@/state/library';
import { useToolbarIcon } from './Icon';
import { Chip, ChipRow, thud } from './kit';
import { DENSITIES, useGridDensity } from './PhotoGrid';
import { curve, radius, space, type, useStyles, useTheme, type Palette } from './theme';

const FILTERS: FilterId[] = ['all', 'edited', 'raw', 'pairs', 'picks', 'favorites', 'rejected'];
const SORTS: SortId[] = ['newest', 'oldest', 'name'];

/** One-tap filters above the grid. Sort, rating and density live in the header's view menu. */
export function FilterBar({ value, onChange }: { value: ViewFilter; onChange(v: ViewFilter): void }) {
  const { t } = useTranslation();
  return (
    <ChipRow>
      {FILTERS.map((f) => (
        <Chip key={f} label={t(`filter.${f}`)} active={value.filter === f} onPress={() => onChange({ ...value, filter: f })} />
      ))}
      {value.minRating > 0 && (
        <Chip icon="star" label={t('filter.rating', { n: value.minRating })} active onPress={() => onChange({ ...value, minRating: 0 })} />
      )}
    </ChipRow>
  );
}

/** Banner row inside the list header (limited photo access, notices). */
export function Notice({ label, onPress }: { label: string; onPress?: () => void }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.noticeWrap}>
      <Text style={s.notice} onPress={onPress} accessibilityRole={onPress ? 'button' : 'text'}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Header items for a photo browser: a native view-options menu (sort, minimum rating, grid
 * density) and Select / Cancel. While selecting, the title becomes the count and a bottom
 * toolbar replaces the tab bar.
 */
export function BrowserToolbar(props: {
  title: string;
  filter: ViewFilter;
  onFilter(v: ViewFilter): void;
  items: PhotoItem[];
  /** Sorting by date isn't offered where the source has no dates worth sorting by. */
  sorts?: SortId[];
}) {
  const { t } = useTranslation();
  const c = useTheme();
  const selecting = useLibrary((s) => s.selecting);
  const selection = useLibrary((s) => s.selection);
  const { setSelecting } = useLibrary.getState();
  const [density, setDensity] = useGridDensity();
  const menuIcon = useToolbarIcon('filter', c.text);
  const sorts = props.sorts ?? SORTS;
  const sortLabel = { newest: t('filter.sortNewest'), oldest: t('filter.sortOldest'), name: t('filter.sortName') };
  const chosen = props.items.filter((i) => selection.has(i.key)).length;

  return (
    <>
      <Stack.Title>{selecting ? (chosen ? t('common.selected', { count: chosen }) : t('common.selectItems')) : props.title}</Stack.Title>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={menuIcon} accessibilityLabel={t('filter.view')} title={t('filter.view')} hidden={selecting}>
          <Stack.Toolbar.Menu inline title={t('filter.sort')}>
            {sorts.map((s) => (
              <Stack.Toolbar.MenuAction key={s} isOn={props.filter.sort === s} onPress={() => props.onFilter({ ...props.filter, sort: s })}>
                {sortLabel[s]}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline title={t('filter.minRating')}>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <Stack.Toolbar.MenuAction key={n} isOn={props.filter.minRating === n} onPress={() => props.onFilter({ ...props.filter, minRating: n })}>
                {n === 0 ? t('filter.anyRating') : t('filter.rating', { n })}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline title={t('filter.density')}>
            {DENSITIES.map((n) => (
              <Stack.Toolbar.MenuAction key={n} isOn={density === n} onPress={() => setDensity(n)}>
                {t('filter.columns', { count: n })}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button
          variant={selecting ? 'done' : 'plain'}
          onPress={() => {
            thud();
            setSelecting(!selecting);
          }}
        >
          {selecting ? t('common.cancel') : t('common.select')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
    </>
  );
}

/** Bottom toolbar while multi-selecting: select all, culling, paste edits, export. */
export function SelectionToolbar({ items }: { items: PhotoItem[] }) {
  const { t } = useTranslation();
  const c = useTheme();
  const selection = useLibrary((s) => s.selection);
  const selecting = useLibrary((s) => s.selecting);
  const { selectAll, setMeta } = useLibrary.getState();
  const icons = {
    all: useToolbarIcon('selectAll', c.text),
    pick: useToolbarIcon('flag', c.text),
    reject: useToolbarIcon('reject', c.text),
    paste: useToolbarIcon('paste', c.text),
    share: useToolbarIcon('share', c.accentInk),
  };
  if (!selecting) return null;
  const chosen = items.filter((i) => selection.has(i.key));
  const keys = chosen.map((i) => i.key).join('\n');
  const none = !chosen.length;
  return (
    <Stack.Toolbar placement="bottom">
      <Stack.Toolbar.Button icon={icons.all} accessibilityLabel={t('common.selectAll')} onPress={() => selectAll(items.map((i) => i.key))} />
      <Stack.Toolbar.Spacer />
      <Stack.Toolbar.Button icon={icons.pick} accessibilityLabel={t('culling.pick')} disabled={none} onPress={() => chosen.forEach((i) => setMeta(i, { flag: 1 }))} />
      <Stack.Toolbar.Button icon={icons.reject} accessibilityLabel={t('culling.reject')} disabled={none} onPress={() => chosen.forEach((i) => setMeta(i, { flag: -1 }))} />
      <Stack.Toolbar.Button
        icon={icons.paste}
        accessibilityLabel={t('editor.paste')}
        disabled={none}
        onPress={() => router.push({ pathname: '/batch', params: { keys } })}
      />
      <Stack.Toolbar.Spacer />
      <Stack.Toolbar.Button
        icon={icons.share}
        accessibilityLabel={t('export.title')}
        disabled={none}
        tintColor={c.accentInk}
        onPress={() => router.push({ pathname: '/export', params: { keys } })}
      />
    </Stack.Toolbar>
  );
}

/**
 * Selection is transient screen state: Android back cancels it before leaving, and it ends when
 * the screen loses focus (so the tab bar never stays hidden behind a pushed screen).
 */
export function useSelectionMode() {
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!useLibrary.getState().selecting) return false;
        useLibrary.getState().setSelecting(false);
        return true;
      });
      return () => {
        sub.remove();
        // pushing the editor/export from a selection keeps it; only leaving for good clears it
      };
    }, []),
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    noticeWrap: { paddingHorizontal: space.lg, paddingTop: space.xs },
    notice: {
      color: c.accentInk,
      backgroundColor: c.accentSoft,
      ...type.footnote,
      fontWeight: '600',
      textAlign: 'center',
      paddingVertical: space.md - 2,
      paddingHorizontal: space.md,
      borderRadius: radius.tile,
      ...curve,
      overflow: 'hidden',
    },
  });
