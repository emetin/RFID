import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

export class PostgresDatabase {
  #pool;

  constructor({
    connectionString = process.env.DATABASE_URL,
    ssl = process.env.PGSSL === "require"
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
    pool
  } = {}) {
    if (pool) {
      this.#pool = pool;
      return;
    }
    if (!connectionString) throw new Error("DATABASE_URL is required");
    this.#pool = new Pool({
      connectionString,
      ssl,
      max: Number(process.env.PGPOOL_MAX ?? 20),
      idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS ?? 30_000),
      connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS ?? 10_000)
    });
  }

  async close() {
    await this.#pool.end();
  }

  async healthCheck() {
    const startedAt = Date.now();
    const result = await this.#pool.query(
      "SELECT current_database() AS database, now() AS server_time"
    );
    return {
      status: "ok",
      database: result.rows[0].database,
      serverTime: result.rows[0].server_time,
      latencyMs: Date.now() - startedAt
    };
  }

  async migrate(directory = resolve("db/migrations")) {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await this.#pool.query("SELECT filename FROM schema_migrations")).rows
        .map((row) => row.filename)
    );
    const files = readdirSync(directory)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migrated = [];

    for (const filename of files) {
      if (applied.has(filename)) continue;
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(resolve(directory, filename), "utf8"));
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename]
        );
        await client.query("COMMIT");
        migrated.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${filename} failed: ${error.message}`, {
          cause: error
        });
      } finally {
        client.release();
      }
    }
    return { migrated, alreadyApplied: files.length - migrated.length };
  }

  async tenantTransaction(tenantId, operation) {
    if (!tenantId) throw new Error("tenantId is required");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE globaltex_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true)",
        [tenantId]
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async systemTransaction(operation) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
