import { describe, expect, it } from 'vitest';
import { escapeSlackText, hereMention, sanitizeText, slackQuote } from '@jisr/core';

/** Written as code points so the file stays readable and greppable. */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const RTL_OVERRIDE = String.fromCodePoint(0x202e);
const NUL = String.fromCodePoint(0x00);

describe('Slack escaping', () => {
  it('escapes the three characters Slack treats specially', () => {
    expect(escapeSlackText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('stops worker text from firing a channel-wide mention', () => {
    const quoted = slackQuote('<!channel> everyone come now');
    expect(quoted).not.toContain('<!channel>');
    expect(quoted).toContain('&lt;!channel&gt;');
  });

  it('stops worker text from disguising a link', () => {
    const quoted = slackQuote('<https://evil.example|payroll portal>');
    expect(quoted).not.toMatch(/^<https/);
    expect(quoted).toContain('&lt;https://evil.example');
  });

  it('strips invisible characters that could hide a spoofed mention', () => {
    expect(slackQuote(`a${ZERO_WIDTH_SPACE}${RTL_OVERRIDE}b`)).toBe('ab');
  });

  it('collapses whitespace and truncates long quotes', () => {
    expect(slackQuote('one   two\n\nthree')).toBe('one two three');
    const long = slackQuote('x'.repeat(500), 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith('...')).toBe(true);
  });

  it('only we can produce an @here', () => {
    expect(hereMention()).toBe('<!here>');
  });
});

describe('input sanitisation', () => {
  it('normalises, strips control characters and caps length', () => {
    expect(sanitizeText(`  hello${NUL}world  `)).toBe('helloworld');
    expect(sanitizeText('a'.repeat(100), 10)).toHaveLength(10);
    expect(sanitizeText(null)).toBe('');
  });

  it('keeps newlines and tabs, which are meaningful in a transcript', () => {
    expect(sanitizeText('line one\nline two')).toBe('line one\nline two');
  });

  it('removes bidirectional overrides', () => {
    expect(sanitizeText(`safe${RTL_OVERRIDE}txt.exe`)).toBe('safetxt.exe');
  });
});
