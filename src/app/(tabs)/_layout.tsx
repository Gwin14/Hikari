import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet } from 'react-native';

import { colors } from '@/ui/theme';

// Android needs a BlurTargetView around the content to blur; there the bar falls back to translucent glass.
const TabBarBackground = () =>
  Platform.OS === 'ios' ? (
    <BlurView tint="systemChromeMaterialDark" intensity={90} style={StyleSheet.absoluteFill} />
  ) : null;

export default function TabsLayout() {
  const { t } = useTranslation();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: Platform.OS === 'ios' ? 'transparent' : colors.glass,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          elevation: 0,
        },
        tabBarBackground: TabBarBackground,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textDim,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.library'),
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'images' : 'images-outline'} color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="folders"
        options={{
          title: t('tabs.folders'),
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'folder' : 'folder-outline'} color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? 'options' : 'options-outline'} color={color as string} size={size} />,
        }}
      />
    </Tabs>
  );
}
