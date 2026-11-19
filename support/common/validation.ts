import { OPTION_KEYS, isOptionKey, type OptionKey, type QuestionOption } from './types.js';

export function normalizeName(raw: unknown): string {
  return typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
}

/** Returns an error message, or '' when the (normalized) name is acceptable. */
export function nameError(name: string): string {
  if (name.length < 2) return 'Enter your full name.';
  if (name.length > 80) return 'Name must be 80 characters or fewer.';
  if (!/^[\p{L}][\p{L}\p{M}\s.'’-]*$/u.test(name)) return 'Use letters, spaces, hyphens and apostrophes only.';
  if (name.split(' ').length < 2) return 'Enter your first and last name.';
  return '';
}

export interface QuestionEdit {
  text: string;
  options: QuestionOption[];
  correct: OptionKey;
  explanation: string;
  topic: string;
  topicInferred: boolean;
  active: boolean;
}

export type QuestionEditErrors = Partial<Record<'text' | 'opt' | 'exp' | 'topic', string>>;

/** Validates and cleans an admin edit. Same rules run in the browser and on the server. */
export function validateQuestionEdit(
  input: unknown,
  topicIds: readonly string[],
): { ok: true; value: QuestionEdit } | { ok: false; errors: QuestionEditErrors } {
  const d = (input ?? {}) as Record<string, unknown>;
  const errors: QuestionEditErrors = {};
  const text = typeof d.text === 'string' ? d.text.trim() : '';
  if (!text) errors.text = 'Question text is required.';
  else if (text.length > 300) errors.text = 'Keep question text under 300 characters.';

  const rawOpts = Array.isArray(d.options) ? d.options : [];
  const options: QuestionOption[] = OPTION_KEYS.map((key) => {
    const o = rawOpts.find((x: unknown) => (x as QuestionOption)?.key === key) as QuestionOption | undefined;
    return { key, text: typeof o?.text === 'string' ? o.text.trim() : '' };
  });
  if (options.some((o) => !o.text)) errors.opt = 'All four options need text.';
  else if (options.some((o) => o.text.length > 200)) errors.opt = 'Keep each option under 200 characters.';
  else if (new Set(options.map((o) => o.text.toLowerCase())).size < 4) errors.opt = 'Options must be different from each other.';
  if (!isOptionKey(d.correct)) errors.opt = 'Select the correct answer.';

  const explanation = typeof d.explanation === 'string' ? d.explanation.trim() : '';
  if (!explanation) errors.exp = 'Explanation is required.';
  else if (explanation.length > 1500) errors.exp = 'Keep the explanation under 1,500 characters.';

  const topic = typeof d.topic === 'string' ? d.topic : '';
  if (!topicIds.includes(topic)) errors.topic = 'Choose a topic.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      text,
      options,
      correct: d.correct as OptionKey,
      explanation,
      topic,
      topicInferred: d.topicInferred !== false,
      active: d.active !== false,
    },
  };
}

export function settingsError(passMark: unknown, minSample: unknown, activeTotal: number): string {
  const pm = Number(passMark);
  const ms = Number(minSample);
  if (!Number.isInteger(pm) || pm < 1 || pm > activeTotal) return `Pass mark must be a whole number from 1 to ${activeTotal}.`;
  if (!Number.isInteger(ms) || ms < 1 || ms > 500) return 'Minimum responses must be a whole number from 1 to 500.';
  return '';
}
