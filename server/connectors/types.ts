// Interfaces shaped after the real systems' APIs so live implementations can replace the mocks.

export type SystemId = "m365" | "salesforce" | "clickup" | "inforln";

/** One value IT has to provide before a system can be switched from simulated to live. */
export interface ConnectorSetting {
  /** Environment variable name. */
  key: string;
  label: string;
  help: string;
  required: boolean;
  /** Whether a value is present. The value itself is never sent to the browser. */
  set: boolean;
}

export interface ConnectorStatus {
  system: SystemId;
  name: string;
  mode: "mock" | "live";
  connected: boolean;
  detail: string;
  records: Record<string, number>;
  /** The real API the live connector calls. */
  api: string;
  /** What the live connector needs, and whether each value is present. */
  settings: ConnectorSetting[];
  /** Why the system is not connected, in plain words. */
  error?: string;
  checkedAt: string;
}

// ---- Microsoft 365 (Microsoft Graph: /me/events, /me/messages, /sites/.../drive, /teams/.../channels) ----
export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  category: "Trade show" | "Customer visit" | "Internal" | "Webinar" | "Training";
  organizer: string;
}

export interface MailMessage {
  id: string;
  conversationId: string;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  /** Where the sender asked for replies to go, when that is not the address it came from. */
  replyTo?: { name: string; address: string }[];
  subject: string;
  bodyPreview: string;
  body: string;
  receivedDateTime: string;
  isDraft: boolean;
  folder: "Inbox" | "Sent Items" | "Drafts";
}

export interface TeamsPost {
  id: string;
  channel: string;
  text: string;
  createdDateTime: string;
  from?: string;
}

export interface BrandAsset {
  id: string;
  name: string;
  webUrl: string;
  kind: "photo" | "video" | "brochure" | "logo";
  productSku?: string;
  tags: string[];
}

export interface M365Connector {
  status(): Promise<ConnectorStatus>;
  listEvents(fromIso: string, toIso: string): Promise<CalendarEvent[]>;
  /** The latest of each folder, at most MAIL_LIST_LIMIT of each. */
  listMessages(folder?: MailMessage["folder"]): Promise<MailMessage[]>;
  createDraft(msg: Omit<MailMessage, "id" | "conversationId" | "receivedDateTime" | "isDraft" | "folder" | "bodyPreview" | "replyTo"> & { /** The id of the message this one answers, so it is filed in the same conversation. */ inReplyTo?: string }): Promise<MailMessage>;
  sendDraft(id: string): Promise<MailMessage>;
  listBrandAssets(): Promise<BrandAsset[]>;
  listTeamsPosts(): Promise<TeamsPost[]>;
  postTeamsMessage(channel: string, text: string): Promise<TeamsPost>;
}

// ---- Salesforce (REST API: SOQL on Account, Contact, Opportunity, Campaign, Case; sobjects/Task) ----
export type CustomerMarket = "Aged Care" | "Community Care" | "Hospital Care" | "Wholesale";

export interface SfAccount {
  Id: string;
  Name: string;
  Type: "Public Hospital" | "Private Hospital" | "Aged Care" | "Hospice" | "Community Care" | "Retail Partner";
  BillingCity: string;
  Region: string;
  AnnualSpend__c: number;
  OwnerName: string;
  /** The Cubro market the customer belongs to. */
  Market__c?: CustomerMarket;
  Phone?: string;
}

export interface SfContact {
  Id: string;
  AccountId: string;
  Name: string;
  Title: string;
  Email: string;
  Phone: string;
}

export interface SfOpportunity {
  Id: string;
  Name: string;
  AccountId: string;
  StageName: "Prospecting" | "Qualification" | "Proposal" | "Negotiation" | "Closed Won" | "Closed Lost";
  Amount: number;
  CloseDate: string;
  ProductSkus: string[];
  OwnerName?: string;
  CreatedDate?: string;
}

export interface SfCampaign {
  Id: string;
  Name: string;
  Type: "Product Launch" | "Trade Show" | "Webinar" | "Awareness" | "Seasonal";
  Status: "Planned" | "In Progress" | "Completed";
  StartDate: string;
  EndDate: string;
  ProductSkus: string[];
  Audience: string;
  KeyMessage: string;
}

export interface SfCase {
  Id: string;
  Subject: string;
  AccountId: string;
  ProductSku: string;
  Type: "Feedback" | "Complaint" | "Service" | "Enquiry";
  Description: string;
  CreatedDate: string;
  Status?: "New" | "In Progress" | "Closed";
  ContactName?: string;
  OwnerName?: string;
}

export interface SfActivity {
  Id: string;
  WhatId: string;
  Subject: string;
  Description: string;
  CreatedDate: string;
  OwnerName?: string;
}

export interface SfObjects {
  Account: SfAccount;
  Contact: SfContact;
  Opportunity: SfOpportunity;
  Campaign: SfCampaign;
  Case: SfCase;
}

export interface SalesforceConnector {
  status(): Promise<ConnectorStatus>;
  query<T extends keyof SfObjects>(sobject: T): Promise<SfObjects[T][]>;
  listActivities(): Promise<SfActivity[]>;
  logActivity(input: { WhatId: string; Subject: string; Description: string }): Promise<{ Id: string }>;
}

// ---- ClickUp (API v2: /list/{id}/task, /task/{id}) ----
export interface ClickUpTask {
  id: string;
  name: string;
  description: string;
  list: "Marketing" | "Purchasing" | "Operations" | "Sales";
  status: "to do" | "in progress" | "review" | "complete";
  assignees: string[];
  due_date: string | null;
  tags: string[];
  url: string;
  priority?: "urgent" | "high" | "normal" | "low";
}

export interface ClickUpConnector {
  status(): Promise<ConnectorStatus>;
  listTasks(list?: ClickUpTask["list"]): Promise<ClickUpTask[]>;
  createTask(input: Omit<ClickUpTask, "id" | "url" | "status"> & { status?: ClickUpTask["status"] }): Promise<ClickUpTask>;
  updateTask(id: string, patch: Partial<Pick<ClickUpTask, "status" | "description" | "due_date">>): Promise<ClickUpTask>;
}

// ---- Infor LN (ION API gateway: items, business partners, purchase orders, inventory) ----
/** Product categories as they appear on cubro.co.nz, plus spare parts. */
export type ItemGroup =
  | "Beds" | "Bedroom furniture" | "Pressure care" | "Moving and transferring" | "Falls prevention and recovery" | "Seating"
  | "Wheelchairs" | "Powered wheelchairs" | "Mobility scooters" | "Trolleys, carts and laundry" | "Infection control"
  | "Medical and respiratory" | "Hygiene" | "Walking and mobility aids" | "Theatre equipment" | "Spare parts";

export interface LnItem {
  item: string; // Cubro product code
  description: string;
  itemGroup: ItemGroup;
  /** List price, NZD excluding GST. */
  unitPrice: number;
  /** Standard purchase cost, NZD. */
  standardCost?: number;
  onHand: number;
  reorderPoint: number;
  safetyStock: number;
  avgMonthlyDemand: number;
  primarySupplier: string;
  isNew: boolean;
  launchDate?: string;
}

export interface LnSupplier {
  supplier: string;
  name: string;
  country: string;
  contactName: string;
  email: string;
  phone: string;
  paymentTerms: string;
  avgLeadTimeDays: number;
  onTimeRate: number; // 0..1
  categories: string[];
  city?: string;
  currency?: LnPurchaseOrder["currency"];
  incoterms?: string;
}

export interface LnPurchaseOrderLine {
  line: number;
  item: string;
  quantity: number;
  received: number;
  /** Unit price in the order currency. */
  price: number;
}

export interface LnPurchaseOrder {
  order: string;
  supplier: string;
  orderDate: string;
  plannedReceiptDate: string;
  confirmedReceiptDate: string | null;
  status: "Created" | "Sent" | "Confirmed" | "Partially received" | "Received" | "Closed";
  buyer: string;
  currency: "NZD" | "AUD" | "USD" | "EUR" | "GBP" | "CNY";
  lines: LnPurchaseOrderLine[];
}

export interface InforLnConnector {
  status(): Promise<ConnectorStatus>;
  listItems(): Promise<LnItem[]>;
  listSuppliers(): Promise<LnSupplier[]>;
  listPurchaseOrders(): Promise<LnPurchaseOrder[]>;
  getSupplier(id: string): Promise<LnSupplier | undefined>;
}

export interface Connectors {
  m365: M365Connector;
  salesforce: SalesforceConnector;
  clickup: ClickUpConnector;
  inforln: InforLnConnector;
}

/** How many messages of one folder a mailbox lists, the latest first. A folder that returns this many has older ones that are not listed. */
export const MAIL_LIST_LIMIT = 300;
