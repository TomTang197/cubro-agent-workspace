import type { Connectors } from "../connectors/index.js";
import { addDays, isoDate } from "../data/rng.js";
import type { LlmProvider } from "../llm/index.js";
import type { AgentId, AgentRun, ApprovalItem, SocialPostPayload, Store, SupplierEmailPayload } from "../store.js";
import { buildSupplierDrafts, type Draft } from "./drafts.js";
import { nzDay, shortDay } from "./nzTime.js";
import { buildSocialDrafts, socialBrief, takenSocialTopics } from "./social.js";

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
    description: "Checks Infor LN every morning for overdue, unconfirmed or part-delivered purchase orders and low-stock items, and drafts the supplier email for each.",
    reads: ["Infor LN purchase orders, items & suppliers", "Outlook supplier inbox"],
    writes: ["Outlook email to supplier", "ClickUp Purchasing follow-up task"],
  },
};

export class AgentService {
  constructor(private store: Store, private connectors: Connectors, private llm: LlmProvider, private now: () => Date = () => new Date()) {}

  get providerName() { return this.llm.name; }

  async run(agent: AgentId, triggeredBy: string, today = this.now()): Promise<AgentRun> {
    const startedAt = new Date().toISOString();
    const steps: AgentRun["steps"] = [];
    const step = (system: string, action: string, detail: string) => steps.push({ at: new Date().toISOString(), system, action, detail });
    const { settings } = this.store.state;
    let drafts: Draft[];
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
      const mine = this.store.state.approvals.filter((a) => a.agent === agent);
      const taken = takenSocialTopics(mine, today, settings.social.horizonDays);
      drafts = buildSocialDrafts({ campaigns, cases, accounts, items, events, assets }, settings, today, mine.length, taken);
      step("Approvals", "Check for repeats", "Left out anything already waiting for review, approved, or decided in the last two weeks");
    } else {
      const [items, suppliers, purchaseOrders] = await Promise.all([this.connectors.inforln.listItems(), this.connectors.inforln.listSuppliers(), this.connectors.inforln.listPurchaseOrders()]);
      step("Infor LN", "PurchaseOrder BOD", `${purchaseOrders.length} purchase orders, ${suppliers.length} suppliers, ${items.length} items`);
      const inbox = await this.connectors.m365.listMessages("Inbox");
      step("Microsoft 365", "Graph messages", `${inbox.length} supplier emails checked for recent replies`);
      const pending = new Set(this.store.state.approvals.filter((a) => a.status === "pending" && a.payload.type === "supplier_email").map((a) => {
        const p = a.payload as SupplierEmailPayload;
        return p.reason === "low_stock" ? `low_stock:${p.supplierId}` : `${p.reason}:${p.purchaseOrder}`;
      }));
      drafts = buildSupplierDrafts({ items, suppliers, purchaseOrders }, settings, today, pending);
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
    step("Model", "Draft", kept
      ? `${drafts.length - kept} of ${drafts.length} drafts written with ${this.llm.name}; ${kept} kept the built-in template (${firstError})`
      : `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"} written with ${this.llm.name}`);
    const run: AgentRun = {
      id: this.store.nextId("run"), agent, startedAt, finishedAt: new Date().toISOString(), triggeredBy, provider: this.llm.name,
      itemsCreated: drafts.length, steps,
      summary: drafts.length ? `${drafts.length} ${agent === "social-media" ? (drafts.length === 1 ? "post" : "posts") : "supplier emails"} drafted for review` : agent === "social-media" ? "Nothing new to plan: every current campaign, event and launch already has a post waiting or decided" : "Nothing needed attention",
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
    const outcome: NonNullable<ApprovalItem["outcome"]> = [];
    if (a.payload.type === "social_post") {
      const p = a.payload;
      const on = nzDay(p.scheduledFor);
      if (new Date(p.scheduledFor) < this.now()) throw new HttpError(409, `This post was planned for ${shortDay(on)}, which has passed. Pick a new date or reject it.`);
      const task = await this.connectors.clickup.createTask({
        name: `Publish ${p.channel} post — ${new Date(p.scheduledFor).toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland" })}`,
        description: `${p.text}\n\n${p.hashtags.join(" ")}\n\nImage: ${p.assetName ? `${p.assetName} ${p.assetUrl ?? ""}` : "none picked, add one before publishing"}\nApproved by ${by}${note ? `: ${note}` : ""}`,
        list: "Marketing", assignees: [by], due_date: on, tags: ["social", p.channel.toLowerCase(), "agent-drafted"],
      });
      outcome.push({ system: "ClickUp", ref: task.url, label: `Task ${task.id} added to the Marketing list, due ${shortDay(on)}. The team publishes the post from there.` });
      const post = await this.connectors.m365.postTeamsMessage("Marketing", `✅ ${p.channel} post approved by ${by} for ${shortDay(on)}: ${a.title}`);
      outcome.push({ system: "Microsoft 365", ref: post.id, label: "Team told in the Marketing channel on Teams" });
    } else {
      const p = a.payload;
      const draft = await this.connectors.m365.createDraft({ from: { name: this.store.state.settings.supplier.sender, address: "purchasing@cubro.co.nz" }, to: [p.to], subject: p.subject, body: p.body });
      const sent = await this.connectors.m365.sendDraft(draft.id);
      outcome.push({ system: "Microsoft 365", ref: sent.id, label: `Email sent to ${p.to.address}` });
      const task = await this.connectors.clickup.createTask({
        name: `Chase reply: ${p.supplierName} — ${p.purchaseOrder ?? p.subject}`, description: `Agent email sent ${isoDate(new Date())}. Follow up if no reply.`,
        list: "Purchasing", assignees: [by], due_date: isoDate(addDays(new Date(), 3)), tags: ["supplier", p.reason, "agent-drafted"],
      });
      outcome.push({ system: "ClickUp", ref: task.url, label: `Follow-up task ${task.id} due in 3 days` });
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

  /** Staff can retime, retag and rewrite a post; this keeps what they save publishable. */
  private checkSocialEdit(a: ApprovalItem, patch: Partial<SocialPostPayload>) {
    if (patch.text !== undefined && (typeof patch.text !== "string" || !patch.text.trim())) throw new HttpError(400, "The post has no text. Write something or reject the draft.");
    if (patch.scheduledFor !== undefined) {
      const at = new Date(patch.scheduledFor);
      if (typeof patch.scheduledFor !== "string" || Number.isNaN(at.getTime())) throw new HttpError(400, "That date is not valid.");
      if (at < this.now()) throw new HttpError(400, "Pick a date and time in the future.");
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
