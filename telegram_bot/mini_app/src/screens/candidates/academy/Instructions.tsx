import type { PublicConfig } from '../../../../../../support/common/types';
import { useBackButton } from '../../../lib/telegram';
import { Accent, Spinner } from '../../../components/ui';

export function Instructions({ config, name, busy, error, onBack, onBegin }: {
  config: PublicConfig;
  name: string;
  busy: boolean;
  error: string;
  onBack: () => void;
  onBegin: () => void;
}) {
  useBackButton(busy ? null : onBack);
  const first = name.split(' ')[0]?.toUpperCase() ?? '';
  const passPct = Math.round((config.passMark / config.total) * 100);
  const steps = [
    'Choose one answer (A, B, C, or D) for each question.',
    'All questions are on one page. You can change any answer until you submit.',
    'Answer every question. Unanswered questions are scored as incorrect.',
    config.allowRetakes ? 'When you finish, submit the test.' : 'When you finish, submit the test. You get one attempt.',
    'Your score, the correct answers and explanations appear after you submit.',
  ];
  return (
    <div className="fill">
      <header className="top-bar">
        <img src="/assets/cft-primary.svg" alt="CF Transport" />
        <span>{name}</span>
      </header>
      <main className="page stagger">
        <div className="kicker"><b>INSTRUCTIONS</b><span>before you begin</span></div>
        <h1 className="h-page">HI, {first}<Accent /></h1>
        <div className="tiles">
          <div className="tile"><b>{config.total}</b><span>questions</span></div>
          <div className="tile"><b>1</b><span>point each</span></div>
          <div className="tile"><b style={{ color: 'var(--blue)' }}>{config.passMark}/{config.total}</b><span>passing score ({passPct}%)</span></div>
          <div className="tile"><b>None</b><span>time limit set</span></div>
        </div>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i}><b>{String(i + 1).padStart(2, '0')}</b><span>{s}</span></li>
          ))}
        </ol>
        {error && (
          <div role="alert" className="alert"><svg viewBox="0 0 24 24" className="icon"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>{error}</div>
        )}
        <div className="actions">
          <button className="btn btn-outline" onClick={onBack} disabled={busy}>Back</button>
          <button className="btn btn-primary" onClick={onBegin} disabled={busy} aria-busy={busy}>
            {busy && <Spinner />}
            {busy ? 'Preparing…' : error ? 'Try again' : 'Start test'}
          </button>
        </div>
      </main>
    </div>
  );
}
