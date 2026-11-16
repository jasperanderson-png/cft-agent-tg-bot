import { useState } from 'react';
import type { SheetsStatus } from '../../../../../../shared/types';
import { ApiError, adminApi } from '../../../lib/api';
import { Icon, Modal, Spinner } from '../../../components/ui';
import type { Ctx } from './common';

const ago = (iso: string | null) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'Just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export function SheetsDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const g = ctx.data.sheets;
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'' | 'link' | 'create' | 'sync'>('');

  const run = async (kind: typeof busy, fn: () => Promise<SheetsStatus>, msg: string) => {
    if (busy) return;
    setBusy(kind);
    setErr('');
    try {
      const s = await fn();
      ctx.setData((d) => ({ ...d, sheets: s }));
      if (msg) ctx.toast(msg);
    } catch (e) {
      if ((e as ApiError).status === 401) ctx.onError(e);
      else setErr((e as ApiError).message);
    } finally {
      setBusy('');
    }
  };
  const link = () => {
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/.test(url.trim())) return setErr('Paste a Google Sheets link, e.g. https://docs.google.com/spreadsheets/d/…');
    run('link', () => adminApi.sheetsLink(url.trim()), 'Google Sheets connected');
  };

  return (
    <Modal onClose={onClose} labelledBy="gs-title" sheet={ctx.narrow} style={{ maxWidth: 520, maxHeight: 'min(720px, 90vh)' }}>
      <div className="dialog-head">
        <span className="badge-icon"><Icon name="sheet" size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow">INTEGRATION</div>
          <div id="gs-title" className="cond" style={{ fontSize: 24, lineHeight: 1.1, marginTop: 2 }}>GOOGLE SHEETS</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{g.connected ? (g.autoSync ? 'Connected · auto-sync on' : 'Connected · auto-sync paused') : 'Send every graded attempt to a spreadsheet automatically.'}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="dialog-body">
        {!g.connected && (
          <>
            <button onClick={() => run('create', adminApi.sheetsCreate, 'Results sheet created')} disabled={!!busy} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, borderRadius: 16, border: '1px solid rgba(160,220,255,.35)', background: 'rgba(160,220,255,.08)', color: '#fff', textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ flex: 'none', width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--blue)', color: '#000' }}>{busy === 'create' ? <Spinner size={18} /> : <Icon name="plus" size={18} />}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>Create a new results sheet</span>
                <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>"CFT Agent Academy — Results" with all past attempts, shared with you</span>
              </span>
            </button>
            <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#666' }}><span style={{ flex: 1, height: 1, background: 'var(--line-2)' }} />OR LINK AN EXISTING SHEET<span style={{ flex: 1, height: 1, background: 'var(--line-2)' }} /></div>
            <div className="field">
              <label htmlFor="gs-url" className="eyebrow">SHEET URL</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input id="gs-url" className="ctl" style={{ flex: 1, minWidth: 0, borderColor: err ? 'var(--bad)' : undefined }} value={url} onChange={(e) => { setUrl(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && link()} placeholder="https://docs.google.com/spreadsheets/d/…" inputMode="url" />
                <button className="pill pill-primary" style={{ height: 44 }} onClick={link} disabled={!!busy}>{busy === 'link' && <Spinner size={14} />}{busy === 'link' ? 'Linking…' : 'Link'}</button>
              </div>
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>Share the sheet with <b style={{ color: 'var(--soft)', wordBreak: 'break-all' }}>{g.serviceAccountEmail}</b> as an Editor so it can write rows.</span>
            </div>
          </>
        )}
        {err && <span role="alert" className="err" style={{ fontSize: 13 }}>{err}</span>}
        {g.connected && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, borderRadius: 16, border: '1px solid rgba(160,220,255,.3)', background: 'rgba(160,220,255,.06)' }}>
              <span style={{ flex: 'none', width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'rgba(160,220,255,.14)', color: 'var(--blue)' }}><Icon name="sheet" size={18} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</span>
                <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.url}</span>
              </span>
              {g.url && <a className="pill pill-primary" style={{ height: 36 }} href={g.url} target="_blank" rel="noopener noreferrer">Open<Icon name="ext" size={12} /></a>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ padding: 14, borderRadius: 14, border: '1px solid var(--line-2)', background: 'rgba(255,255,255,.03)' }}><div className="eyebrow">ROWS SYNCED</div><div className="cond" style={{ fontSize: 24, marginTop: 4 }}>{g.rowsSynced}</div></div>
              <div style={{ padding: 14, borderRadius: 14, border: '1px solid var(--line-2)', background: 'rgba(255,255,255,.03)' }}><div className="eyebrow">LAST SYNC</div><div style={{ fontSize: 15, marginTop: 8 }}>{ago(g.lastSyncAt)}</div></div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, border: '1px solid var(--line-2)' }}>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontSize: 14 }}>Auto-sync new submissions</span>
                <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>Each graded attempt is added as a new row within seconds.</span>
              </span>
              <button role="switch" aria-checked={g.autoSync} aria-label="Auto-sync" className="switch" onClick={() => run('', () => adminApi.sheetsAuto(!g.autoSync), '')}><i /></button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button className="pill" onClick={() => run('sync', adminApi.sheetsSync, 'Synced to Google Sheets')} disabled={!!busy}>
                <Icon name="sync" size={14} className={busy === 'sync' ? 'spin' : ''} style={{ color: 'var(--blue)' }} />{busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
              <button className="pill" style={{ border: 0, background: 'transparent', color: 'var(--bad)' }} onClick={() => run('', adminApi.sheetsDisconnect, 'Sheet disconnected')}>Disconnect</button>
            </div>
          </>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="eyebrow">COLUMNS WRITTEN</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['Candidate', 'Attempt ID', 'Started', 'Submitted', 'Score', 'Percentage', 'Result', 'Duration', `Q1–Q${ctx.data.questions.length} answers`].map((c) => (
              <span key={c} className="soft" style={{ height: 26, padding: '0 10px', display: 'inline-flex', alignItems: 'center', borderRadius: 999, border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)', fontSize: 12 }}>{c}</span>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
