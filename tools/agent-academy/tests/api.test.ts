// End-to-end API tests against a real PostgreSQL database.
// Set TEST_DATABASE_URL (e.g. in .env.local); the database is wiped and rebuilt for each run.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../../core/crypto.js';
import { closePool, getPool } from '../../../db_storage/db.js';
import type { ApiRequest } from '../../../core/http.js';
import { handle } from '../../../telegram_bot/server/router.js';
import { migrate } from '../../../db_storage/migrate.js';
import { seed } from '../../../db_storage/seeds/academy/seed.js';
import { signInitData } from '../../../core/tests/helpers.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST-bot-token';
const OFFICIAL: { n: number; correct: string }[] = JSON.parse(readFileSync('db_storage/seeds/academy/questions.json', 'utf8'));

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const req: ApiRequest = { method, path, query: new URLSearchParams(), headers, body: body ?? null, ip: '10.0.0.1' };
  const res = await handle(req);
  return { status: res.status, body: res.body as any };
}
const tg = (id: number, first = 'Ann', last = 'Lee') => signInitData({ id, first_name: first, last_name: last, username: 'user' + id }, BOT);
const tok = (t: string) => ({ 'x-attempt-token': t });
const bearer = (t: string) => ({ authorization: 'Bearer ' + t });

describe.skipIf(!DB)('API (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.TELEGRAM_BOT_TOKEN = BOT;
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret-123456';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '';
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    await getPool().query("insert into admins (email, password_hash, telegram_user_id) values ('boss@cft.test', $1, 9001)", [await hashPassword('a-very-long-password')]);
  });
  beforeEach(() => {
    process.env.ALLOW_WEB_CANDIDATES = 'true';
  });
  afterAll(closePool);

  it('serves public config without the answer key', async () => {
    const r = await call('GET', 'config');
    expect(r.body).toMatchObject({ total: 30, passMark: 21, timeLimitMinutes: null, allowRetakes: false });
  });

  it('requires Telegram when web candidates are disabled', async () => {
    process.env.ALLOW_WEB_CANDIDATES = 'false';
    const r = await call('POST', 'attempts', { name: 'Ann Lee' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('telegram_required');
  });

  it('validates the candidate name on the server', async () => {
    expect((await call('POST', 'attempts', { name: 'Ann' })).status).toBe(400);
    expect((await call('POST', 'attempts', { name: '<b>x</b> y' })).status).toBe(400);
  });

  it('never exposes correct answers or explanations before submission', async () => {
    const r = await call('POST', 'attempts', { name: '  Ann   Lee ' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: 'in_progress', name: 'Ann Lee' });
    expect(r.body.questions).toHaveLength(30);
    const json = JSON.stringify(r.body);
    for (const leak of ['"correct"', 'explanation', '"why', 'basis', 'topic', 'Correct answer']) expect(json).not.toContain(leak);
    expect(Object.keys(r.body.questions[0]).sort()).toEqual(['n', 'options', 'text']);

    const again = await call('GET', `attempts/${r.body.attemptId}`, undefined, tok(r.body.token));
    expect(JSON.stringify(again.body)).not.toContain('explanation');
  });

  it('rejects unknown attempts and wrong tokens', async () => {
    const r = await call('POST', 'attempts', { name: 'Ben Cole' });
    expect((await call('GET', `attempts/${r.body.attemptId}`, undefined, tok('x'.repeat(43)))).status).toBe(404);
    expect((await call('GET', `attempts/${r.body.attemptId}`)).status).toBe(404);
    expect((await call('GET', 'attempts/not-a-uuid', undefined, tok(r.body.token))).status).toBe(404);
  });

  it('grades on the server, ignores client scores, and counts unanswered as incorrect', async () => {
    const r = await call('POST', 'attempts', { name: 'Cara Diaz' });
    const { attemptId, token } = r.body;
    // Save progress, including junk that must be ignored.
    const saved = await call('PUT', `attempts/${attemptId}/answers`, { answers: { 1: 'A', 2: 'Z', 99: 'B' } }, tok(token));
    expect(saved.body).toEqual({ saved: 1 });
    expect((await call('GET', `attempts/${attemptId}`, undefined, tok(token))).body.answers).toEqual({ 1: 'A' });

    // Correct for Q1–20, wrong for Q21–25, unanswered Q26–30.
    const answers: Record<number, string> = {};
    for (const q of OFFICIAL) {
      if (q.n <= 20) answers[q.n] = q.correct;
      else if (q.n <= 25) answers[q.n] = q.correct === 'A' ? 'B' : 'A';
    }
    const res = await call('POST', `attempts/${attemptId}/submit`, { answers, correct: 30, pct: 100, score: 30 }, tok(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'completed', correct: 20, total: 30, unanswered: 5, pct: 66.7, passMark: 21, passed: false });
    expect(res.body.alreadyCompleted).toBeUndefined();
    expect(res.body.questions[0]).toMatchObject({ n: 1, correct: OFFICIAL[0].correct, explanation: expect.any(String) });

    const row = (await getPool().query('select correct_count, score_pct, status, unanswered_count from assessment_attempts where id = $1', [attemptId])).rows[0];
    expect(row).toEqual({ correct_count: 20, score_pct: 66.7, status: 'completed', unanswered_count: 5 });
    const graded = (await getPool().query('select count(*) filter (where is_correct)::int c, count(*) filter (where is_correct is null)::int n from attempt_answers where attempt_id = $1', [attemptId])).rows[0];
    expect(graded).toEqual({ c: 20, n: 0 });
  });

  it('makes submission idempotent, including concurrent duplicates', async () => {
    const r = await call('POST', 'attempts', { name: 'Dan Evans' });
    const { attemptId, token } = r.body;
    const all = Object.fromEntries(OFFICIAL.map((q) => [q.n, q.correct]));
    const [a, b] = await Promise.all([
      call('POST', `attempts/${attemptId}/submit`, { answers: all }, tok(token)),
      call('POST', `attempts/${attemptId}/submit`, { answers: {} }, tok(token)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.correct).toBe(30);
    expect(b.body.correct).toBe(30);
    expect([a.body.alreadyCompleted, b.body.alreadyCompleted].filter(Boolean)).toHaveLength(1);

    // A later submit with different answers changes nothing.
    const c = await call('POST', `attempts/${attemptId}/submit`, { answers: { 1: 'D' } }, tok(token));
    expect(c.body).toMatchObject({ correct: 30, alreadyCompleted: true, submittedAt: a.body.submittedAt });
    expect((await call('PUT', `attempts/${attemptId}/answers`, { answers: { 1: 'D' } }, tok(token))).status).toBe(409);
  });

  describe('Telegram candidates', () => {
    it('rejects forged initData', async () => {
      const forged = tg(501).replace('Ann', 'Eve');
      const r = await call('POST', 'attempts', { name: 'Eve Fox', initData: forged });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('telegram_auth');
    });

    it('resumes the open attempt, rotates the token, and blocks a second attempt', async () => {
      const first = await call('POST', 'attempts', { name: 'Gus Hill', initData: tg(502) });
      expect(first.status).toBe(201);
      await call('PUT', `attempts/${first.body.attemptId}/answers`, { answers: { 3: 'C' } }, tok(first.body.token));

      const session = await call('POST', 'session', { initData: tg(502) });
      expect(session.body).toMatchObject({ state: 'in_progress', attemptId: first.body.attemptId, answers: { 3: 'C' } });
      expect(session.body.token).not.toBe(first.body.token);
      expect((await call('GET', `attempts/${first.body.attemptId}`, undefined, tok(first.body.token))).status).toBe(404);

      // Two simultaneous starts still map to the same attempt.
      const [s1, s2] = await Promise.all([
        call('POST', 'attempts', { name: 'Gus Hill', initData: tg(502) }),
        call('POST', 'attempts', { name: 'Gus Hill', initData: tg(502) }),
      ]);
      expect(s1.body.attemptId).toBe(first.body.attemptId);
      expect(s2.body.attemptId).toBe(first.body.attemptId);

      await call('POST', `attempts/${s2.body.attemptId}/submit`, { answers: {} }, tok(s2.body.token));
      const retry = await call('POST', 'attempts', { name: 'Gus Hill', initData: tg(502) });
      expect(retry.body).toMatchObject({ state: 'completed', attemptId: first.body.attemptId, alreadyCompleted: true });
      expect((await getPool().query('select count(*)::int n from assessment_attempts a join candidates c on c.id = a.candidate_id where c.telegram_user_id = 502')).rows[0].n).toBe(1);
    });

    it('offers a fresh attempt when retakes are enabled', async () => {
      const a = await call('POST', 'attempts', { name: 'Ida Jones', initData: tg(503) });
      await call('POST', `attempts/${a.body.attemptId}/submit`, { answers: {} }, tok(a.body.token));
      await getPool().query('update app_settings set allow_retakes = true');
      try {
        expect((await call('POST', 'session', { initData: tg(503) })).body.state).toBe('none');
        const b = await call('POST', 'attempts', { name: 'Ida Jones', initData: tg(503) });
        expect(b.body.state).toBe('in_progress');
        expect(b.body.attemptId).not.toBe(a.body.attemptId);
      } finally {
        await getPool().query('update app_settings set allow_retakes = false');
      }
    });

    it('suggests the Telegram name for a new candidate', async () => {
      const r = await call('POST', 'session', { initData: tg(504, 'Kai', 'Long') });
      expect(r.body).toEqual({ state: 'none', suggestedName: 'Kai Long', isAdmin: false });
    });
  });

  describe('admin', () => {
    let token = '';
    const login = (password: string, email = 'boss@cft.test') => call('POST', 'admin/login', { email, password });

    it('protects every admin route', async () => {
      for (const [m, p] of [['GET', 'admin/data'], ['GET', 'admin/me'], ['PUT', 'admin/settings'], ['PUT', 'admin/questions/1'], ['POST', 'admin/sheets/sync']]) {
        expect((await call(m, p, {})).status).toBe(401);
        expect((await call(m, p, {}, bearer('f'.repeat(43)))).status).toBe(401);
      }
    });

    it('signs in, rejects bad passwords and locks out brute force', async () => {
      expect((await login('wrong-password')).status).toBe(401);
      expect((await login('whatever', 'nobody@cft.test')).status).toBe(401);
      const ok = await login('a-very-long-password');
      expect(ok.status).toBe(200);
      token = ok.body.token;
      expect((await call('GET', 'admin/me', undefined, bearer(token))).body).toMatchObject({ email: 'boss@cft.test', role: 'admin', notifyResults: true });

      for (let i = 0; i < 8; i++) await login('nope', 'locked@cft.test');
      expect((await login('nope', 'locked@cft.test')).status).toBe(429);
    });

    it('signs in linked Telegram admins only', async () => {
      expect((await call('POST', 'admin/telegram-login', { initData: tg(9001) })).status).toBe(200);
      expect((await call('POST', 'admin/telegram-login', { initData: tg(9002) })).status).toBe(403);
    });

    it('returns dashboard data without answers for ungraded attempts', async () => {
      const open = await call('POST', 'attempts', { name: 'Lia Moss' });
      await call('PUT', `attempts/${open.body.attemptId}/answers`, { answers: { 1: 'A', 2: 'B' } }, tok(open.body.token));
      const d = await call('GET', 'admin/data', undefined, bearer(token));
      expect(d.status).toBe(200);
      expect(d.body.questions).toHaveLength(30);
      expect(d.body.settings).toEqual({ passMark: 21, minSample: 10, allowRetakes: false, timezone: 'Asia/Tashkent' });
      const lia = d.body.attempts.find((a: any) => a.id === open.body.attemptId);
      expect(lia).toMatchObject({ status: 'in_progress', answeredCount: 2, answers: {}, correctness: {} });
      const cara = d.body.attempts.find((a: any) => a.name === 'Cara Diaz');
      expect(cara).toMatchObject({ correct: 20, status: 'completed' });
      expect(Object.keys(cara.correctness)).toHaveLength(30);
      expect(JSON.stringify(d.body)).not.toContain('token_hash');
      expect((await call('GET', `admin/attempts/${open.body.attemptId}`, undefined, bearer(token))).status).toBe(409);
    });

    it('versions question edits so past attempts keep what the candidate saw', async () => {
      const d = await call('GET', 'admin/data', undefined, bearer(token));
      const q1 = d.body.questions[0];
      const cara = d.body.attempts.find((a: any) => a.name === 'Cara Diaz');

      const bad = await call('PUT', `admin/questions/${q1.id}`, { ...q1, text: '' }, bearer(token));
      expect(bad.status).toBe(400);
      expect(bad.body.errors.text).toBeTruthy();

      const edit = await call('PUT', `admin/questions/${q1.id}`, { ...q1, text: 'What does logistics mean?', topic: 'terms' }, bearer(token));
      expect(edit.status).toBe(200);
      expect(edit.body).toMatchObject({ text: 'What does logistics mean?', revision: 2, edited: true, topic: 'terms' });

      const old = await call('GET', `admin/attempts/${cara.id}`, undefined, bearer(token));
      expect(old.body.questions[0].text).toBe('What is logistics?');
      const fresh = await call('POST', 'attempts', { name: 'Max Nash' });
      expect(fresh.body.questions[0].text).toBe('What does logistics mean?');

      const topicOnly = await call('PUT', `admin/questions/${q1.id}`, { ...edit.body, topic: 'roles' }, bearer(token));
      expect(topicOnly.body.revision).toBe(2);
    });

    it('validates settings and refuses deactivating below the pass mark', async () => {
      expect((await call('PUT', 'admin/settings', { passMark: 31, minSample: 10 }, bearer(token))).status).toBe(400);
      const s = await call('PUT', 'admin/settings', { passMark: 30, minSample: 5, allowRetakes: false }, bearer(token));
      expect(s.body).toEqual({ passMark: 30, minSample: 5, allowRetakes: false, timezone: 'Asia/Tashkent' });
      const q = (await call('GET', 'admin/data', undefined, bearer(token))).body.questions[5];
      expect((await call('PUT', `admin/questions/${q.id}`, { ...q, active: false }, bearer(token))).status).toBe(400);
      await call('PUT', 'admin/settings', { passMark: 21, minSample: 10 }, bearer(token));
      expect((await call('PUT', `admin/questions/${q.id}`, { ...q, active: false }, bearer(token))).body.active).toBe(false);
      expect((await call('GET', 'config')).body.total).toBe(29);
      await call('PUT', `admin/questions/${q.id}`, { ...q, active: true }, bearer(token));
    });

    it('reports Sheets as not configured without a service account', async () => {
      const d = await call('GET', 'admin/data', undefined, bearer(token));
      expect(d.body.sheets).toMatchObject({ configured: false, connected: false });
      expect((await call('POST', 'admin/sheets/create', {}, bearer(token))).status).toBe(503);
    });

    it('revokes the session on sign-out', async () => {
      expect((await call('POST', 'admin/logout', {}, bearer(token))).status).toBe(200);
      expect((await call('GET', 'admin/data', undefined, bearer(token))).status).toBe(401);
    });
  });

  it('rejects webhook calls without the secret', async () => {
    expect((await call('POST', 'telegram/webhook', { message: { chat: { id: 1 }, text: '/start' } })).status).toBe(401);
    const r = await call('POST', 'telegram/webhook', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'test-webhook-secret-123456' });
    expect(r.body).toEqual({ ok: true });
  });

  it('keeps the public Supabase roles locked out via RLS', async () => {
    const { rows } = await getPool().query("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity");
    expect(rows).toEqual([]);
  });
});

describe.skipIf(!DB)('CSV export links', () => {
  it('stores an export for a signed-in admin and serves it from an unguessable, 10-minute URL', async () => {
    const t = (await call('POST', 'admin/login', { email: 'boss@cft.test', password: 'a-very-long-password' })).body.token;
    expect((await call('POST', 'admin/exports', { filename: 'x.csv', content: 'a,b' })).status).toBe(401);
    expect((await call('POST', 'admin/exports', { filename: '../evil.sh', content: 'a' }, bearer(t))).status).toBe(400);
    const r = await call('POST', 'admin/exports', { filename: 'cft_attempts.csv', content: 'Name\r\n"Lee, Ann"' }, bearer(t));
    const res = await handle({ method: 'GET', path: r.body.path.replace('/api/', ''), query: new URLSearchParams(), headers: {}, body: null, ip: null });
    expect(res.file).toMatchObject({ contentType: 'text/csv; charset=utf-8', filename: 'cft_attempts.csv' });
    expect(Buffer.from(res.file!.content).toString('utf8')).toBe('﻿Name\r\n"Lee, Ann"');
    expect((await call('GET', 'exports/' + 'z'.repeat(43))).status).toBe(404);
  });
});
