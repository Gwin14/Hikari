import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { deletePreset, listPresets, presetFromFile, presetToFile, savePreset } from '@/core/recipe/presetStore';
import type { Preset } from '@/core/recipe/presets';
import { RECIPE_SECTIONS, type Recipe, type RecipeSection } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { Button, Chip, ChipRow, SectionTitle } from '../../kit';
import { Slider } from '../../Slider';
import { colors, font, radius, space } from '../../theme';

export function PresetsPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const presets = useMemo(() => listPresets(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selected, setSelected] = useState<Preset | null>(null);
  const [amount, setAmount] = useState(100);
  const [saving, setSaving] = useState(false);
  // Recipe before the first preset was tried, so switching presets doesn't stack them.
  const base = useRef<Recipe | null>(null);
  const { applyPreset } = useEditor.getState();

  const groups = useMemo(() => {
    const m = new Map<string, Preset[]>();
    for (const p of presets) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [presets]);

  const apply = (p: Preset, a: number) => {
    if (!base.current) base.current = recipe;
    applyPreset(p.settings, a / 100, base.current);
  };

  const importPreset = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      presetFromFile(await new File(res.assets[0].uri).text());
      setVersion((v) => v + 1);
    } catch (e) {
      Alert.alert(t('common.error'), e instanceof Error ? e.message : String(e));
    }
  };

  const share = async (p: Preset) => {
    const f = new File(Paths.cache, `${p.name.replace(/[^\w-]+/g, '_')}.hikari`);
    f.write(presetToFile(p));
    await Sharing.shareAsync(f.uri, { mimeType: 'application/json', dialogTitle: p.name });
  };

  const manage = (p: Preset) => {
    if (p.builtIn) return share(p);
    Alert.alert(p.name, undefined, [
      { text: t('presets.exportPreset'), onPress: () => share(p) },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deletePreset(p.id);
          setVersion((v) => v + 1);
        },
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  };

  return (
    <>
      <ChipRow>
        <Chip icon="add" label={t('presets.create')} onPress={() => setSaving(true)} />
        <Chip icon="download-outline" label={t('presets.import')} onPress={importPreset} />
      </ChipRow>
      {selected && (
        <Slider
          label={`${selected.name} · ${t('presets.amount')}`}
          min={0}
          max={150}
          neutral={100}
          value={amount}
          onCommit={(v) => {
            setAmount(v);
            apply(selected, v);
          }}
        />
      )}
      {groups.map(([group, list]) => (
        <View key={group}>
          <SectionTitle title={group === 'mine' ? t('presets.mine') : group} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {list.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => {
                  setSelected(p);
                  setAmount(100);
                  apply(p, 100);
                }}
                onLongPress={() => manage(p)}
                style={[styles.preset, selected?.id === p.id && styles.presetOn]}
              >
                <Text style={styles.presetText} numberOfLines={2}>
                  {p.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ))}
      <SavePresetModal
        visible={saving}
        onClose={() => setSaving(false)}
        onSave={(name, sections) => {
          savePreset(name, recipe, sections);
          setSaving(false);
          setVersion((v) => v + 1);
        }}
      />
    </>
  );
}

export function SectionPicker({ value, onChange }: { value: RecipeSection[]; onChange(v: RecipeSection[]): void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.sections}>
      {RECIPE_SECTIONS.map((s) => (
        <Chip
          key={s}
          label={t(`sections.${s}`)}
          active={value.includes(s)}
          onPress={() => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s])}
        />
      ))}
    </View>
  );
}

const DEFAULT_SECTIONS: RecipeSection[] = ['profile', 'light', 'color', 'curves', 'hsl', 'grading', 'detail', 'effects', 'lut'];

function SavePresetModal(p: { visible: boolean; onClose(): void; onSave(name: string, sections: RecipeSection[]): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [sections, setSections] = useState<RecipeSection[]>(DEFAULT_SECTIONS);
  return (
    <Modal visible={p.visible} transparent animationType="fade" onRequestClose={p.onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.title}>{t('presets.createFromCurrent')}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('common.name')}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoFocus
          />
          <Text style={styles.caption}>{t('presets.sections')}</Text>
          <SectionPicker value={sections} onChange={setSections} />
          <View style={styles.buttons}>
            <Button label={t('common.cancel')} onPress={p.onClose} style={{ flex: 1 }} />
            <Button primary label={t('common.save')} disabled={!name.trim()} onPress={() => p.onSave(name.trim(), sections)} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.xs },
  preset: {
    width: 92,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    padding: space.sm,
    justifyContent: 'flex-end',
  },
  presetOn: { borderWidth: 1.5, borderColor: colors.accent },
  presetText: { color: colors.text, fontSize: font.xs, fontWeight: '600' },
  sections: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: space.xl },
  dialog: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  title: { color: colors.text, fontSize: font.lg, fontWeight: '700' },
  input: { backgroundColor: colors.surface2, color: colors.text, borderRadius: radius.md, padding: space.md, fontSize: font.md },
  caption: { color: colors.textDim, fontSize: font.sm },
  buttons: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
});
