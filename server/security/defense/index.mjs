/**
 * Defensive firewall / network-control assessment.
 * Read-only by default. Rule changes are explicit mutations.
 */

import path from "node:path";
import { securityResult } from "../evidence.mjs";
import {
  createFirewallRuleStore,
  inspectFirewallPolicy,
  listFirewallRules,
  normalizePolicy,
} from "./firewall.mjs";
import { defaultTcpConnect, testPorts } from "./connect.mjs";
import { analyzeRoute, defaultLookup, detectProxy, testDns } from "./route.mjs";
import { inspectTlsTarget, inspectCertificatePem, inspectTlsHandshake } from "./tls.mjs";
import { evaluateSegmentation } from "./segmentation.mjs";
import { runWafTests } from "./waf.mjs";
import { validateIds } from "./ids.mjs";
import { mapServices } from "./service-map.mjs";
import { assertAuthorizedTarget } from "./authorized.mjs";

export const DEFENSE_TOOLS = Object.freeze([
  "security_firewall_inspect",
  "security_firewall_rules",
  "security_port_test",
  "security_route_trace",
  "security_dns_test",
  "security_tls_inspect",
  "security_segmentation_test",
  "security_waf_test",
  "security_ids_validation",
  "security_service_map",
]);

export const DEFENSE_AUDIT = Object.freeze({
  security_firewall_inspect: "security_firewall_inspected",
  security_firewall_rules_read: "security_firewall_rules_read",
  security_firewall_rules_changed: "security_firewall_rules_changed",
  security_port_test: "security_port_tested",
  security_route_trace: "security_route_traced",
  security_dns_test: "security_dns_tested",
  security_tls_inspect: "security_tls_inspected",
  security_segmentation_test: "security_segmentation_tested",
  security_waf_test: "security_waf_tested",
  security_ids_validation: "security_ids_validated",
  security_service_map: "security_service_mapped",
});

export const FIREWALL_MUTATIONS = Object.freeze([
  "add",
  "remove",
  "enable",
  "disable",
  "rollback",
]);

export function isFirewallMutation(args = {}) {
  return FIREWALL_MUTATIONS.includes(String(args.action || "").toLowerCase());
}

export function classifyDefenseIntent(text = "") {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/firewall rules?|list firewall|show firewall rules/i.test(t)) {
    return intent(
      "security_firewall_rules",
      "List or inspect Windows Firewall rules.",
    );
  }
  if (/inspect (?:the )?firewall|windows firewall|firewall (?:status|policy|profiles)/i.test(t)) {
    return intent(
      "security_firewall_inspect",
      "Read-only Windows Firewall profile and policy inspection.",
    );
  }
  if (/test (?:this )?port|is port \d+|port (?:open|reachable)|check port/i.test(t)) {
    return intent("security_port_test", "Bounded TCP/UDP reachability test.");
  }
  if (/trace ?route|path to |route (?:to|trace)|gateway and (?:path|route)/i.test(t)) {
    return intent("security_route_trace", "Route and path diagnostics.");
  }
  if (/dns (?:test|lookup|fail|failure)|resolve (?:this )?host|dns resolution/i.test(t)) {
    return intent("security_dns_test", "DNS resolution chain test.");
  }
  if (/tls inspect|inspect (?:the )?cert|certificate (?:chain|expiry)|https cert/i.test(t)) {
    return intent("security_tls_inspect", "TLS handshake and certificate inspection.");
  }
  if (/segmentation|can .+ reach|expected (?:allow|deny)|reachability matrix/i.test(t)) {
    return intent(
      "security_segmentation_test",
      "Compare intended segmentation with observed reachability.",
    );
  }
  if (/\bwaf\b|web application firewall/i.test(t)) {
    return intent(
      "security_waf_test",
      "Benign WAF checks against an Owner-authorized target only.",
    );
  }
  if (/\bids\b|\bips\b|ids validation|synthetic (?:ids|canary)/i.test(t)) {
    return intent(
      "security_ids_validation",
      "Safe synthetic IDS/IPS canary. No attack payloads.",
    );
  }
  if (/service map|what is listening|listening services|map (?:local )?services/i.test(t)) {
    return intent("security_service_map", "Map local listening services.");
  }
  return null;
}

function intent(tool, effectiveIntent) {
  return {
    kind: tool,
    tool,
    effectiveIntent,
    directive: [
      "NETWORK DEFENSE TURN.",
      `Call ${tool}. Do not use terminal first.`,
      "Use observed / expected / mismatch / possible cause / recommended remediation labels.",
      "Do not claim a host is safe, clean, or compromised.",
    ].join("\n"),
  };
}

export function createDefenseToolkit({
  dataDirectory,
  user,
  adapters = {},
  allowlist = [],
} = {}) {
  const store = adapters.firewallStore
    || createFirewallRuleStore({
      initial: adapters.firewallPolicy,
      runner: adapters.firewallRunner,
    });
  const authorized = allowlist.length
    ? allowlist
    : adapters.authorizedTargets || [];

  return {
    async execute(name, args = {}) {
      if (name === "security_firewall_inspect") {
        if (args.policy || !adapters.firewallRunner) {
          return inspectFirewallPolicy(args.policy || store.snapshot(), args);
        }
        return store.inspect(args);
      }
      if (name === "security_firewall_rules") {
        const action = String(args.action || "list").toLowerCase();
        if (action === "list" || action === "inspect" || action === "export") {
          return args.policy
            ? listFirewallRules(args.policy, args)
            : store.list(args);
        }
        if (action === "backup") {
          const id = store.backup("export");
          return securityResult({
            tool: "security_firewall_rules",
            observed: { action: "backup", backupId: id, backups: store.backups() },
          });
        }
        if (isFirewallMutation(args)) {
          return store.mutate({
            action,
            rule: args.rule,
            backupId: args.backupId,
            verify: adapters.verifyChange,
          });
        }
        return securityResult({
          tool: "security_firewall_rules",
          error: "Unknown firewall rules action.",
          observed: { action },
        });
      }
      if (name === "security_port_test") {
        return testPorts({
          host: args.host,
          ports: args.ports || args.port,
          protocol: args.protocol,
          timeoutMs: args.timeoutMs,
          connect: adapters.connect || defaultTcpConnect,
        });
      }
      if (name === "security_dns_test") {
        return testDns({
          name: args.name || args.host,
          lookup: adapters.lookup || defaultLookup,
          recordTypes: args.recordTypes,
        });
      }
      if (name === "security_route_trace") {
        const hops = typeof adapters.trace === "function"
          ? await adapters.trace(args)
          : args.hops || [];
        return analyzeRoute({
          target: args.target || args.host,
          hops: hops.hops || hops,
          gateway: hops.gateway || args.gateway,
          interfaceName: hops.interfaceName || args.interfaceName,
          mtu: hops.mtu || args.mtu,
          proxy: args.proxy || detectProxy(),
        });
      }
      if (name === "security_tls_inspect") {
        if (args.pem) {
          return inspectTlsHandshake({
            host: args.host,
            port: args.port,
            certificates: [args.pem],
            protocol: args.protocol,
            cipher: args.cipher,
          });
        }
        return inspectTlsTarget({
          host: args.host,
          port: args.port,
          sni: args.sni,
          connect: adapters.tlsConnect,
        });
      }
      if (name === "security_segmentation_test") {
        return evaluateSegmentation({
          intended: args.intended,
          observed: args.observed,
        });
      }
      if (name === "security_waf_test") {
        return runWafTests({
          target: args.target,
          allowlist: args.allowlist || authorized,
          http: adapters.http,
          tests: args.tests,
        });
      }
      if (name === "security_ids_validation") {
        return validateIds({
          testId: args.testId,
          target: args.target,
          allowlist: args.allowlist || authorized,
          send: adapters.idsSend,
          detector: adapters.idsDetector,
        });
      }
      if (name === "security_service_map") {
        const listeners = typeof adapters.listeners === "function"
          ? await adapters.listeners()
          : args.listeners || [];
        return mapServices({
          listeners,
          processes: args.processes || [],
          tls: args.tls || [],
          banners: args.banners || [],
        });
      }
      throw new Error(`Unknown defense tool: ${name}`);
    },
    authorizedDir: dataDirectory
      ? path.join(dataDirectory, "security", "defense", String(user?.id || "local"))
      : null,
    assertAuthorized: (target) => assertAuthorizedTarget(target, authorized),
    store,
  };
}

export {
  inspectFirewallPolicy,
  listFirewallRules,
  normalizePolicy,
  testPorts,
  testDns,
  analyzeRoute,
  inspectTlsHandshake,
  inspectCertificatePem,
  evaluateSegmentation,
  runWafTests,
  validateIds,
  mapServices,
};
