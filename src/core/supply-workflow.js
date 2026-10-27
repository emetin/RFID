import { randomUUID } from "node:crypto";
import { linenStage } from "./linen-cycle.js";

export function normalizeEpcs(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,;]+/).filter(Boolean);
  const epcs = list.map(v => String(v).trim().toUpperCase());
  if (!epcs.length || epcs.length > 10000 || epcs.some(v => !/^[0-9A-F]{8,96}$/.test(v))) throw new Error("Scan at least one valid EPC (8–96 hexadecimal characters). Maximum 10,000 items per operation.");
  if (new Set(epcs).size !== epcs.length) throw new Error("Duplicate EPCs found. Each item must appear once.");
  return epcs;
}

export async function provisionWorkflowLocation(store, tenantId, facility, zoneDefinitions) {
  await store.upsertFacility(tenantId, facility);
  for (const [zoneId, name, zoneType] of zoneDefinitions) {
    await store.upsertZone(tenantId, { facilityId: facility.facilityId, zoneId, name, zoneType });
    await store.upsertReader(tenantId, { readerId: `workflow-${zoneId}`, facilityId: facility.facilityId, zoneId, name: `${name} operator station`, adapter: "stdin", regulatoryRegion: "FCC_US", active: true });
  }
}

export async function ensureOperatorStation(store, tenantId, zone) {
  const readerId = `workflow-${zone.zoneId}`;
  if (!(await store.readersFor(tenantId)).some(r => r.readerId === readerId)) {
    await store.upsertReader(tenantId, { readerId, facilityId: zone.facilityId, zoneId: zone.zoneId, name: `${zone.name} operator station`, adapter: "stdin", regulatoryRegion: "FCC_US", active: true });
  }
  return readerId;
}

export async function setupWarehouses(store, tenantId) {
  const existing = await store.facilitiesFor(tenantId);
  for (const [facilityId, name, timezone] of [["houston", "Houston, Texas", "America/Chicago"], ["miami", "Miami, Florida", "America/New_York"]]) {
    if (existing.some(f => f.facilityId === facilityId)) continue;
    await provisionWorkflowLocation(store, tenantId, { facilityId, name, facilityType: "warehouse", timezone }, [[`${facilityId}-stock`, `${name} · Stock`, "warehouse"]]);
  }
  return store.facilitiesFor(tenantId);
}

export function hotelDetails(value, previous = {}) {
  const detail = { ...previous };
  for (const key of ["name", "contact", "email", "phone", "address", "city", "state", "postalCode", "country", "notes", "timezone"]) {
    if (value[key] !== undefined) detail[key] = String(value[key]).trim();
    if ((detail[key]?.length ?? 0) > (key === "notes" ? 2000 : 300)) throw new Error(`${key} is too long.`);
  }
  if (!detail.name || detail.name.length < 2 || detail.name.length > 120) throw new Error("Hotel name must be 2–120 characters long.");
  if (detail.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(detail.email)) throw new Error("Enter a valid contact email.");
  detail.timezone ||= "America/New_York";
  try { new Intl.DateTimeFormat("en-US", { timeZone: detail.timezone }); } catch { throw new Error("Enter a valid IANA time zone."); }
  return detail;
}

export async function enforceLifespan(store, tenantId) {
  const rules = (await store.operationsFor(tenantId)).lifespanPolicies ?? [];
  if (!rules.length) return;
  for (const asset of await store.inventoryFor(tenantId)) {
    const rule = rules.find(r => r.sku === asset.sku);
    if (!rule?.autoRetire || asset.assetStatus !== "active" || asset.inTransit) continue;
    if ((rule.maxWashes && asset.washCount >= rule.maxWashes) || (rule.maxUses && asset.useCount >= rule.maxUses)) {
      await store.updateAssetStatus(tenantId, asset.epc, { status: "retired", reason: `Configured service life reached (${asset.washCount} washes, ${asset.useCount} uses).`, actorId: "lifespan-policy" });
    }
  }
}

export async function saveLifespan(store, tenantId, value, actorId) {
  if (!(await store.productsFor(tenantId)).some(p => p.sku === value.sku)) throw new Error("Select a registered product.");
  const rule = { sku: value.sku, maxWashes: Number(value.maxWashes || 0), maxUses: Number(value.maxUses || 0), autoRetire: value.autoRetire === true, updatedBy: actorId, updatedAt: new Date().toISOString() };
  if ([rule.maxWashes, rule.maxUses].some(n => !Number.isSafeInteger(n) || n < 0 || n > 100000) || (!rule.maxWashes && !rule.maxUses)) throw new Error("Set at least one service-life limit between 1 and 100,000. Zero disables a limit.");
  await store.updateOperations(tenantId, state => {
    state.lifespanPolicies ??= [];
    const index = state.lifespanPolicies.findIndex(p => p.sku === rule.sku);
    if (index < 0) state.lifespanPolicies.push(rule); else state.lifespanPolicies[index] = rule;
  });
  await enforceLifespan(store, tenantId);
  return rule;
}

export async function workflowScan(store, tenantId, value, actorId) {
  const epcs = normalizeEpcs(value.epcs);
  const zone = (await store.zonesFor(tenantId)).find(z => z.zoneId === value.zoneId && z.facilityId === value.facilityId && z.active !== false);
  if (!zone || !(await store.facilitiesFor(tenantId)).some(f=>f.facilityId===zone.facilityId&&f.active!==false)) throw new Error("Select an active location belonging to this workspace.");
  const inventory = new Map((await store.inventoryFor(tenantId)).map(a => [a.epc, a]));
  if (epcs.some(e => !inventory.get(e)?.sku || inventory.get(e).inTransit)) throw new Error("Only owned items outside open transfers can be moved. Receive incoming transfers first.");
  if (epcs.some(e => inventory.get(e).assetStatus !== "active")) throw new Error("Retired, damaged, lost or quarantined items cannot enter an operating cycle.");
  await ensureOperatorStation(store, tenantId, zone);
  // A physical scanner or explicitly confirmed operator scan is authoritative.
  const session = await store.startSession({ tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, type: "inventory", reference: `Confirmed operator count by ${actorId}` });
  const result = await store.ingest({ tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, readerId: `workflow-${zone.zoneId}`, sessionId: session.sessionId, events: epcs.map(epc => ({ epc, eventId: randomUUID(), observedAt: new Date(Math.max(Date.now(), Date.parse(inventory.get(epc).lastSeenAt || 0) + 1)).toISOString() })) });
  await store.completeSession(tenantId, session.sessionId);
  await enforceLifespan(store, tenantId);
  return { ...result, scanned: epcs.length };
}

export async function dispatchTransfer(store, tenantId, value, actorId) {
  const epcs = normalizeEpcs(value.epcs);
  const shipmentId = String(value.operationId ?? randomUUID());
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(shipmentId)) throw new Error("Invalid operation ID.");
  const reference = String(value.reference ?? "").trim();
  if (!reference || reference.length > 200) throw new Error("Enter an order or transfer reference (up to 200 characters).");
  const existing = (await store.shipmentsFor(tenantId)).find(s => s.shipmentId === shipmentId);
  if (existing) {
    if (existing.customerTenantId !== value.customerTenantId || existing.destinationFacilityId !== value.destinationFacilityId || existing.reference !== reference || JSON.stringify(existing.assets.map(a=>a.epc).sort()) !== JSON.stringify([...epcs].sort())) throw new Error("This operation ID belongs to another transfer.");
    return existing;
  }
  if (!(await store.facilitiesFor(tenantId)).some(f => f.facilityId === value.sourceFacilityId && f.active !== false)) throw new Error("Select an active source facility.");
  const inventory = new Map((await store.inventoryFor(tenantId)).map(a => [a.epc, a]));
  for (const epc of epcs) {
    const asset = inventory.get(epc);
    if (!asset?.sku || asset.assetStatus !== "active" || asset.inTransit || asset.facilityId !== value.sourceFacilityId) throw new Error(`EPC ${epc} must be available at the selected source warehouse.`);
  }
  const destination = (await store.facilitiesFor(value.customerTenantId)).find(f => f.facilityId === value.destinationFacilityId && f.active !== false);
  if (!destination) throw new Error("Select an active destination facility.");
  if (value.customerTenantId === tenantId && value.sourceFacilityId === value.destinationFacilityId) throw new Error("Source and destination must differ.");
  // Shipment IDs make a retry after a lost response safe. Native stores serialize EPC reservations.
  return store.createShipment({ tenantId, customerTenantId: value.customerTenantId, destinationFacilityId: value.destinationFacilityId, epcs, reference, shipmentId, actorId });
}

export async function receiveTransfer(store, tenantId, shipmentId, value, actorId) {
  let epcs = normalizeEpcs(value.epcs);
  const shipment = (await store.shipmentsFor(tenantId)).find(s => s.shipmentId === shipmentId && s.customerTenantId === tenantId);
  if (!shipment) throw new Error("Incoming transfer not found in this workspace.");
  const expected = new Set(shipment.assets.map(a => a.epc));
  const unexpected = epcs.filter(epc => !expected.has(epc));
  if (unexpected.length) throw new Error(`Unexpected tags: ${unexpected.join(", ")}. Check the package and scan again.`);
  const zone = (await store.zonesFor(tenantId)).find(z => z.facilityId === shipment.destinationFacilityId && z.zoneId === value.zoneId && z.active !== false);
  if (!zone || !(await store.facilitiesFor(tenantId)).some(f=>f.facilityId===zone.facilityId&&f.active!==false)) throw new Error("Select an active receiving location at the transfer destination.");
  const pending = new Set(shipment.assets.filter(a => !a.acceptedAt).map(a => a.epc));
  epcs = epcs.filter(epc => pending.has(epc));
  if (!epcs.length) return { shipment, receivedCount: 0, missingCount: pending.size, unexpectedCount: 0, received: [], missing: [...pending], unexpected: [] };
  await ensureOperatorStation(store, tenantId, zone);
  const session = await store.startSession({ tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, type: "receiving", reference: `Transfer ${shipmentId} · ${actorId}` });
  const current = new Map((await store.inventoryFor(tenantId)).map(a => [a.epc,a]));
  await store.ingest({ tenantId, facilityId: zone.facilityId, zoneId: zone.zoneId, readerId: `workflow-${zone.zoneId}`, sessionId: session.sessionId, events: epcs.map(epc => ({ epc, eventId: randomUUID(), observedAt: new Date(Math.max(Date.now(), Date.parse(current.get(epc)?.lastSeenAt || "1970-01-01") + 1)).toISOString() })) });
  const preview = await store.reconcileShipment({ tenantId, shipmentId, sessionId: session.sessionId });
  if (preview.unexpectedCount) throw new Error(`Unexpected tags: ${preview.unexpected.join(", ")}. No ownership was transferred. Check the package and scan again.`);
  const result = await store.reconcileShipment({ tenantId, shipmentId, sessionId: session.sessionId, accept: true });
  if (shipment.supplierTenantId !== tenantId) {
    const sourceRules = (await store.operationsFor(shipment.supplierTenantId)).lifespanPolicies ?? [];
    const receivedSkus = new Set((await store.inventoryFor(tenantId)).filter(a => epcs.includes(a.epc)).map(a => a.sku));
    await store.updateOperations(tenantId, state => {
      state.lifespanPolicies ??= [];
      for (const rule of sourceRules) if (receivedSkus.has(rule.sku) && !state.lifespanPolicies.some(r => r.sku === rule.sku)) state.lifespanPolicies.push({ ...rule, inheritedFrom: shipment.supplierTenantId });
    });
  }
  await store.completeSession(tenantId, session.sessionId);
  return result;
}

export async function workflowSnapshot(store, tenantId) {
  await enforceLifespan(store, tenantId);
  const [assets, products, facilities, zones, shipments, operations, encodingBatches] = await Promise.all([store.inventoryFor(tenantId), store.productsFor(tenantId), store.facilitiesFor(tenantId), store.zonesFor(tenantId), store.shipmentsFor(tenantId), store.operationsFor(tenantId), store.encodingBatchesFor(tenantId)]);
  const registered = assets.filter(a => a.sku);
  return { assets: registered.map(a => ({ ...a, stage: linenStage(zones.find(z => z.zoneId === a.zoneId)?.zoneType) })), products, facilities, zones, shipments, encodingBatches, lifespanPolicies: operations.lifespanPolicies ?? [], metrics: { registered: registered.length, available: registered.filter(a => a.assetStatus === "active" && !a.inTransit).length, inTransit: registered.filter(a => a.inTransit).length, retired: registered.filter(a => a.assetStatus === "retired").length } };
}
