import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { zohoClientFromEnv } from "./zoho-inventory-client.js";
import { buildZohoMappingReport, mappingReportCsv } from "./zoho-mapping-report.js";

const outputJson = process.env.ZOHO_MAPPING_REPORT_JSON ?? "data/runtime/zoho-mapping-report.json";
const outputCsv = process.env.ZOHO_MAPPING_REPORT_CSV ?? "data/runtime/zoho-eligible-items.csv";
const client = zohoClientFromEnv();
const [activeItems, inactiveItems] = await Promise.all([
  client.listItems({ filter_by: "Status.Active" }),
  client.listItems({ filter_by: "Status.Inactive" })
]);
const itemsById = new Map([...activeItems, ...inactiveItems].map((item) => [String(item.item_id), item]));
const items = [...itemsById.values()];
const initialReport = buildZohoMappingReport(items);
const details = await client.bulkItemDetails(initialReport.catalog.map((item) => item.itemId));
const detailsById = new Map(details.map((item) => [String(item.item_id), item]));
const enrichedItems = items.map((item) => ({
  ...item,
  ...(detailsById.get(String(item.item_id)) ?? {})
}));
const report = buildZohoMappingReport(enrichedItems);
for (const path of [outputJson, outputCsv]) mkdirSync(dirname(path), { recursive: true });
writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(outputCsv, mappingReportCsv(report));
console.log(JSON.stringify({ ...report.summary, outputJson, outputCsv }, null, 2));
