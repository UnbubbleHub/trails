import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const baseConfig = {
  serverExternalPackages: ['firebase-admin'],
};

export default withNextIntl(baseConfig);
