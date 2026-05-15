export const locales = ['en', 'it', 'de', 'es', 'fr'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

export const localeNames: Record<Locale, string> = {
  en: 'English',
  it: 'Italiano',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
};
