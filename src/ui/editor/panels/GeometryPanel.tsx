import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { rotatedSize } from '@/core/pipeline/geometry';
import type { Recipe } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { Chip, ChipRow, IconButton } from '../../kit';
import { space } from '../../theme';
import { Sliders } from './common';

const ASPECTS: { label: string; value: number | 'original' | null }[] = [
  { label: 'free', value: null },
  { label: 'original', value: 'original' },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '5:4', value: 5 / 4 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '1.85:1', value: 1.85 },
  { label: '2.39:1', value: 2.39 },
];

/** Largest centered crop of the given pixel aspect inside the rotated frame. */
function fitAspect(aspect: number, fw: number, fh: number) {
  const frame = fw / fh;
  let w = 1;
  let h = 1;
  if (aspect > frame) h = frame / aspect;
  else w = aspect / frame;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

export function GeometryPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const update = useEditor((s) => s.update);
  const inputs = useEditor((s) => s.inputs);
  const g = recipe.geometry;

  const setAspect = (a: number | 'original' | null) => {
    if (!inputs) return;
    update((r) => {
      const [fw, fh] = rotatedSize(inputs.frame.width, inputs.frame.height, r.geometry.rotate90);
      const value = a === 'original' ? fw / fh : a;
      return {
        ...r,
        geometry: { ...r.geometry, aspect: value, crop: value ? fitAspect(value, fw, fh) : r.geometry.crop },
      };
    });
  };

  const rotate = () =>
    update((r) => ({
      ...r,
      geometry: {
        ...r.geometry,
        rotate90: ((r.geometry.rotate90 + 3) % 4) as 0 | 1 | 2 | 3,
        // keep the aspect lock meaningful after a quarter turn
        aspect: r.geometry.aspect ? 1 / r.geometry.aspect : null,
        crop: { x: r.geometry.crop.y, y: 1 - r.geometry.crop.x - r.geometry.crop.w, w: r.geometry.crop.h, h: r.geometry.crop.w },
      },
    }));

  const isActive = (v: number | 'original' | null) => {
    if (v === null) return g.aspect === null;
    if (!inputs || g.aspect === null) return false;
    const [fw, fh] = rotatedSize(inputs.frame.width, inputs.frame.height, g.rotate90);
    const target = v === 'original' ? fw / fh : v;
    return Math.abs(target - g.aspect) < 0.005;
  };

  return (
    <>
      <View style={styles.actions}>
        <IconButton icon="refresh" onPress={rotate} label={t('geometry.rotateLeft')} />
        <IconButton icon="swap-horizontal" active={g.flipH} onPress={() => update((r) => ({ ...r, geometry: { ...r.geometry, flipH: !r.geometry.flipH } }))} />
        <IconButton icon="swap-vertical" active={g.flipV} onPress={() => update((r) => ({ ...r, geometry: { ...r.geometry, flipV: !r.geometry.flipV } }))} />
        <View style={{ flex: 1 }} />
        <IconButton
          icon="scan-outline"
          onPress={() => update((r) => ({ ...r, geometry: { ...r.geometry, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: null, straighten: 0, perspectiveH: 0, perspectiveV: 0 } }))}
          label={t('geometry.resetCrop')}
        />
      </View>
      <ChipRow>
        {ASPECTS.map((a) => (
          <Chip
            key={a.label}
            label={a.label === 'free' ? t('geometry.free') : a.label === 'original' ? t('geometry.original') : a.label}
            active={isActive(a.value)}
            onPress={() => setAspect(a.value)}
          />
        ))}
      </ChipRow>
      <Sliders
        recipe={recipe}
        specs={[
          { label: t('adj.straighten'), path: ['geometry', 'straighten'], min: -45, max: 45, decimals: 1, unit: '°' },
          { label: t('adj.perspectiveV'), path: ['geometry', 'perspectiveV'], min: -100, max: 100 },
          { label: t('adj.perspectiveH'), path: ['geometry', 'perspectiveH'], min: -100, max: 100 },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingTop: space.sm },
});
