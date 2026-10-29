import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { isEdited } from '@/core/recipe/ops';
import type { Recipe } from '@/core/recipe/schema';
import { matchingVersion, nextVersionName } from '@/core/recipe/versions';
import { useEditor } from '@/state/editor';
import { Button, Chip, ChipRow, tick } from '../../kit';
import { colors, font, radius, space } from '../../theme';

/** Named versions of the photo: save the current look, switch between looks, keep them side by side. */
export function VersionsPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const versions = useEditor((s) => s.versions);
  const { createVersion, applyVersion, updateVersion, renameVersion, deleteVersion, resetAll } = useEditor.getState();
  // null: closed; '': naming a new version; otherwise the id being renamed
  const [naming, setNaming] = useState<string | null>(null);
  const current = matchingVersion(versions, recipe);
  const editing = naming ? versions.find((v) => v.id === naming) : null;

  const manage = (id: string, name: string) =>
    Alert.alert(name, undefined, [
      { text: t('versions.update'), onPress: () => updateVersion(id) },
      { text: t('common.rename'), onPress: () => setNaming(id) },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () =>
          Alert.alert(t('versions.deleteConfirm', { name }), undefined, [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.delete'), style: 'destructive', onPress: () => deleteVersion(id) },
          ]),
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);

  return (
    <>
      <ChipRow>
        <Chip icon="add" label={t('versions.create')} onPress={() => setNaming('')} />
      </ChipRow>
      <Row
        title={t('common.original')}
        subtitle={t('versions.originalHint')}
        active={!isEdited(recipe)}
        onPress={() => {
          tick();
          resetAll();
        }}
      />
      {versions.map((v) => (
        <Row
          key={v.id}
          thumb={v.thumb}
          title={v.name}
          subtitle={new Date(v.createdAt).toLocaleString()}
          active={current?.id === v.id}
          onPress={() => {
            tick();
            applyVersion(v.id);
          }}
          onMore={() => manage(v.id, v.name)}
        />
      ))}
      {versions.length === 0 && <Text style={styles.empty}>{t('versions.empty')}</Text>}
      <NameModal
        key={naming ?? 'closed'}
        visible={naming !== null}
        title={editing ? t('common.rename') : t('versions.create')}
        initial={
          editing?.name ??
          nextVersionName(
            versions.map((v) => v.name),
            t('versions.defaultName'),
          )
        }
        onClose={() => setNaming(null)}
        onSave={(name) => {
          if (editing) renameVersion(editing.id, name);
          else createVersion(name);
          setNaming(null);
        }}
      />
    </>
  );
}

function Row(p: { thumb?: string | null; title: string; subtitle: string; active: boolean; onPress(): void; onMore?: () => void }) {
  return (
    <Pressable
      onPress={p.onPress}
      onLongPress={p.onMore}
      style={({ pressed }) => [styles.row, p.active && styles.rowOn, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.thumb}>
        {p.thumb ? (
          <Image source={{ uri: p.thumb }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <Ionicons name={p.onMore ? 'image-outline' : 'aperture-outline'} size={20} color={colors.textFaint} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={1}>
          {p.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {p.subtitle}
        </Text>
      </View>
      {p.active && <Ionicons name="checkmark-circle" size={20} color={colors.accent} />}
      {p.onMore && (
        <Pressable onPress={p.onMore} hitSlop={10} style={styles.more}>
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textDim} />
        </Pressable>
      )}
    </Pressable>
  );
}

function NameModal(p: { visible: boolean; title: string; initial: string; onClose(): void; onSave(name: string): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(p.initial);
  return (
    <Modal visible={p.visible} transparent animationType="fade" onRequestClose={p.onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>{p.title}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('common.name')}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            selectTextOnFocus
            autoFocus
            onSubmitEditing={() => name.trim() && p.onSave(name.trim())}
          />
          <View style={styles.buttons}>
            <Button label={t('common.cancel')} onPress={p.onClose} style={{ flex: 1 }} />
            <Button primary label={t('common.save')} disabled={!name.trim()} onPress={() => p.onSave(name.trim())} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginVertical: space.xs,
    padding: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  rowOn: { borderColor: colors.accent },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: font.md, fontWeight: '600' },
  subtitle: { color: colors.textFaint, fontSize: font.xs, marginTop: 2 },
  more: { padding: space.xs },
  empty: { color: colors.textDim, fontSize: font.sm, textAlign: 'center', padding: space.lg },
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: space.xl },
  dialog: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  dialogTitle: { color: colors.text, fontSize: font.lg, fontWeight: '700' },
  input: { backgroundColor: colors.surface2, color: colors.text, borderRadius: radius.md, padding: space.md, fontSize: font.md },
  buttons: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
});
