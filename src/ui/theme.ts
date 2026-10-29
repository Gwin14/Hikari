import { StyleSheet } from 'react-native';

/** Dark, low-distraction palette: the photo is the brightest thing on screen. */
export const colors = {
  bg: '#0B0B0C',
  surface: '#151517',
  surface2: '#1E1E21',
  surface3: '#2A2A2E',
  border: '#2E2E33',
  text: '#F2F2F3',
  textDim: '#9A9AA2',
  textFaint: '#5E5E66',
  accent: '#FFB547',
  accentDim: '#7A5A2A',
  danger: '#FF5C5C',
  success: '#5BD18B',
  red: '#FF5A5F',
  green: '#4CD07D',
  blue: '#4D9BFF',
  overlay: 'rgba(0,0,0,0.55)',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;
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
  title: { color: colors.text, fontSize: font.xl, fontWeight: '700' },
  text: { color: colors.text, fontSize: font.md },
});
