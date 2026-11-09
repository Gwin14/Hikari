import { readMetadata, isNativeAvailable, revertLibraryEdit, type PhotoMetadata } from 'hikari-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, SlideInDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as db from '@/core/db/db';
import { decodeTarget } from '@/core/image/load';
import type { RecipeSection } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { useLibrary } from '@/state/library';

import { Icon } from '../Icon';
import { Button, Chip, EASE_OUT, Grabber, Group, ListRow, notifySuccess, tick, ToggleRow } from '../kit';
import { LABEL_COLORS } from '../PhotoGrid';
import { colors, floating, radius, space, tabular, type } from '../theme';
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
  const reduceMotion = useReducedMotion();

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
          if (item.kind === 'library' && Platform.OS === 'ios' && isNativeAvailable) {
            db.clearEdit(item.key);
            try {
              await revertLibraryEdit(item.id);
              useEditor.getState().markReverted();
            } catch {
              // the asset may have no Hikari edit in Photos
            }
          }
          close();
        },
      },
    ]);

  return (
    <Modal visible={sheet !== null} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel={t('common.close')} />
      <Animated.View
        entering={reduceMotion ? FadeIn.duration(150) : SlideInDown.duration(280).easing(EASE_OUT)}
        style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}
      >
        <Grabber />
        {sheet === 'menu' && (
          <ScrollView contentContainerStyle={styles.menu} bounces={false}>
            <View style={styles.culling}>
              <View style={styles.rating} accessibilityRole="adjustable" accessibilityLabel={t('culling.rate')}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Pressable
                    key={n}
                    hitSlop={4}
                    style={styles.star}
                    accessibilityLabel={t('culling.stars', { count: n })}
                    onPress={() => {
                      tick();
                      setMeta(item, { rating: meta?.rating === n ? 0 : n });
                    }}
                  >
                    <Icon name="star" size={24} color={(meta?.rating ?? 0) >= n ? colors.accent : colors.surface3} />
                  </Pressable>
                ))}
              </View>
              <View style={styles.flags}>
                <Chip icon="flag" label={t('culling.pick')} active={meta?.flag === 1} onPress={() => setMeta(item, { flag: meta?.flag === 1 ? 0 : 1 })} />
                <Chip icon="reject" label={t('culling.reject')} active={meta?.flag === -1} onPress={() => setMeta(item, { flag: meta?.flag === -1 ? 0 : -1 })} />
              </View>
              <View style={styles.labels}>
                {(['red', 'yellow', 'green', 'blue', 'purple'] as const).map((col) => (
                  <Pressable
                    key={col}
                    accessibilityLabel={t(`labels.${col}`)}
                    accessibilityState={{ selected: meta?.label === col }}
                    hitSlop={6}
                    onPress={() => {
                      tick();
                      setMeta(item, { label: meta?.label === col ? null : col });
                    }}
                    style={[styles.labelRing, meta?.label === col && styles.labelOn]}
                  >
                    <View style={[styles.labelDot, { backgroundColor: LABEL_COLORS[col] }]} />
                  </Pressable>
                ))}
              </View>
            </View>
            <Group>
              <ListRow icon="copy" label={t('editor.copy')} onPress={() => onSheet('copy')} />
              <ListRow
                icon="paste"
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
                icon="toolVersions"
                label={t('tools.versions')}
                onPress={() => {
                  setTool('versions');
                  close();
                }}
              />
            </Group>
            <Group>
              <ListRow icon="info" label={t('editor.info')} onPress={() => onSheet('info')} />
              <ToggleRow icon="histogram" label={t('editor.histogram')} value={props.histogram} onChange={props.onHistogram} />
            </Group>
            <Group>
              <ListRow
                icon="reset"
                label={t('editor.resetAll')}
                chevron={false}
                onPress={() => {
                  resetAll();
                  close();
                }}
              />
              <ListRow icon="undo" label={t('editor.revertOriginal')} destructive chevron={false} onPress={revert} />
            </Group>
          </ScrollView>
        )}
        {sheet === 'copy' && (
          <View style={{ padding: space.lg, gap: space.lg }}>
            <Text style={styles.title}>{t('editor.copy')}</Text>
            <SectionPicker value={sections} onChange={setSections} />
            <Button
              primary
              icon="copy"
              label={t('editor.copy')}
              onPress={() => {
                copy(sections);
                notifySuccess();
                close();
              }}
            />
          </View>
        )}
        {sheet === 'info' && (
          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={styles.menu}>
            <Text style={styles.title}>{t('editor.info')}</Text>
            <Group>
              {(
                [
                  [t('info.file'), recipe.source.filename],
                  ...(info
                    ? [
                        [t('info.camera'), [info.make, info.model].filter(Boolean).join(' ')],
                        [t('info.lens'), info.lens],
                        [
                          t('info.exposure'),
                          [
                            info.exposureTime ? (info.exposureTime < 1 ? `1/${Math.round(1 / info.exposureTime)}s` : `${info.exposureTime}s`) : null,
                            info.fNumber ? `ƒ/${info.fNumber}` : null,
                            info.iso ? `ISO ${info.iso}` : null,
                            info.focalLength ? `${Math.round(info.focalLength)}mm` : null,
                            info.exposureBias ? `${info.exposureBias > 0 ? '+' : ''}${info.exposureBias.toFixed(1)} EV` : null,
                          ]
                            .filter(Boolean)
                            .join('  ·  '),
                        ],
                        [t('info.dimensions'), `${info.width} × ${info.height} · ${((info.width * info.height) / 1e6).toFixed(1)} MP`],
                        [t('info.date'), info.dateTaken],
                        [t('info.profile'), [info.colorProfile, info.isRaw ? (info.isProRaw ? 'ProRAW' : 'RAW') : null].filter(Boolean).join(' · ')],
                        [t('info.location'), info.latitude != null ? `${info.latitude.toFixed(5)}, ${info.longitude?.toFixed(5)}` : null],
                      ]
                    : []),
                ] as [string, string | null | undefined][]
              )
                .filter(([, v]) => !!v)
                .map(([label, value]) => (
                  <InfoRow key={label} label={label} value={value} />
                ))}
            </Group>
          </ScrollView>
        )}
      </Animated.View>
    </Modal>
  );
}


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
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '80%',
    backgroundColor: colors.panel,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderCurve: 'continuous',
    boxShadow: floating,
  },
  menu: { padding: space.lg, gap: space.lg },
  title: { color: colors.text, ...type.title3 },
  culling: { gap: space.md, alignItems: 'center' },
  rating: { flexDirection: 'row', gap: space.xs },
  star: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  flags: { flexDirection: 'row', gap: space.sm },
  labels: { flexDirection: 'row', gap: space.md },
  labelRing: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  labelOn: { borderColor: colors.text },
  labelDot: { width: 22, height: 22, borderRadius: 11 },
  infoRow: { paddingHorizontal: space.lg, paddingVertical: space.md - 2, gap: 2 },
  infoLabel: { color: colors.textDim, ...type.footnote },
  infoValue: { color: colors.text, ...type.body, ...tabular },
});
