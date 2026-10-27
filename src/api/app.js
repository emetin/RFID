import { changeHotelContact } from '../core/hotel-contacts.js';
import { importZohoCatalog } from '../integrations/zoho-catalog-import.js';
import { buildReports, reportCsv } from "../core/reports.js";
import { setResourceActive } from "../core/resource-archive.js";
import { companyPortalAccess, commercialRequest } from "../core/portal-access.js";
import { createHotelPreviewStore, HOTEL_PREVIEW_TENANT } from "../core/hotel-preview.js";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SerialPort } from "serialport";
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
  verifySignature
} from "../core/auth.js";
import { InventoryStore } from "../core/inventory-store.js";
import { parseAssetCsv, parseProductCsv } from "../core/csv.js";
import { calculatePackaging } from "../core/packaging.js";
import {
  scanRru9809,
  writeRru9809Epc
} from "../gateway/adapters/rru9809usb.js";
import { gs1UsProfile } from "../standards/gs1.js";
import { managedHotels, evaluateStock, saveStockPolicy, transitionRequest, dispatchStockRequest, requestCancellation } from "../core/hotel-operations.js";

import { setupWarehouses, provisionWorkflowLocation, ensureOperatorStation, hotelDetails, workflowSnapshot, workflowScan, dispatchTransfer, receiveTransfer, saveLifespan, enforceLifespan, normalizeEpcs } from "../core/supply-workflow.js";

const MAX_BODY_BYTES = 2_000_000;
const EPC_PATTERN = /^[0-9A-F]{8,96}$/;
const DASHBOARD = readFileSync(new URL("../../public/dashboard.html", import.meta.url), "utf8");
const LOGIN = readFileSync(new URL("../../public/login.html", import.meta.url), "utf8");
const WORKFLOW_JS = readFileSync(new URL("../../public/workflow.js", import.meta.url));
const PORTAL_DESIGN_CSS = readFileSync(new URL("../../public/portal-design.css", import.meta.url));
const PORTAL_FONTS = Object.fromEntries(['Inter','Manrope'].map(name=>[name,readFileSync(new URL(`../../public/assets/fonts/${name}-Variable.woff2`,import.meta.url))]));
const PORTAL_DESIGN_JS = Buffer.from(readFileSync(new URL("../../public/portal-design.js", import.meta.url), "utf8").replace("'/assets/portal-design.css'", "'/assets/portal-design.css?v="+createHash("sha256").update(PORTAL_DESIGN_CSS).digest("hex").slice(0,12)+"'"));
const PORTAL_REPORTS_JS = readFileSync(new URL("../../public/portal-reports.js", import.meta.url));
const PORTAL_ROLES_JS = readFileSync(new URL("../../public/portal-roles.js", import.meta.url));
const PORTAL = readFileSync(new URL("../../public/portal.html", import.meta.url), "utf8")
  .replace('src="/assets/workflow.js"', `src="/assets/workflow.js?v=${createHash("sha256").update(WORKFLOW_JS).digest("hex").slice(0, 12)}"`)
  .replace('<script>','<script src="/assets/portal-roles.js?v='+createHash("sha256").update(PORTAL_ROLES_JS).digest("hex").slice(0,12)+'" defer></script>\n<script src="/assets/portal-design.js?v='+createHash("sha256").update(PORTAL_DESIGN_JS).digest("hex").slice(0,12)+'" defer></script>\n<script src="/assets/portal-reports.js?v='+createHash("sha256").update(PORTAL_REPORTS_JS).digest("hex").slice(0,12)+'" defer></script>\n<script>');
const PATAK_LOGO = readFileSync(new URL("../../public/assets/patak-logo.png", import.meta.url));
const GLOBALTEX_LOGO = readFileSync(new URL("../../public/assets/globaltex-logo.png", import.meta.url));
const ADMIN_ROLES = new Set(["viewer", "operator", "hotel_admin", "chain_admin"]);
const CUSTOMER_API_SCOPES = new Set([
  "catalog:read", "catalog:write", "assets:write", "inventory:read",
  "encoding:read", "encoding:work"
]);

function tokenHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function customerPrincipal(request, credentialIndex) {
  const authorization = String(request.headers.authorization ?? "");
  if (!authorization.startsWith("Bearer ")) return { error: "customer_api_auth_required" };
  const credential = credentialIndex.get(tokenHash(authorization.slice(7).trim()));
  if (!credential) return { error: "customer_api_auth_required" };
  if (!credential.tenantId || !credential.clientId) return { error: "customer_api_credential_invalid" };
  const scopes = new Set(credential.scopes ?? []);
  if ([...scopes].some((scope) => !CUSTOMER_API_SCOPES.has(scope))) {
    return { error: "customer_api_credential_invalid" };
  }
  return { clientId: credential.clientId, tenantId: credential.tenantId, scopes };
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function html(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function binary(response, status, body, contentType) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": (contentType.startsWith("text/javascript") || contentType.startsWith("text/css")) ? "no-cache" : "public, max-age=3600"
  });
  response.end(body);
}

function linenStage(zoneType) {
  const type = String(zoneType ?? "").toLowerCase();
  if (["clean", "clean_stock", "clean_return", "linen_room", "storage"].includes(type)) return "clean";
  if (["room", "in_room", "assigned", "in_use"].includes(type)) return "inRoom";
  if (["soiled", "hamper", "dirty"].includes(type)) return "soiled";
  if (["wash", "in_wash", "laundry"].includes(type)) return "inWash";
  if (type === "drying") return "drying";
  if (type === "distribution") return "distribution";
  return "other";
}

async function linenOperations(store, tenantId, { now = Date.now(), safetyMargin = 20 } = {}) {
  const [inventory, zones] = await Promise.all([
    store.inventoryFor(tenantId),
    store.zonesFor(tenantId)
  ]);
  const zoneTypes = new Map(zones.map((zone) => [zone.zoneId, zone.zoneType]));
  const stages = { clean: 0, inRoom: 0, soiled: 0, inWash: 0, drying: 0, distribution: 0, other: 0 };
  const notSeen = [];
  const inspection = [];
  for (const item of inventory) {
    stages[linenStage(zoneTypes.get(item.zoneId))] += 1;
    if (item.lastSeenAt && now - Date.parse(item.lastSeenAt) >= 30 * 86400000) notSeen.push(item);
    if (item.inspectionRequired || Number(item.washCount) >= 60) inspection.push(item);
  }
  return { stages, safetyMargin, cleanLow: stages.clean < safetyMargin, notSeen, inspection };
}

function cookieValue(request, name) {
  const match = String(request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function identityForCredentials(username, password, admin, store) {
  let identity;
  if (username === "admin" && admin?.identities) identity = admin.identities[password];
  else if (username === "admin" && admin?.token === password) {
    identity = {
      actorId: "local-admin",
      role: admin.role ?? "hotel_admin",
      tenantIds: [admin.tenantId]
    };
  }
  if (identity) return { ...identity, managed: false, userId: null };

  const user = await store.adminUserByUsername?.(username);
  if (!user?.active || !await verifyPassword(password, user.passwordHash)) return null;
  return {
    actorId: user.username,
    displayName: user.displayName,
    role: user.role,
    tenantIds: user.tenantIds,
    defaultTenantId: user.defaultTenantId,
    managed: true,
    userId: user.userId
  };
}

async function authenticateAdmin(request, admin, store, sessionSecret) {
  const session = verifySessionToken(
    cookieValue(request, "rfid_session"),
    sessionSecret
  );
  let identity = session;
  if (session?.managed) {
    const user = await store.adminUserById?.(session.userId);
    if (!user?.active) return { error: "admin_auth_required" };
    identity = {
      actorId: user.username,
      displayName: user.displayName,
      role: user.role,
      tenantIds: user.tenantIds,
      defaultTenantId: user.defaultTenantId,
      managed: true,
      userId: user.userId
    };
  }

  const authorization = request.headers.authorization;
  if (!identity && authorization?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      identity = await identityForCredentials(
        decoded.slice(0, separator),
        decoded.slice(separator + 1),
        admin,
        store
      );
    } catch {
      return { error: "admin_auth_required" };
    }
  }
  if (!identity) return { error: "admin_auth_required" };

  let tenantIds = [...(identity.tenantIds ?? [])];
  if (identity.role === "chain_admin") {
    const hotels = await managedHotels(store, tenantIds);
    tenantIds = [...new Set([...tenantIds, ...hotels.map((hotel) => hotel.tenantId)])];
  }
  const tenantId = request.headers["x-tenant-id"] ?? (identity.role === "chain_admin" ? tenantIds[0] : identity.defaultTenantId ?? tenantIds[0]);
  if (!tenantId || !tenantIds.includes(tenantId)) return { error: "tenant_access_denied" };
  if (!ADMIN_ROLES.has(identity.role)) return { error: "admin_role_invalid" };
  return {
    actorId: identity.actorId,
    displayName: identity.displayName ?? identity.actorId,
    role: identity.role,
    tenantIds,
    tenantId,
    managed: Boolean(identity.managed),
    userId: identity.userId ?? null
  };
}

function requireAdmin(response, error = "admin_auth_required") {
  const status = error === "admin_auth_required" ? 401 : 403;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error }));
}

function canMutate(principal, pathname) {
  if (principal.role === "hotel_admin" || principal.role === "chain_admin") return true;
  if (principal.role === "viewer") return false;
  return pathname === "/v1/admin/sessions" ||
    pathname === "/v1/admin/stock/requests" ||
    /^\/v1\/admin\/workflow\/(scan|receive)$/.test(pathname) ||
    /^\/v1\/admin\/stock\/requests\/[^/]+$/.test(pathname) ||
    pathname === "/v1/admin/hardware/rru9809/scan" ||
    pathname === "/v1/admin/hardware/rru9809/detect" ||
    /^\/v1\/admin\/sessions\/[^/]+\/complete$/.test(pathname) ||
    /^\/v1\/admin\/shipments\/[^/]+\/accept$/.test(pathname) ||
    /^\/v1\/admin\/receiving-batches(?:\/[^/]+\/(?:scan|approve|tags\/[^/]+))?$/.test(pathname) ||
    /^\/v1\/admin\/assets\/[^/]+\/status$/.test(pathname) ||
    /^\/v1\/admin\/alerts\/[^/]+\/acknowledge$/.test(pathname) ||
    /^\/v1\/admin\/exceptions\/[^/]+\/resolve$/.test(pathname) ||
    /^\/v1\/admin\/pending-movements\/[^/]+\/resolve$/.test(pathname);
}

function managedUserScope(principal, value, existing = null) {
  if (!["hotel_admin", "chain_admin"].includes(principal.role)) {
    throw new Error("User management requires administrator access");
  }
  const role = value.role ?? existing?.role;
  if (!ADMIN_ROLES.has(role)) throw new Error("Unsupported user role");
  const tenantIds = value.tenantIds ?? existing?.tenantIds;
  if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
    throw new Error("At least one hotel assignment is required");
  }
  const uniqueTenantIds = [...new Set(tenantIds.map(String))];
  if (principal.role === "chain_admin" && role === "chain_admin" &&
      (uniqueTenantIds.length !== 1 || uniqueTenantIds[0] !== principal.tenantIds[0])) {
    throw new Error("Company administrator accounts must belong only to Globaltex head office.");
  }
  if (principal.role === "chain_admin" && role !== "chain_admin" && uniqueTenantIds.includes(principal.tenantIds[0]) &&
      (!existing || value.tenantIds || value.role)) {
    throw new Error("Hotel accounts cannot be assigned to Globaltex head office. Create a hotel first.");
  }
  if (uniqueTenantIds.some((tenantId) => !principal.tenantIds.includes(tenantId))) {
    throw new Error("User assignment exceeds your hotel scope");
  }
  if (principal.role === "hotel_admin") {
    if (role === "chain_admin") throw new Error("Hotel admin cannot create chain admin");
    if (uniqueTenantIds.length !== 1 || uniqueTenantIds[0] !== principal.tenantId) {
      throw new Error("Hotel admin can assign only the selected hotel");
    }
  }
  const defaultTenantId = value.defaultTenantId ?? existing?.defaultTenantId ?? uniqueTenantIds[0];
  if (!uniqueTenantIds.includes(defaultTenantId)) {
    throw new Error("Default hotel must be included in assignments");
  }
  return { role, tenantIds: uniqueTenantIds, defaultTenantId };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateBatch(value) {
  if (!value || typeof value !== "object") return "Body must be an object";
  if (typeof value.facilityId !== "string" || !value.facilityId) return "facilityId is required";
  if (typeof value.zoneId !== "string" || !value.zoneId) return "zoneId is required";
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 5000) {
    return "events must contain 1..5000 reads";
  }

  for (const event of value.events) {
    if (typeof event.eventId !== "string" || !event.eventId) return "eventId is required";
    if (typeof event.epc !== "string" || !EPC_PATTERN.test(event.epc)) return "epc must be uppercase hexadecimal";
    if (!Number.isFinite(Date.parse(event.observedAt))) return "observedAt must be ISO-8601";
  }
  return null;
}

function validateHeartbeat(value) {
  if (!value || typeof value !== "object") return "Body must be an object";
  if (typeof value.adapter !== "string" || !value.adapter) return "adapter is required";
  if (typeof value.gatewayVersion !== "string" || !value.gatewayVersion) {
    return "gatewayVersion is required";
  }
  if (typeof value.readerConnected !== "boolean") return "readerConnected must be boolean";
  if (!Number.isInteger(value.queueDepth) || value.queueDepth < 0) {
    return "queueDepth must be a non-negative integer";
  }
  if (!Number.isFinite(Date.parse(value.heartbeatAt))) return "heartbeatAt must be ISO-8601";
  if (value.lastReadAt != null && !Number.isFinite(Date.parse(value.lastReadAt))) {
    return "lastReadAt must be ISO-8601";
  }
  return null;
}

function retentionOptions(value, { dryRun } = {}) {
  if (!value || typeof value !== "object") throw new Error("Body must be an object");
  if (!Number.isFinite(Date.parse(value.before))) throw new Error("before must be ISO-8601");
  const limit = value.limit == null ? 10_000 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error("limit must be an integer between 1 and 50000");
  }
  const resolvedDryRun = dryRun ?? value.dryRun ?? true;
  if (typeof resolvedDryRun !== "boolean") throw new Error("dryRun must be boolean");
  return { before: value.before, limit, dryRun: resolvedDryRun };
}

function chainSummary(tenantSummaries) {
  const lines = new Map();
  for (const tenant of tenantSummaries) {
    for (const line of tenant.summary.lines) {
      const current = lines.get(line.sku) ?? {
        sku: line.sku,
        name: line.name,
        category: line.category,
        size: line.size,
        color: line.color,
        units: 0,
        tenantIds: new Set(),
        packagingProfiles: new Map()
      };
      current.units += line.units;
      current.tenantIds.add(tenant.tenantId);
      const profileKey = `${line.unitsPerBox}:${line.boxesPerPallet}`;
      if (!current.packagingProfiles.has(profileKey)) {
        current.packagingProfiles.set(profileKey, {
          unitsPerBox: line.unitsPerBox,
          boxesPerPallet: line.boxesPerPallet
        });
      }
      lines.set(line.sku, current);
    }
  }

  return {
    tenantCount: tenantSummaries.length,
    totals: tenantSummaries.reduce((totals, tenant) => {
      totals.uniqueUnits += tenant.summary.uniqueUnits;
      totals.registeredUnits += tenant.summary.registeredUnits;
      totals.unknownUnits += tenant.summary.unknownUnits;
      totals.availableUnits += tenant.summary.availableUnits;
      for (const [status, count] of Object.entries(tenant.summary.statusCounts)) {
        totals.statusCounts[status] = (totals.statusCounts[status] ?? 0) + count;
      }
      return totals;
    }, {
      uniqueUnits: 0,
      registeredUnits: 0,
      unknownUnits: 0,
      availableUnits: 0,
      statusCounts: {}
    }),
    lines: [...lines.values()].map((line) => {
      const profiles = [...line.packagingProfiles.values()];
      const result = {
        sku: line.sku,
        name: line.name,
        category: line.category,
        size: line.size,
        color: line.color,
        units: line.units,
        tenantCount: line.tenantIds.size,
        packagingMixed: profiles.length !== 1
      };
      if (profiles.length === 1) {
        Object.assign(result, calculatePackaging(
          line.units,
          profiles[0].unitsPerBox,
          profiles[0].boxesPerPallet
        ));
      } else {
        result.packagingProfiles = profiles;
      }
      return result;
    }).sort((a, b) => a.sku.localeCompare(b.sku)),
    tenants: tenantSummaries.map(({ tenantId, summary }) => ({
      tenantId,
      uniqueUnits: summary.uniqueUnits,
      registeredUnits: summary.registeredUnits,
      unknownUnits: summary.unknownUnits,
      availableUnits: summary.availableUnits,
      statusCounts: summary.statusCounts,
      lines: summary.lines
    }))
  };
}

export function createApp({
  credentials,
  admin,
  customerApiCredentials = {},
  store: primaryStore = new InventoryStore(),
  enableHotelPreview = false,
  now,
  requireProvisionedReaders = false,
  rfidWriter = writeRru9809Epc,
  rfidReader = scanRru9809,
  sessionSecret = admin?.sessionSecret ?? admin?.token ?? "local-session-secret",
  secureCookies = false
} = {}) {
  const store = primaryStore;
  const previewEnabled = enableHotelPreview === true && process.env.NODE_ENV !== "production";
  let previewStorePromise;
  if (!credentials || Object.keys(credentials).length === 0) {
    throw new Error("At least one device credential is required");
  }
  const customerCredentialIndex = new Map(Object.entries(customerApiCredentials).map(
    ([token, credential]) => [tokenHash(token), credential]
  ));

  let monitoring = false;
  const stockMonitor = setInterval(async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      for (const tenantId of await store.operationsTenantIds()) await evaluateStock(store, tenantId);
    } catch (error) { console.error("Stock monitor failed:", error.message); }
    finally { monitoring = false; }
  }, 30_000);
  stockMonitor.unref();

  const server = createServer(async (request, response) => {
    let store = primaryStore;
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { status: "ok" });
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        try {
          return json(response, 200, await store.readinessCheck());
        } catch {
          return json(response, 503, { status: "not_ready" });
        }
      }

      if (request.method === "GET" && url.pathname === "/assets/workflow.js") return binary(response, 200, WORKFLOW_JS, "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/portal-reports.js") return binary(response, 200, PORTAL_REPORTS_JS, "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/portal-design.js") return binary(response, 200, PORTAL_DESIGN_JS, "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/portal-design.css") return binary(response, 200, PORTAL_DESIGN_CSS, "text/css; charset=utf-8");
      if (request.method === "GET" && /^\/assets\/fonts\/(Inter|Manrope)-Variable\.woff2$/.test(url.pathname)) return binary(response,200,PORTAL_FONTS[url.pathname.match(/\/(Inter|Manrope)-Variable/)[1]],'font/woff2');
      if (request.method === "GET" && url.pathname === "/assets/portal-roles.js") return binary(response, 200, PORTAL_ROLES_JS, "text/javascript; charset=utf-8");

      if (request.method === "GET" && url.pathname === "/login") {
        return html(response, 200, LOGIN);
      }

      if (request.method === "GET" && url.pathname === "/assets/patak-logo.png") {
        return binary(response, 200, PATAK_LOGO, "image/png");
      }

      if (request.method === "GET" && url.pathname === "/assets/globaltex-logo.png") {
        return binary(response, 200, GLOBALTEX_LOGO, "image/png");
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        try {
          const value = JSON.parse(await readBody(request));
          const identity = await identityForCredentials(
            value.username,
            value.password,
            admin,
            store
          );
          if (!identity) return json(response, 401, { error: "invalid_credentials" });
          const expiresAt = (now?.() ?? Date.now()) + 8 * 60 * 60_000;
          const token = createSessionToken({
            ...identity,
            exp: expiresAt
          }, sessionSecret);
          const cookie = [
            `rfid_session=${encodeURIComponent(token)}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Strict",
            "Max-Age=28800",
            secureCookies ? "Secure" : ""
          ].filter(Boolean).join("; ");
          return json(response, 200, {
            actorId: identity.actorId,
            displayName: identity.displayName ?? identity.actorId,
            role: identity.role,
            tenantIds: identity.tenantIds,
            defaultTenantId: identity.defaultTenantId ?? identity.tenantIds[0]
          }, { "set-cookie": cookie });
        } catch (error) {
          return json(response, 422, { error: "invalid_login", message: error.message });
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        return json(response, 200, { loggedOut: true }, {
          "set-cookie": "rfid_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        });
      }

      if (url.pathname === "/") {
        response.writeHead(302, { location: "/dashboard" });
        return response.end();
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/"))
      ) {
        const principal = await authenticateAdmin(request, admin, store, sessionSecret);
        if (principal.error) {
          response.writeHead(302, { location: "/login" });
          return response.end();
        }
        return html(response, 200, principal.role === "chain_admin" && url.pathname.startsWith("/dashboard/technical") ? DASHBOARD : PORTAL);
      }

      if (url.pathname.startsWith("/v1/customer/")) {
        const principal = customerPrincipal(request, customerCredentialIndex);
        if (principal.error) return json(response, 401, { error: principal.error });

        const minute = Math.floor((now?.() ?? Date.now()) / 60_000);
        const rate = await store.consumeCustomerApiRateLimit(principal.clientId, minute, 120);
        if (!rate.allowed) {
          return json(response, 429, { error: "customer_api_rate_limit" }, { "retry-after": "60" });
        }

        const requireScope = (scope) => {
          if (principal.scopes.has(scope)) return true;
          json(response, 403, { error: "customer_api_scope_required", scope });
          return false;
        };
        const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
        if (mutation && (!idempotencyKey || idempotencyKey.length > 200)) {
          return json(response, 400, { error: "idempotency_key_required" });
        }
        const idempotency = mutation ? {
          tenantId: principal.tenantId,
          clientId: principal.clientId,
          method: request.method,
          path: url.pathname,
          idempotencyKey
        } : null;
        const replay = idempotency
          ? await store.customerApiIdempotencyGet(idempotency)
          : null;
        if (replay !== null) {
          return json(response, 200, replay, { "idempotency-replayed": "true" });
        }

        let result;
        if (request.method === "GET" && url.pathname === "/v1/customer/catalog") {
          if (!requireScope("catalog:read")) return;
          result = { products: await store.productsFor(principal.tenantId) };
        } else if (request.method === "POST" && url.pathname === "/v1/customer/catalog") {
          if (!requireScope("catalog:write")) return;
          const body = await readBody(request);
          const products = request.headers["content-type"]?.includes("text/csv")
            ? parseProductCsv(body)
            : JSON.parse(body).products;
          result = await store.upsertProducts(principal.tenantId, products);
        } else if (request.method === "POST" && url.pathname === "/v1/customer/assets") {
          if (!requireScope("assets:write")) return;
          const body = await readBody(request);
          const assets = request.headers["content-type"]?.includes("text/csv")
            ? parseAssetCsv(body)
            : JSON.parse(body).assets;
          result = await store.registerAssets(principal.tenantId, assets);
        } else if (request.method === "GET" && url.pathname === "/v1/customer/inventory") {
          if (!requireScope("inventory:read")) return;
          result = await store.summaryFor(principal.tenantId);
        } else if (request.method === "GET" && url.pathname === "/v1/customer/encoding/batches") {
          if (!requireScope("encoding:read")) return;
          result = { batches: await store.encodingBatchesFor(principal.tenantId) };
        } else if (request.method === "POST" && url.pathname === "/v1/customer/encoding/jobs/claim") {
          if (!requireScope("encoding:work")) return;
          result = { job: await store.claimEncodingJob(
            principal.tenantId,
            JSON.parse(await readBody(request) || "{}")
          ) };
        } else if (request.method === "POST" && url.pathname === "/v1/customer/encoding/jobs/finish") {
          if (!requireScope("encoding:work")) return;
          result = await store.finishEncodingJob(
            principal.tenantId,
            JSON.parse(await readBody(request) || "{}")
          );
        } else {
          return json(response, 404, { error: "customer_api_route_not_found" });
        }

        if (mutation) {
          result = await store.customerApiIdempotencyPut({ ...idempotency, response: result });
          await store.recordAudit({
            tenantId: principal.tenantId,
            actorId: principal.clientId,
            actorRole: "customer_api",
            action: `${request.method} ${url.pathname}`,
            entityType: "api_route",
            entityId: null,
            details: { path: url.pathname, idempotencyKey }
          });
        }
        return json(response, 200, result);
      }

      if (url.pathname.startsWith("/v1/admin/")) {
        const authenticationRequest = request.headers["x-preview-mode"] === "hotel"
          ? { headers: { ...request.headers, "x-tenant-id": undefined } } : request;
        let principal = await authenticateAdmin(authenticationRequest, admin, store, sessionSecret);
        if (principal.error) return requireAdmin(response, principal.error);
        if (url.pathname === "/v1/admin/preview" && request.method === "GET") return json(response,200,{enabled:previewEnabled&&principal.role==="chain_admin",readOnly:true,tenantId:HOTEL_PREVIEW_TENANT});
        if (request.headers["x-preview-mode"] === "hotel") {
          // Authenticate against the real store, then route reads to disposable sample data.
          if (!previewEnabled || principal.role !== "chain_admin") return json(response,403,{error:"preview_unavailable"});
          if (request.method !== "GET") return json(response,403,{error:"preview_read_only",message:"This is a read-only hotel preview with sample data. Return to the company workspace to make changes."});
          previewStorePromise ??= createHotelPreviewStore();
          store = await previewStorePromise;
          principal = {...principal, role:"hotel_admin",tenantId:HOTEL_PREVIEW_TENANT,tenantIds:[HOTEL_PREVIEW_TENANT],displayName:"Demo Hotel Manager",managed:false,userId:null};
        }
        if (!companyPortalAccess(principal, request.method, url.pathname)) return json(response, 403, { error: "hotel_operations_private", message: "Hotel inventory, rooms, laundry and stock rules are private to the hotel. Globaltex can manage accounts, orders and its own shipments." });
        const manufacturingOnly = /^\/v1\/admin\/(encoding|receiving-batches|zoho|retention|hardware)(\/|$)/.test(url.pathname);
        if (principal.role !== "chain_admin" && manufacturingOnly) return json(response, 403, { error: "globaltex_admin_required" });
        const tenantId = principal.tenantId;
        const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        const globaltexOnly = /^\/v1\/admin\/(?:users|hotels|encoding|receiving-batches|hardware|zoho|retention|readers|facilities|zones|catalog\/import|assets\/register)(?:\/|$)/.test(url.pathname) ||
          (request.method !== "GET" && url.pathname === "/v1/admin/shipments");
        if (principal.role !== "chain_admin" && globaltexOnly && mutation) {
          return json(response, 403, { error: "globaltex_admin_required" });
        }
        if (mutation && !canMutate(principal, url.pathname)) {
          return json(response, 403, { error: "admin_role_forbidden" });
        }
        if (mutation) {
          response.once("finish", () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              Promise.resolve(store.recordAudit({
                tenantId,
                actorId: principal.actorId,
                actorRole: principal.role,
                action: `${request.method} ${url.pathname}`,
                entityType: "api_route",
                entityId: null,
                details: { path: url.pathname }
              })).catch(() => {});
            }
          });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/me") {
          return json(response, 200, {
            actorId: principal.actorId,
            displayName: principal.displayName,
            role: principal.role,
            tenantId: principal.tenantId,
            tenantIds: principal.tenantIds,
            managed: principal.managed,
            userId: principal.userId
          });
        }

        if (url.pathname === "/v1/admin/hotels" && request.method === "GET") {
          const hotels = await managedHotels(store, principal.tenantIds);
          const names = new Map(hotels.map((h) => [h.tenantId, h]));
          const visible = [];
          for (const id of principal.tenantIds) visible.push(names.get(id) ?? {
            tenantId: id, name: id === "globaltex-local" ? "Globaltex Head Office" :
              (await store.facilitiesFor(id)).find((facility) => facility.facilityType === "hotel")?.name ?? id
          });
          return json(response, 200, { hotels: visible });
        }
        if (url.pathname === "/v1/admin/hotels" && request.method === "POST") {
          try {
            const value = JSON.parse(await readBody(request));
            const name = String(value.name ?? "").trim();
            if (name.length < 2 || name.length > 120) throw new Error("Hotel name must be 2–120 characters long.");
            const hotel = { ...hotelDetails(value), tenantId: `hotel-${randomUUID()}`, createdAt: new Date().toISOString() };
            // Establish the facility before exposing the hotel in the directory.
            await provisionWorkflowLocation(store, hotel.tenantId, { facilityId: "main", name, facilityType: "hotel", timezone: hotel.timezone }, [["storage","Storage","storage"],["washing","Washing","in_wash"],["drying","Drying","drying"],["distribution","Distribution","distribution"],["in-use","In Use","in_use"]]);
            await store.updateOperations(principal.tenantIds[0], (state) => { state.hotels.push(hotel); });
            return json(response, 201, hotel);
          } catch (error) { return json(response, 422, { error: "invalid_hotel", message: error.message }); }
        }
        const contactRoute=url.pathname.match(/^\/v1\/admin\/hotels\/([^/]+)\/contacts(?:\/([^/]+))?$/);
        if(contactRoute&&['POST','PUT'].includes(request.method)){
          if(principal.role!=='chain_admin')return json(response,403,{error:'globaltex_admin_required'});
          const hotelId=decodeURIComponent(contactRoute[1]),root=principal.tenantIds[0];
          if(!principal.tenantIds.includes(hotelId)||(request.method==='PUT'&&!contactRoute[2])||(request.method==='POST'&&contactRoute[2]))return json(response,404,{error:'hotel_or_contact_not_found'});
          try{const value=JSON.parse(await readBody(request));let saved;
            await store.updateOperations(root,state=>{const hotel=state.hotels.find(h=>h.tenantId===hotelId);if(!hotel)throw new Error('Hotel not found.');saved=changeHotelContact(hotel,value,principal.actorId,contactRoute[2]?decodeURIComponent(contactRoute[2]):null);});
            await store.recordAudit({tenantId:root,actorId:principal.actorId,actorRole:principal.role,action:'hotel.contact.update',entityType:'hotel',entityId:hotelId,details:{contactId:saved.contactId,active:saved.active}});
            return json(response,200,saved);
          }catch(error){return json(response,422,{error:'invalid_hotel_contact',message:error.message});}
        }
        const hotelUpdate = url.pathname.match(/^\/v1\/admin\/hotels\/([^/]+)$/);
        if (hotelUpdate && request.method === "PUT") {
          try {
            const id = decodeURIComponent(hotelUpdate[1]);
            const root = principal.tenantIds[0];
            const existing = (await managedHotels(store, [root])).find(h => h.tenantId === id);
            if (!existing || !principal.tenantIds.includes(id)) return json(response, 404, { error: "hotel_not_found" });
            const changes = hotelDetails(JSON.parse(await readBody(request)), existing);
            const updated = { ...changes, updatedBy: principal.actorId, updatedAt: new Date().toISOString() };
            await store.upsertFacility(id, { facilityId: "main", name: updated.name, facilityType: "hotel", timezone: updated.timezone });
            await store.updateOperations(root, state => { Object.assign(state.hotels.find(h => h.tenantId === id), updated); });
            return json(response, 200, updated);
          } catch (error) { return json(response, 422, { error: "invalid_hotel", message: error.message }); }
        }
        if (["/v1/admin/reports","/v1/admin/reports/export"].includes(url.pathname) && request.method === "GET") {
          try {
            const report=await buildReports(store,principal,Object.fromEntries(url.searchParams),now?.()??Date.now());
            if (url.pathname.endsWith("/export")) {
              const key=url.searchParams.get("dataset")??"inventory",data=report.datasets[key];
              const csv=reportCsv(report,key,{search:url.searchParams.get("search")??""});
              const stamp=data.scope==="snapshot"?report.generatedAt.slice(0,10):report.filters.from+"_"+report.filters.to;
              response.writeHead(200,{"content-type":"text/csv; charset=utf-8","cache-control":"private, no-store","content-disposition":'attachment; filename="globaltex-'+(request.headers["x-preview-mode"]==="hotel"?"demo-":"")+report.mode+'-'+key+'-'+stamp+'.csv"'});
              return response.end(csv);
            }
            response.setHeader("cache-control","private, no-store");
            return json(response,200,report);
          } catch(error) { return json(response,422,{error:"invalid_report",message:error.message}); }
        }
        if (url.pathname === "/v1/admin/workflow" && request.method === "GET") {
          const snapshot = await workflowSnapshot(store, tenantId);
          if (principal.role !== "chain_admin") delete snapshot.encodingBatches;
          return json(response, 200, snapshot);
        }
        if (url.pathname.startsWith("/v1/admin/workflow/") && request.method === "POST") {
          try {
            const action = url.pathname.split("/").at(-1);
            const value = JSON.parse(await readBody(request) || "{}");
            const adminOnly = ["setup", "dispatch", "tag", "register", "product"];
            if (adminOnly.includes(action) && principal.role !== "chain_admin") return json(response, 403, { error: "globaltex_admin_required" });
            if (action === "resource-state") {
              if (!["chain_admin","hotel_admin"].includes(principal.role)) return json(response,403,{error:"admin_role_forbidden"});
              if (value.kind !== "location" && principal.role !== "chain_admin") return json(response,403,{error:"globaltex_admin_required"});
              return json(response,200,await setResourceActive(store,principal,value));
            }
            if (action === "setup") {
              if (tenantId !== principal.tenantIds[0]) throw new Error("Switch to the Globaltex head office workspace to set up company warehouses.");
              return json(response, 200, { facilities: await setupWarehouses(store, tenantId) });
            }
            if (action === "lifespan") {
              if (!["chain_admin", "hotel_admin"].includes(principal.role)) return json(response, 403, { error: "admin_role_forbidden" });
              const rule = await saveLifespan(store, tenantId, value, principal.actorId);
              await evaluateStock(store, tenantId);
              return json(response, 200, rule);
            }
            if (action === "location") {
              if (!["chain_admin", "hotel_admin"].includes(principal.role)) return json(response, 403, { error: "admin_role_forbidden" });
              const facility = (await store.facilitiesFor(tenantId)).find(f => f.facilityId === value.facilityId && f.active !== false);
              const locationName = String(value.name ?? "").trim();
              if (!facility || !locationName || locationName.length > 120 || !["warehouse","receiving","in_room","soiled","in_wash","clean_return","waiting","storage","drying","distribution","in_use"].includes(value.zoneType)) throw new Error("Select a facility and location type, and enter a name of up to 120 characters.");
              if ((await store.zonesFor(tenantId)).some(z => z.facilityId === facility.facilityId && z.name.toLocaleLowerCase("en-US") === locationName.toLocaleLowerCase("en-US"))) throw new Error("A location with this name already exists at this facility.");
              const zoneId = "location-" + randomUUID();
              await provisionWorkflowLocation(store, tenantId, facility, [[zoneId, locationName, value.zoneType]]);
              return json(response, 201, { zoneId, name: locationName, facilityId: facility.facilityId, zoneType: value.zoneType });
            }
            if (action === "product") {
              if ((await store.productsFor(tenantId)).some(p=>p.sku===value.sku&&p.active===false)) throw new Error("This SKU is archived. Restore it from Product catalog before editing.");
              return json(response, 201, await store.upsertProducts(tenantId, [{ sku: value.sku, name: value.name, category: "Hotel linen", unitsPerBox: Number(value.unitsPerBox || 1), boxesPerPallet: Number(value.boxesPerPallet || 1) }]));
            }
            if (action === "dispatch") {
              if (!principal.tenantIds.includes(value.customerTenantId)) return json(response, 403, { error: "tenant_access_denied" });
              return json(response, 201, await dispatchTransfer(store, tenantId, value, principal.actorId));
            }
            if (action === "read") {
              if (principal.role !== "chain_admin") return json(response,403,{error:"hotel_gateway_required",message:"Hotel scans must come from the hotel's assigned gateway, not the Globaltex server reader."});
              const reads = await rfidReader({ port: process.env.RRU9809_PORT ?? "COM4", baudRate: Number(process.env.RRU9809_BAUD_RATE ?? 57600), scanCount: 5 });
              return json(response, 200, { epcs: [...new Set(reads.map(r => r.epc))] });
            }
            if (["scan", "receive"].includes(action)) {
              if (value.readMode === "device" && principal.role !== "chain_admin") return json(response,403,{error:"hotel_gateway_required",message:"Use your hotel's assigned reader gateway or a confirmed physical count."});
              if (value.readMode === "gateway") {
                const cutoff=Date.now()-60000;
                value.epcs=(await store.inventoryFor(tenantId)).filter(a=>a.zoneId===value.zoneId&&Date.parse(a.lastSeenAt)>=cutoff&&Date.parse(a.lastSeenAt)<=Date.now()+5000).map(a=>a.epc);
                if (!value.epcs.length) throw new Error("No recent gateway reads at this location. Scan items with your hotel's assigned reader, then try again within 60 seconds.");
              }
              else if (value.readMode === "device") value.epcs = [...new Set((await rfidReader({ port: process.env.RRU9809_PORT ?? "COM4", baudRate: Number(process.env.RRU9809_BAUD_RATE ?? 57600), scanCount: 5 })).map(r => r.epc))];
              else if (value.confirmed !== true || !String(value.reason ?? "").trim()) throw new Error("Confirm the physical count and enter a reason for manual EPC entry.");
              value.epcs = normalizeEpcs(value.epcs);
              const result = action === "scan" ? await workflowScan(store, tenantId, value, principal.actorId) : await receiveTransfer(store, tenantId, value.shipmentId, value, principal.actorId);
              await store.recordAudit({ tenantId, actorId: principal.actorId, actorRole: principal.role, action: "workflow." + action, entityType: "scan", entityId: value.shipmentId ?? null, details: { readMode: value.readMode, reason: value.reason, epcs: value.epcs, zoneId: value.zoneId } });
              await evaluateStock(store, tenantId);
              return json(response, 200, result);
            }
            if (action === "register") {
              const product = (await store.productsFor(tenantId)).find(p => p.sku === value.sku && p.active !== false);
              const zone = (await store.zonesFor(tenantId)).find(z => z.zoneId === value.zoneId && z.facilityId === value.facilityId && z.active !== false);
              if (!product || !zone || !(await store.facilitiesFor(tenantId)).some(f=>f.facilityId===zone.facilityId&&f.active!==false)) throw new Error("Select an active product and initial location.");
              if (value.readMode === "device") value.epcs = [...new Set((await rfidReader({port: process.env.RRU9809_PORT ?? "COM4", baudRate: Number(process.env.RRU9809_BAUD_RATE ?? 57600), scanCount: 5})).map(r => r.epc))];
              else if (value.confirmed !== true || !String(value.reason ?? "").trim()) throw new Error("Confirm the physical count and enter a count reference.");
              const epcs = normalizeEpcs(value.epcs);
              const current = new Map((await store.inventoryFor(tenantId)).map(a => [a.epc, a]));
              if (epcs.some(epc => current.get(epc)?.sku)) throw new Error("Some tags are already registered. Use location scans for existing inventory.");
              await ensureOperatorStation(store, tenantId, zone);
              await store.registerAssets(tenantId, epcs.map(epc => ({epc, sku: product.sku})));
              const session = await store.startSession({tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, type: "receiving", reference: "Confirmed initial stock"});
              await store.ingest({tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, readerId: "workflow-"+zone.zoneId, sessionId: session.sessionId, events: epcs.map(epc=>({epc,eventId:randomUUID(),observedAt:new Date().toISOString()}))});
              await store.completeSession(tenantId, session.sessionId);
              await store.recordAudit({tenantId,actorId:principal.actorId,actorRole:principal.role,action:"workflow.initial_stock",entityType:"session",entityId:session.sessionId,details:{readMode:value.readMode,reason:value.reason,epcs,sku:product.sku}});
              return json(response,201,{registered:epcs.length});
            }
            if (action === "tag") {
              const product = (await store.productsFor(tenantId)).find(p => p.sku === value.sku && p.active !== false);
              const zone = (await store.zonesFor(tenantId)).find(z => z.zoneId === value.zoneId && z.facilityId === value.facilityId && z.active !== false);
              if (!product || !zone || !(await store.facilitiesFor(tenantId)).some(f=>f.facilityId===zone.facilityId&&f.active!==false) || value.confirmed !== true) throw new Error("Select a product and initial location; confirm exactly one blank tag is on the writer.");
              await ensureOperatorStation(store, tenantId, zone);
              const batch = value.batchId ? await store.encodingBatchFor(tenantId,String(value.batchId)) : await store.createEncodingBatch(tenantId, { sku: value.sku, requestedQuantity: 1 });
              if(!batch || batch.sku!==value.sku)throw new Error("Encoding batch does not match the selected product.");
              if(value.batchId && !batch.queued)throw new Error("No queued tags remain in this batch. Review failed or in-progress jobs before creating a replacement batch.");
              const job = await store.claimEncodingJob(tenantId, { stationId: "workflow-writer", batchId: batch.batchId });
              if (!job || job.batchId !== batch.batchId) throw new Error("Another encoding job is queued. Complete it at the encoding station first.");
              let written;
              try {
                written = await rfidWriter({ port: process.env.RRU9809_PORT ?? "COM4", baudRate: Number(process.env.RRU9809_BAUD_RATE ?? 57600), epc: job.epc });
                if (!written.verified) throw new Error("Tag read-back verification failed.");
              } catch(error) {
                await store.finishEncodingJob(tenantId, { jobId: job.jobId, stationId: "workflow-writer", leaseToken: job.leaseToken, errorCode: "writer_error", errorMessage: error.message });
                throw error;
              }
              const finished = await store.finishEncodingJob(tenantId, { jobId: job.jobId, stationId: "workflow-writer", leaseToken: job.leaseToken, observedEpc: written.epc, previousEpc: written.previousEpc });
              if (!finished.verified) throw new Error("Read-back did not match the allocated EPC. No stock was added.");
              const session = await store.startSession({ tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, type: "receiving", reference: "Verified RFID encoding" });
              await store.ingest({ tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, readerId: "workflow-" + zone.zoneId, sessionId: session.sessionId, events: [{ epc: written.epc, eventId: randomUUID(), observedAt: new Date().toISOString() }] });
              await store.completeSession(tenantId, session.sessionId);
              return json(response, 201, { epc: written.epc, verified: true, batchId: batch.batchId });
            }
            return json(response, 404, { error: "unknown_workflow_action" });
          } catch(error) { return json(response, 422, { error: "workflow_failed", message: error.message }); }
        }
        if (url.pathname === "/v1/admin/stock" && request.method === "GET") {
          const state = await evaluateStock(store, tenantId);
          return json(response, 200, { policies: state.policies, requests: state.requests.map(r=>({...r,...requestCancellation(r,principal.role,now?.()??Date.now())})), cancellationWindowMinutes:30 });
        }
        if (url.pathname === "/v1/admin/stock/policies" && request.method === "PUT") {
          if (!["chain_admin", "hotel_admin"].includes(principal.role)) return json(response, 403, { error: "stock_settings_forbidden" });
          try {
            const value = JSON.parse(await readBody(request));
            const product = (await store.productsFor(tenantId)).find((p) => p.sku === value.sku && p.active !== false);
            if (!product) throw new Error("Select an active product belonging to this hotel.");
            await store.updateOperations(tenantId, (state) => saveStockPolicy(state, value, principal.actorId));
            const state = await evaluateStock(store, tenantId);
            return json(response, 200, { policies: state.policies, requests: state.requests });
          } catch (error) { return json(response, 422, { error: "invalid_stock_policy", message: error.message }); }
        }
        if (url.pathname === "/v1/admin/stock/requests" && request.method === "POST") {
          if (principal.role === "chain_admin") return json(response, 403, { error: "hotel_order_required" });
          try {
            const value = JSON.parse(await readBody(request));
            const quantity = Number(value.quantity);
            if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw new Error("Enter a quantity between 1 and 1,000,000.");
            if (!(await store.productsFor(tenantId)).some(p=>p.sku===value.sku && p.active !== false)) throw new Error("Select a product from your hotel inventory.");
            const created = await store.updateOperations(tenantId, state => {
              if (state.requests.some(r=>r.sku===value.sku && ["submitted","approved","shipped"].includes(r.status))) throw new Error("An open request already exists for this product. Track it before requesting more.");
              const at = new Date().toISOString();
              const order = {requestId:randomUUID(),tenantId,sku:value.sku,quantity,source:"manual",status:"submitted",createdAt:at,createdBy:principal.actorId,history:[{status:"submitted",actorId:principal.actorId,at}]};
              state.requests.unshift(order); return order;
            });
            return json(response,201,created);
          } catch(error) { return json(response,422,{error:"invalid_stock_request",message:error.message}); }
        }
        const stockRequest = url.pathname.match(/^\/v1\/admin\/stock\/requests\/([^/]+)$/);
        if (stockRequest && request.method === "PUT") {
          try {
            const { status } = JSON.parse(await readBody(request));
            const result = await store.updateOperations(tenantId, (state) => transitionRequest(state, decodeURIComponent(stockRequest[1]), status, principal, {now:now?.()??Date.now()}));
            return json(response, 200, result);
          } catch (error) { return json(response, 422, { error: "invalid_request_transition", message: error.message }); }
        }
        const stockDispatch = url.pathname.match(/^\/v1\/admin\/stock\/requests\/([^/]+)\/dispatch$/);
        if (stockDispatch && request.method === "POST") {
          if (principal.role !== "chain_admin") return json(response, 403, { error: "globaltex_admin_required" });
          try {
            const value = JSON.parse(await readBody(request));
            if (value.supplierTenantId !== principal.tenantIds[0]) return json(response, 403, { error: "tenant_access_denied" });
            return json(response, 200, await dispatchStockRequest(store, {
              tenantId, requestId: decodeURIComponent(stockDispatch[1]), supplierTenantId: value.supplierTenantId,
              sourceFacilityId: value.sourceFacilityId, destinationFacilityId: value.destinationFacilityId, epcs: value.epcs, actorId: principal.actorId
            }));
          } catch (error) { return json(response, 422, { error: "stock_dispatch_failed", message: error.message }); }
        }
        if (url.pathname === "/v1/admin/stock/overview" && request.method === "GET") {
          if (principal.role !== "chain_admin") return json(response, 403, { error: "globaltex_admin_required" });
          const requests = [];
          for (const id of principal.tenantIds.slice(1)) {
            requests.push(...(await store.operationsFor(id)).requests.map(commercialRequest));
          }
          const shipments = await store.shipmentsFor(principal.tenantIds[0]);
          return json(response, 200, { requests: requests.sort((a,b) => b.createdAt.localeCompare(a.createdAt)), shipments });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/standards/profile") {
          return json(response, 200, gs1UsProfile({
            companyPrefix: process.env.GS1_COMPANY_PREFIX || null
          }));
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/users") {
          if (!["hotel_admin", "chain_admin"].includes(principal.role)) {
            return json(response, 403, { error: "user_management_forbidden" });
          }
          const users = (await store.adminUsers()).filter((user) =>
            user.tenantIds.length > 0 &&
            user.tenantIds.every((assigned) => principal.tenantIds.includes(assigned)) &&
            (principal.role === "chain_admin" ||
              (user.tenantIds.length === 1 && user.tenantIds[0] === tenantId))
          );
          return json(response, 200, { users });
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/users") {
          try {
            const value = JSON.parse(await readBody(request));
            const username = String(value.username ?? "").trim().toLowerCase();
            if (!/^[a-z0-9._@+-]{3,120}$/.test(username)) {
              throw new Error("Username contains unsupported characters");
            }
            const scope = managedUserScope(principal, value);
            const passwordHash = await hashPassword(value.password);
            return json(response, 201, await store.createAdminUser({
              username,
              displayName: value.displayName,
              passwordHash,
              ...scope
            }));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_admin_user",
              message: error.message
            });
          }
        }

        const managedUser = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)$/);
        if (request.method === "PUT" && managedUser) {
          try {
            const userId = decodeURIComponent(managedUser[1]);
            const existing = (await store.adminUsers())
              .find((user) => user.userId === userId);
            if (!existing) throw new Error("Unknown admin user");
            if (!existing.tenantIds.every((assigned) => principal.tenantIds.includes(assigned))) {
              return json(response, 403, { error: "user_scope_forbidden" });
            }
            const value = JSON.parse(await readBody(request));
            if (principal.userId === userId && value.active === false) {
              throw new Error("You cannot deactivate your own account");
            }
            const scope = managedUserScope(principal, value, existing);
            const changes = {
              displayName: value.displayName,
              active: value.active,
              ...scope
            };
            if (value.password) changes.passwordHash = await hashPassword(value.password);
            return json(response, 200, await store.updateAdminUser(userId, changes));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_admin_user_update",
              message: error.message
            });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/catalog") {
          return json(response, 200, { products: await store.productsFor(tenantId) });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/encoding/batches") {
          return json(response, 200, { batches: await store.encodingBatchesFor(tenantId) });
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/encoding/batches") {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "globaltex_admin_required" });
          }
          try {
            return json(response, 201, await store.createEncodingBatch(
              tenantId,
              JSON.parse(await readBody(request))
            ));
          } catch (error) {
            return json(response, 422, { error: "invalid_encoding_batch", message: error.message });
          }
        }

        const encodingBatch = url.pathname.match(/^\/v1\/admin\/encoding\/batches\/([^/]+)$/);
        if (request.method === "GET" && encodingBatch) {
          const batch = await store.encodingBatchFor(tenantId, decodeURIComponent(encodingBatch[1]));
          return batch
            ? json(response, 200, batch)
            : json(response, 404, { error: "encoding_batch_not_found" });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/assets") {
          return json(response, 200, { assets: await store.inventoryFor(tenantId) });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/receiving-batches") {
          return json(response, 200, { batches: await store.receivingBatchesFor(tenantId) });
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/receiving-batches") {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "globaltex_admin_required" });
          }
          try {
            const value = JSON.parse(await readBody(request) || "{}");
            return json(response, 201, await store.createReceivingBatch({
              tenantId,
              sku: value.sku,
              expectedQuantity: Number(value.expectedQuantity),
              facilityId: value.facilityId,
              zoneId: value.zoneId,
              reference: value.reference || null
            }));
          } catch (error) {
            return json(response, 422, { error: "invalid_receiving_batch", message: error.message });
          }
        }

        const receivingScan = url.pathname.match(
          /^\/v1\/admin\/receiving-batches\/([^/]+)\/scan$/
        );
        if (request.method === "POST" && receivingScan) {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "globaltex_admin_required" });
          }
          try {
            const value = JSON.parse(await readBody(request) || "{}");
            const reads = await scanRru9809({
              port: process.env.RRU9809_PORT ?? "COM4",
              baudRate: Number(process.env.RRU9809_BAUD_RATE ?? 57600),
              scanCount: Math.min(Math.max(Number(value.scanCount) || 5, 1), 10)
            });
            const epcs = [...new Set(reads.map((read) => read.epc))];
            const batch = await store.addReceivingBatchReads({
              tenantId,
              batchId: decodeURIComponent(receivingScan[1]),
              epcs
            });
            return json(response, 200, { batch, detectedQuantity: epcs.length });
          } catch (error) {
            return json(response, 422, { error: "receiving_batch_scan_failed", message: error.message });
          }
        }

        const receivingApproval = url.pathname.match(
          /^\/v1\/admin\/receiving-batches\/([^/]+)\/approve$/
        );
        const receivingTag = url.pathname.match(
          /^\/v1\/admin\/receiving-batches\/([^/]+)\/tags\/([^/]+)$/
        );
        if (request.method === "DELETE" && receivingTag) {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "globaltex_admin_required" });
          }
          try {
            return json(response, 200, await store.removeReceivingBatchTag({
              tenantId,
              batchId: decodeURIComponent(receivingTag[1]),
              epc: decodeURIComponent(receivingTag[2])
            }));
          } catch (error) {
            return json(response, 422, { error: "receiving_batch_tag_removal_failed", message: error.message });
          }
        }
        if (request.method === "POST" && receivingApproval) {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "globaltex_admin_required" });
          }
          try {
            return json(response, 200, await store.approveReceivingBatch({
              tenantId,
              batchId: decodeURIComponent(receivingApproval[1]),
              actorId: principal.actorId
            }));
          } catch (error) {
            return json(response, 422, { error: "receiving_batch_approval_failed", message: error.message });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/hardware/rru9809/scan") {
          try {
            const value = JSON.parse(await readBody(request) || "{}");
            const reads = await scanRru9809({
              port: value.port || process.env.RRU9809_PORT || "COM4",
              baudRate: Number(value.baudRate || process.env.RRU9809_BAUD_RATE || 57600),
              scanCount: Math.min(Math.max(Number(value.scanCount) || 1, 1), 10)
            });
            let ingestion = null;
            if (value.facilityId || value.zoneId || value.sessionId) {
              if (!value.facilityId || !value.zoneId) {
                throw new Error("facilityId and zoneId must be supplied together");
              }
              const reader = (await store.readersFor(tenantId)).find(
                (item) => item.active && item.adapter === "rru9809usb"
              );
              if (!reader) throw new Error("No active RRU9809 reader is assigned to this hotel");
              ingestion = await store.ingest({
                tenantId,
                readerId: reader.readerId,
                facilityId: value.facilityId,
                zoneId: value.zoneId,
                sessionId: value.sessionId,
                events: reads.map((read) => ({
                  eventId: randomUUID(),
                  epc: read.epc,
                  observedAt: new Date().toISOString(),
                  antenna: read.antenna ?? 1
                }))
              });
            }
            return json(response, 200, { reads, ingestion });
          } catch (error) {
            return json(response, 422, { error: "rru9809_scan_failed", message: error.message });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/hardware/rru9809/status") {
          try {
            const configuredPort = process.env.RRU9809_PORT ?? "COM4";
            const baudRate = Number(process.env.RRU9809_BAUD_RATE ?? 57600);
            const ports = await SerialPort.list();
            const detectedPort = ports.find((port) =>
              String(port.path).toLowerCase() === configuredPort.toLowerCase()
            );
            const health = await store.gatewayHealthFor(tenantId);
            const assigned = (await store.readersFor(tenantId)).filter((r) => r.active && r.adapter === "rru9809usb");
            const latest = health.filter((item) => assigned.some((r) => r.readerId === item.readerId) &&
              item.adapter.split("@")[0] === "rru9809usb")
              .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0] ?? null;
            const telemetryState = !latest ? "standby" : latest.status === "offline" ? "timeout" : latest.status;
            return json(response, 200, {
              configuredPort,
              baudRate,
              detected: Boolean(detectedPort),
              physicalLink: detectedPort ? "connected" : "disconnected",
              telemetryState,
              lastHeartbeatAt: latest?.receivedAt ?? null,
              availablePorts: ports.map((port) => ({
                path: port.path,
                manufacturer: port.manufacturer ?? null,
                vendorId: port.vendorId ?? null,
                productId: port.productId ?? null
              })),
              capabilities: { inventoryRead: true, epcWrite: true, writeReadbackVerification: true },
              message: detectedPort
                ? `Reader detected on ${configuredPort}`
                : `No reader detected on ${configuredPort}. Connect the RRU9809USB-L and confirm its COM port.`
            });
          } catch (error) {
            return json(response, 503, {
              error: "rru9809_status_failed",
              message: error.message
            });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/hardware/rru9809/detect") {
          try {
            const ports = await SerialPort.list();
            const likely = ports.find((port) => /cp210|silicon|usb|uart|serial/i.test(
              `${port.manufacturer ?? ""} ${port.pnpId ?? ""} ${port.path ?? ""}`
            )) ?? null;
            if (likely?.path) process.env.RRU9809_PORT = likely.path;
            return json(response, 200, {
              detected: Boolean(likely),
              recommendedPort: likely?.path ?? null,
              baudRate: Number(process.env.RRU9809_BAUD_RATE ?? 57600),
              availablePorts: ports.map((port) => ({
                path: port.path,
                manufacturer: port.manufacturer ?? null,
                vendorId: port.vendorId ?? null,
                productId: port.productId ?? null
              }))
            });
          } catch (error) {
            return json(response, 503, { error: "rru9809_detect_failed", message: error.message });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/hardware/rru9809/write") {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "globaltex_admin_required" });
          }
          try {
            const value = JSON.parse(await readBody(request) || "{}");
            const epc = value.epc || `475458${randomBytes(9).toString("hex").toUpperCase()}`;
            return json(response, 200, await writeRru9809Epc({
              port: process.env.RRU9809_PORT ?? "COM4",
              baudRate: Number(process.env.RRU9809_BAUD_RATE ?? 57600),
              epc
            }));
          } catch (error) {
            return json(response, 422, { error: "rru9809_write_failed", message: error.message });
          }
        }

        if(request.method==='POST' && url.pathname==='/v1/admin/zoho/catalog/import'){
          if(principal.role!=='chain_admin'||principal.tenantId!==principal.tenantIds[0])return json(response,403,{error:'globaltex_admin_required'});
          try{
            const report=JSON.parse(readFileSync(process.env.ZOHO_MAPPING_REPORT_JSON??'data/runtime/zoho-mapping-report.json','utf8'));
            return json(response,200,await importZohoCatalog(store,principal.tenantId,report));
          }catch(error){return json(response,422,{error:'zoho_catalog_import_failed',message:error.message});}
        }
        if (request.method === "GET" && url.pathname === "/v1/admin/zoho/catalog") {
          if (principal.role !== "chain_admin") {
            return json(response, 200, {
              connected: false,
              generatedAt: null,
              summary: null,
              products: []
            });
          }
          try {
            const report = JSON.parse(readFileSync(
              process.env.ZOHO_MAPPING_REPORT_JSON ?? "data/runtime/zoho-mapping-report.json",
              "utf8"
            ));
            return json(response, 200, {
              connected: true,
              generatedAt: report.generatedAt,
              summary: report.summary,
              products: report.catalog ?? report.eligible ?? []
            });
          } catch {
            return json(response, 200, {
              connected: false,
              generatedAt: null,
              summary: null,
              products: []
            });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/zoho/assets/register") {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "globaltex_admin_required" });
          }
          try {
            const value = JSON.parse(await readBody(request));
            const report = JSON.parse(readFileSync(
              process.env.ZOHO_MAPPING_REPORT_JSON ?? "data/runtime/zoho-mapping-report.json",
              "utf8"
            ));
            const product = (report.eligible ?? []).find(
              (item) => item.sku === String(value.sku ?? "").trim()
            );
            if (!product) throw new Error("SKU is not in the eligible Zoho catalog");
            const unitsPerBox = Number(value.unitsPerBox);
            const boxesPerPallet = Number(value.boxesPerPallet);
            if (!Number.isInteger(unitsPerBox) || unitsPerBox < 1) {
              throw new Error("unitsPerBox must be a positive integer");
            }
            if (!Number.isInteger(boxesPerPallet) || boxesPerPallet < 1) {
              throw new Error("boxesPerPallet must be a positive integer");
            }
            await store.upsertProducts(tenantId, [{
              sku: product.sku,
              name: product.name,
              category: value.category ?? "Zoho Inventory",
              unitsPerBox,
              boxesPerPallet,
              size: value.size ?? "",
              color: value.color ?? "",
              active: true
            }]);
            const result = await store.registerAssets(tenantId, [{
              epc: value.epc,
              sku: product.sku,
              tid: value.tid ?? null,
              encodedAt: new Date().toISOString()
            }]);
            return json(response, 200, { ...result, sku: product.sku, name: product.name });
          } catch (error) {
            return json(response, 422, { error: "invalid_zoho_asset", message: error.message });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/audit") {
          return json(response, 200, {
            events: await store.auditFor(tenantId, {
              limit: Number(url.searchParams.get("limit") ?? 100)
            })
          });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/chain/summary") {
          if (principal.role !== "chain_admin") {
            return json(response, 403, { error: "chain_admin_required" });
          }
          const summaries = await Promise.all(
            principal.tenantIds.slice(0, 1).map(async (allowedTenantId) => ({
              tenantId: allowedTenantId,
              summary: await store.summaryFor(allowedTenantId)
            }))
          );
          return json(response, 200, chainSummary(summaries));
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/retention/read-events") {
          try {
            return json(response, 200, await store.readEventRetention(
              tenantId,
              retentionOptions({
                before: url.searchParams.get("before"),
                limit: url.searchParams.get("limit") ?? undefined
              }, { dryRun: true })
            ));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_retention_request",
              message: error.message
            });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/retention/read-events") {
          try {
            const value = JSON.parse(await readBody(request));
            return json(response, 200, await store.readEventRetention(
              tenantId,
              retentionOptions(value)
            ));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_retention_request",
              message: error.message
            });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/integrations/outbox") {
          return json(response, 200, {
            events: await store.integrationOutboxFor(tenantId, {
              status: url.searchParams.get("status") || undefined,
              limit: Number(url.searchParams.get("limit") ?? 100)
            })
          });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/alerts") {
          await store.evaluateOperationalAlerts(tenantId, { now: now?.() ?? Date.now() });
          return json(response, 200, {
            alerts: await store.alertsFor(tenantId, {
              status: url.searchParams.get("status") || undefined,
              limit: Number(url.searchParams.get("limit") ?? 100)
            })
          });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/exceptions") {
          return json(response, 200, {
            exceptions: await store.exceptionsFor(tenantId, {
              status: url.searchParams.get("status") || undefined,
              exceptionType: url.searchParams.get("type") || undefined,
              limit: Number(url.searchParams.get("limit") ?? 100)
            })
          });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/linen-operations") {
          const result = await linenOperations(store, tenantId, {
            now: now?.() ?? Date.now(),
            safetyMargin: Number(url.searchParams.get("safetyMargin") ?? 20)
          });
          for (const item of result.notSeen) {
            await store.raiseException({
              tenantId,
              dedupeKey: `not-seen:${item.epc}`,
              exceptionType: "not_seen_30_days",
              severity: "warning",
              epc: item.epc,
              details: { lastSeenAt: item.lastSeenAt, thresholdDays: 30 }
            });
          }
          return json(response, 200, result);
        }

        const exceptionResolution = url.pathname.match(
          /^\/v1\/admin\/exceptions\/([^/]+)\/resolve$/
        );
        if (request.method === "POST" && exceptionResolution) {
          try {
            const value = JSON.parse(await readBody(request));
            const caseId = decodeURIComponent(exceptionResolution[1]);
            if (value.resolution === "quarantine_bill") {
              const exception = (await store.exceptionsFor(tenantId, { limit: 500 }))
                .find((item) => item.caseId === caseId);
              if (exception?.epc) {
                await store.updateAssetStatus(tenantId, exception.epc, {
                  status: "quarantined",
                  reason: "Exception resolution: quarantine and billing review",
                  actorId: principal.actorId
                });
              }
            }
            return json(response, 200, await store.resolveException(
              tenantId,
              caseId,
              { resolution: value.resolution, actorId: principal.actorId }
            ));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_exception_resolution",
              message: error.message
            });
          }
        }

        const alertAcknowledgement = url.pathname.match(
          /^\/v1\/admin\/alerts\/([^/]+)\/acknowledge$/
        );
        if (request.method === "POST" && alertAcknowledgement) {
          try {
            return json(response, 200, await store.acknowledgeAlert(
              tenantId,
              decodeURIComponent(alertAcknowledgement[1]),
              principal.actorId
            ));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_alert",
              message: error.message
            });
          }
        }

        const integrationRetry = url.pathname.match(
          /^\/v1\/admin\/integrations\/outbox\/([^/]+)\/retry$/
        );
        if (request.method === "POST" && integrationRetry) {
          try {
            return json(response, 200, await store.retryIntegrationEvent(
              tenantId,
              decodeURIComponent(integrationRetry[1])
            ));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_integration_event",
              message: error.message
            });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/facilities") {
          try {
            return json(response, 200, await store.upsertFacility(
              tenantId,
              JSON.parse(await readBody(request))
            ));
          } catch (error) {
            return json(response, 422, { error: "invalid_facility", message: error.message });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/facilities") {
          const facilities = await store.facilitiesFor(tenantId);
          return json(response, 200, { facilities: principal.role === "chain_admin" && tenantId !== principal.tenantIds[0] ? facilities.filter(f => f.facilityType === "hotel").map(({facilityId,name,facilityType,active})=>({facilityId,name,facilityType,active})) : facilities });
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/zones") {
          try {
            return json(response, 200, await store.upsertZone(
              tenantId,
              JSON.parse(await readBody(request))
            ));
          } catch (error) {
            return json(response, 422, { error: "invalid_zone", message: error.message });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/zones") {
          return json(response, 200, { zones: await store.zonesFor(tenantId) });
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/readers") {
          try {
            return json(response, 200, await store.upsertReader(
              tenantId,
              JSON.parse(await readBody(request))
            ));
          } catch (error) {
            return json(response, 422, { error: "invalid_reader", message: error.message });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/readers") {
          return json(response, 200, { readers: await store.readersFor(tenantId) });
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/catalog/import") {
          const body = await readBody(request);
          try {
            const products = request.headers["content-type"]?.includes("text/csv")
              ? parseProductCsv(body)
              : JSON.parse(body).products;
            return json(response, 200, await store.upsertProducts(tenantId, products));
          } catch (error) {
            return json(response, 422, { error: "invalid_catalog", message: error.message });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/assets/register") {
          try {
            const body = await readBody(request);
            const assets = request.headers["content-type"]?.includes("text/csv")
              ? parseAssetCsv(body)
              : JSON.parse(body).assets;
            return json(response, 200, await store.registerAssets(tenantId, assets));
          } catch (error) {
            return json(response, 422, { error: "invalid_assets", message: error.message });
          }
        }

        const custodyHistory = url.pathname.match(
          /^\/v1\/admin\/assets\/([^/]+)\/custody$/
        );
        if (request.method === "GET" && custodyHistory) {
          return json(response, 200, {
            history: await store.custodyHistoryFor(tenantId, {
              epc: decodeURIComponent(custodyHistory[1]),
              limit: Number(url.searchParams.get("limit") ?? 100)
            })
          });
        }

        const assetLifecycle = url.pathname.match(
          /^\/v1\/admin\/assets\/([^/]+)\/lifecycle$/
        );
        if (request.method === "GET" && assetLifecycle) {
          return json(response, 200, {
            history: await store.assetLifecycleFor(
              tenantId,
              decodeURIComponent(assetLifecycle[1]),
              { limit: Number(url.searchParams.get("limit") ?? 100) }
            )
          });
        }

        const assetStatus = url.pathname.match(
          /^\/v1\/admin\/assets\/([^/]+)\/status$/
        );
        if (request.method === "POST" && assetStatus) {
          try {
            const value = JSON.parse(await readBody(request));
            if (principal.role === "operator" && value.status === "retired") {
              return json(response, 403, { error: "asset_retirement_requires_admin" });
            }
            return json(response, 200, await store.updateAssetStatus(
              tenantId,
              decodeURIComponent(assetStatus[1]),
              {
                status: value.status,
                reason: value.reason,
                actorId: principal.actorId
              }
            ));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_asset_status_transition",
              message: error.message
            });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/shipments") {
          try {
            const value = JSON.parse(await readBody(request));
            return json(response, 201, await store.createShipment({
              ...value,
              tenantId,
              actorId: principal.actorId
            }));
          } catch (error) {
            return json(response, 422, { error: "invalid_shipment", message: error.message });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/shipments") {
          return json(response, 200, { shipments: await store.shipmentsFor(tenantId) });
        }

        const reconciliation = url.pathname.match(
          /^\/v1\/admin\/shipments\/([^/]+)\/reconciliation$/
        );
        if (request.method === "GET" && reconciliation) {
          try {
            return json(response, 200, await store.reconcileShipment({
              tenantId,
              shipmentId: decodeURIComponent(reconciliation[1]),
              sessionId: url.searchParams.get("sessionId")
            }));
          } catch (error) {
            return json(response, 422, { error: "invalid_reconciliation", message: error.message });
          }
        }

        const acceptance = url.pathname.match(/^\/v1\/admin\/shipments\/([^/]+)\/accept$/);
        if (request.method === "POST" && acceptance) {
          try {
            const value = JSON.parse(await readBody(request));
            const result = await store.reconcileShipment({
              tenantId,
              shipmentId: decodeURIComponent(acceptance[1]),
              sessionId: value.sessionId,
              accept: true
            });
            await evaluateStock(store, tenantId);
            return json(response, 200, result);
          } catch (error) {
            return json(response, 422, { error: "invalid_reconciliation", message: error.message });
          }
        }

        if (request.method === "POST" && url.pathname === "/v1/admin/sessions") {
          try {
            const value = JSON.parse(await readBody(request));
            const location = await store.validateLocation({
              tenantId,
              facilityId: value.facilityId,
              zoneId: value.zoneId,
              required: requireProvisionedReaders
            });
            if (!location.valid) {
              return json(response, 422, {
                error: "invalid_session_location",
                reason: location.reason
              });
            }
            return json(response, 201, await store.startSession({ ...value, tenantId }));
          } catch (error) {
            return json(response, 422, { error: "invalid_session", message: error.message });
          }
        }

        const completion = url.pathname.match(/^\/v1\/admin\/sessions\/([^/]+)\/complete$/);
        if (request.method === "POST" && completion) {
          try {
            return json(response, 200, await store.completeSession(tenantId, decodeURIComponent(completion[1])));
          } catch (error) {
            return json(response, 422, { error: "invalid_session", message: error.message });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/sessions") {
          return json(response, 200, { sessions: await store.sessionsFor(tenantId) });
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/summary") {
          return json(response, 200, await store.summaryFor(tenantId, {
            facilityId: url.searchParams.get("facilityId") || undefined,
            zoneId: url.searchParams.get("zoneId") || undefined,
            sessionId: url.searchParams.get("sessionId") || undefined
          }));
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/pending-movements") {
          return json(response, 200, {
            pendingMovements: await store.pendingMovementsFor(tenantId)
          });
        }

        const pendingResolution = url.pathname.match(
          /^\/v1\/admin\/pending-movements\/([^/]+)\/resolve$/
        );
        if (request.method === "POST" && pendingResolution) {
          try {
            const value = JSON.parse(await readBody(request));
            return json(response, 200, await store.resolvePendingMovement(
              tenantId,
              decodeURIComponent(pendingResolution[1]),
              { action: value.action, actorId: principal.actorId }
            ));
          } catch (error) {
            return json(response, 422, {
              error: "invalid_movement_resolution",
              message: error.message
            });
          }
        }

        if (request.method === "GET" && url.pathname === "/v1/admin/readers/health") {
          return json(response, 200, {
            readers: await store.gatewayHealthFor(tenantId, { now: now?.() ?? Date.now() })
          });
        }
      }

      const keyId = request.headers["x-device-key"];
      const credential = credentials[keyId];
      if (!credential) return json(response, 401, { error: "unknown_device" });

      if (request.method === "GET") {
        const timestamp = request.headers["x-device-timestamp"];
        const signature = request.headers["x-device-signature"];
        if (!verifySignature({ secret: credential.secret, timestamp, signature, body: "", now: now?.() })) {
          return json(response, 401, { error: "invalid_signature" });
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/tag-reads") {
        const body = await readBody(request);
        const timestamp = request.headers["x-device-timestamp"];
        const signature = request.headers["x-device-signature"];
        if (!verifySignature({ secret: credential.secret, timestamp, signature, body, now: now?.() })) {
          return json(response, 401, { error: "invalid_signature" });
        }

        let batch;
        try {
          batch = JSON.parse(body);
        } catch {
          return json(response, 400, { error: "invalid_json" });
        }
        const validationError = validateBatch(batch);
        if (validationError) return json(response, 422, { error: "invalid_batch", message: validationError });
        const readerContext = await store.validateReaderContext({
          tenantId: credential.tenantId,
          readerId: credential.readerId,
          facilityId: batch.facilityId,
          zoneId: batch.zoneId,
          required: requireProvisionedReaders
        });
        if (!readerContext.valid) {
          return json(response, 403, {
            error: "invalid_reader_context",
            reason: readerContext.reason
          });
        }

        const result = await store.ingest({
          tenantId: credential.tenantId,
          readerId: credential.readerId,
          facilityId: batch.facilityId,
          zoneId: batch.zoneId,
          sessionId: batch.sessionId ?? null,
          events: batch.events
        });
        await enforceLifespan(store, credential.tenantId);
        await evaluateStock(store, credential.tenantId);
        return json(response, 202, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/device-heartbeats") {
        const body = await readBody(request);
        const timestamp = request.headers["x-device-timestamp"];
        const signature = request.headers["x-device-signature"];
        if (!verifySignature({ secret: credential.secret, timestamp, signature, body, now: now?.() })) {
          return json(response, 401, { error: "invalid_signature" });
        }

        let heartbeat;
        try {
          heartbeat = JSON.parse(body);
        } catch {
          return json(response, 400, { error: "invalid_json" });
        }
        const validationError = validateHeartbeat(heartbeat);
        if (validationError) {
          return json(response, 422, { error: "invalid_heartbeat", message: validationError });
        }
        const readerContext = await store.validateReaderContext({
          tenantId: credential.tenantId,
          readerId: credential.readerId,
          required: requireProvisionedReaders
        });
        if (!readerContext.valid) {
          return json(response, 403, {
            error: "invalid_reader_context",
            reason: readerContext.reason
          });
        }
        const receivedAt = new Date(now?.() ?? Date.now()).toISOString();
        return json(response, 202, await store.recordGatewayHealth({
          tenantId: credential.tenantId,
          readerId: credential.readerId,
          ...heartbeat,
          lastError: heartbeat.lastError ?? null,
          lastReadAt: heartbeat.lastReadAt ?? null,
          receivedAt
        }));
      }

      if (request.method === "GET" && url.pathname === "/v1/inventory") {
        return json(response, 200, { items: await store.inventoryFor(credential.tenantId) });
      }

      if (request.method === "GET" && url.pathname === "/v1/movements") {
        return json(response, 200, { movements: await store.movementsFor(credential.tenantId) });
      }

      if (request.method === "GET" && url.pathname === "/v1/inventory/summary") {
        return json(response, 200, await store.summaryFor(credential.tenantId, {
          facilityId: url.searchParams.get("facilityId") || undefined,
          zoneId: url.searchParams.get("zoneId") || undefined,
          sessionId: url.searchParams.get("sessionId") || undefined
        }));
      }

      return json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error.message === "body_too_large" ? 413 : 500;
      return json(response, status, { error: error.message === "body_too_large" ? error.message : "internal_error" });
    }
  });
  server.once("close", () => clearInterval(stockMonitor));
  return server;
}
