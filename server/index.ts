import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { Store } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prod = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? (prod ? 8080 : 3001));
const store = new Store({ dataDir: process.env.DATA_DIR ?? path.join(root, ".data") });
const app = createApp(store, { staticDir: prod ? path.join(root, "dist") : undefined });
app.listen(port, "0.0.0.0", () => console.log(`Cubro agent workspace API on http://localhost:${port}`));
