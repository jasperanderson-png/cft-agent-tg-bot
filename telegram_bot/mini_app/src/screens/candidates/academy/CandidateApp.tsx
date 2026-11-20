import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttemptResult, AttemptState, InProgressAttempt, PublicConfig } from '../../../../../../support/common/types';
import { ApiError, candidateApi } from '../../../lib/api';
import { initData, signedIn, tg } from '../../../lib/telegram';
import { Instructions } from './Instructions';
import { ResultsView } from './ResultsView';
import { clearBackup, TestView } from './TestView';
import { Welcome } from './Welcome';

type View =
  | { k: 'loading' }
  | { k: 'fatal'; msg: string; retry: boolean }
  | { k: 'welcome' }
  | { k: 'instructions' }
  | { k: 'test'; a: InProgressAttempt }
  | { k: 'results'; r: AttemptResult };

const STORE = 'cft_attempt';
const remember = (id: string, token: string) => {
  try {
    localStorage.setItem(STORE, JSON.stringify({ id, token }));
  } catch {
    /* storage blocked: resume via Telegram still works */
  }
};
const recall = (): { id: string; token: string } | null => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? 'null');
  } catch {
    return null;
  }
};
const forget = () => {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
};

export function CandidateApp({ scrollTop }: { scrollTop: () => void }) {
  const [view, setView] = useState<View>({ k: 'loading' });
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [name, setName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startErr, setStartErr] = useState('');
  const token = useRef('');

  const go = useCallback((v: View) => {
    setView(v);
    scrollTop();
  }, [scrollTop]);

  const show = useCallback((s: AttemptState & { token?: string }) => {
    if (s.token) {
      token.current = s.token;
      remember(s.attemptId, s.token);
    }
    setName(s.name);
    go(s.state === 'completed' ? { k: 'results', r: s } : { k: 'test', a: s });
  }, [go]);

  const load = useCallback(async () => {
    setView({ k: 'loading' });
    try {
      setConfig(await candidateApi.config());
      if (signedIn) {
        const s = await candidateApi.session(initData);
        if (s.state === 'none') {
          setName(s.suggestedName);
          setIsAdmin(s.isAdmin);
          return go({ k: 'welcome' });
        }
        return show(s);
      }
      const saved = recall();
      if (saved) {
        try {
          token.current = saved.token;
          return show(await candidateApi.get(saved.id, saved.token));
        } catch (e) {
          if ((e as ApiError).status !== 404) throw e;
          forget();
        }
      }
      go({ k: 'welcome' });
    } catch (e) {
      const err = e as ApiError;
      setView({ k: 'fatal', msg: ['telegram_auth', 'driver_request', 'academy_moved'].includes(err.code ?? '') ? err.message : err.isNetwork ? err.message : `Couldn't load the assessment. ${err.message}`, retry: !['telegram_auth', 'driver_request', 'academy_moved'].includes(err.code ?? '') });
    }
  }, [go, show]);

  useEffect(() => {
    load();
  }, [load]);

  const begin = async () => {
    setBusy(true);
    setStartErr('');
    try {
      show(await candidateApi.start(name, initData));
    } catch (e) {
      setStartErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const lost = useCallback((msg: string) => {
    forget();
    setView({ k: 'fatal', msg, retry: true });
  }, []);

  if (view.k === 'loading' || !config) {
    return view.k === 'fatal' ? <Fatal msg={view.msg} retry={view.retry ? load : null} /> : <div className="center-msg">Loading assessment…</div>;
  }
  switch (view.k) {
    case 'fatal':
      return <Fatal msg={view.msg} retry={view.retry ? load : null} />;
    case 'welcome':
      return <Welcome config={config} initialName={name} isAdmin={isAdmin} onContinue={(n) => { setName(n); setStartErr(''); go({ k: 'instructions' }); }} />;
    case 'instructions':
      return <Instructions config={config} name={name} busy={busy} error={startErr} onBack={() => go({ k: 'welcome' })} onBegin={begin} />;
    case 'test':
      return <TestView attempt={view.a} token={token.current} passMark={config.passMark} onLost={lost} onDone={(r) => go({ k: 'results', r })} />;
    case 'results':
      return (
        <ResultsView
          r={view.r}
          finishLabel={tg ? 'Close' : 'Finish'}
          onFinish={() => {
            if (tg) return tg.close();
            clearBackup(view.r.attemptId);
            forget();
            setName('');
            go({ k: 'welcome' });
          }}
        />
      );
  }
}

function Fatal({ msg, retry }: { msg: string; retry: (() => void) | null }) {
  return (
    <div className="center-msg">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, maxWidth: 420 }}>
        <img src="/assets/cft-favicon.svg" alt="" style={{ height: 40 }} />
        <p role="alert" style={{ margin: 0, color: '#fff', fontSize: 16, lineHeight: 1.5 }}>{msg}</p>
        {retry && <button className="btn btn-primary" onClick={retry}>Try again</button>}
      </div>
    </div>
  );
}
