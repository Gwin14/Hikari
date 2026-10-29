import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as db from '@/core/db/db';
import { recipeFor, refreshThumb } from '@/core/export/exporter';
import { applySettings, isEdited, recipeHash } from '@/core/recipe/ops';
import { listPresets } from '@/core/recipe/presetStore';
import type { RecipeSettings } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { findItems, useLibrary } from '@/state/library';
import { Button, Chip, ChipRow, IconButton, notifySuccess, ProgressBar, SectionTitle } from '@/ui/kit';
import { colors, common, font, space } from '@/ui/theme';

/** Apply copied edits or a preset to many photos at once (non-destructive, catalog only). */
export default function BatchScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { keys } = useLocalSearchParams<{ keys: string }>();
  const items = useMemo(() => findItems((keys ?? '').split('\n').filter(Boolean)), [keys]);
  const clipboard = useEditor((s) => s.clipboard);
  const presets = useMemo(() => listPresets(), []);
  const [choice, setChoice] = useState<{ name: string; settings: Partial<RecipeSettings> } | null>(
    clipboard ? { name: t('editor.paste'), settings: clipboard.settings } : null,
  );
  const [done, setDone] = useState<number | null>(null);

  const run = async () => {
    if (!choice) return;
    setDone(0);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const next = applySettings(recipeFor(it), choice.settings);
      db.saveRecipe(it.key, next, isEdited(next), recipeHash(next), it.folderId);
      try {
        await refreshThumb(it, next);
      } catch {
        // thumbnail is best effort
      }
      setDone(i + 1);
    }
    useLibrary.getState().refreshMeta(items.map((i) => i.key));
    useLibrary.getState().clearSelection();
    notifySuccess();
    router.back();
  };

  return (
    <View style={[common.screen, { paddingTop: space.md }]}>
      <View style={styles.header}>
        <IconButton icon="close" onPress={() => router.back()} label={t('common.close')} style={styles.side} />
        <Text style={styles.title}>{t('common.selected', { count: items.length })}</Text>
        <View style={styles.side} />
      </View>
      {done !== null ? (
        <View style={[common.center, styles.progress]}>
          <Text style={[common.text, styles.progressText]}>
            {done}/{items.length}
          </Text>
          <ProgressBar value={items.length ? done / items.length : 0} />
        </View>
      ) : (
        <ScrollView>
          {clipboard && (
            <>
              <SectionTitle title={t('editor.paste')} />
              <ChipRow>
                <Chip
                  icon="clipboard"
                  label={clipboard.sections.map((s) => t(`sections.${s}`)).join(', ')}
                  active={choice?.settings === clipboard.settings}
                  onPress={() => setChoice({ name: t('editor.paste'), settings: clipboard.settings })}
                />
              </ChipRow>
            </>
          )}
          <SectionTitle title={t('presets.title')} />
          <View style={styles.wrap}>
            {presets.map((p) => (
              <Chip key={p.id} label={p.name} active={choice?.settings === p.settings} onPress={() => setChoice({ name: p.name, settings: p.settings })} />
            ))}
          </View>
        </ScrollView>
      )}
      <View style={{ padding: space.lg, paddingBottom: insets.bottom + space.md }}>
        <Button primary label={choice ? `${t('common.apply')} · ${choice.name}` : t('common.apply')} disabled={!choice || done !== null} onPress={run} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm },
  side: { width: 44 },
  progress: { flex: 1, paddingHorizontal: space.xl * 2, gap: space.md },
  progressText: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  title: { flex: 1, textAlign: 'center', color: colors.text, fontSize: font.lg, fontWeight: '700' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg },
});
