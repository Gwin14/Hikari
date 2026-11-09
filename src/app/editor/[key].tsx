import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { handoffReturnUrl, returnToKomorebi } from '@/core/companion/komorebi';
import { cachedThumb } from '@/core/thumbs';
import { hasRaw, keyMatches } from '@/core/sources/types';
import { prefetchPhoto, useEditor, type ToolId } from '@/state/editor';
import { useLibrary } from '@/state/library';
import { usePrefBool } from '@/state/prefs';
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
import { RetouchPanel } from '@/ui/editor/panels/RetouchPanel';
import { VersionsPanel } from '@/ui/editor/panels/VersionsPanel';
import { toolMeta, ToolBar } from '@/ui/editor/ToolBar';
import { Button, IconButton, PressableScale, tick } from '@/ui/kit';
import { colors, common, curve, radius, raised, space, tabular, ThemeProvider, type } from '@/ui/theme';

export default function EditorScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const { key } = useLocalSearchParams<{ key: string }>();
  const sequence = useLibrary((s) => s.sequence);
  const index = sequence.findIndex((i) => keyMatches(i.key, key));
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
  const ready = useEditor((s) => !!s.inputs && !!item && s.item?.key === item.key);
  const thumb = useLibrary((s) => (item ? (s.meta.get(item.key)?.thumb ?? null) : null));
  const previewUri = item ? (thumb ?? item.thumbUri ?? cachedThumb(item)) : null;
  const { open, close, undo, redo, setTool, setCompare, auto } = useEditor.getState();
  const [sheet, setSheet] = useState<'menu' | 'copy' | 'info' | null>(null);
  const [histPref, setShowHist] = usePrefBool('showHistogram');
  const showHist = histPref ?? true;
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

  // opened from Komorebi: a cold-started deep link has no gallery underneath
  const fromKomorebi = item?.kind === 'library' && !!handoffReturnUrl(item.id);
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const landscape = width > height;
  const panelHeight = landscape ? undefined : Math.round(height * 0.36);
  const showRaw = !!item && (hasRaw(item) || hasPair || !!recipe?.source.isRaw);

  const go = (d: number) => {
    const next = sequence[index + d];
    if (!next) return;
    tick();
    router.setParams({ key: next.key });
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
      case 'versions':
        return <VersionsPanel recipe={recipe} />;
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
      case 'retouch':
        return <RetouchPanel recipe={recipe} brush={brush} />;
      case 'raw':
        return <RawPanel recipe={recipe} />;
      default:
        return null;
    }
  }, [tool, recipe, brush]);

  if (!item) {
    return (
      <View style={[common.screen, common.center]}>
        <Button label={t('common.close')} onPress={leave} />
      </View>
    );
  }

  const tool_ = toolMeta(tool);
  const exportLabel = t('export.title');

  return (
    <ThemeProvider scheme="dark">
      <StatusBar style="light" />
      <View style={[common.screen, { backgroundColor: colors.canvas, paddingTop: insets.top }]}>
        <View style={styles.top}>
          <IconButton icon="close" size={20} onPress={leave} label={t('common.close')} />
          <View
            style={styles.titleBlock}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={item.filename}
            accessibilityValue={{ text: t('editor.position', { n: index + 1, total: sequence.length }) }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => go(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
          >
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
              {item.filename}
            </Text>
            {(sequence.length > 1 || item.pair || hasPair) && (
              <Text style={styles.position} numberOfLines={1}>
                {sequence.length > 1 ? t('editor.position', { n: index + 1, total: sequence.length }) : ''}
                {item.pair || hasPair ? `${sequence.length > 1 ? ' · ' : ''}RAW+JPEG` : ''}
              </Text>
            )}
          </View>
          {fromKomorebi && <IconButton icon="camera" onPress={() => returnToKomorebi(item.id)} label={t('komorebi.back')} />}
          <IconButton icon="more" onPress={() => setSheet('menu')} label={t('editor.more')} />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={exportLabel}
            onPress={() => router.push({ pathname: '/export', params: { keys: item.key } })}
            style={styles.export}
          >
            <Text style={styles.exportText}>{exportLabel}</Text>
          </PressableScale>
        </View>

        <View style={[styles.body, landscape && { flexDirection: 'row' }]}>
          <View style={{ flex: 1 }}>
            <EditorCanvas brush={brush} onSwipe={go} />
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
              <Animated.View entering={FadeIn.delay(150).duration(180)} exiting={FadeOut.duration(120)} style={styles.loadingPill} pointerEvents="none">
                <ActivityIndicator size="small" color={colors.text} />
                {hasRaw(item) && <Text style={styles.loading}>{t('editor.unsavedRaw')}</Text>}
              </Animated.View>
            )}
            {error && (
              <View style={[StyleSheet.absoluteFill, common.center]} pointerEvents="none">
                <Text style={styles.error}>{error}</Text>
              </View>
            )}
            {/* history and compare float over the photo's bottom edge, out of the panel's way */}
            <View style={styles.canvasBar} pointerEvents="box-none">
              <View style={styles.capsule}>
                <IconButton icon="undo" size={18} disabled={!past} onPress={undo} label={t('editor.undo')} style={styles.capsuleBtn} />
                <View style={styles.capsuleDivider} />
                <IconButton icon="redo" size={18} disabled={!future} onPress={redo} label={t('editor.redo')} style={styles.capsuleBtn} />
              </View>
              <IconButton
                icon="compare"
                variant="glass"
                active={compare === 'split'}
                onPress={() => setCompare(compare === 'split' ? 'off' : 'split')}
                label={t('editor.split')}
              />
            </View>
          </View>
          <View style={[styles.panel, landscape ? styles.panelSide : { height: panelHeight }]}>
            <View style={styles.panelHeader}>
              <Text style={styles.panelTitle} accessibilityRole="header">
                {t(tool_.label)}
              </Text>
            </View>
            <PanelScroll>{panel}</PanelScroll>
          </View>
        </View>
        <View style={[styles.tools, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <ToolBar value={tool} onChange={onTool} showRaw={showRaw} />
        </View>
        <EditorMenu sheet={sheet} onSheet={setSheet} histogram={showHist} onHistogram={setShowHist} />
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.sm, height: 52 },
  titleBlock: { flex: 1, alignItems: 'center', paddingHorizontal: space.xs },
  name: { color: colors.text, ...type.subhead, fontWeight: '600', textAlign: 'center' },
  position: { color: colors.textDim, ...type.caption2, marginTop: 1, ...tabular },
  export: {
    height: 34,
    paddingHorizontal: space.lg,
    marginLeft: space.xs,
    borderRadius: radius.pill,
    ...curve,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exportText: { color: colors.onAccent, ...type.subhead, fontWeight: '700' },
  body: { flex: 1 },
  preview: { backgroundColor: colors.canvas },
  hist: { position: 'absolute', top: space.sm, left: space.sm },
  canvasBar: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    paddingHorizontal: space.xs,
    borderRadius: radius.pill,
    ...curve,
    backgroundColor: colors.glass,
    boxShadow: raised,
  },
  capsuleBtn: { width: 40, height: 40 },
  capsuleDivider: { width: StyleSheet.hairlineWidth, height: 18, backgroundColor: colors.separator },
  panel: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    ...curve,
  },
  panelSide: { width: 360, borderTopRightRadius: 0, borderBottomLeftRadius: radius.sheet },
  panelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingTop: space.md, paddingBottom: space.xs },
  panelTitle: { color: colors.text, ...type.headline },
  tools: { backgroundColor: colors.panel, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  error: { color: colors.danger, ...type.subhead, padding: space.xl, textAlign: 'center' },
  loadingPill: {
    position: 'absolute',
    top: space.md,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    height: 34,
    borderRadius: radius.pill,
    ...curve,
    backgroundColor: colors.glass,
  },
  loading: { color: colors.text, ...type.footnote, fontWeight: '500' },
});
