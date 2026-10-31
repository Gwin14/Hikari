import { readMetadata, isNativeAvailable, revertLibraryEdit, type PhotoMetadata } from 'hikari-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as db from '@/core/db/db';
import { decodeTarget } from '@/core/image/load';
import type { RecipeSection } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { useLibrary } from '@/state/library';
import { Button, ListRow, SectionTitle, ToggleRow } from '../kit';
import { colors, font, radius, space } from '../theme';
import { SectionPicker } from './panels/PresetsPanel';

type Sheet = 'menu' | 'copy' | 'info' | null;

const COPY_DEFAULT: RecipeSection[] = ['profile', 'light', 'color', 'curves', 'hsl', 'grading', 'detail', 'lens', 'effects', 'lut'];

/** "More" menu: copy/paste, versions, rating, info, reset/revert. */
export function EditorMenu(props: { sheet: Sheet; onSheet(s: Sheet): void; histogram: boolean; onHistogram(v: boolean): void }) {
  const { sheet, onSheet } = props;
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const item = useEditor((s) => s.item);
  const recipe = useEditor((s) => s.recipe);
  const clipboard = useEditor((s) => s.clipboard);
  const meta = useLibrary((s) => (item ? s.meta.get(item.key) : undefined));
  const [sections, setSections] = useState<RecipeSection[]>(COPY_DEFAULT);
  const [info, setInfo] = useState<PhotoMetadata | null>(null);
  const { copy, paste, resetAll, setTool } = useEditor.getState();
  const { setMeta } = useLibrary.getState();

  useEffect(() => {
    if (sheet === 'info' && recipe && isNativeAvailable) {
      const target = decodeTarget(recipe.source);
      readMetadata(target.uri).then(setInfo).catch(() => setInfo(null));
    }
  }, [sheet, recipe]);

  if (!item || !recipe) return null;
  const close = () => onSheet(null);

  const revert = () =>
    Alert.alert(t('editor.revertOriginal'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('editor.revertOriginal'),
        style: 'destructive',
        onPress: async () => {
          resetAll();
          db.clearEdit(item.key);
          if (item.kind === 'library' && Platform.OS === 'ios' && isNativeAvailable) {
            try {
              await revertLibraryEdit(item.id);
            } catch {
              // the asset may have no Hikari edit in Photos
            }
          }
          close();
        },
      },
    ]);

  return (
    <Modal visible={sheet !== null} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
        {sheet === 'menu' && (
          <ScrollView>
            <View style={styles.rating}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} onPress={() => setMeta(item, { rating: meta?.rating === n ? 0 : n })} hitSlop={6}>
                  <Text style={[styles.star, (meta?.rating ?? 0) >= n && { color: colors.accent }]}>★</Text>
                </Pressable>
              ))}
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => setMeta(item, { flag: meta?.flag === 1 ? 0 : 1 })} style={[styles.flag, meta?.flag === 1 && styles.flagOn]}>
                <Text style={styles.flagText}>{t('culling.pick')}</Text>
              </Pressable>
              <Pressable onPress={() => setMeta(item, { flag: meta?.flag === -1 ? 0 : -1 })} style={[styles.flag, meta?.flag === -1 && styles.flagOn]}>
                <Text style={styles.flagText}>{t('culling.reject')}</Text>
              </Pressable>
            </View>
            <View style={styles.labels}>
              {(['red', 'yellow', 'green', 'blue', 'purple'] as const).map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setMeta(item, { label: meta?.label === c ? null : c })}
                  style={[styles.labelDot, { backgroundColor: LABELS[c] }, meta?.label === c && styles.labelOn]}
                />
              ))}
            </View>
            <ListRow icon="copy-outline" label={t('editor.copy')} onPress={() => onSheet('copy')} />
            <ListRow
              icon="clipboard-outline"
              label={t('editor.paste')}
              onPress={
                clipboard
                  ? () => {
                      paste();
                      close();
                    }
                  : undefined
              }
            />
            <ListRow
              icon="git-branch-outline"
              label={t('tools.versions')}
              onPress={() => {
                setTool('versions');
                close();
              }}
            />
            <ListRow icon="information-circle-outline" label={t('editor.info')} onPress={() => onSheet('info')} />
            <ToggleRow icon="bar-chart-outline" label={t('editor.histogram')} value={props.histogram} onChange={props.onHistogram} />
            <ListRow
              icon="refresh-outline"
              label={t('editor.resetAll')}
              onPress={() => {
                resetAll();
                close();
              }}
            />
            <ListRow icon="arrow-undo-outline" label={t('editor.revertOriginal')} destructive onPress={revert} />
          </ScrollView>
        )}
        {sheet === 'copy' && (
          <View style={{ padding: space.lg, gap: space.md }}>
            <Text style={styles.title}>{t('editor.copy')}</Text>
            <SectionPicker value={sections} onChange={setSections} />
            <Button
              primary
              label={t('editor.copy')}
              onPress={() => {
                copy(sections);
                close();
              }}
            />
          </View>
        )}
        {sheet === 'info' && (
          <ScrollView style={{ maxHeight: 480 }}>
            <SectionTitle title={t('editor.info')} />
            <InfoRow label={t('info.file')} value={recipe.source.filename} />
            {info && (
              <>
                <InfoRow label={t('info.camera')} value={[info.make, info.model].filter(Boolean).join(' ')} />
                <InfoRow label={t('info.lens')} value={info.lens} />
                <InfoRow
                  label={t('info.exposure')}
                  value={[
                    info.exposureTime ? (info.exposureTime < 1 ? `1/${Math.round(1 / info.exposureTime)}s` : `${info.exposureTime}s`) : null,
                    info.fNumber ? `ƒ/${info.fNumber}` : null,
                    info.iso ? `ISO ${info.iso}` : null,
                    info.focalLength ? `${Math.round(info.focalLength)}mm` : null,
                    info.exposureBias ? `${info.exposureBias > 0 ? '+' : ''}${info.exposureBias.toFixed(1)} EV` : null,
                  ]
                    .filter(Boolean)
                    .join('  ·  ')}
                />
                <InfoRow label={t('info.dimensions')} value={`${info.width} × ${info.height} · ${((info.width * info.height) / 1e6).toFixed(1)} MP`} />
                <InfoRow label={t('info.date')} value={info.dateTaken} />
                <InfoRow label={t('info.profile')} value={[info.colorProfile, info.isRaw ? (info.isProRaw ? 'ProRAW' : 'RAW') : null].filter(Boolean).join(' · ')} />
                {info.latitude != null && <InfoRow label={t('info.location')} value={`${info.latitude.toFixed(5)}, ${info.longitude?.toFixed(5)}`} />}
              </>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const LABELS = { red: '#FF5A5F', yellow: '#FFD23F', green: '#4CD07D', blue: '#4D9BFF', purple: '#B57BFF' } as const;

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: space.sm, maxHeight: '75%' },
  title: { color: colors.text, fontSize: font.lg, fontWeight: '700' },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.lg, paddingVertical: space.md },
  star: { color: colors.surface3, fontSize: 28 },
  flag: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surface2 },
  flagOn: { backgroundColor: colors.accent },
  flagText: { color: colors.text, fontSize: font.sm, fontWeight: '600' },
  labels: { flexDirection: 'row', gap: 14, paddingHorizontal: space.lg, paddingBottom: space.md },
  labelDot: { width: 24, height: 24, borderRadius: 12, opacity: 0.6 },
  labelOn: { opacity: 1, borderWidth: 2, borderColor: colors.text },
  infoRow: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  infoLabel: { color: colors.textFaint, fontSize: font.xs, textTransform: 'uppercase', letterSpacing: 0.6 },
  infoValue: { color: colors.text, fontSize: font.md, marginTop: 2 },
});
