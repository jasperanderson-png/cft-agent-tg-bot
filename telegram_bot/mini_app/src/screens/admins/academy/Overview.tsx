import { useState } from 'react';
import { isPass, overview, questionStats, scoreDistribution } from '../../../../../../shared/analytics';
import type { AdminAttempt } from '../../../../../../shared/types';
import { Icon, Modal, fmtDate, type IconName } from '../../../components/ui';
import { activeTotal, PageHead, Section, statusChip, type AttemptFilters, type Ctx } from './common';

type KpiKey = 'candidates' | 'completed' | 'avg' | 'highlow' | 'completion' | 'pass';
const initials = (n: string) => n.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const when = (a: AdminAttempt) => a.submittedAt ?? a.startedAt;

export function Overview({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const pm = data.settings.passMark;
  const total = activeTotal(data);
  const o = overview(data.attempts, pm);
  const [kpi, setKpi] = useState<KpiKey | null>(null);
  const done = data.attempts.filter((a) => a.status === 'completed');

  const kpis: { key: KpiKey; label: string; value: string; sub: string }[] = [
    { key: 'candidates', label: 'CANDIDATES', value: String(o.candidates), sub: `${o.inProgress} in progress` },
    { key: 'completed', label: 'COMPLETED', value: String(o.completed), sub: `of ${o.started} started` },
    { key: 'avg', label: 'AVERAGE SCORE', value: o.avg == null ? '—' : o.avg.toFixed(1), sub: o.avg == null ? 'no attempts yet' : `of ${total} · ${Math.round((o.avg / total) * 100)}%` },
    { key: 'highlow', label: 'HIGH / LOW', value: o.high == null ? '—' : `${o.high} / ${o.low}`, sub: `out of ${total}` },
    { key: 'completion', label: 'COMPLETION RATE', value: o.completionRate == null ? '—' : o.completionRate + '%', sub: `${o.completed} of ${o.started} submitted` },
    { key: 'pass', label: 'PASS RATE', value: o.passRate == null ? '—' : o.passRate + '%', sub: `${o.passed} of ${o.completed} at ${pm}+` },
  ];

  const dist = scoreDistribution(data.attempts, total);
  const mx = Math.max(1, ...dist.map((d) => d.count));
  const gaps = questionStats(data.questions.filter((q) => q.active), data.attempts)
    .filter((g) => g.responses > 0)
    .sort((a, b) => b.pctIncorrect - a.pctIncorrect || a.n - b.n)
    .slice(0, 4);
  const recent = data.attempts.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 6);

  return (
    <>
      <PageHead title="OVERVIEW" sub="results at a glance" ctx={ctx} />
      <div className="kpis stagger">
        {kpis.map((k) => (
          <button key={k.key} className="card kpi" onClick={() => setKpi(k.key)} aria-haspopup="dialog" aria-label={`Open ${k.label.toLowerCase()} details`}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="eyebrow">{k.label}</span>
              <span className="arrow"><Icon name="arrow" size={12} /></span>
            </span>
            <span className="v">{k.value}</span>
            <span className="s">{k.sub}</span>
          </button>
        ))}
      </div>
      <div className="grid2">
        <Section title="SCORE DISTRIBUTION" gap={18} action={<span className="muted" style={{ fontSize: 13 }}>{o.completed} completed attempts · score out of {total}</span>}>
          {o.completed === 0 ? (
            <div className="empty" style={{ padding: 24 }}>No submitted attempts yet.</div>
          ) : (
            <>
              <div role="img" aria-label={`Score distribution for ${o.completed} attempts`} className="dist">
                {dist.map((b, i) => (
                  <div key={b.score}>
                    <span>{b.count || ''}</span>
                    <i style={{ height: (b.count / mx) * 82 + '%', background: b.score >= pm ? 'var(--blue)' : '#333', animationDelay: 200 + i * 35 + 'ms' }} />
                  </div>
                ))}
              </div>
              <div className="dist-axis">
                {dist.map((b) => <span key={b.score} style={{ color: b.score === pm ? '#fff' : undefined }}>{b.score}</span>)}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12 }} className="muted">
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i className="sw" style={{ width: 12, height: 12, background: 'var(--blue)' }} />At or above pass mark ({pm})</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i className="sw" style={{ width: 12, height: 12, background: '#333' }} />Below pass mark</span>
              </div>
            </>
          )}
        </Section>
        <Section title="MOST MISSED QUESTIONS" className="stagger" action={<button className="link-btn" onClick={() => ctx.go('questions')}>All questions</button>}>
          {gaps.length === 0 && <div className="muted" style={{ fontSize: 14 }}>Appears once attempts are submitted.</div>}
          {gaps.map((g) => (
            <div key={g.n} className="list-row" style={{ gridTemplateColumns: '44px minmax(0,1fr) auto' }}>
              <span className="cond" style={{ fontSize: 14 }}>Q{g.n}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, lineHeight: 1.35 }}>{g.text}</div>
                {g.topWrong && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Most chosen wrong answer: {g.topWrong.key}. {g.topWrong.text} ({g.topWrong.count})</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="cond" style={{ fontSize: 18, color: 'var(--bad)' }}>{g.pctIncorrect}%</div>
                <div className="muted" style={{ fontSize: 11 }}>{g.incorrect} of {g.responses}</div>
              </div>
            </div>
          ))}
        </Section>
      </div>
      <Section title="RECENT ATTEMPTS" gap={6} className="stagger" action={<button className="link-btn" onClick={() => ctx.go('attempts')}>All attempts</button>}>
        {recent.length === 0 && <div className="muted" style={{ fontSize: 14, paddingTop: 8 }}>No attempts yet. Share the bot link with candidates to get started.</div>}
        {recent.map((a) => (
          <button key={a.id} className="rowbtn" onClick={() => ctx.openAttempt(a.id)}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15 }}>{a.name}</span>
              <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{fmtDate(a.startedAt)}</span>
            </span>
            <span className="cond num" style={{ fontSize: 15 }}>{a.status === 'completed' ? `${a.correct}/${a.total}` : '—'}</span>
            <span style={{ minWidth: 92, display: 'flex', justifyContent: 'center' }}>{statusChip(a)}</span>
          </button>
        ))}
      </Section>
      {kpi && <KpiDialog k={kpi} label={kpis.find((x) => x.key === kpi)!} ctx={ctx} done={done} total={total} avg={o.avg} onClose={() => setKpi(null)} />}
    </>
  );
}

function KpiDialog({ k, label, ctx, done, total, avg, onClose }: {
  k: KpiKey; label: { label: string; value: string; sub: string }; ctx: Ctx; done: AdminAttempt[]; total: number; avg: number | null; onClose: () => void;
}) {
  const { data } = ctx;
  const pm = data.settings.passMark;
  const atts = data.attempts;
  const byScore = done.slice().sort((a, b) => (b.correct ?? 0) - (a.correct ?? 0) || a.name.localeCompare(b.name));
  const newest = (x: AdminAttempt[]) => x.slice().sort((a, b) => when(b).localeCompare(when(a)));
  const latest = new Map<string, AdminAttempt>();
  for (const a of atts) if (!latest.has(a.candidateId) || a.startedAt > latest.get(a.candidateId)!.startedAt) latest.set(a.candidateId, a);
  const statusTag = (a: AdminAttempt) => (a.status === 'completed' ? 'COMPLETED' : 'IN PROGRESS');

  const spec: Record<KpiKey, { icon: IconName; col3: string; rows: [AdminAttempt, string | null][]; foot: string; filters: Partial<AttemptFilters> }> = {
    candidates: { icon: 'attempts', col3: 'STATUS', rows: [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)).map((a) => [a, statusTag(a)]), foot: 'Latest attempt per candidate', filters: {} },
    completed: { icon: 'check', col3: 'RESULT', rows: newest(done).map((a) => [a, null]), foot: 'Newest first', filters: { st: 'completed' } },
    avg: { icon: 'list', col3: 'RESULT', rows: byScore.map((a) => [a, null]), foot: avg == null ? 'No attempts yet' : `Average ${avg.toFixed(1)} of ${total} across ${done.length} attempts`, filters: { st: 'completed', sk: 'score', sd: 'desc' } },
    highlow: { icon: 'award', col3: 'RANK', rows: byScore.map((a, i) => [a, '#' + (i + 1)]), foot: 'Ranked by score', filters: { st: 'completed', sk: 'score', sd: 'desc' } },
    completion: { icon: 'clock', col3: 'STATUS', rows: [...newest(atts.filter((a) => a.status !== 'completed')), ...newest(done)].map((a) => [a, statusTag(a)]), foot: 'In-progress attempts first', filters: {} },
    pass: { icon: 'award', col3: 'RESULT', rows: [...byScore.filter((a) => isPass(a, pm)), ...byScore.filter((a) => !isPass(a, pm))].map((a) => [a, null]), foot: `Pass mark ${pm}/${total}`, filters: { st: 'completed' } },
  };
  const m = spec[k];

  return (
    <Modal onClose={onClose} labelledBy="kpi-title" sheet={ctx.narrow} style={{ maxWidth: 680, maxHeight: 'min(720px, 88vh)' }}>
      <div className="dialog-head">
        <span className="badge-icon"><Icon name={m.icon} size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow">{label.label}</div>
          <div id="kpi-title" className="cond" style={{ fontSize: 26, lineHeight: 1.1, marginTop: 2 }}>{label.value}</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{label.sub}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="eyebrow" style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 64px 110px', gap: 12, padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
        <span>CANDIDATE</span><span style={{ textAlign: 'right' }}>SCORE</span><span style={{ textAlign: 'right' }}>{m.col3}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '6px 8px' }}>
        {m.rows.length === 0 && <div className="muted" style={{ padding: 20, fontSize: 14 }}>Nothing to show yet.</div>}
        {m.rows.map(([a, tagOverride]) => {
          const d = a.status === 'completed';
          const pass = isPass(a, pm);
          const tag = tagOverride ?? (d ? (pass ? 'PASS' : 'BELOW') : 'IN PROGRESS');
          const good = tag === 'PASS' || tag === 'COMPLETED' || tag.startsWith('#');
          const frac = d ? (a.correct ?? 0) / a.total : a.answeredCount / a.total;
          return (
            <button key={a.id} className="rowbtn" style={{ width: '100%', margin: 0, gridTemplateColumns: 'minmax(0,1fr) 64px 110px', gap: 12, padding: '10px 12px' }} onClick={() => { onClose(); ctx.openAttempt(a.id); }}>
              <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 'none', width: 30, height: 30, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.06)', fontSize: 11, fontWeight: 700, color: 'var(--soft)' }}>{initials(a.name)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <span style={{ flex: 'none', width: 96, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: '100%', width: frac * 100 + '%', background: d ? (pass ? 'var(--blue)' : 'var(--bad)') : '#666' }} />
                    </span>
                    <span className="muted nowrap" style={{ fontSize: 11 }}>{fmtDate(when(a))}</span>
                  </span>
                </span>
              </span>
              <span className="cond num" style={{ textAlign: 'right', fontSize: 15 }}>{d ? `${a.correct}/${a.total}` : `${a.answeredCount}/${a.total}`}</span>
              <span style={{ justifySelf: 'end', height: 24, padding: '0 9px', display: 'inline-flex', alignItems: 'center', borderRadius: 999, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', border: '1px solid', borderColor: good ? 'var(--blue)' : tag === 'IN PROGRESS' ? '#3f3f3f' : 'var(--bad)', background: good ? 'var(--blue)' : 'transparent', color: good ? '#000' : tag === 'IN PROGRESS' ? 'var(--soft)' : 'var(--bad)' }}>{tag}</span>
            </button>
          );
        })}
      </div>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', borderTop: '1px solid var(--line-2)' }}>
        <span className="muted" style={{ fontSize: 12 }}>{m.foot}</span>
        <button className="pill pill-primary" onClick={() => { onClose(); ctx.go('attempts', { ...m.filters, q: '', rs: 'all' }); }}>Open in Attempts<Icon name="arrow" size={12} /></button>
      </div>
    </Modal>
  );
}
