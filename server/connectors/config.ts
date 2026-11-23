// What each live connector needs before it can replace the simulated one.
// The Connected systems page shows this list, so labels and help are written for the person filling it in.
import type { ConnectorSetting, ConnectorStatus, SystemId } from "./types.js";

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface SettingDef { key: string; label: string; help: string; required: boolean }
const req = (key: string, label: string, help: string): SettingDef => ({ key, label, help, required: true });
const opt = (key: string, label: string, help: string): SettingDef => ({ key, label, help, required: false });

export const SYSTEMS: Record<SystemId, { name: string; switchKey: string; api: string; simulated: string; settings: SettingDef[] }> = {
  m365: {
    name: "Microsoft 365",
    switchKey: "CONNECTOR_M365",
    api: "Microsoft Graph v1.0 (Outlook mail and calendar, SharePoint files, Teams channels)",
    simulated: "Simulated Outlook mailbox and calendar, SharePoint Marketing library and Teams channels",
    settings: [
      req("M365_TENANT_ID", "Tenant ID", "Directory (tenant) ID of Cubro's Microsoft 365 tenant, from the app registration in Entra ID."),
      req("M365_CLIENT_ID", "App registration client ID", "Application (client) ID of the app registration created for this workspace."),
      req("M365_CLIENT_SECRET", "App registration client secret", "Client secret for that app registration. Needs admin consent for Mail.ReadWrite, Mail.Send, Calendars.Read, Sites.Read.All and ChannelMessage.Read.All."),
      req("M365_MAILBOX", "Purchasing mailbox", "Shared mailbox supplier emails are read from and sent from, for example purchasing@cubro.co.nz."),
      req("M365_CALENDAR_USER", "Marketing calendar", "Mailbox whose calendar holds trade shows, webinars and customer visits."),
      req("M365_SHAREPOINT_SITE_ID", "SharePoint site ID", "Graph site ID of the Marketing site that holds approved photos, videos and brochures."),
      opt("M365_SHAREPOINT_FOLDER", "SharePoint folder", "Folder inside the site's document library to read assets from. Leave empty to read the whole library."),
      req("M365_TEAMS_TEAM_ID", "Teams team ID", "ID of the team whose channels the workspace reads."),
      req("M365_TEAMS_CHANNELS", "Teams channel IDs", 'JSON map of channel name to channel ID, for example {"Marketing":"19:…@thread.tacv2"}.'),
      req("M365_TEAMS_WEBHOOKS", "Teams posting webhooks", 'JSON map of channel name to the "Post to a channel when a webhook request is received" workflow URL. Microsoft does not let an unattended app post to a channel through Graph.'),
    ],
  },
  salesforce: {
    name: "Salesforce",
    switchKey: "CONNECTOR_SALESFORCE",
    api: "Salesforce REST API (SOQL queries on Account, Contact, Opportunity, Campaign and Case; Task for logged activity)",
    simulated: "Simulated Sales Cloud org with accounts, contacts, opportunities, campaigns, cases and logged activity",
    settings: [
      req("SALESFORCE_INSTANCE_URL", "My Domain URL", "For example https://cubro.my.salesforce.com."),
      req("SALESFORCE_CLIENT_ID", "Connected app consumer key", "Consumer key of a connected app with the client credentials flow enabled."),
      req("SALESFORCE_CLIENT_SECRET", "Connected app consumer secret", "Consumer secret of that connected app. Its run-as user needs read access to the five objects and create access to Task."),
      opt("SALESFORCE_API_VERSION", "API version", "Defaults to v61.0."),
      opt("SALESFORCE_FIELDS", "Custom field names", 'JSON map for custom fields whose API names differ from the defaults, for example {"Account.Region":"Sales_Region__c"}. Defaults: Account.Region=Region__c, Account.AnnualSpend=AnnualSpend__c, Account.Market=Market__c, Opportunity.ProductSkus=ProductSkus__c, Campaign.ProductSkus=ProductSkus__c, Campaign.Audience=Audience__c, Campaign.KeyMessage=KeyMessage__c, Case.ProductSku=ProductSku__c.'),
    ],
  },
  clickup: {
    name: "ClickUp",
    switchKey: "CONNECTOR_CLICKUP",
    api: "ClickUp API v2 (tasks in the Marketing, Purchasing, Operations and Sales lists)",
    simulated: "Simulated ClickUp workspace with Marketing, Purchasing, Operations and Sales lists",
    settings: [
      req("CLICKUP_API_TOKEN", "API token", "Personal token (pk_…) of a service user who can see the four lists."),
      req("CLICKUP_LISTS", "List IDs", 'JSON map of list name to ClickUp list ID, for example {"Marketing":"901200001","Purchasing":"901200002","Operations":"901200003","Sales":"901200004"}.'),
      opt("CLICKUP_USERS", "Assignee IDs", 'JSON map of staff name to ClickUp user ID, so new tasks can be assigned. Without it tasks are created unassigned.'),
    ],
  },
  inforln: {
    name: "Infor LN",
    switchKey: "CONNECTOR_INFORLN",
    api: "Infor ION API gateway (LN OData services for items, suppliers and purchase orders)",
    simulated: "Simulated Infor LN company with items, stock levels, suppliers and purchase orders",
    settings: [
      req("INFORLN_ION_URL", "ION API URL", "Base URL of the tenant's ION API gateway including the tenant, from the .ionapi file (iu and ti)."),
      req("INFORLN_TOKEN_URL", "Token URL", "OAuth token endpoint from the .ionapi file (pu followed by ot)."),
      req("INFORLN_CLIENT_ID", "Client ID", "ci from the .ionapi file of a backend service authorised app."),
      req("INFORLN_CLIENT_SECRET", "Client secret", "cs from the .ionapi file."),
      req("INFORLN_SERVICE_ACCOUNT_KEY", "Service account access key", "saak from the .ionapi file."),
      req("INFORLN_SERVICE_ACCOUNT_SECRET", "Service account secret key", "sask from the .ionapi file."),
      req("INFORLN_COMPANY", "LN company", "LN logistic company number to read from."),
      req("INFORLN_ITEMS_PATH", "Items service path", "Path under the ION API URL of the OData collection that lists items with stock and reorder data."),
      req("INFORLN_SUPPLIERS_PATH", "Suppliers service path", "Path of the OData collection that lists buy-from business partners."),
      req("INFORLN_PURCHASE_ORDERS_PATH", "Purchase orders service path", "Path of the OData collection that lists purchase orders."),
      opt("INFORLN_PURCHASE_ORDER_LINES_PATH", "Purchase order lines service path", "Only needed when order lines are a separate collection rather than nested in each order."),
      opt("INFORLN_FIELDS", "Field names", 'JSON map from the workspace field to the LN property name, per collection, for example {"items":{"item":"Item","onHand":"InventoryOnHand"},"purchaseOrders":{"order":"OrderNumber"}}. Fields that are not mapped are read by the workspace name.'),
    ],
  },
};

export const SYSTEM_IDS = Object.keys(SYSTEMS) as SystemId[];
export const isSystemId = (s: string): s is SystemId => s in SYSTEMS;

export function settingsFor(system: SystemId, env: Env): ConnectorSetting[] {
  return SYSTEMS[system].settings.map((s) => ({ ...s, set: Boolean(env[s.key]?.trim()) }));
}

export function missingSettings(system: SystemId, env: Env) {
  return settingsFor(system, env).filter((s) => s.required && !s.set);
}

/** The parts of a status every connector, simulated or live, reports the same way. */
export function baseStatus(system: SystemId, mode: "mock" | "live", env: Env): Pick<ConnectorStatus, "system" | "name" | "mode" | "api" | "settings" | "checkedAt"> {
  return { system, name: SYSTEMS[system].name, mode, api: SYSTEMS[system].api, settings: settingsFor(system, env), checkedAt: new Date().toISOString() };
}

/** A failure talking to a real system, worded for the Connected systems page. */
export class ConnectorError extends Error {
  constructor(public system: SystemId, message: string, public httpStatus?: number) {
    super(`${SYSTEMS[system].name}: ${message}`);
    this.name = "ConnectorError";
  }
}

/** Reads a JSON map setting such as CLICKUP_LISTS. */
export function jsonSetting<T extends object>(system: SystemId, env: Env, key: string): T {
  const raw = env[key]?.trim();
  if (!raw) return {} as T;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as T;
  } catch { /* reported below */ }
  throw new ConnectorError(system, `${key} must be a JSON object, for example {"Marketing":"123"}.`);
}

/** Turns any connector failure into a status, so one system being down never hides the others. */
export function failedStatus(system: SystemId, mode: "mock" | "live", env: Env, err: unknown): ConnectorStatus {
  const text = err instanceof Error ? err.message : String(err);
  return { ...baseStatus(system, mode, env), connected: false, detail: "Not connected", records: {}, error: text.replace(`${SYSTEMS[system].name}: `, "") };
}
