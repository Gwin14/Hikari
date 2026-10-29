import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { listFolders } from '@/core/db/db';
import { listFolder, openFolder } from '@/core/sources/folders';
import type { FolderEntry, PhotoItem } from '@/core/sources/types';
import { applyFilter, defaultFilter, useLibrary, type ViewFilter } from '@/state/library';
import { BrowserHeader, FilterBar, SelectionBar } from '@/ui/BrowserChrome';
import { Button, IconButton } from '@/ui/kit';
import { PhotoGrid } from '@/ui/PhotoGrid';
import { colors, common, font, radius, space } from '@/ui/theme';

/** Folder browser — the same grid, filters and selection as the Gallery. */
export default function FolderScreen() {
  const { t } = useTranslation();
  const { id, path, name } = useLocalSearchParams<{ id: string; path?: string; name?: string }>();
  const row = useMemo(() => listFolders().find((f) => f.id === id), [id]);
  const [uri, setUri] = useState<string | null>(path ?? null);
  const [subfolders, setSubfolders] = useState<FolderEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ViewFilter>({ ...defaultFilter, sort: 'name' });
  const items = useLibrary((s) => s.folderItems);
  const meta = useLibrary((s) => s.meta);
  const selection = useLibrary((s) => s.selection);
  const selecting = useLibrary((s) => s.selecting);
  const { setFolderItems, setSequence, toggleSelect, setSelecting } = useLibrary.getState();

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
  return (
    <View style={common.screen}>
      <BrowserHeader
        title={title}
        subtitle={t('folders.items', { count: visible.length })}
        left={<IconButton icon="chevron-back" size={26} onPress={() => router.back()} />}
        right={<IconButton icon={selecting ? 'close' : 'checkmark-circle-outline'} onPress={() => setSelecting(!selecting)} />}
      />
      {error ? (
        <View style={[common.center, { flex: 1, padding: space.xl }]}>
          <Text style={[common.text, { textAlign: 'center', marginBottom: space.lg }]}>{error}</Text>
          <Button label={t('common.retry')} onPress={() => router.back()} />
        </View>
      ) : (
        <PhotoGrid
          items={visible}
          meta={meta}
          selection={selection}
          selecting={selecting}
          onPress={open}
          onLongPress={(it) => toggleSelect(it.key)}
          header={
            <View>
              {subfolders.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subs}>
                  {subfolders.map((f) => (
                    <Pressable
                      key={f.uri}
                      style={styles.sub}
                      onPress={() => router.push({ pathname: '/folder/[id]', params: { id, path: f.uri, name: f.name } })}
                    >
                      <Ionicons name="folder" size={16} color={colors.accent} />
                      <Text style={styles.subText} numberOfLines={1}>
                        {f.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}
              <FilterBar value={filter} onChange={setFilter} />
            </View>
          }
          empty={<Text style={styles.empty}>{t('library.empty')}</Text>}
        />
      )}
      <SelectionBar items={visible} />
    </View>
  );
}

const styles = StyleSheet.create({
  subs: { gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.xs },
  sub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    maxWidth: 200,
  },
  subText: { color: colors.text, fontSize: font.sm },
  empty: { color: colors.textDim, textAlign: 'center', marginTop: 80 },
});
