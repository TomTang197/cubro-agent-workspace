import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, day, type ApprovalItem, type Compose, type EmailOption, type RecordRow } from "../api";
import { EmailOptions } from "../components/EmailOptions";
import { RecordLink } from "../components/Record";
import { useApi } from "../useApi";

/** A supplier email written by picking what it should say. It is saved as a draft to check; nothing is sent from this page. */
export default function Write() {
  const [params, setParams] = useSearchParams();
  const about = { supplier: params.get("supplier") ?? "", order: params.get("order") ?? "", reply: params.get("reply") ?? "", near: params.get("near") ?? "" };
  const query = Object.entries(about).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const { data: suppliers, error: listError } = useApi<RecordRow[]>(query ? null : "/records/supplier");
  const { data, error, dataPath } = useApi<Compose>(query ? `/supplier-emails/options?${query}` : null);
  const shown = dataPath === `/supplier-emails/options?${query}` ? data : undefined;
  const go = (next: Record<string, string>) => setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)));
  return (
    <>
      <div className="page-head"><div><h1>{about.reply ? "Reply to a supplier" : "Write to a supplier"}</h1><p className="muted">Pick what the email should say and it is written for you. It then waits in Drafts to check: nothing is sent until someone approves it.</p></div></div>
      {!query && <section className="card one">
        <label className="field"><span>Who are you writing to?</span>
          <select value="" disabled={!suppliers} onChange={(e) => go({ supplier: e.target.value })}><option value="">{suppliers ? "Pick a supplier" : "Loading…"}</option>{[...(suppliers ?? [])].sort((a, b) => a.title.localeCompare(b.title)).map((s) => <option key={s.id} value={s.id}>{s.title}{s.status && s.status !== "No open orders" ? ` (${s.status})` : ""}</option>)}</select></label>
        <p className="small muted">To answer an email a supplier sent, open the supplier or the purchase order and choose Reply beside their email.</p>
        {listError && <div className="error">{listError}</div>}
      </section>}
      {query && error && <div className="error">{error} <Link to="/write">Pick a supplier instead</Link></div>}
      {query && !error && !shown && <p className="muted">Reading the order and the supplier's emails…</p>}
      {shown && <Composer key={query} data={shown} about={about} onOrder={(order) => go(about.reply ? { reply: about.reply, order } : { supplier: shown.supplier.id, order })} />}
    </>
  );
}

function Composer({ data, about, onOrder }: { data: Compose; about: { supplier: string; order: string; reply: string; near: string }; onOrder: (order: string) => void }) {
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
          <div><span>Supplier</span><b><RecordLink kind="supplier" id={data.supplier.id}>{data.supplier.name}</RecordLink>{!data.replyTo && <> · <Link to="/write">change</Link></>}</b></div>
          <div><span>Purchase order</span><select aria-label="Purchase order" value={data.order?.id ?? ""} disabled={!empty} title={empty ? undefined : "Take out what you picked to change the order"} onChange={(e) => onOrder(e.target.value)}><option value="">{data.replyTo ? "The one their email names, if any" : "No particular order"}</option>{data.orders.map((o) => <option key={o.id} value={o.id}>{o.id} · {o.status}</option>)}{data.order && !data.orders.some((o) => o.id === data.order!.id) && <option value={data.order.id}>{data.order.id} · {data.order.status}</option>}</select></div>
        </div>
        {data.replyTo && <details className="quoted" open><summary>{data.replyTo.from} wrote on {day(data.replyTo.receivedDateTime)}: {data.replyTo.subject}</summary><div className="letter-body">{data.replyTo.body}</div></details>}
        {data.waiting && <div className="banner" role="status">A draft about this is already waiting to be checked: <Link to={`/approvals/${data.waiting.id}?agent=supplier-outreach`}>{data.waiting.title}</Link>. You can add to that one instead of writing another.</div>}
        <h2>What do you want to say?</h2>
        <p className="small muted">{data.options.length ? "Pick as many as you need. Each one adds its words to the email on the right." : "Nothing about this order or supplier suggests itself, so write your own line below."}</p>
        <EmailOptions options={data.options} isOn={(o) => picked.includes(o.id)} onToggle={toggle} onOwn={(text) => setOwn((l) => [...l, text])}
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
