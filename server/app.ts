import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { AGENTS, AgentService, HttpError } from "./agents/service.js";
import { ConnectorError, failedStatus, isSystemId, SYSTEM_IDS, type FetchLike } from "./connectors/config.js";
import { createConnectors, isLive } from "./connectors/index.js";
import type { SfObjects, SystemId } from "./connectors/types.js";
import { addDays, isoDate } from "./data/rng.js";
import { createLlm, type LlmProvider } from "./llm/index.js";
import type { AgentId, Store } from "./store.js";

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).then((r) => { if (!res.headersSent) res.json(r); }).catch(next);
const agentId = (s: string): AgentId => { if (s !== "social-media" && s !== "supplier-outreach") throw new HttpError(404, `Unknown agent ${s}`); return s; };

export function createApp(store: Store, opts: { llm?: LlmProvider; staticDir?: string; env?: NodeJS.ProcessEnv; fetch?: FetchLike } = {}) {
  const env = opts.env ?? process.env;
  const connectors = createConnectors(store, env, opts.fetch);
  // A system that cannot be reached reports that on its own card; the other three still load.
  const statusOf = (system: SystemId) => connectors[system].status().catch((e: unknown) => failedStatus(system, isLive(system, env) ? "live" : "mock", env, e));
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
    const since = isoDate(addDays(new Date(), -30));
    const last30 = s.savings.filter((x) => x.date >= since);
    const weekly = new Map<string, { week: string; "social-media": number; "supplier-outreach": number; dollars: number }>();
    for (const e of s.savings) {
      const d = new Date(e.date + "T00:00:00Z");
      const monday = isoDate(addDays(d, -((d.getUTCDay() + 6) % 7)));
      const w = weekly.get(monday) ?? { week: monday, "social-media": 0, "supplier-outreach": 0, dollars: 0 };
      w[e.agent] += e.minutesSaved / 60; w.dollars += e.dollarsSaved;
      weekly.set(monday, w);
    }
    const perAgent = (Object.keys(AGENTS) as AgentId[]).map((id) => {
      const mine = s.approvals.filter((a) => a.agent === id);
      const dec = mine.filter((a) => a.status !== "pending");
      const sav = s.savings.filter((x) => x.agent === id);
      return {
        id, ...AGENTS[id], ...s.settings.agents[id], pending: mine.filter((a) => a.status === "pending").length,
        approvalRate: dec.length ? dec.filter((a) => a.status === "approved").length / dec.length : 0,
        editRate: dec.length ? dec.filter((a) => a.edited).length / dec.length : 0,
        hoursSaved: sav.reduce((n, x) => n + x.minutesSaved, 0) / 60, dollarsSaved: sav.reduce((n, x) => n + x.dollarsSaved, 0),
        lastRun: s.runs.find((r) => r.agent === id),
      };
    });
    return {
      totals: {
        pending: pending.length, highPriority: pending.filter((a) => a.priority === "high").length, decided: decided.length,
        approvalRate: decided.length ? decided.filter((a) => a.status === "approved").length / decided.length : 0,
        hoursSaved: s.savings.reduce((n, x) => n + x.minutesSaved, 0) / 60, dollarsSaved: s.savings.reduce((n, x) => n + x.dollarsSaved, 0),
        hoursSaved30: last30.reduce((n, x) => n + x.minutesSaved, 0) / 60, dollarsSaved30: last30.reduce((n, x) => n + x.dollarsSaved, 0),
        pilotStart: s.savings.at(-1)?.date ?? isoDate(new Date()),
      },
      weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)).map((w) => ({ ...w, "social-media": +w["social-media"].toFixed(1), "supplier-outreach": +w["supplier-outreach"].toFixed(1), dollars: Math.round(w.dollars) })),
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

  api.get("/savings", wrap(() => ({ entries: store.state.savings, rates: store.state.settings.hourlyRates })));
  api.get("/activity", wrap(() => store.state.activity));

  api.get("/settings", wrap(() => store.state.settings));
  api.put("/settings", wrap((req) => {
    const s = store.state.settings;
    const b = req.body ?? {};
    if (b.hourlyRates) Object.assign(s.hourlyRates, b.hourlyRates);
    if (b.social) Object.assign(s.social, b.social);
    if (b.supplier) Object.assign(s.supplier, b.supplier);
    if (b.agents) for (const k of Object.keys(b.agents) as AgentId[]) Object.assign(s.agents[agentId(k)], b.agents[k]);
    store.log(user(req), "updated settings", "Agent settings changed");
    store.save();
    return s;
  }));
  api.post("/reset", wrap(() => { store.reset(); return { ok: true }; }));

  api.get("/systems", wrap(() => Promise.all(SYSTEM_IDS.map(statusOf))));
  api.post("/systems/:system/test", wrap(async (req) => {
    if (!isSystemId(req.params.system)) throw new HttpError(404, "Unknown system");
    const status = await statusOf(req.params.system);
    store.log(user(req), "tested connection", `${status.name}: ${status.connected ? "connected" : `not connected. ${status.error ?? ""}`}`.trim());
    store.save();
    return status;
  }));
  api.get("/systems/m365/:resource", wrap(async (req) => {
    const m = connectors.m365;
    switch (req.params.resource) {
      case "events": return m.listEvents(addDays(new Date(), -90).toISOString(), addDays(new Date(), 365).toISOString());
      case "messages": return m.listMessages();
      case "assets": return m.listBrandAssets();
      case "teams": return m.listTeamsPosts();
    }
    throw new HttpError(404, "Unknown resource");
  }));
  api.get("/systems/salesforce/:resource", wrap(async (req) => {
    const map: Record<string, keyof SfObjects> = { accounts: "Account", contacts: "Contact", opportunities: "Opportunity", campaigns: "Campaign", cases: "Case" };
    if (req.params.resource === "activities") return connectors.salesforce.listActivities();
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
    // 502: the workspace is fine, the system behind it did not answer.
    const status = err instanceof HttpError ? err.status : err instanceof ConnectorError ? 502 : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}
