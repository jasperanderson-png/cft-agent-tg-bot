import { useState, type ReactNode } from 'react';
import type { AdminAttempt, AdminData } from '../../../../../../support/common/types';
import { isPass } from '../../../../../../support/common/analytics';
import { Accent, Icon, Spinner, type IconName } from '../../../components/ui';

export type Page = 'overview' | 'attempts' | 'attempt' | 'questions' | 'topics' | 'reports' | 'users' | 'bank' | 'settings';
export type SortKey = 'name' | 'date' | 'score' | 'pct' | 'correct' | 'incorrect' | 'result' | 'status';
export interface AttemptFilters {
  q: string;
  st: 'all' | 'completed' | 'in_progress';
  rs: 'all' | 'pass' | 'below';
  sk: SortKey;
  sd: 'asc' | 'desc';
}
export const FILTERS0: AttemptFilters = { q: '', st: 'all', rs: 'all', sk: 'date', sd: 'desc' };

export interface Ctx {
  data: AdminData;
  setData: (f: (d: AdminData) => AdminData) => void;
  w: number;
  narrow: boolean;
  go: (p: Page, f?: Partial<AttemptFilters>) => void;
  openAttempt: (id: string) => void;
  toast: (m: string) => void;
  openSheets: () => void;
  onError: (e: unknown) => void;
  filters: AttemptFilters;
  setFilters: (f: Partial<AttemptFilters>) => void;
}

export const topicName = (d: AdminData, id: string) => d.topics.find((t) => t.id === id)?.name ?? id;
export const activeTotal = (d: AdminData) => d.questions.filter((q) => q.active).length;

export function statusChip(a: AdminAttempt) {
  return a.status === 'completed' ? <span className="chip chip-done">COMPLETED</span> : <span className="chip chip-open">IN PROGRESS</span>;
}
export function resultOf(a: AdminAttempt, passMark: number) {
  if (a.status !== 'completed') return { label: '—', long: '', color: 'var(--muted)' };
  return isPass(a, passMark) ? { label: 'PASS', long: 'PASS', color: 'var(--blue)' } : { label: 'BELOW', long: 'BELOW PASS MARK', color: 'var(--bad)' };
}

export function MetaChips({ items }: { items: { icon: IconName; text: string; color?: string }[] }) {
  return (
    <div className="row-scroll" style={{ marginTop: -6 }}>
      {items.map((m) => (
        <span key={m.text} className="meta-chip"><Icon name={m.icon} style={{ color: m.color ?? 'var(--blue)' }} />{m.text}</span>
      ))}
    </div>
  );
}

export function PageHead({ title, sub, ctx, onExport }: { title: string; sub: string; ctx: Ctx; onExport?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const s = ctx.data.sheets;
  const exp = async () => {
    if (!onExport || busy) return;
    setBusy(true);
    try {
      await onExport();
      ctx.toast('Exported CSV');
    } catch (e) {
      ctx.onError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page-head">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <h1>{title}<Accent /></h1>
        <span className="muted" style={{ fontSize: 14 }}>{sub}</span>
      </div>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        {s.configured && (
          <button className="pill" onClick={ctx.openSheets} aria-haspopup="dialog" aria-label={s.connected ? 'Google Sheets connected, manage' : 'Connect Google Sheets'} style={s.connected ? { borderColor: 'rgba(160,220,255,.4)', background: 'rgba(160,220,255,.08)', padding: ctx.narrow ? '0 12px' : undefined } : { padding: ctx.narrow ? '0 12px' : undefined }}>
            <span style={{ position: 'relative', display: 'grid' }}>
              <Icon name="sheet" style={{ color: 'var(--blue)' }} />
              {s.connected && <span style={{ position: 'absolute', right: -3, bottom: -3, width: 8, height: 8, borderRadius: '50%', background: 'var(--blue)', boxShadow: '0 0 0 2px #000' }} />}
            </span>
            {!ctx.narrow && <span>{s.connected ? 'Sheets · synced' : 'Connect Sheets'}</span>}
          </button>
        )}
        {onExport && (
          <button className="pill" onClick={exp} disabled={busy} aria-label="Export CSV">
            {busy ? <Spinner /> : <Icon name="download" />}
            {ctx.narrow ? 'CSV' : 'Export CSV'}
          </button>
        )}
      </div>
    </div>
  );
}

export function Section({ title, action, children, className = '', gap = 14 }: { title: string; action?: ReactNode; children: ReactNode; className?: string; gap?: number }) {
  return (
    <div className={'card card-pad ' + className} style={{ display: 'flex', flexDirection: 'column', gap }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span className="cond" style={{ fontSize: 14 }}>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}
