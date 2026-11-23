import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planSupplierDrafts } from "../server/agents/drafts";
import { AgentService } from "../server/agents/service";
import { createConnectors } from "../server/connectors";
import { templateProvider } from "../server/llm";
import { Store, type SupplierEmailPayload, type WorkspaceState } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const setup = () => {
  const store = new Store({ today });
  const connectors = createConnectors(store, {});
  return { store, connectors, agents: new AgentService(store, connectors, templateProvider, () => today) };
};
const pending = (store: Store, kind: "supplier_email" | "social_post") => store.state.approvals.find((a) => a.status === "pending" && a.kind === kind)!;
const sentTo = (store: Store, subject: string) => store.state.systems.m365.messages.filter((m) => m.subject === subject && m.folder === "Sent Items");

describe("approving when a connected system fails part-way", () => {
  it("does not send the supplier email again when the follow-up task failed and the reviewer approves again", async () => {
    const { store, connectors, agents } = setup();
    const item = pending(store, "supplier_email"), subject = (item.payload as SupplierEmailPayload).subject;
    const createTask = connectors.clickup.createTask.bind(connectors.clickup);
    let fail = true;
    connectors.clickup.createTask = async (input) => { if (fail) throw new Error("ClickUp: 503 from api.clickup.com."); return createTask(input); };
    const savings = store.state.savings.length;

    await expect(agents.approve(item.id, "Priya Raman")).rejects.toThrow(/Done so far: Email sent to .*The next step failed: ClickUp: 503.*will not be repeated/);
    expect(item.status).toBe("pending");
    expect(sentTo(store, subject)).toHaveLength(1);
    expect(store.state.savings.length).toBe(savings);
    // Part of it has gone out, so it can only be finished.
    expect(() => agents.reject(item.id, "Priya Raman")).toThrow(/cannot be rejected/);
    expect(() => agents.edit(item.id, { subject: "Changed" }, "Priya Raman")).toThrow(/cannot be edited/);

    fail = false;
    const done = await agents.approve(item.id, "Priya Raman");
    expect(done.status).toBe("approved");
    expect(sentTo(store, subject)).toHaveLength(1);
    expect(done.outcome!.map((o) => o.step)).toEqual(["email", "followup"]);
    expect(store.state.savings.length).toBe(savings + 1);
  });

  it("sends the draft it already saved instead of writing a second one", async () => {
    const { store, connectors, agents } = setup();
    const item = pending(store, "supplier_email"), subject = (item.payload as SupplierEmailPayload).subject;
    const sendDraft = connectors.m365.sendDraft.bind(connectors.m365);
    let fail = true;
    connectors.m365.sendDraft = async (id) => { if (fail) throw new Error("Microsoft 365: timed out."); return sendDraft(id); };
    await expect(agents.approve(item.id, "Priya Raman")).rejects.toThrow(/saved as a draft.*not sent yet/);
    fail = false;
    await agents.approve(item.id, "Priya Raman");
    expect(store.state.systems.m365.messages.filter((m) => m.subject === subject)).toHaveLength(1);
    expect(item.outcome!.map((o) => o.label).join(" ")).not.toContain("saved as a draft");
  });

  it("does not add a second publishing task when the Teams post failed the first time", async () => {
    const { store, connectors, agents } = setup();
    const item = pending(store, "social_post");
    const postTeams = connectors.m365.postTeamsMessage.bind(connectors.m365);
    let fail = true;
    connectors.m365.postTeamsMessage = async (c, t) => { if (fail) throw new Error("Microsoft 365: webhook refused."); return postTeams(c, t); };
    const tasks = store.state.systems.clickup.tasks.length;
    await expect(agents.approve(item.id, "Aroha Ngata")).rejects.toThrow(/next step failed/);
    fail = false;
    await agents.approve(item.id, "Aroha Ngata");
    expect(store.state.systems.clickup.tasks.length).toBe(tasks + 1);
  });

  it("lets a post whose time has passed be finished once its publishing task exists", async () => {
    const store = new Store({ today });
    const connectors = createConnectors(store, {});
    let clock = today;
    const agents = new AgentService(store, connectors, templateProvider, () => clock);
    const item = pending(store, "social_post");
    const postTeams = connectors.m365.postTeamsMessage.bind(connectors.m365);
    let fail = true;
    connectors.m365.postTeamsMessage = async (c, t) => { if (fail) throw new Error("Microsoft 365: webhook refused."); return postTeams(c, t); };
    await expect(agents.approve(item.id, "Aroha Ngata")).rejects.toThrow(/next step failed/);
    clock = new Date(new Date((item.payload as { scheduledFor: string }).scheduledFor).getTime() + 3_600_000);
    fail = false;
    await agents.approve(item.id, "Aroha Ngata");
    expect(item.status).toBe("approved");
    const untouched = store.state.approvals.find((a) => a.status === "pending" && a.kind === "social_post" && new Date((a.payload as { scheduledFor: string }).scheduledFor) < clock);
    if (untouched) await expect(agents.approve(untouched.id, "Aroha Ngata")).rejects.toThrow(/has passed/);
  });

  it("dates the follow-up from the day the email went when the approval is finished later", async () => {
    const { store, connectors, agents } = setup();
    const item = pending(store, "supplier_email");
    const createTask = connectors.clickup.createTask.bind(connectors.clickup);
    let fail = true;
    connectors.clickup.createTask = async (input) => { if (fail) throw new Error("ClickUp: 503 from api.clickup.com."); return createTask(input); };
    await expect(agents.approve(item.id, "Priya Raman")).rejects.toThrow(/next step failed/);
    item.outcome!.find((o) => o.step === "email")!.at = "2026-11-02T21:00:00Z"; // Tuesday 3 November, 10am in New Zealand
    fail = false;
    await agents.approve(item.id, "Priya Raman");
    const task = store.state.systems.clickup.tasks[0];
    expect(task.description).toContain("on 3 November 2026");
    expect(task.due_date).toBe("2026-11-06");
  });

  it("lets only one of two approvals at the same moment through", async () => {
    const { store, agents } = setup();
    const item = pending(store, "supplier_email"), subject = (item.payload as SupplierEmailPayload).subject;
    const savings = store.state.savings.length;
    const results = await Promise.allSettled([agents.approve(item.id, "Priya Raman"), agents.approve(item.id, "Mark Jensen")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.status).toBe(409);
    expect(sentTo(store, subject)).toHaveLength(1);
    expect(store.state.savings.length).toBe(savings + 1);
  });
});

describe("supplier outreach when Infor LN has no supplier record", () => {
  it("skips that supplier's orders and stock and still drafts the rest", () => {
    const { store } = setup();
    const { inforln } = store.state.systems, settings = { ...store.state.settings, supplier: { ...store.state.settings.supplier, maxEmailsPerRun: 999 } };
    const full = planSupplierDrafts(inforln, settings, today).drafts.map((d) => d.payload as SupplierEmailPayload);
    const gone = full[0].supplierId;
    const plan = planSupplierDrafts({ ...inforln, suppliers: inforln.suppliers.filter((s) => s.supplier !== gone) }, settings, today);
    const left = plan.drafts.map((d) => d.payload as SupplierEmailPayload);
    expect(left.length).toBe(full.filter((p) => p.supplierId !== gone).length);
    expect(left.length).toBeGreaterThan(0);
    expect(left.some((p) => p.supplierId === gone)).toBe(false);
  });
});

describe("saved workspace from before a sample data change", () => {
  it("gets the new sample data and keeps what staff did, with the old file left beside it", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cubro-state-"));
    const first = new Store({ dataDir, today });
    const agents = new AgentService(first, createConnectors(first, {}), templateProvider, () => today);
    const approved = pending(first, "supplier_email"), rejected = pending(first, "social_post");
    await agents.approve(approved.id, "Priya Raman", "Sent as written");
    agents.reject(rejected.id, "Aroha Ngata", "Wrong week");
    await agents.run("social-media", "Aroha Ngata");
    first.state.settings.hourlyRates["supplier-outreach"] = 71;
    first.state.settings.agents["social-media"].owner = "Someone Who Left";
    const mine = { runs: first.state.runs.filter((r) => !/-h/.test(r.id)).length, drafts: first.state.approvals.filter((a) => !/^apr-h/.test(a.id)).length };
    expect(mine).toMatchObject({ runs: 1 });
    expect(mine.drafts).toBeGreaterThan(0);
    const old: WorkspaceState = { ...first.state, version: 2 };
    old.systems = { ...old.systems, inforln: { ...old.systems.inforln, items: [] } };
    fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify(old));

    const { state } = new Store({ dataDir, today });
    expect(state.version).toBeGreaterThan(2);
    expect(state.systems.inforln.items.length).toBeGreaterThan(100);
    expect(state.settings.hourlyRates["supplier-outreach"]).toBe(71);
    expect(state.settings.agents["social-media"].owner).not.toBe("Someone Who Left");
    const kept = state.approvals.find((a) => a.title === approved.title && a.decidedBy === "Priya Raman")!;
    expect(kept).toMatchObject({ status: "approved", reviewerNote: "Sent as written" });
    expect(state.approvals.find((a) => a.decidedBy === "Aroha Ngata" && a.reviewerNote === "Wrong week")).toMatchObject({ status: "rejected" });
    expect(state.savings.find((x) => x.approvalId === kept.id)).toBeTruthy();
    expect(state.runs.filter((r) => !/-h/.test(r.id))).toHaveLength(1);
    expect(state.approvals.filter((a) => !/^apr-h/.test(a.id) && !/^apr-v2h/.test(a.id))).toHaveLength(mine.drafts);
    expect(new Set(state.approvals.map((a) => a.id)).size).toBe(state.approvals.length);
    expect(state.activity.some((x) => x.actor === "Priya Raman" && x.action === "approved" && x.detail === approved.title)).toBe(true);
    // The email and follow-up task that approval made are still in the sample systems, once each.
    const [email, followUp] = kept.outcome!;
    expect(state.systems.m365.messages.filter((m) => m.id === email.ref)).toMatchObject([{ folder: "Sent Items" }]);
    expect(state.systems.clickup.tasks.filter((t) => t.url === followUp.ref)).toHaveLength(1);
    expect(state.systems.clickup.tasks.length).toBe(new Store({ today }).state.systems.clickup.tasks.length + 1);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "state.v2.json"), "utf8")).version).toBe(2);
    // Loading again changes nothing.
    expect(new Store({ dataDir, today }).state.approvals.length).toBe(state.approvals.length);
  });
});
