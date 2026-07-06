import { readFileSync } from "node:fs";
import { createBackup, verifyBackup } from "./backup.js";

const command = process.argv[2];

if (command === "create") {
  const result = await createBackup({
    sourcePath: process.env.SQLITE_PATH ?? "data/runtime/rfid.db",
    backupDir: process.env.BACKUP_DIR ?? "data/backups"
  });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "verify") {
  const path = process.argv[3];
  if (!path) {
    console.error("Usage: npm run backup:verify -- <backup.db> [manifest.json]");
    process.exit(1);
  }
  const manifestPath = process.argv[4];
  const manifest = manifestPath
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : null;
  const result = await verifyBackup(path, {
    expectedSha256: manifest?.sha256
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error("Usage: node src/ops/backup-cli.js <create|verify>");
  process.exit(1);
}
