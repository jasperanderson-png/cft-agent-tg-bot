import { useEffect, useState } from 'react';
import type { BankQuestion, Settings } from '../../../../../../shared/types';
import { settingsError, validateQuestionEdit, type QuestionEditErrors } from '../../../../../../shared/validation';
import { ApiError, adminApi } from '../../../lib/api';
import { useBackButton } from '../../../lib/telegram';
import { Icon, Spinner } from '../../../components/ui';
import { activeTotal, MetaChips, PageHead, topicName, type Ctx } from './common';

export function Bank({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const all = data.questions;
  const [sel, setSel] = useState(all[0]?.id ?? 0);
  const [editing, setEditing] = useState(false); // narrow layout: list vs editor
  const [search, setSearch] = useState('');
  const [topic, setTopic] = useState('all');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const current = all.find((q) => q.id === sel) ?? all[0];
  const [draft, setDraft] = useState<BankQuestion | undefined>(current);
  const [errs, setErrs] = useState<QuestionEditErrors>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(all.find((q) => q.id === sel));
    setErrs({});
    setMsg('');
    // Reset the draft only when the selection changes, not on background data refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const narrow = ctx.narrow;
  useBackButton(narrow && editing ? () => setEditing(false) : null);

  const term = search.trim().toLowerCase();
  const num = term.replace(/^q/, '');
  const list = all.filter(
    (q) =>
      (topic === 'all' || q.topic === topic) &&
      (status === 'all' || (status === 'active' ? q.active : !q.active)) &&
      (!term || String(q.n) === num || [q.text, q.explanation, ...q.options.map((o) => o.text)].join(' ').toLowerCase().includes(term)),
  );
  const idx = list.findIndex((q) => q.id === sel);
  const pick = (id: number) => {
    setSel(id);
    setEditing(true);
  };
  const dirty = !!draft && !!current && JSON.stringify(draft) !== JSON.stringify(current);
  const upd = (f: (d: BankQuestion) => BankQuestion) => {
    setDraft((d) => (d ? f(structuredClone(d)) : d));
    setMsg('');
  };

  const save = async () => {
    if (!draft || busy) return;
    const v = validateQuestionEdit(draft, data.topics.map((t) => t.id));
    if (!v.ok) return setErrs(v.errors);
    setBusy(true);
    setErrs({});
    try {
      const saved = await adminApi.saveQuestion({ ...draft, ...v.value });
      ctx.setData((d) => ({ ...d, questions: d.questions.map((q) => (q.id === saved.id ? saved : q)) }));
      setDraft(saved);
      setMsg('Saved. Changes apply to new attempts only.');
      ctx.toast(`Question ${saved.n} saved`);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) ctx.onError(e);
      else if (err.data?.errors) setErrs(err.data.errors as QuestionEditErrors);
      else setMsg('! ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const showList = !narrow || !editing;
  const showEditor = !narrow || editing;
  const d = draft;

  return (
    <>
      <PageHead title="QUESTION BANK" sub="official assessment content" ctx={ctx} />
      <MetaChips items={[
        { icon: 'bank', text: `${list.length} of ${all.length} questions` },
        { icon: 'check', text: `${all.filter((q) => q.active).length} active` },
        { icon: 'eyeoff', text: `${all.filter((q) => !q.active).length} inactive`, color: 'var(--muted)' },
      ]} />
      <div style={{ flex: 'none', display: 'flex', gap: 10, alignItems: 'center', padding: '10px 14px', borderRadius: 14, border: '1px solid var(--line-2)', background: 'rgba(160,220,255,.05)', fontSize: 13, lineHeight: 1.4 }} className="soft">
        <Icon name="shield" style={{ color: 'var(--blue)' }} />
        <span>Official content from the test and answer key. Edits create a new revision and apply to new attempts only; past results keep what the candidate saw.</span>
      </div>
      <div className="bank" style={{ minHeight: narrow ? 520 : 460, height: narrow ? undefined : 'min(720px, calc(100vh - 260px))' }}>
        {showList && (
          <div className="card bank-list" style={{ width: narrow ? '100%' : 'min(340px, 36%)' }}>
            <div style={{ flex: 'none', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--line-2)' }}>
              <div className="search" style={{ flex: 'none' }}>
                <Icon name="search" style={{ top: 11, left: 12 }} />
                <input className="ctl" style={{ height: 38, fontSize: 13, borderRadius: 12, paddingLeft: 36 }} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search question bank" placeholder="Search text, options or Q#" />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="ctl" style={{ flex: 1, minWidth: 0, height: 38, fontSize: 13, borderRadius: 12 }} value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Filter by topic">
                  <option value="all">All topics</option>
                  {data.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select className="ctl" style={{ flex: 'none', height: 38, fontSize: 13, borderRadius: 12 }} value={status} onChange={(e) => setStatus(e.target.value as never)} aria-label="Filter by status">
                  <option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
                </select>
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {list.map((q) => (
                <button key={q.id} className="bank-item" aria-current={q.id === sel ? 'true' : undefined} onClick={() => pick(q.id)}>
                  <span className="cond" style={{ fontSize: 13, color: q.id === sel ? 'var(--blue)' : '#fff' }}>Q{q.n}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="clamp2" style={{ fontSize: 13, lineHeight: 1.35 }}>{q.text}</span>
                    <span style={{ display: 'block', marginTop: 3, fontSize: 11, color: q.active ? 'var(--muted)' : 'var(--bad)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {topicName(data, q.topic)} · Answer {q.correct}{q.edited ? ' · Edited' : ''}{q.active ? '' : ' · Inactive'}
                    </span>
                  </span>
                </button>
              ))}
              {list.length === 0 && (
                <div className="muted" style={{ padding: '32px 16px', textAlign: 'center', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <span>No questions match.</span>
                  <button className="pill" style={{ height: 32 }} onClick={() => { setSearch(''); setTopic('all'); setStatus('all'); }}>Clear search</button>
                </div>
              )}
            </div>
          </div>
        )}
        {showEditor && d && (
          <div className="card editor">
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px 12px 18px', borderBottom: '1px solid var(--line-2)' }}>
              {narrow && <button className="icon-btn" style={{ width: 34, height: 34, borderRadius: 10 }} onClick={() => setEditing(false)} aria-label="Back to list"><Icon name="left" /></button>}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="cond" style={{ fontSize: 17 }}>QUESTION {d.n}</span>
                <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {topicName(data, d.topic)} · Answer {d.correct} · Revision {d.revision}{idx >= 0 ? ` · ${idx + 1} of ${list.length}` : ''}
                </span>
              </div>
              <label className="check"><input type="checkbox" checked={d.active} onChange={() => upd((x) => ({ ...x, active: !x.active }))} />Active</label>
              <button className="icon-btn" style={{ width: 34, height: 34, borderRadius: 10, opacity: idx > 0 ? 1 : 0.35 }} disabled={idx <= 0} onClick={() => setSel(list[idx - 1].id)} aria-label="Previous question"><Icon name="up" /></button>
              <button className="icon-btn" style={{ width: 34, height: 34, borderRadius: 10, opacity: idx >= 0 && idx < list.length - 1 ? 1 : 0.35 }} disabled={idx < 0 || idx >= list.length - 1} onClick={() => setSel(list[idx + 1].id)} aria-label="Next question"><Icon name="down" /></button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="field" style={{ gap: 6 }}>
                <label htmlFor="bk-text" className="eyebrow">QUESTION TEXT</label>
                <textarea id="bk-text" className="ctl" rows={2} value={d.text} onChange={(e) => { const t = e.target.value; upd((x) => ({ ...x, text: t })); }} style={{ borderColor: errs.text ? 'var(--bad)' : undefined, fontSize: 14 }} />
                {errs.text && <span className="err" style={{ fontSize: 13 }}>{errs.text}</span>}
              </div>
              <fieldset style={{ margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <legend className="eyebrow" style={{ marginBottom: 6 }}>OPTIONS · TAP A LETTER TO MARK CORRECT</legend>
                <div role="radiogroup" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap: 8 }}>
                  {d.options.map((o, i) => (
                    <div key={o.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button className="keybtn" role="radio" aria-checked={o.key === d.correct} aria-label={`Mark ${o.key} as correct`} onClick={() => upd((x) => ({ ...x, correct: o.key }))}>{o.key}</button>
                      <input className="ctl" style={{ flex: 1, minWidth: 0, height: 40, fontSize: 13, borderRadius: 12, borderColor: errs.opt && !o.text.trim() ? 'var(--bad)' : undefined }} value={o.text} aria-label={`Option ${o.key} text`} onChange={(e) => { const t = e.target.value; upd((x) => ({ ...x, options: x.options.map((y, j) => (j === i ? { ...y, text: t } : y)) })); }} />
                    </div>
                  ))}
                </div>
                {errs.opt && <span className="err" style={{ fontSize: 13 }}>{errs.opt}</span>}
              </fieldset>
              <div className="field" style={{ gap: 6 }}>
                <label htmlFor="bk-exp" className="eyebrow">EXPLANATION</label>
                <textarea id="bk-exp" className="ctl" rows={3} value={d.explanation} onChange={(e) => { const t = e.target.value; upd((x) => ({ ...x, explanation: t })); }} style={{ borderColor: errs.exp ? 'var(--bad)' : undefined, fontSize: 13 }} />
                {errs.exp && <span className="err" style={{ fontSize: 13 }}>{errs.exp}</span>}
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="field" style={{ gap: 6, flex: '1 1 200px' }}>
                  <label htmlFor="bk-topic" className="eyebrow">TOPIC</label>
                  <select id="bk-topic" className="ctl" style={{ height: 40, fontSize: 13, borderRadius: 12 }} value={d.topic} onChange={(e) => { const t = e.target.value; upd((x) => ({ ...x, topic: t })); }}>
                    {data.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <label className="check" style={{ height: 40 }}><input type="checkbox" checked={d.topicInferred} onChange={() => upd((x) => ({ ...x, topicInferred: !x.topicInferred }))} />Topic is inferred</label>
              </div>
              {d.basis && <div className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>Basis (from answer key): {d.basis}</div>}
              {d.edited && <div className="muted" style={{ fontSize: 12 }}>This question has been edited from the official wording.</div>}
            </div>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--line-2)' }}>
              <button className="pill pill-primary" onClick={save} disabled={busy || !dirty} style={{ opacity: dirty ? 1 : 0.5 }}>{busy && <Spinner />}Save changes</button>
              <button className="pill" onClick={() => { setDraft(current); setErrs({}); setMsg(''); }} disabled={!dirty || busy}>Discard</button>
              {msg && <span role={msg.startsWith('! ') ? 'alert' : 'status'} style={{ fontSize: 12, color: msg.startsWith('! ') ? 'var(--bad)' : 'var(--blue)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{msg.replace(/^! /, '')}</span>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export function SettingsPage({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const total = activeTotal(data);
  const [d, setD] = useState<{ passMark: string; minSample: string; allowRetakes: boolean; timezone: string }>({
    passMark: String(data.settings.passMark),
    minSample: String(data.settings.minSample),
    allowRetakes: data.settings.allowRetakes,
    timezone: data.settings.timezone,
  });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const pct = Math.round(((Number(d.passMark) || 0) / total) * 100);

  const save = async () => {
    const e = settingsError(d.passMark, d.minSample, total);
    if (e) return setErr(e);
    setBusy(true);
    setErr('');
    try {
      const s: Settings = await adminApi.saveSettings({ passMark: Number(d.passMark), minSample: Number(d.minSample), allowRetakes: d.allowRetakes, timezone: d.timezone.trim() });
      ctx.setData((x) => ({ ...x, settings: s }));
      setMsg('Settings saved.');
      ctx.toast('Settings saved');
    } catch (e) {
      if ((e as ApiError).status === 401) ctx.onError(e);
      else setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (p: Partial<typeof d>) => {
    setD({ ...d, ...p });
    setMsg('');
  };

  return (
    <>
      <PageHead title="SETTINGS" sub="assessment rules" ctx={ctx} />
      <div className="card" style={{ maxWidth: 640, padding: 24, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div className="field">
          <label htmlFor="set-pass" className="eyebrow">PASS MARK</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input id="set-pass" className="ctl" type="number" inputMode="numeric" min={1} max={total} value={d.passMark} onChange={(e) => set({ passMark: e.target.value })} style={{ width: 96, fontSize: 16 }} />
            <span style={{ fontSize: 15 }}>of {total} correct ({pct}%)</span>
          </div>
          <span className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>Source: test instructions state "Passing score: 21/30 (70%)". The answer key calls it a suggested pass mark. Changes apply to attempts graded from now on.</span>
        </div>
        <div className="field">
          <label htmlFor="set-min" className="eyebrow">MINIMUM RESPONSES FOR PATTERNS</label>
          <input id="set-min" className="ctl" type="number" inputMode="numeric" min={1} max={500} value={d.minSample} onChange={(e) => set({ minSample: e.target.value })} style={{ width: 96, fontSize: 16 }} />
          <span className="muted" style={{ fontSize: 13 }}>Questions and topics with fewer responses are labeled low sample and excluded from patterns.</span>
        </div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={d.allowRetakes} onChange={() => set({ allowRetakes: !d.allowRetakes })} style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--blue)' }} />
          <span>
            <span style={{ display: 'block', fontSize: 15 }}>Allow retakes</span>
            <span className="muted" style={{ display: 'block', fontSize: 13, marginTop: 2 }}>Off: one attempt per Telegram account. On: a candidate who has finished can start a new attempt.</span>
          </span>
        </label>
        <div className="field">
          <label htmlFor="set-tz" className="eyebrow">REPORT TIME ZONE</label>
          <input id="set-tz" className="ctl" list="tz-list" value={d.timezone} onChange={(e) => set({ timezone: e.target.value })} style={{ maxWidth: 280, fontSize: 15 }} autoCapitalize="off" spellCheck={false} />
          <datalist id="tz-list">
            {['Asia/Tashkent', 'America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC'].map((z) => <option key={z} value={z} />)}
          </datalist>
          <span className="muted" style={{ fontSize: 13 }}>Used for dates in Excel reports, bot messages and when weeks start (Monday 00:00).</span>
        </div>
        {err && <span role="alert" className="err" style={{ fontSize: 13 }}>{err}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="pill pill-primary" style={{ height: 44, padding: '0 20px' }} onClick={save} disabled={busy}>{busy && <Spinner />}Save settings</button>
          {msg && <span role="status" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>
      <MyNotifications ctx={ctx} />
    </>
  );
}

function MyNotifications({ ctx }: { ctx: Ctx }) {
  const me = ctx.data.me;
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const toggle = async (k: 'notifyResults' | 'weeklyReport') => {
    setBusy(true);
    try {
      const next = await adminApi.savePrefs({ notifyResults: me.notifyResults, weeklyReport: me.weeklyReport, [k]: !me[k] });
      ctx.setData((x) => ({ ...x, me: next }));
      ctx.toast('Notification settings saved');
    } catch (e) {
      ctx.onError(e);
    } finally {
      setBusy(false);
    }
  };
  const row = (k: 'notifyResults' | 'weeklyReport', title: string, sub: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderTop: '1px solid var(--line-2)' }}>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: 15 }}>{title}</span>
        <span className="muted" style={{ display: 'block', fontSize: 13, marginTop: 2 }}>{sub}</span>
      </span>
      <button role="switch" aria-checked={me[k]} aria-label={title} className="switch" disabled={busy || !me.telegramUserId} onClick={() => toggle(k)}><i /></button>
    </div>
  );
  return (
    <div className="card" style={{ maxWidth: 640, padding: '20px 24px 10px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="cond" style={{ fontSize: 14 }}>MY TELEGRAM NOTIFICATIONS</span>
        <span className="muted" style={{ fontSize: 12 }}>{me.role === 'owner' ? 'Owner' : 'Admin'}{me.name ? ` · ${me.name}` : ''}</span>
      </div>
      {!me.telegramUserId && <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>Your admin account isn't linked to Telegram, so the bot can't message you.</p>}
      {row('notifyResults', 'Pass / fail alerts', 'A message each time a candidate submits, with their score.')}
      {row('weeklyReport', 'Weekly summary', "Every Monday: last week's statistics and the Excel report.")}
    </div>
  );
}
