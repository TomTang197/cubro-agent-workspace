import type { AgentId, ApprovalItem, SavingsEntry } from "./store.js";

/** Extra minutes counted when the reviewer rewrites part of a draft. */
export const EDIT_MINUTES = 4;

const NZ_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Auckland", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function nzWallClock(t: number) {
  const p = Object.fromEntries(NZ_PARTS.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, asUtc: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) };
}

/** The calendar date in New Zealand, which is the day staff see on their own clock. */
export const nzDate = (d: Date | string) => nzWallClock(new Date(d).getTime()).date;

/** The instant at which it is `hour` o'clock in New Zealand on `date`. */
export function nzTime(date: string, hour: number) {
  const wall = Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000;
  const guess = wall - 12 * 3_600_000;
  return new Date(wall - (nzWallClock(guess).asUtc - guess));
}

export const addDaysIso = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const weekStart = (date: string) => addDaysIso(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
/** First day of a period of `days` calendar days ending today. */
export const periodStart = (today: string, days: number) => addDaysIso(today, -(days - 1));

/**
 * The ledger line for one decision. Approved: the job by hand minus the review (and any edits).
 * Rejected: nothing was saved, and the review time is a cost.
 */
export function savingFor(a: Pick<ApprovalItem, "id" | "agent" | "title" | "status" | "edited" | "estimate" | "decidedAt" | "decidedBy">, hourlyRate: number): Omit<SavingsEntry, "id"> {
  const approved = a.status === "approved";
  const manualMinutes = approved ? a.estimate.manualMinutes : 0;
  const agentAssistedMinutes = a.estimate.reviewMinutes + (a.edited ? EDIT_MINUTES : 0);
  const minutesSaved = manualMinutes - agentAssistedMinutes;
  // Settings are free-form input; the ledger and its export only ever hold a number.
  hourlyRate = Number.isFinite(Number(hourlyRate)) ? Number(hourlyRate) : 0;
  return {
    date: nzDate(a.decidedAt ?? new Date()), agent: a.agent, approvalId: a.id, description: a.title,
    outcome: approved ? "approved" : "rejected", edited: a.edited, reviewer: a.decidedBy,
    manualMinutes, agentAssistedMinutes, minutesSaved, hourlyRate, dollarsSaved: Math.round((minutesSaved / 60) * hourlyRate * 100) / 100,
  };
}

export interface SavingsLine {
  approved: number;
  rejected: number;
  /** How long the approved jobs take by hand. */
  manualMinutes: number;
  /** Reviewing and editing the approved drafts. */
  reviewMinutes: number;
  /** Reviewing drafts that were rejected. */
  rejectedMinutes: number;
  /** manualMinutes - reviewMinutes - rejectedMinutes */
  minutesSaved: number;
  dollarsSaved: number;
  hourlyRates: number[];
}

/** One set of sums for every screen and the export, so the same filter always gives the same figures. */
export function summarise(entries: SavingsEntry[]): SavingsLine {
  const l: SavingsLine = { approved: 0, rejected: 0, manualMinutes: 0, reviewMinutes: 0, rejectedMinutes: 0, minutesSaved: 0, dollarsSaved: 0, hourlyRates: [] };
  let cents = 0;
  for (const e of entries) {
    if (e.outcome === "rejected") { l.rejected++; l.rejectedMinutes += e.agentAssistedMinutes; }
    else { l.approved++; l.manualMinutes += e.manualMinutes; l.reviewMinutes += e.agentAssistedMinutes; }
    l.minutesSaved += e.minutesSaved;
    cents += Math.round(e.dollarsSaved * 100);
    if (!l.hourlyRates.includes(e.hourlyRate)) l.hourlyRates.push(e.hourlyRate);
  }
  l.dollarsSaved = cents / 100;
  l.hourlyRates.sort((a, b) => a - b);
  return l;
}

export const AGENT_IDS: AgentId[] = ["social-media", "supplier-outreach"];
export const AGENT_NAMES: Record<AgentId, string> = { "social-media": "Social Media Planner", "supplier-outreach": "Supplier Outreach" };
export const TEAMS: Record<AgentId, string> = { "social-media": "Marketing", "supplier-outreach": "Purchasing" };
export const decisionLabel = (e: SavingsEntry) => (e.outcome === "rejected" ? "Rejected" : e.edited ? "Approved after edits" : "Approved");

/** Excel opens this as a table: UTF-8 with a byte-order mark, and text that looks like a formula is escaped. */
export function savingsCsv(entries: SavingsEntry[]) {
  const text = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  const rows = entries.map((e) => [e.date, text(AGENT_NAMES[e.agent]), text(TEAMS[e.agent]), text(e.description), text(decisionLabel(e)), text(e.reviewer ?? ""), ...[e.manualMinutes, e.agentAssistedMinutes, e.minutesSaved, e.hourlyRate].map(Number), Number(e.dollarsSaved).toFixed(2)].join(","));
  return "\uFEFF" + ["Date,Agent,Team,Work,Decision,Reviewed by,By hand (min),With agent (min),Saved (min),Hourly cost (NZD),Saved (NZD)", ...rows].join("\r\n") + "\r\n";
}
