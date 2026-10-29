import { addListener, presentPermissionsPicker, usePermissions } from 'expo-media-library';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { listAlbums, pairLibraryItems, type AlbumInfo } from '@/core/sources/library';
import type { PhotoItem } from '@/core/sources/types';
import { applyFilter, defaultFilter, useLibrary, type ViewFilter } from '@/state/library';
import { BrowserHeader, FilterBar, SelectionBar } from '@/ui/BrowserChrome';
import { Button, IconButton, ListRow } from '@/ui/kit';
import { PhotoGrid } from '@/ui/PhotoGrid';
import { colors, common, font, radius, space } from '@/ui/theme';

export default function LibraryScreen() {
  const { t } = useTranslation();
  const [permission, requestPermission] = usePermissions({ granularPermissions: ['photo'] });
  const [filter, setFilter] = useState<ViewFilter>(defaultFilter);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [albumPicker, setAlbumPicker] = useState(false);
  const albumId = useLibrary((s) => s.albumId);
  const raw = useLibrary((s) => s.libraryRaw);
  const meta = useLibrary((s) => s.meta);
  const selection = useLibrary((s) => s.selection);
  const selecting = useLibrary((s) => s.selecting);
  const loading = useLibrary((s) => s.libraryLoading);
  const { loadLibrary, refreshLibrary, setSequence, toggleSelect, setSelecting } = useLibrary.getState();

  const granted = permission?.granted;
  const sort = filter.sort === 'oldest' ? 'oldest' : 'newest';

  useEffect(() => {
    if (!granted) return;
    loadLibrary(albumId, sort, true);
    listAlbums().then(setAlbums).catch(() => setAlbums([]));
    // new/deleted photos: re-list in place (debounced) instead of resetting the grid to page one
    const sub = addListener(() => refreshLibrary(sort));
    return () => sub.remove();
  }, [granted, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(
    useCallback(() => {
      const keys = useLibrary.getState().libraryRaw.map((i) => i.key);
      if (keys.length) useLibrary.getState().refreshMeta(keys);
    }, []),
  );

  const items = useMemo(() => applyFilter(pairLibraryItems(raw), meta, filter), [raw, meta, filter]);
  const albumTitle = albumId ? (albums.find((a) => a.id === albumId)?.title ?? t('library.albums')) : t('library.allPhotos');

  const open = (item: PhotoItem) => {
    if (selecting) return toggleSelect(item.key);
    setSequence(items);
    router.push({ pathname: '/editor/[key]', params: { key: item.key } });
  };

  // while the permission check resolves, the cached snapshot already fills the grid
  if (!permission && !raw.length) return <View style={common.screen} />;
  if (permission && !granted) {
    return (
      <View style={[common.screen, common.center, { padding: space.xl }]}>
        <Text style={[common.title, { textAlign: 'center' }]}>{t('library.permissionTitle')}</Text>
        <Text style={styles.body}>{t('library.permissionBody')}</Text>
        <Button primary label={t('library.permissionButton')} onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={common.screen}>
      <BrowserHeader
        title={albumTitle}
        subtitle={t('folders.items', { count: items.length })}
        onTitlePress={() => setAlbumPicker(true)}
        right={
          <IconButton icon={selecting ? 'close' : 'checkmark-circle-outline'} onPress={() => setSelecting(!selecting)} />
        }
      />
      {permission?.accessPrivileges === 'limited' && (
        <Pressable onPress={() => presentPermissionsPicker()} style={styles.limited}>
          <Text style={styles.limitedText}>{t('library.limited')}</Text>
        </Pressable>
      )}
      <PhotoGrid
        items={items}
        meta={meta}
        selection={selection}
        selecting={selecting}
        onPress={open}
        onLongPress={(it) => toggleSelect(it.key)}
        onEndReached={() => loadLibrary(albumId, sort)}
        header={<FilterBar value={filter} onChange={setFilter} />}
        loading={loading || !permission}
        empty={<Text style={styles.empty}>{t('library.empty')}</Text>}
      />
      <SelectionBar items={items} />
      <AlbumPicker
        visible={albumPicker}
        albums={albums}
        current={albumId}
        onClose={() => setAlbumPicker(false)}
        onPick={(id) => {
          setAlbumPicker(false);
          loadLibrary(id, sort, true);
        }}
      />
    </View>
  );
}

function AlbumPicker(p: {
  visible: boolean;
  albums: AlbumInfo[];
  current: string | null;
  onClose(): void;
  onPick(id: string | null): void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={p.visible} transparent animationType="slide" onRequestClose={p.onClose}>
      <Pressable style={styles.backdrop} onPress={p.onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <Text style={styles.sheetTitle}>{t('library.albums')}</Text>
        <ScrollView style={{ maxHeight: 480 }}>
          <ListRow icon="images" label={t('library.allPhotos')} onPress={() => p.onPick(null)} value={p.current ? '' : '✓'} chevron={false} />
          {p.albums.map((a) => (
            <ListRow key={a.id} icon="albums-outline" label={a.title} onPress={() => p.onPick(a.id)} value={p.current === a.id ? '✓' : ''} chevron={false} />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.textDim, fontSize: font.md, textAlign: 'center', marginVertical: space.lg, lineHeight: 21 },
  empty: { color: colors.textDim, textAlign: 'center', marginTop: 80 },
  limited: { marginHorizontal: space.lg, marginBottom: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  limitedText: { color: colors.accent, fontSize: font.sm, fontWeight: '600', textAlign: 'center' },
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.lg },
  sheetTitle: { color: colors.text, fontSize: font.lg, fontWeight: '700', paddingHorizontal: space.lg, paddingBottom: space.sm },
});
