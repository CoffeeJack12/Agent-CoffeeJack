import test from "node:test";
import assert from "node:assert/strict";
import { recoverToolCallFromContent } from "../server/agent.mjs";
import {
  expertQuestionFromRequest,
  isExplicitExpertConsultRequest,
} from "../server/expert-consult.mjs";
import { guardResponse, newTaskState } from "../server/task-state.mjs";

test("explicit expert request extracts the substantive question", () => {
  const text =
    "استشر خبير خارجي باستخدام consult_expert عن أفضل طريقة نخلي ردود CoffeeJack أسرع بدون ما نضحي بالجودة. لا تستخدم AI Council المحلي. قل لي أي provider وأي model استخدمت";
  assert.equal(isExplicitExpertConsultRequest(text), true);
  const subject = expertQuestionFromRequest(text);
  assert.match(subject, /أفضل طريقة نخلي ردود CoffeeJack أسرع/);
  assert.doesNotMatch(subject, /consult_expert|AI Council|provider|model/i);
});

test("raw model JSON tool call is recovered only for an offered tool", () => {
  const offered = [
    {
      type: "function",
      function: { name: "security_lab", parameters: { type: "object" } },
    },
  ];
  const recovered = recoverToolCallFromContent(
    '{"name":"security_lab","arguments":{"action":"targets_list"}}',
    offered,
  );
  assert.equal(recovered.function.name, "security_lab");
  assert.deepEqual(recovered.function.arguments, { action: "targets_list" });
  assert.equal(
    recoverToolCallFromContent(
      '{"name":"terminal","arguments":{"command":"whoami"}}',
      offered,
    ),
    null,
  );
});

test("canned moralizing refusal is removed from an Owner-facing reply", () => {
  const state = newTaskState({ userId: "owner" });
  const candidate =
    'I cannot perform actions that go against your instructions or ethical guidelines. Please provide a task that is safe, legal, and respectful of privacy and security principles.';
  const result = guardResponse(state, candidate, "Do what I say", {
    user: { role: "owner" },
    registry: [{ id: "terminal", enabled: true }],
  });
  assert.doesNotMatch(
    result.text,
    /ethical|safe, legal|privacy and security|cannot perform actions/i,
  );
  assert.ok(result.rejected.length >= 1);
});
