import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: true,
  test: {
    // environment: 'jsdom',
    // globals: true,
    snapshotFormat: {
      printBasicPrototype: true,
    },
    // setupFiles: ['./tests/setupTests.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['**/src/**'],
      exclude: [],
    },
    poolOptions: {
      threads: {
        useAtomics: !!process.env['CI'],
      },
      forks: {
        execArgv: ['--expose-gc'],
      },
    },
  },
});
