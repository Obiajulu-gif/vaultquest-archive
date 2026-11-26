import path from "path";
import { createRequire } from "node:module";

/** @type {import('next').NextConfig} */
const require = createRequire(import.meta.url);
const { i18n } = require('./next-i18next.config.js');

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@vaultquest/stellar-wallet-connect"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };

    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": path.resolve(
        "./lib/shims/async-storage.js",
      ),
    };

    return config;
  },
  
  i18n,
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [],
  },
};

export default nextConfig;