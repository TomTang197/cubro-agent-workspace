import fs from "node:fs";
import path from "node:path";
import { generateSystemData, STAFF, type SystemData } from "./data/seed.js";
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
  /** The person who wrote this with the assistant, by picking what the email should say. Not set on a draft an agent run made. */
  writtenBy?: string;
  /** What approving has done so far. A step that is listed is not repeated when an approval that failed part-way is tried again. */
  outcome?: { system: string; ref: string; label: string; step?: string; at?: string; by?: string }[];
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
  /** Why an agent drafted it, or `reply` / `new` for an email a person wrote with the assistant. */
  reason: "overdue" | "unconfirmed" | "low_stock" | "partial" | "reply" | "new";
  purchaseOrder?: string;
  items: string[];
  /** The reply-by date written into the body (YYYY-MM-DD), so a draft approved late can be flagged. */
  replyBy?: string;
  /** The supplier's email this one answers. It is sent as a reply in the same conversation. */
  inReplyTo?: { id: string; subject: string; from: string; receivedDateTime: string; body: string };
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
  /** Set once a real system has answered a read or a write: from then on the saved drafts and decisions may hold real records. */
  heldLive?: boolean;
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

// Bump when the shape of the sample data changes. Saved state from an older version gets new sample data; what staff did is carried over.
const STATE_VERSION = 3;
/** Records the sample data was seeded with have ids like apr-h1x; anything else was made by staff using the workspace. */
const seeded = (id: string) => /^[a-z]+-h[0-9a-z]+$/.test(id);
/** Emails, Teams posts, tasks and logged activities that approvals wrote into the sample systems (ids from nextId, e.g. 86c-mhx3k2a91). */
const written = (id: string) => /^(AAMkDraft|teams|86c|00TWs)-[0-9a-z]{9,}$/.test(id);

export class Store {
  state: WorkspaceState;
  private file?: string;

  constructor(opts: { dataDir?: string; seed?: number; today?: Date } = {}) {
    if (opts.dataDir) {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      this.file = path.join(opts.dataDir, "state.json");
    }
    const loaded = this.file && fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as WorkspaceState) : undefined;
    if (!loaded || loaded.version === STATE_VERSION) { this.state = loaded ?? Store.fresh(opts.seed, opts.today); return; }
    // The old file is kept beside the new one, so nothing is lost if the carry-over misses something.
    fs.copyFileSync(this.file!, this.file!.replace(/\.json$/, `.v${loaded.version ?? 0}.json`));
    this.state = Store.migrate(loaded, Store.fresh(opts.seed, opts.today));
    this.save();
  }

  /** New sample data, with the settings staff chose and the drafts, decisions, runs, savings and activity they made carried over. */
  static migrate(old: WorkspaceState, fresh: WorkspaceState): WorkspaceState {
    const savings = (old.savings ?? []).filter((x) => !seeded(x.id));
    const decided = new Set(savings.map((x) => x.approvalId));
    // A seeded draft that staff decided keeps its record under a new id, since the new sample data reuses the old one.
    const carried = (id: string) => (seeded(id) ? id.replace("-h", `-v${old.version ?? 0}h`) : id);
    const approvals = (old.approvals ?? []).filter((a) => !seeded(a.id) || decided.has(a.id)).map((a) => ({ ...a, id: carried(a.id) }));
    const names = new Set(STAFF.map((p) => p.name));
    const settings = structuredClone(fresh.settings);
    if (old.settings) {
      Object.assign(settings.hourlyRates, old.settings.hourlyRates);
      Object.assign(settings.social, old.settings.social);
      Object.assign(settings.supplier, old.settings.supplier, names.has(old.settings.supplier?.sender) ? {} : { sender: settings.supplier.sender });
      for (const k of Object.keys(settings.agents) as AgentId[]) {
        const was = old.settings.agents?.[k];
        if (was) Object.assign(settings.agents[k], was, names.has(was.owner) ? {} : { owner: settings.agents[k].owner });
      }
    }
    // What approvals wrote into the sample systems stays, so the links in their outcomes still lead somewhere.
    const keep = <T,>(was: T[] | undefined, now: T[], id: (x: T) => string) => [...(was ?? []).filter((x) => written(id(x))), ...now];
    const was = old.systems, systems = structuredClone(fresh.systems);
    systems.m365.messages = keep(was?.m365?.messages, systems.m365.messages, (x) => x.id);
    systems.m365.teamsPosts = keep(was?.m365?.teamsPosts, systems.m365.teamsPosts, (x) => x.id);
    systems.clickup.tasks = keep(was?.clickup?.tasks, systems.clickup.tasks, (x) => x.id);
    systems.salesforce.activities = keep(was?.salesforce?.activities, systems.salesforce.activities, (x) => x.Id);
    return {
      ...fresh, systems, settings, counters: { ...old.counters }, heldLive: old.heldLive,
      approvals: [...approvals, ...fresh.approvals],
      runs: [...(old.runs ?? []).filter((r) => !seeded(r.id)), ...fresh.runs],
      savings: [...savings.map((x) => ({ ...x, approvalId: x.approvalId && carried(x.approvalId) })), ...fresh.savings].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
      activity: [...(old.activity ?? []).filter((x) => !seeded(x.id)), ...fresh.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500),
    };
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

  reset(today = new Date(), heldLive = false) {
    this.state = Store.fresh(undefined, today);
    if (heldLive) this.state.heldLive = true;
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
