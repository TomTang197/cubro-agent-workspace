import type { SystemData } from "../data/seed.js";
import { addDays, isoDate } from "../data/rng.js";
import type { ApprovalItem, Settings, SocialPostPayload, SupplierEmailPayload } from "../store.js";

export type Draft = Omit<ApprovalItem, "id" | "runId" | "status" | "createdAt" | "edited" | "originalPayload">;

export const ESTIMATES = {
  social_post: { manualMinutes: 35, reviewMinutes: 5 },
  supplier_email: { manualMinutes: 22, reviewMinutes: 3 },
} as const;

// Keyed by the Infor LN item group (the product categories on cubro.co.nz).
const HASHTAGS: Record<string, string[]> = {
  Beds: ["#FallsPrevention", "#AgedCareNZ"],
  "Bedroom furniture": ["#AgedCareNZ", "#CareHomeDesign"],
  "Pressure care": ["#PressureInjuryPrevention", "#WoundCare"],
  "Moving and transferring": ["#SafeMovingAndHandling", "#CarerSafety"],
  "Falls prevention and recovery": ["#FallsPrevention", "#PatientSafety"],
  Seating: ["#Seating", "#PostureCare"],
  Wheelchairs: ["#Mobility", "#Independence"],
  "Powered wheelchairs": ["#Mobility", "#Independence"],
  "Mobility scooters": ["#Mobility", "#Independence"],
  "Trolleys, carts and laundry": ["#WardEquipment"],
  "Infection control": ["#InfectionPrevention"],
  "Medical and respiratory": ["#RespiratoryCare"],
  Hygiene: ["#DignityInCare", "#Bathing"],
  "Walking and mobility aids": ["#Mobility", "#Independence"],
  "Theatre equipment": ["#PerioperativeCare"],
  "Spare parts": ["#ServiceAndSupport"],
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

export function buildSupplierDrafts(d: SupplierData, settings: Settings, today: Date, exclude: Set<string> = new Set()): Draft[] {
  const { overdueGraceDays, lowStockCoverageWeeks, maxEmailsPerRun, sender } = settings.supplier;
  const t = isoDate(today);
  const grace = isoDate(addDays(today, -overdueGraceDays));
  const out: Draft[] = [];
  const sup = (id: string) => d.suppliers.find((s) => s.supplier === id)!;
  const itemName = (sku: string) => d.items.find((i) => i.item === sku)?.description ?? sku;
  const openStatuses = ["Created", "Sent", "Confirmed", "Partially received"];
  const sign = `Kind regards,\n${sender}\nPurchasing Officer, Cubro Ltd\nTauriko, Tauranga, New Zealand`;
  const linesText = (po: SupplierData["purchaseOrders"][number]) => po.lines.map((l) => `  • ${l.item} ${itemName(l.item)} — ${l.quantity - l.received} of ${l.quantity} outstanding`).join("\n");

  for (const po of d.purchaseOrders) {
    if (!openStatuses.includes(po.status)) continue;
    const s = sup(po.supplier);
    const due = po.confirmedReceiptDate ?? po.plannedReceiptDate;
    let reason: SupplierEmailPayload["reason"] | undefined;
    if (po.status === "Partially received") reason = "partial";
    else if (due < grace) reason = "overdue";
    else if (po.status === "Sent" && po.orderDate < isoDate(addDays(today, -7))) reason = "unconfirmed";
    if (!reason || exclude.has(`${reason}:${po.order}`)) continue;
    const daysLate = Math.round((today.getTime() - new Date(due).getTime()) / 86_400_000);
    const subject = reason === "overdue" ? `${po.order} — overdue, please confirm new ship date` : reason === "partial" ? `${po.order} — balance of partial delivery` : `${po.order} — please confirm order`;
    const intro = reason === "overdue"
      ? `Our purchase order ${po.order} (placed ${po.orderDate}) was due to arrive on ${due} and is now ${daysLate} days late.`
      : reason === "partial" ? `Thank you for the partial delivery against ${po.order}. The following lines are still outstanding:`
        : `We sent purchase order ${po.order} on ${po.orderDate} but haven't received a confirmation yet.`;
    const ask = reason === "unconfirmed" ? "Could you please confirm the order, pricing and expected ship date?" : "Could you please confirm the expected ship date and tracking details for the outstanding items, and let us know if anything is holding them up?";
    const body = `Hi ${s.contactName.split(" ")[0]},\n\n${intro}\n\n${linesText(po)}\n\n${ask} We have customer orders waiting on some of these items, so an update by ${isoDate(addDays(today, 2))} would really help.\n\n${sign}`;
    out.push({
      agent: "supplier-outreach", kind: "supplier_email", title: `${s.name}: ${subject}`,
      priority: reason === "overdue" && daysLate > 10 ? "high" : "normal",
      rationale: reason === "overdue" ? `Infor LN shows ${po.order} status "${po.status}", receipt date ${due} is ${daysLate} days past (grace ${overdueGraceDays} days). Supplier on-time rate ${Math.round(s.onTimeRate * 100)}%.`
        : reason === "partial" ? `Infor LN shows ${po.order} partially received.` : `Infor LN shows ${po.order} sent ${po.orderDate} with no supplier confirmation.`,
      sources: [{ system: "Infor LN", label: `Purchase order ${po.order}`, ref: po.order }, { system: "Infor LN", label: `Supplier ${s.supplier}`, ref: s.supplier }],
      payload: { type: "supplier_email", supplierId: s.supplier, supplierName: s.name, to: { name: s.contactName, address: s.email }, subject, body, reason, purchaseOrder: po.order, items: po.lines.map((l) => l.item) },
      estimate: { ...ESTIMATES.supplier_email },
    });
  }

  const openQty = (sku: string) => d.purchaseOrders.filter((p) => openStatuses.includes(p.status)).flatMap((p) => p.lines).filter((l) => l.item === sku).reduce((n, l) => n + l.quantity - l.received, 0);
  const low = d.items.filter((i) => i.onHand + openQty(i.item) < Math.max(i.reorderPoint, (i.avgMonthlyDemand / 4.33) * lowStockCoverageWeeks));
  const bySupplier = new Map<string, typeof low>();
  for (const i of low) bySupplier.set(i.primarySupplier, [...(bySupplier.get(i.primarySupplier) ?? []), i]);
  for (const [sid, list] of bySupplier) {
    if (exclude.has(`low_stock:${sid}`)) continue;
    const s = sup(sid);
    const lines = list.map((i) => {
      const qty = Math.max(i.reorderPoint * 2 - i.onHand, Math.ceil(i.avgMonthlyDemand * 2));
      return `  • ${i.item} ${i.description} — about ${qty} units (on hand ${i.onHand}, reorder point ${i.reorderPoint})`;
    }).join("\n");
    const subject = `Availability and lead time request — ${list.length} item${list.length > 1 ? "s" : ""}`;
    out.push({
      agent: "supplier-outreach", kind: "supplier_email", title: `${s.name}: ${subject}`, priority: list.some((i) => i.onHand <= i.safetyStock) ? "high" : "normal",
      rationale: `Infor LN stock plus open orders for ${list.map((i) => i.item).join(", ")} covers less than ${lowStockCoverageWeeks} weeks of demand. Average lead time from ${s.name} is ${s.avgLeadTimeDays} days.`,
      sources: [...list.map((i) => ({ system: "Infor LN", label: `Item ${i.item}`, ref: i.item })), { system: "Infor LN", label: `Supplier ${s.supplier}`, ref: s.supplier }],
      payload: { type: "supplier_email", supplierId: s.supplier, supplierName: s.name, to: { name: s.contactName, address: s.email }, subject, reason: "low_stock", items: list.map((i) => i.item),
        body: `Hi ${s.contactName.split(" ")[0]},\n\nWe're planning our next order and would like to check current availability, pricing and lead time for:\n\n${lines}\n\nCould you let us know the earliest ship date you can offer and whether ${s.paymentTerms} terms still apply? If any of these are on allocation, please tell us so we can plan around it.\n\n${sign}` },
      estimate: { ...ESTIMATES.supplier_email },
    });
  }
  const rank = { high: 0, normal: 1, low: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, maxEmailsPerRun);
}
void ({} as SupplierEmailPayload);
