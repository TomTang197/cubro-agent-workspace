import type { Store } from "../../store.js";
import type { ClickUpConnector, Connectors, InforLnConnector, M365Connector, SalesforceConnector } from "../types.js";

const delay = () => new Promise((r) => setTimeout(r, 5));

export function createMockConnectors(store: Store): Connectors {
  const sys = () => store.state.systems;

  const m365: M365Connector = {
    async status() {
      const d = sys().m365;
      return { system: "m365", name: "Microsoft 365", mode: "mock", connected: true, detail: "Simulated Microsoft Graph tenant cubro.onmicrosoft.com (Outlook, Calendar, SharePoint, Teams)", records: { events: d.events.length, messages: d.messages.length, brandAssets: d.assets.length, teamsPosts: d.teamsPosts.length } };
    },
    async listEvents(from, to) { await delay(); return sys().m365.events.filter((e) => e.start >= from && e.start <= to); },
    async listMessages(folder) { await delay(); return sys().m365.messages.filter((m) => !folder || m.folder === folder); },
    async createDraft(msg) {
      const created = { ...msg, id: store.nextId("AAMkDraft"), conversationId: store.nextId("conv"), receivedDateTime: new Date().toISOString(), isDraft: true, folder: "Drafts" as const, bodyPreview: msg.body.slice(0, 120) };
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
    async postTeamsMessage(channel, text) {
      const post = { id: store.nextId("teams"), channel, text, createdDateTime: new Date().toISOString() };
      sys().m365.teamsPosts.unshift(post);
      return post;
    },
  };

  const salesforce: SalesforceConnector = {
    async status() {
      const d = sys().salesforce;
      return { system: "salesforce", name: "Salesforce", mode: "mock", connected: true, detail: "Simulated Sales Cloud org (Accounts, Opportunities, Campaigns, Cases)", records: { accounts: d.accounts.length, opportunities: d.opportunities.length, campaigns: d.campaigns.length, cases: d.cases.length, activities: d.activities.length } };
    },
    async query(sobject) {
      await delay();
      const d = sys().salesforce;
      const map = { Account: d.accounts, Opportunity: d.opportunities, Campaign: d.campaigns, Case: d.cases };
      return map[sobject] as never;
    },
    async logActivity(input) {
      const Id = store.nextId("00TWs");
      sys().salesforce.activities.unshift({ Id, ...input, CreatedDate: new Date().toISOString() });
      return { Id };
    },
  };

  const clickup: ClickUpConnector = {
    async status() {
      const d = sys().clickup;
      return { system: "clickup", name: "ClickUp", mode: "mock", connected: true, detail: "Simulated workspace \"Cubro HQ\" (Marketing, Purchasing, Operations, Sales lists)", records: { tasks: d.tasks.length, open: d.tasks.filter((t) => t.status !== "complete").length } };
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
      return { system: "inforln", name: "Infor LN", mode: "mock", connected: true, detail: "Simulated Infor LN company 100 via ION API (items, suppliers, purchase orders, inventory)", records: { items: d.items.length, suppliers: d.suppliers.length, purchaseOrders: d.purchaseOrders.length } };
    },
    async listItems() { await delay(); return sys().inforln.items; },
    async listSuppliers() { await delay(); return sys().inforln.suppliers; },
    async listPurchaseOrders() { await delay(); return sys().inforln.purchaseOrders; },
    async getSupplier(id) { return sys().inforln.suppliers.find((s) => s.supplier === id); },
  };

  return { m365, salesforce, clickup, inforln };
}
