import type { Connectors } from "../connectors/index.js";
import { addDays, isoDate } from "../data/rng.js";
import type { LlmProvider } from "../llm/index.js";
import { savingFor } from "../savings.js";
import type { AgentId, AgentRun, ApprovalItem, SocialPostPayload, Store, SupplierEmailPayload } from "../store.js";
import { FOLLOW_UP_DAYS, handledSupplierKeys, nzDate, nzDay as nzMidnight, planSupplierDrafts, RECENT_REPLY_DAYS, supplierRunSummary, type Draft, type SupplierPlan } from "./drafts.js";
import { dateProblem, nzClock, nzDay, nzTime, shiftDay, shortDay } from "./nzTime.js";
import { EVENT_LEAD_DAYS, buildSocialDrafts, busySocialSlots, socialBrief, takenSocialTopics } from "./social.js";

export const AGENTS: Record<AgentId, { name: string; description: string; team: string; reads: string[]; writes: string[] }> = {
  "social-media": {
    name: "Social Media Planner",
    team: "Marketing",
    description: "Plans the next two weeks of LinkedIn, Facebook and Instagram posts from live campaigns, events, new products and customer feedback, and picks an image from SharePoint. Approved posts go to the Marketing list in ClickUp for the team to publish; nothing is posted to a social channel automatically.",
    reads: ["Salesforce campaigns & cases", "Infor LN items & stock", "Outlook calendar", "SharePoint brand assets"],
    writes: ["ClickUp Marketing tasks", "Teams #marketing post"],
  },
  "supplier-outreach": {
    name: "Supplier Outreach",
    team: "Purchasing",
    description: "Checks Infor LN for overdue, unconfirmed or part-delivered purchase orders and low-stock items, and drafts the supplier email for each.",
    reads: ["Infor LN purchase orders, items & suppliers", "Outlook supplier inbox"],
    writes: ["Outlook email to supplier", "ClickUp Purchasing follow-up task"],
  },
};

export class AgentService {
  constructor(private store: Store, private connectors: Connectors, private llm: LlmProvider, private now: () => Date = () => new Date()) {}

  get providerName() { return this.llm.name; }

  /** Work that was under way when the sample data was restored belongs to the old data, so none of it is saved into the new. */
  private unlessRestored(state: Store["state"]) {
    if (this.store.state !== state) throw new HttpError(409, "The sample data was restored while this was under way, so nothing was saved. Please try again.");
  }

  async run(agent: AgentId, triggeredBy: string, today = this.now()): Promise<AgentRun> {
    const startedAt = new Date().toISOString();
    const state = this.store.state;
    const steps: AgentRun["steps"] = [];
    const step = (system: string, action: string, detail: string) => steps.push({ at: new Date().toISOString(), system, action, detail });
    const { settings } = this.store.state;
    if (!settings.agents[agent].enabled) throw new HttpError(409, `${AGENTS[agent].name} is paused. Turn it back on in Settings to run it.`);
    let drafts: Draft[];
    let plan: SupplierPlan | undefined;
    if (agent === "social-media") {
      const [campaigns, cases, accounts, items, assets] = await Promise.all([
        this.connectors.salesforce.query("Campaign"), this.connectors.salesforce.query("Case"), this.connectors.salesforce.query("Account"),
        this.connectors.inforln.listItems(), this.connectors.m365.listBrandAssets(),
      ]);
      step("Salesforce", "SOQL query", `${campaigns.length} campaigns, ${cases.length} cases, ${accounts.length} accounts`);
      step("Infor LN", "Item BOD", `${items.length} items`);
      const lookAhead = settings.social.horizonDays + EVENT_LEAD_DAYS;
      // To the end of the last NZ day an event can fall on and still be promoted inside the plan.
      const events = await this.connectors.m365.listEvents(today.toISOString(), nzTime(shiftDay(nzDay(today), lookAhead + 1), 0, 0).toISOString());
      step("Microsoft 365", "Graph calendarView", `${events.length} events in the next ${lookAhead} days`);
      step("Microsoft 365", "SharePoint drive", `${assets.length} brand assets`);
      const mine = this.store.state.approvals.filter((a) => a.agent === agent);
      const taken = takenSocialTopics(mine, today, settings.social.horizonDays);
      drafts = buildSocialDrafts({ campaigns, cases, accounts, items, events, assets }, settings, today, mine.length, taken, busySocialSlots(mine, today));
      step("Approvals", "Check for repeats", "Left out anything already waiting for review, approved, or decided in the last two weeks");
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
    let kept = 0, firstError = "";
    const queue = [...drafts];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const p = d.payload;
        try {
          if (p.type === "social_post") p.text = await this.llm.polish({ task: `Write a ${p.channel} post`, draft: p.text, context: socialBrief(d), tone: settings.social.tone });
          else p.body = await this.llm.polish({ task: "Write the body of a supplier email", draft: p.body, context: d.rationale, tone: "Polite, direct, professional" });
        } catch (e) {
          kept++;
          firstError ||= e instanceof Error ? e.message : String(e);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    this.unlessRestored(state);
    step("Model", "Draft", kept
      ? `${drafts.length - kept} of ${drafts.length} drafts written with ${this.llm.name}; ${kept} kept the built-in template (${firstError})`
      : `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"} written with ${this.llm.name}`);
    const run: AgentRun = {
      id: this.store.nextId("run"), agent, startedAt, finishedAt: new Date().toISOString(), triggeredBy, provider: this.llm.name,
      itemsCreated: drafts.length, steps,
      summary: plan ? supplierRunSummary(plan) : drafts.length ? `${drafts.length} ${drafts.length === 1 ? "post" : "posts"} drafted for review` : "Nothing new to plan: every current campaign, event and launch already has a post waiting or decided",
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
    if (a.payload.type === "social_post") this.checkSocialEdit(a, patch as Partial<SocialPostPayload>);
    Object.assign(a.payload, patch);
    a.edited = true;
    this.store.log(by, "edited draft", a.title);
    this.store.save();
    return a;
  }

  async approve(id: string, by: string, note?: string) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, `Already ${a.status}`);
    const state = this.store.state;
    const outcome: NonNullable<ApprovalItem["outcome"]> = [];
    if (a.payload.type === "social_post") {
      const p = a.payload;
      const on = nzDay(p.scheduledFor);
      const at = `${shortDay(on)} at ${nzClock(p.scheduledFor)}`;
      if (new Date(p.scheduledFor) < this.now()) throw new HttpError(409, `This post was planned for ${shortDay(on)}, which has passed. Pick a new date or reject it.`);
      const task = await this.connectors.clickup.createTask({
        name: `Publish ${p.channel} post — ${new Date(p.scheduledFor).toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland" })}`,
        description: `Publish on ${p.channel}: ${at} (NZ time)\n\n${p.text}\n\n${p.hashtags.join(" ")}\n\nImage: ${p.assetName ? `${p.assetName} ${p.assetUrl ?? ""}` : "none picked, add one before publishing"}\nApproved by ${by}${note ? `: ${note}` : ""}`,
        list: "Marketing", assignees: [by], due_date: on, tags: ["social", p.channel.toLowerCase(), "agent-drafted"],
      });
      outcome.push({ system: "ClickUp", ref: task.url, label: `Task ${task.id} added to the Marketing list, to publish ${at}. The team publishes the post from there.` });
      const post = await this.connectors.m365.postTeamsMessage("Marketing", `✅ ${p.channel} post approved by ${by} to publish ${at}: ${a.title}`);
      outcome.push({ system: "Microsoft 365", ref: post.id, label: "Team told in the Marketing channel on Teams" });
    } else {
      const p = a.payload;
      const draft = await this.connectors.m365.createDraft({ from: { name: this.store.state.settings.supplier.sender, address: "purchasing@cubro.co.nz" }, to: [p.to], subject: p.subject, body: p.body });
      const sent = await this.connectors.m365.sendDraft(draft.id);
      outcome.push({ system: "Microsoft 365", ref: sent.id, label: `Email sent to ${p.to.address}` });
      const task = await this.connectors.clickup.createTask({
        name: `Chase reply: ${p.supplierName} — ${p.purchaseOrder ?? p.subject}`, description: `Agent email sent to ${p.to.name} <${p.to.address}> on ${nzDate(isoDate(nzMidnight(new Date())))}. Follow up if no reply.`,
        list: "Purchasing", assignees: [by], due_date: isoDate(addDays(nzMidnight(new Date()), FOLLOW_UP_DAYS)), tags: ["supplier", p.reason, "agent-drafted"],
      });
      outcome.push({ system: "ClickUp", ref: task.url, label: `Follow-up task ${task.id} in Purchasing, due ${nzDate(task.due_date ?? isoDate(addDays(nzMidnight(new Date()), FOLLOW_UP_DAYS)))}` });
    }
    this.unlessRestored(state);
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
    this.recordSaving(a);
    this.store.log(by, "rejected", `${a.title}${note ? ` — ${note}` : ""}`);
    this.store.save();
    return a;
  }

  /** Staff can retime, retag and rewrite a post; this keeps what they save publishable. */
  private checkSocialEdit(a: ApprovalItem, patch: Partial<SocialPostPayload>) {
    if (patch.text !== undefined && (typeof patch.text !== "string" || !patch.text.trim())) throw new HttpError(400, "The post has no text. Write something or reject the draft.");
    if (patch.scheduledFor !== undefined) {
      const at = new Date(patch.scheduledFor);
      if (typeof patch.scheduledFor !== "string" || Number.isNaN(at.getTime())) throw new HttpError(400, "That date is not valid.");
      if (at < this.now()) throw new HttpError(400, "Pick a date and time in the future.");
      const problem = a.payload.type === "social_post" ? dateProblem(a.payload, at.toISOString()) : undefined;
      if (problem) throw new HttpError(400, problem);
      patch.scheduledFor = at.toISOString();
    }
    if (patch.hashtags !== undefined) {
      if (!Array.isArray(patch.hashtags)) throw new HttpError(400, "Hashtags must be a list.");
      patch.hashtags = [...new Set(patch.hashtags.map((h) => String(h).replace(/[#\s]/g, "")).filter(Boolean).map((h) => `#${h}`))];
    }
    if (patch.channel !== undefined) {
      if (!["LinkedIn", "Facebook", "Instagram"].includes(patch.channel)) throw new HttpError(400, "Unknown channel.");
      a.title = a.title.replace(/^(LinkedIn|Facebook|Instagram):/, `${patch.channel}:`);
    }
  }

  private recordSaving(a: ApprovalItem) {
    this.store.state.savings.unshift({ id: this.store.nextId("sav"), ...savingFor(a, this.store.state.settings.hourlyRates[a.agent]) });
  }
}

export function toApproval(d: Draft, runId: string, createdAt: string, id: string): ApprovalItem {
  return { ...d, id, runId, status: "pending", createdAt, edited: false, originalPayload: structuredClone(d.payload) };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
