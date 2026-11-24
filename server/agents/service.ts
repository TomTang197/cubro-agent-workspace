import type { Connectors } from "../connectors/index.js";
import { addDays, isoDate } from "../data/rng.js";
import type { LlmProvider } from "../llm/index.js";
import { savingFor } from "../savings.js";
import type { AgentId, AgentRun, ApprovalItem, SocialPostPayload, Store, SupplierEmailPayload } from "../store.js";
import { composeDraft, composeParts, composeSubject, emailOptions, MAX_OWN_LINE, orderIn, tidyOwnLine, writeList, type ComposeInput } from "./compose.js";
import { factSheet, readFacts, type Candidate, type FactContext, type FactSheet } from "./facts.js";
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

  /** What an email a person is writing is about: the supplier, and the order or the supplier's email if one was picked. */
  private async composeInput(q: ComposeQuery): Promise<ComposeInput> {
    const [suppliers, purchaseOrders, items] = await Promise.all([this.connectors.inforln.listSuppliers(), this.connectors.inforln.listPurchaseOrders(), this.connectors.inforln.listItems()]);
    const message = q.reply ? (await this.connectors.m365.listMessages("Inbox")).find((m) => m.id === q.reply) : undefined;
    if (q.reply && !message) throw new HttpError(404, "That email is not in the purchasing inbox any more.");
    const named = q.order ? purchaseOrders.find((po) => po.order === q.order) : undefined;
    if (q.order && !named) throw new HttpError(404, `Purchase order ${q.order} is not in Infor LN.`);
    const supplier = suppliers.find((s) => (message ? s.email.toLowerCase() === message.from.address.toLowerCase() : s.supplier === (named?.supplier ?? q.supplier)));
    if (!supplier) throw new HttpError(message ? 400 : 404, message ? `${message.from.name || message.from.address} is not a supplier in Infor LN, so this email cannot be answered from here.` : "That supplier is not in Infor LN.");
    if (!supplier.email) throw new HttpError(400, `${supplier.name} has no email address in Infor LN.`);
    // A reply opened from another supplier's order is still a reply to the supplier who wrote: that order is left out.
    const theirs = named?.supplier === supplier.supplier ? named : undefined;
    if (named && !theirs && !message) throw new HttpError(400, `${named.order} was not placed with ${supplier.name}.`);
    const orders = purchaseOrders.filter((po) => po.supplier === supplier.supplier);
    // The order the writer picked comes first, then the one the email names. The order whose page the email was opened from
    // is only where the reply started, so it counts last: an email shown there can be about another of the supplier's orders.
    const near = orders.find((po) => po.order === q.near);
    return { supplier, order: theirs ?? (message ? orderIn(message, orders) ?? near : undefined), message, orders, items, today: this.now() };
  }

  /** What the writing page lists to start from. */
  async writeList() {
    const [suppliers, purchaseOrders, messages] = await Promise.all([this.connectors.inforln.listSuppliers(), this.connectors.inforln.listPurchaseOrders(), this.connectors.m365.listMessages()]);
    const waiting = this.store.state.approvals.flatMap((a) => (a.status === "pending" && a.payload.type === "supplier_email" ? [a.payload] : []));
    return writeList(suppliers, purchaseOrders, messages, waiting, this.now());
  }

  /** Everything the writing page shows before anything is picked. */
  async composeOptions(q: ComposeQuery, by: string) {
    const input = await this.composeInput(q);
    const { supplier: s, order: po, message: m } = input;
    const parts = composeParts(input, by);
    const waiting = this.store.state.approvals.find((a) => a.status === "pending" && a.payload.type === "supplier_email" && (po ? a.payload.purchaseOrder === po.order : !!m && a.payload.inReplyTo?.id === m.id));
    return {
      ...parts,
      supplier: { id: s.supplier, name: s.name },
      order: po && { id: po.order, status: po.status },
      // Open orders first, so the one being chased is near the top of the picker.
      orders: input.orders.filter((o) => !["Received", "Closed"].includes(o.status)).map((o) => ({ id: o.order, status: o.status })),
      replyTo: m && { id: m.id, subject: m.subject, from: m.from.name, receivedDateTime: m.receivedDateTime, body: m.body },
      waiting: waiting && { id: waiting.id, title: waiting.title },
    };
  }

  /** The options for adding to a supplier email that is already waiting, leaving out what it says already. */
  async draftOptions(id: string) {
    const a = this.find(id);
    if (a.payload.type !== "supplier_email") return [];
    const p = a.payload;
    const input = await this.composeInput({ supplier: p.supplierId, order: p.purchaseOrder, reply: p.inReplyTo?.id }).catch((e) => { if (e instanceof HttpError) return undefined; throw e; });
    if (!input) return [];
    // An agent draft already makes the ask it was written for.
    const made: string[] = { overdue: ["ship-date"], unconfirmed: ["confirm-order"], partial: ["balance"], low_stock: ["availability", "terms"], reply: [], new: [] }[p.reason];
    return emailOptions(input).filter((o) => !made.includes(o.id));
  }

  // What the model read in an email, asked once per email. A reading that failed is asked for again the next time.
  private readings = new Map<string, Promise<Candidate[]>>();
  private reading(text: string) {
    const had = this.readings.get(text);
    if (had) return had;
    if (this.readings.size >= 500) this.readings.delete(this.readings.keys().next().value!);
    const asked = readFacts(this.llm, text);
    this.readings.set(text, asked);
    asked.catch(() => { if (this.readings.get(text) === asked) this.readings.delete(text); });
    return asked;
  }

  /** The key facts of an email. `quick` leaves the model out, so the page has the facts the rules find at once. */
  private async facts(mail: { subject: string; body: string }, ctx: FactContext, quick: boolean): Promise<FactSheet> {
    if (quick || !this.llm.read) return { ...factSheet(mail, ctx), ...(this.llm.read && { more: true }) };
    // Without the model's reading the rules still stand, so a failed or limited model costs the reader nothing they had.
    const read = await this.reading(`${mail.subject}\n\n${mail.body}`).catch(() => undefined);
    return { ...factSheet(mail, ctx, read), ...(read && { readBy: this.llm.name }) };
  }

  /** The key facts in a supplier's email, compared with the order it is about. */
  async emailFacts(q: ComposeQuery, quick: boolean) {
    const { message, order, orders, items, supplier } = await this.composeInput(q);
    if (!message) throw new HttpError(400, "Say which email to read.");
    return this.facts(message, { order, orders, items, supplier: supplier.supplier, at: new Date(message.receivedDateTime) }, quick);
  }

  /** The key facts in a supplier email waiting to be checked, as it reads now (`shown`, with edits not saved yet), and in the email it answers. */
  async draftFacts(id: string, shown: { subject?: unknown; body?: unknown }, quick: boolean) {
    const a = this.find(id), p = a.payload;
    if (p.type !== "supplier_email") throw new HttpError(400, "Only supplier emails have key facts.");
    const [purchaseOrders, items] = await Promise.all([this.connectors.inforln.listPurchaseOrders(), this.connectors.inforln.listItems()]);
    const orders = purchaseOrders.filter((po) => po.supplier === p.supplierId), written = (v: unknown, saved: string) => (typeof v === "string" ? v : saved);
    const order = orders.find((po) => po.order === p.purchaseOrder) ?? (p.inReplyTo && orderIn(p.inReplyTo, orders));
    const ctx = { order, orders, items, supplier: p.supplierId };
    return {
      draft: factSheet({ subject: written(shown.subject, p.subject), body: written(shown.body, p.body) }, { ...ctx, at: new Date(a.createdAt) }),
      inReplyTo: p.inReplyTo && (await this.facts(p.inReplyTo, { ...ctx, at: new Date(p.inReplyTo.receivedDateTime) }, quick)),
    };
  }

  async tidy(note: unknown, emailSoFar: unknown) {
    if (typeof note !== "string" || !note.trim()) throw new HttpError(400, "Write your line first.");
    if (note.length > MAX_OWN_LINE) throw new HttpError(400, `Keep your own line under ${MAX_OWN_LINE} characters.`);
    return tidyOwnLine(this.llm, note, typeof emailSoFar === "string" ? emailSoFar.slice(0, 6000) : "");
  }

  /** Saves an email a person wrote from the options as a draft to check. Nothing is sent until it is approved. */
  async write(q: ComposeQuery, by: string, picked: unknown, own: unknown) {
    const state = this.store.state;
    const ids = Array.isArray(picked) ? picked.map(String) : [];
    const lines = (Array.isArray(own) ? own : []).map((l) => String(l).trim()).filter(Boolean);
    if (lines.some((l) => l.length > MAX_OWN_LINE * 3)) throw new HttpError(400, "One of your own lines is too long.");
    const input = await this.composeInput(q);
    if (!lines.length && !ids.length) throw new HttpError(400, "Pick at least one thing to say, or add a line of your own.");
    // The order or the inbox can change while the page is open. What was picked is never left out without saying so.
    const offered = emailOptions(input);
    if (ids.some((id) => !offered.some((o) => o.id === id))) throw new HttpError(409, "The order has changed since you opened this page, so some of what you picked no longer applies. Nothing was saved. Open the page again and pick from what it offers now.");
    const draft = composeDraft(input, by, ids, lines);
    this.unlessRestored(state);
    const a = toApproval(draft, "", new Date().toISOString(), this.store.nextId("apr"));
    this.store.state.approvals.unshift(a);
    this.store.log(by, "wrote draft", a.title);
    this.store.save();
    return a;
  }

  find(id: string) {
    const a = this.store.state.approvals.find((x) => x.id === id);
    if (!a) throw new HttpError(404, `Approval ${id} not found`);
    return a;
  }

  /** Checks a reviewer's edits and puts them on the draft, without saving. */
  private change(a: ApprovalItem, patch: Partial<SocialPostPayload> | Partial<SupplierEmailPayload>) {
    this.untouched(a, "edited");
    const allowed = a.payload.type === "social_post" ? ["text", "hashtags", "scheduledFor", "channel"] : ["subject", "body"];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new HttpError(400, `Field ${k} cannot be edited`);
    if (a.payload.type === "social_post") this.checkSocialEdit(a, patch as Partial<SocialPostPayload>);
    Object.assign(a.payload, patch);
    a.edited = true;
  }

  edit(id: string, patch: Partial<SocialPostPayload> | Partial<SupplierEmailPayload>, by: string) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, "Only pending items can be edited");
    this.change(a, patch);
    this.store.log(by, "edited draft", a.title);
    this.store.save();
    return a;
  }

  /** Approvals being carried out right now: a second click or a second reviewer must not send the same email twice. */
  private approving = new Set<string>();
  /** True while an approval is part-way through its steps in the connected systems. */
  get approvingNow() { return this.approving.size > 0; }

  /** A decision can carry the reviewer's edits. They are kept only if the decision goes through, so one that fails leaves the draft as everyone else sees it. */
  async decide(kind: "approve" | "reject", id: string, by: string, note?: string, patch?: Partial<SocialPostPayload> | Partial<SupplierEmailPayload>) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, `Already ${a.status}`);
    const before = { payload: structuredClone(a.payload), edited: a.edited };
    let changed = false;
    try {
      if (patch) { this.change(a, patch); changed = true; }
      return await this[kind](id, by, note);
    } catch (e) {
      // Once the draft is decided, or approving it has done part of the work, the edits are what went out, even if a later step or the save then failed.
      if (changed && a.status === "pending" && !a.outcome?.length) { a.payload = before.payload; a.edited = before.edited; }
      throw e;
    }
  }

  async approve(id: string, by: string, note?: string) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, `Already ${a.status}`);
    if (this.approving.has(id)) throw new HttpError(409, "This is already being approved. Refresh in a moment to see the result.");
    const state = this.store.state;
    // The note given when approving began is kept if the approval is finished later without saying; a note cleared on purpose stays cleared.
    note ??= a.reviewerNote;
    this.approving.add(id);
    try {
      await this.carryOut(a, by, note, state);
    } catch (e) {
      if (!a.outcome?.length) delete a.outcome;
      if (e instanceof HttpError || !a.outcome) throw e;
      const done = a.outcome.map((o) => o.label).join(". ");
      throw new HttpError(502, `Done so far: ${done}. The next step failed: ${e instanceof Error ? e.message : String(e)} Approve again to finish; what is already done will not be repeated.`);
    } finally {
      this.approving.delete(id);
    }
    this.unlessRestored(state);
    a.status = "approved"; a.decidedAt = new Date().toISOString(); a.decidedBy = by; a.reviewerNote = note;
    this.recordSaving(a);
    this.store.log(by, "approved", a.title);
    this.store.save();
    return a;
  }

  reject(id: string, by: string, note?: string) {
    const a = this.find(id);
    if (a.status !== "pending") throw new HttpError(409, `Already ${a.status}`);
    this.untouched(a, "rejected");
    a.status = "rejected"; a.decidedAt = new Date().toISOString(); a.decidedBy = by; a.reviewerNote = note;
    this.recordSaving(a);
    this.store.log(by, "rejected", `${a.title}${note ? ` — ${note}` : ""}`);
    this.store.save();
    return a;
  }

  /** Staff can retime, retag and rewrite a post; this keeps what they save publishable. */
  /** Once approving has started, the draft is what went out: it can only be finished, not changed or withdrawn. */
  private untouched(a: ApprovalItem, verb: string) {
    if (this.approving.has(a.id)) throw new HttpError(409, "This is being approved right now. Refresh in a moment to see the result.");
    if (a.outcome?.length) throw new HttpError(409, `This cannot be ${verb}: approving it already did part of the work (${a.outcome.map((o) => o.label).join("; ")}). Approve it again to finish.`);
  }

  /** Does each step of an approval once, saving after every step so a retry picks up where a failure stopped. */
  private async carryOut(a: ApprovalItem, by: string, note: string | undefined, state: Store["state"]) {
    const outcome = (a.outcome ??= []);
    const did = (step: string) => outcome.find((o) => o.step === step);
    const record = (step: string, system: string, ref: string, label: string, replaces?: string) => {
      this.unlessRestored(state);
      const at = replaces ? outcome.findIndex((o) => o.step === replaces) : -1;
      const done = { system, ref, label, step, at: new Date().toISOString(), by };
      if (at >= 0) outcome[at] = done; else outcome.push(done);
      a.reviewerNote = note;
      this.store.save();
    };
    if (a.payload.type === "social_post") {
      const p = a.payload;
      const on = nzDay(p.scheduledFor);
      const at = `${shortDay(on)} at ${nzClock(p.scheduledFor)}`;
      // A part-done approval can always be finished, even late: its publishing task already exists and it can no longer be edited or rejected.
      if (!outcome.length && new Date(p.scheduledFor) < this.now()) throw new HttpError(409, `This post was planned for ${shortDay(on)}, which has passed. Pick a new date or reject it.`);
      if (!did("task")) {
        const task = await this.connectors.clickup.createTask({
          name: `Publish ${p.channel} post — ${new Date(p.scheduledFor).toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland" })}`,
          description: `Publish on ${p.channel}: ${at} (NZ time)\n\n${p.text}\n\n${p.hashtags.join(" ")}\n\nImage: ${p.assetName ? `${p.assetName} ${p.assetUrl ?? ""}` : "none picked, add one before publishing"}\nApproved by ${by}${note ? `: ${note}` : ""}`,
          list: "Marketing", assignees: [by], due_date: on, tags: ["social", p.channel.toLowerCase(), "agent-drafted"],
        });
        record("task", "ClickUp", task.url, `Task ${task.id} added to the Marketing list, to publish ${at}. The team publishes the post from there.`);
      }
      if (!did("teams")) {
        const post = await this.connectors.m365.postTeamsMessage("Marketing", `✅ ${p.channel} post approved by ${by} to publish ${at}: ${a.title}`);
        record("teams", "Microsoft 365", post.id, "Team told in the Marketing channel on Teams");
      }
    } else {
      const p = a.payload;
      if (!did("email")) {
        if (!did("draft")) {
          const draft = await this.connectors.m365.createDraft({ from: { name: this.store.state.settings.supplier.sender, address: "purchasing@cubro.co.nz" }, to: [p.to], subject: p.subject, body: p.body, inReplyTo: p.inReplyTo?.id });
          record("draft", "Microsoft 365", draft.id, `Email to ${p.to.address} saved as a draft in the purchasing mailbox, not sent yet`);
        }
        const sent = await this.connectors.m365.sendDraft(did("draft")!.ref);
        record("email", "Microsoft 365", sent.id, `Email sent to ${p.to.address}`, "draft");
      }
      if (!did("followup")) {
        // Dated from when the email went, which is earlier than today if this approval is being finished later.
        const sentOn = nzMidnight(new Date(did("email")?.at ?? Date.now())), due = isoDate(addDays(sentOn, FOLLOW_UP_DAYS));
        const task = await this.connectors.clickup.createTask({
          name: `Chase reply: ${p.supplierName} — ${p.purchaseOrder ?? p.subject}`, description: `${a.writtenBy ? `Email written by ${a.writtenBy}` : "Agent email"} sent to ${p.to.name} <${p.to.address}> on ${nzDate(isoDate(sentOn))}. Follow up if no reply.`,
          list: "Purchasing", assignees: [by], due_date: due, tags: ["supplier", p.reason, a.writtenBy ? "staff-written" : "agent-drafted"],
        });
        record("followup", "ClickUp", task.url, `Follow-up task ${task.id} in Purchasing, due ${nzDate(task.due_date ?? due)}`);
      }
    }
  }

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

/** `order` is the order the writer picked; `near` is the order whose page a reply was opened from, used only if the email names none. */
export interface ComposeQuery { supplier?: string; order?: string; reply?: string; near?: string }

export function toApproval(d: Draft, runId: string, createdAt: string, id: string): ApprovalItem {
  return { ...d, id, runId, status: "pending", createdAt, edited: false, originalPayload: structuredClone(d.payload) };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
