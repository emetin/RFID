export const GATEWAY_OFFLINE_AFTER_MS = 90_000;

export function gatewayStatus(health, now = Date.now()) {
  if (now - Date.parse(health.receivedAt) > GATEWAY_OFFLINE_AFTER_MS) return "offline";
  if (!health.readerConnected || health.queueDepth > 0 || health.lastError) return "degraded";
  return "online";
}
