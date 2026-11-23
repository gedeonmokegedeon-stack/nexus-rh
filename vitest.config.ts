import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@nexus-rh/shared-types': path.resolve(__dirname, 'packages/shared-types/src/index.ts'),
      '@nexus-rh/crypto-audit': path.resolve(__dirname, 'packages/crypto-audit/src/index.ts'),
      '@nexus-rh/database': path.resolve(__dirname, 'packages/database/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.spec.ts', 'apps/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
