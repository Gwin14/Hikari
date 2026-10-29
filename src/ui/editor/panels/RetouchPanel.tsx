import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type { Recipe } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { Chip, SectionTitle, ToggleRow } from '../../kit';
import { Slider } from '../../Slider';
import { colors, font, radius, space } from '../../theme';
import type { BrushSettings } from '../EditorCanvas';

/** Content-aware object removal: paint over a distraction and it is rebuilt from its surroundings. */
export function RetouchPanel({ recipe, brush }: { recipe: Recipe; brush: SharedValue<BrushSettings> }) {
  const { t } = useTranslation();
  const busy = useEditor((s) => s.retouchBusy);
  const objects = useEditor((s) => s.removeObjects);
  const { removeRetouch, clearRetouch, setRemoveObjects } = useEditor.getState();
  const [size, setSize] = useState(() => brush.value.size);

  return (
    <>
      <View style={styles.status}>
        {busy ? (
          <>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.hint}>{t('retouch.working')}</Text>
          </>
        ) : (
          <Text style={styles.hint}>{t('retouch.hint')}</Text>
        )}
      </View>
      <ToggleRow label={t('retouch.objectAware')} hint={t('retouch.objectAwareHint')} value={objects} onChange={setRemoveObjects} />
      <Slider
        label={t('masks.size')}
        min={1}
        max={30}
        neutral={6}
        value={size * 100}
        onCommit={(v) => {
          setSize(v / 100);
          brush.set({ ...brush.value, size: v / 100, erase: false });
        }}
      />
      <SectionTitle
        title={t('retouch.spots', { count: recipe.retouch.length })}
        right={
          recipe.retouch.length > 0 ? <Chip icon="trash-outline" label={t('retouch.clear')} color={colors.danger} onPress={clearRetouch} /> : undefined
        }
      />
      {recipe.retouch.length === 0 ? (
        <Text style={styles.empty}>{t('retouch.empty')}</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.list}>
          {recipe.retouch.map((spot, i) => (
            <View key={spot.id} style={styles.spot}>
              <Ionicons name={spot.objectAware ? 'scan-outline' : 'bandage-outline'} size={18} color={colors.text} />
              <Text style={styles.spotName}>{t('retouch.spot', { n: i + 1 })}</Text>
              <Pressable hitSlop={10} onPress={() => removeRetouch(spot.id)} accessibilityLabel={t('common.delete')}>
                <Ionicons name="close-circle" size={18} color={colors.textDim} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.md, minHeight: 44 },
  hint: { color: colors.textDim, fontSize: font.sm, textAlign: 'center', flexShrink: 1 },
  empty: { color: colors.textDim, fontSize: font.sm, textAlign: 'center', padding: space.lg },
  list: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  spot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
  },
  spotName: { color: colors.text, fontSize: font.sm },
});
