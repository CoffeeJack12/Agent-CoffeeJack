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
export function applyLegacyOwnerAutoApprove(decision, user, autoApprove) {
  if (
    autoApprove === true &&
    user?.role === "owner" &&
    decision?.decision === "require_approval"
  )
    return result("allow", "Temporary owner auto-approval compatibility");
  return decision;
}
