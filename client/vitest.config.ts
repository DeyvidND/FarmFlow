import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure logic only — node env, no jsdom. `@` alias mirrors tsconfig so any
// runtime import of `@/...` resolves (type-only imports are erased by esbuild).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
