import { buildSocialDrafts, buildSupplierDrafts } from "../agents/drafts.js";
import { toApproval } from "../agents/service.js";
import { nzDate, nzTime, savingFor } from "../savings.js";
import type { ActivityEntry, AgentRun, ApprovalItem, SavingsEntry, Settings } from "../store.js";
import { addDays, createRng, isoDate } from "./rng.js";
import type { SystemData } from "./seed.js";

const REVIEWERS = { "social-media": ["Aroha Ngata", "Sophie Turner", "Liam Chen"], "supplier-outreach": ["Priya Raman", "Mark Jensen", "Hemi Walker"] } as const;
const REJECT_NOTES = ["Already spoke to them by phone", "Wrong image for this product", "Hold until the campaign is confirmed", "Supplier replied overnight", "Tone too salesy for LinkedIn"];

/** Eight weeks of past agent activity so the savings tracker and audit trail have real history. */
export function generateHistory(systems: SystemData, settings: Settings, today: Date, seed = 20261123) {
  const rng = createRng(seed + 7);
  const now = today;
  // Days are New Zealand calendar days: runs start at 7am NZ time and staff decide the same morning.
  today = new Date(nzDate(now) + "T00:00:00Z");
  const approvals: ApprovalItem[] = [];
  const runs: AgentRun[] = [];
  const savings: SavingsEntry[] = [];
  const activity: ActivityEntry[] = [];
  let n = 0;
  const id = (p: string) => `${p}-h${(++n).toString(36)}`;

  for (let day = 56; day >= 1; day--) {
    const date = addDays(today, -day);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const jobs: { agent: "social-media" | "supplier-outreach"; drafts: ReturnType<typeof buildSupplierDrafts> }[] = [];
    if (dow === 1) jobs.push({ agent: "social-media", drafts: buildSocialDrafts({ ...systems.salesforce, ...systems.inforln, ...systems.m365 }, settings, date, day) });
    // Older history is lighter: the pilot ramped up over the eight weeks.
    const supplierCount = day > 35 ? 2 : day > 14 ? 4 : 6;
    jobs.push({ agent: "supplier-outreach", drafts: buildSupplierDrafts(systems.inforln, settings, date).slice(0, supplierCount) });

    for (const job of jobs) {
      const at = nzTime(isoDate(date), job.agent === "social-media" ? 7.5 : 7).toISOString();
      const run: AgentRun = { id: id("run"), agent: job.agent, startedAt: at, finishedAt: at, triggeredBy: "Schedule", provider: "Built-in templates", itemsCreated: job.drafts.length, steps: [], summary: `${job.drafts.length} drafts for review` };
      runs.unshift(run);
      for (const d of job.drafts) {
        const a = toApproval(d, run.id, at, id("apr"));
        const by = rng.pick(REVIEWERS[job.agent]);
        const rejected = rng.chance(day > 35 ? 0.22 : 0.1);
        a.status = rejected ? "rejected" : "approved";
        a.decidedBy = by;
        a.decidedAt = new Date(new Date(at).getTime() + rng.int(20, 300) * 60_000).toISOString();
        a.edited = !rejected && rng.chance(0.35);
        if (rejected) a.reviewerNote = rng.pick(REJECT_NOTES);
        approvals.unshift(a);
        activity.unshift({ id: id("act"), at: a.decidedAt, actor: by, action: a.status, detail: a.title });
        savings.unshift({ id: id("sav"), ...savingFor(a, settings.hourlyRates[job.agent]) });
      }
    }
  }
  // Newest decision first, like the live ledger.
  savings.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  // Today's queue, waiting for staff.
  const pending: ApprovalItem[] = [];
  const runAt = new Date(Math.min(nzTime(isoDate(today), 7).getTime(), now.getTime())).toISOString();
  const sRun: AgentRun = { id: id("run"), agent: "supplier-outreach", startedAt: runAt, finishedAt: runAt, triggeredBy: "Schedule", provider: "Built-in templates", itemsCreated: 0, steps: [], summary: "" };
  const sDrafts = buildSupplierDrafts(systems.inforln, settings, today);
  sRun.itemsCreated = sDrafts.length; sRun.summary = `${sDrafts.length} supplier emails drafted for review`;
  sDrafts.forEach((d) => pending.push(toApproval(d, sRun.id, runAt, id("apr"))));
  const mRun: AgentRun = { id: id("run"), agent: "social-media", startedAt: runAt, finishedAt: runAt, triggeredBy: "Schedule", provider: "Built-in templates", itemsCreated: 0, steps: [], summary: "" };
  const mDrafts = buildSocialDrafts({ ...systems.salesforce, ...systems.inforln, ...systems.m365 }, settings, today, 0);
  mRun.itemsCreated = mDrafts.length; mRun.summary = `${mDrafts.length} posts drafted for review`;
  mDrafts.forEach((d) => pending.push(toApproval(d, mRun.id, runAt, id("apr"))));
  runs.unshift(sRun, mRun);
  approvals.unshift(...pending);
  return { approvals, runs, savings, activity };
}
