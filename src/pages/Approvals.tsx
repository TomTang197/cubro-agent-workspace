import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fromNzInput, nzDay, shortDay } from "../../server/agents/nzTime";
import { AGENT_NAMES, DRAFT_NOUN, RESTART, STATUS_LABEL, TEAMS, agentFor, api, getUser, teamOf, todayNz, weekday, when, type AgentId, type ApprovalItem } from "../api";

const AGENT_TEAM: Record<AgentId, string> = { "social-media": "Marketing", "supplier-outreach": "Purchasing" };
import { useApi } from "../useApi";
import { SocialFields, SocialFootnote, SocialMeta, socialEdits, socialPatch, socialProblem, type SocialEdits } from "./SocialPost";

const UNDO_MS = 8000;
/** A decision that has been made but not yet sent on, so it can still be undone. */
type Held = { item: ApprovalItem; kind: "approve" | "reject"; note: string; by: string; changes?: Changes };
/** What the reviewer changed: `patch` goes to the server with the decision, `edits` puts their typing back if it is undone. */
type Changes = { patch: object; edits: Edits };
type Edits = { text: string; subject: string; social?: SocialEdits };

export default function Approvals() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "pending";
  // One draft at a time is the everyday view; the list is for looking things up.
  const focus = status === "pending" && params.get("view") !== "list";
  const me = getUser();
  const agentParam = params.get("agent");
  // With nothing asked for, a person gets their own team's drafts; a link to one draft works whoever opens it.
  const agent = agentParam === "all" ? "" : agentParam ?? (focus && !id ? agentFor(me) : "");
  const [q, setQ] = useState("");
  const { data, error, reload } = useApi<ApprovalItem[]>(`/approvals?status=${status}${agent ? `&agent=${agent}` : ""}`);
  // A decision is sent on seconds after it was made, so it reloads whichever queue is on screen by then.
  const reloadNow = useRef(reload);
  reloadNow.current = reload;
  const nav = useNavigate();
  const dirty = useRef(false);
  // A draft with unsaved edits stays in the list and stays open, whatever is typed in the search box.
  const editing = useRef<string>();
  const [held, setHeld] = useState<Held>();
  const heldRef = useRef<Held>();
  const timer = useRef<number>();
  // Decided drafts leave the queue straight away, before the server has been told.
  const [decided, setDecided] = useState<string[]>([]);
  const [done, setDone] = useState<ApprovalItem>();
  const [failed, setFailed] = useState<{ item: ApprovalItem; message: string }>();
  // The reviewer's typing, handed back to the draft once when its decision is undone or did not go through.
  const restore = useRef<{ id: string; edits: Edits }>();
  const giveBack = (h: Held) => { restore.current = h.changes && { id: h.item.id, edits: h.changes.edits }; };
  const take = (draft: string) => (restore.current?.id === draft ? restore.current.edits : undefined);
  const waiting = (data ?? []).filter((a) => !(a.status === "pending" && decided.includes(a.id)));
  const filtered = waiting.filter((a) => focus || !q || a.title.toLowerCase().includes(q.toLowerCase()) || (dirty.current && a.id === editing.current));
  const list = focus ? [...filtered].sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high")) : filtered;
  const selected = list.find((a) => a.id === id) ?? (id && !focus ? undefined : (dirty.current ? list.find((a) => a.id === editing.current) : undefined) ?? list[0]);
  editing.current = selected?.id;
  const at = selected ? list.findIndex((x) => x.id === selected.id) : -1;
  const keepEdits = () => dirty.current && !window.confirm("You have unsaved edits to this draft. Leave without saving them?");
  const query = (change: Record<string, string>) => { const p = new URLSearchParams(params); p.set("agent", agent || "all"); for (const [k, v] of Object.entries(change)) { if (v) p.set(k, v); else p.delete(k); } return `?${p}`; };
  const set = (change: Record<string, string>) => { if (!keepEdits()) nav(`/approvals${query(change)}`); };
  const qs = query({});
  const guard = (e: { preventDefault: () => void }) => { if (keepEdits()) e.preventDefault(); };

  async function commit(h: Held, keepalive = false) {
    try { setDone(await api<ApprovalItem>(`/approvals/${h.item.id}/${h.kind}`, { method: "POST", body: { note: h.note, user: h.by, ...(h.changes && { payload: h.changes.patch }) }, keepalive })); }
    catch (e) { giveBack(h); setFailed({ item: h.item, message: e instanceof Error ? e.message : String(e) }); setDecided((d) => d.filter((x) => x !== h.item.id)); }
    finally { reloadNow.current(); }
  }
  const settle = (keepalive = false) => {
    const h = heldRef.current;
    if (!h) return;
    window.clearTimeout(timer.current); heldRef.current = undefined; setHeld(undefined);
    void commit(h, keepalive);
  };
  const decide = (h: Held, next?: string) => {
    settle(); // an earlier decision still counting down goes through now
    heldRef.current = h; setHeld(h); setDone(undefined); setFailed(undefined); setDecided((d) => [...d, h.item.id]);
    timer.current = window.setTimeout(() => settle(), UNDO_MS);
    reload();
    nav(next ? `/approvals/${next}${qs}` : `/approvals${qs}`);
  };
  const drop = () => {
    const h = heldRef.current;
    if (h) { window.clearTimeout(timer.current); heldRef.current = undefined; setHeld(undefined); setDecided((d) => d.filter((x) => x !== h.item.id)); }
    return h;
  };
  const undo = () => {
    const h = drop();
    if (!h) return;
    giveBack(h);
    nav(`/approvals/${h.item.id}${qs}`);
  };
  // Leaving the page is not an undo: a decision still counting down is sent on.
  const leave = useRef(settle);
  leave.current = settle;
  useEffect(() => {
    const flush = () => leave.current(true);
    window.addEventListener("pagehide", flush);
    window.addEventListener(RESTART, drop);
    return () => { window.removeEventListener("pagehide", flush); window.removeEventListener(RESTART, drop); flush(); };
  }, []);

  useEffect(() => { if (restore.current?.id === selected?.id) restore.current = undefined; }, [selected?.id]);
  // The next draft opens at its top, not wherever the last one was scrolled to.
  useEffect(() => { if (focus) window.scrollTo(0, 0); }, [focus, selected?.id]);

  const scope = agent ? `${teamOf(me) === AGENT_TEAM[agent as AgentId] ? "your team's" : `${AGENT_TEAM[agent as AgentId]}'s`} ${DRAFT_NOUN[agent as AgentId][1]}` : "both teams' drafts";
  const heldWhat = held && (held.kind === "reject" ? "Sent back. Nothing will go out." : held.item.payload.type === "supplier_email" ? `Approved. The email goes to ${held.item.payload.to.name} in a few seconds.` : "Approved. The team is told in a few seconds.");
  return (
    <>
      <div className="page-head"><div><h1>Drafts to check</h1><p className="muted">{focus ? "One draft at a time: read it, then approve it, change it or send it back. Nothing leaves the building until someone here approves it." : "Every draft the assistants have written, and what was decided. Nothing leaves the building until someone here approves it."}</p></div></div>
      <div className="toolbar">
        {!focus && <div className="seg">{(["pending", "approved", "rejected", "all"] as const).map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => set({ status: s === "pending" ? "" : s, view: "list" })}>{s === "all" ? "All" : STATUS_LABEL[s]}</button>)}</div>}
        <select aria-label="Whose drafts" value={agent} onChange={(e) => set({ agent: e.target.value || "all" })}><option value="">Both teams' drafts</option><option value="social-media">Marketing: social posts</option><option value="supplier-outreach">Purchasing: supplier emails</option></select>
        {!focus && <input placeholder="Search drafts" value={q} onChange={(e) => setQ(e.target.value)} />}
        {focus && list.length > 0 && <span className="queue-at"><b>Draft {at + 1} of {list.length}</b>
          {list.length > 1 && <span className="row gap">{at > 0 && <Link to={`/approvals/${list[at - 1].id}${qs}`} onClick={guard}>‹ Previous</Link>}{at < list.length - 1 && <Link to={`/approvals/${list[at + 1].id}${qs}`} onClick={guard}>Skip for now ›</Link>}</span>}</span>}
        {focus ? <Link className="to-list" to={`/approvals${query({ view: "list" })}`} onClick={guard}>See them as a list, with what was already decided</Link>
          : <Link className="to-list" to={`/approvals${query({ view: "", status: "" })}`} onClick={guard}>Back to one at a time</Link>}
      </div>
      {error && <div className="error">{error}</div>}
      {failed && <div className="error" role="alert"><b>That didn't go through:</b> {failed.message} The draft is still waiting. <Link to={`/approvals/${failed.item.id}${qs}`} onClick={guard}>Open it</Link></div>}
      {done && !held && <div className="banner" role="status">
        <b>{done.status === "approved" ? (done.payload.type === "supplier_email" ? "Sent" : "Approved") : "Sent back"}:</b> {done.title}.{" "}
        {done.status === "approved" ? `${(done.outcome ?? []).map((o) => o.label).join(" · ")}.` : "Nothing was sent."}{" "}
        <Link to={`/approvals/${done.id}?status=${done.status}&agent=${agent || "all"}`} onClick={guard}>View</Link>
      </div>}
      {focus ? (
        selected ? <div className="one"><Detail key={selected.id} item={selected} onDirty={(d) => { dirty.current = d; }} restore={take(selected.id)} onDecide={(kind, note, changes) => decide({ item: selected, kind, note, by: getUser(), changes }, list[at + 1]?.id)} /></div>
          : data ? <section className="card one all-done"><h2>All done</h2><p>Nothing is waiting in {scope}.{held ? "" : " Ask an assistant for new drafts from your Today page."}</p><div className="row gap wrap"><Link className="btn primary" to="/">Back to Today</Link><Link className="btn" to={`/approvals${query({ status: "all", view: "list" })}`}>See what was decided</Link></div></section>
          : <p className="muted">Loading…</p>
      ) : (
        <div className="split">
          <div className="list card flush">
            {list.length === 0 && <p className="muted pad">{data ? "Nothing here." : "Loading…"}</p>}
            {list.map((a) => (
              <Link key={a.id} to={`/approvals/${a.id}${qs}`} className={`list-row ${selected?.id === a.id ? "sel" : ""}`}
                onClick={(e) => { if (a.id !== selected?.id && keepEdits()) e.preventDefault(); }}>
                <div className="row between"><span className="small muted">{AGENT_NAMES[a.agent]}</span>{a.priority === "high" && <span className="pill warn">Urgent</span>}{a.status !== "pending" && <span className={`pill ${a.status === "approved" ? "ok" : "bad"} plain`}>{STATUS_LABEL[a.status]}</span>}</div>
                <div className="title">{a.title}</div>
                <div className="small muted">{a.payload.type === "social_post" ? `Scheduled ${when(a.payload.scheduledFor)}` : `To ${a.payload.to.address}`} · drafted {when(a.createdAt)}</div>
              </Link>
            ))}
          </div>
          {selected ? <Detail key={selected.id} item={selected} onDirty={(d) => { dirty.current = d; }} restore={take(selected.id)} onDecide={(kind, note, changes) => decide({ item: selected, kind, note, by: getUser(), changes }, list[at + 1]?.id)} /> : <div className="card muted">Select a draft.</div>}
        </div>
      )}
      {held && <div className="undo" role="status">
        <span><b>{heldWhat}</b> {held.item.title}</span>
        <button type="button" className="btn" onClick={undo}>Undo</button>
        <i style={{ animationDuration: `${UNDO_MS}ms` }} />
      </div>}
    </>
  );
}

function Detail({ item, onDecide, onDirty, restore }: { item: ApprovalItem; onDecide: (kind: "approve" | "reject", note: string, changes?: Changes) => void; onDirty: (dirty: boolean) => void; restore?: Edits }) {
  const p = item.payload;
  const [text, setText] = useState(restore?.text ?? (p.type === "social_post" ? p.text : p.body));
  const [subject, setSubject] = useState(restore?.subject ?? (p.type === "supplier_email" ? p.subject : ""));
  const [note, setNote] = useState("");
  // A draft is read first; its fields open only when someone chooses to change it.
  const [changing, setChanging] = useState(!!restore);
  const pending = item.status === "pending";
  const [social, setSocial] = useState(p.type === "social_post" ? restore?.social ?? socialEdits(p) : undefined);
  const patch = p.type === "social_post" ? socialPatch(p, social!) : { body: text, subject };
  const dirty = p.type === "social_post" ? Object.keys(patch).length > 0 : text !== p.body || subject !== p.subject;
  const problem = pending && p.type === "social_post" ? socialProblem(p, social!) : undefined;
  useEffect(() => { onDirty(pending && dirty); return () => onDirty(false); }, [pending, dirty]);

  // A draft approved days after it was written would ask the supplier to reply by a date that has gone.
  const lateReplyBy = pending && p.type === "supplier_email" && p.replyBy && p.replyBy < todayNz() && text.includes(weekday(p.replyBy)) ? weekday(p.replyBy) : undefined;

  function act(kind: "approve" | "reject") {
    if (kind === "approve" && lateReplyBy && !window.confirm(`This email asks for a reply by ${lateReplyBy}, which has passed. Send it anyway?`)) return;
    // The edits are saved with the decision, not before it, so undoing the decision leaves the draft as it was for everyone else.
    onDecide(kind, note, dirty && (kind === "approve" || p.type !== "social_post") ? { patch, edits: { text, subject, social } } : undefined);
  }
  const shown = item;
  const revert = () => { if (p.type === "social_post") setSocial(socialEdits(p)); else { setText(p.body); setSubject(p.subject); } setChanging(false); };
  const signOff = p.type === "supplier_email" ? /((?:Kind|Best|Warm) regards|Ng\u0101 mihi|Thanks|Cheers),[ \t]*\n([^\n]+)(\nPurchasing Officer, )?/i.exec(text) : null;
  const signedBy = signOff?.[2].trim();
  const me = getUser();
  // The drafted title is a Purchasing one, so it only stays under a Purchasing name.
  const signAsMe = () => signOff && setText(`${text.slice(0, signOff.index)}${signOff[1]},\n${me}${TEAMS.Purchasing.includes(me) ? signOff[3] ?? "" : signOff[3] ? "\n" : ""}${text.slice(signOff.index + signOff[0].length)}`);

  return (
    <section className="card detail">
      <div className="row between wrap"><span className="small muted">{AGENT_NAMES[item.agent]} · drafted {when(item.createdAt)}</span>{pending && item.priority === "high" && <span className="pill warn">Urgent</span>}{shown.status !== "pending" && <span className={`pill ${shown.status === "approved" ? "ok" : "bad"} plain`}>{STATUS_LABEL[shown.status]} by {shown.decidedBy} {shown.decidedAt && when(shown.decidedAt)}</span>}</div>
      <h2>{item.title}</h2>
      <div className="why"><b>Why the assistant drafted this</b><p>{item.rationale}</p>
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
      {pending && !changing ? (
        <div className="letter">
          {p.type === "supplier_email" && <p className="letter-subject"><span className="small muted">Subject</span>{subject}</p>}
          <div className="letter-body">{p.type === "social_post" ? social!.text : text}</div>
          {p.type === "social_post" && <>
            <div className="chips">{social!.hashtags.split(/\s+/).filter(Boolean).map((h) => <span className="chip" key={h}>{h}</span>)}</div>
            <p className="small muted">To publish on {p.channel}: {social!.scheduledFor ? when(fromNzInput(social!.scheduledFor)) : "no date picked"}</p>
          </>}
        </div>
      ) : <>
        {p.type === "supplier_email" && <label className="field"><span>Subject</span><input value={subject} disabled={!pending} onChange={(e) => setSubject(e.target.value)} /></label>}
        {p.type === "social_post" ? <SocialFields p={p} edits={social!} onChange={setSocial} pending={pending} /> : (
          <label className="field"><span>Email</span>
            <textarea rows={14} value={text} disabled={!pending} onChange={(e) => setText(e.target.value)} /></label>
        )}
      </>}
      {lateReplyBy && <div className="error" role="alert">This email asks for a reply by {lateReplyBy}, which has passed. Change the date before you send it.</div>}
      {pending && signOff && signedBy && signedBy !== me && <p className="small sign-note">This email is signed <b>{signedBy}</b>, the name the assistant puts on every supplier email, and you are approving as <b>{me}</b>. <button type="button" className="link" onClick={signAsMe}>Sign it as {me} instead</button></p>}
      <p className="small muted">Doing this by hand: ~{item.estimate.manualMinutes} min. Reviewing the draft: ~{item.estimate.reviewMinutes} min{item.edited ? " (+4 min for edits)" : ""}.</p>
      {pending && <>
        <label className="field"><span>Note for the team (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you sent it back, or anything the team should know" /></label>
        {problem && <div className="error">{problem}</div>}
        <div className="choices">
          <div>
            <button className="btn primary" disabled={!!problem} onClick={() => act("approve")}>{p.type === "social_post" ? "Approve" : "Approve and send"}{dirty ? " with your changes" : ""}</button>
            <small>{p.type === "social_post"
              ? `Adds a task to Marketing's list in ClickUp to publish it${social!.scheduledFor ? ` on ${shortDay(nzDay(fromNzInput(social!.scheduledFor)))}` : ""}, and tells the team on Teams. Nothing is posted to ${p.channel} automatically.`
              : `Emails it to ${p.to.name} at ${p.supplierName} from the Purchasing mailbox, and adds a reminder in ClickUp to chase a reply.`}</small>
          </div>
          <div>
            {changing || dirty ? <button className="btn" onClick={revert}>Undo my changes</button> : <button className="btn" onClick={() => setChanging(true)}>Change it</button>}
            <small>{changing || dirty ? "Puts the draft back to how the assistant wrote it." : `Fix the ${p.type === "social_post" ? "wording, hashtags or date" : "subject or wording"} first. Nothing goes out until you approve.`}</small>
          </div>
          <div>
            <button className="btn" onClick={() => act("reject")}>Send back</button>
            <small>Nothing goes out and the draft is not used. Add a note so the team knows why.</small>
          </div>
        </div>
        <p className="small muted">You get a few seconds to undo after approving or sending back.</p>
      </>}
      {shown.reviewerNote && <p className="small"><b>Reviewer note:</b> {shown.reviewerNote}</p>}
      {shown.outcome && <div className="outcome"><b>What happened</b><ul>{shown.outcome.map((o) => <li key={o.ref}><b>{o.system}:</b> {o.label}</li>)}</ul></div>}
      {p.type === "social_post" && !pending && <SocialFootnote item={shown} edits={social!} />}
    </section>
  );
}
