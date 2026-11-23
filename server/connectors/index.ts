import type { Store } from "../store.js";
import { createLiveClickUp, createLiveInforLn, createLiveM365, createLiveSalesforce } from "./live/index.js";
import { createMockConnectors } from "./mock/index.js";
import type { Connectors } from "./types.js";

export function createConnectors(store: Store, env = process.env): Connectors {
  const mock = createMockConnectors(store);
  return {
    m365: env.CONNECTOR_M365 === "live" ? createLiveM365() : mock.m365,
    salesforce: env.CONNECTOR_SALESFORCE === "live" ? createLiveSalesforce() : mock.salesforce,
    clickup: env.CONNECTOR_CLICKUP === "live" ? createLiveClickUp() : mock.clickup,
    inforln: env.CONNECTOR_INFORLN === "live" ? createLiveInforLn() : mock.inforln,
  };
}
export type { Connectors } from "./types.js";
