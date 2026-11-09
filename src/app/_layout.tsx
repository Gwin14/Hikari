import '@/i18n';

import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { getDb } from '@/core/db/db';
import { modalHeader } from '@/ui/headers';
import { colors, radius, ThemeProvider, useTheme } from '@/ui/theme';

// Deep links (hikari://edit from Komorebi) keep the library below the editor.
export const unstable_settings = { initialRouteName: '(tabs)' };

function RootStack() {
  const c = useTheme();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(c.bg);
  }, [c.bg]);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={c.scheme === 'dark' ? 'light' : 'dark'} />
      {/* Native headers take their interface style from this theme, which also sets the Liquid Glass of bar items and menus. */}
      <NavigationThemeProvider value={c.scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
          <Stack.Screen name="(tabs)" />
          {/* Full-attention workspace above the tabs: always dark, no edge swipe (the canvas pans). */}
          <Stack.Screen
            name="editor/[key]"
            options={{ animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: colors.canvas } }}
          />
          <Stack.Screen name="export" options={{ presentation: 'modal', ...modalHeader(c) }} />
          <Stack.Screen name="batch" options={{ presentation: 'modal', ...modalHeader(c) }} />
          <Stack.Screen
            name="albums"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.6, 1],
              sheetGrabberVisible: true,
              sheetCornerRadius: radius.sheet,
              contentStyle: { backgroundColor: c.bg },
            }}
          />
          <Stack.Screen name="edit" options={{ animation: 'fade' }} />
        </Stack>
      </NavigationThemeProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  useEffect(() => {
    getDb();
  }, []);
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <RootStack />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
