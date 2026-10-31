import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { listAlbums, type AlbumInfo } from '@/core/sources/library';
import { useLibrary } from '@/state/library';
import { ListRow } from '@/ui/kit';
import { colors, font, space } from '@/ui/theme';

/** Album picker, presented as a native form sheet over the Library. */
export default function AlbumsSheet() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { sort } = useLocalSearchParams<{ sort?: 'newest' | 'oldest' }>();
  const current = useLibrary((s) => s.albumId);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);

  useEffect(() => {
    listAlbums().then(setAlbums).catch(() => setAlbums([]));
  }, []);

  const pick = (id: string | null) => {
    if (id !== current) useLibrary.getState().loadLibrary(id, sort ?? 'newest', true);
    router.back();
  };

  return (
    <ScrollView style={styles.sheet} contentContainerStyle={{ paddingBottom: insets.bottom + space.md }}>
      <Text style={styles.title}>{t('library.albums')}</Text>
      <ListRow icon="images-outline" label={t('library.allPhotos')} selected={!current} onPress={() => pick(null)} chevron={false} />
      {albums.map((a) => (
        <ListRow key={a.id} icon="albums-outline" label={a.title} selected={current === a.id} onPress={() => pick(a.id)} chevron={false} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.surface },
  title: { color: colors.text, fontSize: font.lg, fontWeight: '700', paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.sm },
});
