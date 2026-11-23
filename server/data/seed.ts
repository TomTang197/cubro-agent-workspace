import type {
  BrandAsset, CalendarEvent, ClickUpTask, CustomerMarket, ItemGroup, LnItem, LnPurchaseOrder, LnSupplier, MailMessage,
  SfAccount, SfActivity, SfCampaign, SfCase, SfContact, SfOpportunity, TeamsPost,
} from "../connectors/types.js";
import {
  ACCOUNT_PATTERNS, BUYERS, CATALOGUE, COMPANY, CONTACT_TITLES, CURRENCY_BY_COUNTRY, FIRST_NAMES, FX_PER_NZD, LAST_NAMES,
  LEAD_BY_COUNTRY, NAME_STEMS, PUBLIC_HOSPITALS, REGIONS, STAFF, SUPPLIERS, staffEmail,
} from "./catalogue.js";
import { addDays, createRng, DAY, isoDate, type Rng } from "./rng.js";

export { STAFF };

export interface SystemData {
  m365: { events: CalendarEvent[]; messages: MailMessage[]; assets: BrandAsset[]; teamsPosts: TeamsPost[] };
  salesforce: { accounts: SfAccount[]; contacts: SfContact[]; opportunities: SfOpportunity[]; campaigns: SfCampaign[]; cases: SfCase[]; activities: SfActivity[] };
  clickup: { tasks: ClickUpTask[] };
  inforln: { items: LnItem[]; suppliers: LnSupplier[]; purchaseOrders: LnPurchaseOrder[] };
}

// ---------- dates ----------
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const toWeekday = (d: Date, step = 1) => { while (isWeekend(d)) d = addDays(d, step); return d; };
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY);
const day = (iso: string) => new Date(iso + "T00:00:00Z");

/** Hours New Zealand is ahead of UTC on a date: 13 during daylight saving (last Sunday of September to first Sunday of April), else 12. */
export function nzOffsetHours(d: Date) {
  const y = d.getUTCFullYear();
  const firstSundayOfApril = 1 + ((7 - new Date(Date.UTC(y, 3, 1)).getUTCDay()) % 7);
  const endOfSeptember = new Date(Date.UTC(y, 9, 0));
  const lastSundayOfSeptember = endOfSeptember.getUTCDate() - endOfSeptember.getUTCDay();
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return md < 400 + firstSundayOfApril || md >= 900 + lastSundayOfSeptember ? 13 : 12;
}
/** ISO timestamp of a New Zealand wall-clock time on a calendar day. */
export function nzTime(d: Date, hour: number, minute = 0) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - nzOffsetHours(d), minute)).toISOString();
}
const longDate = (d: Date | string) => (typeof d === "string" ? day(d) : d).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// ---------- ids ----------
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** An 18-character Salesforce record Id: key prefix, instance, record number and the case-safe checksum. */
export function sfId(prefix: string, n: number) {
  let x = 1_200_000 + n * 7, tail = "";
  for (let i = 0; i < 5; i++) { tail = B62[x % 62] + tail; x = Math.floor(x / 62); }
  const id15 = `${prefix}Ws00000${tail}`;
  let checksum = "";
  for (let c = 0; c < 3; c++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) { const ch = id15[c * 5 + i]; if (ch >= "A" && ch <= "Z") bits |= 1 << i; }
    checksum += "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"[bits];
  }
  return id15 + checksum;
}
const pad = (n: number, len = 4) => n.toString().padStart(len, "0");
const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const first = (name: string) => name.split(" ")[0];
const money = (n: number) => Math.round(n * 100) / 100;

// ---------- Infor LN ----------
interface PoMeta { po: LnPurchaseOrder; supplier: LnSupplier; receipt: Date; confirmOn: Date; late: boolean; revised: boolean }

function makeItems(rng: Rng, today: Date, suppliers: LnSupplier[], leadByKey: Map<string, number>): LnItem[] {
  return CATALOGUE.map(([item, description, itemGroup, listPrice, demand, supplierKey, isNew]) => {
    const lead = leadByKey.get(supplierKey)!;
    const safetyStock = Math.max(1, Math.ceil(demand * 0.5));
    const reorderPoint = Math.ceil(demand * Math.max(1, lead / 30)) + safetyStock;
    const low = rng.chance(isNew ? 0.05 : 0.07);
    const standardCost = money(listPrice * rng.int(42, 58) / 100);
    return {
      item, description, itemGroup, unitPrice: listPrice, standardCost,
      onHand: low ? rng.int(0, Math.max(1, Math.floor(reorderPoint * 0.55))) : rng.int(Math.ceil(reorderPoint * 1.15), Math.ceil(reorderPoint * 2.4) + 1),
      reorderPoint, safetyStock, avgMonthlyDemand: demand,
      primarySupplier: suppliers[SUPPLIERS.findIndex((s) => s.key === supplierKey)].supplier,
      isNew: !!isNew, launchDate: isNew ? isoDate(toWeekday(addDays(today, rng.int(-25, 35)))) : undefined,
    };
  });
}

const packSize = (cost: number) => (cost < 30 ? 20 : cost < 120 ? 10 : cost < 600 ? 2 : 1);

function makePurchaseOrders(rng: Rng, today: Date, items: LnItem[], suppliers: LnSupplier[], leadByKey: Map<string, number>): PoMeta[] {
  const out: PoMeta[] = [];
  suppliers.forEach((supplier, si) => {
    const seed = SUPPLIERS[si];
    const own = items.filter((it) => it.primarySupplier === supplier.supplier);
    const lead = leadByKey.get(seed.key)!;
    const currency = CURRENCY_BY_COUNTRY[seed.country as keyof typeof CURRENCY_BY_COUNTRY];
    const interval = rng.int(22, 38);
    const buyer = BUYERS[si % BUYERS.length];
    for (let ago = 365 - rng.int(0, interval); ago >= 0; ago -= interval + rng.int(-5, 5)) {
      const orderDate = toWeekday(addDays(today, -ago), -1);
      const planned = toWeekday(addDays(orderDate, Math.max(3, lead + rng.int(-4, 6))));
      // Deliveries due in the last few weeks run later than usual (pre-Christmas port congestion), which is what the purchasing team is chasing.
      const dueRecently = planned <= today && daysBetween(planned, today) <= 30;
      const late = rng.next() > seed.reliability - (dueRecently ? 0.3 : 0);
      const receipt = toWeekday(addDays(planned, late ? (dueRecently ? rng.int(12, 45) : rng.int(4, 24)) : rng.int(-3, 1)));
      const confirmOn = toWeekday(addDays(orderDate, rng.int(1, 4)));
      const age = daysBetween(orderDate, today);
      const neverConfirmed = age <= 25 && rng.chance(0.25);
      let status: LnPurchaseOrder["status"];
      let confirmed: string | null = null;
      let revised = false;
      if (receipt <= today) {
        status = daysBetween(receipt, today) > 14 ? "Closed" : "Received";
        confirmed = isoDate(receipt);
      } else if (age < 2) status = "Created";
      else if (confirmOn > today || neverConfirmed) status = "Sent";
      else {
        status = "Confirmed";
        confirmed = isoDate(planned);
        if (late && planned <= today) {
          // Either the supplier has already advised a new date, or the order has gone quiet and needs chasing.
          if (rng.chance(0.3)) status = "Partially received";
          else if (rng.chance(0.45)) { revised = true; confirmed = isoDate(receipt); }
        }
      }
      const lines = rng.sample(own, Math.min(own.length, rng.int(2, 6))).map((it, idx) => {
        const pack = packSize(it.standardCost!);
        const quantity = Math.max(pack, Math.round((it.avgMonthlyDemand * (interval / 30) * rng.int(8, 16) / 10) / pack) * pack);
        const received = status === "Received" || status === "Closed" ? quantity : status === "Partially received" ? Math.max(pack, Math.floor((quantity * rng.int(30, 70) / 100) / pack) * pack) : 0;
        return { line: (idx + 1) * 10, item: it.item, quantity, received: Math.min(received, status === "Partially received" ? Math.max(0, quantity - pack) : quantity), price: money(it.standardCost! * FX_PER_NZD[currency]) };
      });
      out.push({
        po: { order: "", supplier: supplier.supplier, orderDate: isoDate(orderDate), plannedReceiptDate: isoDate(planned), confirmedReceiptDate: confirmed, status, buyer, currency, lines },
        supplier, receipt, confirmOn, late, revised,
      });
    }
  });
  out.sort((a, b) => a.po.orderDate.localeCompare(b.po.orderDate));
  let num = 41200;
  for (const m of out) { num += rng.int(1, 3); m.po.order = `PO${num}`; }
  // Supplier performance comes from the delivery history, so the supplier list and the orders agree.
  for (const s of suppliers) {
    const done = out.filter((m) => m.supplier === s && (m.po.status === "Closed" || m.po.status === "Received"));
    if (!done.length) continue;
    s.onTimeRate = Math.round((done.filter((m) => daysBetween(day(m.po.plannedReceiptDate), m.receipt) <= 2).length / done.length) * 100) / 100;
    s.avgLeadTimeDays = Math.round(done.reduce((n, m) => n + daysBetween(day(m.po.orderDate), m.receipt), 0) / done.length);
  }
  return out.reverse();
}

// ---------- Salesforce ----------
const ACCOUNT_MIX: [Exclude<SfAccount["Type"], "Public Hospital">, number][] = [["Private Hospital", 12], ["Aged Care", 52], ["Hospice", 8], ["Community Care", 16], ["Retail Partner", 16]];
const MARKET: Record<SfAccount["Type"], CustomerMarket> = { "Public Hospital": "Hospital Care", "Private Hospital": "Hospital Care", Hospice: "Hospital Care", "Aged Care": "Aged Care", "Community Care": "Community Care", "Retail Partner": "Wholesale" };
const REGION_WEIGHT: Record<string, number> = { Auckland: 8, Canterbury: 4, Wellington: 4, Waikato: 4, "Bay of Plenty": 4, Otago: 2, "Whanganui/Manawatū": 2, "Gisborne/Hawke's Bay": 2, Northland: 2, "Nelson/Tasman": 2, Taranaki: 1, Southland: 1, "West Coast": 1 };
const AREA_CODE: Record<string, string> = { Northland: "9", Auckland: "9", Waikato: "7", "Bay of Plenty": "7", "Gisborne/Hawke's Bay": "6", Taranaki: "6", "Whanganui/Manawatū": "6", Wellington: "4" };
const BASE_SPEND: Record<SfAccount["Type"], [number, number]> = { "Public Hospital": [120, 600], "Private Hospital": [30, 150], "Aged Care": [15, 120], Hospice: [8, 40], "Community Care": [15, 90], "Retail Partner": [40, 300] };
const OPPS_PER_ACCOUNT: Record<SfAccount["Type"], [number, number]> = { "Public Hospital": [2, 4], "Private Hospital": [1, 3], "Aged Care": [1, 2], Hospice: [0, 2], "Community Care": [1, 2], "Retail Partner": [1, 3] };
const BUYS: Record<SfAccount["Type"], ItemGroup[]> = {
  "Public Hospital": ["Beds", "Pressure care", "Moving and transferring", "Trolleys, carts and laundry", "Infection control", "Medical and respiratory", "Theatre equipment", "Falls prevention and recovery", "Bedroom furniture"],
  "Private Hospital": ["Theatre equipment", "Trolleys, carts and laundry", "Beds", "Medical and respiratory", "Bedroom furniture", "Infection control"],
  "Aged Care": ["Beds", "Bedroom furniture", "Pressure care", "Falls prevention and recovery", "Seating", "Moving and transferring", "Hygiene"],
  Hospice: ["Beds", "Pressure care", "Seating", "Bedroom furniture", "Medical and respiratory"],
  "Community Care": ["Wheelchairs", "Powered wheelchairs", "Hygiene", "Walking and mobility aids", "Moving and transferring", "Pressure care", "Seating"],
  "Retail Partner": ["Mobility scooters", "Walking and mobility aids", "Wheelchairs", "Hygiene", "Pressure care"],
};
const PROJECT: Record<ItemGroup, string[]> = {
  Beds: ["bed replacement programme", "new wing bed fit-out", "low bed trial"],
  "Bedroom furniture": ["bedroom refurbishment", "bedside furniture replacement"],
  "Pressure care": ["alternating air mattress upgrade", "pressure care mattress replacement"],
  "Moving and transferring": ["lifter and sling standardisation", "moving and handling equipment renewal"],
  "Falls prevention and recovery": ["falls sensor rollout", "falls prevention equipment order"],
  Seating: ["lounge and day room seating", "care chair order"],
  Wheelchairs: ["wheelchair fleet renewal", "wheelchair stock order"],
  "Powered wheelchairs": ["power wheelchair assessment order"],
  "Mobility scooters": ["scooter showroom stock order", "seasonal scooter range order"],
  "Trolleys, carts and laundry": ["ward trolley replacement", "emergency cart standardisation"],
  "Infection control": ["sluice room refit"],
  "Medical and respiratory": ["oxygen concentrator fleet", "respiratory equipment order"],
  Hygiene: ["shower commode replacement", "bathroom equipment order"],
  "Walking and mobility aids": ["walking aid stock order"],
  "Theatre equipment": ["operating table replacement", "procedure room fit-out"],
  "Spare parts": ["spare parts order"],
};
const SERVICE_TEXT: Partial<Record<ItemGroup, string[]>> = {
  Beds: ["Hand controller on the {p} responds intermittently and the bed has stopped at mid height.", "Side rail latch is loose on one {p}. Requesting a technician visit.", "Annual AS/NZS 3551 test and service is due for {n} x {p}."],
  "Pressure care": ["Pump on the {p} is alarming low pressure. Loan mattress requested while it is assessed.", "Cover on the {p} has a split seam near the foot end and needs a new cover."],
  "Moving and transferring": ["Six-monthly AS/NZS 10535 load test is due for the {p}.", "Battery on the {p} is not lasting a full shift."],
  Seating: ["Gas strut on the {p} sinks slowly under load.", "Armrest upholstery is torn on the {p}. Quote for re-upholstery requested."],
  "Mobility scooters": ["Customer reports the {p} is losing range; batteries are three years old.", "Rear tyre puncture on a {p}. New tyre and tube needed."],
  Wheelchairs: ["Left brake lever on the {p} is not locking."],
  Hygiene: ["Castors on the {p} are stiff after wet-room use. New castor set requested."],
  "Medical and respiratory": ["{p} is showing a low oxygen purity alarm and needs testing."],
};
const SERVICE_DEFAULT = ["Preventative maintenance visit requested for the {p}.", "The {p} needs a repair assessment after damage in use."];
/** Keeps a fault description away from products it cannot apply to. */
const fits = (text: string, product: string) => (!/castors/i.test(text) || /mobile|trolley/i.test(product)) && (!/gas strut|armrest/i.test(text) || /chair/i.test(product));
const PRAISE_TEXT: Partial<Record<ItemGroup, string[]>> = {
  Beds: ["Night staff tell us the {p} goes low enough that two residents no longer need floor mattresses.", "The {p} is quiet and our residents can work the hand controller themselves."],
  "Pressure care": ["Since moving to the {p} we have had no new pressure injuries on the wing in three months."],
  "Moving and transferring": ["Our carers find the {p} easy to manoeuvre in small ensuites."],
  "Falls prevention and recovery": ["The {p} alerts staff before the resident is on their feet, and false alarms are rare."],
  Seating: ["Families have commented on how comfortable residents look in the {p}."],
  "Mobility scooters": ["Customers like how easy the {p} is to drive on their first try in the shop."],
};
const PRAISE_DEFAULT = ["The {p} arrived on time and the technician took the time to train our team.", "The {p} has held up well to daily use and cleaning."];
const ENQUIRY_TEXT = ["Could we arrange a trial of the {p} for our new wing?", "Requesting a quote and lead time for {n} x {p}.", "Please send the specification sheet and weight capacity for the {p}.", "Can someone show the {p} to our team at their next in-service session?"];
const COMPLAINT_TEXT = ["The {p} arrived with a damaged carton and a scratched panel.", "Delivery of the {p} was a week later than the date we were given.", "The back-order on the {p} has not been updated for three weeks.", "The invoice for the {p} did not match the quoted price."];

function seasonalCampaign(today: Date) {
  const m = today.getUTCMonth() + 1;
  if (m >= 11 || m === 1) return { Name: "Christmas and New Year service hours", KeyMessage: "Our service team and spare parts counter stay on call over the holidays. Free phone 0800 373 930." };
  if (m <= 4) return { Name: "April Falls month", KeyMessage: "Low beds, bed and chair sensors and landing mats work together to reduce harm from falls." };
  if (m <= 8) return { Name: "Winter respiratory season", KeyMessage: "Oxygen concentrators and nebulisers in stock at Tauriko for winter demand." };
  return { Name: "Spring equipment check", KeyMessage: "Book annual testing and preventative maintenance before the summer break. Free phone 0800 373 930." };
}

export function generateSystemData(seed = 20261123, today = new Date()): SystemData {
  const rng = createRng(seed);
  today = day(isoDate(today));

  // ---- Infor LN ----
  const leadByKey = new Map(SUPPLIERS.map((s) => [s.key, rng.int(...LEAD_BY_COUNTRY[s.country])]));
  const suppliers: LnSupplier[] = SUPPLIERS.map((s, i) => ({
    supplier: `SUP${1001 + i * 7}`, name: s.name, country: s.country, city: s.city, contactName: s.contactName, email: s.email, phone: s.phone,
    paymentTerms: s.paymentTerms, incoterms: s.incoterms, currency: CURRENCY_BY_COUNTRY[s.country as keyof typeof CURRENCY_BY_COUNTRY],
    avgLeadTimeDays: leadByKey.get(s.key)!, onTimeRate: s.reliability, categories: [],
  }));
  const items = makeItems(rng, today, suppliers, leadByKey);
  for (const s of suppliers) s.categories = [...new Set(items.filter((it) => it.primarySupplier === s.supplier).map((it) => it.itemGroup))];
  const poMeta = makePurchaseOrders(rng, today, items, suppliers, leadByKey);
  const purchaseOrders = poMeta.map((m) => m.po);
  const itemBy = new Map(items.map((it) => [it.item, it]));
  const sellable = items.filter((it) => it.itemGroup !== "Spare parts");
  const itemsIn = (groups: ItemGroup[]) => sellable.filter((it) => groups.includes(it.itemGroup));

  // ---- Salesforce ----
  const territoryOwner = (territory: string) => STAFF.find((s) => s.territory === territory)!.name;
  const wholesaleOwner = territoryOwner("Wholesale");
  const weightedRegions = REGIONS.flatMap((r) => Array(REGION_WEIGHT[r.region] ?? 1).fill(r) as typeof REGIONS[number][]);
  const accounts: SfAccount[] = [];
  const phone = (region: string) => `+64 ${AREA_CODE[region] ?? "3"} ${rng.int(300, 989)} ${pad(rng.int(0, 9999))}`;
  const addAccount = (Name: string, Type: SfAccount["Type"], BillingCity: string, Region: string) => {
    const territory = REGIONS.find((r) => r.region === Region)!.territory;
    accounts.push({
      Id: sfId("001", accounts.length), Name, Type, BillingCity, Region, AnnualSpend__c: 0,
      OwnerName: Type === "Retail Partner" ? wholesaleOwner : territoryOwner(territory), Market__c: MARKET[Type], Phone: phone(Region),
    });
  };
  for (const [name, city, region] of PUBLIC_HOSPITALS) addAccount(`Health NZ — ${name}`, "Public Hospital", city, region);
  const usedNames = new Set<string>();
  for (const [type, count] of ACCOUNT_MIX) {
    for (let made = 0; made < count;) {
      const r = rng.pick(weightedRegions);
      const city = rng.pick(r.cities);
      const name = rng.pick(ACCOUNT_PATTERNS[type]).replace("{s}", rng.pick(NAME_STEMS)).replace("{c}", city);
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      addAccount(name, type, city, r.region);
      made++;
    }
  }

  const contacts: SfContact[] = [];
  for (const a of accounts) {
    const domain = `${slug(a.Name.replace("Health NZ — ", "")).slice(0, 28).replace(/-$/, "")}.example.co.nz`;
    const titles = rng.sample(CONTACT_TITLES[a.Type], a.Type === "Public Hospital" ? rng.int(3, 4) : rng.int(1, 3));
    const taken = new Set<string>();
    for (const Title of titles) {
      let Name = "";
      do Name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`; while (taken.has(Name));
      taken.add(Name);
      contacts.push({
        Id: sfId("003", contacts.length), AccountId: a.Id, Name, Title,
        Email: `${slug(Name).replace("-", ".")}@${domain}`,
        Phone: rng.chance(0.5) ? a.Phone! : `+64 ${rng.pick(["21", "22", "27"])} ${rng.int(200, 989)} ${pad(rng.int(0, 9999))}`,
      });
    }
  }
  const contactsOf = (id: string) => contacts.filter((c) => c.AccountId === id);

  const opportunities: SfOpportunity[] = [];
  const stageRoll: [SfOpportunity["StageName"], number][] = [["Closed Won", 0.44], ["Closed Lost", 0.11], ["Prospecting", 0.09], ["Qualification", 0.1], ["Proposal", 0.14], ["Negotiation", 0.12]];
  const openWindow: Record<string, [number, number]> = { Prospecting: [45, 180], Qualification: [30, 150], Proposal: [14, 90], Negotiation: [5, 45] };
  for (const a of accounts) {
    const short = a.Name.replace("Health NZ — ", "");
    for (let k = rng.int(...OPPS_PER_ACCOUNT[a.Type]); k > 0; k--) {
      const group = rng.pick(BUYS[a.Type]);
      const pool = itemsIn([group]);
      const prods = rng.sample(pool, Math.min(pool.length, rng.int(1, 3)));
      let roll = rng.next();
      const StageName = stageRoll.find(([, p]) => (roll -= p) < 0)?.[0] ?? "Proposal";
      const closed = StageName.startsWith("Closed");
      const close = toWeekday(addDays(today, closed ? -rng.int(3, 360) : rng.int(...openWindow[StageName])));
      const scale = a.Type === "Public Hospital" ? 2 : a.Type === "Retail Partner" ? 1.5 : 1;
      const Amount = prods.reduce((sum, p) => sum + p.unitPrice * Math.max(1, Math.round((p.unitPrice > 20000 ? 1 : p.unitPrice > 5000 ? rng.int(1, 4) : p.unitPrice > 1000 ? rng.int(2, 14) : rng.int(6, 40)) * scale)), 0);
      opportunities.push({
        Id: sfId("006", opportunities.length), Name: `${short} — ${rng.pick(PROJECT[group])}`, AccountId: a.Id, StageName, Amount,
        CloseDate: isoDate(close), ProductSkus: prods.map((p) => p.item), OwnerName: a.OwnerName,
        CreatedDate: isoDate(toWeekday(closed ? addDays(close, -rng.int(25, 120)) : addDays(today, -rng.int(5, 90)), -1)),
      });
    }
  }
  const yearAgo = isoDate(addDays(today, -365));
  for (const a of accounts) {
    const won = opportunities.filter((o) => o.AccountId === a.Id && o.StageName === "Closed Won" && o.CloseDate >= yearAgo).reduce((n, o) => n + o.Amount, 0);
    a.AnnualSpend__c = Math.round((won + rng.int(...BASE_SPEND[a.Type]) * 1000) / 100) * 100;
  }
  const accountBy = new Map(accounts.map((a) => [a.Id, a]));
  const boughtBy = (id: string) => opportunities.filter((o) => o.AccountId === id && o.StageName === "Closed Won").flatMap((o) => o.ProductSkus);

  const skus = (...codes: string[]) => codes.filter((c) => itemBy.has(c));
  const season = seasonalCampaign(today);
  const campaignSeeds: { Name: string; Type: SfCampaign["Type"]; start: number; end: number; skus: string[]; Audience: string; KeyMessage: string }[] = [
    { Name: "Caro bed with Mediflex mattress launch", Type: "Product Launch", start: -10, end: 35, skus: skus("98101", "98100", "2010"), Audience: "Aged care facility and clinical managers", KeyMessage: "The Caro bed now comes with a Mediflex pressure redistribution mattress and Softech cover as one order." },
    { Name: "Maven XR mobility scooter launch", Type: "Product Launch", start: 5, end: 50, skus: skus("9605-1", "9603-1"), Audience: "Retail partners and mobility stores", KeyMessage: "The Maven XR joins the Maven range for customers who want more range and comfort on longer trips." },
    { Name: "Orvio carbon fibre wheelchair introduction", Type: "Product Launch", start: -20, end: 20, skus: skus("91001", "91000"), Audience: "Community occupational therapists and wheelchair assessors", KeyMessage: "The Orvio carbon fibre wheelchair gives active users a lighter frame to lift and push." },
    { Name: "Pressure injury prevention webinar series", Type: "Webinar", start: 2, end: 30, skus: skus("2271", "2274", "2160", "2010"), Audience: "Wound care nurses and clinical educators", KeyMessage: "Matching the support surface to the person's risk: foam, alternating air and when to step up." },
    { Name: "Safe moving and handling roadshow", Type: "Trade Show", start: 10, end: 28, skus: skus("11007", "66553", "1951", "198"), Audience: "Moving and handling coordinators, physiotherapists and health and safety representatives", KeyMessage: "Try the LUNA X5 portable lifter, Molift Raiser Pro and TurnAid with our clinical educator at a Cubro branch near you." },
    { Name: "Falls prevention in aged care", Type: "Awareness", start: -14, end: 28, skus: skus("1625", "20131", "21130", "1142"), Audience: "Aged care clinical managers and registered nurses", KeyMessage: "An extra low bed, a bed or chair sensor and a landing mat each lower the risk of harm from a fall." },
    { Name: season.Name, Type: "Seasonal", start: 12, end: 48, skus: [], Audience: "All customers", KeyMessage: season.KeyMessage },
    { Name: "Asset Pulse and preventative maintenance", Type: "Awareness", start: -5, end: 55, skus: [], Audience: "Facility, property and clinical equipment managers", KeyMessage: "Asset Pulse gives you visibility of your equipment, and our technicians test to AS/NZS 3551 and AS/NZS 3760 on site." },
    { Name: "Dementia-friendly bedroom furniture", Type: "Awareness", start: -28, end: 10, skus: skus("22000", "20142", "25000"), Audience: "Aged care village and facility managers", KeyMessage: "Leo and Willow bedroom furniture helps residents find and recognise their own belongings." },
    { Name: "Theatre and procedure room fit-out", Type: "Awareness", start: 20, end: 60, skus: skus("3603", "MX34ANE-CT", "3662"), Audience: "Theatre managers and hospital procurement", KeyMessage: "Operating tables, anaesthetic carts and instrument trolleys specified, delivered and installed by one team." },
    { Name: "Community showering and toileting", Type: "Awareness", start: 30, end: 65, skus: skus("8120", "8110", "8210"), Audience: "Community occupational therapists", KeyMessage: "Shower commodes and bath transfer benches for safer showering at home." },
    { Name: "Aged care conference stand follow-up", Type: "Trade Show", start: -50, end: -36, skus: skus("66940", "3157"), Audience: "Aged care operators who visited the Cubro stand", KeyMessage: "Thank you for visiting our stand. Here is more on the EasiTilt care chair and Configura rise and recline chair." },
    { Name: "Home oxygen and respiratory range", Type: "Awareness", start: -40, end: -8, skus: skus("815", "814", "805"), Audience: "Community nurses and retail partners", KeyMessage: "DeVilbiss oxygen concentrators and nebulisers, with servicing from Cubro technicians." },
    { Name: "Bariatric care equipment guide", Type: "Awareness", start: -75, end: -40, skus: skus("3401", "1603", "2165", "3170"), Audience: "Hospital moving and handling coordinators", KeyMessage: "Beds, mattresses and seating rated for bariatric care, with delivery and installation support." },
  ];
  const campaigns: SfCampaign[] = campaignSeeds.map((c, i) => ({
    Id: sfId("701", i), Name: c.Name, Type: c.Type, Status: c.end < 0 ? "Completed" : c.start <= 0 ? "In Progress" : "Planned",
    StartDate: isoDate(addDays(today, c.start)), EndDate: isoDate(addDays(today, c.end)), ProductSkus: c.skus, Audience: c.Audience, KeyMessage: c.KeyMessage,
  }));
  const campaignDay = (name: string, offset: number) => toWeekday(addDays(day(campaigns.find((c) => c.Name === name)!.StartDate), offset));

  const cases: SfCase[] = [];
  const caseTypes: SfCase["Type"][] = ["Service", "Service", "Service", "Service", "Feedback", "Feedback", "Feedback", "Enquiry", "Enquiry", "Complaint"];
  for (let i = 0; i < 150; i++) {
    const a = rng.pick(accounts);
    const owned = boughtBy(a.Id);
    const product = itemBy.get(owned.length ? rng.pick(owned) : rng.pick(itemsIn(BUYS[a.Type])).item)!;
    const picked = rng.pick(caseTypes);
    const Type = picked === "Service" && product.unitPrice < 400 ? "Enquiry" : picked;
    const texts = Type === "Service" ? [...(SERVICE_TEXT[product.itemGroup] ?? []).filter((t) => fits(t, product.description)), ...SERVICE_DEFAULT] : Type === "Feedback" ? PRAISE_TEXT[product.itemGroup] ?? PRAISE_DEFAULT : Type === "Enquiry" ? ENQUIRY_TEXT : COMPLAINT_TEXT;
    const Description = rng.pick(texts).replace("{p}", product.description).replace("{n}", String(rng.int(2, 12)));
    const age = rng.int(0, 120);
    const who = contactsOf(a.Id);
    cases.push({
      Id: sfId("500", i), AccountId: a.Id, ProductSku: product.item, Type, Description,
      Subject: `${Type === "Service" ? "Service request" : Type === "Feedback" ? "Customer feedback" : Type === "Enquiry" ? "Product enquiry" : "Complaint"} — ${product.description}`,
      CreatedDate: isoDate(toWeekday(addDays(today, -age), -1)),
      Status: Type === "Feedback" || age > 21 ? "Closed" : age <= 2 ? "New" : rng.chance(0.3) ? "Closed" : "In Progress",
      ContactName: who.length ? rng.pick(who).Name : undefined,
      OwnerName: Type === "Service" ? "Wiremu Paki" : Type === "Enquiry" ? a.OwnerName : "Mere Tapsell",
    });
  }
  cases.sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));

  const mainProduct = (o: SfOpportunity) => o.ProductSkus.map((s) => itemBy.get(s)!).sort((a, b) => b.unitPrice - a.unitPrice)[0];
  const openOpps = opportunities.filter((o) => o.StageName === "Proposal" || o.StageName === "Negotiation");
  const activities: SfActivity[] = rng.sample(openOpps, Math.min(openOpps.length, 48)).map((o, i) => {
    const a = accountBy.get(o.AccountId)!;
    const who = contactsOf(a.Id)[0]?.Name ?? "the customer";
    const [Subject, Description] = rng.pick([
      ["Call: quote follow-up", `Spoke with ${who}. They are comparing our quote with one other supplier and expect a decision by ${longDate(o.CloseDate)}.`],
      ["Site visit", `Walked the site with ${who} and measured doorways and lift access for delivery.`],
      ["Email: revised quote sent", `Sent ${who} a revised quote with delivery and installation included.`],
      ["Product trial arranged", `Trial unit of ${mainProduct(o).description} booked with ${who} for two weeks.`],
    ] as const);
    return { Id: sfId("00T", i), WhatId: o.Id, Subject, Description, CreatedDate: nzTime(toWeekday(addDays(today, -rng.int(1, 30)), -1), rng.int(9, 16), rng.pick([0, 15, 30, 45])), OwnerName: o.OwnerName };
  }).sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));

  // ---- Microsoft 365: calendar ----
  const events: CalendarEvent[] = [];
  const addEvent = (subject: string, category: CalendarEvent["category"], location: string, d: Date, hour: number, minutes: number, organizer: string, minute = 0) => {
    const start = nzTime(d, hour, minute);
    events.push({ id: "", subject, category, location, start, end: new Date(new Date(start).getTime() + minutes * 60_000).toISOString(), organizer });
  };
  const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
  for (let w = -5; w <= 12; w++) {
    const wk = addDays(monday, w * 7);
    addEvent("Marketing weekly stand-up", "Internal", "Tauriko head office", wk, 9, 30, "Liam Chen");
    addEvent("Purchasing and inventory review", "Internal", "Tauriko head office", addDays(wk, 1), 10, 60, "Mark Jensen");
    if ((w + 5) % 2 === 0) addEvent("Service scheduling — technician run sheets", "Internal", "Microsoft Teams", addDays(wk, 2), 8, 45, "Wiremu Paki");
    if ((w + 5) % 4 === 1) addEvent("Sales and operations planning", "Internal", "Tauriko head office", addDays(wk, 3), 13, 90, "James Whitfield");
  }
  const stops: [string, string][] = [["Auckland", "Cubro Auckland branch"], ["Hamilton", "Hamilton (venue to be confirmed)"], ["Tauranga", "Cubro showroom, Tauriko"], ["Palmerston North", "Palmerston North (venue to be confirmed)"], ["Wellington", "Cubro Wellington branch"], ["Christchurch", "Cubro Christchurch branch"], ["Dunedin", "Dunedin (venue to be confirmed)"]];
  stops.forEach(([city, venue], i) => addEvent(`Safe moving and handling roadshow — ${city}`, "Trade show", venue, campaignDay("Safe moving and handling roadshow", 1 + i * 2.5), 9, 360, "Hannah Lowe"));
  ["Matching the support surface to the risk", "Alternating air mattresses in practice", "Seating and pressure care", "Heel and positioning care"].forEach((title, i) =>
    addEvent(`Pressure injury prevention webinar: ${title}`, "Webinar", "Microsoft Teams", campaignDay("Pressure injury prevention webinar series", 1 + i * 7), 12, 45, "Hannah Lowe", 30));
  const shows: [string, string, number, number, string][] = [
    ["Aged care sector conference — Cubro stand", "Christchurch", -44, 2, "James Whitfield"], ["Rehabilitation and mobility expo", "Auckland", -19, 1, "Grant Mitchell"],
    ["Hospital procurement supplier day", "Wellington", 6, 1, "Emma Clarke"], ["Mobility retailers' trade day", "Cubro showroom, Tauriko", 33, 1, "Grant Mitchell"],
    ["Occupational therapy equipment expo", "Auckland", 47, 2, "Olivia Harding"], ["Aged care clinical leaders' forum", "Hamilton", 68, 1, "Sina Leota"],
  ];
  for (const [subject, location, offset, days, organizer] of shows) {
    const d0 = toWeekday(addDays(today, offset));
    for (let d = 0; d < days; d++) addEvent(days > 1 ? `${subject} (day ${d + 1})` : subject, "Trade show", location, toWeekday(addDays(d0, d)), 8, 510, organizer, 30);
  }
  for (const o of rng.sample(openOpps, Math.min(openOpps.length, 30))) {
    const a = accountBy.get(o.AccountId)!;
    const p = mainProduct(o);
    addEvent(`${rng.pick(["Product trial", "Site visit", "Quote review"])} — ${a.Name.replace("Health NZ — ", "")}: ${p.description}`, "Customer visit", a.BillingCity, toWeekday(addDays(today, rng.int(-25, 40))), rng.int(9, 15), 60, o.OwnerName!);
  }
  const recentWins = opportunities.filter((o) => o.StageName === "Closed Won" && o.CloseDate >= isoDate(addDays(today, -60)));
  for (const o of rng.sample(recentWins, Math.min(recentWins.length, 16))) {
    const a = accountBy.get(o.AccountId)!;
    addEvent(`In-service training — ${mainProduct(o).description} at ${a.Name.replace("Health NZ — ", "")}`, "Training", a.BillingCity, toWeekday(addDays(day(o.CloseDate), rng.int(10, 30))), rng.pick([10, 13, 14]), 90, "Hannah Lowe");
  }
  for (let i = 0; i < 4; i++) addEvent(`Online equipment training: ${rng.pick(itemsIn(["Moving and transferring", "Pressure care", "Beds"])).description}`, "Training", "Microsoft Teams", toWeekday(addDays(today, -20 + i * 21)), 14, 45, "Hannah Lowe");
  const chase = poMeta.filter((m) => (m.po.status === "Confirmed" || m.po.status === "Sent") && (m.po.confirmedReceiptDate ?? m.po.plannedReceiptDate) < isoDate(today));
  for (const m of chase.slice(0, 8)) addEvent(`Supplier call — ${m.supplier.name} (${m.po.order} delay)`, "Internal", "Microsoft Teams", toWeekday(addDays(today, rng.int(1, 6))), rng.int(14, 16), 30, m.po.buyer);
  for (const it of items.filter((i) => i.isNew)) addEvent(`Product photography — ${it.description}`, "Internal", "Cubro showroom, Tauriko", toWeekday(addDays(day(it.launchDate!), -12), -1), 10, 120, "Aroha Ngata");
  addEvent("Quarterly stocktake — Tauriko warehouse", "Internal", "Tauriko warehouse", toWeekday(addDays(today, 18)), 7, 480, "Nick Barrett");
  addEvent("ISO 9001 and ISO 13485 surveillance audit preparation", "Internal", "Tauriko head office", toWeekday(addDays(today, 26)), 9, 180, "Mere Tapsell");
  events.sort((a, b) => a.start.localeCompare(b.start));
  events.forEach((e, i) => { e.id = `AAMkAGE1${pad(i)}`; });

  // ---- Microsoft 365: purchasing shared mailbox ----
  const messages: MailMessage[] = [];
  const mailbox = COMPANY.purchasingEmail;
  const addMail = (folder: "Inbox" | "Sent Items", from: MailMessage["from"], to: MailMessage["to"][number], subject: string, body: string, at: string, conversationId: string) => {
    if (at > nzTime(today, 23, 59)) return;
    messages.push({ id: "", conversationId, from, to: [to], subject, body, bodyPreview: body.slice(0, 120).replace(/\n/g, " "), receivedDateTime: at, isDraft: false, folder });
  };
  const hourAt = (d: Date) => nzTime(d, rng.int(8, 16), rng.pick([4, 12, 21, 37, 48, 55]));
  const role = (name: string) => STAFF.find((s) => s.name === name)!.role;
  const delayReasons = ["a shortage of empty containers at the port", "congestion at the transhipment port", "a late delivery of actuators from our component supplier", "rework after our final quality inspection", "the vessel omitting our port on this sailing"];
  for (const m of poMeta) {
    const { po, supplier: s } = m;
    const ordered = day(po.orderDate);
    if (po.status === "Created" || (daysBetween(ordered, today) > 80 && m.receipt <= today)) continue;
    const conv = `conv-${po.order}`;
    const us = { name: po.buyer, address: mailbox }, them = { name: s.contactName, address: s.email };
    const overseas = s.country !== "New Zealand";
    const list = po.lines.map((l) => `  ${l.quantity} x ${l.item} ${itemBy.get(l.item)!.description} @ ${po.currency} ${l.price.toFixed(2)}`).join("\n");
    const subject = `Purchase order ${po.order} — Cubro Ltd`;
    addMail("Sent Items", us, them, subject, `Hi ${first(s.contactName)},\n\nPlease find attached purchase order ${po.order}:\n\n${list}\n\nWe need this at our Tauriko warehouse by ${longDate(po.plannedReceiptDate)} (${s.incoterms}). Please confirm pricing and your ship date.\n\nKind regards,\n${po.buyer}\n${role(po.buyer)}, Cubro Ltd`, hourAt(ordered), conv);
    if (po.status === "Sent") continue;
    addMail("Inbox", them, us, `RE: ${subject}`, `Hi ${first(po.buyer)},\n\nThank you for the order. We confirm ${po.order} at the prices shown${overseas ? ` and will ship ${s.incoterms}` : ""}. Delivery to Tauriko is expected around ${longDate(po.plannedReceiptDate)}.\n\nBest regards,\n${s.contactName}\n${s.name}`, hourAt(m.confirmOn), conv);
    if (m.revised || (m.late && m.receipt <= today)) {
      addMail("Inbox", them, us, `RE: ${subject} — revised delivery date`, `Hi ${first(po.buyer)},\n\nI am sorry to advise that ${po.order} is delayed because of ${rng.pick(delayReasons)}. The new delivery date to Tauriko is ${longDate(m.receipt)}.\n\nWe apologise for the inconvenience.\n\nBest regards,\n${s.contactName}`, hourAt(toWeekday(addDays(day(po.plannedReceiptDate), -rng.int(3, 9)), -1)), conv);
    }
    if (po.status === "Partially received") {
      addMail("Inbox", them, us, `RE: ${subject} — part shipment`, `Hi ${first(po.buyer)},\n\nWe have shipped the part of ${po.order} that was ready so you are not left waiting for everything. The balance will follow and I will confirm the date as soon as production gives it to me.\n\nBest regards,\n${s.contactName}`, hourAt(toWeekday(addDays(day(po.plannedReceiptDate), -2), -1)), conv);
    }
    const arriving = m.receipt <= today || po.status === "Confirmed";
    const eta = m.receipt <= today ? m.receipt : day(po.confirmedReceiptDate!);
    if (overseas && arriving && daysBetween(today, eta) <= 12) {
      const port = s.country === "Australia" ? "Port of Tauranga" : rng.pick(["Port of Tauranga", "Port of Tauranga", "Ports of Auckland (rail to MetroPort Tauranga)"]);
      addMail("Inbox", { name: "Bay Freight Logistics — Imports", address: "imports@bayfreight.example.co.nz" }, { name: "Cubro Purchasing", address: mailbox }, `Arrival notice — ${po.order} ex ${s.city}`, `Kia ora,\n\nYour shipment for ${po.order} from ${s.name} is due at ${port} on ${longDate(addDays(eta, -4))}. Customs and MPI clearance has been lodged and we expect to deliver to Tauriko on ${longDate(eta)}.\n\nPlease reply if the receiving dock needs a booking.\n\nNgā mihi,\nBay Freight Logistics`, hourAt(toWeekday(addDays(eta, -7), -1)), conv);
    }
  }
  const month = today.getUTCMonth() + 1;
  rng.sample(suppliers, 14).forEach((s, i) => {
    const them = { name: s.contactName, address: s.email }, us = { name: "Cubro Purchasing", address: mailbox };
    const effective = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 1));
    addMail("Inbox", them, us, `Price list effective ${longDate(effective)}`, `Dear Cubro team,\n\nBecause of higher ${rng.pick(["steel and freight", "foam and textile", "electronic component", "labour and energy"])} costs, our prices will rise by ${rng.pick(["2.5", "3", "3.8", "4.5", "5"])}% from ${longDate(effective)}. Orders confirmed before that date keep current pricing. The new price list is attached.\n\nKind regards,\n${s.contactName}\n${s.name}`, hourAt(toWeekday(addDays(today, -rng.int(2, 40)), -1)), `conv-price-${i}`);
    const asia = ["China", "Taiwan", "Vietnam", "Malaysia"].includes(s.country);
    if (month >= 11 || month === 1) {
      addMail("Inbox", them, us, asia ? "Lunar New Year factory closure" : "Christmas and New Year closure", asia
        ? `Dear customers,\n\nOur factory will close for Lunar New Year for about three weeks from late January. Orders that must ship before the holiday need to be confirmed by mid December.\n\nBest regards,\n${s.contactName}`
        : `Hi team,\n\nWe close on 23 December and reopen on 11 January. Please send any orders you need before Christmas by 4 December.\n\nRegards,\n${s.contactName}`, hourAt(toWeekday(addDays(today, -rng.int(1, 25)), -1)), `conv-closure-${i}`);
    }
  });
  const lowStock = items.filter((it) => it.onHand < it.reorderPoint);
  rng.sample(lowStock, Math.min(lowStock.length, 22)).forEach((it, i) => {
    const waiting = rng.pick(accounts);
    const sup = suppliers.find((s) => s.supplier === it.primarySupplier)!;
    const asker = rng.pick(["Mere Tapsell", waiting.OwnerName, "Wiremu Paki"]);
    const when = toWeekday(addDays(today, -rng.int(0, 14)), -1);
    const buyer = BUYERS[suppliers.indexOf(sup) % BUYERS.length];
    addMail("Inbox", { name: asker, address: staffEmail(asker) }, { name: "Cubro Purchasing", address: mailbox }, `Stock query — ${it.item} ${it.description}`, `Hi team,\n\n${waiting.Name} is waiting on ${rng.int(1, 6)} x ${it.description} (${it.item}). Infor shows ${it.onHand} on hand. Do we have a date for the next delivery from ${sup.name}?\n\nThanks,\n${first(asker)}`, nzTime(when, rng.int(8, 11), rng.pick([5, 20, 40])), `conv-stock-${i}`);
    const next = poMeta.find((m) => m.supplier === sup && m.receipt > today && m.po.lines.some((l) => l.item === it.item));
    if (rng.chance(0.6)) addMail("Sent Items", { name: buyer, address: mailbox }, { name: asker, address: staffEmail(asker) }, `RE: Stock query — ${it.item} ${it.description}`, next
      ? `Hi ${first(asker)},\n\n${next.po.order} has ${next.po.lines.find((l) => l.item === it.item)!.quantity} on order and is due ${longDate(next.po.confirmedReceiptDate ?? next.po.plannedReceiptDate)}. I will let you know if that moves.\n\n${first(buyer)}`
      : `Hi ${first(asker)},\n\nNothing on order yet. I am asking ${sup.name} for availability today and will come back to you with a date.\n\n${first(buyer)}`, nzTime(when, rng.int(13, 16), rng.pick([10, 25, 50])), `conv-stock-${i}`);
  });
  messages.sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
  messages.forEach((m, i) => { m.id = `AAMkAGI2${pad(i)}`; });

  // ---- Microsoft 365: SharePoint marketing library ----
  const library = "https://cubro.sharepoint.example.com/sites/Marketing/Shared%20Documents";
  const assets: BrandAsset[] = [];
  const addAsset = (folder: string, name: string, kind: BrandAsset["kind"], tags: string[], productSku?: string) =>
    assets.push({ id: `01SPDRV${pad(assets.length)}`, name, webUrl: `${library}/${folder.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(name)}`, kind, productSku, tags });
  const scenes = ["Aged care bedroom", "Hospital ward", "Community home visit", "Tauriko warehouse", "Service technician on site", "Cubro showroom", "Clinical educator training session", "Retail mobility store", "Delivery and installation", "Tauriko head office"];
  scenes.forEach((scene, i) => { for (let n = 1; n <= 2; n++) addAsset("Lifestyle photography", `${slug(scene)}-${pad(i * 2 + n, 2)}.jpg`, "photo", ["lifestyle", scene]); });
  for (const it of sellable) {
    const base = `${it.item.replace(/[^A-Za-z0-9-]/g, "-")}_${slug(it.description)}`;
    const tags = [it.itemGroup, ...(it.isNew ? ["new"] : [])];
    const folder = `Product photography/${it.itemGroup}`;
    addAsset(folder, `${base}_studio.jpg`, "photo", [...tags, "studio"], it.item);
    if (it.unitPrice > 250 && rng.chance(0.6)) addAsset(folder, `${base}_in-use.jpg`, "photo", [...tags, "in use"], it.item);
    if (it.unitPrice > 500 && rng.chance(0.45)) addAsset(`Brochures/${it.itemGroup}`, `${base}_brochure.pdf`, "brochure", tags, it.item);
    if (it.isNew || (it.unitPrice > 2500 && rng.chance(0.25))) addAsset("Video", `${base}_overview.mp4`, "video", tags, it.item);
  }
  for (const market of ["Aged Care", "Community Care", "Hospital Care", "Wholesale"]) addAsset("Brochures/Market guides", `Cubro_${slug(market)}_range-guide.pdf`, "brochure", [market]);
  for (const doc of ["Cubro_service-and-maintenance_overview.pdf", "Cubro_Asset-Pulse_overview.pdf", "Cubro_company-profile.pdf", "Cubro_brand-guidelines.pdf"]) addAsset("Brochures/Company", doc, "brochure", ["company"]);
  for (const logo of ["Cubro_logo_primary.svg", "Cubro_logo_primary.png", "Cubro_logo_reversed.svg", "Cubro_logo_reversed.png", "Cubro_logo_mono.svg", "Cubro_social-avatar.png"]) addAsset("Brand/Logos", logo, "logo", ["brand"]);

  // ---- Microsoft 365: Teams ----
  const teamsPosts: TeamsPost[] = [];
  const post = (channel: string, from: string, text: string, daysAgo: number) => teamsPosts.push({ id: "", channel, from, text, createdDateTime: nzTime(toWeekday(addDays(today, -daysAgo), -1), rng.int(8, 16), rng.pick([2, 14, 26, 41, 53])) });
  for (const m of poMeta.filter((m) => m.receipt <= today && daysBetween(m.receipt, today) <= 21).slice(0, 14)) post("Purchasing", "Nick Barrett", `${m.po.order} from ${m.supplier.name} has been received and put away at Tauriko (${m.po.lines.length} lines).`, daysBetween(m.receipt, today));
  for (const m of chase.slice(0, 6)) post("Purchasing", m.po.buyer, `${m.po.order} from ${m.supplier.name} is past its date with no update. I am chasing today.`, rng.int(0, 4));
  for (const c of campaigns.filter((c) => c.Status !== "Completed").slice(0, 8)) post("Marketing", rng.pick(["Liam Chen", "Aroha Ngata", "Sophie Turner"]), `Campaign "${c.Name}" runs ${longDate(c.StartDate)} to ${longDate(c.EndDate)}. Brief and assets are in the Marketing library.`, rng.int(1, 18));
  for (const c of cases.filter((c) => c.Type === "Service" && c.Status !== "Closed").slice(0, 8)) post("Service", "Wiremu Paki", `New service job for ${accountBy.get(c.AccountId)!.Name} (${accountBy.get(c.AccountId)!.BillingCity}): ${c.Description}`, daysBetween(day(c.CreatedDate), today));
  for (const o of recentWins.slice(0, 6)) post("Sales", o.OwnerName!, `Won: ${o.Name} ($${o.Amount.toLocaleString("en-NZ")}).`, Math.min(20, daysBetween(day(o.CloseDate), today)));
  teamsPosts.sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
  teamsPosts.forEach((p, i) => { p.id = `teams-seed-${pad(i)}`; });

  // ---- ClickUp ----
  const tasks: ClickUpTask[] = [];
  const team = (t: ClickUpTask["list"]) => STAFF.filter((s) => s.team === t).map((s) => s.name);
  const technician = (region: string) => STAFF.find((s) => s.role.startsWith("Service Technician") && s.base === REGIONS.find((r) => r.region === region)!.tech)!.name;
  const addTask = (list: ClickUpTask["list"], name: string, description: string, assignee: string, due: Date, tags: string[], done?: boolean) => {
    const d = daysBetween(today, due);
    const status: ClickUpTask["status"] = done === true ? "complete" : done === false ? (d < 3 ? "in progress" : "to do")
      : d < -10 ? "complete" : d < -3 ? (rng.chance(0.8) ? "complete" : rng.pick(["in progress", "review"] as const))
        : d < 0 ? rng.pick(["complete", "in progress", "review"] as const)
          : d < 7 ? rng.pick(["to do", "in progress", "in progress", "review"] as const) : rng.chance(0.8) ? "to do" : "in progress";
    const id = `86c${(2_176_782 + tasks.length * 131).toString(36)}`;
    tasks.push({
      id, name, description, list, status, assignees: [assignee], due_date: isoDate(toWeekday(due)), tags, url: `https://app.clickup.com/t/${id}`,
      priority: status !== "complete" && d < 0 ? (d < -5 ? "urgent" : "high") : d > 21 ? "low" : "normal",
    });
  };
  for (const c of campaigns) {
    const start = day(c.StartDate);
    const tag = slug(c.Name).slice(0, 32);
    const product = c.ProductSkus.length ? itemBy.get(c.ProductSkus[0])!.description : "the service team";
    const steps: [string, string, number, string][] = [
      [`Write campaign brief — ${c.Name}`, `Audience: ${c.Audience}. Key message: ${c.KeyMessage}`, -21, "Liam Chen"],
      [`Select photography for ${c.Name}`, `Choose approved images of ${product} from the SharePoint Marketing library.`, -14, "Aroha Ngata"],
      [`Schedule social posts — ${c.Name}`, `LinkedIn, Facebook and Instagram posts for ${c.StartDate} to ${c.EndDate}. Salesforce campaign ${c.Id}.`, -5, "Sophie Turner"],
      [`Send customer email — ${c.Name}`, `Email to ${c.Audience.toLowerCase()} from the Salesforce campaign list.`, 2, "Sophie Turner"],
      [`Report results — ${c.Name}`, `Leads, enquiries and orders against Salesforce campaign ${c.Id}.`, daysBetween(start, day(c.EndDate)) + 7, "Liam Chen"],
    ];
    if (c.Type === "Product Launch") steps.push([`Update website product page — ${product}`, "Specifications, images and brochure download checked by the product manager.", -7, "Daniel Kim"]);
    if (c.Type === "Trade Show") steps.push([`Book stand equipment and freight — ${c.Name}`, "Demonstration units, banners and brochures packed and booked with the warehouse.", -10, "Aroha Ngata"]);
    for (const [name, description, offset, who] of steps) addTask("Marketing", name, description, who, addDays(start, offset), [tag, c.Type.toLowerCase()]);
  }
  for (const m of poMeta) {
    const { po, supplier: s } = m;
    const due = day(po.confirmedReceiptDate ?? po.plannedReceiptDate);
    if (po.status === "Sent" && daysBetween(day(po.orderDate), today) > 7) addTask("Purchasing", `Chase order confirmation — ${po.order} ${s.name}`, `Sent ${longDate(po.orderDate)}, no confirmation from ${s.contactName} yet.`, po.buyer, addDays(today, rng.int(0, 2)), [po.order, "unconfirmed"], false);
    else if (po.status === "Partially received") addTask("Purchasing", `Follow up balance — ${po.order} ${s.name}`, `${po.lines.filter((l) => l.received < l.quantity).length} lines still outstanding. Was due ${longDate(due)}.`, po.buyer, addDays(today, rng.int(0, 3)), [po.order, "part delivery"], false);
    else if (po.status === "Confirmed" && due < today) addTask("Purchasing", `Chase overdue delivery — ${po.order} ${s.name}`, `Due ${longDate(due)}, ${daysBetween(due, today)} days late. No revised date from ${s.contactName}.`, po.buyer, addDays(today, rng.int(0, 2)), [po.order, "overdue"], false);
    else if (m.receipt <= today && daysBetween(m.receipt, today) <= 45 && s.country !== "New Zealand") addTask("Purchasing", `Reconcile freight and duty — ${po.order}`, `Match the Bay Freight Logistics invoice to ${po.order} from ${s.name} and update landed cost in Infor LN.`, po.buyer, addDays(m.receipt, 10), [po.order, "landed cost"]);
  }
  for (const it of lowStock) {
    const s = suppliers.find((x) => x.supplier === it.primarySupplier)!;
    addTask("Purchasing", `Review reorder — ${it.item} ${it.description}`, `On hand ${it.onHand}, reorder point ${it.reorderPoint}, average demand ${it.avgMonthlyDemand} a month. Supplier ${s.name}, lead time about ${s.avgLeadTimeDays} days.`, "Hemi Walker", addDays(today, rng.int(-2, 6)), [it.item, "low stock"]);
  }
  rng.sample(suppliers, 10).forEach((s) => addTask("Purchasing", `Review new price list — ${s.name}`, `Compare against current standard cost for ${s.categories.join(", ").toLowerCase()} and update Infor LN.`, "Mark Jensen", addDays(today, rng.int(3, 30)), [s.supplier, "pricing"]));
  for (const c of cases.filter((c) => c.Type === "Service").slice(0, 58)) {
    const a = accountBy.get(c.AccountId)!;
    addTask("Operations", `Service visit — ${a.Name.replace("Health NZ — ", "")}${a.Name.includes(a.BillingCity) ? "" : ` (${a.BillingCity})`}`, `${c.Description} Salesforce case ${c.Id}.`, technician(a.Region), addDays(day(c.CreatedDate), rng.int(3, 9)), [a.Region, "service"], c.Status === "Closed" ? true : false);
  }
  for (const o of recentWins.slice(0, 26)) {
    const a = accountBy.get(o.AccountId)!;
    addTask("Operations", `Deliver and install — ${o.Name}`, `Products: ${o.ProductSkus.map((s) => `${s} ${itemBy.get(s)!.description}`).join("; ")}. Site contact: ${contactsOf(a.Id)[0]?.Name ?? "see Salesforce"}.`, rng.pick(["Nick Barrett", "Wiremu Paki"]), addDays(day(o.CloseDate), rng.int(7, 28)), [a.Region, "delivery"]);
  }
  addTask("Operations", "Quarterly stocktake — spare parts cage", "Count ZZ spare part codes and post adjustments in Infor LN.", "Nick Barrett", addDays(today, 18), ["stocktake"]);
  addTask("Operations", "Loan equipment register check", "Confirm all loan beds and mattresses are returned or extended.", "Wiremu Paki", addDays(today, 9), ["loan equipment"]);
  for (const o of opportunities.filter((o) => !o.StageName.startsWith("Closed"))) {
    const a = accountBy.get(o.AccountId)!;
    const [name, description]: [string, string] = o.StageName === "Negotiation" ? [`Follow up decision — ${o.Name}`, `Quote of $${o.Amount.toLocaleString("en-NZ")} is with ${contactsOf(a.Id)[0]?.Name ?? "the customer"}. Expected close ${longDate(o.CloseDate)}.`]
      : o.StageName === "Proposal" ? [`${a.Type === "Public Hospital" ? "Tender response" : "Prepare quote"} — ${o.Name}`, `Products: ${o.ProductSkus.join(", ")}. Salesforce opportunity ${o.Id}.`]
        : [`Book discovery visit — ${o.Name}`, `Confirm needs and budget with ${contactsOf(a.Id)[0]?.Name ?? "the customer"} in ${a.BillingCity}.`];
    if (o.StageName === "Prospecting" && rng.chance(0.5)) continue;
    addTask("Sales", name, description, o.OwnerName!, addDays(day(o.CloseDate), -rng.int(5, 20)), [a.Region, o.StageName.toLowerCase()]);
  }
  void team;
  tasks.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));

  return {
    m365: { events, messages, assets, teamsPosts },
    salesforce: { accounts, contacts, opportunities, campaigns, cases, activities },
    clickup: { tasks },
    inforln: { items, suppliers, purchaseOrders },
  };
}
