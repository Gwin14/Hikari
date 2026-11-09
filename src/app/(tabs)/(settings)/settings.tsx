import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { isNativeAvailable } from 'hikari-native';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { clearThumbRefs } from '@/core/db/db';
import { clearThumbCaches } from '@/core/thumbs';
import { LANGUAGES, setLanguage } from '@/i18n';
import { prefs, usePrefBool, usePrefString, type PreviewQuality } from '@/state/prefs';
import { Notice } from '@/ui/BrowserChrome';
import { Field, Group, ListRow, Segmented, ToggleRow } from '@/ui/kit';
import { curve, space, type, useStyles, useTheme, type AppearancePref, type Palette } from '@/ui/theme';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const c = useTheme();
  const s = useStyles(makeStyles);
  const [appearance, setAppearance] = usePrefString('appearance');
  const [language] = usePrefString('language');
  const [quality, setQuality] = usePrefString('previewQuality');
  const [haptics, setHaptics] = usePrefBool('haptics');
  const [rawDefault, setRawDefault] = usePrefBool('rawDefault');
  const [sidecars, setSidecars] = usePrefBool('writeSidecars');
  const [artist, setArtist] = usePrefString('defaultArtist');
  const [copyright, setCopyright] = usePrefString('defaultCopyright');

  const clearCache = () =>
    Alert.alert(t('settings.cache'), t('settings.cacheHint'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.cacheClear'),
        style: 'destructive',
        onPress: () => {
          clearThumbCaches();
          clearThumbRefs();
          prefs.remove('export.last');
        },
      },
    ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={s.content}
    >
      <Stack.Title>{t('settings.title')}</Stack.Title>
      {!isNativeAvailable && <Notice label={t('settings.nativeMissing')} />}

      <Group title={t('settings.appearance')}>
        <View style={s.padded}>
          <Segmented
            options={[
              { value: 'system', label: t('settings.system') },
              { value: 'light', label: t('settings.light') },
              { value: 'dark', label: t('settings.dark') },
            ]}
            value={(appearance as AppearancePref) ?? 'system'}
            onChange={(v) => setAppearance(v)}
          />
        </View>
      </Group>

      <Group title={t('settings.language')}>
        {LANGUAGES.map((l) => (
          <ListRow key={l.code} label={l.label ?? t('settings.system')} selected={(language ?? 'system') === l.code} onPress={() => setLanguage(l.code)} />
        ))}
      </Group>

      <Group title={t('settings.editing')} footer={t('settings.previewHint')}>
        <View style={[s.padded, { gap: space.sm }]}>
          <Text style={s.label}>{t('settings.previewQuality')}</Text>
          <Segmented
            options={[
              { value: 'fast', label: t('settings.previewFast') },
              { value: 'balanced', label: t('settings.previewBalanced') },
              { value: 'high', label: t('settings.previewHigh') },
            ]}
            value={(quality as PreviewQuality) ?? 'balanced'}
            onChange={(v) => setQuality(v)}
          />
        </View>
        <ToggleRow icon="raw" label={t('settings.rawDefault')} value={rawDefault ?? true} onChange={setRawDefault} />
        <ToggleRow icon="sidecar" label={t('settings.writeSidecars')} value={sidecars ?? true} onChange={setSidecars} />
        <ToggleRow icon="haptics" label={t('settings.haptics')} value={haptics ?? true} onChange={setHaptics} />
      </Group>

      <Group title={t('export.metadata')} footer={t('settings.metadataHint')}>
        <View style={[s.padded, { gap: space.md }]}>
          <Field
            label={t('settings.defaultArtist')}
            defaultValue={artist ?? ''}
            onChangeText={setArtist}
            textContentType="name"
            autoComplete="name"
            autoCapitalize="words"
            returnKeyType="next"
          />
          <Field label={t('settings.defaultCopyright')} defaultValue={copyright ?? ''} onChangeText={setCopyright} placeholder="© 2026" returnKeyType="done" />
        </View>
      </Group>

      <Group>
        <ListRow icon="cache" label={t('settings.cache')} destructive onPress={clearCache} chevron={false} />
      </Group>

      <View style={s.about}>
        <Image source={require('../../../../assets/icon.png')} style={s.icon} contentFit="cover" accessibilityIgnoresInvertColors />
        <Text style={s.appName}>Hikari</Text>
        <Text style={s.version} selectable>
          {t('settings.version', { v: Constants.expoConfig?.version ?? '1.0.0' })}
        </Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: space.lg, gap: space.xxl, paddingBottom: space.xxxl * 2 },
    padded: { paddingHorizontal: space.lg, paddingVertical: space.md },
    label: { color: c.textDim, ...type.footnote, fontWeight: '500' },
    about: { alignItems: 'center', gap: space.xs, paddingTop: space.sm },
    icon: { width: 64, height: 64, borderRadius: 15, ...curve, marginBottom: space.sm },
    appName: { color: c.text, ...type.headline },
    version: { color: c.textDim, ...type.footnote },
  });
