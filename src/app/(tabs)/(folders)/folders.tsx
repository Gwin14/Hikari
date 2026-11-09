import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionSheetIOS, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { deleteRow, type FolderRow } from '@/core/db/db';
import { addFolderInteractive, listFolders } from '@/core/sources/folders';
import { Icon, useToolbarIcon } from '@/ui/Icon';
import { Button, EmptyState } from '@/ui/kit';
import { curve, radius, space, type, useStyles, useTheme, type Palette } from '@/ui/theme';

export default function FoldersScreen() {
  const { t } = useTranslation();
  const c = useTheme();
  const s = useStyles(makeStyles);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const refresh = useCallback(() => setFolders(listFolders()), []);
  useFocusEffect(refresh);
  const addIcon = useToolbarIcon('add', c.accentInk);

  const add = async () => {
    try {
      const row = await addFolderInteractive();
      refresh();
      if (row) router.push({ pathname: '/folder/[id]', params: { id: row.id } });
    } catch (e) {
      Alert.alert(t('common.error'), e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (f: FolderRow) => {
    const confirm = () => {
      deleteRow('folders', f.id);
      refresh();
    };
    if (process.env.EXPO_OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: f.name, message: t('folders.removeHint'), options: [t('folders.remove'), t('common.cancel')], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
        (i) => i === 0 && confirm(),
      );
    } else {
      Alert.alert(f.name, t('folders.removeHint'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('folders.remove'), style: 'destructive', onPress: confirm },
      ]);
    }
  };

  return (
    <>
      <Stack.Title>{t('folders.title')}</Stack.Title>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={addIcon} accessibilityLabel={t('folders.add')} onPress={add} />
      </Stack.Toolbar>
      <FlatList
        data={folders}
        keyExtractor={(f) => f.id}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: c.bg }}
        contentContainerStyle={s.content}
        ListHeaderComponent={folders.length ? <Text style={s.caption}>{t('folders.caption')}</Text> : undefined}
        ListFooterComponent={folders.length ? <Text style={s.footer}>{t('folders.footer')}</Text> : undefined}
        ListEmptyComponent={
          <EmptyState
            icon="folderOpen"
            title={t('folders.emptyTitle')}
            body={t('folders.emptyBody')}
            action={<Button primary icon="add" label={t('folders.add')} onPress={add} />}
            style={s.empty}
          />
        }
        renderItem={({ item, index }) => {
          const first = index === 0;
          const last = index === folders.length - 1;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityHint={t('folders.removeHint')}
              onPress={() => router.push({ pathname: '/folder/[id]', params: { id: item.id } })}
              onLongPress={() => remove(item)}
              style={({ pressed }) => [s.row, first && s.first, last && s.last, pressed && { backgroundColor: c.surface2 }]}
            >
              <View style={s.tile}>
                <Icon name="foldersFill" size={22} color={c.accentInk} />
              </View>
              <View style={[s.text, !last && s.divider]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={s.uri} numberOfLines={1} ellipsizeMode="middle">
                    {readablePath(item.uri)}
                  </Text>
                </View>
                <Icon name="chevron" size={14} color={c.textFaint} weight="semibold" />
              </View>
            </Pressable>
          );
        }}
      />
    </>
  );
}

/** A provider URI shown the way people know the place (".../DCIM/100CANON"), not as an encoded tree id. */
function readablePath(uri: string) {
  const decoded = decodeURIComponent(uri);
  const tree = decoded.split(/tree\/|document\//).pop() ?? decoded;
  return tree.replace(/^primary:/, '').replace(/^file:\/\//, '');
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: space.lg, flexGrow: 1 },
    caption: { color: c.textDim, ...type.footnote, textTransform: 'uppercase', paddingHorizontal: space.lg, paddingBottom: space.sm - 2 },
    footer: { color: c.textDim, ...type.footnote, paddingHorizontal: space.lg, paddingTop: space.sm },
    empty: { marginTop: 120 },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.lg, backgroundColor: c.surface },
    first: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, ...curve },
    last: { borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card, ...curve },
    tile: { width: 40, height: 40, borderRadius: radius.tile, ...curve, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' },
    text: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md, paddingRight: space.lg, minHeight: 64 },
    divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator },
    name: { color: c.text, ...type.headline },
    uri: { color: c.textDim, ...type.footnote, marginTop: 2 },
  });
