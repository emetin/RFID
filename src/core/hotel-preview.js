import { InventoryStore } from "./inventory-store.js";
import { provisionWorkflowLocation } from "./supply-workflow.js";

export const HOTEL_PREVIEW_TENANT = "demo-hotel-preview";

// A separate in-memory store: customer accounts, stock and permissions are untouched.
export async function createHotelPreviewStore() {
  const store = new InventoryStore();
  const tenantId = HOTEL_PREVIEW_TENANT;
  await provisionWorkflowLocation(store, tenantId, { facilityId: "main", name: "Harbor House · Demo Hotel", facilityType: "hotel", timezone: "America/New_York" }, [
    ["stock", "Storage", "storage"], ["room-301", "Distribution", "distribution"],
    ["room-302", "In Use", "in_use"], ["soiled", "Drying", "drying"],
    ["laundry", "Washing", "in_wash"], ["clean", "Clean Storage", "clean_return"]
  ]);
  const products = [
    { sku: "DEMO-BT", name: "Signature Bath Towel", category: "Bath linen", unitsPerBox: 12, boxesPerPallet: 20 },
    { sku: "DEMO-HT", name: "Cotton Hand Towel", category: "Bath linen", unitsPerBox: 24, boxesPerPallet: 20 },
    { sku: "DEMO-SH", name: "Percale Bed Sheet", category: "Bed linen", unitsPerBox: 6, boxesPerPallet: 20 }
  ];
  store.upsertProducts(tenantId, products);
  for (let i = 0; i < 36; i++) {
    const epc = `DE00000000000000${(i+1).toString(16).padStart(8,"0")}`.toUpperCase();
    const sku = products[Math.floor(i/12)].sku;
    store.registerAssets(tenantId, [{ epc, sku, washCount: i % 18 }]);
    const zoneId = ["stock","stock","room-301","room-302","soiled","laundry"][i % 6];
    store.ingest({ tenantId, readerId: `workflow-${zoneId}`, facilityId: "main", zoneId,
      events: [{ epc, eventId: `preview-initial-${i}`, observedAt: new Date(Date.now()-30000).toISOString() }] });
  }
  store.updateOperations(tenantId, state => {
    state.policies.push({ sku:"DEMO-BT", minimum:18, target:36, automatic:true, triggered:true, available:12 });
    state.requests.push({ requestId:"demo-order-001", tenantId, sku:"DEMO-BT", quantity:24, status:"submitted", source:"automatic", createdAt:new Date().toISOString(), history:[] });
    state.lifespanPolicies=[{sku:"DEMO-BT",maxWashes:60,maxUses:120,autoRetire:false}];
  });
  store.upsertProducts("demo-supplier",products);
  const incoming = Array.from({length:6},(_,i)=>({epc:`DF00000000000000${(i+1).toString(16).padStart(8,"0")}`.toUpperCase(),sku:"DEMO-HT"}));
  store.registerAssets("demo-supplier",incoming);
  store.createShipment({tenantId:"demo-supplier",customerTenantId:tenantId,destinationFacilityId:"main",reference:"DEMO · Delivery 1042",epcs:incoming.map(a=>a.epc)});
  return store;
}
