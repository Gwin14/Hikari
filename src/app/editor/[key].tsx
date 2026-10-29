import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cachedThumb } from '@/core/thumbs';
import { hasRaw } from '@/core/sources/types';
import { prefetchPhoto, useEditor, type ToolId } from '@/state/editor';
import { useLibrary } from '@/state/library';
import { CurveEditor } from '@/ui/editor/CurveEditor';
import { EditorCanvas } from '@/ui/editor/EditorCanvas';
import { EditorMenu } from '@/ui/editor/EditorMenu';
import { HistogramView } from '@/ui/editor/HistogramView';
import {
  ColorPanel,
  DetailPanel,
  EffectsPanel,
  GradingPanel,
  HslPanel,
  LightPanel,
  LutPanel,
  OpticsPanel,
  PanelScroll,
  RawPanel,
} from '@/ui/editor/panels/BasicPanels';
import { GeometryPanel } from '@/ui/editor/panels/GeometryPanel';
import { MasksPanel, useBrush } from '@/ui/editor/panels/MasksPanel';
import { PresetsPanel } from '@/ui/editor/panels/PresetsPanel';
import { ToolBar } from '@/ui/editor/ToolBar';
import { Button, IconButton } from '@/ui/kit';
import { colors, common, font, radius, space } from '@/ui/theme';

export default function EditorScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const { key } = useLocalSearchParams<{ key: string }>();
  const sequence = useLibrary((s) => s.sequence);
  const index = sequence.findIndex((i) => i.key === key);
  const item = index >= 0 ? sequence[index] : null;

  const recipe = useEditor((s) => s.recipe);
  const loading = useEditor((s) => s.loading);
  const error = useEditor((s) => s.error);
  const tool = useEditor((s) => s.tool);
  const past = useEditor((s) => s.past.length);
  const future = useEditor((s) => s.future.length);
  const histogram = useEditor((s) => s.histogram);
  const compare = useEditor((s) => s.compare);
  const hasPair = useEditor((s) => s.hasPair);
  const ready = useEditor((s) => !!s.inputs && s.item?.key === key);
  const thumb = useLibrary((s) => (item ? (s.meta.get(item.key)?.thumb ?? null) : null));
  const previewUri = item ? (thumb ?? item.thumbUri ?? cachedThumb(item)) : null;
  const { open, close, undo, redo, setTool, setCompare, auto } = useEditor.getState();
  const [sheet, setSheet] = useState<'menu' | 'copy' | 'snapshots' | 'info' | null>(null);
  const [showHist, setShowHist] = useState(true);
  const brush = useBrush();

  useEffect(() => {
    if (item) open(item);
  }, [item?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => close(), [close]);
  // Once this photo is on screen, decode its neighbours so stepping through is instant.
  useEffect(() => {
    if (!ready) return;
    const next = sequence[index + 1];
    const prev = sequence[index - 1];
    if (next) prefetchPhoto(next);
    if (prev) prefetchPhoto(prev);
  }, [ready, index, sequence]);

  const landscape = width > height;
  const panelHeight = landscape ? undefined : Math.round(height * 0.34);
  const showRaw = !!item && (hasRaw(item) || hasPair || !!recipe?.source.isRaw);

  const go = (d: number) => {
    const next = sequence[index + d];
    if (next) router.setParams({ key: next.key });
  };

  const onTool = (id: ToolId) => {
    if (id === 'auto') {
      auto();
      return;
    }
    setTool(id);
  };

  const panel = useMemo(() => {
    if (!recipe) return null;
    switch (tool) {
      case 'presets':
        return <PresetsPanel recipe={recipe} />;
      case 'light':
        return <LightPanel recipe={recipe} />;
      case 'color':
        return <ColorPanel recipe={recipe} />;
      case 'curves':
        return <CurveEditor recipe={recipe} />;
      case 'hsl':
        return <HslPanel recipe={recipe} />;
      case 'grading':
        return <GradingPanel recipe={recipe} />;
      case 'detail':
        return <DetailPanel recipe={recipe} />;
      case 'optics':
        return <OpticsPanel recipe={recipe} />;
      case 'geometry':
        return <GeometryPanel recipe={recipe} />;
      case 'effects':
        return <EffectsPanel recipe={recipe} />;
      case 'lut':
        return <LutPanel recipe={recipe} />;
      case 'masks':
        return <MasksPanel recipe={recipe} brush={brush} />;
      case 'raw':
        return <RawPanel recipe={recipe} />;
      default:
        return null;
    }
  }, [tool, recipe, brush]);

  if (!item) {
    return (
      <View style={[common.screen, common.center]}>
        <Button label={t('common.close')} onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={[common.screen, { paddingTop: insets.top }]}>
      <View style={styles.top}>
        <IconButton icon="chevron-back" size={26} onPress={() => router.back()} label={t('common.close')} />
        <IconButton icon="arrow-undo" disabled={!past} onPress={undo} />
        <IconButton icon="arrow-redo" disabled={!future} onPress={redo} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {item.filename}
            {item.pair || hasPair ? ' · RAW+JPEG' : ''}
          </Text>
        </View>
        <IconButton icon="chevron-up" disabled={index <= 0} onPress={() => go(-1)} size={20} />
        <IconButton icon="chevron-down" disabled={index >= sequence.length - 1} onPress={() => go(1)} size={20} />
        <IconButton icon="git-compare-outline" active={compare === 'split'} onPress={() => setCompare(compare === 'split' ? 'off' : 'split')} label={t('editor.split')} />
        <IconButton icon="bar-chart-outline" active={showHist} onPress={() => setShowHist(!showHist)} label={t('editor.histogram')} />
        <IconButton icon="ellipsis-horizontal-circle" onPress={() => setSheet('menu')} />
        <IconButton icon="share-outline" active onPress={() => router.push({ pathname: '/export', params: { keys: item.key } })} label={t('export.title')} />
      </View>

      <View style={[styles.body, landscape && { flexDirection: 'row' }]}>
        <View style={{ flex: 1 }}>
          <EditorCanvas brush={brush} />
          {!ready && previewUri && (
            // the grid thumbnail stands in (already in memory) while the full preview decodes
            <Animated.View style={[StyleSheet.absoluteFill, styles.preview]} exiting={FadeOut.duration(180)} pointerEvents="none">
              <Image source={{ uri: previewUri }} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="memory-disk" priority="high" />
            </Animated.View>
          )}
          {showHist && (
            <View style={styles.hist} pointerEvents="box-none">
              <HistogramView histogram={histogram} />
            </View>
          )}
          {loading && (
            <Animated.View entering={FadeIn.delay(150)} exiting={FadeOut} style={styles.loadingPill} pointerEvents="none">
              <ActivityIndicator size="small" color={colors.accent} />
              {hasRaw(item) && <Text style={styles.loading}>{t('editor.unsavedRaw')}</Text>}
            </Animated.View>
          )}
          {error && (
            <View style={[StyleSheet.absoluteFill, common.center]} pointerEvents="none">
              <Text style={styles.error}>{error}</Text>
            </View>
          )}
        </View>
        <View style={[styles.panel, landscape ? { width: 360 } : { height: panelHeight }]}>
          <View style={styles.grabber} />
          <PanelScroll>{panel}</PanelScroll>
        </View>
      </View>
      <View style={[styles.tools, { paddingBottom: insets.bottom }]}>
        <ToolBar value={tool} onChange={onTool} showRaw={showRaw} />
      </View>
      <EditorMenu sheet={sheet} onSheet={setSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm, height: 52 },
  name: { color: colors.textDim, fontSize: font.xs, fontWeight: '600', textAlign: 'center', letterSpacing: 0.2 },
  body: { flex: 1 },
  preview: { backgroundColor: colors.bg },
  hist: { position: 'absolute', top: space.sm, left: space.sm },
  panel: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.surface3, marginTop: space.sm },
  tools: { backgroundColor: colors.surface },
  error: { color: colors.danger, fontSize: font.md, padding: space.xl, textAlign: 'center' },
  loadingPill: {
    position: 'absolute',
    top: space.md,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
  },
  loading: { color: colors.textDim, fontSize: font.xs },
});
