// A use starts once per clean cycle. A wash completes only after laundry entry.
export function linenStage(type) {
  if (["clean", "clean_stock", "clean_return", "linen_room", "receiving", "storage"].includes(type)) return "clean";
  if (["room", "in_room", "assigned", "in_use"].includes(type)) return "in_room";
  if (["soiled", "hamper", "dirty"].includes(type)) return "soiled";
  if (["wash", "in_wash", "laundry"].includes(type)) return "in_wash";
  if (type === "drying") return "drying";
  if (type === "distribution") return "distribution";
  if (type === "waiting") return "waiting";
  return "other";
}

export function nextLinenCycle(asset, zoneType) {
  const stage = linenStage(zoneType);
  let phase = asset.cyclePhase ?? asset.cycle_phase ?? "clean";
  let useCount = Number(asset.useCount ?? asset.use_count ?? 0);
  let washCount = Number(asset.washCount ?? asset.wash_count ?? 0);
  let washed = false;
  if (stage === "in_room" && phase === "clean") { useCount++; phase = "used"; }
  if (stage === "soiled" && phase !== "washing") phase = "used";
  if (stage === "in_wash") phase = "washing";
  if (stage === "clean" && phase === "washing") { washCount++; phase = "clean"; washed = true; }
  return { useCount, washCount, cyclePhase: phase, washed };
}
