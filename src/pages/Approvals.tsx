import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AGENT_NAMES, api, day, when, type ApprovalItem } from "../api";
import { useApi } from "../useApi";

export default function Approvals() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "pending";
  const agent = params.get("agent") ?? "";
  const [q, setQ] = useState("");
  const { data, error, reload } = useApi<ApprovalItem[]>(`/approvals?status=${status}${agent ? `&agent=${agent}` : ""}`);
  const nav = useNavigate();
  const list = (data ?? []).filter((a) => !q || a.title.toLowerCase().includes(q.toLowerCase()));
  const selected = list.find((a) => a.id === id) ?? (id ? undefined : list[0]);
  const dirty = useRef(false);
  const keepEdits = () => dirty.current && !window.confirm("You have unsaved edits to this draft. Leave without saving them?");
  const set = (k: string, v: string) => { if (keepEdits()) return; const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  const qs = params.toString() ? `?${params}` : "";
  const [done, setDone] = useState<ApprovalItem>();

  return (
    <>
      <div className="page-head"><div><h1>Approvals</h1><p className="muted">Nothing leaves the building until someone here approves it.</p></div></div>
      <div className="toolbar">
        <div className="seg">{["pending", "approved", "rejected", "all"].map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => set("status", s === "pending" ? "" : s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div>
        <select value={agent} onChange={(e) => set("agent", e.target.value)}><option value="">All agents</option><option value="social-media">Social Media Planner</option><option value="supplier-outreach">Supplier Outreach</option></select>
        <input placeholder="Search drafts" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      {done && <div className="banner" role="status">
        <b>{done.status === "approved" ? (done.payload.type === "supplier_email" ? "Sent" : "Approved") : "Rejected"}:</b> {done.title}.{" "}
        {done.status === "approved" ? `${(done.outcome ?? []).map((o) => o.label).join(" · ")}.` : "Nothing was sent."}{" "}
        <Link to={`/approvals/${done.id}?status=${done.status}${agent ? `&agent=${agent}` : ""}`} onClick={(e) => { if (keepEdits()) e.preventDefault(); }}>View</Link>
      </div>}
      <div className="split">
        <div className="list card flush">
          {list.length === 0 && <p className="muted pad">{data ? "Nothing here." : "Loading…"}</p>}
          {list.map((a) => (
            <Link key={a.id} to={`/approvals/${a.id}${qs}`} className={`list-row ${selected?.id === a.id ? "sel" : ""}`}
              onClick={(e) => { if (a.id !== selected?.id && keepEdits()) e.preventDefault(); }}>
              <div className="row between"><span className="small muted">{AGENT_NAMES[a.agent]}</span>{a.priority === "high" && <span className="pill warn">High</span>}{a.status !== "pending" && <span className={`pill ${a.status === "approved" ? "ok" : "bad"}`}>{a.status}</span>}</div>
              <div className="title">{a.title}</div>
              <div className="small muted">{a.payload.type === "social_post" ? `Scheduled ${when(a.payload.scheduledFor)}` : `To ${a.payload.to.address}`} · drafted {when(a.createdAt)}</div>
            </Link>
          ))}
        </div>
        {selected ? <Detail key={selected.id} item={selected} onDirty={(d) => { dirty.current = d; }} onDone={(next, result) => { setDone(result); reload(); nav(next ? `/approvals/${next}${qs}` : `/approvals${qs}`); }} nextId={list[list.findIndex((x) => x.id === selected.id) + 1]?.id} /> : <div className="card muted">Select a draft.</div>}
      </div>
    </>
  );
}

function Detail({ item, onDone, onDirty, nextId }: { item: ApprovalItem; onDone: (next: string | undefined, result: ApprovalItem) => void; onDirty: (dirty: boolean) => void; nextId?: string }) {
  const p = item.payload;
  const [text, setText] = useState(p.type === "social_post" ? p.text : p.body);
  const [subject, setSubject] = useState(p.type === "supplier_email" ? p.subject : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<ApprovalItem>();
  useEffect(() => setResult(undefined), [item.id]);
  const pending = item.status === "pending";
  const dirty = p.type === "social_post" ? text !== p.text : text !== p.body || subject !== p.subject;
  useEffect(() => { onDirty(pending && dirty && !result); return () => onDirty(false); }, [pending, dirty, result]);

  async function act(kind: "approve" | "reject") {
    setBusy(true); setErr(undefined);
    try {
      if (dirty) await api(`/approvals/${item.id}`, { method: "PATCH", body: { payload: p.type === "social_post" ? { text } : { body: text, subject } } });
      const r = await api<ApprovalItem>(`/approvals/${item.id}/${kind}`, { method: "POST", body: { note } });
      setResult(r);
      setTimeout(() => onDone(nextId, r), 900);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const shown = result ?? item;

  return (
    <section className="card detail">
      <div className="row between wrap"><span className="small muted">{AGENT_NAMES[item.agent]} · drafted {when(item.createdAt)}</span>{shown.status !== "pending" && <span className={`pill ${shown.status === "approved" ? "ok" : "bad"}`}>{shown.status} by {shown.decidedBy} {shown.decidedAt && when(shown.decidedAt)}</span>}</div>
      <h2>{item.title}</h2>
      <div className="why"><b>Why the agent drafted this</b><p>{item.rationale}</p>
        <div className="chips">{item.sources.map((s) => <span className="chip" key={s.ref + s.label}><b>{s.system}</b> {s.label}</span>)}</div>
      </div>
      {p.type === "social_post" ? (
        <div className="meta-grid">
          <div><span>Channel</span><b>{p.channel}</b></div>
          <div><span>Scheduled</span><b>{when(p.scheduledFor)}</b></div>
          <div><span>Campaign</span><b>{p.campaign ?? "—"}</b></div>
          <div><span>Image</span><b>{p.assetName ? <a href={p.assetUrl} target="_blank" rel="noreferrer">{p.assetName}</a> : "—"}</b></div>
        </div>
      ) : (
        <div className="meta-grid">
          <div><span>To</span><b>{p.to.name} &lt;{p.to.address}&gt;</b></div>
          <div><span>Supplier</span><b>{p.supplierName} ({p.supplierId})</b></div>
          <div><span>Reason</span><b>{{ overdue: "Overdue order", unconfirmed: "Unconfirmed order", low_stock: "Low stock", partial: "Partial delivery" }[p.reason]}</b></div>
          {p.purchaseOrder ? <div><span>Purchase order</span><b>{p.purchaseOrder}</b></div> : <div><span>Items</span><b>{p.items.join(", ")}</b></div>}
        </div>
      )}
      {p.type === "supplier_email" && <label className="field"><span>Subject</span><input value={subject} disabled={!pending} onChange={(e) => setSubject(e.target.value)} /></label>}
      <label className="field"><span>{p.type === "social_post" ? "Post" : "Email"} {pending && <em className="muted">— edit before approving if needed</em>}</span>
        <textarea rows={p.type === "social_post" ? 8 : 14} value={text} disabled={!pending} onChange={(e) => setText(e.target.value)} /></label>
      {p.type === "social_post" && <div className="chips">{p.hashtags.map((h) => <span className="chip" key={h}>{h}</span>)}</div>}
      <p className="small muted">Doing this by hand: ~{item.estimate.manualMinutes} min. Reviewing the draft: ~{item.estimate.reviewMinutes} min{item.edited ? " (+4 min for edits)" : ""}.</p>
      {pending && !result && <>
        <label className="field"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you rejected it, or anything the team should know" /></label>
        {err && <div className="error">{err}</div>}
        <div className="row gap">
          <button className="btn primary" disabled={busy} onClick={() => act("approve")}>{p.type === "social_post" ? "Approve & schedule" : "Approve & send"}</button>
          <button className="btn" disabled={busy} onClick={() => act("reject")}>Reject</button>
          {dirty && <span className="small muted">Your edits will be {p.type === "supplier_email" ? "sent" : "saved"} if you approve. <button type="button" className="link" onClick={() => { setText(p.type === "social_post" ? p.text : p.body); if (p.type === "supplier_email") setSubject(p.subject); }}>Undo edits</button></span>}
        </div>
      </>}
      {shown.reviewerNote && <p className="small"><b>Reviewer note:</b> {shown.reviewerNote}</p>}
      {shown.outcome && <div className="outcome"><b>What happened</b><ul>{shown.outcome.map((o) => <li key={o.ref}><b>{o.system}:</b> {o.label}</li>)}</ul></div>}
      {p.type === "social_post" && <p className="small muted">Post goes out {day(p.scheduledFor)} via the Marketing ClickUp list.</p>}
    </section>
  );
}
