import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calculatePackaging } from "./packaging.js";
import { gatewayStatus } from "./gateway-health.js";
import { movementDecision } from "./movement-policy.js";
import { ASSET_STATUSES, validateAssetTransition } from "./asset-lifecycle.js";

const MIGRATION = readFileSync(
  new URL("../../db/sqlite/001_initial.sql", import.meta.url),
  "utf8"
);

function toProduct(row) {
  return {
    tenantId: row.tenant_id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    unitsPerBox: row.units_per_box,
    boxesPerPallet: row.boxes_per_pallet,
    size: row.size,
    color: row.color,
    active: Boolean(row.active)
  };
}

function toInventory(row) {
  return {
    tenantId: row.tenant_id,
    epc: row.epc,
    sku: row.sku,
    assetStatus: row.asset_status,
    facilityId: row.facility_id,
    zoneId: row.zone_id,
    readerId: row.reader_id,
    sessionId: row.session_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    readCount: row.read_count,
    lastRssi: row.last_rssi,
    lastAntenna: row.last_antenna
  };
}

export class SqliteStore {
  #database;

  constructor(path = "data/runtime/rfid.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(MIGRATION);
  }

  close() {
    this.#database.close();
  }

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
    const normalized = String(username).trim().toLowerCase();
    return this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO admin_users (
          user_id, username, display_name, password_hash, role,
          default_tenant_id, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, normalized, displayName?.trim() || normalized, passwordHash,
        role, defaultTenantId, active ? 1 : 0, createdAt, createdAt
      );
      const assignment = this.#database.prepare(`
        INSERT INTO admin_user_tenants (user_id, tenant_id) VALUES (?, ?)
      `);
      for (const tenantId of new Set(tenantIds)) assignment.run(userId, tenantId);
      return this.#adminUserById(userId, false);
    });
  }

  adminUserByUsername(username) {
    const row = this.#database.prepare(`
      SELECT * FROM admin_users WHERE username = ?
    `).get(String(username).trim().toLowerCase());
    return row ? this.#adminUser(row, true) : null;
  }

  adminUserById(userId) {
    return this.#adminUserById(userId, true);
  }

  adminUsers() {
    return this.#database.prepare(`
      SELECT * FROM admin_users ORDER BY username
    `).all().map((row) => this.#adminUser(row, false));
  }

  updateAdminUser(userId, changes) {
    return this.#transaction(() => {
      const current = this.#adminUserById(userId, true);
      if (!current) throw new Error("Unknown admin user");
      const tenantIds = changes.tenantIds ?? current.tenantIds;
      this.#database.prepare(`
        UPDATE admin_users
        SET display_name = ?, password_hash = ?, role = ?,
            default_tenant_id = ?, active = ?, updated_at = ?
        WHERE user_id = ?
      `).run(
        changes.displayName ?? current.displayName,
        changes.passwordHash ?? current.passwordHash,
        changes.role ?? current.role,
        changes.defaultTenantId ?? current.defaultTenantId,
        (changes.active ?? current.active) ? 1 : 0,
        new Date().toISOString(),
        userId
      );
      if (changes.tenantIds) {
        this.#database.prepare("DELETE FROM admin_user_tenants WHERE user_id = ?").run(userId);
        const assignment = this.#database.prepare(`
          INSERT INTO admin_user_tenants (user_id, tenant_id) VALUES (?, ?)
        `);
        for (const tenantId of new Set(tenantIds)) assignment.run(userId, tenantId);
      }
      return this.#adminUserById(userId, false);
    });
  }

  #adminUserById(userId, includeHash) {
    const row = this.#database.prepare(`
      SELECT * FROM admin_users WHERE user_id = ?
    `).get(userId);
    return row ? this.#adminUser(row, includeHash) : null;
  }

  #adminUser(row, includeHash) {
    const value = {
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      tenantIds: this.#database.prepare(`
        SELECT tenant_id FROM admin_user_tenants
        WHERE user_id = ? ORDER BY tenant_id
      `).all(row.user_id).map((item) => item.tenant_id),
      defaultTenantId: row.default_tenant_id,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    if (includeHash) value.passwordHash = row.password_hash;
    return value;
  }

  #transaction(operation) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertProducts(tenantId, products) {
    const statement = this.#database.prepare(`
      INSERT INTO products (
        tenant_id, sku, name, category, units_per_box,
        boxes_per_pallet, size, color, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        units_per_box = excluded.units_per_box,
        boxes_per_pallet = excluded.boxes_per_pallet,
        size = excluded.size,
        color = excluded.color,
        active = excluded.active
    `);

    return this.#transaction(() => {
      for (const product of products) {
        if (!product.sku || !product.name) throw new Error("Product sku and name are required");
        if (!Number.isInteger(product.unitsPerBox) || product.unitsPerBox < 1) {
          throw new Error(`Invalid unitsPerBox for ${product.sku}`);
        }
        if (!Number.isInteger(product.boxesPerPallet) || product.boxesPerPallet < 1) {
          throw new Error(`Invalid boxesPerPallet for ${product.sku}`);
        }
        statement.run(
          tenantId,
          product.sku,
          product.name,
          product.category ?? "",
          product.unitsPerBox,
          product.boxesPerPallet,
          product.size ?? "",
          product.color ?? "",
          product.active === false ? 0 : 1
        );
      }
      return { imported: products.length };
    });
  }

  productsFor(tenantId) {
    return this.#database.prepare(`
      SELECT * FROM products WHERE tenant_id = ? ORDER BY sku
    `).all(tenantId).map(toProduct);
  }

  upsertFacility(tenantId, facility) {
    const allowedTypes = new Set(["factory", "warehouse", "hotel", "laundry"]);
    if (!facility.facilityId || !facility.name) throw new Error("facilityId and name are required");
    if (!allowedTypes.has(facility.facilityType)) throw new Error("Unsupported facilityType");
    this.#database.prepare(`
      INSERT INTO facilities (
        tenant_id, facility_id, name, facility_type, timezone, active
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, facility_id) DO UPDATE SET
        name = excluded.name,
        facility_type = excluded.facility_type,
        timezone = excluded.timezone,
        active = excluded.active
    `).run(
      tenantId,
      facility.facilityId,
      facility.name,
      facility.facilityType,
      facility.timezone ?? "UTC",
      facility.active === false ? 0 : 1
    );
    return this.facilitiesFor(tenantId)
      .find((item) => item.facilityId === facility.facilityId);
  }

  facilitiesFor(tenantId) {
    return this.#database.prepare(`
      SELECT * FROM facilities WHERE tenant_id = ? ORDER BY facility_id
    `).all(tenantId).map((row) => ({
      tenantId: row.tenant_id,
      facilityId: row.facility_id,
      name: row.name,
      facilityType: row.facility_type,
      timezone: row.timezone,
      active: Boolean(row.active)
    }));
  }

  upsertZone(tenantId, zone) {
    if (!zone.zoneId || !zone.facilityId || !zone.name || !zone.zoneType) {
      throw new Error("zoneId, facilityId, name and zoneType are required");
    }
    const facility = this.#database.prepare(`
      SELECT 1 FROM facilities WHERE tenant_id = ? AND facility_id = ?
    `).get(tenantId, zone.facilityId);
    if (!facility) throw new Error("Unknown facility");
    this.#database.prepare(`
      INSERT INTO zones (
        tenant_id, zone_id, facility_id, name, zone_type, active
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, zone_id) DO UPDATE SET
        facility_id = excluded.facility_id,
        name = excluded.name,
        zone_type = excluded.zone_type,
        active = excluded.active
    `).run(
      tenantId,
      zone.zoneId,
      zone.facilityId,
      zone.name,
      zone.zoneType,
      zone.active === false ? 0 : 1
    );
    return this.zonesFor(tenantId).find((item) => item.zoneId === zone.zoneId);
  }

  zonesFor(tenantId) {
    return this.#database.prepare(`
      SELECT * FROM zones WHERE tenant_id = ? ORDER BY zone_id
    `).all(tenantId).map((row) => ({
      tenantId: row.tenant_id,
      zoneId: row.zone_id,
      facilityId: row.facility_id,
      name: row.name,
      zoneType: row.zone_type,
      active: Boolean(row.active)
    }));
  }

  upsertReader(tenantId, reader) {
    if (!reader.readerId || !reader.facilityId || !reader.zoneId || !reader.name || !reader.adapter) {
      throw new Error("readerId, facilityId, zoneId, name and adapter are required");
    }
    const zone = this.#database.prepare(`
      SELECT facility_id FROM zones WHERE tenant_id = ? AND zone_id = ?
    `).get(tenantId, reader.zoneId);
    if (!zone || zone.facility_id !== reader.facilityId) {
      throw new Error("Reader zone does not belong to facility");
    }
    this.#database.prepare(`
      INSERT INTO readers (
        tenant_id, reader_id, facility_id, zone_id, name, adapter, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, reader_id) DO UPDATE SET
        facility_id = excluded.facility_id,
        zone_id = excluded.zone_id,
        name = excluded.name,
        adapter = excluded.adapter,
        active = excluded.active
    `).run(
      tenantId,
      reader.readerId,
      reader.facilityId,
      reader.zoneId,
      reader.name,
      reader.adapter,
      reader.active === false ? 0 : 1
    );
    return this.readersFor(tenantId).find((item) => item.readerId === reader.readerId);
  }

  readersFor(tenantId) {
    return this.#database.prepare(`
      SELECT * FROM readers WHERE tenant_id = ? ORDER BY reader_id
    `).all(tenantId).map((row) => ({
      tenantId: row.tenant_id,
      readerId: row.reader_id,
      facilityId: row.facility_id,
      zoneId: row.zone_id,
      name: row.name,
      adapter: row.adapter,
      active: Boolean(row.active)
    }));
  }

  validateReaderContext({ tenantId, readerId, facilityId, zoneId, required = false }) {
    const row = this.#database.prepare(`
      SELECT
        r.*,
        f.active AS facility_active,
        z.active AS zone_active
      FROM readers r
      JOIN facilities f
        ON f.tenant_id = r.tenant_id AND f.facility_id = r.facility_id
      JOIN zones z
        ON z.tenant_id = r.tenant_id AND z.zone_id = r.zone_id
      WHERE r.tenant_id = ? AND r.reader_id = ?
    `).get(tenantId, readerId);
    if (!row) {
      return required
        ? { valid: false, reason: "reader_not_provisioned" }
        : { valid: true, reason: "legacy_unprovisioned_reader" };
    }
    if (!row.active || !row.facility_active || !row.zone_active) {
      return { valid: false, reason: "reader_or_location_inactive" };
    }
    if (facilityId != null && row.facility_id !== facilityId) {
      return { valid: false, reason: "reader_facility_mismatch" };
    }
    if (zoneId != null && row.zone_id !== zoneId) {
      return { valid: false, reason: "reader_zone_mismatch" };
    }
    return { valid: true, reason: null };
  }

  validateLocation({ tenantId, facilityId, zoneId, required = false }) {
    const row = this.#database.prepare(`
      SELECT
        f.active AS facility_active,
        z.active AS zone_active,
        z.facility_id AS zone_facility_id
      FROM facilities f
      LEFT JOIN zones z
        ON z.tenant_id = f.tenant_id AND z.zone_id = ?
      WHERE f.tenant_id = ? AND f.facility_id = ?
    `).get(zoneId, tenantId, facilityId);
    if (!row || row.zone_facility_id == null) {
      return required
        ? { valid: false, reason: "location_not_provisioned" }
        : { valid: true, reason: "legacy_unprovisioned_location" };
    }
    if (!row.facility_active || !row.zone_active) {
      return { valid: false, reason: "location_inactive" };
    }
    if (row.zone_facility_id !== facilityId) {
      return { valid: false, reason: "zone_facility_mismatch" };
    }
    return { valid: true, reason: null };
  }

  registerAssets(tenantId, assets) {
    const productExists = this.#database.prepare(`
      SELECT 1 FROM products WHERE tenant_id = ? AND sku = ?
    `);
    const existingAsset = this.#database.prepare(`
      SELECT tenant_id, sku FROM rfid_assets WHERE epc = ?
    `);
    const insert = this.#database.prepare(`
      INSERT INTO rfid_assets (
        tenant_id, epc, sku, tid, status, encoded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertCustody = this.#database.prepare(`
      INSERT INTO asset_custody_history (
        custody_id, epc, tenant_id, facility_id, shipment_id,
        change_type, valid_from, recorded_at
      ) VALUES (?, ?, ?, NULL, NULL, 'registered', ?, ?)
    `);
    const insertLifecycle = this.#database.prepare(`
      INSERT INTO asset_lifecycle_history (
        history_id, tenant_id, epc, from_status, to_status,
        reason, actor_id, changed_at
      ) VALUES (?, ?, ?, NULL, ?, 'registration', 'asset_registration', ?)
    `);

    return this.#transaction(() => {
      let registered = 0;
      let unchanged = 0;
      for (const asset of assets) {
        const epc = String(asset.epc ?? "").toUpperCase();
        if (!productExists.get(tenantId, asset.sku)) throw new Error(`Unknown SKU: ${asset.sku}`);
        if (!/^[0-9A-F]{8,96}$/.test(epc)) throw new Error(`Invalid EPC: ${epc}`);
        const status = asset.status ?? "active";
        if (!ASSET_STATUSES.has(status)) throw new Error(`Invalid asset status: ${status}`);
        const existing = existingAsset.get(epc);
        if (existing && existing.tenant_id !== tenantId) {
          throw new Error(`EPC ${epc} is already assigned to tenant ${existing.tenant_id}`);
        }
        if (existing && existing.sku !== asset.sku) {
          throw new Error(`EPC ${epc} is already registered to SKU ${existing.sku}`);
        }
        if (existing) {
          unchanged += 1;
          continue;
        }
        insert.run(
          tenantId,
          epc,
          asset.sku,
          asset.tid ?? null,
          status,
          asset.encodedAt ?? null
        );
        const recordedAt = new Date().toISOString();
        insertLifecycle.run(
          randomUUID(),
          tenantId,
          epc,
          status,
          asset.encodedAt ?? recordedAt
        );
        insertCustody.run(
          randomUUID(),
          epc,
          tenantId,
          asset.encodedAt ?? recordedAt,
          recordedAt
        );
        registered += 1;
      }
      return { registered, unchanged };
    });
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
    const normalized = [...new Set(epcs.map((epc) => String(epc).toUpperCase()))];
    if (normalized.length !== epcs.length) throw new Error("Shipment contains duplicate EPCs");

    const asset = this.#database.prepare(`
      SELECT sku FROM rfid_assets WHERE tenant_id = ? AND epc = ?
    `);
    const insertShipment = this.#database.prepare(`
      INSERT INTO shipments (
        shipment_id, supplier_tenant_id, customer_tenant_id,
        destination_facility_id, reference, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'ready', ?)
    `);
    const insertAsset = this.#database.prepare(`
      INSERT INTO shipment_assets (shipment_id, epc, sku)
      VALUES (?, ?, ?)
    `);

    this.#transaction(() => {
      const assets = normalized.map((epc) => {
        const found = asset.get(tenantId, epc);
        if (!found) throw new Error(`EPC ${epc} is not owned by supplier tenant`);
        return { epc, sku: found.sku };
      });
      insertShipment.run(
        shipmentId,
        tenantId,
        customerTenantId,
        destinationFacilityId,
        reference,
        new Date().toISOString()
      );
      for (const item of assets) insertAsset.run(shipmentId, item.epc, item.sku);
    });
    return this.#shipmentForTenant(tenantId, shipmentId);
  }

  shipmentsFor(tenantId) {
    return this.#database.prepare(`
      SELECT
        s.*,
        COUNT(sa.epc) AS asset_count,
        SUM(CASE WHEN sa.accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted_asset_count
      FROM shipments s
      LEFT JOIN shipment_assets sa ON sa.shipment_id = s.shipment_id
      WHERE s.supplier_tenant_id = ? OR s.customer_tenant_id = ?
      GROUP BY s.shipment_id
      ORDER BY s.created_at DESC
    `).all(tenantId, tenantId).map((row) => this.#toShipment(row));
  }

  reconcileShipment({ tenantId, shipmentId, sessionId, accept = false }) {
    const shipment = this.#database.prepare(`
      SELECT * FROM shipments
      WHERE shipment_id = ? AND customer_tenant_id = ?
    `).get(shipmentId, tenantId);
    if (!shipment) throw new Error("Unknown shipment");
    const session = this.#database.prepare(`
      SELECT * FROM scan_sessions WHERE tenant_id = ? AND session_id = ?
    `).get(tenantId, sessionId);
    if (!session) throw new Error("Unknown scan session");
    if (session.facility_id !== shipment.destination_facility_id) {
      throw new Error("Scan session is not at the shipment destination");
    }

    const manifest = this.#database.prepare(`
      SELECT epc, sku, accepted_at FROM shipment_assets WHERE shipment_id = ?
    `).all(shipmentId);
    const scannedRows = this.#database.prepare(`
      SELECT epc FROM session_epcs WHERE tenant_id = ? AND session_id = ?
    `).all(tenantId, sessionId);
    const expected = new Set(manifest.map((item) => item.epc));
    const scanned = new Set(scannedRows.map((item) => item.epc));
    const received = [...expected].filter((epc) => scanned.has(epc));
    const missing = [...expected].filter((epc) => !scanned.has(epc));
    const unexpected = [...scanned].filter((epc) => !expected.has(epc));

    if (accept) {
      this.#transaction(() => {
        const sourceProduct = this.#database.prepare(`
          SELECT * FROM products WHERE tenant_id = ? AND sku = ?
        `);
        const copyProduct = this.#database.prepare(`
          INSERT INTO products (
            tenant_id, sku, name, category, units_per_box,
            boxes_per_pallet, size, color, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, sku) DO NOTHING
        `);
        const transferAsset = this.#database.prepare(`
          UPDATE rfid_assets SET tenant_id = ?
          WHERE tenant_id = ? AND epc = ?
        `);
        const acceptAsset = this.#database.prepare(`
          UPDATE shipment_assets SET accepted_at = ?
          WHERE shipment_id = ? AND epc = ? AND accepted_at IS NULL
        `);
        const closeCustody = this.#database.prepare(`
          UPDATE asset_custody_history
          SET valid_to = ?
          WHERE epc = ? AND tenant_id = ? AND valid_to IS NULL
        `);
        const insertCustody = this.#database.prepare(`
          INSERT INTO asset_custody_history (
            custody_id, epc, tenant_id, facility_id, shipment_id,
            change_type, valid_from, recorded_at
          ) VALUES (?, ?, ?, ?, ?, 'shipment_received', ?, ?)
        `);
        const acceptedAt = new Date().toISOString();

        for (const epc of received) {
          const manifestAsset = manifest.find((item) => item.epc === epc);
          if (manifestAsset.accepted_at) continue;
          const product = sourceProduct.get(shipment.supplier_tenant_id, manifestAsset.sku);
          if (!product) throw new Error(`Product ${manifestAsset.sku} is no longer available`);
          copyProduct.run(
            tenantId,
            product.sku,
            product.name,
            product.category,
            product.units_per_box,
            product.boxes_per_pallet,
            product.size,
            product.color,
            product.active
          );
          const transferred = transferAsset.run(tenantId, shipment.supplier_tenant_id, epc);
          if (Number(transferred.changes) !== 1) {
            throw new Error(`EPC ${epc} is no longer owned by supplier tenant`);
          }
          this.#database.prepare(`
            INSERT INTO asset_lifecycle_history (
              history_id, tenant_id, epc, from_status, to_status,
              reason, actor_id, changed_at
            ) VALUES (?, ?, ?, NULL, ?, 'custody_transfer', 'shipment_acceptance', ?)
          `).run(
            randomUUID(),
            tenantId,
            epc,
            this.#database.prepare(
              "SELECT status FROM rfid_assets WHERE tenant_id = ? AND epc = ?"
            ).get(tenantId, epc).status,
            acceptedAt
          );
          this.#database.prepare(`
            UPDATE exception_cases
            SET status = 'resolved', resolution = 'corrected',
                resolved_by = 'shipment_acceptance', resolved_at = ?
            WHERE tenant_id = ? AND dedupe_key = ? AND status = 'open'
          `).run(acceptedAt, tenantId, `unknown-asset:${epc}`);
          acceptAsset.run(acceptedAt, shipmentId, epc);
          closeCustody.run(acceptedAt, epc, shipment.supplier_tenant_id);
          insertCustody.run(
            randomUUID(),
            epc,
            tenantId,
            shipment.destination_facility_id,
            shipmentId,
            acceptedAt,
            acceptedAt
          );
          this.enqueueIntegrationEvent({
            tenantId,
            eventType: "asset.custody_transferred",
            aggregateId: epc,
            payload: {
              epc,
              sku: manifestAsset.sku,
              shipmentId,
              fromTenantId: shipment.supplier_tenant_id,
              toTenantId: tenantId,
              destinationFacilityId: shipment.destination_facility_id,
              acceptedAt
            }
          });
        }

        const counts = this.#database.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted
          FROM shipment_assets WHERE shipment_id = ?
        `).get(shipmentId);
        const status = Number(counts.accepted) === Number(counts.total)
          ? "received"
          : "partially_received";
        this.#database.prepare(`
          UPDATE shipments
          SET status = ?, accepted_at = CASE WHEN ? = 'received' THEN ? ELSE NULL END
          WHERE shipment_id = ?
        `).run(status, status, acceptedAt, shipmentId);
        for (const epc of missing) {
          this.raiseException({
            tenantId,
            dedupeKey: `shipment:${shipmentId}:${sessionId}:missing:${epc}`,
            exceptionType: "shipment_missing",
            severity: "warning",
            epc,
            shipmentId,
            sessionId,
            details: { destinationFacilityId: shipment.destination_facility_id }
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
            details: { destinationFacilityId: shipment.destination_facility_id }
          });
        }
      });
    }

    return {
      shipment: this.#shipmentForTenant(tenantId, shipmentId),
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

  startSession({
    tenantId,
    facilityId,
    zoneId,
    type = "inventory",
    reference = null,
    sessionId = randomUUID()
  }) {
    const allowedTypes = new Set(["receiving", "inventory", "transfer", "laundry_out", "laundry_in"]);
    if (!facilityId || !zoneId) throw new Error("facilityId and zoneId are required");
    if (!allowedTypes.has(type)) throw new Error(`Unsupported session type: ${type}`);
    const startedAt = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO scan_sessions (
        tenant_id, session_id, facility_id, zone_id, type,
        reference, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(tenantId, sessionId, facilityId, zoneId, type, reference, startedAt);
    return {
      sessionId,
      tenantId,
      facilityId,
      zoneId,
      type,
      reference,
      status: "open",
      startedAt,
      completedAt: null,
      uniqueEpcs: 0
    };
  }

  completeSession(tenantId, sessionId) {
    const completedAt = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE scan_sessions
      SET status = 'completed', completed_at = ?
      WHERE tenant_id = ? AND session_id = ? AND status = 'open'
    `).run(completedAt, tenantId, sessionId);
    if (Number(result.changes) !== 1) throw new Error("Unknown or closed scan session");
    return this.#session(tenantId, sessionId);
  }

  sessionsFor(tenantId) {
    return this.#database.prepare(`
      SELECT
        s.*,
        COUNT(se.epc) AS unique_epcs
      FROM scan_sessions s
      LEFT JOIN session_epcs se
        ON se.tenant_id = s.tenant_id AND se.session_id = s.session_id
      WHERE s.tenant_id = ?
      GROUP BY s.tenant_id, s.session_id
      ORDER BY s.started_at DESC
    `).all(tenantId).map((row) => this.#toSession(row));
  }

  #session(tenantId, sessionId) {
    const row = this.#database.prepare(`
      SELECT
        s.*,
        COUNT(se.epc) AS unique_epcs
      FROM scan_sessions s
      LEFT JOIN session_epcs se
        ON se.tenant_id = s.tenant_id AND se.session_id = s.session_id
      WHERE s.tenant_id = ? AND s.session_id = ?
      GROUP BY s.tenant_id, s.session_id
    `).get(tenantId, sessionId);
    if (!row) throw new Error("Unknown scan session");
    return this.#toSession(row);
  }

  #toSession(row) {
    return {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      facilityId: row.facility_id,
      zoneId: row.zone_id,
      type: row.type,
      reference: row.reference,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      uniqueEpcs: Number(row.unique_epcs)
    };
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
    const session = sessionId
      ? this.#database.prepare(`
          SELECT status FROM scan_sessions
          WHERE tenant_id = ? AND session_id = ?
        `).get(tenantId, sessionId)
      : null;
    if (sessionId && session?.status !== "open") throw new Error("Scan session is not open");

    const insertEvent = this.#database.prepare(`
      INSERT OR IGNORE INTO read_events (
        tenant_id, event_id, epc, reader_id, facility_id, zone_id,
        session_id, observed_at, rssi, antenna, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const addSessionEpc = this.#database.prepare(`
      INSERT OR IGNORE INTO session_epcs (tenant_id, session_id, epc)
      VALUES (?, ?, ?)
    `);
    const asset = this.#database.prepare(`
      SELECT sku FROM rfid_assets WHERE tenant_id = ? AND epc = ?
    `);
    const previousPosition = this.#database.prepare(`
      SELECT facility_id, zone_id, first_seen_at, last_seen_at
      FROM inventory_positions WHERE tenant_id = ? AND epc = ?
    `);
    const pendingMovement = this.#database.prepare(`
      SELECT * FROM pending_movements WHERE tenant_id = ? AND epc = ?
    `);
    const upsertPendingMovement = this.#database.prepare(`
      INSERT INTO pending_movements (
        tenant_id, epc, from_facility_id, from_zone_id,
        to_facility_id, to_zone_id, reader_id, first_observed_at,
        last_observed_at, observations, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, epc) DO UPDATE SET
        from_facility_id = excluded.from_facility_id,
        from_zone_id = excluded.from_zone_id,
        to_facility_id = excluded.to_facility_id,
        to_zone_id = excluded.to_zone_id,
        reader_id = excluded.reader_id,
        first_observed_at = excluded.first_observed_at,
        last_observed_at = excluded.last_observed_at,
        observations = excluded.observations,
        reason = excluded.reason
    `);
    const deletePendingMovement = this.#database.prepare(`
      DELETE FROM pending_movements WHERE tenant_id = ? AND epc = ?
    `);
    const incrementPositionReads = this.#database.prepare(`
      UPDATE inventory_positions SET read_count = read_count + 1
      WHERE tenant_id = ? AND epc = ?
    `);
    const upsertPosition = this.#database.prepare(`
      INSERT INTO inventory_positions (
        tenant_id, epc, facility_id, zone_id, reader_id, session_id,
        first_seen_at, last_seen_at, read_count, last_rssi, last_antenna
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (tenant_id, epc) DO UPDATE SET
        facility_id = excluded.facility_id,
        zone_id = excluded.zone_id,
        reader_id = excluded.reader_id,
        session_id = excluded.session_id,
        last_seen_at = excluded.last_seen_at,
        read_count = inventory_positions.read_count + 1,
        last_rssi = excluded.last_rssi,
        last_antenna = excluded.last_antenna
    `);
    const insertMovement = this.#database.prepare(`
      INSERT INTO movement_events (
        tenant_id, epc, from_facility_id, from_zone_id,
        to_facility_id, to_zone_id, reader_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return this.#transaction(() => {
      let accepted = 0;
      let duplicates = 0;
      let unknownAssets = 0;
      for (const event of events) {
        const inserted = insertEvent.run(
          tenantId,
          event.eventId,
          event.epc,
          readerId,
          facilityId,
          zoneId,
          sessionId,
          event.observedAt,
          event.rssi ?? null,
          event.antenna ?? null,
          receivedAt
        );
        if (Number(inserted.changes) === 0) {
          duplicates += 1;
          continue;
        }
        accepted += 1;
        if (!asset.get(tenantId, event.epc)) {
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
        if (sessionId) addSessionEpc.run(tenantId, sessionId, event.epc);

        const previous = previousPosition.get(tenantId, event.epc);
        const pending = pendingMovement.get(tenantId, event.epc);
        const decision = movementDecision({
          previous: previous ? {
            facilityId: previous.facility_id,
            zoneId: previous.zone_id,
            lastSeenAt: previous.last_seen_at
          } : null,
          candidate: pending ? {
            fromFacilityId: pending.from_facility_id,
            fromZoneId: pending.from_zone_id,
            toFacilityId: pending.to_facility_id,
            toZoneId: pending.to_zone_id,
            readerId: pending.reader_id,
            firstObservedAt: pending.first_observed_at,
            lastObservedAt: pending.last_observed_at,
            observations: pending.observations,
            reason: pending.reason
          } : null,
          facilityId,
          zoneId,
          readerId,
          observedAt: event.observedAt,
          trustedSession: Boolean(session)
        });

        if (decision.action === "pending") {
          const candidate = decision.candidate;
          upsertPendingMovement.run(
            tenantId,
            event.epc,
            candidate.fromFacilityId,
            candidate.fromZoneId,
            candidate.toFacilityId,
            candidate.toZoneId,
            candidate.readerId,
            candidate.firstObservedAt,
            candidate.lastObservedAt,
            candidate.observations,
            candidate.reason
          );
          incrementPositionReads.run(tenantId, event.epc);
          continue;
        }

        deletePendingMovement.run(tenantId, event.epc);
        if (decision.action === "ignore") {
          incrementPositionReads.run(tenantId, event.epc);
          continue;
        }
        if (decision.action === "confirm") {
          insertMovement.run(
            tenantId,
            event.epc,
            previous?.facility_id ?? null,
            previous?.zone_id ?? null,
            facilityId,
            zoneId,
            readerId,
            event.observedAt
          );
          this.enqueueIntegrationEvent({
            tenantId,
            eventType: previous
              ? "inventory.movement_confirmed"
              : "inventory.position_initialized",
            aggregateId: event.epc,
            payload: {
              epc: event.epc,
              fromFacilityId: previous?.facility_id ?? null,
              fromZoneId: previous?.zone_id ?? null,
              toFacilityId: facilityId,
              toZoneId: zoneId,
              readerId,
              observedAt: event.observedAt
            }
          });
        }
        upsertPosition.run(
          tenantId,
          event.epc,
          facilityId,
          zoneId,
          readerId,
          sessionId,
          previous?.first_seen_at ?? event.observedAt,
          event.observedAt,
          event.rssi ?? null,
          event.antenna ?? null
        );
      }
      return { accepted, duplicates, unknownAssets };
    });
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

    const normalizedBefore = new Date(cutoff).toISOString();
    return this.#transaction(() => {
      const stats = this.#database.prepare(`
        SELECT COUNT(*) AS total_read_events,
               MIN(received_at) AS oldest_received_at,
               MAX(received_at) AS newest_received_at
        FROM read_events
        WHERE tenant_id = ?
      `).get(tenantId);
      const eligible = this.#database.prepare(`
        SELECT COUNT(*) AS eligible
        FROM read_events
        WHERE tenant_id = ? AND received_at < ?
      `).get(tenantId, normalizedBefore);
      let deleted = 0;
      if (!dryRun) {
        const result = this.#database.prepare(`
          DELETE FROM read_events
          WHERE rowid IN (
            SELECT rowid
            FROM read_events
            WHERE tenant_id = ? AND received_at < ?
            ORDER BY received_at, event_id
            LIMIT ?
          )
        `).run(tenantId, normalizedBefore, limit);
        deleted = Number(result.changes);
      }
      return {
        before: normalizedBefore,
        totalReadEvents: Number(stats.total_read_events),
        eligible: Number(eligible.eligible),
        deleted,
        dryRun,
        batchLimit: limit,
        oldestReceivedAt: stats.oldest_received_at,
        newestReceivedAt: stats.newest_received_at
      };
    });
  }

  inventoryFor(tenantId) {
    return this.#database.prepare(`
      SELECT
        i.*,
        a.sku,
        COALESCE(a.status, 'unregistered') AS asset_status
      FROM inventory_positions i
      LEFT JOIN rfid_assets a
        ON a.tenant_id = i.tenant_id AND a.epc = i.epc
      WHERE i.tenant_id = ?
      ORDER BY i.epc
    `).all(tenantId).map(toInventory);
  }

  custodyHistoryFor(tenantId, { epc, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let sql = `
      SELECT * FROM asset_custody_history
      WHERE tenant_id = ?
    `;
    const parameters = [tenantId];
    if (epc) {
      sql += " AND epc = ?";
      parameters.push(String(epc).toUpperCase());
    }
    sql += " ORDER BY valid_from DESC, rowid DESC LIMIT ?";
    parameters.push(safeLimit);
    return this.#database.prepare(sql).all(...parameters).map((row) => ({
      custodyId: row.custody_id,
      epc: row.epc,
      tenantId: row.tenant_id,
      facilityId: row.facility_id,
      shipmentId: row.shipment_id,
      changeType: row.change_type,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      recordedAt: row.recorded_at
    }));
  }

  updateAssetStatus(tenantId, epc, {
    status,
    reason,
    actorId,
    changedAt = new Date().toISOString()
  }) {
    if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
    const normalizedEpc = String(epc).toUpperCase();
    return this.#transaction(() => {
      const asset = this.#database.prepare(`
        SELECT * FROM rfid_assets WHERE tenant_id = ? AND epc = ?
      `).get(tenantId, normalizedEpc);
      if (!asset) throw new Error("Unknown asset");
      const transition = validateAssetTransition(asset.status, status);
      if (!transition.changed) {
        return {
          changed: false,
          asset: {
            tenantId,
            epc: normalizedEpc,
            sku: asset.sku,
            tid: asset.tid,
            status: asset.status,
            encodedAt: asset.encoded_at
          },
          history: null
        };
      }
      const history = {
        historyId: randomUUID(),
        tenantId,
        epc: normalizedEpc,
        fromStatus: asset.status,
        toStatus: status,
        reason: reason.trim(),
        actorId,
        changedAt
      };
      this.#database.prepare(`
        UPDATE rfid_assets SET status = ? WHERE tenant_id = ? AND epc = ?
      `).run(status, tenantId, normalizedEpc);
      this.#database.prepare(`
        INSERT INTO asset_lifecycle_history (
          history_id, tenant_id, epc, from_status, to_status,
          reason, actor_id, changed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        history.historyId,
        tenantId,
        normalizedEpc,
        history.fromStatus,
        status,
        history.reason,
        actorId,
        changedAt
      );
      this.enqueueIntegrationEvent({
        tenantId,
        eventType: "asset.status_changed",
        aggregateId: normalizedEpc,
        payload: history
      });
      return {
        changed: true,
        asset: {
          tenantId,
          epc: normalizedEpc,
          sku: asset.sku,
          tid: asset.tid,
          status,
          encodedAt: asset.encoded_at
        },
        history
      };
    });
  }

  assetLifecycleFor(tenantId, epc, { limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.prepare(`
      SELECT * FROM asset_lifecycle_history
      WHERE tenant_id = ? AND epc = ?
      ORDER BY changed_at DESC, rowid DESC
      LIMIT ?
    `).all(tenantId, String(epc).toUpperCase(), safeLimit).map((row) => ({
      historyId: row.history_id,
      tenantId: row.tenant_id,
      epc: row.epc,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      actorId: row.actor_id,
      changedAt: row.changed_at
    }));
  }

  movementsFor(tenantId) {
    return this.#database.prepare(`
      SELECT * FROM movement_events
      WHERE tenant_id = ? ORDER BY observed_at, id
    `).all(tenantId).map((row) => ({
      tenantId: row.tenant_id,
      epc: row.epc,
      fromFacilityId: row.from_facility_id,
      fromZoneId: row.from_zone_id,
      toFacilityId: row.to_facility_id,
      toZoneId: row.to_zone_id,
      readerId: row.reader_id,
      observedAt: row.observed_at
    }));
  }

  pendingMovementsFor(tenantId) {
    return this.#database.prepare(`
      SELECT * FROM pending_movements
      WHERE tenant_id = ? ORDER BY first_observed_at
    `).all(tenantId).map((row) => ({
      tenantId: row.tenant_id,
      epc: row.epc,
      fromFacilityId: row.from_facility_id,
      fromZoneId: row.from_zone_id,
      toFacilityId: row.to_facility_id,
      toZoneId: row.to_zone_id,
      readerId: row.reader_id,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      observations: row.observations,
      reason: row.reason
    }));
  }

  resolvePendingMovement(tenantId, epc, { action, actorId }) {
    if (!["confirm", "dismiss"].includes(action)) {
      throw new Error("action must be confirm or dismiss");
    }
    const normalizedEpc = String(epc).toUpperCase();
    return this.#transaction(() => {
      const candidate = this.#database.prepare(`
        SELECT * FROM pending_movements WHERE tenant_id = ? AND epc = ?
      `).get(tenantId, normalizedEpc);
      if (!candidate) throw new Error("Unknown pending movement");
      this.#database.prepare(`
        DELETE FROM pending_movements WHERE tenant_id = ? AND epc = ?
      `).run(tenantId, normalizedEpc);
      if (action === "dismiss") {
        return { action, epc: normalizedEpc, actorId, movement: null };
      }
      const previous = this.#database.prepare(`
        SELECT * FROM inventory_positions WHERE tenant_id = ? AND epc = ?
      `).get(tenantId, normalizedEpc);
      if (!previous) throw new Error("Inventory position is missing");
      this.#database.prepare(`
        INSERT INTO movement_events (
          tenant_id, epc, from_facility_id, from_zone_id,
          to_facility_id, to_zone_id, reader_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId,
        normalizedEpc,
        previous.facility_id,
        previous.zone_id,
        candidate.to_facility_id,
        candidate.to_zone_id,
        candidate.reader_id,
        candidate.last_observed_at
      );
      this.#database.prepare(`
        UPDATE inventory_positions
        SET facility_id = ?, zone_id = ?, reader_id = ?, last_seen_at = ?
        WHERE tenant_id = ? AND epc = ?
      `).run(
        candidate.to_facility_id,
        candidate.to_zone_id,
        candidate.reader_id,
        candidate.last_observed_at,
        tenantId,
        normalizedEpc
      );
      const movement = {
        tenantId,
        epc: normalizedEpc,
        fromFacilityId: previous.facility_id,
        fromZoneId: previous.zone_id,
        toFacilityId: candidate.to_facility_id,
        toZoneId: candidate.to_zone_id,
        readerId: candidate.reader_id,
        observedAt: candidate.last_observed_at,
        confidence: 1,
        resolution: "operator_confirmed",
        resolvedBy: actorId
      };
      this.enqueueIntegrationEvent({
        tenantId,
        eventType: "inventory.movement_confirmed",
        aggregateId: normalizedEpc,
        payload: {
          ...movement,
          resolution: movement.resolution,
          resolvedBy: actorId
        }
      });
      return { action, epc: normalizedEpc, actorId, movement };
    });
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
    this.#database.prepare(`
      INSERT INTO gateway_health (
        tenant_id, reader_id, adapter, gateway_version, reader_connected,
        queue_depth, last_read_at, last_error, heartbeat_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, reader_id) DO UPDATE SET
        adapter = excluded.adapter,
        gateway_version = excluded.gateway_version,
        reader_connected = excluded.reader_connected,
        queue_depth = excluded.queue_depth,
        last_read_at = excluded.last_read_at,
        last_error = excluded.last_error,
        heartbeat_at = excluded.heartbeat_at,
        received_at = excluded.received_at
      WHERE excluded.heartbeat_at > gateway_health.heartbeat_at
    `).run(
      tenantId,
      readerId,
      adapter,
      gatewayVersion,
      readerConnected ? 1 : 0,
      queueDepth,
      lastReadAt,
      lastError,
      heartbeatAt,
      receivedAt
    );
    return this.gatewayHealthFor(tenantId, { now: Date.parse(receivedAt) })
      .find((health) => health.readerId === readerId);
  }

  gatewayHealthFor(tenantId, { now = Date.now() } = {}) {
    return this.#database.prepare(`
      SELECT * FROM gateway_health
      WHERE tenant_id = ? ORDER BY reader_id
    `).all(tenantId).map((row) => {
      const health = {
        tenantId: row.tenant_id,
        readerId: row.reader_id,
        adapter: row.adapter,
        gatewayVersion: row.gateway_version,
        readerConnected: Boolean(row.reader_connected),
        queueDepth: row.queue_depth,
        lastReadAt: row.last_read_at,
        lastError: row.last_error,
        heartbeatAt: row.heartbeat_at,
        receivedAt: row.received_at
      };
      return { ...health, status: gatewayStatus(health, now) };
    });
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
    this.#database.prepare(`
      INSERT INTO audit_events (
        audit_id, tenant_id, actor_id, actor_role, action,
        entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId,
      tenantId,
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      JSON.stringify(details),
      createdAt
    );
    return {
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
  }

  auditFor(tenantId, { limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.prepare(`
      SELECT * FROM audit_events
      WHERE tenant_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(tenantId, safeLimit).map((row) => ({
      auditId: row.audit_id,
      tenantId: row.tenant_id,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: JSON.parse(row.details_json),
      createdAt: row.created_at
    }));
  }

  enqueueIntegrationEvent({
    tenantId,
    eventType,
    aggregateId = null,
    payload,
    eventId = randomUUID(),
    createdAt = new Date().toISOString()
  }) {
    this.#database.prepare(`
      INSERT INTO integration_outbox (
        event_id, tenant_id, event_type, aggregate_id, payload_json,
        status, attempts, next_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      eventId,
      tenantId,
      eventType,
      aggregateId,
      JSON.stringify(payload),
      createdAt,
      createdAt
    );
    return this.integrationOutboxFor(tenantId, { limit: 500 })
      .find((event) => event.eventId === eventId);
  }

  pendingIntegrationEvents(tenantId, { now = Date.now(), limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.prepare(`
      SELECT * FROM integration_outbox
      WHERE tenant_id = ?
        AND status = 'pending'
        AND next_attempt_at <= ?
      ORDER BY created_at, rowid
      LIMIT ?
    `).all(tenantId, new Date(now).toISOString(), safeLimit)
      .map((row) => this.#toIntegrationEvent(row));
  }

  integrationOutboxFor(tenantId, { status, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let sql = `
      SELECT * FROM integration_outbox
      WHERE tenant_id = ?
    `;
    const parameters = [tenantId];
    if (status) {
      sql += " AND status = ?";
      parameters.push(status);
    }
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?";
    parameters.push(safeLimit);
    return this.#database.prepare(sql).all(...parameters)
      .map((row) => this.#toIntegrationEvent(row));
  }

  markIntegrationDelivered(tenantId, eventId, deliveredAt = new Date().toISOString()) {
    const result = this.#database.prepare(`
      UPDATE integration_outbox
      SET status = 'delivered', delivered_at = ?, last_error = NULL
      WHERE tenant_id = ? AND event_id = ?
    `).run(deliveredAt, tenantId, eventId);
    if (Number(result.changes) !== 1) throw new Error("Unknown integration event");
    return this.integrationOutboxFor(tenantId, { status: "delivered", limit: 500 })
      .find((event) => event.eventId === eventId);
  }

  markIntegrationFailed(
    tenantId,
    eventId,
    error,
    { now = Date.now(), maxAttempts = 5 } = {}
  ) {
    const current = this.#database.prepare(`
      SELECT attempts FROM integration_outbox
      WHERE tenant_id = ? AND event_id = ?
    `).get(tenantId, eventId);
    if (!current) throw new Error("Unknown integration event");
    const attempts = Number(current.attempts) + 1;
    const status = attempts >= maxAttempts ? "dead_letter" : "pending";
    const delay = Math.min(60_000 * (2 ** Math.max(attempts - 1, 0)), 3_600_000);
    this.#database.prepare(`
      UPDATE integration_outbox
      SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
      WHERE tenant_id = ? AND event_id = ?
    `).run(
      status,
      attempts,
      new Date(now + delay).toISOString(),
      String(error?.message ?? error).slice(0, 1000),
      tenantId,
      eventId
    );
    return this.integrationOutboxFor(tenantId, { status, limit: 500 })
      .find((event) => event.eventId === eventId);
  }

  retryIntegrationEvent(tenantId, eventId, now = new Date().toISOString()) {
    const result = this.#database.prepare(`
      UPDATE integration_outbox
      SET status = 'pending', attempts = 0, next_attempt_at = ?,
          last_error = NULL, delivered_at = NULL
      WHERE tenant_id = ? AND event_id = ?
    `).run(now, tenantId, eventId);
    if (Number(result.changes) !== 1) throw new Error("Unknown integration event");
    return this.integrationOutboxFor(tenantId, { status: "pending", limit: 500 })
      .find((event) => event.eventId === eventId);
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
    const caseId = randomUUID();
    this.#database.prepare(`
      INSERT INTO exception_cases (
        case_id, tenant_id, dedupe_key, exception_type, severity, status,
        epc, shipment_id, session_id, details_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        details_json = excluded.details_json
    `).run(
      caseId,
      tenantId,
      dedupeKey,
      exceptionType,
      severity,
      epc,
      shipmentId,
      sessionId,
      JSON.stringify(details),
      now,
      now
    );
    const row = this.#database.prepare(`
      SELECT * FROM exception_cases
      WHERE tenant_id = ? AND dedupe_key = ?
    `).get(tenantId, dedupeKey);
    return this.#toException(row);
  }

  exceptionsFor(tenantId, { status, exceptionType, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let sql = "SELECT * FROM exception_cases WHERE tenant_id = ?";
    const parameters = [tenantId];
    if (status) {
      sql += " AND status = ?";
      parameters.push(status);
    }
    if (exceptionType) {
      sql += " AND exception_type = ?";
      parameters.push(exceptionType);
    }
    sql += " ORDER BY last_seen_at DESC, rowid DESC LIMIT ?";
    parameters.push(safeLimit);
    return this.#database.prepare(sql).all(...parameters)
      .map((row) => this.#toException(row));
  }

  resolveException(
    tenantId,
    caseId,
    { resolution, actorId, now = new Date().toISOString() }
  ) {
    const allowed = new Set(["corrected", "accepted_exception", "quarantined", "dismissed"]);
    if (!allowed.has(resolution)) throw new Error("Unsupported exception resolution");
    const existing = this.#database.prepare(`
      SELECT * FROM exception_cases WHERE tenant_id = ? AND case_id = ?
    `).get(tenantId, caseId);
    if (!existing) throw new Error("Unknown exception case");
    if (existing.status === "resolved") return this.#toException(existing);
    this.#database.prepare(`
      UPDATE exception_cases
      SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ?
      WHERE tenant_id = ? AND case_id = ?
    `).run(resolution, actorId, now, tenantId, caseId);
    this.enqueueIntegrationEvent({
      tenantId,
      eventType: "exception.resolved",
      aggregateId: caseId,
      payload: {
        caseId,
        exceptionType: existing.exception_type,
        epc: existing.epc,
        shipmentId: existing.shipment_id,
        resolution,
        resolvedBy: actorId,
        resolvedAt: now
      }
    });
    return this.#toException(this.#database.prepare(`
      SELECT * FROM exception_cases WHERE tenant_id = ? AND case_id = ?
    `).get(tenantId, caseId));
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
    const alertId = randomUUID();
    this.#database.prepare(`
      INSERT INTO operational_alerts (
        alert_id, tenant_id, dedupe_key, alert_type, severity, status,
        entity_type, entity_id, title, message, details_json,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
        alert_type = excluded.alert_type,
        severity = excluded.severity,
        entity_type = excluded.entity_type,
        entity_id = excluded.entity_id,
        title = excluded.title,
        message = excluded.message,
        details_json = excluded.details_json,
        last_seen_at = excluded.last_seen_at,
        status = CASE
          WHEN operational_alerts.status = 'resolved' THEN 'open'
          ELSE operational_alerts.status
        END,
        first_seen_at = CASE
          WHEN operational_alerts.status = 'resolved' THEN excluded.first_seen_at
          ELSE operational_alerts.first_seen_at
        END,
        acknowledged_by = CASE
          WHEN operational_alerts.status = 'resolved' THEN NULL
          ELSE operational_alerts.acknowledged_by
        END,
        acknowledged_at = CASE
          WHEN operational_alerts.status = 'resolved' THEN NULL
          ELSE operational_alerts.acknowledged_at
        END,
        resolved_at = CASE
          WHEN operational_alerts.status = 'resolved' THEN NULL
          ELSE operational_alerts.resolved_at
        END
    `).run(
      alertId,
      tenantId,
      dedupeKey,
      alertType,
      severity,
      entityType,
      entityId,
      title,
      message,
      JSON.stringify(details),
      now,
      now
    );
    const row = this.#database.prepare(`
      SELECT * FROM operational_alerts
      WHERE tenant_id = ? AND dedupe_key = ?
    `).get(tenantId, dedupeKey);
    return this.#toAlert(row);
  }

  resolveAlertByKey(tenantId, dedupeKey, now = new Date().toISOString()) {
    const result = this.#database.prepare(`
      UPDATE operational_alerts
      SET status = 'resolved', resolved_at = ?
      WHERE tenant_id = ? AND dedupe_key = ? AND status != 'resolved'
    `).run(now, tenantId, dedupeKey);
    if (Number(result.changes) === 0) return null;
    const row = this.#database.prepare(`
      SELECT * FROM operational_alerts
      WHERE tenant_id = ? AND dedupe_key = ?
    `).get(tenantId, dedupeKey);
    return this.#toAlert(row);
  }

  acknowledgeAlert(tenantId, alertId, actorId, now = new Date().toISOString()) {
    const result = this.#database.prepare(`
      UPDATE operational_alerts
      SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?
      WHERE tenant_id = ? AND alert_id = ? AND status != 'resolved'
    `).run(actorId, now, tenantId, alertId);
    if (Number(result.changes) !== 1) throw new Error("Unknown or resolved alert");
    const row = this.#database.prepare(`
      SELECT * FROM operational_alerts
      WHERE tenant_id = ? AND alert_id = ?
    `).get(tenantId, alertId);
    return this.#toAlert(row);
  }

  alertsFor(tenantId, { status, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let sql = "SELECT * FROM operational_alerts WHERE tenant_id = ?";
    const parameters = [tenantId];
    if (status) {
      sql += " AND status = ?";
      parameters.push(status);
    }
    sql += " ORDER BY last_seen_at DESC, rowid DESC LIMIT ?";
    parameters.push(safeLimit);
    return this.#database.prepare(sql).all(...parameters)
      .map((row) => this.#toAlert(row));
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

  #toAlert(row) {
    return {
      alertId: row.alert_id,
      tenantId: row.tenant_id,
      dedupeKey: row.dedupe_key,
      alertType: row.alert_type,
      severity: row.severity,
      status: row.status,
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
      message: row.message,
      details: JSON.parse(row.details_json),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      acknowledgedBy: row.acknowledged_by,
      acknowledgedAt: row.acknowledged_at,
      resolvedAt: row.resolved_at
    };
  }

  #toException(row) {
    return {
      caseId: row.case_id,
      tenantId: row.tenant_id,
      dedupeKey: row.dedupe_key,
      exceptionType: row.exception_type,
      severity: row.severity,
      status: row.status,
      epc: row.epc,
      shipmentId: row.shipment_id,
      sessionId: row.session_id,
      details: JSON.parse(row.details_json),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      resolution: row.resolution,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at
    };
  }

  #toIntegrationEvent(row) {
    return {
      eventId: row.event_id,
      tenantId: row.tenant_id,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      payload: JSON.parse(row.payload_json),
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at
    };
  }

  summaryFor(tenantId, { facilityId, zoneId, sessionId } = {}) {
    let rows;
    if (sessionId) {
      rows = this.#database.prepare(`
        SELECT se.epc, a.sku, COALESCE(a.status, 'unregistered') AS asset_status
        FROM session_epcs se
        LEFT JOIN rfid_assets a
          ON a.tenant_id = se.tenant_id AND a.epc = se.epc
        WHERE se.tenant_id = ? AND se.session_id = ?
      `).all(tenantId, sessionId);
    } else {
      let sql = `
        SELECT i.epc, a.sku, COALESCE(a.status, 'unregistered') AS asset_status
        FROM inventory_positions i
        LEFT JOIN rfid_assets a
          ON a.tenant_id = i.tenant_id AND a.epc = i.epc
        WHERE i.tenant_id = ?
      `;
      const parameters = [tenantId];
      if (facilityId) {
        sql += " AND i.facility_id = ?";
        parameters.push(facilityId);
      }
      if (zoneId) {
        sql += " AND i.zone_id = ?";
        parameters.push(zoneId);
      }
      rows = this.#database.prepare(sql).all(...parameters);
    }

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
    for (const row of rows) {
      statusCounts[row.asset_status] = (statusCounts[row.asset_status] ?? 0) + 1;
      if (!row.sku) {
        unknownUnits += 1;
      } else {
        counts.set(row.sku, (counts.get(row.sku) ?? 0) + 1);
      }
    }
    const productStatement = this.#database.prepare(`
      SELECT * FROM products WHERE tenant_id = ? AND sku = ?
    `);
    const lines = [...counts.entries()].map(([sku, units]) => {
      const product = toProduct(productStatement.get(tenantId, sku));
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
      filters: {
        facilityId: facilityId ?? null,
        zoneId: zoneId ?? null,
        sessionId: sessionId ?? null
      },
      uniqueUnits: rows.length,
      registeredUnits: rows.length - unknownUnits,
      unknownUnits,
      availableUnits: statusCounts.active,
      statusCounts,
      lines
    };
  }

  #shipmentForTenant(tenantId, shipmentId) {
    const row = this.#database.prepare(`
      SELECT
        s.*,
        COUNT(sa.epc) AS asset_count,
        SUM(CASE WHEN sa.accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted_asset_count
      FROM shipments s
      LEFT JOIN shipment_assets sa ON sa.shipment_id = s.shipment_id
      WHERE s.shipment_id = ?
        AND (s.supplier_tenant_id = ? OR s.customer_tenant_id = ?)
      GROUP BY s.shipment_id
    `).get(shipmentId, tenantId, tenantId);
    if (!row) throw new Error("Unknown shipment");
    return this.#toShipment(row);
  }

  #toShipment(row) {
    return {
      shipmentId: row.shipment_id,
      supplierTenantId: row.supplier_tenant_id,
      customerTenantId: row.customer_tenant_id,
      destinationFacilityId: row.destination_facility_id,
      reference: row.reference,
      status: row.status,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      assetCount: Number(row.asset_count),
      acceptedAssetCount: Number(row.accepted_asset_count)
    };
  }
}
