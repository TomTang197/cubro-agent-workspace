import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ESTIMATES } from "./agents/drafts.js";
import { AGENTS, AgentService, HttpError } from "./agents/service.js";
import { ConnectorError, failedStatus, isSystemId, SYSTEM_IDS, type FetchLike } from "./connectors/config.js";
import { createConnectors, isLive, workspacePassword } from "./connectors/index.js";
import type { SfObjects, SystemId } from "./connectors/types.js";
import { addDays, isoDate } from "./data/rng.js";
import { createLlm, type LlmProvider } from "./llm/index.js";
import { activityRecord, isRecordKind, listRecords, notificationsFor, recordDetail, searchRecords } from "./records.js";
import { AGENT_IDS, EDIT_MINUTES, nzDate, periodStart, summarise, weekStart } from "./savings.js";
import { mergeSettings, validateSettings } from "./settings.js";
import type { AgentId, Store } from "./store.js";

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).then((r) => { if (!res.headersSent) res.json(r); }).catch(next);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const agentId = (s: string): AgentId => { if (s !== "social-media" && s !== "supplier-outreach") throw new HttpError(404, `Unknown agent ${s}`); return s; };

export function createApp(store: Store, opts: { llm?: LlmProvider; staticDir?: string; env?: NodeJS.ProcessEnv; fetch?: FetchLike; now?: () => Date } = {}) {
  const env = opts.env ?? process.env;
  const connectors = createConnectors(store, env, opts.fetch);
  // A system that cannot be reached reports that on its own card; the other three still load.
  const statusOf = (system: SystemId) => connectors[system].status().catch((e: unknown) => failedStatus(system, isLive(system, env) ? "live" : "mock", env, e));
  const agents = new AgentService(store, connectors, opts.llm ?? createLlm(opts.env), opts.now);
  const app = express();
  app.use(cors());
  // With WORKSPACE_PASSWORD set, the browser asks for it before any page or record is served. Real systems stay disconnected without one.
  const password = workspacePassword(env);
  const anyLive = SYSTEM_IDS.some((s) => isLive(s, env));
  const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
  app.use((req, res, next) => {
    if (req.path === "/api/health") return next();
    const refuse = (code: number, error: string) => { if (req.path.startsWith("/api/")) res.status(code).json({ error }); else res.status(code).type("text/plain").send(error); };
    if (!password) {
      // Drafts and decisions saved after a real system answered stay closed if the password is later taken away.
      if (store.state.heldLive) return refuse(503, "This workspace holds drafts and decisions made from real systems and has no sign-in password. Set WORKSPACE_PASSWORD on the server and restart.");
      return next();
    }
    // The password is only asked for over an encrypted connection (or on the server itself), so it is never sent in the clear.
    const forwarded = req.header("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
    const onServer = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (forwarded ? forwarded !== "https" : !req.secure && !onServer) return refuse(403, "Open this workspace over https. The sign-in password is not accepted on an unencrypted connection.");
    const [scheme, value] = (req.header("authorization") ?? "").split(" ");
    const given = scheme?.toLowerCase() === "basic" ? Buffer.from(value ?? "", "base64").toString("utf8") : "";
    if (crypto.timingSafeEqual(digest(given.slice(given.indexOf(":") + 1)), digest(password))) return next();
    res.status(401).set("WWW-Authenticate", 'Basic realm="Cubro agent workspace", charset="UTF-8"').json({ error: "Sign in with the workspace password to continue." });
  });
  app.use(express.json({ limit: "1mb" }));
  const api = express.Router();
  const user = (req: Request) => String(req.body?.user ?? req.header("x-cubro-user") ?? "Staff member");

  api.get("/health", (_req, res) => { res.json({ ok: true }); });
  // A demo is a workspace where no system is live, so nothing approved leaves it and the sample data can be restored freely.
  api.get("/workspace", wrap(() => ({ demo: !anyLive })));

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
  api.get("/approvals/:id/options", wrap((req) => agents.draftOptions(req.params.id)));
  // Supplier emails a person writes with the assistant: pick what to say, add a line of your own, and it goes to Drafts to check.
  const about = (from: Record<string, unknown>) => ({ supplier: text(from.supplier), order: text(from.order), reply: text(from.reply), near: text(from.near) });
  api.get("/supplier-emails/starts", wrap(() => agents.writeList()));
  api.get("/supplier-emails/options", wrap((req) => agents.composeOptions(about(req.query), user(req))));
  api.post("/supplier-emails/tidy", wrap((req) => agents.tidy(req.body?.note, req.body?.email)));
  api.post("/supplier-emails", wrap((req) => agents.write(about(req.body ?? {}), user(req), req.body?.options, req.body?.own)));
  api.patch("/approvals/:id", wrap((req) => agents.edit(req.params.id, req.body?.payload ?? {}, user(req))));
  api.post("/approvals/:id/approve", wrap((req) => agents.decide("approve", req.params.id, user(req), req.body?.note, req.body?.payload)));
  api.post("/approvals/:id/reject", wrap((req) => agents.decide("reject", req.params.id, user(req), req.body?.note, req.body?.payload)));

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
  // Who approved what, and which systems each approval went to.
  api.get("/activity/record", wrap(() => activityRecord(store.state)));
  api.get("/notifications", wrap((req) => notificationsFor(store.state, user(req), agentId(String(req.query.agent ?? "")), opts.now?.())));
  api.get("/search", wrap((req) => searchRecords(connectors, store.state.approvals, String(req.query.q ?? ""), opts.now?.())));
  const recordKind = (s: string) => { if (!isRecordKind(s)) throw new HttpError(404, "Unknown kind of record"); return s; };
  api.get("/records/:kind", wrap((req) => listRecords(connectors, recordKind(req.params.kind), opts.now?.())));
  api.get("/records/:kind/:id", wrap(async (req) => {
    const found = await recordDetail(connectors, store.state.approvals, recordKind(req.params.kind), req.params.id, opts.now?.());
    if (!found) throw new HttpError(404, "That record is not in the connected systems any more.");
    return found;
  }));

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
  // While a real system is switched on, a run still in flight can save drafts made from it after the reset, so the workspace stays marked.
  // An approval in the middle of its steps is left to finish first: restoring under it would leave a task or an email in the other systems with no draft here to finish from.
  api.post("/reset", wrap(() => {
    if (agents.approvingNow) throw new HttpError(409, "A draft is being approved right now. Wait a few seconds for it to finish, then try again.");
    store.reset(opts.now?.(), anyLive && store.state.heldLive);
    return { ok: true };
  }));

  api.get("/systems", wrap(() => Promise.all(SYSTEM_IDS.map(statusOf))));
  api.post("/systems/:system/test", wrap(async (req) => {
    if (!isSystemId(req.params.system)) throw new HttpError(404, "Unknown system");
    const status = await statusOf(req.params.system);
    // The reason for a failure is shown on the system's card, not kept in the activity list.
    store.log(user(req), "tested connection", `${status.name}: ${status.connected ? "connected" : "could not connect"}`);
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
