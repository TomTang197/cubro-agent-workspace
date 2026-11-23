import type {
  BrandAsset, CalendarEvent, ClickUpTask, LnItem, LnPurchaseOrder, LnSupplier, MailMessage,
  SfAccount, SfCampaign, SfCase, SfOpportunity,
} from "../connectors/types.js";
import { addDays, createRng, isoDate, type Rng } from "./rng.js";

export interface SystemData {
  m365: { events: CalendarEvent[]; messages: MailMessage[]; assets: BrandAsset[]; teamsPosts: { id: string; channel: string; text: string; createdDateTime: string }[] };
  salesforce: { accounts: SfAccount[]; opportunities: SfOpportunity[]; campaigns: SfCampaign[]; cases: SfCase[]; activities: { Id: string; WhatId: string; Subject: string; Description: string; CreatedDate: string }[] };
  clickup: { tasks: ClickUpTask[] };
  inforln: { items: LnItem[]; suppliers: LnSupplier[]; purchaseOrders: LnPurchaseOrder[] };
}

export const STAFF = [
  { name: "Aroha Ngata", role: "Marketing Coordinator", team: "Marketing" },
  { name: "James Whitfield", role: "Business Development Manager", team: "Sales" },
  { name: "Priya Raman", role: "Purchasing Officer", team: "Purchasing" },
  { name: "Liam O'Connor", role: "Supply Chain Lead", team: "Purchasing" },
  { name: "Mere Tapsell", role: "Customer Service Lead", team: "Operations" },
  { name: "Daniel Kim", role: "Product Manager", team: "Marketing" },
  { name: "Sophie Turner", role: "Account Manager — Midlands", team: "Sales" },
  { name: "Hemi Walker", role: "Account Manager — South Island", team: "Sales" },
] as const;

const SUPPLIERS: Omit<LnSupplier, "supplier" | "onTimeRate" | "avgLeadTimeDays">[] = [
  { name: "Ningbo MedTech Manufacturing Co.", country: "China", contactName: "Lily Chen", email: "lily.chen@ningbo-medtech.example.cn", phone: "+86 574 8800 1122", paymentTerms: "30% deposit, 70% before shipment", categories: ["Beds", "Tables & trolleys"] },
  { name: "Foshan Steelcare Furniture Ltd", country: "China", contactName: "Kevin Zhao", email: "kevin@steelcare-fs.example.cn", phone: "+86 757 2233 4455", paymentTerms: "T/T 45 days", categories: ["Beds", "Bariatric"] },
  { name: "Taichung Mobility Industrial", country: "Taiwan", contactName: "Grace Lin", email: "grace.lin@tcmobility.example.tw", phone: "+886 4 2358 9900", paymentTerms: "T/T 30 days", categories: ["Seating", "Patient handling"] },
  { name: "Hsinchu Actuator Systems", country: "Taiwan", contactName: "Brian Wu", email: "b.wu@hsinchu-actuator.example.tw", phone: "+886 3 577 1200", paymentTerms: "Net 30", categories: ["Spares", "Beds"] },
  { name: "Melbourne Foam Technologies", country: "Australia", contactName: "Sarah Mitchell", email: "sarah.m@melbfoam.example.com.au", phone: "+61 3 9555 0192", paymentTerms: "Net 30", categories: ["Mattresses"] },
  { name: "Brisbane Care Textiles", country: "Australia", contactName: "Tom Nguyen", email: "tom@bctextiles.example.com.au", phone: "+61 7 3211 4400", paymentTerms: "Net 45", categories: ["Mattresses", "Spares"] },
  { name: "Sydney Hoist & Lift Pty", country: "Australia", contactName: "Rachel Adams", email: "rachel.adams@sydhoist.example.com.au", phone: "+61 2 9811 7733", paymentTerms: "Net 30", categories: ["Patient handling"] },
  { name: "Auckland Precision Engineering", country: "New Zealand", contactName: "Mike Harrison", email: "mike@aklprecision.example.co.nz", phone: "+64 9 274 5521", paymentTerms: "20th of month following", categories: ["Spares", "Bathroom & toileting"] },
  { name: "Hamilton Powder Coating", country: "New Zealand", contactName: "Jess Parata", email: "jess@hamiltoncoat.example.co.nz", phone: "+64 7 849 3310", paymentTerms: "20th of month following", categories: ["Spares"] },
  { name: "Tauranga Plastics Moulding", country: "New Zealand", contactName: "Craig Bennett", email: "craig@tgaplastics.example.co.nz", phone: "+64 7 572 8870", paymentTerms: "20th of month following", categories: ["Bathroom & toileting", "Spares"] },
  { name: "Christchurch Castors & Wheels", country: "New Zealand", contactName: "Anna Fraser", email: "anna@chchcastors.example.co.nz", phone: "+64 3 366 2290", paymentTerms: "Net 30", categories: ["Spares"] },
  { name: "Linak-style Drive Solutions GmbH", country: "Germany", contactName: "Jonas Becker", email: "j.becker@drivesolutions.example.de", phone: "+49 89 4411 2200", paymentTerms: "Net 60", categories: ["Spares", "Beds"] },
  { name: "Stuttgart Sensor Werke", country: "Germany", contactName: "Lena Hoffmann", email: "lena.hoffmann@sensorwerke.example.de", phone: "+49 711 889 0012", paymentTerms: "Net 45", categories: ["Spares", "Patient handling"] },
  { name: "Xiamen Bath Safety Products", country: "China", contactName: "Amy Huang", email: "amy@xmbathsafety.example.cn", phone: "+86 592 556 7788", paymentTerms: "T/T 30 days", categories: ["Bathroom & toileting"] },
  { name: "Suzhou Wheelchair Works", country: "China", contactName: "David Sun", email: "david.sun@szwheelchair.example.cn", phone: "+86 512 6612 3344", paymentTerms: "30% deposit, 70% before shipment", categories: ["Seating", "Bariatric"] },
  { name: "Penang Electronics Assembly", country: "Malaysia", contactName: "Farid Ismail", email: "farid@penang-ea.example.my", phone: "+60 4 644 1100", paymentTerms: "Net 30", categories: ["Spares"] },
  { name: "Wellington Upholstery Co.", country: "New Zealand", contactName: "Kate Morrison", email: "kate@wgtnupholstery.example.co.nz", phone: "+64 4 568 2201", paymentTerms: "20th of month following", categories: ["Seating"] },
  { name: "Adelaide Medical Plastics", country: "Australia", contactName: "Chris Walsh", email: "chris.walsh@admedplastics.example.com.au", phone: "+61 8 8344 9021", paymentTerms: "Net 30", categories: ["Bathroom & toileting"] },
  { name: "Ho Chi Minh Metal Fabrication", country: "Vietnam", contactName: "Minh Tran", email: "minh.tran@hcmfab.example.vn", phone: "+84 28 3822 4411", paymentTerms: "T/T 45 days", categories: ["Tables & trolleys", "Beds"] },
  { name: "Osaka Air Cell Systems", country: "Japan", contactName: "Yuki Tanaka", email: "y.tanaka@osaka-aircell.example.jp", phone: "+81 6 6344 5566", paymentTerms: "Net 60", categories: ["Mattresses"] },
  { name: "Perth Heavy Duty Lifting", country: "Australia", contactName: "Ben Carter", email: "ben@perthhdl.example.com.au", phone: "+61 8 9411 3300", paymentTerms: "Net 30", categories: ["Bariatric", "Patient handling"] },
  { name: "Dunedin Textile Mills", country: "New Zealand", contactName: "Fiona Grant", email: "fiona@dunedintextile.example.co.nz", phone: "+64 3 477 9012", paymentTerms: "20th of month following", categories: ["Mattresses", "Seating"] },
];

const LEAD_BY_COUNTRY: Record<string, [number, number]> = {
  China: [42, 70], Taiwan: [35, 56], Vietnam: [45, 70], Malaysia: [30, 45], Japan: [35, 50],
  Germany: [50, 80], Australia: [10, 21], "New Zealand": [5, 14],
};
const CURRENCY_BY_COUNTRY: Record<string, LnPurchaseOrder["currency"]> = {
  China: "USD", Taiwan: "USD", Vietnam: "USD", Malaysia: "USD", Japan: "USD", Germany: "EUR", Australia: "AUD", "New Zealand": "NZD",
};

const TREES = ["Kauri", "Rimu", "Tōtara", "Mānuka", "Kōwhai", "Pōhutukawa", "Matai", "Tawa", "Harakeke", "Kahikatea", "Miro", "Nīkau"];
const PRODUCT_TEMPLATES: { group: LnItem["itemGroup"]; names: string[]; price: [number, number] }[] = [
  { group: "Beds", names: ["Hi-Lo Community Care Bed", "Ultra-Low Falls Prevention Bed", "Electric Homecare Bed", "Paediatric Care Bed", "Acute Care Bed", "Day Surgery Recliner Bed"], price: [2400, 7800] },
  { group: "Mattresses", names: ["Pressure Care Foam Mattress", "Hybrid Air Mattress", "Alternating Air Overlay", "Bariatric Foam Mattress", "Static Air Cushion"], price: [380, 3200] },
  { group: "Patient handling", names: ["Mobile Patient Hoist", "Ceiling Track Hoist", "Standing Hoist", "Slide Sheet Set", "Transfer Board", "Universal Sling"], price: [90, 6400] },
  { group: "Bathroom & toileting", names: ["Mobile Shower Commode", "Tilt-in-Space Shower Chair", "Shower Trolley", "Toilet Frame", "Bariatric Commode", "Shower Stool"], price: [120, 5600] },
  { group: "Seating", names: ["Tilt-in-Space Care Chair", "Day Room Recliner", "Lift Recliner", "Wheelchair Lite", "Transit Wheelchair"], price: [650, 5200] },
  { group: "Bariatric", names: ["Bariatric Bed 450kg", "Bariatric Wheelchair 300kg", "Bariatric Shower Trolley", "Bariatric Hoist 320kg", "Bariatric Walking Frame"], price: [900, 11800] },
  { group: "Tables & trolleys", names: ["Overbed Table", "Medication Trolley", "Linen Skip", "Bedside Cabinet"], price: [180, 1900] },
  { group: "Spares", names: ["Bed Actuator", "Hand Control Pendant", "Castor Set 125mm", "Hoist Battery Pack", "Side Rail Kit", "Commode Pan"], price: [25, 640] },
];

const REGIONS = [
  ["Waikato", "Hamilton"], ["Bay of Plenty", "Tauranga"], ["Auckland", "Auckland"], ["Canterbury", "Christchurch"], ["Capital & Coast", "Wellington"],
  ["Southern", "Dunedin"], ["Hawke's Bay", "Hastings"], ["Northland", "Whangārei"], ["MidCentral", "Palmerston North"], ["Nelson Marlborough", "Nelson"],
  ["Lakes", "Rotorua"], ["Taranaki", "New Plymouth"],
] as const;
const ACCOUNT_STEMS: Record<SfAccount["Type"], string[]> = {
  "Public Hospital": ["Te Whatu Ora {r} — {c} Hospital"],
  "Private Hospital": ["{c} Private Hospital", "{c} Surgical Centre", "Bayview Private ({c})"],
  "Aged Care": ["{t} Lodge Rest Home ({c})", "{t} Gardens Retirement Village", "{t} Court Care Home", "{c} Lifecare Village"],
  Hospice: ["Hospice {r}", "{t} House Hospice"],
  "Disability Services": ["{r} Disability Support Trust", "Enable Living {c}"],
  Distributor: ["{c} Mobility Supplies", "Pacific Rehab Distribution ({c})"],
};

const BUYERS = ["Priya Raman", "Liam O'Connor"];

function makeItems(rng: Rng, today: Date, supplierIds: string[], suppliers: LnSupplier[]): LnItem[] {
  const items: LnItem[] = [];
  let n = 1000;
  for (const tpl of PRODUCT_TEMPLATES) {
    for (const base of tpl.names) {
      const variants = tpl.group === "Spares" ? 1 : rng.int(1, 2);
      for (let v = 0; v < variants; v++) {
        const tree = rng.pick(TREES);
        const fitting = suppliers.filter((s) => s.categories.includes(tpl.group));
        const supplier = (fitting.length ? rng.pick(fitting) : suppliers[0]).supplier;
        const demand = tpl.group === "Spares" ? rng.int(20, 120) : rng.int(2, 28);
        const reorderPoint = Math.round(demand * rng.int(12, 20) / 10);
        const lowStock = rng.chance(0.22);
        const isNew = rng.chance(0.12);
        n += rng.int(3, 17);
        items.push({
          item: `CB-${tpl.group.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X")}-${n}`,
          description: `${tree} ${base}${variants > 1 && v === 1 ? " Plus" : ""}`,
          itemGroup: tpl.group,
          unitPrice: Math.round(rng.int(tpl.price[0], tpl.price[1]) / 10) * 10 - 1,
          onHand: lowStock ? rng.int(0, Math.max(1, Math.floor(reorderPoint * 0.6))) : rng.int(reorderPoint, reorderPoint * 3),
          reorderPoint,
          safetyStock: Math.max(1, Math.round(reorderPoint * 0.4)),
          avgMonthlyDemand: demand,
          primarySupplier: supplier,
          isNew,
          launchDate: isNew ? isoDate(addDays(today, rng.int(-20, 40))) : undefined,
        });
      }
    }
  }
  void supplierIds;
  return items;
}

function makePurchaseOrders(rng: Rng, today: Date, items: LnItem[], suppliers: LnSupplier[]): LnPurchaseOrder[] {
  const pos: LnPurchaseOrder[] = [];
  let num = 41200;
  for (let i = 0; i < 150; i++) {
    const supplier = rng.pick(suppliers);
    const supplierItems = items.filter((it) => it.primarySupplier === supplier.supplier);
    const pool = supplierItems.length ? supplierItems : items;
    const orderDate = addDays(today, -rng.int(2, 150));
    const lead = supplier.avgLeadTimeDays + rng.int(-5, 10);
    const planned = addDays(orderDate, lead);
    const daysToPlanned = Math.round((planned.getTime() - today.getTime()) / 86_400_000);
    let status: LnPurchaseOrder["status"];
    let confirmed: string | null = null;
    const late = rng.next() > supplier.onTimeRate;
    if (daysToPlanned < -20) status = rng.chance(0.85) ? "Closed" : late ? "Partially received" : "Received";
    else if (daysToPlanned < 0) status = late ? rng.pick(["Confirmed", "Sent", "Partially received"] as const) : "Received";
    else status = rng.pick(["Created", "Sent", "Sent", "Confirmed", "Confirmed"] as const);
    if (status !== "Created" && status !== "Sent") confirmed = isoDate(addDays(planned, late ? rng.int(3, 21) : 0));
    const lines = rng.sample(pool, rng.int(1, Math.min(4, pool.length))).map((it, idx) => {
      const qty = it.itemGroup === "Spares" ? rng.int(20, 200) : rng.int(2, 30);
      const received = status === "Received" || status === "Closed" ? qty : status === "Partially received" ? Math.floor(qty * rng.int(20, 70) / 100) : 0;
      return { line: (idx + 1) * 10, item: it.item, quantity: qty, received, price: Math.round(it.unitPrice * 0.48) };
    });
    num += rng.int(1, 6);
    pos.push({
      order: `PO${num}`,
      supplier: supplier.supplier,
      orderDate: isoDate(orderDate),
      plannedReceiptDate: isoDate(planned),
      confirmedReceiptDate: confirmed,
      status,
      buyer: rng.pick(BUYERS),
      currency: CURRENCY_BY_COUNTRY[supplier.country] ?? "NZD",
      lines,
    });
  }
  return pos.sort((a, b) => b.orderDate.localeCompare(a.orderDate));
}

function fill(t: string, r: string, c: string, tree: string) {
  return t.replace("{r}", r).replace("{c}", c).replace("{t}", tree);
}

export function generateSystemData(seed = 20261123, today = new Date()): SystemData {
  const rng = createRng(seed);
  today = new Date(isoDate(today) + "T00:00:00Z");

  const suppliers: LnSupplier[] = SUPPLIERS.map((s, i) => {
    const [lo, hi] = LEAD_BY_COUNTRY[s.country] ?? [20, 40];
    return { ...s, supplier: `SUP${(1001 + i * 7).toString()}`, avgLeadTimeDays: rng.int(lo, hi), onTimeRate: rng.int(62, 98) / 100 };
  });
  const items = makeItems(rng, today, suppliers.map((s) => s.supplier), suppliers);
  const purchaseOrders = makePurchaseOrders(rng, today, items, suppliers);

  // Salesforce
  const accounts: SfAccount[] = [];
  const sales = STAFF.filter((s) => s.team === "Sales").map((s) => s.name);
  const types = Object.keys(ACCOUNT_STEMS) as SfAccount["Type"][];
  const seen = new Set<string>();
  let acc = 0;
  while (accounts.length < 46) {
    const type = accounts.length < REGIONS.length ? "Public Hospital" : rng.pick(types.filter((t) => t !== "Public Hospital"));
    const [region, city] = accounts.length < REGIONS.length ? REGIONS[accounts.length] : rng.pick(REGIONS);
    const name = fill(rng.pick(ACCOUNT_STEMS[type]), region, city, rng.pick(TREES));
    if (seen.has(name)) continue;
    seen.add(name);
    acc++;
    accounts.push({
      Id: `001Ws00000${(4100 + acc).toString()}AB`,
      Name: name, Type: type, BillingCity: city, Region: region,
      AnnualSpend__c: type === "Public Hospital" ? rng.int(180, 950) * 1000 : rng.int(8, 160) * 1000,
      OwnerName: rng.pick(sales),
    });
  }
  const stages: SfOpportunity["StageName"][] = ["Prospecting", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"];
  const opportunities: SfOpportunity[] = Array.from({ length: 84 }, (_, i) => {
    const a = rng.pick(accounts);
    const prods = rng.sample(items.filter((it) => it.itemGroup !== "Spares"), rng.int(1, 3));
    const stage = rng.pick(stages);
    const closed = stage.startsWith("Closed");
    return {
      Id: `006Ws00000${(7300 + i).toString()}XY`,
      Name: `${a.Name.split(" — ").pop()} — ${prods[0].itemGroup} ${rng.pick(["refresh", "expansion", "tender", "replacement", "trial"])}`,
      AccountId: a.Id, StageName: stage,
      Amount: prods.reduce((sum, p) => sum + p.unitPrice * rng.int(2, 24), 0),
      CloseDate: isoDate(addDays(today, closed ? -rng.int(5, 120) : rng.int(5, 140))),
      ProductSkus: prods.map((p) => p.item),
    };
  });

  const byGroup = (g: LnItem["itemGroup"]) => items.filter((it) => it.itemGroup === g).map((it) => it.item);
  const newItems = items.filter((it) => it.isNew);
  const campaigns: SfCampaign[] = [
    { Name: "Falls prevention month", Type: "Awareness", start: -6, end: 24, skus: byGroup("Beds").slice(0, 3), Audience: "Aged care managers and clinical nurse leads", KeyMessage: "Ultra-low beds and sensor mats reduce injury from falls at night." },
    { Name: "Bariatric care roadshow — North Island", Type: "Trade Show", start: 4, end: 18, skus: byGroup("Bariatric"), Audience: "Hospital procurement and moving & handling coordinators", KeyMessage: "Safe, dignified bariatric care: rated, tested and supported locally." },
    { Name: "New product launch — summer range", Type: "Product Launch", start: -2, end: 30, skus: newItems.map((i) => i.item), Audience: "All customers", KeyMessage: "Designed with NZ carers, built for NZ facilities." },
    { Name: "Pressure injury prevention webinar", Type: "Webinar", start: 9, end: 9, skus: byGroup("Mattresses").slice(0, 4), Audience: "Wound care nurses and educators", KeyMessage: "Matching mattress technology to patient risk." },
    { Name: "Safe moving & handling week", Type: "Awareness", start: 14, end: 21, skus: byGroup("Patient handling").slice(0, 4), Audience: "Carers, physios and H&S reps", KeyMessage: "The right hoist and sling protects patients and staff." },
    { Name: "Christmas & New Year service hours", Type: "Seasonal", start: 20, end: 45, skus: [], Audience: "All customers", KeyMessage: "Our service and spares team is on call over the holidays." },
    { Name: "Shower & toileting dignity series", Type: "Awareness", start: -30, end: -5, skus: byGroup("Bathroom & toileting").slice(0, 3), Audience: "Aged care and disability providers", KeyMessage: "Tilt-in-space bathing that keeps residents comfortable and safe." },
    { Name: "NZACA conference follow-up", Type: "Trade Show", start: -45, end: -38, skus: byGroup("Seating").slice(0, 2), Audience: "Aged care operators", KeyMessage: "Thanks for visiting our stand — here's what you asked about." },
  ].map((c, i) => ({
    Id: `701Ws00000${(2200 + i).toString()}CM`, Name: c.Name, Type: c.Type as SfCampaign["Type"],
    Status: c.end < 0 ? "Completed" : c.start <= 0 ? "In Progress" : "Planned",
    StartDate: isoDate(addDays(today, c.start)), EndDate: isoDate(addDays(today, c.end)),
    ProductSkus: c.skus, Audience: c.Audience, KeyMessage: c.KeyMessage,
  }));

  const feedback = [
    "Residents love how quiet the bed motor is at night.",
    "Staff say the hoist is much easier to manoeuvre in tight ensuites.",
    "The new commode wheels roll well on our wet-room floors.",
    "Pressure injury rates on Ward 4 dropped since switching mattresses.",
    "Castor on one unit is sticking — requesting service visit.",
    "Delivery was quick and the install team were great with residents.",
    "Can we get a demo of the bariatric range for our new wing?",
    "Hand control cable needs replacing on two beds.",
  ];
  const cases: SfCase[] = Array.from({ length: 36 }, (_, i) => {
    const text = rng.pick(feedback);
    return {
      Id: `500Ws00000${(9100 + i).toString()}CS`, Subject: text.slice(0, 48),
      AccountId: rng.pick(accounts).Id, ProductSku: rng.pick(items).item,
      Type: /sticking|replacing/.test(text) ? "Service" : /demo/.test(text) ? "Feedback" : rng.pick(["Feedback", "Feedback", "Complaint"] as const),
      Description: text, CreatedDate: isoDate(addDays(today, -rng.int(1, 90))),
    };
  });

  // M365
  const eventSeeds: [string, CalendarEvent["category"], string][] = [
    ["NZ Aged Care Association Conference", "Trade show", "Te Pae, Christchurch"],
    ["HealthTech Week Expo", "Trade show", "Aotea Centre, Auckland"],
    ["Moving & Handling Forum", "Trade show", "Claudelands, Hamilton"],
    ["Product demo — Te Whatu Ora Waikato", "Customer visit", "Waikato Hospital"],
    ["Site visit — Pōhutukawa Lodge", "Customer visit", "Tauranga"],
    ["Pressure injury prevention webinar", "Webinar", "Microsoft Teams"],
    ["Marketing weekly stand-up", "Internal", "Tauriko head office"],
    ["Purchasing review", "Internal", "Tauriko head office"],
    ["New range photoshoot", "Internal", "Tauriko showroom"],
    ["Carer training — hoist & sling safety", "Training", "Rotorua"],
    ["Bariatric roadshow — Hamilton", "Customer visit", "Hamilton"],
    ["Bariatric roadshow — Tauranga", "Customer visit", "Tauranga"],
    ["Bariatric roadshow — Auckland", "Customer visit", "Auckland"],
    ["Supplier call — Ningbo MedTech", "Internal", "Microsoft Teams"],
    ["Christmas shutdown planning", "Internal", "Tauriko head office"],
  ];
  const events: CalendarEvent[] = [];
  for (let w = -2; w < 7; w++) {
    for (const [i, [subject, category, location]] of eventSeeds.entries()) {
      const recurring = category === "Internal" && /weekly|review/.test(subject);
      if (!recurring && rng.next() > 0.18) continue;
      const day = addDays(today, w * 7 + (recurring ? (i % 5) : rng.int(0, 4)));
      const start = new Date(day.getTime() + rng.int(8, 15) * 3_600_000);
      events.push({
        id: `AAMkAG${events.length.toString().padStart(4, "0")}`, subject, category, location,
        start: start.toISOString(), end: new Date(start.getTime() + (category === "Trade show" ? 8 : 1) * 3_600_000).toISOString(),
        organizer: rng.pick(STAFF).name,
      });
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));

  const supplierMailTopics = [
    (s: LnSupplier, po: string) => [`RE: ${po} shipment update`, `Hi Priya,\n\nPlease note ${po} is now expected to leave port about 10 days later than planned because of a container shortage. We will confirm the new ETD this week.\n\nBest regards,\n${s.contactName}`],
    (s: LnSupplier) => [`Price adjustment notice 2027`, `Dear Cubro team,\n\nDue to steel and freight costs, our price list will increase by 4.5% from 1 February 2027. Orders confirmed before 15 January keep current pricing.\n\nKind regards,\n${s.contactName}`],
    (s: LnSupplier, po: string) => [`${po} — order confirmation`, `Hello,\n\nWe confirm receipt of ${po}. Production is scheduled and we will advise the ship date.\n\nThanks,\n${s.contactName}`],
    (s: LnSupplier) => [`Holiday closure dates`, `Hi team,\n\nOur factory closes from 20 December to 8 January. Please place urgent orders by 5 December.\n\n${s.contactName}`],
  ];
  const messages: MailMessage[] = [];
  for (let i = 0; i < 34; i++) {
    const s = rng.pick(suppliers);
    const po = rng.pick(purchaseOrders.filter((p) => p.supplier === s.supplier)) ?? rng.pick(purchaseOrders);
    const [subject, body] = rng.pick(supplierMailTopics)(s, po.order);
    messages.push({
      id: `AAMkAGI2${i.toString().padStart(4, "0")}`, conversationId: `conv-${i}`,
      from: { name: s.contactName, address: s.email },
      to: [{ name: rng.pick(BUYERS), address: "purchasing@cubro.example.co.nz" }],
      subject, body, bodyPreview: body.slice(0, 120).replace(/\n/g, " "),
      receivedDateTime: addDays(today, -rng.int(0, 40)).toISOString(), isDraft: false, folder: "Inbox",
    });
  }
  messages.sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));

  const assets: BrandAsset[] = items.filter((it) => it.itemGroup !== "Spares").slice(0, 44).map((it, i) => ({
    id: `01SPDRV${i.toString().padStart(4, "0")}`,
    name: `${it.description.replace(/\s+/g, "_")}_${rng.pick(["in-use", "studio", "detail", "lifestyle"])}.jpg`,
    webUrl: `https://cubro.sharepoint.example.com/sites/Marketing/Shared%20Documents/Product%20Photos/${it.item}.jpg`,
    kind: rng.chance(0.15) ? "video" : rng.chance(0.15) ? "brochure" : "photo",
    productSku: it.item, tags: [it.itemGroup, ...(it.isNew ? ["new"] : [])],
  }));

  // ClickUp
  const taskSeeds: [ClickUpTask["list"], string][] = [
    ["Marketing", "Write case study: {acc}"], ["Marketing", "Brief photographer for {prod}"], ["Marketing", "Update website product page — {prod}"],
    ["Marketing", "Plan LinkedIn content for {camp}"], ["Marketing", "Design trade show banner"], ["Marketing", "Translate brochure into te reo Māori headings"],
    ["Purchasing", "Chase confirmation from {sup}"], ["Purchasing", "Review 2027 price list — {sup}"], ["Purchasing", "Approve sample from {sup}"],
    ["Purchasing", "Reconcile freight invoice"], ["Operations", "Service visit — {acc}"], ["Operations", "Install {prod} at {acc}"],
    ["Operations", "Stocktake spares cage"], ["Sales", "Prepare quote for {acc}"], ["Sales", "Follow up demo — {acc}"], ["Sales", "Tender response — {acc}"],
  ];
  const tasks: ClickUpTask[] = Array.from({ length: 88 }, (_, i) => {
    const [list, tpl] = rng.pick(taskSeeds);
    const name = tpl.replace("{acc}", rng.pick(accounts).Name).replace("{prod}", rng.pick(items).description)
      .replace("{sup}", rng.pick(suppliers).name).replace("{camp}", rng.pick(campaigns).Name);
    const team = STAFF.filter((s) => s.team === list);
    const id = `86c${(1_000_000 + i * 37).toString(36)}`;
    return {
      id, name, description: "", list,
      status: rng.pick(["to do", "to do", "in progress", "review", "complete", "complete"] as const),
      assignees: [rng.pick(team.length ? team : STAFF).name],
      due_date: isoDate(addDays(today, rng.int(-20, 40))),
      tags: [], url: `https://app.clickup.com/t/${id}`,
    };
  });

  return {
    m365: { events, messages, assets, teamsPosts: [] },
    salesforce: { accounts, opportunities, campaigns, cases, activities: [] },
    clickup: { tasks },
    inforln: { items, suppliers, purchaseOrders },
  };
}
