export const MOVEMENT_CONFIRMATION_WINDOW_MS = 15_000;
export const MOVEMENT_CONFIRMATION_READS = 2;

export function movementDecision({
  previous,
  candidate,
  facilityId,
  zoneId,
  readerId,
  observedAt,
  trustedSession = false
}) {
  if (!previous) return { action: "confirm", candidate: null };
  if (Date.parse(observedAt) <= Date.parse(previous.lastSeenAt) &&
      previous.facilityId === facilityId &&
      previous.zoneId === zoneId) {
    return { action: "ignore", candidate: null };
  }
  if (previous.facilityId === facilityId && previous.zoneId === zoneId) {
    return { action: "stay", candidate: null };
  }
  if (Date.parse(observedAt) <= Date.parse(previous.lastSeenAt)) {
    return {
      action: "pending",
      candidate: buildCandidate({
        previous,
        facilityId,
        zoneId,
        readerId,
        observedAt,
        observations: 1,
        reason: "stale_observation"
      })
    };
  }
  if (trustedSession) return { action: "confirm", candidate: null };

  const sameTarget = candidate &&
    candidate.toFacilityId === facilityId &&
    candidate.toZoneId === zoneId;
  const withinWindow = sameTarget &&
    Date.parse(observedAt) - Date.parse(candidate.firstObservedAt) <=
      MOVEMENT_CONFIRMATION_WINDOW_MS;

  if (withinWindow) {
    const next = {
      ...candidate,
      readerId,
      lastObservedAt: observedAt,
      observations: candidate.observations + 1,
      reason: "awaiting_confirmation"
    };
    if (next.observations >= MOVEMENT_CONFIRMATION_READS) {
      return { action: "confirm", candidate: null };
    }
    return { action: "pending", candidate: next };
  }

  return {
    action: "pending",
    candidate: buildCandidate({
      previous,
      facilityId,
      zoneId,
      readerId,
      observedAt,
      observations: 1,
      reason: candidate ? "conflicting_or_expired_evidence" : "awaiting_confirmation"
    })
  };
}

function buildCandidate({
  previous,
  facilityId,
  zoneId,
  readerId,
  observedAt,
  observations,
  reason
}) {
  return {
    fromFacilityId: previous.facilityId,
    fromZoneId: previous.zoneId,
    toFacilityId: facilityId,
    toZoneId: zoneId,
    readerId,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    observations,
    reason
  };
}
