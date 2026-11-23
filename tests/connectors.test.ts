import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import type { FetchLike } from "../server/connectors/config";
import { createLiveClickUp, createLiveInforLn, createLiveM365, createLiveSalesforce } from "../server/connectors/live";
import { templateProvider } from "../server/llm";
import { Store } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Route = (call: Call) => unknown;

/** Stands in for the real systems: answers by URL fragment and records every request. */
function fakeFetch(routes: [string, Route][]) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url: decodeURIComponent(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") };
    calls.push(call);
    const route = routes.find(([fragment]) => call.url.includes(fragment));
    if (!route) return new Response(JSON.stringify({ error: `no route for ${call.url}` }), { status: 404 });
    const out = route[1](call);
    return out instanceof Response ? out : new Response(out === undefined ? "" : JSON.stringify(out), { status: 200 });
  };
  return { fetchImpl, calls };
}
const noNetwork: FetchLike = async (url) => { throw new Error(`unexpected request to ${url}`); };
const signIn = `Basic ${Buffer.from("anyone:kōwhai-42").toString("base64")}`;
/** A workspace with a sign-in password, and every request already signed in, unless the test is about signing in. */
const app = (env: Record<string, string>, fetchImpl: FetchLike = noNetwork, password: string | null = "kōwhai-42") => {
  const inner = createApp(new Store({ today }), { llm: templateProvider, env: { ...env, ...(password ? { WORKSPACE_PASSWORD: password } : {}) }, fetch: fetchImpl });
  return password ? express().use((req, _res, next) => { req.headers.authorization ??= signIn; next(); }).use(inner) : inner;
};

const SF = { SALESFORCE_INSTANCE_URL: "https://cubro.my.salesforce.test/", SALESFORCE_CLIENT_ID: "id", SALESFORCE_CLIENT_SECRET: "sf-secret-value" };
const CU = { CLICKUP_API_TOKEN: "pk_test", CLICKUP_LISTS: '{"Marketing":"901","Purchasing":"902"}', CLICKUP_USERS: '{"Priya Raman":4411}' };
const MS = {
  M365_TENANT_ID: "tenant", M365_CLIENT_ID: "id", M365_CLIENT_SECRET: "secret", M365_MAILBOX: "purchasing@cubro.co.nz", M365_CALENDAR_USER: "marketing@cubro.co.nz",
  M365_SHAREPOINT_SITE_ID: "site1", M365_TEAMS_TEAM_ID: "team1", M365_TEAMS_CHANNELS: '{"Marketing":"19:abc"}', M365_TEAMS_WEBHOOKS: '{"Marketing":"https://flows.test/hook"}',
};
const LN = {
  INFORLN_ION_URL: "https://ion.test/CUBRO_PRD/", INFORLN_TOKEN_URL: "https://sso.test/token", INFORLN_CLIENT_ID: "ci", INFORLN_CLIENT_SECRET: "cs", INFORLN_SERVICE_ACCOUNT_KEY: "saak", INFORLN_SERVICE_ACCOUNT_SECRET: "sask",
  INFORLN_COMPANY: "100", INFORLN_ITEMS_PATH: "LN/odata/Items", INFORLN_SUPPLIERS_PATH: "LN/odata/Suppliers", INFORLN_PURCHASE_ORDERS_PATH: "LN/odata/Orders",
};
const token: [string, Route] = ["token", () => ({ access_token: "tok", expires_in: 3600 })];

describe("connected systems API", () => {
  it("describes each simulated system and what going live needs, without exposing values", async () => {
    const res = await request(app({ SALESFORCE_CLIENT_SECRET: "sf-secret-value" })).get("/api/systems").expect(200);
    expect(res.body.map((s: { system: string }) => s.system)).toEqual(["m365", "salesforce", "clickup", "inforln"]);
    for (const s of res.body) {
      expect(s).toMatchObject({ mode: "mock", connected: true });
      expect(s.api.length).toBeGreaterThan(10);
      expect(s.settings.some((x: { required: boolean }) => x.required)).toBe(true);
      expect(Object.values(s.records).every((n) => (n as number) > 0)).toBe(true);
    }
    const secret = res.body[1].settings.find((x: { key: string }) => x.key === "SALESFORCE_CLIENT_SECRET");
    expect(secret.set).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sf-secret-value");
  });

  it("serves every resource the page shows, including contacts, Teams posts and logged activity", async () => {
    const a = app({});
    for (const path of ["m365/events", "m365/messages", "m365/assets", "m365/teams", "salesforce/accounts", "salesforce/contacts", "salesforce/opportunities", "salesforce/campaigns", "salesforce/cases", "salesforce/activities", "clickup/tasks", "inforln/items", "inforln/suppliers", "inforln/purchase-orders"]) {
      const res = await request(a).get(`/api/systems/${path}`).expect(200);
      expect(res.body.length, path).toBeGreaterThan(0);
    }
    await request(a).get("/api/systems/salesforce/leads").expect(404);
    await request(a).get("/api/systems/inforln/warehouses").expect(404);
  });

  it("reports a live system with missing settings on its own card and keeps the others working", async () => {
    const a = app({ CONNECTOR_SALESFORCE: "live", SALESFORCE_INSTANCE_URL: "https://cubro.my.salesforce.test" });
    const res = await request(a).get("/api/systems").expect(200);
    const sf = res.body[1];
    expect(sf).toMatchObject({ system: "salesforce", mode: "live", connected: false, records: {} });
    expect(sf.error).toContain("SALESFORCE_CLIENT_ID");
    expect(sf.error).toContain("SALESFORCE_CLIENT_SECRET");
    expect(sf.error).not.toContain("SALESFORCE_INSTANCE_URL");
    expect(res.body.filter((s: { connected: boolean }) => s.connected).map((s: { system: string }) => s.system)).toEqual(["m365", "clickup", "inforln"]);
    const records = await request(a).get("/api/systems/salesforce/accounts").expect(502);
    expect(records.body.error).toContain("Salesforce: Not set up yet");
    await request(a).get("/api/systems/inforln/items").expect(200);
  });

  it("says a live system is not set up on every record tab, never an empty list", async () => {
    const a = app({ CONNECTOR_M365: "live", CONNECTOR_SALESFORCE: "live", CONNECTOR_CLICKUP: "live", CONNECTOR_INFORLN: "live" });
    for (const path of ["m365/events", "m365/messages", "m365/assets", "m365/teams", "salesforce/accounts", "salesforce/activities", "clickup/tasks", "inforln/items", "inforln/suppliers", "inforln/purchase-orders"]) {
      const res = await request(a).get(`/api/systems/${path}`);
      expect(res.status, path).toBe(502);
      expect(res.body.error, path).toContain("Not set up yet");
    }
  });

  it("asks for the workspace password before serving anything, once one is set", async () => {
    const a = createApp(new Store({ today }), { llm: templateProvider, env: { WORKSPACE_PASSWORD: "kōwhai-42" }, fetch: noNetwork });
    const refused = await request(a).get("/api/systems/salesforce/accounts").expect(401);
    expect(refused.headers["www-authenticate"]).toContain("Basic");
    expect(JSON.stringify(refused.body)).not.toContain("Hospital");
    await request(a).post("/api/approvals/any/approve").send({ user: "Priya Raman" }).expect(401);
    await request(a).get("/api/systems").set("authorization", `Basic ${Buffer.from("priya:wrong").toString("base64")}`).expect(401);
    await request(a).get("/api/health").expect(200);
    const ok = await request(a).get("/api/systems/salesforce/accounts").set("authorization", signIn).expect(200);
    expect(ok.body.length).toBeGreaterThan(0);
  });

  it("does not ask for the password over an unencrypted connection", async () => {
    const a = createApp(new Store({ today }), { llm: templateProvider, env: { WORKSPACE_PASSWORD: "kōwhai-42" }, fetch: noNetwork });
    const plain = await request(a).get("/api/systems").set("x-forwarded-proto", "http").set("authorization", signIn).expect(403);
    expect(plain.headers["www-authenticate"]).toBeUndefined();
    expect(plain.body.error).toContain("https");
    expect((await request(a).get("/").set("x-forwarded-proto", "http").expect(403)).text).toContain("https");
    await request(a).get("/api/systems").set("x-forwarded-proto", "https").expect(401);
    await request(a).get("/api/systems").set("x-forwarded-proto", "https").set("authorization", signIn).expect(200);
  });

  it("does not connect a real system while the workspace has no password", async () => {
    const { fetchImpl, calls } = fakeFetch([token]);
    const a = app({ CONNECTOR_SALESFORCE: "live", ...SF }, fetchImpl, null);
    const res = await request(a).get("/api/systems").expect(200);
    expect(res.body[1]).toMatchObject({ system: "salesforce", mode: "live", connected: false });
    expect(res.body[1].error).toContain("WORKSPACE_PASSWORD");
    expect((await request(a).get("/api/systems/salesforce/accounts").expect(502)).body.error).toContain("no sign-in password");
    expect((await request(a).post("/api/systems/salesforce/test").send({}).expect(200)).body.connected).toBe(false);
    expect(calls).toHaveLength(0);
    await request(a).get("/api/systems/inforln/items").expect(200);
  });

  it("stays closed if the password is taken away after a real system was connected", async () => {
    const store = new Store({ today });
    const { fetchImpl } = fakeFetch([token]);
    const make = (env: Record<string, string>) => createApp(store, { llm: templateProvider, env, fetch: fetchImpl });
    await request(make({ CONNECTOR_SALESFORCE: "live", ...SF, WORKSPACE_PASSWORD: "kōwhai-42" })).get("/api/approvals").set("authorization", signIn).expect(200);
    // Restarted without the password, with or without the live switch: the saved drafts are not served.
    for (const env of [{}, { CONNECTOR_SALESFORCE: "live", ...SF }]) {
      const res = await request(make(env)).get("/api/approvals").expect(503);
      expect(res.body.error).toContain("WORKSPACE_PASSWORD");
      expect(JSON.stringify(res.body)).not.toContain("payload");
      await request(make(env)).post("/api/reset").send({}).expect(503);
      await request(make(env)).get("/api/health").expect(200);
    }
    await request(make({ WORKSPACE_PASSWORD: "kōwhai-42" })).get("/api/approvals").set("authorization", signIn).expect(200);
    // A workspace that never had a real system connected stays open without a password.
    await request(createApp(new Store({ today }), { llm: templateProvider, env: {}, fetch: noNetwork })).get("/api/approvals").expect(200);
  });

  it("reports a live system that rejects the credentials without failing the page", async () => {
    const { fetchImpl } = fakeFetch([["/services/oauth2/token", () => new Response('{"error":"invalid_client"}', { status: 401 })]]);
    const res = await request(app({ CONNECTOR_SALESFORCE: "live", ...SF }, fetchImpl)).get("/api/systems").expect(200);
    expect(res.body[1]).toMatchObject({ mode: "live", connected: false });
    expect(res.body[1].error).toContain("401");
    expect(res.body[1].error).toContain("credentials were rejected");
  });

  it("tests one connection on request and logs who ran it", async () => {
    const store = new Store({ today });
    const a = createApp(store, { llm: templateProvider, env: {}, fetch: noNetwork });
    const res = await request(a).post("/api/systems/inforln/test").send({ user: "Hemi Walker" }).expect(200);
    expect(res.body).toMatchObject({ system: "inforln", mode: "mock", connected: true });
    expect(store.state.activity[0]).toMatchObject({ actor: "Hemi Walker", action: "tested connection" });
    await request(a).post("/api/systems/sap/test").send({}).expect(404);
  });
});

describe("live Salesforce connector", () => {
  const account = { Id: "001000000000001AAA", Name: "Radius Care", Type: "Aged Care", BillingCity: "Tauranga", Phone: null, Owner: { Name: "Rachel Stewart" }, Sales_Region__c: "Bay of Plenty", AnnualSpend__c: 120000, Market__c: "Aged Care" };
  it("signs in once, follows result pages and maps custom fields", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["/services/oauth2/token", token[1]],
      ["/query/next-page", () => ({ totalSize: 2, done: true, records: [{ ...account, Id: "001000000000002AAA", Name: "Summerset" }] })],
      ["FROM Account", () => ({ totalSize: 2, done: false, nextRecordsUrl: "/services/data/v61.0/query/next-page", records: [account] })],
      ["FROM Opportunity", () => ({ totalSize: 1, done: true, records: [{ Id: "006000000000001AAA", Name: "Bed replacement", AccountId: account.Id, StageName: "Proposal", Amount: 50000, CloseDate: "2027-01-20", CreatedDate: "2026-10-01T02:00:00.000+0000", Owner: { Name: "Rachel Stewart" }, ProductSkus__c: "98100; 1951" }] })],
    ]);
    const sf = createLiveSalesforce({ ...SF, SALESFORCE_FIELDS: '{"Account.Region":"Sales_Region__c"}' }, fetchImpl);
    const accounts = await sf.query("Account");
    expect(accounts.map((a) => a.Name)).toEqual(["Radius Care", "Summerset"]);
    expect(accounts[0]).toMatchObject({ Region: "Bay of Plenty", AnnualSpend__c: 120000, OwnerName: "Rachel Stewart", Market__c: "Aged Care" });
    const [opp] = await sf.query("Opportunity");
    expect(opp).toMatchObject({ ProductSkus: ["98100", "1951"], CloseDate: "2027-01-20", CreatedDate: "2026-10-01" });
    expect(calls.filter((c) => c.url.includes("/oauth2/token"))).toHaveLength(1);
    expect(calls[0].body).toContain("grant_type=client_credentials");
    expect(calls[1].url).toContain("https://cubro.my.salesforce.test/services/data/v61.0/query?q=SELECT");
    expect(calls[1].url).toContain("Sales_Region__c");
    expect(calls[1].headers.authorization).toBe("Bearer tok");
  });
  it("logs approved work as a completed Task and reports record counts", async () => {
    const { fetchImpl, calls } = fakeFetch([token, ["/sobjects/Task", () => ({ id: "00T000000000001AAA", success: true })], ["COUNT()", () => ({ totalSize: 42, done: true, records: [] })]]);
    const sf = createLiveSalesforce(SF, fetchImpl);
    expect(await sf.logActivity({ WhatId: "701000000000001AAA", Subject: "Post approved", Description: "LinkedIn" })).toEqual({ Id: "00T000000000001AAA" });
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ WhatId: "701000000000001AAA", Status: "Completed" });
    const status = await sf.status();
    expect(status).toMatchObject({ mode: "live", connected: true, records: { accounts: 42, cases: 42 } });
    expect(status.detail).toContain("cubro.my.salesforce.test");
    expect(calls.some((c) => c.url.includes("SELECT COUNT() FROM Task"))).toBe(true);
  });
});

describe("live ClickUp connector", () => {
  it("reads every page of each list and maps statuses, dates and priority", async () => {
    const task = (id: string, status: string, type = "custom") => ({ id, name: `Task ${id}`, text_content: "Chase supplier", status: { status, type }, assignees: [{ username: "Priya Raman" }], tags: [{ name: "po" }], due_date: String(Date.parse("2026-11-26T11:00:00Z")), priority: { priority: "high" }, url: `https://app.clickup.com/t/${id}` });
    const { fetchImpl, calls } = fakeFetch([
      ["/list/902/task?page=0", () => ({ tasks: [task("a", "In Review"), task("b", "Closed", "closed")], last_page: false })],
      ["/list/902/task?page=1", () => ({ tasks: [task("c", "Open")], last_page: true })],
      ["/list/901/task", () => ({ tasks: [], last_page: true })],
    ]);
    const tasks = await createLiveClickUp(CU, fetchImpl).listTasks();
    expect(tasks.map((t) => [t.id, t.list, t.status])).toEqual([["a", "Purchasing", "review"], ["b", "Purchasing", "complete"], ["c", "Purchasing", "to do"]]);
    // 11:00 UTC on the 26th is already the 27th in New Zealand.
    expect(tasks[0]).toMatchObject({ due_date: "2026-11-27", priority: "high", assignees: ["Priya Raman"], tags: ["po"], description: "Chase supplier" });
    expect(calls.every((c) => c.headers.authorization === "pk_test")).toBe(true);
  });
  it("creates a task in the right list with the mapped assignee", async () => {
    const { fetchImpl, calls } = fakeFetch([["/list/902/task", () => ({ id: "86cx1", name: "Follow up PO41783", status: { status: "to do" }, url: "https://app.clickup.com/t/86cx1" })]]);
    const cu = createLiveClickUp(CU, fetchImpl);
    const created = await cu.createTask({ name: "Follow up PO41783", description: "Reply due", list: "Purchasing", assignees: ["Priya Raman"], due_date: "2026-11-27", tags: ["supplier-outreach"] });
    expect(created).toMatchObject({ id: "86cx1", list: "Purchasing", status: "to do", assignees: ["Priya Raman"], url: "https://app.clickup.com/t/86cx1" });
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toMatchObject({ name: "Follow up PO41783", assignees: [4411], tags: ["supplier-outreach"] });
    // The due date is sent as a time that is the 27th in New Zealand and everywhere west of it, not midnight UTC.
    const due = JSON.parse(calls[0].body).due_date;
    expect(new Date(due).toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" })).toBe("2026-11-27");
    expect(new Date(due).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })).toBe("2026-11-26");
    expect(new Date(due).toISOString()).toBe("2026-11-27T05:00:00.000Z");
    await expect(cu.createTask({ name: "x", description: "", list: "Sales", assignees: [], due_date: null, tags: [] })).rejects.toThrow("No list ID is set for the Sales list");
  });
});

describe("live Microsoft 365 connector", () => {
  const message = { id: "AAMk1", conversationId: "c1", from: { emailAddress: { name: "Helen Wu", address: "helen@supplier.co.nz" } }, toRecipients: [{ emailAddress: { name: "Purchasing", address: "purchasing@cubro.co.nz" } }], subject: "RE: PO41783", bodyPreview: "Confirmed", body: { content: "Confirmed for 27 January." }, receivedDateTime: "2026-11-22T22:12:00Z", isDraft: false };
  it("reads the shared mailbox and calendar and maps Outlook categories", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["oauth2/v2.0/token", token[1]],
      ["/mailFolders/inbox/messages", () => ({ value: [message] })],
      ["/calendarView", () => ({ value: [
        { id: "e1", subject: "NZACA conference", start: { dateTime: "2026-12-01T20:00:00.0000000" }, end: { dateTime: "2026-12-02T04:00:00.0000000" }, location: { displayName: "Te Pae, Christchurch" }, categories: ["Trade Show"], organizer: { emailAddress: { name: "Aroha Ngata" } } },
        { id: "e2", subject: "Dentist", start: { dateTime: "2026-12-02T01:00:00.0000000" }, end: { dateTime: "2026-12-02T02:00:00.0000000" } },
      ] })],
    ]);
    const m365 = createLiveM365(MS, fetchImpl);
    const inbox = await m365.listMessages("Inbox");
    expect(inbox).toEqual([{ id: "AAMk1", conversationId: "c1", from: { name: "Helen Wu", address: "helen@supplier.co.nz" }, to: [{ name: "Purchasing", address: "purchasing@cubro.co.nz" }], subject: "RE: PO41783", bodyPreview: "Confirmed", body: "Confirmed for 27 January.", receivedDateTime: "2026-11-22T22:12:00.000Z", isDraft: false, folder: "Inbox" }]);
    const events = await m365.listEvents("2026-11-23T00:00:00.000Z", "2026-12-07T00:00:00.000Z");
    expect(events.map((e) => [e.category, e.start, e.location, e.organizer])).toEqual([["Trade show", "2026-12-01T20:00:00.000Z", "Te Pae, Christchurch", "Aroha Ngata"], ["Internal", "2026-12-02T01:00:00.000Z", "", ""]]);
    expect(calls.filter((c) => c.url.includes("oauth2/v2.0/token"))).toHaveLength(1);
    expect(calls[1].url).toContain("/users/purchasing@cubro.co.nz/mailFolders/inbox/messages");
    expect(calls.at(-1)!.url).toContain("/users/marketing@cubro.co.nz/calendarView");
  });
  it("sends an approved email from the shared mailbox but never to a sample-data address", async () => {
    const draft = { ...message, id: "AAMkDraft", isDraft: true, from: undefined, toRecipients: [{ emailAddress: { name: "Helen Wu", address: "helen@supplier.co.nz" } }], subject: "PO41783 delivery date" };
    const { fetchImpl, calls } = fakeFetch([token, ["/messages/AAMkDraft/send", () => undefined], ["/messages", () => draft]]);
    const m365 = createLiveM365(MS, fetchImpl);
    const created = await m365.createDraft({ from: { name: "Priya Raman", address: "purchasing@cubro.co.nz" }, to: [{ name: "Helen Wu", address: "helen@supplier.co.nz" }], subject: "PO41783 delivery date", body: "Hi Helen" });
    expect(created).toMatchObject({ id: "AAMkDraft", isDraft: true, folder: "Drafts" });
    expect(JSON.parse(calls[1].body)).toMatchObject({ subject: "PO41783 delivery date", toRecipients: [{ emailAddress: { address: "helen@supplier.co.nz" } }] });
    const sent = await m365.sendDraft(created.id);
    expect(sent).toMatchObject({ id: "AAMkDraft", isDraft: false, folder: "Sent Items" });
    expect(calls.at(-1)).toMatchObject({ method: "POST" });
    expect(calls.at(-1)!.url).toContain("/users/purchasing@cubro.co.nz/messages/AAMkDraft/send");
    const before = calls.length;
    await expect(m365.createDraft({ from: created.from, to: [{ name: "Kevin Zhao", address: "kevin@shunde-carefurniture.example.cn" }], subject: "x", body: "y" })).rejects.toThrow("sample-data address");
    expect(calls.length).toBe(before);
  });
  it("tries the mailbox, calendar, every Teams channel and the brand library in the connection check", async () => {
    const routes: [string, Route][] = [
      ["oauth2/v2.0/token", token[1]],
      ["/mailFolders/inbox/messages", () => ({ value: [message], "@odata.count": 318 })],
      ["/calendarView", () => ({ value: [] })],
      ["/channels/19:abc/messages", () => ({ value: [] })],
      ["/drive/root:/Brand/Photos:/children", () => ({ value: [{ id: "f1", name: "a.jpg", file: {} }] })],
    ];
    const good = fakeFetch(routes);
    const status = await createLiveM365({ ...MS, M365_SHAREPOINT_FOLDER: "/Brand/Photos/" }, good.fetchImpl).status();
    expect(status).toMatchObject({ connected: true, records: { "inbox emails": 318, "Teams channels": 1 } });
    expect(status.detail).toContain("marketing@cubro.co.nz");
    for (const part of ["/users/purchasing@cubro.co.nz/mailFolders/inbox", "/users/marketing@cubro.co.nz/calendarView", "/teams/team1/channels/19:abc/messages", "/sites/site1/drive/root:/Brand/Photos:/children"]) expect(good.calls.some((c) => c.url.includes(part)), part).toBe(true);
    // A channel ID that Teams does not know fails the check instead of showing as connected.
    const bad = await createLiveM365({ ...MS, M365_SHAREPOINT_FOLDER: "Brand/Photos", M365_TEAMS_CHANNELS: '{"Marketing":"19:abc","Purchasing":"19:wrong"}' }, fakeFetch(routes).fetchImpl).status();
    expect(bad).toMatchObject({ connected: false });
    expect(bad.error).toContain("404");
  });
  it("walks the SharePoint library and posts to Teams through the channel webhook", async () => {
    const { fetchImpl, calls } = fakeFetch([
      token,
      ["/items/folder1/children", () => ({ value: [{ id: "f1", name: "98100_caro-bed_studio.jpg", webUrl: "https://cubro.sharepoint.test/a.jpg", file: {} }, { id: "f2", name: "notes.docx", file: {} }] })],
      ["/drive/root/children", () => ({ value: [{ id: "folder1", name: "Beds", folder: {} }, { id: "f3", name: "cubro-logo.svg", file: {} }] })],
      ["https://flows.test/hook", () => undefined],
    ]);
    const m365 = createLiveM365(MS, fetchImpl);
    expect(await m365.listBrandAssets()).toEqual([
      { id: "f3", name: "cubro-logo.svg", webUrl: "", kind: "logo", productSku: undefined, tags: [] },
      { id: "f1", name: "98100_caro-bed_studio.jpg", webUrl: "https://cubro.sharepoint.test/a.jpg", kind: "photo", productSku: "98100", tags: ["Beds"] },
    ]);
    const post = await m365.postTeamsMessage("Marketing", "LinkedIn post approved");
    expect(post).toMatchObject({ channel: "Marketing", text: "LinkedIn post approved" });
    expect(calls.at(-1)!.url).toBe("https://flows.test/hook");
    expect(calls.at(-1)!.body).toContain("LinkedIn post approved");
    await expect(m365.postTeamsMessage("Sales", "x")).rejects.toThrow("No posting webhook is set for the Sales channel");
  });
});

describe("live Infor LN connector", () => {
  const routes: [string, Route][] = [
    ["sso.test/token", token[1]],
    ["LN/odata/Items", () => ({ value: [{ Item: "98100", Description: "Caro bed", itemGroup: "Beds", unitPrice: 2890, InventoryOnHand: "14", reorderPoint: 10, safetyStock: 4, avgMonthlyDemand: 9, primarySupplier: "SUP1001", launchDate: "2019-03-01T00:00:00Z" }] })],
    ["LN/odata/OrderLines", () => ({ value: [{ OrderNumber: "PO41783", line: 20, item: "1951", quantity: 4, received: 0, price: 300 }, { OrderNumber: "PO41783", line: 10, item: "98100", quantity: 10, received: 4, price: 6200 }] })],
    ["LN/odata/Orders?page=2", () => ({ value: [{ OrderNumber: "PO41700", supplier: "SUP1001", orderDate: "2026-08-03", plannedReceiptDate: "2026-10-12", confirmedReceiptDate: "2026-10-26", status: "Closed", buyer: "Mark Jensen", currency: "CNY" }] })],
    ["LN/odata/Orders", () => ({ value: [{ OrderNumber: "PO41783", supplier: "SUP1001", orderDate: "2026-11-02T00:00:00Z", plannedReceiptDate: "2027-01-25", confirmedReceiptDate: "2027-01-25", status: "30", buyer: "Priya Raman", currency: "cny" }], "@odata.nextLink": "https://ion.test/CUBRO_PRD/LN/odata/Orders?page=2" })],
    ["LN/odata/Suppliers", () => ({ value: [{ supplier: "SUP1001", name: "Ningbo Kanghui Care Bed Co., Ltd", country: "China", contactName: "Helen Wu", email: "helen@kanghui.test", phone: "+86 574 0000", paymentTerms: "30 days", categories: "Beds; Bedroom furniture" }] })],
  ];
  const env = { ...LN, INFORLN_PURCHASE_ORDER_LINES_PATH: "LN/odata/OrderLines", INFORLN_FIELDS: '{"items":{"item":"Item","description":"Description","onHand":"InventoryOnHand"},"purchaseOrders":{"order":"OrderNumber"},"purchaseOrderLines":{"order":"OrderNumber"}}' };

  it("reads items and purchase orders through mapped property names, joining lines to orders", async () => {
    const { fetchImpl, calls } = fakeFetch(routes);
    const ln = createLiveInforLn(env, fetchImpl);
    expect(await ln.listItems()).toEqual([{ item: "98100", description: "Caro bed", itemGroup: "Beds", unitPrice: 2890, standardCost: undefined, onHand: 14, reorderPoint: 10, safetyStock: 4, avgMonthlyDemand: 9, primarySupplier: "SUP1001", isNew: false, launchDate: "2019-03-01" }]);
    const orders = await ln.listPurchaseOrders();
    expect(orders.map((o) => [o.order, o.status, o.currency, o.orderDate, o.lines.map((l) => l.line)])).toEqual([["PO41783", "Partially received", "CNY", "2026-11-02", [10, 20]], ["PO41700", "Closed", "CNY", "2026-08-03", []]]);
    expect(calls[0].body).toContain("grant_type=password");
    expect(calls[1].url).toBe("https://ion.test/CUBRO_PRD/LN/odata/Items");
    expect(calls[1].headers).toMatchObject({ authorization: "Bearer tok", "X-Infor-LnCompany": "100" });
  });
  it("works out supplier lead time and on-time rate from the order history", async () => {
    const supplier = await createLiveInforLn(env, fakeFetch(routes).fetchImpl).getSupplier("SUP1001");
    expect(supplier).toMatchObject({ name: "Ningbo Kanghui Care Bed Co., Ltd", categories: ["Beds", "Bedroom furniture"], avgLeadTimeDays: 84, onTimeRate: 0.5 });
  });
  it("follows a relative next link from where the page came from", async () => {
    const order = (n: string) => ({ order: n, supplier: "SUP1001", orderDate: "2026-11-02", plannedReceiptDate: "2027-01-25", status: "Open", buyer: "Priya Raman", currency: "NZD" });
    const { fetchImpl, calls } = fakeFetch([
      ["sso.test/token", token[1]],
      ["Orders?$skiptoken=3", () => ({ value: [order("PO3")] })],
      ["Orders?$skiptoken=2", () => ({ "@odata.context": "https://ion.test/CUBRO_PRD/LN/odata/$metadata#Orders", value: [order("PO2")], "@odata.nextLink": "Orders?$skiptoken=3" })],
      ["LN/odata/Orders", () => ({ value: [order("PO1")], "@odata.nextLink": "Orders?$skiptoken=2" })],
    ]);
    const orders = await createLiveInforLn(LN, fetchImpl).listPurchaseOrders();
    expect(orders.map((o) => o.order)).toEqual(["PO1", "PO2", "PO3"]);
    expect(calls.slice(1).map((c) => c.url)).toEqual(["https://ion.test/CUBRO_PRD/LN/odata/Orders", "https://ion.test/CUBRO_PRD/LN/odata/Orders?$skiptoken=2", "https://ion.test/CUBRO_PRD/LN/odata/Orders?$skiptoken=3"]);
  });
  it("calls an order part received when one line is short, even if another line was over-received", async () => {
    const order = (n: string, lines: [number, number][]) => ({ order: n, supplier: "SUP1001", orderDate: "2026-11-02", plannedReceiptDate: "2026-11-20", status: "", buyer: "Priya Raman", currency: "NZD", lines: lines.map(([quantity, received], i) => ({ line: (i + 1) * 10, item: "98100", quantity, received, price: 100 })) });
    const { fetchImpl } = fakeFetch([["sso.test/token", token[1]], ["LN/odata/Orders", () => ({ value: [order("SHORT", [[10, 12], [5, 3]]), order("FULL", [[10, 12], [5, 5]]), order("NONE", [[10, 0]])] })]]);
    const orders = await createLiveInforLn(LN, fetchImpl).listPurchaseOrders();
    expect(orders.map((o) => [o.order, o.status])).toEqual([["SHORT", "Partially received"], ["FULL", "Received"], ["NONE", "Created"]]);
  });
  it("tries the order lines collection in the connection check when one is configured", async () => {
    const good = fakeFetch(routes.map(([k, r]): [string, Route] => [k, k.startsWith("LN/") ? () => ({ ...(r({} as Call) as object), "@odata.count": 7 }) : r]));
    expect(await createLiveInforLn(env, good.fetchImpl).status()).toMatchObject({ connected: true, records: { items: 7, suppliers: 7, "purchase orders": 7 } });
    expect(good.calls.some((c) => c.url.includes("LN/odata/OrderLines"))).toBe(true);
    const bad = await createLiveInforLn({ ...env, INFORLN_PURCHASE_ORDER_LINES_PATH: "LN/odata/WrongLines" }, fakeFetch(routes).fetchImpl).status();
    expect(bad).toMatchObject({ connected: false });
    expect(bad.error).toContain("404");
  });
  it("says which settings are missing instead of calling out", async () => {
    const status = await createLiveInforLn({ INFORLN_ION_URL: LN.INFORLN_ION_URL }, noNetwork).status();
    expect(status).toMatchObject({ mode: "live", connected: false });
    expect(status.error).toContain("LN company (INFORLN_COMPANY)");
    expect(status.settings.find((s) => s.key === "INFORLN_ION_URL")!.set).toBe(true);
  });
});
