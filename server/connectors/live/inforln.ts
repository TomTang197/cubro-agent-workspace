// Infor LN through the ION API gateway, signed in as a backend service (service account keys from the .ionapi file).
// LN's OData service and property names differ between installations, so the collection paths are settings and
// property names can be mapped with INFORLN_FIELDS. A property that is not mapped is read by the workspace name.
import { baseStatus, failedStatus, jsonSetting, type Env, type FetchLike } from "../config.js";
import type { InforLnConnector, LnItem, LnPurchaseOrder, LnPurchaseOrderLine, LnSupplier } from "../types.js";
import { createHttp, requireSettings, tokenCache, trimSlash } from "./http.js";

type Rec = Record<string, unknown>;
type Collection = "items" | "suppliers" | "purchaseOrders" | "purchaseOrderLines";
interface ODataPage { value: Rec[]; "@odata.nextLink"?: string; "@odata.count"?: number }
const MAX_PAGES = 200;

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => Number(v) || 0;
const date = (v: unknown) => str(v).slice(0, 10);
const STATUSES: LnPurchaseOrder["status"][] = ["Created", "Sent", "Confirmed", "Partially received", "Received", "Closed"];
const CURRENCIES: LnPurchaseOrder["currency"][] = ["NZD", "AUD", "USD", "EUR", "GBP", "CNY"];

/** Works out a purchase order's stage when LN's own status text is not one of the six the workspace uses. */
export function orderStatus(raw: string, lines: LnPurchaseOrderLine[], confirmed: string | null): LnPurchaseOrder["status"] {
  const known = STATUSES.find((s) => s.toLowerCase() === raw.toLowerCase());
  if (known) return known;
  const ordered = lines.reduce((n, l) => n + l.quantity, 0), received = lines.reduce((n, l) => n + l.received, 0);
  if (/clos|cancel/i.test(raw)) return "Closed";
  if (ordered > 0 && received >= ordered) return "Received";
  if (received > 0) return "Partially received";
  if (confirmed) return "Confirmed";
  return /sent|print|approv|releas/i.test(raw) ? "Sent" : "Created";
}

export function createLiveInforLn(env: Env, fetchImpl: FetchLike = fetch): InforLnConnector {
  const http = createHttp("inforln", fetchImpl);
  const token = tokenCache(() => http.json(env.INFORLN_TOKEN_URL!, { method: "POST", form: {
    grant_type: "password", username: env.INFORLN_SERVICE_ACCOUNT_KEY!, password: env.INFORLN_SERVICE_ACCOUNT_SECRET!, client_id: env.INFORLN_CLIENT_ID!, client_secret: env.INFORLN_CLIENT_SECRET!,
  } }));
  const url = (path: string) => (path.startsWith("http") ? path : `${trimSlash(env.INFORLN_ION_URL!)}/${path.replace(/^\/+/, "")}`);
  const call = async (path: string) => {
    requireSettings("inforln", env);
    return http.json<ODataPage>(url(path), { headers: { authorization: `Bearer ${await token.get()}`, "X-Infor-LnCompany": env.INFORLN_COMPANY! } });
  };
  const all = async (path: string) => {
    const out: Rec[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const res: ODataPage = await call(next);
      out.push(...res.value);
      next = res["@odata.nextLink"];
    }
    return out;
  };
  const count = async (path: string) => {
    const res = await call(`${path}${path.includes("?") ? "&" : "?"}$top=1&$count=true`);
    return res["@odata.count"] ?? res.value.length;
  };
  /** Reads a workspace field from an LN record, using the mapped property name when one is set. */
  const reader = (collection: Collection) => {
    const map = jsonSetting<Partial<Record<Collection, Record<string, string>>>>("inforln", env, "INFORLN_FIELDS")[collection] ?? {};
    return (r: Rec, field: string) => r[map[field] ?? field];
  };
  const toLine = (r: Rec, get: (r: Rec, f: string) => unknown): LnPurchaseOrderLine => ({ line: num(get(r, "line")), item: str(get(r, "item")), quantity: num(get(r, "quantity")), received: num(get(r, "received")), price: num(get(r, "price")) });

  const listPurchaseOrders = async (): Promise<LnPurchaseOrder[]> => {
    const get = reader("purchaseOrders"), getLine = reader("purchaseOrderLines");
    const [orders, lineRecs] = await Promise.all([all(env.INFORLN_PURCHASE_ORDERS_PATH!), env.INFORLN_PURCHASE_ORDER_LINES_PATH ? all(env.INFORLN_PURCHASE_ORDER_LINES_PATH) : Promise.resolve([])]);
    const separate = new Map<string, LnPurchaseOrderLine[]>();
    for (const r of lineRecs) { const o = str(getLine(r, "order")); separate.set(o, [...(separate.get(o) ?? []), toLine(r, getLine)]); }
    return orders.map((r) => {
      const order = str(get(r, "order"));
      const nested = get(r, "lines");
      const lines = (Array.isArray(nested) ? (nested as Rec[]).map((l) => toLine(l, getLine)) : separate.get(order) ?? []).sort((a, b) => a.line - b.line);
      const confirmed = date(get(r, "confirmedReceiptDate")) || null;
      const currency = str(get(r, "currency")).toUpperCase() as LnPurchaseOrder["currency"];
      return {
        order, supplier: str(get(r, "supplier")), orderDate: date(get(r, "orderDate")), plannedReceiptDate: date(get(r, "plannedReceiptDate")), confirmedReceiptDate: confirmed,
        status: orderStatus(str(get(r, "status")), lines, confirmed), buyer: str(get(r, "buyer")), currency: CURRENCIES.includes(currency) ? currency : "NZD", lines,
      };
    });
  };

  const listSuppliers = async (): Promise<LnSupplier[]> => {
    const get = reader("suppliers");
    const [recs, orders] = await Promise.all([all(env.INFORLN_SUPPLIERS_PATH!), listPurchaseOrders()]);
    return recs.map((r) => {
      const supplier = str(get(r, "supplier"));
      // LN does not hold delivery performance on the business partner, so it is worked out from the supplier's confirmed orders unless a mapped property supplies it.
      const mine = orders.filter((o) => o.supplier === supplier && o.confirmedReceiptDate);
      const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
      const lead = mine.length ? Math.round(mine.reduce((n, o) => n + days(o.orderDate, o.confirmedReceiptDate!), 0) / mine.length) : 0;
      const onTime = mine.length ? mine.filter((o) => o.confirmedReceiptDate! <= o.plannedReceiptDate).length / mine.length : 1;
      const categories = get(r, "categories");
      const currency = str(get(r, "currency")).toUpperCase() as LnPurchaseOrder["currency"];
      return {
        supplier, name: str(get(r, "name")), country: str(get(r, "country")), contactName: str(get(r, "contactName")), email: str(get(r, "email")), phone: str(get(r, "phone")), paymentTerms: str(get(r, "paymentTerms")),
        avgLeadTimeDays: get(r, "avgLeadTimeDays") != null ? num(get(r, "avgLeadTimeDays")) : lead, onTimeRate: get(r, "onTimeRate") != null ? num(get(r, "onTimeRate")) : +onTime.toFixed(2),
        categories: Array.isArray(categories) ? categories.map(str) : str(categories).split(/[;,]/).map((s) => s.trim()).filter(Boolean),
        city: str(get(r, "city")) || undefined, currency: CURRENCIES.includes(currency) ? currency : undefined, incoterms: str(get(r, "incoterms")) || undefined,
      };
    });
  };

  return {
    async status() {
      try {
        const [items, suppliers, purchaseOrders] = await Promise.all([count(env.INFORLN_ITEMS_PATH ?? ""), count(env.INFORLN_SUPPLIERS_PATH ?? ""), count(env.INFORLN_PURCHASE_ORDERS_PATH ?? "")]);
        return { ...baseStatus("inforln", "live", env), connected: true, detail: `Connected to Infor LN company ${env.INFORLN_COMPANY} through ${new URL(env.INFORLN_ION_URL!).host}`, records: { items, suppliers, "purchase orders": purchaseOrders } };
      } catch (e) { token.clear(); return failedStatus("inforln", "live", env, e); }
    },
    async listItems() {
      const get = reader("items");
      return (await all(env.INFORLN_ITEMS_PATH!)).map((r): LnItem => {
        const isNew = get(r, "isNew"), launch = date(get(r, "launchDate"));
        return {
          item: str(get(r, "item")), description: str(get(r, "description")), itemGroup: str(get(r, "itemGroup")) as LnItem["itemGroup"], unitPrice: num(get(r, "unitPrice")), standardCost: get(r, "standardCost") != null ? num(get(r, "standardCost")) : undefined,
          onHand: num(get(r, "onHand")), reorderPoint: num(get(r, "reorderPoint")), safetyStock: num(get(r, "safetyStock")), avgMonthlyDemand: num(get(r, "avgMonthlyDemand")), primarySupplier: str(get(r, "primarySupplier")),
          // Without an explicit flag, an item counts as new for 90 days after its launch date.
          isNew: isNew != null ? isNew === true || /^(true|yes|1)$/i.test(str(isNew)) : Boolean(launch) && Date.now() - Date.parse(launch) < 90 * 86_400_000, launchDate: launch || undefined,
        };
      });
    },
    listSuppliers,
    listPurchaseOrders,
    async getSupplier(id) { return (await listSuppliers()).find((s) => s.supplier === id); },
  };
}
