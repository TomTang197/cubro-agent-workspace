import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { generateSystemData } from "../server/data/seed";
import { templateProvider } from "../server/llm";
import { Store } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const setup = () => { const store = new Store({ today }); return { store, app: createApp(store, { llm: templateProvider, env: {} }) }; };

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

  it("rejecting records no savings", async () => {
    const { app, store } = setup();
    const item = store.state.approvals.find((a) => a.status === "pending")!;
    const savings = store.state.savings.length;
    await request(app).post(`/api/approvals/${item.id}/reject`).send({ note: "Not now" }).expect(200);
    expect(store.state.savings.length).toBe(savings);
  });

  it("running supplier outreach does not duplicate drafts already waiting", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/agents/supplier-outreach/run").send({ user: "Priya Raman" }).expect(200);
    expect(res.body.steps.length).toBeGreaterThan(0);
    const dupes = await request(app).get("/api/approvals?status=pending&agent=supplier-outreach");
    const titles = dupes.body.map((a: { title: string }) => a.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("running social planner drafts new posts", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/agents/social-media/run").send({}).expect(200);
    expect(res.body.itemsCreated).toBe(8);
  });

  it("dashboard totals add up", async () => {
    const { app, store } = setup();
    const res = await request(app).get("/api/dashboard").expect(200);
    expect(res.body.totals.pending).toBe(store.state.approvals.filter((a) => a.status === "pending").length);
    expect(res.body.agents).toHaveLength(2);
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
