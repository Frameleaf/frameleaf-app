import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  testMatch: /\.e2e-spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: 'list',
  forbidOnly: !!process.env.CI,
});
