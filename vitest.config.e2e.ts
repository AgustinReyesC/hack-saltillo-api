import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Las pruebas e2e levantan AppModule completo: usan el mismo entorno que `npm run start`.
    env: parseEnv(readFileSync('.env.local', 'utf8')),
  },
});
