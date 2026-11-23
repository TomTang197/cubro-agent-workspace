# Cubro Agent Workspace

Internal workspace where AI agents do routine work inside Cubro's systems and staff approve it before anything goes out. Every approval is logged with the time and money it saved.

## What's in it

- **Social Media Planner** (Marketing): plans two weeks of LinkedIn, Facebook and Instagram posts from Salesforce campaigns and customer feedback, Outlook events, new Infor LN items and SharePoint images. On approval it creates a ClickUp Marketing task and posts to Teams.
- **Supplier Outreach** (Purchasing): checks Infor LN for overdue, unconfirmed or part-delivered purchase orders and low stock, and drafts the supplier email. On approval it sends the email from Outlook and creates a ClickUp follow-up.
- **Approvals**: one queue; staff can edit, approve or reject with a note. Each draft shows why the agent made it and which records it used.
- **Time & money saved**: manual minutes vs. review minutes per job, priced at each team's hourly cost, with CSV export.
- **Connected systems**: browse the data each connector exposes.

## Systems and connectors

All four systems start on deterministic sample data (`server/data/seed.ts`, company facts and catalogue in `server/data/catalogue.ts`) behind interfaces shaped like the real APIs (`server/connectors/types.ts`). Each has a live client in `server/connectors/live` that calls the real API through the same interface:

| System | Live client calls | Turn on with | Settings |
|---|---|---|---|
| Microsoft 365 | Microsoft Graph v1.0 with an Entra app registration (shared mailbox, calendar, SharePoint library, Teams channels) | `CONNECTOR_M365=live` | `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET`, `M365_MAILBOX`, `M365_CALENDAR_USER`, `M365_SHAREPOINT_SITE_ID`, `M365_TEAMS_TEAM_ID`, `M365_TEAMS_CHANNELS`, `M365_TEAMS_WEBHOOKS`; optional `M365_SHAREPOINT_FOLDER` |
| Salesforce | REST API (SOQL, Task) with a connected app using the client credentials flow | `CONNECTOR_SALESFORCE=live` | `SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`; optional `SALESFORCE_API_VERSION`, `SALESFORCE_FIELDS` |
| ClickUp | API v2 (lists, tasks) with an API token | `CONNECTOR_CLICKUP=live` | `CLICKUP_API_TOKEN`, `CLICKUP_LISTS`; optional `CLICKUP_USERS` |
| Infor LN | OData services through the ION API gateway with a service account | `CONNECTOR_INFORLN=live` | `INFORLN_ION_URL`, `INFORLN_TOKEN_URL`, `INFORLN_CLIENT_ID`, `INFORLN_CLIENT_SECRET`, `INFORLN_SERVICE_ACCOUNT_KEY`, `INFORLN_SERVICE_ACCOUNT_SECRET`, `INFORLN_COMPANY`, `INFORLN_ITEMS_PATH`, `INFORLN_SUPPLIERS_PATH`, `INFORLN_PURCHASE_ORDERS_PATH`; optional `INFORLN_PURCHASE_ORDER_LINES_PATH`, `INFORLN_FIELDS` |

Going live, one system at a time:

1. Set the system's settings as environment variables on the server. The Connected systems page lists each one in plain words with what it is for and whether it is set (`server/connectors/config.ts` is the source); values never reach the browser.
2. Set its `CONNECTOR_…=live` switch and restart.
3. Open Connected systems and press **Test connection**. The card shows the record counts read from the real system, or the reason it could not connect. A system that fails does not affect the other three.

Things that differ per Cubro tenant are settings, not code: Salesforce custom field names (`SALESFORCE_FIELDS`), ClickUp list and user IDs, the Infor LN service paths and property names (`INFORLN_FIELDS`), Teams channel IDs and posting webhooks. The live clients have been tested against recorded-shape responses (`tests/connectors.test.ts`), not against Cubro's own tenants, so expect to adjust those mappings on first connection.

Supplier and customer email addresses in the sample data use reserved `.example` domains. The live Microsoft 365 client refuses to send to them, so a live mailbox cannot email a made-up supplier while Infor LN is still on sample data.

Drafts come from built-in templates. Set `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, `OPENAI_BASE_URL`) to have a model rewrite them (`server/llm/index.ts`).

## Run

```bash
npm install
npm run dev        # web on :5173, API on :3001
npm test
npm run build && npm start   # production on :8080 (PORT to change)
```

State is saved to `.data/state.json` (`DATA_DIR` to change). Settings → Reset sample data regenerates everything.
