import type { SystemData } from "../data/seed.js";
import { addDays, isoDate } from "../data/rng.js";
import type { ApprovalItem, Settings, SocialPostPayload, SupplierEmailPayload } from "../store.js";

export type Draft = Omit<ApprovalItem, "id" | "runId" | "status" | "createdAt" | "edited" | "originalPayload">;

export const ESTIMATES = {
  social_post: { manualMinutes: 35, reviewMinutes: 5 },
  supplier_email: { manualMinutes: 22, reviewMinutes: 3 },
} as const;

const HASHTAGS: Record<string, string[]> = {
  Beds: ["#FallsPrevention", "#AgedCareNZ"],
  Mattresses: ["#PressureInjuryPrevention", "#WoundCare"],
  "Patient handling": ["#SafeMovingAndHandling", "#CarerSafety"],
  "Bathroom & toileting": ["#DignityInCare", "#Bathing"],
  Seating: ["#Seating", "#PostureCare"],
  Bariatric: ["#BariatricCare", "#Dignity"],
  "Tables & trolleys": ["#WardEquipment"],
  Spares: ["#ServiceAndSupport"],
};

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", timeZone: "Pacific/Auckland" });

type SocialData = Pick<SystemData["salesforce"], "campaigns" | "cases" | "accounts"> & Pick<SystemData["inforln"], "items"> & Pick<SystemData["m365"], "events" | "assets">;

export function buildSocialDrafts(d: SocialData, settings: Settings, start: Date, offset = 0): Draft[] {
  const { channels, postsPerRun, horizonDays } = settings.social;
  const end = addDays(start, horizonDays);
  const inWindow = (s: string, e: string) => s <= isoDate(end) && e >= isoDate(start);
  const campaigns = d.campaigns.filter((c) => inWindow(c.StartDate, c.EndDate));
  const events = d.events.filter((e) => e.category === "Trade show" || e.category === "Webinar").filter((e) => e.start >= start.toISOString() && e.start <= end.toISOString());
  const praise = d.cases.filter((c) => c.Type === "Feedback" && !/demo|replacing|sticking/i.test(c.Description));
  const newItems = d.items.filter((i) => i.isNew);

  type Idea = { title: string; text: (ch: string) => string; tags: string[]; skus: string[]; campaign?: string; why: string; sources: Draft["sources"]; priority: Draft["priority"] };
  const ideas: Idea[] = [];
  for (const c of campaigns) {
    const prods = c.ProductSkus.map((s) => d.items.find((i) => i.item === s)).filter(Boolean) as SocialData["items"];
    const p = prods[(offset + ideas.length) % Math.max(1, prods.length)];
    ideas.push({
      title: `${c.Name}${p ? ` — ${p.description}` : ""}`,
      text: (ch) => ch === "LinkedIn"
        ? `${c.KeyMessage}\n\n${p ? `The ${p.description} is part of our ${p.itemGroup.toLowerCase()} range, designed and supported here in Aotearoa. ` : ""}Our team works alongside ${c.Audience.toLowerCase()} to match equipment to the people using it.\n\nTalk to your Cubro account manager or visit cubro.co.nz to book a demo.`
        : ch === "Instagram"
          ? `${c.KeyMessage} ${p ? `Meet the ${p.description}.` : ""} Designed with NZ carers 💙`
          : `${c.KeyMessage}${p ? ` See the ${p.description} in action and ask us about a trial at your facility.` : ""} Message us to find out more.`,
      tags: [...(p ? HASHTAGS[p.itemGroup] ?? [] : []), "#Cubro", "#NZHealth"],
      skus: p ? [p.item] : [], campaign: c.Name, priority: c.Status === "In Progress" ? "high" : "normal",
      why: `Salesforce campaign "${c.Name}" runs ${c.StartDate} to ${c.EndDate}${p ? `; featured product ${p.item} has ${p.onHand} units on hand in Infor LN` : ""}.`,
      sources: [{ system: "Salesforce", label: `Campaign: ${c.Name}`, ref: c.Id }, ...(p ? [{ system: "Infor LN", label: `Item ${p.item}`, ref: p.item }] : [])],
    });
  }
  for (const e of events) {
    ideas.push({
      title: `Event: ${e.subject}`,
      text: (ch) => ch === "LinkedIn"
        ? `We'll be at ${e.subject} (${e.location}) on ${fmtDate(e.start)}. Come and see our latest care beds, hoists and bathroom solutions, and talk to our team about what your facility needs.\n\nWe'd love to see you there.`
        : `Catch the Cubro team at ${e.subject}, ${e.location}, on ${fmtDate(e.start)}. Come say kia ora!`,
      tags: ["#Cubro", "#HealthcareNZ", "#TradeShow"], skus: [], priority: "high",
      why: `Outlook calendar shows "${e.subject}" on ${e.start.slice(0, 10)} organised by ${e.organizer}.`,
      sources: [{ system: "Microsoft 365", label: `Calendar: ${e.subject}`, ref: e.id }],
    });
  }
  for (const p of newItems) {
    ideas.push({
      title: `New product: ${p.description}`,
      text: (ch) => ch === "LinkedIn"
        ? `New to the Cubro range: the ${p.description}.\n\nBuilt for the realities of NZ ${p.itemGroup === "Beds" ? "wards and rest homes" : "care settings"}, it joins our ${p.itemGroup.toLowerCase()} line-up${p.launchDate ? ` from ${fmtDate(p.launchDate + "T00:00:00Z")}` : ""}. Ask your account manager about a trial unit.`
        : `Introducing the ${p.description} — new to our ${p.itemGroup.toLowerCase()} range. Ask us about a trial.`,
      tags: [...(HASHTAGS[p.itemGroup] ?? []), "#NewProduct", "#Cubro"], skus: [p.item], priority: "normal",
      why: `Infor LN flags ${p.item} as a new item${p.launchDate ? ` launching ${p.launchDate}` : ""}.`,
      sources: [{ system: "Infor LN", label: `New item ${p.item}`, ref: p.item }],
    });
  }
  for (const c of praise.slice(0, 4)) {
    const acc = d.accounts.find((a) => a.Id === c.AccountId);
    const p = d.items.find((i) => i.item === c.ProductSku);
    ideas.push({
      title: `Customer story: ${p?.description ?? "feedback"}`,
      text: () => `"${c.Description}" — feedback from a ${acc?.Type.toLowerCase() ?? "customer"} team in ${acc?.BillingCity ?? "NZ"}.\n\nStories like this are why we design equipment with the people who use it every day.${p ? ` (Pictured: ${p.description})` : ""}`,
      tags: ["#CustomerStory", "#Cubro", ...(p ? HASHTAGS[p.itemGroup] ?? [] : [])], skus: p ? [p.item] : [], priority: "low",
      why: `Salesforce case ${c.Id} logged positive feedback on ${c.CreatedDate}. Get the customer's permission before naming them.`,
      sources: [{ system: "Salesforce", label: `Case ${c.Id}`, ref: c.Id }],
    });
  }

  const drafts: Draft[] = [];
  for (let i = 0; i < postsPerRun && ideas.length; i++) {
    const idea = ideas[(i + offset) % ideas.length];
    const channel = channels[(i + offset) % channels.length];
    const when = addDays(start, Math.min(horizonDays - 1, Math.floor((i * horizonDays) / postsPerRun) + 1));
    when.setUTCHours(channel === "LinkedIn" ? 20 : 6, 30); // 9:30am / 7:30pm NZDT
    const asset = d.assets.find((a) => idea.skus.includes(a.productSku ?? "")) ?? d.assets[(i + offset) % d.assets.length];
    const payload: SocialPostPayload = {
      type: "social_post", channel, scheduledFor: when.toISOString(), text: idea.text(channel), hashtags: idea.tags.slice(0, 4),
      assetName: asset?.name, assetUrl: asset?.webUrl, campaign: idea.campaign, productSkus: idea.skus,
    };
    drafts.push({
      agent: "social-media", kind: "social_post", title: `${channel}: ${idea.title}`, priority: idea.priority,
      rationale: idea.why, sources: [...idea.sources, ...(asset ? [{ system: "Microsoft 365", label: `SharePoint asset ${asset.name}`, ref: asset.id }] : [])],
      payload, estimate: { ...ESTIMATES.social_post },
    });
  }
  return drafts;
}

type SupplierData = SystemData["inforln"];
type SupplierReply = { subject: string; receivedDateTime: string };

/** Days the agent leaves a supplier alone after an email is sent or a draft is rejected; also when the ClickUp follow-up falls due. */
export const FOLLOW_UP_DAYS = 3;
/** A supplier email about an order within this many days means the chase is not needed yet. */
export const REPLY_WORKING_DAYS = 2;
export const RECENT_REPLY_DAYS = 7;

/** Stock enquiries to the same supplier are spaced further apart than order chases. */
export const LOW_STOCK_REPEAT_DAYS = 14;

/** Orders and suppliers the agent should leave alone: a draft is already waiting, or one was sent or rejected recently. */
export function handledSupplierKeys(approvals: ApprovalItem[], today: Date): Set<string> {
  const since = (days: number) => addDays(today, -days).toISOString();
  const keys = new Set<string>();
  for (const a of approvals) {
    if (a.payload.type !== "supplier_email") continue;
    const window = a.payload.reason === "low_stock" ? LOW_STOCK_REPEAT_DAYS : FOLLOW_UP_DAYS;
    if (a.status === "pending" || (a.decidedAt ?? "") >= since(window)) keys.add(supplierKey(a.payload));
  }
  return keys;
}

export const supplierKey = (p: Pick<SupplierEmailPayload, "reason" | "purchaseOrder" | "supplierId">) => p.reason === "low_stock" ? `low_stock:${p.supplierId}` : `po:${p.purchaseOrder}`;
export const nzDate = (iso: string, weekday = false) => {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z"), fmt = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-NZ", { ...o, timeZone: "UTC" });
  return weekday ? `${fmt({ weekday: "long" })} ${d.getUTCDate()} ${fmt({ month: "long" })}` : `${d.getUTCDate()} ${fmt({ month: "long" })} ${d.getUTCFullYear()}`;
};
/** The calendar day in Auckland as a UTC-midnight Date: a 7am run in New Zealand is still "yesterday" in UTC. */
export const nzDay = (d: Date) => new Date(d.toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" }) + "T00:00:00Z");
/** The date n working days (Monday to Friday) after `from`. */
export const addWorkingDays = (from: Date, n: number) => {
  let d = from;
  while (n > 0) { d = addDays(d, 1); if (![0, 6].includes(d.getUTCDay())) n--; }
  return d;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface SupplierPlanOptions {
  /** Keys from handledSupplierKeys(). */
  exclude?: Set<string>;
  /** Latest supplier email per purchase order, from the Microsoft 365 inbox. */
  replies?: Map<string, SupplierReply>;
}
export interface SupplierPlan { drafts: Draft[]; heldBack: number; alreadyHandled: number; repliedRecently: number }

export function planSupplierDrafts(d: SupplierData, settings: Settings, today: Date, { exclude = new Set(), replies = new Map() }: SupplierPlanOptions = {}): SupplierPlan {
  const { overdueGraceDays, lowStockCoverageWeeks, maxEmailsPerRun, sender } = settings.supplier;
  today = nzDay(today);
  const t = isoDate(today);
  const grace = isoDate(addDays(today, -overdueGraceDays));
  const recentReply = isoDate(addDays(today, -RECENT_REPLY_DAYS));
  const out: (Draft & { rank: number })[] = [];
  let alreadyHandled = 0, repliedRecently = 0;
  const sup = (id: string) => d.suppliers.find((s) => s.supplier === id)!;
  const itemName = (sku: string) => d.items.find((i) => i.item === sku)?.description ?? sku;
  const openStatuses = ["Created", "Sent", "Confirmed", "Partially received"];
  const sign = `Kind regards,\n${sender}\nPurchasing Officer, Cubro Ltd\nTauriko, Tauranga, New Zealand`;
  const linesText = (po: SupplierData["purchaseOrders"][number]) => po.lines.filter((l) => l.received < l.quantity).map((l) => `  • ${l.item} ${itemName(l.item)} — ${l.quantity - l.received} of ${l.quantity} outstanding`).join("\n");
  const daysSince = (iso: string) => Math.round((new Date(isoDate(today)).getTime() - new Date(iso.slice(0, 10)).getTime()) / 86_400_000);
  const replyBy = isoDate(addWorkingDays(today, REPLY_WORKING_DAYS));
  const replyByText = nzDate(replyBy, true);

  for (const po of d.purchaseOrders) {
    if (!openStatuses.includes(po.status) || po.orderDate > t) continue;
    const s = sup(po.supplier);
    const due = po.confirmedReceiptDate ?? po.plannedReceiptDate;
    let reason: SupplierEmailPayload["reason"] | undefined;
    // The balance of a part delivery is only chased once the order's due date has passed.
    if (po.status === "Partially received") reason = due < t ? "partial" : undefined;
    else if (due < grace) reason = "overdue";
    else if (po.status === "Sent" && po.orderDate < isoDate(addDays(today, -7))) reason = "unconfirmed";
    if (!reason) continue;
    if (exclude.has(`po:${po.order}`)) { alreadyHandled++; continue; }
    const reply = replies.get(po.order);
    if (reply && reply.receivedDateTime.slice(0, 10) >= recentReply) { repliedRecently++; continue; }
    const daysLate = daysSince(due);
    const outstanding = po.lines.reduce((n, l) => n + l.quantity - l.received, 0), ordered = po.lines.reduce((n, l) => n + l.quantity, 0);
    const subject = reason === "overdue" ? `${po.order} — overdue, please confirm new ship date` : reason === "partial" ? `${po.order} — balance of partial delivery` : `${po.order} — please confirm order`;
    const intro = reason === "overdue"
      ? `Our purchase order ${po.order} (placed ${nzDate(po.orderDate)}) was due to arrive on ${nzDate(due)} and is now ${plural(daysLate, "day")} late.`
      : reason === "partial" ? `Thank you for the partial delivery against ${po.order}, which was due on ${nzDate(due)}. The following lines are still outstanding:`
        : `We sent purchase order ${po.order} on ${nzDate(po.orderDate)} but haven't received a confirmation yet.`;
    const ask = reason === "unconfirmed" ? "Could you please confirm the order, pricing and expected ship date?" : "Could you please confirm the expected ship date and tracking details for the outstanding items, and let us know if anything is holding them up?";
    const body = `Hi ${s.contactName.split(" ")[0]},\n\n${intro}\n\n${linesText(po)}\n\n${ask} A reply by ${replyByText} would help us plan deliveries to our customers.\n\n${sign}`;
    const why = reason === "overdue" ? `Infor LN shows ${po.order} status "${po.status}", receipt date ${nzDate(due)} is ${plural(daysLate, "day")} past (grace ${plural(overdueGraceDays, "day")}). Supplier on-time rate ${Math.round(s.onTimeRate * 100)}%.`
      : reason === "partial" ? `Infor LN shows ${po.order} partially received: ${outstanding} of ${plural(ordered, "unit")} still outstanding, due ${nzDate(due)} (${plural(daysLate, "day")} ago).`
        : `Infor LN shows ${po.order} sent ${nzDate(po.orderDate)} (${plural(daysSince(po.orderDate), "day")} ago) with no supplier confirmation.`;
    out.push({
      agent: "supplier-outreach", kind: "supplier_email", title: `${s.name}: ${subject}`,
      priority: reason === "overdue" && daysLate > 10 ? "high" : "normal",
      rationale: reply ? `${why} Last email from ${s.contactName} about this order: "${reply.subject}" on ${nzDate(reply.receivedDateTime)}.` : `${why} No email from the supplier about this order in the inbox.`,
      sources: [{ system: "Infor LN", label: `Purchase order ${po.order}`, ref: po.order }, { system: "Infor LN", label: `Supplier ${s.supplier}`, ref: s.supplier }, ...(reply ? [{ system: "Microsoft 365", label: `Email "${reply.subject}"`, ref: `mail:${po.order}` }] : [])],
      payload: { type: "supplier_email", replyBy, supplierId: s.supplier, supplierName: s.name, to: { name: s.contactName, address: s.email }, subject, body, reason, purchaseOrder: po.order, items: po.lines.map((l) => l.item) },
      estimate: { ...ESTIMATES.supplier_email },
      // Late and part-delivered orders are chased before unconfirmed ones; within a group, the longest-waiting first.
      rank: { overdue: 0, partial: 1, low_stock: 2, unconfirmed: 3 }[reason] * 1000 - Math.min(999, Math.max(0, reason === "unconfirmed" ? daysSince(po.orderDate) : daysLate)),
    });
  }

  const openQty = (sku: string) => d.purchaseOrders.filter((p) => openStatuses.includes(p.status)).flatMap((p) => p.lines).filter((l) => l.item === sku).reduce((n, l) => n + l.quantity - l.received, 0);
  const low = d.items.filter((i) => i.onHand + openQty(i.item) < Math.max(i.reorderPoint, (i.avgMonthlyDemand / 4.33) * lowStockCoverageWeeks));
  const bySupplier = new Map<string, typeof low>();
  for (const i of low) bySupplier.set(i.primarySupplier, [...(bySupplier.get(i.primarySupplier) ?? []), i]);
  for (const [sid, list] of bySupplier) {
    if (exclude.has(`low_stock:${sid}`)) { alreadyHandled++; continue; }
    const s = sup(sid);
    // Stock levels stay in the reviewer's notes; the supplier only sees what we want to buy.
    const lines = list.map((i) => `  • ${i.item} ${i.description} — about ${Math.max(i.reorderPoint * 2 - i.onHand, Math.ceil(i.avgMonthlyDemand * 2))} units`).join("\n");
    const stock = list.map((i) => `${i.item}: ${i.onHand} on hand, ${openQty(i.item)} on order, reorder point ${i.reorderPoint}, about ${i.avgMonthlyDemand} used a month`).join("; ");
    const subject = `Availability and lead time request — ${plural(list.length, "item")}`;
    out.push({
      agent: "supplier-outreach", kind: "supplier_email", title: `${s.name}: ${subject}`, priority: list.some((i) => i.onHand <= i.safetyStock) ? "high" : "normal",
      rationale: `Infor LN stock plus open orders covers less than ${lowStockCoverageWeeks} weeks of demand. ${stock}. Average lead time from ${s.name} is ${s.avgLeadTimeDays} days. The email does not show our stock levels.`,
      sources: [...list.map((i) => ({ system: "Infor LN", label: `Item ${i.item}`, ref: i.item })), { system: "Infor LN", label: `Supplier ${s.supplier}`, ref: s.supplier }],
      payload: { type: "supplier_email", replyBy, supplierId: s.supplier, supplierName: s.name, to: { name: s.contactName, address: s.email }, subject, reason: "low_stock", items: list.map((i) => i.item),
        body: `Hi ${s.contactName.split(" ")[0]},\n\nWe're planning our next order and would like to check current availability, pricing and lead time for:\n\n${lines}\n\nCould you let us know the earliest ship date you can offer and whether ${s.paymentTerms} terms still apply? If any of these are on allocation, please tell us so we can plan around it. A reply by ${replyByText} would be appreciated.\n\n${sign}` },
      estimate: { ...ESTIMATES.supplier_email },
      rank: 2000,
    });
  }
  const priority = { high: 0, normal: 1, low: 2 };
  const ranked = out.sort((a, b) => priority[a.priority] - priority[b.priority] || a.rank - b.rank).map(({ rank: _rank, ...draft }) => draft);
  return { drafts: ranked.slice(0, maxEmailsPerRun), heldBack: Math.max(0, ranked.length - maxEmailsPerRun), alreadyHandled, repliedRecently };
}

export const buildSupplierDrafts = (d: SupplierData, settings: Settings, today: Date, opts?: SupplierPlanOptions): Draft[] => planSupplierDrafts(d, settings, today, opts).drafts;

/** One line a purchasing officer can read on the Agents page and Overview. */
export function supplierRunSummary(plan: Pick<SupplierPlan, "heldBack"> & { drafts: unknown[] }): string {
  const held = plan.heldBack ? `, ${plan.heldBack} more held for the next run` : "";
  return plan.drafts.length ? `${plural(plan.drafts.length, "supplier email")} drafted for review${held}` : "Nothing new needs chasing";
}
