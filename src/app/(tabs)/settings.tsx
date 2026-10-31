import Constants from 'expo-constants';
import { isNativeAvailable } from 'hikari-native';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { clearThumbRefs } from '@/core/db/db';
import { clearThumbCaches } from '@/core/thumbs';
import { LANGUAGES, setLanguage } from '@/i18n';
import { prefs, usePrefBool, usePrefString, type PreviewQuality } from '@/state/prefs';
import { BrowserHeader } from '@/ui/BrowserChrome';
import { Card, Field, ListRow, SectionTitle, Segmented, ToggleRow } from '@/ui/kit';
import { colors, common, font, space } from '@/ui/theme';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const [language] = usePrefString('language');
  const [quality, setQuality] = usePrefString('previewQuality');
  const [haptics, setHaptics] = usePrefBool('haptics');
  const [rawDefault, setRawDefault] = usePrefBool('rawDefault');
  const [sidecars, setSidecars] = usePrefBool('writeSidecars');
  const [artist, setArtist] = usePrefString('defaultArtist');
  const [copyright, setCopyright] = usePrefString('defaultCopyright');

  return (
    <View style={common.screen}>
      <BrowserHeader title={t('settings.title')} />
      <ScrollView keyboardDismissMode="interactive" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 120 }}>
        {!isNativeAvailable && (
          <Card style={{ padding: space.md }}>
            <Text style={{ color: colors.accent, fontSize: font.sm }}>{t('settings.nativeMissing')}</Text>
          </Card>
        )}
        <SectionTitle title={t('settings.language')} />
        <Card>
          {LANGUAGES.map((l) => (
            <ListRow
              key={l.code}
              label={l.label ?? t('settings.system')}
              selected={(language ?? 'system') === l.code}
              chevron={false}
              onPress={() => setLanguage(l.code)}
            />
          ))}
        </Card>

        <SectionTitle title={t('settings.editing')} />
        <Card>
          <View style={{ padding: space.lg, gap: space.sm }}>
            <Text style={common.label}>{t('settings.previewQuality')}</Text>
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
          <ToggleRow label={t('settings.rawDefault')} value={rawDefault ?? true} onChange={setRawDefault} />
          <ToggleRow label={t('settings.writeSidecars')} value={sidecars ?? true} onChange={setSidecars} />
          <ToggleRow label={t('settings.haptics')} value={haptics ?? true} onChange={setHaptics} />
        </Card>

        <SectionTitle title={t('export.metadata')} />
        <Card style={{ padding: space.lg, gap: space.md }}>
          <Field
            label={t('settings.defaultArtist')}
            defaultValue={artist ?? ''}
            onChangeText={setArtist}
            textContentType="name"
            autoComplete="name"
            autoCapitalize="words"
            returnKeyType="next"
          />
          <Field label={t('settings.defaultCopyright')} defaultValue={copyright ?? ''} onChangeText={setCopyright} placeholder="© 2026" />
        </Card>

        <Card>
          <ListRow
            icon="trash-outline"
            label={t('settings.cache')}
            onPress={() => {
              clearThumbCaches();
              clearThumbRefs();
              prefs.remove('export.last');
              Alert.alert(t('settings.cacheCleared'));
            }}
          />
        </Card>
        <Text style={styles.version}>Hikari · {t('settings.version', { v: Constants.expoConfig?.version ?? '1.0.0' })}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  version: { color: colors.textFaint, fontSize: font.xs, textAlign: 'center', marginTop: space.lg },
});
