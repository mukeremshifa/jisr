/**
 * Terms that must survive translation unchanged. Injected into every translation
 * prompt. Workers say "OT" and "camp boss" in every language; translating them
 * produces something nobody at the site would recognise.
 */
export interface GlossaryTerm {
  term: string;
  meaning: string;
}

export const GLOSSARY: readonly GlossaryTerm[] = [
  { term: 'OT', meaning: 'overtime' },
  { term: 'WPS', meaning: 'Wage Protection System (UAE salary transfer system)' },
  { term: 'camp boss', meaning: 'the person in charge of the accommodation camp' },
  { term: 'Emirates ID', meaning: 'the UAE national identity card' },
  { term: 'MOHRE', meaning: 'UAE Ministry of Human Resources and Emiratisation' },
  { term: 'labour card', meaning: 'the work permit card' },
  { term: 'site', meaning: 'the work location' },
  { term: 'Site A', meaning: 'the site named "Al Quoz yard" — keep the name as-is' },
  { term: 'Site B', meaning: 'the site named "Camp and site" — keep the name as-is' },
  { term: 'midday break', meaning: 'the legally required 12:30–15:00 outdoor work break, 15 June – 15 September' },
];

/** Rendered into prompts. Kept short: a long glossary crowds out the transcript. */
export function glossaryBlock(): string {
  return GLOSSARY.map((g) => `- "${g.term}" = ${g.meaning}. Keep "${g.term}" as-is.`).join('\n');
}
