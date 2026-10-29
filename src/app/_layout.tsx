import '@/i18n';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { getDb } from '@/core/db/db';
import { colors, radius } from '@/ui/theme';

export default function RootLayout() {
  useEffect(() => {
    getDb();
    SystemUI.setBackgroundColorAsync(colors.bg);
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: 'fade',
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="editor/[key]" options={{ animation: 'fade', gestureEnabled: false }} />
          <Stack.Screen name="folder/[id]" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="export" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="batch" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen
            name="albums"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.5, 1],
              sheetGrabberVisible: true,
              sheetCornerRadius: radius.xl,
              contentStyle: { backgroundColor: colors.surface },
            }}
          />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
