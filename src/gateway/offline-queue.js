import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS queued_batches (
    queue_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    encoding TEXT NOT NULL,
    iv TEXT,
    auth_tag TEXT,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS queued_batches_order_idx
    ON queued_batches (created_at, queue_id);
`;

export class OfflineQueue {
  #database;
  #key;

  constructor(path = "data/runtime/edge-queue.db", { encryptionKey } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(SCHEMA);
    this.#key = encryptionKey
      ? createHash("sha256").update(encryptionKey).digest()
      : null;
  }

  close() {
    this.#database.close();
  }

  enqueue(batch, queueId = randomUUID()) {
    const encoded = this.#encode(JSON.stringify(batch));
    this.#database.prepare(`
      INSERT INTO queued_batches (
        queue_id, payload, encoding, iv, auth_tag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      queueId,
      encoded.payload,
      encoded.encoding,
      encoded.iv,
      encoded.authTag,
      new Date().toISOString()
    );
    return queueId;
  }

  pending(limit = 100) {
    return this.#database.prepare(`
      SELECT * FROM queued_batches
      ORDER BY rowid
      LIMIT ?
    `).all(limit).map((row) => ({
      queueId: row.queue_id,
      batch: JSON.parse(this.#decode(row)),
      createdAt: row.created_at,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,
      lastError: row.last_error
    }));
  }

  remove(queueId) {
    this.#database.prepare(`
      DELETE FROM queued_batches WHERE queue_id = ?
    `).run(queueId);
  }

  recordFailure(queueId, error) {
    this.#database.prepare(`
      UPDATE queued_batches
      SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
      WHERE queue_id = ?
    `).run(
      new Date().toISOString(),
      String(error?.message ?? error).slice(0, 1000),
      queueId
    );
  }

  size() {
    return Number(
      this.#database.prepare("SELECT COUNT(*) AS count FROM queued_batches").get().count
    );
  }

  #encode(value) {
    if (!this.#key) {
      return { payload: value, encoding: "plain", iv: null, authTag: null };
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      payload: payload.toString("base64"),
      encoding: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64")
    };
  }

  #decode(row) {
    if (row.encoding === "plain") return row.payload;
    if (row.encoding !== "aes-256-gcm" || !this.#key) {
      throw new Error("Edge queue encryption key is missing or incompatible");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(row.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.payload, "base64")),
      decipher.final()
    ]).toString("utf8");
  }
}

export async function flushOfflineQueue({ queue, send, limit = 100 }) {
  let sent = 0;
  while (true) {
    const pending = queue.pending(limit);
    if (pending.length === 0) {
      return { sent, remaining: 0, error: null };
    }
    for (const item of pending) {
      try {
        await send(item.batch);
        queue.remove(item.queueId);
        sent += 1;
      } catch (error) {
        queue.recordFailure(item.queueId, error);
        return {
          sent,
          remaining: queue.size(),
          error: String(error?.message ?? error)
        };
      }
    }
  }
}
