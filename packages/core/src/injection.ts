/**
 * Prompt-injection heuristics. This never blocks a worker: it sets a flag, writes
 * an audit event and puts a badge on the card. Content never grants privileges,
 * whatever it says - the real defence is that the worker-facing agent has no
 * privileged tools at all.
 */

const PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|your\s+|previous\s+|prior\s+|the\s+)*(instructions|rules|prompt)/i,
  /disregard\s+(all\s+|your\s+|the\s+)?(instructions|rules|previous)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /system\s*(prompt|message|role)\s*[:=]/i,
  /\b(developer|admin|root)\s*mode\b/i,
  /pretend\s+(you\s+are|to\s+be)\b/i,
  /\bjailbreak\b/i,
  /reveal\s+(the\s+)?(identity|reporter|who\s+(sent|reported))/i,
  /approve\s+(this|the|my)?\s*(pay|payment|overtime|adjustment)/i,
  /(without|no|skip)\s+(the\s+)?(approval|supervisor|hr|human|review)/i,
  /<\s*\/?\s*(system|untrusted_content|instructions)\s*>/i,
];

export interface InjectionCheck {
  suspected: boolean;
  matched: string[];
}

export function injectionHeuristic(text: string | null | undefined): InjectionCheck {
  if (!text) return { suspected: false, matched: [] };
  const matched = PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  return { suspected: matched.length > 0, matched };
}

/**
 * Wrap every piece of untrusted text before it reaches a model. The closing tag is
 * neutralised inside the content so a transcript cannot close its own boundary.
 */
export function wrapUntrusted(text: string): string {
  const neutralised = text.replace(/<\s*\/?\s*untrusted_content\s*>/gi, '[tag removed]');
  return `<untrusted_content>\n${neutralised}\n</untrusted_content>`;
}
