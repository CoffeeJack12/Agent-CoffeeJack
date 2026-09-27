/**
 * Owner-configured authorized targets for defensive WAF/IDS tests.
 * No implicit public-internet scanning.
 */

export function parseHost(input) {
  const raw = String(input || "").trim();
  if (!raw || raw.includes("\0")) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const url = new URL(raw);
      return {
        protocol: url.protocol.replace(":", ""),
        host: url.hostname.toLowerCase(),
        port: url.port ? Number(url.port) : null,
        href: url.href,
      };
    }
  } catch {
    return null;
  }
  const m = raw.match(/^(\[[^\]]+\]|[^:\/]+)(?::(\d+))?$/);
  if (!m) return null;
  return {
    protocol: null,
    host: m[1].replace(/^\[|\]$/g, "").toLowerCase(),
    port: m[2] ? Number(m[2]) : null,
    href: raw,
  };
}

export function hostsMatch(allowed, host) {
  const a = String(allowed || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const h = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!a || !h) return false;
  return a === h || a === `*.${h}` || (a.startsWith("*.") && h.endsWith(a.slice(1)));
}

export function assertAuthorizedTarget(target, allowlist = []) {
  const parsed = parseHost(target);
  if (!parsed?.host) {
    return { ok: false, error: "Invalid target.", parsed: null };
  }
  const list = Array.isArray(allowlist) ? allowlist : [];
  const allowed = list.some((entry) => {
    const item = typeof entry === "string" ? parseHost(entry) : entry;
    return hostsMatch(item?.host || entry, parsed.host);
  });
  if (!allowed) {
    return {
      ok: false,
      error:
        "Target is not on the Owner authorized allowlist. Defensive WAF/IDS tests run only against explicitly configured hosts.",
      parsed,
    };
  }
  return { ok: true, parsed };
}

export function looksLikeEvasion(value = "") {
  return /(?:\.\.|%2e|%00|%2f|%5c|<script|union\s+select|'\s*or\s+'|\$\{|bypass|evas(?:ion)?|cmd=|\/etc\/passwd|\.\.\/)/i.test(
    String(value || ""),
  );
}
