# Cubro Agent Workspace

Internal workspace where AI agents do routine work inside Cubro's systems and staff approve it before anything goes out. Every approval is logged with the time and money it saved.

## What's in it

- **Social Media Planner** (Marketing): plans two weeks of LinkedIn, Facebook and Instagram posts from Salesforce campaigns and customer feedback, Outlook events, new Infor LN items and SharePoint images. On approval it creates a ClickUp Marketing task and posts to Teams.
- **Supplier Outreach** (Purchasing): checks Infor LN for overdue, unconfirmed or part-delivered purchase orders and low stock, and drafts the supplier email. On approval it sends the email from Outlook and creates a ClickUp follow-up.
- **Approvals**: one queue; staff can edit, approve or reject with a note. Each draft shows why the agent made it and which records it used.
- **Time & money saved**: manual minutes vs. review minutes per job, priced at each team's hourly cost, with CSV export.
- **Connected systems**: browse the data each connector exposes.

## Systems and connectors

All four systems are simulated with deterministic sample data (`server/data/seed.ts`) behind interfaces shaped like the real APIs (`server/connectors/types.ts`):

| System | Interface modelled on | Mock | Live stub |
|---|---|---|---|
| Microsoft 365 | Microsoft Graph v1.0 (calendar, mail, SharePoint, Teams) | `server/connectors/mock` | `server/connectors/live` |
| Salesforce | REST API v61.0 (SOQL, sobjects) | same | same |
| ClickUp | API v2 (lists, tasks) | same | same |
| Infor LN | ION API / BODs (Item, SupplierPartyMaster, PurchaseOrder) | same | same |

To connect a real system, implement its functions in `server/connectors/live/index.ts` and set `CONNECTOR_M365=live` (or `CONNECTOR_SALESFORCE`, `CONNECTOR_CLICKUP`, `CONNECTOR_INFORLN`). Nothing else changes.

Drafts come from built-in templates. Set `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, `OPENAI_BASE_URL`) to have a model rewrite them (`server/llm/index.ts`).

## Run

```bash
npm install
npm run dev        # web on :5173, API on :3001
npm test
npm run build && npm start   # production on :8080 (PORT to change)
```

State is saved to `.data/state.json` (`DATA_DIR` to change). Settings → Reset sample data regenerates everything.
