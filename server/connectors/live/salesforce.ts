// Salesforce through the REST API, signed in as a connected app (OAuth client credentials flow).
import { baseStatus, failedStatus, jsonSetting, type Env, type FetchLike } from "../config.js";
import type { SalesforceConnector, SfActivity, SfObjects } from "../types.js";
import { createHttp, requireSettings, tokenCache, trimSlash } from "./http.js";

type Rec = Record<string, unknown> & { Owner?: { Name?: string }; Contact?: { Name?: string } };
interface QueryPage { totalSize: number; done: boolean; nextRecordsUrl?: string; records: Rec[] }

/** Custom fields the workspace reads. Standard fields are fixed; these can be renamed with SALESFORCE_FIELDS. */
export const DEFAULT_FIELDS = {
  "Account.Region": "Region__c", "Account.AnnualSpend": "AnnualSpend__c", "Account.Market": "Market__c",
  "Opportunity.ProductSkus": "ProductSkus__c",
  "Campaign.ProductSkus": "ProductSkus__c", "Campaign.Audience": "Audience__c", "Campaign.KeyMessage": "KeyMessage__c",
  "Case.ProductSku": "ProductSku__c",
};

const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown) => Number(v) || 0;
/** Product codes are kept in a text or multi-select field, separated by semicolons or commas. */
const skus = (v: unknown) => str(v).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
const date = (v: unknown) => str(v).slice(0, 10);

export function createLiveSalesforce(env: Env, fetchImpl: FetchLike = fetch): SalesforceConnector {
  const http = createHttp("salesforce", fetchImpl);
  const base = () => trimSlash(env.SALESFORCE_INSTANCE_URL!);
  const version = () => env.SALESFORCE_API_VERSION?.trim() || "v61.0";
  const token = tokenCache(() => http.json(`${base()}/services/oauth2/token`, { method: "POST", form: { grant_type: "client_credentials", client_id: env.SALESFORCE_CLIENT_ID!, client_secret: env.SALESFORCE_CLIENT_SECRET! } }));
  const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    requireSettings("salesforce", env);
    return http.json<T>(`${base()}${path}`, { ...init, headers: { authorization: `Bearer ${await token.get()}` } });
  };
  const fields = () => ({ ...DEFAULT_FIELDS, ...jsonSetting<Partial<typeof DEFAULT_FIELDS>>("salesforce", env, "SALESFORCE_FIELDS") });
  const soql = async (q: string) => {
    const out: Rec[] = [];
    let page = await call<QueryPage>(`/services/data/${version()}/query?q=${encodeURIComponent(q)}`);
    out.push(...page.records);
    while (!page.done && page.nextRecordsUrl) { page = await call<QueryPage>(page.nextRecordsUrl); out.push(...page.records); }
    return out;
  };
  const count = async (sobject: string) => (await call<QueryPage>(`/services/data/${version()}/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${sobject}`)}`)).totalSize;

  const readers: { [K in keyof SfObjects]: () => Promise<SfObjects[K][]> } = {
    async Account() {
      const f = fields();
      return (await soql(`SELECT Id, Name, Type, BillingCity, Phone, Owner.Name, ${f["Account.Region"]}, ${f["Account.AnnualSpend"]}, ${f["Account.Market"]} FROM Account ORDER BY Name`)).map((r) => ({
        Id: str(r.Id), Name: str(r.Name), Type: str(r.Type) as SfObjects["Account"]["Type"], BillingCity: str(r.BillingCity), Region: str(r[f["Account.Region"]]), AnnualSpend__c: num(r[f["Account.AnnualSpend"]]),
        OwnerName: str(r.Owner?.Name), Market__c: (str(r[f["Account.Market"]]) || undefined) as SfObjects["Account"]["Market__c"], Phone: str(r.Phone) || undefined,
      }));
    },
    async Contact() {
      return (await soql("SELECT Id, AccountId, Name, Title, Email, Phone FROM Contact WHERE AccountId != null ORDER BY Name")).map((r) => ({ Id: str(r.Id), AccountId: str(r.AccountId), Name: str(r.Name), Title: str(r.Title), Email: str(r.Email), Phone: str(r.Phone) }));
    },
    async Opportunity() {
      const f = fields();
      return (await soql(`SELECT Id, Name, AccountId, StageName, Amount, CloseDate, CreatedDate, Owner.Name, ${f["Opportunity.ProductSkus"]} FROM Opportunity ORDER BY CloseDate DESC`)).map((r) => ({
        Id: str(r.Id), Name: str(r.Name), AccountId: str(r.AccountId), StageName: str(r.StageName) as SfObjects["Opportunity"]["StageName"], Amount: num(r.Amount), CloseDate: date(r.CloseDate),
        ProductSkus: skus(r[f["Opportunity.ProductSkus"]]), OwnerName: str(r.Owner?.Name) || undefined, CreatedDate: date(r.CreatedDate) || undefined,
      }));
    },
    async Campaign() {
      const f = fields();
      return (await soql(`SELECT Id, Name, Type, Status, StartDate, EndDate, ${f["Campaign.ProductSkus"]}, ${f["Campaign.Audience"]}, ${f["Campaign.KeyMessage"]} FROM Campaign ORDER BY StartDate DESC`)).map((r) => ({
        Id: str(r.Id), Name: str(r.Name), Type: str(r.Type) as SfObjects["Campaign"]["Type"], Status: str(r.Status) as SfObjects["Campaign"]["Status"], StartDate: date(r.StartDate), EndDate: date(r.EndDate),
        ProductSkus: skus(r[f["Campaign.ProductSkus"]]), Audience: str(r[f["Campaign.Audience"]]), KeyMessage: str(r[f["Campaign.KeyMessage"]]),
      }));
    },
    async Case() {
      const f = fields();
      return (await soql(`SELECT Id, Subject, AccountId, Type, Description, CreatedDate, Status, Contact.Name, Owner.Name, ${f["Case.ProductSku"]} FROM Case ORDER BY CreatedDate DESC`)).map((r) => ({
        Id: str(r.Id), Subject: str(r.Subject), AccountId: str(r.AccountId), ProductSku: str(r[f["Case.ProductSku"]]), Type: str(r.Type) as SfObjects["Case"]["Type"], Description: str(r.Description), CreatedDate: date(r.CreatedDate),
        Status: (str(r.Status) || undefined) as SfObjects["Case"]["Status"], ContactName: str(r.Contact?.Name) || undefined, OwnerName: str(r.Owner?.Name) || undefined,
      }));
    },
  };

  return {
    async status() {
      try {
        // Task is counted too: it is where approved work is logged and read back.
        const [accounts, contacts, opportunities, campaigns, cases] = await Promise.all(["Account", "Contact", "Opportunity", "Campaign", "Case", "Task"].map(count));
        return { ...baseStatus("salesforce", "live", env), connected: true, detail: `Connected to ${new URL(base()).host} (REST API ${version()})`, records: { accounts, contacts, opportunities, campaigns, cases } };
      } catch (e) { token.clear(); return failedStatus("salesforce", "live", env, e); }
    },
    query: (sobject) => readers[sobject](),
    async listActivities() {
      return (await soql("SELECT Id, WhatId, Subject, Description, CreatedDate, Owner.Name FROM Task ORDER BY CreatedDate DESC LIMIT 200")).map((r): SfActivity => ({ Id: str(r.Id), WhatId: str(r.WhatId), Subject: str(r.Subject), Description: str(r.Description), CreatedDate: str(r.CreatedDate), OwnerName: str(r.Owner?.Name) || undefined }));
    },
    async logActivity(input) {
      const res = await call<{ id: string }>(`/services/data/${version()}/sobjects/Task`, { method: "POST", body: { WhatId: input.WhatId, Subject: input.Subject, Description: input.Description, Status: "Completed", ActivityDate: new Date().toISOString().slice(0, 10) } });
      return { Id: res.id };
    },
  };
}
