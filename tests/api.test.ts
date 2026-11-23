import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { generateSystemData } from "../server/data/seed";
import { templateProvider } from "../server/llm";
import { Store } from "../server/store";

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
