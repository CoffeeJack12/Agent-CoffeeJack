const CAPABILITIES = new Set([
  "chat",
  "web_search",
  "research",
  "browser",
  "files_read",
  "files_write",
  "terminal_safe",
  "terminal_sensitive",
  "git_read",
  "git_write",
  "git_push",
  "desktop_view",
  "desktop_control",
  "system_inspect",
  "install_software",
  "delete_files",
  "outside_workspace",
  "sensitive_settings",
  "user_management",
  "gaming_toggle",
  "self_repair",
  "security_inspect",
  "security_capture",
  "security_firewall_modify",
  "security_lab",
]);

const APPROVAL = new Set([
  "delete_files",
  "outside_workspace",
  "install_software",
  "terminal_sensitive",
  "desktop_control",
  "git_push",
]);

const OWNER_ALLOW = new Set([
  "chat",
  "web_search",
  "research",
  "browser",
  "files_read",
  "files_write",
  "terminal_safe",
  "git_read",
  "git_write",
  "desktop_view",
  "system_inspect",
  "sensitive_settings",
  "user_management",
  "gaming_toggle",
  "self_repair",
  "security_inspect",
]);

const TRUSTED_ALLOW = new Set([
  ...OWNER_ALLOW,
  "gaming_toggle",
]);
TRUSTED_ALLOW.delete("user_management");
TRUSTED_ALLOW.delete("sensitive_settings");

/** Explicit Standard allow-list — does not inherit Owner tools. */
const STANDARD_ALLOW = new Set([
  "chat",
  "research",
  "web_search",
  "files_read",
]);
const STANDARD_APPROVAL = new Set(["files_write"]);

export function standardCapabilityList() {
  return [...STANDARD_ALLOW];
}

/** Public registered accounts must verify email before any AI/tool work. Owner/local bootstrap is unchanged. */
export function publicAccountNeedsVerification(user) {
  if (!user || user.role === "owner") return false;
  return Boolean(user.email) && !user.email_verified;
}

const GUEST_ALLOW = new Set(["chat", "research", "web_search"]);
const GUEST_APPROVAL = new Set(["files_read"]);

function result(decision, reason) {
  return { decision, reason };
}

export function authorize({
  user,
  capability,
  action,
  resource: _resource,
  context = {},
} = {}) {
  if (!user || user.status === "disabled")
    return result("deny", "No active user identity");
  if (!CAPABILITIES.has(capability))
    return result("deny", `Unknown capability: ${capability || "none"}`);
  const roleEarly = String(user.role ?? "").toLowerCase();
  if (capability === "security_capture") {
    if (roleEarly === "owner")
      return result(
        "require_approval",
        "Packet capture requires explicit Owner approval",
      );
    return result("deny", "Packet capture is Owner-only");
  }
  if (capability === "security_inspect") {
    if (roleEarly === "owner")
      return result("allow", "Owner read-only security inspection");
    if (roleEarly === "trusted")
      return result(
        "require_approval",
        "Trusted security inspection requires explicit permission",
      );
    return result(
      "deny",
      "Host-level reverse-engineering tools are unavailable",
    );
  }
  if (capability === "security_firewall_modify") {
    if (roleEarly === "owner")
      return result(
        "require_approval",
        "Firewall rule changes require explicit Owner approval",
      );
    return result("deny", "Firewall rule changes are Owner-only");
  }
  if (capability === "security_lab") {
    const labAction = String(context.labAction || "").toLowerCase();
    if (roleEarly === "owner")
      return result("allow", "Owner adaptive security validation lab");
    if (roleEarly === "trusted") {
      if (["targets_add", "targets_remove", "clear_lessons"].includes(labAction))
        return result(
          "deny",
          "Only Owner can manage authorized targets and lab lessons",
        );
      return result(
        "require_approval",
        "Trusted security lab requires explicit Owner permission",
      );
    }
    return result("deny", "Security Lab is unavailable to this role");
  }
  if (
    capability === "chat" &&
    action === "remember" &&
    context.memoryPack === false
  )
    return result("deny", "Memory capability is disabled for this session");

  const role = String(user.role ?? "").toLowerCase();
  if (role === "owner") {
    if (OWNER_ALLOW.has(capability))
      return result("allow", "Allowed by owner policy");
    if (APPROVAL.has(capability))
      return result("require_approval", "Sensitive owner action requires approval");
  }
  if (role === "trusted") {
    if (TRUSTED_ALLOW.has(capability))
      return result("allow", "Allowed by trusted-user policy");
    if (capability === "sensitive_settings" || APPROVAL.has(capability))
      return result(
        "require_approval",
        "Sensitive trusted-user action requires approval",
      );
  }
  if (role === "standard") {
    if (publicAccountNeedsVerification(user))
      return result("deny", "Email verification required");
    if (STANDARD_ALLOW.has(capability))
      return result("allow", "Allowed by standard-user policy");
    if (STANDARD_APPROVAL.has(capability))
      return result(
        "require_approval",
        "Standard-user action requires owner approval",
      );
    return result("deny", "Capability is unavailable to standard users");
  }
  if (role === "guest") {
    if (GUEST_ALLOW.has(capability))
      return result("allow", "Allowed by guest policy");
    if (GUEST_APPROVAL.has(capability))
      return result("require_approval", "Guest file access requires approval");
    return result("deny", "Capability is unavailable to guests");
  }
  return result("deny", "Unknown user role");
}

function commandText(args) {
  if (typeof args === "string") return args;
  return String(
    args?.command ?? args?.script ?? args?.input ?? args?.args ?? "",
  );
}

function terminalCapability(args) {
  const command = commandText(args);
  if (
    /\b(?:remove-item|del(?:ete)?|erase|rm|rmdir|format|diskpart|shutdown|restart-computer|stop-computer|set-executionpolicy|reg\s+(?:add|delete)|net\s+user|takeown|icacls)\b|(?:^|[\s;&|])(?:rd|kill)\b|--force\b/i.test(
      command,
    )
  )
    return "terminal_sensitive";
  if (
    /(?:^|[\s"'=])(?:[A-Za-z]:\\|\\\\)|\.\.[\\/]|outside[_ -]?workspace/i.test(
      command,
    )
  )
    return "outside_workspace";
  if (/\b(?:npm|pnpm|yarn|winget|choco|scoop|pip)\s+(?:install|add)\b/i.test(command))
    return "install_software";
  return "terminal_safe";
}

export function toolCapability(toolName, args = {}) {
  const name = String(toolName ?? "").toLowerCase();
  if (["read_file", "list_files", "search_code", "project_map", "recall"].includes(name))
    return "files_read";
  if (["write_file", "apply_patch"].includes(name)) return "files_write";
  if (["run_tests", "run_check"].includes(name)) return "terminal_safe";
  if (name === "terminal") return terminalCapability(args);
  if (["git_status", "git_diff", "git_log", "git_show"].includes(name))
    return "git_read";
  if (
    ["git_push", "push"].includes(name) ||
    (name === "git" && /\bpush\b/i.test(commandText(args)))
  )
    return "git_push";
  if (
    (name.startsWith("git_") && name !== "git_push") ||
    (name === "git" && !/\b(?:status|diff|log|show)\b/i.test(commandText(args)))
  )
    return "git_write";
  if (name === "research") return "research";
  if (name === "web_search") return "web_search";
  if (name === "browser") return "browser";
  if (name === "desktop")
    return /^(?:view|screenshot|capture)$/i.test(String(args?.action ?? ""))
      ? "desktop_view"
      : "desktop_control";
  if (name === "inspect_pc") return "system_inspect";
  if (
    [
      "security_binary_inspect",
      "security_strings",
      "security_hash",
      "security_yara_scan",
      "security_process_inspect",
      "security_network_snapshot",
      "security_disassemble",
      "security_decompile",
    ].includes(name)
  )
    return "security_inspect";
  if (
    [
      "security_firewall_inspect",
      "security_port_test",
      "security_route_trace",
      "security_dns_test",
      "security_tls_inspect",
      "security_segmentation_test",
      "security_waf_test",
      "security_ids_validation",
      "security_service_map",
    ].includes(name)
  )
    return "security_inspect";
  if (name === "security_firewall_rules") {
    const action = String(args?.action || "list").toLowerCase();
    if (["add", "remove", "enable", "disable", "rollback"].includes(action))
      return "security_firewall_modify";
    return "security_inspect";
  }
  if (name === "security_packet_capture") return "security_capture";
  if (name === "security_lab") return "security_lab";
  if (name === "remember") return "chat";
  if (["delete_file", "delete_files"].includes(name)) return "delete_files";
  if (name === "gaming_toggle") return "gaming_toggle";
  if (name === "user_management") return "user_management";
  return null;
}

/**
 * Operational consequence for an approval gate.
 * What happens, what changes, whether it can be restored — no moralizing.
 */
export function approvalConsequence(toolName, args = {}) {
  const capability = toolCapability(toolName, args);
  const detail = String(
    args?.path ||
      args?.command ||
      args?.script ||
      args?.action ||
      args?.url ||
      "",
  ).slice(0, 180);
  const labeled = detail ? ` (${detail})` : "";
  switch (capability) {
    case "delete_files":
      return `This deletes the named file(s)${labeled}. They are not automatically restored.`;
    case "terminal_sensitive":
      return `This PowerShell command can change or destroy system state${labeled}. It is not automatically undone.`;
    case "outside_workspace":
      return `This reaches outside the workspace${labeled}. Paths outside the workspace are not automatically restored.`;
    case "install_software":
      return `This installs software on this machine${labeled}. Removal is a separate step.`;
    case "git_push":
      return `This pushes commits to the remote${labeled}. Remote history will change.`;
    case "desktop_control":
      return `This clicks or types on the live Windows desktop${labeled}. The UI changes immediately.`;
    case "files_write":
      return `This writes a workspace file${labeled}. An existing file is backed up first.`;
    case "security_firewall_modify":
      return `This changes Windows Firewall rules${labeled}. The current policy is backed up first. Connectivity may change immediately. Rollback is a separate approved action.`;
    case "security_lab":
      return `This uses the Adaptive Security Validation Lab${labeled}. Tests stay on the Owner-registered target_id. Lessons stay local and never authorize another host.`;
    case "security_capture":
      return args?.includePayload
        ? `This captures live network packets including payloads${labeled}. Captures may contain private data and are stored only under .local/security/captures. They are not automatically deleted.`
        : `This starts a metadata-only network packet capture${labeled}. Packet headers are stored locally. Payloads are not stored unless you separately approve full-payload mode.`;
    default:
      return `This runs ${String(toolName || "the action")}${labeled}. Confirm to proceed.`;
  }
}

export function permissionSummary(user) {
  if (!user) return "No active user permissions.";
  const keys = [
    "chat",
    "web_search",
    "research",
    "browser",
    "files_read",
    "files_write",
    "terminal_safe",
    "git_read",
    "git_write",
    "desktop_control",
    "system_inspect",
    "gaming_toggle",
    "user_management",
    "self_repair",
    "security_inspect",
    "security_capture",
    "security_firewall_modify",
    "security_lab",
  ];
  return keys
    .map((capability) => {
      const { decision } = authorize({ user, capability });
      return `- ${capability}: ${decision.replace("_", " ")}`;
    })
    .join("\n");
}

export function canToggleGaming(user) {
  return authorize({ user, capability: "gaming_toggle" }).decision === "allow";
}

export function canManageUsers(user) {
  return authorize({ user, capability: "user_management" }).decision === "allow";
}

export function canSelfRepair(user) {
  return authorize({ user, capability: "self_repair" }).decision === "allow";
}

/**
 * Temporary compatibility bridge for the legacy global autoApprove setting.
 * It may only turn an owner's require_approval decision into allow.
 */
export function shouldSkipLegacyAutoApprove(toolName, args = {}) {
  if (String(toolName || "") === "security_packet_capture") return true;
  if (String(toolName || "") === "security_firewall_rules") {
    const action = String(args?.action || "").toLowerCase();
    return ["add", "remove", "enable", "disable", "rollback"].includes(action);
  }
  return false;
}

/**
 * Temporary compatibility bridge for the legacy global autoApprove setting.
 * It may only turn an owner's require_approval decision into allow.
 * Packet capture never auto-approves — it needs exact Owner approval.
 */
export function applyLegacyOwnerAutoApprove(
  decision,
  user,
  autoApprove,
  toolName,
  args = {},
) {
  if (shouldSkipLegacyAutoApprove(toolName, args))
    return decision;
  if (
    autoApprove === true &&
    user?.role === "owner" &&
    decision?.decision === "require_approval"
  )
    return result("allow", "Temporary owner auto-approval compatibility");
  return decision;
}
