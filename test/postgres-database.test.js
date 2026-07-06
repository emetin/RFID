import test from "node:test";
import assert from "node:assert/strict";
import { PostgresDatabase } from "../src/core/postgres-database.js";

function mockPool({ applied = [] } = {}) {
  const poolQueries = [];
  const clientQueries = [];
  let released = 0;
  const client = {
    async query(sql, parameters) {
      clientQueries.push({ sql, parameters });
      return { rows: [] };
    },
    release() {
      released += 1;
    }
  };
  return {
    pool: {
      async query(sql) {
        poolQueries.push(sql);
        if (sql.includes("SELECT filename")) {
          return { rows: applied.map((filename) => ({ filename })) };
        }
        if (sql.includes("current_database")) {
          return {
            rows: [{
              database: "globaltex_rfid",
              server_time: "2026-07-02T14:00:00.000Z"
            }]
          };
        }
        return { rows: [] };
      },
      async connect() {
        return client;
      },
      async end() {}
    },
    poolQueries,
    clientQueries,
    released: () => released
  };
}

test("PostgreSQL tenant transaction sets RLS context before application queries", async () => {
  const mock = mockPool();
  const database = new PostgresDatabase({ pool: mock.pool });
  const result = await database.tenantTransaction(
    "11111111-1111-1111-1111-111111111111",
    async (client) => {
      await client.query("SELECT * FROM products");
      return "done";
    }
  );
  assert.equal(result, "done");
  assert.equal(mock.clientQueries[0].sql, "BEGIN");
  assert.equal(mock.clientQueries[1].sql, "SET LOCAL ROLE globaltex_app");
  assert.match(mock.clientQueries[2].sql, /set_config\('app\.tenant_id'/);
  assert.equal(mock.clientQueries[3].sql, "SELECT * FROM products");
  assert.equal(mock.clientQueries[4].sql, "COMMIT");
  assert.equal(mock.released(), 1);
});

test("PostgreSQL migration runner records each SQL file transactionally", async () => {
  const mock = mockPool();
  const database = new PostgresDatabase({ pool: mock.pool });
  const result = await database.migrate();
  assert.deepEqual(result.migrated, [
    "001_initial.sql",
    "002_tenant_table_rls.sql",
      "003_store_parity.sql",
      "004_external_event_ids.sql",
      "005_asset_custody_history.sql",
      "006_read_event_retention_index.sql",
      "007_exception_cases.sql",
      "008_asset_lifecycle.sql",
      "009_admin_user_directory.sql"
  ]);
  assert.equal(mock.clientQueries[0].sql, "BEGIN");
  assert.match(mock.clientQueries[1].sql, /CREATE TABLE tenants/);
  assert.match(mock.clientQueries[2].sql, /INSERT INTO schema_migrations/);
  assert.deepEqual(mock.clientQueries[2].parameters, ["001_initial.sql"]);
  assert.equal(mock.clientQueries[3].sql, "COMMIT");
});
