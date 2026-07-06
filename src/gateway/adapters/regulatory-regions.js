export const REGULATORY_PROFILES = Object.freeze({
  FCC_US: Object.freeze({
    id: "FCC_US",
    countryCodes: ["US"],
    authority: "FCC Part 15",
    frequencyMHz: { min: 902, max: 928 },
    market: "United States",
    notes: "Use only an FCC-authorized reader model and its vendor FCC region setting."
  }),
  ETSI_TR: Object.freeze({
    id: "ETSI_TR",
    countryCodes: ["TR"],
    authority: "BTK / ETSI EN 302 208",
    frequencyMHz: { min: 865, max: 868 },
    market: "Türkiye encoding station",
    notes: "Final channels and power must follow the reader approval and current BTK interface requirements."
  })
});

export const GLOBAL_TAG_REQUIREMENT = Object.freeze({
  airInterface: "EPC Class 1 Gen2 / ISO 18000-63",
  tagFrequencyMHz: { min: 860, max: 960 },
  recommendation: "Use a global/broadband textile tag qualified in both ETSI and FCC test setups."
});

export function regulatoryProfile(id) {
  const profile = REGULATORY_PROFILES[id];
  if (!profile) throw new Error(`Unsupported regulatory region: ${id}`);
  return profile;
}

export function validateRegulatoryConfig(manifest, config) {
  if (!manifest.rf?.emitsRf) return null;
  const profile = regulatoryProfile(config.regulatoryRegion);
  const supported = manifest.rf.supportedRegions ?? [];
  if (supported.length && !supported.includes(profile.id)) {
    throw new Error(`Adapter ${manifest.id} does not support ${profile.id}`);
  }
  return profile;
}
