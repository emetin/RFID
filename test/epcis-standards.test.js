import test from "node:test";
import assert from "node:assert/strict";
import { commissioningEvent, epcIdentity, receivingEvent, shippingEvent } from "../src/standards/epcis.js";

test("legacy hexadecimal EPCs have a standards-compatible EPCIS raw identity", () => {
  assert.equal(epcIdentity("3034257BF7194E4000000001"), "urn:epc:raw:96.x3034257BF7194E4000000001");
});

test("EPCIS object events use GS1 CBV business steps", () => {
  const common = { epcs: ["3034257BF7194E4000000001"], eventTime: "2026-07-23T12:00:00.000Z" };
  assert.match(commissioningEvent(common).bizStep, /commissioning$/);
  assert.match(shippingEvent(common).bizStep, /shipping$/);
  assert.match(receivingEvent(common).bizStep, /receiving$/);
  assert.equal(shippingEvent(common).disposition, "https://ref.gs1.org/cbv/Disp-in_transit");
});
