import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { listAlbums, type AlbumInfo } from '@/core/sources/library';
import { useLibrary } from '@/state/library';
import { Group, ListRow } from '@/ui/kit';
import { space, type, useStyles, useTheme, type Palette } from '@/ui/theme';

/** Album picker, presented as a native form sheet over the Library. */
export default function AlbumsSheet() {
  const { t } = useTranslation();
  const c = useTheme();
  const s = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { sort } = useLocalSearchParams<{ sort?: 'newest' | 'oldest' }>();
  const current = useLibrary((st) => st.albumId);
  const [albums, setAlbums] = useState<AlbumInfo[] | null>(null);

  useEffect(() => {
    listAlbums()
      .then(setAlbums)
      .catch(() => setAlbums([]));
  }, []);

  const pick = (id: string | null) => {
    if (id !== current) useLibrary.getState().loadLibrary(id, sort ?? 'newest', true);
    router.back();
  };

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.content, { paddingBottom: insets.bottom + space.lg }]}>
      <Text style={s.title} accessibilityRole="header">
        {t('library.albums')}
      </Text>
      <Group>
        <ListRow icon="library" label={t('library.allPhotos')} selected={!current} onPress={() => pick(null)} />
      </Group>
      {albums === null ? (
        <View style={s.loading}>
          <ActivityIndicator color={c.textDim} />
        </View>
      ) : albums.length ? (
        <Group title={t('library.myAlbums')}>
          {albums.map((a) => (
            <ListRow key={a.id} icon="albums" label={a.title} selected={current === a.id} onPress={() => pick(a.id)} />
          ))}
        </Group>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: space.lg, paddingTop: space.xxl, gap: space.xl },
    title: { color: c.text, ...type.title2, paddingHorizontal: space.xs },
    loading: { paddingVertical: space.xxl },
  });
