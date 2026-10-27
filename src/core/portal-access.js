// Company users manage commercial relationships, never a customer's internal operations.
export function companyPortalAccess(principal, method, path) {
  if (principal.role !== "chain_admin") return true;
  const ownWorkspace = principal.tenantId === principal.tenantIds[0];
  if (!ownWorkspace) {
    return (method === "GET" && path === "/v1/admin/facilities") ||
      (method === "PUT" && /^\/v1\/admin\/stock\/requests\/[^/]+$/.test(path)) ||
      (method === "POST" && /^\/v1\/admin\/stock\/requests\/[^/]+\/dispatch$/.test(path));
  }
  return !["/v1/admin/workflow/scan", "/v1/admin/workflow/lifespan", "/v1/admin/stock/policies"].includes(path);
}

export function commercialRequest(request) {
  const { requestId, tenantId, sku, quantity, status, createdAt, updatedAt, shipmentId, receivedQuantity } = request;
  return { requestId, tenantId, sku, quantity, status, createdAt, updatedAt, shipmentId,
    receivedQuantity: receivedQuantity ?? 0,
    ...(request.dispatch ? { dispatch: { shipmentId: request.dispatch.shipmentId } } : {}) };
}
