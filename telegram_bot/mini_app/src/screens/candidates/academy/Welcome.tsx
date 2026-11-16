import { useState } from 'react';
import type { PublicConfig } from '../../../../../../shared/types';
import { nameError, normalizeName } from '../../../../../../shared/validation';
import { tg } from '../../../lib/telegram';
import { Accent, Lines } from '../../../components/ui';

export function Welcome({ config, initialName, onContinue, isAdmin }: {
  config: PublicConfig;
  initialName: string;
  onContinue: (name: string) => void;
  isAdmin: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [err, setErr] = useState('');
  const blocked = config.requireTelegram && !tg;
  const passPct = Math.round((config.passMark / config.total) * 100);

  const submit = () => {
    const n = normalizeName(name);
    const e = nameError(n);
    if (e) return setErr(e);
    setName(n);
    onContinue(n);
  };

  return (
    <div className="fill" style={{ overflow: 'hidden' }}>
      <img src="/assets/glow-blue.png" alt="" className="hero-glow" />
      <Lines />
      <header className="top-bar">
        <img src="/assets/cft-primary.svg" alt="CF Transport" />
        <span>Sales Agent assessment</span>
      </header>
      <main className="hero-main">
        <div className="hero-grid stagger">
          <div>
            <h1 className="h-hero">
              <span style={{ color: 'var(--blue)' }}>CFT</span>
              <br />
              AGENT
              <br />
              <span className="nowrap">ACADEMY<Accent /></span>
            </h1>
            <p className="hero-lede">A {config.total}-question knowledge test for Sales Agent candidates. It covers trucking basics, compliance terms and the CFT fuel-card offer.</p>
          </div>
          <div className="form-card">
            <h2>START YOUR TEST</h2>
            {blocked ? (
              <>
                <p className="soft" style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>
                  This assessment runs inside Telegram so your result is linked to you. Open it from the CFT bot to begin.
                </p>
                {config.botUsername && (
                  <a className="btn btn-primary" href={`https://t.me/${config.botUsername}?startapp&mode=fullscreen`}>
                    Open @{config.botUsername}
                  </a>
                )}
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="cand-name" className="label">FULL NAME</label>
                  <input
                    id="cand-name"
                    className={'input' + (err ? ' invalid' : '')}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setErr('');
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                    autoComplete="name"
                    autoCapitalize="words"
                    enterKeyHint="next"
                    maxLength={100}
                    placeholder="First and last name"
                    aria-invalid={!!err}
                    aria-describedby={err ? 'name-err' : undefined}
                  />
                  {err && <div id="name-err" role="alert" className="err">{err}</div>}
                </div>
                <button className="btn btn-primary" onClick={submit}>Continue</button>
                <p className="fine">No account needed. We only ask for your name so your result can be recorded.</p>
              </>
            )}
            <div className="stat-split">
              <div><b>{config.total}</b><span>questions, multiple choice</span></div>
              <div><b>{config.passMark}/{config.total}</b><span>to pass ({passPct}%)</span></div>
            </div>
            {isAdmin && <a href="#/admin" className="fine" style={{ color: 'var(--blue)' }}>Open admin console →</a>}
          </div>
        </div>
      </main>
    </div>
  );
}
