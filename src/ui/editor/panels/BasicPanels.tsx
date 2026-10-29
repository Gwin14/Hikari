import * as DocumentPicker from 'expo-document-picker';
import { isNativeAvailable } from 'hikari-native';
import { useMemo, useState, type ReactNode } from 'react';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { listLuts } from '@/core/db/db';
import { HSL_BANDS, type HslBand, type ProfileId, type Recipe } from '@/core/recipe/schema';
import { useEditor } from '@/state/editor';
import { Chip, ChipRow, Segmented, SectionTitle, ToggleRow } from '../../kit';
import { ColorWheel } from '../ColorWheel';
import { colors, font, space } from '../../theme';
import { bipolar, Sliders, unipolar, useCommitPath } from './common';

const BAND_COLORS: Record<HslBand, string> = {
  red: '#FF4D4D',
  orange: '#FF9933',
  yellow: '#FFE040',
  green: '#4CD964',
  aqua: '#3FD9E0',
  blue: '#3F7BFF',
  purple: '#9A5CFF',
  magenta: '#FF4DD2',
};

export function LightPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  return (
    <Sliders
      recipe={recipe}
      specs={[
        { label: t('adj.exposure'), path: ['light', 'exposure'], min: -5, max: 5, decimals: 2, unit: 'EV' },
        bipolar(t('adj.contrast'), ['light', 'contrast']),
        bipolar(t('adj.highlights'), ['light', 'highlights']),
        bipolar(t('adj.shadows'), ['light', 'shadows']),
        bipolar(t('adj.whites'), ['light', 'whites']),
        bipolar(t('adj.blacks'), ['light', 'blacks']),
      ]}
    />
  );
}

const PROFILES: ProfileId[] = ['standard', 'vivid', 'neutral', 'flat', 'mono'];

export function ColorPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const commit = useCommitPath();
  return (
    <>
      <ChipRow>
        {PROFILES.map((p) => (
          <Chip key={p} label={t(`profiles.${p}`)} active={recipe.profile === p} onPress={() => commit(['profile'], p)} />
        ))}
      </ChipRow>
      <Sliders
        recipe={recipe}
        specs={[
          bipolar(t('adj.temperature'), ['color', 'temperature'], { gradient: ['#4D8DFF', '#E8E8E8', '#FFB03B'] }),
          bipolar(t('adj.tint'), ['color', 'tint'], { gradient: ['#4CD964', '#E8E8E8', '#E14CD9'] }),
          bipolar(t('adj.vibrance'), ['color', 'vibrance']),
          bipolar(t('adj.saturation'), ['color', 'saturation']),
        ]}
      />
    </>
  );
}

export function HslPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const [band, setBand] = useState<HslBand>('red');
  return (
    <>
      <View style={styles.bands}>
        {HSL_BANDS.map((b) => (
          <Pressable key={b} onPress={() => setBand(b)} style={[styles.band, band === b && styles.bandOn]}>
            <View style={[styles.bandDot, { backgroundColor: BAND_COLORS[b] }]} />
          </Pressable>
        ))}
      </View>
      <Text style={styles.bandName}>{t(`bands.${band}`)}</Text>
      <Sliders
        recipe={recipe}
        specs={[
          bipolar(t('adj.hue'), ['hsl', band, 'hue']),
          bipolar(t('adj.saturation'), ['hsl', band, 'sat']),
          bipolar(t('adj.luminance'), ['hsl', band, 'lum']),
        ]}
      />
    </>
  );
}

export function DetailPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  return (
    <Sliders
      recipe={recipe}
      specs={[
        bipolar(t('adj.clarity'), ['detail', 'clarity']),
        bipolar(t('adj.texture'), ['detail', 'texture']),
        bipolar(t('adj.dehaze'), ['detail', 'dehaze']),
        { label: t('adj.sharpenAmount'), path: ['detail', 'sharpenAmount'], min: 0, max: 150 },
        { label: t('adj.sharpenRadius'), path: ['detail', 'sharpenRadius'], min: 0.5, max: 3, neutral: 1, decimals: 1, step: 0.1 },
        unipolar(t('adj.sharpenDetail'), ['detail', 'sharpenDetail'], { neutral: 25 }),
        unipolar(t('adj.sharpenMasking'), ['detail', 'sharpenMasking']),
        unipolar(t('adj.noiseLuma'), ['detail', 'noiseLuma']),
        unipolar(t('adj.noiseColor'), ['detail', 'noiseColor']),
      ]}
    />
  );
}

export function OpticsPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  return (
    <Sliders
      recipe={recipe}
      specs={[
        bipolar(t('adj.distortion'), ['lens', 'distortion']),
        unipolar(t('adj.chromatic'), ['lens', 'chromatic']),
        bipolar(t('adj.vignetteCorrection'), ['lens', 'vignetteCorrection']),
      ]}
    />
  );
}

export function EffectsPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const commit = useCommitPath();
  const bw = recipe.effects.bw || recipe.profile === 'mono';
  return (
    <>
      <Sliders
        recipe={recipe}
        specs={[
          bipolar(t('adj.vignetteAmount'), ['effects', 'vignetteAmount']),
          unipolar(t('adj.vignetteMidpoint'), ['effects', 'vignetteMidpoint'], { neutral: 50 }),
          unipolar(t('adj.vignetteFeather'), ['effects', 'vignetteFeather'], { neutral: 50 }),
          bipolar(t('adj.vignetteRoundness'), ['effects', 'vignetteRoundness']),
          unipolar(t('adj.grainAmount'), ['effects', 'grainAmount']),
          unipolar(t('adj.grainSize'), ['effects', 'grainSize'], { neutral: 25 }),
          unipolar(t('adj.grainRoughness'), ['effects', 'grainRoughness'], { neutral: 50 }),
        ]}
      />
      <ToggleRow label={t('adj.bw')} value={recipe.effects.bw} onChange={(v) => commit(['effects', 'bw'], v)} />
      {bw && (
        <Sliders
          recipe={recipe}
          specs={HSL_BANDS.map((b) => bipolar(t(`bands.${b}`), ['effects', 'bwMix', b], { gradient: ['#111', BAND_COLORS[b], '#eee'] }))}
        />
      )}
    </>
  );
}

export function RawPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const commit = useCommitPath();
  const hasPair = useEditor((s) => s.hasPair);
  const setUseRaw = useEditor((s) => s.setUseRaw);
  const isRawSource = recipe.source.useRaw && (recipe.source.isRaw || !!recipe.source.pairedUri);
  return (
    <>
      {hasPair && (
        <View style={{ paddingHorizontal: space.lg, paddingVertical: space.sm }}>
          <Text style={styles.caption}>{t('editor.source')}</Text>
          <Segmented
            options={[
              { value: 'raw', label: t('editor.useRaw') },
              { value: 'jpeg', label: t('editor.useJpeg') },
            ]}
            value={recipe.source.useRaw ? 'raw' : 'jpeg'}
            onChange={(v) => setUseRaw(v === 'raw')}
          />
        </View>
      )}
      {!isNativeAvailable && <Text style={[styles.caption, { padding: space.lg }]}>{t('settings.nativeMissing')}</Text>}
      {isRawSource && (
        <>
          <Sliders
            recipe={recipe}
            specs={[
              unipolar(t('adj.boost'), ['raw', 'boost'], { neutral: 100 }),
              unipolar(t('adj.decodeNoise'), ['raw', 'decodeNoise']),
            ]}
          />
          <ToggleRow label={t('adj.highlightRecovery')} value={recipe.raw.highlightRecovery} onChange={(v) => commit(['raw', 'highlightRecovery'], v)} />
          <ToggleRow label={t('adj.lensCorrection')} value={recipe.raw.lensCorrection} onChange={(v) => commit(['raw', 'lensCorrection'], v)} />
        </>
      )}
    </>
  );
}

export function LutPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const commit = useCommitPath();
  const importLut = useEditor((s) => s.importLut);
  const [version, setVersion] = useState(0);
  const luts = useMemo(() => listLuts(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    try {
      await importLut(a.uri, a.name);
      setVersion((v) => v + 1);
    } catch {
      Alert.alert(t('lut.invalid'));
    }
  };
  return (
    <>
      <ChipRow>
        <Chip icon="add" label={t('lut.import')} onPress={pick} />
        <Chip label={t('lut.none')} active={!recipe.lut.id} onPress={() => commit(['lut'], { id: null, name: null, intensity: 100 })} />
        {luts.map((l) => (
          <Chip
            key={l.id}
            label={l.name}
            active={recipe.lut.id === l.id}
            onPress={() => commit(['lut'], { id: l.id, name: l.name, intensity: recipe.lut.intensity })}
          />
        ))}
      </ChipRow>
      {recipe.lut.id && <Sliders recipe={recipe} specs={[unipolar(t('adj.intensity'), ['lut', 'intensity'], { neutral: 100 })]} />}
    </>
  );
}

export function GradingPanel({ recipe }: { recipe: Recipe }) {
  const { t } = useTranslation();
  const [zone, setZone] = useState<'shadows' | 'midtones' | 'highlights' | 'global'>('midtones');
  return (
    <>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
        <Segmented
          options={(['shadows', 'midtones', 'highlights', 'global'] as const).map((z) => ({ value: z, label: t(`grading.${z}`) }))}
          value={zone}
          onChange={setZone}
        />
      </View>
      <ColorWheel key={zone} zone={zone} recipe={recipe} />
      <Sliders
        recipe={recipe}
        specs={[
          bipolar(t('adj.luminance'), ['grading', zone, 'lum']),
          unipolar(t('adj.blending'), ['grading', 'blending'], { neutral: 50 }),
          bipolar(t('adj.balance'), ['grading', 'balance']),
        ]}
      />
    </>
  );
}

export function PanelScroll({ children }: { children: ReactNode }) {
  return (
    // Gesture-handler ScrollView so sliders and the panel scroll negotiate the touch natively.
    <GestureScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.lg }} showsVerticalScrollIndicator={false}>
      {children}
    </GestureScrollView>
  );
}

export { SectionTitle };

const styles = StyleSheet.create({
  bands: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.md },
  band: { padding: 4, borderRadius: 16, borderWidth: 2, borderColor: 'transparent' },
  bandOn: { borderColor: colors.text },
  bandDot: { width: 22, height: 22, borderRadius: 11 },
  bandName: { color: colors.textDim, fontSize: font.sm, textAlign: 'center', marginTop: space.sm },
  caption: { color: colors.textDim, fontSize: font.sm, marginBottom: space.sm },
});
