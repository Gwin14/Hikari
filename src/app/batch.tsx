import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { editFor, refreshThumb, savePhotoEdit } from '@/core/export/exporter';
import { applySettings } from '@/core/recipe/ops';
import { listPresets } from '@/core/recipe/presetStore';
import type { RecipeSettings } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { findItems, useLibrary } from '@/state/library';
import { Button, EmptyState, Group, ListRow, notifySuccess, ProgressBar } from '@/ui/kit';
import { space, tabular, type, useStyles, useTheme, type Palette } from '@/ui/theme';

/** Apply copied edits or a preset to many photos at once (saved with each photo). */
export default function BatchScreen() {
  const { t } = useTranslation();
  const c = useTheme();
  const s = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { keys } = useLocalSearchParams<{ keys: string }>();
  const items = useMemo(() => findItems((keys ?? '').split('\n').filter(Boolean)), [keys]);
  const clipboard = useEditor((st) => st.clipboard);
  const presets = useMemo(() => listPresets(), []);
  const groups = useMemo(() => {
    const m = new Map<string, typeof presets>();
    for (const p of presets) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [presets]);
  const [choice, setChoice] = useState<{ id: string; name: string; settings: Partial<RecipeSettings> } | null>(
    clipboard ? { id: 'clipboard', name: t('editor.paste'), settings: clipboard.settings } : null,
  );
  const [done, setDone] = useState<number | null>(null);
  const [finished, setFinished] = useState<string[] | null>(null);
  usePreventRemove(done !== null && !finished, () => {});

  const run = async () => {
    if (!choice) return;
    setDone(0);
    const failed: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const edit = await editFor(it);
        const next = applySettings(edit.recipe, choice.settings);
        await savePhotoEdit(it, next, edit.versions);
        await refreshThumb(it, next).catch(() => {}); // thumbnail is best effort
      } catch (e) {
        failed.push(`${it.filename}: ${e instanceof Error ? e.message : String(e)}`);
      }
      setDone(i + 1);
    }
    useLibrary.getState().refreshMeta(items.map((i) => i.key));
    useLibrary.getState().clearSelection();
    setFinished(failed);
  };

  useEffect(() => {
    if (!finished) return;
    if (finished.length) Alert.alert(t('common.error'), finished.join('\n'));
    else notifySuccess();
    router.back();
  }, [finished, t]);

  const title = t('batch.title', { count: items.length });

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Title>{title}</Stack.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()} disabled={done !== null}>
          {t('common.cancel')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {done !== null ? (
        <View style={s.progress}>
          <Text style={s.progressCount}>{t('batch.applying', { done, total: items.length })}</Text>
          <ProgressBar value={items.length ? done / items.length : 0} />
        </View>
      ) : !clipboard && presets.length === 0 ? (
        <View style={s.progress}>
          <EmptyState icon="paste" title={t('batch.emptyTitle')} body={t('batch.emptyBody')} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 112 }]}>
          <Text style={s.lead}>{t('batch.lead')}</Text>
          {clipboard && (
            <Group title={t('editor.paste')}>
              <ListRow
                icon="paste"
                label={t('batch.copiedEdits')}
                hint={clipboard.sections.map((sec) => t(`sections.${sec}`)).join(', ')}
                selected={choice?.id === 'clipboard'}
                onPress={() => setChoice({ id: 'clipboard', name: t('editor.paste'), settings: clipboard.settings })}
              />
            </Group>
          )}
          {groups.map(([group, list]) => (
            <Group key={group} title={group === 'mine' ? t('presets.mine') : group}>
              {list.map((p) => (
                <ListRow key={p.id} label={p.name} selected={choice?.id === p.id} onPress={() => setChoice({ id: p.id, name: p.name, settings: p.settings })} />
              ))}
            </Group>
          ))}
        </ScrollView>
      )}
      {done === null && (
        <View style={[s.footer, { paddingBottom: insets.bottom + space.md }]}>
          <Button primary label={choice ? t('batch.apply', { name: choice.name }) : t('common.apply')} disabled={!choice || !items.length} onPress={run} />
        </View>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: space.lg, gap: space.xxl },
    lead: { color: c.textDim, ...type.subhead, paddingHorizontal: space.xs },
    progress: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xxxl * 1.5, gap: space.md },
    progressCount: { color: c.text, ...type.headline, textAlign: 'center', ...tabular },
    footer: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      backgroundColor: c.bg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.separator,
    },
  });
