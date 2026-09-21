import test from "node:test";
import assert from "node:assert/strict";
import { buildZohoMappingReport, mappingReportCsv } from "../src/integrations/zoho-mapping-report.js";

test("Zoho mapping report selects only uniquely identified tracked goods", () => {
  const report = buildZohoMappingReport([
    { item_id: "1", sku: "TOWEL-1", name: "Towel", status: "active", item_type: "inventory", product_type: "goods", track_inventory: true, locations: [] },
    { item_id: "2", sku: "", name: "Fee", status: "active", item_type: "sales", product_type: "service", track_inventory: false },
    { item_id: "3", sku: "TOWEL-1", name: "Duplicate", status: "active", item_type: "inventory", product_type: "goods", track_inventory: true }
  ]);
  assert.equal(report.summary.eligibleInventoryItems, 0);
  assert.equal(report.summary.duplicateSkuGroups, 1);
  assert.equal(report.summary.missingSku, 1);
});

test("Zoho mapping CSV escapes product names", () => {
  const report = buildZohoMappingReport([
    { item_id: "1", sku: "SHEET-1", name: "Sheet, King", status: "active", item_type: "inventory", product_type: "goods", track_inventory: true, locations: [{ location_id: "10", location_stock_on_hand: "12", location_available_stock: "9" }] }
  ]);
  assert.match(mappingReportCsv(report), /SHEET-1,"Sheet, King"/);
  assert.equal(report.eligible[0].zohoStockOnHand, 12);
  assert.equal(report.eligible[0].zohoAvailableStock, 9);
});

test("Zoho catalog retains inactive tracked goods but excludes them from encoding", () => {
  const report = buildZohoMappingReport([
    { item_id: "1", sku: "ACTIVE-1", name: "Active", status: "active", item_type: "inventory", product_type: "goods", track_inventory: true, locations: [] },
    { item_id: "2", sku: "OLD-1", name: "Inactive", status: "inactive", item_type: "inventory", product_type: "goods", track_inventory: true, locations: [] }
  ]);
  assert.deepEqual(report.catalog.map((item) => item.status), ["active", "inactive"]);
  assert.deepEqual(report.eligible.map((item) => item.sku), ["ACTIVE-1"]);
  assert.equal(report.summary.inactiveInventoryItems, 1);
});
