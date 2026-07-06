import { PostgresDatabase } from "../core/postgres-database.js";

const command = process.argv[2];
const database = new PostgresDatabase();
try {
  if (command === "migrate") {
    console.log(JSON.stringify(await database.migrate(), null, 2));
  } else if (command === "check") {
    console.log(JSON.stringify(await database.healthCheck(), null, 2));
  } else {
    console.error("Usage: node src/ops/postgres-cli.js <migrate|check>");
    process.exitCode = 1;
  }
} finally {
  await database.close();
}
