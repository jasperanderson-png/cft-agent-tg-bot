import { useState } from 'react';
import { ApiError, adminApi } from '../../../lib/api';
import { Accent, Lines, Spinner } from '../../../components/ui';

export function Login({ onSignedIn, notice }: { onSignedIn: (token: string, email: string) => void; notice: string }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr('Enter a valid email address.');
    if (!pw) return setErr('Enter your password.');
    setBusy(true);
    setErr('');
    try {
      const s = await adminApi.login(email.trim(), pw);
      setPw('');
      onSignedIn(s.token, s.email);
    } catch (e) {
      setErr((e as ApiError).message);
      setBusy(false);
    }
  };
  const onKey = (e: React.KeyboardEvent) => e.key === 'Enter' && signIn();

  return (
    <div className="fill" style={{ overflow: 'hidden' }}>
      <img src="/assets/glow-blue.png" alt="" className="hero-glow" />
      <Lines />
      <header className="top-bar">
        <img src="/assets/cft-primary.svg" alt="CF Transport" />
        <span>Admin console</span>
      </header>
      <main className="hero-main">
        <div className="hero-grid stagger">
          <div>
            <h1 className="h-hero">AGENT<br />ACADEMY<br /><span className="nowrap" style={{ color: 'var(--blue)' }}>ADMIN<Accent /></span></h1>
            <p className="hero-lede">Review candidate results, spot recurring knowledge gaps and manage the question bank.</p>
          </div>
          <form className="form-card" onSubmit={(e) => { e.preventDefault(); signIn(); }}>
            <h2>SIGN IN</h2>
            {notice && <div role="status" className="notice" style={{ fontSize: 13 }}>{notice}</div>}
            <div className="field">
              <label htmlFor="adm-email" className="label">EMAIL</label>
              <input id="adm-email" className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setErr(''); }} onKeyDown={onKey} autoComplete="username" inputMode="email" placeholder="you@company.com" style={{ borderColor: 'rgba(255,255,255,.18)' }} />
            </div>
            <div className="field">
              <label htmlFor="adm-pw" className="label">PASSWORD</label>
              <input id="adm-pw" className="input" type="password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(''); }} onKeyDown={onKey} autoComplete="current-password" placeholder="••••••••" style={{ borderColor: 'rgba(255,255,255,.18)' }} />
            </div>
            {err && <div role="alert" className="err">{err}</div>}
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{busy && <Spinner />}{busy ? 'Signing in…' : 'Sign in'}</button>
            <p className="fine">Admin access only. Candidates take the test without an account.</p>
            <a href="#/" className="fine" style={{ color: 'var(--blue)' }}>← Candidate assessment</a>
          </form>
        </div>
      </main>
    </div>
  );
}
