import { useCallback, useEffect, useState } from 'react';
import type { AdminUser } from '../../../../../../shared/types';
import { ApiError, adminApi } from '../../../lib/api';
import { Icon, Modal, Spinner, fmtDate } from '../../../components/ui';
import { MetaChips, PageHead, type Ctx } from './common';

export function Users({ ctx }: { ctx: Ctx }) {
  const me = ctx.data.me;
  const isOwner = me?.role === 'owner';
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'all' | 'admins' | 'candidates'>('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<AdminUser | null>(null);
  const { onError, toast } = ctx;

  const load = useCallback(async () => {
    try {
      setUsers(await adminApi.users());
      setErr('');
    } catch (e) {
      if ((e as ApiError).status === 401) onError(e);
      else setErr((e as ApiError).message);
    }
  }, [onError]);
  useEffect(() => {
    load();
  }, [load]);

  const promote = async (u: AdminUser) => {
    setBusy(String(u.telegramUserId));
    try {
      await adminApi.addAdmin(String(u.telegramUserId), u.name ?? '');
      toast(`${u.name ?? u.telegramUserId} is now an admin`);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  };
  const demote = async (u: AdminUser) => {
    setConfirm(null);
    setBusy(String(u.telegramUserId));
    try {
      await adminApi.removeAdmin(u.admin!.id);
      toast('Admin access removed');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  };

  const term = q.trim().toLowerCase().replace(/^@/, '');
  const list = (users ?? []).filter(
    (u) =>
      (tab === 'all' || (tab === 'admins' ? !!u.admin : u.attempts > 0)) &&
      (!term || [u.name, u.username, u.candidateName, String(u.telegramUserId)].some((x) => x?.toLowerCase().includes(term))),
  );
  const admins = (users ?? []).filter((u) => u.admin).length;
  const candidates = (users ?? []).filter((u) => u.attempts > 0).length;

  return (
    <>
      <PageHead title="USERS" sub="everyone who opened the bot · admin access" ctx={ctx} />
      <MetaChips items={[
        { icon: 'users', text: `${users?.length ?? 0} users` },
        { icon: 'attempts', text: `${candidates} took the test` },
        { icon: 'shield', text: `${admins} admins` },
      ]} />
      <div className="row-scroll" style={{ alignItems: 'center' }}>
        <div role="tablist" className="tabs" style={{ flex: 'none' }}>
          <button role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')}>All</button>
          <button role="tab" aria-selected={tab === 'candidates'} onClick={() => setTab('candidates')}>Candidates</button>
          <button role="tab" aria-selected={tab === 'admins'} onClick={() => setTab('admins')}>Admins</button>
        </div>
        <div className="search">
          <Icon name="search" />
          <input className="ctl" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" placeholder="Name, @username or Telegram ID" />
        </div>
        <button className="pill pill-primary" style={{ height: 44 }} onClick={() => setAdding(true)}><Icon name="plus" />Add admin</button>
      </div>
      {err && <div role="alert" className="alert"><Icon name="info" />{err}</div>}
      {!users && !err && <div className="center-msg" style={{ height: 160 }}><Spinner size={20} /></div>}
      {users && list.length === 0 && (
        <div className="empty">{users.length ? 'No users match.' : 'Nobody has opened the bot yet. Users appear here after they press Start or open the app.'}</div>
      )}
      <div className="card" style={{ overflow: 'hidden', display: list.length ? undefined : 'none' }}>
        {list.map((u) => {
          const l = u.latest;
          const working = busy === String(u.telegramUserId);
          return (
            <div key={u.telegramUserId} className="user-row">
              <div className="user-ava">{(u.name ?? '?').split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase()}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{u.name ?? 'Unknown'}</span>
                  {u.admin && <span className={'chip ' + (u.admin.role === 'owner' ? 'chip-pass' : 'chip-done')}>{u.admin.role === 'owner' ? 'OWNER' : 'ADMIN'}</span>}
                  {u.blockedBot && <span className="chip chip-bad">BLOCKED BOT</span>}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                  {u.username ? `@${u.username} · ` : ''}ID {u.telegramUserId}
                  {u.candidateName && u.candidateName !== u.name ? ` · test name: ${u.candidateName}` : ''}
                  {u.lastSeenAt ? ` · last seen ${fmtDate(u.lastSeenAt)}` : ''}
                </div>
                {u.admin && !u.startedBot && <div style={{ fontSize: 12, marginTop: 3, color: 'var(--bad)' }}>Hasn't pressed Start in the bot yet, so can't receive notifications.</div>}
              </div>
              <div className="user-status">
                {l ? (
                  l.status === 'completed' ? (
                    <button className="link-btn" style={{ textDecoration: 'none', textAlign: 'right' }} onClick={() => ctx.openAttempt(l.id)}>
                      <span className="cond" style={{ fontSize: 16, color: l.passed ? 'var(--blue)' : 'var(--bad)' }}>{l.correct}/{l.total} · {l.passed ? 'PASS' : 'FAIL'}</span>
                      <span className="muted" style={{ display: 'block', fontSize: 11 }}>{fmtDate(l.at)}{u.attempts > 1 ? ` · ${u.attempts} attempts` : ''}</span>
                    </button>
                  ) : (
                    <span className="chip chip-open">IN PROGRESS</span>
                  )
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>{u.admin ? '' : 'No test yet'}</span>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                {!u.admin && (
                  <button className="pill" style={{ height: 34, fontSize: 12 }} disabled={working} onClick={() => promote(u)}>{working ? <Spinner size={12} /> : <Icon name="shield" size={14} />}Make admin</button>
                )}
                {u.admin && u.admin.role === 'admin' && isOwner && u.admin.id !== me?.id && (
                  <button className="pill" style={{ height: 34, fontSize: 12, color: 'var(--bad)', background: 'transparent' }} disabled={working} onClick={() => setConfirm(u)}>{working && <Spinner size={12} />}Remove admin</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {adding && <AddAdmin ctx={ctx} onClose={() => setAdding(false)} onAdded={load} />}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} labelledBy="rm-title" className="dialog-solid">
          <h2 id="rm-title" className="cond" style={{ margin: 0, fontSize: 26 }}>REMOVE ADMIN?</h2>
          <p className="soft" style={{ margin: 0, lineHeight: 1.5 }}>{confirm.name ?? confirm.telegramUserId} will lose access to the admin console and stop receiving notifications. Their past actions stay in the audit log.</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-primary" style={{ background: 'var(--bad)' }} onClick={() => demote(confirm)}>Remove</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function AddAdmin({ ctx, onClose, onAdded }: { ctx: Ctx; onClose: () => void; onAdded: () => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!/^\d{3,15}$/.test(id.trim())) return setErr('Enter the numeric Telegram user ID, e.g. 123456789.');
    setBusy(true);
    setErr('');
    try {
      await adminApi.addAdmin(id.trim(), name.trim());
      ctx.toast('Admin added');
      onAdded();
      onClose();
    } catch (e) {
      if ((e as ApiError).status === 401) ctx.onError(e);
      else setErr((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} labelledBy="add-title" className="dialog-solid" sheet={ctx.narrow}>
      <h2 id="add-title" className="cond" style={{ margin: 0, fontSize: 26 }}>ADD ADMIN</h2>
      <p className="soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
        Admins sign in inside the bot with their Telegram account — no password. Easiest: ask them to press Start in the bot, then use <b>Make admin</b> on the Users list.
      </p>
      <div className="field">
        <label htmlFor="add-id" className="label">TELEGRAM USER ID</label>
        <input id="add-id" className={'input' + (err ? ' invalid' : '')} inputMode="numeric" value={id} onChange={(e) => { setId(e.target.value); setErr(''); }} placeholder="123456789" />
        <span className="muted" style={{ fontSize: 12 }}>They can find it with @userinfobot in Telegram.</span>
      </div>
      <div className="field">
        <label htmlFor="add-name" className="label">NAME (OPTIONAL)</label>
        <input id="add-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="First and last name" />
      </div>
      {err && <div role="alert" className="err">{err}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy && <Spinner />}Add admin</button>
      </div>
    </Modal>
  );
}
