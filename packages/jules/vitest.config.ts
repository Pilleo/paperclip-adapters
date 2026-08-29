import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ["ui-parser.cjs", 'temp-test-extract/**', 'dist/**', 'src/cli/**', 'src/ui/**', 'src/server/index.ts', 'src/server/test-environment.ts', 'src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80
      }
    }
  }
});
