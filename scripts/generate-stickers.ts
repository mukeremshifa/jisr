import { mkdir, writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { config, stickerUrl } from '@jisr/core';
import { closeDb, getDb, repo, withTenant } from '@jisr/db';

/**
 * F1. The printable sticker sheet.
 *
 * A4, eight stickers, each with a QR code, the label, the code, a three-step
 * pictogram strip and one short line in five languages. Written as HTML so it
 * prints from any browser without a toolchain.
 *
 *   pnpm stickers            # every active asset
 *   pnpm stickers R214 BUS07 # just these
 */

interface Sticker {
  code: string;
  label: string;
  url: string;
  qrSvg: string;
}

/** One line, five scripts. Workers who cannot read English still recognise theirs. */
const INSTRUCTION_LINES = [
  { lang: 'English', text: 'Scan, press send, then speak.', dir: 'ltr' },
  { lang: 'हिन्दी', text: 'स्कैन करें, भेजें दबाएँ, फिर बोलें।', dir: 'ltr' },
  { lang: 'اردو', text: 'اسکین کریں، سینڈ دبائیں، پھر بولیں۔', dir: 'rtl' },
  { lang: 'മലയാളം', text: 'സ്കാൻ ചെയ്യുക, സെൻഡ് അമർത്തുക, സംസാരിക്കുക.', dir: 'ltr' },
  { lang: 'Tagalog', text: 'I-scan, pindutin ang send, tapos magsalita.', dir: 'ltr' },
];

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Scan, send, speak, drawn rather than written, for the same reason. */
function pictogramStrip(): string {
  return `
    <svg class="steps" viewBox="0 0 300 56" role="img" aria-label="Scan, press send, then speak">
      <g fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="8" y="10" width="34" height="36" rx="4" />
        <path d="M16 18h6M16 38h6M28 18h6M28 38h6" />
        <path d="M14 28h30" stroke="#c0392b" />
        <text x="25" y="54" text-anchor="middle" font-size="9" stroke="none" fill="#111">1</text>

        <path d="M68 28h22" />
        <path d="M84 22l6 6-6 6" />

        <rect x="108" y="10" width="30" height="36" rx="4" />
        <path d="M116 34l16-8-16-8v6l8 2-8 2z" fill="#111" stroke="none" />
        <text x="123" y="54" text-anchor="middle" font-size="9" stroke="none" fill="#111">2</text>

        <path d="M158 28h22" />
        <path d="M174 22l6 6-6 6" />

        <rect x="200" y="14" width="14" height="22" rx="7" />
        <path d="M194 30a13 13 0 0 0 26 0" />
        <path d="M207 40v6" />
        <text x="207" y="54" text-anchor="middle" font-size="9" stroke="none" fill="#111">3</text>
      </g>
    </svg>`;
}

function sheetHtml(stickers: Sticker[]): string {
  const cards = stickers
    .map(
      (sticker) => `
      <section class="sticker">
        <div class="qr">${sticker.qrSvg}</div>
        <div class="body">
          <h2>${escapeHtml(sticker.label)}</h2>
          <p class="code">${escapeHtml(sticker.code)}</p>
          ${pictogramStrip()}
          <ul class="langs">
            ${INSTRUCTION_LINES.map(
              (line) =>
                `<li dir="${line.dir}"><span class="lang">${escapeHtml(line.lang)}</span> ${escapeHtml(line.text)}</li>`,
            ).join('')}
          </ul>
        </div>
      </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Jisr stickers</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Noto Sans", "Noto Sans Devanagari", "Noto Nastaliq Urdu", "Noto Sans Malayalam", system-ui, sans-serif;
    color: #111;
    background: #fff;
  }
  .sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  .sticker {
    border: 1.5px solid #111;
    border-radius: 3mm;
    padding: 5mm;
    display: grid;
    grid-template-columns: 34mm 1fr;
    gap: 4mm;
    height: 62mm;
    page-break-inside: avoid;
    align-items: start;
  }
  .qr svg { width: 34mm; height: 34mm; }
  h2 { font-size: 12pt; margin: 0 0 1mm; line-height: 1.2; }
  .code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 10pt; margin: 0 0 2mm; color: #444; letter-spacing: 0.04em; }
  .steps { width: 100%; max-width: 52mm; height: auto; margin-bottom: 1.5mm; }
  .langs { list-style: none; margin: 0; padding: 0; font-size: 7.2pt; line-height: 1.45; }
  .langs li { margin-bottom: 0.4mm; }
  .lang { color: #666; display: inline-block; min-width: 14mm; }
  @media screen { body { padding: 10mm; background: #f4f4f2; } .sheet { max-width: 210mm; margin: 0 auto; } }
</style>
</head>
<body>
  <div class="sheet">${cards}</div>
</body>
</html>`;
}

async function main(): Promise<void> {
  const companyId = config.DEFAULT_COMPANY_ID;
  if (!companyId) throw new Error('DEFAULT_COMPANY_ID must be set (run `pnpm seed` first)');
  if (!config.WHATSAPP_NUMBER_DIGITS) throw new Error('WHATSAPP_NUMBER_DIGITS must be set');

  const wanted = process.argv.slice(2).map((code) => code.toUpperCase());

  getDb();
  const rows = await withTenant(companyId, ({ tx }) => repo(companyId, tx).allAssets());
  const chosen = rows
    .filter((asset) => asset.active)
    .filter((asset) => wanted.length === 0 || wanted.includes(asset.code));

  if (chosen.length === 0) throw new Error('no matching assets, seed some first');

  const stickers: Sticker[] = [];
  for (const asset of chosen) {
    const url = stickerUrl(config.WHATSAPP_NUMBER_DIGITS, asset.code);
    stickers.push({
      code: asset.code,
      label: asset.label,
      url,
      // Error correction M survives a sticker getting scuffed on a site.
      qrSvg: await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }),
    });
  }

  await mkdir('tmp', { recursive: true });
  const path = 'tmp/stickers.html';
  await writeFile(path, sheetHtml(stickers), 'utf8');

  process.stdout.write(`${stickers.length} sticker(s) written to ${path}\n`);
  process.stdout.write('Open it and print to A4. Each sticker links to:\n');
  for (const sticker of stickers) process.stdout.write(`  ${sticker.code}  ${sticker.url}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
