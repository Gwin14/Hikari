import { addListener, presentPermissionsPicker, usePermissions } from 'expo-media-library';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';

import { listAlbums, pairLibraryItems, type AlbumInfo } from '@/core/sources/library';
import type { PhotoItem } from '@/core/sources/types';
import { applyFilter, defaultFilter, useLibrary, type ViewFilter } from '@/state/library';
import { BrowserToolbar, FilterBar, Notice, SelectionToolbar, useSelectionMode } from '@/ui/BrowserChrome';
import { useToolbarIcon } from '@/ui/Icon';
import { Button, EmptyState } from '@/ui/kit';
import { GridFooter, PhotoGrid } from '@/ui/PhotoGrid';
import { space, useTheme } from '@/ui/theme';

export default function LibraryScreen() {
  const { t } = useTranslation();
  const c = useTheme();
  const [permission, requestPermission] = usePermissions({ granularPermissions: ['photo'] });
  const [filter, setFilter] = useState<ViewFilter>(defaultFilter);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const albumId = useLibrary((s) => s.albumId);
  const raw = useLibrary((s) => s.libraryRaw);
  const meta = useLibrary((s) => s.meta);
  const selection = useLibrary((s) => s.selection);
  const selecting = useLibrary((s) => s.selecting);
  const loading = useLibrary((s) => s.libraryLoading);
  const done = useLibrary((s) => s.libraryDone);
  const { loadLibrary, refreshLibrary, setSequence, toggleSelect } = useLibrary.getState();
  const albumsIcon = useToolbarIcon('albums', c.text);
  useSelectionMode();

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
  const albumTitle = albumId ? (albums.find((a) => a.id === albumId)?.title ?? t('library.albums')) : t('library.title');

  const open = (item: PhotoItem) => {
    if (selecting) return toggleSelect(item.key);
    setSequence(items);
    router.push({ pathname: '/editor/[key]', params: { key: item.key } });
  };

  // while the permission check resolves, the cached snapshot already fills the grid
  if (permission && !granted) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.centered} style={{ backgroundColor: c.bg }}>
        <Stack.Title>{t('library.title')}</Stack.Title>
        <EmptyState
          icon="photos"
          title={t('library.permissionTitle')}
          body={t('library.permissionBody')}
          action={<Button primary label={t('library.permissionButton')} onPress={requestPermission} />}
        />
      </ScrollView>
    );
  }

  // the grid is the screen's first view so the large title collapses with it
  return (
    <>
      <PhotoGrid
        items={items}
        meta={meta}
        selection={selection}
        selecting={selecting}
        onPress={open}
        onLongPress={(it) => toggleSelect(it.key)}
        onEndReached={() => loadLibrary(albumId, sort)}
        header={
          <View>
            {permission?.accessPrivileges === 'limited' && <Notice label={t('library.limited')} onPress={() => presentPermissionsPicker()} />}
            <FilterBar value={filter} onChange={setFilter} />
          </View>
        }
        footer={done || !loading ? <GridFooter label={t('folders.items', { count: items.length })} /> : null}
        loading={loading || !permission}
        empty={<EmptyState icon="photo" title={t('library.empty')} body={t('library.emptyBody')} style={styles.empty} />}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={albumsIcon}
          accessibilityLabel={t('library.albums')}
          hidden={selecting}
          onPress={() => router.push({ pathname: '/albums', params: { sort } })}
        />
      </Stack.Toolbar>
      <BrowserToolbar title={albumTitle} filter={filter} onFilter={setFilter} items={items} sorts={['newest', 'oldest', 'name']} />
      <SelectionToolbar items={items} />
    </>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: 96 },
  centered: { flexGrow: 1, justifyContent: 'center', paddingVertical: space.xxxl },
});
