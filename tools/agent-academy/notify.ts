import { escHtml } from '../../support/common/html.js';
import { fmtDMYHM, rangeFor, type Range, type RangeKey } from '../../support/common/time.js';
import { loadAttempts } from './console.js';
import { getPool, type Db } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { buildReport, reportFilename, summarize, type ReportInput, type Summary } from './reports.js';
import { botApi, botSendDocument } from '../../support/helpers/telegram.js';


export interface ResultInfo {
  id: string;
  name: string;
  username: string | null;
  correct: number;
  total: number;
  pct: number;
  passMark: number;
  unanswered: number;
  durationSec: number | null;
  submittedAt: Date;
}

export function resultMessage(a: ResultInfo, tz: string): string {
  const passed = a.correct >= a.passMark;
  const mins = a.durationSec == null ? null : Math.max(1, Math.round(a.durationSec / 60));
  return [
    `${passed ? '✅ <b>PASSED</b>' : '❌ <b>FAILED</b>'} · ${escHtml(a.name)}${a.username ? ' (@' + escHtml(a.username) + ')' : ''}`,
    `Score <b>${a.correct}/${a.total}</b> (${Math.round(a.pct)}%) · pass mark ${a.passMark}`,
    [a.unanswered ? `${a.unanswered} unanswered` : null, mins ? `${mins} min` : null, fmtDMYHM(a.submittedAt, tz)].filter(Boolean).join(' · '),
  ].join('\n');
}

export function summaryMessage(s: Summary, r: Range, prev: Summary | null, title: string): string {
  const lines = [`📊 <b>${escHtml(title)}</b> · ${escHtml(r.label)}`, ''];
  if (!s.started && !s.completed) {
    lines.push('No attempts in this period.');
    return lines.join('\n');
  }
  lines.push(`Started: <b>${s.started}</b> · Completed: <b>${s.completed}</b>${s.inProgress ? ` · In progress: ${s.inProgress}` : ''}`);
  if (s.completed) {
    lines.push(`Passed: <b>${s.passed}</b> · Failed: <b>${s.completed - s.passed}</b> · Pass rate <b>${s.passRate}%</b>`);
    lines.push(`Average <b>${s.avg!.toFixed(1)}/${s.total}</b> (${s.avgPct}%) · High ${s.high} · Low ${s.low}`);
  }
  if (prev && (prev.completed || s.completed)) {
    const d = (n: number) => (n > 0 ? '+' + n : String(n));
    const parts = [`completed ${d(s.completed - prev.completed)}`];
    if (s.passRate != null && prev.passRate != null) parts.push(`pass rate ${d(s.passRate - prev.passRate)} pts`);
    lines.push(`vs previous week: ${parts.join(', ')}`);
  }
  if (s.mostMissed.length) {
    lines.push('', 'Most missed:');
    for (const m of s.mostMissed) lines.push(`• Q${m.n} — ${m.pctIncorrect}% wrong (n=${m.responses})`);
  }
  return lines.join('\n');
}

const openButton = (label: string, hash: string) =>
  env.appUrl ? { reply_markup: { inline_keyboard: [[{ text: label, web_app: { url: `${env.appUrl}/${hash}` } }]] } } : {};

/** Admin chats to message. Admins must have pressed Start in the bot for Telegram to deliver. */
async function recipients(db: Db, flag: 'notify_results' | 'weekly_report'): Promise<number[]> {
  const { rows } = await db.query(
    `select a.telegram_user_id as id from admins a left join telegram_users tu on tu.id = a.telegram_user_id
      where a.telegram_user_id is not null and a.${flag} and coalesce(tu.blocked_bot, false) = false`,
  );
  return rows.map((r) => Number(r.id));
}

async function deliver(db: Db, chatId: number, send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    if (/blocked|deactivated|chat not found|403/i.test(msg)) await db.query('update telegram_users set blocked_bot = true where id = $1', [chatId]).catch(() => {});
    console.error('Telegram delivery to', chatId, 'failed:', msg);
    return false;
  }
}

/** Tells every admin (with alerts on) that a candidate passed or failed. Never throws. */
export async function notifyResult(attemptId: string): Promise<void> {
  try {
    if (!env.botToken) return;
    const db = getPool();
    const { rows } = await db.query(
      `select a.id, c.full_name, c.telegram_username, a.correct_count, a.total_questions, a.score_pct, a.pass_mark, a.unanswered_count,
              a.duration_seconds, a.submitted_at, s.timezone
         from assessment_attempts a join candidates c on c.id = a.candidate_id cross join app_settings s
        where a.id = $1 and a.status = 'completed'`,
      [attemptId],
    );
    const r = rows[0];
    if (!r) return;
    const text = resultMessage(
      { id: r.id, name: r.full_name, username: r.telegram_username, correct: r.correct_count, total: r.total_questions, pct: r.score_pct, passMark: r.pass_mark, unanswered: r.unanswered_count, durationSec: r.duration_seconds, submittedAt: r.submitted_at },
      r.timezone,
    );
    const chats = await recipients(db, 'notify_results');
    await Promise.allSettled(
      chats.map((chat_id) => deliver(db, chat_id, () => botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', ...openButton('Open attempt', `#/admin/attempt/${r.id}`) }))),
    );
  } catch (e) {
    console.error('Result notification failed for', attemptId, (e as Error).message);
  }
}

export async function reportInput(db: Db): Promise<ReportInput> {
  const [{ rows: qs }, { rows: topics }, { rows: st }, attempts] = await Promise.all([
    db.query(
      `select q.id, q.number as n, q.topic_id as topic, q.topic_inferred as "topicInferred", q.active, r.revision, r.text, r.options,
              r.correct_option as correct, r.explanation, r.why_correct as "whyCorrect", r.why_incorrect as why, r.basis, (r.source = 'admin_edit') as edited
         from questions q join question_revisions r on r.id = q.current_revision_id order by q.number`,
    ),
    db.query('select id, name from topics order by sort_order, name'),
    db.query('select pass_mark, min_sample, allow_retakes, timezone from app_settings where id = 1'),
    loadAttempts(db),
  ]);
  return {
    questions: qs,
    topics,
    attempts,
    settings: { passMark: st[0].pass_mark, minSample: st[0].min_sample, allowRetakes: st[0].allow_retakes, timezone: st[0].timezone },
  };
}

export async function makeReport(db: Db, key: RangeKey) {
  const input = await reportInput(db);
  const tz = input.settings.timezone;
  const r = rangeFor(key, tz);
  return { bytes: buildReport(input, r), filename: reportFilename(r, tz, key), range: r, input };
}

export async function sendReportToChat(db: Db, chatId: number, key: RangeKey) {
  const { bytes, filename, range, input } = await makeReport(db, key);
  const s = summarize(input, range);
  const caption = `📎 <b>CFT Agent Academy report</b>\n${escHtml(range.label)} · ${s.completed} completed · ${s.passed} passed`;
  await botSendDocument(chatId, filename, bytes, caption);
}

export async function statsText(db: Db, key: 'week' | 'last_week'): Promise<string> {
  const input = await reportInput(db);
  const tz = input.settings.timezone;
  const r = rangeFor(key, tz);
  const prevR = key === 'week' ? rangeFor('last_week', tz) : rangeFor('last_week', tz, r.from!);
  return summaryMessage(summarize(input, r), r, summarize(input, prevR), key === 'week' ? 'Academy · This week so far' : 'Academy · Weekly report');
}

/**
 * Monday summary of the previous week, with the week's Excel report attached, to every admin with
 * weekly reports on. Without `force` it runs at most once per 6 days (safe for cron retries).
 */
export async function sendWeeklyReport(force = false): Promise<{ sent: number; skipped?: string }> {
  const db = getPool();
  if (!env.botToken) return { sent: 0, skipped: 'TELEGRAM_BOT_TOKEN is not set' };
  if (!force) {
    const { rows } = await db.query(
      `update app_settings set last_weekly_report_at = now()
        where id = 1 and (last_weekly_report_at is null or last_weekly_report_at < now() - interval '6 days') returning 1`,
    );
    if (!rows[0]) return { sent: 0, skipped: 'already sent this week' };
  }
  const text = await statsText(db, 'last_week');
  const { bytes, filename, range } = await makeReport(db, 'last_week');
  const chats = await recipients(db, 'weekly_report');
  let sent = 0;
  for (const chat_id of chats) {
    const ok = await deliver(db, chat_id, async () => {
      await botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', ...openButton('Open dashboard', '#/admin') });
      await botSendDocument(chat_id, filename, bytes, `Week ${escHtml(range.label)}`);
    });
    if (ok) sent++;
  }
  return { sent };
}

