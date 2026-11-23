import { describe, expect, it } from "vitest";
import { FX_PER_NZD, STAFF } from "../server/data/catalogue";
import { generateSystemData } from "../server/data/seed";

const today = new Date("2026-11-23T00:00:00Z");
const todayIso = "2026-11-23";
const d = generateSystemData(1, today);
const items = new Map(d.inforln.items.map((i) => [i.item, i]));
const suppliers = new Map(d.inforln.suppliers.map((s) => [s.supplier, s]));
const accounts = new Map(d.salesforce.accounts.map((a) => [a.Id, a]));
const orders = new Set(d.inforln.purchaseOrders.map((p) => p.order));
const staff = new Set(STAFF.map((s) => s.name));
const isWeekday = (iso: string) => ![0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
const nz = (iso: string, part: "hour" | "weekday") => new Intl.DateTimeFormat("en-NZ", part === "hour" ? { hour: "numeric", hour12: false, timeZone: "Pacific/Auckland" } : { weekday: "short", timeZone: "Pacific/Auckland" }).format(new Date(iso));
const poRefs = (s: string) => s.match(/PO\d{5}/g) ?? [];

describe("sample data volume", () => {
  it("is the same every time for the same seed and date", () => {
    expect(generateSystemData(1, today)).toEqual(d);
    expect(generateSystemData(2, today)).not.toEqual(d);
  });
  it("fills every system", () => {
    expect(d.inforln.items.length).toBeGreaterThanOrEqual(150);
    expect(d.inforln.suppliers.length).toBeGreaterThanOrEqual(20);
    expect(d.inforln.purchaseOrders.length).toBeGreaterThanOrEqual(250);
    expect(d.salesforce.accounts.length).toBeGreaterThanOrEqual(120);
    expect(d.salesforce.contacts.length).toBeGreaterThanOrEqual(250);
    expect(d.salesforce.opportunities.length).toBeGreaterThanOrEqual(200);
    expect(d.salesforce.campaigns.length).toBeGreaterThanOrEqual(12);
    expect(d.salesforce.cases.length).toBeGreaterThanOrEqual(150);
    expect(d.m365.events.length).toBeGreaterThanOrEqual(100);
    expect(d.m365.messages.length).toBeGreaterThanOrEqual(180);
    expect(d.m365.assets.length).toBeGreaterThanOrEqual(250);
    expect(d.m365.teamsPosts.length).toBeGreaterThanOrEqual(30);
    expect(d.clickup.tasks.length).toBeGreaterThanOrEqual(250);
  });
});

describe("Infor LN sample data", () => {
  it("only orders items from the supplier that makes them, in that supplier's currency", () => {
    for (const po of d.inforln.purchaseOrders) {
      const s = suppliers.get(po.supplier)!;
      expect(s, po.order).toBeDefined();
      expect(po.currency, po.order).toBe(s.currency);
      expect(po.lines.length).toBeGreaterThan(0);
      for (const l of po.lines) {
        const item = items.get(l.item)!;
        expect(item.primarySupplier, `${po.order} line ${l.line}`).toBe(po.supplier);
        // The price is in the order currency, not NZD: a CNY line costs several times the NZD figure.
        expect(l.price / (item.standardCost! * FX_PER_NZD[po.currency])).toBeCloseTo(1, 1);
      }
    }
  });
  it("gives every supplier items and purchase orders", () => {
    for (const s of d.inforln.suppliers) {
      expect(d.inforln.items.some((i) => i.primarySupplier === s.supplier), s.name).toBe(true);
      expect(d.inforln.purchaseOrders.some((p) => p.supplier === s.supplier), s.name).toBe(true);
      expect(s.onTimeRate).toBeGreaterThanOrEqual(0);
      expect(s.onTimeRate).toBeLessThanOrEqual(1);
    }
  });
  it("keeps order dates, receipts and status in step", () => {
    for (const po of d.inforln.purchaseOrders) {
      const ordered = po.lines.reduce((n, l) => n + l.quantity, 0), received = po.lines.reduce((n, l) => n + l.received, 0);
      expect(isWeekday(po.orderDate) && isWeekday(po.plannedReceiptDate) && (!po.confirmedReceiptDate || isWeekday(po.confirmedReceiptDate)), `${po.order} dates fall on weekdays`).toBe(true);
      expect(po.orderDate <= todayIso && po.orderDate < po.plannedReceiptDate, po.order).toBe(true);
      if (po.status === "Closed" || po.status === "Received") { expect(received, po.order).toBe(ordered); expect(po.confirmedReceiptDate! <= todayIso, po.order).toBe(true); }
      else if (po.status === "Partially received") { expect(received, po.order).toBeGreaterThan(0); expect(received, po.order).toBeLessThan(ordered); }
      else { expect(received, po.order).toBe(0); expect(po.confirmedReceiptDate === null, po.order).toBe(po.status !== "Confirmed"); }
    }
  });
  it("leaves the purchasing team something to chase", () => {
    const open = d.inforln.purchaseOrders.filter((p) => p.status !== "Closed" && p.status !== "Received");
    expect(open.length).toBeGreaterThanOrEqual(20);
    expect(open.some((p) => (p.confirmedReceiptDate ?? p.plannedReceiptDate) < todayIso)).toBe(true);
    expect(d.inforln.items.some((i) => i.onHand < i.reorderPoint)).toBe(true);
    expect(d.inforln.items.every((i) => i.standardCost! < i.unitPrice)).toBe(true);
  });
});

describe("Salesforce sample data", () => {
  it("uses 18-character Salesforce IDs with the right object prefix", () => {
    const check = (rows: { Id: string }[], prefix: string) => { for (const r of rows) expect(r.Id).toMatch(new RegExp(`^${prefix}[A-Za-z0-9]{15}$`)); };
    check(d.salesforce.accounts, "001"); check(d.salesforce.contacts, "003"); check(d.salesforce.opportunities, "006");
    check(d.salesforce.campaigns, "701"); check(d.salesforce.cases, "500"); check(d.salesforce.activities, "00T");
    const ids = Object.values(d.salesforce).flat().map((r) => r.Id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("links contacts, opportunities, cases and campaigns to real accounts and Infor LN items", () => {
    for (const a of d.salesforce.accounts) expect(d.salesforce.contacts.some((c) => c.AccountId === a.Id), a.Name).toBe(true);
    for (const c of d.salesforce.contacts) expect(accounts.has(c.AccountId)).toBe(true);
    for (const o of d.salesforce.opportunities) { expect(accounts.has(o.AccountId)).toBe(true); expect(o.ProductSkus.length).toBeGreaterThan(0); expect(o.ProductSkus.every((s) => items.has(s)), o.Name).toBe(true); }
    for (const c of d.salesforce.cases) { expect(accounts.has(c.AccountId)).toBe(true); expect(items.has(c.ProductSku), c.Subject).toBe(true); }
    for (const c of d.salesforce.campaigns) expect(c.ProductSkus.every((s) => items.has(s)), c.Name).toBe(true);
  });
  it("closes won and lost opportunities in the past and keeps open ones in the future", () => {
    for (const o of d.salesforce.opportunities) expect(o.StageName.startsWith("Closed") ? o.CloseDate <= todayIso : o.CloseDate >= todayIso, `${o.Name} ${o.StageName} ${o.CloseDate}`).toBe(true);
  });
  it("covers Cubro's four markets with one account owner per territory", () => {
    const markets = new Set(d.salesforce.accounts.map((a) => a.Market__c));
    expect([...markets].sort()).toEqual(["Aged Care", "Community Care", "Hospital Care", "Wholesale"]);
    expect(d.salesforce.accounts.filter((a) => a.Market__c === "Aged Care").length / d.salesforce.accounts.length).toBeGreaterThan(0.3);
    const owners = new Map<string, Set<string>>();
    for (const a of d.salesforce.accounts) { expect(staff.has(a.OwnerName), a.OwnerName).toBe(true); const k = `${a.Region}|${a.Market__c}`; owners.set(k, (owners.get(k) ?? new Set()).add(a.OwnerName)); }
    for (const [territory, o] of owners) expect(o.size, territory).toBe(1);
    expect(new Set(d.salesforce.accounts.map((a) => a.Name)).size).toBe(d.salesforce.accounts.length);
  });
});

describe("Microsoft 365 sample data", () => {
  it("puts calendar events on New Zealand weekdays in working hours", () => {
    for (const e of d.m365.events) {
      const hour = Number(nz(e.start, "hour"));
      expect(hour >= 7 && hour <= 17, `${e.subject} starts ${hour}:00 NZ time`).toBe(true);
      expect(["Sat", "Sun"]).not.toContain(nz(e.start, "weekday"));
      expect(e.end > e.start).toBe(true);
    }
    const shows = d.m365.events.filter((e) => e.category === "Trade show").map((e) => e.subject);
    expect(new Set(shows).size).toBe(shows.length);
  });
  it("delivers supplier replies to the mailbox supplier emails are sent from", () => {
    const supplierEmails = new Set(d.inforln.suppliers.map((s) => s.email));
    const replies = d.m365.messages.filter((m) => m.folder === "Inbox" && supplierEmails.has(m.from.address));
    expect(replies.length).toBeGreaterThan(50);
    for (const m of replies) expect(m.to[0].address).toBe("purchasing@cubro.co.nz");
    expect(d.m365.messages.some((m) => m.folder === "Sent Items")).toBe(true);
    expect(JSON.stringify(d)).not.toContain("cubro.example");
  });
  it("only mentions purchase orders that exist in Infor LN", () => {
    for (const m of d.m365.messages) expect(poRefs(m.subject + m.body).every((r) => orders.has(r)), m.subject).toBe(true);
    for (const t of d.m365.teamsPosts) expect(poRefs(t.text).every((r) => orders.has(r)), t.text).toBe(true);
    for (const t of d.clickup.tasks) expect(poRefs(t.name + t.description).every((r) => orders.has(r)), t.name).toBe(true);
  });
  it("names SharePoint files after real items with an extension that matches the kind", () => {
    const ext = { photo: /\.(jpg|png)$/, video: /\.mp4$/, brochure: /\.pdf$/, logo: /\.(svg|png|eps)$/ };
    for (const a of d.m365.assets) {
      expect(a.name).toMatch(ext[a.kind]);
      expect(a.webUrl.endsWith(a.name)).toBe(true);
      if (a.productSku) expect(items.has(a.productSku), a.name).toBe(true);
    }
    for (const i of d.inforln.items.filter((x) => x.itemGroup !== "Spare parts")) expect(d.m365.assets.some((a) => a.productSku === i.item && a.kind === "photo"), i.description).toBe(true);
  });
});

describe("ClickUp sample data", () => {
  it("assigns tasks to Cubro staff and does not leave old work untouched", () => {
    const tenDaysAgo = "2026-11-13";
    for (const t of d.clickup.tasks) {
      expect(t.assignees.length).toBeGreaterThan(0);
      expect(t.assignees.every((a) => staff.has(a)), t.name).toBe(true);
      expect(t.description.length).toBeGreaterThan(10);
      if (t.status === "to do") expect(t.due_date! >= tenDaysAgo, `${t.name} due ${t.due_date}`).toBe(true);
    }
    expect(new Set(d.clickup.tasks.map((t) => t.id)).size).toBe(d.clickup.tasks.length);
    expect(new Set(d.clickup.tasks.map((t) => t.list))).toEqual(new Set(["Marketing", "Purchasing", "Operations", "Sales"]));
  });
});
