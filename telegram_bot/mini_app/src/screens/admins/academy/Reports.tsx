import { useState } from 'react';
import { isPass, overview } from '../../../../../../shared/analytics';
import { dmy, inRange, rangeFor, weekStart, zoned } from '../../../../../../shared/time';
import type { ReportRange } from '../../../../../../shared/types';
import { ApiError, adminApi } from '../../../lib/api';
import { canTelegramDownload, telegramDownload, tg } from '../../../lib/telegram';
import { Bar, Icon, Spinner } from '../../../components/ui';
import { activeTotal, PageHead, Section, type Ctx } from './common';

const RANGES: [ReportRange, string][] = [['week', 'This week'], ['last_week', 'Last week'], ['30d', 'Last 30 days'], ['all', 'All time']];

export function Reports({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const tz = data.settings.timezone;
  const pm = data.settings.passMark;
  const total = activeTotal(data);
  const [range, setRange] = useState<ReportRange>('week');
  const [busy, setBusy] = useState<'' | 'dl' | 'tg' | 'weekly'>('');
  const r = rangeFor(range, tz);
  const done = data.attempts.filter((a) => a.status === 'completed' && inRange(a.submittedAt, r));
  const started = data.attempts.filter((a) => inRange(a.startedAt, r)).length;
  const o = overview(done, pm);
  const linked = !!data.me?.telegramUserId;

  // Last 8 Monday-start weeks in the report time zone.
  const now = new Date();
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const from = weekStart(now, tz, -i);
    const to = weekStart(now, tz, -i + 1);
    const wr = { from, to, label: '' };
    const wd = data.attempts.filter((a) => a.status === 'completed' && inRange(a.submittedAt, wr));
    const wo = overview(wd, pm);
    const end = zoned(new Date(to.getTime() - 1), tz);
    return {
      key: from.toISOString(),
      label: `${dmy(zoned(from, tz)).slice(0, 5)} – ${dmy(end)}`,
      current: i === 0,
      started: data.attempts.filter((a) => inRange(a.startedAt, wr)).length,
      completed: wd.length,
      passed: wd.filter((a) => isPass(a, pm)).length,
      passRate: wo.passRate,
      avg: wo.avg,
    };
  });
  const maxDone = Math.max(1, ...weeks.map((w) => w.completed));

  const run = async (kind: typeof busy, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      ctx.onError(e as ApiError);
    } finally {
      setBusy('');
    }
  };
  const download = () =>
    run('dl', async () => {
      const { path, filename } = await adminApi.reportDownload(range);
      if (canTelegramDownload()) telegramDownload(location.origin + path, filename);
      else {
        const a = document.createElement('a');
        a.href = path;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      ctx.toast('Excel report ready');
    });
  const toTelegram = () =>
    run('tg', async () => {
      await adminApi.reportToTelegram(range);
      ctx.toast('Report sent to your Telegram chat');
    });
  const weekly = () =>
    run('weekly', async () => {
      const res = await adminApi.sendWeekly();
      ctx.toast(res.sent ? `Weekly summary sent to ${res.sent} admin${res.sent === 1 ? '' : 's'}` : 'No admins could be reached — they need to press Start in the bot');
    });

  return (
    <>
      <PageHead title="REPORTS" sub={`Excel reports and weekly statistics · ${tz}`} ctx={ctx} />
      <div role="tablist" aria-label="Report period" className="tabs" style={{ alignSelf: 'flex-start', overflowX: 'auto', maxWidth: '100%' }}>
        {RANGES.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={range === k} onClick={() => setRange(k)} style={{ whiteSpace: 'nowrap' }}>{label}</button>
        ))}
      </div>
      <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span className="cond" style={{ fontSize: 14 }}>{RANGES.find((x) => x[0] === range)![1].toUpperCase()}</span>
          <span className="muted" style={{ fontSize: 13 }}>{r.label}</span>
        </div>
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
          <div className="tile"><b>{started}</b><span>started</span></div>
          <div className="tile"><b>{o.completed}</b><span>completed</span></div>
          <div className="tile"><b style={{ color: 'var(--blue)' }}>{o.passed}</b><span>passed</span></div>
          <div className="tile"><b style={{ color: o.completed - o.passed ? 'var(--bad)' : undefined }}>{o.completed - o.passed}</b><span>failed</span></div>
          <div className="tile"><b>{o.passRate == null ? '—' : o.passRate + '%'}</b><span>pass rate</span></div>
          <div className="tile"><b>{o.avg == null ? '—' : o.avg.toFixed(1)}</b><span>average of {total}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="pill pill-primary" onClick={download} disabled={!!busy}>{busy === 'dl' ? <Spinner /> : <Icon name="download" />}Download Excel</button>
          {linked && <button className="pill" onClick={toTelegram} disabled={!!busy}>{busy === 'tg' ? <Spinner /> : <Icon name="send" />}{tg ? 'Send to my chat' : 'Send to my Telegram'}</button>}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
          The workbook has Summary, Results, In progress, Answers (green = correct, red = wrong), Questions and Topics sheets. Dates are dd/mm/yyyy, times are rounded to the minute and percentages to whole numbers.
        </p>
      </div>

      <Section title="WEEKLY STATISTICS" action={<button className="link-btn" onClick={weekly} disabled={!!busy}>{busy === 'weekly' ? 'Sending…' : 'Send summary to admins now'}</button>}>
        <div className="muted" style={{ fontSize: 13, marginTop: -6 }}>Weeks start on Monday. The bot sends last week's summary with the Excel file every Monday at 09:00 (Tashkent time by default).</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="wk">
            <thead>
              <tr><th>Week</th><th>Started</th><th>Completed</th><th style={{ minWidth: 110 }} /><th>Passed</th><th>Pass rate</th><th>Avg</th></tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.key}>
                  <td className="nowrap">{w.label}{w.current && <span className="muted" style={{ fontSize: 11 }}> · so far</span>}</td>
                  <td>{w.started}</td>
                  <td>{w.completed}</td>
                  <td><Bar pct={(w.completed / maxDone) * 100} height={6} /></td>
                  <td>{w.passed}</td>
                  <td style={{ color: w.passRate == null ? 'var(--muted)' : w.passRate >= 70 ? 'var(--blue)' : 'var(--bad)' }}>{w.passRate == null ? '—' : w.passRate + '%'}</td>
                  <td>{w.avg == null ? '—' : w.avg.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
