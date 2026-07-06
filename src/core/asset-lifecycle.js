const TRANSITIONS = {
  active: new Set(["quarantined", "damaged", "lost", "retired"]),
  quarantined: new Set(["active", "damaged", "lost", "retired"]),
  damaged: new Set(["active", "quarantined", "retired"]),
  lost: new Set(["active", "retired"]),
  retired: new Set()
};

export const ASSET_STATUSES = new Set(Object.keys(TRANSITIONS));

export function validateAssetTransition(fromStatus, toStatus) {
  if (!ASSET_STATUSES.has(toStatus)) throw new Error("Unsupported asset status");
  if (fromStatus === toStatus) return { changed: false };
  if (!TRANSITIONS[fromStatus]?.has(toStatus)) {
    throw new Error(`Asset status cannot change from ${fromStatus} to ${toStatus}`);
  }
  return { changed: true };
}
