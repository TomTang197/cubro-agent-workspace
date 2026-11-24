import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { RECORD_KINDS, type RecordKind, type RecordRow } from "../api";
import { RecordView } from "../components/Record";
import { useApi } from "../useApi";
import NotFound from "./NotFound";

const ABOUT: Record<RecordKind, string> = {
  supplier: "Everyone Cubro buys from, from Infor LN. Pick one to see its orders, the emails about them and the tasks to chase.",
  order: "Every purchase order in Infor LN. Pick one to see its supplier, what is on it, and the emails and tasks about it.",
  customer: "Hospitals, care homes and partners, from Salesforce. Pick one to see its contacts, open deals, cases and emails.",
  product: "What Cubro sells, with the stock on hand in Infor LN. Pick one to see who supplies it, what is on order and who asked about it.",
};
type Filter = { label: string; test: (r: RecordRow) => boolean };
const arrived = (r: RecordRow) => r.status === "Received" || r.status === "Closed";
const FILTERS: Record<RecordKind, Filter[]> = {
  supplier: [{ label: "With open orders", test: (r) => Number(r.sort["Open orders"]) > 0 }, { label: "With overdue orders", test: (r) => r.tone === "warn" }],
  order: [{ label: "Still to arrive", test: (r) => !arrived(r) }, { label: "Overdue", test: (r) => r.status === "Overdue" }, { label: "Arrived", test: arrived }],
  customer: [],
  product: [{ label: "Low stock", test: (r) => r.status === "Low stock" }, { label: "In stock", test: (r) => r.status === "In stock" }],
};
const START: Record<RecordKind, { by: string; down: boolean }> = { supplier: { by: "Name", down: false }, order: { by: "Due date", down: true }, customer: { by: "Name", down: false }, product: { by: "Name", down: false } };
const MAX = 150;
const order = (by: string, sample: string | number | undefined) => (typeof sample === "number" ? ["Smallest first", "Largest first"] : /date/i.test(by) ? ["Earliest first", "Latest first"] : ["A to Z", "Z to A"]);

export default function Records() {
  const { kind } = useParams();
  return RECORD_KINDS.some((k) => k.kind === kind) ? <Table key={kind} kind={kind as RecordKind} /> : <NotFound />;
}

function Table({ kind }: { kind: RecordKind }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<RecordRow[]>(`/records/${kind}`);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [by, setBy] = useState(START[kind].by);
  const [down, setDown] = useState(START[kind].down);
  const names = RECORD_KINDS.find((k) => k.kind === kind)!;
  // Customers are filtered by the market they are in, which comes from the data.
  const filters = useMemo<Filter[]>(() => (kind === "customer" ? [...new Set((data ?? []).map((r) => r.status).filter(Boolean))].sort().map((m) => ({ label: m!, test: (r: RecordRow) => r.status === m })) : FILTERS[kind]), [kind, data]);
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean), test = filters.find((f) => f.label === filter)?.test;
    const found = (data ?? []).filter((r) => (!test || test(r)) && words.every((w) => `${r.title} ${r.subtitle} ${r.id} ${r.status ?? ""}`.toLowerCase().includes(w)));
    return found.sort((a, b) => { const x = a.sort[by], y = b.sort[by]; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * (down ? -1 : 1); });
  }, [data, q, filter, filters, by, down]);
  const shown = id ?? rows[0]?.id;
  const keys = Object.keys(data?.[0]?.sort ?? { [by]: "" });
  const [up, dn] = order(by, data?.[0]?.sort[by]);
  useEffect(() => { document.querySelector(".work-list .sel")?.scrollIntoView({ block: "nearest" }); }, [id, !!data]);
  return (
    <>
      <div className="page-head"><div><h1>{names.label}</h1><p className="muted">{ABOUT[kind]}</p></div></div>
      <div className="toolbar">
        <input type="search" placeholder={`Find in ${names.label.toLowerCase()}`} aria-label={`Find in ${names.label.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />
        {filters.length > 0 && <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">{kind === "customer" ? "All markets" : `All ${names.label.toLowerCase()}`}</option>{filters.map((f) => <option key={f.label}>{f.label}</option>)}</select>}
        <label className="sort"><span className="small muted">Sort by</span>
          <select aria-label="Sort by" value={by} onChange={(e) => setBy(e.target.value)}>{keys.map((k) => <option key={k}>{k}</option>)}</select></label>
        <select aria-label="Order" value={down ? "down" : "up"} onChange={(e) => setDown(e.target.value === "down")}><option value="up">{up}</option><option value="down">{dn}</option></select>
        {data && <span className="small muted count-of">{rows.length === data.length ? `${data.length} ${names.label.toLowerCase()}` : `${rows.length} of ${data.length}`}</span>}
      </div>
      {error && <div className="error">{error} <button type="button" className="link" onClick={reload}>Try again</button></div>}
      <div className={`work ${id ? "has-sel" : ""}`}>
        <div className="work-list card flush" role="list" aria-label={names.label}>
          {!data && loading && <p className="muted pad">Loading…</p>}
          {data && rows.length === 0 && <p className="muted pad">Nothing matches. <button type="button" className="link" onClick={() => { setQ(""); setFilter(""); }}>Show them all</button></p>}
          {rows.slice(0, MAX).map((r) => (
            <Link role="listitem" key={r.id} to={`/records/${kind}/${encodeURIComponent(r.id)}`} className={`list-row ${shown === r.id ? "sel" : ""}`} aria-current={shown === r.id}>
              <div className="row between gap"><span className="title">{r.title}</span>{r.status && <span className={`pill plain ${r.tone ?? ""}`}>{r.status}</span>}</div>
              <div className="small muted">{r.subtitle}</div>
            </Link>
          ))}
          {rows.length > MAX && <p className="muted small pad">Showing the first {MAX}. Type in the box above to narrow it down.</p>}
        </div>
        <div className="work-detail card">
          <button type="button" className="link back" onClick={() => nav(`/records/${kind}`)}>‹ Back to {names.label.toLowerCase()}</button>
          {shown ? <RecordView key={shown} kind={kind} id={shown} page /> : data && <p className="muted">Pick one from the list.</p>}
        </div>
      </div>
    </>
  );
}
