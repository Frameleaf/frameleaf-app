import type { ViteUserConfig } from 'vitest/config';

export const serverTestConfig = async (name: string, include: string) => {
  const globalSetup: string[] = [];
  if (process.env.VITEST_DISABLE_DOCKER_SETUP !== 'true') {
    try {
      const response = await fetch('http://127.0.0.1:2285/api/server/ping', { signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json())?.res !== 'pong') {
        globalSetup.push('src/docker-compose.ts');
      }
    } catch {
      globalSetup.push('src/docker-compose.ts');
    }
  }
  return {
    test: {
      name,
      retry: process.env.CI ? 4 : 0,
      include: [include],
      globalSetup,
      testTimeout: 15_000,
      pool: 'threads',
      maxWorkers: 1,
      isolate: false,
    },
    resolve: { tsconfigPaths: true },
  } satisfies ViteUserConfig;
};
