function normalizedSku(item) {
  return String(item.sku ?? "").trim();
}

function stockNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function classifyZohoItem(item) {
  const sku = normalizedSku(item);
  const reasons = [];
  if (item.status !== "active") reasons.push("inactive");
  if (item.product_type !== "goods") reasons.push("not_goods");
  if (item.item_type !== "inventory" || item.track_inventory !== true) {
    reasons.push("inventory_tracking_disabled");
  }
  if (!sku) reasons.push("missing_sku");
  return {
    eligible: reasons.length === 0,
    reasons,
    sku,
    itemId: String(item.item_id),
    name: item.name,
    status: item.status === "inactive" ? "inactive" : "active",
    itemType: item.item_type,
    productType: item.product_type,
    trackInventory: item.track_inventory === true,
    locations: (item.locations ?? []).map((location) => ({
      locationId: String(location.location_id),
      locationName: location.location_name ?? "",
      stockOnHand: stockNumber(location.location_stock_on_hand),
      availableStock: stockNumber(location.location_available_stock)
    })),
    zohoStockOnHand: (item.locations ?? []).reduce((sum, location) => sum + stockNumber(location.location_stock_on_hand), 0),
    zohoAvailableStock: (item.locations ?? []).reduce((sum, location) => sum + stockNumber(location.location_available_stock), 0)
  };
}

export function buildZohoMappingReport(items) {
  const records = items.map(classifyZohoItem);
  const duplicateSkus = new Set();
  const bySku = new Map();
  for (const record of records) {
    if (!record.sku) continue;
    const key = `${record.status}:${record.sku.toUpperCase()}`;
    if (bySku.has(key)) duplicateSkus.add(key);
    bySku.set(key, record);
  }
  for (const record of records) {
    if (duplicateSkus.has(`${record.status}:${record.sku.toUpperCase()}`)) {
      record.eligible = false;
      record.reasons.push("duplicate_sku");
    }
  }
  const eligible = records.filter((record) => record.eligible);
  const catalog = records.filter((record) =>
    record.sku &&
    record.productType === "goods" &&
    record.itemType === "inventory" &&
    record.trackInventory &&
    !record.reasons.includes("duplicate_sku")
  );
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalRecords: records.length,
      eligibleInventoryItems: eligible.length,
      catalogItems: catalog.length,
      inactiveInventoryItems: catalog.filter((record) => record.status === "inactive").length,
      excludedRecords: records.length - eligible.length,
      missingSku: records.filter((record) => record.reasons.includes("missing_sku")).length,
      services: records.filter((record) => record.reasons.includes("not_goods")).length,
      inventoryTrackingDisabled: records.filter((record) => record.reasons.includes("inventory_tracking_disabled")).length,
      duplicateSkuGroups: duplicateSkus.size
    },
    catalog,
    eligible,
    excluded: records.filter((record) => !record.eligible)
  };
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function mappingReportCsv(report) {
  const header = ["zoho_item_id", "sku", "name", "item_type", "product_type", "track_inventory", "zoho_stock_on_hand", "zoho_available_stock", "location_ids"];
  const rows = report.eligible.map((record) => [
    record.itemId,
    record.sku,
    record.name,
    record.itemType,
    record.productType,
    record.trackInventory,
    record.zohoStockOnHand,
    record.zohoAvailableStock,
    record.locations.map((location) => location.locationId).join("|")
  ]);
  return [header, ...rows].map((row) => row.map(csvValue).join(",")).join("\n") + "\n";
}
