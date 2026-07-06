import { SqliteStore } from "../core/sqlite-store.js";
import { PostgresStore } from "../core/postgres-store.js";
import { deliverIntegrationOutbox } from "./outbox-delivery.js";

let integrations;
try {
  integrations = JSON.parse(process.env.INTEGRATION_ENDPOINTS ?? "{}");
} catch {
  console.error("INTEGRATION_ENDPOINTS must be valid JSON. See .env.example.");
  process.exit(1);
}

if (Object.keys(integrations).length === 0) {
  console.error("At least one tenant integration endpoint is required.");
  process.exit(1);
}

const store = process.env.DATA_STORE === "postgres"
  ? new PostgresStore()
  : new SqliteStore(process.env.SQLITE_PATH ?? "data/runtime/rfid.db");
const results = {};
try {
  for (const [tenantId, config] of Object.entries(integrations)) {
    results[tenantId] = await deliverIntegrationOutbox({
      store,
      tenantId,
      endpoint: config.endpoint,
      secret: config.secret
    });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await store.close();
}
