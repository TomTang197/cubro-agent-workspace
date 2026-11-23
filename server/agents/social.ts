import type { SystemData } from "../data/seed.js";
import type { ApprovalItem, Settings, SocialPostPayload } from "../store.js";
import { ESTIMATES, type Draft } from "./drafts.js";
import { daysBetween, longDay, nzClock, nzDay, nzTime, shiftDay, shortDay } from "./nzTime.js";

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

type SocialData = Pick<SystemData["salesforce"], "campaigns" | "cases" | "accounts"> & Pick<SystemData["inforln"], "items"> & Pick<SystemData["m365"], "events" | "assets">;
type Item = SocialData["items"][number];
type Kind = "event" | "campaign" | "product" | "story";
interface Idea {
  kind: Kind; topic: string; title: string; text: (channel: string) => string; tags: string[]; skus: string[]; campaign?: string;
  why: string; sources: Draft["sources"]; priority: Draft["priority"];
  /** The NZ days this post makes sense on, and why. */
  earliest: string; latest: string; timing: string; noImage?: string;
  /** Hard limits a reviewer's own date must keep to. */
  notBefore?: string; notAfter?: string;
}

const STORY_LOOKBACK_DAYS = 90;
const LAUNCH_LOOKBACK_DAYS = 30;
/** An event is promoted in the week before it, so the planner looks this far past the plan for events. */
export const EVENT_LEAD_DAYS = 7;
const MAX_STORIES = 2;
const MAX_WAITING_PER_CAMPAIGN = 2;
const CAMPAIGN_FULL = "campaign-full:";
const CAMPAIGN_SEEN = "campaign-seen:";
const PRAISE = /\b(love|loves|easier|great|well|quick|happy|pleased|thank|dropped|comfortable|impressed)\b/i;
const NOT_PRAISE = /\?|\b(request|requesting|need|needs|replac\w*|stick\w*|fault\w*|broken|demo|quote|complain\w*)\b/i;
const GENERIC = new Set(["care", "plus", "and", "the", "for", "set", "kit", "with"]);

/** A customer quote is tied to a product only when it actually talks about that kind of product. */
function quoteIsAbout(quote: string, p: Item) {
  const q = quote.toLowerCase();
  return `${p.description} ${p.itemGroup}`.toLowerCase().split(/[^a-zāēīōū]+/).map((w) => w.replace(/(es|s)$/, ""))
    .some((w) => w.length >= 3 && !GENERIC.has(w) && new RegExp(`\\b${w}`).test(q));
}
const customerKind = (type?: string) => (type ? `${type.toLowerCase()} customers` : "customers");

/** The subject a draft covers, so one campaign product, event, launch or quote is not drafted twice. */
export function socialTopic(a: Pick<ApprovalItem, "payload" | "sources">) {
  if (a.payload.type !== "social_post") return undefined;
  if (a.payload.topic) return a.payload.topic;
  const first = a.sources[0];
  if (!first) return undefined;
  if (first.label.startsWith("Campaign")) return `campaign:${first.ref}:${a.payload.productSkus[0] ?? ""}`;
  if (first.label.startsWith("Calendar")) return `event:${first.ref}`;
  if (first.label.startsWith("New item")) return `product:${first.ref}`;
  return `story:${first.ref}`;
}

/** What the drafting model is told about a post. The reviewer's note on a customer story names the customer, so the model never sees it. */
export function socialBrief(d: Pick<Draft, "payload" | "sources" | "rationale">) {
  return socialTopic(d)?.startsWith("story:")
    ? "A customer gave this feedback about our equipment. Quote it as written and do not name the customer, their staff or their town."
    : d.rationale;
}

/** Topics the planner should leave alone: waiting for review, already approved, or decided within the last planning window. */
export function takenSocialTopics(approvals: ApprovalItem[], today: Date, horizonDays: number) {
  const recent = new Date(today.getTime() - horizonDays * 86_400_000).toISOString();
  const taken = new Set<string>();
  const waiting = new Map<string, number>();
  for (const a of approvals) {
    const topic = socialTopic(a);
    if (!topic) continue;
    const campaign = topic.startsWith("campaign:") ? topic.split(":")[1] : undefined;
    if (campaign && a.status === "pending") {
      waiting.set(campaign, (waiting.get(campaign) ?? 0) + 1);
      if (waiting.get(campaign)! >= MAX_WAITING_PER_CAMPAIGN) taken.add(`${CAMPAIGN_FULL}${campaign}`);
    }
    const live = a.status === "pending" || a.createdAt >= recent;
    if (campaign && (live || a.status === "approved")) taken.add(`${CAMPAIGN_SEEN}${campaign}`);
    if (live || (a.status === "approved" && !campaign)) taken.add(topic);
  }
  return taken;
}

/** Channel and NZ day of every post already waiting or approved, so a new plan spreads around them. */
export function busySocialSlots(approvals: ApprovalItem[], today: Date) {
  return approvals.flatMap((a) => (a.payload.type === "social_post" && a.status !== "rejected" && new Date(a.payload.scheduledFor) > today ? [{ channel: a.payload.channel, day: nzDay(a.payload.scheduledFor) }] : []));
}

export function buildSocialDrafts(d: SocialData, settings: Settings, start: Date, offset = 0, taken: ReadonlySet<string> = new Set(), busy: readonly { channel: string; day: string }[] = []): Draft[] {
  const { channels, postsPerRun, horizonDays } = settings.social;
  if (!channels.length || postsPerRun < 1 || horizonDays < 1) return [];
  const today = nzDay(start);
  const first = shiftDay(today, 1);
  const last = shiftDay(today, horizonDays);
  const later = (a: string, b: string) => (a > b ? a : b);
  const sooner = (a: string, b: string) => (a < b ? a : b);
  const item = (sku: string) => d.items.find((i) => i.item === sku);
  const launched = (p: Item, by: string) => !p.isNew || !p.launchDate || p.launchDate <= by;

  const upcoming = d.events
    .filter((e) => e.category === "Trade show" || e.category === "Webinar")
    .map((e) => ({ e, day: nzDay(e.start) }))
    .filter(({ day }) => day > first && shiftDay(day, -EVENT_LEAD_DAYS) <= last)
    .sort((a, b) => a.e.start.localeCompare(b.e.start))
    .filter(({ e }, i, all) => all.findIndex((x) => x.e.subject === e.subject) === i);
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  const ideas: Record<Kind, Idea[]> = { event: [], campaign: [], product: [], story: [] };

  for (const { e, day } of upcoming) {
    const c = d.campaigns.find((x) => sameName(x.Name, e.subject));
    const webinar = e.category === "Webinar";
    const earliest = later(first, shiftDay(day, -EVENT_LEAD_DAYS));
    const latest = sooner(last, shiftDay(day, -1));
    if (earliest > latest) continue;
    const message = c ? ` ${c.KeyMessage}` : "";
    ideas.event.push({
      kind: "event", topic: `event:${e.id}`, title: `Event: ${e.subject}`, campaign: c?.Name, priority: "high",
      text: (ch) => webinar
        ? ch === "LinkedIn"
          ? `Join us online for the ${e.subject} on ${longDay(day)} at ${nzClock(e.start)}.${message}\n\nAsk your Cubro account manager for the link, or get in touch at cubro.co.nz.`
          : `Join us online for the ${e.subject} on ${longDay(day)} at ${nzClock(e.start)}.${message} Message us for the link.`
        : ch === "LinkedIn"
          ? `We'll be at ${e.subject}, ${e.location}, on ${longDay(day)}.${message}\n\nCome and see our latest care beds, hoists and bathroom solutions, and talk to our team about what your facility needs. We'd love to see you there.`
          : `Catch the Cubro team at ${e.subject}, ${e.location}, on ${longDay(day)}. Come and say kia ora!`,
      tags: ["#Cubro", "#HealthcareNZ", webinar ? "#Webinar" : "#TradeShow"],
      skus: c ? c.ProductSkus.filter((s) => { const p = item(s); return p && launched(p, earliest); }).slice(0, 1) : [],
      why: `Outlook calendar shows "${e.subject}" on ${shortDay(day)}, organised by ${e.organizer}${c ? `; it matches the Salesforce campaign of the same name` : ""}.`,
      timing: `Scheduled ahead of the ${webinar ? "webinar" : "event"} so people can plan to ${webinar ? "join" : "come"}.`,
      noImage: `No image picked: there is no ${webinar ? "webinar" : "event"} artwork on SharePoint, so add one before publishing.`,
      earliest, latest, notAfter: shiftDay(day, -1),
      sources: [{ system: "Microsoft 365", label: `Calendar: ${e.subject}`, ref: e.id }, ...(c ? [{ system: "Salesforce", label: `Campaign: ${c.Name}`, ref: c.Id }] : [])],
    });
  }

  const running = d.campaigns
    // An event post covers a campaign only when they are the same thing on the same day.
    .filter((c) => c.StartDate <= last && c.EndDate >= first && !upcoming.some(({ e, day }) => sameName(e.subject, c.Name) && c.StartDate === c.EndDate && c.StartDate === day))
    .sort((a, b) => Number(b.Status === "In Progress") - Number(a.Status === "In Progress") || a.StartDate.localeCompare(b.StartDate));
  for (const c of running) {
    const oneDay = c.StartDate === c.EndDate;
    // A one-day campaign (a webinar, a show) is promoted before the day; a longer one while it runs.
    const from = oneDay ? first : later(first, c.StartDate);
    const latest = oneDay ? sooner(last, shiftDay(c.StartDate, -1)) : sooner(last, c.EndDate);
    if (from > latest) continue;
    // One day gets one post: once it is waiting, approved or rejected, swapping the product does not bring it back.
    if (oneDay && taken.has(`${CAMPAIGN_SEEN}${c.Id}`)) continue;
    const ready = c.ProductSkus.map(item).filter((p): p is Item => !!p && launched(p, latest));
    const pictured = ready.filter((p) => d.assets.some((a) => a.productSku === p.item));
    const inStock = (pictured.length ? pictured : ready).filter((p, _, all) => p.onHand > 0 || all.every((x) => x.onHand <= 0));
    // Leave the product an event post already shows to that post.
    const notShown = inStock.filter((p) => !ideas.event.some((e) => e.skus.includes(p.item)));
    const stocked = notShown.length ? notShown : inStock;
    // Each run offers a fresh product for the campaign, unless enough posts for it are already waiting.
    const fresh = stocked.map((_, i) => stocked[(offset + i) % stocked.length]).filter((x) => !taken.has(`campaign:${c.Id}:${x.item}`));
    if (taken.has(`${CAMPAIGN_FULL}${c.Id}`) || (stocked.length > 0 && !fresh.length)) continue;
    const p = fresh[0];
    const audience = /^all customers$/i.test(c.Audience) ? "care teams across Aotearoa" : c.Audience.charAt(0).toLowerCase() + c.Audience.slice(1);
    const lead = oneDay ? `${c.Name}, ${longDay(c.StartDate)}. ` : "";
    const earliest = p?.isNew && p.launchDate ? later(from, p.launchDate) : from;
    ideas.campaign.push({
      kind: "campaign", topic: `campaign:${c.Id}:${p?.item ?? ""}`, title: `${c.Name}${p ? ` — ${p.description}` : ""}`, campaign: c.Name,
      priority: c.Status === "In Progress" ? "high" : "normal",
      text: (ch) => ch === "LinkedIn"
        ? `${lead}${c.KeyMessage}\n\n${p ? `The ${p.description} is part of our ${p.itemGroup.toLowerCase()} range, supported by our team here in Aotearoa. ` : ""}We partner with ${audience} to match equipment to the people using it.\n\n${oneDay ? "Ask your Cubro account manager for the details, or get in touch at cubro.co.nz." : "Talk to your Cubro account manager or visit cubro.co.nz to book a demo."}`
        : ch === "Instagram"
          ? `${lead}${c.KeyMessage}${p ? ` Meet the ${p.description}.` : ""}${oneDay ? " Message us for the details." : ""} Supporting NZ carers 💙`
          : `${lead}${c.KeyMessage}${p ? ` See the ${p.description} in action and ask us about a trial at your facility.` : ""} ${oneDay ? "Message us for the details." : "Message us to find out more."}`,
      tags: [...(p ? HASHTAGS[p.itemGroup] ?? [] : []), "#Cubro", "#NZHealth"],
      skus: p ? [p.item] : [],
      why: `Salesforce campaign "${c.Name}" ${oneDay ? `is on ${shortDay(c.StartDate)}` : `runs ${shortDay(c.StartDate)} to ${shortDay(c.EndDate)}`}${p ? `; featured product ${p.item} has ${p.onHand} units on hand in Infor LN` : ""}.`,
      timing: oneDay ? "Scheduled before the day so people can plan for it. Salesforce has no start time or sign-up link for it, so add those before publishing." : "Scheduled inside the campaign dates.",
      earliest, latest, notAfter: oneDay ? shiftDay(c.StartDate, -1) : c.EndDate, notBefore: p?.isNew ? p.launchDate : undefined,
      sources: [{ system: "Salesforce", label: `Campaign: ${c.Name}`, ref: c.Id }, ...(p ? [{ system: "Infor LN", label: `Item ${p.item}`, ref: p.item }] : [])],
    });
  }

  const launches = d.items
    .filter((p) => p.isNew && p.itemGroup !== "Spares")
    .filter((p) => !p.launchDate || (p.launchDate <= last && p.launchDate >= shiftDay(today, -LAUNCH_LOOKBACK_DAYS)))
    .sort((a, b) => (b.launchDate ?? "").localeCompare(a.launchDate ?? ""));
  for (const p of launches) {
    const upcomingLaunch = !!p.launchDate && p.launchDate >= first;
    const range = p.itemGroup.toLowerCase();
    ideas.product.push({
      kind: "product", topic: `product:${p.item}`, title: `New product: ${p.description}`, priority: upcomingLaunch ? "high" : "normal",
      text: (ch) => ch === "LinkedIn"
        ? `New to the Cubro range: the ${p.description}.\n\nBuilt for the realities of NZ ${p.itemGroup === "Beds" ? "wards and rest homes" : "care settings"}, it ${upcomingLaunch ? `joins our ${range} line-up from ${longDay(p.launchDate!)}` : `is now part of our ${range} line-up`}. Ask your account manager about a trial unit.`
        : `Introducing the ${p.description}, ${upcomingLaunch ? `available from ${longDay(p.launchDate!)}` : `now available in our ${range} range`}. Ask us about a trial.`,
      tags: [...(HASHTAGS[p.itemGroup] ?? []), "#NewProduct", "#Cubro"], skus: [p.item],
      why: `Infor LN flags ${p.item} as a new item${p.launchDate ? ` ${upcomingLaunch ? "launching" : "that launched"} ${shortDay(p.launchDate)}` : ""}, with ${p.onHand} units on hand.`,
      timing: upcomingLaunch ? "Scheduled for launch day, not before." : "Already launched, so it can go out any day.",
      earliest: upcomingLaunch ? p.launchDate! : first, latest: upcomingLaunch ? sooner(last, shiftDay(p.launchDate!, 2)) : last, notBefore: p.launchDate,
      sources: [{ system: "Infor LN", label: `New item ${p.item}`, ref: p.item }],
    });
  }

  const quotes = d.cases
    .filter((c) => c.Type === "Feedback" && PRAISE.test(c.Description) && !NOT_PRAISE.test(c.Description))
    .filter((c) => c.CreatedDate <= today && c.CreatedDate >= shiftDay(today, -STORY_LOOKBACK_DAYS))
    .sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate))
    .filter((c, i, all) => all.findIndex((x) => x.Description === c.Description) === i);
  for (const c of quotes) {
    const acc = d.accounts.find((a) => a.Id === c.AccountId);
    const linked = item(c.ProductSku);
    const p = linked && launched(linked, first) && quoteIsAbout(c.Description, linked) ? linked : undefined;
    ideas.story.push({
      kind: "story", topic: `story:${c.Description}`, title: `Customer story: ${p?.description ?? "customer feedback"}`, priority: "low",
      text: () => `"${c.Description}"\n\nThat's from one of our ${customerKind(acc?.Type)}${p ? `, about the ${p.description}` : ""}. Feedback like this is why we work alongside the people who use our equipment every day.`,
      tags: ["#CustomerStory", "#Cubro", ...(p ? HASHTAGS[p.itemGroup] ?? [] : ["#HealthcareNZ"])], skus: p ? [p.item] : [],
      why: `${acc?.Name ?? "A customer"} gave this feedback in Salesforce case ${c.Id} on ${shortDay(c.CreatedDate)}. The post does not name them, but ask ${acc?.OwnerName ? `${acc.OwnerName} (account owner)` : "the account owner"} to check they are happy to be quoted before it is published.`,
      timing: "Not tied to a date, so it fills a gap in the plan.",
      noImage: p ? undefined : "No image picked: the feedback is not about one product, so add a photo before publishing.",
      earliest: first, latest: last,
      sources: [{ system: "Salesforce", label: `Case ${c.Id}`, ref: c.Id }],
    });
  }

  // A mix of what is on, not eight of the same thing: take one of each kind in turn, never the same product twice.
  const queue: Record<Kind, Idea[]> = { event: [], campaign: [], product: [], story: [] };
  for (const k of Object.keys(ideas) as Kind[]) queue[k] = ideas[k].filter((i) => !taken.has(i.topic));
  queue.story = queue.story.slice(0, MAX_STORIES);
  const chosen: Idea[] = [];
  const usedSkus = new Set<string>();
  const order: Kind[] = ["event", "campaign", "product", "story"];
  while (chosen.length < postsPerRun && order.some((k) => queue[k].length)) {
    for (const k of order) {
      if (chosen.length >= postsPerRun) break;
      let idea = queue[k].shift();
      while (idea && idea.skus.some((s) => usedSkus.has(s))) idea = queue[k].shift();
      if (!idea) continue;
      idea.skus.forEach((s) => usedSkus.add(s));
      chosen.push(idea);
    }
  }

  // Spread the posts over the window, each on a day that suits it; tightest windows are placed first.
  const load = new Map<string, number>();
  const slots = new Set(busy.map((b) => `${b.channel} ${b.day}`));
  for (const { day } of busy) load.set(day, (load.get(day) ?? 0) + 1);
  const placed = chosen.map((idea, i) => ({ idea, channel: channels[(i + offset) % channels.length], target: shiftDay(today, 1 + Math.floor((i * horizonDays) / chosen.length)) }));
  const slot = new Map<Idea, { day: string; channel: (typeof channels)[number] }>();
  for (const { idea, channel, target } of [...placed].sort((a, b) => daysBetween(a.idea.earliest, a.idea.latest) - daysBetween(b.idea.earliest, b.idea.latest))) {
    // Each channel posts at one time of day, so a day is only open while one of the channels is free on it.
    const open = (day: string) => [channel, ...channels].find((c) => !slots.has(`${c} ${day}`));
    let best = idea.earliest, bestCost = Infinity;
    for (let day = idea.earliest; day <= idea.latest; day = shiftDay(day, 1)) {
      const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
      const cost = (open(day) ? 0 : 100_000) + (load.get(day) ?? 0) * 100 + Math.abs(daysBetween(day, target)) + (weekend && (open(day) ?? channel) === "LinkedIn" ? 4 : 0);
      if (cost < bestCost) { best = day; bestCost = cost; }
    }
    load.set(best, (load.get(best) ?? 0) + 1);
    const free = open(best) ?? channel;
    slots.add(`${free} ${best}`);
    slot.set(idea, { day: best, channel: free });
  }

  return placed.map(({ idea }) => {
    const { day, channel } = slot.get(idea)!;
    const when = nzTime(day, channel === "LinkedIn" ? 9 : 19, 30);
    const asset = d.assets.find((a) => idea.skus.includes(a.productSku ?? ""));
    const noImage = asset ? undefined : idea.noImage ?? "No image picked: there is no photo of this product on SharePoint, so add one before publishing.";
    const payload: SocialPostPayload = {
      type: "social_post", channel, scheduledFor: when.toISOString(), text: idea.text(channel), hashtags: [...new Set(idea.tags)].slice(0, 4),
      assetName: asset?.name, assetUrl: asset?.webUrl, campaign: idea.campaign, productSkus: idea.skus, topic: idea.topic, notBefore: idea.notBefore, notAfter: idea.notAfter,
    };
    return {
      agent: "social-media", kind: "social_post", title: `${channel}: ${idea.title}`, priority: idea.priority,
      rationale: [idea.why, idea.timing, noImage].filter(Boolean).join(" "),
      sources: [...idea.sources, ...(asset ? [{ system: "Microsoft 365", label: `SharePoint asset ${asset.name}`, ref: asset.id }] : [])],
      payload, estimate: { ...ESTIMATES.social_post },
    } satisfies Draft;
  });
}
