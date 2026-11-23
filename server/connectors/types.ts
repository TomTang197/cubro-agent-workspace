// Interfaces shaped after the real systems' APIs so live implementations can replace the mocks.

export type SystemId = "m365" | "salesforce" | "clickup" | "inforln";

export interface ConnectorStatus {
  system: SystemId;
  name: string;
  mode: "mock" | "live";
  connected: boolean;
  detail: string;
  records: Record<string, number>;
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
  subject: string;
  bodyPreview: string;
  body: string;
  receivedDateTime: string;
  isDraft: boolean;
  folder: "Inbox" | "Sent Items" | "Drafts";
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
  listMessages(folder?: MailMessage["folder"]): Promise<MailMessage[]>;
  createDraft(msg: Omit<MailMessage, "id" | "conversationId" | "receivedDateTime" | "isDraft" | "folder" | "bodyPreview">): Promise<MailMessage>;
  sendDraft(id: string): Promise<MailMessage>;
  listBrandAssets(): Promise<BrandAsset[]>;
  postTeamsMessage(channel: string, text: string): Promise<{ id: string; channel: string; text: string; createdDateTime: string }>;
}

// ---- Salesforce (REST API: /sobjects/Account, Opportunity, Campaign, Product2, Case) ----
export interface SfAccount {
  Id: string;
  Name: string;
  Type: "Public Hospital" | "Private Hospital" | "Aged Care" | "Hospice" | "Disability Services" | "Distributor";
  BillingCity: string;
  Region: string;
  AnnualSpend__c: number;
  OwnerName: string;
}

export interface SfOpportunity {
  Id: string;
  Name: string;
  AccountId: string;
  StageName: "Prospecting" | "Qualification" | "Proposal" | "Negotiation" | "Closed Won" | "Closed Lost";
  Amount: number;
  CloseDate: string;
  ProductSkus: string[];
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
  Type: "Feedback" | "Complaint" | "Service";
  Description: string;
  CreatedDate: string;
}

export interface SalesforceConnector {
  status(): Promise<ConnectorStatus>;
  query<T extends "Account" | "Opportunity" | "Campaign" | "Case">(sobject: T): Promise<
    T extends "Account" ? SfAccount[] : T extends "Opportunity" ? SfOpportunity[] : T extends "Campaign" ? SfCampaign[] : SfCase[]
  >;
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
}

export interface ClickUpConnector {
  status(): Promise<ConnectorStatus>;
  listTasks(list?: ClickUpTask["list"]): Promise<ClickUpTask[]>;
  createTask(input: Omit<ClickUpTask, "id" | "url" | "status"> & { status?: ClickUpTask["status"] }): Promise<ClickUpTask>;
  updateTask(id: string, patch: Partial<Pick<ClickUpTask, "status" | "description" | "due_date">>): Promise<ClickUpTask>;
}

// ---- Infor LN (ION API / BODs: Item, SupplierPartyMaster, PurchaseOrder, InventoryCount) ----
export interface LnItem {
  item: string; // SKU
  description: string;
  itemGroup: "Beds" | "Mattresses" | "Patient handling" | "Bathroom & toileting" | "Seating" | "Bariatric" | "Tables & trolleys" | "Spares";
  unitPrice: number;
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
}

export interface LnPurchaseOrderLine {
  line: number;
  item: string;
  quantity: number;
  received: number;
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
  currency: "NZD" | "AUD" | "USD" | "EUR" | "CNY";
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
