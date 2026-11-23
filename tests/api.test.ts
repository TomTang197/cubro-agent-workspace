import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { generateSystemData } from "../server/data/seed";
import { templateProvider } from "../server/llm";
import { FOLLOW_UP_DAYS, handledSupplierKeys, LOW_STOCK_REPEAT_DAYS, planSupplierDrafts, supplierKey, supplierRunSummary } from "../server/agents/drafts";
import { Store, type SupplierEmailPayload } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const setup = () => { const store = new Store({ today }); return { store, app: createApp(store, { llm: templateProvider, env: {}, now: () => today }) }; };

describe("sample data", () => {
  it("is deterministic and large", () => {
    const a = generateSystemData(1, today), b = generateSystemData(1, today);
    expect(a).toEqual(b);
    expect(a.inforln.purchaseOrders.length).toBe(150);
    expect(a.salesforce.accounts.length).toBe(46);
    expect(a.clickup.tasks.length).toBe(88);
  });
  it("seeds a pending queue and savings history", () => {
    const { store } = setup();
    const reasons = store.state.approvals.filter((x) => x.status === "pending" && x.payload.type === "supplier_email").map((x) => (x.payload as SupplierEmailPayload).reason);
    expect(reasons).toEqual(expect.arrayContaining(["overdue", "partial", "low_stock"]));
    expect(store.state.approvals.filter((x) => x.status === "pending").length).toBeGreaterThan(5);
    expect(store.state.savings.length).toBeGreaterThan(50);
  });
});

describe("api", () => {
  it("reports four simulated systems", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/systems").expect(200);
    expect(res.body.map((s: { system: string }) => s.system)).toEqual(["m365", "salesforce", "clickup", "inforln"]);
    expect(res.body.every((s: { mode: string }) => s.mode === "mock")).toBe(true);
  });

  it("approving a supplier email sends it, opens a ClickUp follow-up and records savings", async () => {
    const { app, store } = setup();
    const item = store.state.approvals.find((a) => a.status === "pending" && a.kind === "supplier_email")!;
    const savings = store.state.savings.length;
    await request(app).patch(`/api/approvals/${item.id}`).send({ user: "Priya Raman", payload: { subject: "Edited subject" } }).expect(200);
    const res = await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.edited).toBe(true);
    const sent = store.state.systems.m365.messages.find((m) => m.subject === "Edited subject")!;
    expect(sent.folder).toBe("Sent Items");
    expect(store.state.systems.clickup.tasks[0].list).toBe("Purchasing");
    expect(store.state.savings.length).toBe(savings + 1);
    expect(store.state.savings[0].minutesSaved).toBe(22 - 3 - 4);
    await request(app).post(`/api/approvals/${item.id}/approve`).send({}).expect(409);
  });

  it("approving a social post creates a Marketing task and Teams post", async () => {
    const { app, store } = setup();
    const item = store.state.approvals.find((a) => a.status === "pending" && a.kind === "social_post")!;
    await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Aroha Ngata" }).expect(200);
    expect(store.state.systems.clickup.tasks[0].list).toBe("Marketing");
    expect(store.state.systems.m365.teamsPosts[0].channel).toBe("Marketing");
  });

  it("rejecting counts the review time as a cost", async () => {
    const { app, store } = setup();
    const item = store.state.approvals.find((a) => a.status === "pending" && a.kind === "supplier_email")!;
    const savings = store.state.savings.length;
    await request(app).post(`/api/approvals/${item.id}/reject`).send({ user: "Priya Raman", note: "Not now" }).expect(200);
    expect(store.state.savings.length).toBe(savings + 1);
    expect(store.state.savings[0]).toMatchObject({ outcome: "rejected", approvalId: item.id, reviewer: "Priya Raman", manualMinutes: 0, agentAssistedMinutes: 3, minutesSaved: -3, dollarsSaved: -2.3 });
  });

  it("running supplier outreach does not duplicate drafts already waiting", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/agents/supplier-outreach/run").send({ user: "Priya Raman" }).expect(200);
    expect(res.body.steps.length).toBeGreaterThan(0);
    const dupes = await request(app).get("/api/approvals?status=pending&agent=supplier-outreach");
    const titles = dupes.body.map((a: { title: string }) => a.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("does not chase a supplier again right after an email was sent or a draft was rejected", async () => {
    const { app, store } = setup();
    const pending = store.state.approvals.filter((a) => a.status === "pending" && a.kind === "supplier_email");
    const sent = pending.find((a) => (a.payload as SupplierEmailPayload).purchaseOrder)!;
    const rejected = pending.find((a) => (a.payload as SupplierEmailPayload).reason === "low_stock")!;
    await request(app).post(`/api/approvals/${sent.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    await request(app).post(`/api/approvals/${rejected.id}/reject`).send({ user: "Priya Raman", note: "Already spoke to them by phone" }).expect(200);
    const run = await request(app).post("/api/agents/supplier-outreach/run").send({ user: "Priya Raman" }).expect(200);
    const after = await request(app).get("/api/approvals?status=pending&agent=supplier-outreach");
    const titles = after.body.map((a: { title: string }) => a.title);
    expect(titles).not.toContain(sent.title);
    expect(titles).not.toContain(rejected.title);
    expect(run.body.steps.map((s: { detail: string }) => s.detail).join(" ")).toMatch(/already waiting for review, or sent or rejected in the last few days/);
  });

  it("counts the follow-up window in New Zealand calendar days, the same for a live run and seeded history", () => {
    const { store } = setup();
    const sent = store.state.approvals.find((a) => a.status === "pending" && (a.payload as SupplierEmailPayload).purchaseOrder)!;
    const key = supplierKey(sent.payload as SupplierEmailPayload);
    sent.status = "approved";
    sent.decidedAt = "2026-11-22T20:00:00Z"; // 9am on Monday 23 November in Auckland
    const others = store.state.approvals.filter((a) => a !== sent && (a.payload.type !== "supplier_email" || supplierKey(a.payload) !== key));
    const handledAt = (at: string) => handledSupplierKeys([sent, ...others], new Date(at)).has(key);
    expect(handledAt("2026-11-24T18:00:00Z")).toBe(true); // 7am Wednesday
    expect(handledAt("2026-11-25T18:00:00Z")).toBe(false); // 7am Thursday: three days on
  });

  it("seeded history never emails the same supplier about the same thing twice within the follow-up window", () => {
    const { store } = setup();
    const emails = store.state.approvals.filter((a) => a.payload.type === "supplier_email");
    const last = new Map<string, number>();
    for (const a of [...emails].reverse()) {
      const key = supplierKey(a.payload as SupplierEmailPayload), at = new Date(a.createdAt).getTime();
      const days = (a.payload as SupplierEmailPayload).reason === "low_stock" ? LOW_STOCK_REPEAT_DAYS : FOLLOW_UP_DAYS;
      if (last.has(key)) expect(at - last.get(key)!).toBeGreaterThanOrEqual(days * 86_400_000);
      last.set(key, at);
    }
  });

  it("says how many issues were held back by the per-run limit", () => {
    const { store } = setup();
    const { inforln } = store.state.systems, { settings } = store.state;
    const everything = planSupplierDrafts(inforln, { ...settings, supplier: { ...settings.supplier, maxEmailsPerRun: 999 } }, today);
    const capped = planSupplierDrafts(inforln, { ...settings, supplier: { ...settings.supplier, maxEmailsPerRun: 3 } }, today);
    expect(everything.heldBack).toBe(0);
    expect(capped.drafts).toHaveLength(3);
    expect(capped.heldBack).toBe(everything.drafts.length - 3);
    expect(supplierRunSummary(capped)).toBe(`3 supplier emails drafted for review, ${capped.heldBack} more held for the next run`);
    expect(supplierRunSummary({ drafts: [], heldBack: 0 })).toBe("Nothing new needs chasing");
    const morning = store.state.runs.find((r) => r.agent === "supplier-outreach")!;
    expect(morning.summary).toMatch(/^10 supplier emails drafted for review, \d+ more held for the next run$/);
  });

  it("running social planner drafts new posts", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/agents/social-media/run").send({}).expect(200);
    expect(res.body.itemsCreated).toBeGreaterThan(0);
  });

  it("dashboard totals add up", async () => {
    const { app, store } = setup();
    const res = await request(app).get("/api/dashboard").expect(200);
    expect(res.body.totals.pending).toBe(store.state.approvals.filter((a) => a.status === "pending").length);
    expect(res.body.agents).toHaveLength(2);
  });
});

describe("supplier outreach drafts", () => {
  const { store } = setup();
  const { inforln } = store.state.systems, { settings } = store.state;
  const all = { ...settings, supplier: { ...settings.supplier, maxEmailsPerRun: 999 } };
  const emails = (drafts: ReturnType<typeof planSupplierDrafts>["drafts"]) => drafts.map((d) => d.payload as SupplierEmailPayload);

  it("writes dates the way a New Zealander reads them and never ISO dates", () => {
    const { drafts } = planSupplierDrafts(inforln, all, today);
    for (const d of drafts) expect(`${d.rationale} ${(d.payload as SupplierEmailPayload).body}`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const overdue = emails(drafts).find((p) => p.reason === "overdue")!;
    expect(overdue.body).toMatch(/was due to arrive on \d{1,2} [A-Z][a-z]+ 2026/);
    expect(overdue.body).toContain("A reply by Wednesday 25 November");
  });

  it("asks for a reply two working days out, counted from the day in New Zealand", () => {
    const replyBy = (at: string) => emails(planSupplierDrafts(inforln, all, new Date(at)).drafts)[0];
    expect(replyBy("2026-11-26T00:00:00Z").body).toContain("A reply by Monday 30 November"); // Thursday
    expect(replyBy("2026-11-27T00:00:00Z").body).toContain("A reply by Tuesday 1 December"); // Friday
    // 7am on Friday in Auckland is still Thursday evening in UTC.
    const morning = replyBy("2026-11-26T18:00:00Z");
    expect(morning.body).toContain("A reply by Tuesday 1 December");
    expect(morning.replyBy).toBe("2026-12-01");
  });

  it("keeps Cubro's stock levels out of the email and in the reviewer's notes", () => {
    const { drafts } = planSupplierDrafts(inforln, all, today);
    const low = drafts.filter((d) => (d.payload as SupplierEmailPayload).reason === "low_stock");
    expect(low.length).toBeGreaterThan(0);
    for (const d of low) {
      expect((d.payload as SupplierEmailPayload).body).not.toMatch(/on hand|reorder point/i);
      expect(d.rationale).toMatch(/on hand, \d+ on order, reorder point/);
    }
  });

  it("does not claim customer orders are waiting", () => {
    for (const p of emails(planSupplierDrafts(inforln, all, today).drafts)) expect(p.body).not.toMatch(/customer orders waiting/);
  });

  it("puts late and part-delivered orders ahead of unconfirmed ones when the run is capped", () => {
    const reasons = emails(planSupplierDrafts(inforln, all, today).drafts.filter((d) => d.priority === "normal")).map((p) => p.reason);
    const firstUnconfirmed = reasons.indexOf("unconfirmed");
    expect(reasons.slice(firstUnconfirmed)).not.toContain("overdue");
    expect(reasons.slice(firstUnconfirmed)).not.toContain("partial");
  });

  it("leaves an order alone when the supplier emailed about it this week, and quotes older emails", () => {
    const base = planSupplierDrafts(inforln, all, today);
    const [recent, older] = emails(base.drafts).filter((p) => p.purchaseOrder).map((p) => p.purchaseOrder!);
    const replies = new Map([
      [recent, { subject: `RE: ${recent} shipment update`, receivedDateTime: "2026-11-20T02:00:00.000Z" }],
      [older, { subject: `${older} — order confirmation`, receivedDateTime: "2026-11-02T02:00:00.000Z" }],
    ]);
    const plan = planSupplierDrafts(inforln, all, today, { replies });
    expect(plan.repliedRecently).toBe(1);
    expect(emails(plan.drafts).map((p) => p.purchaseOrder)).not.toContain(recent);
    const quoted = plan.drafts.find((d) => (d.payload as SupplierEmailPayload).purchaseOrder === older)!;
    expect(quoted.rationale).toContain(`"${older} — order confirmation" on 2 November 2026`);
    expect(quoted.sources.some((s) => s.system === "Microsoft 365")).toBe(true);
  });

  it("the run reads the supplier inbox and skips orders the supplier just wrote about", async () => {
    const { app, store } = setup();
    const target = (await request(app).post("/api/agents/supplier-outreach/run").send({}).expect(200)).body;
    expect(target.itemsCreated).toBeGreaterThan(0);
    const fresh = store.state.approvals.find((a) => a.runId === target.id && a.payload.type === "supplier_email" && a.payload.purchaseOrder)!;
    const po = (fresh.payload as SupplierEmailPayload).purchaseOrder!;
    await request(app).post(`/api/approvals/${fresh.id}/reject`).send({}).expect(200);
    fresh.decidedAt = new Date(Date.now() - 30 * 86_400_000).toISOString(); // outside the follow-up window, so only the inbox can stop a new draft
    store.state.systems.m365.messages.unshift({ ...store.state.systems.m365.messages[0], id: "reply-1", subject: `RE: ${po} shipment update`, receivedDateTime: new Date().toISOString() });
    const run = (await request(app).post("/api/agents/supplier-outreach/run").send({}).expect(200)).body;
    expect(run.steps.find((s: { system: string }) => s.system === "Microsoft 365").detail).toMatch(/1 order left alone because the supplier wrote in the last 7 days/);
    expect(store.state.approvals.some((a) => a.runId === run.id && (a.payload as SupplierEmailPayload).purchaseOrder === po)).toBe(false);
  });
});

describe("settings", () => {
  it("saves valid changes and keeps the fields that were not sent", async () => {
    const { app, store } = setup();
    const res = await request(app).put("/api/settings").send({ user: "Aroha Ngata", hourlyRates: { "social-media": 55.5 }, social: { postsPerRun: 4, channels: ["Instagram", "LinkedIn"] } }).expect(200);
    expect(res.body.hourlyRates).toEqual({ "social-media": 55.5, "supplier-outreach": 46 });
    expect(res.body.social.postsPerRun).toBe(4);
    expect(res.body.social.channels).toEqual(["LinkedIn", "Instagram"]);
    expect(res.body.social.horizonDays).toBe(14);
    expect(store.state.activity[0]).toMatchObject({ actor: "Aroha Ngata", action: "updated settings" });
  });

  it.each([
    ["a negative hourly cost", { hourlyRates: { "social-media": -50 } }, /hourly cost/],
    ["an hourly cost that is not a number", { hourlyRates: { "supplier-outreach": "abc" } }, /hourly cost/],
    ["zero posts per run", { social: { postsPerRun: 0 } }, /posts/],
    ["no channels", { social: { channels: [] } }, /channel/],
    ["an unknown channel", { social: { channels: ["TikTok"] } }, /channel/],
    ["an empty tone of voice", { social: { tone: "  " } }, /tone/],
    ["a negative grace period", { supplier: { overdueGraceDays: -9 } }, /days/],
    ["no emails per run", { supplier: { maxEmailsPerRun: -1 } }, /emails/],
    ["an empty signature", { supplier: { sender: "" } }, /signed/],
    ["a non-boolean on/paused flag", { agents: { "social-media": { enabled: "no" } } }, /on or paused/],
  ])("rejects %s and changes nothing", async (_name, body, message) => {
    const { app, store } = setup();
    const before = structuredClone(store.state.settings);
    const res = await request(app).put("/api/settings").send(body).expect(400);
    expect(res.body.error).toMatch(message);
    expect(store.state.settings).toEqual(before);
  });

  it("ignores fields it does not know and rejects unknown agents", async () => {
    const { app } = setup();
    const res = await request(app).put("/api/settings").send({ supplier: { bogus: 1, maxEmailsPerRun: 5 }, extra: true }).expect(200);
    expect(res.body.supplier).not.toHaveProperty("bogus");
    expect(res.body).not.toHaveProperty("extra");
    expect(res.body.supplier.maxEmailsPerRun).toBe(5);
    await request(app).put("/api/settings").send({ agents: { nope: { enabled: false } } }).expect(404);
  });

  it("a paused agent cannot be run until it is switched back on", async () => {
    const { app, store } = setup();
    await request(app).put("/api/settings").send({ agents: { "social-media": { enabled: false } } }).expect(200);
    const runs = store.state.runs.length;
    const res = await request(app).post("/api/agents/social-media/run").send({ user: "Sophie Turner" }).expect(409);
    expect(res.body.error).toMatch(/paused/);
    expect(store.state.runs.length).toBe(runs);
    await request(app).post("/api/agents/supplier-outreach/run").send({ user: "Mark Jensen" }).expect(200);
    await request(app).put("/api/settings").send({ agents: { "social-media": { enabled: true } } }).expect(200);
    await request(app).post("/api/agents/social-media/run").send({ user: "Sophie Turner" }).expect(200);
  });
});

describe("staff switching", () => {
  it("says it is a demo only while every system runs on sample data", async () => {
    const { store, app } = setup();
    expect((await request(app).get("/api/workspace").expect(200)).body).toEqual({ demo: true });
    const live = createApp(store, { llm: templateProvider, env: { CONNECTOR_CLICKUP: "live" }, now: () => today });
    expect((await request(live).get("/api/workspace").expect(200)).body).toEqual({ demo: false });
  });
  it("restores the sample data in one call, undoing approvals and settings", async () => {
    const { store, app } = setup();
    const first = store.state.approvals.find((a) => a.status === "pending" && a.payload.type === "supplier_email")!;
    await request(app).post(`/api/approvals/${first.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    await request(app).put("/api/settings").send({ agents: { "social-media": { enabled: false } } }).expect(200);
    const waiting = () => store.state.approvals.filter((a) => a.status === "pending").length;
    const before = waiting();
    await request(app).post("/api/reset").expect(200);
    expect(waiting()).toBe(before + 1);
    expect(store.state.settings.agents["social-media"].enabled).toBe(true);
    expect(store.state.approvals.some((a) => a.decidedBy === "Priya Raman" && a.id === first.id)).toBe(false);
  });
  it("records runs and approvals under the staff member chosen in the workspace", async () => {
    const { app, store } = setup();
    const run = await request(app).post("/api/agents/supplier-outreach/run").set("x-cubro-user", "Hemi Walker").send({}).expect(200);
    expect(run.body.triggeredBy).toBe("Hemi Walker");
    const item = store.state.approvals.find((a) => a.status === "pending")!;
    const res = await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Liam Chen" }).expect(200);
    expect(res.body.decidedBy).toBe("Liam Chen");
    expect(store.state.activity[0].actor).toBe("Liam Chen");
  });
});
