# Globaltex RFID Adapter SDK

## Purpose

The cloud inventory platform never imports a reader vendor SDK. Hardware-specific
code runs only inside an Edge Gateway adapter. Every adapter converts its device
messages to the same Globaltex read contract, so adding a new reader does not
change inventory, custody, movement, user or integration services.

## Supported integration families

| Family | Plugin strategy | Current state |
| --- | --- | --- |
| LLRP fixed readers | shared protocol plugin | plugin slot ready; hardware implementation/certification required |
| MQTT readers/gateways | shared transport plugin | plugin slot ready; vendor topic mapping required |
| HTTP readers/gateways | shared transport plugin | plugin slot ready; vendor payload mapping required |
| Serial/USB readers and writers | local bridge plugin | stdin/JSON Lines bridge ready |
| Android handhelds | mobile vendor plugin | SDK contract ready; vendor SDK and device required |
| Proprietary vendor SDK | vendor-specific plugin | template ready; vendor SDK and device required |

`simulate` and `stdin` are fully working reference plugins. A family being listed
does not claim that every model in that family has been field-certified.

## Required module exports

```js
export const manifest = {
  id: "vendor-model",
  name: "Vendor Model",
  version: "1.0.0",
  apiVersion: 1,
  transports: ["llrp"],
  deviceTypes: ["fixed_reader"],
  rf: {
    emitsRf: true,
    supportedRegions: ["FCC_US", "ETSI_TR"]
  }
};

export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["host", "regulatoryRegion"],
  properties: {
    host: { type: "string" },
    port: { type: "integer", minimum: 1 },
    regulatoryRegion: {
      type: "string",
      enum: ["FCC_US", "ETSI_TR"]
    }
  }
};

export async function createAdapter({ config, input, now }) {
  return {
    async *reads() {},
    health() {
      return { readerConnected: true, lastError: null };
    },
    async close() {}
  };
}
```

RF yayan adaptörlerde bölge zorunludur. Adaptör, `regulatoryRegion` değerini
üretici SDK'sındaki karşılığına çevirip RF yayınını açmadan önce cihaza
uygulamalıdır. ABD otellerinde `FCC_US`, Türkiye kodlama istasyonunda
`ETSI_TR` kullanılır. Diğer Amerika ülkeleri ayrıca tanımlanmadan `FCC_US`
olarak kabul edilmez.

Each yielded read must contain an EPC and may contain stable `eventId`,
`observedAt`, `rssi` and `antenna`. The SDK normalizes EPC casing and validates
every observation before it reaches the encrypted offline queue.

## Loading a plugin

Built-in adapter:

```powershell
npm run gateway:simulate
```

External module:

```powershell
$env:REGULATORY_REGION='FCC_US'
$env:ADAPTER_CONFIG='{"host":"192.168.1.50","port":5084}'
node src/gateway/cli.js .\adapters\vendor-reader.js
```

The module path is explicit; the Gateway does not download or execute adapters
from the network.

## Certification

Run the contract test before hardware qualification:

```powershell
npm run adapter:test -- simulate
npm run adapter:test -- .\adapters\vendor-reader.js .\reader-config.json
```

The conformance tool verifies manifest/API compatibility, configuration,
instantiation, normalized unique events and health telemetry. Passing this test
proves software contract compatibility, not RF performance. Real models must
also pass reconnect, outage, throughput, antenna and site-calibration tests in
the hardware pilot runbook.

Start new vendor work from
`examples/adapters/vendor-template.js`.
