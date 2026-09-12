import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config, isValidAssetCode, isPlausibleE164, normalizePhone } from '@jisr/core';
import {
  assets,
  closeDb,
  companies,
  encryptField,
  eq,
  getDb,
  phoneHmac,
  sites,
  staff,
  withTenant,
  workers,
} from '@jisr/db';

/**
 * Seeds the demo company.
 *
 * Real phone numbers live only in `seed/roster.local.csv`, which is gitignored.
 * Without that file the seed still runs and creates everything except workers,
 * so a fresh clone can migrate and boot.
 *
 *   pnpm seed
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

interface RosterRow {
  phone: string;
  displayName: string;
  siteCode: string;
  language: string;
  hourlyRateFils: number;
}

async function readRoster(): Promise<RosterRow[]> {
  for (const name of ['roster.local.csv', 'roster.example.csv']) {
    try {
      const text = await readFile(`${HERE}${name}`, 'utf8');
      const rows = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && !line.startsWith('phone,'))
        .map((line) => {
          const [phone, displayName, siteCode, language, rate] = line.split(',').map((s) => s.trim());
          return {
            phone: normalizePhone(phone ?? ''),
            displayName: displayName ?? 'Worker',
            siteCode: (siteCode ?? 'B').toUpperCase(),
            language: (language ?? 'en').toLowerCase(),
            hourlyRateFils: Number(rate ?? 0),
          };
        })
        .filter((row) => isPlausibleE164(row.phone));

      process.stdout.write(`roster: ${rows.length} worker(s) from seed/${name}\n`);
      if (name === 'roster.example.csv') {
        process.stdout.write('  (example numbers - copy it to roster.local.csv and use real ones)\n');
      }
      return rows;
    } catch {
      // Try the next candidate.
    }
  }
  process.stdout.write('roster: none found, skipping workers\n');
  return [];
}

async function main(): Promise<void> {
  const db = getDb();

  const companyName = config.COMPANY_NAME;
  // Find-or-create: companies.name has no unique constraint, so an insert with
  // onConflictDoNothing would create a duplicate company on every re-run.
  const existing = (await db.select().from(companies).where(eq(companies.name, companyName)).limit(1))[0];
  const companyRow = existing ?? (await db.insert(companies).values({ name: companyName }).returning())[0];
  if (!companyRow) throw new Error('could not create or find the company');
  const companyId = companyRow.id;

  // Everything below touches tables with FORCE ROW LEVEL SECURITY, so it must run
  // inside withTenant() — otherwise Postgres rejects every insert.
  await withTenant(companyId, async ({ tx }) => {

  // Site B is geofenced on the demo venue so a live location pin matches it.
  const venueLat = Number(config.VENUE_LAT ?? '25.2048');
  const venueLng = Number(config.VENUE_LNG ?? '55.2708');

  const siteRows = [
    {
      companyId,
      code: 'A',
      name: 'Al Quoz yard',
      lat: 25.1279,
      lng: 55.2323,
      radiusM: 300,
      timezone: 'Asia/Dubai',
      slackChannelId: process.env.SEED_SLACK_CHANNEL_SITE_A ?? null,
    },
    {
      companyId,
      code: 'B',
      name: 'Camp and site',
      lat: venueLat,
      lng: venueLng,
      radiusM: 300,
      timezone: 'Asia/Dubai',
      slackChannelId: process.env.SEED_SLACK_CHANNEL_SITE_B ?? null,
    },
  ];

  for (const row of siteRows) {
    await tx.insert(sites).values(row).onConflictDoNothing();
  }
  const allSites = await tx.select().from(sites).where(eq(sites.companyId, companyId));
  const siteByCode = new Map(allSites.map((s) => [s.code, s]));

  const staffRows = [
    { email: 'supervisor.a@example.com', displayName: 'Supervisor — Al Quoz yard' },
    { email: 'supervisor.b@example.com', displayName: 'Supervisor — Camp and site' },
    { email: 'hr@example.com', displayName: 'HR Manager' },
    { email: 'compliance@example.com', displayName: 'Compliance Officer' },
    { email: 'ops@example.com', displayName: 'Ops Admin' },
  ];
  for (const row of staffRows) {
    await tx.insert(staff).values({ companyId, ...row }).onConflictDoNothing();
  }

  const assetRows = [
    { code: 'R214', label: 'Room 214, Block C', kind: 'room' as const, siteCode: 'B' },
    { code: 'BUS07', label: 'Bus 7', kind: 'bus' as const, siteCode: 'A' },
    { code: 'GATE-B', label: 'Site B gate', kind: 'gate' as const, siteCode: 'B' },
    { code: 'SPEAKUP', label: 'Speak up privately', kind: 'speakup' as const, siteCode: 'B' },
  ];
  for (const row of assetRows) {
    if (!isValidAssetCode(row.code)) throw new Error(`invalid asset code: ${row.code}`);
    await tx
      .insert(assets)
      .values({
        companyId,
        siteId: siteByCode.get(row.siteCode)?.id ?? null,
        code: row.code,
        label: row.label,
        kind: row.kind,
      })
      .onConflictDoNothing();
  }

  const roster = await readRoster();
  let index = 1;
  for (const row of roster) {
    await tx
      .insert(workers)
      .values({
        companyId,
        siteId: siteByCode.get(row.siteCode)?.id ?? null,
        publicRef: `W-${String(index).padStart(4, '0')}`,
        displayName: row.displayName,
        // The number is stored twice: an HMAC to look it up by, and a sealed
        // copy to send to. The plaintext is never written anywhere.
        phoneHmac: phoneHmac(row.phone),
        phoneEnc: encryptField(row.phone, 'data'),
        language: row.language,
        hourlyRateFils: row.hourlyRateFils,
      })
      .onConflictDoNothing();
    index++;
  }

  const staffOut = await tx.select().from(staff).where(eq(staff.companyId, companyId));

  process.stdout.write('\nSeeded.\n\n');
  process.stdout.write(`DEFAULT_COMPANY_ID=${companyId}\n\n`);
  process.stdout.write('Sites:\n');
  for (const site of allSites) process.stdout.write(`  ${site.code}  ${site.id}  ${site.name}\n`);
  process.stdout.write('\nStaff (use these ids in fga/tuples.json):\n');
  for (const row of staffOut) process.stdout.write(`  ${row.id}  ${row.email}\n`);
  process.stdout.write('\nNext: set DEFAULT_COMPANY_ID, fill in fga/tuples.json, and set each site\'s\n');
  process.stdout.write('Slack channel id (SEED_SLACK_CHANNEL_SITE_A/B, or update the sites table).\n');
  });
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
