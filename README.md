# Cubro Agent Workspace

Internal workspace where AI agents do routine work inside Cubro's systems and staff approve it before anything goes out. Every approval is logged with the time and money it saved.

## What's in it

- **Social Media Planner** (Marketing): plans two weeks of LinkedIn, Facebook and Instagram posts from Salesforce campaigns and customer feedback, Outlook events, new Infor LN items and SharePoint images. On approval it creates a ClickUp Marketing task and posts to Teams.
- **Supplier Outreach** (Purchasing): checks Infor LN for overdue, unconfirmed or part-delivered purchase orders and low stock, and drafts the supplier email. On approval it sends the email from Outlook and creates a ClickUp follow-up.
- **Today**: the home page is the to-do for whoever is picked in "Working as": their team's drafts and one main button. A three-step guide shows on first open and from "How it works".
- **Drafts to check** (approvals): one draft at a time with three choices, approve, change or send back, each saying what it does, and a few seconds to undo. The list view keeps the search and the decided drafts. Each draft shows why the assistant wrote it and which records it used.
- **Admin**: Settings and Connected systems live here, out of the everyday menu (linked from the footer; not locked, the pilot has no login). While every connector is simulated the workspace shows a demo notice, and "Start the demo again" restores the sample data.
- **Time & money saved**: one ledger line per decision (`server/savings.ts`). Approved: minutes by hand minus review minutes (plus 4 if edited). Rejected: the review minutes count as a cost. Priced at the team's hourly cost on the day of the decision and dated by the New Zealand calendar. The overview, the page (by period and agent) and the CSV export all sum the same lines.
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

## Drafting model

Set `GEMINI_API_KEY` and Google Gemini writes each post and supplier email from the facts the agent collected (`server/llm/index.ts`, Gemini Interactions API). `GEMINI_MODEL` picks the model (default `gemini-4-hydrogen`; `gemini-4-carbon` is Google's strongest). Requests are sent with `store: false`.

The model writes at most 100 drafts per UTC day (`LLM_DAILY_DRAFT_LIMIT` to change), because the API has no sign-in of its own and every draft spends the key's quota; past the limit, drafts keep their template text until the next day.

Without a key, drafts come from the built-in templates. If a model call fails, that draft keeps its template text and the run's Model step says how many did and why. `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, `OPENAI_BASE_URL`) uses an OpenAI-compatible model instead when no Gemini key is set.

## Run

```bash
npm install
npm run dev        # web on :5173, API on :3001
npm test
npm run build && npm start   # production on :8080 (PORT to change)
```

State is saved to `.data/state.json` (`DATA_DIR` to change). Settings → Reset sample data regenerates everything.
