import type { NativeStackNavigationOptions } from 'expo-router';

import type { Palette } from './theme';

/**
 * Native stack header for the browsing tabs: an iOS large title that collapses into a blurred
 * bar as content scrolls under it; a flat Material top bar on Android.
 */
export function largeHeader(c: Palette): NativeStackNavigationOptions {
  const ios = process.env.EXPO_OS === 'ios';
  return {
    headerShown: true,
    headerLargeTitle: ios,
    headerTransparent: ios,
    headerBlurEffect: ios ? (c.scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight') : undefined,
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    headerTintColor: c.accentInk,
    headerTitleStyle: { color: c.text },
    headerLargeTitleStyle: { color: c.text },
    headerStyle: ios ? undefined : { backgroundColor: c.bg },
    headerBackButtonDisplayMode: 'minimal',
    contentStyle: { backgroundColor: c.bg },
  };
}

/** Header for modals (export, batch): a standard inline title with Cancel on the left. */
export function modalHeader(c: Palette): NativeStackNavigationOptions {
  return {
    headerShown: true,
    headerTransparent: false,
    headerShadowVisible: false,
    headerTintColor: c.accentInk,
    headerTitleStyle: { color: c.text },
    headerStyle: { backgroundColor: c.bg },
    contentStyle: { backgroundColor: c.bg },
  };
}
