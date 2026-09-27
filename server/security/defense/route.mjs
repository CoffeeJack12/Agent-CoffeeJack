/**
 * Route / DNS / proxy diagnostics. Observations only.
 */

import { promises as dns } from "node:dns";
import { securityResult } from "../evidence.mjs";
import { parseHost } from "./authorized.mjs";

export async function defaultLookup(name, type = "A") {
  if (type === "AAAA") return dns.resolve6(name);
  if (type === "TXT") return dns.resolveTxt(name);
  return dns.resolve4(name);
}

export async function testDns({
  name,
  lookup,
  recordTypes = ["A", "AAAA"],
} = {}) {
  const qname = String(name || "").trim();
  if (!qname) {
    return securityResult({
      tool: "security_dns_test",
      error: "DNS name is required.",
      observed: { name: qname },
    });
  }
  if (typeof lookup !== "function") {
    return securityResult({
      tool: "security_dns_test",
      available: false,
      error: "DNS resolver is not configured.",
      observed: { name: qname },
    });
  }
  const chain = [];
  try {
    for (const type of recordTypes.slice(0, 6)) {
      const answers = await lookup(qname, type);
      chain.push({
        type,
        answers: (Array.isArray(answers) ? answers : [answers])
          .filter(Boolean)
          .map((a) => (typeof a === "string" ? a : a.address || a.data || String(a)))
          .slice(0, 16),
      });
    }
    const addresses = chain.flatMap((c) => c.answers);
    return securityResult({
      tool: "security_dns_test",
      observed: {
        name: qname,
        resolved: addresses.length > 0,
        chain,
        addresses,
      },
      expected: ["At least one A or AAAA answer"],
      mismatch: addresses.length ? [] : ["No DNS answers were returned."],
      possibleCause: addresses.length
        ? []
        : ["The name does not exist, the resolver timed out, or a local filter blocked DNS."],
      recommendedRemediation: addresses.length
        ? []
        : ["Retry against a known resolver and compare the answer chain."],
    });
  } catch (error) {
    return securityResult({
      tool: "security_dns_test",
      observed: {
        name: qname,
        resolved: false,
        reason: error.code || error.message,
        chain,
      },
      expected: ["Successful DNS resolution"],
      mismatch: [`DNS lookup failed (${error.code || error.message})`],
      possibleCause: [
        error.code === "ENOTFOUND"
          ? "The name was not found."
          : "Resolver failure or timeout.",
      ],
      recommendedRemediation: ["Verify the name, then test the configured resolver."],
    });
  }
}

export function analyzeRoute({
  target,
  hops = [],
  gateway = null,
  interfaceName = null,
  mtu = null,
  proxy = null,
} = {}) {
  const parsed = parseHost(target);
  const hopList = (hops || []).slice(0, 40).map((h, i) => ({
    ttl: h.ttl ?? i + 1,
    address: h.address || null,
    rttMs: h.rttMs ?? null,
    timeout: Boolean(h.timeout),
  }));
  const timeouts = hopList.filter((h) => h.timeout);
  const last = hopList.filter((h) => h.address).at(-1) || null;
  const mtuSymptom =
    Boolean(mtu) && Number(mtu) < 1280
      ? `Configured MTU ${mtu} is below 1280.`
      : hopList.some((h) => /frag|mtu|too big/i.test(String(h.note || "")))
        ? "A hop reported a fragmentation or MTU-related note."
        : null;
  return securityResult({
    tool: "security_route_trace",
    observed: {
      target: parsed?.host || target,
      gateway,
      interfaceName,
      mtu,
      proxy: proxy
        ? { present: true, url: String(proxy).slice(0, 180) }
        : { present: false },
      hops: hopList,
      lastHop: last,
    },
    expected: ["A path from this host to the target"],
    mismatch: timeouts.length
      ? [`${timeouts.length} hop(s) timed out.`]
      : [],
    possibleCause: [
      mtuSymptom,
      timeouts.length
        ? "Timeouts may be ICMP filtering rather than a broken route."
        : null,
      proxy?.present || proxy
        ? "An HTTP(S) proxy is configured; application traffic may not follow this hop list."
        : null,
    ].filter(Boolean),
    recommendedRemediation: mtuSymptom
      ? ["Compare path MTU with the observed hop that reported fragmentation."]
      : [],
    unverified: [
      "A missing hop is not proof of a firewall deny. Many networks drop TTL-exceeded messages.",
    ],
  });
}

export function detectProxy(env = process.env) {
  const url =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    null;
  return url ? { present: true, url: String(url).slice(0, 180) } : { present: false };
}
