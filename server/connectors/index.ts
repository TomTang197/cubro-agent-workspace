import type { Store } from "../store.js";
import { SYSTEMS, type Env, type FetchLike } from "./config.js";
import { createLiveClickUp, createLiveInforLn, createLiveM365, createLiveSalesforce } from "./live/index.js";
import { createMockConnectors } from "./mock/index.js";
import type { Connectors, SystemId } from "./types.js";

/** Whether a system is switched to its real API (CONNECTOR_<SYSTEM>=live) or runs on sample data. */
export const isLive = (system: SystemId, env: Env) => env[SYSTEMS[system].switchKey]?.trim().toLowerCase() === "live";

export function createConnectors(store: Store, env: Env = process.env, fetchImpl: FetchLike = fetch): Connectors {
  const mock = createMockConnectors(store, env);
  return {
    m365: isLive("m365", env) ? createLiveM365(env, fetchImpl) : mock.m365,
    salesforce: isLive("salesforce", env) ? createLiveSalesforce(env, fetchImpl) : mock.salesforce,
    clickup: isLive("clickup", env) ? createLiveClickUp(env, fetchImpl) : mock.clickup,
    inforln: isLive("inforln", env) ? createLiveInforLn(env, fetchImpl) : mock.inforln,
  };
}
export type { Connectors } from "./types.js";
