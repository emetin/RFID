import { randomUUID } from "node:crypto";
import { calculatePackaging } from "./packaging.js";
import { gatewayStatus } from "./gateway-health.js";
import { movementDecision } from "./movement-policy.js";
import { ASSET_STATUSES, validateAssetTransition } from "./asset-lifecycle.js";

export class InventoryStore {
  #seenEvents = new Set();
  #readEvents = new Map();
  #inventory = new Map();
  #movements = [];
  #products = new Map();
  #assets = new Map();
  #sessions = new Map();
  #shipments = new Map();
  #pendingMovements = new Map();
  #gatewayHealth = new Map();
  #facilities = new Map();
  #zones = new Map();
  #readers = new Map();
  #auditEvents = [];
  #integrationOutbox = new Map();
  #alerts = new Map();
  #custodyHistory = [];
  #exceptions = new Map();
  #assetLifecycleHistory = [];
  #adminUsers = new Map();

  createAdminUser({
    userId = randomUUID(),
    username,
    displayName,
    passwordHash,
    role,
    tenantIds,
    defaultTenantId,
    active = true,
    createdAt = new Date().toISOString()
  }) {
    const key = String(username).trim().toLowerCase();
    if (this.#adminUsers.has(key)) throw new Error("Username already exists");
    const user = {
      userId,
      username: key,
      displayName: displayName?.trim() || key,
      passwordHash,
      role,
      tenantIds: [...new Set(tenantIds)],
      defaultTenantId,
      active,
      createdAt,
      updatedAt: createdAt
    };
    this.#adminUsers.set(key, user);
    return this.#publicAdminUser(user);
  }

  adminUserByUsername(username) {
    const user = this.#adminUsers.get(String(username).trim().toLowerCase());
    return user ? { ...user, tenantIds: [...user.tenantIds] } : null;
  }

  adminUserById(userId) {
    const user = [...this.#adminUsers.values()].find((item) => item.userId === userId);
    return user ? { ...user, tenantIds: [...user.tenantIds] } : null;
  }

  adminUsers() {
    return [...this.#adminUsers.values()]
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((user) => this.#publicAdminUser(user));
  }

  updateAdminUser(userId, changes) {
    const user = [...this.#adminUsers.values()].find((item) => item.userId === userId);
    if (!user) throw new Error("Unknown admin user");
    Object.assign(user, {
      displayName: changes.displayName ?? user.displayName,
      role: changes.role ?? user.role,
      tenantIds: changes.tenantIds ? [...new Set(changes.tenantIds)] : user.tenantIds,
      defaultTenantId: changes.defaultTenantId ?? user.defaultTenantId,
      active: changes.active ?? user.active,
      passwordHash: changes.passwordHash ?? user.passwordHash,
      updatedAt: new Date().toISOString()
    });
    return this.#publicAdminUser(user);
  }

  #publicAdminUser(user) {
    const { passwordHash, ...value } = user;
    return { ...value, tenantIds: [...user.tenantIds] };
  }

  upsertProducts(tenantId, products) {
    for (const product of products) {
      if (!product.sku || !product.name) throw new Error("Product sku and name are required");
      if (!Number.isInteger(product.unitsPerBox) || product.unitsPerBox < 1) {
        throw new Error(`Invalid unitsPerBox for ${product.sku}`);
      }
      if (!Number.isInteger(product.boxesPerPallet) || product.boxesPerPallet < 1) {
        throw new Error(`Invalid boxesPerPallet for ${product.sku}`);
      }
      this.#products.set(`${tenantId}:${product.sku}`, {
        tenantId,
        sku: product.sku,
        name: product.name,
        category: product.category ?? "",
        unitsPerBox: product.unitsPerBox,
        boxesPerPallet: product.boxesPerPallet,
        size: product.size ?? "",
        color: product.color ?? "",
        active: product.active ?? true
      });
    }
    return { imported: products.length };
  }

  productsFor(tenantId) {
    return [...this.#products.values()]
      .filter((product) => product.tenantId === tenantId)
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }

  upsertFacility(tenantId, facility) {
    const allowedTypes = new Set(["factory", "warehouse", "hotel", "laundry"]);
    if (!facility.facilityId || !facility.name) throw new Error("facilityId and name are required");
    if (!allowedTypes.has(facility.facilityType)) throw new Error("Unsupported facilityType");
    const value = {
      tenantId,
      facilityId: facility.facilityId,
      name: facility.name,
      facilityType: facility.facilityType,
      timezone: facility.timezone ?? "UTC",
      active: facility.active ?? true
    };
    this.#facilities.set(`${tenantId}:${facility.facilityId}`, value);
    return value;
  }

  facilitiesFor(tenantId) {
    return [...this.#facilities.values()]
      .filter((facility) => facility.tenantId === tenantId)
      .sort((a, b) => a.facilityId.localeCompare(b.facilityId));
  }

  upsertZone(tenantId, zone) {
    if (!zone.zoneId || !zone.facilityId || !zone.name || !zone.zoneType) {
      throw new Error("zoneId, facilityId, name and zoneType are required");
    }
    if (!this.#facilities.has(`${tenantId}:${zone.facilityId}`)) {
      throw new Error("Unknown facility");
    }
    const value = {
      tenantId,
      zoneId: zone.zoneId,
      facilityId: zone.facilityId,
      name: zone.name,
      zoneType: zone.zoneType,
      active: zone.active ?? true
    };
    this.#zones.set(`${tenantId}:${zone.zoneId}`, value);
    return value;
  }

  zonesFor(tenantId) {
    return [...this.#zones.values()]
      .filter((zone) => zone.tenantId === tenantId)
      .sort((a, b) => a.zoneId.localeCompare(b.zoneId));
  }

  upsertReader(tenantId, reader) {
    if (!reader.readerId || !reader.facilityId || !reader.zoneId || !reader.name || !reader.adapter) {
      throw new Error("readerId, facilityId, zoneId, name and adapter are required");
    }
    const zone = this.#zones.get(`${tenantId}:${reader.zoneId}`);
    if (!zone || zone.facilityId !== reader.facilityId) {
      throw new Error("Reader zone does not belong to facility");
    }
    const value = {
      tenantId,
      readerId: reader.readerId,
      facilityId: reader.facilityId,
      zoneId: reader.zoneId,
      name: reader.name,
      adapter: reader.adapter,
      active: reader.active ?? true
    };
    this.#readers.set(`${tenantId}:${reader.readerId}`, value);
    return value;
  }

  readersFor(tenantId) {
    return [...this.#readers.values()]
      .filter((reader) => reader.tenantId === tenantId)
      .sort((a, b) => a.readerId.localeCompare(b.readerId));
  }

  validateReaderContext({ tenantId, readerId, facilityId, zoneId, required = false }) {
    const reader = this.#readers.get(`${tenantId}:${readerId}`);
    if (!reader) {
      return required
        ? { valid: false, reason: "reader_not_provisioned" }
        : { valid: true, reason: "legacy_unprovisioned_reader" };
    }
    const facility = this.#facilities.get(`${tenantId}:${reader.facilityId}`);
    const zone = this.#zones.get(`${tenantId}:${reader.zoneId}`);
    if (!reader.active || !facility?.active || !zone?.active) {
      return { valid: false, reason: "reader_or_location_inactive" };
    }
    if (facilityId != null && reader.facilityId !== facilityId) {
      return { valid: false, reason: "reader_facility_mismatch" };
    }
    if (zoneId != null && reader.zoneId !== zoneId) {
      return { valid: false, reason: "reader_zone_mismatch" };
    }
    return { valid: true, reason: null };
  }

  validateLocation({ tenantId, facilityId, zoneId, required = false }) {
    const facility = this.#facilities.get(`${tenantId}:${facilityId}`);
    const zone = this.#zones.get(`${tenantId}:${zoneId}`);
    if (!facility || !zone) {
      return required
        ? { valid: false, reason: "location_not_provisioned" }
        : { valid: true, reason: "legacy_unprovisioned_location" };
    }
    if (!facility.active || !zone.active) {
      return { valid: false, reason: "location_inactive" };
    }
    if (zone.facilityId !== facilityId) {
      return { valid: false, reason: "zone_facility_mismatch" };
    }
    return { valid: true, reason: null };
  }

  registerAssets(tenantId, assets) {
    let registered = 0;
    let unchanged = 0;
    for (const asset of assets) {
      const epc = String(asset.epc ?? "").toUpperCase();
      const product = this.#products.get(`${tenantId}:${asset.sku}`);
      if (!product) throw new Error(`Unknown SKU: ${asset.sku}`);
      if (!/^[0-9A-F]{8,96}$/.test(epc)) throw new Error(`Invalid EPC: ${epc}`);
      const status = asset.status ?? "active";
      if (!ASSET_STATUSES.has(status)) throw new Error(`Invalid asset status: ${status}`);
      const existing = this.#assets.get(`${tenantId}:${epc}`);
      const globalExisting = [...this.#assets.values()].find((item) => item.epc === epc);
      if (globalExisting && globalExisting.tenantId !== tenantId) {
        throw new Error(`EPC ${epc} is already assigned to tenant ${globalExisting.tenantId}`);
      }
      if (existing?.sku !== undefined && existing.sku !== asset.sku) {
        throw new Error(`EPC ${epc} is already registered to SKU ${existing.sku}`);
      }
      if (existing) {
        unchanged += 1;
        continue;
      }
      this.#assets.set(`${tenantId}:${epc}`, {
        tenantId,
        epc,
        sku: asset.sku,
        tid: asset.tid ?? null,
        status,
        encodedAt: asset.encodedAt ?? null
      });
      this.#assetLifecycleHistory.push({
        historyId: randomUUID(),
        tenantId,
        epc,
        fromStatus: null,
        toStatus: status,
        reason: "registration",
        actorId: "asset_registration",
        changedAt: asset.encodedAt ?? new Date().toISOString()
      });
      const validFrom = asset.encodedAt ?? new Date().toISOString();
      this.#custodyHistory.push({
        custodyId: randomUUID(),
        epc,
        tenantId,
        facilityId: null,
        shipmentId: null,
        changeType: "registered",
        validFrom,
        validTo: null,
        recordedAt: new Date().toISOString()
      });
      registered += 1;
    }
    return { registered, unchanged };
  }

  createShipment({
    tenantId,
    customerTenantId,
    destinationFacilityId,
    reference = null,
    epcs,
    shipmentId = randomUUID()
  }) {
    if (!customerTenantId || customerTenantId === tenantId) {
      throw new Error("A different customerTenantId is required");
    }
    if (!destinationFacilityId) throw new Error("destinationFacilityId is required");
    if (!Array.isArray(epcs) || epcs.length === 0) throw new Error("epcs must not be empty");
    if (this.#shipments.has(shipmentId)) throw new Error("Shipment already exists");

    const normalized = [...new Set(epcs.map((epc) => String(epc).toUpperCase()))];
    if (normalized.length !== epcs.length) throw new Error("Shipment contains duplicate EPCs");
    const assets = normalized.map((epc) => {
      const asset = this.#assets.get(`${tenantId}:${epc}`);
      if (!asset) throw new Error(`EPC ${epc} is not owned by supplier tenant`);
      return { epc, sku: asset.sku, acceptedAt: null };
    });
    const shipment = {
      shipmentId,
      supplierTenantId: tenantId,
      customerTenantId,
      destinationFacilityId,
      reference,
      status: "ready",
      createdAt: new Date().toISOString(),
      acceptedAt: null,
      assets
    };
    this.#shipments.set(shipmentId, shipment);
    return this.#publicShipment(shipment);
  }

  shipmentsFor(tenantId) {
    return [...this.#shipments.values()]
      .filter((shipment) =>
        shipment.supplierTenantId === tenantId || shipment.customerTenantId === tenantId
      )
      .map((shipment) => this.#publicShipment(shipment));
  }

  reconcileShipment({ tenantId, shipmentId, sessionId, accept = false }) {
    const shipment = this.#shipments.get(shipmentId);
    if (!shipment || shipment.customerTenantId !== tenantId) throw new Error("Unknown shipment");
    const session = this.#sessions.get(`${tenantId}:${sessionId}`);
    if (!session) throw new Error("Unknown scan session");
    if (session.facilityId !== shipment.destinationFacilityId) {
      throw new Error("Scan session is not at the shipment destination");
    }

    const expected = new Set(shipment.assets.map((asset) => asset.epc));
    const scanned = new Set(session.uniqueEpcs);
    const received = [...expected].filter((epc) => scanned.has(epc));
    const missing = [...expected].filter((epc) => !scanned.has(epc));
    const unexpected = [...scanned].filter((epc) => !expected.has(epc));

    if (accept) {
      const acceptedAt = new Date().toISOString();
      for (const epc of received) {
        const manifestAsset = shipment.assets.find((asset) => asset.epc === epc);
        if (manifestAsset.acceptedAt) continue;
        const sourceKey = `${shipment.supplierTenantId}:${epc}`;
        const asset = this.#assets.get(sourceKey);
        if (!asset) throw new Error(`EPC ${epc} is no longer owned by supplier tenant`);
        const sourceProduct = this.#products.get(`${shipment.supplierTenantId}:${asset.sku}`);
        if (!this.#products.has(`${tenantId}:${asset.sku}`)) {
          this.#products.set(`${tenantId}:${asset.sku}`, { ...sourceProduct, tenantId });
        }
        this.#assets.delete(sourceKey);
        this.#assets.set(`${tenantId}:${epc}`, { ...asset, tenantId });
        this.#assetLifecycleHistory.push({
          historyId: randomUUID(),
          tenantId,
          epc,
          fromStatus: null,
          toStatus: asset.status,
          reason: "custody_transfer",
          actorId: "shipment_acceptance",
          changedAt: acceptedAt
        });
        const unknownCase = this.#exceptions.get(`${tenantId}:unknown-asset:${epc}`);
        if (unknownCase?.status === "open") {
          unknownCase.status = "resolved";
          unknownCase.resolution = "corrected";
          unknownCase.resolvedBy = "shipment_acceptance";
          unknownCase.resolvedAt = acceptedAt;
        }
        manifestAsset.acceptedAt = acceptedAt;
        const currentCustody = this.#custodyHistory.find((entry) =>
          entry.epc === epc &&
          entry.tenantId === shipment.supplierTenantId &&
          entry.validTo == null
        );
        if (currentCustody) currentCustody.validTo = acceptedAt;
        this.#custodyHistory.push({
          custodyId: randomUUID(),
          epc,
          tenantId,
          facilityId: shipment.destinationFacilityId,
          shipmentId,
          changeType: "shipment_received",
          validFrom: acceptedAt,
          validTo: null,
          recordedAt: acceptedAt
        });
        this.enqueueIntegrationEvent({
          tenantId,
          eventType: "asset.custody_transferred",
          aggregateId: epc,
          payload: {
            epc,
            sku: asset.sku,
            shipmentId,
            fromTenantId: shipment.supplierTenantId,
            toTenantId: tenantId,
            destinationFacilityId: shipment.destinationFacilityId,
            acceptedAt
          }
        });
      }
      const acceptedCount = shipment.assets.filter((asset) => asset.acceptedAt).length;
      shipment.status = acceptedCount === shipment.assets.length ? "received" : "partially_received";
      shipment.acceptedAt = shipment.status === "received" ? acceptedAt : null;
      for (const epc of missing) {
        this.raiseException({
          tenantId,
          dedupeKey: `shipment:${shipmentId}:${sessionId}:missing:${epc}`,
          exceptionType: "shipment_missing",
          severity: "warning",
          epc,
          shipmentId,
          sessionId,
          details: { destinationFacilityId: shipment.destinationFacilityId }
        });
      }
      for (const epc of unexpected) {
        this.raiseException({
          tenantId,
          dedupeKey: `shipment:${shipmentId}:${sessionId}:unexpected:${epc}`,
          exceptionType: "shipment_unexpected",
          severity: "critical",
          epc,
          shipmentId,
          sessionId,
          details: { destinationFacilityId: shipment.destinationFacilityId }
        });
      }
    }

    return {
      shipment: this.#publicShipment(shipment),
      sessionId,
      expectedCount: expected.size,
      receivedCount: received.length,
      missingCount: missing.length,
      unexpectedCount: unexpected.length,
      received,
      missing,
      unexpected
    };
  }

  startSession({ tenantId, facilityId, zoneId, type = "inventory", reference = null, sessionId = randomUUID() }) {
    const allowedTypes = new Set(["receiving", "inventory", "transfer", "laundry_out", "laundry_in"]);
    if (!facilityId || !zoneId) throw new Error("facilityId and zoneId are required");
    if (!allowedTypes.has(type)) throw new Error(`Unsupported session type: ${type}`);
    const session = {
      sessionId,
      tenantId,
      facilityId,
      zoneId,
      type,
      reference,
      status: "open",
      startedAt: new Date().toISOString(),
      completedAt: null,
      uniqueEpcs: new Set()
    };
    this.#sessions.set(`${tenantId}:${sessionId}`, session);
    return this.#publicSession(session);
  }

  completeSession(tenantId, sessionId) {
    const session = this.#sessions.get(`${tenantId}:${sessionId}`);
    if (!session) throw new Error("Unknown scan session");
    session.status = "completed";
    session.completedAt = new Date().toISOString();
    return this.#publicSession(session);
  }

  sessionsFor(tenantId) {
    return [...this.#sessions.values()]
      .filter((session) => session.tenantId === tenantId)
      .map((session) => this.#publicSession(session));
  }

  ingest({
    tenantId,
    readerId,
    facilityId,
    zoneId,
    sessionId = null,
    events,
    receivedAt = new Date().toISOString()
  }) {
    let accepted = 0;
    let duplicates = 0;
    let unknownAssets = 0;
    const session = sessionId ? this.#sessions.get(`${tenantId}:${sessionId}`) : null;
    if (sessionId && (!session || session.status !== "open")) throw new Error("Scan session is not open");

    for (const event of events) {
      const eventKey = `${tenantId}:${event.eventId}`;
      if (this.#seenEvents.has(eventKey)) {
        duplicates += 1;
        continue;
      }
      this.#seenEvents.add(eventKey);
      this.#readEvents.set(eventKey, {
        tenantId,
        eventId: event.eventId,
        receivedAt
      });
      accepted += 1;
      session?.uniqueEpcs.add(event.epc);

      const key = `${tenantId}:${event.epc}`;
      const previous = this.#inventory.get(key);
      const asset = this.#assets.get(key);
      if (!asset) {
        unknownAssets += 1;
        this.raiseException({
          tenantId,
          dedupeKey: `unknown-asset:${event.epc}`,
          exceptionType: "unknown_asset",
          severity: "warning",
          epc: event.epc,
          details: { readerId, facilityId, zoneId, observedAt: event.observedAt }
        });
      }
      const decision = movementDecision({
        previous,
        candidate: this.#pendingMovements.get(key),
        facilityId,
        zoneId,
        readerId,
        observedAt: event.observedAt,
        trustedSession: Boolean(session)
      });

      if (decision.action === "pending") {
        this.#pendingMovements.set(key, {
          tenantId,
          epc: event.epc,
          ...decision.candidate
        });
        this.#inventory.set(key, {
          ...previous,
          readCount: previous.readCount + 1
        });
        continue;
      }

      this.#pendingMovements.delete(key);
      if (decision.action === "ignore") {
        this.#inventory.set(key, {
          ...previous,
          readCount: previous.readCount + 1
        });
        continue;
      }
      if (decision.action === "confirm") {
        this.#movements.push({
          tenantId,
          epc: event.epc,
          fromFacilityId: previous?.facilityId ?? null,
          fromZoneId: previous?.zoneId ?? null,
          toFacilityId: facilityId,
          toZoneId: zoneId,
          observedAt: event.observedAt,
          readerId
        });
        this.enqueueIntegrationEvent({
          tenantId,
          eventType: previous
            ? "inventory.movement_confirmed"
            : "inventory.position_initialized",
          aggregateId: event.epc,
          payload: {
            epc: event.epc,
            fromFacilityId: previous?.facilityId ?? null,
            fromZoneId: previous?.zoneId ?? null,
            toFacilityId: facilityId,
            toZoneId: zoneId,
            readerId,
            observedAt: event.observedAt
          }
        });
      }
      this.#inventory.set(key, {
        tenantId,
        epc: event.epc,
        sku: asset?.sku ?? null,
        assetStatus: asset?.status ?? "unregistered",
        facilityId: decision.action === "stay" ? previous.facilityId : facilityId,
        zoneId: decision.action === "stay" ? previous.zoneId : zoneId,
        readerId,
        sessionId,
        firstSeenAt: previous?.firstSeenAt ?? event.observedAt,
        lastSeenAt: event.observedAt,
        readCount: (previous?.readCount ?? 0) + 1,
        lastRssi: event.rssi ?? null,
        lastAntenna: event.antenna ?? null
      });
    }

    return { accepted, duplicates, unknownAssets };
  }

  readEventRetention(tenantId, {
    before,
    limit = 10_000,
    dryRun = true
  } = {}) {
    const cutoff = Date.parse(before);
    if (!Number.isFinite(cutoff)) throw new Error("before must be ISO-8601");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
      throw new Error("limit must be an integer between 1 and 50000");
    }
    if (typeof dryRun !== "boolean") throw new Error("dryRun must be boolean");

    const tenantEvents = [...this.#readEvents.entries()]
      .filter(([, event]) => event.tenantId === tenantId)
      .sort((a, b) => a[1].receivedAt.localeCompare(b[1].receivedAt));
    const eligible = tenantEvents.filter(([, event]) =>
      Date.parse(event.receivedAt) < cutoff
    );
    const victims = eligible.slice(0, limit);

    if (!dryRun) {
      for (const [eventKey] of victims) {
        this.#readEvents.delete(eventKey);
        this.#seenEvents.delete(eventKey);
      }
    }

    return {
      before: new Date(cutoff).toISOString(),
      totalReadEvents: tenantEvents.length,
      eligible: eligible.length,
      deleted: dryRun ? 0 : victims.length,
      dryRun,
      batchLimit: limit,
      oldestReceivedAt: tenantEvents[0]?.[1].receivedAt ?? null,
      newestReceivedAt: tenantEvents.at(-1)?.[1].receivedAt ?? null
    };
  }

  inventoryFor(tenantId) {
    return [...this.#inventory.values()]
      .filter((item) => item.tenantId === tenantId)
      .map((item) => {
        const asset = this.#assets.get(`${tenantId}:${item.epc}`);
        return {
          ...item,
          sku: asset?.sku ?? null,
          assetStatus: asset?.status ?? "unregistered"
        };
      })
      .sort((a, b) => a.epc.localeCompare(b.epc));
  }

  custodyHistoryFor(tenantId, { epc, limit = 100 } = {}) {
    return this.#custodyHistory
      .filter((entry) =>
        entry.tenantId === tenantId &&
        (!epc || entry.epc === String(epc).toUpperCase())
      )
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map((entry) => ({ ...entry }));
  }

  updateAssetStatus(tenantId, epc, {
    status,
    reason,
    actorId,
    changedAt = new Date().toISOString()
  }) {
    if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
    const normalizedEpc = String(epc).toUpperCase();
    const asset = this.#assets.get(`${tenantId}:${normalizedEpc}`);
    if (!asset) throw new Error("Unknown asset");
    const transition = validateAssetTransition(asset.status, status);
    if (!transition.changed) {
      return {
        changed: false,
        asset: { ...asset },
        history: null
      };
    }
    const fromStatus = asset.status;
    asset.status = status;
    const history = {
      historyId: randomUUID(),
      tenantId,
      epc: normalizedEpc,
      fromStatus,
      toStatus: status,
      reason: reason.trim(),
      actorId,
      changedAt
    };
    this.#assetLifecycleHistory.push(history);
    this.enqueueIntegrationEvent({
      tenantId,
      eventType: "asset.status_changed",
      aggregateId: normalizedEpc,
      payload: history
    });
    return { changed: true, asset: { ...asset }, history: { ...history } };
  }

  assetLifecycleFor(tenantId, epc, { limit = 100 } = {}) {
    const normalizedEpc = String(epc).toUpperCase();
    return this.#assetLifecycleHistory
      .filter((entry) => entry.tenantId === tenantId && entry.epc === normalizedEpc)
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map((entry) => ({ ...entry }));
  }

  movementsFor(tenantId) {
    return this.#movements.filter((movement) => movement.tenantId === tenantId);
  }

  pendingMovementsFor(tenantId) {
    return [...this.#pendingMovements.values()]
      .filter((movement) => movement.tenantId === tenantId)
      .sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt));
  }

  resolvePendingMovement(tenantId, epc, { action, actorId }) {
    if (!["confirm", "dismiss"].includes(action)) {
      throw new Error("action must be confirm or dismiss");
    }
    const normalizedEpc = String(epc).toUpperCase();
    const key = `${tenantId}:${normalizedEpc}`;
    const candidate = this.#pendingMovements.get(key);
    if (!candidate) throw new Error("Unknown pending movement");
    this.#pendingMovements.delete(key);
    if (action === "dismiss") {
      return { action, epc: normalizedEpc, actorId, movement: null };
    }
    const previous = this.#inventory.get(key);
    if (!previous) throw new Error("Inventory position is missing");
    const movement = {
      tenantId,
      epc: normalizedEpc,
      fromFacilityId: previous.facilityId,
      fromZoneId: previous.zoneId,
      toFacilityId: candidate.toFacilityId,
      toZoneId: candidate.toZoneId,
      observedAt: candidate.lastObservedAt,
      readerId: candidate.readerId,
      confidence: 1,
      resolution: "operator_confirmed",
      resolvedBy: actorId
    };
    this.#movements.push(movement);
    this.#inventory.set(key, {
      ...previous,
      facilityId: candidate.toFacilityId,
      zoneId: candidate.toZoneId,
      readerId: candidate.readerId,
      lastSeenAt: candidate.lastObservedAt
    });
    this.enqueueIntegrationEvent({
      tenantId,
      eventType: "inventory.movement_confirmed",
      aggregateId: normalizedEpc,
      payload: {
        epc: normalizedEpc,
        fromFacilityId: movement.fromFacilityId,
        fromZoneId: movement.fromZoneId,
        toFacilityId: movement.toFacilityId,
        toZoneId: movement.toZoneId,
        readerId: movement.readerId,
        observedAt: movement.observedAt,
        resolution: movement.resolution,
        resolvedBy: actorId
      }
    });
    return { action, epc: normalizedEpc, actorId, movement };
  }

  recordGatewayHealth({
    tenantId,
    readerId,
    adapter,
    gatewayVersion,
    readerConnected,
    queueDepth,
    lastReadAt = null,
    lastError = null,
    heartbeatAt,
    receivedAt = new Date().toISOString()
  }) {
    if (!Number.isInteger(queueDepth) || queueDepth < 0) {
      throw new Error("queueDepth must be a non-negative integer");
    }
    const health = {
      tenantId,
      readerId,
      adapter,
      gatewayVersion,
      readerConnected: Boolean(readerConnected),
      queueDepth,
      lastReadAt,
      lastError,
      heartbeatAt,
      receivedAt
    };
    const key = `${tenantId}:${readerId}`;
    const existing = this.#gatewayHealth.get(key);
    if (existing && Date.parse(heartbeatAt) <= Date.parse(existing.heartbeatAt)) {
      return { ...existing, status: gatewayStatus(existing, Date.parse(receivedAt)) };
    }
    this.#gatewayHealth.set(key, health);
    return { ...health, status: gatewayStatus(health, Date.parse(receivedAt)) };
  }

  gatewayHealthFor(tenantId, { now = Date.now() } = {}) {
    return [...this.#gatewayHealth.values()]
      .filter((health) => health.tenantId === tenantId)
      .map((health) => ({ ...health, status: gatewayStatus(health, now) }))
      .sort((a, b) => a.readerId.localeCompare(b.readerId));
  }

  recordAudit({
    tenantId,
    actorId,
    actorRole,
    action,
    entityType,
    entityId = null,
    details = {},
    auditId = randomUUID(),
    createdAt = new Date().toISOString()
  }) {
    const event = {
      auditId,
      tenantId,
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      details,
      createdAt
    };
    this.#auditEvents.push(event);
    return event;
  }

  auditFor(tenantId, { limit = 100 } = {}) {
    return this.#auditEvents
      .filter((event) => event.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 500));
  }

  enqueueIntegrationEvent({
    tenantId,
    eventType,
    aggregateId = null,
    payload,
    eventId = randomUUID(),
    createdAt = new Date().toISOString()
  }) {
    const event = {
      eventId,
      tenantId,
      eventType,
      aggregateId,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: createdAt,
      lastError: null,
      createdAt,
      deliveredAt: null
    };
    this.#integrationOutbox.set(eventId, event);
    return { ...event };
  }

  pendingIntegrationEvents(tenantId, { now = Date.now(), limit = 100 } = {}) {
    return [...this.#integrationOutbox.values()]
      .filter((event) =>
        event.tenantId === tenantId &&
        event.status === "pending" &&
        Date.parse(event.nextAttemptAt) <= now
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map((event) => ({ ...event }));
  }

  integrationOutboxFor(tenantId, { status, limit = 100 } = {}) {
    return [...this.#integrationOutbox.values()]
      .filter((event) => event.tenantId === tenantId && (!status || event.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map((event) => ({ ...event }));
  }

  markIntegrationDelivered(tenantId, eventId, deliveredAt = new Date().toISOString()) {
    const event = this.#integrationOutbox.get(eventId);
    if (!event || event.tenantId !== tenantId) throw new Error("Unknown integration event");
    event.status = "delivered";
    event.deliveredAt = deliveredAt;
    event.lastError = null;
    return { ...event };
  }

  markIntegrationFailed(
    tenantId,
    eventId,
    error,
    { now = Date.now(), maxAttempts = 5 } = {}
  ) {
    const event = this.#integrationOutbox.get(eventId);
    if (!event || event.tenantId !== tenantId) throw new Error("Unknown integration event");
    event.attempts += 1;
    event.lastError = String(error?.message ?? error).slice(0, 1000);
    event.status = event.attempts >= maxAttempts ? "dead_letter" : "pending";
    const delay = Math.min(60_000 * (2 ** Math.max(event.attempts - 1, 0)), 3_600_000);
    event.nextAttemptAt = new Date(now + delay).toISOString();
    return { ...event };
  }

  retryIntegrationEvent(tenantId, eventId, now = new Date().toISOString()) {
    const event = this.#integrationOutbox.get(eventId);
    if (!event || event.tenantId !== tenantId) throw new Error("Unknown integration event");
    event.status = "pending";
    event.attempts = 0;
    event.nextAttemptAt = now;
    event.lastError = null;
    event.deliveredAt = null;
    return { ...event };
  }

  raiseException({
    tenantId,
    dedupeKey,
    exceptionType,
    severity,
    epc = null,
    shipmentId = null,
    sessionId = null,
    details = {},
    now = new Date().toISOString()
  }) {
    const key = `${tenantId}:${dedupeKey}`;
    const existing = this.#exceptions.get(key);
    if (existing) {
      existing.lastSeenAt = now;
      existing.details = details;
      return { ...existing };
    }
    const exception = {
      caseId: randomUUID(),
      tenantId,
      dedupeKey,
      exceptionType,
      severity,
      status: "open",
      epc,
      shipmentId,
      sessionId,
      details,
      firstSeenAt: now,
      lastSeenAt: now,
      resolution: null,
      resolvedBy: null,
      resolvedAt: null
    };
    this.#exceptions.set(key, exception);
    return { ...exception };
  }

  exceptionsFor(tenantId, { status, exceptionType, limit = 100 } = {}) {
    return [...this.#exceptions.values()]
      .filter((item) =>
        item.tenantId === tenantId &&
        (!status || item.status === status) &&
        (!exceptionType || item.exceptionType === exceptionType)
      )
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map((item) => ({ ...item }));
  }

  resolveException(
    tenantId,
    caseId,
    { resolution, actorId, now = new Date().toISOString() }
  ) {
    const allowed = new Set(["corrected", "accepted_exception", "quarantined", "dismissed"]);
    if (!allowed.has(resolution)) throw new Error("Unsupported exception resolution");
    const exception = [...this.#exceptions.values()]
      .find((item) => item.tenantId === tenantId && item.caseId === caseId);
    if (!exception) throw new Error("Unknown exception case");
    if (exception.status === "resolved") return { ...exception };
    exception.status = "resolved";
    exception.resolution = resolution;
    exception.resolvedBy = actorId;
    exception.resolvedAt = now;
    this.enqueueIntegrationEvent({
      tenantId,
      eventType: "exception.resolved",
      aggregateId: caseId,
      payload: {
        caseId,
        exceptionType: exception.exceptionType,
        epc: exception.epc,
        shipmentId: exception.shipmentId,
        resolution,
        resolvedBy: actorId,
        resolvedAt: now
      }
    });
    return { ...exception };
  }

  raiseAlert({
    tenantId,
    dedupeKey,
    alertType,
    severity,
    entityType,
    entityId = null,
    title,
    message,
    details = {},
    now = new Date().toISOString()
  }) {
    const key = `${tenantId}:${dedupeKey}`;
    const existing = this.#alerts.get(key);
    if (existing) {
      existing.alertType = alertType;
      existing.severity = severity;
      existing.entityType = entityType;
      existing.entityId = entityId;
      existing.title = title;
      existing.message = message;
      existing.details = details;
      existing.lastSeenAt = now;
      if (existing.status === "resolved") {
        existing.status = "open";
        existing.firstSeenAt = now;
        existing.acknowledgedBy = null;
        existing.acknowledgedAt = null;
        existing.resolvedAt = null;
      }
      return { ...existing };
    }
    const alert = {
      alertId: randomUUID(),
      tenantId,
      dedupeKey,
      alertType,
      severity,
      status: "open",
      entityType,
      entityId,
      title,
      message,
      details,
      firstSeenAt: now,
      lastSeenAt: now,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedAt: null
    };
    this.#alerts.set(key, alert);
    return { ...alert };
  }

  resolveAlertByKey(tenantId, dedupeKey, now = new Date().toISOString()) {
    const alert = this.#alerts.get(`${tenantId}:${dedupeKey}`);
    if (!alert || alert.status === "resolved") return null;
    alert.status = "resolved";
    alert.resolvedAt = now;
    return { ...alert };
  }

  acknowledgeAlert(tenantId, alertId, actorId, now = new Date().toISOString()) {
    const alert = [...this.#alerts.values()]
      .find((item) => item.tenantId === tenantId && item.alertId === alertId);
    if (!alert) throw new Error("Unknown alert");
    if (alert.status === "resolved") throw new Error("Resolved alert cannot be acknowledged");
    alert.status = "acknowledged";
    alert.acknowledgedBy = actorId;
    alert.acknowledgedAt = now;
    return { ...alert };
  }

  alertsFor(tenantId, { status, limit = 100 } = {}) {
    return [...this.#alerts.values()]
      .filter((alert) => alert.tenantId === tenantId && (!status || alert.status === status))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map((alert) => ({ ...alert }));
  }

  evaluateOperationalAlerts(tenantId, { now = Date.now() } = {}) {
    const nowIso = new Date(now).toISOString();
    const activeKeys = new Set();

    for (const reader of this.gatewayHealthFor(tenantId, { now })) {
      const key = `reader-health:${reader.readerId}`;
      if (reader.status === "online") {
        this.resolveAlertByKey(tenantId, key, nowIso);
        continue;
      }
      activeKeys.add(key);
      this.raiseAlert({
        tenantId,
        dedupeKey: key,
        alertType: "reader_health",
        severity: reader.status === "offline" ? "critical" : "warning",
        entityType: "reader",
        entityId: reader.readerId,
        title: `Reader ${reader.status}`,
        message: reader.status === "offline"
          ? "Gateway heartbeat is overdue."
          : "Reader is disconnected, reporting an error or has queued data.",
        details: {
          status: reader.status,
          queueDepth: reader.queueDepth,
          lastError: reader.lastError
        },
        now: nowIso
      });
    }

    for (const movement of this.pendingMovementsFor(tenantId)) {
      if (now - Date.parse(movement.firstObservedAt) < 300_000) continue;
      const key = `pending-movement:${movement.epc}`;
      activeKeys.add(key);
      this.raiseAlert({
        tenantId,
        dedupeKey: key,
        alertType: "pending_movement",
        severity: "warning",
        entityType: "asset",
        entityId: movement.epc,
        title: "Movement awaiting confirmation",
        message: "RFID movement evidence has remained unresolved for more than five minutes.",
        details: movement,
        now: nowIso
      });
    }

    const unknown = this.inventoryFor(tenantId)
      .filter((item) => item.assetStatus === "unregistered");
    if (unknown.length > 0) {
      const key = "unknown-tags";
      activeKeys.add(key);
      this.raiseAlert({
        tenantId,
        dedupeKey: key,
        alertType: "unknown_tags",
        severity: "warning",
        entityType: "inventory",
        title: "Unknown RFID tags detected",
        message: `${unknown.length} unregistered EPCs are present in inventory observations.`,
        details: { count: unknown.length, epcs: unknown.slice(0, 100).map((item) => item.epc) },
        now: nowIso
      });
    }

    for (const event of this.integrationOutboxFor(tenantId, {
      status: "dead_letter",
      limit: 500
    })) {
      const key = `integration-dead-letter:${event.eventId}`;
      activeKeys.add(key);
      this.raiseAlert({
        tenantId,
        dedupeKey: key,
        alertType: "integration_delivery_failed",
        severity: "critical",
        entityType: "integration_event",
        entityId: event.eventId,
        title: "Integration delivery failed",
        message: event.lastError ?? "Webhook delivery reached the retry limit.",
        details: { eventType: event.eventType, attempts: event.attempts },
        now: nowIso
      });
    }

    for (const alert of this.alertsFor(tenantId, { limit: 500 })) {
      if (alert.status === "resolved") continue;
      if (["reader_health", "pending_movement", "unknown_tags", "integration_delivery_failed"]
        .includes(alert.alertType) && !activeKeys.has(alert.dedupeKey)) {
        this.resolveAlertByKey(tenantId, alert.dedupeKey, nowIso);
      }
    }
    return this.alertsFor(tenantId, { limit: 500 });
  }

  summaryFor(tenantId, { facilityId, zoneId, sessionId } = {}) {
    const session = sessionId ? this.#sessions.get(`${tenantId}:${sessionId}`) : null;
    const matched = sessionId
      ? [...(session?.uniqueEpcs ?? [])].map((epc) => {
          const asset = this.#assets.get(`${tenantId}:${epc}`);
          return {
            epc,
            sku: asset?.sku ?? null,
            assetStatus: asset?.status ?? "unregistered"
          };
        })
      : this.inventoryFor(tenantId).filter((item) =>
          (!facilityId || item.facilityId === facilityId) &&
          (!zoneId || item.zoneId === zoneId)
        );
    const counts = new Map();
    let unknownUnits = 0;
    const statusCounts = {
      active: 0,
      quarantined: 0,
      damaged: 0,
      lost: 0,
      retired: 0,
      unregistered: 0
    };
    for (const item of matched) {
      const status = item.assetStatus ?? "unregistered";
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      if (!item.sku) {
        unknownUnits += 1;
        continue;
      }
      counts.set(item.sku, (counts.get(item.sku) ?? 0) + 1);
    }

    const lines = [...counts.entries()].map(([sku, units]) => {
      const product = this.#products.get(`${tenantId}:${sku}`);
      return {
        sku,
        name: product.name,
        category: product.category,
        size: product.size,
        color: product.color,
        ...calculatePackaging(units, product.unitsPerBox, product.boxesPerPallet)
      };
    }).sort((a, b) => a.sku.localeCompare(b.sku));

    return {
      filters: { facilityId: facilityId ?? null, zoneId: zoneId ?? null, sessionId: sessionId ?? null },
      uniqueUnits: matched.length,
      registeredUnits: matched.length - unknownUnits,
      unknownUnits,
      availableUnits: statusCounts.active,
      statusCounts,
      lines
    };
  }

  #publicSession(session) {
    return {
      ...session,
      uniqueEpcs: session.uniqueEpcs.size
    };
  }

  #publicShipment(shipment) {
    return {
      shipmentId: shipment.shipmentId,
      supplierTenantId: shipment.supplierTenantId,
      customerTenantId: shipment.customerTenantId,
      destinationFacilityId: shipment.destinationFacilityId,
      reference: shipment.reference,
      status: shipment.status,
      createdAt: shipment.createdAt,
      acceptedAt: shipment.acceptedAt,
      assetCount: shipment.assets.length,
      acceptedAssetCount: shipment.assets.filter((asset) => asset.acceptedAt).length
    };
  }
}
