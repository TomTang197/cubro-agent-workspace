import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { dayOf, factSheet, keyFacts, readFacts, type Candidate, type FactContext } from "../server/agents/facts";
import { createApp } from "../server/app";
import type { LnItem, LnPurchaseOrder } from "../server/connectors/types";
import { templateProvider, withDailyLimit, type LlmProvider } from "../server/llm";
import { Store, type ApprovalItem, type SupplierEmailPayload } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const po: LnPurchaseOrder = {
  order: "PO50001", supplier: "S1", orderDate: "2026-11-02", plannedReceiptDate: "2026-12-03", confirmedReceiptDate: null, status: "Confirmed", buyer: "Priya Raman", currency: "NZD",
  lines: [{ line: 1, item: "98100", quantity: 40, received: 0, price: 2890 }, { line: 2, item: "ZZ200", quantity: 10, received: 4, price: 55.5 }],
};
const other: LnPurchaseOrder = { ...po, order: "PO50002", lines: [{ line: 1, item: "98100", quantity: 5, received: 0, price: 2890 }] };
const items = [{ item: "98100", description: "Caro bed", primarySupplier: "S1" }, { item: "ZZ200", description: "Castor to suit Caro bed", primarySupplier: "S1" }, { item: "12345", description: "Someone else's trolley", primarySupplier: "S2" }] as LnItem[];
const ctx = (order: LnPurchaseOrder | null = po): FactContext => ({ order: order ?? undefined, orders: [po, other], items, supplier: "S1", at: today });
const read = (text: string, order: LnPurchaseOrder | null = po, extra: Candidate[] = []) => keyFacts(text, ctx(order), extra);
const fact = (text: string, written: string, order: LnPurchaseOrder | null = po, extra: Candidate[] = []) => read(text, order, extra).facts.find((f) => f.text === written);

describe("key facts in an email", () => {
  it("lists the order, models, quantities, dates, prices and tracking number, each where it stands in the text", () => {
    const text = "Hi Priya,\n\nWe confirm PO50001:\n\n  40 x 98100 Caro bed @ NZD 2890.00\n  10 x ZZ200 Castor to suit Caro bed @ NZD 55.50\n\nDelivery to Tauriko is expected on 3 December 2026. Tracking number: NZP00123456789.";
    const { facts, marks } = read(text);
    expect(facts.map((f) => `${f.kind} ${f.text}`)).toEqual(["order PO50001", "item 98100", "item ZZ200", "quantity 40", "quantity 10", "date 3 December 2026", "price NZD 2890.00", "price NZD 55.50", "tracking NZP00123456789"]);
    expect(facts.every((f) => f.kind === "tracking" || f.check === "same")).toBe(true);
    // A mark is only ever a stretch of the text itself.
    for (const m of marks) expect(text.slice(m.start, m.end)).toBe(m.text);
    expect(marks.some((m) => m.differs)).toBe(false);
    expect(fact(text, "98100")).toMatchObject({ about: "Caro bed", record: "on PO50001" });
    expect(fact(text, "40")).toMatchObject({ about: "98100", record: "the quantity ordered" });
  });

  it("flags what differs from the order in Infor LN", () => {
    expect(fact("We can only supply 30 units of 98100 on PO50001.", "30 units")).toMatchObject({ check: "differs", record: "order says 40", about: "98100" });
    expect(fact("PO50001:\n  30 x 98100 Caro bed @ NZD 2990.00", "30")).toMatchObject({ check: "differs", record: "order says 40" });
    expect(fact("PO50001:\n  30 x 98100 Caro bed @ NZD 2990.00", "NZD 2990.00")).toMatchObject({ check: "differs", record: "order says NZD 2890.00" });
    expect(fact("PO50001: the price of 98100 is now USD 2890.00 each.", "USD 2890.00")).toMatchObject({ check: "differs", record: "order is in NZD" });
    expect(fact("PO50001 is delayed. The new delivery date to Tauriko is 12 December 2026.", "12 December 2026")).toMatchObject({ check: "differs", record: "9 days later than the order's due date, 3 December 2026" });
    expect(fact("Your order PO50001 will now arrive on 1 Dec.", "1 Dec")).toMatchObject({ check: "differs", record: "2 days earlier than the order's due date, 3 December 2026" });
    expect(fact("Thank you for PO59999.", "PO59999")).toMatchObject({ check: "differs", record: "not among this supplier's orders in Infor LN" });
    expect(fact("PO50001: we will send 12345 instead.", "12345")).toBeUndefined();
    expect(fact("Re PO50002: 6 x ZZ200 are ready.", "ZZ200", other)).toMatchObject({ check: "differs", record: "not on PO50002" });
    const { marks } = read("We can only supply 30 units of 98100 on PO50001.");
    expect(marks.filter((m) => m.differs).map((m) => m.text)).toEqual(["30 units"]);
  });

  it("does not flag a part shipment, a ship date, or a date and a price said in passing", () => {
    expect(fact("PO50001: we have shipped 25 of the 40 x 98100, the balance will follow.", "25")).toEqual({ kind: "quantity", text: "25", about: "98100", record: "of 40 ordered" });
    expect(fact("PO50001: 4 of the 10 x ZZ200 went last week and the other 6 are packed.", "4")).toMatchObject({ check: "same", record: "received so far of 10 ordered" });
    expect(fact("PO50001: 4 of the 10 x ZZ200 went last week and the other 6 are packed.", "6")).toMatchObject({ check: "same", record: "still to come of 10 ordered" });
    expect(fact("PO50001 will ship on 20 November 2026 for delivery by 3 December 2026.", "20 November 2026")).toEqual({ kind: "date", text: "20 November 2026" });
    expect(fact("PO50001 will ship on 20 November 2026 for delivery by 3 December 2026.", "3 December 2026")).toMatchObject({ check: "same" });
    expect(fact("Delivery of PO50001 will leave our dock on 20 November 2026.", "20 November 2026")).toEqual({ kind: "date", text: "20 November 2026" });
    expect(fact("PO50001 was placed on 2 November 2026.", "2 November 2026")).toEqual({ kind: "date", text: "2 November 2026", record: "the day the order was placed" });
    expect(fact("PO50001: freight for 98100 came to NZD 410.00 this time.", "NZD 410.00")).toEqual({ kind: "price", text: "NZD 410.00" });
    expect(fact("Prices rise by 4.5% from 1 January 2027.", "4.5%")).toEqual({ kind: "price", text: "4.5%" });
    // With no order there is nothing to compare with, so the facts are listed and none is checked.
    expect(read("We can supply 30 units of 98100 by 12 December 2026.", null).facts.map((f) => [f.text, f.check])).toEqual([["98100", undefined], ["30 units", undefined], ["12 December 2026", undefined]]);
    // Another of the supplier's orders is named, so an item missing from this one is not a mismatch.
    expect(fact("PO50002 and PO50001: ZZ200 is ready.", "ZZ200", other)?.check).toBeUndefined();
    expect(fact("PO50002 and PO50001: ZZ200 is ready.", "PO50001", other)).toMatchObject({ record: "another order with this supplier" });
  });

  it("compares a figure with its own item and its own order", () => {
    // Each figure belongs to the item on its side of the comma, whichever way round they are written.
    const inline = "PO50001 confirmed: 98100: 40 units, ZZ200: 10 units.";
    expect(fact(inline, "40 units")).toMatchObject({ about: "98100", check: "same" });
    expect(fact(inline, "10 units")).toMatchObject({ about: "ZZ200", check: "same" });
    const priced = "PO50001: 40 x 98100 Caro bed @ NZD 2890.00, 10 x ZZ200 @ NZD 55.50 and nothing else.";
    expect(read(priced).facts.filter((f) => f.check !== "same")).toEqual([]);
    expect(fact("PO50001: 98100 40 units and ZZ200 12 units.", "12 units")).toMatchObject({ about: "ZZ200", check: "differs", record: "order says 10" });
    // A comma or an "and" inside a description does not hand the price to the next item.
    const quote = "PO50001: 40 x 98100 Caro bed, electric and low @ NZD 2890.00 / 10 x ZZ200 @ NZD 55.50";
    expect(read(quote).facts.filter((f) => f.check !== "same")).toEqual([]);
    expect(fact(quote, "NZD 2890.00")).toMatchObject({ about: "98100" });
    // A total ahead of the items does not turn the prices that follow their items into the next item's.
    const totalled = "PO50001 total NZD 116,155.00: 98100 Caro bed @ NZD 2890.00, ZZ200 @ NZD 55.50";
    expect(read(totalled).facts.filter((f) => f.check !== "same")).toEqual([]);
    expect(fact(totalled, "NZD 116,155.00")).toMatchObject({ record: "the order total" });
    const summed = "PO50001: we will ship 40 x 98100 and 10 x ZZ200, 50 units in total.";
    expect(fact(summed, "50 units")).toEqual({ kind: "quantity", text: "50 units", check: "same", record: "the total ordered" });
    expect(fact("PO50001: 40 x 98100 and 10 x ZZ200, a total of 45 units.", "45 units")).toEqual({ kind: "quantity", text: "45 units", check: "differs", record: "order totals 50" });
    // Beside one item, a total is that item's.
    expect(fact("PO50001: 98100: 30 units total.", "30 units")).toMatchObject({ about: "98100", check: "differs", record: "order says 40" });
    expect(fact("PO50001: 98100: 50 units total.", "50 units")).toMatchObject({ about: "98100", check: "differs", record: "order says 40" });
    const mixed = "PO50001: 98100 is short, so we can send 30 units now and 10 units of ZZ200, at NZD 55.50 for ZZ200.";
    expect(fact(mixed, "30 units")).toEqual({ kind: "quantity", text: "30 units", about: "98100", record: "of 40 ordered" });
    expect(fact(mixed, "10 units")).toMatchObject({ about: "ZZ200", check: "same" });
    expect(fact(mixed, "NZD 55.50")).toMatchObject({ about: "ZZ200", check: "same" });
    expect(fact("PO50001: NZD 2890.00 for 98100 and NZD 60.00 each for ZZ200.", "NZD 60.00")).toMatchObject({ about: "ZZ200", check: "differs" });
    // Two orders in one email: what stands under the other order's number is listed but not held against this one.
    const two = "We confirm both orders.\nPO50001:\n  40 x 98100 @ NZD 2890.00\nPO50002:\n  5 x 98100 @ NZD 2950.00, delivery on 20 December 2026\n  3 x ZZ200";
    expect(read(two).facts.filter((f) => f.check === "differs")).toEqual([]);
    expect(fact(two, "5")).toEqual({ kind: "quantity", text: "5" });
    expect(fact(two, "20 December 2026")).toEqual({ kind: "date", text: "20 December 2026" });
    expect(fact(two, "40")).toMatchObject({ check: "same" });
    expect(read(two, other).facts.filter((f) => f.check === "differs").map((f) => f.text)).toEqual(["20 December 2026", "NZD 2950.00"]);
    expect(fact(two, "40", other)).toEqual({ kind: "quantity", text: "40" });
  });

  it("reads what is still to come in our own emails", () => {
    const ours = "We are still waiting on the balance of PO50001:\n\n  • 98100 Caro bed — 40 of 40 outstanding\n  • ZZ200 Castor to suit Caro bed — 6 of 10 outstanding\n\nSee page 2 of 3.";
    expect(read(ours).facts.filter((f) => f.kind === "quantity")).toEqual([
      { kind: "quantity", text: "40", about: "98100", check: "same", record: "the quantity ordered" },
      { kind: "quantity", text: "6", about: "ZZ200", check: "same", record: "still to come of 10 ordered" },
      { kind: "quantity", text: "10", about: "ZZ200", check: "same", record: "the quantity ordered" },
    ]);
    expect(read(ours).marks.filter((m) => m.kind === "quantity").map((m) => m.text)).toEqual(["40", "40", "6", "10"]);
  });

  it("leaves alone numbers that are not facts", () => {
    const quiet = (text: string) => read(text).facts.map((f) => f.text);
    expect(quiet("Up to 12 may arrive later, within 14 days, and the top is 200 x 90 cm. Call 07 555 0199.")).toEqual([]);
    expect(quiet("Invoice 884512 and our ref 77120 are attached, see page 2 of 3.")).toEqual([]);
    expect(quiet("Qty: 15, 3 pallets, 576M tops at $95.11 and €12, 12/12/2026 or 2026-12-14.")).toEqual(["15", "3 pallets", "12/12/2026", "2026-12-14", "$95.11", "€12"]);
    expect(quiet("34 x 576M tops")).toEqual(["34"]);
    expect(quiet("order no. 50001, P.O. 50002 and purchase order 50001")).toEqual(["50001", "P.O. 50002"]);
  });

  it("lists a fact said twice once, and marks every mention", () => {
    const { facts, marks } = read("PO50001: 40 x 98100. To confirm, PO50001 is for 40 units of 98100.");
    expect(facts.map((f) => f.text)).toEqual(["PO50001", "98100", "40"]);
    expect(marks.map((m) => m.text)).toEqual(["PO50001", "40", "98100", "PO50001", "40 units", "98100"]);
  });

  it("reads a date written without a year as the one nearest the email", () => {
    expect(dayOf("3 December", today)).toBe("2026-12-03");
    expect(dayOf("12 January", today)).toBe("2027-01-12");
    expect(dayOf("Dec 3rd, 2026", today)).toBe("2026-12-03");
    expect(dayOf("03/12/26", today)).toBe("2026-12-03");
    expect(dayOf("12/25/2026", today)).toBe("2026-12-25");
    expect(dayOf("31 February", today)).toBeUndefined();
  });

  it("keeps what the model read only where the email says exactly that", () => {
    const text = "PO50001: thirty Caro bed frames are packed, another 8 beds follow in week 50. Allow 30 days.";
    const extra: Candidate[] = [
      { kind: "quantity", text: "8 beds" }, { kind: "date", text: "week 50" }, { kind: "item", text: "Caro bed" },
      { kind: "quantity", text: "30 beds" }, // not in the email
      { kind: "date", text: "12 December 2026" }, // made up
      { kind: "quantity", text: "30" }, // a bare number: the same digits could be anything
      { kind: "order", text: "PO5000" }, // part of a longer number
      { kind: "price", text: "packed" }, // a price has a number in it
    ];
    const { facts, marks } = read(text, po, extra);
    expect(facts.map((f) => `${f.kind} ${f.text}`)).toEqual(["order PO50001", "item Caro bed", "quantity 8 beds", "date week 50"]);
    for (const m of marks) expect(text.slice(m.start, m.end)).toBe(m.text);
    // What the model found is compared with the order like any other fact.
    expect(fact(text, "Caro bed", po, extra)).toMatchObject({ about: "98100", check: "same" });
    expect(fact(text, "8 beds", po, extra)).toMatchObject({ check: "differs", record: "order says 40" });
    // The rules' reading of a stretch of text stands: the model cannot relabel it.
    expect(read("PO50001 is due 3 December 2026.", po, [{ kind: "price", text: "3 December 2026" }]).facts.map((f) => f.kind)).toEqual(["order", "date"]);
  });

  it("marks the subject and the body apart", () => {
    const sheet = factSheet({ subject: "RE: PO50001 — 30 units", body: "We can only supply 30 units of 98100." }, ctx());
    expect(sheet.order).toBe("PO50001");
    expect(sheet.subject.map((m) => [m.start, m.text])).toEqual([[4, "PO50001"], [14, "30 units"]]);
    expect(sheet.body.map((m) => [m.start, m.text, m.differs])).toEqual([[19, "30 units", true], [31, "98100", false]]);
  });

  it("asks the model for a list and takes nothing else from it", async () => {
    const asked = vi.fn(async (_: { instructions: string; text: string }) => 'Here you go:\n```json\n[{"kind":"quantity","text":" 8 beds "},{"kind":"colour","text":"red"},{"kind":"date"},null]\n```');
    expect(await readFacts({ ...templateProvider, read: asked }, "another 8 beds follow")).toEqual([{ kind: "quantity", text: "8 beds" }]);
    expect(asked.mock.calls[0][0]).toMatchObject({ text: "another 8 beds follow" });
    await expect(readFacts({ ...templateProvider, read: async () => "I cannot help with that." }, "x")).rejects.toThrow("did not answer with a list");
    expect(await readFacts(templateProvider, "x")).toEqual([]);
  });
});

describe("key facts in the workspace", () => {
  const setup = (llm: LlmProvider = templateProvider, now = () => today) => { const store = new Store({ today }); return { store, app: createApp(store, { llm, env: {}, now }) }; };
  const ack = (store: Store) => store.state.systems.m365.messages.find((m) => m.folder === "Inbox" && /order acknowledgement$/.test(m.subject) && /acknowledged \d+ units/.test(m.body))!;

  it("shows a supplier's email with what differs from its order, and leaves the email as it was", async () => {
    const { store, app } = setup(), m = ack(store), before = m.body;
    const order = store.state.systems.inforln.purchaseOrders.find((o) => m.subject.includes(o.order))!;
    const sheet = (await request(app).get(`/api/supplier-emails/facts?reply=${m.id}&quick=1`).expect(200)).body;
    expect(sheet.order).toBe(order.order);
    expect(sheet.more).toBeUndefined();
    const wrong = sheet.facts.filter((f: { check?: string }) => f.check === "differs");
    expect(wrong).toEqual([{ kind: "quantity", text: String(Math.round(order.lines[0].quantity * 0.75)), about: order.lines[0].item, check: "differs", record: `order says ${order.lines[0].quantity}` }]);
    for (const mark of sheet.body) expect(m.body.slice(mark.start, mark.end)).toBe(mark.text);
    expect(sheet.subject.map((x: { text: string }) => x.text)).toEqual([order.order]);
    expect(m.body).toBe(before);
    await request(app).get("/api/supplier-emails/facts?supplier=" + order.supplier).expect(400);
  });

  it("has the model read each email once, and falls back to the rules when it fails", async () => {
    const reading = vi.fn(async ({ text }: { text: string }) => JSON.stringify([{ kind: "item", text: /\d+ x \S+ (\w+ \w+)/.exec(text)![1] }, { kind: "quantity", text: "999 units" }]));
    const llm: LlmProvider = { name: "Model", polish: async (i) => i.draft, read: reading };
    let now = today;
    const { store, app } = setup(llm, () => now), m = ack(store);
    const quick = (await request(app).get(`/api/supplier-emails/facts?reply=${m.id}&quick=1`).expect(200)).body;
    expect(quick).toMatchObject({ more: true });
    expect(reading).not.toHaveBeenCalled();
    const full = (await request(app).get(`/api/supplier-emails/facts?reply=${m.id}`).expect(200)).body;
    expect(full.readBy).toBe("Model");
    expect(full.facts.length).toBe(quick.facts.length + 1);
    expect(full.facts.some((f: { text: string }) => f.text === "999 units")).toBe(false);
    await request(app).get(`/api/supplier-emails/facts?reply=${m.id}`).expect(200);
    expect(reading).toHaveBeenCalledTimes(1);

    reading.mockRejectedValue(new Error("boom"));
    const part = store.state.systems.m365.messages.find((x) => x.folder === "Inbox" && / part shipment$/.test(x.subject))!;
    const failed = (await request(app).get(`/api/supplier-emails/facts?reply=${part.id}`).expect(200)).body;
    expect(failed.readBy).toBeUndefined();
    expect(failed.facts.some((f: { kind: string }) => f.kind === "tracking")).toBe(true);
    // A failed reading stands for ten minutes, so a model that is down is not asked on every look.
    await request(app).get(`/api/supplier-emails/facts?reply=${part.id}`).expect(200);
    expect(reading).toHaveBeenCalledTimes(2);
    now = new Date(today.getTime() + 11 * 60_000);
    reading.mockResolvedValue("[]");
    expect((await request(app).get(`/api/supplier-emails/facts?reply=${part.id}`).expect(200)).body.readBy).toBe("Model");
    expect(reading).toHaveBeenCalledTimes(3);
  });

  it("does not ask the model again for each change to a draft while its reading of the email has failed", async () => {
    const reading = vi.fn(async (_: { instructions: string; text: string }): Promise<string> => { throw new Error("Gemini error 429"); });
    const { store, app } = setup({ name: "Model", polish: async (i) => i.draft, read: reading }), m = ack(store);
    const draft: ApprovalItem = (await request(app).post("/api/supplier-emails").send({ reply: m.id, options: ["thanks"], own: [], user: "Priya Raman" }).expect(200)).body;
    for (const n of [1, 2, 3, 4, 5]) {
      const facts = (await request(app).post(`/api/approvals/${draft.id}/facts`).send({ body: `Hi, thanks ${n}`, quick: false }).expect(200)).body;
      expect(facts.inReplyTo.readBy).toBeUndefined();
    }
    expect(reading).toHaveBeenCalledTimes(1);
  });

  it("shows a draft's facts as it reads now, and sends the email as plain text", async () => {
    const { store, app } = setup(), m = ack(store);
    const draft: ApprovalItem = (await request(app).post("/api/supplier-emails").send({ reply: m.id, options: ["thanks"], own: [], user: "Priya Raman" }).expect(200)).body;
    const p = draft.payload as SupplierEmailPayload, order = store.state.systems.inforln.purchaseOrders.find((o) => o.order === p.purchaseOrder)!;
    const saved = (await request(app).post(`/api/approvals/${draft.id}/facts`).send({ quick: true }).expect(200)).body;
    expect(saved.draft.order).toBe(order.order);
    for (const mark of saved.draft.body) expect(p.body.slice(mark.start, mark.end)).toBe(mark.text);
    expect(saved.inReplyTo.facts.some((f: { check?: string }) => f.check === "differs")).toBe(true);
    // Edits not saved yet are read as typed.
    const body = `${p.body}\n\nPlease send all ${order.lines[0].quantity + 5} units of ${order.lines[0].item}.`;
    const typed = (await request(app).post(`/api/approvals/${draft.id}/facts`).send({ body, quick: true }).expect(200)).body;
    expect(typed.draft.facts.filter((f: { check?: string }) => f.check === "differs")).toEqual([expect.objectContaining({ kind: "quantity", text: `${order.lines[0].quantity + 5} units`, record: `order says ${order.lines[0].quantity}` })]);
    expect((store.state.approvals.find((a) => a.id === draft.id)!.payload as SupplierEmailPayload).body).toBe(p.body);

    await request(app).post(`/api/approvals/${draft.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    const sent = store.state.systems.m365.messages.filter((x) => x.conversationId === m.conversationId && x.folder !== "Inbox" && x.subject === p.subject).at(-1)!;
    expect(sent.body).toBe(p.body);
    expect(sent.body).not.toMatch(/<mark|<span|\*\*/);
    const post = store.state.approvals.find((a) => a.payload.type === "social_post")!;
    await request(app).post(`/api/approvals/${post.id}/facts`).send({}).expect(400);
  });
});

describe("the model's daily limit on reading emails", () => {
  it("is counted apart from the drafts it writes", async () => {
    let now = new Date("2026-11-23T10:00:00Z");
    const polish = vi.fn(async () => "text"), reading = vi.fn(async () => "[]"), input = { task: "t", draft: "d", context: "c", tone: "n" };
    const llm = withDailyLimit({ name: "Model", polish, read: reading }, 1, () => now, 2);
    await llm.read!({ instructions: "i", text: "a" });
    await llm.read!({ instructions: "i", text: "b" });
    await expect(llm.read!({ instructions: "i", text: "c" })).rejects.toThrow("daily limit of 2 emails read by the model reached");
    expect(await llm.polish(input)).toBe("text");
    now = new Date("2026-11-24T00:00:01Z");
    expect(await llm.read!({ instructions: "i", text: "c" })).toBe("[]");
    expect(withDailyLimit(templateProvider, 1).read).toBeUndefined();
  });
});
