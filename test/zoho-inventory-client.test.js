import test from "node:test";
import assert from "node:assert/strict";
import { ZohoInventoryClient } from "../src/integrations/zoho-inventory-client.js";

function response(status, payload, headers = new Map()) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (key) => headers.get(key) }, json: async () => payload };
}

test("Zoho client refreshes OAuth token and reads every item page", async () => {
  const requests = [];
  const client = new ZohoInventoryClient({
    clientId: "client", clientSecret: "secret", refreshToken: "refresh", organizationId: "org-1",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/oauth/v2/token")) return response(200, { access_token: "access", expires_in: 3600 });
      const page = new URL(url).searchParams.get("page");
      return response(200, { code: 0, items: [{ item_id: page }], page_context: { has_more_page: page === "1" } });
    }
  });
  const items = await client.listItems();
  assert.deepEqual(items.map((item) => item.item_id), ["1", "2"]);
  assert.equal(requests.filter((item) => item.url.includes("/oauth/v2/token")).length, 1);
  assert.match(requests[1].url, /organization_id=org-1/);
  assert.equal(requests[1].options.headers.Authorization, "Zoho-oauthtoken access");
});

test("Zoho client retries one rate-limited request", async () => {
  let apiCalls = 0;
  const waits = [];
  const client = new ZohoInventoryClient({
    clientId: "client", clientSecret: "secret", refreshToken: "refresh", organizationId: "org-1",
    sleepImpl: async (ms) => waits.push(ms),
    fetchImpl: async (url) => {
      if (String(url).includes("/oauth/v2/token")) return response(200, { access_token: "access" });
      apiCalls += 1;
      return apiCalls === 1
        ? response(429, { code: 44, message: "rate limit" }, new Map([["retry-after", "3"]]))
        : response(200, { code: 0, locations: [] });
    }
  });
  assert.deepEqual(await client.listLocations(), []);
  assert.deepEqual(waits, [3000]);
  assert.equal(apiCalls, 2);
});

test("Zoho client bulk-fetches item details in bounded batches", async () => {
  const batches = [];
  const client = new ZohoInventoryClient({
    clientId: "client", clientSecret: "secret", refreshToken: "refresh", organizationId: "org-1",
    fetchImpl: async (url) => {
      if (String(url).includes("/oauth/v2/token")) return response(200, { access_token: "access" });
      const ids = new URL(url).searchParams.get("item_ids").split(",");
      batches.push(ids);
      return response(200, { code: 0, items: ids.map((item_id) => ({ item_id })) });
    }
  });
  const details = await client.bulkItemDetails(["1", "2", "3"], { batchSize: 2 });
  assert.deepEqual(batches, [["1", "2"], ["3"]]);
  assert.deepEqual(details.map((item) => item.item_id), ["1", "2", "3"]);
});
