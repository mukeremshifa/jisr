import { existsSync } from 'node:fs';
import { defineConfig } from '@trigger.dev/sdk';

// `trigger dev` evaluates this file before it reads --env-file, so load the
// repo's root .env here to make TRIGGER_PROJECT_REF available. A no-op in
// CI and in deployed images, where the file does not exist.
if (existsSync('../../.env')) process.loadEnvFile('../../.env');

/**
 * Trigger.dev v4. Every slow or flaky step in Jisr runs here, so it gets retries,
 * timeouts and a trace instead of a hanging webhook.
 *
 * `sharp` ships platform-specific binaries, so it is marked external and
 * installed in the deployed image rather than bundled.
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? '',
  runtime: 'node',
  logLevel: 'info',
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ['./src/tasks'],
  build: {
    external: ['sharp'],
  },
});
