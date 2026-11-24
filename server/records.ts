// One view over the four systems: the records staff look up (suppliers, purchase orders, customers, products) and what links them.
import { AGENTS } from "./agents/service.js";
import type { Connectors } from "./connectors/index.js";
import type { ClickUpTask, LnItem, LnPurchaseOrder, LnSupplier, MailMessage, SfAccount, SfActivity, SfCase, SfContact, SfOpportunity } from "./connectors/types.js";
import type { AgentId, ApprovalItem, WorkspaceState } from "./store.js";

export const RECORD_KINDS = ["supplier", "order", "customer", "product"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const isRecordKind = (s: string): s is RecordKind => (RECORD_KINDS as readonly string[]).includes(s);

/** A record in a list or a search result. `sort` holds the values its list can be ordered by. */
export interface RecordRow { kind: RecordKind; id: string; title: string; subtitle: string; system: string; status?: string; tone?: "ok" | "warn" | "bad"; sort: Record<string, string | number>; }
/** Something a record is linked to. With a `kind` it opens as a record; a draft opens in Drafts to check; an email or task is shown where it is. */
export interface LinkedItem { kind?: RecordKind | "draft"; id?: string; title: string; subtitle?: string; status?: string; }
export interface RecordDetail extends Omit<RecordRow, "sort"> { fields: { label: string; value: string }[]; links: { label: string; system: string; items: LinkedItem[] }[]; }
export interface SearchHit { kind: RecordKind | "draft"; id: string; title: string; subtitle: string; system: string; }

interface Data {
  suppliers: LnSupplier[]; orders: LnPurchaseOrder[]; items: LnItem[];
  accounts: SfAccount[]; contacts: SfContact[]; opportunities: SfOpportunity[]; cases: SfCase[]; activities: SfActivity[];
  messages: MailMessage[]; tasks: ClickUpTask[];
}

/** Everything the lookups need. A system that does not answer contributes nothing, so the other three can still be searched. */
async function load(c: Connectors): Promise<Data> {
  const or = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
  const [suppliers, orders, items, accounts, contacts, opportunities, cases, activities, messages, tasks] = await Promise.all([
    or(c.inforln.listSuppliers()), or(c.inforln.listPurchaseOrders()), or(c.inforln.listItems()),
    or(c.salesforce.query("Account")), or(c.salesforce.query("Contact")), or(c.salesforce.query("Opportunity")), or(c.salesforce.query("Case")), or(c.salesforce.listActivities()),
    or(c.m365.listMessages()), or(c.clickup.listTasks()),
  ]);
  return { suppliers, orders, items, accounts, contacts, opportunities, cases, activities, messages, tasks };
}

const nzDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" });
const shortDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: iso.length === 10 ? "UTC" : "Pacific/Auckland" });
const amount = (n: number, currency = "NZD") => n.toLocaleString("en-NZ", { style: "currency", currency, maximumFractionDigits: 0 });
// A live order can arrive without a receipt date yet; it has no due date, so it is never overdue.
const dueOf = (po: LnPurchaseOrder) => po.confirmedReceiptDate || po.plannedReceiptDate || "";
const dueText = (po: LnPurchaseOrder) => (dueOf(po) ? `due ${shortDate(dueOf(po))}` : "no due date yet");
const isOpen = (po: LnPurchaseOrder) => po.status !== "Received" && po.status !== "Closed";
const valueOf = (po: LnPurchaseOrder) => po.lines.reduce((n, l) => n + l.quantity * l.price, 0);
const has = (text: string, needle: string) => !!needle && text.toLowerCase().includes(needle.toLowerCase());
/** True when the text names this code or name as a whole, so product 163 is not found inside order PO41163. */
const mentions = (text: string, needle: string) => !!needle && new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(text);

function rows(d: Data, today: string): RecordRow[] {
  const supplierName = new Map(d.suppliers.map((s) => [s.supplier, s.name]));
  const late = (po: LnPurchaseOrder) => isOpen(po) && !!dueOf(po) && dueOf(po) < today;
  return [
    ...d.suppliers.map((s): RecordRow => {
      const open = d.orders.filter((po) => po.supplier === s.supplier && isOpen(po)), overdue = open.filter(late).length;
      return {
        kind: "supplier", id: s.supplier, title: s.name, subtitle: `${s.supplier} · ${[s.city, s.country].filter(Boolean).join(", ")}`, system: "Infor LN",
        status: overdue ? `${overdue} overdue` : open.length ? `${open.length} open` : "No open orders", tone: overdue ? "warn" : undefined,
        sort: { Name: s.name, "Open orders": open.length, "On-time deliveries": s.onTimeRate, "Lead time": s.avgLeadTimeDays },
      };
    }),
    ...d.orders.map((po): RecordRow => ({
      kind: "order", id: po.order, title: po.order, subtitle: `${supplierName.get(po.supplier) ?? po.supplier} · ${dueText(po)}`, system: "Infor LN",
      status: late(po) ? "Overdue" : po.status, tone: late(po) ? "warn" : isOpen(po) ? undefined : "ok",
      // Not sortable by value: orders are in six currencies and nothing here converts between them.
      sort: { "Due date": dueOf(po), "Order date": po.orderDate, Supplier: supplierName.get(po.supplier) ?? po.supplier, "Order number": po.order },
    })),
    ...d.accounts.map((a): RecordRow => ({
      kind: "customer", id: a.Id, title: a.Name, subtitle: `${a.Type} · ${a.BillingCity}`, system: "Salesforce", status: a.Market__c,
      sort: { Name: a.Name, "Yearly spend": a.AnnualSpend__c, City: a.BillingCity },
    })),
    ...d.items.map((i): RecordRow => ({
      kind: "product", id: i.item, title: i.description, subtitle: `${i.item} · ${i.itemGroup}`, system: "Infor LN",
      status: i.onHand < i.reorderPoint ? "Low stock" : "In stock", tone: i.onHand < i.reorderPoint ? "warn" : "ok",
      sort: { Name: i.description, "On hand": i.onHand, Code: i.item },
    })),
  ];
}

export async function listRecords(c: Connectors, kind: RecordKind, now = new Date()) {
  return rows(await load(c), nzDay(now)).filter((r) => r.kind === kind);
}

const draftItem = (a: ApprovalItem): LinkedItem => ({ kind: "draft", id: a.id, title: a.title, subtitle: `${AGENTS[a.agent].name} draft`, status: a.status === "pending" ? "Waiting" : a.status === "approved" ? "Approved" : "Sent back" });
const mailItem = (m: MailMessage): LinkedItem => ({ title: m.subject, subtitle: `${m.folder === "Inbox" ? `From ${m.from.name}` : `To ${m.to.map((t) => t.name || t.address).join(", ")}`} · ${shortDate(m.receivedDateTime)}`, status: m.folder === "Inbox" ? "Received" : m.folder === "Drafts" ? "Draft" : "Sent" });
const taskItem = (t: ClickUpTask): LinkedItem => ({ title: t.name, subtitle: `${t.list} list${t.assignees.length ? ` · ${t.assignees.join(", ")}` : ""}${t.due_date ? ` · due ${shortDate(t.due_date)}` : ""}`, status: t.status });
const newest = <T,>(list: T[], at: (x: T) => string, max = 8) => [...list].sort((a, b) => at(b).localeCompare(at(a))).slice(0, max);

export async function recordDetail(c: Connectors, approvals: ApprovalItem[], kind: RecordKind, id: string, now = new Date()): Promise<RecordDetail | undefined> {
  const d = await load(c), today = nzDay(now);
  const row = rows(d, today).find((r) => r.kind === kind && r.id === id);
  if (!row) return undefined;
  const { sort: _sort, ...base } = row;
  const byRow = (k: RecordKind, ids: string[]): LinkedItem[] => rows(d, today).filter((r) => r.kind === k && ids.includes(r.id)).map((r) => ({ kind: r.kind, id: r.id, title: r.title, subtitle: r.subtitle, status: r.status }));
  const mailAbout = (words: string[], addresses: string[] = []) => newest(d.messages.filter((m) => addresses.some((a) => a && (m.from.address === a || m.to.some((t) => t.address === a))) || words.some((w) => mentions(`${m.subject} ${m.body}`, w))), (m) => m.receivedDateTime).map(mailItem);
  const tasksAbout = (words: string[]) => d.tasks.filter((t) => words.some((w) => mentions(`${t.name} ${t.description}`, w))).slice(0, 8).map(taskItem);
  const links: RecordDetail["links"] = [];
  const link = (label: string, system: string, items: LinkedItem[]) => { if (items.length) links.push({ label, system, items }); };
  let fields: RecordDetail["fields"] = [];

  if (kind === "supplier") {
    const s = d.suppliers.find((x) => x.supplier === id)!;
    const orders = newest(d.orders.filter((po) => po.supplier === id), dueOf, 50);
    fields = [
      { label: "Contact", value: s.contactName }, { label: "Email", value: s.email }, { label: "Phone", value: s.phone },
      { label: "Lead time", value: `${s.avgLeadTimeDays} days` }, { label: "On-time deliveries", value: `${Math.round(s.onTimeRate * 100)}%` }, { label: "Payment terms", value: s.paymentTerms },
      { label: "Supplies", value: s.categories.join(", ") },
    ];
    link("Purchase orders", "Infor LN", byRow("order", orders.slice(0, 8).map((po) => po.order)));
    link("Emails", "Microsoft 365", mailAbout(orders.map((po) => po.order), [s.email]));
    link("Tasks", "ClickUp", tasksAbout([s.name, ...orders.map((po) => po.order)]));
    link("Drafts from the assistant", "Agent Workspace", approvals.filter((a) => a.payload.type === "supplier_email" && a.payload.supplierId === id).slice(0, 8).map(draftItem));
    link("Products", "Infor LN", byRow("product", d.items.filter((i) => i.primarySupplier === id).map((i) => i.item)).slice(0, 8));
  } else if (kind === "order") {
    const po = d.orders.find((x) => x.order === id)!;
    const name = new Map(d.items.map((i) => [i.item, i.description]));
    fields = [
      { label: "Ordered", value: shortDate(po.orderDate) }, { label: "Planned to arrive", value: po.plannedReceiptDate ? shortDate(po.plannedReceiptDate) : "No date yet" },
      { label: "Supplier confirmed", value: po.confirmedReceiptDate ? shortDate(po.confirmedReceiptDate) : "Not confirmed yet" },
      { label: "Buyer", value: po.buyer }, { label: "Value", value: amount(valueOf(po), po.currency) },
      ...po.lines.map((l) => ({ label: `Line ${l.line}`, value: `${l.quantity} × ${name.get(l.item) ?? l.item} (${l.received} received)` })),
    ];
    link("Supplier", "Infor LN", byRow("supplier", [po.supplier]));
    link("Emails", "Microsoft 365", mailAbout([id]));
    link("Tasks", "ClickUp", tasksAbout([id]));
    link("Drafts from the assistant", "Agent Workspace", approvals.filter((a) => a.payload.type === "supplier_email" && a.payload.purchaseOrder === id).map(draftItem));
    link("Products on this order", "Infor LN", byRow("product", po.lines.map((l) => l.item)));
  } else if (kind === "customer") {
    const a = d.accounts.find((x) => x.Id === id)!;
    const contacts = d.contacts.filter((x) => x.AccountId === id), opps = d.opportunities.filter((x) => x.AccountId === id), cases = d.cases.filter((x) => x.AccountId === id);
    const about = new Set([id, ...opps.map((o) => o.Id), ...cases.map((x) => x.Id)]);
    fields = [
      { label: "Type", value: a.Type }, { label: "Market", value: a.Market__c ?? "—" }, { label: "Region", value: a.Region }, { label: "Account owner", value: a.OwnerName },
      { label: "Yearly spend", value: amount(a.AnnualSpend__c) }, ...(a.Phone ? [{ label: "Phone", value: a.Phone }] : []),
    ];
    link("Contacts", "Salesforce", contacts.map((x) => ({ title: x.Name, subtitle: `${x.Title} · ${x.Email}` })));
    link("Opportunities", "Salesforce", newest(opps, (o) => o.CloseDate).map((o) => ({ title: o.Name, subtitle: `${amount(o.Amount)} · closes ${shortDate(o.CloseDate)}`, status: o.StageName })));
    link("Cases", "Salesforce", newest(cases, (x) => x.CreatedDate).map((x) => ({ title: x.Subject, subtitle: `${x.Type} · ${shortDate(x.CreatedDate)}`, status: x.Status })));
    link("Logged activity", "Salesforce", newest(d.activities.filter((x) => about.has(x.WhatId)), (x) => x.CreatedDate).map((x) => ({ title: x.Subject, subtitle: shortDate(x.CreatedDate) })));
    link("Emails", "Microsoft 365", mailAbout([a.Name], contacts.map((x) => x.Email)));
    // A task names the deal it is for, which often shortens the customer's name, or quotes its Salesforce id.
    link("Tasks", "ClickUp", tasksAbout([a.Name, ...opps.flatMap((o) => [o.Name, o.Id])]));
    link("Products they asked about", "Infor LN", byRow("product", [...new Set([...opps.flatMap((o) => o.ProductSkus), ...cases.map((x) => x.ProductSku)])]).slice(0, 8));
  } else {
    const i = d.items.find((x) => x.item === id)!;
    const orders = newest(d.orders.filter((po) => po.lines.some((l) => l.item === id)), dueOf);
    const customers = [...new Set([...d.opportunities.filter((o) => o.ProductSkus.includes(id)).map((o) => o.AccountId), ...d.cases.filter((x) => x.ProductSku === id).map((x) => x.AccountId)])];
    fields = [
      { label: "Code", value: i.item }, { label: "Group", value: i.itemGroup }, { label: "List price", value: amount(i.unitPrice) },
      { label: "On hand", value: `${i.onHand} (reorder at ${i.reorderPoint})` }, { label: "Sold per month", value: String(i.avgMonthlyDemand) },
    ];
    link("Supplier", "Infor LN", byRow("supplier", [i.primarySupplier]));
    link("Purchase orders", "Infor LN", byRow("order", orders.map((po) => po.order)));
    link("Drafts from the assistant", "Agent Workspace", approvals.filter((a) => (a.payload.type === "supplier_email" ? a.payload.items.includes(id) : a.payload.productSkus.includes(id))).slice(0, 8).map(draftItem));
    link("Customer cases", "Salesforce", newest(d.cases.filter((x) => x.ProductSku === id), (x) => x.CreatedDate).map((x) => ({ title: x.Subject, subtitle: `${x.Type} · ${shortDate(x.CreatedDate)}`, status: x.Status })));
    link("Customers", "Salesforce", byRow("customer", customers).slice(0, 8));
    link("Tasks", "ClickUp", tasksAbout([id]));
  }
  return { ...base, fields, links };
}

const PER_KIND = 5;
/** Finds suppliers, purchase orders, customers, products and drafts by any word in them: a name, a code, an order number, a contact. */
export async function searchRecords(c: Connectors, approvals: ApprovalItem[], q: string, now = new Date()): Promise<SearchHit[]> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.join("").length < 2) return [];
  const d = await load(c);
  // Words a record can be found by that its list row does not show.
  const extra = new Map<string, string>();
  for (const s of d.suppliers) extra.set(`supplier:${s.supplier}`, `${s.contactName} ${s.email} ${s.country}`);
  for (const po of d.orders) extra.set(`order:${po.order}`, `${po.supplier} ${po.buyer} ${po.lines.map((l) => l.item).join(" ")}`);
  for (const a of d.accounts) extra.set(`customer:${a.Id}`, `${a.Region} ${a.OwnerName} ${d.contacts.filter((x) => x.AccountId === a.Id).map((x) => `${x.Name} ${x.Email}`).join(" ")}`);
  const candidates: (SearchHit & { text: string })[] = [
    ...rows(d, nzDay(now)).map((r) => ({ kind: r.kind, id: r.id, title: r.title, subtitle: r.subtitle, system: r.system, text: `${r.title} ${r.subtitle} ${r.id} ${extra.get(`${r.kind}:${r.id}`) ?? ""}` })),
    ...approvals.map((a) => ({ kind: "draft" as const, id: a.id, title: a.title, subtitle: `${AGENTS[a.agent].name} draft · ${a.status === "pending" ? "waiting" : a.status === "approved" ? "approved" : "sent back"}`, system: "Agent Workspace", text: `${a.title} ${a.payload.type === "supplier_email" ? `${a.payload.supplierName} ${a.payload.purchaseOrder ?? ""}` : a.payload.channel}` })),
  ];
  const lead = words[0];
  // A record whose name or number starts with what was typed comes before one that only mentions it.
  const rank = (h: SearchHit) => (h.id.toLowerCase() === lead ? 0 : h.id.toLowerCase().startsWith(lead) || h.title.toLowerCase().startsWith(lead) ? 1 : 2);
  const found = candidates.filter((h) => words.every((w) => h.text.toLowerCase().includes(w))).sort((a, b) => rank(a) - rank(b));
  const taken: Record<string, number> = {};
  return found.filter((h) => (taken[h.kind] = (taken[h.kind] ?? 0) + 1) <= PER_KIND).map(({ text: _text, ...h }) => h);
}

/** One line of the activity record: who did what, and for an approval, which systems it went to. */
export interface ActivityLine { id: string; at: string; actor: string; /** `part_done`: approving began and some steps went out, but a later step failed and the draft still waits. */ kind: "approved" | "part_done" | "sent_back" | "asked" | "changed" | "admin"; what: string; went: { system: string; label: string }[]; approvalId?: string; agent?: AgentId; note?: string; }

/** Where an approved draft went. Each step is recorded as it happens; sample history from before that is described by what approving that kind of draft does. */
export function wentTo(a: ApprovalItem): { system: string; label: string }[] {
  if (a.status === "rejected") return [];
  // Still waiting, but approving it got part of the way: what was done has left Cubro and belongs on the record.
  if (a.status === "pending") return (a.outcome ?? []).map((o) => ({ system: o.system, label: o.label }));
  if (a.outcome?.length) return a.outcome.map((o) => ({ system: o.system, label: o.label }));
  return a.payload.type === "supplier_email"
    ? [{ system: "Microsoft 365", label: `Email sent to ${a.payload.to.address}` }, { system: "ClickUp", label: "Follow-up task added to the Purchasing list" }]
    : [{ system: "ClickUp", label: "Publishing task added to the Marketing list" }, { system: "Microsoft 365", label: "Team told in the Marketing channel on Teams" }];
}

export function activityRecord(state: WorkspaceState): ActivityLine[] {
  // Approvals and send-backs are taken from the drafts themselves, which know where each one went; requests for drafts from the runs.
  const decisions = state.approvals.filter((a) => a.status !== "pending" && a.decidedAt).map((a): ActivityLine => ({
    id: `decision-${a.id}`, at: a.decidedAt!, actor: a.decidedBy ?? "Staff member", kind: a.status === "approved" ? "approved" : "sent_back", what: a.title,
    went: wentTo(a), approvalId: a.id, agent: a.agent, note: a.reviewerNote || undefined,
  }));
  const partDone = state.approvals.filter((a) => a.status === "pending" && a.outcome?.length).map((a): ActivityLine => {
    const last = a.outcome![a.outcome!.length - 1];
    return {
      id: `part-${a.id}`, at: last.at ?? a.createdAt, actor: last.by ?? "Staff member", kind: "part_done", what: a.title, went: wentTo(a), approvalId: a.id, agent: a.agent,
      note: a.reviewerNote || undefined,
    };
  });
  const asked = state.runs.map((r): ActivityLine => ({ id: `run-${r.id}`, at: r.finishedAt, actor: r.triggeredBy === "Schedule" ? AGENTS[r.agent].name : r.triggeredBy, kind: "asked", what: r.summary, went: [], agent: r.agent }));
  const other = state.activity.filter((e) => !["approved", "rejected", "ran agent"].includes(e.action)).map((e): ActivityLine => ({
    id: e.id, at: e.at, actor: e.actor, kind: e.action === "edited draft" ? "changed" : "admin",
    what: e.action === "edited draft" ? e.detail : `${e.action[0].toUpperCase()}${e.action.slice(1)}: ${e.detail}`, went: [],
  }));
  return [...decisions, ...partDone, ...asked, ...other].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
}

export interface Notice { id: string; at: string; text: string; to: string; tone?: "warn" | "ok"; }
const NOTICE_DAYS = 7;
/** What a person should know about their team's drafts: urgent ones waiting, and what colleagues decided or asked for in the last week. */
export function notificationsFor(state: WorkspaceState, user: string, agent: AgentId, now = new Date()): Notice[] {
  const since = new Date(now.getTime() - NOTICE_DAYS * 86_400_000).toISOString();
  const mine = state.approvals.filter((a) => a.agent === agent);
  const urgent = mine.filter((a) => a.status === "pending" && a.priority === "high").map((a): Notice => ({ id: `urgent-${a.id}`, at: a.createdAt, text: `Urgent: ${a.title} is waiting to be checked`, to: `/approvals/${a.id}?agent=${agent}`, tone: "warn" }));
  const decided = mine.filter((a) => a.status !== "pending" && a.decidedAt && a.decidedAt >= since && a.decidedBy !== user).map((a): Notice => ({
    id: `decided-${a.id}`, at: a.decidedAt!, to: `/approvals/${a.id}?status=${a.status}&agent=${agent}`, tone: a.status === "approved" ? "ok" : undefined,
    text: a.status === "approved" ? `${a.decidedBy} approved ${a.title}. It went to ${[...new Set(wentTo(a).map((o) => o.system))].join(" and ")}` : `${a.decidedBy} sent back ${a.title}${a.reviewerNote ? `: ${a.reviewerNote}` : ""}`,
  }));
  const asked = state.runs.filter((r) => r.agent === agent && r.itemsCreated > 0 && r.finishedAt >= since && r.triggeredBy !== user).map((r): Notice => ({ id: `run-${r.id}`, at: r.finishedAt, text: `${r.triggeredBy === "Schedule" ? AGENTS[agent].name : r.triggeredBy} asked for drafts: ${r.itemsCreated} new to check`, to: `/approvals?agent=${agent}` }));
  return [...urgent, ...decided, ...asked].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
}
