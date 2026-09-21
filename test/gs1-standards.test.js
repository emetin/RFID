import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSscc,
  encodeSgtin96,
  encodeSscc96,
  gs1CheckDigit,
  gs1UsProfile
} from "../src/standards/gs1.js";

test("GS1 check digits and US readiness profile are deterministic", () => {
  assert.equal(gs1CheckDigit("0001234560001"), "2");
  assert.equal(gs1UsProfile().mode, "legacy_epc");
  assert.equal(gs1UsProfile({ companyPrefix: "0614141" }).mode, "gs1");
});

test("SGTIN-96 encodes a GTIN instance as a 96-bit EPC and EPCIS URI", () => {
  const encoded = encodeSgtin96({
    gtin: "00614141123452",
    companyPrefix: "0614141",
    serial: "400"
  });
  assert.equal(encoded.epc.length, 24);
  assert.match(encoded.epc, /^30/);
  assert.equal(encoded.pureIdentityUri, "urn:epc:id:sgtin:0614141.012345.400");
});

test("SSCC-96 identifies one logistics package", () => {
  const sscc = buildSscc({ companyPrefix: "0614141", serialReference: "1234567890" });
  const encoded = encodeSscc96({ sscc, companyPrefix: "0614141" });
  assert.equal(encoded.epc.length, 24);
  assert.match(encoded.epc, /^31/);
  assert.equal(encoded.pureIdentityUri, "urn:epc:id:sscc:0614141.1234567890");
});

test("SGTIN rejects a GTIN owned by another company prefix", () => {
  assert.throws(() => encodeSgtin96({
    gtin: "00614141123452",
    companyPrefix: "1234567",
    serial: 1
  }), /does not belong/);
});
