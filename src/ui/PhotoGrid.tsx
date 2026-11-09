import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import type { PhotoMeta } from '@/core/db/db';
import type { PhotoItem } from '@/core/sources/types';
import { cachedThumb, requestThumb } from '@/core/thumbs';
import { usePrefNumber } from '@/state/prefs';
import { Icon } from './Icon';
import { radius, space, tabular, type, useStyles, useTheme, type Palette } from './theme';

/** Lightroom-compatible colour labels: content colours, not UI accents. */
export const LABEL_COLORS: Record<string, string> = {
  red: '#FF453A',
  yellow: '#FFD60A',
  green: '#30D158',
  blue: '#0A84FF',
  purple: '#BF5AF2',
};

export interface PhotoGridProps {
  items: PhotoItem[];
  meta: Map<string, PhotoMeta>;
  selection: Set<string>;
  selecting: boolean;
  onPress(item: PhotoItem, index: number): void;
  onLongPress(item: PhotoItem): void;
  onEndReached?: () => void;
  header?: ReactElement | null;
  empty?: ReactElement | null;
  footer?: ReactElement | null;
  /** Show placeholder cells instead of `empty` while the first page loads. */
  loading?: boolean;
}

const GAP = 2;

/** Columns on a phone in portrait; wider windows add columns at the same cell size. */
export const DENSITIES = [3, 4, 5] as const;
export function useGridDensity() {
  const [value, set] = usePrefNumber('gridColumns');
  return [DENSITIES.includes(value as 3) ? (value as number) : 4, set] as const;
}

/** The single photo grid used by both the Library and Folders. */
export function PhotoGrid(p: PhotoGridProps) {
  const c = useTheme();
  const { width } = useWindowDimensions();
  const [density] = useGridDensity();
  const columns = Math.max(density, Math.round(width / (390 / density)));
  const size = (width - (columns - 1) * GAP) / columns;
  // Cells get stable callbacks so memoized thumbnails only re-render when their own data changes.
  const handlers = useRef(p);
  useLayoutEffect(() => {
    handlers.current = p;
  });
  const onPress = useCallback((item: PhotoItem, index: number) => handlers.current.onPress(item, index), []);
  const onLongPress = useCallback((item: PhotoItem) => handlers.current.onLongPress(item), []);
  const showSkeleton = p.loading && p.items.length === 0;
  return (
    <FlashList
      data={p.items}
      numColumns={columns}
      key={columns}
      keyExtractor={(it) => it.key}
      extraData={[p.meta, p.selection, p.selecting, size]}
      onEndReached={p.onEndReached}
      onEndReachedThreshold={1.5}
      drawDistance={size * 6}
      style={{ backgroundColor: c.bg }}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustsScrollIndicatorInsets
      ListHeaderComponent={p.header}
      ListFooterComponent={p.items.length ? p.footer : null}
      ListEmptyComponent={showSkeleton ? <Skeleton size={size} columns={columns} /> : p.empty}
      contentContainerStyle={{ paddingBottom: space.xxxl }}
      renderItem={({ item, index }) => (
        <Thumb
          item={item}
          index={index}
          size={size}
          column={index % columns}
          columns={columns}
          meta={p.meta.get(item.key)}
          selected={p.selection.has(item.key)}
          selecting={p.selecting}
          onPress={onPress}
          onLongPress={onLongPress}
        />
      )}
    />
  );
}

/** Placeholder cells in the grid's exact shape, breathing while the first page is listed. */
function Skeleton({ size, columns }: { size: number; columns: number }) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (!reduceMotion) pulse.set(withRepeat(withTiming(0.55, { duration: 900 }), -1, true));
  }, [pulse, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.get() }));
  return (
    <Animated.View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP }, style]} accessibilityLabel="…">
      {Array.from({ length: columns * 7 }, (_, i) => (
        <View key={i} style={{ width: size - 0.01, height: size, backgroundColor: c.surface2 }} />
      ))}
    </Animated.View>
  );
}

/** Centered count under the grid, like Photos. */
export function GridFooter({ label }: { label: string }) {
  const s = useStyles(makeStyles);
  return <Text style={s.footer}>{label}</Text>;
}

const Thumb = memo(function Thumb(props: {
  item: PhotoItem;
  index: number;
  size: number;
  column: number;
  columns: number;
  meta?: PhotoMeta;
  selected: boolean;
  selecting: boolean;
  onPress(item: PhotoItem, index: number): void;
  onLongPress(item: PhotoItem): void;
}) {
  const c = useTheme();
  const s = useStyles(makeStyles);
  const { item, meta, size } = props;
  const [generated, setGenerated] = useState<string | null>(() => (item.thumbUri ? null : cachedThumb(item)));
  useEffect(() => {
    if (item.thumbUri || generated || meta?.thumb) return;
    let alive = true;
    requestThumb(item).then((u) => alive && setGenerated(u));
    return () => {
      alive = false;
    };
  }, [item, generated, meta?.thumb]);

  const uri = meta?.thumb ?? item.thumbUri ?? generated;
  const ext = item.filename.split('.').pop()?.toUpperCase();
  const format = item.pair ? 'RAW+J' : item.isRaw ? 'RAW' : null;
  const rating = meta?.rating ?? 0;
  // Each column slot is width/columns; padding splits the gaps so cells are equal and edges flush.
  const inset = { paddingLeft: (props.column * GAP) / props.columns, paddingRight: ((props.columns - 1 - props.column) * GAP) / props.columns };
  return (
    <View style={[inset, { paddingBottom: GAP }]}>
    <Pressable
      onPress={() => props.onPress(item, props.index)}
      onLongPress={() => props.onLongPress(item)}
      delayLongPress={280}
      accessibilityRole="imagebutton"
      accessibilityLabel={item.filename}
      accessibilityState={props.selecting ? { selected: props.selected } : undefined}
      style={{ width: size, height: size }}
    >
      {({ pressed }) => (
        <>
          {uri ? (
            <Image
              source={{ uri }}
              style={[StyleSheet.absoluteFill, { backgroundColor: c.surface2 }]}
              contentFit="cover"
              recyclingKey={item.key}
              transition={{ duration: 120, skipOnCacheHit: 'memory' }}
              cachePolicy="memory-disk"
              priority="high"
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, s.placeholder]}>
              <Text style={s.placeholderText}>{ext}</Text>
            </View>
          )}
          {meta?.flag === -1 && <View style={s.rejected} />}
          {(pressed || (props.selecting && props.selected)) && <View style={s.dim} pointerEvents="none" />}

          {meta?.label ? <View style={[s.label, { backgroundColor: LABEL_COLORS[meta.label] }]} /> : null}
          {meta?.edited ? (
            <View style={s.topRight}>
              <Icon name="edited" size={12} color="#FFFFFF" weight="semibold" />
            </View>
          ) : null}

          <View style={[s.bottomRow, props.selecting && { right: 32 }]} pointerEvents="none">
            {format ? (
              <Text style={s.badge} numberOfLines={1}>
                {format}
              </Text>
            ) : null}
            {rating > 0 ? (
              <View style={s.rating}>
                <Icon name="star" size={9} color="#FFFFFF" />
                <Text style={s.ratingText}>{rating}</Text>
              </View>
            ) : null}
            {meta?.flag === 1 ? <Icon name="flag" size={11} color={c.accent} /> : null}
            {meta?.flag === -1 ? <Icon name="reject" size={12} color="#FFFFFF" /> : null}
          </View>

          {props.selecting && (
            <View style={[s.check, props.selected && s.checkOn]}>
              {props.selected && <Icon name="check" size={12} color={c.onAccent} weight="bold" />}
            </View>
          )}
        </>
      )}
    </Pressable>
    </View>
  );
});

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    placeholder: { backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center' },
    placeholderText: { color: c.textFaint, ...type.caption2, fontWeight: '700' },
    rejected: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)' },
    dim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.22)' },
    topRight: {
      position: 'absolute',
      top: space.xs,
      right: space.xs,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: 'rgba(0,0,0,0.45)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    bottomRow: { position: 'absolute', left: space.xs, right: space.xs, bottom: space.xs, flexDirection: 'row', alignItems: 'center', gap: space.xs, overflow: 'hidden' },
    badge: {
      ...type.caption2,
      fontSize: 9,
      lineHeight: 12,
      fontWeight: '700',
      letterSpacing: 0.4,
      color: '#FFFFFF',
      backgroundColor: 'rgba(0,0,0,0.45)',
      paddingHorizontal: 5,
      paddingVertical: 1,
      borderRadius: radius.badge,
      borderCurve: 'continuous',
      overflow: 'hidden',
      flexShrink: 0,
    },
    rating: {
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      backgroundColor: 'rgba(0,0,0,0.45)',
      paddingHorizontal: 5,
      paddingVertical: 1,
      borderRadius: radius.badge,
      borderCurve: 'continuous',
    },
    ratingText: { ...type.caption2, fontSize: 10, lineHeight: 12, fontWeight: '700', color: '#FFFFFF', ...tabular },
    label: { position: 'absolute', top: space.xs + 2, left: space.xs + 2, width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
    check: {
      position: 'absolute',
      right: space.xs + 2,
      bottom: space.xs + 2,
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: '#FFFFFF',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.2)',
    },
    checkOn: { backgroundColor: c.accent, borderColor: '#FFFFFF' },
    footer: { color: c.textDim, ...type.footnote, fontWeight: '600', textAlign: 'center', paddingVertical: space.xl, ...tabular },
  });
