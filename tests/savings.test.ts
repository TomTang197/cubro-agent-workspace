import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { templateProvider } from "../server/llm";
import { AGENT_IDS, nzDate, nzTime, periodStart, savingsCsv, summarise, weekStart, type SavingsLine } from "../server/savings";
import { Store } from "../server/store";

// 9:30am on Tuesday 24 November in New Zealand, which is still Monday in UTC.
const now = new Date("2026-11-23T20:30:00Z");
const setup = () => { const store = new Store({ today: now }); return { store, app: createApp(store, { llm: templateProvider, env: {} }) }; };
const dashboard = async (app: ReturnType<typeof createApp>) => (await request(app).get("/api/dashboard").expect(200)).body;
const cents = (n: number) => Math.round(n * 100);
const SUMS = ["approved", "rejected", "manualMinutes", "reviewMinutes", "rejectedMinutes", "minutesSaved"] as const;

afterEach(() => { vi.useRealTimers(); });

describe("New Zealand dates", () => {
  it("uses the New Zealand calendar day and clock", () => {
    expect(nzDate(now)).toBe("2026-11-24");
    expect(nzDate("2026-07-01T11:59:00Z")).toBe("2026-07-01");
    expect(nzTime("2026-11-24", 7).toISOString()).toBe("2026-11-23T18:00:00.000Z");
    expect(nzTime("2026-07-01", 7).toISOString()).toBe("2026-06-30T19:00:00.000Z");
    expect(weekStart("2026-11-29")).toBe("2026-11-23");
    expect(periodStart("2026-11-24", 30)).toBe("2026-10-26");
  });

  it("sample history is decided on New Zealand weekday mornings", () => {
    const { store } = setup();
    for (const a of store.state.approvals.filter((x) => x.status !== "pending")) {
      const weekday = new Date(`${nzDate(a.decidedAt!)}T00:00:00Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
      expect(new Date(a.decidedAt!).getTime()).toBeLessThanOrEqual(nzTime(nzDate(a.decidedAt!), 13).getTime());
    }
    for (const a of store.state.approvals) expect(new Date(a.createdAt).getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("dates an approval made on a New Zealand morning on that day and in that week", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now });
    const { app, store } = setup();
    const item = store.state.approvals.find((a) => a.status === "pending")!;
    await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Priya Raman" }).expect(200);
    expect(store.state.savings[0].date).toBe("2026-11-24");
    const d = await dashboard(app);
    expect(d.totals.currentWeek).toBe("2026-11-23");
    expect(d.weekly.at(-1).week).toBe("2026-11-23");
    expect(d.totals.since30).toBe("2026-10-26");
  });
});

describe("savings ledger", () => {
  it("has one line for every draft that was approved or rejected", () => {
    const { store } = setup();
    const decided = store.state.approvals.filter((a) => a.status !== "pending");
    expect(store.state.savings.map((e) => e.approvalId).sort()).toEqual(decided.map((a) => a.id).sort());
    for (const e of store.state.savings) {
      const a = decided.find((x) => x.id === e.approvalId)!;
      expect(e.outcome).toBe(a.status);
      expect(e.minutesSaved).toBe(e.manualMinutes - e.agentAssistedMinutes);
      expect(e.dollarsSaved).toBeCloseTo((e.minutesSaved / 60) * e.hourlyRate, 2);
    }
  });

  it("agents add up to the totals, on the overview and in any period", async () => {
    const { app, store } = setup();
    const d = await dashboard(app);
    const lines: SavingsLine[] = d.agents.map((a: { saved: SavingsLine }) => a.saved);
    for (const k of SUMS) expect(lines.reduce((n, l) => n + l[k], 0)).toBe(d.totals.all[k]);
    expect(lines.reduce((n, l) => n + cents(l.dollarsSaved), 0)).toBe(cents(d.totals.all.dollarsSaved));
    expect(d.totals.all.approved).toBe(d.totals.approved);
    expect(d.totals.all.rejected).toBe(d.totals.rejected);
    expect(d.totals.approved + d.totals.rejected).toBe(d.totals.decided);
    const weeks: { "social-media": number; "supplier-outreach": number; dollars: number }[] = d.weekly;
    expect(Math.round(weeks.reduce((n, w) => n + (w["social-media"] + w["supplier-outreach"]) * 60, 0))).toBe(d.totals.all.minutesSaved);
    expect(weeks.reduce((n, w) => n + cents(w.dollars), 0)).toBe(cents(d.totals.all.dollarsSaved));

    for (const from of [d.totals.since30, d.totals.pilotStart]) {
      const entries = store.state.savings.filter((e) => e.date >= from);
      const total = summarise(entries);
      const parts = AGENT_IDS.map((a) => summarise(entries.filter((e) => e.agent === a)));
      for (const k of SUMS) expect(parts.reduce((n, l) => n + l[k], 0)).toBe(total[k]);
      expect(parts.reduce((n, l) => n + cents(l.dollarsSaved), 0)).toBe(cents(total.dollarsSaved));
      expect(total.minutesSaved).toBe(total.manualMinutes - total.reviewMinutes - total.rejectedMinutes);
    }
    expect(summarise(store.state.savings.filter((e) => e.date >= d.totals.since30))).toEqual(d.totals.last30);
  });

  it("the overview moves by exactly what each decision is worth", async () => {
    const { app, store } = setup();
    const pending = store.state.approvals.filter((a) => a.status === "pending" && a.kind === "supplier_email");
    const before = (await dashboard(app)).totals;

    await request(app).post(`/api/approvals/${pending[0].id}/approve`).send({ user: "Priya Raman" }).expect(200);
    let t = (await dashboard(app)).totals;
    expect(t.last30.minutesSaved - before.last30.minutesSaved).toBe(19);
    expect(cents(t.last30.dollarsSaved) - cents(before.last30.dollarsSaved)).toBe(1457);
    expect(t.all.minutesSaved - before.all.minutesSaved).toBe(19);
    expect(t.pending).toBe(before.pending - 1);

    await request(app).patch(`/api/approvals/${pending[1].id}`).send({ payload: { subject: "Edited" } }).expect(200);
    await request(app).post(`/api/approvals/${pending[1].id}/approve`).send({ user: "Priya Raman" }).expect(200);
    await request(app).post(`/api/approvals/${pending[2].id}/reject`).send({ user: "Priya Raman" }).expect(200);
    t = (await dashboard(app)).totals;
    expect(t.all.minutesSaved - before.all.minutesSaved).toBe(19 + 15 - 3);
    expect(cents(t.all.dollarsSaved) - cents(before.all.dollarsSaved)).toBe(1457 + 1150 - 230);
    expect(t.approved - before.approved).toBe(2);
    expect(t.rejected - before.rejected).toBe(1);
  });

  it("keeps the hourly cost a job was decided at when the cost changes later", async () => {
    const { app, store } = setup();
    const before = (await dashboard(app)).totals.all.dollarsSaved;
    await request(app).put("/api/settings").send({ hourlyRates: { "supplier-outreach": 60 } }).expect(200);
    expect((await dashboard(app)).totals.all.dollarsSaved).toBe(before);
    const item = store.state.approvals.find((a) => a.status === "pending" && a.kind === "supplier_email")!;
    await request(app).post(`/api/approvals/${item.id}/approve`).send({}).expect(200);
    expect(store.state.savings[0]).toMatchObject({ hourlyRate: 60, dollarsSaved: 19 });
    const res = await request(app).get("/api/savings").expect(200);
    expect(summarise(res.body.entries.filter((e: { agent: string }) => e.agent === "supplier-outreach")).hourlyRates).toEqual([46, 60]);
    expect(res.body.assumptions.jobs.map((j: { manualMinutes: number }) => j.manualMinutes)).toEqual([35, 22]);
  });
});

describe("export", () => {
  it("opens cleanly in Excel and its column totals match the page", () => {
    const { store } = setup();
    const entries = store.state.savings;
    const csv = savingsCsv(entries);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.slice(1).trimEnd().split("\r\n");
    expect(rows[0]).toBe("Date,Agent,Team,Work,Decision,Reviewed by,By hand (min),With agent (min),Saved (min),Hourly cost (NZD),Saved (NZD)");
    expect(rows.length).toBe(entries.length + 1);
    const cols = rows.slice(1).map((r) => r.split(",").slice(-5).map(Number));
    const total = summarise(entries);
    expect(cols.reduce((n, c) => n + c[2], 0)).toBe(total.minutesSaved);
    expect(cols.reduce((n, c) => n + cents(c[4]), 0)).toBe(cents(total.dollarsSaved));
    expect(csv).toContain("Rejected");
    expect(savingsCsv([{ ...entries[0], description: '=HYPERLINK("x")' }])).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
