import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      'next/link': path.resolve(__dirname, './tests/mocks/next-link.jsx'),
      'next/image': path.resolve(__dirname, './tests/mocks/next-image.jsx'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
    include: ['**/*.test.{js,jsx,ts,tsx}'],
  },
});
