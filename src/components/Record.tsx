import { useEffect, useRef } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { RECORD_KINDS, type LinkedItem, type RecordDetail, type RecordKind } from "../api";
import { useApi } from "../useApi";

const STATUS_TONE: Record<string, string> = { Approved: "ok", Received: "ok", Closed: "ok", "Closed Won": "ok", complete: "ok", "In stock": "ok", "Sent back": "bad", "Closed Lost": "bad", Overdue: "warn", "Low stock": "warn", Waiting: "warn" };
const tone = (status?: string, given?: string) => given ?? (status ? STATUS_TONE[status] ?? (/overdue/.test(status) ? "warn" : "") : "");
export const kindLabel = (kind: string) => RECORD_KINDS.find((k) => k.kind === kind)?.one ?? "Draft";

/** Where a record opens: on top of whatever page is showing, so going back closes it. */
export function useRecordLink() {
  const { pathname, search } = useLocation();
  return (kind: RecordKind, id: string) => { const p = new URLSearchParams(search); p.set("record", `${kind}:${id}`); return `${pathname}?${p}`; };
}

/** Any mention of a supplier, order, customer or product. Clicking it opens that record on the right. */
export function RecordLink({ kind, id, children, className }: { kind: RecordKind; id: string; children: React.ReactNode; className?: string }) {
  const to = useRecordLink();
  return <Link className={className ?? "record-link"} to={to(kind, id)} title={`Open this ${kindLabel(kind).toLowerCase()}`}>{children}</Link>;
}

function Linked({ item, order }: { item: LinkedItem; order?: string }) {
  const body = <><span className="linked-title">{item.title}</span>{item.subtitle && <span className="small muted">{item.subtitle}</span>}</>;
  const status = item.status && <span className={`pill plain ${tone(item.status)}`}>{item.status}</span>;
  if (item.kind === "draft") return <Link className="linked go" to={`/approvals/${item.id}?status=all&view=list&agent=all`}><span>{body}</span>{status}</Link>;
  if (item.kind && item.id) return <RecordLink className="linked go" kind={item.kind} id={item.id}><span>{body}</span>{status}</RecordLink>;
  return <div className="linked"><span>{body}</span><span className="row gap">{item.reply && <Link className="btn small" to={`/write?reply=${encodeURIComponent(item.reply)}${order ? `&order=${encodeURIComponent(order)}` : ""}`}>Reply</Link>}{status}</span></div>;
}

/** One record with everything the other systems hold about it. */
export function RecordView({ kind, id, onClose, page }: { kind: RecordKind; id: string; onClose?: () => void; page?: boolean }) {
  const { data, error, loading, reload, dataPath } = useApi<RecordDetail>(`/records/${kind}/${encodeURIComponent(id)}`);
  const d = dataPath === `/records/${kind}/${encodeURIComponent(id)}` ? data : undefined;
  return (
    <>
      <header className="record-head">
        <div>
          <span className="small muted">{kindLabel(kind)}{d && ` · from ${d.system}`}</span>
          <h2>{d?.title ?? (error ? "Not found" : "Opening…")}</h2>
          {d && <p className="small muted">{d.subtitle}</p>}
        </div>
        <div className="row gap">
          {d?.status && <span className={`pill plain ${tone(d.status, d.tone)}`}>{d.status}</span>}
          {onClose && <button type="button" className="ghost close" onClick={onClose} aria-label="Close">✕</button>}
        </div>
      </header>
      {error && <div className="error">{error} <button type="button" className="link" onClick={reload}>Try again</button></div>}
      {!d && !error && loading && <p className="muted">Looking it up in the four systems…</p>}
      {d && <>
        {(kind === "supplier" || (kind === "order" && d.status !== "Received" && d.status !== "Closed")) && <p className="record-act"><Link className="btn" to={`/write?${kind}=${encodeURIComponent(id)}`}>{kind === "supplier" ? "Write to this supplier" : "Write to the supplier about this order"}</Link></p>}
        <dl className="facts">{d.fields.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
        {d.links.length === 0 && <p className="muted small">Nothing in the other systems mentions this yet.</p>}
        {d.links.map((l) => (
          <section className="linked-group" key={l.label}>
            <h3>{l.label} <span className="count">{l.items.length}</span><span className="from">{l.system}</span></h3>
            {l.items.map((item, i) => <Linked key={`${item.id ?? item.title}-${i}`} item={item} order={kind === "order" ? id : undefined} />)}
          </section>
        ))}
        {!page && <p className="record-foot"><Link to={`/records/${kind}/${encodeURIComponent(id)}`}>Open in the {RECORD_KINDS.find((k) => k.kind === kind)!.label.toLowerCase()} list</Link></p>}
      </>}
    </>
  );
}

/** The record opened by a click anywhere in the workspace, shown on the right over the page. */
export function RecordPanel() {
  const [params, setParams] = useSearchParams();
  const panel = useRef<HTMLElement>(null);
  const [kind, ...rest] = (params.get("record") ?? "").split(":");
  const id = rest.join(":");
  const open = RECORD_KINDS.some((k) => k.kind === kind) && !!id;
  const close = () => { const p = new URLSearchParams(params); p.delete("record"); setParams(p); };
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, kind, id]);
  if (!open) return null;
  return (
    <>
      <div className="panel-back" onClick={close} aria-hidden="true" />
      <aside className="record-panel" ref={panel} tabIndex={-1} role="dialog" aria-label={`${kindLabel(kind)} details`}>
        <RecordView key={`${kind}:${id}`} kind={kind as RecordKind} id={id} onClose={close} />
      </aside>
    </>
  );
}
