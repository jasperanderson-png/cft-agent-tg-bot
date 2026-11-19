import type pg from 'pg';
import type { AdminAttempt, AdminData, AttemptResult, BankQuestion, OptionKey, Settings } from '../../support/common/types.js';
import { isValidTimeZone } from '../../support/common/time.js';
import { settingsError, validateQuestionEdit } from '../../support/common/validation.js';
import { adminMe, audit, type Admin } from '../../support/helpers/admins.js';
import { getPool, tx, type Db } from '../../database/db.js';
import { HttpError, UUID_RE } from '../../support/helpers/http.js';
import { buildResult, loadSettings } from './candidate.js';
import { sheetsStatus } from './sheets.js';

// The Agent Academy part of the admin console: attempts, the question bank and the test settings.

async function bankQuestions(db: Db): Promise<BankQuestion[]> {
  const { rows } = await db.query(
    `select q.id, q.number, q.topic_id, q.topic_inferred, q.active, r.revision, r.text, r.options, r.correct_option,
            r.explanation, r.why_correct, r.why_incorrect, r.basis, r.source
       from questions q join question_revisions r on r.id = q.current_revision_id
      order by q.number`,
  );
  return rows.map((r) => ({
    id: r.id, n: r.number, text: r.text, options: r.options, correct: r.correct_option, explanation: r.explanation,
    whyCorrect: r.why_correct, why: r.why_incorrect, basis: r.basis, topic: r.topic_id, topicInferred: r.topic_inferred,
    active: r.active, revision: r.revision, edited: r.source === 'admin_edit',
  }));
}

export async function loadAttempts(db: Db): Promise<AdminAttempt[]> {
  const [attempts, answers] = await Promise.all([
    db.query(
      `select a.id, a.candidate_id, c.full_name, a.channel, c.telegram_username, right(a.token_hash, 4) as token_tail, a.status,
              a.started_at, a.submitted_at, a.duration_seconds, a.total_questions, a.correct_count, a.score_pct,
              a.unanswered_count, a.pass_mark,
              (select count(*) from attempt_answers x where x.attempt_id = a.id and x.selected_option is not null)::int as answered
         from assessment_attempts a join candidates c on c.id = a.candidate_id
        order by a.started_at desc`,
    ).then((r) => r.rows),
    // Answers only for graded attempts: an in-progress attempt is not reviewable.
    db.query(
      `select aa.attempt_id, q.number, aa.selected_option, aa.is_correct
         from attempt_answers aa join assessment_attempts a on a.id = aa.attempt_id join questions q on q.id = aa.question_id
        where a.status = 'completed'`,
    ).then((r) => r.rows),
  ]);
  const byAttempt = new Map<string, { answers: Record<number, OptionKey>; correctness: Record<number, boolean> }>();
  for (const r of answers) {
    let e = byAttempt.get(r.attempt_id);
    if (!e) byAttempt.set(r.attempt_id, (e = { answers: {}, correctness: {} }));
    if (r.selected_option) e.answers[r.number] = r.selected_option;
    e.correctness[r.number] = r.is_correct === true;
  }
  return attempts.map((a) => ({
    id: a.id, candidateId: a.candidate_id, name: a.full_name, channel: a.channel, telegramUsername: a.telegram_username,
    tokenTail: a.token_tail, status: a.status, startedAt: a.started_at.toISOString(), submittedAt: a.submitted_at?.toISOString() ?? null,
    durationSec: a.duration_seconds, total: a.total_questions, correct: a.correct_count, pct: a.score_pct,
    unanswered: a.unanswered_count, passMark: a.pass_mark, answeredCount: a.answered,
    answers: byAttempt.get(a.id)?.answers ?? {}, correctness: byAttempt.get(a.id)?.correctness ?? {},
  }));
}

export async function adminData(admin?: Admin): Promise<AdminData> {
  const db = getPool();
  const [questions, topics, settings, attempts, sheets, me] = await Promise.all([
    bankQuestions(db),
    db.query('select id, name from topics order by sort_order, name').then((r) => r.rows),
    loadSettings(db),
    loadAttempts(db),
    sheetsStatus(db),
    admin ? adminMe(db, admin) : Promise.resolve(null),
  ]);
  return { questions, topics, settings, attempts, sheets, me };
}

/** Review of one graded attempt, using the question revisions the candidate actually saw. */
export async function attemptReview(id: string): Promise<AttemptResult> {
  if (!UUID_RE.test(id)) throw new HttpError(404, 'Attempt not found.');
  const db = getPool();
  const { rows } = await db.query(
    `select a.id, a.candidate_id, a.status, a.started_at, a.submitted_at, a.correct_count, a.unanswered_count,
            a.total_questions, a.score_pct, a.pass_mark, c.full_name
       from assessment_attempts a join candidates c on c.id = a.candidate_id where a.id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'Attempt not found.');
  if (rows[0].status !== 'completed') throw new HttpError(409, 'This attempt has not been submitted yet.');
  return buildResult(db, rows[0]);
}

async function activeCount(c: pg.PoolClient) {
  const { rows } = await c.query('select count(*)::int as n from questions where active');
  return rows[0].n as number;
}

export async function updateQuestion(admin: Admin, idRaw: string, body: Record<string, unknown>): Promise<BankQuestion> {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Question not found.');
  return tx(async (c) => {
    const { rows: topicRows } = await c.query('select id from topics');
    const v = validateQuestionEdit(body, topicRows.map((t) => t.id));
    if (!v.ok) throw new HttpError(400, Object.values(v.errors)[0]!, 'validation', { errors: v.errors });
    const q = v.value;
    const { rows } = await c.query(
      `select q.id, q.active, r.id as rev_id, r.revision, r.text, r.options, r.correct_option, r.explanation, r.why_correct,
              r.why_incorrect, r.basis
         from questions q join question_revisions r on r.id = q.current_revision_id where q.id = $1 for update of q`,
      [id],
    );
    const cur = rows[0];
    if (!cur) throw new HttpError(404, 'Question not found.');

    if (cur.active && !q.active) {
      const s = await loadSettings(c);
      const remaining = (await activeCount(c)) - 1;
      if (remaining < 1) throw new HttpError(400, 'At least one question must stay active.');
      if (remaining < s.passMark) throw new HttpError(400, `Lower the pass mark below ${remaining + 1} before deactivating this question.`);
    }

    const contentChanged =
      q.text !== cur.text || q.correct !== cur.correct_option || q.explanation !== cur.explanation ||
      JSON.stringify(q.options) !== JSON.stringify(cur.options);
    let revId = cur.rev_id;
    if (contentChanged) {
      // Keep "why the other options are wrong" notes only where they still apply.
      const optionsSame = JSON.stringify(q.options) === JSON.stringify(cur.options);
      const why: Record<string, string> = {};
      if (optionsSame) for (const [k, t] of Object.entries(cur.why_incorrect as Record<string, string>)) if (k !== q.correct) why[k] = t;
      const keepWhyCorrect = optionsSame && q.correct === cur.correct_option;
      const ins = await c.query(
        `insert into question_revisions (question_id, revision, text, options, correct_option, explanation, why_correct, why_incorrect, basis, source, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'admin_edit', $10) returning id`,
        [id, cur.revision + 1, q.text, JSON.stringify(q.options), q.correct, q.explanation, keepWhyCorrect ? cur.why_correct : '',
          JSON.stringify(why), cur.basis, admin.id],
      );
      revId = ins.rows[0].id;
    }
    await c.query(
      `update questions set topic_id = $2, topic_inferred = $3, active = $4, current_revision_id = $5, updated_at = now() where id = $1`,
      [id, q.topic, q.topicInferred, q.active, revId],
    );
    await audit(c, admin.id, 'question.update', 'question', String(id), { contentChanged, topic: q.topic, active: q.active });
    return (await bankQuestions(c)).find((x) => x.id === id)!;
  });
}

export async function updateSettings(admin: Admin, body: Record<string, unknown>): Promise<Settings> {
  return tx(async (c) => {
    const err = settingsError(body.passMark, body.minSample, await activeCount(c));
    if (err) throw new HttpError(400, err, 'validation');
    const cur = await loadSettings(c);
    const timezone = typeof body.timezone === 'string' && body.timezone ? body.timezone : cur.timezone;
    if (!isValidTimeZone(timezone)) throw new HttpError(400, 'Choose a valid time zone, e.g. Asia/Tashkent or America/Chicago.', 'validation');
    const s: Settings = { passMark: Number(body.passMark), minSample: Number(body.minSample), allowRetakes: body.allowRetakes === true, timezone };
    await c.query('update app_settings set pass_mark = $1, min_sample = $2, allow_retakes = $3, timezone = $4, updated_at = now() where id = 1', [
      s.passMark, s.minSample, s.allowRetakes, s.timezone,
    ]);
    await audit(c, admin.id, 'settings.update', 'settings', '1', s);
    return s;
  });
}
