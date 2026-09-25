/**
 * Local vs remote trust classification.
 * Never trust X-Forwarded-* / spoofed Host / CF email headers as proof of locality.
 * A Cloudflare Tunnel hop that reaches 127.0.0.1 must not become "local owner".
 */

export function hasCloudflareForwardingMarkers(req) {
  const h = req?.headers || {};
  return Boolean(
    h["cf-access-jwt-assertion"] ||
      h["cf-ray"] ||
      h["cf-connecting-ip"] ||
      h["cf-visitor"] ||
      h["cf-ipcountry"] ||
      h["cf-access-authenticated-user-email"] ||
      h["cf-access-authenticated-user-id"],
  );
}

export function hostnameFromHostHeader(hostHeader = "") {
  return String(hostHeader).split(":")[0].trim().toLowerCase();
}

/**
 * @returns {{ mode: 'local'|'remote', reason: string, loopbackHost: boolean }}
 */
export function classifyRequest(
  req,
  { accessHostname = null, accessConfigured = false } = {},
) {
  const hostHeader = String(req?.headers?.host || "");
  const hostname = hostnameFromHostHeader(hostHeader);
  const loopbackHost = hostname === "127.0.0.1" || hostname === "localhost";
  const configured =
    accessHostname &&
    hostname === String(accessHostname).trim().toLowerCase();

  // Configured public hostname is always remote — never local bootstrap.
  if (configured) {
    return { mode: "remote", reason: "configured_hostname", loopbackHost };
  }

  // Tunnel/proxy markers on loopback: fail into remote path.
  // Only when remote auth is configured — local-only spoofed CF headers
  // must not flip classification or block Owner bootstrap.
  if (loopbackHost && accessConfigured && hasCloudflareForwardingMarkers(req)) {
    return {
      mode: "remote",
      reason: "cloudflare_markers_on_loopback",
      loopbackHost,
    };
  }

  // Direct browser on loopback without CF markers → local owner bootstrap OK.
  if (loopbackHost) {
    return { mode: "local", reason: "direct_loopback", loopbackHost };
  }

  // Any other Host is remote (and will be rejected unless it matches access).
  return { mode: "remote", reason: "non_loopback_host", loopbackHost };
}

/** Origin expected for CORS / Origin checks. */
export function expectedOrigin(req, { mode, accessHostname }) {
  const host = String(req?.headers?.host || "");
  if (mode === "local") return "http://" + host;
  const hostname = accessHostname || hostnameFromHostHeader(host);
  return "https://" + hostname;
}
