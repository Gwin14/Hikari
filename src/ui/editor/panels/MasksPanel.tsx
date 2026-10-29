import { Ionicons } from '@expo/vector-icons';
import { isNativeAvailable } from 'hikari-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { Mask, MaskType, Recipe } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { Chip, ChipRow, IconButton, SectionTitle, ToggleRow, type IconName } from '../../kit';
import { Slider } from '../../Slider';
import { colors, font, radius, space } from '../../theme';
import type { BrushSettings } from '../EditorCanvas';
import { bipolar, Sliders, unipolar } from './common';

const KINDS: { type: MaskType; icon: IconName; ai?: boolean }[] = [
  { type: 'subject', icon: 'person-circle-outline', ai: true },
  { type: 'sky', icon: 'cloud-outline', ai: true },
  { type: 'background', icon: 'image-outline', ai: true },
  { type: 'person', icon: 'people-outline', ai: true },
  { type: 'brush', icon: 'brush-outline' },
  { type: 'linear', icon: 'reorder-four-outline' },
  { type: 'radial', icon: 'radio-button-off-outline' },
  { type: 'luminance', icon: 'contrast-outline' },
  { type: 'color', icon: 'color-palette-outline' },
];

export function useBrush(): SharedValue<BrushSettings> {
  return useSharedValue<BrushSettings>({ size: 0.06, hardness: 0.5, flow: 0.8, erase: false });
}

export function MasksPanel({ recipe, brush }: { recipe: Recipe; brush: SharedValue<BrushSettings> }) {
  const { t } = useTranslation();
  const activeId = useEditor((s) => s.activeMaskId);
  const busy = useEditor((s) => s.maskBusy);
  const overlay = useEditor((s) => s.maskOverlay);
  const failed = useEditor((s) => s.maskFailed);
  const { addMask, setActiveMask, removeMask, updateMask, setMaskOverlay } = useEditor.getState();
  const active = recipe.masks.find((m) => m.id === activeId) ?? null;
  const index = active ? recipe.masks.indexOf(active) : -1;

  const kinds = KINDS.filter((k) => !k.ai || k.type === 'sky' || isNativeAvailable);

  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.maskList}>
        {recipe.masks.map((m) => (
          <Pressable key={m.id} onPress={() => setActiveMask(m.id === activeId ? null : m.id)} style={[styles.maskItem, m.id === activeId && styles.maskOn]}>
            {busy === m.id ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Ionicons name={KINDS.find((k) => k.type === m.type)?.icon ?? 'layers'} size={20} color={m.visible ? colors.text : colors.textFaint} />
            )}
            <Text style={styles.maskName} numberOfLines={1}>
              {m.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {!active && (
        <>
          <SectionTitle title={t('masks.add')} />
          <View style={styles.grid}>
            {kinds.map((k) => (
              <Pressable key={k.type} style={styles.kind} onPress={() => addMask(k.type, t(`masks.${k.type}`))}>
                <Ionicons name={k.icon} size={24} color={k.ai ? colors.accent : colors.text} />
                <Text style={styles.kindText} numberOfLines={2}>
                  {t(`masks.${k.type}`)}
                </Text>
              </Pressable>
            ))}
          </View>
          {recipe.masks.length === 0 && <Text style={styles.empty}>{t('masks.empty')}</Text>}
        </>
      )}
      {active && (
        <MaskEditor
          mask={active}
          index={index}
          recipe={recipe}
          brush={brush}
          overlay={overlay}
          status={busy === active.id ? t('masks.detecting') : failed.includes(active.id) ? t('masks.notFound') : null}
          onOverlay={setMaskOverlay}
          onUpdate={(fn) => updateMask(active.id, fn)}
          onRemove={() => removeMask(active.id)}
        />
      )}
    </>
  );
}

function MaskEditor(p: {
  mask: Mask;
  index: number;
  recipe: Recipe;
  brush: SharedValue<BrushSettings>;
  overlay: boolean;
  /** AI detection progress / failure message. */
  status: string | null;
  onOverlay(v: boolean): void;
  onUpdate(fn: (m: Mask) => Mask): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const { mask: m, index: i, recipe } = p;
  const base = ['masks', i] as const;
  const a = (k: string) => [...base, 'adjust', k] as const;
  return (
    <>
      <View style={styles.actions}>
        <IconButton icon={m.visible ? 'eye-outline' : 'eye-off-outline'} onPress={() => p.onUpdate((x) => ({ ...x, visible: !x.visible }))} />
        <IconButton icon="swap-horizontal" active={m.invert} onPress={() => p.onUpdate((x) => ({ ...x, invert: !x.invert }))} label={t('masks.invert')} />
        <IconButton icon="color-filter-outline" active={p.overlay} onPress={() => p.onOverlay(!p.overlay)} label={t('masks.showOverlay')} />
        <View style={{ flex: 1 }} />
        <IconButton icon="trash-outline" color={colors.danger} onPress={p.onRemove} label={t('common.delete')} />
      </View>
      {p.status && <Text style={styles.empty}>{p.status}</Text>}
      {m.type === 'brush' && <BrushControls brush={p.brush} />}
      {m.type === 'color' && <Text style={styles.empty}>{t('masks.pickColor')}</Text>}
      {(m.type === 'luminance' || m.type === 'color' || m.type === 'linear' || m.type === 'radial') && (
        <>
          <SectionTitle title={t('masks.range')} />
          {m.type !== 'luminance' && m.type !== 'color' && (
            <ToggleRow
              label={t('masks.refine')}
              value={m.range.enabled}
              onChange={(v) => p.onUpdate((x) => ({ ...x, range: { ...x.range, enabled: v } }))}
            />
          )}
          {m.type === 'radial' && (
            <Sliders recipe={recipe} specs={[{ label: t('adj.feather'), path: [...base, 'geometry', 'feather'], min: 0, max: 1, decimals: 2, neutral: 0.5 }]} />
          )}
          {m.type === 'color' ? (
            <Sliders recipe={recipe} specs={[{ label: t('masks.tolerance'), path: [...base, 'range', 'hueTolerance'], min: 0.02, max: 0.5, decimals: 2, neutral: 0.25 }]} />
          ) : (
            m.range.enabled && (
              <Sliders
                recipe={recipe}
                specs={[
                  { label: t('masks.rangeLow'), path: [...base, 'range', 'lumLow'], min: 0, max: 1, decimals: 2, neutral: 0 },
                  { label: t('masks.rangeHigh'), path: [...base, 'range', 'lumHigh'], min: 0, max: 1, decimals: 2, neutral: 1 },
                  { label: t('masks.smooth'), path: [...base, 'range', 'lumSmooth'], min: 0.01, max: 0.5, decimals: 2, neutral: 0.15 },
                ]}
              />
            )
          )}
        </>
      )}
      <SectionTitle title={t('tools.light')} />
      <Sliders
        recipe={recipe}
        specs={[
          { label: t('adj.exposure'), path: a('exposure'), min: -100, max: 100 },
          bipolar(t('adj.contrast'), a('contrast')),
          bipolar(t('adj.highlights'), a('highlights')),
          bipolar(t('adj.shadows'), a('shadows')),
          bipolar(t('adj.whites'), a('whites')),
          bipolar(t('adj.blacks'), a('blacks')),
        ]}
      />
      <SectionTitle title={t('tools.color')} />
      <Sliders
        recipe={recipe}
        specs={[
          bipolar(t('adj.temperature'), a('temperature'), { gradient: ['#4D8DFF', '#E8E8E8', '#FFB03B'] }),
          bipolar(t('adj.tint'), a('tint'), { gradient: ['#4CD964', '#E8E8E8', '#E14CD9'] }),
          bipolar(t('adj.saturation'), a('saturation')),
        ]}
      />
      <SectionTitle title={t('tools.detail')} />
      <Sliders
        recipe={recipe}
        specs={[
          bipolar(t('adj.clarity'), a('clarity')),
          bipolar(t('adj.dehaze'), a('dehaze')),
          bipolar(t('adj.sharpness'), a('sharpness')),
          unipolar(t('adj.noise'), a('noise')),
          unipolar(t('adj.opacity'), [...base, 'opacity'], { neutral: 100 }),
        ]}
      />
    </>
  );
}

function BrushControls({ brush }: { brush: SharedValue<BrushSettings> }) {
  const { t } = useTranslation();
  // React state mirrors the shared value so the controls re-render.
  const [b, setB] = useState<BrushSettings>(() => brush.value);
  const set = (patch: Partial<BrushSettings>) => {
    const next = { ...b, ...patch };
    setB(next);
    brush.set(next);
  };
  return (
    <>
      <ChipRow>
        <Chip icon="brush" label={t('masks.brush')} active={!b.erase} onPress={() => set({ erase: false })} />
        <Chip icon="remove-circle-outline" label={t('masks.erase')} active={b.erase} onPress={() => set({ erase: true })} />
      </ChipRow>
      <Slider label={t('masks.size')} min={1} max={30} neutral={6} value={b.size * 100} onCommit={(v) => set({ size: v / 100 })} />
      <Slider label={t('masks.hardness')} min={0} max={100} neutral={50} value={b.hardness * 100} onCommit={(v) => set({ hardness: v / 100 })} />
      <Slider label={t('masks.flow')} min={5} max={100} neutral={80} value={b.flow * 100} onCommit={(v) => set({ flow: v / 100 })} />
    </>
  );
}

const styles = StyleSheet.create({
  maskList: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  maskItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    maxWidth: 170,
  },
  maskOn: { borderWidth: 1.5, borderColor: colors.accent },
  maskName: { color: colors.text, fontSize: font.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: space.md },
  kind: { width: '33.33%', alignItems: 'center', paddingVertical: space.md, gap: 6 },
  kindText: { color: colors.textDim, fontSize: font.xs, textAlign: 'center' },
  empty: { color: colors.textDim, fontSize: font.sm, textAlign: 'center', padding: space.lg },
  actions: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md },
});
