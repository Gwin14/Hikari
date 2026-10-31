import { usePermissions } from 'expo-media-library';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';

import { KOMOREBI_SCHEME, registerHandoff } from '@/core/companion/komorebi';
import { libraryAssetId, libraryItem } from '@/core/sources/library';
import { useLibrary } from '@/state/library';
import { Button, EmptyState } from '@/ui/kit';
import { colors, common } from '@/ui/theme';

type Params = {
  asset?: string;
  source?: string;
  return?: string;
  lut?: string;
  lutName?: string;
  lutFile?: string;
  lutIntensity?: string;
  clean?: string;
};

/**
 * Deep link entry: `hikari://edit?asset=<PHAsset id | MediaStore id>&source=komorebi`.
 * Resolves the library asset and opens it in the editor.
 */
export default function EditLinkScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<Params>();
  const [permission, requestPermission] = usePermissions({ granularPermissions: ['photo'] });
  const [missing, setMissing] = useState(false);
  const granted = !!permission?.granted;

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    if (!granted || !params.asset) return;
    let alive = true;
    libraryItem(params.asset).then((item) => {
      if (!alive) return;
      if (!item) {
        setMissing(true);
        return;
      }
      if (params.source === 'komorebi' || params.return?.startsWith(`${KOMOREBI_SCHEME}://`)) {
        registerHandoff(libraryAssetId(params.asset!), params);
      }
      useLibrary.getState().setSequence([item]);
      router.replace({ pathname: '/editor/[key]', params: { key: item.key } });
    });
    return () => {
      alive = false;
    };
  }, [granted, params.asset]); // eslint-disable-line react-hooks/exhaustive-deps

  const leave = () => router.replace('/');

  if (!params.asset || missing) {
    return (
      <View style={[common.screen, common.center]}>
        <EmptyState icon="image-outline" title={t('link.missingTitle')} body={t('link.missingBody')} action={<Button primary label={t('link.openLibrary')} onPress={leave} />} />
      </View>
    );
  }
  if (permission && !granted) {
    return (
      <View style={[common.screen, common.center]}>
        <EmptyState
          icon="images-outline"
          title={t('library.permissionTitle')}
          body={t('library.permissionBody')}
          action={<Button primary label={t('library.permissionButton')} onPress={requestPermission} />}
        />
      </View>
    );
  }
  return (
    <View style={[common.screen, common.center]}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
