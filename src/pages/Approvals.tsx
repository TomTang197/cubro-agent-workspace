import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AGENT_NAMES, TEAMS, api, getUser, todayNz, weekday, when, type ApprovalItem } from "../api";
import { useApi } from "../useApi";
import { SocialFields, SocialFootnote, SocialMeta, socialEdits, socialPatch, socialProblem } from "./SocialPost";

export default function Approvals() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "pending";
  const agent = params.get("agent") ?? "";
  const [q, setQ] = useState("");
  const { data, error, reload } = useApi<ApprovalItem[]>(`/approvals?status=${status}${agent ? `&agent=${agent}` : ""}`);
  const nav = useNavigate();
  const dirty = useRef(false);
  // A draft with unsaved edits stays in the list and stays open, whatever is typed in the search box.
  const editing = useRef<string>();
  const list = (data ?? []).filter((a) => !q || a.title.toLowerCase().includes(q.toLowerCase()) || (dirty.current && a.id === editing.current));
  const selected = list.find((a) => a.id === id) ?? (id ? undefined : (dirty.current ? list.find((a) => a.id === editing.current) : undefined) ?? list[0]);
  editing.current = selected?.id;
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
        {selected ? <Detail key={selected.id} item={selected} onFailed={reload} onDirty={(d) => { dirty.current = d; }} onDone={(next, result) => { setDone(result); reload(); nav(next ? `/approvals/${next}${qs}` : `/approvals${qs}`); }} nextId={list[list.findIndex((x) => x.id === selected.id) + 1]?.id} /> : <div className="card muted">Select a draft.</div>}
      </div>
    </>
  );
}

function Detail({ item, onDone, onDirty, onFailed, nextId }: { item: ApprovalItem; onDone: (next: string | undefined, result: ApprovalItem) => void; onDirty: (dirty: boolean) => void; onFailed: () => void; nextId?: string }) {
  const p = item.payload;
  const [text, setText] = useState(p.type === "social_post" ? p.text : p.body);
  const [subject, setSubject] = useState(p.type === "supplier_email" ? p.subject : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<ApprovalItem>();
  useEffect(() => setResult(undefined), [item.id]);
  const pending = item.status === "pending";
  const [social, setSocial] = useState(p.type === "social_post" ? socialEdits(p) : undefined);
  const patch = p.type === "social_post" ? socialPatch(p, social!) : { body: text, subject };
  const dirty = p.type === "social_post" ? Object.keys(patch).length > 0 : text !== p.body || subject !== p.subject;
  // Once approving has begun (a step is done and a later one failed), the draft is fixed and can only be finished.
  const started = pending && !!item.outcome?.length;
  const problem = pending && !started && p.type === "social_post" ? socialProblem(p, social!) : undefined;
  useEffect(() => { onDirty(pending && dirty && !result); return () => onDirty(false); }, [pending, dirty, result]);

  // A draft approved days after it was written would ask the supplier to reply by a date that has gone.
  const unsent = !item.outcome?.some((o) => o.step === "email");
  const lateReplyBy = pending && unsent && p.type === "supplier_email" && p.replyBy && p.replyBy < todayNz() && text.includes(weekday(p.replyBy)) ? weekday(p.replyBy) : undefined;

  async function act(kind: "approve" | "reject") {
    if (kind === "approve" && lateReplyBy && !window.confirm(`This email asks for a reply by ${lateReplyBy}, which has passed. Send it anyway?`)) return;
    setBusy(true); setErr(undefined);
    try {
      if (dirty && (kind === "approve" || p.type !== "social_post")) await api(`/approvals/${item.id}`, { method: "PATCH", body: { payload: patch } });
      const r = await api<ApprovalItem>(`/approvals/${item.id}/${kind}`, { method: "POST", body: { note } });
      setResult(r);
      setTimeout(() => onDone(nextId, r), 900);
    } catch (e) { setErr((e as Error).message); onFailed(); /* the saved edits and any steps already done come back with the item */ } finally { setBusy(false); }
  }
  const shown = result ?? item;
  const signOff = p.type === "supplier_email" ? /((?:Kind|Best|Warm) regards|Ng\u0101 mihi|Thanks|Cheers),[ \t]*\n([^\n]+)(\nPurchasing Officer, )?/i.exec(text) : null;
  const signedBy = signOff?.[2].trim();
  const me = getUser();
  // The drafted title is a Purchasing one, so it only stays under a Purchasing name.
  const signAsMe = () => signOff && setText(`${text.slice(0, signOff.index)}${signOff[1]},\n${me}${TEAMS.Purchasing.includes(me) ? signOff[3] ?? "" : signOff[3] ? "\n" : ""}${text.slice(signOff.index + signOff[0].length)}`);

  return (
    <section className="card detail">
      <div className="row between wrap"><span className="small muted">{AGENT_NAMES[item.agent]} · drafted {when(item.createdAt)}</span>{shown.status !== "pending" && <span className={`pill ${shown.status === "approved" ? "ok" : "bad"}`}>{shown.status} by {shown.decidedBy} {shown.decidedAt && when(shown.decidedAt)}</span>}</div>
      <h2>{item.title}</h2>
      <div className="why"><b>Why the agent drafted this</b><p>{item.rationale}</p>
        <div className="chips">{item.sources.map((s) => <span className="chip" key={s.ref + s.label}><b>{s.system}</b> {s.label}</span>)}</div>
      </div>
      {p.type === "social_post" ? (
        <SocialMeta p={p} />
      ) : (
        <div className="meta-grid">
          <div><span>To</span><b>{p.to.name} &lt;{p.to.address}&gt;</b></div>
          <div><span>Supplier</span><b>{p.supplierName} ({p.supplierId})</b></div>
          <div><span>Reason</span><b>{{ overdue: "Overdue order", unconfirmed: "Unconfirmed order", low_stock: "Low stock", partial: "Partial delivery" }[p.reason]}</b></div>
          {p.purchaseOrder ? <div><span>Purchase order</span><b>{p.purchaseOrder}</b></div> : <div><span>Items</span><b>{p.items.join(", ")}</b></div>}
        </div>
      )}
      {p.type === "supplier_email" && <label className="field"><span>Subject</span><input value={subject} disabled={!pending || started} onChange={(e) => setSubject(e.target.value)} /></label>}
      {p.type === "social_post" ? <SocialFields p={p} edits={social!} onChange={setSocial} pending={pending && !result && !started} /> : (
        <label className="field"><span>Email {pending && <em className="muted">— edit before approving if needed</em>}</span>
          <textarea rows={14} value={text} disabled={!pending || started} onChange={(e) => setText(e.target.value)} /></label>
      )}
      {lateReplyBy && !result && <div className="error" role="alert">This email asks for a reply by {lateReplyBy}, which has passed. {started ? "It is already saved as a draft in the purchasing mailbox, so it cannot be changed here. Change the date in that draft first, or send it as it is." : "Change the date before you send it."}</div>}
      {pending && !result && !started && signOff && signedBy && signedBy !== me && <p className="small sign-note">This email is signed <b>{signedBy}</b>, the name the agent uses for every supplier email (set in Settings), and you are approving as <b>{me}</b>. <button type="button" className="link" onClick={signAsMe}>Sign it as {me} instead</button></p>}
      <p className="small muted">Doing this by hand: ~{item.estimate.manualMinutes} min. Reviewing the draft: ~{item.estimate.reviewMinutes} min{item.edited ? " (+4 min for edits)" : ""}.</p>
      {pending && !result && <>
        <label className="field"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you rejected it, or anything the team should know" /></label>
        {started && <p className="small">Part of this approval is already done (see What happened below). Approve again to finish it; nothing is repeated.</p>}
        {err && <div className="error">{err}</div>}
        {problem && <div className="error">{problem}</div>}
        <div className="row gap">
          <button className="btn primary" disabled={busy || !!problem} onClick={() => act("approve")}>{p.type === "social_post" ? "Approve post" : "Approve & send"}</button>
          <button className="btn" disabled={busy || started} onClick={() => act("reject")}>Reject</button>
          {dirty && <span className="small muted">Your edits will be {p.type === "supplier_email" ? "sent" : "saved"} if you approve. <button type="button" className="link" onClick={() => { if (p.type === "social_post") setSocial(socialEdits(p)); else { setText(p.body); setSubject(p.subject); } }}>Undo edits</button></span>}
        </div>
      </>}
      {shown.reviewerNote && <p className="small"><b>Reviewer note:</b> {shown.reviewerNote}</p>}
      {shown.outcome && <div className="outcome"><b>What happened</b><ul>{shown.outcome.map((o) => <li key={o.ref}><b>{o.system}:</b> {o.label}</li>)}</ul></div>}
      {p.type === "social_post" && <SocialFootnote item={shown} edits={social!} />}
    </section>
  );
}
