import { createApp } from "./app.js";
import { SqliteStore } from "../core/sqlite-store.js";
import { PostgresStore } from "../core/postgres-store.js";

const port = Number(process.env.PORT ?? 8080);
const production = process.env.NODE_ENV === "production";
let credentials;

try {
  credentials = process.env.DEVICE_CREDENTIALS
    ? JSON.parse(process.env.DEVICE_CREDENTIALS)
    : null;
} catch {
  console.error("DEVICE_CREDENTIALS must be valid JSON. See .env.example.");
  process.exit(1);
}

if (!credentials) {
  if (production) {
    console.error("DEVICE_CREDENTIALS is required in production.");
    process.exit(1);
  }
  credentials = {
    "local-reader": {
      tenantId: "globaltex-local",
      readerId: "local-reader",
      secret: "local-device-secret"
    }
  };
  console.warn("Using local development device credentials.");
}

let adminIdentities;
try {
  adminIdentities = process.env.ADMIN_IDENTITIES
    ? JSON.parse(process.env.ADMIN_IDENTITIES)
    : null;
} catch {
  console.error("ADMIN_IDENTITIES must be valid JSON. See .env.example.");
  process.exit(1);
}

let customerApiCredentials;
try {
  customerApiCredentials = process.env.CUSTOMER_API_CREDENTIALS
    ? JSON.parse(process.env.CUSTOMER_API_CREDENTIALS)
    : {};
} catch {
  console.error("CUSTOMER_API_CREDENTIALS must be valid JSON. See .env.example.");
  process.exit(1);
}

if (production && !process.env.ADMIN_TOKEN && !adminIdentities) {
  console.error("ADMIN_TOKEN or ADMIN_IDENTITIES is required in production.");
  process.exit(1);
}
const sessionSecret = process.env.SESSION_SECRET ??
  (production ? null : "local-development-session-secret");
if (!sessionSecret || sessionSecret.length < 24) {
  console.error("SESSION_SECRET with at least 24 characters is required.");
  process.exit(1);
}

const dataStore = process.env.DATA_STORE ?? "sqlite";
if (!["sqlite", "postgres"].includes(dataStore)) {
  console.error("DATA_STORE must be sqlite or postgres.");
  process.exit(1);
}
if (production) {
  const errors = [];
  if (dataStore !== "postgres") errors.push("DATA_STORE must be postgres");
  if (process.env.COOKIE_SECURE !== "true") errors.push("COOKIE_SECURE must be true");
  if (!String(process.env.PUBLIC_BASE_URL ?? "").startsWith("https://")) {
    errors.push("PUBLIC_BASE_URL must use https://");
  }
  for (const [key, value] of Object.entries(credentials)) {
    if (String(value.secret ?? "").length < 32) errors.push(`device secret ${key} must be at least 32 characters`);
  }
  const adminTokens = adminIdentities
    ? Object.keys(adminIdentities)
    : [process.env.ADMIN_TOKEN];
  if (adminTokens.some((token) => String(token ?? "").length < 32)) {
    errors.push("admin bootstrap tokens must be at least 32 characters");
  }
  if (Object.keys(customerApiCredentials).some((token) => token.length < 32)) {
    errors.push("customer API tokens must be at least 32 characters");
  }
  if (errors.length) {
    console.error(`Production configuration rejected:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
}
const store = dataStore === "postgres"
  ? new PostgresStore()
  : new SqliteStore(process.env.SQLITE_PATH ?? "data/runtime/rfid.db");
const localTenantId = process.env.ADMIN_TENANT_ID ?? Object.values(credentials)[0].tenantId;

if (!production && dataStore === "sqlite" && store.productsFor(localTenantId).length === 0) {
  store.upsertProducts(localTenantId, [{
    sku: "BT-WHT-2754",
    name: "Bath Towel",
    category: "Towels",
    unitsPerBox: 2,
    boxesPerPallet: 2,
    size: "27x54 in",
    color: "White"
  }]);
  store.registerAssets(localTenantId, Array.from({ length: 5 }, (_, index) => ({
    epc: `3034257BF7194E400000000${index + 1}`,
    sku: "BT-WHT-2754"
  })));
  console.log("Seeded the local SQLite database with demo products and EPCs.");
}

const server = createApp({
  credentials,
  customerApiCredentials,
  admin: adminIdentities
    ? { identities: adminIdentities }
      : {
        token: process.env.ADMIN_TOKEN ?? "local-admin",
        tenantId: localTenantId,
        role: process.env.ADMIN_ROLE ?? (production ? "hotel_admin" : "chain_admin")
  },
  store,
  requireProvisionedReaders: production,
  sessionSecret,
  secureCookies: process.env.COOKIE_SECURE === "true"
});

server.listen(port, () => {
  console.log(`Globaltex RFID API listening on http://127.0.0.1:${port}`);
  console.log(`Data store: ${dataStore}`);
  if (!production) console.log("Local dashboard login: admin / local-admin");
});

function shutdown() {
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
