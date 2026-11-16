import { OPTION_KEYS, type AdminAttempt, type BankQuestion, type OptionKey, type Topic } from './types.js';

export interface QuestionStat {
  n: number;
  text: string;
  topic: string;
  correctKey: OptionKey;
  responses: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  pctCorrect: number;
  pctIncorrect: number;
  dist: Record<OptionKey | 'none', number>;
  topWrong: { key: OptionKey; count: number; pct: number; text: string } | null;
}

export interface TopicStat {
  id: string;
  name: string;
  questions: number;
  answers: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  weakest: QuestionStat | undefined;
}

export interface Pattern {
  kind: 'FREQUENTLY MISSED' | 'SHARED WRONG ANSWER' | 'LOW TOPIC ACCURACY';
  n: string;
  title: string;
  detail: string;
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** Thresholds for "observed patterns". Kept here so the UI can explain them. */
export const PATTERN_RULES = { missedPct: 40, lowTopicAccuracy: 70, sharedWrongMin: 4, sharedWrongShare: 0.25 } as const;

/**
 * Per-question statistics over graded attempts. Correctness comes from what was recorded at grading
 * time, so editing a question's answer key later doesn't rewrite history.
 */
export function questionStats(questions: readonly BankQuestion[], attempts: readonly AdminAttempt[]): QuestionStat[] {
  const done = attempts.filter((a) => a.status === 'completed');
  return questions.map((q) => {
    const dist: QuestionStat['dist'] = { A: 0, B: 0, C: 0, D: 0, none: 0 };
    let responses = 0;
    let correct = 0;
    for (const a of done) {
      const graded = a.correctness[q.n];
      if (graded === undefined) continue; // question wasn't part of this attempt
      responses++;
      const s = a.answers[q.n];
      dist[s ?? 'none']++;
      if (graded) correct++;
    }
    const incorrect = responses - correct;
    const wrong = OPTION_KEYS.filter((k) => k !== q.correct)
      .map((k) => ({ key: k, count: dist[k] }))
      .sort((x, y) => y.count - x.count)[0];
    return {
      n: q.n,
      text: q.text,
      topic: q.topic,
      correctKey: q.correct,
      responses,
      correct,
      incorrect,
      unanswered: dist.none,
      pctCorrect: pct(correct, responses),
      pctIncorrect: pct(incorrect, responses),
      dist,
      topWrong: wrong && wrong.count
        ? { key: wrong.key, count: wrong.count, pct: pct(wrong.count, responses), text: q.options.find((o) => o.key === wrong.key)?.text ?? '' }
        : null,
    };
  });
}

export function topicStats(topics: readonly Topic[], qstats: readonly QuestionStat[]): TopicStat[] {
  return topics
    .map((t) => {
      const qs = qstats.filter((s) => s.topic === t.id);
      const answers = qs.reduce((a, s) => a + s.responses, 0);
      const correct = qs.reduce((a, s) => a + s.correct, 0);
      return {
        id: t.id,
        name: t.name,
        questions: qs.length,
        answers,
        correct,
        incorrect: answers - correct,
        accuracy: pct(correct, answers),
        weakest: qs.slice().sort((a, b) => a.pctCorrect - b.pctCorrect || a.n - b.n)[0],
      };
    })
    .filter((t) => t.questions > 0);
}

/** Observed patterns, only from questions/topics that reach the minimum sample size. */
export function findPatterns(qstats: readonly QuestionStat[], tstats: readonly TopicStat[], minSample: number): Pattern[] {
  const out: Pattern[] = [];
  qstats
    .filter((x) => x.responses >= minSample && x.pctIncorrect >= PATTERN_RULES.missedPct)
    .sort((a, b) => b.pctIncorrect - a.pctIncorrect || a.n - b.n)
    .forEach((x) =>
      out.push({
        kind: 'FREQUENTLY MISSED',
        n: `n = ${x.responses}`,
        title: `Q${x.n} answered incorrectly by ${x.incorrect} of ${x.responses} candidates (${x.pctIncorrect}%)`,
        detail: x.text,
      }),
    );
  qstats
    .filter((x) => x.responses >= minSample && x.topWrong && x.topWrong.count >= Math.max(PATTERN_RULES.sharedWrongMin, Math.ceil(x.responses * PATTERN_RULES.sharedWrongShare)))
    .sort((a, b) => b.topWrong!.count - a.topWrong!.count || a.n - b.n)
    .forEach((x) =>
      out.push({
        kind: 'SHARED WRONG ANSWER',
        n: `n = ${x.responses}`,
        title: `${x.topWrong!.count} of ${x.responses} candidates chose ${x.topWrong!.key} on Q${x.n}`,
        detail: `Chosen: “${x.topWrong!.text}”. Correct answer is ${x.correctKey}.`,
      }),
    );
  tstats
    .filter((t) => t.answers >= minSample && t.accuracy < PATTERN_RULES.lowTopicAccuracy)
    .forEach((t) =>
      out.push({
        kind: 'LOW TOPIC ACCURACY',
        n: `n = ${t.answers} answers`,
        title: `${t.name}: ${t.accuracy}% accuracy`,
        detail: `${t.correct} of ${t.answers} answers correct across ${t.questions} ${t.questions === 1 ? 'question' : 'questions'}. Topic assignment is inferred.`,
      }),
    );
  return out;
}

export interface Overview {
  candidates: number;
  started: number;
  completed: number;
  inProgress: number;
  avg: number | null;
  high: number | null;
  low: number | null;
  completionRate: number | null;
  passed: number;
  passRate: number | null;
}

export function overview(attempts: readonly AdminAttempt[], passMark: number): Overview {
  const done = attempts.filter((a) => a.status === 'completed');
  const scores = done.map((a) => a.correct ?? 0);
  const passed = done.filter((a) => (a.correct ?? 0) >= (a.passMark ?? passMark)).length;
  return {
    candidates: new Set(attempts.map((a) => a.candidateId)).size,
    started: attempts.length,
    completed: done.length,
    inProgress: attempts.length - done.length,
    avg: done.length ? scores.reduce((x, y) => x + y, 0) / done.length : null,
    high: done.length ? Math.max(...scores) : null,
    low: done.length ? Math.min(...scores) : null,
    completionRate: attempts.length ? pct(done.length, attempts.length) : null,
    passed,
    passRate: done.length ? pct(passed, done.length) : null,
  };
}

/** One bar per possible score from a little below the lowest observed score up to the total. */
export function scoreDistribution(attempts: readonly AdminAttempt[], total: number): { score: number; count: number }[] {
  const scores = attempts.filter((a) => a.status === 'completed').map((a) => a.correct ?? 0);
  const lo = scores.length ? Math.max(0, Math.min(...scores) - 2) : Math.max(0, total - 15);
  const out = [];
  for (let s = lo; s <= total; s++) out.push({ score: s, count: scores.filter((y) => y === s).length });
  return out;
}

export function isPass(a: AdminAttempt, passMark: number): boolean {
  return a.status === 'completed' && (a.correct ?? 0) >= (a.passMark ?? passMark);
}
