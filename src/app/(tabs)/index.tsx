import { addListener, presentPermissionsPicker, usePermissions } from 'expo-media-library';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { listAlbums, pairLibraryItems, type AlbumInfo } from '@/core/sources/library';
import type { PhotoItem } from '@/core/sources/types';
import { applyFilter, defaultFilter, useLibrary, type ViewFilter } from '@/state/library';
import { BrowserHeader, FilterBar, SelectionBar } from '@/ui/BrowserChrome';
import { Button, EmptyState, IconButton } from '@/ui/kit';
import { PhotoGrid } from '@/ui/PhotoGrid';
import { colors, common, curve, font, radius, space } from '@/ui/theme';

export default function LibraryScreen() {
  const { t } = useTranslation();
  const [permission, requestPermission] = usePermissions({ granularPermissions: ['photo'] });
  const [filter, setFilter] = useState<ViewFilter>(defaultFilter);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
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
      <View style={[common.screen, common.center]}>
        <EmptyState
          icon="images-outline"
          title={t('library.permissionTitle')}
          body={t('library.permissionBody')}
          action={<Button primary label={t('library.permissionButton')} onPress={requestPermission} />}
        />
      </View>
    );
  }

  return (
    <View style={common.screen}>
      <BrowserHeader
        title={albumTitle}
        subtitle={t('folders.items', { count: items.length })}
        onTitlePress={() => router.push({ pathname: '/albums', params: { sort } })}
        right={
          <IconButton
            icon={selecting ? 'close' : 'checkmark-circle-outline'}
            onPress={() => setSelecting(!selecting)}
            label={selecting ? t('common.cancel') : t('common.select')}
          />
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
        empty={<EmptyState icon="images-outline" title={t('library.empty')} body={t('library.emptyBody')} style={styles.empty} />}
      />
      <SelectionBar items={items} />
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: 96 },
  limited: { marginHorizontal: space.lg, marginBottom: space.sm, padding: space.md, borderRadius: radius.md, ...curve, backgroundColor: colors.accentSoft },
  limitedText: { color: colors.accent, fontSize: font.sm, fontWeight: '600', textAlign: 'center' },
});
