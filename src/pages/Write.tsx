import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, day, shortDay, type ApprovalItem, type Compose, type EmailOption, type WriteList } from "../api";
import { EmailOptions } from "../components/EmailOptions";
import { RecordLink } from "../components/Record";
import { useApi } from "../useApi";

const TOPIC: Record<WriteList["emails"][number]["topic"], string> = { delay: "Delay", part: "Part shipment", price: "Price change", closure: "Closure", confirmed: "Confirmation", other: "Email" };
const FIRST = 5;

/**
 * Supplier emails on one page: what there is to write about on the left, the email being written on the right.
 * It is saved as a draft to check; nothing is sent from this page.
 */
export default function Write() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const about = { supplier: params.get("supplier") ?? "", order: params.get("order") ?? "", reply: params.get("reply") ?? "", near: params.get("near") ?? "" };
  const query = Object.entries(about).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const { data, error, dataPath } = useApi<Compose>(query ? `/supplier-emails/options?${query}` : null);
  const shown = query && dataPath === `/supplier-emails/options?${query}` ? data : undefined;
  // What is picked on the right is lost when another row is opened, so the list asks first.
  const started = useRef(false);
  const mayGo = () => !started.current || window.confirm("What you picked or typed for this email is not saved. Leave it and start another?");
  const go = (next: Record<string, string>) => { started.current = false; nav(`/write?${new URLSearchParams(Object.entries(next).filter(([, v]) => v))}`); };
  const at = about.reply ? `email:${about.reply}` : shown?.order ? `order:${shown.order.id}` : shown ? `supplier:${shown.supplier.id}` : about.order ? `order:${about.order}` : `supplier:${about.supplier}`;
  return (
    <>
      <div className="page-head"><div><h1>{about.reply ? "Reply to a supplier" : "Write to a supplier"}</h1><p className="muted">Pick an email to answer, an order or a supplier, then pick what the email should say. It then waits in Drafts to check: nothing is sent until someone approves it.</p></div></div>
      <div className={`work write-work ${query ? "has-sel" : ""}`}>
        <Starts at={query ? at : ""} onPick={(next) => { if (mayGo()) go(next); }} />
        <div className="work-detail">
          <button type="button" className="link back" onClick={() => { if (mayGo()) go({}); }}>‹ Back to the emails and orders</button>
          {!query && <section className="card write-none"><h2>Who are you writing to?</h2><p className="muted">Pick a supplier's email to answer it, a late order to chase it, or search for any supplier or order. What the email can say appears here, with the email beside it.</p></section>}
          {query && error && <div className="error">{error}</div>}
          {query && !error && !shown && <p className="muted">Reading the order and the supplier's emails…</p>}
          {shown && <Composer key={query} data={shown} about={about} onStarted={(on) => { started.current = on; }} onOrder={(order) => { if (mayGo()) go(about.reply ? { reply: about.reply, near: about.near, order } : { supplier: shown.supplier.id, order }); }} />}
        </div>
      </div>
    </>
  );
}

/** The left side: supplier emails nobody has answered, late orders, and every supplier. The box finds any of them, and orders that are not late, with the suppliers it finds first. */
function Starts({ at, onPick }: { at: string; onPick: (next: Record<string, string>) => void }) {
  const { data, error, reload } = useApi<WriteList>("/supplier-emails/starts");
  const [q, setQ] = useState("");
  const [all, setAll] = useState<string[]>([]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const has = (...text: (string | undefined)[]) => words.every((w) => text.join(" ").toLowerCase().includes(w));
  const groups = !data ? [] : [
    { name: "Emails to answer", rows: data.emails.filter((e) => (words.length ? has(e.supplier, e.from, e.subject, e.order, TOPIC[e.topic]) : e.toAnswer || `email:${e.id}` === at)).map((e) => ({ key: `email:${e.id}`, to: { reply: e.id }, title: e.supplier, pill: TOPIC[e.topic], tone: e.topic === "delay" ? "warn" : "", sub: `${e.subject.replace(/^re:\s*/i, "")} · ${shortDay(e.at)}`, draft: e.draft })) },
    { name: words.length ? "Orders still to arrive" : "Late orders", rows: data.orders.filter((o) => (words.length ? has(o.id, o.supplier, o.status) : o.daysLate > 0 || `order:${o.id}` === at)).map((o) => ({ key: `order:${o.id}`, to: { order: o.id }, title: o.id, pill: o.daysLate ? `${o.daysLate} ${o.daysLate === 1 ? "day" : "days"} late` : o.status, tone: o.daysLate ? "warn" : "", sub: `${o.supplier} · ${o.due ? `due ${shortDay(o.due)}` : "no due date yet"}`, draft: o.draft })) },
    { name: "Suppliers", rows: data.suppliers.filter((s) => has(s.name, s.contact, s.id)).map((s) => ({ key: `supplier:${s.id}`, to: { supplier: s.id }, title: s.name, pill: "", tone: "", sub: `${s.contact} · ${s.open ? `${s.open} open ${s.open === 1 ? "order" : "orders"}` : "no open orders"}`, draft: false })) },
  ].filter((g) => g.rows.length).sort((a, b) => (words.length ? Number(b.name === "Suppliers") - Number(a.name === "Suppliers") : 0));
  useEffect(() => { document.querySelector(".write-work .sel")?.scrollIntoView({ block: "nearest" }); }, [at, !!data]);
  return (
    <div className="work-list card flush" aria-label="What to write about">
      <div className="write-find"><input type="search" value={q} placeholder="Find a supplier or an order" aria-label="Find a supplier, an order or an email" onChange={(e) => setQ(e.target.value)} /></div>
      {error && <div className="error">{error} <button type="button" className="link" onClick={reload}>Try again</button></div>}
      {!data && !error && <p className="muted pad">Reading the inbox and the orders…</p>}
      {data && !groups.length && <p className="muted pad">Nothing matches “{q.trim()}”. <button type="button" className="link" onClick={() => setQ("")}>Show them all</button></p>}
      {groups.map((g) => {
        // A search shows everything it finds; otherwise the first few, and always the one that is open.
        const open = words.length > 0 || all.includes(g.name) || g.rows.length <= FIRST + 1, rows = open ? g.rows : g.rows.filter((r, i) => i < FIRST || r.key === at);
        return (
          <div key={g.name} role="group" aria-label={g.name}>
            <div className="search-group">{g.name} <span className="count">{g.rows.length}</span></div>
            {rows.map((r) => (
              <button type="button" key={r.key} className={`list-row ${r.key === at ? "sel" : ""}`} aria-current={r.key === at} onClick={() => { if (r.key !== at) onPick(r.to); }}>
                <span className="title">{r.title}</span>
                <span className="small muted">{r.draft ? <span className="pill plain ok">Draft waiting</span> : r.pill && <span className={`pill plain ${r.tone}`}>{r.pill}</span>}{r.sub}</span>
              </button>
            ))}
            {!open && <button type="button" className="link write-more" onClick={() => setAll((a) => [...a, g.name])}>Show all {g.rows.length}</button>}
          </div>
        );
      })}
    </div>
  );
}

function Composer({ data, about, onOrder, onStarted }: { data: Compose; about: { supplier: string; order: string; reply: string; near: string }; onOrder: (order: string) => void; onStarted: (on: boolean) => void }) {
  const nav = useNavigate();
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string>();
  const chosen = data.options.filter((o) => picked.includes(o.id));
  const body = [data.greeting, ...chosen.map((o) => o.text), ...own, data.sign].join("\n\n");
  const topic = chosen[0]?.topic;
  const subject = data.replyTo || !topic ? data.subject : data.order ? `${data.order.id} — ${topic}` : `${topic[0].toUpperCase()}${topic.slice(1)}`;
  const empty = !chosen.length && !own.length;
  const [typing, setTyping] = useState(false);
  useEffect(() => onStarted(!empty || typing), [empty, typing]);
  const toggle = (o: EmailOption) => setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
  async function save() {
    setSaving(true); setFailed(undefined);
    try {
      const a = await api<ApprovalItem>("/supplier-emails", { method: "POST", body: { ...about, order: data.order?.id ?? "", options: picked, own } });
      nav(`/approvals/${a.id}?agent=supplier-outreach`);
    } catch (e) { setFailed(e instanceof Error ? e.message : String(e)); setSaving(false); }
  }
  return (
    <div className="write">
      <section className="card">
        <div className="meta-grid">
          <div><span>To</span><b>{data.to.name} &lt;{data.to.address}&gt;</b></div>
          <div><span>Supplier</span><b><RecordLink kind="supplier" id={data.supplier.id}>{data.supplier.name}</RecordLink></b></div>
          <div><span>Purchase order</span><select aria-label="Purchase order" value={data.order?.id ?? ""} disabled={!empty} title={empty ? undefined : "Take out what you picked to change the order"} onChange={(e) => onOrder(e.target.value)}><option value="">{data.replyTo ? "The one their email names, if any" : "No particular order"}</option>{data.orders.map((o) => <option key={o.id} value={o.id}>{o.id} · {o.status}</option>)}{data.order && !data.orders.some((o) => o.id === data.order!.id) && <option value={data.order.id}>{data.order.id} · {data.order.status}</option>}</select></div>
        </div>
        {data.replyTo && <details className="quoted" open><summary>{data.replyTo.from} wrote on {day(data.replyTo.receivedDateTime)}: {data.replyTo.subject}</summary><div className="letter-body">{data.replyTo.body}</div></details>}
        {data.waiting && <div className="banner" role="status">A draft about this is already waiting to be checked: <Link to={`/approvals/${data.waiting.id}?agent=supplier-outreach`}>{data.waiting.title}</Link>. You can add to that one instead of writing another.</div>}
        <h2>What do you want to say?</h2>
        <p className="small muted">{data.options.length ? "Pick as many as you need. Each one adds its words to the email." : "Nothing about this order or supplier suggests itself, so write your own line below."}</p>
        <EmailOptions options={data.options} isOn={(o) => picked.includes(o.id)} onToggle={toggle} onOwn={(text) => setOwn((l) => [...l, text])} onTyping={setTyping}
          tidy={(note) => api("/supplier-emails/tidy", { method: "POST", body: { note, email: body } })}>
          {own.map((line, i) => <div className="own-added" key={i}><span>{line}</span><button type="button" className="link" onClick={() => setOwn((l) => l.filter((_, at) => at !== i))} aria-label="Take this line out">Take out</button></div>)}
        </EmailOptions>
      </section>
      <section className="card">
        <h2>The email</h2>
        <div className={`letter ${empty ? "empty" : ""}`} aria-live="polite">
          <p className="letter-subject"><span className="small muted">Subject</span>{subject}</p>
          <div className="letter-body">{body}</div>
        </div>
        {failed && <div className="error" role="alert">{failed}</div>}
        <div className="row gap wrap">
          <button type="button" className="btn primary" disabled={empty || saving} onClick={save}>{saving ? "Saving…" : "Put it in Drafts to check"}</button>
          <small className="muted">{empty ? "Pick something to say first." : "Nothing is sent yet. You can still change the wording there, and it goes out only when it is approved."}</small>
        </div>
      </section>
    </div>
  );
}
