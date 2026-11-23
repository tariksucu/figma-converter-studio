import { defineConfig } from 'vitest/config';

// Unit tests: Figma's plugin API and Converter Studio's API are stood in for (test/fake-*.ts);
// the panel's tests run in jsdom. No network.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
