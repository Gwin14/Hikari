import { Canvas, Group, Path, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Histogram } from '@/core/auto/analysis';
import { useEditor } from '@/state/editor';
import { colors } from '../theme';

const W = 132;
const H = 56;

function binsPath(bins: Uint32Array, max: number) {
  const pb = Skia.PathBuilder.Make();
  pb.moveTo(0, H);
  for (let i = 0; i < 256; i++) pb.lineTo((i / 255) * W, H - Math.min(1, bins[i] / max) * H);
  pb.lineTo(W, H);
  pb.close();
  return pb.build();
}

/** Compact RGB histogram with clipping indicators; tap toggles the clipping overlay. */
export function HistogramView({ histogram }: { histogram: Histogram | null }) {
  const showClipping = useEditor((s) => s.showClipping);
  const toggle = useEditor((s) => s.toggleClipping);
  const paths = useMemo(() => {
    if (!histogram) return null;
    let max = 1;
    for (let i = 3; i < 253; i++) max = Math.max(max, histogram.r[i], histogram.g[i], histogram.b[i]);
    return { r: binsPath(histogram.r, max), g: binsPath(histogram.g, max), b: binsPath(histogram.b, max) };
  }, [histogram]);
  if (!paths || !histogram) return null;
  return (
    <Pressable onPress={toggle} style={styles.wrap}>
      <Canvas style={{ width: W, height: H }}>
        <Group blendMode="screen">
          <Path path={paths.r} color="rgba(255,70,70,0.75)" />
          <Path path={paths.g} color="rgba(70,220,110,0.75)" />
          <Path path={paths.b} color="rgba(80,140,255,0.75)" />
        </Group>
      </Canvas>
      <View style={[styles.clip, { left: 2, backgroundColor: histogram.clipLow > 0.005 ? colors.blue : colors.surface3 }, showClipping && styles.on]} />
      <View style={[styles.clip, { right: 2, backgroundColor: histogram.clipHigh > 0.005 ? colors.red : colors.surface3 }, showClipping && styles.on]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: W, height: H, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 6, overflow: 'hidden' },
  clip: { position: 'absolute', top: 2, width: 8, height: 8, borderRadius: 2 },
  on: { borderWidth: 1, borderColor: colors.text },
});
