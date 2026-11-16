import { useEffect, useState } from 'react';
import { isPass } from '../../../../../../shared/analytics';
import type { AdminAttempt, AttemptResult } from '../../../../../../shared/types';
import { adminApi } from '../../../lib/api';
import { ReviewList, TopicRows, topicScores } from '../../shared/review';
import { Icon, Spinner, fmtDate, fmtDuration } from '../../../components/ui';
import { exportCsv } from './csv';
import { activeTotal, MetaChips, PageHead, resultOf, statusChip, type Ctx, type SortKey } from './common';

const COLS: [SortKey, string][] = [['name', 'CANDIDATE'], ['date', 'DATE & TIME'], ['score', 'SCORE'], ['pct', '%'], ['correct', 'CORRECT'], ['incorrect', 'INCORRECT'], ['result', 'RESULT'], ['status', 'STATUS']];

export function Attempts({ ctx }: { ctx: Ctx }) {
  const { data, filters: f, setFilters } = ctx;
  const pm = data.settings.passMark;
  const atts = data.attempts;
  const q = f.q.trim().toLowerCase();
  const list = atts.filter(
    (a) =>
      (!q || a.name.toLowerCase().includes(q) || a.id.startsWith(q) || (a.telegramUsername ?? '').toLowerCase().includes(q.replace(/^@/, ''))) &&
      (f.st === 'all' || a.status === f.st) &&
      (f.rs === 'all' || (a.status === 'completed' && (f.rs === 'pass' ? isPass(a, pm) : !isPass(a, pm)))),
  );
  const key: Record<SortKey, (a: AdminAttempt) => string | number> = {
    name: (a) => a.name.toLowerCase(),
    date: (a) => a.startedAt,
    score: (a) => a.correct ?? -1,
    pct: (a) => a.pct ?? -1,
    correct: (a) => a.correct ?? -1,
    incorrect: (a) => (a.status === 'completed' ? a.total - (a.correct ?? 0) : -1),
    status: (a) => a.status,
    result: (a) => (a.status !== 'completed' ? -1 : isPass(a, pm) ? 1 : 0),
  };
  const k = key[f.sk];
  list.sort((a, b) => {
    const x = k(a), y = k(b);
    return (x < y ? -1 : x > y ? 1 : 0) * (f.sd === 'asc' ? 1 : -1);
  });
  const sortBy = (s: SortKey) => setFilters({ sk: s, sd: f.sk === s ? (f.sd === 'asc' ? 'desc' : 'asc') : s === 'name' ? 'asc' : 'desc' });
  const done = atts.filter((a) => a.status === 'completed');
  const table = ctx.w >= 1000;

  const onExport = () =>
    exportCsv('attempts', [
      { label: 'Candidate', get: (a: AdminAttempt) => a.name },
      { label: 'Telegram', get: (a) => (a.telegramUsername ? '@' + a.telegramUsername : a.channel === 'telegram' ? 'yes' : '') },
      { label: 'Attempt ID', get: (a) => a.id },
      { label: 'Started', get: (a) => a.startedAt },
      { label: 'Submitted', get: (a) => a.submittedAt ?? '' },
      { label: 'Status', get: (a) => (a.status === 'completed' ? 'Completed' : 'In progress') },
      { label: 'Correct', get: (a) => a.correct ?? '' },
      { label: 'Incorrect', get: (a) => (a.status === 'completed' ? a.total - (a.correct ?? 0) - (a.unanswered ?? 0) : '') },
      { label: 'Unanswered', get: (a) => a.unanswered ?? '' },
      { label: 'Total questions', get: (a) => a.total },
      { label: 'Percentage', get: (a) => a.pct ?? '' },
      { label: 'Pass mark', get: (a) => a.passMark ?? '' },
      { label: 'Result', get: (a) => (a.status !== 'completed' ? '' : isPass(a, pm) ? 'Pass' : 'Below pass mark') },
      { label: 'Duration (min)', get: (a) => (a.durationSec == null ? '' : Math.max(1, Math.round(a.durationSec / 60))) },
    ], list);

  return (
    <>
      <PageHead title="ATTEMPTS" sub="every candidate attempt" ctx={ctx} onExport={onExport} />
      <MetaChips items={[
        { icon: 'filter', text: `Showing ${list.length} of ${atts.length}` },
        { icon: 'check', text: `${done.length} completed` },
        { icon: 'clock', text: `${atts.length - done.length} in progress`, color: 'var(--muted)' },
        { icon: 'award', text: `${done.filter((a) => isPass(a, pm)).length} passed` },
      ]} />
      <div className="row-scroll">
        <div className="search">
          <Icon name="search" />
          <input className="ctl" value={f.q} onChange={(e) => setFilters({ q: e.target.value })} aria-label="Search candidates" placeholder="Search name, @username or attempt ID" style={{ fontSize: 15 }} />
        </div>
        <select className="ctl" value={f.st} onChange={(e) => setFilters({ st: e.target.value as never })} aria-label="Status" style={{ flex: 'none' }}>
          <option value="all">All statuses</option><option value="completed">Completed</option><option value="in_progress">In progress</option>
        </select>
        <select className="ctl" value={f.rs} onChange={(e) => setFilters({ rs: e.target.value as never })} aria-label="Result" style={{ flex: 'none' }}>
          <option value="all">All results</option><option value="pass">Pass</option><option value="below">Below pass mark</option>
        </select>
        {!table && (
          <select className="ctl" value={f.sk + ':' + f.sd} onChange={(e) => { const [sk, sd] = e.target.value.split(':'); setFilters({ sk: sk as SortKey, sd: sd as 'asc' | 'desc' }); }} aria-label="Sort" style={{ flex: 'none' }}>
            <option value="date:desc">Newest first</option><option value="date:asc">Oldest first</option><option value="score:desc">Highest score</option><option value="score:asc">Lowest score</option><option value="name:asc">Name A–Z</option>
          </select>
        )}
      </div>
      {list.length === 0 && (
        <div className="empty">
          <span className="cond" style={{ fontSize: 16, color: '#fff' }}>{atts.length ? 'NO MATCHING ATTEMPTS' : 'NO ATTEMPTS YET'}</span>
          <span className="muted">{atts.length ? 'Try a different name or clear the filters.' : 'Attempts appear here as soon as a candidate starts the test.'}</span>
          {atts.length > 0 && <button className="pill" onClick={() => setFilters({ q: '', st: 'all', rs: 'all' })}>Clear filters</button>}
        </div>
      )}
      {list.length > 0 && table && (
        <div role="table" aria-label="Assessment attempts" className="card table">
          <div role="row" className="tr" style={{ background: 'rgba(255,255,255,.04)' }}>
            {COLS.map(([s, label]) => (
              <button key={s} role="columnheader" aria-sort={f.sk === s ? (f.sd === 'asc' ? 'ascending' : 'descending') : 'none'} className="th" onClick={() => sortBy(s)}>
                {label}
                <Icon name="down" size={12} style={{ opacity: f.sk === s ? 1 : 0.25, transform: f.sk === s && f.sd === 'asc' ? 'rotate(180deg)' : undefined, strokeWidth: 2.5 }} />
              </button>
            ))}
          </div>
          {list.map((a) => {
            const d = a.status === 'completed';
            const r = resultOf(a, pm);
            return (
              <div key={a.id} role="row" className="tr body" onClick={() => ctx.openAttempt(a.id)}>
                <div role="cell" className="td">
                  <button className="link-btn" style={{ textDecoration: 'none', fontWeight: 700, fontSize: 14, textAlign: 'left' }} onClick={(e) => { e.stopPropagation(); ctx.openAttempt(a.id); }}>{a.name}</button>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{a.telegramUsername ? '@' + a.telegramUsername : a.id.slice(0, 8)}</div>
                </div>
                <div role="cell" className="td soft">{fmtDate(a.startedAt)}</div>
                <div role="cell" className="td cond">{d ? `${a.correct}/${a.total}` : '—'}</div>
                <div role="cell" className="td">{d ? a.pct + '%' : '—'}</div>
                <div role="cell" className="td">{d ? a.correct : '—'}</div>
                <div role="cell" className="td">{d ? a.total - (a.correct ?? 0) : '—'}</div>
                <div role="cell" className="td"><span style={{ fontSize: 12, fontWeight: 700, color: r.color }}>{r.label}</span></div>
                <div role="cell" className="td">{statusChip(a)}</div>
              </div>
            );
          })}
        </div>
      )}
      {list.length > 0 && !table && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((a) => {
            const d = a.status === 'completed';
            const r = resultOf(a, pm);
            return (
              <button key={a.id} className="card att-card" onClick={() => ctx.openAttempt(a.id)}>
                <span><span style={{ fontSize: 16, fontWeight: 700 }}>{a.name}</span><span className="cond" style={{ fontSize: 18 }}>{d ? `${a.correct}/${a.total}` : '—'}</span></span>
                <span className="muted" style={{ fontSize: 13 }}><span>{fmtDate(a.startedAt)}</span><span>{d ? a.pct + '%' : `${a.answeredCount} of ${a.total} answered`}</span></span>
                <span style={{ justifyContent: 'flex-start', alignItems: 'center', gap: 8 }}>{statusChip(a)}<span style={{ fontSize: 12, fontWeight: 700, color: r.color }}>{r.long}</span></span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

export function AttemptDetail({ ctx, id }: { ctx: Ctx; id: string }) {
  const { data } = ctx;
  const a = data.attempts.find((x) => x.id === id);
  const [review, setReview] = useState<AttemptResult | null>(null);
  const [err, setErr] = useState('');
  const done = a?.status === 'completed';

  useEffect(() => {
    if (!done) return;
    let live = true;
    adminApi.attempt(id).then((r) => live && setReview(r)).catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [id, done]);

  const back = (
    <button className="link-btn" style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', textDecoration: 'none', fontSize: 14 }} onClick={() => ctx.go('attempts')}>
      <Icon name="left" />Attempts
    </button>
  );
  if (!a) return <>{back}<div className="empty">This attempt no longer exists.</div></>;
  const r = resultOf(a, data.settings.passMark);
  const total = activeTotal(data);
  return (
    <>
      {back}
      <PageHead title="ATTEMPT" sub={done ? 'answers and explanations' : 'in progress'} ctx={ctx} />
      <div className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,260px),1fr))', gap: 24, alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="cond" style={{ fontSize: 24 }}>{a.name}</span>
          <span className="muted" style={{ fontSize: 13 }}>{a.telegramUsername ? `@${a.telegramUsername} · ` : a.channel === 'telegram' ? 'Telegram · ' : 'Web · '}{a.id.slice(0, 8)} · token ••••{a.tokenTail}</span>
          <span style={{ alignSelf: 'flex-start', marginTop: 6 }}>{statusChip(a)}</span>
        </div>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 16 }}>
          <div><dt className="eyebrow">SCORE</dt><dd className="cond" style={{ margin: '4px 0 0', fontSize: 22 }}>{done ? `${a.correct}/${a.total} · ${a.pct}%` : '—'}</dd></div>
          <div><dt className="eyebrow">RESULT</dt><dd style={{ margin: '4px 0 0', fontSize: 15, fontWeight: 700, color: r.color }}>{done ? (r.label === 'PASS' ? 'Pass' : 'Below pass mark') : 'Not graded'}</dd></div>
          <div><dt className="eyebrow">STARTED</dt><dd style={{ margin: '4px 0 0', fontSize: 14 }}>{fmtDate(a.startedAt)}</dd></div>
          <div><dt className="eyebrow">SUBMITTED</dt><dd style={{ margin: '4px 0 0', fontSize: 14 }}>{fmtDate(a.submittedAt)}</dd></div>
          <div><dt className="eyebrow">DURATION</dt><dd style={{ margin: '4px 0 0', fontSize: 14 }}>{fmtDuration(a.durationSec)}</dd></div>
        </dl>
      </div>
      {!done && (
        <div className="empty" style={{ alignItems: 'flex-start', textAlign: 'left', fontSize: 15, lineHeight: 1.5 }}>
          {a.answeredCount} of {total} questions answered so far. This attempt hasn't been submitted, so it isn't graded and no answers are shown.
        </div>
      )}
      {done && !review && !err && <div className="center-msg" style={{ height: 120 }}><Spinner size={20} /></div>}
      {err && <div role="alert" className="alert"><Icon name="info" />{err}</div>}
      {review && (
        <>
          <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="cond" style={{ fontSize: 14, marginBottom: 8 }}>BY TOPIC</span>
            <TopicRows rows={topicScores(review.questions, review.answers, review.topics)} compact />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ReviewList admin questions={review.questions} answers={review.answers} title={<span className="cond" style={{ fontSize: 14 }}>ANSWERS</span>} />
          </div>
        </>
      )}
    </>
  );
}
