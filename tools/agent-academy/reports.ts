import { isPass, overview, questionStats, topicStats } from '../../shared/analytics.js';
import { excelSerial, fmtDMY, fmtDMYHM, inRange, type Range } from '../../shared/time.js';
import type { AdminAttempt, BankQuestion, Settings, Topic } from '../../shared/types.js';
import { buildXlsx, type Cell, type SheetSpec } from '../../core/xlsx.js';

export interface ReportInput {
  questions: BankQuestion[];
  topics: Topic[];
  attempts: AdminAttempt[];
  settings: Settings;
}

export interface Summary {
  started: number;
  completed: number;
  inProgress: number;
  passed: number;
  passRate: number | null;
  avg: number | null;
  avgPct: number | null;
  high: number | null;
  low: number | null;
  total: number;
  mostMissed: { n: number; text: string; pctIncorrect: number; responses: number }[];
}

/** Attempts submitted in the range (graded), plus attempts started in the range and still open. */
export function rangeAttempts(attempts: AdminAttempt[], r: Range) {
  return {
    done: attempts.filter((a) => a.status === 'completed' && inRange(a.submittedAt, r)),
    open: attempts.filter((a) => a.status === 'in_progress' && inRange(a.startedAt, r)),
    started: attempts.filter((a) => inRange(a.startedAt, r)),
  };
}

export function summarize(input: ReportInput, r: Range): Summary {
  const { done, open, started } = rangeAttempts(input.attempts, r);
  const o = overview(done, input.settings.passMark);
  const total = input.questions.filter((q) => q.active).length;
  const missed = questionStats(input.questions.filter((q) => q.active), done)
    .filter((s) => s.responses > 0 && s.incorrect > 0)
    .sort((a, b) => b.pctIncorrect - a.pctIncorrect || a.n - b.n)
    .slice(0, 3)
    .map((s) => ({ n: s.n, text: s.text, pctIncorrect: s.pctIncorrect, responses: s.responses }));
  return {
    started: started.length,
    completed: done.length,
    inProgress: open.length,
    passed: o.passed,
    passRate: o.passRate,
    avg: o.avg,
    avgPct: o.avg == null ? null : Math.round((o.avg / total) * 100),
    high: o.high,
    low: o.low,
    total,
    mostMissed: missed,
  };
}

const dateCell = (iso: string, tz: string): Cell => ({ v: Math.floor(excelSerial(iso, tz)), s: 'date' });
const timeCell = (iso: string, tz: string): Cell => {
  const x = excelSerial(iso, tz);
  return { v: Math.round((x - Math.floor(x)) * 1440) / 1440, s: 'time' };
};
const tgCell = (a: AdminAttempt) => (a.telegramUsername ? '@' + a.telegramUsername : a.channel === 'telegram' ? 'Telegram' : 'Web');
const minutes = (sec: number | null) => (sec == null ? null : Math.max(1, Math.round(sec / 60)));

/** Builds the Excel report: Summary, Results, In progress, Answers, Questions, Topics. */
export function buildReport(input: ReportInput, r: Range, generatedAt = new Date()): Uint8Array {
  const tz = input.settings.timezone;
  const pm = input.settings.passMark;
  const { done, open } = rangeAttempts(input.attempts, r);
  const byNewest = done.slice().sort((a, b) => b.submittedAt!.localeCompare(a.submittedAt!));
  const s = summarize(input, r);
  const active = input.questions.filter((q) => q.active);
  const pct = (n: number | null) => (n == null ? '—' : { v: n / 100, s: 'pct' as const });

  const summary: SheetSpec = {
    name: 'Summary',
    table: false,
    columns: [{ header: '', width: 30 }, { header: '', width: 26 }],
    rows: [
      [{ v: 'CFT Agent Academy — Results report', s: 'title' }],
      [{ v: `Period: ${r.label}`, s: 'muted' }],
      [{ v: `Generated: ${fmtDMYHM(generatedAt, tz)} (${tz})`, s: 'muted' }],
      [],
      [{ v: 'Attempts started', s: 'bold' }, { v: s.started, s: 'int' }],
      [{ v: 'Completed', s: 'bold' }, { v: s.completed, s: 'int' }],
      [{ v: 'Still in progress', s: 'bold' }, { v: s.inProgress, s: 'int' }],
      [{ v: 'Passed', s: 'bold' }, { v: s.passed, s: 'int' }],
      [{ v: 'Failed', s: 'bold' }, { v: s.completed - s.passed, s: 'int' }],
      [{ v: 'Pass rate', s: 'bold' }, pct(s.passRate)],
      [{ v: 'Average score', s: 'bold' }, s.avg == null ? '—' : `${s.avg.toFixed(1)} / ${s.total} (${s.avgPct}%)`],
      [{ v: 'Highest / lowest', s: 'bold' }, s.high == null ? '—' : `${s.high} / ${s.low}`],
      [{ v: 'Pass mark', s: 'bold' }, `${pm} / ${s.total} (${Math.round((pm / s.total) * 100)}%)`],
      [],
      [{ v: 'Topics are inferred from question content. Percentages are rounded to whole numbers.', s: 'muted' }],
    ],
  };

  const results: SheetSpec = {
    name: 'Results',
    columns: [
      { header: '#', width: 5, style: 'int' }, { header: 'Candidate', width: 26 }, { header: 'Telegram', width: 18 },
      { header: 'Date', width: 12 }, { header: 'Time', width: 8 }, { header: 'Score', width: 8, style: 'center' },
      { header: 'Percent', width: 9 }, { header: 'Result', width: 10 }, { header: 'Unanswered', width: 12, style: 'int' },
      { header: 'Duration (min)', width: 15, style: 'int' },
    ],
    rows: byNewest.map((a, i) => {
      const pass = isPass(a, pm);
      return [
        i + 1, a.name, tgCell(a), dateCell(a.submittedAt!, tz), timeCell(a.submittedAt!, tz), `${a.correct}/${a.total}`,
        { v: Math.round((a.pct ?? 0) * 10) / 1000, s: 'pct' }, { v: pass ? 'PASS' : 'FAIL', s: pass ? 'good' : 'bad' }, a.unanswered ?? 0, minutes(a.durationSec),
      ];
    }),
  };

  const inProgress: SheetSpec = {
    name: 'In progress',
    columns: [{ header: 'Candidate', width: 26 }, { header: 'Telegram', width: 18 }, { header: 'Started', width: 12 }, { header: 'Time', width: 8 }, { header: 'Answered', width: 11, style: 'center' }],
    rows: open.map((a) => [a.name, tgCell(a), dateCell(a.startedAt, tz), timeCell(a.startedAt, tz), `${a.answeredCount}/${a.total}`]),
  };

  const qNums = active.map((q) => q.n);
  const answers: SheetSpec = {
    name: 'Answers',
    columns: [{ header: 'Candidate', width: 26 }, { header: 'Date', width: 12 }, { header: 'Score', width: 8, style: 'center' }, ...qNums.map((n) => ({ header: `Q${n}`, width: 5.5 }))],
    rows: byNewest.map((a) => [
      a.name, dateCell(a.submittedAt!, tz), `${a.correct}/${a.total}`,
      ...qNums.map((n): Cell => {
        if (a.correctness[n] === undefined) return null;
        const sel = a.answers[n];
        return { v: sel ?? '—', s: a.correctness[n] ? 'good' : 'bad' };
      }),
    ]),
  };

  const qstats = questionStats(active, done);
  const topicName = (id: string) => input.topics.find((t) => t.id === id)?.name ?? id;
  const questions: SheetSpec = {
    name: 'Questions',
    columns: [
      { header: 'Q', width: 5, style: 'int' }, { header: 'Question', width: 58, style: 'wrap' }, { header: 'Topic (inferred)', width: 26 },
      { header: 'Answer', width: 8, style: 'center' }, { header: 'Responses', width: 11, style: 'int' }, { header: 'Correct', width: 9 },
      { header: 'Wrong', width: 9 }, { header: 'Most chosen wrong answer', width: 40, style: 'wrap' }, { header: 'Times', width: 7, style: 'int' },
    ],
    rows: qstats
      .slice()
      .sort((a, b) => b.pctIncorrect - a.pctIncorrect || a.n - b.n)
      .map((x) => [
        x.n, x.text, topicName(x.topic), x.correctKey, x.responses,
        x.responses ? { v: x.pctCorrect / 100, s: 'pct' } : '—', x.responses ? { v: x.pctIncorrect / 100, s: 'pct' } : '—',
        x.topWrong ? `${x.topWrong.key}. ${x.topWrong.text}` : '', x.topWrong?.count ?? null,
      ]),
  };

  const topics: SheetSpec = {
    name: 'Topics',
    columns: [{ header: 'Topic (inferred)', width: 32 }, { header: 'Questions', width: 11, style: 'int' }, { header: 'Answers', width: 10, style: 'int' }, { header: 'Accuracy', width: 10 }, { header: 'Weakest question', width: 18 }],
    rows: topicStats(input.topics, qstats)
      .sort((a, b) => a.accuracy - b.accuracy)
      .map((t) => [t.name, t.questions, t.answers, t.answers ? { v: t.accuracy / 100, s: 'pct' } : '—', t.weakest && t.answers ? `Q${t.weakest.n} (${t.weakest.pctCorrect}% correct)` : '']),
  };

  return buildXlsx([summary, results, inProgress, answers, questions, topics], 'CFT Agent Academy report');
}

export function reportFilename(r: Range, tz: string, key: string, now = new Date()): string {
  const d = (x: Date) => fmtDMY(x, tz).replace(/\//g, '-');
  if (key === 'week' || key === 'last_week') {
    const to = r.to ? new Date(r.to.getTime() - 1) : now;
    return `CFT_Academy_Week_${d(r.from!)}_to_${d(to)}.xlsx`;
  }
  return `CFT_Academy_Report_${key === '30d' ? 'last-30-days' : 'all-time'}_${d(now)}.xlsx`;
}
