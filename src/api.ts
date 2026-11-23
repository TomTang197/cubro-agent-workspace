import type { AgentRun, ApprovalItem, SavingsEntry, Settings, ActivityEntry, AgentId } from "../server/store";
import type { ConnectorStatus } from "../server/connectors/types";
import type { SavingsLine } from "../server/savings";
export type { AgentRun, ApprovalItem, SavingsEntry, Settings, ActivityEntry, AgentId, ConnectorStatus, SavingsLine };

let currentUser = localStorage.getItem("cubro-user") ?? "Aroha Ngata";
export const getUser = () => currentUser;
export const setUser = (u: string) => { currentUser = u; localStorage.setItem("cubro-user", u); };

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", "x-cubro-user": currentUser },
    body: init?.body ? JSON.stringify({ user: currentUser, ...(init.body as object) }) : init?.method && init.method !== "GET" ? JSON.stringify({ user: currentUser }) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

export interface AgentSummary {
  id: AgentId; name: string; description: string; team: string; reads: string[]; writes: string[];
  enabled: boolean; schedule: string; owner: string; pending: number; approvalRate: number; editRate: number;
  saved: SavingsLine; lastRun?: AgentRun;
}
export interface Dashboard {
  totals: {
    pending: number; highPriority: number; decided: number; approved: number; rejected: number; approvalRate: number;
    all: SavingsLine; last30: SavingsLine; pilotStart: string; since30: string; currentWeek: string;
  };
  weekly: { week: string; "social-media": number; "supplier-outreach": number; dollars: number }[];
  agents: AgentSummary[];
  activity: ActivityEntry[];
  provider: string;
}

export const nzd = (n: number) => n.toLocaleString("en-NZ", { style: "currency", currency: "NZD", maximumFractionDigits: 0 });
/** Money to the cent, so rows, agents and totals add up exactly. */
export const money = (n: number) => n.toLocaleString("en-NZ", { style: "currency", currency: "NZD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/^-/, "\u2212");
/** Whole minutes as "63 h 5 min": exact, so parts add up to the total. */
export const hm = (minutes: number) => {
  const m = Math.abs(Math.round(minutes));
  const text = m < 60 ? `${m} min` : `${Math.floor(m / 60).toLocaleString("en-NZ")} h ${m % 60} min`;
  return minutes < 0 ? `\u2212${text}` : text;
};
export const shortDay = (iso: string) => day(iso).replace(/ \d{4}$/, "");
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const when = (iso: string) => new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Pacific/Auckland" });
export const day = (iso: string) => new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "Pacific/Auckland" });
export const AGENT_NAMES: Record<AgentId, string> = { "social-media": "Social Media Planner", "supplier-outreach": "Supplier Outreach" };
export const STAFF = ["Aroha Ngata", "Sophie Turner", "Liam Chen", "Priya Raman", "Mark Jensen", "Hemi Walker"];
