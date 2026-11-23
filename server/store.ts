import fs from "node:fs";
import path from "node:path";
import { generateSystemData, type SystemData } from "./data/seed.js";
import { generateHistory } from "./data/history.js";

export type AgentId = "social-media" | "supplier-outreach";

export interface ApprovalItem {
  id: string;
  agent: AgentId;
  runId: string;
  kind: "social_post" | "supplier_email";
  title: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reviewerNote?: string;
  edited: boolean;
  priority: "high" | "normal" | "low";
  sources: { system: string; label: string; ref: string }[];
  rationale: string;
  payload: SocialPostPayload | SupplierEmailPayload;
  originalPayload: SocialPostPayload | SupplierEmailPayload;
  estimate: { manualMinutes: number; reviewMinutes: number };
  outcome?: { system: string; ref: string; label: string }[];
}

export interface SocialPostPayload {
  type: "social_post";
  channel: "LinkedIn" | "Facebook" | "Instagram";
  scheduledFor: string;
  text: string;
  hashtags: string[];
  assetName?: string;
  assetUrl?: string;
  campaign?: string;
  productSkus: string[];
  /** What the post is about (a campaign product, event, launch or customer quote), so the planner does not draft it twice. */
  topic?: string;
  /** NZ days a reviewer can move the post within: not before the product launches, not after what it promotes. */
  notBefore?: string;
  notAfter?: string;
}

export interface SupplierEmailPayload {
  type: "supplier_email";
  supplierId: string;
  supplierName: string;
  to: { name: string; address: string };
  subject: string;
  body: string;
  reason: "overdue" | "unconfirmed" | "low_stock" | "partial";
  purchaseOrder?: string;
  items: string[];
}

export interface AgentRun {
  id: string;
  agent: AgentId;
  startedAt: string;
  finishedAt: string;
  triggeredBy: string;
  provider: string;
  itemsCreated: number;
  summary: string;
  steps: { at: string; system: string; action: string; detail: string }[];
}

export interface SavingsEntry {
  id: string;
  /** New Zealand calendar day of the decision. */
  date: string;
  decidedAt: string;
  agent: AgentId;
  approvalId?: string;
  description: string;
  /** Rejected drafts are kept in the ledger: they save nothing and cost the review time. */
  outcome: "approved" | "rejected";
  edited: boolean;
  reviewer?: string;
  manualMinutes: number;
  agentAssistedMinutes: number;
  minutesSaved: number;
  hourlyRate: number;
  dollarsSaved: number;
}

export interface ActivityEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface Settings {
  hourlyRates: Record<AgentId, number>;
  agents: Record<AgentId, { enabled: boolean; schedule: string; owner: string }>;
  social: { channels: ("LinkedIn" | "Facebook" | "Instagram")[]; postsPerRun: number; horizonDays: number; tone: string };
  supplier: { lowStockCoverageWeeks: number; overdueGraceDays: number; maxEmailsPerRun: number; sender: string };
}

export interface WorkspaceState {
  version: number;
  seededAt: string;
  systems: SystemData;
  approvals: ApprovalItem[];
  runs: AgentRun[];
  savings: SavingsEntry[];
  activity: ActivityEntry[];
  settings: Settings;
  counters: Record<string, number>;
}

export const DEFAULT_SETTINGS: Settings = {
  hourlyRates: { "social-media": 42, "supplier-outreach": 46 },
  agents: {
    "social-media": { enabled: true, schedule: "Mondays 7:30am", owner: "Aroha Ngata" },
    "supplier-outreach": { enabled: true, schedule: "Weekdays 7:00am", owner: "Priya Raman" },
  },
  social: { channels: ["LinkedIn", "Facebook", "Instagram"], postsPerRun: 8, horizonDays: 14, tone: "Warm, practical and clinical-credible. NZ English." },
  supplier: { lowStockCoverageWeeks: 6, overdueGraceDays: 3, maxEmailsPerRun: 10, sender: "Priya Raman" },
};

const STATE_VERSION = 2;

export class Store {
  state: WorkspaceState;
  private file?: string;

  constructor(opts: { dataDir?: string; seed?: number; today?: Date } = {}) {
    if (opts.dataDir) {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      this.file = path.join(opts.dataDir, "state.json");
    }
    const loaded = this.file && fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as WorkspaceState) : undefined;
    this.state = loaded && loaded.version === STATE_VERSION ? loaded : Store.fresh(opts.seed, opts.today);
  }

  static fresh(seed?: number, today = new Date()): WorkspaceState {
    const systems = generateSystemData(seed, today);
    const history = generateHistory(systems, DEFAULT_SETTINGS, today, seed);
    return {
      version: STATE_VERSION,
      seededAt: today.toISOString(),
      systems,
      approvals: history.approvals,
      runs: history.runs,
      savings: history.savings,
      activity: history.activity,
      settings: structuredClone(DEFAULT_SETTINGS),
      counters: {},
    };
  }

  reset(today = new Date()) {
    this.state = Store.fresh(undefined, today);
    this.save();
  }

  nextId(prefix: string) {
    const n = (this.state.counters[prefix] ?? 0) + 1;
    this.state.counters[prefix] = n;
    return `${prefix}-${Date.now().toString(36)}${n.toString(36)}`;
  }

  log(actor: string, action: string, detail: string) {
    this.state.activity.unshift({ id: this.nextId("act"), at: new Date().toISOString(), actor, action, detail });
    this.state.activity = this.state.activity.slice(0, 500);
  }

  save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.state));
  }
}
