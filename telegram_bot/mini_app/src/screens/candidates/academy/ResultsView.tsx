import type { AttemptResult } from '../../../../../../shared/types';
import { ReviewList, TopicRows, topicScores } from '../../shared/review';
import { Accent, fmtDate, useCountUp } from '../../../components/ui';

export function ResultsView({ r, onFinish, finishLabel }: { r: AttemptResult; onFinish: () => void; finishLabel: string }) {
  const wrong = r.total - r.correct - r.unanswered;
  const passPct = Math.round((r.passMark / r.total) * 100);
  const score = useCountUp(r.correct);
  const first = r.name.split(' ')[0]?.toUpperCase() ?? '';
  const topics = topicScores(r.questions, r.answers, r.topics);
  return (
    <div className="fill">
      <header className="top-bar">
        <img src="/assets/cft-primary.svg" alt="CF Transport" />
        <span>{r.name}</span>
      </header>
      <main className="results stagger">
        {r.alreadyCompleted && (
          <div className="notice" role="status">You completed this assessment on {fmtDate(r.submittedAt)}. This is your recorded result.</div>
        )}
        <section className="score-card">
          <img src="/assets/glow-blue.png" alt="" className="glow" />
          <div style={{ position: 'relative' }}>
            <div className="eyebrow">YOUR RESULT</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 12 }} aria-label={`${r.correct} of ${r.total} correct`}>
              <span className="big-score" aria-hidden="true">{score}</span>
              <span className="cond muted" style={{ fontSize: 'clamp(24px,3cqw,32px)' }} aria-hidden="true">/{r.total}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 20 }}>
              <span className="cond" style={{ fontSize: 24 }}>{r.pct}%</span>
              <span className={'badge ' + (r.passed ? 'pass' : 'fail')}>{r.passed ? 'PASSED' : 'BELOW PASS MARK'}</span>
            </div>
            <div style={{ position: 'relative', marginTop: 26, maxWidth: 380, height: 34 }} aria-hidden="true">
              <div className="track" style={{ position: 'absolute', inset: 0 }}>
                <div className="dash" />
                <div className="fillbar" style={{ width: r.pct + '%', animation: 'grow-x 1s .25s var(--ease) backwards', transformOrigin: 'left' }} />
              </div>
              <div style={{ position: 'absolute', left: passPct + '%', top: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'translateX(-50%)', gap: 6 }}>
                <span style={{ width: 2, height: 12, borderRadius: 1, background: 'var(--soft)' }} />
                <span className="muted nowrap" style={{ fontSize: 11 }}>Pass {r.passMark}</span>
              </div>
            </div>
          </div>
          <dl className="dl">
            <dt>Correct</dt><dd>{r.correct}</dd>
            <dt>Incorrect</dt><dd>{wrong}</dd>
            <dt>Not answered</dt><dd>{r.unanswered}</dd>
            <dt>Pass mark</dt><dd>{r.passMark}/{r.total} ({passPct}%)</dd>
            <dt>Submitted</dt><dd>{fmtDate(r.submittedAt)}</dd>
          </dl>
        </section>

        {topics.length > 0 && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <h2 className="h-sec">BY TOPIC<Accent /></h2>
              <p className="muted" style={{ margin: '10px 0 0', fontSize: 14 }}>Topics group the questions for review. They don't change your score.</p>
            </div>
            <TopicRows rows={topics} />
          </section>
        )}

        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ReviewList questions={r.questions} answers={r.answers} title={<h2 className="h-sec">ANSWER REVIEW<Accent /></h2>} />
        </section>

        <section className="thanks">
          <div>
            <b>THANK YOU, {first}</b>
            <span>Your result has been recorded. You can close this page.</span>
          </div>
          <button className="btn btn-dark" onClick={onFinish}>{finishLabel}</button>
        </section>
      </main>
    </div>
  );
}
