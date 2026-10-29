import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { deleteRow, type FolderRow } from '@/core/db/db';
import { addFolderInteractive, listFolders } from '@/core/sources/folders';
import { BrowserHeader } from '@/ui/BrowserChrome';
import { Button, IconButton } from '@/ui/kit';
import { colors, common, font, radius, space } from '@/ui/theme';

export default function FoldersScreen() {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const refresh = useCallback(() => setFolders(listFolders()), []);
  useFocusEffect(refresh);

  const add = async () => {
    try {
      const row = await addFolderInteractive();
      refresh();
      if (row) router.push({ pathname: '/folder/[id]', params: { id: row.id } });
    } catch (e) {
      Alert.alert(t('common.error'), e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (f: FolderRow) =>
    Alert.alert(f.name, undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('folders.remove'),
        style: 'destructive',
        onPress: () => {
          deleteRow('folders', f.id);
          refresh();
        },
      },
    ]);

  return (
    <View style={common.screen}>
      <BrowserHeader title={t('folders.title')} right={<IconButton icon="add-circle" size={28} onPress={add} label={t('folders.add')} />} />
      <FlatList
        data={folders}
        keyExtractor={(f) => f.id}
        contentContainerStyle={{ padding: space.lg, gap: space.sm, flexGrow: 1, paddingBottom: 120 }}
        ListEmptyComponent={
          <View style={[common.center, { flex: 1, paddingHorizontal: space.xl }]}>
            <Ionicons name="folder-open-outline" size={56} color={colors.textFaint} />
            <Text style={[common.title, { marginTop: space.lg, textAlign: 'center' }]}>{t('folders.emptyTitle')}</Text>
            <Text style={styles.body}>{t('folders.emptyBody')}</Text>
            <Button primary icon="add" label={t('folders.add')} onPress={add} />
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.folder, pressed && { opacity: 0.7 }]}
            onPress={() => router.push({ pathname: '/folder/[id]', params: { id: item.id } })}
            onLongPress={() => remove(item)}
          >
            <View style={styles.folderIcon}>
              <Ionicons name="folder" size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.uri} numberOfLines={1}>
                {decodeURIComponent(item.uri)}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.textDim, fontSize: font.md, textAlign: 'center', marginVertical: space.lg, lineHeight: 21 },
  folder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  folderIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { color: colors.text, fontSize: font.md, fontWeight: '600' },
  uri: { color: colors.textFaint, fontSize: font.xs, marginTop: 2 },
});
