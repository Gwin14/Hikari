import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { isNativeAvailable, type ExportColorSpace, type ExportFormat, type MetadataPolicy } from 'hikari-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { handoffReturnUrl, returnToKomorebi } from '@/core/companion/komorebi';
import { listFolders, listJson, newId, upsertJson } from '@/core/db/db';
import { exportItems, recipeFor, type ExportProgress } from '@/core/export/exporter';
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
import { cachedThumb } from '@/core/thumbs';
import { findItems, useLibrary } from '@/state/library';
import { prefs } from '@/state/prefs';
import { useToolbarIcon } from '@/ui/Icon';
import { Button, Chip, Field, Group, ListRow, notifySuccess, ProgressBar, Segmented, ToggleRow } from '@/ui/kit';
import { Slider } from '@/ui/Slider';
import { curve, radius, space, tabular, type, useStyles, useTheme, type Palette } from '@/ui/theme';

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

/** Export sheet: a summary of what comes out on top, the settings grouped below, one action at the bottom. */
export default function ExportScreen() {
  const { t } = useTranslation();
  const c = useTheme();
  const s = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { keys } = useLocalSearchParams<{ keys: string }>();
  const items = useMemo(() => findItems((keys ?? '').split('\n').filter(Boolean)), [keys]);
  const [o, setO] = useState<ExportOptions>(loadLast);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [finished, setFinished] = useState<string[] | null>(null);
  const [presets, setPresets] = useState(() => listJson<ExportOptions>('export_presets', 'options'));
  const folders = useMemo(() => listFolders(), []);
  const set = (patch: Partial<ExportOptions>) => setO((prev) => ({ ...prev, ...patch }));
  const saveIcon = useToolbarIcon('bookmark', c.accentInk);
  // an export in flight can't be abandoned half-way
  usePreventRemove(!!progress, () => {});

  // Without the native engine only Skia's 8-bit encoders are available.
  const formats: ExportFormat[] = isNativeAvailable ? ['jpeg', 'heic', 'png', 'tiff', 'webp'] : ['jpeg', 'png', 'webp'];

  const first = items[0];
  const thumb = useLibrary((st) => (first ? (st.meta.get(first.key)?.thumb ?? null) : null));
  const previewUri = first ? (thumb ?? first.thumbUri ?? cachedThumb(first)) : null;
  const estimate = useMemo(() => {
    if (!first || !first.width) return null;
    const g = geometryMatrix(recipeFor(first).geometry, first.width, first.height);
    return outputSize(g.outW, g.outH, o.sizeMode, o.sizeValue);
  }, [first, o.sizeMode, o.sizeValue]);

  const destinations: { value: Destination; label: string; hint?: string }[] = [
    { value: 'library', label: t('export.toLibrary') },
    ...(Platform.OS === 'ios' && items.every((i) => i.kind === 'library')
      ? [{ value: 'libraryEdit' as const, label: t('export.toLibraryEdit'), hint: t('export.toLibraryEditHint') }]
      : []),
    ...(items.some((i) => i.dirUri) ? [{ value: 'sourceFolder' as const, label: t('export.toSourceFolder') }] : []),
    ...(folders.length ? [{ value: 'folder' as const, label: t('export.toFolder') }] : []),
    { value: 'share', label: t('export.toShare') },
  ];

  const run = async () => {
    prefs.set(LAST_KEY, JSON.stringify(o));
    setProgress({ done: 0, total: items.length, current: '', errors: [] });
    const res = await exportItems(items, o, setProgress);
    // leave once the back-block above has been lifted by this render
    setProgress(null);
    setFinished(res.errors);
  };

  useEffect(() => {
    if (!finished) return;
    if (finished.length) Alert.alert(t('common.error'), finished.join('\n'));
    else notifySuccess();
    router.back();
    // closes the loop shoot → edit → see it in the camera's gallery
    const fromCamera = items.length === 1 && items[0].kind === 'library' && handoffReturnUrl(items[0].id);
    if (!finished.length && fromCamera) {
      Alert.alert(t('komorebi.exportedTitle'), t('komorebi.exportedBody'), [
        { text: t('komorebi.stay'), style: 'cancel' },
        { text: t('komorebi.back'), onPress: () => returnToKomorebi(items[0].id) },
      ]);
    }
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePreset = () => {
    const save = (name: string) => {
      upsertJson('export_presets', 'options', newId(), name, o);
      setPresets(listJson<ExportOptions>('export_presets', 'options'));
      notifySuccess();
    };
    const fallback = `${o.format.toUpperCase()} ${o.sizeMode === 'original' ? '' : o.sizeValue}`.trim();
    // Alert.prompt is iOS-only; Android gets a descriptive automatic name.
    if (Platform.OS === 'ios') Alert.prompt(t('export.savePreset'), undefined, (name) => save(name?.trim() || fallback), 'plain-text', fallback);
    else save(fallback);
  };

  const title = items.length > 1 ? t('export.count', { count: items.length }) : t('export.one');

  if (progress) {
    return (
      <View style={[s.progress, { backgroundColor: c.bg }]}>
        <Stack.Title>{title}</Stack.Title>
        <Text style={s.progressCount}>{t('export.exporting', { done: progress.done, total: progress.total })}</Text>
        <ProgressBar value={progress.total ? progress.done / progress.total : 0} />
        <Text style={s.progressFile} numberOfLines={1} ellipsizeMode="middle">
          {progress.current || ' '}
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
  const summary = [
    inPlace ? t('export.inPlace') : o.format.toUpperCase(),
    !inPlace && estimate ? `${estimate.width} × ${estimate.height}` : null,
    !inPlace ? (o.colorSpace === 'srgb' ? 'sRGB' : o.colorSpace === 'p3' ? 'Display P3' : 'Adobe RGB') : null,
    !inPlace && supports16Bit(o.format) ? `${o.bitDepth} bit` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Title>{title}</Stack.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={saveIcon} accessibilityLabel={t('export.savePreset')} onPress={savePreset} />
      </Stack.Toolbar>

      <ScrollView
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 112 }]}
      >
        <View style={s.summary}>
          <View style={s.thumb}>
            {previewUri ? <Image source={{ uri: previewUri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
            {items.length > 1 && (
              <View style={s.stackBadge}>
                <Text style={s.stackBadgeText}>{items.length}</Text>
              </View>
            )}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.summaryTitle} numberOfLines={1} ellipsizeMode="middle">
              {items.length > 1 ? t('common.selected', { count: items.length }) : (first?.filename ?? '')}
            </Text>
            <Text style={s.summaryDetail} numberOfLines={2}>
              {summary}
            </Text>
          </View>
        </View>

        {presets.length > 0 && (
          <Group title={t('export.presets')}>
            <View style={s.chips}>
              {presets.map((p) => (
                <Chip key={p.id} icon="bookmark" label={p.name} onPress={() => setO({ ...defaultExportOptions(), ...p.value })} />
              ))}
            </View>
          </Group>
        )}

        <Group title={t('export.destination')}>
          {destinations.map((d) => (
            <ListRow key={d.value} label={d.label} hint={d.hint} selected={o.destination === d.value} onPress={() => set({ destination: d.value })} />
          ))}
        </Group>
        {o.destination === 'folder' && (
          <Group title={t('export.chooseFolder')}>
            {folders.map((f) => (
              <ListRow
                key={f.id}
                icon="foldersFill"
                label={f.name}
                selected={o.destinationFolderId === f.id}
                onPress={() => set({ destinationFolderId: f.id })}
              />
            ))}
          </Group>
        )}

        {!inPlace && (
          <>
            <Group title={t('export.format')}>
              <View style={s.chips}>
                {formats.map((f) => (
                  <Chip
                    key={f}
                    label={f.toUpperCase()}
                    active={o.format === f}
                    onPress={() => set({ format: f, bitDepth: supports16Bit(f) ? o.bitDepth : 8 })}
                  />
                ))}
              </View>
              {supportsQuality(o.format) ? (
                <Slider label={t('export.quality')} min={10} max={100} neutral={92} value={o.quality} onCommit={(v) => set({ quality: Math.round(v) })} />
              ) : null}
              {supports16Bit(o.format) ? (
                <View style={s.padded}>
                  <Segmented
                    options={[
                      { value: 8, label: '8 bit' },
                      { value: 16, label: '16 bit' },
                    ]}
                    value={o.bitDepth}
                    onChange={(v) => set({ bitDepth: v as 8 | 16 })}
                  />
                </View>
              ) : null}
            </Group>

            <Group title={t('export.size')}>
              <View style={s.chips}>
                {sizes.map((sz) => (
                  <Chip
                    key={sz.value}
                    label={sz.label}
                    active={o.sizeMode === sz.value}
                    onPress={() => set({ sizeMode: sz.value, sizeValue: defaultSizeValue(sz.value) })}
                  />
                ))}
              </View>
              {o.sizeMode !== 'original' ? (
                <View style={[s.padded, s.sizeRow]}>
                  <TextInput
                    keyboardType="number-pad"
                    keyboardAppearance={c.scheme}
                    selectionColor={c.accentInk}
                    value={String(o.sizeValue)}
                    onChangeText={(v) => set({ sizeValue: Number(v.replace(/[^\d.]/g, '')) || 0 })}
                    style={s.input}
                    accessibilityLabel={t('export.size')}
                  />
                  <View style={s.quick}>
                    {quickSizes(o.sizeMode).map((v) => (
                      <Chip key={v} label={String(v)} active={o.sizeValue === v} onPress={() => set({ sizeValue: v })} />
                    ))}
                  </View>
                </View>
              ) : null}
            </Group>

            <Group title={t('export.colorSpace')}>
              <View style={s.padded}>
                <Segmented
                  options={(['srgb', 'p3', 'adobergb'] as ExportColorSpace[]).map((cs) => ({
                    value: cs,
                    label: cs === 'srgb' ? 'sRGB' : cs === 'p3' ? 'Display P3' : 'Adobe RGB',
                  }))}
                  value={o.colorSpace}
                  onChange={(v) => set({ colorSpace: v as ExportColorSpace })}
                />
              </View>
            </Group>

            <Group title={t('export.sharpen')}>
              <View style={s.padded}>
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
            </Group>
          </>
        )}

        <Group title={t('export.metadata')}>
          <View style={s.chips}>
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
          </View>
          <View style={[s.padded, { gap: space.md }]}>
            <Field label={t('export.artist')} value={o.artist} onChangeText={(v) => set({ artist: v })} textContentType="name" autoCapitalize="words" />
            <Field label={t('export.copyright')} value={o.copyright} onChangeText={(v) => set({ copyright: v })} />
          </View>
        </Group>

        {!inPlace && (
          <>
            <Group title={t('export.watermark')}>
              <ToggleRow label={t('export.watermarkAdd')} value={o.watermark.enabled} onChange={(v) => set({ watermark: { ...o.watermark, enabled: v } })} />
              {o.watermark.enabled ? (
                <View style={{ paddingBottom: space.sm }}>
                  <View style={s.padded}>
                    <Field label={t('export.watermarkText')} value={o.watermark.text} onChangeText={(v) => set({ watermark: { ...o.watermark, text: v } })} />
                  </View>
                  <View style={s.padded}>
                    <Segmented
                      options={(['tl', 'tr', 'center', 'bl', 'br'] as WatermarkPosition[]).map((p) => ({ value: p, label: POS_LABEL[p] }))}
                      value={o.watermark.position}
                      onChange={(p) => set({ watermark: { ...o.watermark, position: p } })}
                    />
                  </View>
                  <Slider
                    label={t('export.watermarkOpacity')}
                    min={5}
                    max={100}
                    neutral={70}
                    value={o.watermark.opacity}
                    onCommit={(v) => set({ watermark: { ...o.watermark, opacity: Math.round(v) } })}
                  />
                  <Slider
                    label={t('export.watermarkSize')}
                    min={1}
                    max={12}
                    neutral={3}
                    decimals={1}
                    value={o.watermark.size}
                    onCommit={(v) => set({ watermark: { ...o.watermark, size: v } })}
                  />
                </View>
              ) : null}
            </Group>

            <Group
              title={t('export.filename')}
              footer={first ? `${expandFilename(o.filenameTemplate, { name: first.filename, date: new Date(), seq: 1 })}.${FORMAT_EXT[o.format]}` : undefined}
            >
              <View style={s.padded}>
                <Field
                  label={t('export.filenameHint')}
                  value={o.filenameTemplate}
                  onChangeText={(v) => set({ filenameTemplate: v })}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </Group>

            {(o.destination === 'folder' || o.destination === 'sourceFolder') && (
              <Group>
                <ToggleRow label={t('export.exportRecipe')} value={o.includeSidecar} onChange={(v) => set({ includeSidecar: v })} />
                {o.destination === 'folder' ? <ToggleRow label={t('export.includeRaw')} value={o.includeRaw} onChange={(v) => set({ includeRaw: v })} /> : null}
              </Group>
            )}
          </>
        )}
      </ScrollView>

      <View style={[s.footer, { paddingBottom: insets.bottom + space.md }]}>
        <Button
          primary
          icon={o.destination === 'share' ? 'share' : 'download'}
          label={title}
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

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: space.lg, gap: space.xxl },
    summary: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: c.surface, borderRadius: radius.card, ...curve },
    thumb: { width: 64, height: 64, borderRadius: radius.tile, ...curve, overflow: 'hidden', backgroundColor: c.surface2 },
    stackBadge: {
      position: 'absolute',
      right: 4,
      bottom: 4,
      minWidth: 20,
      height: 20,
      paddingHorizontal: 5,
      borderRadius: 10,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stackBadgeText: { color: c.onAccent, ...type.caption2, fontWeight: '700', ...tabular },
    summaryTitle: { color: c.text, ...type.headline },
    summaryDetail: { color: c.textDim, ...type.footnote, ...tabular },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.md },
    padded: { paddingHorizontal: space.lg, paddingVertical: space.sm },
    sizeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    quick: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    input: {
      backgroundColor: c.surface2,
      color: c.text,
      borderRadius: radius.tile,
      ...curve,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      ...type.body,
      lineHeight: undefined,
      minWidth: 88,
      ...tabular,
    },
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
    progress: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xxxl * 1.5, gap: space.md },
    progressCount: { color: c.text, ...type.headline, textAlign: 'center', ...tabular },
    progressFile: { color: c.textDim, ...type.footnote, textAlign: 'center' },
  });
