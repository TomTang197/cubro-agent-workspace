import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AGENT_NAMES, STAFF, day, when, type ActivityLine } from "../api";
import { useApi } from "../useApi";

const VERB: Record<ActivityLine["kind"], string> = { approved: "approved", sent_back: "sent back", asked: "asked for drafts", changed: "changed a draft", admin: "changed the workspace" };
const KINDS: { id: ActivityLine["kind"] | ""; label: string }[] = [{ id: "", label: "Everything" }, { id: "approved", label: "Approved" }, { id: "sent_back", label: "Sent back" }, { id: "asked", label: "Asked for drafts" }];
const systemsOf = (a: ActivityLine) => [...new Set(a.went.map((w) => w.system))];

/** The record of who did what: every approval with the systems it went to, every draft sent back, every request for drafts. */
export default function Activity() {
  const { data, error, reload } = useApi<ActivityLine[]>("/activity/record");
  const [kind, setKind] = useState<ActivityLine["kind"] | "">("");
  const [who, setWho] = useState("");
  const [system, setSystem] = useState("");
  const [q, setQ] = useState("");
  const [oldest, setOldest] = useState(false);
  const [picked, setPicked] = useState<string>();
  const people = useMemo(() => [...new Set([...STAFF, ...(data ?? []).map((a) => a.actor)])], [data]);
  const systems = useMemo(() => [...new Set((data ?? []).flatMap(systemsOf))].sort(), [data]);
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const found = (data ?? []).filter((a) => (!kind || a.kind === kind) && (!who || a.actor === who) && (!system || systemsOf(a).includes(system)) && words.every((w) => `${a.actor} ${a.what} ${a.note ?? ""}`.toLowerCase().includes(w)));
    return oldest ? [...found].reverse() : found;
  }, [data, kind, who, system, q, oldest]);
  const shown = rows.find((a) => a.id === picked) ?? rows[0];
  return (
    <>
      <div className="page-head"><div><h1>Activity</h1><p className="muted">The record of who approved what and which system it went to. Nothing leaves Cubro without a name against it here.</p></div></div>
      <div className="toolbar">
        <div className="seg">{KINDS.map((k) => <button key={k.id} type="button" className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>{k.label}</button>)}</div>
        <select aria-label="Who" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{people.map((p) => <option key={p}>{p}</option>)}</select>
        <select aria-label="Which system it went to" value={system} onChange={(e) => setSystem(e.target.value)}><option value="">Any system</option>{systems.map((s) => <option key={s} value={s}>Went to {s}</option>)}</select>
        <input type="search" placeholder="Find a supplier, order or post" aria-label="Find in the activity record" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Order" value={oldest ? "oldest" : "newest"} onChange={(e) => setOldest(e.target.value === "oldest")}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
        {data && <span className="small muted count-of">{rows.length === data.length ? `${data.length} entries` : `${rows.length} of ${data.length}`}</span>}
      </div>
      {error && <div className="error">{error} <button type="button" className="link" onClick={reload}>Try again</button></div>}
      <div className={`work ${picked ? "has-sel" : ""}`}>
        <div className="work-list card flush" role="list" aria-label="Activity">
          {!data && !error && <p className="muted pad">Loading…</p>}
          {data && rows.length === 0 && <p className="muted pad">Nothing matches. <button type="button" className="link" onClick={() => { setKind(""); setWho(""); setSystem(""); setQ(""); }}>Show everything</button></p>}
          {rows.map((a) => (
            <button type="button" role="listitem" key={a.id} className={`list-row ${shown?.id === a.id ? "sel" : ""}`} aria-current={shown?.id === a.id} onClick={() => setPicked(a.id)}>
              <div className="row between gap"><span className="small muted">{when(a.at)}</span><span className={`pill plain ${a.partial ? "warn" : a.kind === "approved" ? "ok" : a.kind === "sent_back" ? "bad" : ""}`}>{a.partial ? "Part done" : KINDS.find((k) => k.id === a.kind)?.label ?? "Change"}</span></div>
              <div className="title"><b>{a.actor}</b> {VERB[a.kind]}</div>
              <div className="small">{a.what}</div>
              {a.went.length > 0 && <div className="went">{systemsOf(a).map((s) => <span className="chip" key={s}>→ {s}</span>)}</div>}
            </button>
          ))}
        </div>
        <div className="work-detail card">
          <button type="button" className="link back" onClick={() => setPicked(undefined)}>‹ Back to the activity record</button>
          {shown ? <>
            <header className="record-head"><div>
              <span className="small muted">{day(shown.at)} · {when(shown.at)}{shown.agent && ` · ${AGENT_NAMES[shown.agent]}`}</span>
              <h2>{shown.actor} {shown.partial ? "started approving" : VERB[shown.kind]}</h2>
              <p>{shown.what}</p>
            </div></header>
            {shown.kind === "approved" && <section className="linked-group"><h3>Where it went</h3>
              {shown.went.map((w, i) => <div className="linked" key={i}><span><span className="linked-title">{w.system}</span><span className="small muted">{w.label}</span></span><span className="pill plain ok">Done</span></div>)}</section>}
            {shown.partial && <p className="error" role="status">Only part of this approval went through: the next step failed. Open the draft and approve it again to finish. What is already done will not be repeated.</p>}
            {shown.kind === "sent_back" && <p className="muted">Nothing went out. The draft was not used.</p>}
            {shown.kind === "asked" && <p className="muted">The drafts wait in Drafts to check until a person approves them. Nothing went to a supplier, customer or social channel.</p>}
            {shown.note && <p><b>Note for the team:</b> {shown.note}</p>}
            {shown.approvalId && <p className="record-foot"><Link className="btn" to={`/approvals/${shown.approvalId}?status=all&view=list&agent=all`}>Open the draft</Link></p>}
            {shown.kind === "asked" && shown.agent && <p className="record-foot"><Link className="btn" to={`/approvals?agent=${shown.agent}`}>See the drafts waiting</Link></p>}
          </> : data && <p className="muted">Pick an entry from the list.</p>}
        </div>
      </div>
    </>
  );
}
