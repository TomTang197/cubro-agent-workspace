import request from "supertest";
import { describe, expect, it } from "vitest";
import { nzClock, nzDay, nzTime, shiftDay } from "../server/agents/nzTime";
import { buildSocialDrafts, socialTopic } from "../server/agents/social";
import { createApp } from "../server/app";
import { generateSystemData } from "../server/data/seed";
import { templateProvider } from "../server/llm";
import { DEFAULT_SETTINGS, Store, type ApprovalItem, type SocialPostPayload } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const setup = () => { const store = new Store({ today }); return { store, app: createApp(store, { llm: templateProvider, env: {}, now: () => today }) }; };
const post = (a: { payload: ApprovalItem["payload"] }) => a.payload as SocialPostPayload;
const systems = generateSystemData(1, today);
const data = { ...systems.salesforce, ...systems.inforln, ...systems.m365 };
const plan = (seed: number, start = today) => { const s = generateSystemData(seed, today); return { s, drafts: buildSocialDrafts({ ...s.salesforce, ...s.inforln, ...s.m365 }, { ...DEFAULT_SETTINGS, social: { ...DEFAULT_SETTINGS.social, postsPerRun: 30 } }, start) }; };
const seeds = [1, 2, 3, 4, 5, 20261123];

describe("social media plan", () => {
  it("schedules event posts before the event and says the event's NZ date", () => {
    let seen = 0;
    for (const seed of seeds) {
      const { s, drafts } = plan(seed);
      for (const d of drafts.filter((x) => x.title.includes("Event:"))) {
        const e = s.m365.events.find((x) => x.id === d.sources[0].ref)!;
        expect(nzDay(post(d).scheduledFor) < nzDay(e.start)).toBe(true);
        expect(post(d).text).toContain(new Date(e.start).toLocaleDateString("en-NZ", { day: "numeric", month: "long", timeZone: "Pacific/Auckland" }));
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("never announces a product before its launch day, or features one that has not launched", () => {
    let seen = 0;
    for (const seed of seeds) {
      const { s, drafts } = plan(seed);
      for (const d of drafts) {
        for (const sku of post(d).productSkus) {
          const item = s.inforln.items.find((i) => i.item === sku)!;
          if (!item.isNew || !item.launchDate) continue;
          expect(nzDay(post(d).scheduledFor) >= item.launchDate).toBe(true);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("keeps posts inside the planning window, at 9:30am or 7:30pm NZ time", () => {
    for (const d of plan(1).drafts) {
      const day = nzDay(post(d).scheduledFor);
      expect(day > nzDay(today) && day <= shiftDay(nzDay(today), DEFAULT_SETTINGS.social.horizonDays)).toBe(true);
      expect(nzClock(post(d).scheduledFor)).toBe(post(d).channel === "LinkedIn" ? "9:30 am" : "7:30 pm");
    }
    expect(nzTime("2026-07-01", 9, 30).toISOString()).toBe("2026-06-30T21:30:00.000Z"); // NZST
    expect(nzTime("2026-12-01", 9, 30).toISOString()).toBe("2026-11-30T20:30:00.000Z"); // NZDT
  });

  it("only attaches an image of a product the post is about", () => {
    for (const seed of seeds) {
      const { s, drafts } = plan(seed);
      for (const d of drafts) {
        const p = post(d);
        if (!p.assetName) { expect(d.rationale).toContain("No image picked"); continue; }
        const asset = s.m365.assets.find((a) => a.name === p.assetName)!;
        expect(p.productSkus).toContain(asset.productSku);
      }
    }
  });

  it("does not plan the same topic or product twice in one run", () => {
    for (const seed of seeds) {
      const { drafts } = plan(seed);
      const topics = drafts.map((d) => socialTopic(d));
      expect(new Set(topics).size).toBe(topics.length);
      const skus = drafts.flatMap((d) => post(d).productSkus);
      expect(new Set(skus).size).toBe(skus.length);
    }
  });

  it("quotes only praise, once each, without naming the customer", () => {
    const cases = [
      { Id: "c1", Subject: "", AccountId: data.accounts[0].Id, ProductSku: data.items[0].item, Type: "Feedback" as const, Description: "Staff say the hoist is much easier to manoeuvre in tight ensuites.", CreatedDate: "2026-11-20" },
      { Id: "c2", Subject: "", AccountId: data.accounts[1].Id, ProductSku: data.items[1].item, Type: "Feedback" as const, Description: "Staff say the hoist is much easier to manoeuvre in tight ensuites.", CreatedDate: "2026-11-18" },
      { Id: "c3", Subject: "", AccountId: data.accounts[2].Id, ProductSku: data.items[2].item, Type: "Feedback" as const, Description: "Can we get a demo of the bariatric range for our new wing?", CreatedDate: "2026-11-19" },
      { Id: "c4", Subject: "", AccountId: data.accounts[3].Id, ProductSku: data.items[3].item, Type: "Complaint" as const, Description: "Delivery was quick but the bed arrived damaged.", CreatedDate: "2026-11-19" },
      { Id: "c5", Subject: "", AccountId: data.accounts[4].Id, ProductSku: data.items[4].item, Type: "Feedback" as const, Description: "The team were great.", CreatedDate: "2026-12-25" },
    ];
    const stories = buildSocialDrafts({ ...data, cases, campaigns: [], events: [], items: data.items.map((i) => ({ ...i, isNew: false })) }, DEFAULT_SETTINGS, today);
    expect(stories.map((d) => d.sources[0].ref)).toEqual(["c1"]);
    const account = data.accounts[0];
    expect(post(stories[0]).text).not.toContain(account.Name);
    expect(post(stories[0]).text).not.toContain(account.BillingCity);
    expect(stories[0].rationale).toContain(account.Name);
  });
});

describe("social media planner in the app", () => {
  it("a second run does not repeat posts already waiting", async () => {
    const { app, store } = setup();
    for (let i = 0; i < 3; i++) await request(app).post("/api/agents/social-media/run").send({ user: "Aroha Ngata" }).expect(200);
    const topics = store.state.approvals.filter((a) => a.agent === "social-media" && a.status === "pending").map((a) => socialTopic(a));
    expect(new Set(topics).size).toBe(topics.length);
    const last = await request(app).post("/api/agents/social-media/run").send({ user: "Aroha Ngata" }).expect(200);
    expect(last.body.itemsCreated).toBe(0);
    expect(last.body.summary).toMatch(/Nothing new to plan/);
  });

  it("saves a new date and hashtags, and uses the NZ date for the ClickUp task", async () => {
    const { app, store } = setup();
    const item = store.state.approvals.find((a) => a.status === "pending" && a.kind === "social_post")!;
    const scheduledFor = nzTime("2026-12-01", 8, 0).toISOString(); // 30 Nov in UTC
    const edited = await request(app).patch(`/api/approvals/${item.id}`).send({ payload: { scheduledFor, hashtags: ["Cubro", "#Aged Care", "#Cubro"] } }).expect(200);
    expect(edited.body.payload.hashtags).toEqual(["#Cubro", "#AgedCare"]);
    const res = await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Aroha Ngata" }).expect(200);
    expect(store.state.systems.clickup.tasks[0].due_date).toBe("2026-12-01");
    expect(store.state.systems.m365.teamsPosts[0].text).toContain("1 Dec");
    expect(res.body.outcome[0].label).toMatch(/team publishes/);
  });

  it("refuses an empty post, a past date, and approving a post whose date has passed", async () => {
    const { app, store } = setup();
    const item = store.state.approvals.find((a) => a.status === "pending" && a.kind === "social_post")!;
    await request(app).patch(`/api/approvals/${item.id}`).send({ payload: { text: "  " } }).expect(400);
    await request(app).patch(`/api/approvals/${item.id}`).send({ payload: { scheduledFor: "2026-11-01T00:00:00.000Z" } }).expect(400);
    post(item).scheduledFor = "2026-11-20T20:30:00.000Z";
    const res = await request(app).post(`/api/approvals/${item.id}/approve`).send({ user: "Aroha Ngata" }).expect(409);
    expect(res.body.error).toMatch(/has passed/);
    await request(app).post(`/api/approvals/${item.id}/reject`).send({ note: "Too late" }).expect(200);
  });
});
