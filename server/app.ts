import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { ESTIMATES } from "./agents/drafts.js";
import { AGENTS, AgentService, HttpError } from "./agents/service.js";
import { createConnectors } from "./connectors/index.js";
import { addDays, isoDate } from "./data/rng.js";
import { createLlm, type LlmProvider } from "./llm/index.js";
import { AGENT_IDS, EDIT_MINUTES, nzDate, periodStart, summarise, weekStart } from "./savings.js";
import { mergeSettings, validateSettings } from "./settings.js";
import type { AgentId, Store } from "./store.js";

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).then((r) => { if (!res.headersSent) res.json(r); }).catch(next);
const agentId = (s: string): AgentId => { if (s !== "social-media" && s !== "supplier-outreach") throw new HttpError(404, `Unknown agent ${s}`); return s; };

export function createApp(store: Store, opts: { llm?: LlmProvider; staticDir?: string; env?: NodeJS.ProcessEnv } = {}) {
  const connectors = createConnectors(store, opts.env);
  const agents = new AgentService(store, connectors, opts.llm ?? createLlm(opts.env));
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  const api = express.Router();
  const user = (req: Request) => String(req.body?.user ?? req.header("x-cubro-user") ?? "Staff member");

  api.get("/health", (_req, res) => { res.json({ ok: true }); });

  api.get("/dashboard", wrap(() => {
    const s = store.state;
    const pending = s.approvals.filter((a) => a.status === "pending");
    const decided = s.approvals.filter((a) => a.status !== "pending");
    const approved = decided.filter((a) => a.status === "approved").length;
    const today = nzDate(new Date());
    const since30 = periodStart(today, 30);
    const weekly = new Map<string, { week: string; "social-media": number; "supplier-outreach": number }>();
    for (const e of s.savings) {
      const monday = weekStart(e.date);
      const w = weekly.get(monday) ?? { week: monday, "social-media": 0, "supplier-outreach": 0 };
      w[e.agent] += e.minutesSaved / 60;
      weekly.set(monday, w);
    }
    const perAgent = AGENT_IDS.map((id) => {
      const mine = s.approvals.filter((a) => a.agent === id);
      const dec = mine.filter((a) => a.status !== "pending");
      const ok = dec.filter((a) => a.status === "approved");
      return {
        id, ...AGENTS[id], ...s.settings.agents[id], pending: mine.filter((a) => a.status === "pending").length,
        approvalRate: dec.length ? ok.length / dec.length : 0,
        editRate: ok.length ? ok.filter((a) => a.edited).length / ok.length : 0,
        saved: summarise(s.savings.filter((x) => x.agent === id)),
        lastRun: s.runs.find((r) => r.agent === id),
      };
    });
    return {
      totals: {
        pending: pending.length, highPriority: pending.filter((a) => a.priority === "high").length, decided: decided.length, approved, rejected: decided.length - approved,
        approvalRate: decided.length ? approved / decided.length : 0,
        all: summarise(s.savings), last30: summarise(s.savings.filter((x) => x.date >= since30)),
        pilotStart: s.savings.at(-1)?.date ?? today, since30, currentWeek: weekStart(today),
      },
      weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
      agents: perAgent,
      activity: s.activity.slice(0, 12),
      provider: agents.providerName,
    };
  }));

  api.get("/agents", wrap(() => (Object.keys(AGENTS) as AgentId[]).map((id) => ({ id, ...AGENTS[id], ...store.state.settings.agents[id], runs: store.state.runs.filter((r) => r.agent === id).slice(0, 20) }))));
  api.post("/agents/:id/run", wrap((req) => agents.run(agentId(req.params.id), user(req))));

  api.get("/approvals", wrap((req) => {
    const { status, agent, q } = req.query as Record<string, string | undefined>;
    return store.state.approvals.filter((a) => (!status || status === "all" || a.status === status) && (!agent || a.agent === agent) && (!q || a.title.toLowerCase().includes(q.toLowerCase())));
  }));
  api.get("/approvals/:id", wrap((req) => agents.find(req.params.id)));
  api.patch("/approvals/:id", wrap((req) => agents.edit(req.params.id, req.body?.payload ?? {}, user(req))));
  api.post("/approvals/:id/approve", wrap((req) => agents.approve(req.params.id, user(req), req.body?.note)));
  api.post("/approvals/:id/reject", wrap((req) => agents.reject(req.params.id, user(req), req.body?.note)));

  api.get("/savings", wrap(() => {
    const today = nzDate(new Date());
    return {
      entries: store.state.savings, rates: store.state.settings.hourlyRates, today, pilotStart: store.state.savings.at(-1)?.date ?? today,
      assumptions: {
        editMinutes: EDIT_MINUTES,
        jobs: [
          { agent: "social-media" as AgentId, job: "Social media post", ...ESTIMATES.social_post },
          { agent: "supplier-outreach" as AgentId, job: "Supplier email", ...ESTIMATES.supplier_email },
        ],
      },
    };
  }));
  api.get("/activity", wrap(() => store.state.activity));

  api.get("/settings", wrap(() => store.state.settings));
  api.put("/settings", wrap((req) => {
    const b = req.body ?? {};
    if (b.agents && typeof b.agents === "object") for (const k of Object.keys(b.agents)) agentId(k);
    const next = mergeSettings(store.state.settings, b);
    const problems = Object.values(validateSettings(next));
    if (problems.length) throw new HttpError(400, problems.join(" "));
    store.state.settings = next;
    store.log(user(req), "updated settings", "Agent settings changed");
    store.save();
    return next;
  }));
  api.post("/reset", wrap(() => { store.reset(); return { ok: true }; }));

  api.get("/systems", wrap(async () => Promise.all([connectors.m365.status(), connectors.salesforce.status(), connectors.clickup.status(), connectors.inforln.status()])));
  api.get("/systems/m365/:resource", wrap(async (req) => {
    const m = connectors.m365;
    switch (req.params.resource) {
      case "events": return m.listEvents(isoDate(addDays(new Date(), -30)), isoDate(addDays(new Date(), 90)));
      case "messages": return m.listMessages();
      case "assets": return m.listBrandAssets();
      case "teams": return store.state.systems.m365.teamsPosts;
    }
    throw new HttpError(404, "Unknown resource");
  }));
  api.get("/systems/salesforce/:resource", wrap(async (req) => {
    const map: Record<string, "Account" | "Opportunity" | "Campaign" | "Case"> = { accounts: "Account", opportunities: "Opportunity", campaigns: "Campaign", cases: "Case" };
    if (req.params.resource === "activities") return store.state.systems.salesforce.activities;
    const o = map[req.params.resource];
    if (!o) throw new HttpError(404, "Unknown resource");
    return connectors.salesforce.query(o);
  }));
  api.get("/systems/clickup/tasks", wrap(() => connectors.clickup.listTasks()));
  api.get("/systems/inforln/:resource", wrap(async (req) => {
    const l = connectors.inforln;
    switch (req.params.resource) {
      case "items": return l.listItems();
      case "suppliers": return l.listSuppliers();
      case "purchase-orders": return l.listPurchaseOrders();
    }
    throw new HttpError(404, "Unknown resource");
  }));

  app.use("/api", api);
  app.use("/api", (_req, res) => { res.status(404).json({ error: "Not found" }); });
  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get("*", (_req, res) => res.sendFile(path.join(opts.staticDir!, "index.html")));
  }
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}
