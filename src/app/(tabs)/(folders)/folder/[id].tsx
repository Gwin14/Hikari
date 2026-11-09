import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { listFolders } from '@/core/db/db';
import { listFolder, openFolder } from '@/core/sources/folders';
import type { FolderEntry, PhotoItem } from '@/core/sources/types';
import { applyFilter, defaultFilter, useLibrary, type ViewFilter } from '@/state/library';
import { BrowserToolbar, FilterBar, SelectionToolbar, useSelectionMode } from '@/ui/BrowserChrome';
import { Icon } from '@/ui/Icon';
import { Button, EmptyState } from '@/ui/kit';
import { GridFooter, PhotoGrid } from '@/ui/PhotoGrid';
import { curve, radius, space, type, useStyles, useTheme, type Palette } from '@/ui/theme';

/** Folder browser — the same grid, filters and selection as the Library, inside the Folders tab. */
export default function FolderScreen() {
  const { t } = useTranslation();
  const c = useTheme();
  const s = useStyles(makeStyles);
  const { id, path, name } = useLocalSearchParams<{ id: string; path?: string; name?: string }>();
  const row = useMemo(() => listFolders().find((f) => f.id === id), [id]);
  const [uri, setUri] = useState<string | null>(path ?? null);
  const [subfolders, setSubfolders] = useState<FolderEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ViewFilter>({ ...defaultFilter, sort: 'name' });
  const items = useLibrary((st) => st.folderItems);
  const meta = useLibrary((st) => st.meta);
  const selection = useLibrary((st) => st.selection);
  const selecting = useLibrary((st) => st.selecting);
  const { setFolderItems, setSequence, toggleSelect, setSelecting } = useLibrary.getState();
  useSelectionMode();
  // leaving the folder ends a selection made in it
  useEffect(() => () => setSelecting(false), [setSelecting]);

  useEffect(() => {
    if (!row || uri) return;
    openFolder(row)
      .then(setUri)
      .catch(() => setError(t('folders.accessLost')));
  }, [row, uri, t]);

  const load = useCallback(() => {
    if (!uri || !row) return;
    try {
      const listing = listFolder(uri, row.id);
      setSubfolders(listing.folders);
      setFolderItems(listing.photos);
      setError(null);
    } catch {
      setError(t('folders.accessLost'));
    }
  }, [uri, row, setFolderItems, t]);

  // Reload on focus: subfolders share the store listing, and edits change badges.
  useFocusEffect(load);

  const visible = useMemo(() => applyFilter(items, meta, filter), [items, meta, filter]);

  const open = (item: PhotoItem) => {
    if (selecting) return toggleSelect(item.key);
    setSequence(visible);
    router.push({ pathname: '/editor/[key]', params: { key: item.key } });
  };

  const title = name ?? row?.name ?? '';

  if (error) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.bg }} contentContainerStyle={s.centered}>
        <Stack.Title>{title}</Stack.Title>
        <EmptyState icon="lock" title={error} body={t('folders.accessLostBody')} action={<Button label={t('common.back')} onPress={() => router.back()} />} />
      </ScrollView>
    );
  }

  // the grid is the screen's first view so the large title collapses with it
  return (
    <>
      <PhotoGrid
        items={visible}
        meta={meta}
        selection={selection}
        selecting={selecting}
        onPress={open}
        onLongPress={(it) => toggleSelect(it.key)}
        loading={!uri}
        header={
          <View>
            {subfolders.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.subs}>
                {subfolders.map((f) => (
                  <Pressable
                    key={f.uri}
                    accessibilityRole="button"
                    style={({ pressed }) => [s.sub, pressed && { backgroundColor: c.surface3 }]}
                    onPress={() => router.push({ pathname: '/folder/[id]', params: { id, path: f.uri, name: f.name } })}
                  >
                    <Icon name="foldersFill" size={16} color={c.accentInk} />
                    <Text style={s.subText} numberOfLines={1}>
                      {f.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <FilterBar value={filter} onChange={setFilter} />
          </View>
        }
        footer={<GridFooter label={t('folders.items', { count: visible.length })} />}
        empty={<EmptyState icon="photo" title={t('folders.emptyFolder')} body={t('library.emptyBody')} style={s.empty} />}
      />
      <BrowserToolbar title={title} filter={filter} onFilter={setFilter} items={visible} />
      <SelectionToolbar items={visible} />
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    subs: { gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.xs },
    sub: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm - 2,
      paddingHorizontal: 14,
      minHeight: 38,
      borderRadius: radius.tile,
      ...curve,
      backgroundColor: c.surface,
      maxWidth: 220,
    },
    subText: { color: c.text, ...type.subhead, fontWeight: '600' },
    empty: { marginTop: 96 },
    centered: { flexGrow: 1, justifyContent: 'center', paddingVertical: space.xxxl },
  });
