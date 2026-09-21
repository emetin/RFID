# RFID encoding workflow

The tag stores an identifier, not the product record. Product name, SKU, hotel, quantities and locations remain in the database.

## Production sequence

1. Create or import the product SKU and packaging rules.
2. Create an encoding batch for one SKU and requested quantity.
3. Allocate a globally unique EPC according to the approved EPC scheme.
4. Present exactly one blank textile tag to the controlled reader/writer antenna.
5. Read the factory TID when the chip provides a suitable serialized TID.
6. Write the EPC memory bank.
7. Read back EPC and TID and compare with the planned record.
8. Optionally apply an EPC access lock after the recovery policy is approved.
9. Mark the asset `verified` and attach or sew the tag to the product.
10. Export an exception report for failed, duplicated or skipped tags.

The implemented orchestration persists every batch and job. `GTX96` allocation is
atomic, so concurrent stations cannot receive the same EPC. A station claims one
job with a 15-600 second lease, writes the allocated EPC, reads it back and reports
the result. Expired leases return to the queue. Failed or mismatched writes remain
auditable and create a replacement job with a new EPC; failed EPC values are never
reissued.

The device-neutral worker is in `src/encoding/worker.js`. Its hardware adapter must
implement `writeAndVerify({ epc, jobId, batchId })` and return `observedEpc` plus an
optional `tid`. This allows multiple industrial writers to run independently
against the same central queue.

Bulk writing in an uncontrolled RF field is not acceptable because a nearby tag can be modified accidentally. The encoding station must have a shielded or tightly controlled near-field read zone.

## EPC numbering decision

The implemented `GTX96` values use the hexadecimal Globaltex marker `475458` plus
an 18-hex-digit central serial. This is a collision-safe closed-system allocator,
not a GS1 identity. Before interoperable production, Globaltex must choose one path:

- provide its GS1 Company Prefix and GTIN data so a standard serialized EPC scheme can be designed;
- use pre-encoded unique EPCs supplied by the textile-tag manufacturer and import their EPC/SKU file;
- approve a private EPC allocation for a closed system after collision and interoperability review.

The software treats EPC as an uppercase hexadecimal identifier, so the reader pipeline remains stable while this business decision is pending.

### Product grouping and serial identity

Every physical textile receives one globally unique EPC. Product grouping is not
derived from an arbitrary EPC prefix; it is maintained by the verified
`EPC -> SKU -> product` mapping in the platform. This prevents a product rename,
ERP migration or packaging-rule change from forcing tags to be rewritten.

For production, use one approved allocation policy per customer program:

- **GS1 / SGTIN:** the GTIN identifies the trade-item group and the serial
  component identifies the individual textile. Use this when the brand owner has
  an approved GS1 Company Prefix and requires standards-based interoperability.
- **Supplier pre-encoded EPC:** import the supplier's unique EPC and SKU/GTIN
  mapping file. Never infer the product only from an undocumented prefix.
- **Globaltex closed-system EPC:** allocate a unique 96-bit identifier from a
  controlled Globaltex namespace and keep the SKU relationship in the database.
  This is suitable for a closed pilot only after collision and migration rules
  are approved.

Do not generate EPC values independently at multiple encoding stations. A
central allocation service or pre-authorized non-overlapping serial ranges must
guarantee uniqueness. The database rejects an EPC that is already assigned.

## Required hardware later

- washable UHF EPC Gen2 textile tags;
- controlled UHF reader/writer or RFID printer/encoder;
- reader antenna or fixture suitable for one-tag-at-a-time encoding;
- workstation or industrial edge controller running the encoding-station adapter;
- verification and reject handling process.
