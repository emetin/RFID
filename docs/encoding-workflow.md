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

Bulk writing in an uncontrolled RF field is not acceptable because a nearby tag can be modified accidentally. The encoding station must have a shielded or tightly controlled near-field read zone.

## EPC numbering decision

Demo EPC values in this repository are synthetic and must not be used for production allocation. Before production, Globaltex must choose one path:

- provide its GS1 Company Prefix and GTIN data so a standard serialized EPC scheme can be designed;
- use pre-encoded unique EPCs supplied by the textile-tag manufacturer and import their EPC/SKU file;
- approve a private EPC allocation for a closed system after collision and interoperability review.

The software treats EPC as an uppercase hexadecimal identifier, so the reader pipeline remains stable while this business decision is pending.

## Required hardware later

- washable UHF EPC Gen2 textile tags;
- controlled UHF reader/writer or RFID printer/encoder;
- reader antenna or fixture suitable for one-tag-at-a-time encoding;
- workstation running the future encoding-station adapter;
- verification and reject handling process.

