import { NativeTabs } from 'expo-router/native-tabs';
import { useTranslation } from 'react-i18next';

import { useLibrary } from '@/state/library';
import { md, sf } from '@/ui/Icon';
import { useTheme } from '@/ui/theme';

/** System tab bar (Liquid Glass on iOS 26, Material navigation bar on Android). Each tab owns a stack. */
export default function TabsLayout() {
  const { t } = useTranslation();
  const c = useTheme();
  // multi-select swaps the tab bar for the selection toolbar, like Photos
  const selecting = useLibrary((s) => s.selecting);
  return (
    <NativeTabs
      hidden={selecting}
      tintColor={c.accentInk}
      iconColor={{ default: c.textDim, selected: c.accentInk }}
      labelStyle={{ default: { color: c.textDim }, selected: { color: c.accentInk } }}
      indicatorColor={c.accentSoft}
      // iOS draws its own material; Android gets the surface tone
      backgroundColor={process.env.EXPO_OS === 'android' ? c.surface : undefined}
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="(library)">
        <NativeTabs.Trigger.Icon sf={{ default: sf('library'), selected: sf('libraryFill') }} md={md('library')} />
        <NativeTabs.Trigger.Label>{t('tabs.library')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(folders)">
        <NativeTabs.Trigger.Icon sf={{ default: sf('folders'), selected: sf('foldersFill') }} md={md('folders')} />
        <NativeTabs.Trigger.Label>{t('tabs.folders')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(settings)">
        <NativeTabs.Trigger.Icon sf={{ default: sf('settings'), selected: sf('settingsFill') }} md={md('settings')} />
        <NativeTabs.Trigger.Label>{t('tabs.settings')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
