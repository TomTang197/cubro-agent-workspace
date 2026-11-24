// Microsoft 365 through Microsoft Graph v1.0, signed in as an app registration (client credentials).
import { baseStatus, failedStatus, jsonSetting, ConnectorError, type Env, type FetchLike } from "../config.js";
import { MAIL_LIST_LIMIT, type BrandAsset, type CalendarEvent, type M365Connector, type MailMessage, type TeamsPost } from "../types.js";
import { createHttp, requireSettings, tokenCache } from "./http.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS: Record<MailMessage["folder"], string> = { Inbox: "inbox", "Sent Items": "sentitems", Drafts: "drafts" };
const CATEGORIES: CalendarEvent["category"][] = ["Trade show", "Customer visit", "Internal", "Webinar", "Training"];
const MAX_PAGES = 10;
const MAX_ASSETS = 2000;

interface GraphPage<T> { value: T[]; "@odata.nextLink"?: string; "@odata.count"?: number }
interface GraphRecipient { emailAddress?: { name?: string; address?: string } }
interface GraphMessage { id: string; conversationId?: string; from?: GraphRecipient; toRecipients?: GraphRecipient[]; replyTo?: GraphRecipient[]; subject?: string; bodyPreview?: string; body?: { content?: string }; receivedDateTime?: string; createdDateTime?: string; isDraft?: boolean }
interface GraphEvent { id: string; subject?: string; start?: { dateTime: string }; end?: { dateTime: string }; location?: { displayName?: string }; categories?: string[]; organizer?: GraphRecipient }
interface GraphDriveItem { id: string; name: string; webUrl?: string; folder?: object; file?: object }
interface GraphChannelMessage { id: string; createdDateTime: string; messageType?: string; body?: { content?: string }; from?: { user?: { displayName?: string }; application?: { displayName?: string } } }

const person = (r?: GraphRecipient) => ({ name: r?.emailAddress?.name ?? r?.emailAddress?.address ?? "", address: r?.emailAddress?.address ?? "" });
const utc = (s?: string) => (s ? (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? new Date(s) : new Date(`${s}Z`)).toISOString() : "");
const plain = (html = "") => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** Addresses on reserved example domains only exist in the sample data; a live mailbox must never send to them. */
const isSampleAddress = (a: string) => /(^|[.@])example(\.[a-z.]+)?$/i.test(a.split("@")[1] ?? "") || /\.(example|test|invalid)$/i.test(a);

export function assetKind(name: string): BrandAsset["kind"] | undefined {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (/logo/i.test(name) && ["svg", "png", "eps", "ai", "jpg", "jpeg"].includes(ext)) return "logo";
  if (["jpg", "jpeg", "png", "webp", "tif", "tiff"].includes(ext)) return "photo";
  if (["mp4", "mov", "m4v"].includes(ext)) return "video";
  if (ext === "pdf") return "brochure";
  if (["svg", "eps", "ai"].includes(ext)) return "logo";
  return undefined;
}

export function createLiveM365(env: Env, fetchImpl: FetchLike = fetch): M365Connector {
  const http = createHttp("m365", fetchImpl);
  const token = tokenCache(() => http.json(`https://login.microsoftonline.com/${encodeURIComponent(env.M365_TENANT_ID!)}/oauth2/v2.0/token`, {
    method: "POST", form: { grant_type: "client_credentials", client_id: env.M365_CLIENT_ID!, client_secret: env.M365_CLIENT_SECRET!, scope: "https://graph.microsoft.com/.default" },
  }));
  const graph = async <T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    requireSettings("m365", env);
    return http.json<T>(path.startsWith("http") ? path : `${GRAPH}${path}`, { ...init, headers: { authorization: `Bearer ${await token.get()}`, ...init.headers } });
  };
  const all = async <T>(path: string, headers?: Record<string, string>, limit = Infinity) => {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < MAX_PAGES && out.length < limit; page++) {
      const res: GraphPage<T> = await graph<GraphPage<T>>(next, { headers });
      out.push(...res.value);
      next = res["@odata.nextLink"];
    }
    return out;
  };
  const mailbox = () => `/users/${encodeURIComponent(env.M365_MAILBOX!)}`;
  // Immutable IDs keep a message's ID the same when it moves from Drafts to Sent Items.
  const mailHeaders = { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' };
  const toMessage = (m: GraphMessage, folder: MailMessage["folder"]): MailMessage => ({
    id: m.id, conversationId: m.conversationId ?? m.id, from: person(m.from), to: (m.toRecipients ?? []).map(person), ...(m.replyTo?.length && { replyTo: m.replyTo.map(person) }), subject: m.subject ?? "",
    bodyPreview: m.bodyPreview ?? "", body: m.body?.content ?? "", receivedDateTime: utc(m.receivedDateTime ?? m.createdDateTime), isDraft: Boolean(m.isDraft), folder,
  });
  const drive = () => `/sites/${env.M365_SHAREPOINT_SITE_ID}/drive`;
  /** The folder brand assets are read from: the configured one, or the top of the library. */
  const library = () => {
    const start = env.M365_SHAREPOINT_FOLDER?.trim().replace(/^\/+|\/+$/g, "");
    return start ? `${drive()}/root:/${start.split("/").map(encodeURIComponent).join("/")}:/children` : `${drive()}/root/children`;
  };
  const channels = () => jsonSetting<Record<string, string>>("m365", env, "M365_TEAMS_CHANNELS");
  const count = async (path: string) => (await graph<GraphPage<unknown>>(`${path}${path.includes("?") ? "&" : "?"}$top=1&$count=true`, { headers: { ConsistencyLevel: "eventual" } }))["@odata.count"] ?? 0;

  return {
    async status() {
      try {
        const names = Object.keys(channels());
        const week = new URLSearchParams({ startDateTime: new Date().toISOString(), endDateTime: new Date(Date.now() + 7 * 86_400_000).toISOString(), $top: "1", $select: "id" });
        // Every read the workspace makes is tried (mail, calendar, each Teams channel, the brand library), so a wrong mailbox or channel shows here rather than when an agent runs.
        const [emails, files] = await Promise.all([
          count(`${mailbox()}/mailFolders/inbox/messages`), graph<GraphPage<unknown>>(`${library()}?$top=1`),
          graph(`/users/${encodeURIComponent(env.M365_CALENDAR_USER!)}/calendarView?${week}`),
          ...Object.values(channels()).map((id) => graph(`/teams/${env.M365_TEAMS_TEAM_ID}/channels/${encodeURIComponent(id)}/messages?$top=1`)),
        ]);
        return { ...baseStatus("m365", "live", env), connected: true, detail: `Connected to Microsoft Graph as mailbox ${env.M365_MAILBOX}; calendar ${env.M365_CALENDAR_USER}; Teams channels ${names.join(", ") || "none"}`, records: { "inbox emails": emails, "Teams channels": names.length, "SharePoint library": files.value.length ? 1 : 0 } };
      } catch (e) { token.clear(); return failedStatus("m365", "live", env, e); }
    },
    async listEvents(fromIso, toIso) {
      const q = new URLSearchParams({ startDateTime: fromIso, endDateTime: toIso, $top: "100", $orderby: "start/dateTime", $select: "id,subject,start,end,location,categories,organizer" });
      const events = await all<GraphEvent>(`/users/${encodeURIComponent(env.M365_CALENDAR_USER!)}/calendarView?${q}`, { Prefer: 'outlook.timezone="UTC"' });
      return events.map((e) => ({
        id: e.id, subject: e.subject ?? "", start: utc(e.start?.dateTime), end: utc(e.end?.dateTime), location: e.location?.displayName ?? "",
        // Outlook categories carry the event type; anything uncategorised is treated as internal so it is not posted about.
        category: CATEGORIES.find((c) => e.categories?.some((x) => x.toLowerCase() === c.toLowerCase())) ?? "Internal", organizer: person(e.organizer).name,
      }));
    },
    async listMessages(folder) {
      const folders = folder ? [folder] : (Object.keys(FOLDERS) as MailMessage["folder"][]);
      const q = new URLSearchParams({ $top: "50", $orderby: "receivedDateTime desc", $select: "id,conversationId,from,toRecipients,replyTo,subject,bodyPreview,body,receivedDateTime,createdDateTime,isDraft" });
      const lists = await Promise.all(folders.map(async (f) => (await all<GraphMessage>(`${mailbox()}/mailFolders/${FOLDERS[f]}/messages?${q}`, mailHeaders, MAIL_LIST_LIMIT)).slice(0, MAIL_LIST_LIMIT).map((m) => toMessage(m, f))));
      return lists.flat().sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
    },
    async createDraft(msg) {
      const sample = msg.to.find((t) => isSampleAddress(t.address));
      if (sample) throw new ConnectorError("m365", `${sample.address} is a sample-data address. The live mailbox only sends to real addresses, so connect Infor LN before sending supplier emails.`);
      const toRecipients = msg.to.map((t) => ({ emailAddress: t }));
      // A reply is made from the message it answers, so Outlook files it in that conversation and quotes the original under our text.
      const created = msg.inReplyTo
        ? await graph<GraphMessage>(`${mailbox()}/messages/${encodeURIComponent(msg.inReplyTo)}/createReply`, { method: "POST", headers: mailHeaders, body: { message: { subject: msg.subject, toRecipients }, comment: msg.body } })
        : await graph<GraphMessage>(`${mailbox()}/messages`, { method: "POST", headers: mailHeaders, body: { subject: msg.subject, body: { contentType: "Text", content: msg.body }, toRecipients } });
      return toMessage(created, "Drafts");
    },
    async sendDraft(id) {
      const draft = toMessage(await graph<GraphMessage>(`${mailbox()}/messages/${encodeURIComponent(id)}`, { headers: mailHeaders }), "Drafts");
      await graph(`${mailbox()}/messages/${encodeURIComponent(id)}/send`, { method: "POST", headers: mailHeaders });
      return { ...draft, isDraft: false, folder: "Sent Items", receivedDateTime: new Date().toISOString() };
    },
    async listBrandAssets() {
      const queue: { path: string; tags: string[] }[] = [{ path: library(), tags: [] }];
      const assets: BrandAsset[] = [];
      while (queue.length && assets.length < MAX_ASSETS) {
        const { path, tags } = queue.shift()!;
        for (const it of await all<GraphDriveItem>(`${path}?$top=200&$select=id,name,webUrl,folder,file`)) {
          if (it.folder) { if (tags.length < 4) queue.push({ path: `${drive()}/items/${it.id}/children`, tags: [...tags, it.name] }); continue; }
          const kind = assetKind(it.name);
          if (!kind) continue;
          // File names start with the product code, for example 98100_caro-bed_studio.jpg.
          const sku = /^([A-Za-z0-9-]+)_/.exec(it.name)?.[1];
          assets.push({ id: it.id, name: it.name, webUrl: it.webUrl ?? "", kind, productSku: kind === "logo" ? undefined : sku, tags });
        }
      }
      return assets;
    },
    async listTeamsPosts() {
      requireSettings("m365", env);
      const lists = await Promise.all(Object.entries(channels()).map(async ([channel, id]) =>
        (await all<GraphChannelMessage>(`/teams/${env.M365_TEAMS_TEAM_ID}/channels/${encodeURIComponent(id)}/messages?$top=50`, undefined, 100))
          .filter((m) => !m.messageType || m.messageType === "message")
          .map((m): TeamsPost => ({ id: m.id, channel, text: plain(m.body?.content), createdDateTime: utc(m.createdDateTime), from: m.from?.user?.displayName ?? m.from?.application?.displayName }))));
      return lists.flat().sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
    },
    async postTeamsMessage(channel, text) {
      requireSettings("m365", env);
      const url = jsonSetting<Record<string, string>>("m365", env, "M365_TEAMS_WEBHOOKS")[channel];
      if (!url) throw new ConnectorError("m365", `No posting webhook is set for the ${channel} channel in M365_TEAMS_WEBHOOKS.`);
      await http.json(url, { method: "POST", body: { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }] } }] } });
      const createdDateTime = new Date().toISOString();
      return { id: `webhook-${createdDateTime}`, channel, text, createdDateTime, from: "Cubro agent workspace" };
    },
  };
}
