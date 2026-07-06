import { createApp } from "./api/app.js";
import { sendReads } from "./gateway/client.js";
import { signatureFor } from "./core/auth.js";
import { InventoryStore } from "./core/inventory-store.js";

const credential = {
  tenantId: "globaltex-demo",
  readerId: "dock-door-1",
  secret: "demo-secret"
};
const store = new InventoryStore();
store.upsertProducts(credential.tenantId, [{
  sku: "BT-WHT-2754",
  name: "Bath Towel",
  category: "Towels",
  unitsPerBox: 2,
  boxesPerPallet: 2,
  size: "27x54 in",
  color: "White"
}]);
store.registerAssets(credential.tenantId, [
  { epc: "3034257BF7194E4000000001", sku: "BT-WHT-2754" },
  { epc: "3034257BF7194E4000000002", sku: "BT-WHT-2754" },
  { epc: "3034257BF7194E4000000003", sku: "BT-WHT-2754" },
  { epc: "3034257BF7194E4000000004", sku: "BT-WHT-2754" },
  { epc: "3034257BF7194E4000000005", sku: "BT-WHT-2754" }
]);
const session = store.startSession({
  tenantId: credential.tenantId,
  facilityId: "hotel-miami-1",
  zoneId: "receiving",
  type: "receiving",
  reference: "DEMO-PO-001"
});
const server = createApp({
  credentials: { "demo-reader": credential },
  admin: { token: "demo-admin", tenantId: credential.tenantId },
  store
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  const result = await sendReads({
    apiUrl,
    deviceKey: "demo-reader",
    deviceSecret: credential.secret,
    facilityId: "hotel-miami-1",
    zoneId: "receiving",
    sessionId: session.sessionId,
    reads: [
      { epc: "3034257BF7194E4000000001", rssi: -43.2, antenna: 1 },
      { epc: "3034257BF7194E4000000002", rssi: -49.8, antenna: 1 },
      { epc: "3034257BF7194E4000000003", rssi: -51.1, antenna: 2 },
      { epc: "3034257BF7194E4000000004", rssi: -52.4, antenna: 2 },
      { epc: "3034257BF7194E4000000005", rssi: -48.6, antenna: 2 }
    ]
  });

  const timestamp = String(Date.now());
  const completedSession = store.completeSession(credential.tenantId, session.sessionId);
  const response = await fetch(`${apiUrl}/v1/inventory/summary?sessionId=${session.sessionId}`, {
    headers: {
      "x-device-key": "demo-reader",
      "x-device-timestamp": timestamp,
      "x-device-signature": signatureFor(credential.secret, timestamp, "")
    }
  });
  const summary = await response.json();
  console.log(JSON.stringify({ ingestion: result, session: completedSession, summary }, null, 2));
} finally {
  server.close();
}
