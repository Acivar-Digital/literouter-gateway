import { loadLocationConfig } from "../src/config/location";

export function getTestGatewayUrl(): string {
  if (process.env.LITEROUTER_BASE_URL) {
    return process.env.LITEROUTER_BASE_URL.replace(/\/+$/, "");
  }

  try {
    const loc = loadLocationConfig();
    if (loc.testing?.test_base_url) {
      return loc.testing.test_base_url.replace(/\/+$/, "");
    }
    const testPort = loc.testing?.test_port ?? 7767;
    const proto = loc.tls_enabled ? "https" : "http";
    return `${proto}://${loc.host}:${testPort}`;
  } catch {
    return "http://127.0.0.1:7767";
  }
}
