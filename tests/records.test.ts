import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { templateProvider } from "../server/llm";
import { AgentService } from "../server/agents/service";
import { createConnectors } from "../server/connectors";
import { activityRecord, type ActivityLine, type Notice, type RecordDetail, type RecordRow, type SearchHit } from "../server/records";
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
  it("an open order with no receipt date yet is not overdue", async () => {
    const { app, store } = setup();
    const po = store.state.systems.inforln.purchaseOrders.find((x) => x.status === "Sent" || x.status === "Confirmed")!;
    po.plannedReceiptDate = ""; po.confirmedReceiptDate = null;
    const rows: RecordRow[] = (await request(app).get("/api/records/order").expect(200)).body;
    expect(rows.find((r) => r.id === po.order)).toMatchObject({ status: po.status, subtitle: expect.stringContaining("no due date yet") });
    const d: RecordDetail = (await request(app).get(`/api/records/order/${po.order}`).expect(200)).body;
    expect(d.fields.find((f) => f.label === "Planned to arrive")!.value).toBe("No date yet");
  });
  it("does not offer to sort purchase orders by a value in mixed currencies", async () => {
    const { app } = setup();
    const rows: RecordRow[] = (await request(app).get("/api/records/order").expect(200)).body;
    expect(Object.keys(rows[0].sort)).toEqual(["Due date", "Order date", "Supplier", "Order number"]);
  });
  it("links a task to a product only when it names the code as a whole", async () => {
    const { app, store } = setup();
    const s = store.state.systems;
    const item = s.inforln.items[0];
    s.clickup.tasks.unshift({ ...s.clickup.tasks[0], id: "t-inside", name: `Freight booking PO9${item.item}7`, description: "" }, { ...s.clickup.tasks[0], id: "t-whole", name: `Recount ${item.item}, then post`, description: "" });
    const d: RecordDetail = (await request(app).get(`/api/records/product/${item.item}`).expect(200)).body;
    const titles = group(d, "Tasks")!.items.map((t) => t.title);
    expect(titles).toContain(`Recount ${item.item}, then post`);
    expect(titles).not.toContain(`Freight booking PO9${item.item}7`);
  });
  it("links a customer to the tasks about its deals, by the deal's Salesforce id", async () => {
    const { app, store } = setup();
    const s = store.state.systems;
    const task = s.clickup.tasks.find((t) => /Salesforce opportunity (\w+)/.test(t.description))!;
    const opp = s.salesforce.opportunities.find((o) => task.description.includes(o.Id))!;
    task.name = "Prepare quote";
    const d: RecordDetail = (await request(app).get(`/api/records/customer/${opp.AccountId}`).expect(200)).body;
    expect(group(d, "Tasks")!.items.some((t) => t.title === "Prepare quote")).toBe(true);
  });
  it("gives a task that quotes one deal's Salesforce id to that customer only, when two customers' deals share a name", async () => {
    const { app, store } = setup();
    const s = store.state.systems;
    const [mine, other] = [s.salesforce.opportunities[0], s.salesforce.opportunities.find((o) => o.AccountId !== s.salesforce.opportunities[0].AccountId)!];
    mine.Name = other.Name = "Bed replacement programme";
    s.clickup.tasks.unshift(
      { ...s.clickup.tasks[0], id: "t-id", name: "Prepare quote — Bed replacement programme", description: `Salesforce opportunity ${mine.Id}.` },
      { ...s.clickup.tasks[0], id: "t-name", name: "Book discovery visit — Bed replacement programme", description: "" },
    );
    const tasks = async (account: string) => (group((await request(app).get(`/api/records/customer/${account}`).expect(200)).body, "Tasks")?.items ?? []).map((t) => t.title);
    expect(await tasks(mine.AccountId)).toContain("Prepare quote — Bed replacement programme");
    expect(await tasks(other.AccountId)).not.toContain("Prepare quote — Bed replacement programme");
    // With no id to go on, a name both customers' deals have says nothing about whose task it is.
    expect(await tasks(mine.AccountId)).not.toContain("Book discovery visit — Bed replacement programme");
    expect(await tasks(other.AccountId)).not.toContain("Book discovery visit — Bed replacement programme");
  });
  it("says so when a record is not there", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/records/supplier/SUP0000").expect(404)).body.error).toMatch(/not in the connected systems/);
  });
});

describe("activity record and notifications", () => {
  it("records the email that went out when the follow-up task then failed, and one line once it is finished", async () => {
    const store = new Store({ today }), connectors = createConnectors(store, {});
    const agents = new AgentService(store, connectors, templateProvider, () => today);
    const draft = store.state.approvals.find((a) => a.status === "pending" && a.payload.type === "supplier_email")!;
    const createTask = connectors.clickup.createTask.bind(connectors.clickup);
    let fail = true;
    connectors.clickup.createTask = async (input) => { if (fail) throw new Error("ClickUp: 503 from api.clickup.com."); return createTask(input); };
    await expect(agents.approve(draft.id, "Priya Raman")).rejects.toThrow(/next step failed/);
    expect(draft.status).toBe("pending");

    const part = activityRecord(store.state).filter((l) => l.approvalId === draft.id);
    expect(part).toHaveLength(1);
    expect(part[0]).toMatchObject({ actor: "Priya Raman", kind: "part_done", what: draft.title });
    expect(part[0].went.map((w) => w.system)).toEqual(["Microsoft 365"]);

    fail = false;
    await agents.approve(draft.id, "Mark Jensen");
    const done = activityRecord(store.state).filter((l) => l.approvalId === draft.id);
    expect(done).toHaveLength(1);
    expect(done[0].actor).toBe("Mark Jensen");
    expect(done[0].went.map((w) => w.system)).toEqual(["Microsoft 365", "ClickUp"]);
    expect(done[0].kind).toBe("approved");
  });
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
