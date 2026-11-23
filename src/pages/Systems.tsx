import { useMemo, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { api, day, nzd, when, type ConnectorStatus } from "../api";
import { useApi } from "../useApi";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Names for the codes other systems refer to, so staff read "Ningbo Kanghui Care Bed Co." rather than "SUP1001". */
type Names = { supplier: (code: string) => string; account: (id: string) => string; product: (code: string) => string };
type Col = { h: string; v: (r: Row, n: Names) => React.ReactNode; num?: boolean };
type Resource = { label: string; path: string; noun: string; cols: Col[] };

const money = (n: number, currency: string) => n.toLocaleString("en-NZ", { style: "currency", currency, maximumFractionDigits: 0 });
const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "") || "—";
const pill = (text: string, tone = "") => <span className={`pill ${tone}`}>{text}</span>;
const STATUS_TONE: Record<string, string> = { complete: "ok", Closed: "ok", Received: "ok", "Closed Won": "ok", Completed: "ok", "Closed Lost": "bad", Complaint: "bad", urgent: "bad", review: "warn", "Partially received": "warn", high: "warn" };
const status = (s?: string) => (s ? pill(s, STATUS_TONE[s] ?? "") : "—");

const RESOURCES: Record<string, Resource[]> = {
  m365: [
    { label: "Calendar", path: "m365/events", noun: "events", cols: [{ h: "Starts", v: (r) => when(r.start) }, { h: "Event", v: (r) => r.subject }, { h: "Type", v: (r) => r.category }, { h: "Location", v: (r) => r.location }, { h: "Organiser", v: (r) => r.organizer }] },
    { label: "Mail", path: "m365/messages", noun: "emails", cols: [{ h: "Date", v: (r) => when(r.receivedDateTime) }, { h: "Folder", v: (r) => r.folder }, { h: "From", v: (r) => r.from.name }, { h: "To", v: (r) => r.to.map((t: Row) => t.name || t.address).join(", ") }, { h: "Subject", v: (r) => r.subject }] },
    { label: "SharePoint files", path: "m365/assets", noun: "files", cols: [{ h: "File", v: (r) => r.name }, { h: "Kind", v: (r) => r.kind }, { h: "Product", v: (r, n) => (r.productSku ? n.product(r.productSku) : "—") }, { h: "Tags", v: (r) => list(r.tags) }] },
    { label: "Teams posts", path: "m365/teams", noun: "posts", cols: [{ h: "Posted", v: (r) => when(r.createdDateTime) }, { h: "Channel", v: (r) => r.channel }, { h: "From", v: (r) => r.from ?? "Agent workspace" }, { h: "Message", v: (r) => r.text }] },
  ],
  salesforce: [
    { label: "Accounts", path: "salesforce/accounts", noun: "accounts", cols: [{ h: "Account", v: (r) => r.Name }, { h: "Type", v: (r) => r.Type }, { h: "Market", v: (r) => r.Market__c ?? "—" }, { h: "City", v: (r) => r.BillingCity }, { h: "Region", v: (r) => r.Region }, { h: "Account owner", v: (r) => r.OwnerName }, { h: "Annual spend", v: (r) => nzd(r.AnnualSpend__c), num: true }] },
    { label: "Contacts", path: "salesforce/contacts", noun: "contacts", cols: [{ h: "Name", v: (r) => r.Name }, { h: "Role", v: (r) => r.Title }, { h: "Account", v: (r, n) => n.account(r.AccountId) }, { h: "Email", v: (r) => r.Email }, { h: "Phone", v: (r) => r.Phone }] },
    { label: "Opportunities", path: "salesforce/opportunities", noun: "opportunities", cols: [{ h: "Opportunity", v: (r) => r.Name }, { h: "Stage", v: (r) => status(r.StageName) }, { h: "Close date", v: (r) => day(r.CloseDate) }, { h: "Owner", v: (r) => r.OwnerName ?? "—" }, { h: "Products", v: (r) => list(r.ProductSkus) }, { h: "Amount", v: (r) => nzd(r.Amount), num: true }] },
    { label: "Campaigns", path: "salesforce/campaigns", noun: "campaigns", cols: [{ h: "Campaign", v: (r) => r.Name }, { h: "Type", v: (r) => r.Type }, { h: "Status", v: (r) => status(r.Status) }, { h: "Dates", v: (r) => `${day(r.StartDate)} – ${day(r.EndDate)}` }, { h: "Audience", v: (r) => r.Audience }, { h: "Products", v: (r) => list(r.ProductSkus) }] },
    { label: "Cases", path: "salesforce/cases", noun: "cases", cols: [{ h: "Opened", v: (r) => day(r.CreatedDate) }, { h: "Type", v: (r) => status(r.Type) }, { h: "Status", v: (r) => r.Status ?? "—" }, { h: "Subject", v: (r) => r.Subject }, { h: "Account", v: (r, n) => n.account(r.AccountId) }, { h: "Product", v: (r, n) => n.product(r.ProductSku) }, { h: "Owner", v: (r) => r.OwnerName ?? "—" }] },
    { label: "Logged activity", path: "salesforce/activities", noun: "activities", cols: [{ h: "Logged", v: (r) => when(r.CreatedDate) }, { h: "Subject", v: (r) => r.Subject }, { h: "Detail", v: (r) => r.Description }, { h: "By", v: (r) => r.OwnerName ?? "Agent workspace" }] },
  ],
  clickup: [
    { label: "Tasks", path: "clickup/tasks", noun: "tasks", cols: [{ h: "List", v: (r) => r.list }, { h: "Task", v: (r) => r.name }, { h: "Status", v: (r) => status(r.status) }, { h: "Priority", v: (r) => status(r.priority) }, { h: "Assigned to", v: (r) => list(r.assignees) }, { h: "Due", v: (r) => (r.due_date ? day(r.due_date) : "—") }, { h: "Tags", v: (r) => list(r.tags) }] },
  ],
  inforln: [
    { label: "Items", path: "inforln/items", noun: "items", cols: [{ h: "Code", v: (r) => r.item }, { h: "Description", v: (r) => r.description }, { h: "Group", v: (r) => r.itemGroup }, { h: "On hand", v: (r) => <>{r.onHand < r.reorderPoint && pill("Low", "warn")} {r.onHand}</>, num: true }, { h: "Reorder point", v: (r) => r.reorderPoint, num: true }, { h: "Monthly demand", v: (r) => r.avgMonthlyDemand, num: true }, { h: "Supplier", v: (r, n) => n.supplier(r.primarySupplier) }, { h: "List price", v: (r) => nzd(r.unitPrice), num: true }] },
    { label: "Suppliers", path: "inforln/suppliers", noun: "suppliers", cols: [{ h: "Supplier", v: (r) => r.name }, { h: "Code", v: (r) => r.supplier }, { h: "Location", v: (r) => [r.city, r.country].filter(Boolean).join(", ") }, { h: "Contact", v: (r) => r.contactName }, { h: "Email", v: (r) => r.email }, { h: "Payment terms", v: (r) => r.paymentTerms }, { h: "Currency", v: (r) => r.currency ?? "—" }, { h: "Lead time", v: (r) => `${r.avgLeadTimeDays} days`, num: true }, { h: "On time", v: (r) => `${Math.round(r.onTimeRate * 100)}%`, num: true }] },
    { label: "Purchase orders", path: "inforln/purchase-orders", noun: "purchase orders", cols: [{ h: "Order", v: (r) => r.order }, { h: "Supplier", v: (r, n) => n.supplier(r.supplier) }, { h: "Ordered", v: (r) => day(r.orderDate) }, { h: "Due", v: (r) => day(r.confirmedReceiptDate ?? r.plannedReceiptDate) }, { h: "Status", v: (r) => status(r.status) }, { h: "Lines", v: (r) => r.lines.length, num: true }, { h: "Value", v: (r) => money(r.lines.reduce((t: number, l: Row) => t + l.quantity * l.price, 0), r.currency), num: true }, { h: "Buyer", v: (r) => r.buyer }] },
  ],
};

const MAX_ROWS = 500;
/** A record that is missing a field shows a dash in that cell instead of breaking the page. */
const cell = (c: Col, r: Row, n: Names) => { try { return c.v(r, n) ?? "—"; } catch { return "—"; } };
const textOf = (n: React.ReactNode): string => (n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(textOf).join(" ") : typeof n === "object" ? textOf((n as { props?: { children?: React.ReactNode } }).props?.children) : String(n));
const state = (s: ConnectorStatus) => (s.mode === "mock" ? { text: "Sample data", tone: "mock" } : s.connected ? { text: "Live", tone: "ok" } : { text: "Not connected", tone: "bad asis" });

const missing = (s: ConnectorStatus) => s.settings.filter((x) => x.required && !x.set).length;

function Records({ res, names }: { res: Resource; names: Names }) {
  const { data, error, loading, reload } = useApi<Row[]>(`/systems/${res.path}`);
  const [q, setQ] = useState("");
  // Search looks at what each row shows (a supplier's name, a formatted date) as well as the record behind it (codes, email bodies).
  const rows = useMemo(() => (Array.isArray(data) ? data : []).filter((r) => !q || `${res.cols.map((c) => textOf(cell(c, r, names))).join(" ")} ${JSON.stringify(r)}`.toLowerCase().includes(q.trim().toLowerCase())), [data, q, res, names]);
  return (
    <>
      <div className="toolbar">
        <input placeholder={`Search ${res.noun}`} aria-label={`Search ${res.noun}`} value={q} onChange={(e) => setQ(e.target.value)} />
        {data && <span className="small muted">{rows.length > MAX_ROWS ? `Showing the first ${MAX_ROWS} of ${rows.length} ${res.noun}` : `${rows.length} ${res.noun}`}</span>}
      </div>
      {error ? <div className="error">Could not load {res.noun}. {error} <button onClick={reload}>Try again</button></div>
        : !data && loading ? <p className="muted">Loading {res.noun}…</p>
        : <section className="card flush scroll">
            <table className="table"><thead><tr>{res.cols.map((c) => <th key={c.h} className={c.num ? "num" : ""}>{c.h}</th>)}</tr></thead>
              <tbody>{rows.slice(0, MAX_ROWS).map((r, i) => <tr key={i}>{res.cols.map((c) => <td key={c.h} className={c.num ? "num" : ""}>{cell(c, r, names)}</td>)}</tr>)}
                {!rows.length && <tr><td colSpan={res.cols.length} className="muted">{q ? `No ${res.noun} match "${q}".` : `No ${res.noun} yet.`}</td></tr>}</tbody></table>
          </section>}
    </>
  );
}

function GoLive({ st }: { st: ConnectorStatus }) {
  const required = st.settings.filter((s) => s.required);
  const provided = required.filter((s) => s.set).length;
  return (
    <details className="card golive" open={st.mode === "live" && !st.connected}>
      <summary><b>{st.mode === "mock" ? `Switching ${st.name} to the real system` : `${st.name} connection settings`}</b> <span className="small muted">{provided} of {required.length} required settings provided</span></summary>
      <p className="small">For IT. The live connector calls the {st.api}. Set the values below as environment variables on the server, set <code>CONNECTOR_{st.system.toUpperCase()}=live</code> and restart. The other systems can stay on sample data. Values are never shown here, only whether each one is present.</p>
      <table className="table"><thead><tr><th>Setting</th><th>Environment variable</th><th>What it is</th><th>Status</th></tr></thead>
        <tbody>{st.settings.map((s) => <tr key={s.key}><td>{s.label}{!s.required && <span className="muted"> (optional)</span>}</td><td><code>{s.key}</code></td><td className="small">{s.help}</td><td>{s.set ? pill("Provided", "ok") : s.required ? pill("Missing", "warn") : pill("Not set")}</td></tr>)}</tbody></table>
    </details>
  );
}

export default function Systems() {
  const { system = "m365" } = useParams();
  const { data: statuses, error, loading, reload } = useApi<ConnectorStatus[]>("/systems");
  const { data: suppliers } = useApi<Row[]>("/systems/inforln/suppliers");
  const { data: accounts } = useApi<Row[]>("/systems/salesforce/accounts");
  const { data: items } = useApi<Row[]>("/systems/inforln/items");
  const names = useMemo<Names>(() => {
    const map = (rows: Row[] | undefined, key: string, name: string) => new Map((Array.isArray(rows) ? rows : []).map((r) => [r[key], r[name]]));
    const s = map(suppliers, "supplier", "name"), a = map(accounts, "Id", "Name"), p = map(items, "item", "description");
    return { supplier: (c) => s.get(c) ?? c, account: (c) => a.get(c) ?? c, product: (c) => (p.has(c) ? `${c} · ${p.get(c)}` : c) };
  }, [suppliers, accounts, items]);

  const key = system in RESOURCES ? system : "m365";
  const resources = RESOURCES[key];
  // The open tab is remembered per system, so moving between systems never points at a tab the new system does not have.
  const [tabs, setTabs] = useState<Record<string, number>>({});
  const res = resources[tabs[key] ?? 0] ?? resources[0];
  const [test, setTest] = useState<{ system: string; running: boolean; result?: ConnectorStatus; error?: string }>();
  const st = (test?.system === key && test.result) || statuses?.find((s) => s.system === key);
  const runTest = () => {
    setTest({ system: key, running: true });
    api<ConnectorStatus>(`/systems/${key}/test`, { method: "POST" })
      .then((result) => { setTest({ system: key, running: false, result }); reload(); })
      .catch((e) => setTest({ system: key, running: false, error: String(e.message ?? e) }));
  };
  const tested = test?.system === key && !test.running ? test : undefined;

  return (
    <>
      <div className="page-head"><div><h1>Connected systems</h1><p className="muted">The four systems the agents read from and write to. A system marked "Sample data" is a stand-in filled with made-up Cubro records, so nothing here reaches a real customer or supplier until IT switches that system to live.</p></div></div>
      {error && <div className="error">Could not load the systems. {error} <button onClick={reload}>Try again</button></div>}
      {!statuses && loading && <p className="muted">Checking the four systems…</p>}
      <div className="sys-cards">{statuses?.map((s) => (
        <NavLink key={s.system} to={`/systems/${s.system}`} className={`card sys ${key === s.system ? "sel" : ""}`}>
          <div className="row between"><b>{s.name}</b><span className={`pill ${state(s).tone}`}>{state(s).text}</span></div>
          <span className="small muted">{s.connected ? Object.entries(s.records).map(([k, v]) => `${v.toLocaleString("en-NZ")} ${k}`).join(" · ") : missing(s) ? `Switched to live, but ${missing(s)} of ${s.settings.filter((x) => x.required).length} required settings are missing.` : s.error}</span>
        </NavLink>))}</div>
      {st && (
        <section className="card">
          <div className="row between wrap">
            <div><b>{st.name}</b> <span className={`pill ${state(st).tone}`}>{state(st).text}</span><div className="small muted">{st.detail}. Last checked {when(st.checkedAt)}.</div></div>
            <button onClick={runTest} disabled={test?.running}>{test?.running && test.system === key ? "Testing…" : "Test connection"}</button>
          </div>
          {st.mode === "live" && !st.connected && <div className="error top">{st.name} is switched to live but is not connected. {st.error} The agents cannot read from it until this is fixed.</div>}
          {tested?.error && <div className="error top">The test could not run. {tested.error}</div>}
          {tested?.result && (tested.result.connected
            ? <div className="banner top">{tested.result.mode === "mock" ? `${st.name} is running on sample data and answered normally. No real system was contacted.` : `${st.name} answered. The live connection is working.`}</div>
            : tested.result.mode === "mock" && <div className="error top">{st.name} sample data did not answer. {tested.result.error}</div>)}
        </section>
      )}
      {st && <GoLive key={`${st.system}-${st.mode}-${st.connected}`} st={st} />}
      <div className="toolbar">
        <div className="seg">{resources.map((r, i) => <button key={r.path} className={res === r ? "on" : ""} onClick={() => setTabs({ ...tabs, [key]: i })}>{r.label}</button>)}</div>
      </div>
      {/* Keyed by resource so one tab's records are never drawn with another tab's columns. */}
      <Records key={res.path} res={res} names={names} />
    </>
  );
}
