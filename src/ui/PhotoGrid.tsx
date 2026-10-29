import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import type { PhotoMeta } from '@/core/db/db';
import type { PhotoItem } from '@/core/sources/types';
import { cachedThumb, requestThumb } from '@/core/thumbs';
import { colors, font, radius } from './theme';

const LABEL_COLORS: Record<string, string> = {
  red: '#FF5A5F',
  yellow: '#FFD23F',
  green: '#4CD07D',
  blue: '#4D9BFF',
  purple: '#B57BFF',
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
  /** Show placeholder cells instead of `empty` while the first page loads. */
  loading?: boolean;
  columns?: number;
}

const GAP = 2;

/** The single photo grid used by both the Gallery and Folders modes. */
export function PhotoGrid(p: PhotoGridProps) {
  const { width } = useWindowDimensions();
  const columns = p.columns ?? (width > 900 ? 7 : width > 600 ? 5 : 4);
  const size = Math.floor((width - (columns - 1) * GAP) / columns);
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
      keyExtractor={(it) => it.key}
      extraData={[p.meta, p.selection, p.selecting, size]}
      onEndReached={p.onEndReached}
      onEndReachedThreshold={1.5}
      drawDistance={size * 6}
      ListHeaderComponent={p.header}
      ListEmptyComponent={showSkeleton ? <Skeleton size={size} columns={columns} /> : p.empty}
      contentContainerStyle={{ paddingBottom: 140 }}
      renderItem={({ item, index }) => (
        <Thumb
          item={item}
          index={index}
          size={size}
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

/** Pulsing placeholder cells shown while the first page of photos is listed. */
function Skeleton({ size, columns }: { size: number; columns: number }) {
  const pulse = useSharedValue(0.35);
  useEffect(() => {
    pulse.set(withRepeat(withTiming(0.7, { duration: 700 }), -1, true));
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View style={[styles.skeleton, style]}>
      {Array.from({ length: columns * 6 }, (_, i) => (
        <View key={i} style={{ width: size, height: size, backgroundColor: colors.surface2 }} />
      ))}
    </Animated.View>
  );
}

const Thumb = memo(function Thumb(props: {
  item: PhotoItem;
  index: number;
  size: number;
  meta?: PhotoMeta;
  selected: boolean;
  selecting: boolean;
  onPress(item: PhotoItem, index: number): void;
  onLongPress(item: PhotoItem): void;
}) {
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
  return (
    <Pressable
      onPress={() => props.onPress(item, props.index)}
      onLongPress={() => props.onLongPress(item)}
      delayLongPress={300}
      style={({ pressed }) => [{ width: size, height: size, marginBottom: GAP, opacity: pressed ? 0.75 : 1 }]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          recyclingKey={item.key}
          transition={{ duration: 150, skipOnCacheHit: 'memory' }}
          cachePolicy="memory-disk"
          priority="high"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
          <Text style={styles.placeholderText}>{item.filename.split('.').pop()?.toUpperCase()}</Text>
        </View>
      )}
      {meta?.flag === -1 && <View style={styles.rejected} />}
      <View style={styles.badges}>
        {item.pair ? (
          <Text style={styles.badge}>RAW+J</Text>
        ) : item.isRaw ? (
          <Text style={styles.badge}>RAW</Text>
        ) : null}
        {meta?.edited ? <Ionicons name="color-wand" size={12} color={colors.text} style={styles.icon} /> : null}
      </View>
      <View style={styles.bottom}>
        {meta?.rating ? <Text style={styles.stars}>{'★'.repeat(meta.rating)}</Text> : null}
        {meta?.flag === 1 ? <Ionicons name="flag" size={11} color={colors.accent} /> : null}
        {meta?.label ? <View style={[styles.label, { backgroundColor: LABEL_COLORS[meta.label] }]} /> : null}
      </View>
      {props.selecting && (
        <View style={[styles.check, props.selected && styles.checkOn]}>
          {props.selected && <Ionicons name="checkmark" size={14} color={colors.bg} />}
        </View>
      )}
      {props.selected && <View style={styles.selectedTint} pointerEvents="none" />}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  placeholder: { backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: colors.textFaint, fontSize: font.xs, fontWeight: '700' },
  badges: { position: 'absolute', top: 4, left: 4, flexDirection: 'row', gap: 4, alignItems: 'center' },
  badge: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.3,
    color: colors.text,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  skeleton: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  icon: { textShadowColor: '#000', textShadowRadius: 3 },
  bottom: { position: 'absolute', bottom: 3, left: 4, right: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  stars: { color: colors.accent, fontSize: 10, textShadowColor: '#000', textShadowRadius: 2 },
  label: { width: 8, height: 8, borderRadius: 4, marginLeft: 'auto' },
  rejected: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)' },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  selectedTint: { ...StyleSheet.absoluteFill, borderWidth: 3, borderColor: colors.accent, backgroundColor: 'rgba(255,181,71,0.12)' },
});
