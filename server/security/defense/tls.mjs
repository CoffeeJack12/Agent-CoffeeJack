/**
 * TLS certificate / handshake inspection. Does not claim a host is safe.
 */

import { X509Certificate } from "node:crypto";
import { securityResult } from "../evidence.mjs";

export function inspectCertificatePem(pem, { host = null, now = Date.now() } = {}) {
  const cert = new X509Certificate(pem);
  const validFrom = Date.parse(cert.validFrom);
  const validTo = Date.parse(cert.validTo);
  const expired = Number.isFinite(validTo) && now > validTo;
  const notYet = Number.isFinite(validFrom) && now < validFrom;
  let hostnameOk = null;
  let hostnameError = null;
  if (host) {
    try {
      hostnameOk = cert.checkHost(host) != null;
    } catch (error) {
      hostnameOk = false;
      hostnameError = error.message;
    }
  }
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    serialNumber: cert.serialNumber,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    expired,
    notYetValid: notYet,
    hostnameOk,
    hostnameError,
    fingerprint256: cert.fingerprint256,
    subjectAltName: cert.subjectAltName || null,
  };
}

export function inspectTlsHandshake({
  host,
  port = 443,
  sni = null,
  protocol = null,
  cipher = null,
  certificates = [],
  authorized = null,
  error = null,
  now = Date.now(),
} = {}) {
  const chain = (certificates || []).slice(0, 8).map((pem) => {
    try {
      return inspectCertificatePem(pem, { host, now });
    } catch (err) {
      return { error: err.message };
    }
  });
  const leaf = chain[0] || null;
  const mismatch = [];
  if (error) mismatch.push(`Handshake failed: ${error}`);
  if (leaf?.expired) mismatch.push("Leaf certificate is expired.");
  if (leaf && leaf.hostnameOk === false)
    mismatch.push("Hostname does not match the leaf certificate.");
  if (authorized === false) mismatch.push("Chain was not trusted by the local store.");
  return securityResult({
    tool: "security_tls_inspect",
    observed: {
      host,
      port,
      sni: sni || host,
      protocol,
      cipher,
      authorized,
      handshakeError: error || null,
      chain,
      leaf,
    },
    expected: ["Completed TLS handshake with a host-matching, unexpired leaf certificate"],
    mismatch,
    possibleCause: error
      ? ["Protocol mismatch, an intercepting proxy, or the service is not speaking TLS."]
      : leaf?.expired
        ? ["The certificate validity window has ended."]
        : [],
    recommendedRemediation: mismatch.length
      ? ["Compare SNI, hostname, and expiry with the intended certificate."]
      : [],
    unverified: [
      "Trust-store validation is reported only when the handshake adapter supplied it.",
    ],
  });
}

export async function inspectTlsTarget({
  host,
  port = 443,
  sni,
  connect,
  now,
} = {}) {
  if (typeof connect !== "function") {
    return securityResult({
      tool: "security_tls_inspect",
      available: false,
      error: "TLS connector is not configured.",
      observed: { host, port },
    });
  }
  try {
    const handshake = await connect({ host, port, sni: sni || host });
    return inspectTlsHandshake({ host, port, sni: sni || host, now, ...handshake });
  } catch (error) {
    return inspectTlsHandshake({
      host,
      port,
      sni: sni || host,
      now,
      error: error.code || error.message,
    });
  }
}
