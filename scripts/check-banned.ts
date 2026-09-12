/**
 * The banned-character and banned-dependency guard.
 *
 * The client rejected em dashes by name, in every surface: UI copy, README,
 * comments and commit messages. A one-time sweep does not hold, because new
 * work reintroduces them, so this runs in CI beside gitleaks and fails the
 * build on the first one.
 *
 * It also guards the two font families and the icon libraries that were
 * rejected by name, and the middle dot used to join meta strings.
 *
 * Run with: pnpm check:banned
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/**
 * Characters that may not appear in a tracked source or doc file.
 *
 * `skipFencedBlocks` exempts fenced code blocks in Markdown. The middle dot is
 * banned as a way of joining meta strings in the interface, not as a drawing
 * character: the ASCII architecture diagrams use it as a list separator inside
 * a picture, which is a different thing and stays.
 */
const BANNED_CHARS: Array<{ char: string; name: string; hint: string; skipFencedBlocks?: boolean }> = [
  {
    char: '—',
    name: 'em dash',
    hint: 'Use a comma or a full stop. An em dash between clauses is almost never a hyphen.',
  },
  {
    char: '·',
    name: 'middle dot',
    hint: 'Meta strings joined with middle dots are banned. Use a comma, or separate the elements.',
    skipFencedBlocks: true,
  },
];

/**
 * Banned identifiers, matched case-insensitively against file contents.
 * Kept narrow on purpose: a substring that can occur innocently (for example
 * the word "inter" inside "interface") is matched in its import or font-family
 * form only.
 */
const BANNED_PATTERNS: Array<{ pattern: RegExp; name: string; hint: string }> = [
  { pattern: /lucide-react|from ['"]lucide/i, name: 'Lucide icons', hint: 'Draw the glyph inline as SVG. See docs/design.md.' },
  { pattern: /@heroicons|react-icons|font-awesome|feather-icons/i, name: 'icon library', hint: 'No icon library. Draw it inline or use a word.' },
  { pattern: /['"]Inter['"]|font-family:\s*Inter\b|next\/font\/google['"];?[\s\S]{0,200}\bInter\b/, name: 'Inter', hint: 'Use IBM Plex Sans.' },
  { pattern: /['"]Geist['"]|geist\/font|['"]Space Grotesk['"]/i, name: 'Geist or Space Grotesk', hint: 'Use IBM Plex Sans.' },
];

/** Files exempt from the character rules, by exact path. */
const CHAR_EXEMPT = new Set<string>([
  'pnpm-lock.yaml',
  'scripts/check-banned.ts',
]);

/** Files exempt from the dependency patterns. The lockfile records transitive names we do not import. */
const PATTERN_EXEMPT = new Set<string>([
  'pnpm-lock.yaml',
  'scripts/check-banned.ts',
  'docs/extension-brief.md',
  'docs/design.md',
]);

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|mp3|ogg|wav|m4a)$/i;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f.length > 0);
}

type Finding = { file: string; line: number; column: number; label: string; hint: string; text: string };

function main(): void {
  const findings: Finding[] = [];

  for (const file of trackedFiles()) {
    if (BINARY_EXT.test(file)) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // Deleted but still in the index.
    }
    if (!stat.isFile()) continue;

    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);

    if (!CHAR_EXEMPT.has(file)) {
      // Track fenced blocks once, so a rule can opt out of them.
      const fenced: boolean[] = [];
      let inFence = false;
      for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
          fenced.push(true);
          inFence = !inFence;
          continue;
        }
        fenced.push(inFence);
      }

      for (const { char, name, hint, skipFencedBlocks } of BANNED_CHARS) {
        lines.forEach((line, i) => {
          if (skipFencedBlocks && fenced[i]) return;
          let col = line.indexOf(char);
          while (col !== -1) {
            findings.push({ file, line: i + 1, column: col + 1, label: name, hint, text: line.trim().slice(0, 120) });
            col = line.indexOf(char, col + 1);
          }
        });
      }
    }

    if (!PATTERN_EXEMPT.has(file)) {
      for (const { pattern, name, hint } of BANNED_PATTERNS) {
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            findings.push({ file, line: i + 1, column: 1, label: name, hint, text: line.trim().slice(0, 120) });
          }
        });
      }
    }
  }

  if (findings.length === 0) {
    console.log('check:banned clean. No banned characters, fonts or icon libraries in tracked files.');
    return;
  }

  console.error(`check:banned found ${findings.length} violation(s):\n`);
  const byLabel = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byLabel.get(f.label) ?? [];
    list.push(f);
    byLabel.set(f.label, list);
  }
  for (const [label, list] of byLabel) {
    console.error(`${label} (${list.length}): ${list[0]?.hint ?? ''}`);
    for (const f of list) {
      console.error(`  ${f.file}:${f.line}:${f.column}  ${f.text}`);
    }
    console.error('');
  }
  process.exit(1);
}

main();
