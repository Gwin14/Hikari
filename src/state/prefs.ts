import { createMMKV, useMMKVBoolean, useMMKVNumber, useMMKVString } from 'react-native-mmkv';

/** Small synchronous key-value store for user preferences. */
export const prefs = createMMKV({ id: 'hikari-prefs' });

export type PreviewQuality = 'fast' | 'balanced' | 'high';
export const PREVIEW_DIM: Record<PreviewQuality, number> = { fast: 1440, balanced: 2048, high: 3072 };

export const getPreviewDim = () => PREVIEW_DIM[(prefs.getString('previewQuality') as PreviewQuality) ?? 'balanced'] ?? 2048;
export const getBool = (key: string, fallback: boolean) => prefs.getBoolean(key) ?? fallback;

export const usePrefString = (key: string) => useMMKVString(key, prefs);
export const usePrefBool = (key: string) => useMMKVBoolean(key, prefs);
export const usePrefNumber = (key: string) => useMMKVNumber(key, prefs);
