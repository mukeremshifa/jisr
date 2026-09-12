// Next.js only reads env files from its own folder. The repo keeps one .env at
// the root, so copy it to .env.local (gitignored) before `next dev` starts.
import { copyFileSync, existsSync } from 'node:fs';

const root = new URL('../../../.env', import.meta.url);
const local = new URL('../.env.local', import.meta.url);

if (existsSync(root)) {
  copyFileSync(root, local);
  console.log('dashboard: copied the root .env to apps/dashboard/.env.local');
} else {
  console.warn('dashboard: no root .env found; using apps/dashboard/.env.local if it exists');
}
