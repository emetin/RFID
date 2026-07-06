import { randomUUID } from "node:crypto";
import { PostgresDatabase } from "../core/postgres-database.js";

const database = new PostgresDatabase();
const tenantA = randomUUID();
const tenantB = randomUUID();
const suffix = randomUUID().slice(0, 8);

try {
  await database.systemTransaction(async (client) => {
    await client.query(`
      INSERT INTO tenants (id, slug, name)
      VALUES ($1, $2, 'RLS Hotel A'), ($3, $4, 'RLS Hotel B')
    `, [tenantA, `rls-a-${suffix}`, tenantB, `rls-b-${suffix}`]);
  });

  await database.tenantTransaction(tenantA, async (client) => {
    await client.query(`
      INSERT INTO facilities (tenant_id, code, name, facility_type)
      VALUES ($1, 'hotel-a', 'Hotel A', 'hotel')
    `, [tenantA]);
  });

  const tenantAResult = await database.tenantTransaction(tenantA, async (client) => {
    const tenants = await client.query("SELECT id FROM tenants");
    const facilities = await client.query("SELECT tenant_id, code FROM facilities");
    return { tenants: tenants.rows, facilities: facilities.rows };
  });
  const tenantBResult = await database.tenantTransaction(tenantB, async (client) => {
    const tenants = await client.query("SELECT id FROM tenants");
    const facilities = await client.query("SELECT tenant_id, code FROM facilities");
    return { tenants: tenants.rows, facilities: facilities.rows };
  });

  let crossTenantWriteBlocked = false;
  try {
    await database.tenantTransaction(tenantB, async (client) => {
      await client.query(`
        INSERT INTO facilities (tenant_id, code, name, facility_type)
        VALUES ($1, 'forbidden', 'Forbidden', 'hotel')
      `, [tenantA]);
    });
  } catch (error) {
    crossTenantWriteBlocked = /row-level security policy/i.test(error.message);
  }

  const passed =
    tenantAResult.tenants.length === 1 &&
    tenantAResult.tenants[0].id === tenantA &&
    tenantAResult.facilities.length === 1 &&
    tenantBResult.tenants.length === 1 &&
    tenantBResult.tenants[0].id === tenantB &&
    tenantBResult.facilities.length === 0 &&
    crossTenantWriteBlocked;

  console.log(JSON.stringify({
    passed,
    tenantAVisibleFacilities: tenantAResult.facilities.length,
    tenantBVisibleFacilities: tenantBResult.facilities.length,
    crossTenantWriteBlocked
  }, null, 2));
  if (!passed) process.exitCode = 2;
} finally {
  await database.systemTransaction(async (client) => {
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = ANY($1::uuid[])",
      [[tenantA, tenantB]]
    );
    await client.query(
      "DELETE FROM tenants WHERE id = ANY($1::uuid[])",
      [[tenantA, tenantB]]
    );
  });
  await database.close();
}
