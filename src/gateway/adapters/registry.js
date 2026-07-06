import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { instantiateAdapter, validateAdapterModule } from "./sdk.js";

const BUILT_INS = {
  simulate: () => import("./simulate.js"),
  stdin: () => import("./stdin.js")
};

export const ADAPTER_FAMILIES = [
  {
    family: "llrp",
    deviceTypes: ["fixed_reader"],
    integration: "shared_protocol_plugin",
    status: "plugin_required",
    configFields: ["host", "port", "antennas", "regulatoryRegion"]
  },
  {
    family: "mqtt",
    deviceTypes: ["fixed_reader", "gateway"],
    integration: "shared_transport_plugin",
    status: "plugin_required",
    configFields: ["brokerUrl", "topic", "qos", "tls", "regulatoryRegion"]
  },
  {
    family: "http",
    deviceTypes: ["fixed_reader", "gateway"],
    integration: "shared_transport_plugin",
    status: "plugin_required",
    configFields: ["endpoint", "auth", "mapping", "regulatoryRegion"]
  },
  {
    family: "serial-usb",
    deviceTypes: ["desktop_reader", "desktop_writer"],
    integration: "local_bridge_plugin",
    status: "plugin_required",
    configFields: ["port", "baudRate", "mapping", "regulatoryRegion"]
  },
  {
    family: "android-sdk",
    deviceTypes: ["handheld"],
    integration: "mobile_vendor_plugin",
    status: "vendor_sdk_required",
    configFields: ["vendor", "sdkVersion", "mapping", "regulatoryRegion"]
  },
  {
    family: "vendor-sdk",
    deviceTypes: ["fixed_reader", "handheld", "writer"],
    integration: "vendor_plugin",
    status: "vendor_sdk_required",
    configFields: ["vendor", "model", "sdkVersion", "regulatoryRegion"]
  }
];

export async function loadAdapterModule(specifier) {
  if (BUILT_INS[specifier]) return validateAdapterModule(await BUILT_INS[specifier]());
  if (!specifier) throw new Error("Adapter id or module path is required");
  const moduleUrl = pathToFileURL(resolve(specifier)).href;
  return validateAdapterModule(await import(moduleUrl));
}

export async function loadAdapter(specifier, options) {
  const module = await loadAdapterModule(specifier);
  return instantiateAdapter(module, options);
}

export async function adapterCatalog() {
  const builtIns = [];
  for (const [id, load] of Object.entries(BUILT_INS)) {
    const module = validateAdapterModule(await load());
    builtIns.push({ ...module.manifest, builtIn: true, status: "ready" });
  }
  return { builtIns, families: ADAPTER_FAMILIES };
}
