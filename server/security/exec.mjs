/**
 * Bounded spawn helper for optional security adapters.
 * Never uses a shell. Never executes the inspected target as a program.
 */

import { spawn } from "node:child_process";

export function safeToken(value, { max = 80, extra = "" } = {}) {
  const s = String(value || "").slice(0, max);
  const re = extra
    ? new RegExp(`^[A-Za-z0-9_@.$+\\-:${extra}]+$`)
    : /^[A-Za-z0-9_@.$+\-:]+$/;
  return re.test(s) ? s : null;
}

export function runCommand(command, args, { timeout = 45000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const winBat =
        process.platform === "win32" &&
        /\.(bat|cmd)$/i.test(String(command || ""));
      child = winBat
        ? spawn(process.env.ComSpec || "cmd.exe", ["/c", command, ...args], {
            cwd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(command, args, {
            cwd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
    } catch (error) {
      resolve({
        code: 1,
        output: String(error?.message || error).slice(0, 4000),
      });
      return;
    }
    let output = "";
    const collect = (chunk) => {
      if (output.length < 40000)
        output += chunk.toString().slice(0, 40000 - output.length);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeout);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: 1,
        output: String(error?.message || error).slice(0, 4000),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}
