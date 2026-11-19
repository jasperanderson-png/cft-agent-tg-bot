// Work reports: periods and Russian wording, the cards and captions, and the whole flow in the bot
// (shift → log → end → daily report, the channel, the API Claude logs work through, the evening job
// with weekly and monthly reports). Telegram is stubbed. The bot tests need TEST_DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../../database/db.js';
import { migrate } from '../../../database/migrate.js';
import { seed } from '../../../database/seeds/academy/seed.js';
import type { ApiRequest } from '../../../support/helpers/http.js';
import { handle as router } from '../../../telegram_bot/server/router.js';
import { parseEntryLines } from '../../../telegram_bot/handlers/admins/shift.js';
import { areasOf, highlightsOf, type DailyReport, type MonthlyReport } from '../build.js';
import { dailyCaption, monthlyTaskList } from '../captions.js';
import { cardRender, dailySvg } from '../card.js';
import { designRender } from '../../../telegram_bot/handlers/admins/system-design.js';
import { runEvening } from '../cron.js';
import { addDays, isLastDayOfMonth, monthOf, weekday, weekOf } from '../periods.js';
import type { Entry } from '../store.js';
import { duration, durationEn, hours, plural } from '../words.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST';

const entry = (text: string, o: Partial<Entry> = {}): Entry => ({
  id: crypto.randomUUID(), workDate: '2026-11-14', kind: 'done', text, detail: null, area: null, size: 'm', highlight: false, source: 'claude', createdAt: new Date(), ...o,
});

describe('periods and wording', () => {
  it('reports weeks from Sunday to Saturday and calendar months', () => {
    expect(weekOf('2026-11-14')).toEqual({ start: '2026-11-08', end: '2026-11-14' }); // Saturday
    expect(weekOf('2026-11-10')).toEqual({ start: '2026-11-08', end: '2026-11-14' }); // Tuesday
    expect(weekOf('2026-11-15')).toEqual({ start: '2026-11-15', end: '2026-11-21' }); // Sunday starts the next one
    expect(weekday('2026-11-14')).toBe(5);
    expect(monthOf('2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(isLastDayOfMonth('2026-11-30')).toBe(true);
    expect(isLastDayOfMonth('2026-11-29')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('speaks proper Russian', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111].map((n) => `${n} ${plural(n, 'задача', 'задачи', 'задач')}`)).toEqual([
      '1 задача', '2 задачи', '5 задач', '11 задач', '21 задача', '22 задачи', '25 задач', '111 задач',
    ]);
    expect(duration(575)).toBe('9 ч 35 мин');
    expect(duration(45)).toBe('45 мин');
    expect(duration(120)).toBe('2 ч');
    expect(durationEn(575)).toBe('9 h 35 min');
    expect(hours(3110)).toBe('52');
    expect(hours(3090)).toBe('51,5');
  });
  it('picks highlights and counts areas', () => {
    const list = [entry('a', { size: 's' }), entry('b', { size: 'l', area: 'Лиды' }), entry('c', { highlight: true, area: 'Топливо' }), entry('d', { kind: 'improved' }), entry('e', { area: 'Топливо' })];
    expect(highlightsOf(list, 3).map((e) => e.text)).toEqual(['c', 'b', 'e']);
    expect(areasOf(list)).toEqual([{ name: 'Топливо', n: 2 }, { name: 'Лиды', n: 1 }, { name: 'Другое', n: 1 }]);
  });
});

describe('entries typed in the bot', () => {
  it('takes one entry per line, without list marks, with #areas per line or for all', () => {
    expect(parseEntryLines('\nПодключил Парсинг\nСделал Новый UI/UX для мини апп\nДобавил Новых юзеров: агентов\nАвтоматизировал поиск по дискаунтам')).toEqual([
      { text: 'Подключил Парсинг', area: null },
      { text: 'Сделал Новый UI/UX для мини апп', area: null },
      { text: 'Добавил Новых юзеров: агентов', area: null },
      { text: 'Автоматизировал поиск по дискаунтам', area: null },
    ]);
    expect(parseEntryLines('- Первое #Лиды\n• Второе\n2) Третье\n#Топливо')).toEqual([
      { text: 'Первое', area: 'Лиды' }, { text: 'Второе', area: 'Топливо' }, { text: 'Третье', area: 'Топливо' },
    ]);
    expect(parseEntryLines('Одна задача #бот')).toEqual([{ text: 'Одна задача', area: 'Бот' }]);
    expect(parseEntryLines('  \n ')).toEqual([]);
  });
});

describe('cards and captions', () => {
  const day: DailyReport = {
    kind: 'daily', name: 'Jasper', day: '2026-11-14', minutes: 575, open: false, autoClosed: false,
    shifts: [{ id: 'x', staffId: 1, workDate: '2026-11-14', startedAt: new Date('2026-11-14T04:05:00Z'), endedAt: new Date('2026-11-14T13:40:00Z'), endReason: 'manual' }],
    entries: {
      done: Array.from({ length: 11 }, (_v, i) => entry(`Задача номер ${i + 1}: агенты находят цены даже с ошибками в названии штата`, { area: 'Топливо' })),
      improved: [entry('Меньше ошибок у агентов', { kind: 'improved', detail: 'раньше бот отвечал «штат не найден»' })],
      learned: [], blocker: [], plan: [entry('Первый отчёт в канал', { kind: 'plan' })],
    },
  };
  it('draws the daily card in Russian with the CFT look', () => {
    const svg = dailySvg(day, 'Asia/Tashkent');
    expect(svg).toContain('ОТЧЁТ ЗА ДЕНЬ');
    expect(svg).toContain('Суббота, 14/11');
    expect(svg).toContain('Смена 09:05 – 18:40 · Jasper');
    expect(svg).toContain('Что стало лучше');
    expect(svg).toContain('раньше бот отвечал «штат не найден»');
    expect(svg).not.toContain('…и ещё'); // 11 tasks: all shown (up to 14)
    expect(svg).toContain('Топливо'); // one area: a tag on each line, no headings
    expect(svg).toContain('Топливо');
    expect(svg).toContain('data:image/svg+xml;base64,'); // the logo
    expect(cardRender.png(svg).length).toBeGreaterThan(10_000); // a real picture, with the real fonts
  });
  it('keeps the caption within what Telegram allows under a picture', () => {
    const c = dailyCaption(day, 'Asia/Tashkent');
    expect(c).toContain('📅 <b>Отчёт за день · 14/11/2026</b> (суббота)');
    expect(c).toContain('⏱ Смена 09:05–18:40 · <b>9 ч 35 мин</b>');
    expect(c).toContain('✅ 11 задач · 📈 1 улучшение');
    expect(c).toContain('<b>Главное:</b>');
    expect(c).toContain('🔜 <b>Завтра:</b> Первый отчёт в канал');
    expect(c.length).toBeLessThanOrEqual(1024);
    const long = { ...day, entries: { ...day.entries, done: Array.from({ length: 4 }, () => entry('x'.repeat(400))), plan: [entry('y'.repeat(400), { kind: 'plan' })] } };
    expect(dailyCaption(long, 'Asia/Tashkent').length).toBeLessThanOrEqual(1024);
  });
  it('lists every solved task of the month, grouped by area, in messages Telegram accepts', () => {
    const done = Array.from({ length: 120 }, (_v, i) => entry(`Задача ${i} `.repeat(6), { area: i % 3 ? 'Лиды' : 'Топливо' }));
    const r = { kind: 'monthly', done, highlights: done.slice(0, 5), areas: areasOf(done), period: { start: '2026-11-01', end: '2026-11-30' } } as unknown as MonthlyReport;
    const msgs = monthlyTaskList(r);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs[0]).toContain('📋 <b>Все решённые задачи · ноябрь 2026</b> (120)');
    for (const m of msgs) expect(m.length).toBeLessThan(4096);
    expect(msgs.join('\n').match(/^• /gm)).toHaveLength(120);
  });
});

describe.skipIf(!DB)('work reports in the bot (PostgreSQL)', () => {
  interface Sent { method: string; chat_id?: number; text?: string; caption?: string; body?: any }
  const sent: Sent[] = [];
  const OWNER = 9447180;
  const CANDIDATE = 8404;
  const CHANNEL = -1001234567890;
  const GROUP = -1009876543210;
  const TOKEN = 'task-report-token-1234567890';
  let id = 50_000;
  let msgId = 1000;

  const hook = (update: Record<string, unknown>) => router({ method: 'POST', path: 'telegram/webhook', query: new URLSearchParams(), headers: { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' }, body: update, ip: '10.0.0.1' } as ApiRequest);
  const say = (from: number, text: string, extra: Record<string, unknown> = {}) => hook({ update_id: ++id, message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: 'Jasper', last_name: 'A' }, text, ...extra } });
  const tap = (from: number, data: string) => hook({ update_id: ++id, callback_query: { id: 'cb' + id, from: { id: from, first_name: 'Jasper', last_name: 'A' }, data, message: { message_id: 5, chat: { id: from, type: 'private' } } } });
  const api = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    router({ method, path, query: new URLSearchParams(path.split('?')[1] ?? ''), headers: token ? { authorization: 'Bearer ' + token } : {}, body: body ?? null, ip: '10.0.0.2' } as ApiRequest);
  const of = (chat: number, method?: string) => sent.filter((m) => m.chat_id === chat && (!method || m.method === method));
  const buttons = (m: Sent) => (m.body?.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data: string }[];
  const q = (sql: string, args: unknown[] = []) => getPool().query(sql, args);

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://academy.example.com',
      ADMIN_TELEGRAM_IDS: String(OWNER), GOOGLE_SERVICE_ACCOUNT_JSON: '', TASK_REPORT_TOKEN: TOKEN, CRON_SECRET: 'cron-secret', TASK_REPORT_USER_IDS: String(OWNER),
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split('/').pop()!;
      if (init?.body instanceof FormData) {
        const fd = init.body;
        const file = (fd.get('photo') ?? fd.get('card')) as File | null;
        const media = fd.get('media') ? JSON.parse(String(fd.get('media'))) : null;
        sent.push({
          method, chat_id: Number(fd.get('chat_id')), caption: String(fd.get('caption') ?? media?.caption ?? ''),
          text: file ? new TextDecoder().decode(new Uint8Array(await file.arrayBuffer())) : undefined, body: { message_id: Number(fd.get('message_id')) || undefined },
        });
        return new Response(JSON.stringify({ ok: true, result: { message_id: ++msgId } }));
      }
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      if (method === 'getChat') return new Response(JSON.stringify({ ok: true, result: b.chat_id === GROUP ? { id: GROUP, type: 'supergroup', title: 'CFT test chat' } : { id: b.chat_id, type: 'channel', title: 'CFT test reports' } }));
      if (method === 'getChatMember') return new Response(JSON.stringify({ ok: true, result: b.chat_id === GROUP ? { status: 'member' } : { status: 'administrator', can_post_messages: true, can_edit_messages: true } }));
      return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: ++msgId } : true }));
    });
    cardRender.png = (svg) => new TextEncoder().encode(svg);
    designRender.png = (svg) => Buffer.from(svg);
    await q('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  it('gives admins the ⏱ Shift button and an English panel', async () => {
    await say(OWNER, '/start');
    expect((sent[0].body.reply_markup.keyboard as { text: string }[][]).flat().map((b) => b.text)).toContain('⏱ Shift');
    expect((sent[0].body.reply_markup.keyboard as { text: string }[][]).flat().map((b) => b.text)).toContain('🧩 System Design');
    sent.length = 0;
    await say(OWNER, '🧩 System Design');
    const design = sent.find((m) => m.method === 'sendPhoto')!;
    expect(design.caption).toContain('System design');
    expect(design.text).toContain('WHO can do what');
    expect(design.text).toContain('Task report'); // the tools come from the code
    sent.length = 0;
    await say(OWNER, '⏱ Shift');
    const panel = of(OWNER, 'sendMessage')[0];
    expect(panel.text).toContain('⏱ <b>Shift</b>');
    expect(panel.text).toContain('⚪️ Not on shift');
    expect(panel.text).toContain('No reports chat connected');
    expect(buttons(panel).map((b) => b.text)).toEqual(['▶️ Start shift', "👁 Today's report", '📋 Log', '🔄 Refresh']);
  });

  it('is only for the people in TASK_REPORT_USER_IDS, not even for other admins', async () => {
    const OTHER_ADMIN = 8405;
    await q(`insert into admins (telegram_user_id, name, role) values ($1, 'Other admin', 'admin') on conflict do nothing`, [OTHER_ADMIN]);
    await say(OTHER_ADMIN, '/start');
    expect((sent[0].body.reply_markup.keyboard as { text: string }[][]).flat().map((b) => b.text)).not.toContain('⏱ Shift');
    expect(sent[0].text).not.toContain('/shift');
    expect((sent[0].body.reply_markup.keyboard as { text: string }[][]).flat().map((b) => b.text)).not.toContain('🧩 System Design');
    sent.length = 0;
    await say(OTHER_ADMIN, '/design');
    expect(sent.filter((m) => m.method === 'sendPhoto')).toHaveLength(0);
    await say(OTHER_ADMIN, '/start');
    expect(sent.find((m) => m.method === 'setMyCommands')!.body.commands.map((c: { command: string }) => c.command)).not.toContain('shift');
    sent.length = 0;
    await say(OTHER_ADMIN, '/shift');
    await say(OTHER_ADMIN, '/done Что-то');
    await say(OTHER_ADMIN, '/help');
    expect(sent.filter((m) => m.method === 'sendMessage').map((m) => m.text).join('\n')).not.toMatch(/Shift|Logged/);
    sent.length = 0;
    await tap(OTHER_ADMIN, 'rep:start');
    expect(sent.find((m) => m.method === 'answerCallbackQuery')?.body.text).toBe('Not available.');
    await hook({ update_id: ++id, my_chat_member: { chat: { id: -100444, type: 'channel', title: 'X' }, from: { id: OTHER_ADMIN, first_name: 'O' }, new_chat_member: { status: 'administrator' } } });
    expect((await q('select count(*)::int n from work_shifts')).rows[0].n).toBe(0);
    expect((await q('select count(*)::int n from report_staff')).rows[0].n).toBe(0);
    expect(sent.filter((m) => m.method === 'sendMessage')).toHaveLength(0);
  });

  it('is not for anyone else', async () => {
    await tap(CANDIDATE, 'rep:start');
    expect(sent.find((m) => m.method === 'answerCallbackQuery')?.body.text).toBe('For CFT administrators only.');
    expect((await q('select count(*)::int n from work_shifts')).rows[0].n).toBe(0);
    await say(CANDIDATE, '/done something');
    expect((await q('select count(*)::int n from work_entries')).rows[0].n).toBe(0);
  });

  it('runs a shift: start, log from the bot and the API, end, and the daily report', async () => {
    await tap(OWNER, 'rep:start');
    expect(sent.find((m) => m.method === 'answerCallbackQuery')?.body.text).toMatch(/^Shift started at \d\d:\d\d$/);
    expect(of(OWNER, 'editMessageText').at(-1)!.text).toContain('🟢 On shift since');

    await say(OWNER, '/done Агенты находят цены даже с ошибками #топливо');
    const logged = of(OWNER, 'sendMessage').at(-1)!;
    expect(logged.text).toContain('Logged under “Done”: Агенты находят цены даже с ошибками <i>#Топливо</i>');
    // Several lines: several tasks.
    await say(OWNER, '/done\n\nПодключил Парсинг\nСделал Новый UI/UX для мини апп');
    const multi = of(OWNER, 'sendMessage').at(-1)!;
    expect(multi.text).toBe('✅ Logged 2 entries under “Done”:\n1. Подключил Парсинг\n2. Сделал Новый UI/UX для мини апп');
    expect(buttons(multi).map((b) => b.text)).toEqual(['🗑 1', '🗑 2', '📋 All entries']);
    await tap(OWNER, buttons(multi)[1].callback_data);
    await tap(OWNER, buttons(multi)[0].callback_data);
    expect((await q("select count(*)::int n from work_entries where source = 'bot'")).rows[0].n).toBe(1);
    await say(OWNER, '/plan');
    expect(of(OWNER, 'sendMessage').at(-1)!.text).toContain('Write what is planned after the command');

    // Claude logs through the API; a retry with the same id is not added twice.
    expect((await api('POST', 'task-report/entries', { entries: [{ kind: 'done', text: 'x' }] }, null)).status).toBe(401);
    expect((await api('POST', 'task-report/entries', { entries: [{ kind: 'nope', text: 'x' }] })).status).toBe(400);
    const body = { entries: [
      { kind: 'done', text: 'Бот разделён по ролям', area: 'Бот', size: 'l', highlight: true, id: 'c-1' },
      { kind: 'improved', text: 'Новые функции добавляются быстрее', detail: 'у каждой части своё место', id: 'c-2' },
      { kind: 'plan', text: 'Первый отчёт в канал', id: 'c-3' },
    ] };
    expect((await api('POST', 'task-report/entries', body)).body).toMatchObject({ added: 3, skipped: 0 });
    expect((await api('POST', 'task-report/entries', body)).body).toMatchObject({ added: 0, skipped: 3 });
    const list = await api('GET', 'task-report/entries');
    expect((list.body as { entries: unknown[] }).entries).toHaveLength(4);

    sent.length = 0;
    await say(OWNER, '/worklog');
    expect(of(OWNER, 'sendMessage')[0].text).toContain('🤖');
    expect(buttons(of(OWNER, 'sendMessage')[0]).filter((b) => b.text.startsWith('🗑'))).toHaveLength(4);

    sent.length = 0;
    await tap(OWNER, 'rep:end');
    expect(of(OWNER, 'sendMessage')[0].text).toContain("End your shift");
    expect(of(OWNER, 'sendMessage')[0].text).toContain('here (no reports chat connected)');
    sent.length = 0;
    await tap(OWNER, 'rep:endy');
    // No channel yet: the report comes to the private chat.
    const card = of(OWNER, 'sendPhoto')[0];
    expect(card.caption).toMatch(/📅 <b>Отчёт за день · \d\d\/\d\d\/\d{4}<\/b>/);
    expect(card.caption).toContain('✅ 2 задачи · 📈 1 улучшение');
    expect(card.text).toContain('Бот разделён по ролям');
    expect(card.text).toContain('План на завтра');
    expect(of(OWNER, 'editMessageText').at(-1)!.text).toMatch(/⏹ Shift ended: .*\n📤 The day's report was sent above \(no reports chat connected\)\./);
    expect((await q('select count(*)::int n from report_posts')).rows[0].n).toBe(1);
  });

  it('connects the channel when an admin adds the bot, with a pinned status that is edited silently', async () => {
    await hook({ update_id: ++id, my_chat_member: { chat: { id: CHANNEL, type: 'channel', title: 'CFT test reports' }, from: { id: OWNER, first_name: 'Jasper' }, new_chat_member: { status: 'administrator' } } });
    const offer = of(OWNER, 'sendMessage')[0];
    expect(offer.text).toContain('The bot was added to “CFT test reports”');
    expect(buttons(offer)[0].callback_data).toBe(`rep:ch:${CHANNEL}`);
    sent.length = 0;
    await tap(OWNER, `rep:ch:${CHANNEL}`);
    expect(of(OWNER, 'editMessageText').at(-1)!.text).toContain('✅ “CFT test reports” connected');
    const status = of(CHANNEL, 'sendMessage')[0];
    expect(status.text).toContain('⚪️ <b>Jasper A</b> не на смене');
    expect(status.body.disable_notification).toBe(true);
    expect(of(CHANNEL, 'pinChatMessage')).toHaveLength(1);

    // A second shift the same day: the status is edited, and the day's post is replaced in the channel.
    sent.length = 0;
    await say(OWNER, '/startshift');
    expect(of(CHANNEL, 'editMessageText')[0].text).toMatch(/🟢 <b>Jasper A<\/b> на смене с \d\d:\d\d/);
    expect(of(CHANNEL, 'sendMessage')).toHaveLength(0);
    sent.length = 0;
    await say(OWNER, '/endshift');
    await tap(OWNER, 'rep:endy');
    expect(of(CHANNEL, 'sendPhoto')).toHaveLength(1); // the channel's first post of the day
    sent.length = 0;
    await say(OWNER, '/startshift');
    await say(OWNER, '/done Ещё одна задача');
    await say(OWNER, '/endshift');
    await tap(OWNER, 'rep:endy');
    expect(of(CHANNEL, 'sendPhoto')).toHaveLength(0);
    expect(of(CHANNEL, 'editMessageMedia')).toHaveLength(1);
    expect(of(CHANNEL, 'editMessageMedia')[0].caption).toContain('✅ 3 задачи');
    expect(of(OWNER, 'editMessageText').at(-1)!.text).toContain("The day's report was updated in “CFT test reports”");
  });

  it('runs the evening: closes a forgotten shift, then the week on Saturday and the month on its last day', async () => {
    const owner = OWNER;
    await q('delete from report_posts; delete from work_entries; delete from work_shifts');
    // Last month and this one, with work on several days.
    const shift = (day: string, start: string, end: string | null) =>
      q(`insert into work_shifts (staff_id, work_date, started_at, ended_at, end_reason) values ($1, $2, $3, $4, $5)`, [owner, day, `${day}T${start}:00+05:00`, end && `${day}T${end}:00+05:00`, end ? 'manual' : null]);
    const log = (day: string, kind: string, text: string, area: string | null = null) =>
      q(`insert into work_entries (staff_id, work_date, kind, text, area, source) values ($1, $2, $3, $4, $5, 'claude')`, [owner, day, kind, text, area]);
    await shift('2026-10-20', '09:00', '17:00');
    await log('2026-10-20', 'done', 'Октябрьская задача', 'Академия');
    for (const d of ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']) {
      await shift(d, '09:00', '18:00');
      await log(d, 'done', `Задача за ${d}`, 'Топливо');
    }
    await log('2026-11-27', 'improved', 'Поиск стал быстрее');
    await log('2026-11-27', 'learned', 'Проектирование систем');
    // Saturday 28/11: a shift opened at 08:00 is still open at 23:30, so the person is reminded.
    await shift('2026-11-28', '08:00', null);
    sent.length = 0;
    const sat = new Date('2026-11-28T18:30:00Z'); // 23:30 in Tashkent
    await runEvening(getPool(), sat);
    expect(of(owner, 'sendMessage').some((m) => m.text!.includes('Your shift is still open'))).toBe(true);
    // Friday's report never went out (it was added straight to the database), so it goes now; then the week.
    const posted = of(CHANNEL, 'sendPhoto');
    expect(posted.map((p) => p.caption!.split('\n')[0])).toEqual(['📅 <b>Отчёт за день · 27/11/2026</b> (пятница)', '📊 <b>Итоги недели · 22/11 – 28/11/2026</b>']);
    const weekly = [posted[1]];
    expect(weekly[0].caption).toContain('📊 <b>Итоги недели · 22/11 – 28/11/2026</b>');
    expect(weekly[0].caption).toContain('✅ 5 задач выполнено');
    expect(weekly[0].text).toContain('Часы по дням');
    // Twice the same evening: nothing new.
    sent.length = 0;
    await runEvening(getPool(), sat);
    expect(of(CHANNEL, 'sendPhoto')).toHaveLength(0);

    // Monday 30/11 is the last day: the Saturday shift was forgotten (open > 16 h), so it is closed
    // at its last sign of work and its day reported; then the month.
    sent.length = 0;
    await runEvening(getPool(), new Date('2026-11-30T18:30:00Z'));
    const closed = (await q(`select end_reason, ended_at = started_at as at_start from work_shifts where work_date = '2026-11-28'`)).rows[0];
    expect(closed).toEqual({ end_reason: 'auto', at_start: true });
    const photos = of(CHANNEL, 'sendPhoto');
    expect(photos.map((p) => p.caption!.split('\n')[0])).toEqual(['📅 <b>Отчёт за день · 28/11/2026</b> (суббота)', '🗓 <b>Итоги месяца · ноябрь 2026</b>']);
    expect(photos[0].caption).toContain('(закрыта ботом)');
    expect(photos[1].caption).toContain('✅ 5 задач решено');
    expect(photos[1].text).toContain('Чему научился');
    expect(photos[1].text).toContain('+400% к октябрю'); // 5 tasks against 1
    expect(of(CHANNEL, 'editMessageText').at(-1)!.text).toContain('не на смене');

    // The cron route needs the secret.
    expect((await router({ method: 'GET', path: 'cron/task-report', query: new URLSearchParams(), headers: {}, body: null, ip: null })).status).toBe(401);
  });

  it('stops sending to a channel the bot was removed from', async () => {
    await hook({ update_id: ++id, my_chat_member: { chat: { id: CHANNEL, type: 'channel', title: 'CFT test reports' }, from: { id: OWNER, first_name: 'Jasper' }, new_chat_member: { status: 'left' } } });
    expect(of(OWNER, 'sendMessage')[0].text).toContain('The bot is no longer in “CFT test reports”');
    expect((await q('select channel_id from report_staff')).rows[0].channel_id).toBeNull();
  });

  it('sends reports to a group chat: /reports in the group connects it, and the group can be upgraded', async () => {
    const inGroup = (from: number, text: string | undefined, extra: Record<string, unknown> = {}) =>
      hook({ update_id: ++id, message: { chat: { id: GROUP, type: 'supergroup', title: 'CFT test chat' }, from: { id: from, first_name: 'Jasper', last_name: 'A' }, text, ...extra } });
    // Someone who is not an admin: nothing happens, and the bot stays quiet in the group.
    await inGroup(CANDIDATE, '/reports@cft_Agentbot');
    expect(sent).toHaveLength(0);
    await inGroup(OWNER, '/reports@cft_Agentbot');
    expect(of(OWNER, 'sendMessage').at(-1)!.text).toContain('✅ “CFT test chat” connected: your work reports go there now.');
    expect(of(GROUP, 'sendMessage')[0].text).toContain('<b>Jasper A</b> не на смене');
    expect(of(GROUP, 'sendMessage')[0].body.disable_notification).toBe(true);
    expect((await q('select channel_id, channel_title from report_staff')).rows[0]).toEqual({ channel_id: GROUP, channel_title: 'CFT test chat' });
    // Ordinary chatter in the group is ignored.
    sent.length = 0;
    await inGroup(OWNER, 'hello team');
    expect(sent).toHaveLength(0);
    // Adding the bot to another group asks first, in the private chat.
    await hook({ update_id: ++id, my_chat_member: { chat: { id: -100777, type: 'group', title: 'Other group' }, from: { id: OWNER, first_name: 'Jasper' }, new_chat_member: { status: 'member' } } });
    expect(of(OWNER, 'sendMessage')[0].text).toContain('The bot was added to “Other group”');
    // The group becomes a supergroup with a new id: reports follow it.
    await inGroup(OWNER, undefined, { migrate_to_chat_id: -100999 });
    expect((await q('select channel_id from report_staff')).rows[0].channel_id).toBe(-100999);
  });
});
