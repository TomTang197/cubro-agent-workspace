import request from "supertest";
import { describe, expect, it } from "vitest";
import { composeBody, composeParts, emailOptions, emailTopic, orderIn, revisedDate, tidyOwnLine, writeList, type ComposeInput } from "../server/agents/compose";
import { createApp } from "../server/app";
import { MAIL_LIST_LIMIT, type LnPurchaseOrder, type MailMessage } from "../server/connectors/types";
import { templateProvider, type LlmProvider } from "../server/llm";
import { Store, type ApprovalItem, type SupplierEmailPayload } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const setup = (llm: LlmProvider = templateProvider) => { const store = new Store({ today }); return { store, app: createApp(store, { llm, env: {}, now: () => today }) }; };
const ln = (store: Store) => store.state.systems.inforln;
const input = (store: Store, po?: LnPurchaseOrder, message?: MailMessage, supplierId = po?.supplier): ComposeInput => {
  const supplier = ln(store).suppliers.find((s) => s.supplier === supplierId)!;
  return { supplier, order: po, message, orders: ln(store).purchaseOrders.filter((o) => o.supplier === supplier.supplier), items: ln(store).items, today };
};
const ids = (store: Store, po?: LnPurchaseOrder, message?: MailMessage, supplierId?: string) => emailOptions(input(store, po, message, supplierId ?? po?.supplier)).map((o) => o.id);
const due = (po: LnPurchaseOrder) => po.confirmedReceiptDate ?? po.plannedReceiptDate;
const fromSupplier = (store: Store, test: (m: MailMessage) => boolean) => store.state.systems.m365.messages.find((m) => m.folder === "Inbox" && ln(store).suppliers.some((s) => s.email === m.from.address) && test(m))!;

describe("what a supplier email can say", () => {
  it("comes from the state of the order", () => {
    const { store } = setup();
    const orders = ln(store).purchaseOrders;
    const late = orders.find((po) => po.status === "Confirmed" && due(po) < "2026-11-23")!;
    const lateOptions = emailOptions(input(store, late));
    expect(lateOptions.map((o) => o.id)).toEqual(expect.arrayContaining(["ship-date", "tracking"]));
    expect(lateOptions.find((o) => o.id === "ship-date")!.text).toContain(`Our purchase order ${late.order} was due`);
    expect(lateOptions.map((o) => o.id)).not.toContain("on-track");

    const onTime = orders.find((po) => po.status === "Confirmed" && due(po) > "2026-11-23")!;
    expect(ids(store, onTime)).toContain("on-track");
    expect(ids(store, onTime)).not.toContain("ship-date");

    const unconfirmed = orders.find((po) => po.status === "Sent")!;
    expect(ids(store, unconfirmed)).toContain("confirm-order");

    const part = orders.find((po) => po.status === "Partially received")!;
    const balance = emailOptions(input(store, part)).find((o) => o.id === "balance")!;
    const left = part.lines.find((l) => l.received < l.quantity)!;
    expect(balance.text).toContain(`${left.item} `);
    expect(balance.text).toContain(`${left.quantity - left.received} of ${left.quantity} outstanding`);

    // An order that has arrived leaves nothing to ask about it.
    expect(ids(store, orders.find((po) => po.status === "Received")!)).toEqual([]);
  });

  it("answers the supplier's own email: a delay, a price rise, a closure", () => {
    const { store } = setup();
    const delay = fromSupplier(store, (m) => /revised delivery date/.test(m.subject));
    expect(emailTopic(delay)).toBe("delay");
    const po = ln(store).purchaseOrders.find((o) => delay.subject.includes(o.order))!;
    const options = emailOptions(input(store, po, delay));
    const newDate = /new delivery date to Tauriko is ([^.]+)\./.exec(delay.body)![1];
    expect(options.find((o) => o.id === "accept-date")!.text).toContain(`the new delivery date of ${newDate}`);
    expect(options.map((o) => o.id)).toEqual(expect.arrayContaining(["earlier", "firm-date"]));
    // A later date in the notice that is not the delivery date is not mistaken for it.
    const tracked = { ...delay, body: `The new delivery date to Tauriko is ${newDate}. We will send tracking details by 12 February 2027.` };
    expect(emailOptions(input(store, po, tracked)).find((o) => o.id === "accept-date")!.text).toContain(`the new delivery date of ${newDate}`);
    expect(revisedDate("It was due 23 November 2026 and is now expected on 9 December 2026.")).toBe("9 December 2026");
    expect(revisedDate("Sorry for the delay. Shipping 3 December 2026.")).toBe("3 December 2026");
    // Two dates and nothing to say which is the new one: none is quoted.
    expect(revisedDate("Vessel sails 3 December 2026, arrives 20 December 2026.")).toBeUndefined();
    // The date the delivery is moving from is never the new one, whichever way round the sentence puts them.
    expect(revisedDate("The revised delivery has moved from 23 November 2026 to 9 December 2026.")).toBe("9 December 2026");
    expect(revisedDate("Delivery has been pushed back from 23 November to 9 December.")).toBe("9 December");
    expect(revisedDate("The new date is 9 December 2026 instead of 23 November 2026.")).toBe("9 December 2026");
    expect(revisedDate("The revised schedule replaces the original delivery date of 23 November 2026.")).toBeUndefined();
    expect(revisedDate("The order was due 23 November 2026 and will be late.")).toBeUndefined();
    expect(revisedDate("New date 9 December 2026. To confirm, the revised arrival is 9 December.")).toBe("9 December 2026");
    expect(revisedDate("The new ship date is 3 December 2026 and the new arrival date is 20 December 2026.")).toBeUndefined();
    expect(revisedDate("Lot 1 has a new ship date of 3 December and the new delivery date for lot 2 is 20 December.")).toBeUndefined();
    expect(revisedDate("The new confirmed date for dispatch is 1 December; arrival is expected 9 December.")).toBeUndefined();
    expect(revisedDate("Due to a shipping delay, the new delivery date is 9 December instead of 23 November.")).toBe("9 December");
    expect(revisedDate("Dispatch is now due on 1 December. Arrival is expected 9 December.")).toBeUndefined();
    expect(revisedDate("The new delivery date is 3 December for the first lot and the new delivery date is 20 December for the rest.")).toBeUndefined();
    // A date is read by the words since the date before it: a tracking date after the new delivery date does not compete with it.
    expect(revisedDate("The new delivery date is 9 December 2026 and we will send tracking details by 12 December 2026.")).toBe("9 December 2026");
    // "Was delayed until" is where the delivery moved to, not where it was.
    expect(revisedDate("Delivery was delayed until 9 December.")).toBe("9 December");
    expect(revisedDate("The order, which was due 23 November, was put back to 9 December.")).toBe("9 December");
    expect(revisedDate("Delivery was delayed from 23 November to 9 December.")).toBe("9 December");
    // A moving word about something else does not make its date the delivery date.
    expect(revisedDate("We changed carriers on 1 December; the new delivery estimate is 9 December.")).toBe("9 December");
    expect(revisedDate("We changed carriers on 1 December and expect delivery on 9 December.")).toBeUndefined();
    expect(revisedDate("The new carrier collected it on 1 December, so it is now due on 9 December.")).toBe("9 December");
    expect(revisedDate("We updated the delivery address on 1 December. Arrival is expected 9 December.")).toBeUndefined();
    expect(revisedDate("The delivery date was revised to 9 December instead of 23 November.")).toBe("9 December");
    // "Updated" or "revised" about a payment or a freight quote is not about the delivery.
    expect(revisedDate("The updated payment date is 1 December. Delivery is expected 9 December.")).toBeUndefined();
    expect(revisedDate("Our revised freight estimate is valid to 1 December. Delivery is expected 9 December.")).toBeUndefined();
    expect(revisedDate("Revised delivery: 9 December", true)).toBe("9 December");
    // The day it ships is not the day it arrives.
    expect(revisedDate("Revised shipping: 1 December. Expected arrival 9 December.")).toBeUndefined();
    expect(revisedDate("We updated the delivery date to 9 December and will invoice on 12 December.")).toBe("9 December");
    expect(revisedDate("The new confirmed delivery date is 9 December; documents follow by 12 December.")).toBe("9 December");
    expect(revisedDate("The updated delivery schedule gives 9 December.", true)).toBe("9 December");
    // A body with several unmarked dates is unclear, and the subject's date (here the original due date) does not settle it.
    const unclear = { ...delay, subject: `${po.order} due 23 November 2026 — delay`, body: "Vessel sails 3 December 2026, arrives 20 December 2026." };
    expect(emailOptions(input(store, po, unclear)).find((o) => o.id === "accept-date")).toMatchObject({ label: "Accept the delay", text: expect.not.stringMatching(/November|December/) });
    // With no date in the body, the subject counts only where it calls its date the new one.
    const inSubject = (subject: string) => emailOptions(input(store, po, { ...delay, subject, body: "Apologies, this order is delayed at the port." })).find((o) => o.id === "accept-date")!.label;
    expect(inSubject(`${po.order} due 23 November 2026 — delay`)).toBe("Accept the delay");
    expect(inSubject(`${po.order} delay — new delivery date 9 December 2026`)).toBe("Accept the new date, 9 December");
    // They have just given the new date, so it is not asked for.
    expect(options.map((o) => o.id)).not.toContain("ship-date");
    // What answers their email comes before what the order suggests.
    expect(options[0].from).toBe("email");

    const price = fromSupplier(store, (m) => /^Price list effective/.test(m.subject));
    const supplier = ln(store).suppliers.find((s) => s.email === price.from.address)!;
    const priceOptions = emailOptions(input(store, undefined, price, supplier.supplier));
    expect(priceOptions.map((o) => o.id)).toEqual(["note-price", "hold-price", "price-list"]);
    expect(priceOptions[0].text).toMatch(/price change of [\d.]+% from \d+ \w+ \d{4}/);

    expect(emailTopic({ subject: "Christmas and New Year closure", body: "We close on 23 December and reopen on 11 January." })).toBe("closure");
    expect(emailTopic({ subject: "Hello", body: "Do you have a new catalogue?" })).toBe("other");
    // A confirmation is of the order, now: something still to be confirmed is not one.
    expect(emailTopic({ subject: "RE: Purchase order PO41694 — Cubro Ltd", body: "Thank you for the order. We confirm PO41694 at the prices shown." })).toBe("confirmed");
    expect(emailTopic({ subject: "RE: Purchase order PO41694 — Cubro Ltd", body: "We are pleased to confirm your purchase order." })).toBe("confirmed");
    expect(emailTopic({ subject: "Order", body: "We confirm the attached purchase order." })).toBe("confirmed");
    expect(emailTopic({ subject: "Order", body: "We hereby confirm receipt of your new order." })).toBe("confirmed");
    expect(emailTopic({ subject: "Artwork", body: "We confirm the artwork for your order is at the printer." })).toBe("other");
    expect(emailTopic({ subject: "Artwork", body: "We will start the run once we confirm the artwork. Please send the final file." })).toBe("other");
    expect(emailTopic({ subject: "PO41694", body: "We will send a ship date once the order is confirmed by our factory." })).toBe("other");
  });

  it("finds the order a supplier's email is about, with or without the PO prefix", () => {
    const { store } = setup();
    const [a, b] = ln(store).purchaseOrders, digits = a.order.replace(/^\D+/, "");
    expect(orderIn({ subject: `Your order ${digits}`, body: "It ships next week." }, [a, b])).toBe(a);
    expect(orderIn({ subject: "Update", body: `Regarding ${b.order.toLowerCase()} and ${a.order}.` }, [a, b])).toBe(b);
    // A longer number that only contains the digits is another number.
    expect(orderIn({ subject: "Invoice", body: `Invoice 9${digits}7 attached.` }, [a, b])).toBeUndefined();
    // An invoice number that happens to be one order's digits does not outrank, or stand in for, the order the email names.
    expect(orderIn({ subject: "Statement", body: `Invoice ${digits} is attached. It covers ${b.order}.` }, [a, b])).toBe(b);
    expect(orderIn({ subject: "Statement", body: `Invoice no. ${digits} and tracking #${digits} attached.` }, [a, b])).toBeUndefined();
    expect(orderIn({ subject: "Statement", body: `Invoice ${digits}7 attached for order ${digits}.` }, [a, b])).toBe(a);
    // An order number is an order number however it is spaced or introduced, and comes before a later order written closed up.
    const prefix = a.order.slice(0, -digits.length);
    expect(orderIn({ subject: "Delay", body: `${prefix} ${digits} is delayed. ${b.order} is on time.` }, [a, b])).toBe(a);
    expect(orderIn({ subject: "Delay", body: `Invoice ${b.order.replace(/^\D+/, "")} attached. ${prefix}-${digits} is delayed.` }, [a, b])).toBe(a);
    // The supplier's own sales order, account or reference number is not our order, even when its digits match one.
    expect(orderIn({ subject: "Delay", body: `Sales order ${digits} for ${b.order} is delayed.` }, [a, b])).toBe(b);
    expect(orderIn({ subject: "Delay", body: `Sales-order no. ${digits} for ${b.order} is delayed.` }, [a, b])).toBe(b);
    for (const said of [`Sales order ${digits}`, `Sales-order no. ${digits}`, `Account no. ${digits}`, `Our ref: ${digits}`, `Customer #${digits}`]) expect(orderIn({ subject: "Statement", body: `${said} is attached.` }, [a, b])).toBeUndefined();
    // "Order no." and "Order ref:" name our order, and come before an earlier bare number.
    const other = b.order.replace(/^\D+/, "");
    for (const said of [`Order no. ${digits}`, `Order ref: ${digits}`, `Re order #${digits}`]) expect(orderIn({ subject: "Delay", body: `Carton ${other}. ${said} is delayed.` }, [a, b])).toBe(a);
    for (const said of [`PO reference ${digits}`, `P.O. #${digits}`, `Purchase order no. ${digits}`, `your order ref: ${digits}`]) expect(orderIn({ subject: "Delay", body: `${said} is delayed.` }, [a, b])).toBe(a);
  });

  it("offers what the supplier's record suggests when no order is picked", () => {
    const { store } = setup();
    const supplier = ln(store).suppliers.find((s) => ln(store).purchaseOrders.some((po) => po.supplier === s.supplier && po.status === "Confirmed"))!;
    const options = emailOptions(input(store, undefined, undefined, supplier.supplier));
    expect(options.map((o) => o.id)).toEqual(expect.arrayContaining(["open-orders", "terms"]));
    expect(options.find((o) => o.id === "terms")!.text).toContain(`${supplier.avgLeadTimeDays} days and ${supplier.paymentTerms}`);
    expect(options.every((o) => o.from === "supplier")).toBe(true);
  });

  it("addresses a reply to the Reply-To address only when it is one of the supplier's own mailboxes", () => {
    const { store } = setup();
    const delay = fromSupplier(store, (m) => /revised delivery date/.test(m.subject));
    const po = ln(store).purchaseOrders.find((o) => delay.subject.includes(o.order))!;
    expect(composeParts(input(store, po, delay), "Priya Raman").to.address).toBe(delay.from.address);
    const orders = { name: "Order desk", address: `orders@${delay.from.address.split("@")[1].toUpperCase()}` };
    expect(composeParts(input(store, po, { ...delay, replyTo: [orders] }), "Priya Raman").to).toEqual(orders);
    // A Reply-To outside the supplier's domain could be anyone's, so the reply keeps the address Infor LN holds.
    const elsewhere = { name: "Farid", address: "farid.orders@freemail.example.com" };
    expect(composeParts(input(store, po, { ...delay, replyTo: [elsewhere] }), "Priya Raman").to.address).toBe(delay.from.address);
    expect(composeParts(input(store, po, { ...delay, replyTo: [elsewhere, orders] }), "Priya Raman").to).toEqual(orders);
  });

  it("signs with the writer's own name and job", () => {
    const { store } = setup();
    const parts = composeParts(input(store, ln(store).purchaseOrders[0]), "Mark Jensen");
    expect(composeBody(parts, ["One.", "Two."])).toBe(`${parts.greeting}\n\nOne.\n\nTwo.\n\nKind regards,\nMark Jensen\nProcurement Manager, Cubro Ltd\nTauriko, Tauranga, New Zealand`);
  });
});

describe("a person's own line", () => {
  const polished = (reply: string | Error): LlmProvider & { seen: { task: string; draft: string; context: string }[] } => ({
    name: "Test model", seen: [],
    async polish(i) { this.seen.push(i); if (reply instanceof Error) throw reply; return reply; },
  });

  it("is rewritten by the model, which is told what the email already says", async () => {
    const llm = polished("We would also be grateful if the pallets could be labelled with our order number.");
    const out = await tidyOwnLine(llm, " 托盘上请贴我们的订单号 ", "Hi Helen,\n\nThank you for confirming PO41783.");
    expect(out).toEqual({ text: "We would also be grateful if the pallets could be labelled with our order number." });
    expect(llm.seen[0].draft).toBe("托盘上请贴我们的订单号");
    expect(llm.seen[0].context).toContain("Thank you for confirming PO41783.");
    expect(llm.seen[0].task).toMatch(/in English whatever language/);
  });

  it("is kept as typed, with a capital and a full stop, when there is no model or it fails", async () => {
    expect(await tidyOwnLine(templateProvider, "please label the pallets", "")).toEqual({ text: "Please label the pallets." });
    const failed = await tidyOwnLine(polished(new Error("Gemini error 503")), "please label the pallets", "");
    expect(failed.text).toBe("Please label the pallets.");
    expect(failed.problem).toMatch(/could not tidy the wording \(Gemini error 503\), so your line is added as you typed it/);
  });

  it("is tidied through the workspace, which refuses an empty or overlong line", async () => {
    const { app, store } = setup(polished("Please label each pallet."));
    const supplier = ln(store).suppliers[0].supplier;
    const res = await request(app).post("/api/supplier-emails/tidy").send({ supplier, note: "label pallets", email: "Hi" }).expect(200);
    expect(res.body).toEqual({ text: "Please label each pallet." });
    await request(app).post("/api/supplier-emails/tidy").send({ supplier, note: "  " }).expect(400);
    await request(app).post("/api/supplier-emails/tidy").send({ supplier, note: "x".repeat(601) }).expect(400);
  });
});

describe("writing a supplier email from the options", () => {
  it("puts the picked paragraphs and the writer's line into a draft that waits for approval", async () => {
    const { app, store } = setup();
    const po = ln(store).purchaseOrders.find((o) => o.status === "Confirmed" && due(o) > "2026-11-23")!;
    const supplier = ln(store).suppliers.find((s) => s.supplier === po.supplier)!;
    const shown = (await request(app).get(`/api/supplier-emails/options?order=${po.order}`).set("x-cubro-user", "Mark Jensen").expect(200)).body;
    expect(shown.to).toEqual({ name: supplier.contactName, address: supplier.email });
    expect(shown.order).toEqual({ id: po.order, status: "Confirmed" });
    const pick = (id: string) => shown.options.find((o: { id: string }) => o.id === id);
    const sentBefore = store.state.systems.m365.messages.length;

    // Picked in the other order: the email still reads in the order the options are listed.
    const res = await request(app).post("/api/supplier-emails").send({ user: "Mark Jensen", order: po.order, options: ["tracking", "on-track"], own: ["Please label each pallet with our order number."] }).expect(200);
    const item = res.body as ApprovalItem, p = item.payload as SupplierEmailPayload;
    expect(item).toMatchObject({ status: "pending", agent: "supplier-outreach", kind: "supplier_email", writtenBy: "Mark Jensen", edited: false, title: `Email to ${supplier.name} — ${po.order}` });
    expect(p).toMatchObject({ reason: "new", purchaseOrder: po.order, supplierId: supplier.supplier, to: shown.to, subject: `${po.order} — delivery date` });
    expect(p.body).toBe([shown.greeting, pick("on-track").text, pick("tracking").text, "Please label each pallet with our order number.", shown.sign].join("\n\n"));
    expect(p.body).toContain("Kind regards,\nMark Jensen\nProcurement Manager, Cubro Ltd");
    expect(item.rationale).toContain("Mark Jensen wrote this email");
    expect(item.rationale).toContain("added a line of their own");
    // Nothing has left: no email until someone approves it.
    expect(store.state.systems.m365.messages.length).toBe(sentBefore);
    expect(store.state.approvals[0].id).toBe(item.id);

    // The page says a draft about this order is already waiting.
    expect((await request(app).get(`/api/supplier-emails/options?order=${po.order}`).expect(200)).body.waiting).toEqual({ id: item.id, title: item.title });

    const done = (await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Priya Raman" }).expect(200)).body as ApprovalItem;
    expect(done.outcome!.map((o) => o.step)).toEqual(["email", "followup"]);
    expect(store.state.systems.m365.messages.find((m) => m.subject === p.subject && m.folder === "Sent Items")!.body).toBe(p.body);
    expect(store.state.systems.clickup.tasks[0]).toMatchObject({ tags: ["supplier", "new", "staff-written"] });
    expect(store.state.systems.clickup.tasks[0].description).toContain("Email written by Mark Jensen sent to");
  });

  it("sends a reply in the supplier's own conversation, under their subject", async () => {
    const { app, store } = setup();
    const delay = fromSupplier(store, (m) => /revised delivery date/.test(m.subject));
    const shown = (await request(app).get(`/api/supplier-emails/options?reply=${delay.id}`).expect(200)).body;
    expect(shown.replyTo).toMatchObject({ id: delay.id, subject: delay.subject, body: delay.body });
    // The order is found from the email itself.
    expect(delay.subject).toContain(shown.order.id);
    expect(shown.subject).toBe(delay.subject);

    // Their price notice names no order, so the writer can say which one the reply is about; another supplier's order is not taken.
    const emailOf = (o: LnPurchaseOrder) => ln(store).suppliers.find((s) => s.supplier === o.supplier)!.email;
    const confirmed = ln(store).purchaseOrders.filter((o) => o.status === "Confirmed");
    const price = fromSupplier(store, (m) => /^Price list effective/.test(m.subject) && confirmed.some((o) => emailOf(o) === m.from.address));
    const own = confirmed.find((o) => emailOf(o) === price.from.address)!;
    const other = ln(store).purchaseOrders.find((o) => ln(store).suppliers.find((s) => s.supplier === o.supplier)!.email !== price.from.address)!;
    expect((await request(app).get(`/api/supplier-emails/options?reply=${price.id}`).expect(200)).body.order).toBeUndefined();
    expect((await request(app).get(`/api/supplier-emails/options?reply=${price.id}&order=${other.order}`).expect(200)).body.order).toBeUndefined();
    expect((await request(app).get(`/api/supplier-emails/options?reply=${price.id}&order=${own.order}`).expect(200)).body.order.id).toBe(own.order);
    // The order whose page the reply was opened from stands in only where the email names none, and only if it is this supplier's.
    expect((await request(app).get(`/api/supplier-emails/options?reply=${price.id}&near=${own.order}`).expect(200)).body.order.id).toBe(own.order);
    expect((await request(app).get(`/api/supplier-emails/options?reply=${price.id}&near=${other.order}`).expect(200)).body.order).toBeUndefined();
    // A delay notice is about the order it names, even opened from another of the supplier's orders, until the writer picks one.
    const delayed = ln(store).purchaseOrders.find((o) => o.order === shown.order.id)!;
    const sibling = ln(store).purchaseOrders.find((o) => o.supplier === delayed.supplier && o.order !== delayed.order)!;
    expect((await request(app).get(`/api/supplier-emails/options?reply=${delay.id}&near=${sibling.order}`).expect(200)).body.order.id).toBe(delayed.order);
    expect((await request(app).get(`/api/supplier-emails/options?reply=${delay.id}&order=${sibling.order}`).expect(200)).body.order.id).toBe(sibling.order);

    const item = (await request(app).post("/api/supplier-emails").send({ user: "Priya Raman", reply: delay.id, options: ["accept-date"] }).expect(200)).body as ApprovalItem;
    const p = item.payload as SupplierEmailPayload;
    expect(p).toMatchObject({ reason: "reply", subject: delay.subject, purchaseOrder: shown.order.id, inReplyTo: { id: delay.id, from: delay.from.name } });
    expect(p.to.address).toBe(delay.from.address);
    expect(item.title).toMatch(/^Reply to /);

    await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    const sent = store.state.systems.m365.messages.find((m) => m.folder === "Sent Items" && m.body === p.body)!;
    expect(sent.conversationId).toBe(delay.conversationId);
  });

  it("refuses an email that says nothing, an unknown order, and a reply to someone who is not a supplier", async () => {
    const { app, store } = setup();
    const po = ln(store).purchaseOrders.find((o) => o.status === "Confirmed")!;
    const before = store.state.approvals.length;
    expect((await request(app).post("/api/supplier-emails").send({ order: po.order, options: [], own: ["  "] }).expect(400)).body.error).toMatch(/Pick at least one thing to say/);
    // The order arrived while the page was open: what was picked no longer applies, and the email is not saved without it.
    po.status = "Received";
    expect((await request(app).post("/api/supplier-emails").send({ order: po.order, options: ["tracking"], own: ["Please label each pallet."] }).expect(409)).body.error).toMatch(/some of what you picked no longer applies. Nothing was saved/);
    await request(app).get("/api/supplier-emails/options?order=PO0").expect(404);
    await request(app).get("/api/supplier-emails/options").expect(404);
    const staff = store.state.systems.m365.messages.find((m) => m.folder === "Inbox" && /^Stock query/.test(m.subject))!;
    expect((await request(app).get(`/api/supplier-emails/options?reply=${staff.id}`).expect(400)).body.error).toMatch(/is not a supplier in Infor LN/);
    expect(store.state.approvals.length).toBe(before);
  });

  it("offers more to say on a draft the agent wrote, without the ask it already makes", async () => {
    const { app, store } = setup();
    const overdue = store.state.approvals.find((a) => a.status === "pending" && a.payload.type === "supplier_email" && a.payload.reason === "overdue")!;
    const options = (await request(app).get(`/api/approvals/${overdue.id}/options`).expect(200)).body as { id: string }[];
    expect(options.map((o) => o.id)).toContain("tracking");
    expect(options.map((o) => o.id)).not.toContain("ship-date");
    const post = store.state.approvals.find((a) => a.payload.type === "social_post")!;
    expect((await request(app).get(`/api/approvals/${post.id}/options`).expect(200)).body).toEqual([]);
  });

  it("marks a supplier's own emails on a record so they can be answered", async () => {
    const { app, store } = setup();
    const delay = fromSupplier(store, (m) => /revised delivery date/.test(m.subject));
    const order = /PO\d+/.exec(delay.subject)![0];
    const emails = (await request(app).get(`/api/records/order/${order}`).expect(200)).body.links.find((l: { label: string }) => l.label === "Emails").items as { title: string; reply?: string; status: string }[];
    expect(emails.find((e) => e.title === delay.subject)).toMatchObject({ reply: delay.id });
    expect(emails.filter((e) => e.status !== "Received").every((e) => !e.reply)).toBe(true);
  });

  it("lists what there is to write about: unanswered supplier emails, orders still to arrive and every supplier", async () => {
    const { app, store } = setup();
    type Starts = import("../server/agents/compose").WriteList;
    const starts = async () => (await request(app).get("/api/supplier-emails/starts").expect(200)).body as Starts;
    const first = await starts();
    const inbox = store.state.systems.m365.messages.filter((m) => m.folder === "Inbox");

    // One row for each conversation with a supplier, on their latest email in it; nobody else's email is offered, a freight forwarder's in the same conversation included.
    expect(first.emails.length).toBeGreaterThan(0);
    for (const e of first.emails) {
      const m = inbox.find((x) => x.id === e.id)!;
      expect(ln(store).suppliers.some((s) => s.email === m.from.address && s.name === e.supplier)).toBe(true);
      expect(inbox.some((x) => x.conversationId === m.conversationId && x.from.address === m.from.address && x.receivedDateTime > m.receivedDateTime)).toBe(false);
    }
    expect(new Set(first.emails.map((e) => inbox.find((x) => x.id === e.id)!.conversationId)).size).toBe(first.emails.length);
    // An order confirmation needs no answer, so it is found only by searching; news about an order comes before notices to every customer.
    expect(first.emails.filter((e) => e.topic === "confirmed").every((e) => !e.toAnswer)).toBe(true);
    expect(first.emails.filter((e) => e.toAnswer).some((e) => e.topic === "delay")).toBe(true);
    // An order confirmation is not listed, whatever its punctuation; an email that only mentions confirming something else is.
    const [s] = ln(store).suppliers, from = { name: s.contactName, address: s.email }, to = [{ name: "Priya Raman", address: "purchasing@cubro.example.co.nz" }];
    const mail = (id: string, body: string): MailMessage => ({ id, conversationId: `conv-${id}`, subject: "Artwork for the new cartons", from, to, body, bodyPreview: body, receivedDateTime: "2026-11-22T20:00:00.000Z", isDraft: false, folder: "Inbox" });
    const listed = writeList(ln(store).suppliers, ln(store).purchaseOrders, [mail("asks", "Thank you for your order. Which delivery address should we use?"), mail("artwork", "We will start the run once we confirm the artwork. Please send the final file."), mail("plain", "Thank you for your order.")], [], today).emails;
    expect(listed.map((e) => [e.id, e.topic, e.toAnswer])).toEqual([["asks", "confirmed", false], ["artwork", "other", true], ["plain", "confirmed", false]]);
    // A mailbox lists only the latest it sent. With that list full, an email older than all of it may have been answered, so it is not offered.
    const ours = (n: number): MailMessage[] => Array.from({ length: n }, (_, i) => ({ ...mail(`sent-${i}`, "Thank you."), from: to[0], to: [from], folder: "Sent Items" as const, receivedDateTime: `2026-11-23T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` }));
    const older = mail("older", "Do you have a new catalogue?");
    expect(writeList(ln(store).suppliers, [], [older, ...ours(MAIL_LIST_LIMIT - 1)], [], today).emails.map((e) => e.id)).toEqual(["older"]);
    expect(writeList(ln(store).suppliers, [], [older, ...ours(MAIL_LIST_LIMIT)], [], today).emails).toEqual([]);
    expect(writeList(ln(store).suppliers, [], [{ ...older, receivedDateTime: "2026-11-23T00:03:00.000Z" }, ...ours(MAIL_LIST_LIMIT)], [], today).emails.map((e) => e.id)).toEqual(["older"]);
    expect(first.emails.findIndex((e) => !e.order)).toBeGreaterThan(first.emails.map((e) => !!e.order).lastIndexOf(true));

    // Orders still to arrive, the latest first, and no order that has arrived.
    const open = ln(store).purchaseOrders.filter((po) => !["Received", "Closed"].includes(po.status));
    expect(first.orders.map((o) => o.id).sort()).toEqual(open.map((po) => po.order).sort());
    expect(first.orders[0].daysLate).toBeGreaterThan(0);
    expect(first.orders.map((o) => o.daysLate)).toEqual([...first.orders.map((o) => o.daysLate)].sort((a, b) => b - a));
    const late = first.orders[0], po = open.find((x) => x.order === late.id)!;
    expect(late).toMatchObject({ due: due(po), daysLate: Math.round((Date.parse("2026-11-23") - Date.parse(due(po)!)) / 86_400_000) });
    expect(first.suppliers.map((s) => s.id).sort()).toEqual(ln(store).suppliers.map((s) => s.supplier).sort());

    // A reply waiting in Drafts to check is marked on the email and on its order; once it is sent the email is answered and leaves the list.
    const delay = first.emails.find((e) => e.topic === "delay" && e.order && !e.draft)!;
    const item = (await request(app).post("/api/supplier-emails").send({ user: "Priya Raman", reply: delay.id, options: ["accept-date"] }).expect(200)).body as ApprovalItem;
    const waiting = await starts();
    expect(waiting.emails.find((e) => e.id === delay.id)).toMatchObject({ draft: true });
    expect(waiting.orders.find((o) => o.id === delay.order)).toMatchObject({ draft: true });
    await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    const after = await starts();
    expect(after.emails.some((e) => e.id === delay.id)).toBe(false);
    expect(after.emails.length).toBe(first.emails.length - 1);
  });
});
