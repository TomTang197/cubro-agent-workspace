import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fromNzInput, nzDay, shortDay } from "../../server/agents/nzTime";
import { AGENT_NAMES, DRAFT_NOUN, RESTART, STATUS_LABEL, TEAMS, agentFor, api, getUser, scrollToTop, teamOf, todayNz, weekday, when, day, type AgentId, type ApprovalItem, type EmailOption } from "../api";
import { EmailOptions } from "../components/EmailOptions";
import { KeyFacts, Marked, useFacts, type FactSheet } from "../components/KeyFacts";
import { RecordLink } from "../components/Record";
import { askBeforeLeaving, mayLeave } from "../leaving";

const AGENT_TEAM: Record<AgentId, string> = { "social-media": "Marketing", "supplier-outreach": "Purchasing" };
import { useApi } from "../useApi";
import { SocialFields, SocialFootnote, SocialMeta, socialEdits, socialPatch, socialProblem, type SocialEdits } from "./SocialPost";

const UNDO_MS = 8000;
/** Where a supplier email is signed off: what is added to it goes in above this. */
const SIGN_OFF = /((?:Kind|Best|Warm) regards|Ng\u0101 mihi|Thanks|Cheers),[ \t]*\n([^\n]+)(\n[^\n,]+, (?=Cubro Ltd))?/i;
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
  const [sort, setSort] = useState("newest");
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
  const restore = useRef<{ id: string; note: string; edits?: Edits }>();
  const giveBack = (h: Held) => { restore.current = h.changes || h.note ? { id: h.item.id, note: h.note, edits: h.changes?.edits } : undefined; };
  const take = (draft: string) => (restore.current?.id === draft ? restore.current : undefined);
  const waiting = (data ?? []).filter((a) => !(a.status === "pending" && decided.includes(a.id)));
  const filtered = waiting.filter((a) => focus || !q || a.title.toLowerCase().includes(q.toLowerCase()) || (dirty.current && a.id === editing.current));
  const urgentFirst = (a: ApprovalItem, b: ApprovalItem) => Number(b.priority === "high") - Number(a.priority === "high");
  const SORTS: Record<string, (a: ApprovalItem, b: ApprovalItem) => number> = {
    newest: (a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt),
    oldest: (a, b) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt),
    urgent: urgentFirst,
    name: (a, b) => a.title.localeCompare(b.title),
  };
  const list = [...filtered].sort(focus ? urgentFirst : SORTS[sort] ?? SORTS.newest);
  const selected = list.find((a) => a.id === id) ?? (id && !focus ? undefined : (dirty.current ? list.find((a) => a.id === editing.current) : undefined) ?? list[0]);
  editing.current = selected?.id;
  const at = selected ? list.findIndex((x) => x.id === selected.id) : -1;
  const keepEdits = () => dirty.current && !window.confirm("You have unsaved edits to this draft. Leave without saving them?");
  const query = (change: Record<string, string>) => { const p = new URLSearchParams(params); p.set("agent", agent || "all"); for (const [k, v] of Object.entries(change)) { if (v) p.set(k, v); else p.delete(k); } return `?${p}`; };
  const set = (change: Record<string, string>) => { if (!keepEdits()) nav(`/approvals${query(change)}`); };
  const qs = query({});
  // A draft decided under one team can be reopened after the reviewer has switched to the other, so its link names its own team.
  const queueOf = (a: ApprovalItem) => (agent && agent !== a.agent ? a.agent : agent || "all");
  const guard = (e: { preventDefault: () => void }) => { if (keepEdits()) e.preventDefault(); };
  // Links outside this page (the record panel's linked drafts, notifications, the menu) and the search would otherwise drop the edits without asking.
  useEffect(() => {
    askBeforeLeaving(keepEdits);
    const ask = (e: MouseEvent) => {
      const link = (e.target as Element).closest?.("a[href]");
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!link || link.getAttribute("target") === "_blank" || link.closest("main")) return; // links on this page ask for themselves
      if (!mayLeave(link.getAttribute("href")!)) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("click", ask, true);
    return () => { askBeforeLeaving(); document.removeEventListener("click", ask, true); };
  }, []);

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
    nav(`/approvals/${h.item.id}${query({ agent: queueOf(h.item) })}`);
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
  useEffect(() => { if (focus) scrollToTop(); }, [focus, selected?.id]);

  const scope = agent ? `${teamOf(me) === AGENT_TEAM[agent as AgentId] ? "your team's" : `${AGENT_TEAM[agent as AgentId]}'s`} ${DRAFT_NOUN[agent as AgentId][1]}` : "both teams' drafts";
  const heldWhat = held && (held.kind === "reject" ? "Sent back. Nothing will go out." : held.item.outcome?.length ? "Approved. The rest is finished in a few seconds." : held.item.payload.type === "supplier_email" ? `Approved. The email goes to ${held.item.payload.to.name} in a few seconds.` : "Approved. The team is told in a few seconds.");
  return (
    <>
      <div className="page-head"><div><h1>Drafts to check</h1><p className="muted">{focus ? "One draft at a time: read it, then approve it, change it or send it back. Nothing leaves the building until someone here approves it." : "Every draft the assistants have written, and what was decided. Nothing leaves the building until someone here approves it."}</p></div></div>
      <div className="toolbar">
        {!focus && <div className="seg">{(["pending", "approved", "rejected", "all"] as const).map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => set({ status: s === "pending" ? "" : s, view: "list" })}>{s === "all" ? "All" : STATUS_LABEL[s]}</button>)}</div>}
        <select aria-label="Whose drafts" value={agent} onChange={(e) => set({ agent: e.target.value || "all" })}><option value="">Both teams' drafts</option><option value="social-media">Marketing: social posts</option><option value="supplier-outreach">Purchasing: supplier emails</option></select>
        {agent === "supplier-outreach" && <Link className="btn" to="/write" onClick={guard}>Write a supplier email</Link>}
        {!focus && <input type="search" placeholder="Find a draft" aria-label="Find a draft" value={q} onChange={(e) => setQ(e.target.value)} />}
        {!focus && <label className="sort"><span className="small muted">Sort by</span><select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="urgent">Urgent first</option><option value="name">Name, A to Z</option></select></label>}
        {focus && list.length > 0 && <span className="queue-at"><b>Draft {at + 1} of {list.length}</b>
          {list.length > 1 && <span className="row gap">{at > 0 && <Link to={`/approvals/${list[at - 1].id}${qs}`} onClick={guard}>‹ Previous</Link>}{at < list.length - 1 && <Link to={`/approvals/${list[at + 1].id}${qs}`} onClick={guard}>Skip for now ›</Link>}</span>}</span>}
        {focus ? <Link className="to-list" to={`/approvals${query({ view: "list" })}`} onClick={guard}>See them as a list, with what was already decided</Link>
          : <Link className="to-list" to={`/approvals${query({ view: "", status: "" })}`} onClick={guard}>Back to one at a time</Link>}
      </div>
      {error && <div className="error">{error}</div>}
      {failed && <div className="error" role="alert"><b>That didn't go through:</b> {failed.message} The draft is still waiting. <Link to={`/approvals/${failed.item.id}${query({ agent: queueOf(failed.item) })}`} onClick={guard}>Open it</Link></div>}
      {done && !held && <div className="banner" role="status">
        <b>{done.status === "approved" ? (done.payload.type === "supplier_email" ? "Sent" : "Approved") : "Sent back"}:</b> {done.title}.{" "}
        {done.status === "approved" ? `${(done.outcome ?? []).map((o) => o.label).join(" · ")}.` : "Nothing was sent."}{" "}
        <Link to={`/approvals/${done.id}?status=${done.status}&agent=${queueOf(done)}`} onClick={guard}>View</Link>
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

function Detail({ item, onDecide, onDirty, restore }: { item: ApprovalItem; onDecide: (kind: "approve" | "reject", note: string, changes?: Changes) => void; onDirty: (dirty: boolean) => void; restore?: { note: string; edits?: Edits } }) {
  const p = item.payload;
  const [text, setText] = useState(restore?.edits?.text ?? (p.type === "social_post" ? p.text : p.body));
  const [subject, setSubject] = useState(restore?.edits?.subject ?? (p.type === "supplier_email" ? p.subject : ""));
  // A part-done approval keeps the note it was started with.
  const [note, setNote] = useState(restore?.note ?? (item.status === "pending" ? item.reviewerNote ?? "" : ""));
  // A draft is read first; its fields open only when someone chooses to change it.
  const [changing, setChanging] = useState(!!restore?.edits);
  // The numbers in the draft as it reads now, and in the email it answers, picked out for the reader. What is sent stays plain text.
  const facts = useFacts<{ draft: FactSheet; inReplyTo?: FactSheet }>(p.type === "supplier_email" && item.status === "pending" ? `${item.id}\n${subject}\n${text}` : null,
    (quick) => api(`/approvals/${item.id}/facts`, { method: "POST", body: { subject, body: text, quick } }), (f) => !!f.inReplyTo?.more);
  const pending = item.status === "pending";
  const [social, setSocial] = useState(p.type === "social_post" ? restore?.edits?.social ?? socialEdits(p) : undefined);
  const patch = p.type === "social_post" ? socialPatch(p, social!) : { body: text, subject };
  const dirty = p.type === "social_post" ? Object.keys(patch).length > 0 : text !== p.body || subject !== p.subject;
  // Once approving has begun (a step is done and a later one failed), the draft is fixed and can only be finished.
  const started = pending && !!item.outcome?.length;
  const problem = pending && !started && p.type === "social_post" ? socialProblem(p, social!) : undefined;
  useEffect(() => { onDirty(pending && dirty && !started); return () => onDirty(false); }, [pending, dirty, started]);

  // A draft approved days after it was written would ask the supplier to reply by a date that has gone.
  const unsent = !item.outcome?.some((o) => o.step === "email");
  const lateReplyBy = pending && unsent && p.type === "supplier_email" && p.replyBy && p.replyBy < todayNz() && text.includes(weekday(p.replyBy)) ? weekday(p.replyBy) : undefined;

  function act(kind: "approve" | "reject") {
    if (kind === "approve" && lateReplyBy && !window.confirm(`This email asks for a reply by ${lateReplyBy}, which has passed. Send it anyway?`)) return;
    // The edits are saved with the decision, not before it, so undoing the decision leaves the draft as it was for everyone else.
    onDecide(kind, note, dirty && !started && (kind === "approve" || p.type !== "social_post") ? { patch, edits: { text, subject, social } } : undefined);
  }
  const shown = item;
  const revert = () => { if (p.type === "social_post") setSocial(socialEdits(p)); else { setText(p.body); setSubject(p.subject); } setChanging(false); };
  const signOff = p.type === "supplier_email" ? SIGN_OFF.exec(text) : null;
  // More to say, offered once the reviewer chooses to change a supplier email: one click adds the words above the sign-off.
  const adding = pending && changing && !started && p.type === "supplier_email";
  const { data: options } = useApi<EmailOption[]>(adding ? `/approvals/${item.id}/options` : null);
  const addPara = (para: string) => setText((t) => { const at = SIGN_OFF.exec(t)?.index ?? t.length; return `${t.slice(0, at).trimEnd()}\n\n${para}${at < t.length ? `\n\n${t.slice(at)}` : ""}`; });
  const toggle = (o: EmailOption) => (text.includes(o.text) ? setText((t) => t.replace(o.text, "").replace(/\n{3,}/g, "\n\n")) : addPara(o.text));
  const signedBy = signOff?.[2].trim();
  const me = getUser();
  // The drafted title is a Purchasing one, so it only stays under a Purchasing name.
  const signAsMe = () => signOff && setText(`${text.slice(0, signOff.index)}${signOff[1]},\n${me}${TEAMS.Purchasing.includes(me) && signOff[3] === "\nPurchasing Officer, " ? signOff[3] : signOff[3] ? "\n" : ""}${text.slice(signOff.index + signOff[0].length)}`);

  return (
    <section className="card detail">
      <div className="row between wrap"><span className="small muted">{item.writtenBy ? `Written by ${item.writtenBy} with ${AGENT_NAMES[item.agent]} · ${when(item.createdAt)}` : `${AGENT_NAMES[item.agent]} · drafted ${when(item.createdAt)}`}</span>{pending && item.priority === "high" && <span className="pill warn">Urgent</span>}{shown.status !== "pending" && <span className={`pill ${shown.status === "approved" ? "ok" : "bad"} plain`}>{STATUS_LABEL[shown.status]} by {shown.decidedBy} {shown.decidedAt && when(shown.decidedAt)}</span>}</div>
      <h2>{item.title}</h2>
      <div className="why"><b>{item.writtenBy ? "How this was written" : "Why the assistant drafted this"}</b><p>{item.rationale}</p>
        <div className="chips">{item.sources.map((s) => <span className="chip" key={s.ref + s.label}><b>{s.system}</b> {s.label}</span>)}</div>
      </div>
      {p.type === "social_post" ? (
        <SocialMeta p={p} />
      ) : (
        <div className="meta-grid">
          <div><span>To</span><b>{p.to.name} &lt;{p.to.address}&gt;</b></div>
          <div><span>Supplier</span><b><RecordLink kind="supplier" id={p.supplierId}>{p.supplierName}</RecordLink> ({p.supplierId})</b></div>
          <div><span>Reason</span><b>{{ overdue: "Overdue order", unconfirmed: "Unconfirmed order", low_stock: "Low stock", partial: "Partial delivery", reply: "Reply to their email", new: "New email" }[p.reason]}</b></div>
          {p.purchaseOrder ? <div><span>Purchase order</span><b><RecordLink kind="order" id={p.purchaseOrder}>{p.purchaseOrder}</RecordLink></b></div> : <div><span>Items</span><b>{p.items.map((code, i) => <span key={code}>{i > 0 && ", "}<RecordLink kind="product" id={code}>{code}</RecordLink></span>)}</b></div>}
        </div>
      )}
      {p.type === "supplier_email" && p.inReplyTo && <details className="quoted"><summary>In reply to {p.inReplyTo.from}'s email of {day(p.inReplyTo.receivedDateTime)}: {p.inReplyTo.subject}</summary><KeyFacts sheet={facts?.inReplyTo} of="their email" /><div className="letter-body"><Marked text={p.inReplyTo.body} marks={facts?.inReplyTo?.body} /></div></details>}
      {pending && (!changing || started) ? (
        <div className="letter">
          {p.type === "supplier_email" && <p className="letter-subject"><span className="small muted">Subject</span><Marked text={subject} marks={facts?.draft.subject} /></p>}
          <KeyFacts sheet={facts?.draft} of="this draft" />
          <div className="letter-body">{p.type === "social_post" ? social!.text : <Marked text={text} marks={facts?.draft.body} />}</div>
          {p.type === "social_post" && <>
            <div className="chips">{social!.hashtags.split(/\s+/).filter(Boolean).map((h) => <span className="chip" key={h}>{h}</span>)}</div>
            <p className="small muted">To publish on {p.channel}: {social!.scheduledFor ? when(fromNzInput(social!.scheduledFor)) : "no date picked"}</p>
          </>}
        </div>
      ) : <>
        {adding && <div className="add-to"><b>Add to this email</b>
          <EmailOptions options={options ?? []} isOn={(o) => text.includes(o.text)} onToggle={toggle} onOwn={addPara} tidy={(note) => api("/supplier-emails/tidy", { method: "POST", body: { note, email: text } })} /></div>}
        {p.type === "supplier_email" && <label className="field"><span>Subject</span><input value={subject} disabled={!pending} onChange={(e) => setSubject(e.target.value)} /></label>}
        {p.type === "social_post" ? <SocialFields p={p} edits={social!} onChange={setSocial} pending={pending} /> : (
          <label className="field"><span>Email</span>
            <textarea rows={14} value={text} disabled={!pending} onChange={(e) => setText(e.target.value)} /></label>
        )}
        {/* While it is being changed the email is in a text box, which cannot be highlighted, so its facts are listed under it. */}
        <KeyFacts sheet={facts?.draft} of="this draft" />
      </>}
      {lateReplyBy && <div className="error" role="alert">This email asks for a reply by {lateReplyBy}, which has passed. {started ? "It is already saved as a draft in the purchasing mailbox, so it cannot be changed here. Change the date in that draft first, or send it as it is." : "Change the date before you send it."}</div>}
      {pending && !started && signOff && signedBy && signedBy !== me && <p className="small sign-note">This email is signed <b>{signedBy}</b>, {item.writtenBy === signedBy ? "who wrote it" : "the name the assistant puts on every supplier email"}, and you are approving as <b>{me}</b>. <button type="button" className="link" onClick={signAsMe}>Sign it as {me} instead</button></p>}
      <p className="small muted">Doing this by hand: ~{item.estimate.manualMinutes} min. Reviewing the draft: ~{item.estimate.reviewMinutes} min{item.edited ? " (+4 min for edits)" : ""}.</p>
      {pending && <>
        <label className="field"><span>Note for the team (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you sent it back, or anything the team should know" /></label>
        {problem && <div className="error">{problem}</div>}
        <div className="choices">
          <div>
            <button className="btn primary" disabled={!!problem} onClick={() => act("approve")}>{started ? "Finish approving" : `${p.type === "social_post" ? "Approve" : "Approve and send"}${dirty ? " with your changes" : ""}`}</button>
            <small>{started
              ? "Part of this approval is already done (see What happened below). This finishes the rest; nothing is repeated. The draft can no longer be changed or sent back."
              : p.type === "social_post"
              ? `Adds a task to Marketing's list in ClickUp to publish it${social!.scheduledFor ? ` on ${shortDay(nzDay(fromNzInput(social!.scheduledFor)))}` : ""}, and tells the team on Teams. Nothing is posted to ${p.channel} automatically.`
              : `Emails it to ${p.to.name} at ${p.supplierName} from the Purchasing mailbox, and adds a reminder in ClickUp to chase a reply.`}</small>
          </div>
          {!started && <div>
            {changing || dirty ? <button className="btn" onClick={revert}>Undo my changes</button> : <button className="btn" onClick={() => setChanging(true)}>Change it</button>}
            <small>{changing || dirty ? "Puts the draft back to how the assistant wrote it." : `${p.type === "social_post" ? "Fix the wording, hashtags or date" : "Fix the wording, or pick more for it to say,"} first. Nothing goes out until you approve.`}</small>
          </div>}
          {!started && <div>
            <button className="btn" onClick={() => act("reject")}>Send back</button>
            <small>Nothing goes out and the draft is not used. Add a note so the team knows why.</small>
          </div>}
        </div>
        <p className="small muted">{started ? "You get a few seconds to undo after approving." : "You get a few seconds to undo after approving or sending back."}</p>
      </>}
      {!pending && shown.reviewerNote && <p className="small"><b>Reviewer note:</b> {shown.reviewerNote}</p>}
      {!!shown.outcome?.length && <div className="outcome"><b>What happened</b><ul>{shown.outcome.map((o) => <li key={o.ref}><b>{o.system}:</b> {o.label}</li>)}</ul></div>}
      {p.type === "social_post" && !pending && <SocialFootnote item={shown} edits={social!} />}
    </section>
  );
}
