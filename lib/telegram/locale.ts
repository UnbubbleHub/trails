import { locales, type Locale } from '@/i18n/config';

/**
 * Map Telegram's `language_code` (ISO 639-1, optionally with region) to a
 * supported app locale. Falls back to `en` for anything unsupported.
 *
 * This is the only locale source in the standalone build: the bot speaks the
 * user's Telegram client language. There is no stored language preference.
 */
export function mapLocale(languageCode?: string): Locale {
  if (!languageCode) return 'en';
  const code = languageCode.split('-')[0].toLowerCase();
  if (locales.includes(code as Locale)) return code as Locale;
  return 'en';
}
