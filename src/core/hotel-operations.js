import { randomUUID } from "node:crypto";
import { enforceLifespan } from "./supply-workflow.js";

export const emptyOperations = () => ({ hotels: [], policies: [], requests: [] });
const openStates = new Set(["submitted", "approved", "shipped"]);
export const REQUEST_CANCEL_WINDOW_MS = 30 * 60_000;

export function requestCancellation(item, role, at = Date.now()) {
  const created = Date.parse(item.createdAt);
  const deadline = Number.isFinite(created) ? created + REQUEST_CANCEL_WINDOW_MS : null;
  let cancellationReason = '';
  if (!['operator','hotel_admin'].includes(role)) cancellationReason = 'Only hotel operators or managers can cancel hotel requests.';
  else if (item.dispatch || item.status !== 'submitted') cancellationReason = 'Only requests awaiting Globaltex approval can be cancelled. Contact Globaltex for changes.';
  else if (!deadline || at >= deadline) cancellationReason = 'The 30-minute cancellation window has closed. Contact Globaltex for changes.';
  return { canCancel: !cancellationReason, cancelUntil: deadline ? new Date(deadline).toISOString() : null, cancellationReason };
}

export async function managedHotels(store, tenantIds) {
  const hotels = [];
  for (const tenantId of tenantIds) {
    const state = await store.operationsFor(tenantId);
    hotels.push(...state.hotels);
  }
  return hotels;
}

export async function evaluateStock(store, tenantId) {
  await enforceLifespan(store, tenantId);
  await syncRequestShipments(store, tenantId);
  const inventory = await store.inventoryFor(tenantId);
  const counts = new Map();
  for (const asset of inventory) {
    if (asset.sku && (asset.assetStatus ?? "active") === "active" && !asset.inTransit) {
      counts.set(asset.sku, (counts.get(asset.sku) ?? 0) + 1);
    }
  }
  return store.updateOperations(tenantId, (state) => {
    for (const policy of state.policies) {
      const available = counts.get(policy.sku) ?? 0;
      policy.available = available;
      policy.evaluatedAt = new Date().toISOString();
      if (available >= policy.minimum) policy.triggered = false;
      if (!policy.automatic || available >= policy.minimum || policy.triggered) continue;
      if (state.requests.some((r) => r.sku === policy.sku && openStates.has(r.status))) continue;
      const quantity = policy.target - available;
      if (quantity <= 0) continue;
      state.requests.unshift({
        requestId: randomUUID(), tenantId, sku: policy.sku, quantity,
        availableAtRequest: available, source: "automatic", status: "submitted",
        createdAt: new Date().toISOString(), createdBy: "stock-monitor",
        history: [{ status: "submitted", actorId: "stock-monitor", at: new Date().toISOString() }]
      });
      policy.triggered = true;
    }
    return state;
  });
}

export function saveStockPolicy(state, value, actorId) {
  const minimum = Number(value.minimum), target = Number(value.target);
  if (!Number.isSafeInteger(minimum) || minimum < 0 || !Number.isSafeInteger(target) || target < 1 || target < minimum || target > 1_000_000) {
    throw new Error("Minimum stock must be a non-negative integer. Target stock must be at least the minimum and no greater than 1,000,000.");
  }
  if (typeof value.automatic !== "boolean") throw new Error("An automatic request preference is required.");
  const existing = state.policies.find((p) => p.sku === value.sku);
  const policy = { ...existing, sku: value.sku, minimum, target, automatic: value.automatic,
    triggered: existing?.triggered ?? false, updatedBy: actorId, updatedAt: new Date().toISOString() };
  if (existing) Object.assign(existing, policy); else state.policies.push(policy);
  return policy;
}

export function transitionRequest(state, requestId, status, principal, { now = Date.now() } = {}) {
  const item = state.requests.find((r) => r.requestId === requestId);
  if (!item) throw new Error("Request not found.");
  if (["shipped", "fulfilled"].includes(status)) throw new Error("Shipping and completion are updated from the linked shipment and verified receiving, not manually.");
  if (item.dispatch) throw new Error("This request is linked to a shipment and cannot be changed manually.");
  const allowed = principal.role === "chain_admin"
    ? { submitted: ["approved", "rejected", "cancelled"], approved: ["cancelled"] }
    : { submitted: ["cancelled"] };
  if (!allowed[item.status]?.includes(status)) throw new Error("You do not have permission for this request transition, or the transition is invalid.");
  if (principal.role !== 'chain_admin') {
    const cancellation = requestCancellation(item, principal.role, now);
    if (!cancellation.canCancel) throw new Error(cancellation.cancellationReason);
  }
  item.status = status;
  item.updatedAt = new Date(now).toISOString();
  if (['cancelled','rejected'].includes(status)) {
    const policy = state.policies.find(p=>p.sku===item.sku);
    if (policy) policy.triggered = true;
  }
  item.history.push({ status, at: item.updatedAt, actorId: principal.actorId });
  return item;
}

export async function syncRequestShipments(store, tenantId) {
  const state = await store.operationsFor(tenantId);
  if (!state.requests.some(r => r.dispatch && r.status !== "fulfilled")) return;
  const shipments = new Map((await store.shipmentsFor(tenantId)).map(s => [s.shipmentId, s]));
  return store.updateOperations(tenantId, document => {
    for (const request of document.requests) {
      if (!request.dispatch || request.status === "fulfilled") continue;
      const shipment = shipments.get(request.dispatch.shipmentId);
      if (!shipment || shipment.customerTenantId !== tenantId || shipment.supplierTenantId !== request.dispatch.supplierTenantId) continue;
      request.shipmentId = shipment.shipmentId;
      request.receivedQuantity = Math.max(request.receivedQuantity ?? 0, shipment.acceptedAssetCount);
      const status = shipment.status === "received" && shipment.acceptedAssetCount === request.quantity ? "fulfilled" : "shipped";
      if (request.status === status) continue;
      // A completed request never moves backwards after a stale concurrent read.
      if (request.status === "fulfilled") continue;
      request.status = status;
      request.updatedAt = new Date().toISOString();
      request.history.push({ status, actorId: "shipment-reconciliation", at: request.updatedAt, shipmentId: shipment.shipmentId });
    }
  });
}

export async function dispatchStockRequest(store, { tenantId, requestId, supplierTenantId, sourceFacilityId, destinationFacilityId, epcs, actorId }) {
  if (!supplierTenantId || supplierTenantId === tenantId) throw new Error("Select a different supplier workspace.");
  const request = (await store.operationsFor(tenantId)).requests.find(r => r.requestId === requestId);
  if (!request) throw new Error("Request not found.");
  if (!Array.isArray(epcs) || epcs.length !== request.quantity) throw new Error(`Scan exactly ${request.quantity} items for this request.`);
  const normalized = epcs.map(epc => String(epc).toUpperCase()).sort();
  if (new Set(normalized).size !== normalized.length || normalized.some(epc => !/^[0-9A-F]{8,96}$/.test(epc))) throw new Error("The package contains duplicate or invalid EPCs.");
  const facility = (await store.facilitiesFor(tenantId)).find(f => f.facilityId === destinationFacilityId && f.active !== false);
  if (!facility) throw new Error("Select an active receiving facility belonging to this hotel.");
  const shipmentId = `replenishment-${requestId}`;
  const manifest = { shipmentId, supplierTenantId, destinationFacilityId, epcs: normalized };
  const sameManifest = d => d && d.shipmentId === shipmentId && d.supplierTenantId === supplierTenantId &&
    d.destinationFacilityId === destinationFacilityId && JSON.stringify(d.epcs) === JSON.stringify(normalized);
  if (request.dispatch && !sameManifest(request.dispatch)) throw new Error("This request already has a different shipment package.");
  let shipment = (await store.shipmentsFor(supplierTenantId)).find(s => s.shipmentId === shipmentId);
  if (shipment && !request.dispatch) throw new Error("This shipment was not reserved for the stock request.");
  if (!shipment) {
    const inventory = new Map((await store.inventoryFor(supplierTenantId)).map(a => [a.epc, a]));
    for (const epc of normalized) {
      const asset = inventory.get(epc);
      if (asset?.inTransit) throw new Error(`EPC ${epc} is already reserved in a shipment.`);
      if (!asset || asset.sku !== request.sku || asset.assetStatus !== "active") throw new Error(`EPC ${epc} must be an available ${request.sku} item owned by the supplier.`);
      if (sourceFacilityId && asset.facilityId !== sourceFacilityId) throw new Error(`EPC ${epc} is not at the selected source facility.`);
    }
  }
  await store.updateOperations(tenantId, state => {
    const current = state.requests.find(r => r.requestId === requestId);
    if (!current || (!current.dispatch && current.status !== "approved")) throw new Error("Approve the request before preparing a shipment.");
    if (current.dispatch && !sameManifest(current.dispatch)) throw new Error("Another shipment package is already linked to this request.");
    current.dispatch = manifest;
  });
  try {
    if (!shipment) {
      try {
        shipment = await store.createShipment({ tenantId: supplierTenantId, customerTenantId: tenantId,
          destinationFacilityId, epcs: normalized, shipmentId, reference: `Stock request ${requestId.slice(0, 8)}`, actorId });
      } catch (error) {
        // Recover a successful create if the same request was retried concurrently.
        shipment = (await store.shipmentsFor(supplierTenantId)).find(s => s.shipmentId === shipmentId);
        if (!shipment) throw error;
      }
    }
    if (shipment.supplierTenantId !== supplierTenantId || shipment.customerTenantId !== tenantId || shipment.assetCount !== request.quantity) throw new Error("Linked shipment does not match this request.");
    await syncRequestShipments(store, tenantId);
    return { shipment, request: (await store.operationsFor(tenantId)).requests.find(r => r.requestId === requestId) };
  } catch (error) {
    // Keep a recoverable link when shipment creation succeeded but synchronization failed.
    if (!shipment) await store.updateOperations(tenantId, state => {
      const current = state.requests.find(r => r.requestId === requestId);
      if (sameManifest(current?.dispatch)) delete current.dispatch;
    });
    throw error;
  }
}
