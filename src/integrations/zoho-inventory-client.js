const DEFAULT_TIMEOUT_MS = 15_000;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ZohoInventoryClient {
  #accessToken = null;
  #accessTokenExpiresAt = 0;

  constructor({
    clientId,
    clientSecret,
    refreshToken,
    organizationId,
    accountsUrl = "https://accounts.zoho.com",
    apiUrl = "https://www.zohoapis.com/inventory/v1",
    fetchImpl = fetch,
    now = Date.now,
    sleepImpl = sleep,
    timeoutMs = DEFAULT_TIMEOUT_MS
  }) {
    this.clientId = required(clientId, "ZOHO_CLIENT_ID");
    this.clientSecret = required(clientSecret, "ZOHO_CLIENT_SECRET");
    this.refreshToken = required(refreshToken, "ZOHO_REFRESH_TOKEN");
    this.organizationId = required(organizationId, "ZOHO_ORGANIZATION_ID");
    this.accountsUrl = accountsUrl.replace(/\/$/, "");
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleepImpl = sleepImpl;
    this.timeoutMs = timeoutMs;
  }

  async accessToken() {
    if (this.#accessToken && this.now() < this.#accessTokenExpiresAt) {
      return this.#accessToken;
    }
    const parameters = new URLSearchParams({
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token"
    });
    const response = await this.#fetch(`${this.accountsUrl}/oauth/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: parameters.toString()
    });
    const payload = await response.json();
    if (!response.ok || !payload.access_token) {
      throw new Error(`Zoho OAuth failed (${response.status}): ${payload.error ?? "missing access token"}`);
    }
    this.#accessToken = payload.access_token;
    const expiresIn = Number(payload.expires_in ?? 3600);
    this.#accessTokenExpiresAt = this.now() + Math.max(30, expiresIn - 60) * 1000;
    return this.#accessToken;
  }

  async request(path, { method = "GET", query = {}, body, retry429 = true } = {}) {
    const url = new URL(`${this.apiUrl}/${path.replace(/^\//, "")}`);
    url.searchParams.set("organization_id", this.organizationId);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const token = await this.accessToken();
    const response = await this.#fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 429 && retry429) {
      const retryAfter = Math.min(60, Math.max(1, Number(response.headers?.get?.("retry-after") ?? 2)));
      await this.sleepImpl(retryAfter * 1000);
      return this.request(path, { method, query, body, retry429: false });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      throw new Error(`Zoho API ${method} ${url.pathname} failed (${response.status}): ${payload.message ?? payload.code ?? "unknown error"}`);
    }
    return payload;
  }

  async listAll(path, responseKey, query = {}) {
    const records = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.request(path, { query: { ...query, page, per_page: 200 } });
      records.push(...(payload[responseKey] ?? []));
      if (!payload.page_context?.has_more_page) return records;
    }
  }

  listOrganizations() {
    return this.request("organizations").then((payload) => payload.organizations ?? []);
  }

  listItems(query) {
    return this.listAll("items", "items", query);
  }

  async bulkItemDetails(itemIds, { batchSize = 50 } = {}) {
    const details = [];
    for (let index = 0; index < itemIds.length; index += batchSize) {
      const ids = itemIds.slice(index, index + batchSize);
      const payload = await this.request("itemdetails", { query: { item_ids: ids.join(",") } });
      details.push(...(payload.items ?? []));
    }
    return details;
  }

  listLocations() {
    return this.request("locations", { query: { is_hierarchical_response: false } })
      .then((payload) => payload.locations ?? []);
  }

  createInventoryAdjustment(adjustment) {
    return this.request("inventoryadjustments", { method: "POST", body: adjustment });
  }

  createTransferOrder(transferOrder) {
    return this.request("transferorders", { method: "POST", body: transferOrder });
  }

  async #fetch(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function zohoClientFromEnv(env = process.env, overrides = {}) {
  return new ZohoInventoryClient({
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    refreshToken: env.ZOHO_REFRESH_TOKEN,
    organizationId: env.ZOHO_ORGANIZATION_ID,
    accountsUrl: env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com",
    apiUrl: env.ZOHO_API_URL ?? "https://www.zohoapis.com/inventory/v1",
    ...overrides
  });
}
