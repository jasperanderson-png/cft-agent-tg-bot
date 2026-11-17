import { describe, expect, it } from 'vitest';
import { findPatterns, overview, questionStats, scoreDistribution, topicStats } from '../../shared/analytics.js';
import { csvCell, toCSV } from '../../shared/csv.js';
import { gradeAttempt, sanitizeAnswers, scorePct } from '../../shared/grading.js';
import type { AdminAttempt, BankQuestion, OptionKey } from '../../shared/types.js';
import { nameError, normalizeName, settingsError, validateQuestionEdit } from '../../shared/validation.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { verifyInitData } from '../telegram.js';
import { signInitData } from './helpers.js';

const Q = (n: number, correct: OptionKey, topic = 't1'): BankQuestion => ({
  id: n, n, text: `Question ${n}`, correct, topic, topicInferred: true, active: true, revision: 1, edited: false,
  explanation: 'e', whyCorrect: '', why: {}, basis: '',
  options: (['A', 'B', 'C', 'D'] as const).map((k) => ({ key: k, text: `${n}${k}` })),
});

const att = (id: string, answers: Partial<Record<number, OptionKey>>, qs: BankQuestion[], status: 'completed' | 'in_progress' = 'completed'): AdminAttempt => {
  const correctness: Record<number, boolean> = {};
  if (status === 'completed') for (const q of qs) correctness[q.n] = answers[q.n] === q.correct;
  const correct = Object.values(correctness).filter(Boolean).length;
  return {
    id, candidateId: 'c-' + id, name: 'Name ' + id, channel: 'telegram', telegramUsername: null, tokenTail: 'abcd', status,
    startedAt: '2026-10-01T10:00:00Z', submittedAt: status === 'completed' ? '2026-10-01T10:20:00Z' : null, durationSec: 1200,
    total: qs.length, correct: status === 'completed' ? correct : null, pct: status === 'completed' ? scorePct(correct, qs.length) : null,
    unanswered: null, passMark: 2, answeredCount: Object.keys(answers).length, answers: status === 'completed' ? answers : {}, correctness,
  };
};

describe('grading', () => {
  const qs = [Q(1, 'A'), Q(2, 'B'), Q(3, 'C')];

  it('grades correct, wrong and unanswered questions', () => {
    const g = gradeAttempt(qs, { 1: 'A', 2: 'C' });
    expect(g).toMatchObject({ correct: 1, wrong: 1, unanswered: 1, total: 3, pct: 33.3 });
    expect(g.perQ).toEqual([
      { n: 1, selected: 'A', isCorrect: true },
      { n: 2, selected: 'C', isCorrect: false },
      { n: 3, selected: null, isCorrect: false },
    ]);
  });

  it('computes percentages with one decimal and handles edge cases', () => {
    expect(scorePct(21, 30)).toBe(70);
    expect(scorePct(22, 30)).toBe(73.3);
    expect(scorePct(30, 30)).toBe(100);
    expect(scorePct(0, 0)).toBe(0);
    expect(gradeAttempt(qs, {}).pct).toBe(0);
  });

  it('drops answers for unknown questions and invalid options', () => {
    expect(sanitizeAnswers({ 1: 'A', 2: 'Z', 99: 'B', x: 'C', 3: 'd' }, new Set([1, 2, 3]))).toEqual({ 1: 'A' });
    expect(sanitizeAnswers('nope', new Set([1]))).toEqual({});
    expect(sanitizeAnswers([1, 2], new Set([1]))).toEqual({});
  });
});

describe('analytics', () => {
  const qs = [Q(1, 'A', 'roles'), Q(2, 'B', 'roles'), Q(3, 'C', 'offer')];
  const attempts = [
    att('1', { 1: 'A', 2: 'B', 3: 'C' }, qs),
    att('2', { 1: 'B', 2: 'B', 3: 'A' }, qs),
    att('3', { 1: 'B', 2: 'B' }, qs),
    att('4', { 1: 'B' }, qs, 'in_progress'),
  ];

  it('computes per-question responses, distribution and most common wrong answer', () => {
    const s = questionStats(qs, attempts);
    expect(s[0]).toMatchObject({ n: 1, responses: 3, correct: 1, incorrect: 2, pctCorrect: 33, pctIncorrect: 67, dist: { A: 1, B: 2, C: 0, D: 0, none: 0 } });
    expect(s[0].topWrong).toMatchObject({ key: 'B', count: 2, pct: 67, text: '1B' });
    expect(s[2]).toMatchObject({ responses: 3, correct: 1, unanswered: 1 });
    expect(s[1].topWrong).toBeNull();
  });

  it('uses correctness recorded at grading time, not the current answer key', () => {
    const edited = [{ ...qs[0], correct: 'B' as const }, qs[1], qs[2]];
    expect(questionStats(edited, attempts)[0].correct).toBe(1);
  });

  it('aggregates topics and picks the weakest question', () => {
    const t = topicStats([{ id: 'roles', name: 'Roles' }, { id: 'offer', name: 'Offer' }, { id: 'empty', name: 'Empty' }], questionStats(qs, attempts));
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ id: 'roles', questions: 2, answers: 6, correct: 4, incorrect: 2, accuracy: 67 });
    expect(t[0].weakest?.n).toBe(1);
  });

  it('only reports patterns that reach the minimum sample size', () => {
    const qstats = questionStats(qs, attempts);
    const tstats = topicStats([{ id: 'roles', name: 'Roles' }, { id: 'offer', name: 'Offer' }], qstats);
    expect(findPatterns(qstats, tstats, 10)).toEqual([]);
    const p = findPatterns(qstats, tstats, 3);
    expect(p.map((x) => x.kind)).toContain('FREQUENTLY MISSED');
    expect(p.find((x) => x.kind === 'FREQUENTLY MISSED')?.title).toContain('Q1 answered incorrectly by 2 of 3');
    expect(p.find((x) => x.kind === 'LOW TOPIC ACCURACY')?.title).toBe('Roles: 67% accuracy');
  });

  it('summarizes the overview and score distribution', () => {
    const o = overview(attempts, 2);
    expect(o).toMatchObject({ candidates: 4, started: 4, completed: 3, inProgress: 1, high: 3, low: 1, completionRate: 75, passed: 1, passRate: 33 });
    expect(o.avg).toBeCloseTo(5 / 3);
    const d = scoreDistribution(attempts, 3);
    expect(d).toEqual([{ score: 0, count: 0 }, { score: 1, count: 2 }, { score: 2, count: 0 }, { score: 3, count: 1 }]);
    expect(overview([], 21)).toMatchObject({ avg: null, completionRate: null, passRate: null });
  });
});

describe('CSV export', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(73.3)).toBe('73.3');
  });

  it('neutralizes spreadsheet formulas in text but not numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell(-5)).toBe('-5');
  });

  it('builds rows with CRLF line endings', () => {
    const csv = toCSV([{ label: 'Name', get: (r: { n: string }) => r.n }, { label: 'Score', get: () => 1 }], [{ n: 'Lee, Ann' }]);
    expect(csv).toBe('Name,Score\r\n"Lee, Ann",1');
  });
});

describe('validation', () => {
  it('normalizes and validates candidate names', () => {
    expect(normalizeName('  Ann   Lee  ')).toBe('Ann Lee');
    expect(nameError('Ann Lee')).toBe('');
    expect(nameError("Olena O’Neil-Kovalenko")).toBe('');
    expect(nameError('Ann')).toMatch(/first and last/);
    expect(nameError('A')).toMatch(/full name/);
    expect(nameError('<script> x')).toMatch(/letters/);
    expect(nameError('A'.repeat(81))).toMatch(/80/);
  });

  it('validates question edits', () => {
    const base = { text: ' Q? ', options: ['A', 'B', 'C', 'D'].map((k) => ({ key: k, text: 'opt ' + k })), correct: 'B', explanation: 'x', topic: 'roles' };
    const okRes = validateQuestionEdit(base, ['roles']);
    expect(okRes.ok && okRes.value.text).toBe('Q?');
    expect(validateQuestionEdit({ ...base, text: '' }, ['roles'])).toMatchObject({ ok: false, errors: { text: expect.any(String) } });
    expect(validateQuestionEdit({ ...base, correct: 'E' }, ['roles'])).toMatchObject({ ok: false, errors: { opt: 'Select the correct answer.' } });
    const dup = { ...base, options: base.options.map((o) => ({ ...o, text: 'same' })) };
    expect(validateQuestionEdit(dup, ['roles'])).toMatchObject({ ok: false, errors: { opt: expect.stringMatching(/different/) } });
    expect(validateQuestionEdit({ ...base, topic: 'nope' }, ['roles'])).toMatchObject({ ok: false });
  });

  it('validates settings', () => {
    expect(settingsError(21, 10, 30)).toBe('');
    expect(settingsError(31, 10, 30)).toMatch(/1 to 30/);
    expect(settingsError(20.5, 10, 30)).toMatch(/whole number/);
    expect(settingsError(21, 0, 30)).toMatch(/Minimum/);
  });
});

describe('Telegram initData', () => {
  const token = '123456:TEST-token';
  const user = { id: 42, first_name: 'Ann', last_name: 'Lee', username: 'annlee' };

  it('accepts correctly signed data', () => {
    const v = verifyInitData(signInitData(user, token, undefined, { start_param: 'admin' }), token, 3600);
    expect(v).toMatchObject({ user: { id: 42, first_name: 'Ann' }, startParam: 'admin' });
  });

  it('rejects tampered, wrongly signed and expired data', () => {
    const good = signInitData(user, token);
    expect(verifyInitData(good.replace('Ann', 'Bob'), token, 3600)).toBeNull();
    expect(verifyInitData(good, '999:other', 3600)).toBeNull();
    expect(verifyInitData(signInitData(user, token, Math.floor(Date.now() / 1000) - 7200), token, 3600)).toBeNull();
    expect(verifyInitData('', token, 3600)).toBeNull();
    expect(verifyInitData('user=%7B%7D&hash=zz', token, 3600)).toBeNull();
  });
});

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});
