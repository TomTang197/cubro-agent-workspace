import type { Connectors } from "../connectors/index.js";
import { addDays, isoDate } from "../data/rng.js";
import type { LlmProvider } from "../llm/index.js";
import type { AgentId, AgentRun, ApprovalItem, SocialPostPayload, Store, SupplierEmailPayload } from "../store.js";
import { buildSocialDrafts, FOLLOW_UP_DAYS, handledSupplierKeys, nzDate, nzDay, planSupplierDrafts, RECENT_REPLY_DAYS, supplierRunSummary, type Draft, type SupplierPlan } from "./drafts.js";

export const AGENTS: Record<AgentId, { name: string; description: string; team: string; reads: string[]; writes: string[] }> = {
  "social-media": {
    name: "Social Media Planner",
    team: "Marketing",
    description: "Plans the next two weeks of LinkedIn, Facebook and Instagram posts from live campaigns, events, new products and customer feedback, and picks an image from SharePoint.",
    reads: ["Salesforce campaigns & cases", "Infor LN items & stock", "Outlook calendar", "SharePoint brand assets"],
    writes: ["ClickUp Marketing tasks", "Teams #marketing post"],
  },
  "supplier-outreach": {
    name: "Supplier Outreach",
    team: "Purchasing",
    description: "Checks Infor LN every morning for overdue, unconfirmed or part-delivered purchase orders and low-stock items, and drafts the supplier email for each.",
    reads: ["Infor LN purchase orders, items & suppliers", "Outlook supplier inbox"],
    writes: ["Outlook email to supplier", "ClickUp Purchasing follow-up task"],
  },
};

export class AgentService {
  constructor(private store: Store, private connectors: Connectors, private llm: LlmProvider) {}

  get providerName() { return this.llm.name; }

  async run(agent: AgentId, triggeredBy: string, today = new Date()): Promise<AgentRun> {
    const startedAt = new Date().toISOString();
    const steps: AgentRun["steps"] = [];
    const step = (system: string, action: string, detail: string) => steps.push({ at: new Date().toISOString(), system, action, detail });
    const { settings } = this.store.state;
    let drafts: Draft[];
    let plan: SupplierPlan | undefined;
    if (agent === "social-media") {
      const [campaigns, cases, accounts, items, assets] = await Promise.all([
        this.connectors.salesforce.query("Campaign"), this.connectors.salesforce.query("Case"), this.connectors.salesforce.query("Account"),
        this.connectors.inforln.listItems(), this.connectors.m365.listBrandAssets(),
      ]);
      step("Salesforce", "SOQL query", `${campaigns.length} campaigns, ${cases.length} cases, ${accounts.length} accounts`);
      step("Infor LN", "Item BOD", `${items.length} items`);
      const events = await this.connectors.m365.listEvents(today.toISOString(), addDays(today, settings.social.horizonDays).toISOString());
      step("Microsoft 365", "Graph calendarView", `${events.length} events in the next ${settings.social.horizonDays} days`);
      step("Microsoft 365", "SharePoint drive", `${assets.length} brand assets`);
      const existing = this.store.state.approvals.filter((a) => a.agent === agent).length;
      drafts = buildSocialDrafts({ campaigns, cases, accounts, items, events, assets }, settings, today, existing);
    } else {
      const [items, suppliers, purchaseOrders] = await Promise.all([this.connectors.inforln.listItems(), this.connectors.inforln.listSuppliers(), this.connectors.inforln.listPurchaseOrders()]);
      step("Infor LN", "PurchaseOrder BOD", `${purchaseOrders.length} purchase orders, ${suppliers.length} suppliers, ${items.length} items`);
      const inbox = await this.connectors.m365.listMessages("Inbox");
      // Latest supplier email per purchase order, so a supplier who has just written is not chased again.
      const replies = new Map<string, { subject: string; receivedDateTime: string }>();
      for (const m of inbox) for (const po of new Set(`${m.subject} ${m.body}`.match(/PO\d+/g) ?? [])) {
        const seen = replies.get(po);
        if (!seen || seen.receivedDateTime < m.receivedDateTime) replies.set(po, { subject: m.subject, receivedDateTime: m.receivedDateTime });
      }
      const exclude = handledSupplierKeys(this.store.state.approvals, today);
      plan = planSupplierDrafts({ items, suppliers, purchaseOrders }, settings, today, { exclude, replies });
      drafts = plan.drafts;
      step("Microsoft 365", "Graph messages", `${inbox.length} supplier emails checked; ${plan.repliedRecently} order${plan.repliedRecently === 1 ? "" : "s"} left alone because the supplier wrote in the last ${RECENT_REPLY_DAYS} days`);
      step("Agent Workspace", "Approvals", `${plan.alreadyHandled} already waiting for review, or sent or rejected in the last few days, so not drafted again`);
      if (plan.heldBack) step("Agent Workspace", "Settings", `${plan.heldBack} more held for the next run (limit ${settings.supplier.maxEmailsPerRun} emails per run)`);
    }
    for (const d of drafts) {
      if (d.payload.type === "social_post") {
        d.payload.text = await this.llm.polish({ task: `Write a ${d.payload.channel} post`, draft: d.payload.text, context: d.rationale, tone: settings.social.tone });
      } else {
        d.payload.body = await this.llm.polish({ task: "Write a supplier email", draft: d.payload.body, context: d.rationale, tone: "Polite, direct, professional" });
      }
    }
    step("Model", "Draft", `${drafts.length} drafts written with ${this.llm.name}`);
    const run: AgentRun = {
      id: this.store.nextId("run"), agent, startedAt, finishedAt: new Date().toISOString(), triggeredBy, provider: this.llm.name,
      itemsCreated: drafts.length, steps,
      summary: plan ? supplierRunSummary(plan) : drafts.length ? `${drafts.length} posts drafted for review` : "Nothing needed attention",
    };
    for (const d of drafts) this.store.state.approvals.unshift(toApproval(d, run.id, run.finishedAt, this.store.nextId("apr")));
    this.store.state.runs.unshift(run);
    this.store.log(triggeredBy, "ran agent", `${AGENTS[agent].name}: ${run.summary}`);
    this.store.save();
    return run;
  }

  find(id: string) {
    const a = this.store.state.approvals.find((x) => x.id === id);
    if (!a) throw new HttpError(404, `Approval ${id} not found`);
    return a;
  }

  edit(id: string, patch: Partial<SocialPostPayload> | Partial<SupplierEmailPayload>, by: string) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, "Only pending items can be edited");
    const allowed = a.payload.type === "social_post" ? ["text", "hashtags", "scheduledFor", "channel"] : ["subject", "body"];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new HttpError(400, `Field ${k} cannot be edited`);
    Object.assign(a.payload, patch);
    a.edited = true;
    this.store.log(by, "edited draft", a.title);
    this.store.save();
    return a;
  }

  async approve(id: string, by: string, note?: string) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, `Already ${a.status}`);
    const outcome: NonNullable<ApprovalItem["outcome"]> = [];
    if (a.payload.type === "social_post") {
      const p = a.payload;
      const task = await this.connectors.clickup.createTask({
        name: `Publish ${p.channel} post — ${new Date(p.scheduledFor).toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland" })}`,
        description: `${p.text}\n\n${p.hashtags.join(" ")}\n\nImage: ${p.assetName ?? "none"} ${p.assetUrl ?? ""}\nApproved by ${by}${note ? `: ${note}` : ""}`,
        list: "Marketing", assignees: [by], due_date: p.scheduledFor.slice(0, 10), tags: ["social", p.channel.toLowerCase(), "agent-drafted"],
      });
      outcome.push({ system: "ClickUp", ref: task.url, label: `Task ${task.id} in Marketing` });
      const post = await this.connectors.m365.postTeamsMessage("Marketing", `✅ ${p.channel} post approved by ${by} for ${p.scheduledFor.slice(0, 10)}: ${a.title}`);
      outcome.push({ system: "Microsoft 365", ref: post.id, label: "Posted to Teams #Marketing" });
    } else {
      const p = a.payload;
      const draft = await this.connectors.m365.createDraft({ from: { name: this.store.state.settings.supplier.sender, address: "purchasing@cubro.co.nz" }, to: [p.to], subject: p.subject, body: p.body });
      const sent = await this.connectors.m365.sendDraft(draft.id);
      outcome.push({ system: "Microsoft 365", ref: sent.id, label: `Email sent to ${p.to.address}` });
      const task = await this.connectors.clickup.createTask({
        name: `Chase reply: ${p.supplierName} — ${p.purchaseOrder ?? p.subject}`, description: `Agent email sent to ${p.to.name} <${p.to.address}> on ${nzDate(isoDate(nzDay(new Date())))}. Follow up if no reply.`,
        list: "Purchasing", assignees: [by], due_date: isoDate(addDays(nzDay(new Date()), FOLLOW_UP_DAYS)), tags: ["supplier", p.reason, "agent-drafted"],
      });
      outcome.push({ system: "ClickUp", ref: task.url, label: `Follow-up task ${task.id} in Purchasing, due ${nzDate(task.due_date ?? isoDate(addDays(nzDay(new Date()), FOLLOW_UP_DAYS)))}` });
    }
    a.status = "approved"; a.decidedAt = new Date().toISOString(); a.decidedBy = by; a.reviewerNote = note; a.outcome = outcome;
    this.recordSaving(a);
    this.store.log(by, "approved", a.title);
    this.store.save();
    return a;
  }

  reject(id: string, by: string, note?: string) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, `Already ${a.status}`);
    a.status = "rejected"; a.decidedAt = new Date().toISOString(); a.decidedBy = by; a.reviewerNote = note;
    this.store.log(by, "rejected", `${a.title}${note ? ` — ${note}` : ""}`);
    this.store.save();
    return a;
  }

  private recordSaving(a: ApprovalItem) {
    const rate = this.store.state.settings.hourlyRates[a.agent];
    const assisted = a.estimate.reviewMinutes + (a.edited ? 4 : 0);
    const minutesSaved = Math.max(0, a.estimate.manualMinutes - assisted);
    this.store.state.savings.unshift({
      id: this.store.nextId("sav"), date: (a.decidedAt ?? new Date().toISOString()).slice(0, 10), agent: a.agent, approvalId: a.id, description: a.title,
      manualMinutes: a.estimate.manualMinutes, agentAssistedMinutes: assisted, minutesSaved, hourlyRate: rate, dollarsSaved: Math.round((minutesSaved / 60) * rate * 100) / 100,
    });
  }
}

export function toApproval(d: Draft, runId: string, createdAt: string, id: string): ApprovalItem {
  return { ...d, id, runId, status: "pending", createdAt, edited: false, originalPayload: structuredClone(d.payload) };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
