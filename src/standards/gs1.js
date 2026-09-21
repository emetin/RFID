const PARTITIONS = [
  { partition: 0, companyDigits: 12, companyBits: 40, itemDigits: 1, itemBits: 4, ssccDigits: 5, ssccBits: 42 },
  { partition: 1, companyDigits: 11, companyBits: 37, itemDigits: 2, itemBits: 7, ssccDigits: 6, ssccBits: 45 },
  { partition: 2, companyDigits: 10, companyBits: 34, itemDigits: 3, itemBits: 10, ssccDigits: 7, ssccBits: 48 },
  { partition: 3, companyDigits: 9, companyBits: 30, itemDigits: 4, itemBits: 14, ssccDigits: 8, ssccBits: 52 },
  { partition: 4, companyDigits: 8, companyBits: 27, itemDigits: 5, itemBits: 17, ssccDigits: 9, ssccBits: 55 },
  { partition: 5, companyDigits: 7, companyBits: 24, itemDigits: 6, itemBits: 20, ssccDigits: 10, ssccBits: 58 },
  { partition: 6, companyDigits: 6, companyBits: 20, itemDigits: 7, itemBits: 24, ssccDigits: 11, ssccBits: 62 }
];

function digits(value, length, label) {
  const normalized = String(value ?? "").replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${length}}$`).test(normalized)) {
    throw new Error(`${label} must contain exactly ${length} digits`);
  }
  return normalized;
}

function partitionFor(companyPrefix) {
  const normalized = String(companyPrefix ?? "");
  const partition = PARTITIONS.find((item) => item.companyDigits === normalized.length);
  if (!partition || !/^\d+$/.test(normalized)) {
    throw new Error("GS1 Company Prefix must contain 6 to 12 digits");
  }
  return partition;
}

export function gs1CheckDigit(payload) {
  const value = String(payload ?? "");
  if (!/^\d+$/.test(value)) throw new Error("GS1 payload must contain digits only");
  const sum = [...value].reverse().reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1),
    0
  );
  return String((10 - (sum % 10)) % 10);
}

export function validateGs1Key(value, length, label = "GS1 key") {
  const normalized = digits(value, length, label);
  if (gs1CheckDigit(normalized.slice(0, -1)) !== normalized.at(-1)) {
    throw new Error(`${label} has an invalid check digit`);
  }
  return normalized;
}

export function encodeSgtin96({ gtin, companyPrefix, serial, filter = 1 }) {
  const gtin14 = validateGs1Key(gtin, 14, "GTIN-14");
  const partition = partitionFor(companyPrefix);
  if (gtin14.slice(1, 1 + partition.companyDigits) !== companyPrefix) {
    throw new Error("GTIN-14 does not belong to the configured GS1 Company Prefix");
  }
  const serialNumber = BigInt(serial);
  if (serialNumber < 0n || serialNumber >= 2n ** 38n) {
    throw new Error("SGTIN-96 serial must be between 0 and 274877906943");
  }
  const filterValue = Number(filter);
  if (!Number.isInteger(filterValue) || filterValue < 0 || filterValue > 7) {
    throw new Error("SGTIN filter must be between 0 and 7");
  }
  const itemReference = `${gtin14[0]}${gtin14.slice(1 + partition.companyDigits, 13)}`;
  let binary = 0x30n << 88n;
  binary |= BigInt(filterValue) << 85n;
  binary |= BigInt(partition.partition) << 82n;
  binary |= BigInt(companyPrefix) << BigInt(38 + partition.itemBits);
  binary |= BigInt(itemReference) << 38n;
  binary |= serialNumber;
  return {
    scheme: "SGTIN-96",
    epc: binary.toString(16).toUpperCase().padStart(24, "0"),
    pureIdentityUri: `urn:epc:id:sgtin:${companyPrefix}.${itemReference}.${serialNumber}`,
    gtin: gtin14,
    serial: serialNumber.toString()
  };
}

export function encodeSscc96({ sscc, companyPrefix, filter = 0 }) {
  const sscc18 = validateGs1Key(sscc, 18, "SSCC-18");
  const partition = partitionFor(companyPrefix);
  if (sscc18.slice(1, 1 + partition.companyDigits) !== companyPrefix) {
    throw new Error("SSCC-18 does not belong to the configured GS1 Company Prefix");
  }
  const filterValue = Number(filter);
  if (!Number.isInteger(filterValue) || filterValue < 0 || filterValue > 7) {
    throw new Error("SSCC filter must be between 0 and 7");
  }
  const serialReference = `${sscc18[0]}${sscc18.slice(1 + partition.companyDigits, 17)}`;
  let binary = 0x31n << 88n;
  binary |= BigInt(filterValue) << 85n;
  binary |= BigInt(partition.partition) << 82n;
  binary |= BigInt(companyPrefix) << BigInt(partition.ssccBits);
  binary |= BigInt(serialReference);
  return {
    scheme: "SSCC-96",
    epc: binary.toString(16).toUpperCase().padStart(24, "0"),
    pureIdentityUri: `urn:epc:id:sscc:${companyPrefix}.${serialReference}`,
    sscc: sscc18
  };
}

export function buildSscc({ companyPrefix, serialReference }) {
  const partition = partitionFor(companyPrefix);
  const reference = digits(serialReference, partition.ssccDigits, "SSCC serial reference");
  const payload = `${reference[0]}${companyPrefix}${reference.slice(1)}`;
  return `${payload}${gs1CheckDigit(payload)}`;
}

export function gs1UsProfile({ companyPrefix = null } = {}) {
  const configured = Boolean(companyPrefix && /^\d{6,12}$/.test(companyPrefix));
  return {
    market: "US",
    regulatoryRegion: "FCC_US",
    frequencyBandMHz: "902-928",
    airInterface: "EPC UHF Gen2 / ISO/IEC 18000-63",
    tagDataStandard: "GS1 TDS 2.2",
    eventStandard: "EPCIS 2.0 / CBV 2.0",
    itemScheme: "SGTIN-96",
    logisticsScheme: "SSCC-96",
    companyPrefixConfigured: configured,
    mode: configured ? "gs1" : "legacy_epc"
  };
}
