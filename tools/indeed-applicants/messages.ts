import { escHtml } from '../../support/common/html.js';
import { formatPhone } from '../../support/common/leads.js';
import { fmtDMY, fmtDMYHM } from '../../support/common/time.js';
import type { Applicant, IndeedStats } from './store.js';

// Every text Indeed Applicants sends: the hiring-chat cards and alerts, the file captions and the
// admins' section. Change the wording here.

export const TITLE = '📋 <b>Indeed Applicants</b>';

/** At most this many cards per report; the rest are summed up in one line (after a long outage, say). */
export const MAX_CARDS = 15;

export function card(a: Applicant, tz: string): string {
  const lines = ['🆕 <b>New Indeed applicant</b>', '', `👤 <b>${escHtml(a.name)}</b>`];
  if (a.job_title) lines.push(`💼 ${escHtml(a.job_title)}`);
  if (a.location) lines.push(`📍 ${escHtml(a.location)}`);
  const phone = formatPhone(a.phone);
  lines.push(`📞 ${phone || 'no phone number'}`);
  if (a.applied_at) lines.push(`🕒 Applied ${fmtDMYHM(a.applied_at, tz)}`);
  if (a.experience.length) lines.push(`🧰 ${a.experience.map(escHtml).join('\n      ')}`);
  return lines.join('\n');
}

export const moreApplicants = (n: number) =>
  `➕ <b>${n} more new Indeed applicant${n === 1 ? '' : 's'}</b> arrived at once. They are all in the next Excel file.`;

export const connected = (n: number) =>
  `✅ <b>Indeed applicants are connected.</b>\nThe office computer is reporting. ${n} applicant${n === 1 ? ' was' : 's were'} already there and ${n === 1 ? 'is' : 'are'} left out; every new one will appear here, and the lead-import Excel file arrives once a day.`;

/** What each problem the office script reports means, for the hiring chat. */
const PROBLEMS: Record<string, string> = {
  chrome_closed: 'the "Chrome - Indeed Bot" window on the office computer is closed. Please open it again with its desktop shortcut.',
  logged_out: 'Indeed is signed out in the "Chrome - Indeed Bot" window. Please sign in to employers.indeed.com there again.',
  no_data: 'the Indeed page loaded but no applicants were found on it. Indeed may have changed the page, and the office script may need an update.',
  error: 'the office script could not read Indeed this time. It keeps trying every run.',
  silent: 'the office computer has not reported for over 2 hours. It may be off, asleep or offline, or its scheduled task stopped.',
};

export const problem = (key: string, detail: string | null) =>
  `⚠️ <b>Indeed applicants paused:</b> ${PROBLEMS[key] ?? PROBLEMS.error}${detail ? `\n<i>${escHtml(detail)}</i>` : ''}`;

export const recovered = '✅ <b>Indeed applicants are working again.</b>';

export const fileCaption = (n: number, kind: 'daily' | 'new' | 'week') =>
  kind === 'week'
    ? `🗂 <b>Indeed applicants, last 7 days</b> · ${n}\nA copy for reference: it doesn't change what the next import file contains.`
    : `📊 <b>Indeed leads import</b> · ${n} new applicant${n === 1 ? '' : 's'}\nEach applicant goes into one import file only.`;

export const NOTHING_NEW = '📊 No new Indeed applicants since the last import file.';
export const NOTHING_THIS_WEEK = '🗂 No Indeed applicants in the last 7 days.';
export const SEND_FAILED = '⚠️ Telegram refused the file. The applicants were not marked as sent; the next file includes them.';
export const SEND_UNKNOWN = '⚠️ Telegram did not confirm the file. The applicants were marked as sent so nobody is imported twice; if the file is missing, ask the developer.';
export const NOT_SET_UP = `${TITLE}\n\nNot set up on this server yet (INDEED_COLLECTOR_TOKEN is missing).`;
export const ADMINS_ONLY = 'Indeed applicants are for CFT administrators only.';

const ago = (d: Date, now: Date) => {
  const min = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

export function sectionText(s: IndeedStats, tz: string, now = new Date()): string {
  const c = s.collector;
  const office = !c.last_seen_at
    ? '⏳ The office computer has not reported yet.'
    : c.last_status === 'ok'
      ? `🟢 Office computer: last check ${ago(c.last_seen_at, now)}.`
      : `🔴 Office computer: ${escHtml(c.last_status ?? '')} (${ago(c.last_seen_at, now)}).${c.last_ok_at ? ` Last good check ${fmtDMYHM(c.last_ok_at, tz)}.` : ''}`;
  return [
    TITLE,
    '',
    office,
    `Today: <b>${s.today}</b> new · waiting for the import file: <b>${s.waiting}</b> · all: ${s.total}`,
    '',
    'A card for every new applicant goes to the hiring chat, and the lead-import Excel file arrives there once a day. 📥 sends you the applicants that are not in a file yet (and marks them sent).',
  ].join('\n');
}

export const BUTTONS = { new: (n: number) => `📥 New applicants · ${n}`, week: '🗂 Last 7 days' };

export const HELP = `${TITLE}\n/indeed — status, new applicants as Excel, last 7 days`;

/** The import file's name, e.g. CFT_Indeed_Leads_Import_11_20_26.xlsx (month first, as the CRM files are named). */
export function fileName(now: Date, tz: string): string {
  const [d, m, y] = fmtDMY(now, tz).split('/');
  return `CFT_Indeed_Leads_Import_${m}_${d}_${y.slice(2)}.xlsx`;
}
