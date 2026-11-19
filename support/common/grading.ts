import { isOptionKey, type Answers, type OptionKey } from './types.js';

export interface GradeInput {
  n: number;
  correct: OptionKey;
}

export interface GradeResult {
  correct: number;
  wrong: number;
  unanswered: number;
  total: number;
  /** Percentage with one decimal place, e.g. 73.3 */
  pct: number;
  perQ: { n: number; selected: OptionKey | null; isCorrect: boolean }[];
}

export function scorePct(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
}

/** Drops anything that isn't a known question number mapped to A–D. */
export function sanitizeAnswers(raw: unknown, allowed: ReadonlySet<number>): Answers {
  const out: Answers = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(k);
    if (Number.isInteger(n) && allowed.has(n) && isOptionKey(v)) out[n] = v;
  }
  return out;
}

/** Unanswered questions count as incorrect, as the test instructions state. */
export function gradeAttempt(questions: readonly GradeInput[], answers: Answers): GradeResult {
  let correct = 0;
  const perQ = questions.map((q) => {
    const selected = answers[q.n] ?? null;
    const isCorrect = selected === q.correct;
    if (isCorrect) correct++;
    return { n: q.n, selected, isCorrect };
  });
  const unanswered = perQ.filter((p) => !p.selected).length;
  const total = questions.length;
  return { correct, wrong: total - correct - unanswered, unanswered, total, pct: scorePct(correct, total), perQ };
}
