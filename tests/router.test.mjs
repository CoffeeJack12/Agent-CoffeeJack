import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, routeModel } from "../server/router.mjs";
import { Ollama, buildChatRequest } from "../server/ollama.mjs";

const fake = (models) => ({
  models: async () => Object.keys(models).map((name) => ({ name })),
  inspect: async (name) => ({ capabilities: models[name] }),
});
test("routing classifies English, Arabic, continuation and image overrides", () => {
  for (const text of [
    "debug this code",
    "صلح الكود",
    "build a website",
    "run tests",
  ])
    assert.equal(classifyTask({ text }), "coding");
  assert.equal(classifyTask({ text: "hello" }), "general");
  assert.equal(
    classifyTask({
      text: "continue",
      history: [{ role: "user", content: "debug code" }],
    }),
    "coding",
  );
  assert.equal(
    classifyTask({
      text: "hello",
      mode: "general",
      attachments: ["uploads/a.png"],
    }),
    "vision",
  );
  assert.throws(() => classifyTask({ mode: "bad" }));
});
test("routing chooses configured models and falls back to installed tool-capable models", async () => {
  const ollama = fake({ main: ["tools"], coder: ["tools", "thinking"] });
  const settings = { model: "main", codingModel: "coder" };
  const route = await routeModel({
    ollama,
    settings,
    text: "debug code",
    memoryBytes: 32 * 1024 ** 3,
  });
  assert.equal(route.model, "coder");
  assert.equal(route.profile.think, false);
  assert.equal(route.profile.context, 8192);
  assert.equal(
    (await routeModel({ ollama, settings, text: "hello" })).model,
    "main",
  );
  const fallback = await routeModel({
    ollama,
    settings: { ...settings, codingModel: "missing" },
    text: "debug code",
    memoryBytes: 8 * 1024 ** 3,
  });
  assert.equal(fallback.model, "main");
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.profile.context, 6144);
});
test("vision requires verified capability and never silently drops image input", async () => {
  const settings = { model: "main", visionModel: "missing" };
  const task = { settings, attachments: ["uploads/x.jpg"] };
  await assert.rejects(
    routeModel({ ...task, ollama: fake({ main: ["tools"] }) }),
    /vision/,
  );
  const route = await routeModel({
    ...task,
    ollama: fake({ main: ["tools"], eyes: ["vision"] }),
  });
  assert.equal(route.model, "eyes");
  assert.equal(route.kind, "vision");
  await assert.rejects(
    routeModel({ settings, ollama: fake({ "big:cloud": ["tools"] }) }),
    /local model/,
  );
});
test("routing aborts and Ollama releases other models before loading selected model", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    routeModel({ ollama: fake({}), settings: {}, signal: controller.signal }),
  );
  const ollama = new Ollama();
  const calls = [];
  ollama.request = async (endpoint, body) => {
    calls.push([endpoint, body]);
    return {
      json: async () => ({ models: [{ name: "old" }, { name: "selected" }] }),
    };
  };
  await ollama.prepare("selected");
  assert.deepEqual(calls, [
    ["/api/ps", undefined],
    ["/api/generate", { model: "old", keep_alive: 0 }],
  ]);
});
test("coding profile reaches Ollama request while ordinary chat keeps lightweight defaults", () => {
  const body = buildChatRequest({
    model: "coder",
    messages: [],
    profile: { think: true, context: 8192, predict: 3072, keepAlive: "5m" },
  });
  assert.equal(body.think, true);
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.options.num_predict, 3072);
  assert.equal(body.keep_alive, "5m");
  assert.equal(buildChatRequest({ model: "main", messages: [] }).think, false);
  assert.equal(buildChatRequest({ model: "main", messages: [] }).keep_alive, "10m");
});
