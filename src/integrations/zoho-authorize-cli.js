import { readFileSync, writeFileSync } from "node:fs";

const required = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_AUTHORIZATION_CODE"];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`${name} is required in .env`);
    process.exit(1);
  }
}

const accountsUrl = (process.env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com").replace(/\/$/, "");
const parameters = new URLSearchParams({
  code: process.env.ZOHO_AUTHORIZATION_CODE,
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  grant_type: "authorization_code"
});

const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: parameters.toString()
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || !payload.refresh_token) {
  console.error(`Zoho authorization failed (${response.status}): ${payload.error ?? "refresh token missing"}`);
  process.exit(1);
}

const envPath = ".env";
const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
let refreshTokenWritten = false;
const updated = lines.flatMap((line) => {
  if (line.startsWith("ZOHO_AUTHORIZATION_CODE=")) return [];
  if (line.startsWith("ZOHO_REFRESH_TOKEN=")) {
    refreshTokenWritten = true;
    return [`ZOHO_REFRESH_TOKEN=${payload.refresh_token}`];
  }
  return [line];
});
if (!refreshTokenWritten) updated.push(`ZOHO_REFRESH_TOKEN=${payload.refresh_token}`);
writeFileSync(envPath, `${updated.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
console.log("Zoho refresh token was stored in .env; the one-time authorization code was removed.");
