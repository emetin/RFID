import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function sqliteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyBackup(path, { expectedSha256 } = {}) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) throw new Error("Backup file does not exist");
  const database = new DatabaseSync(absolutePath, { readOnly: true });
  let integrity;
  let tableCount;
  try {
    integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    tableCount = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).get().count);
  } finally {
    database.close();
  }
  if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`);
  const digest = await sha256(absolutePath);
  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error("Backup SHA-256 does not match the expected manifest");
  }
  return {
    backupPath: absolutePath,
    sizeBytes: statSync(absolutePath).size,
    sha256: digest,
    integrity,
    tableCount
  };
}

export async function createBackup({
  sourcePath = "data/runtime/rfid.db",
  backupDir = "data/backups",
  now = new Date()
} = {}) {
  const absoluteSource = resolve(sourcePath);
  if (!existsSync(absoluteSource)) throw new Error("Source database does not exist");
  const absoluteDirectory = resolve(backupDir);
  mkdirSync(absoluteDirectory, { recursive: true });
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  let backupPath = join(absoluteDirectory, `rfid-${stamp}.db`);
  if (existsSync(backupPath)) {
    backupPath = join(absoluteDirectory, `rfid-${stamp}-${randomUUID()}.db`);
  }

  const source = new DatabaseSync(absoluteSource);
  try {
    source.exec("PRAGMA busy_timeout = 30000");
    source.exec(`VACUUM INTO ${sqliteLiteral(backupPath)}`);
  } finally {
    source.close();
  }

  const verification = await verifyBackup(backupPath);
  const manifest = {
    formatVersion: 1,
    sourcePath: absoluteSource,
    backupFile: basename(backupPath),
    createdAt: now.toISOString(),
    ...verification
  };
  const manifestPath = `${backupPath}.manifest.json`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return { ...manifest, manifestPath };
}
