import test from "node:test";
import assert from "node:assert/strict";
import {
  consultExpert,
  expertStatus,
  isExplicitExpertConsultRequest,
} from "../server/expert-consult.mjs";

function fakeRegistry({ failGoogle = false } = {}) {
  const calls = [];
  return {
    calls,
    refresh: async () => {},
    getProvider(id) {
      return ["google", "groq"].includes(id) ? { id, enabled: true } : null;
    },
    listModels() {
      return [
        { provider: "google", id: "gemini-3.8-flash" },
        { provider: "groq", id: "openai/gpt-oss-120b" },
      ];
    },
    async chat(args) {
      calls.push(args);
      if (failGoogle && args.providerId === "google")
        throw new Error("google unavailable");
      return {
        content:
          args.providerId === "google"
            ? "Check the failing boundary first."
            : "Use the Groq fallback.",
      };
    },
  };
}

test("explicit expert request matcher handles Arabic and English", () => {
  assert.equal(
    isExplicitExpertConsultRequest("استشر خبير واديني أفضل طريقة"),
    true,
  );
  assert.equal(isExplicitExpertConsultRequest("consult an expert about this"), true);
  assert.equal(isExplicitExpertConsultRequest("ask the expert for a second opinion"), true);
  assert.equal(isExplicitExpertConsultRequest("حسن سرعة الردود"), false);
});

test("expert status discovers free providers", () => {
  const registry = fakeRegistry();
  const status = expertStatus(registry);
  assert.equal(status.configured, true);
  assert.equal(status.candidates[0].providerId, "google");
  assert.equal(status.candidates[0].modelId, "gemini-3.8-flash");
});
test("consultExpert sanitizes secrets before a remote call", async () => {
  const registry = fakeRegistry();
  const result = await consultExpert({
    registry,
    task: "Fix login",
    context: "password=super-secret-value",
    attempts: "Bearer abcdefghijklmnopqrstuvwxyz0123456789 failed",
    question: "What should Jack inspect next?",
  });

  assert.equal(result.provider, "google");
  assert.equal(result.sanitized, true);
  assert.ok(result.redacted >= 1);
  const payload = JSON.stringify(registry.calls[0].messages);
  assert.doesNotMatch(payload, /super-secret-value/);
  assert.doesNotMatch(payload, /abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(payload, /redacted/);
});
test("consultExpert falls back from Gemini to Groq", async () => {
  const registry = fakeRegistry({ failGoogle: true });
  const result = await consultExpert({
    registry,
    task: "Debug a failing test",
    question: "What is the next useful check?",
  });

  assert.equal(result.provider, "groq");
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.equal(registry.calls.length, 2);
  assert.equal(registry.calls[0].providerId, "google");
  assert.equal(registry.calls[1].providerId, "groq");
});


test("consultExpert falls back across Gemini Flash models", async () => {
  const calls = [];
  const registry = {
    refresh: async () => {},
    getProvider(id) {
      return id === "google" ? { id, enabled: true } : null;
    },
    listModels() {
      return [
        { provider: "google", id: "gemini-3.8-flash" },
        { provider: "google", id: "gemini-3.7-flash" },
        { provider: "google", id: "gemini-3.6-flash" },
        { provider: "google", id: "gemini-flash-latest" },
      ];
    },
    async chat(args) {
      calls.push(args.modelId);
      if (args.modelId === "gemini-3.8-flash")
        throw new Error("503 high demand");
      return { content: "fallback-ok" };
    },
  };

  const result = await consultExpert({
    registry,
    task: "Need a second opinion",
    question: "What next?",
  });

  assert.equal(result.provider, "google");
  assert.equal(result.model, "gemini-3.7-flash");
  assert.deepEqual(calls, ["gemini-3.8-flash", "gemini-3.7-flash"]);
});
