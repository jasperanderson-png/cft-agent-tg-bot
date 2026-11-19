// Server tests: support/helpers/tests (the helpers), telegram_bot and each tool's tests/ folder.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['support/**/*.test.ts', 'telegram_bot/**/*.test.ts', 'tools/**/*.test.ts'],
    testTimeout: 20000,
    fileParallelism: false,
    // Paid services (TomTom, Google voice, the Redis that caps them) and OpenRouteService
    // are never called from tests, even when a developer's .env.local has the keys: tests that need
    // them set fakes and stub fetch.
    env: { TOMTOM_API_KEY: '', GOOGLE_TTS_KEY: '', REDIS_URL: '', KV_REST_API_URL: '', KV_REST_API_TOKEN: '', ORS_API_KEY: '' },
  },
});
