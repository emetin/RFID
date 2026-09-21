function zoneOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function epcIdentity(value) {
  const normalized = String(value ?? "").trim();
  if (normalized.startsWith("urn:epc:")) return normalized;
  if (!/^[0-9A-Fa-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("EPC must be an EPC URI or an even-length hexadecimal value");
  }
  return `urn:epc:raw:${normalized.length * 4}.x${normalized.toUpperCase()}`;
}

export function epcisObjectEvent({
  epcs,
  businessStep,
  disposition,
  eventTime = new Date().toISOString(),
  readPoint = null,
  businessLocation = null,
  source = null,
  destination = null,
  transaction = null
}) {
  if (!Array.isArray(epcs) || epcs.length === 0) throw new Error("EPCIS event requires EPCs");
  if (!businessStep) throw new Error("EPCIS businessStep is required");
  const date = new Date(eventTime);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid EPCIS eventTime");
  return {
    "@context": ["https://ref.gs1.org/standards/epcis/epcis-context.jsonld"],
    type: "ObjectEvent",
    eventTime: date.toISOString(),
    eventTimeZoneOffset: zoneOffset(date),
    epcList: [...new Set(epcs.map(epcIdentity))],
    action: "OBSERVE",
    bizStep: `https://ref.gs1.org/cbv/BizStep-${businessStep}`,
    ...(disposition ? { disposition: `https://ref.gs1.org/cbv/Disp-${disposition}` } : {}),
    ...(readPoint ? { readPoint: { id: readPoint } } : {}),
    ...(businessLocation ? { bizLocation: { id: businessLocation } } : {}),
    ...(source ? { sourceList: [{ type: "owning_party", source }] } : {}),
    ...(destination ? { destinationList: [{ type: "owning_party", destination }] } : {}),
    ...(transaction ? { bizTransactionList: [{ type: "po", bizTransaction: transaction }] } : {})
  };
}

export function commissioningEvent(options) {
  return epcisObjectEvent({ ...options, businessStep: "commissioning", disposition: "active" });
}

export function shippingEvent(options) {
  return epcisObjectEvent({ ...options, businessStep: "shipping", disposition: "in_transit" });
}

export function receivingEvent(options) {
  return epcisObjectEvent({ ...options, businessStep: "receiving", disposition: "active" });
}
