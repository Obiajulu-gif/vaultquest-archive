import path from "path";
import { createRequire } from "module";

/** @type {import('next').NextConfig} */
const require = createRequire(import.meta.url);
const { i18n } = require("./next-i18next.config.js");
const nextI18n = {
  defaultLocale: i18n.defaultLocale,
  locales: i18n.locales,
};

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@vaultquest/stellar-wallet-connect"],
  i18n: nextI18n,
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [],
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": path.resolve(
        "./lib/shims/async-storage.js",
      ),
    };
    return config;
  },
};

export default nextConfig;
