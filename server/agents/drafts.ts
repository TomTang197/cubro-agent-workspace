import type { SystemData } from "../data/seed.js";
import { addDays, isoDate } from "../data/rng.js";
import type { ApprovalItem, Settings, SupplierEmailPayload } from "../store.js";

export type Draft = Omit<ApprovalItem, "id" | "runId" | "status" | "createdAt" | "edited" | "originalPayload">;

export const ESTIMATES = {
  social_post: { manualMinutes: 35, reviewMinutes: 5 },
  supplier_email: { manualMinutes: 22, reviewMinutes: 3 },
} as const;

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
