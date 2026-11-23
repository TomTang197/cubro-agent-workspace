import { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { day, nzd, when, type ConnectorStatus } from "../api";
import { useApi } from "../useApi";

type Col<T> = { h: string; v: (r: T) => React.ReactNode; num?: boolean };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RESOURCES: Record<string, { label: string; path: string; cols: Col<Row>[] }[]> = {
  m365: [
    { label: "Calendar", path: "m365/events", cols: [{ h: "Start", v: (r) => when(r.start) }, { h: "Subject", v: (r) => r.subject }, { h: "Category", v: (r) => r.category }, { h: "Location", v: (r) => r.location }, { h: "Organiser", v: (r) => r.organizer }] },
    { label: "Mail", path: "m365/messages", cols: [{ h: "Received", v: (r) => when(r.receivedDateTime) }, { h: "Folder", v: (r) => r.folder }, { h: "From", v: (r) => r.from.name }, { h: "To", v: (r) => r.to.map((t: Row) => t.address).join(", ") }, { h: "Subject", v: (r) => r.subject }] },
    { label: "SharePoint assets", path: "m365/assets", cols: [{ h: "Name", v: (r) => r.name }, { h: "Kind", v: (r) => r.kind }, { h: "Product", v: (r) => r.productSku ?? "—" }, { h: "Tags", v: (r) => r.tags.join(", ") }] },
    { label: "Teams posts", path: "m365/teams", cols: [{ h: "Posted", v: (r) => when(r.createdDateTime) }, { h: "Channel", v: (r) => r.channel }, { h: "Message", v: (r) => r.text }] },
  ],
  salesforce: [
    { label: "Accounts", path: "salesforce/accounts", cols: [{ h: "Id", v: (r) => r.Id }, { h: "Name", v: (r) => r.Name }, { h: "Type", v: (r) => r.Type }, { h: "City", v: (r) => r.BillingCity }, { h: "Owner", v: (r) => r.OwnerName }, { h: "Annual spend", v: (r) => nzd(r.AnnualSpend__c), num: true }] },
    { label: "Opportunities", path: "salesforce/opportunities", cols: [{ h: "Name", v: (r) => r.Name }, { h: "Stage", v: (r) => r.StageName }, { h: "Close", v: (r) => day(r.CloseDate) }, { h: "Products", v: (r) => r.ProductSkus.join(", ") }, { h: "Amount", v: (r) => nzd(r.Amount), num: true }] },
    { label: "Campaigns", path: "salesforce/campaigns", cols: [{ h: "Name", v: (r) => r.Name }, { h: "Type", v: (r) => r.Type }, { h: "Status", v: (r) => r.Status }, { h: "Dates", v: (r) => `${day(r.StartDate)} – ${day(r.EndDate)}` }, { h: "Audience", v: (r) => r.Audience }] },
    { label: "Cases", path: "salesforce/cases", cols: [{ h: "Id", v: (r) => r.Id }, { h: "Created", v: (r) => day(r.CreatedDate) }, { h: "Type", v: (r) => r.Type }, { h: "Subject", v: (r) => r.Subject }, { h: "Product", v: (r) => r.ProductSku }] },
  ],
  clickup: [
    { label: "Tasks", path: "clickup/tasks", cols: [{ h: "List", v: (r) => r.list }, { h: "Task", v: (r) => r.name }, { h: "Status", v: (r) => r.status }, { h: "Assignees", v: (r) => r.assignees.join(", ") }, { h: "Due", v: (r) => (r.due_date ? day(r.due_date) : "—") }, { h: "Tags", v: (r) => r.tags.join(", ") }] },
  ],
  inforln: [
    { label: "Items", path: "inforln/items", cols: [{ h: "Item", v: (r) => r.item }, { h: "Description", v: (r) => r.description }, { h: "Group", v: (r) => r.itemGroup }, { h: "On hand", v: (r) => r.onHand, num: true }, { h: "Reorder pt", v: (r) => r.reorderPoint, num: true }, { h: "Demand/mo", v: (r) => r.avgMonthlyDemand, num: true }, { h: "Supplier", v: (r) => r.primarySupplier }, { h: "Price", v: (r) => nzd(r.unitPrice), num: true }] },
    { label: "Suppliers", path: "inforln/suppliers", cols: [{ h: "Code", v: (r) => r.supplier }, { h: "Name", v: (r) => r.name }, { h: "Country", v: (r) => r.country }, { h: "Contact", v: (r) => `${r.contactName} <${r.email}>` }, { h: "Terms", v: (r) => r.paymentTerms }, { h: "Lead time", v: (r) => `${r.avgLeadTimeDays} d`, num: true }, { h: "On time", v: (r) => `${Math.round(r.onTimeRate * 100)}%`, num: true }] },
    { label: "Purchase orders", path: "inforln/purchase-orders", cols: [{ h: "Order", v: (r) => r.order }, { h: "Supplier", v: (r) => r.supplier }, { h: "Ordered", v: (r) => day(r.orderDate) }, { h: "Due", v: (r) => day(r.confirmedReceiptDate ?? r.plannedReceiptDate) }, { h: "Status", v: (r) => r.status }, { h: "Lines", v: (r) => r.lines.length, num: true }, { h: "Buyer", v: (r) => r.buyer }] },
  ],
};

const API_SHAPE: Record<string, string> = {
  m365: "Microsoft Graph v1.0 — calendarView, mailFolders/messages, messages/{id}/send, sites/drive, teams/channels/messages",
  salesforce: "Salesforce REST v61.0 — SOQL query on Account, Opportunity, Campaign, Case; sobjects/Task for activity",
  clickup: "ClickUp API v2 — GET/POST /list/{id}/task, PUT /task/{id}",
  inforln: "Infor ION API — Item, SupplierPartyMaster, PurchaseOrder BODs",
};

export default function Systems() {
  const { system = "m365" } = useParams();
  const { data: statuses } = useApi<ConnectorStatus[]>("/systems");
  const resources = RESOURCES[system] ?? RESOURCES.m365;
  const [tab, setTab] = useState(0);
  useEffect(() => setTab(0), [system]);
  const res = resources[Math.min(tab, resources.length - 1)];
  const { data } = useApi<Row[]>(`/systems/${res.path}`);
  const [q, setQ] = useState("");
  const rows = (data ?? []).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  const st = statuses?.find((s) => s.system === system);

  return (
    <>
      <div className="page-head"><div><h1>Connected systems</h1><p className="muted">Each system sits behind an interface shaped like its real API. Today they run on simulated data; switching one to live is a connector swap, not a rebuild.</p></div></div>
      <div className="sys-cards">{statuses?.map((s) => (
        <NavLink key={s.system} to={`/systems/${s.system}`} onClick={() => setTab(0)} className={({ isActive }) => `card sys ${isActive || (system === s.system) ? "sel" : ""}`}>
          <div className="row between"><b>{s.name}</b><span className={`pill ${s.mode === "mock" ? "mock" : "ok"}`}>{s.mode === "mock" ? "Simulated" : "Live"}</span></div>
          <span className="small muted">{Object.entries(s.records).map(([k, v]) => `${v} ${k}`).join(" · ")}</span>
        </NavLink>))}</div>
      {st && <p className="small muted">{st.detail}. Interface: {API_SHAPE[system]}.</p>}
      <div className="toolbar">
        <div className="seg">{resources.map((r, i) => <button key={r.label} className={res === r ? "on" : ""} onClick={() => setTab(i)}>{r.label}</button>)}</div>
        <input placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} /><span className="small muted">{rows.length} records</span>
      </div>
      <section className="card flush scroll">
        <table className="table"><thead><tr>{res.cols.map((c) => <th key={c.h} className={c.num ? "num" : ""}>{c.h}</th>)}</tr></thead>
          <tbody>{rows.slice(0, 300).map((r, i) => <tr key={i}>{res.cols.map((c) => <td key={c.h} className={c.num ? "num" : ""}>{c.v(r)}</td>)}</tr>)}</tbody></table>
      </section>
    </>
  );
}
