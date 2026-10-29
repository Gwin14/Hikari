import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { memo, useEffect, useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { PhotoMeta } from '@/core/db/db';
import type { PhotoItem } from '@/core/sources/types';
import { cachedThumb, requestThumb } from '@/core/thumbs';
import { colors, font } from './theme';

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
  columns?: number;
}

/** The single photo grid used by both the Gallery and Folders modes. */
export function PhotoGrid(p: PhotoGridProps) {
  const { width } = useWindowDimensions();
  const columns = p.columns ?? (width > 900 ? 7 : width > 600 ? 5 : 3);
  const size = Math.floor((width - (columns - 1) * 2) / columns);
  return (
    <FlashList
      data={p.items}
      numColumns={columns}
      keyExtractor={(it) => it.key}
      extraData={[p.meta, p.selection, p.selecting, size]}
      onEndReached={p.onEndReached}
      onEndReachedThreshold={1.5}
      ListHeaderComponent={p.header}
      ListEmptyComponent={p.empty}
      contentContainerStyle={{ paddingBottom: 120 }}
      renderItem={({ item, index }) => (
        <Thumb
          item={item}
          size={size}
          meta={p.meta.get(item.key)}
          selected={p.selection.has(item.key)}
          selecting={p.selecting}
          onPress={() => p.onPress(item, index)}
          onLongPress={() => p.onLongPress(item)}
        />
      )}
    />
  );
}

const Thumb = memo(function Thumb(props: {
  item: PhotoItem;
  size: number;
  meta?: PhotoMeta;
  selected: boolean;
  selecting: boolean;
  onPress(): void;
  onLongPress(): void;
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
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={300}
      style={{ width: size, height: size, marginRight: 2, marginBottom: 2 }}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          recyclingKey={item.key}
          transition={120}
          cachePolicy="memory-disk"
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
    color: colors.text,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
  },
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
  selectedTint: { ...StyleSheet.absoluteFill, borderWidth: 2, borderColor: colors.accent },
});
