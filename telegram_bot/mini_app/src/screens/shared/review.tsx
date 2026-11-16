import { useState, type ReactNode } from 'react';
import type { Answers, ReviewQuestion, Topic } from '../../../../../shared/types';
import { Bar, Icon } from '../../components/ui';

export interface TopicScore {
  id: string;
  name: string;
  correct: number;
  total: number;
  pct: number;
  tag: 'STRENGTH' | 'OK' | 'REVIEW';
}

/** Per-topic breakdown of one attempt. Tags: ≥80% strength, <70% review. */
export function topicScores(questions: ReviewQuestion[], answers: Answers, topics: Topic[]): TopicScore[] {
  return topics
    .map((t) => {
      const qs = questions.filter((q) => q.topic === t.id);
      const correct = qs.filter((q) => answers[q.n] === q.correct).length;
      const pct = qs.length ? Math.round((correct / qs.length) * 100) : 0;
      return { id: t.id, name: t.name, correct, total: qs.length, pct, tag: pct >= 80 ? 'STRENGTH' : pct < 70 ? 'REVIEW' : 'OK' } as TopicScore;
    })
    .filter((t) => t.total > 0);
}

export function TopicRows({ rows, compact = false }: { rows: TopicScore[]; compact?: boolean }) {
  if (compact) {
    return (
      <>
        {rows.map((t) => (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(80px,220px) 60px', gap: 16, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--line-2)', fontSize: 14 }}>
            <span>{t.name}</span>
            <Bar pct={t.pct} />
            <span className="num" style={{ textAlign: 'right' }}>{t.correct}/{t.total}</span>
          </div>
        ))}
      </>
    );
  }
  return (
    <div className="stagger" style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)' }}>
      {rows.map((t) => (
        <div key={t.id} className="topic-row">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16 }}>{t.name}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{t.correct} of {t.total} correct</div>
          </div>
          <Bar pct={t.pct} height={6} />
          <span className={'tag ' + (t.tag === 'STRENGTH' ? 'strength' : t.tag === 'REVIEW' ? 'review' : '')}>{t.tag}</span>
        </div>
      ))}
    </div>
  );
}

function ReviewCard({ q, selected, admin }: { q: ReviewQuestion; selected: string | undefined; admin: boolean }) {
  const [open, setOpen] = useState(false);
  const ok = selected === q.correct;
  const status = ok ? 'CORRECT' : selected ? 'INCORRECT' : 'NOT ANSWERED';
  const why = Object.entries(q.why).sort(([a], [b]) => a.localeCompare(b));
  return (
    <article className="review">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span className="eyebrow">QUESTION {q.idx}{admin && q.idx !== q.n ? ` · Q${q.n}` : ''}</span>
        <span className={'chip ' + (ok ? 'chip-done' : 'chip-bad')} style={{ height: 26, fontSize: 12 }}>{status}</span>
      </div>
      <h3>{q.text}</h3>
      <div className="ropts">
        {q.options.map((o) => {
          const isC = o.key === q.correct;
          const isS = o.key === selected;
          const note = isC ? (isS ? (admin ? 'Selected · correct' : 'Your answer · correct') : 'Correct answer') : isS ? (admin ? 'Selected' : 'Your answer') : '';
          return (
            <div key={o.key} className={'ropt' + (isC ? ' correct' : isS ? ' picked' : '')}>
              <span className="key">{o.key}</span>
              <span className="t">{o.text}</span>
              {note && <span className="note">{note}</span>}
            </div>
          );
        })}
      </div>
      <div className="explain">{q.explanation}</div>
      {(why.length > 0 || q.basis) && (
        <button className="text-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide why the other options are incorrect' : 'Why the other options are incorrect'}
          <Icon name="down" style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
        </button>
      )}
      {open && (
        <div className="why fade-in">
          {q.whyCorrect && <div><b>{q.correct}.</b><span>{q.whyCorrect}</span></div>}
          {why.map(([k, t]) => (
            <div key={k}><b>{k}.</b><span>{t}</span></div>
          ))}
          {q.basis && <div className="muted" style={{ fontSize: 12 }}>Basis: {q.basis}{q.edited ? ' · Question edited by an administrator' : ''}</div>}
        </div>
      )}
    </article>
  );
}

export function ReviewList({ questions, answers, admin = false, title }: { questions: ReviewQuestion[]; answers: Answers; admin?: boolean; title: ReactNode }) {
  const [filter, setFilter] = useState<'all' | 'incorrect'>('all');
  const wrong = questions.filter((q) => answers[q.n] !== q.correct);
  const list = filter === 'all' ? questions : wrong;
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        {title}
        <div role="tablist" aria-label="Filter answers" className="tabs">
          <button role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>All {questions.length}</button>
          <button role="tab" aria-selected={filter === 'incorrect'} onClick={() => setFilter('incorrect')}>{admin ? 'Incorrect' : 'To review'} {wrong.length}</button>
        </div>
      </div>
      {list.length === 0 && <div className="empty">Every question was answered correctly.</div>}
      {list.map((q) => (
        <ReviewCard key={q.n} q={q} selected={answers[q.n]} admin={admin} />
      ))}
    </>
  );
}
