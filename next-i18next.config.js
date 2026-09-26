module.exports = {
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es', 'fr', 'de'],
    localePath: './public/locales',
    reloadOnPrerender: process.env.NODE_ENV === 'development',
  },
  fallbackLng: 'en',
  defaultNS: 'common',
  localeDetection: false,
  localeExtension: 'json',
  serverLanguageDetection: false,
  strictMode: true,
};
