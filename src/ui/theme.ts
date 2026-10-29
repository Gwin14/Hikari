import { StyleSheet } from 'react-native';

/** Dark, low-distraction palette: the photo is the brightest thing on screen. */
export const colors = {
  bg: '#000000',
  surface: '#111113',
  surface2: '#1C1C1F',
  surface3: '#2B2B30',
  border: 'rgba(255,255,255,0.08)',
  text: '#F5F5F7',
  textDim: '#A1A1AA',
  textFaint: '#5F5F68',
  accent: '#FFB547',
  accentDim: '#7A5A2A',
  accentSoft: 'rgba(255,181,71,0.16)',
  /** Translucent chrome floating over photos (fallback where blur isn't available). */
  glass: 'rgba(22,22,26,0.82)',
  danger: '#FF5C5C',
  success: '#5BD18B',
  red: '#FF5A5F',
  green: '#4CD07D',
  blue: '#4D9BFF',
  overlay: 'rgba(0,0,0,0.55)',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 18, xl: 24, pill: 999 } as const;
export const font = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  mono: 'Menlo',
} as const;

export const common = StyleSheet.create({
  fill: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.textDim, fontSize: font.sm },
  title: { color: colors.text, fontSize: font.xl, fontWeight: '700', letterSpacing: -0.3 },
  text: { color: colors.text, fontSize: font.md },
});
