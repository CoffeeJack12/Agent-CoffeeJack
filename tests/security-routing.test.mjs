/**
 * Deterministic security-tool routing: explicit paths, tool locking,
 * stale-context isolation, and tool-output attribution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAuthoritativeSecurityTool,
  filterToolsForTurn,
  resolveTurnContext,
} from "../server/conversation-intent.mjs";
import {
  classifySecurityIntent,
  extractSecurityFileTarget,
  formatSecurityToolFailure,
} from "../server/security/index.mjs";
import {
  formatFinalOutputContract,
  rewriteUserProvidedToolSpeech,
} from "../server/conversation-style.mjs";
import { toolFeedback } from "../server/agent.mjs";
import { guardResponse, newTaskState } from "../server/task-state.mjs";

const NOTEPAD = "C:\\Windows\\System32\\notepad.exe";
const QUOTED_APP = "C:\\Program Files\\App\\foo.exe";
const KERNEL = "C:\\Windows\\System32\\kernel32.dll";
const SYS = "C:\\Windows\\System32\\ntoskrnl.sys";
const SAMPLE = "C:\\test\\sample.exe";
const LAB = "C:\\lab\\target.exe";

const OFFERED = [
  "security_binary_inspect",
  "security_strings",
  "security_process_inspect",
  "security_network_snapshot",
  "security_yara_scan",
  "security_decompile",
  "security_firewall_inspect",
  "security_lab",
  "terminal",
  "research",
].map((name) => ({ function: { name } }));

function names(defs) {
  return defs.map((d) => d.function.name);
}

test("1 unquoted Windows EXE path", () => {
  const hit = extractSecurityFileTarget(`Analyze ${NOTEPAD}`);
  assert.equal(hit.path, NOTEPAD);
  assert.equal(hit.extension, ".exe");
  assert.equal(hit.explicit, true);
});

test("2 quoted Windows path with spaces", () => {
  const hit = extractSecurityFileTarget(`Analyze "${QUOTED_APP}"`);
  assert.equal(hit.path, QUOTED_APP);
  assert.equal(hit.extension, ".exe");
  assert.match(hit.path, /Program Files/);
  assert.match(hit.path, /\\/);
});

test("3 DLL path", () => {
  const hit = extractSecurityFileTarget(`Inspect ${KERNEL}`);
  assert.equal(hit.path, KERNEL);
  assert.equal(hit.extension, ".dll");
});

test("4 SYS path", () => {
  const hit = extractSecurityFileTarget(`Inspect ${SYS}`);
  assert.equal(hit.path, SYS);
  assert.equal(hit.extension, ".sys");
});

test("5 explicit binary path maps to binary inspector", () => {
  const cases = [
    `Analyze ${NOTEPAD}`,
    `Analyze "${QUOTED_APP}"`,
    `Inspect ${KERNEL}`,
    `Analyze this file ${SAMPLE}`,
    `Reverse engineer ${LAB}`,
  ];
  for (const text of cases) {
    const intent = classifySecurityIntent(text);
    assert.equal(intent?.tool, "security_binary_inspect", text);
    assert.equal(intent?.kind, "security_binary_inspect", text);
    assert.equal(resolveTurnContext(text).taskHint, "security_binary_inspect", text);
  }
});

test("6 exact backslashes/path preserved", () => {
  const text = `Analyze ${NOTEPAD}`;
  const hit = extractSecurityFileTarget(text);
  const intent = classifySecurityIntent(text);
  assert.equal(hit.path, NOTEPAD);
  assert.equal(intent.argsHint.path, NOTEPAD);
  assert.match(intent.directive, /Target file:\nC:\\Windows\\System32\\notepad\.exe/);
  assert.doesNotMatch(hit.path, /\//);
  assert.equal(hit.path.includes("\\"), true);
});

test("7-10 binary request offers only binary inspector", () => {
  const turn = resolveTurnContext(`Analyze ${NOTEPAD}`);
  const filtered = names(filterToolsForTurn(OFFERED, turn));
  assert.deepEqual(filtered, ["security_binary_inspect"]);
  assert.equal(filtered.includes("security_process_inspect"), false);
  assert.equal(filtered.includes("security_network_snapshot"), false);
  assert.equal(filtered.includes("terminal"), false);
  assert.equal(filtered.includes("security_lab"), false);
  assert.equal(filtered.includes("security_firewall_inspect"), false);
});

test("11 stale prior network reply cannot override new binary target", () => {
  const turn = resolveTurnContext(`Analyze ${NOTEPAD}`, {
    history: [
      { role: "user", content: "Show network connections" },
      {
        role: "assistant",
        content:
          "TCP 127.0.0.1:3210 is listening. chrome.exe has several established connections.",
      },
    ],
    previousTopic: "network connections",
    previousSecurityTarget: { tool: "security_network_snapshot" },
  });
  assert.equal(turn.securityIntent.tool, "security_binary_inspect");
  assert.equal(turn.securityIntent.argsHint.path, NOTEPAD);
  assert.equal(turn.canonicalTopic, NOTEPAD);
  assert.equal(turn.resetTaskState, true);
  assert.equal(turn.snapshot.lastAssistant, "");
  assert.doesNotMatch(turn.threadContext || "", /TCP 127\.0\.0\.1/);
  assert.doesNotMatch(JSON.stringify(turn.snapshot), /chrome\.exe/);
});

test("12 stale prior process target cannot override new binary target", () => {
  const turn = resolveTurnContext(`Analyze ${NOTEPAD}`, {
    history: [
      { role: "user", content: "Inspect PID 1234" },
      { role: "assistant", content: "Process 1234 is svchost.exe." },
    ],
    previousTopic: "PID 1234",
    previousSecurityTarget: {
      tool: "security_process_inspect",
      pid: 1234,
    },
  });
  assert.equal(turn.securityIntent.tool, "security_binary_inspect");
  assert.equal(turn.securityIntent.argsHint.path, NOTEPAD);
  assert.equal(turn.securityIntent.argsHint.pid, undefined);
  assert.equal(turn.canonicalTopic, NOTEPAD);
});

test("13 follow-up show its imports may reuse active binary target", () => {
  const turn = resolveTurnContext("show its imports", {
    previousSecurityTarget: { path: NOTEPAD, tool: "security_binary_inspect" },
    history: [
      { role: "user", content: `Analyze ${NOTEPAD}` },
      { role: "assistant", content: "PE32+ inspection of notepad.exe." },
    ],
  });
  assert.equal(turn.securityIntent.tool, "security_binary_inspect");
  assert.equal(turn.securityIntent.argsHint.path, NOTEPAD);
  assert.match(turn.directive, /C:\\Windows\\System32\\notepad\.exe/);
});

test("14 failed binary inspection does not trigger unrelated security tools", () => {
  const turn = resolveTurnContext(`Analyze ${NOTEPAD}`);
  const forced = applyAuthoritativeSecurityTool(
    {
      tool_calls: [
        {
          function: {
            name: "security_process_inspect",
            arguments: { name: "notepad.exe" },
          },
        },
        {
          function: {
            name: "security_network_snapshot",
            arguments: {},
          },
        },
      ],
    },
    turn.securityIntent,
  );
  assert.equal(forced.tool_calls.length, 1);
  assert.equal(forced.tool_calls[0].function.name, "security_binary_inspect");
  assert.equal(forced.tool_calls[0].function.arguments.path, NOTEPAD);
  const filtered = names(filterToolsForTurn(OFFERED, turn));
  assert.deepEqual(filtered, ["security_binary_inspect"]);
  assert.match(
    formatSecurityToolFailure("security_binary_inspect", "file not found"),
    /^Binary inspection failed: file not found\.$/,
  );
});

test("15 tool output is not described as user-provided data", () => {
  const rewritten = rewriteUserProvidedToolSpeech(
    "The data you've provided appears to be a list of network connections. I will use your network data.",
  );
  assert.doesNotMatch(rewritten, /data you(?:'ve)? provided/i);
  assert.doesNotMatch(rewritten, /your network data/i);
  assert.match(rewritten, /inspection returned|observed network snapshot/i);
  const contract = formatFinalOutputContract({ language: "en" });
  assert.match(contract, /Tool results are Jack's observations/);
  assert.match(contract, /the data you provided/);
  const feedback = JSON.parse(
    toolFeedback({ observed: { listeningTcp: [] } }, "security_network_snapshot"),
  );
  assert.match(feedback._attribution, /not user-authored/i);
  const guarded = guardResponse(
    newTaskState(),
    "The output you gave me shows chrome.exe connections.",
  );
  assert.doesNotMatch(guarded.text, /output you gave me/i);
  assert.match(guarded.text, /tool reported/i);
});

test("16 normal process request still uses process inspector", () => {
  const pid = classifySecurityIntent("Inspect PID 1234");
  assert.equal(pid.tool, "security_process_inspect");
  assert.equal(pid.argsHint.pid, 1234);
  const named = classifySecurityIntent("inspect this process");
  assert.equal(named.tool, "security_process_inspect");
  const turn = resolveTurnContext("Inspect PID 1234");
  assert.deepEqual(names(filterToolsForTurn(OFFERED, turn)), [
    "security_process_inspect",
  ]);
});

test("17 normal network request still uses network snapshot", () => {
  const intent = classifySecurityIntent("Show network connections");
  assert.equal(intent.tool, "security_network_snapshot");
  const turn = resolveTurnContext("Show network connections");
  assert.equal(turn.taskHint, "security_network_snapshot");
  assert.deepEqual(names(filterToolsForTurn(OFFERED, turn)), [
    "security_network_snapshot",
  ]);
});
