import { Canvas, Circle, Group, Line, Path, Skia, vec } from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

import { bakeCurveLut, buildSpline } from '@/core/color/curve';
import { makeRgbaImage } from '@/core/pipeline/render';
import type { CurvePoint, Curves, Recipe } from '@/core/recipe/schema';
import { liveInputs, useEditor } from '@/state/editor';
import { Segmented } from '../kit';
import { colors, font, space } from '../theme';

type Channel = keyof Curves;
const CH_COLOR: Record<Channel, string> = { rgb: '#FFFFFF', r: '#FF5A5F', g: '#4CD07D', b: '#4D9BFF' };
const HIT = 28;

export function CurveEditor({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<Channel>('rgb');
  const [size, setSize] = useState(280);
  const [points, setPointsState] = useState<CurvePoint[]>(recipe.curves[channel]);
  // Gesture callbacks read the latest points through a ref (state lags behind during drags).
  const pointsRef = useRef(points);
  const setPoints = (p: CurvePoint[]) => {
    pointsRef.current = p;
    setPointsState(p);
  };
  const dragIndex = useRef(-1);
  const lastBake = useRef(0);
  const histogram = useEditor((s) => s.histogram);

  // Re-sync when the committed curve changes (undo, presets, channel switch).
  const committed = recipe.curves[channel];
  const [synced, setSynced] = useState(committed);
  if (synced !== committed) {
    setSynced(committed);
    setPointsState(committed);
  }
  useEffect(() => {
    pointsRef.current = committed;
  }, [committed]);

  const toPx = (p: CurvePoint) => ({ x: p.x * size, y: (1 - p.y) * size });

  const path = useMemo(() => {
    const f = buildSpline(points);
    const pb = Skia.PathBuilder.Make();
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      const y = Math.max(0, Math.min(1, f(x)));
      if (i === 0) pb.moveTo(x * size, (1 - y) * size);
      else pb.lineTo(x * size, (1 - y) * size);
    }
    return pb.build();
  }, [points, size]);

  const histPath = useMemo(() => {
    if (!histogram) return null;
    const bins = channel === 'rgb' ? histogram.l : histogram[channel];
    let max = 1;
    for (let i = 2; i < 254; i++) max = Math.max(max, bins[i]);
    const pb = Skia.PathBuilder.Make();
    pb.moveTo(0, size);
    for (let i = 0; i < 256; i++) pb.lineTo((i / 255) * size, size - Math.min(1, bins[i] / max) * size * 0.9);
    pb.lineTo(size, size);
    pb.close();
    return pb.build();
  }, [histogram, channel, size]);

  /** Live preview: bake the LUT for the image without touching history. */
  const preview = (pts: CurvePoint[]) => {
    setPoints(pts);
    const now = performance.now(); // eslint-disable-line react-hooks/purity -- runs from gesture events
    if (now - lastBake.current < 32) return;
    lastBake.current = now;
    const inp = liveInputs.value;
    if (!inp) return;
    const curves = { ...recipe.curves, [channel]: pts };
    liveInputs.set({ ...inp, curve: makeRgbaImage(bakeCurveLut(curves), 256, 1) });
  };
  const commit = (pts: CurvePoint[]) => {
    useEditor.getState().update((r) => ({ ...r, curves: { ...r.curves, [channel]: pts } }));
  };

  const nearest = (x: number, y: number) => {
    let best = -1;
    let bestD = HIT;
    pointsRef.current.forEach((p, i) => {
      const q = toPx(p);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const begin = (x: number, y: number) => {
    let i = nearest(x, y);
    if (i < 0) {
      const nx = Math.max(0, Math.min(1, x / size));
      const ny = Math.max(0, Math.min(1, 1 - y / size));
      const next = [...pointsRef.current, { x: nx, y: ny }].sort((a, b) => a.x - b.x);
      i = next.findIndex((p) => p.x === nx && p.y === ny);
      setPoints(next);
      dragIndex.current = i;
      preview(next);
      return;
    }
    dragIndex.current = i;
  };
  const move = (x: number, y: number) => {
    const i = dragIndex.current;
    if (i < 0) return;
    const next = [...pointsRef.current];
    const lo = i > 0 ? next[i - 1].x + 0.01 : 0;
    const hi = i < next.length - 1 ? next[i + 1].x - 0.01 : 1;
    const nx = Math.max(lo, Math.min(hi, x / size));
    next[i] = { x: nx, y: Math.max(0, Math.min(1, 1 - y / size)) };
    preview(next);
  };
  const end = () => {
    dragIndex.current = -1;
    commit(pointsRef.current);
  };
  const remove = (x: number, y: number) => {
    const i = nearest(x, y);
    const pts = pointsRef.current;
    if (i <= 0 || i >= pts.length - 1) return;
    const next = pts.filter((_, j) => j !== i);
    setPoints(next);
    commit(next);
  };

  /* eslint-disable react-hooks/refs -- callbacks run on gesture events, not during render */
  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => scheduleOnRN(begin, e.x, e.y))
    .onUpdate((e) => scheduleOnRN(move, e.x, e.y))
    .onFinalize(() => scheduleOnRN(end));
  const dbl = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => scheduleOnRN(remove, e.x, e.y));
  /* eslint-enable react-hooks/refs */

  const onLayout = (e: LayoutChangeEvent) => setSize(Math.min(e.nativeEvent.layout.width, 320));

  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
      <Segmented
        options={(['rgb', 'r', 'g', 'b'] as const).map((c) => ({ value: c, label: t(`curves.${c}`) }))}
        value={channel}
        onChange={setChannel}
      />
      <View style={styles.box} onLayout={onLayout}>
        <GestureDetector gesture={Gesture.Simultaneous(pan, dbl)}>
          <View style={{ width: size, height: size }}>
            <Canvas style={{ width: size, height: size }}>
              <Group>
                {[0.25, 0.5, 0.75].map((g) => (
                  <Group key={g}>
                    <Line p1={vec(g * size, 0)} p2={vec(g * size, size)} color={colors.border} strokeWidth={1} />
                    <Line p1={vec(0, g * size)} p2={vec(size, g * size)} color={colors.border} strokeWidth={1} />
                  </Group>
                ))}
                <Line p1={vec(0, size)} p2={vec(size, 0)} color={colors.surface3} strokeWidth={1} />
                {histPath && <Path path={histPath} color="rgba(255,255,255,0.08)" />}
                <Path path={path} style="stroke" strokeWidth={2} color={CH_COLOR[channel]} />
                {points.map((p, i) => {
                  const q = toPx(p);
                  return <Circle key={i} cx={q.x} cy={q.y} r={6} color={CH_COLOR[channel]} />;
                })}
              </Group>
            </Canvas>
          </View>
        </GestureDetector>
      </View>
      <Text style={styles.hint}>{t('curves.hint')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', marginTop: space.md, backgroundColor: colors.surface, borderRadius: 8, overflow: 'hidden' },
  hint: { color: colors.textFaint, fontSize: font.xs, textAlign: 'center', marginTop: space.sm },
});
