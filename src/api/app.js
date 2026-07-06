import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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

const MAX_BODY_BYTES = 2_000_000;
const EPC_PATTERN = /^[0-9A-F]{8,96}$/;
const DASHBOARD = readFileSync(new URL("../../public/dashboard.html", import.meta.url), "utf8");
const LOGIN = readFileSync(new URL("../../public/login.html", import.meta.url), "utf8");
const ADMIN_ROLES = new Set(["viewer", "operator", "hotel_admin", "chain_admin"]);

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

function cookieValue(request, name) {
  const match = String(request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function identityForCredentials(username, password, admin, store) {
  let identity;
  if (admin?.identities) identity = admin.identities[password];
  else if (admin?.token === password) {
    identity = {
      actorId: "local-admin",
      role: "hotel_admin",
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

  const tenantIds = identity.tenantIds ?? [];
  const tenantId = request.headers["x-tenant-id"] ?? identity.defaultTenantId ?? tenantIds[0];
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
    /^\/v1\/admin\/sessions\/[^/]+\/complete$/.test(pathname) ||
    /^\/v1\/admin\/shipments\/[^/]+\/accept$/.test(pathname) ||
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
  store = new InventoryStore(),
  now,
  requireProvisionedReaders = false,
  sessionSecret = admin?.sessionSecret ?? admin?.token ?? "local-session-secret",
  secureCookies = false
} = {}) {
  if (!credentials || Object.keys(credentials).length === 0) {
    throw new Error("At least one device credential is required");
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { status: "ok" });
      }

      if (request.method === "GET" && url.pathname === "/login") {
        return html(response, 200, LOGIN);
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
        return html(response, 200, DASHBOARD);
      }

      if (url.pathname.startsWith("/v1/admin/")) {
        const principal = await authenticateAdmin(request, admin, store, sessionSecret);
        if (principal.error) return requireAdmin(response, principal.error);
        const tenantId = principal.tenantId;
        const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
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
            principal.tenantIds.map(async (allowedTenantId) => ({
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

        const exceptionResolution = url.pathname.match(
          /^\/v1\/admin\/exceptions\/([^/]+)\/resolve$/
        );
        if (request.method === "POST" && exceptionResolution) {
          try {
            const value = JSON.parse(await readBody(request));
            return json(response, 200, await store.resolveException(
              tenantId,
              decodeURIComponent(exceptionResolution[1]),
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
          return json(response, 200, { facilities: await store.facilitiesFor(tenantId) });
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
            return json(response, 201, await store.createShipment({ tenantId, ...value }));
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
            return json(response, 200, await store.reconcileShipment({
              tenantId,
              shipmentId: decodeURIComponent(acceptance[1]),
              sessionId: value.sessionId,
              accept: true
            }));
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
            return json(response, 201, await store.startSession({ tenantId, ...value }));
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
}
