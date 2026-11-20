import type pg from 'pg';
import { gradeAttempt, sanitizeAnswers } from '../../support/common/grading.js';
import type { Answers, AttemptResult, AttemptState, InProgressAttempt, OptionKey, PublicConfig, ReviewQuestion, Settings } from '../../support/common/types.js';
import { nameError, normalizeName } from '../../support/common/validation.js';
import { newToken, sha256 } from '../../support/helpers/crypto.js';
import { getPool, tx, type Db } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { HttpError, UUID_RE } from '../../support/helpers/http.js';
import { telegramAdmin } from '../../support/helpers/admins.js';
import { notifyResult } from './notify.js';
import { autoSyncAttempt } from './sheets.js';
import { fullName, requireInitData, verifyInitData, type VerifiedInitData } from '../../support/helpers/telegram.js';
import { touchTelegramUser } from '../../support/helpers/users.js';

interface AttemptRow {
  id: string;
  candidate_id: string;
  status: 'in_progress' | 'completed';
  started_at: Date;
  submitted_at: Date | null;
  correct_count: number | null;
  unanswered_count: number | null;
  total_questions: number;
  score_pct: number | null;
  pass_mark: number | null;
  full_name: string;
}

export async function loadSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query('select pass_mark, min_sample, allow_retakes, timezone from app_settings where id = 1');
  if (!rows[0]) throw new HttpError(503, 'The assessment has not been set up yet. Ask the administrator to run the database seed.');
  return { passMark: rows[0].pass_mark, minSample: rows[0].min_sample, allowRetakes: rows[0].allow_retakes, timezone: rows[0].timezone };
}

export async function publicConfig(): Promise<PublicConfig> {
  const db = getPool();
  const s = await loadSettings(db);
  const { rows } = await db.query('select count(*)::int as n from questions where active');
  return {
    total: rows[0].n,
    passMark: s.passMark,
    timeLimitMinutes: null, // the source materials don't set a time limit
    allowRetakes: s.allowRetakes,
    requireTelegram: !env.allowWebCandidates,
    botUsername: env.academyBotUsername,
  };
}

const ATTEMPT_COLS = `a.id, a.candidate_id, a.status, a.started_at, a.submitted_at, a.correct_count, a.unanswered_count,
  a.total_questions, a.score_pct, a.pass_mark, c.full_name`;

async function attemptByToken(db: Db, id: unknown, token: unknown, lock = false): Promise<AttemptRow> {
  if (typeof id !== 'string' || !UUID_RE.test(id) || typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new HttpError(404, 'This test session was not found.', 'attempt_not_found');
  }
  const { rows } = await db.query(
    `select ${ATTEMPT_COLS} from assessment_attempts a join candidates c on c.id = a.candidate_id
      where a.id = $1 and a.token_hash = $2 ${lock ? 'for update of a' : ''}`,
    [id, sha256(token)],
  );
  if (!rows[0]) throw new HttpError(404, 'This test session was not found.', 'attempt_not_found');
  return rows[0];
}

async function answerRows(db: Db, attemptId: string) {
  const { rows } = await db.query(
    `select q.number as n, q.topic_id, aa.position, aa.selected_option, aa.is_correct,
            r.text, r.options, r.correct_option, r.explanation, r.why_correct, r.why_incorrect, r.basis, r.source
       from attempt_answers aa
       join questions q on q.id = aa.question_id
       join question_revisions r on r.id = aa.question_revision_id
      where aa.attempt_id = $1
      order by aa.position`,
    [attemptId],
  );
  return rows as {
    n: number; topic_id: string; position: number; selected_option: OptionKey | null; is_correct: boolean | null;
    text: string; options: { key: OptionKey; text: string }[]; correct_option: OptionKey; explanation: string;
    why_correct: string; why_incorrect: Record<string, string>; basis: string; source: string;
  }[];
}

function answersOf(rows: { n: number; selected_option: OptionKey | null }[]): Answers {
  const a: Answers = {};
  for (const r of rows) if (r.selected_option) a[r.n] = r.selected_option;
  return a;
}

async function inProgressState(db: Db, a: AttemptRow): Promise<InProgressAttempt> {
  const rows = await answerRows(db, a.id);
  // Deliberately only question text and options: no answer key, explanation or topic.
  return {
    state: 'in_progress',
    attemptId: a.id,
    name: a.full_name,
    startedAt: a.started_at.toISOString(),
    questions: rows.map((r) => ({ n: r.n, text: r.text, options: r.options })),
    answers: answersOf(rows),
  };
}

/** Full result with answer key and explanations — only ever built for a graded attempt. */
export async function buildResult(db: Db, a: AttemptRow): Promise<AttemptResult> {
  if (a.status !== 'completed') throw new Error('buildResult called for an ungraded attempt');
  const rows = await answerRows(db, a.id);
  const { rows: topics } = await db.query('select id, name from topics order by sort_order, name');
  const questions: ReviewQuestion[] = rows.map((r, i) => ({
    n: r.n,
    idx: i + 1,
    text: r.text,
    options: r.options,
    correct: r.correct_option,
    explanation: r.explanation,
    whyCorrect: r.why_correct,
    why: r.why_incorrect,
    basis: r.basis,
    topic: r.topic_id,
    edited: r.source === 'admin_edit',
  }));
  const passMark = a.pass_mark ?? 0;
  return {
    state: 'completed',
    attemptId: a.id,
    name: a.full_name,
    startedAt: a.started_at.toISOString(),
    submittedAt: a.submitted_at!.toISOString(),
    correct: a.correct_count!,
    total: a.total_questions,
    unanswered: a.unanswered_count ?? 0,
    pct: a.score_pct!,
    passMark,
    passed: a.correct_count! >= passMark,
    answers: answersOf(rows),
    questions,
    topics,
  };
}

async function stateOf(db: Db, a: AttemptRow): Promise<AttemptState> {
  return a.status === 'completed' ? buildResult(db, a) : inProgressState(db, a);
}

async function rotateToken(c: pg.PoolClient, attemptId: string): Promise<string> {
  const token = newToken();
  await c.query('update assessment_attempts set token_hash = $2 where id = $1', [attemptId, sha256(token)]);
  return token;
}

async function latestAttemptFor(c: pg.PoolClient, telegramUserId: number, status: 'in_progress' | 'completed'): Promise<AttemptRow | null> {
  const { rows } = await c.query(
    `select ${ATTEMPT_COLS} from assessment_attempts a join candidates c on c.id = a.candidate_id
      where c.telegram_user_id = $1 and a.status = $2
      order by a.started_at desc limit 1 for update of a`,
    [telegramUserId, status],
  );
  return rows[0] ?? null;
}

/** Serializes concurrent starts from the same Telegram account. */
const lockTelegramUser = (c: pg.PoolClient, id: number) => c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['tg:' + id]);

/**
 * The test opens only from the Academy's own bot (@cftacademybot): its initData is signed with that
 * bot's token. Opened from @cft_Agentbot (or its website), it says where the test is instead.
 */
function requireAcademyUser(initData: unknown): VerifiedInitData {
  const bot = env.academyBotUsername;
  if (!env.academyBotToken || !bot) throw new HttpError(503, 'The Academy bot is not set up yet.', 'academy_moved');
  const fromMainBot = typeof initData === 'string' && (initData.startsWith('cftweb.') || (!!env.botToken && !!verifyInitData(initData, env.botToken, env.initDataMaxAgeSec)));
  if (fromMainBot) throw new HttpError(403, `The Sales Agent test is in @${bot}. Open it there.`, 'academy_moved');
  return requireInitData(initData, 'academy');
}

/**
 * The test is for Sales Agent candidates. Drivers, and people who asked for driver access (waiting or
 * declined), get their request status instead, even if they find the Academy bot.
 */
async function refuseDrivers(c: pg.PoolClient, telegramUserId: number): Promise<void> {
  const { rows } = await c.query(
    `select exists(select 1 from map_drivers where telegram_user_id = $1) as driver,
            (select status from driver_requests where telegram_user_id = $1 order by created_at desc limit 1) as request`,
    [telegramUserId],
  );
  const { driver, request } = rows[0] as { driver: boolean; request: string | null };
  if (driver) throw new HttpError(403, 'You have driver access: open the Route map in @cft_Agentbot.', 'driver_request');
  if (request === 'asking') throw new HttpError(403, 'Finish your driver access request in @cft_Agentbot: answer its questions there.', 'driver_request');
  if (request === 'pending') throw new HttpError(403, 'Your driver access request is being reviewed. @cft_Agentbot will message you when an admin decides.', 'driver_request');
  if (request === 'declined') throw new HttpError(403, 'Your driver access request was declined. Contact the person who invited you.', 'driver_request');
}

/**
 * Called when the Mini App opens inside Telegram: returns this account's open or finished
 * attempt (with a fresh token) so a returning candidate lands where they left off.
 */
export async function telegramSession(body: Record<string, unknown>): Promise<AttemptState | { state: 'none'; suggestedName: string; isAdmin: boolean }> {
  const tg = requireAcademyUser(body.initData);
  return tx(async (c) => {
    await lockTelegramUser(c, tg.user.id);
    await touchTelegramUser(c, tg.user);
    await refuseDrivers(c, tg.user.id);
    const s = await loadSettings(c);
    const open = await latestAttemptFor(c, tg.user.id, 'in_progress');
    const done = open ? null : await latestAttemptFor(c, tg.user.id, 'completed');
    const found = open ?? (!s.allowRetakes ? done : null);
    if (found) {
      const token = await rotateToken(c, found.id);
      const st = await stateOf(c, found);
      return { ...st, token, ...(st.state === 'completed' ? { alreadyCompleted: true } : {}) };
    }
    return {
      state: 'none' as const,
      suggestedName: normalizeName(fullName(tg.user)),
      isAdmin: !!(await telegramAdmin(c, tg.user)),
    };
  });
}

export async function startAttempt(body: Record<string, unknown>): Promise<AttemptState> {
  const name = normalizeName(body.name);
  const err = nameError(name);
  if (err) throw new HttpError(400, err, 'invalid_name');

  let tg: VerifiedInitData | null = null;
  if (typeof body.initData === 'string' && body.initData) tg = requireAcademyUser(body.initData);
  else if (!env.allowWebCandidates) throw new HttpError(401, 'Open this test from the CFT Telegram bot to begin.', 'telegram_required');

  return tx(async (c) => {
    const s = await loadSettings(c);
    let candidateId: string;
    if (tg) {
      await lockTelegramUser(c, tg.user.id);
      await touchTelegramUser(c, tg.user);
      await refuseDrivers(c, tg.user.id);
      const open = await latestAttemptFor(c, tg.user.id, 'in_progress');
      const done = open || s.allowRetakes ? null : await latestAttemptFor(c, tg.user.id, 'completed');
      const existing = open ?? done;
      if (existing) {
        if (open) await c.query('update candidates set full_name = $2, updated_at = now() where id = $1', [existing.candidate_id, name]);
        const token = await rotateToken(c, existing.id);
        const st = await stateOf(c, open ? { ...existing, full_name: name } : existing);
        return { ...st, token, ...(st.state === 'completed' ? { alreadyCompleted: true } : {}) };
      }
      const { rows } = await c.query(
        `insert into candidates (full_name, telegram_user_id, telegram_username) values ($1, $2, $3)
         on conflict (telegram_user_id) where telegram_user_id is not null
         do update set full_name = excluded.full_name, telegram_username = excluded.telegram_username, updated_at = now()
         returning id`,
        [name, tg.user.id, tg.user.username ?? null],
      );
      candidateId = rows[0].id;
    } else {
      const { rows } = await c.query('insert into candidates (full_name) values ($1) returning id', [name]);
      candidateId = rows[0].id;
    }

    const { rows: qs } = await c.query(
      'select id, current_revision_id from questions where active and current_revision_id is not null order by number',
    );
    if (!qs.length) throw new HttpError(503, 'There are no active questions. Ask the administrator to check the question bank.');
    const token = newToken();
    const { rows: ins } = await c.query(
      `insert into assessment_attempts (candidate_id, token_hash, channel, total_questions)
       values ($1, $2, $3, $4) returning id`,
      [candidateId, sha256(token), tg ? 'telegram' : 'web', qs.length],
    );
    const attemptId: string = ins[0].id;
    await c.query(
      `insert into attempt_answers (attempt_id, question_id, question_revision_id, position)
       select $1, q.id, q.rev, q.pos from unnest($2::int[], $3::bigint[]) with ordinality as q(id, rev, pos)`,
      [attemptId, qs.map((q) => q.id), qs.map((q) => q.current_revision_id)],
    );
    const a = await attemptByToken(c, attemptId, token);
    return { ...(await inProgressState(c, a)), token };
  });
}

export async function getAttempt(id: string, token: unknown): Promise<AttemptState> {
  const db = getPool();
  return stateOf(db, await attemptByToken(db, id, token));
}

async function applyAnswers(c: pg.PoolClient, attemptId: string, raw: unknown): Promise<number> {
  const { rows } = await c.query('select q.number from attempt_answers aa join questions q on q.id = aa.question_id where aa.attempt_id = $1', [attemptId]);
  const answers = sanitizeAnswers(raw, new Set(rows.map((r) => r.number as number)));
  const ns = Object.keys(answers).map(Number);
  if (!ns.length) return 0;
  const res = await c.query(
    `update attempt_answers aa set selected_option = v.opt, answered_at = now()
       from unnest($2::int[], $3::text[]) as v(n, opt), questions q
      where aa.attempt_id = $1 and q.id = aa.question_id and q.number = v.n
        and aa.selected_option is distinct from v.opt`,
    [attemptId, ns, ns.map((n) => answers[n])],
  );
  return res.rowCount ?? 0;
}

export async function saveAnswers(id: string, token: unknown, body: Record<string, unknown>): Promise<{ saved: number }> {
  return tx(async (c) => {
    const a = await attemptByToken(c, id, token, true);
    if (a.status === 'completed') throw new HttpError(409, 'This test has already been submitted.', 'already_submitted');
    return { saved: await applyAnswers(c, a.id, body.answers) };
  });
}

/**
 * Grades on the server. Idempotent: the attempt row is locked, and a second submit returns the
 * stored result instead of grading again.
 */
export async function submitAttempt(id: string, token: unknown, body: Record<string, unknown>): Promise<AttemptResult> {
  let firstTime = false;
  const result = await tx(async (c) => {
    const a = await attemptByToken(c, id, token, true);
    if (a.status === 'completed') return { ...(await buildResult(c, a)), alreadyCompleted: true };
    firstTime = true;
    await applyAnswers(c, a.id, body.answers);
    const s = await loadSettings(c);
    const rows = await answerRows(c, a.id);
    const g = gradeAttempt(rows.map((r) => ({ n: r.n, correct: r.correct_option })), answersOf(rows));
    await c.query(
      `update attempt_answers aa set is_correct = v.ok, graded_at = now()
         from unnest($2::int[], $3::bool[]) as v(n, ok), questions q
        where aa.attempt_id = $1 and q.id = aa.question_id and q.number = v.n`,
      [a.id, g.perQ.map((p) => p.n), g.perQ.map((p) => p.isCorrect)],
    );
    const { rows: upd } = await c.query(
      `update assessment_attempts
          set status = 'completed', submitted_at = now(), correct_count = $2, unanswered_count = $3,
              total_questions = $4, score_pct = $5, pass_mark = $6,
              duration_seconds = greatest(0, extract(epoch from now() - started_at))::int
        where id = $1 returning submitted_at`,
      [a.id, g.correct, g.unanswered, g.total, g.pct, s.passMark],
    );
    return buildResult(c, {
      ...a, status: 'completed', submitted_at: upd[0].submitted_at, correct_count: g.correct, unanswered_count: g.unanswered,
      total_questions: g.total, score_pct: g.pct, pass_mark: s.passMark,
    });
  });
  // Side effects after commit; both swallow their own errors so the candidate always gets a result.
  if (firstTime) await Promise.allSettled([autoSyncAttempt(result.attemptId), notifyResult(result.attemptId)]);
  return result;
}
