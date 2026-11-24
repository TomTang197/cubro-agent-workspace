import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { templateProvider } from "../server/llm";
import type { ActivityLine, Notice, RecordDetail, RecordRow, SearchHit } from "../server/records";
import { Store, type SupplierEmailPayload } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const setup = () => { const store = new Store({ today }); return { store, app: createApp(store, { llm: templateProvider, env: {}, now: () => today }) }; };
const group = (d: RecordDetail, label: string) => d.links.find((l) => l.label === label);

describe("search across the four systems", () => {
  it("finds a supplier by name, with its purchase orders", async () => {
    const { app, store } = setup();
    const supplier = store.state.systems.inforln.suppliers[0];
    const hits: SearchHit[] = (await request(app).get(`/api/search?q=${encodeURIComponent(supplier.name.split(" ")[0])}`).expect(200)).body;
    expect(hits[0]).toMatchObject({ kind: "supplier", id: supplier.supplier, title: supplier.name, system: "Infor LN" });
    expect(hits.some((h) => h.kind === "order")).toBe(true);
  });
  it("finds a purchase order by its number and a customer by name", async () => {
    const { app, store } = setup();
    const po = store.state.systems.inforln.purchaseOrders[0], account = store.state.systems.salesforce.accounts[0];
    const byNumber: SearchHit[] = (await request(app).get(`/api/search?q=${po.order.toLowerCase()}`).expect(200)).body;
    expect(byNumber[0]).toMatchObject({ kind: "order", id: po.order });
    const byName: SearchHit[] = (await request(app).get(`/api/search?q=${encodeURIComponent(account.Name)}`).expect(200)).body;
    expect(byName[0]).toMatchObject({ kind: "customer", id: account.Id, system: "Salesforce" });
  });
  it("finds a supplier by its contact's name, and drafts written to it", async () => {
    const { app, store } = setup();
    const draft = store.state.approvals.find((a) => a.payload.type === "supplier_email")!, p = draft.payload as SupplierEmailPayload;
    const contact = store.state.systems.inforln.suppliers.find((s) => s.supplier === p.supplierId)!.contactName;
    const hits: SearchHit[] = (await request(app).get(`/api/search?q=${encodeURIComponent(contact)}`).expect(200)).body;
    expect(hits.some((h) => h.kind === "supplier" && h.id === p.supplierId)).toBe(true);
    const byName: SearchHit[] = (await request(app).get(`/api/search?q=${encodeURIComponent(p.supplierName)}`).expect(200)).body;
    expect(byName.some((h) => h.kind === "draft" && h.system === "Agent Workspace")).toBe(true);
  });
  it("returns nothing for one letter or no match", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/search?q=a").expect(200)).body).toEqual([]);
    expect((await request(app).get("/api/search?q=zzzzqqqq").expect(200)).body).toEqual([]);
  });
});

describe("records and what links them", () => {
  it("lists each kind with the values it can be sorted by", async () => {
    const { app, store } = setup();
    const s = store.state.systems;
    for (const [kind, count] of [["supplier", s.inforln.suppliers.length], ["order", s.inforln.purchaseOrders.length], ["customer", s.salesforce.accounts.length], ["product", s.inforln.items.length]] as const) {
      const rows: RecordRow[] = (await request(app).get(`/api/records/${kind}`).expect(200)).body;
      expect(rows).toHaveLength(count);
      expect(Object.keys(rows[0].sort).length).toBeGreaterThan(1);
    }
    await request(app).get("/api/records/invoice").expect(404);
  });
  it("marks an open order past its due date as overdue", async () => {
    const { app, store } = setup();
    const late = store.state.systems.inforln.purchaseOrders.find((po) => !["Received", "Closed"].includes(po.status) && (po.confirmedReceiptDate ?? po.plannedReceiptDate) < "2026-11-23")!;
    const rows: RecordRow[] = (await request(app).get("/api/records/order").expect(200)).body;
    expect(rows.find((r) => r.id === late.order)).toMatchObject({ status: "Overdue", tone: "warn" });
  });
  it("a purchase order links to its supplier, its products and the emails that mention it", async () => {
    const { app, store } = setup();
    const s = store.state.systems;
    const po = s.inforln.purchaseOrders.find((x) => s.m365.messages.some((m) => `${m.subject} ${m.body}`.includes(x.order)))!;
    const d: RecordDetail = (await request(app).get(`/api/records/order/${po.order}`).expect(200)).body;
    expect(group(d, "Supplier")!.items[0]).toMatchObject({ kind: "supplier", id: po.supplier });
    expect(group(d, "Products on this order")!.items.map((i) => i.id).sort()).toEqual([...new Set(po.lines.map((l) => l.item))].sort());
    expect(group(d, "Emails")).toMatchObject({ system: "Microsoft 365" });
    expect(group(d, "Emails")!.items.length).toBeGreaterThan(0);
  });
  it("a supplier links to its orders, and to the follow-up task once a draft to it is approved", async () => {
    const { app, store } = setup();
    const draft = store.state.approvals.find((a) => a.status === "pending" && a.payload.type === "supplier_email" && (a.payload as SupplierEmailPayload).purchaseOrder)!;
    const p = draft.payload as SupplierEmailPayload;
    await request(app).post(`/api/approvals/${draft.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    const d: RecordDetail = (await request(app).get(`/api/records/supplier/${p.supplierId}`).expect(200)).body;
    expect(group(d, "Purchase orders")!.items.every((i) => i.kind === "order")).toBe(true);
    expect(group(d, "Tasks")).toMatchObject({ system: "ClickUp" });
    expect(group(d, "Tasks")!.items.some((t) => t.title.startsWith("Chase reply"))).toBe(true);
    expect(group(d, "Emails")!.items.some((m) => m.status === "Sent")).toBe(true);
    expect(group(d, "Drafts from the assistant")!.items.find((i) => i.id === draft.id)).toMatchObject({ kind: "draft", status: "Approved" });
  });
  it("a customer links to its contacts and deals in Salesforce", async () => {
    const { app, store } = setup();
    const s = store.state.systems.salesforce;
    const account = s.accounts.find((a) => s.opportunities.some((o) => o.AccountId === a.Id) && s.contacts.some((c) => c.AccountId === a.Id))!;
    const d: RecordDetail = (await request(app).get(`/api/records/customer/${account.Id}`).expect(200)).body;
    expect(group(d, "Contacts")!.items).toHaveLength(s.contacts.filter((c) => c.AccountId === account.Id).length);
    expect(group(d, "Opportunities")!.items.length).toBeGreaterThan(0);
  });
  it("says so when a record is not there", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/records/supplier/SUP0000").expect(404)).body.error).toMatch(/not in the connected systems/);
  });
});

describe("activity record and notifications", () => {
  it("records who approved a draft and which systems it went to", async () => {
    const { app, store } = setup();
    const draft = store.state.approvals.find((a) => a.status === "pending" && a.payload.type === "supplier_email")!;
    await request(app).post(`/api/approvals/${draft.id}/approve`).send({ user: "Mark Jensen" }).expect(200);
    const lines: ActivityLine[] = (await request(app).get("/api/activity/record").expect(200)).body;
    const line = lines.find((l) => l.approvalId === draft.id)!;
    expect(line).toMatchObject({ actor: "Mark Jensen", kind: "approved", what: draft.title });
    expect(line.went.map((w) => w.system)).toEqual(["Microsoft 365", "ClickUp"]);
    expect(line.went[0].label).toMatch(/^Email sent to /);
    expect(lines.map((l) => l.at)).toEqual([...lines.map((l) => l.at)].sort().reverse());
  });
  it("a draft sent back went nowhere, and keeps the note", async () => {
    const { app, store } = setup();
    const draft = store.state.approvals.find((a) => a.status === "pending")!;
    await request(app).post(`/api/approvals/${draft.id}/reject`).send({ user: "Hemi Walker", note: "Wrong supplier" }).expect(200);
    const lines: ActivityLine[] = (await request(app).get("/api/activity/record").expect(200)).body;
    expect(lines.find((l) => l.approvalId === draft.id)).toMatchObject({ actor: "Hemi Walker", kind: "sent_back", went: [], note: "Wrong supplier" });
  });
  it("sample history says where each kind of approval goes, and requests for drafts are listed", async () => {
    const { app } = setup();
    const lines: ActivityLine[] = (await request(app).get("/api/activity/record").expect(200)).body;
    expect(lines.filter((l) => l.kind === "approved").every((l) => l.went.length === 2)).toBe(true);
    expect(lines.some((l) => l.kind === "asked")).toBe(true);
  });
  it("tells a person what colleagues decided on their team's drafts, not what they did themselves", async () => {
    const { app, store } = setup();
    const [first, second] = store.state.approvals.filter((a) => a.status === "pending" && a.agent === "supplier-outreach");
    await request(app).post(`/api/approvals/${first.id}/approve`).send({ user: "Mark Jensen" }).expect(200);
    await request(app).post(`/api/approvals/${second.id}/reject`).send({ user: "Priya Raman", note: "Not needed" }).expect(200);
    const forPriya: Notice[] = (await request(app).get("/api/notifications?agent=supplier-outreach").set("x-cubro-user", "Priya Raman").expect(200)).body;
    expect(forPriya.find((n) => n.id === `decided-${first.id}`)!.text).toBe(`Mark Jensen approved ${first.title}. It went to Microsoft 365 and ClickUp`);
    expect(forPriya.some((n) => n.id === `decided-${second.id}`)).toBe(false);
    const forMark: Notice[] = (await request(app).get("/api/notifications?agent=supplier-outreach").set("x-cubro-user", "Mark Jensen").expect(200)).body;
    expect(forMark.find((n) => n.id === `decided-${second.id}`)!.text).toBe(`Priya Raman sent back ${second.title}: Not needed`);
    expect(forMark.some((n) => n.id === `decided-${first.id}`)).toBe(false);
    // Urgent drafts still waiting are listed for everyone on the team, and only that team's.
    const urgent = store.state.approvals.filter((a) => a.status === "pending" && a.priority === "high" && a.agent === "supplier-outreach");
    expect(forMark.filter((n) => n.id.startsWith("urgent-"))).toHaveLength(Math.min(urgent.length, forMark.length));
    const marketing: Notice[] = (await request(app).get("/api/notifications?agent=social-media").set("x-cubro-user", "Aroha Ngata").expect(200)).body;
    expect(marketing.some((n) => n.id === `decided-${first.id}`)).toBe(false);
  });
});
