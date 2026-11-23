// Placeholders for the real integrations. Each one documents the API it should call;
// implement the methods and set CONNECTOR_<SYSTEM>=live to switch a system over.
import type { ClickUpConnector, InforLnConnector, M365Connector, SalesforceConnector } from "../types.js";

function notImplemented(system: string, env: string[]): never {
  throw new Error(`${system} live connector is not implemented yet. Required env: ${env.join(", ")}`);
}

/** Microsoft Graph v1.0: GET /me/calendarView, GET /me/mailFolders/{id}/messages, POST /me/messages, POST /me/messages/{id}/send, GET /sites/{site}/drive/root/children, POST /teams/{id}/channels/{id}/messages */
export function createLiveM365(): M365Connector {
  const env = ["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET"];
  const fail = () => notImplemented("Microsoft 365", env);
  return { status: async () => ({ system: "m365", name: "Microsoft 365", mode: "live", connected: env.every((k) => process.env[k]), detail: "Microsoft Graph (not implemented)", records: {} }), listEvents: fail, listMessages: fail, createDraft: fail, sendDraft: fail, listBrandAssets: fail, postTeamsMessage: fail };
}

/** Salesforce REST API v61.0: GET /services/data/v61.0/query?q=SELECT ..., POST /sobjects/Task */
export function createLiveSalesforce(): SalesforceConnector {
  const env = ["SF_INSTANCE_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET"];
  const fail = () => notImplemented("Salesforce", env);
  return { status: async () => ({ system: "salesforce", name: "Salesforce", mode: "live", connected: env.every((k) => process.env[k]), detail: "Salesforce REST API (not implemented)", records: {} }), query: fail, logActivity: fail };
}

/** ClickUp API v2: GET /list/{list_id}/task, POST /list/{list_id}/task, PUT /task/{task_id} */
export function createLiveClickUp(): ClickUpConnector {
  const env = ["CLICKUP_API_TOKEN", "CLICKUP_LIST_IDS"];
  const fail = () => notImplemented("ClickUp", env);
  return { status: async () => ({ system: "clickup", name: "ClickUp", mode: "live", connected: env.every((k) => process.env[k]), detail: "ClickUp API v2 (not implemented)", records: {} }), listTasks: fail, createTask: fail, updateTask: fail };
}

/** Infor LN via ION API gateway: tdipu001 items, tccom020 suppliers, tdpur400/401 purchase orders, whinr140 inventory */
export function createLiveInforLn(): InforLnConnector {
  const env = ["ION_API_BASE_URL", "ION_CLIENT_ID", "ION_CLIENT_SECRET", "LN_COMPANY"];
  const fail = () => notImplemented("Infor LN", env);
  return { status: async () => ({ system: "inforln", name: "Infor LN", mode: "live", connected: env.every((k) => process.env[k]), detail: "Infor ION API (not implemented)", records: {} }), listItems: fail, listSuppliers: fail, listPurchaseOrders: fail, getSupplier: fail };
}
