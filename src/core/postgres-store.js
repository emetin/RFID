import { randomUUID } from "node:crypto";
import { calculatePackaging } from "./packaging.js";
import { gatewayStatus } from "./gateway-health.js";
import { movementDecision } from "./movement-policy.js";
import { PostgresDatabase } from "./postgres-database.js";
import { ASSET_STATUSES, validateAssetTransition } from "./asset-lifecycle.js";
import { commissioningEvent } from "../standards/epcis.js";

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

export class PostgresStore {
  #database;
  #tenants = new Map();

  constructor(database = new PostgresDatabase()) {
    this.#database = database;
  }

  async close() {
    await this.#database.close();
  }

  async readinessCheck() {
    const health = await this.#database.healthCheck();
    return { status: "ready", store: "postgres", latencyMs: health.latencyMs };
  }

  async createAdminUser({
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
    return this.#database.systemTransaction(async (client) => {
      const normalized = String(username).trim().toLowerCase();
      await client.query(`
        INSERT INTO admin_users (
          id, username, display_name, password_hash, role,
          default_tenant_slug, active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      `, [
        userId, normalized, displayName?.trim() || normalized, passwordHash,
        role, defaultTenantId, active, createdAt
      ]);
      for (const tenantId of new Set(tenantIds)) {
        await client.query(`
          INSERT INTO admin_user_tenants (user_id, tenant_slug) VALUES ($1,$2)
        `, [userId, tenantId]);
      }
      return this.#adminUserById(client, userId, false);
    });
  }

  async adminUserByUsername(username) {
    return this.#database.systemTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM admin_users WHERE username = $1",
        [String(username).trim().toLowerCase()]
      );
      return rows[0] ? this.#adminUser(client, rows[0], true) : null;
    });
  }

  async adminUserById(userId) {
    return this.#database.systemTransaction((client) =>
      this.#adminUserById(client, userId, true)
    );
  }

  async adminUsers() {
    return this.#database.systemTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM admin_users ORDER BY username");
      return Promise.all(rows.map((row) => this.#adminUser(client, row, false)));
    });
  }

  async updateAdminUser(userId, changes) {
    return this.#database.systemTransaction(async (client) => {
      const current = await this.#adminUserById(client, userId, true);
      if (!current) throw new Error("Unknown admin user");
      await client.query(`
        UPDATE admin_users
        SET display_name = $1, password_hash = $2, role = $3,
            default_tenant_slug = $4, active = $5, updated_at = now()
        WHERE id = $6
      `, [
        changes.displayName ?? current.displayName,
        changes.passwordHash ?? current.passwordHash,
        changes.role ?? current.role,
        changes.defaultTenantId ?? current.defaultTenantId,
        changes.active ?? current.active,
        userId
      ]);
      if (changes.tenantIds) {
        await client.query("DELETE FROM admin_user_tenants WHERE user_id = $1", [userId]);
        for (const tenantId of new Set(changes.tenantIds)) {
          await client.query(`
            INSERT INTO admin_user_tenants (user_id, tenant_slug) VALUES ($1,$2)
          `, [userId, tenantId]);
        }
      }
      return this.#adminUserById(client, userId, false);
    });
  }

  async #adminUserById(client, userId, includeHash) {
    const { rows } = await client.query("SELECT * FROM admin_users WHERE id = $1", [userId]);
    return rows[0] ? this.#adminUser(client, rows[0], includeHash) : null;
  }

  async #adminUser(client, row, includeHash) {
    const assignments = await client.query(`
      SELECT tenant_slug FROM admin_user_tenants
      WHERE user_id = $1 ORDER BY tenant_slug
    `, [row.id]);
    const value = {
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      tenantIds: assignments.rows.map((item) => item.tenant_slug),
      defaultTenantId: row.default_tenant_slug,
      active: row.active,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
    if (includeHash) value.passwordHash = row.password_hash;
    return value;
  }

  async #tenant(slug) {
    if (this.#tenants.has(slug)) return this.#tenants.get(slug);
    const id = await this.#database.systemTransaction(async (client) => {
      const result = await client.query(`
        INSERT INTO tenants (slug, name)
        VALUES ($1, $1)
        ON CONFLICT (slug) DO UPDATE SET name = tenants.name
        RETURNING id
      `, [slug]);
      return result.rows[0].id;
    });
    this.#tenants.set(slug, id);
    return id;
  }

  async upsertFacility(tenantId, facility) {
    const allowed = new Set(["factory", "warehouse", "hotel", "laundry"]);
    if (!facility.facilityId || !facility.name) throw new Error("facilityId and name are required");
    if (!allowed.has(facility.facilityType)) throw new Error("Unsupported facilityType");
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const result = await client.query(`
        INSERT INTO facilities (tenant_id, code, name, facility_type, timezone, active)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, code) DO UPDATE SET
          name = EXCLUDED.name,
          facility_type = EXCLUDED.facility_type,
          timezone = EXCLUDED.timezone,
          active = EXCLUDED.active
        RETURNING code, name, facility_type, timezone, active
      `, [
        tenant,
        facility.facilityId,
        facility.name,
        facility.facilityType,
        facility.timezone ?? "UTC",
        facility.active !== false
      ]);
      const row = result.rows[0];
      return {
        tenantId,
        facilityId: row.code,
        name: row.name,
        facilityType: row.facility_type,
        timezone: row.timezone,
        active: row.active
      };
    });
  }

  async facilitiesFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT code, name, facility_type, timezone, active
        FROM facilities ORDER BY code
      `);
      return rows.map((row) => ({
        tenantId,
        facilityId: row.code,
        name: row.name,
        facilityType: row.facility_type,
        timezone: row.timezone,
        active: row.active
      }));
    });
  }

  async upsertZone(tenantId, zone) {
    if (!zone.zoneId || !zone.facilityId || !zone.name || !zone.zoneType) {
      throw new Error("zoneId, facilityId, name and zoneType are required");
    }
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const facility = await client.query(
        "SELECT id FROM facilities WHERE code = $1",
        [zone.facilityId]
      );
      if (facility.rowCount !== 1) throw new Error("Unknown facility");
      const { rows } = await client.query(`
        INSERT INTO zones (tenant_id, facility_id, code, name, zone_type, active)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (facility_id, code) DO UPDATE SET
          name = EXCLUDED.name,
          zone_type = EXCLUDED.zone_type,
          active = EXCLUDED.active
        RETURNING code, name, zone_type, active
      `, [
        tenant,
        facility.rows[0].id,
        zone.zoneId,
        zone.name,
        zone.zoneType,
        zone.active !== false
      ]);
      return {
        tenantId,
        zoneId: rows[0].code,
        facilityId: zone.facilityId,
        name: rows[0].name,
        zoneType: rows[0].zone_type,
        active: rows[0].active
      };
    });
  }

  async zonesFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT z.code, z.name, z.zone_type, z.active, f.code AS facility_code
        FROM zones z
        JOIN facilities f ON f.id = z.facility_id
        ORDER BY z.code
      `);
      return rows.map((row) => ({
        tenantId,
        zoneId: row.code,
        facilityId: row.facility_code,
        name: row.name,
        zoneType: row.zone_type,
        active: row.active
      }));
    });
  }

  async upsertReader(tenantId, reader) {
    if (!reader.readerId || !reader.facilityId || !reader.zoneId || !reader.name || !reader.adapter) {
      throw new Error("readerId, facilityId, zoneId, name and adapter are required");
    }
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const location = await client.query(`
        SELECT f.id AS facility_id, z.id AS zone_id
        FROM facilities f
        JOIN zones z ON z.facility_id = f.id
        WHERE f.code = $1 AND z.code = $2
      `, [reader.facilityId, reader.zoneId]);
      if (location.rowCount !== 1) throw new Error("Reader zone does not belong to facility");
      const { rows } = await client.query(`
        INSERT INTO readers (
          tenant_id, facility_id, zone_id, code, name, adapter, protocol, active
        ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
        ON CONFLICT (tenant_id, code) DO UPDATE SET
          facility_id = EXCLUDED.facility_id,
          zone_id = EXCLUDED.zone_id,
          name = EXCLUDED.name,
          adapter = EXCLUDED.adapter,
          protocol = EXCLUDED.protocol,
          active = EXCLUDED.active
        RETURNING code, name, adapter, active
      `, [
        tenant,
        location.rows[0].facility_id,
        location.rows[0].zone_id,
        reader.readerId,
        reader.name,
        reader.adapter,
        reader.active !== false
      ]);
      return {
        tenantId,
        readerId: rows[0].code,
        facilityId: reader.facilityId,
        zoneId: reader.zoneId,
        name: rows[0].name,
        adapter: rows[0].adapter,
        active: rows[0].active
      };
    });
  }

  async readersFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT r.code, r.name, r.adapter, r.active,
               f.code AS facility_code, z.code AS zone_code
        FROM readers r
        JOIN facilities f ON f.id = r.facility_id
        JOIN zones z ON z.id = r.zone_id
        ORDER BY r.code
      `);
      return rows.map((row) => ({
        tenantId,
        readerId: row.code,
        facilityId: row.facility_code,
        zoneId: row.zone_code,
        name: row.name,
        adapter: row.adapter,
        active: row.active
      }));
    });
  }

  async validateReaderContext({
    tenantId,
    readerId,
    facilityId,
    zoneId,
    required = false
  }) {
    const readers = await this.readersFor(tenantId);
    const reader = readers.find((item) => item.readerId === readerId);
    if (!reader) {
      return required
        ? { valid: false, reason: "reader_not_provisioned" }
        : { valid: true, reason: "legacy_unprovisioned_reader" };
    }
    if (!reader.active) return { valid: false, reason: "reader_or_location_inactive" };
    if (facilityId != null && reader.facilityId !== facilityId) {
      return { valid: false, reason: "reader_facility_mismatch" };
    }
    if (zoneId != null && reader.zoneId !== zoneId) {
      return { valid: false, reason: "reader_zone_mismatch" };
    }
    return { valid: true, reason: null };
  }

  async validateLocation({ tenantId, facilityId, zoneId, required = false }) {
    const zones = await this.zonesFor(tenantId);
    const zone = zones.find((item) => item.zoneId === zoneId);
    if (!zone) {
      return required
        ? { valid: false, reason: "location_not_provisioned" }
        : { valid: true, reason: "legacy_unprovisioned_location" };
    }
    if (!zone.active) return { valid: false, reason: "location_inactive" };
    if (zone.facilityId !== facilityId) {
      return { valid: false, reason: "zone_facility_mismatch" };
    }
    return { valid: true, reason: null };
  }

  async upsertProducts(tenantId, products) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      for (const product of products) {
        if (!product.sku || !product.name) throw new Error("Product sku and name are required");
        if (!Number.isInteger(product.unitsPerBox) || product.unitsPerBox < 1) {
          throw new Error(`Invalid unitsPerBox for ${product.sku}`);
        }
        if (!Number.isInteger(product.boxesPerPallet) || product.boxesPerPallet < 1) {
          throw new Error(`Invalid boxesPerPallet for ${product.sku}`);
        }
        await client.query(`
          INSERT INTO products (
            tenant_id, sku, name, category, units_per_box,
            boxes_per_pallet, size, color, active
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (tenant_id, sku) DO UPDATE SET
            name = EXCLUDED.name, category = EXCLUDED.category,
            units_per_box = EXCLUDED.units_per_box,
            boxes_per_pallet = EXCLUDED.boxes_per_pallet,
            size = EXCLUDED.size, color = EXCLUDED.color,
            active = EXCLUDED.active, updated_at = now()
        `, [
          tenant, product.sku, product.name, product.category ?? "",
          product.unitsPerBox, product.boxesPerPallet,
          product.size ?? "", product.color ?? "", product.active !== false
        ]);
      }
      return { imported: products.length };
    });
  }

  async createEncodingBatch(tenantId, {
    sku, requestedQuantity, epcScheme = "GTX96",
    batchId = randomUUID(), createdAt = new Date().toISOString()
  }) {
    const quantity = Number(requestedQuantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) {
      throw new Error("requestedQuantity must be an integer between 1 and 100000");
    }
    if (epcScheme !== "GTX96") throw new Error("Unsupported EPC scheme");
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const product = await client.query(`
        SELECT id FROM products WHERE tenant_id = $1 AND sku = $2 AND active = true
      `, [tenant, sku]);
      if (!product.rows[0]) throw new Error("Unknown or inactive SKU");
      await client.query(`
        INSERT INTO encoding_batches (
          id, tenant_id, product_id, requested_quantity, epc_scheme, status, created_at
        ) VALUES ($1,$2,$3,$4,$5,'planned',$6)
      `, [batchId, tenant, product.rows[0].id, quantity, epcScheme, createdAt]);
      await client.query(`
        INSERT INTO encoding_jobs (
          batch_id, tenant_id, sequence_number, epc, status, updated_at
        )
        SELECT $1, $2, sequence_number,
          '475458' || upper(lpad(to_hex(nextval('globaltex_epc_serial_seq')), 18, '0')),
          'queued', $4
        FROM generate_series(1, $3) AS sequence_number
      `, [batchId, tenant, quantity, createdAt]);
      return this.#encodingBatch(client, tenantId, batchId);
    });
  }

  async encodingBatchesFor(tenantId, { limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT id FROM encoding_batches ORDER BY created_at DESC LIMIT $1
      `, [Math.min(Math.max(Number(limit) || 100, 1), 500)]);
      return Promise.all(rows.map((row) => this.#encodingBatch(client, tenantId, row.id)));
    });
  }

  async encodingBatchFor(tenantId, batchId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, (client) =>
      this.#encodingBatch(client, tenantId, batchId)
    );
  }

  async claimEncodingJob(tenantId, {
    stationId, leaseSeconds = 60, now = new Date().toISOString()
  }) {
    if (!stationId) throw new Error("stationId is required");
    const seconds = Math.min(Math.max(Number(leaseSeconds) || 60, 15), 600);
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      await client.query(`
        UPDATE encoding_jobs SET status = 'queued', station_id = NULL,
          lease_token = NULL, lease_until = NULL, updated_at = $2
        WHERE tenant_id = $1 AND status = 'leased' AND lease_until <= $2
      `, [tenant, now]);
      const { rows } = await client.query(`
        WITH candidate AS (
          SELECT id FROM encoding_jobs
          WHERE tenant_id = $1 AND status = 'queued'
          ORDER BY batch_id, sequence_number
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE encoding_jobs job SET
          status = 'leased', station_id = $2, lease_token = gen_random_uuid(),
          lease_until = $3::timestamptz + ($4 * interval '1 second'),
          attempts = attempts + 1, updated_at = $3
        FROM candidate WHERE job.id = candidate.id
        RETURNING job.*
      `, [tenant, stationId, now, seconds]);
      if (!rows[0]) return null;
      const row = rows[0];
      await client.query(`
        UPDATE encoding_batches SET status = 'encoding', started_at = COALESCE(started_at, $2)
        WHERE id = $1 AND status = 'planned'
      `, [row.batch_id, now]);
      return {
        jobId: row.id, batchId: row.batch_id, sequenceNumber: row.sequence_number,
        epc: row.epc, stationId, leaseToken: row.lease_token,
        leaseUntil: iso(row.lease_until), attempts: row.attempts
      };
    });
  }

  async finishEncodingJob(tenantId, {
    jobId, stationId, leaseToken, observedEpc = null, tid = null,
    previousEpc = null, errorCode = null, errorMessage = null,
    now = new Date().toISOString()
  }) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT job.*, batch.requested_quantity, batch.product_id
        FROM encoding_jobs job JOIN encoding_batches batch ON batch.id = job.batch_id
        WHERE job.tenant_id = $1 AND job.id = $2 FOR UPDATE
      `, [tenant, jobId]);
      const job = rows[0];
      if (!job) throw new Error("Unknown encoding job");
      if (job.status !== "leased" || job.station_id !== stationId || String(job.lease_token) !== leaseToken) {
        throw new Error("Encoding job lease is not owned by this station");
      }
      if (Date.parse(job.lease_until) <= Date.parse(now)) throw new Error("Encoding job lease expired");
      const verified = !errorCode && observedEpc === job.epc;
      const finalErrorCode = verified ? null : (errorCode || "readback_mismatch");
      const finalErrorMessage = verified ? null : (errorMessage || "Observed EPC does not match allocation");
      await client.query(`
        UPDATE encoding_jobs SET status = $2, previous_epc = $3, tid = $4,
          error_code = $5, error_message = $6, written_at = $7,
          verified_at = $8, lease_token = NULL, lease_until = NULL, updated_at = $7
        WHERE id = $1
      `, [jobId, verified ? "verified" : "failed", previousEpc, tid,
        finalErrorCode, finalErrorMessage, now, verified ? now : null]);
      if (verified) {
        await client.query(`
          INSERT INTO rfid_assets (
            tenant_id, epc, product_id, encoding_batch_id, tid,
            status, encoding_status, encoded_at, verified_at
          ) VALUES ($1,$2,$3,$4,$5,'active','verified',$6,$6)
          ON CONFLICT (tenant_id, epc) DO NOTHING
        `, [tenant, job.epc, job.product_id, job.batch_id, tid, now]);
      } else {
        await client.query(`
          INSERT INTO encoding_jobs (
            batch_id, tenant_id, sequence_number, epc, status, updated_at
          ) SELECT $1, $2, COALESCE(MAX(sequence_number), 0) + 1,
            '475458' || upper(lpad(to_hex(nextval('globaltex_epc_serial_seq')), 18, '0')),
            'queued', $3 FROM encoding_jobs WHERE batch_id = $1
        `, [job.batch_id, tenant, now]);
      }
      const count = await client.query(`
        SELECT COUNT(*)::integer AS count FROM encoding_jobs
        WHERE batch_id = $1 AND status = 'verified'
      `, [job.batch_id]);
      if (count.rows[0].count >= job.requested_quantity) {
        await client.query(`
          UPDATE encoding_batches SET status = 'completed', completed_at = $2 WHERE id = $1
        `, [job.batch_id, now]);
      }
      return {
        verified,
        job: await this.#encodingJob(client, jobId),
        batch: await this.#encodingBatch(client, tenantId, job.batch_id)
      };
    });
  }

  async productsFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query("SELECT * FROM products ORDER BY sku");
      return rows.map((row) => ({
        tenantId,
        sku: row.sku,
        name: row.name,
        category: row.category ?? "",
        unitsPerBox: row.units_per_box,
        boxesPerPallet: row.boxes_per_pallet,
        size: row.size ?? "",
        color: row.color ?? "",
        active: row.active
      }));
    });
  }

  async registerAssets(tenantId, assets) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.systemTransaction(async (client) => {
      let registered = 0;
      let unchanged = 0;
      for (const item of assets) {
        const epc = String(item.epc ?? "").toUpperCase();
        if (!/^[0-9A-F]{8,96}$/.test(epc)) throw new Error(`Invalid EPC: ${epc}`);
        const status = item.status ?? "active";
        if (!ASSET_STATUSES.has(status)) throw new Error(`Invalid asset status: ${status}`);
        const product = await client.query(
          "SELECT id FROM products WHERE tenant_id = $1 AND sku = $2",
          [tenant, item.sku]
        );
        if (product.rowCount !== 1) throw new Error(`Unknown SKU: ${item.sku}`);
        const existing = await client.query(`
          SELECT a.tenant_id, p.sku
          FROM rfid_assets a JOIN products p ON p.id = a.product_id
          WHERE a.epc = $1
        `, [epc]);
        if (existing.rowCount) {
          if (existing.rows[0].tenant_id !== tenant) {
            throw new Error(`EPC ${epc} is already assigned to another tenant`);
          }
          if (existing.rows[0].sku !== item.sku) {
            throw new Error(`EPC ${epc} is already registered to SKU ${existing.rows[0].sku}`);
          }
          unchanged += 1;
          continue;
        }
        await client.query(`
          INSERT INTO rfid_assets (
            tenant_id, epc, product_id, tid, status, encoded_at
          ) VALUES ($1,$2,$3,$4,$5,$6)
        `, [
          tenant, epc, product.rows[0].id, item.tid ?? null,
          status, item.encodedAt ?? null
        ]);
        await client.query(`
          INSERT INTO asset_lifecycle_history (
            tenant_id, epc, from_status, to_status, reason, actor_id, changed_at
          ) VALUES ($1,$2,NULL,$3,'registration','asset_registration',$4)
        `, [tenant, epc, status, item.encodedAt ?? new Date().toISOString()]);
        await client.query(`
          INSERT INTO asset_custody_history (
            epc, custodian_tenant_id, change_type, valid_from
          ) VALUES ($1,$2,'registered',$3)
        `, [epc, tenant, item.encodedAt ?? new Date().toISOString()]);
        registered += 1;
      }
      return { registered, unchanged };
    });
  }

  async createReceivingBatch({
    tenantId,
    sku,
    expectedQuantity,
    facilityId,
    zoneId,
    reference = null,
    batchId = randomUUID(),
    createdAt = new Date().toISOString()
  }) {
    if (!Number.isInteger(expectedQuantity) || expectedQuantity < 1) {
      throw new Error("Expected quantity must be a positive integer");
    }
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const context = await client.query(`
        SELECT p.id AS product_id, f.id AS facility_id, z.id AS zone_id
        FROM products p, facilities f, zones z
        WHERE p.tenant_id = $1 AND p.sku = $2
          AND f.tenant_id = $1 AND f.code = $3
          AND z.tenant_id = $1 AND z.code = $4 AND z.facility_id = f.id
      `, [tenant, sku, facilityId, zoneId]);
      if (context.rowCount !== 1) throw new Error("Unknown product or receiving location");
      await client.query(`
        INSERT INTO receiving_batches (
          id, tenant_id, product_id, expected_quantity, facility_id,
          zone_id, reference, status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
      `, [
        batchId,
        tenant,
        context.rows[0].product_id,
        expectedQuantity,
        context.rows[0].facility_id,
        context.rows[0].zone_id,
        reference,
        createdAt
      ]);
      return this.#receivingBatch(client, tenantId, tenant, batchId);
    });
  }

  async receivingBatchesFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT id FROM receiving_batches ORDER BY created_at DESC
      `);
      const batches = [];
      for (const row of rows) batches.push(await this.#receivingBatch(client, tenantId, tenant, row.id));
      return batches;
    });
  }

  async receivingBatchFor(tenantId, batchId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(
      tenant,
      (client) => this.#receivingBatch(client, tenantId, tenant, batchId)
    );
  }

  async addReceivingBatchReads({
    tenantId,
    batchId,
    epcs,
    observedAt = new Date().toISOString()
  }) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const batch = await client.query(`
        SELECT status FROM receiving_batches WHERE id = $1 FOR UPDATE
      `, [batchId]);
      if (batch.rowCount !== 1) throw new Error("Unknown receiving batch");
      if (batch.rows[0].status !== "draft") throw new Error("Receiving batch is not open");
      for (const value of epcs) {
        const epc = String(value ?? "").toUpperCase();
        if (!/^[0-9A-F]{8,96}$/.test(epc)) throw new Error(`Invalid EPC: ${epc}`);
        await client.query(`
          INSERT INTO receiving_batch_tags (
            batch_id, tenant_id, epc, first_seen_at, last_seen_at, read_count
          ) VALUES ($1,$2,$3,$4,$4,1)
          ON CONFLICT (batch_id, epc) DO UPDATE SET
            last_seen_at = EXCLUDED.last_seen_at,
            read_count = receiving_batch_tags.read_count + 1
        `, [batchId, tenant, epc, observedAt]);
      }
      return this.#receivingBatch(client, tenantId, tenant, batchId);
    });
  }

  async removeReceivingBatchTag({ tenantId, batchId, epc }) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const batch = await client.query(`
        SELECT status FROM receiving_batches WHERE id = $1 FOR UPDATE
      `, [batchId]);
      if (batch.rowCount !== 1) throw new Error("Unknown receiving batch");
      if (batch.rows[0].status !== "draft") throw new Error("Receiving batch is not open");
      await client.query(`
        DELETE FROM receiving_batch_tags WHERE batch_id = $1 AND epc = $2
      `, [batchId, String(epc).toUpperCase()]);
      return this.#receivingBatch(client, tenantId, tenant, batchId);
    });
  }

  async approveReceivingBatch({ tenantId, batchId, actorId, approvedAt = new Date().toISOString() }) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const locked = await client.query(`
        SELECT status FROM receiving_batches WHERE id = $1 FOR UPDATE
      `, [batchId]);
      if (locked.rowCount !== 1) throw new Error("Unknown receiving batch");
      const detail = await this.#receivingBatch(client, tenantId, tenant, batchId);
      if (detail.status !== "draft") throw new Error("Receiving batch is not open");
      if (!detail.canApprove) {
        throw new Error("Expected quantity, scanned tags and EPC conflicts must reconcile before approval");
      }
      const context = await client.query(`
        SELECT p.id AS product_id, f.id AS facility_id, z.id AS zone_id, r.id AS reader_id
        FROM products p
        JOIN receiving_batches b ON b.product_id = p.id
        JOIN facilities f ON f.id = b.facility_id
        JOIN zones z ON z.id = b.zone_id
        LEFT JOIN LATERAL (
          SELECT id FROM readers
          WHERE tenant_id = $2 AND facility_id = f.id AND zone_id = z.id
          ORDER BY last_seen_at DESC NULLS LAST LIMIT 1
        ) r ON true
        WHERE b.id = $1
      `, [batchId, tenant]);
      if (!context.rows[0]?.reader_id) {
        throw new Error("No reader is assigned to the receiving location");
      }
      for (const tag of detail.tags) {
        await client.query(`
          INSERT INTO rfid_assets (
            tenant_id, epc, product_id, status, encoding_status, encoded_at
          ) VALUES ($1,$2,$3,'active','registered',$4)
        `, [tenant, tag.epc, context.rows[0].product_id, approvedAt]);
        await client.query(`
          INSERT INTO asset_lifecycle_history (
            tenant_id, epc, from_status, to_status, reason, actor_id, changed_at
          ) VALUES ($1,$2,NULL,'active','receiving_batch_approval',$3,$4)
        `, [tenant, tag.epc, actorId, approvedAt]);
        await client.query(`
          INSERT INTO asset_custody_history (
            epc, custodian_tenant_id, facility_id, change_type, valid_from
          ) VALUES ($1,$2,$3,'registered',$4)
        `, [tag.epc, tenant, context.rows[0].facility_id, approvedAt]);
        await client.query(`
          INSERT INTO inventory_positions (
            tenant_id, epc, facility_id, zone_id, reader_id,
            first_seen_at, last_seen_at, read_count
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          tenant,
          tag.epc,
          context.rows[0].facility_id,
          context.rows[0].zone_id,
          context.rows[0].reader_id,
          tag.firstSeenAt,
          tag.lastSeenAt,
          tag.readCount
        ]);
      }
      await client.query(`
        UPDATE receiving_batches
        SET status = 'approved', approved_at = $2, approved_by = $3
        WHERE id = $1
      `, [batchId, approvedAt, actorId]);
      await client.query(`
        INSERT INTO audit_events (
          tenant_id, actor_id, actor_role, action,
          entity_type, entity_id, details_json, created_at
        ) VALUES ($1,$2,'chain_admin','receiving_batch.approved',
                  'receiving_batch',$3,$4,$5)
      `, [
        tenant,
        actorId,
        batchId,
        JSON.stringify({
          sku: detail.sku,
          quantity: detail.scannedQuantity,
          epcis: commissioningEvent({
            epcs: detail.tags.map((tag) => tag.epc),
            eventTime: approvedAt,
            businessLocation: context.rows[0].facility_id
          })
        }),
        approvedAt
      ]);
      return this.#receivingBatch(client, tenantId, tenant, batchId);
    });
  }

  async startSession({
    tenantId,
    facilityId,
    zoneId,
    type = "inventory",
    reference = null,
    sessionId = randomUUID()
  }) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const location = await client.query(`
        SELECT f.id AS facility_id, z.id AS zone_id
        FROM facilities f JOIN zones z ON z.facility_id = f.id
        WHERE f.code = $1 AND z.code = $2
      `, [facilityId, zoneId]);
      if (location.rowCount !== 1) throw new Error("Unknown session location");
      const { rows } = await client.query(`
        INSERT INTO scan_sessions (
          id, tenant_id, facility_id, zone_id, session_type, reference
        ) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING started_at
      `, [
        sessionId, tenant, location.rows[0].facility_id,
        location.rows[0].zone_id, type, reference
      ]);
      return {
        sessionId,
        tenantId,
        facilityId,
        zoneId,
        type,
        reference,
        status: "open",
        startedAt: iso(rows[0].started_at),
        completedAt: null,
        uniqueEpcs: 0
      };
    });
  }

  async completeSession(tenantId, sessionId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const result = await client.query(`
        UPDATE scan_sessions SET status = 'completed', completed_at = now()
        WHERE id = $1 AND status = 'open'
      `, [sessionId]);
      if (result.rowCount !== 1) throw new Error("Unknown or closed scan session");
      return (await this.#sessions(client, tenantId, sessionId))[0];
    });
  }

  async sessionsFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(
      tenant,
      (client) => this.#sessions(client, tenantId)
    );
  }

  async #sessions(client, tenantId, sessionId) {
    const parameters = [];
    let filter = "";
    if (sessionId) {
      parameters.push(sessionId);
      filter = "WHERE s.id = $1";
    }
    const { rows } = await client.query(`
      SELECT s.*, f.code AS facility_code, z.code AS zone_code,
             COUNT(se.epc)::int AS unique_epcs
      FROM scan_sessions s
      JOIN facilities f ON f.id = s.facility_id
      JOIN zones z ON z.id = s.zone_id
      LEFT JOIN session_epcs se ON se.session_id = s.id
      ${filter}
      GROUP BY s.id, f.code, z.code
      ORDER BY s.started_at DESC
    `, parameters);
    return rows.map((row) => ({
      sessionId: row.id,
      tenantId,
      facilityId: row.facility_code,
      zoneId: row.zone_code,
      type: row.session_type,
      reference: row.reference,
      status: row.status,
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      uniqueEpcs: row.unique_epcs
    }));
  }

  async ingest({
    tenantId,
    readerId,
    facilityId,
    zoneId,
    sessionId = null,
    events,
    receivedAt = new Date().toISOString()
  }) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const context = await client.query(`
        SELECT r.id AS reader_id, f.id AS facility_id, z.id AS zone_id
        FROM readers r
        JOIN facilities f ON f.id = r.facility_id
        JOIN zones z ON z.id = r.zone_id
        WHERE r.code = $1 AND f.code = $2 AND z.code = $3
      `, [readerId, facilityId, zoneId]);
      if (context.rowCount !== 1) throw new Error("Reader context is not provisioned");
      if (sessionId) {
        const session = await client.query(
          "SELECT status FROM scan_sessions WHERE id = $1",
          [sessionId]
        );
        if (session.rows[0]?.status !== "open") throw new Error("Scan session is not open");
      }
      const ids = context.rows[0];
      let accepted = 0;
      let duplicates = 0;
      let unknownAssets = 0;

      for (const event of events) {
        const inserted = await client.query(`
          INSERT INTO read_events (
            tenant_id, event_id, epc, reader_id, facility_id, zone_id,
            session_id, observed_at, rssi, antenna, received_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (tenant_id, event_id) DO NOTHING
          RETURNING event_id
        `, [
          tenant, event.eventId, event.epc, ids.reader_id, ids.facility_id,
          ids.zone_id, sessionId, event.observedAt,
          event.rssi ?? null, event.antenna ?? null, receivedAt
        ]);
        if (inserted.rowCount === 0) {
          duplicates += 1;
          continue;
        }
        accepted += 1;
        if (sessionId) {
          await client.query(`
            INSERT INTO session_epcs (tenant_id, session_id, epc)
            VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
          `, [tenant, sessionId, event.epc]);
        }
        const asset = await client.query(
          "SELECT 1 FROM rfid_assets WHERE epc = $1",
          [event.epc]
        );
        if (asset.rowCount === 0) {
          unknownAssets += 1;
          await this.#upsertException(client, {
            tenant,
            tenantId,
            dedupeKey: `unknown-asset:${event.epc}`,
            exceptionType: "unknown_asset",
            severity: "warning",
            epc: event.epc,
            details: { readerId, facilityId, zoneId, observedAt: event.observedAt }
          });
        }

        const previousResult = await client.query(`
          SELECT i.*, f.code AS facility_code, z.code AS zone_code
          FROM inventory_positions i
          JOIN facilities f ON f.id = i.facility_id
          JOIN zones z ON z.id = i.zone_id
          WHERE i.epc = $1
        `, [event.epc]);
        const previousRow = previousResult.rows[0];
        const previous = previousRow ? {
          facilityId: previousRow.facility_code,
          zoneId: previousRow.zone_code,
          firstSeenAt: iso(previousRow.first_seen_at),
          lastSeenAt: iso(previousRow.last_seen_at),
          readCount: Number(previousRow.read_count)
        } : null;
        const pendingResult = await client.query(`
          SELECT p.*, ff.code AS from_facility_code, fz.code AS from_zone_code,
                 tf.code AS to_facility_code, tz.code AS to_zone_code
          FROM pending_movements p
          JOIN facilities ff ON ff.id = p.from_facility_id
          JOIN zones fz ON fz.id = p.from_zone_id
          JOIN facilities tf ON tf.id = p.to_facility_id
          JOIN zones tz ON tz.id = p.to_zone_id
          WHERE p.epc = $1
        `, [event.epc]);
        const pendingRow = pendingResult.rows[0];
        const candidate = pendingRow ? {
          fromFacilityId: pendingRow.from_facility_code,
          fromZoneId: pendingRow.from_zone_code,
          toFacilityId: pendingRow.to_facility_code,
          toZoneId: pendingRow.to_zone_code,
          readerId,
          firstObservedAt: iso(pendingRow.first_observed_at),
          lastObservedAt: iso(pendingRow.last_observed_at),
          observations: pendingRow.observations,
          reason: pendingRow.reason
        } : null;
        const decision = movementDecision({
          previous,
          candidate,
          facilityId,
          zoneId,
          readerId,
          observedAt: event.observedAt,
          trustedSession: Boolean(sessionId)
        });

        if (decision.action === "pending") {
          const fromLocation = await client.query(`
            SELECT f.id AS facility_id, z.id AS zone_id
            FROM facilities f JOIN zones z ON z.facility_id = f.id
            WHERE f.code = $1 AND z.code = $2
          `, [
            decision.candidate.fromFacilityId,
            decision.candidate.fromZoneId
          ]);
          await client.query(`
            INSERT INTO pending_movements (
              tenant_id, epc, from_facility_id, from_zone_id,
              to_facility_id, to_zone_id, reader_id,
              first_observed_at, last_observed_at, observations, reason
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (tenant_id, epc) DO UPDATE SET
              from_facility_id = EXCLUDED.from_facility_id,
              from_zone_id = EXCLUDED.from_zone_id,
              to_facility_id = EXCLUDED.to_facility_id,
              to_zone_id = EXCLUDED.to_zone_id,
              reader_id = EXCLUDED.reader_id,
              first_observed_at = EXCLUDED.first_observed_at,
              last_observed_at = EXCLUDED.last_observed_at,
              observations = EXCLUDED.observations,
              reason = EXCLUDED.reason
          `, [
            tenant, event.epc,
            fromLocation.rows[0].facility_id, fromLocation.rows[0].zone_id,
            ids.facility_id, ids.zone_id, ids.reader_id,
            decision.candidate.firstObservedAt,
            decision.candidate.lastObservedAt,
            decision.candidate.observations,
            decision.candidate.reason
          ]);
          await client.query(`
            UPDATE inventory_positions
            SET read_count = read_count + 1
            WHERE epc = $1
          `, [event.epc]);
          continue;
        }

        await client.query("DELETE FROM pending_movements WHERE epc = $1", [event.epc]);
        if (decision.action === "ignore") {
          await client.query(`
            UPDATE inventory_positions
            SET read_count = read_count + 1
            WHERE epc = $1
          `, [event.epc]);
          continue;
        }
        if (decision.action === "confirm") {
          await client.query(`
            INSERT INTO movement_events (
              tenant_id, epc, from_facility_id, from_zone_id,
              to_facility_id, to_zone_id, reader_id, confidence, observed_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [
            tenant, event.epc,
            previousRow?.facility_id ?? null, previousRow?.zone_id ?? null,
            ids.facility_id, ids.zone_id, ids.reader_id,
            sessionId ? 1 : 0.8, event.observedAt
          ]);
          await this.#insertOutbox(client, {
            tenant,
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
        await client.query(`
          INSERT INTO inventory_positions (
            tenant_id, epc, facility_id, zone_id, reader_id, session_id,
            first_seen_at, last_seen_at, read_count, last_rssi, last_antenna
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)
          ON CONFLICT (tenant_id, epc) DO UPDATE SET
            facility_id = EXCLUDED.facility_id,
            zone_id = EXCLUDED.zone_id,
            reader_id = EXCLUDED.reader_id,
            session_id = EXCLUDED.session_id,
            last_seen_at = EXCLUDED.last_seen_at,
            read_count = inventory_positions.read_count + 1,
            last_rssi = EXCLUDED.last_rssi,
            last_antenna = EXCLUDED.last_antenna
        `, [
          tenant, event.epc, ids.facility_id, ids.zone_id, ids.reader_id,
          sessionId, previous?.firstSeenAt ?? event.observedAt, event.observedAt,
          event.rssi ?? null, event.antenna ?? null
        ]);
      }
      return { accepted, duplicates, unknownAssets };
    });
  }

  async readEventRetention(tenantId, {
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
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const stats = await client.query(`
        SELECT COUNT(*)::int AS total_read_events,
               MIN(received_at) AS oldest_received_at,
               MAX(received_at) AS newest_received_at
        FROM read_events
      `);
      const eligible = await client.query(`
        SELECT COUNT(*)::int AS eligible
        FROM read_events
        WHERE received_at < $1
      `, [normalizedBefore]);
      let deleted = 0;
      if (!dryRun) {
        const result = await client.query(`
          WITH victims AS (
            SELECT event_id
            FROM read_events
            WHERE received_at < $1
            ORDER BY received_at, event_id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM read_events AS reads
          USING victims
          WHERE reads.tenant_id = $3
            AND reads.event_id = victims.event_id
          RETURNING reads.event_id
        `, [normalizedBefore, limit, tenant]);
        deleted = result.rowCount;
      }
      const row = stats.rows[0];
      return {
        before: normalizedBefore,
        totalReadEvents: Number(row.total_read_events),
        eligible: Number(eligible.rows[0].eligible),
        deleted,
        dryRun,
        batchLimit: limit,
        oldestReceivedAt: iso(row.oldest_received_at),
        newestReceivedAt: iso(row.newest_received_at)
      };
    });
  }

  async inventoryFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT i.*, f.code AS facility_code, z.code AS zone_code,
               r.code AS reader_code, p.sku,
               COALESCE(a.status, 'unregistered') AS asset_status
        FROM inventory_positions i
        JOIN facilities f ON f.id = i.facility_id
        JOIN zones z ON z.id = i.zone_id
        JOIN readers r ON r.id = i.reader_id
        LEFT JOIN rfid_assets a ON a.epc = i.epc
        LEFT JOIN products p ON p.id = a.product_id
        ORDER BY i.epc
      `);
      return rows.map((row) => ({
        tenantId,
        epc: row.epc,
        sku: row.sku ?? null,
        assetStatus: row.asset_status,
        facilityId: row.facility_code,
        zoneId: row.zone_code,
        readerId: row.reader_code,
        sessionId: row.session_id,
        firstSeenAt: iso(row.first_seen_at),
        lastSeenAt: iso(row.last_seen_at),
        readCount: Number(row.read_count),
        lastRssi: row.last_rssi,
        lastAntenna: row.last_antenna
      }));
    });
  }

  async movementsFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT m.*, ff.code AS from_facility_code, fz.code AS from_zone_code,
               tf.code AS to_facility_code, tz.code AS to_zone_code,
               r.code AS reader_code
        FROM movement_events m
        LEFT JOIN facilities ff ON ff.id = m.from_facility_id
        LEFT JOIN zones fz ON fz.id = m.from_zone_id
        JOIN facilities tf ON tf.id = m.to_facility_id
        JOIN zones tz ON tz.id = m.to_zone_id
        JOIN readers r ON r.id = m.reader_id
        ORDER BY m.observed_at, m.id
      `);
      return rows.map((row) => ({
        tenantId,
        epc: row.epc,
        fromFacilityId: row.from_facility_code,
        fromZoneId: row.from_zone_code,
        toFacilityId: row.to_facility_code,
        toZoneId: row.to_zone_code,
        readerId: row.reader_code,
        observedAt: iso(row.observed_at)
      }));
    });
  }

  async pendingMovementsFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT p.*, ff.code AS from_facility_code, fz.code AS from_zone_code,
               tf.code AS to_facility_code, tz.code AS to_zone_code,
               r.code AS reader_code
        FROM pending_movements p
        JOIN facilities ff ON ff.id = p.from_facility_id
        JOIN zones fz ON fz.id = p.from_zone_id
        JOIN facilities tf ON tf.id = p.to_facility_id
        JOIN zones tz ON tz.id = p.to_zone_id
        JOIN readers r ON r.id = p.reader_id
        ORDER BY p.first_observed_at
      `);
      return rows.map((row) => ({
        tenantId,
        epc: row.epc,
        fromFacilityId: row.from_facility_code,
        fromZoneId: row.from_zone_code,
        toFacilityId: row.to_facility_code,
        toZoneId: row.to_zone_code,
        readerId: row.reader_code,
        firstObservedAt: iso(row.first_observed_at),
        lastObservedAt: iso(row.last_observed_at),
        observations: row.observations,
        reason: row.reason
      }));
    });
  }

  async resolvePendingMovement(tenantId, epc, { action, actorId }) {
    if (!["confirm", "dismiss"].includes(action)) {
      throw new Error("action must be confirm or dismiss");
    }
    const tenant = await this.#tenant(tenantId);
    const normalizedEpc = String(epc).toUpperCase();
    return this.#database.tenantTransaction(tenant, async (client) => {
      const candidateResult = await client.query(`
        SELECT p.*, tf.code AS to_facility_code, tz.code AS to_zone_code,
               r.code AS reader_code
        FROM pending_movements p
        JOIN facilities tf ON tf.id = p.to_facility_id
        JOIN zones tz ON tz.id = p.to_zone_id
        JOIN readers r ON r.id = p.reader_id
        WHERE p.epc = $1
      `, [normalizedEpc]);
      const candidate = candidateResult.rows[0];
      if (!candidate) throw new Error("Unknown pending movement");
      await client.query("DELETE FROM pending_movements WHERE epc = $1", [normalizedEpc]);
      if (action === "dismiss") {
        return { action, epc: normalizedEpc, actorId, movement: null };
      }
      const previousResult = await client.query(`
        SELECT i.*, f.code AS facility_code, z.code AS zone_code
        FROM inventory_positions i
        JOIN facilities f ON f.id = i.facility_id
        JOIN zones z ON z.id = i.zone_id
        WHERE i.epc = $1
      `, [normalizedEpc]);
      const previous = previousResult.rows[0];
      if (!previous) throw new Error("Inventory position is missing");
      await client.query(`
        INSERT INTO movement_events (
          tenant_id, epc, from_facility_id, from_zone_id,
          to_facility_id, to_zone_id, reader_id, confidence, observed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)
      `, [
        tenant,
        normalizedEpc,
        previous.facility_id,
        previous.zone_id,
        candidate.to_facility_id,
        candidate.to_zone_id,
        candidate.reader_id,
        candidate.last_observed_at
      ]);
      await client.query(`
        UPDATE inventory_positions
        SET facility_id = $1, zone_id = $2, reader_id = $3, last_seen_at = $4
        WHERE epc = $5
      `, [
        candidate.to_facility_id,
        candidate.to_zone_id,
        candidate.reader_id,
        candidate.last_observed_at,
        normalizedEpc
      ]);
      const movement = {
        tenantId,
        epc: normalizedEpc,
        fromFacilityId: previous.facility_code,
        fromZoneId: previous.zone_code,
        toFacilityId: candidate.to_facility_code,
        toZoneId: candidate.to_zone_code,
        readerId: candidate.reader_code,
        observedAt: iso(candidate.last_observed_at),
        confidence: 1,
        resolution: "operator_confirmed",
        resolvedBy: actorId
      };
      await this.#insertOutbox(client, {
        tenant,
        eventType: "inventory.movement_confirmed",
        aggregateId: normalizedEpc,
        payload: movement
      });
      return { action, epc: normalizedEpc, actorId, movement };
    });
  }

  async summaryFor(tenantId, { facilityId, zoneId, sessionId } = {}) {
    let items;
    if (sessionId) {
      const tenant = await this.#tenant(tenantId);
      items = await this.#database.tenantTransaction(tenant, async (client) => {
        const { rows } = await client.query(`
          SELECT se.epc, p.sku,
                 COALESCE(a.status, 'unregistered') AS asset_status
          FROM session_epcs se
          LEFT JOIN rfid_assets a ON a.epc = se.epc
          LEFT JOIN products p ON p.id = a.product_id
          WHERE se.session_id = $1
        `, [sessionId]);
        return rows;
      });
    } else {
      items = (await this.inventoryFor(tenantId)).filter((item) =>
        (!facilityId || item.facilityId === facilityId) &&
        (!zoneId || item.zoneId === zoneId)
      );
    }
    const products = new Map(
      (await this.productsFor(tenantId)).map((product) => [product.sku, product])
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
    for (const item of items) {
      const status = item.assetStatus ?? item.asset_status ?? "unregistered";
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      if (!item.sku) unknownUnits += 1;
      else counts.set(item.sku, (counts.get(item.sku) ?? 0) + 1);
    }
    const lines = [...counts.entries()].map(([sku, units]) => {
      const product = products.get(sku);
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
      uniqueUnits: items.length,
      registeredUnits: items.length - unknownUnits,
      unknownUnits,
      availableUnits: statusCounts.active,
      statusCounts,
      lines
    };
  }

  async recordGatewayHealth({
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
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const reader = await client.query("SELECT id FROM readers WHERE code = $1", [readerId]);
      if (reader.rowCount !== 1) throw new Error("Unknown reader");
      await client.query(`
        INSERT INTO gateway_health (
          tenant_id, reader_id, adapter, gateway_version, reader_connected,
          queue_depth, last_read_at, last_error, heartbeat_at, received_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tenant_id, reader_id) DO UPDATE SET
          adapter = EXCLUDED.adapter,
          gateway_version = EXCLUDED.gateway_version,
          reader_connected = EXCLUDED.reader_connected,
          queue_depth = EXCLUDED.queue_depth,
          last_read_at = EXCLUDED.last_read_at,
          last_error = EXCLUDED.last_error,
          heartbeat_at = EXCLUDED.heartbeat_at,
          received_at = EXCLUDED.received_at
        WHERE EXCLUDED.heartbeat_at > gateway_health.heartbeat_at
      `, [
        tenant, reader.rows[0].id, adapter, gatewayVersion, readerConnected,
        queueDepth, lastReadAt, lastError, heartbeatAt, receivedAt
      ]);
      return (await this.#gatewayHealth(client, tenantId, Date.parse(receivedAt)))
        .find((item) => item.readerId === readerId);
    });
  }

  async gatewayHealthFor(tenantId, { now = Date.now() } = {}) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(
      tenant,
      (client) => this.#gatewayHealth(client, tenantId, now)
    );
  }

  async #gatewayHealth(client, tenantId, now) {
    const { rows } = await client.query(`
      SELECT h.*, r.code AS reader_code
      FROM gateway_health h
      JOIN readers r ON r.id = h.reader_id
      ORDER BY r.code
    `);
    return rows.map((row) => {
      const health = {
        tenantId,
        readerId: row.reader_code,
        adapter: row.adapter,
        gatewayVersion: row.gateway_version,
        readerConnected: row.reader_connected,
        queueDepth: row.queue_depth,
        lastReadAt: iso(row.last_read_at),
        lastError: row.last_error,
        heartbeatAt: iso(row.heartbeat_at),
        receivedAt: iso(row.received_at)
      };
      return { ...health, status: gatewayStatus(health, now) };
    });
  }

  async consumeCustomerApiRateLimit(clientId, windowStart, limit) {
    return this.#database.systemTransaction(async (client) => {
      const { rows } = await client.query(`
        INSERT INTO customer_api_rate_limits (client_id, window_start, request_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (client_id, window_start)
        DO UPDATE SET request_count = customer_api_rate_limits.request_count + 1
        RETURNING request_count
      `, [clientId, windowStart]);
      await client.query(
        "DELETE FROM customer_api_rate_limits WHERE window_start < $1",
        [windowStart - 2]
      );
      return { allowed: rows[0].request_count <= limit, count: rows[0].request_count };
    });
  }

  async customerApiIdempotencyGet({ tenantId, clientId, method, path, idempotencyKey }) {
    return this.#database.systemTransaction(async (client) => {
      const { rows } = await client.query(`
        SELECT response FROM customer_api_idempotency
        WHERE tenant_slug = $1 AND client_id = $2 AND method = $3
          AND path = $4 AND idempotency_key = $5
      `, [tenantId, clientId, method, path, idempotencyKey]);
      return rows[0]?.response ?? null;
    });
  }

  async customerApiIdempotencyPut({
    tenantId, clientId, method, path, idempotencyKey, response, createdAt = new Date().toISOString()
  }) {
    return this.#database.systemTransaction(async (client) => {
      const { rows } = await client.query(`
        INSERT INTO customer_api_idempotency (
          tenant_slug, client_id, method, path, idempotency_key, response, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_slug, client_id, method, path, idempotency_key)
        DO UPDATE SET response = customer_api_idempotency.response
        RETURNING response
      `, [tenantId, clientId, method, path, idempotencyKey, response, createdAt]);
      return rows[0].response;
    });
  }

  async recordAudit({
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
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        INSERT INTO audit_events (
          id, tenant_id, actor_id, actor_role, action,
          entity_type, entity_id, details, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `, [
        auditId, tenant, actorId, actorRole, action,
        entityType, entityId, details, createdAt
      ]);
      return this.#auditRow(rows[0], tenantId);
    });
  }

  async auditFor(tenantId, { limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1
      `, [safeLimit]);
      return rows.map((row) => this.#auditRow(row, tenantId));
    });
  }

  #auditRow(row, tenantId) {
    return {
      auditId: row.id,
      tenantId,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      createdAt: iso(row.created_at)
    };
  }

  async enqueueIntegrationEvent({
    tenantId,
    eventType,
    aggregateId = null,
    payload,
    eventId = randomUUID(),
    createdAt = new Date().toISOString()
  }) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      await this.#insertOutbox(client, {
        tenant,
        eventType,
        aggregateId,
        payload,
        eventId,
        createdAt
      });
      const { rows } = await client.query(
        "SELECT * FROM integration_outbox WHERE id = $1",
        [eventId]
      );
      return this.#outboxRow(rows[0], tenantId);
    });
  }

  async #insertOutbox(client, {
    tenant,
    eventType,
    aggregateId,
    payload,
    eventId = randomUUID(),
    createdAt = new Date().toISOString()
  }) {
    await client.query(`
      INSERT INTO integration_outbox (
        id, tenant_id, event_type, aggregate_id, payload,
        status, attempts, next_attempt_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,'pending',0,$6,$6)
    `, [eventId, tenant, eventType, aggregateId, payload, createdAt]);
    return eventId;
  }

  async pendingIntegrationEvents(tenantId, { now = Date.now(), limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT * FROM integration_outbox
        WHERE status = 'pending' AND next_attempt_at <= $1
        ORDER BY created_at, id LIMIT $2
      `, [new Date(now).toISOString(), safeLimit]);
      return rows.map((row) => this.#outboxRow(row, tenantId));
    });
  }

  async integrationOutboxFor(tenantId, { status, limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const parameters = [];
      let filter = "";
      if (status) {
        parameters.push(status);
        filter = "WHERE status = $1";
      }
      parameters.push(safeLimit);
      const limitParameter = `$${parameters.length}`;
      const { rows } = await client.query(`
        SELECT * FROM integration_outbox ${filter}
        ORDER BY created_at DESC, id DESC LIMIT ${limitParameter}
      `, parameters);
      return rows.map((row) => this.#outboxRow(row, tenantId));
    });
  }

  async markIntegrationDelivered(tenantId, eventId, deliveredAt = new Date().toISOString()) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        UPDATE integration_outbox
        SET status = 'delivered', delivered_at = $1, last_error = NULL
        WHERE id = $2 RETURNING *
      `, [deliveredAt, eventId]);
      if (!rows[0]) throw new Error("Unknown integration event");
      return this.#outboxRow(rows[0], tenantId);
    });
  }

  async markIntegrationFailed(
    tenantId,
    eventId,
    error,
    { now = Date.now(), maxAttempts = 5 } = {}
  ) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const current = await client.query(
        "SELECT attempts FROM integration_outbox WHERE id = $1",
        [eventId]
      );
      if (!current.rows[0]) throw new Error("Unknown integration event");
      const attempts = current.rows[0].attempts + 1;
      const status = attempts >= maxAttempts ? "dead_letter" : "pending";
      const delay = Math.min(60_000 * (2 ** Math.max(attempts - 1, 0)), 3_600_000);
      const { rows } = await client.query(`
        UPDATE integration_outbox
        SET status = $1, attempts = $2, next_attempt_at = $3, last_error = $4
        WHERE id = $5 RETURNING *
      `, [
        status, attempts, new Date(now + delay).toISOString(),
        String(error?.message ?? error).slice(0, 1000), eventId
      ]);
      return this.#outboxRow(rows[0], tenantId);
    });
  }

  async retryIntegrationEvent(tenantId, eventId, now = new Date().toISOString()) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        UPDATE integration_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = $1,
            last_error = NULL, delivered_at = NULL
        WHERE id = $2 RETURNING *
      `, [now, eventId]);
      if (!rows[0]) throw new Error("Unknown integration event");
      return this.#outboxRow(rows[0], tenantId);
    });
  }

  #outboxRow(row, tenantId) {
    return {
      eventId: row.id,
      tenantId,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: iso(row.next_attempt_at),
      lastError: row.last_error,
      createdAt: iso(row.created_at),
      deliveredAt: iso(row.delivered_at)
    };
  }

  async createShipment({
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
    const supplier = await this.#tenant(tenantId);
    const customer = await this.#tenant(customerTenantId);
    await this.#database.systemTransaction(async (client) => {
      const destination = await client.query(`
        SELECT id FROM facilities WHERE tenant_id = $1 AND code = $2
      `, [customer, destinationFacilityId]);
      if (destination.rowCount !== 1) throw new Error("Unknown destination facility");
      const shipment = await client.query(`
        INSERT INTO shipments (
          external_id, supplier_tenant_id, customer_tenant_id,
          destination_facility_id, reference
        ) VALUES ($1,$2,$3,$4,$5)
        RETURNING id
      `, [
        shipmentId, supplier, customer,
        destination.rows[0].id, reference
      ]);
      for (const epc of normalized) {
        const asset = await client.query(`
          SELECT product_id FROM rfid_assets
          WHERE tenant_id = $1 AND epc = $2
        `, [supplier, epc]);
        if (asset.rowCount !== 1) {
          throw new Error(`EPC ${epc} is not owned by supplier tenant`);
        }
        await client.query(`
          INSERT INTO shipment_assets (shipment_id, epc, product_id)
          VALUES ($1,$2,$3)
        `, [shipment.rows[0].id, epc, asset.rows[0].product_id]);
      }
    });
    return (await this.shipmentsFor(tenantId))
      .find((shipment) => shipment.shipmentId === shipmentId);
  }

  async shipmentsFor(tenantId) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.systemTransaction(async (client) => {
      const { rows } = await client.query(`
        SELECT s.*, st.slug AS supplier_slug, ct.slug AS customer_slug,
               f.code AS destination_code,
               COUNT(sa.epc)::int AS asset_count,
               COUNT(sa.accepted_at)::int AS accepted_asset_count
        FROM shipments s
        JOIN tenants st ON st.id = s.supplier_tenant_id
        JOIN tenants ct ON ct.id = s.customer_tenant_id
        JOIN facilities f ON f.id = s.destination_facility_id
        LEFT JOIN shipment_assets sa ON sa.shipment_id = s.id
        WHERE s.supplier_tenant_id = $1 OR s.customer_tenant_id = $1
        GROUP BY s.id, st.slug, ct.slug, f.code
        ORDER BY s.created_at DESC
      `, [tenant]);
      return rows.map((row) => ({
        shipmentId: row.external_id,
        supplierTenantId: row.supplier_slug,
        customerTenantId: row.customer_slug,
        destinationFacilityId: row.destination_code,
        reference: row.reference,
        status: row.status,
        createdAt: iso(row.created_at),
        acceptedAt: iso(row.accepted_at),
        assetCount: row.asset_count,
        acceptedAssetCount: row.accepted_asset_count
      }));
    });
  }

  async reconcileShipment({ tenantId, shipmentId, sessionId, accept = false }) {
    const customer = await this.#tenant(tenantId);
    const preview = await this.#database.tenantTransaction(customer, async (client) => {
      const shipment = await client.query(`
        SELECT s.*, f.code AS destination_code
        FROM shipments s
        JOIN facilities f ON f.id = s.destination_facility_id
        WHERE s.external_id = $1 AND s.customer_tenant_id = $2
      `, [shipmentId, customer]);
      if (shipment.rowCount !== 1) throw new Error("Unknown shipment");
      const session = await client.query(`
        SELECT s.id, f.code AS facility_code
        FROM scan_sessions s
        JOIN facilities f ON f.id = s.facility_id
        WHERE s.id = $1
      `, [sessionId]);
      if (session.rowCount !== 1) throw new Error("Unknown scan session");
      if (session.rows[0].facility_code !== shipment.rows[0].destination_code) {
        throw new Error("Scan session is not at the shipment destination");
      }
      const manifest = await client.query(`
        SELECT epc, accepted_at FROM shipment_assets WHERE shipment_id = $1
      `, [shipment.rows[0].id]);
      const scanned = await client.query(
        "SELECT epc FROM session_epcs WHERE session_id = $1",
        [sessionId]
      );
      return {
        shipmentUuid: shipment.rows[0].id,
        supplier: shipment.rows[0].supplier_tenant_id,
        destinationFacilityId: shipment.rows[0].destination_code,
        manifest: manifest.rows,
        scanned: scanned.rows.map((row) => row.epc)
      };
    });
    const expected = new Set(preview.manifest.map((item) => item.epc));
    const scanned = new Set(preview.scanned);
    const received = [...expected].filter((epc) => scanned.has(epc));
    const missing = [...expected].filter((epc) => !scanned.has(epc));
    const unexpected = [...scanned].filter((epc) => !expected.has(epc));

    if (accept) {
      await this.#database.systemTransaction(async (client) => {
        const acceptedAt = new Date().toISOString();
        for (const epc of received) {
          const manifest = preview.manifest.find((item) => item.epc === epc);
          if (manifest.accepted_at) continue;
          const source = await client.query(`
            SELECT a.product_id, p.*
            FROM rfid_assets a
            JOIN products p ON p.id = a.product_id
            WHERE a.tenant_id = $1 AND a.epc = $2
          `, [preview.supplier, epc]);
          if (source.rowCount !== 1) {
            throw new Error(`EPC ${epc} is no longer owned by supplier tenant`);
          }
          const product = source.rows[0];
          const destinationProduct = await client.query(`
            INSERT INTO products (
              tenant_id, sku, name, category, size, color,
              units_per_box, boxes_per_pallet, active
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (tenant_id, sku) DO UPDATE SET name = products.name
            RETURNING id
          `, [
            customer, product.sku, product.name, product.category,
            product.size, product.color, product.units_per_box,
            product.boxes_per_pallet, product.active
          ]);
          await client.query(`
            UPDATE rfid_assets
            SET tenant_id = $1, product_id = $2
            WHERE tenant_id = $3 AND epc = $4
          `, [
            customer, destinationProduct.rows[0].id,
            preview.supplier, epc
          ]);
          await client.query(`
            INSERT INTO asset_lifecycle_history (
              tenant_id, epc, from_status, to_status, reason, actor_id, changed_at
            )
            SELECT tenant_id, epc, NULL, status,
                   'custody_transfer', 'shipment_acceptance', $1
            FROM rfid_assets
            WHERE tenant_id = $2 AND epc = $3
          `, [acceptedAt, customer, epc]);
          await client.query(`
            UPDATE exception_cases
            SET status = 'resolved', resolution = 'corrected',
                resolved_by = 'shipment_acceptance', resolved_at = $1
            WHERE tenant_id = $2 AND dedupe_key = $3 AND status = 'open'
          `, [acceptedAt, customer, `unknown-asset:${epc}`]);
          await client.query(`
            UPDATE shipment_assets SET accepted_at = $1
            WHERE shipment_id = $2 AND epc = $3
          `, [acceptedAt, preview.shipmentUuid, epc]);
          await client.query(`
            UPDATE asset_custody_history
            SET valid_to = $1
            WHERE epc = $2 AND custodian_tenant_id = $3 AND valid_to IS NULL
          `, [acceptedAt, epc, preview.supplier]);
          const destination = await client.query(`
            SELECT id FROM facilities
            WHERE tenant_id = $1 AND code = $2
          `, [customer, preview.destinationFacilityId]);
          await client.query(`
            INSERT INTO asset_custody_history (
              epc, custodian_tenant_id, facility_id, shipment_id,
              change_type, valid_from
            ) VALUES ($1,$2,$3,$4,'shipment_received',$5)
          `, [
            epc, customer, destination.rows[0].id,
            preview.shipmentUuid, acceptedAt
          ]);
          await this.#insertOutbox(client, {
            tenant: customer,
            eventType: "asset.custody_transferred",
            aggregateId: epc,
            payload: {
              epc,
              sku: product.sku,
              shipmentId,
              fromTenantId: preview.supplier,
              toTenantId: customer,
              destinationFacilityId: preview.destinationFacilityId,
              acceptedAt
            }
          });
        }
        const counts = await client.query(`
          SELECT COUNT(*)::int AS total, COUNT(accepted_at)::int AS accepted
          FROM shipment_assets WHERE shipment_id = $1
        `, [preview.shipmentUuid]);
        const status = counts.rows[0].accepted === counts.rows[0].total
          ? "received"
          : "partially_received";
        await client.query(`
          UPDATE shipments
          SET status = $1,
              accepted_at = CASE WHEN $1 = 'received' THEN $2::timestamptz ELSE NULL END
          WHERE id = $3
        `, [status, acceptedAt, preview.shipmentUuid]);
        for (const epc of missing) {
          await this.#upsertException(client, {
            tenant: customer,
            tenantId,
            dedupeKey: `shipment:${shipmentId}:${sessionId}:missing:${epc}`,
            exceptionType: "shipment_missing",
            severity: "warning",
            epc,
            shipmentId,
            sessionId,
            details: { destinationFacilityId: preview.destinationFacilityId },
            now: acceptedAt
          });
        }
        for (const epc of unexpected) {
          await this.#upsertException(client, {
            tenant: customer,
            tenantId,
            dedupeKey: `shipment:${shipmentId}:${sessionId}:unexpected:${epc}`,
            exceptionType: "shipment_unexpected",
            severity: "critical",
            epc,
            shipmentId,
            sessionId,
            details: { destinationFacilityId: preview.destinationFacilityId },
            now: acceptedAt
          });
        }
      });
    }
    const shipment = (await this.shipmentsFor(tenantId))
      .find((item) => item.shipmentId === shipmentId);
    return {
      shipment,
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

  async custodyHistoryFor(tenantId, { epc, limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const parameters = [];
      let filter = "";
      if (epc) {
        parameters.push(String(epc).toUpperCase());
        filter = "WHERE c.epc = $1";
      }
      parameters.push(safeLimit);
      const { rows } = await client.query(`
        SELECT c.*, f.code AS facility_code, s.external_id AS shipment_external_id
        FROM asset_custody_history c
        LEFT JOIN facilities f ON f.id = c.facility_id
        LEFT JOIN shipments s ON s.id = c.shipment_id
        ${filter}
        ORDER BY c.valid_from DESC, c.id DESC
        LIMIT $${parameters.length}
      `, parameters);
      return rows.map((row) => ({
        custodyId: row.id,
        epc: row.epc,
        tenantId,
        facilityId: row.facility_code,
        shipmentId: row.shipment_external_id,
        changeType: row.change_type,
        validFrom: iso(row.valid_from),
        validTo: iso(row.valid_to),
        recordedAt: iso(row.recorded_at)
      }));
    });
  }

  async updateAssetStatus(tenantId, epc, {
    status,
    reason,
    actorId,
    changedAt = new Date().toISOString()
  }) {
    if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
    const tenant = await this.#tenant(tenantId);
    const normalizedEpc = String(epc).toUpperCase();
    return this.#database.tenantTransaction(tenant, async (client) => {
      const existing = await client.query(`
        SELECT a.*, p.sku
        FROM rfid_assets a
        JOIN products p ON p.id = a.product_id
        WHERE a.epc = $1
        FOR UPDATE
      `, [normalizedEpc]);
      const asset = existing.rows[0];
      if (!asset) throw new Error("Unknown asset");
      const transition = validateAssetTransition(asset.status, status);
      const publicAsset = (resolvedStatus) => ({
        tenantId,
        epc: normalizedEpc,
        sku: asset.sku,
        tid: asset.tid,
        status: resolvedStatus,
        encodedAt: iso(asset.encoded_at)
      });
      if (!transition.changed) {
        return { changed: false, asset: publicAsset(asset.status), history: null };
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
      await client.query(
        "UPDATE rfid_assets SET status = $1 WHERE epc = $2",
        [status, normalizedEpc]
      );
      await client.query(`
        INSERT INTO asset_lifecycle_history (
          id, tenant_id, epc, from_status, to_status, reason, actor_id, changed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        history.historyId,
        tenant,
        normalizedEpc,
        history.fromStatus,
        status,
        history.reason,
        actorId,
        changedAt
      ]);
      await this.#insertOutbox(client, {
        tenant,
        eventType: "asset.status_changed",
        aggregateId: normalizedEpc,
        payload: history
      });
      return { changed: true, asset: publicAsset(status), history };
    });
  }

  async assetLifecycleFor(tenantId, epc, { limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        SELECT * FROM asset_lifecycle_history
        WHERE epc = $1
        ORDER BY changed_at DESC, id DESC
        LIMIT $2
      `, [String(epc).toUpperCase(), safeLimit]);
      return rows.map((row) => ({
        historyId: row.id,
        tenantId,
        epc: row.epc,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        reason: row.reason,
        actorId: row.actor_id,
        changedAt: iso(row.changed_at)
      }));
    });
  }

  async #upsertException(client, {
    tenant,
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
    const { rows } = await client.query(`
      INSERT INTO exception_cases (
        tenant_id, dedupe_key, exception_type, severity, status,
        epc, shipment_id, session_id, details, first_seen_at, last_seen_at
      ) VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$9)
      ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        details = EXCLUDED.details
      RETURNING *
    `, [
      tenant, dedupeKey, exceptionType, severity, epc,
      shipmentId, sessionId, details, now
    ]);
    return this.#exceptionRow(rows[0], tenantId);
  }

  async raiseException({
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
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, (client) =>
      this.#upsertException(client, {
        tenant,
        tenantId,
        dedupeKey,
        exceptionType,
        severity,
        epc,
        shipmentId,
        sessionId,
        details,
        now
      })
    );
  }

  async exceptionsFor(tenantId, { status, exceptionType, limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const filters = [];
      const parameters = [];
      if (status) {
        parameters.push(status);
        filters.push(`status = $${parameters.length}`);
      }
      if (exceptionType) {
        parameters.push(exceptionType);
        filters.push(`exception_type = $${parameters.length}`);
      }
      parameters.push(safeLimit);
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const { rows } = await client.query(`
        SELECT * FROM exception_cases
        ${where}
        ORDER BY last_seen_at DESC, id DESC
        LIMIT $${parameters.length}
      `, parameters);
      return rows.map((row) => this.#exceptionRow(row, tenantId));
    });
  }

  async resolveException(
    tenantId,
    caseId,
    { resolution, actorId, now = new Date().toISOString() }
  ) {
    const allowed = new Set(["corrected", "accepted_exception", "quarantined", "dismissed"]);
    if (!allowed.has(resolution)) throw new Error("Unsupported exception resolution");
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const existing = await client.query(
        "SELECT * FROM exception_cases WHERE id = $1",
        [caseId]
      );
      if (!existing.rows[0]) throw new Error("Unknown exception case");
      if (existing.rows[0].status === "resolved") {
        return this.#exceptionRow(existing.rows[0], tenantId);
      }
      const { rows } = await client.query(`
        UPDATE exception_cases
        SET status = 'resolved', resolution = $1, resolved_by = $2, resolved_at = $3
        WHERE id = $4
        RETURNING *
      `, [resolution, actorId, now, caseId]);
      await this.#insertOutbox(client, {
        tenant,
        eventType: "exception.resolved",
        aggregateId: caseId,
        payload: {
          caseId,
          exceptionType: rows[0].exception_type,
          epc: rows[0].epc,
          shipmentId: rows[0].shipment_id,
          resolution,
          resolvedBy: actorId,
          resolvedAt: now
        }
      });
      return this.#exceptionRow(rows[0], tenantId);
    });
  }

  async raiseAlert({
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
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        INSERT INTO operational_alerts (
          tenant_id, dedupe_key, alert_type, severity, status,
          entity_type, entity_id, title, message, details,
          first_seen_at, last_seen_at
        ) VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
          alert_type = EXCLUDED.alert_type,
          severity = EXCLUDED.severity,
          entity_type = EXCLUDED.entity_type,
          entity_id = EXCLUDED.entity_id,
          title = EXCLUDED.title,
          message = EXCLUDED.message,
          details = EXCLUDED.details,
          last_seen_at = EXCLUDED.last_seen_at,
          status = CASE
            WHEN operational_alerts.status = 'resolved' THEN 'open'
            ELSE operational_alerts.status
          END,
          first_seen_at = CASE
            WHEN operational_alerts.status = 'resolved' THEN EXCLUDED.first_seen_at
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
        RETURNING *
      `, [
        tenant, dedupeKey, alertType, severity, entityType,
        entityId, title, message, details, now
      ]);
      return this.#alertRow(rows[0], tenantId);
    });
  }

  async resolveAlertByKey(tenantId, dedupeKey, now = new Date().toISOString()) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        UPDATE operational_alerts
        SET status = 'resolved', resolved_at = $1
        WHERE dedupe_key = $2 AND status != 'resolved'
        RETURNING *
      `, [now, dedupeKey]);
      return rows[0] ? this.#alertRow(rows[0], tenantId) : null;
    });
  }

  async acknowledgeAlert(tenantId, alertId, actorId, now = new Date().toISOString()) {
    const tenant = await this.#tenant(tenantId);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const { rows } = await client.query(`
        UPDATE operational_alerts
        SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = $2
        WHERE id = $3 AND status != 'resolved'
        RETURNING *
      `, [actorId, now, alertId]);
      if (!rows[0]) throw new Error("Unknown or resolved alert");
      return this.#alertRow(rows[0], tenantId);
    });
  }

  async alertsFor(tenantId, { status, limit = 100 } = {}) {
    const tenant = await this.#tenant(tenantId);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.#database.tenantTransaction(tenant, async (client) => {
      const parameters = [];
      let filter = "";
      if (status) {
        parameters.push(status);
        filter = "WHERE status = $1";
      }
      parameters.push(safeLimit);
      const { rows } = await client.query(`
        SELECT * FROM operational_alerts ${filter}
        ORDER BY last_seen_at DESC, id DESC
        LIMIT $${parameters.length}
      `, parameters);
      return rows.map((row) => this.#alertRow(row, tenantId));
    });
  }

  #alertRow(row, tenantId) {
    return {
      alertId: row.id,
      tenantId,
      dedupeKey: row.dedupe_key,
      alertType: row.alert_type,
      severity: row.severity,
      status: row.status,
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
      message: row.message,
      details: row.details,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      acknowledgedBy: row.acknowledged_by,
      acknowledgedAt: iso(row.acknowledged_at),
      resolvedAt: iso(row.resolved_at)
    };
  }

  #exceptionRow(row, tenantId) {
    return {
      caseId: row.id,
      tenantId,
      dedupeKey: row.dedupe_key,
      exceptionType: row.exception_type,
      severity: row.severity,
      status: row.status,
      epc: row.epc,
      shipmentId: row.shipment_id,
      sessionId: row.session_id,
      details: row.details,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      resolution: row.resolution,
      resolvedBy: row.resolved_by,
      resolvedAt: iso(row.resolved_at)
    };
  }

  async evaluateOperationalAlerts(tenantId, { now = Date.now() } = {}) {
    const nowIso = new Date(now).toISOString();
    const activeKeys = new Set();
    for (const reader of await this.gatewayHealthFor(tenantId, { now })) {
      const key = `reader-health:${reader.readerId}`;
      if (reader.status === "online") {
        await this.resolveAlertByKey(tenantId, key, nowIso);
        continue;
      }
      activeKeys.add(key);
      await this.raiseAlert({
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
    for (const movement of await this.pendingMovementsFor(tenantId)) {
      if (now - Date.parse(movement.firstObservedAt) < 300_000) continue;
      const key = `pending-movement:${movement.epc}`;
      activeKeys.add(key);
      await this.raiseAlert({
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
    const unknown = (await this.inventoryFor(tenantId))
      .filter((item) => item.assetStatus === "unregistered");
    if (unknown.length) {
      activeKeys.add("unknown-tags");
      await this.raiseAlert({
        tenantId,
        dedupeKey: "unknown-tags",
        alertType: "unknown_tags",
        severity: "warning",
        entityType: "inventory",
        title: "Unknown RFID tags detected",
        message: `${unknown.length} unregistered EPCs are present in inventory observations.`,
        details: { count: unknown.length, epcs: unknown.slice(0, 100).map((item) => item.epc) },
        now: nowIso
      });
    }
    for (const event of await this.integrationOutboxFor(tenantId, {
      status: "dead_letter",
      limit: 500
    })) {
      const key = `integration-dead-letter:${event.eventId}`;
      activeKeys.add(key);
      await this.raiseAlert({
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
    for (const alert of await this.alertsFor(tenantId, { limit: 500 })) {
      if (alert.status === "resolved") continue;
      if (["reader_health", "pending_movement", "unknown_tags", "integration_delivery_failed"]
        .includes(alert.alertType) && !activeKeys.has(alert.dedupeKey)) {
        await this.resolveAlertByKey(tenantId, alert.dedupeKey, nowIso);
      }
    }
    return this.alertsFor(tenantId, { limit: 500 });
  }

  async #receivingBatch(client, tenantId, tenant, batchId) {
    const batchResult = await client.query(`
      SELECT batch.*, product.sku, facility.code AS facility_code, zone.code AS zone_code
      FROM receiving_batches batch
      JOIN products product ON product.id = batch.product_id
      JOIN facilities facility ON facility.id = batch.facility_id
      JOIN zones zone ON zone.id = batch.zone_id
      WHERE batch.id = $1 AND batch.tenant_id = $2
    `, [batchId, tenant]);
    const row = batchResult.rows[0];
    if (!row) throw new Error("Unknown receiving batch");
    const tagResult = await client.query(`
      SELECT tag.*, asset.tenant_id AS existing_tenant_id, product.sku AS existing_sku
      FROM receiving_batch_tags tag
      LEFT JOIN rfid_assets asset ON asset.epc = tag.epc
      LEFT JOIN products product ON product.id = asset.product_id
      WHERE tag.batch_id = $1 ORDER BY tag.epc
    `, [batchId]);
    const tags = tagResult.rows.map((tag) => ({
      epc: tag.epc,
      firstSeenAt: iso(tag.first_seen_at),
      lastSeenAt: iso(tag.last_seen_at),
      readCount: tag.read_count,
      existingTenantId: tag.existing_tenant_id ?? null,
      existingSku: tag.existing_sku ?? null
    }));
    const conflictEpcs = tags.filter((tag) => tag.existingTenantId).map((tag) => tag.epc);
    return {
      batchId: row.id,
      tenantId,
      sku: row.sku,
      expectedQuantity: row.expected_quantity,
      facilityId: row.facility_code,
      zoneId: row.zone_code,
      reference: row.reference,
      status: row.status,
      createdAt: iso(row.created_at),
      approvedAt: iso(row.approved_at),
      approvedBy: row.approved_by,
      tags,
      scannedQuantity: tags.length,
      remainingQuantity: Math.max(row.expected_quantity - tags.length, 0),
      overageQuantity: Math.max(tags.length - row.expected_quantity, 0),
      conflictEpcs,
      canApprove: row.status === "draft" &&
        tags.length === row.expected_quantity && conflictEpcs.length === 0
    };
  }

  async #encodingJob(client, jobId) {
    const { rows } = await client.query(`SELECT * FROM encoding_jobs WHERE id = $1`, [jobId]);
    const row = rows[0];
    if (!row) return null;
    return {
      jobId: row.id, batchId: row.batch_id, sequenceNumber: row.sequence_number,
      epc: row.epc, status: row.status, stationId: row.station_id,
      leaseUntil: iso(row.lease_until), attempts: row.attempts, previousEpc: row.previous_epc,
      tid: row.tid, errorCode: row.error_code, errorMessage: row.error_message,
      writtenAt: iso(row.written_at), verifiedAt: iso(row.verified_at), updatedAt: iso(row.updated_at)
    };
  }

  async #encodingBatch(client, tenantId, batchId) {
    const { rows } = await client.query(`
      SELECT batch.*, product.sku,
        COUNT(job.id) FILTER (WHERE job.status = 'queued')::integer AS queued_count,
        COUNT(job.id) FILTER (WHERE job.status = 'leased')::integer AS leased_count,
        COUNT(job.id) FILTER (WHERE job.status = 'verified')::integer AS verified_count,
        COUNT(job.id) FILTER (WHERE job.status = 'failed')::integer AS failed_count,
        COUNT(job.id)::integer AS total_jobs
      FROM encoding_batches batch
      JOIN products product ON product.id = batch.product_id
      LEFT JOIN encoding_jobs job ON job.batch_id = batch.id
      WHERE batch.id = $1
      GROUP BY batch.id, product.sku
    `, [batchId]);
    const row = rows[0];
    if (!row) return null;
    return {
      batchId: row.id, tenantId, sku: row.sku,
      requestedQuantity: row.requested_quantity, epcScheme: row.epc_scheme,
      status: row.status, queued: row.queued_count, leased: row.leased_count,
      verified: row.verified_count, failed: row.failed_count, totalJobs: row.total_jobs,
      createdAt: iso(row.created_at), startedAt: iso(row.started_at), completedAt: iso(row.completed_at)
    };
  }
}
