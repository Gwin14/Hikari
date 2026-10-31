import { router, useLocalSearchParams } from 'expo-router';
import { isNativeAvailable, type ExportColorSpace, type ExportFormat, type MetadataPolicy } from 'hikari-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { handoffReturnUrl, returnToKomorebi } from '@/core/companion/komorebi';
import { listFolders, listJson, newId, upsertJson } from '@/core/db/db';
import { exportItems, type ExportProgress } from '@/core/export/exporter';
import {
  defaultExportOptions,
  expandFilename,
  FORMAT_EXT,
  outputSize,
  supports16Bit,
  supportsQuality,
  type Destination,
  type ExportOptions,
  type SizeMode,
  type WatermarkPosition,
} from '@/core/export/options';
import { geometryMatrix } from '@/core/pipeline/geometry';
import { recipeFor } from '@/core/export/exporter';
import { prefs } from '@/state/prefs';
import { findItems } from '@/state/library';
import { Button, Chip, ChipRow, Field, IconButton, notifySuccess, ProgressBar, SectionTitle, Segmented, ToggleRow } from '@/ui/kit';
import { Slider } from '@/ui/Slider';
import { colors, common, curve, font, radius, space } from '@/ui/theme';

const LAST_KEY = 'export.last';

function loadLast(): ExportOptions {
  try {
    const s = prefs.getString(LAST_KEY);
    const base = defaultExportOptions();
    const o = s ? { ...base, ...JSON.parse(s) } : base;
    o.artist ||= prefs.getString('defaultArtist') ?? '';
    o.copyright ||= prefs.getString('defaultCopyright') ?? '';
    return o;
  } catch {
    return defaultExportOptions();
  }
}

export default function ExportScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { keys } = useLocalSearchParams<{ keys: string }>();
  const items = useMemo(() => findItems((keys ?? '').split('\n').filter(Boolean)), [keys]);
  const [o, setO] = useState<ExportOptions>(loadLast);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [presets, setPresets] = useState(() => listJson<ExportOptions>('export_presets', 'options'));
  const folders = useMemo(() => listFolders(), []);
  const set = (patch: Partial<ExportOptions>) => setO((prev) => ({ ...prev, ...patch }));

  // Without the native engine only Skia's 8-bit encoders are available.
  const formats: ExportFormat[] = isNativeAvailable ? ['jpeg', 'heic', 'png', 'tiff', 'webp'] : ['jpeg', 'png', 'webp'];

  const first = items[0];
  const estimate = useMemo(() => {
    if (!first || !first.width) return null;
    const g = geometryMatrix(recipeFor(first).geometry, first.width, first.height);
    return outputSize(g.outW, g.outH, o.sizeMode, o.sizeValue);
  }, [first, o.sizeMode, o.sizeValue]);

  const destinations: { value: Destination; label: string }[] = [
    { value: 'library', label: t('export.toLibrary') },
    ...(Platform.OS === 'ios' && items.every((i) => i.kind === 'library') ? [{ value: 'libraryEdit' as const, label: t('export.toLibraryEdit') }] : []),
    ...(items.some((i) => i.dirUri) ? [{ value: 'sourceFolder' as const, label: t('export.toSourceFolder') }] : []),
    ...(folders.length ? [{ value: 'folder' as const, label: t('export.toFolder') }] : []),
    { value: 'share', label: t('export.toShare') },
  ];

  const run = async () => {
    prefs.set(LAST_KEY, JSON.stringify(o));
    setProgress({ done: 0, total: items.length, current: '', errors: [] });
    const res = await exportItems(items, o, setProgress);
    if (res.errors.length) Alert.alert(t('common.error'), res.errors.join('\n'));
    else notifySuccess();
    router.back();
    // closes the loop shoot → edit → see it in the camera's gallery
    const fromCamera = items.length === 1 && items[0].kind === 'library' && handoffReturnUrl(items[0].id);
    if (!res.errors.length && fromCamera) {
      Alert.alert(t('komorebi.exportedTitle'), t('komorebi.exportedBody'), [
        { text: t('komorebi.stay'), style: 'cancel' },
        { text: t('komorebi.back'), onPress: () => returnToKomorebi(items[0].id) },
      ]);
    }
  };

  const savePreset = () => {
    const save = (name: string) => {
      upsertJson('export_presets', 'options', newId(), name, o);
      setPresets(listJson<ExportOptions>('export_presets', 'options'));
    };
    const fallback = `${o.format.toUpperCase()} ${o.sizeMode === 'original' ? '' : o.sizeValue}`.trim();
    // Alert.prompt is iOS-only; Android gets a descriptive automatic name.
    if (Platform.OS === 'ios') Alert.prompt(t('export.savePreset'), undefined, (name) => save(name?.trim() || fallback), 'plain-text', fallback);
    else save(fallback);
  };

  if (progress) {
    return (
      <View style={[common.screen, common.center, styles.progress]}>
        <Text style={[common.text, styles.progressText]}>{t('export.exporting', { done: progress.done, total: progress.total })}</Text>
        <ProgressBar value={progress.total ? progress.done / progress.total : 0} />
        <Text style={styles.dim} numberOfLines={1}>
          {progress.current}
        </Text>
      </View>
    );
  }

  const sizes: { value: SizeMode; label: string }[] = [
    { value: 'original', label: t('export.sizeOriginal') },
    { value: 'long', label: t('export.sizeLong') },
    { value: 'short', label: t('export.sizeShort') },
    { value: 'megapixels', label: 'MP' },
    { value: 'percent', label: '%' },
  ];
  const inPlace = o.destination === 'libraryEdit';

  return (
    <View style={[common.screen, { paddingTop: Platform.OS === 'android' ? insets.top : space.md }]}>
      <View style={styles.header}>
        <IconButton icon="close" onPress={() => router.back()} label={t('common.close')} />
        <Text style={styles.title}>{items.length > 1 ? t('export.count', { count: items.length }) : t('export.one')}</Text>
        <IconButton icon="bookmark-outline" onPress={savePreset} label={t('export.savePreset')} />
      </View>
      <ScrollView keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}>
        {presets.length > 0 && (
          <>
            <SectionTitle title={t('export.presets')} />
            <ChipRow>
              {presets.map((p) => (
                <Chip key={p.id} label={p.name} onPress={() => setO({ ...defaultExportOptions(), ...p.value })} />
              ))}
            </ChipRow>
          </>
        )}

        <SectionTitle title={t('export.destination')} />
        <ChipRow>
          {destinations.map((d) => (
            <Chip key={d.value} label={d.label} active={o.destination === d.value} onPress={() => set({ destination: d.value })} />
          ))}
        </ChipRow>
        {o.destination === 'folder' && (
          <ChipRow>
            {folders.map((f) => (
              <Chip key={f.id} icon="folder" label={f.name} active={o.destinationFolderId === f.id} onPress={() => set({ destinationFolderId: f.id })} />
            ))}
          </ChipRow>
        )}

        {!inPlace && (
          <>
            <SectionTitle title={t('export.format')} />
            <ChipRow>
              {formats.map((f) => (
                <Chip
                  key={f}
                  label={f.toUpperCase()}
                  active={o.format === f}
                  onPress={() => set({ format: f, bitDepth: supports16Bit(f) ? o.bitDepth : 8 })}
                />
              ))}
            </ChipRow>
            {supportsQuality(o.format) && (
              <Slider label={t('export.quality')} min={10} max={100} neutral={92} value={o.quality} onCommit={(v) => set({ quality: Math.round(v) })} />
            )}
            {supports16Bit(o.format) && (
              <View style={styles.pad}>
                <Segmented
                  options={[
                    { value: 8, label: '8 bit' },
                    { value: 16, label: '16 bit' },
                  ]}
                  value={o.bitDepth}
                  onChange={(v) => set({ bitDepth: v as 8 | 16 })}
                />
              </View>
            )}

            <SectionTitle title={t('export.size')} right={estimate ? <Text style={styles.dim}>{t('export.estimate', { w: estimate.width, h: estimate.height })}</Text> : null} />
            <ChipRow>
              {sizes.map((s) => (
                <Chip key={s.value} label={s.label} active={o.sizeMode === s.value} onPress={() => set({ sizeMode: s.value, sizeValue: defaultSizeValue(s.value) })} />
              ))}
            </ChipRow>
            {o.sizeMode !== 'original' && (
              <View style={[styles.pad, common.row, { gap: space.md }]}>
                <TextInput
                  keyboardType="number-pad"
                  selectionColor={colors.accent}
                  value={String(o.sizeValue)}
                  onChangeText={(v) => set({ sizeValue: Number(v.replace(/[^\d.]/g, '')) || 0 })}
                  style={styles.input}
                />
                <ChipRow>
                  {quickSizes(o.sizeMode).map((v) => (
                    <Chip key={v} label={String(v)} active={o.sizeValue === v} onPress={() => set({ sizeValue: v })} />
                  ))}
                </ChipRow>
              </View>
            )}

            <SectionTitle title={t('export.colorSpace')} />
            <View style={styles.pad}>
              <Segmented
                options={(['srgb', 'p3', 'adobergb'] as ExportColorSpace[]).map((c) => ({
                  value: c,
                  label: c === 'srgb' ? 'sRGB' : c === 'p3' ? 'Display P3' : 'Adobe RGB',
                }))}
                value={o.colorSpace}
                onChange={(v) => set({ colorSpace: v as ExportColorSpace })}
              />
            </View>

            <SectionTitle title={t('export.sharpen')} />
            <View style={styles.pad}>
              <Segmented
                options={[
                  { value: 'none', label: t('common.none') },
                  { value: 'screen', label: t('export.sharpenScreen') },
                  { value: 'print', label: t('export.sharpenPrint') },
                ]}
                value={o.outputSharpen}
                onChange={(v) => set({ outputSharpen: v as ExportOptions['outputSharpen'] })}
              />
            </View>
          </>
        )}

        <SectionTitle title={t('export.metadata')} />
        <ChipRow>
          {(
            [
              ['all', t('export.metaAll')],
              ['noLocation', t('export.metaNoLocation')],
              ['copyright', t('export.metaCopyright')],
              ['none', t('export.metaNone')],
            ] as [MetadataPolicy, string][]
          ).map(([v, l]) => (
            <Chip key={v} label={l} active={o.metadata === v} onPress={() => set({ metadata: v })} />
          ))}
        </ChipRow>
        <View style={[styles.pad, { gap: space.md }]}>
          <Field label={t('export.artist')} value={o.artist} onChangeText={(v) => set({ artist: v })} textContentType="name" autoCapitalize="words" />
          <Field label={t('export.copyright')} value={o.copyright} onChangeText={(v) => set({ copyright: v })} />
        </View>

        {!inPlace && (
          <>
            <ToggleRow label={t('export.watermark')} value={o.watermark.enabled} onChange={(v) => set({ watermark: { ...o.watermark, enabled: v } })} />
            {o.watermark.enabled && (
              <>
                <View style={styles.pad}>
                  <Field label={t('export.watermarkText')} value={o.watermark.text} onChangeText={(v) => set({ watermark: { ...o.watermark, text: v } })} />
                </View>
                <ChipRow>
                  {(['tl', 'tr', 'center', 'bl', 'br'] as WatermarkPosition[]).map((p) => (
                    <Chip key={p} label={POS_LABEL[p]} active={o.watermark.position === p} onPress={() => set({ watermark: { ...o.watermark, position: p } })} />
                  ))}
                </ChipRow>
                <Slider label={t('export.watermarkOpacity')} min={5} max={100} neutral={70} value={o.watermark.opacity} onCommit={(v) => set({ watermark: { ...o.watermark, opacity: Math.round(v) } })} />
                <Slider label={t('export.watermarkSize')} min={1} max={12} neutral={3} decimals={1} value={o.watermark.size} onCommit={(v) => set({ watermark: { ...o.watermark, size: v } })} />
              </>
            )}

            <SectionTitle title={t('export.filename')} />
            <View style={styles.pad}>
              <TextInput value={o.filenameTemplate} onChangeText={(v) => set({ filenameTemplate: v })} style={styles.input} autoCapitalize="none" />
              <Text style={styles.dim}>
                {t('export.filenameHint')} →{' '}
                {first ? `${expandFilename(o.filenameTemplate, { name: first.filename, date: new Date(), seq: 1 })}.${FORMAT_EXT[o.format]}` : ''}
              </Text>
            </View>
            {(o.destination === 'folder' || o.destination === 'sourceFolder') && (
              <>
                <ToggleRow label={t('export.exportRecipe')} value={o.includeSidecar} onChange={(v) => set({ includeSidecar: v })} />
                {o.destination === 'folder' && <ToggleRow label={t('export.includeRaw')} value={o.includeRaw} onChange={(v) => set({ includeRaw: v })} />}
              </>
            )}
          </>
        )}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
        <Button
          primary
          icon="share-outline"
          label={items.length > 1 ? t('export.count', { count: items.length }) : t('export.one')}
          disabled={!items.length || (o.destination === 'folder' && !o.destinationFolderId)}
          onPress={run}
        />
      </View>
    </View>
  );
}

const POS_LABEL: Record<WatermarkPosition, string> = { tl: '↖', tr: '↗', center: '•', bl: '↙', br: '↘' };

function defaultSizeValue(mode: SizeMode) {
  return mode === 'long' ? 2048 : mode === 'short' ? 1080 : mode === 'megapixels' ? 12 : mode === 'percent' ? 50 : 0;
}
function quickSizes(mode: SizeMode) {
  if (mode === 'long') return [1080, 2048, 3840, 6000];
  if (mode === 'short') return [720, 1080, 1350, 2160];
  if (mode === 'megapixels') return [2, 8, 12, 24];
  return [25, 50, 75];
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm, paddingBottom: space.sm },
  title: { flex: 1, color: colors.text, fontSize: font.lg, fontWeight: '700', textAlign: 'center' },
  pad: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  dim: { color: colors.textDim, fontSize: font.xs, marginTop: 6 },
  progress: { paddingHorizontal: space.xl * 2, gap: space.md },
  progressText: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  input: {
    backgroundColor: colors.surface2,
    color: colors.text,
    borderRadius: radius.md,
    ...curve,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: font.md,
    minWidth: 90,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
});
