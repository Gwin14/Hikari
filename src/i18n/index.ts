import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { prefs } from '@/state/prefs';
import en from './en';
import ptBR from './pt-BR';

export const LANGUAGES = [
  { code: 'system', label: null },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'en', label: 'English' },
] as const;

export function systemLanguage(): string {
  const code = getLocales()[0]?.languageCode ?? 'en';
  return code === 'pt' ? 'pt-BR' : 'en';
}

export function resolveLanguage(pref: string | undefined): string {
  return !pref || pref === 'system' ? systemLanguage() : pref;
}

// eslint-disable-next-line import/no-named-as-default-member
i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, 'pt-BR': { translation: ptBR } },
  lng: resolveLanguage(prefs.getString('language')),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function setLanguage(pref: string) {
  prefs.set('language', pref);
  // eslint-disable-next-line import/no-named-as-default-member
  i18n.changeLanguage(resolveLanguage(pref));
}

export default i18n;
