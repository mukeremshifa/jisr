import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    // Config is read at module load; tests must not depend on a developer's .env.
    // Fixed, obviously-fake 32-byte keys so tests never depend on a
    // developer's .env - and so a real key can never leak into the repo.
    env: {
      NODE_ENV: 'test',
      DATA_ENCRYPTION_KEY: 'dGVzdC1kYXRhLWtleS1mb3ItdW5pdC10ZXN0cyEhISE=',
      SEALING_KEY: 'dGVzdC1zZWFsaW5nLWtleS11bml0LXRlc3RzISEhISE=',
      PHONE_HMAC_KEY: 'dGVzdC1obWFjLWtleS1mb3ItdW5pdC10ZXN0cyEhISE=',
    },
  },
  resolve: {
    alias: {
      '@jisr/core': r('./packages/core/src/index.ts'),
      '@jisr/db': r('./packages/db/src/index.ts'),
      '@jisr/ai': r('./packages/ai/src/index.ts'),
      '@jisr/integrations': r('./packages/integrations/src/index.ts'),
    },
  },
});
