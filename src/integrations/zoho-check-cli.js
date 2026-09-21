import { zohoClientFromEnv } from "./zoho-inventory-client.js";

try {
  const client = zohoClientFromEnv();
  const [organizations, items] = await Promise.all([
    client.listOrganizations(),
    client.listItems({ filter_by: "Status.Active" })
  ]);
  let locations = [];
  let locationsStatus = "disabled";
  if (process.env.ZOHO_LOCATIONS_ENABLED === "true") {
    try {
      locations = await client.listLocations();
      locationsStatus = "connected";
    } catch (error) {
      locationsStatus = `unavailable: ${error.message}`;
    }
  }
  console.log(JSON.stringify({
    connected: true,
    organizationId: client.organizationId,
    organizationName: organizations.find((item) => String(item.organization_id) === String(client.organizationId))?.name ?? null,
    activeItems: items.length,
    locationsStatus,
    locations: locations.map((item) => ({ id: item.location_id, name: item.location_name, type: item.type }))
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
