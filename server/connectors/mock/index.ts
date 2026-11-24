import type { Store } from "../../store.js";
import { baseStatus, SYSTEMS, type Env } from "../config.js";
import type { ClickUpConnector, Connectors, InforLnConnector, M365Connector, SalesforceConnector, SfObjects, SystemId } from "../types.js";

const delay = () => new Promise((r) => setTimeout(r, 5));

export function createMockConnectors(store: Store, env: Env = {}): Connectors {
  const sys = () => store.state.systems;
  const status = (system: SystemId, records: Record<string, number>) => ({ ...baseStatus(system, "mock", env), connected: true, detail: SYSTEMS[system].simulated, records });

  const m365: M365Connector = {
    async status() {
      const d = sys().m365;
      return status("m365", { "calendar events": d.events.length, emails: d.messages.length, "SharePoint files": d.assets.length, "Teams posts": d.teamsPosts.length });
    },
    async listEvents(from, to) { await delay(); return sys().m365.events.filter((e) => e.start >= from && e.start <= to); },
    async listMessages(folder) { await delay(); return sys().m365.messages.filter((m) => !folder || m.folder === folder); },
    async createDraft({ replyTo, ...msg }) {
      const answered = replyTo ? sys().m365.messages.find((m) => m.id === replyTo) : undefined;
      if (replyTo && !answered) throw new Error(`Message ${replyTo} not found`);
      const created = { ...msg, id: store.nextId("AAMkDraft"), conversationId: answered?.conversationId ?? store.nextId("conv"), receivedDateTime: new Date().toISOString(), isDraft: true, folder: "Drafts" as const, bodyPreview: msg.body.slice(0, 120) };
      sys().m365.messages.unshift(created);
      return created;
    },
    async sendDraft(id) {
      const m = sys().m365.messages.find((x) => x.id === id);
      if (!m) throw new Error(`Message ${id} not found`);
      m.isDraft = false; m.folder = "Sent Items"; m.receivedDateTime = new Date().toISOString();
      return m;
    },
    async listBrandAssets() { await delay(); return sys().m365.assets; },
    async listTeamsPosts() { await delay(); return sys().m365.teamsPosts; },
    async postTeamsMessage(channel, text) {
      const post = { id: store.nextId("teams"), channel, text, createdDateTime: new Date().toISOString() };
      sys().m365.teamsPosts.unshift(post);
      return post;
    },
  };

  const salesforce: SalesforceConnector = {
    async status() {
      const d = sys().salesforce;
      return status("salesforce", { accounts: d.accounts.length, contacts: d.contacts.length, opportunities: d.opportunities.length, campaigns: d.campaigns.length, cases: d.cases.length, "logged activities": d.activities.length });
    },
    async query<T extends keyof SfObjects>(sobject: T) {
      await delay();
      const d = sys().salesforce;
      const map: { [K in keyof SfObjects]: SfObjects[K][] } = { Account: d.accounts, Contact: d.contacts, Opportunity: d.opportunities, Campaign: d.campaigns, Case: d.cases };
      return map[sobject];
    },
    async listActivities() { await delay(); return sys().salesforce.activities; },
    async logActivity(input) {
      const Id = store.nextId("00TWs");
      sys().salesforce.activities.unshift({ Id, ...input, CreatedDate: new Date().toISOString() });
      return { Id };
    },
  };

  const clickup: ClickUpConnector = {
    async status() {
      const d = sys().clickup;
      return status("clickup", { tasks: d.tasks.length, "open tasks": d.tasks.filter((t) => t.status !== "complete").length });
    },
    async listTasks(list) { await delay(); return sys().clickup.tasks.filter((t) => !list || t.list === list); },
    async createTask(input) {
      const id = store.nextId("86c");
      const task = { ...input, id, status: input.status ?? "to do", url: `https://app.clickup.com/t/${id}` };
      sys().clickup.tasks.unshift(task);
      return task;
    },
    async updateTask(id, patch) {
      const t = sys().clickup.tasks.find((x) => x.id === id);
      if (!t) throw new Error(`Task ${id} not found`);
      Object.assign(t, patch);
      return t;
    },
  };

  const inforln: InforLnConnector = {
    async status() {
      const d = sys().inforln;
      return status("inforln", { items: d.items.length, suppliers: d.suppliers.length, "purchase orders": d.purchaseOrders.length, "open purchase orders": d.purchaseOrders.filter((p) => p.status !== "Closed" && p.status !== "Received").length });
    },
    async listItems() { await delay(); return sys().inforln.items; },
    async listSuppliers() { await delay(); return sys().inforln.suppliers; },
    async listPurchaseOrders() { await delay(); return sys().inforln.purchaseOrders; },
    async getSupplier(id) { return sys().inforln.suppliers.find((s) => s.supplier === id); },
  };

  return { m365, salesforce, clickup, inforln };
}
