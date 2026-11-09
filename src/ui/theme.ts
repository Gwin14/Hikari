import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Appearance, StyleSheet, useColorScheme, type TextStyle } from 'react-native';

import { usePrefString } from '@/state/prefs';

/**
 * Hikari design system — "darkroom".
 *
 * - The photo is the brightest, most saturated thing on screen; chrome is neutral grey.
 * - One accent, the amber glow of the app icon. It is spent on the primary action, the
 *   active state and progress — never decoration.
 * - One grey family (Apple's system greys), in a light and a dark variant. Browsing screens
 *   follow the system appearance; the editor is always dark so colour judgement is not
 *   skewed by a bright surround.
 * - Shape rule: actions, chips and segmented controls are pills; grouped cards are 20;
 *   tiles, thumbnails and inputs are 12; badges are 6; sheets are 28. Always continuous.
 * - Spacing is a 4 pt grid.
 */

export type Scheme = 'light' | 'dark';

export interface Palette {
  scheme: Scheme;
  /** Screen background (grouped background in light mode). */
  bg: string;
  /** Cards, grouped rows, panels. */
  surface: string;
  /** Fills inside a surface: chips, inputs, segmented tracks, placeholders. */
  surface2: string;
  /** Stronger fill: pressed rows, the segmented thumb, inactive tracks. */
  surface3: string;
  separator: string;
  text: string;
  textDim: string;
  textFaint: string;
  /** Accent as a fill (primary buttons, active chips, progress). Text on it is `onAccent`. */
  accent: string;
  /** Accent as ink: icon tint and text on `bg`/`surface` (darker in light mode for contrast). */
  accentInk: string;
  accentSoft: string;
  onAccent: string;
  danger: string;
  success: string;
  overlay: string;
  /** Translucent chrome floating over photos. */
  glass: string;
}

const ACCENT = '#FFB23A';

export const dark: Palette = {
  scheme: 'dark',
  bg: '#000000',
  surface: '#1C1C1E',
  surface2: '#2C2C2E',
  surface3: '#3A3A3C',
  separator: 'rgba(84,84,88,0.55)',
  text: '#FFFFFF',
  textDim: 'rgba(235,235,245,0.62)',
  textFaint: 'rgba(235,235,245,0.32)',
  accent: ACCENT,
  accentInk: ACCENT,
  accentSoft: 'rgba(255,178,58,0.16)',
  onAccent: '#1F1404',
  danger: '#FF453A',
  success: '#30D158',
  overlay: 'rgba(0,0,0,0.5)',
  glass: 'rgba(28,28,30,0.78)',
};

export const light: Palette = {
  scheme: 'light',
  bg: '#F2F2F7',
  surface: '#FFFFFF',
  surface2: '#E9E9EE',
  surface3: '#D1D1D6',
  separator: 'rgba(60,60,67,0.22)',
  text: '#000000',
  textDim: 'rgba(60,60,67,0.62)',
  textFaint: 'rgba(60,60,67,0.32)',
  accent: ACCENT,
  accentInk: '#A86400',
  accentSoft: 'rgba(255,178,58,0.2)',
  onAccent: '#1F1404',
  danger: '#FF3B30',
  success: '#34C759',
  overlay: 'rgba(0,0,0,0.32)',
  glass: 'rgba(249,249,249,0.82)',
};

/** The editor palette (always dark). Static so worklets, Skia and StyleSheets can use it directly. */
export const colors = {
  ...dark,
  /** Editor canvas surround. */
  canvas: '#000000',
  /** Editor panel: a step above the canvas so the photo edge stays readable. */
  panel: '#121214',
  /** Hairline grid lines drawn over the panel (curves, wheels). */
  border: 'rgba(255,255,255,0.08)',
  red: '#FF453A',
  green: '#30D158',
  blue: '#0A84FF',
} as const;

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

/** Shape lock — see the rule above. */
export const radius = { badge: 6, tile: 12, card: 20, sheet: 28, pill: 999 } as const;

/** iOS squircle corners for every rounded rectangle. */
export const curve = { borderCurve: 'continuous' } as const;

/** The one elevation step: something raised above its track or floating over a photo. */
export const raised = '0 1px 3px rgba(0,0,0,0.28)';
export const floating = '0 8px 24px rgba(0,0,0,0.35)';

/** Platform type ramp (iOS sizes; Android maps them to the same visual weights). */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: 0.37 },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.26 },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600', letterSpacing: -0.45 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.43 },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400', letterSpacing: -0.43 },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400', letterSpacing: -0.31 },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400', letterSpacing: -0.23 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: -0.08 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400', letterSpacing: 0 },
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: '500', letterSpacing: 0.06 },
} satisfies Record<string, TextStyle>;

/** Legacy size scale kept for the editor's dense panels (maps onto the ramp above). */
export const font = { xs: 11, sm: 13, md: 15, lg: 17, xl: 22, mono: 'Menlo' } as const;

/** Tabular numerals for anything that counts. */
export const tabular = { fontVariant: ['tabular-nums'] } as TextStyle;

export const common = StyleSheet.create({
  fill: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.textDim, fontSize: font.sm },
  title: { color: colors.text, ...type.title2 },
  text: { color: colors.text, fontSize: font.md },
});

// ---------------------------------------------------------------- theming

export type AppearancePref = 'system' | 'light' | 'dark';

const ThemeContext = createContext<Palette | null>(null);

/**
 * The scheme the browsing screens use. The appearance preference is applied natively
 * (`Appearance.setColorScheme`), so system bars, menus and sheets switch along with JS.
 */
export function useAppScheme(): Scheme {
  const [pref] = usePrefString('appearance');
  useEffect(() => {
    if (typeof Appearance.setColorScheme !== 'function') return; // web has no native override
    Appearance.setColorScheme(pref === 'light' || pref === 'dark' ? pref : 'unspecified');
  }, [pref]);
  const system = useColorScheme();
  if (pref === 'light' || pref === 'dark') return pref;
  return system === 'light' ? 'light' : 'dark';
}

/** Provides a palette to the subtree. Without `scheme` it follows the app appearance. */
export function ThemeProvider({ scheme, children }: { scheme?: Scheme; children: ReactNode }) {
  const app = useAppScheme();
  const palette = (scheme ?? app) === 'light' ? light : dark;
  return createElement(ThemeContext.Provider, { value: palette }, children);
}

export function useTheme(): Palette {
  return useContext(ThemeContext) ?? dark;
}

/** Theme-aware StyleSheet: `const s = useStyles(makeStyles)` where `makeStyles = (c: Palette) => StyleSheet.create(...)`. */
export function useStyles<T>(factory: (c: Palette) => T): T {
  const c = useTheme();
  return useMemo(() => factory(c), [factory, c]);
}
