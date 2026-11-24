// A supplier email a person writes with the assistant: they pick what to say from options drawn from the order and the supplier's own email,
// add a line of their own, and the result goes to Drafts to check like any other draft.
import type { LnItem, LnPurchaseOrder, LnSupplier, MailMessage } from "../connectors/types.js";
import { STAFF } from "../data/seed.js";
import type { LlmProvider } from "../llm/index.js";
import type { SupplierEmailPayload } from "../store.js";
import { ESTIMATES, nzDate, nzDay, type Draft } from "./drafts.js";

/** One thing the email can say. Picking it puts `text` into the email as a paragraph. */
export interface EmailOption { id: string; label: string; text: string; /** What the option came from. */ from: "email" | "order" | "supplier"; /** Used for the subject of a new email. */ topic: string }
export interface ComposeInput { supplier: LnSupplier; order?: LnPurchaseOrder; message?: MailMessage; /** Every order placed with this supplier. */ orders: LnPurchaseOrder[]; items: LnItem[]; today: Date }

const OPEN = ["Created", "Sent", "Confirmed", "Partially received"];
const DATE = /\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December)(?: \d{4})?\b/g;
const first = (name: string) => name.split(" ")[0];
const domainOf = (address: string) => address.split("@")[1]?.trim().toLowerCase();
const dueOf = (po: LnPurchaseOrder) => po.confirmedReceiptDate || po.plannedReceiptDate || "";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** What a supplier's email is about, so the reply options answer it. */
export function emailTopic(m: Pick<MailMessage, "subject" | "body">): "delay" | "part" | "price" | "closure" | "confirmed" | "other" {
  const t = `${m.subject}\n${m.body}`.toLowerCase();
  if (/delay|revised delivery|new delivery date|running late/.test(t)) return "delay";
  if (/part shipment|part delivery|balance will follow/.test(t)) return "part";
  if (/prices? (will|are going to) (rise|increase|go up)|price (increase|list|rise)/.test(t)) return "price";
  if (/closure|will close|we close|closed (for|from)|reopen/.test(t)) return "closure";
  if (/we confirm|order (is )?confirmed|thank you for (the|your) order/.test(t)) return "confirmed";
  return "other";
}

/** Directly before a date, these make it the date the delivery is moving away from, whatever comes earlier: "delayed from 12 December". */
const FROM = /\b(?:from|instead of|rather than|not|replac(?:es|ing))\s+(?:the\s+)?$/i;
/** So do these a few words before it ("was due 12 December", "originally planned for 12 December"), unless those words say it moved ("was put back to"). */
const WAS = /\b(?:original|originally|previous|previously|earlier|old|was|were)(?: \w+){0,3}\s+(?:the\s+)?$/i;
const MOVING = /\b(?:delayed|moved|pushed|put back|postponed|slipped|changed|brought forward|rescheduled|revised|now)\b/i;
/**
 * What makes a date the new one, in the words since the date before it (or the start of the sentence): a phrase about delivery
 * timing ("new delivery date", "revised ETA", "now expected on"), or a moving word that runs straight into the date
 * ("pushed back to", "delayed until"). A moving word about something else ("we changed carriers on 1 December") does not count.
 */
const NEW_TIMING = /\b(?:(?:new|revised|updated)\s+(?:\w+\s+){0,2}?(?:date|delivery|eta|etd|arrival|dispatch|ship(?:ping|ment)?|schedule)\b|rescheduled\b|now\s+(?:\w+\s+){0,5}(?:the\s+)?$)/i;
const MOVED_TO = /\b(?:delayed|moved|pushed|put back|postponed|slipped|changed|brought forward)\b[^,;:]*\b(?:to|until|till)\s+(?:the\s+)?$/i;
const TO = /^\s*(?:to|until|till)\s+(?:the\s+)?$/i;

/**
 * The new delivery date a delay notice gives: the date it calls new, revised or moved to, never the one it is moving from.
 * Each date is read by the words since the date before it, so "the new date is 9 December and tracking follows by 12 December"
 * means 9 December, and "was delayed until 9 December" is where it moved to, not where it was.
 * A notice with one date and no such words means that date, unless `marked` asks for the words. Where the notice leaves it unclear
 * (several dates and no such words, or two different dates both called new), none is quoted rather than the wrong one.
 */
export function revisedDate(text: string, marked = false): string | undefined {
  const all = [...text.matchAll(DATE)], fresh: string[] = [];
  let after = 0, last = "";
  for (const d of all) {
    const sentence = text.slice(0, d.index).search(/[^.!?\n]*$/), lead = text.slice(Math.max(sentence, after), d.index);
    const was = WAS.exec(lead)?.[0];
    const kind = FROM.test(lead) || (was && !MOVING.test(was)) ? "old" : NEW_TIMING.test(lead) || MOVED_TO.test(lead) || (last === "old" && sentence <= after && TO.test(lead)) ? "new" : "";
    if (kind === "new") fresh.push(d[0]);
    after = d.index + d[0].length;
    last = kind;
  }
  // The same day given once with its year and once without is one date.
  if (new Set(fresh.map((d) => d.replace(/ \d{4}$/, ""))).size === 1) return fresh.find((d) => /\d{4}$/.test(d)) ?? fresh[0];
  return !marked && !fresh.length && all.length === 1 && last !== "old" ? all[0][0] : undefined;
}

/** Words before a bare number that make it another document's number: an invoice, a quote, a consignment. */
const OTHER_NUMBER = /\b(?:invoice|inv|credit note|quote|quotation|delivery note|packing (?:slip|list)|tracking|consignment|awb)\b[\s.:#-]*(?:no|number|num|nr)?[\s.:#-]*$/i;
/** Words before a number that make it an order number however it is spaced: "PO 41711", "purchase order no. 41711", "PO reference 41711". */
const ORDER_WORDS = String.raw`(?:p\.?\s?o\.?|purchase order|order)(?:\s*(?:no|number|num|nr|ref|reference))?[\s.:#-]*`;

/**
 * The supplier's order an email is about. An order the email calls an order ("PO41711", "PO 41711", "order no. 41711") is taken
 * before anything else in it; only where none is does a bare number ("41711") count, and not an invoice, quote or tracking number.
 */
export function orderIn(m: Pick<MailMessage, "subject" | "body">, orders: LnPurchaseOrder[]) {
  const text = `${m.subject} ${m.body}`, safe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const whole = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "giu");
  const first = (at: (po: LnPurchaseOrder) => number) => orders.map((po) => ({ po, i: at(po) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0]?.po;
  // A number shorter than four digits is too easily something else to be read without its prefix.
  const digits = (po: LnPurchaseOrder) => { const d = /\d+$/.exec(po.order)?.[0] ?? ""; return d.length >= 4 ? d : undefined; };
  const named = (po: LnPurchaseOrder) => {
    const d = digits(po), prefix = d && safe(po.order.slice(0, -d.length));
    return text.search(whole([safe(po.order), ...(d ? [`${ORDER_WORDS}${d}`, ...(prefix ? [`${prefix}[\\s.:#-]*${d}`] : [])] : [])].join("|")));
  };
  const bare = (po: LnPurchaseOrder) => { const d = digits(po); return (d ? [...text.matchAll(whole(d))].find((x) => !OTHER_NUMBER.test(text.slice(0, x.index)))?.index : undefined) ?? -1; };
  return first(named) ?? first(bare);
}

/** The things this email could say, from the supplier's email being answered, the order and the supplier's record. */
export function emailOptions({ supplier: s, order: po, message: m, orders, items, today }: ComposeInput): EmailOption[] {
  const t = nzDay(today).toISOString().slice(0, 10);
  const out: EmailOption[] = [];
  const add = (from: EmailOption["from"], id: string, label: string, topic: string, text: string) => out.push({ id, label, text, from, topic });
  const itemName = (code: string) => items.find((i) => i.item === code)?.description ?? code;
  const open = orders.filter((o) => OPEN.includes(o.status)).sort((a, b) => dueOf(a).localeCompare(dueOf(b)));
  const openList = open.slice(0, 6).map((o) => `  • ${o.order}${dueOf(o) ? ` — due ${nzDate(dueOf(o))}` : ""}`).join("\n");
  const ref = po?.order ?? "the order";
  const topic = m ? emailTopic(m) : undefined;
  // The first date in a price notice is when it takes effect.
  const dates = m ? m.body.match(DATE) ?? m.subject.match(DATE) ?? [] : [];

  if (m) {
    const theirs = `your email of ${nzDate(nzDay(new Date(m.receivedDateTime)).toISOString())}`;
    if (topic === "delay") {
      // The subject is read only when the body gives no date at all, and only for a date it calls new: a body with several
      // unmarked dates is unclear, and a lone date in a subject is as likely the original due date as the new one.
      const date = m.body.match(DATE) ? revisedDate(m.body) : revisedDate(m.subject, true);
      add("email", "accept-date", date ? `Accept the new date, ${date.replace(/ \d{4}$/, "")}` : "Accept the delay", "revised delivery date", `Thank you for letting us know about the delay to ${ref}. We have noted ${date ? `the new delivery date of ${date}` : "it"} and will plan around it.`);
      add("email", "earlier", "Ask them to bring it forward", "revised delivery date", `${date ? `Delivery on ${date}` : "The new date"} is later than we planned for. Is there any way to bring it forward, or to send part of ${ref} earlier?`);
      add("email", "firm-date", "Ask if the new date is firm", "revised delivery date", `Could you please confirm that ${date ?? "the new date"} is now firm, and tell us straight away if anything changes?`);
    } else if (topic === "part") {
      add("email", "thanks-part", "Thank them for the part shipment", "part shipment", `Thank you for sending the part of ${ref} that was ready.`);
      if (po?.status !== "Partially received") add("email", "balance", "Ask when the balance will ship", "balance of the order", `Could you please confirm when the balance of ${ref} will ship?`);
    } else if (topic === "price") {
      const rise = /(\d+(?:\.\d+)?)\s?%/.exec(m.body)?.[1];
      add("email", "note-price", "Say the new prices are noted", "price change", `Thank you for the notice of your price change${rise ? ` of ${rise}%` : ""}${dates[0] ? ` from ${dates[0]}` : ""}. We have noted it.`);
      add("email", "hold-price", open.length ? "Ask to keep current prices on our open orders" : "Ask which orders keep current prices", "price change", open.length
        ? `Could you please confirm that our open orders keep the current prices?\n\n${openList}`
        : `Could you please confirm that orders we place${dates[0] ? ` before ${dates[0]}` : " before the change"} keep the current prices?`);
      add("email", "price-list", "Ask for the new prices of what we buy", "price change", "Could you please send the new prices for the items we buy from you, so we can update our records before the change?");
    } else if (topic === "closure") {
      add("email", "note-closure", "Thank them for the notice", "closure dates", "Thank you for letting us know about your closure. We have noted the dates.");
      if (open.length) add("email", "closure-orders", "Ask if our open orders ship before they close", "closure dates", `Could you please confirm whether our open orders will ship before you close?\n\n${openList}`);
      add("email", "closure-cutoff", "Ask for the last order date", "closure dates", "What is the last day we can place an order and still have it ship before you close?");
    } else if (topic === "confirmed") {
      add("email", "thanks-confirm", "Thank them for confirming", "order confirmation", `Thank you for confirming ${ref}.`);
    } else {
      add("email", "thanks", "Thank them for their email", "your email", `Thank you for ${theirs}.`);
    }
  }

  if (po && OPEN.includes(po.status)) {
    const due = dueOf(po), late = !!due && due < t;
    const left = po.lines.filter((l) => l.received < l.quantity);
    const daysLate = late ? Math.round((new Date(t).getTime() - new Date(due).getTime()) / 86_400_000) : 0;
    if (po.status === "Partially received") {
      add("order", "balance", "Ask when the balance will ship", "balance of partial delivery", `We are still waiting on the balance of ${po.order}:\n\n${left.map((l) => `  • ${l.item} ${itemName(l.item)} — ${l.quantity - l.received} of ${l.quantity} outstanding`).join("\n")}\n\nCould you please confirm when it will ship?`);
    } else if (po.status === "Sent") {
      add("order", "confirm-order", "Ask them to confirm the order", "please confirm order", `Could you please confirm that you have received ${po.order}, placed on ${nzDate(po.orderDate)}, and give us your ship date?${due ? ` We need it at our Tauriko warehouse by ${nzDate(due)}.` : ""}`);
    }
    // A delay notice already gives the new date, so it is not asked for again.
    if (late && po.status !== "Partially received" && topic !== "delay") add("order", "ship-date", "Ask for a new ship date", "please confirm new ship date", `Our purchase order ${po.order} was due at our Tauriko warehouse on ${nzDate(due)} and is now ${plural(daysLate, "day")} late. Could you please confirm the new ship date and when it will arrive?`);
    if (!late && due && po.status !== "Partially received" && topic !== "delay") add("order", "on-track", `Ask if it is on track for ${nzDate(due).replace(/ \d{4}$/, "")}`, "delivery date", `Could you please confirm that ${po.order} is still on track to reach our Tauriko warehouse by ${nzDate(due)}?`);
    if ((late || topic === "delay") && po.status !== "Partially received" && (left.length > 1 || left.some((l) => l.quantity - l.received > 1))) add("order", "part-ship", "Ask them to send what is ready now", "part shipment", `If part of ${po.order} is ready, please send it now and let the balance follow.`);
    const low = left.map((l) => items.find((i) => i.item === l.item)).filter((i): i is LnItem => !!i && i.onHand < i.reorderPoint);
    if (low.length) add("order", "urgent", `Say we are running low on ${low.length === 1 ? low[0].description : `${low.length} items`}`, "urgent", `We are running low on ${list(low.slice(0, 3).map((i) => `${i.description} (${i.item})`))}${low.length > 3 ? " and other items on this order" : ""}, so ${po.order} is urgent for us.`);
    if (po.status !== "Created") add("order", "tracking", "Ask for tracking and shipping documents", "tracking and shipping documents", `When ${po.status === "Partially received" ? "the balance" : po.order} ships, could you please send the tracking details, commercial invoice and packing list?`);
  } else if (!po) {
    const low = items.filter((i) => i.primarySupplier === s.supplier && i.onHand < i.reorderPoint).slice(0, 6);
    if (open.length && topic !== "price" && topic !== "closure") add("supplier", "open-orders", `Ask for an update on our ${plural(open.length, "open order")}`, "update on open orders", `Could you please send us an update on our open ${open.length === 1 ? "order" : "orders"}, with the ship date for each?\n\n${openList}`);
    if (!m && low.length) add("supplier", "availability", `Ask about stock of ${low.length === 1 ? low[0].description : `${low.length} items we are low on`}`, "availability and lead time", `We are planning our next order and would like to check current availability and lead time for:\n\n${low.map((i) => `  • ${i.item} ${i.description}`).join("\n")}\n\nCould you let us know the earliest ship date you can offer?`);
    if (!m) add("supplier", "terms", "Check lead time and payment terms", "lead time and payment terms", `Our records show a lead time of ${s.avgLeadTimeDays} days and ${s.paymentTerms} payment terms. Could you please confirm these still apply?`);
  }
  return out;
}

export interface ComposeParts { to: { name: string; address: string }; greeting: string; sign: string; /** Subject when nothing is picked yet. */ subject: string; options: EmailOption[] }

/** The fixed parts of the email: who it goes to, how it opens and how it is signed. */
export function composeParts(input: ComposeInput, by: string): ComposeParts {
  const { supplier: s, order: po, message: m } = input;
  const role = STAFF.find((x) => x.name === by)?.role;
  return {
    // A reply goes where the supplier asked for replies only if that is another mailbox of theirs. A Reply-To somewhere else
    // is not followed: anyone can put one on an email, so the reply stays with the address Infor LN holds for the supplier.
    to: m?.replyTo?.find((r) => r.address && domainOf(r.address) === domainOf(s.email)) ?? { name: s.contactName, address: s.email },
    greeting: `Hi ${first(s.contactName)},`,
    sign: `Kind regards,\n${by}\n${role ? `${role}, ` : ""}Cubro Ltd\nTauriko, Tauranga, New Zealand`,
    subject: m ? (/^re:/i.test(m.subject) ? m.subject : `RE: ${m.subject}`) : po ? `Purchase order ${po.order}` : "Message from Cubro Purchasing",
    options: emailOptions(input),
  };
}

export const composeBody = (parts: Pick<ComposeParts, "greeting" | "sign">, paragraphs: string[]) => [parts.greeting, ...paragraphs, parts.sign].join("\n\n");
/** A reply keeps the subject of the email it answers; a new email is named after the first thing it says. */
export const composeSubject = (parts: ComposeParts, input: Pick<ComposeInput, "order" | "message">, chosen: EmailOption[]) => {
  if (input.message || !chosen.length) return parts.subject;
  const topic = chosen[0].topic;
  return input.order ? `${input.order.order} — ${topic}` : `${topic[0].toUpperCase()}${topic.slice(1)}`;
};

/** The draft that goes to Drafts to check. `picked` are option ids; `own` are the writer's own lines, already tidied. */
export function composeDraft(input: ComposeInput, by: string, picked: string[], own: string[]): Draft {
  const { supplier: s, order: po, message: m } = input;
  const parts = composeParts(input, by);
  // In the order the options are listed, which reads better than the order they were clicked in.
  const chosen = parts.options.filter((o) => picked.includes(o.id));
  const subject = composeSubject(parts, input, chosen);
  const about = po?.order ?? (m ? m.subject.replace(/^re:\s*/i, "") : chosen[0]?.topic ?? "their own message");
  const payload: SupplierEmailPayload = {
    type: "supplier_email", supplierId: s.supplier, supplierName: s.name, to: parts.to, subject, body: composeBody(parts, [...chosen.map((o) => o.text), ...own]),
    reason: m ? "reply" : "new", purchaseOrder: po?.order, items: po?.lines.map((l) => l.item) ?? [],
    ...(m && { inReplyTo: { id: m.id, subject: m.subject, from: m.from.name, receivedDateTime: m.receivedDateTime, body: m.body } }),
  };
  const said = [chosen.length ? `picked: ${chosen.map((o) => o.label).join("; ")}` : "", own.length ? `added ${own.length === 1 ? "a line" : `${own.length} lines`} of their own, which the assistant tidied` : ""].filter(Boolean).join(", and ");
  return {
    agent: "supplier-outreach", kind: "supplier_email", title: `${m ? "Reply to" : "Email to"} ${s.name} — ${about}`, priority: "normal", writtenBy: by, estimate: ESTIMATES.supplier_email,
    rationale: `${by} wrote this ${m ? `reply to ${m.from.name}'s email of ${nzDate(nzDay(new Date(m.receivedDateTime)).toISOString())}, "${m.subject}"` : `email to ${s.contactName} at ${s.name}`}${po ? `, about ${po.order}` : ""}. They ${said}.`,
    sources: [...(m ? [{ system: "Microsoft 365", label: `Email "${m.subject}"`, ref: `mail:${m.id}` }] : []), ...(po ? [{ system: "Infor LN", label: `Purchase order ${po.order}`, ref: po.order }] : []), { system: "Infor LN", label: `Supplier ${s.supplier}`, ref: s.supplier }],
    payload,
  };
}

export const MAX_OWN_LINE = 600;
/** Capital letter and full stop: what a line gets when no model is there to tidy it. */
const plainTidy = (note: string) => { const t = note.trim().replace(/\s+/g, " "); return `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`; };

/** Turns a person's own line into a paragraph that fits the email. If the model cannot be reached, the line is kept as they typed it. */
export async function tidyOwnLine(llm: LlmProvider, note: string, emailSoFar: string): Promise<{ text: string; problem?: string }> {
  try {
    const text = (await llm.polish({
      task: "Rewrite the note below as one short paragraph for the body of an email to a supplier. Write it in English whatever language the note is in. Say only what the note says. Return only that paragraph: no greeting and no sign-off.",
      draft: note.trim(), context: `A Cubro purchasing officer wants to add this to the email below, in their own words.\n\n${emailSoFar}`, tone: "Polite, direct, professional",
    })).trim();
    // The built-in templates hand the note straight back.
    return { text: text === note.trim() ? plainTidy(note) : text };
  } catch (e) {
    return { text: plainTidy(note), problem: `The assistant could not tidy the wording (${e instanceof Error ? e.message : String(e)}), so your line is added as you typed it.` };
  }
}
