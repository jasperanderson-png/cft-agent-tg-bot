import { useState } from 'react';
import { findPatterns, PATTERN_RULES, questionStats, topicStats, type QuestionStat, type TopicStat } from '../../../../../../shared/analytics';
import { Bar, Icon } from '../../../components/ui';
import { exportCsv } from './csv';
import { MetaChips, PageHead, topicName, type Ctx } from './common';

export function Questions({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const [qq, setQq] = useState('');
  const [sort, setSort] = useState<'error' | 'order'>('error');
  const [topic, setTopic] = useState('all');
  const ms = data.settings.minSample;
  const active = data.questions.filter((q) => q.active);
  const stats = questionStats(active, data.attempts);
  const n = data.attempts.filter((a) => a.status === 'completed').length;
  const term = qq.trim().toLowerCase();
  const num = term.replace(/^q/, '');
  let list = stats.filter((x) => (topic === 'all' || x.topic === topic) && (!term || String(x.n) === num || x.text.toLowerCase().includes(term)));
  list = sort === 'error' ? list.sort((a, b) => b.pctIncorrect - a.pctIncorrect || a.n - b.n) : list.sort((a, b) => a.n - b.n);

  const onExport = () =>
    exportCsv('questions', [
      { label: 'Question', get: (s: QuestionStat) => s.n },
      { label: 'Text', get: (s) => s.text },
      { label: 'Topic (inferred)', get: (s) => topicName(data, s.topic) },
      { label: 'Correct option', get: (s) => s.correctKey },
      { label: 'Responses', get: (s) => s.responses },
      { label: 'Correct', get: (s) => s.correct },
      { label: '% correct', get: (s) => s.pctCorrect },
      { label: 'Incorrect', get: (s) => s.incorrect },
      { label: '% incorrect', get: (s) => s.pctIncorrect },
      { label: 'Chose A', get: (s) => s.dist.A },
      { label: 'Chose B', get: (s) => s.dist.B },
      { label: 'Chose C', get: (s) => s.dist.C },
      { label: 'Chose D', get: (s) => s.dist.D },
      { label: 'Unanswered', get: (s) => s.unanswered },
      { label: 'Most common wrong option', get: (s) => (s.topWrong ? `${s.topWrong.key}. ${s.topWrong.text}` : '') },
      { label: 'Most common wrong count', get: (s) => s.topWrong?.count ?? '' },
      { label: 'Low sample', get: (s) => (s.responses < ms ? 'yes' : 'no') },
    ], list);

  return (
    <>
      <PageHead title="QUESTIONS" sub="question-level accuracy" ctx={ctx} onExport={onExport} />
      <MetaChips items={[
        { icon: 'list', text: `${list.length} of ${stats.length} questions` },
        { icon: 'attempts', text: `${n} completed attempts` },
        { icon: 'alert', text: `Low sample under ${ms}`, color: 'var(--muted)' },
      ]} />
      <div className="row-scroll">
        <div className="search"><Icon name="search" /><input className="ctl" value={qq} onChange={(e) => setQq(e.target.value)} aria-label="Search questions" placeholder="Search questions or Q#" /></div>
        <select className="ctl" value={sort} onChange={(e) => setSort(e.target.value as never)} aria-label="Sort questions" style={{ flex: 'none' }}>
          <option value="error">Highest error rate</option><option value="order">Question order</option>
        </select>
        <select className="ctl" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic" style={{ flex: 'none' }}>
          <option value="all">All topics</option>
          {data.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      {list.length === 0 && <div className="empty">No questions match.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {list.map((s) => {
          const q = data.questions.find((x) => x.n === s.n)!;
          return (
            <article key={s.n} className="card qstat">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <span className="cond" style={{ fontSize: 16 }}>Q{s.n}</span>
                  <span className="small-tag">{topicName(data, s.topic)}</span>
                  {s.responses < ms && <span className="small-tag dashed">Low sample</span>}
                </div>
                <div style={{ fontSize: 15, lineHeight: 1.4 }}>{s.text}</div>
                <div className="qstat-nums">
                  <div><div className="eyebrow">RESPONSES</div><b>{s.responses}</b></div>
                  <div><div className="eyebrow">CORRECT</div><b>{s.correct} <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>{s.pctCorrect}%</span></b></div>
                  <div><div className="eyebrow">INCORRECT</div><b style={{ color: s.pctIncorrect >= PATTERN_RULES.missedPct ? 'var(--bad)' : '#fff' }}>{s.incorrect} <span style={{ fontSize: 13, fontWeight: 500 }}>{s.pctIncorrect}%</span></b></div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                {(['A', 'B', 'C', 'D'] as const).map((k) => {
                  const cnt = s.dist[k];
                  const pct = s.responses ? Math.round((cnt / s.responses) * 100) : 0;
                  const isC = k === s.correctKey;
                  const isTop = s.topWrong?.key === k;
                  const text = (q.options.find((o) => o.key === k)?.text ?? '') + (isC ? '  (correct)' : '');
                  return (
                    <div key={k} className="distrow" title={text}>
                      <span className="cond" style={{ fontSize: 13, color: isC ? 'var(--blue)' : isTop ? 'var(--bad)' : 'var(--muted)' }}>{k}</span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                        <span className="soft" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
                        <Bar pct={pct} color={isC ? 'var(--blue)' : isTop ? 'var(--bad)' : '#666'} />
                      </div>
                      <span className="soft num" style={{ textAlign: 'right', fontSize: 12 }}>{cnt} · {pct}%</span>
                    </div>
                  );
                })}
                {s.unanswered > 0 && <div className="muted" style={{ fontSize: 12 }}>Not answered · {s.unanswered}</div>}
                {s.topWrong && s.topWrong.count > 1 && (
                  <div style={{ fontSize: 12, color: 'var(--bad)', marginTop: 2 }}>Most common wrong answer: {s.topWrong.key} · {s.topWrong.count} of {s.responses} ({s.topWrong.pct}%)</div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

export function Topics({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const ms = data.settings.minSample;
  const n = data.attempts.filter((a) => a.status === 'completed').length;
  const qstats = questionStats(data.questions.filter((q) => q.active), data.attempts);
  const tstats = topicStats(data.topics, qstats).sort((a, b) => a.accuracy - b.accuracy);
  const patterns = findPatterns(qstats, tstats, ms);
  const anyInferred = data.questions.some((q) => q.topicInferred);

  const onExport = () =>
    exportCsv('topics', [
      { label: anyInferred ? 'Topic (inferred)' : 'Topic', get: (t: TopicStat) => t.name },
      { label: 'Questions', get: (t) => t.questions },
      { label: 'Answers', get: (t) => t.answers },
      { label: 'Correct', get: (t) => t.correct },
      { label: 'Incorrect', get: (t) => t.incorrect },
      { label: 'Accuracy %', get: (t) => t.accuracy },
      { label: 'Weakest question', get: (t) => (t.weakest ? 'Q' + t.weakest.n : '') },
      { label: 'Low sample', get: (t) => (t.answers < ms ? 'yes' : 'no') },
    ], tstats);

  return (
    <>
      <PageHead title="TOPICS & GAPS" sub="topic accuracy and observed patterns" ctx={ctx} onExport={onExport} />
      <MetaChips items={[
        { icon: 'topics', text: `${tstats.length} topics${anyInferred ? ' · inferred' : ''}` },
        { icon: 'attempts', text: `n = ${n} attempts` },
        { icon: 'alert', text: `${patterns.length} patterns found`, color: 'var(--bad)' },
      ]} />
      <div className="notice">
        These are observed patterns in {n} submitted attempts, not proof that a training section is ineffective. Topics were assigned from question
        content (inferred) and can be changed in the question bank. Patterns need at least {ms} responses; a question counts as frequently missed at
        {' '}{PATTERN_RULES.missedPct}%+ incorrect, and a topic as low accuracy under {PATTERN_RULES.lowTopicAccuracy}%.
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {tstats.map((t) => (
          <div key={t.id} className="topic-line">
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{t.name}</span>
                {data.questions.some((q) => q.topic === t.id && q.topicInferred) && <span className="muted" style={{ fontSize: 11, border: '1px solid var(--line)', borderRadius: 5, padding: '2px 6px' }}>inferred</span>}
                {t.accuracy < PATTERN_RULES.lowTopicAccuracy && t.answers >= ms && <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', color: 'var(--bad)' }}>LOW ACCURACY</span>}
                {t.answers < ms && <span className="small-tag dashed">Low sample</span>}
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.questions} {t.questions === 1 ? 'question' : 'questions'} · {t.incorrect} incorrect of {t.answers} answers</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}><Bar pct={t.accuracy} height={10} color={t.accuracy < PATTERN_RULES.lowTopicAccuracy ? 'var(--bad)' : 'var(--blue)'} /></div>
              <span className="cond" style={{ width: 48, textAlign: 'right', fontSize: 18 }}>{t.accuracy}%</span>
            </div>
            <div className="soft" style={{ fontSize: 13, lineHeight: 1.4 }}>{t.weakest && t.answers ? <>Weakest: <b>Q{t.weakest.n}</b> · {t.weakest.pctCorrect}% correct</> : 'No responses yet'}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="cond" style={{ fontSize: 14 }}>OBSERVED PATTERNS</span>
        {n < ms && <div className="empty" style={{ alignItems: 'flex-start', textAlign: 'left' }}>Not enough submitted attempts yet. Patterns appear after {ms} completed attempts.</div>}
        {n >= ms && patterns.length === 0 && <div className="empty">No recurring gaps meet the thresholds right now.</div>}
        <div className="patterns">
          {patterns.map((p, i) => (
            <div key={i} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span className="eyebrow" style={{ color: '#fff' }}>{p.kind}</span><span className="muted" style={{ fontSize: 11 }}>{p.n}</span></div>
              <div style={{ fontSize: 15, lineHeight: 1.4, fontWeight: 700 }}>{p.title}</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>{p.detail}</div>
              <span className="muted" style={{ fontSize: 11, marginTop: 'auto' }}>Potential learning gap</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
