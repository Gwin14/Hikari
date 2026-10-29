import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { colors } from '@/ui/theme';

export default function TabsLayout() {
  const { t } = useTranslation();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textDim,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t('tabs.library'), tabBarIcon: ({ color, size }) => <Ionicons name="images" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="folders"
        options={{ title: t('tabs.folders'), tabBarIcon: ({ color, size }) => <Ionicons name="folder" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: t('tabs.settings'), tabBarIcon: ({ color, size }) => <Ionicons name="options" color={color as string} size={size} /> }}
      />
    </Tabs>
  );
}
