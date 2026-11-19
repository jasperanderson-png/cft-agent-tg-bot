import { useCallback, useEffect, useRef, useState } from 'react';
import type { Answers, AttemptResult, InProgressAttempt, OptionKey } from '../../../../../../support/common/types';
import { ApiError, candidateApi } from '../../../lib/api';
import { haptic, useClosingConfirmation } from '../../../lib/telegram';
import { Icon, Modal, Spinner, useWidth } from '../../../components/ui';

type SaveState = 'idle' | 'saving' | 'saved' | 'offline';
const backupKey = (id: string) => 'cft_answers_' + id;

export function readBackup(id: string): Answers {
  try {
    return JSON.parse(localStorage.getItem(backupKey(id)) ?? '{}');
  } catch {
    return {};
  }
}
export function clearBackup(id: string) {
  try {
    localStorage.removeItem(backupKey(id));
  } catch {
    /* ignore */
  }
}

export function TestView({ attempt, token, passMark, onDone, onLost }: {
  attempt: InProgressAttempt;
  token: string;
  passMark: number;
  onDone: (r: AttemptResult) => void;
  onLost: (msg: string) => void;
}) {
  const qs = attempt.questions;
  const total = qs.length;
  const [answers, setAnswers] = useState<Answers>(() => ({ ...attempt.answers, ...readBackup(attempt.attemptId) }));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState('');
  const [showMissing, setShowMissing] = useState(false);
  const w = useWidth();
  const narrow = w < 760;
  const withAside = w >= 1000;

  const answered = qs.filter((q) => answers[q.n]).length;
  const unanswered = qs.filter((q) => !answers[q.n]);
  useClosingConfirmation(answered > 0 && !submitting);

  // Autosave: local backup immediately, server copy debounced; retry when back online.
  // Answers restored from this device's backup that the server hasn't seen yet still need saving.
  const dirty = useRef(Object.entries(readBackup(attempt.attemptId)).some(([n, k]) => attempt.answers[Number(n)] !== k));
  const latest = useRef(answers);
  latest.current = answers;
  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setSaveState('saving');
    try {
      await candidateApi.save(attempt.attemptId, token, latest.current as Record<number, string>);
      setSaveState(dirty.current ? 'saving' : 'saved');
    } catch (e) {
      dirty.current = true;
      if (e instanceof ApiError && e.code === 'already_submitted') return;
      if (e instanceof ApiError && e.code === 'attempt_not_found') return onLost('This test session is no longer valid. It may have been opened on another device.');
      setSaveState('offline');
    }
  }, [attempt.attemptId, token, onLost]);

  useEffect(() => {
    try {
      localStorage.setItem(backupKey(attempt.attemptId), JSON.stringify(answers));
    } catch {
      /* storage full or blocked */
    }
  }, [answers, attempt.attemptId]);

  useEffect(() => {
    if (!dirty.current) return;
    const t = window.setTimeout(save, saveState === 'offline' ? 5000 : 700);
    return () => window.clearTimeout(t);
  }, [answers, save, saveState]);

  useEffect(() => {
    const on = () => save();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [save]);

  const pick = (n: number, k: OptionKey) => {
    if (submitting) return;
    if (answers[n] !== k) haptic.select();
    dirty.current = true;
    setAnswers((a) => ({ ...a, [n]: k }));
  };

  const jump = (n: number) => document.getElementById('q-' + n)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitErr('');
    try {
      const r = await candidateApi.submit(attempt.attemptId, token, answers as Record<number, string>);
      haptic.success();
      clearBackup(attempt.attemptId);
      onDone(r);
    } catch (e) {
      haptic.error();
      const err = e as ApiError;
      if (err.code === 'attempt_not_found') return onLost('This test session is no longer valid. It may have been opened on another device.');
      setSubmitErr(
        err.isNetwork
          ? "We couldn't reach the server, so your test was not submitted. Your answers are still on this page. Check your connection and try again."
          : err.message,
      );
      setSubmitting(false);
    }
  };

  const closeConfirm = () => {
    if (submitting) return;
    setConfirm(false);
    if (unanswered.length) setShowMissing(true);
  };

  const pctW = (answered / total) * 100 + '%';
  const passW = Math.round((passMark / total) * 100) + '%';
  const chip = (n: number, extra = '') => {
    const a = !!answers[n];
    return (
      <button key={n} className={'qchip' + (a ? ' on' : !a && showMissing ? ' miss' : '') + extra} onClick={() => jump(n)} aria-label={`Question ${n}, ${a ? 'answered' : 'unanswered'}`}>
        {n}
      </button>
    );
  };
  const saveLabel =
    saveState === 'saving' ? <><Spinner size={12} />Saving…</> :
    saveState === 'saved' ? <><Icon name="tick" size={12} />Saved</> :
    saveState === 'offline' ? <><Icon name="cloudoff" size={12} />Offline — answers kept on this device</> : null;

  return (
    <div className="fill">
      <header className="test-head">
        <div className="test-head-row">
          <div className="brand-mini">
            <img src="/assets/cft-favicon.svg" alt="CF Transport" />
            <div style={{ minWidth: 0, lineHeight: 1.15 }}>
              <b>AGENT ACADEMY</b>
              <span>{attempt.name}</span>
            </div>
          </div>
          <div className="progress">
            <div className="progress-top"><span className="soft">{answered} of {total} answered</span><span className="muted">{Math.round((answered / total) * 100)}%</span></div>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={answered} aria-label="Questions answered" className="track">
              <div className="dash" />
              <div className="fillbar" style={{ width: pctW }} />
              <div className="tick" title="Pass mark" style={{ left: passW }} />
              <div className="knob" style={{ left: pctW }} />
            </div>
          </div>
          {!narrow && <button className="btn btn-primary" style={{ flex: 'none', height: 44, padding: '0 20px', fontSize: 13 }} onClick={() => setConfirm(true)}>Submit test</button>}
        </div>
        {narrow && <div className="chips">{qs.map((q) => chip(q.n))}</div>}
      </header>

      <div className="test-body">
        <div className="qlist">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 4px' }}>
            <p className="muted" style={{ margin: 0, fontSize: 15 }}>Choose one answer for each question. You can change answers until you submit.</p>
            <span className={'save-state' + (saveState === 'offline' ? ' bad' : '')} aria-live="polite">{saveLabel}</span>
          </div>
          {qs.map((q, i) => {
            const sel = answers[q.n];
            const miss = !sel && showMissing;
            return (
              <section key={q.n} id={'q-' + q.n} aria-labelledby={'qh-' + q.n} className={'qcard' + (miss ? ' miss' : '')}>
                <div className="qcard-top">
                  <span className="eyebrow nowrap">QUESTION {i + 1} OF {total}</span>
                  <span style={{ color: sel ? 'var(--blue)' : 'var(--bad)' }}>{sel ? 'Answered' : miss ? 'Not answered' : ''}</span>
                </div>
                <h3 id={'qh-' + q.n}>{q.text}</h3>
                <div role="radiogroup" aria-labelledby={'qh-' + q.n} className="opts">
                  {q.options.map((o) => (
                    <button key={o.key} role="radio" aria-checked={sel === o.key} className={'opt' + (sel === o.key ? ' on' : '')} onClick={() => pick(q.n, o.key)}>
                      <span className="key">{o.key}</span>
                      <span>{o.text}</span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          <div className="end-card">
            <div>
              <div className="cond" style={{ fontSize: 18 }}>{answered} OF {total} ANSWERED</div>
              <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                {unanswered.length ? `${unanswered.length} still unanswered. Unanswered questions count as incorrect.` : 'All questions answered. Review anything you like, then submit.'}
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => setConfirm(true)}>Submit test</button>
          </div>
        </div>
        {withAside && (
          <aside className="aside" aria-label="Question navigator">
            <div className="eyebrow">QUESTIONS</div>
            <div className="aside-grid">{qs.map((q) => chip(q.n))}</div>
            <div className="legend">
              <span><i className="sw" style={{ background: 'var(--blue)' }} />Answered · {answered}</span>
              <span><i className="sw" style={{ border: '1px solid #666' }} />Unanswered · {unanswered.length}</span>
            </div>
          </aside>
        )}
      </div>

      {narrow && (
        <div className="bottom-bar">
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setConfirm(true)}>Submit test · {answered}/{total}</button>
        </div>
      )}

      {confirm && (
        <Modal onClose={closeConfirm} labelledBy="cf-title" className="dialog-solid">
          <h2 id="cf-title" className="cond" style={{ margin: 0, fontSize: 28, lineHeight: 0.95 }}>SUBMIT YOUR TEST?</h2>
          <p className="soft" style={{ margin: 0, fontSize: 16, lineHeight: 1.5 }}>
            You answered {answered} of {total} questions. After you submit, you can't change your answers.
          </p>
          {unanswered.length > 0 && (
            <div style={{ border: '1px solid var(--bad)', borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--bad)' }}>{unanswered.length} unanswered. These will be scored as incorrect.</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {unanswered.map((q) => (
                  <button
                    key={q.n}
                    className="qchip miss"
                    style={{ minWidth: 40, width: 'auto', padding: '0 8px' }}
                    aria-label={'Go to question ' + q.n}
                    disabled={submitting}
                    onClick={() => {
                      setConfirm(false);
                      setShowMissing(true);
                      setTimeout(() => jump(q.n), 50);
                    }}
                  >
                    {q.n}
                  </button>
                ))}
              </div>
            </div>
          )}
          {submitErr && (
            <div role="alert" className="alert"><Icon name="info" />{submitErr}</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={closeConfirm} disabled={submitting} style={{ fontSize: 13, padding: '0 20px' }}>Keep reviewing</button>
            <button className="btn btn-primary" onClick={submit} disabled={submitting} aria-busy={submitting} style={{ fontSize: 13 }}>
              {submitting && <Spinner />}
              {submitting ? 'Grading…' : submitErr ? 'Try again' : 'Submit test'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
