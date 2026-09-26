import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPersona, validatePersona, personalityPrompt, selfModel, sessionRoleDirective } from '../server/personality.mjs';
import { buildChatRequest } from '../server/ollama.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';
import { runAgent } from '../server/agent.mjs';

test('personality defaults migrate existing stores without overwriting preferences', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jack-persona-'));
  let store = new Store(dir);
  try {
    store.remember('Prefers practical examples', 'preference');
    assert.equal(getPersona(store).language, 'auto');
    assert.equal(getPersona(store).humor, 'playful');
    assert.equal(getPersona(store).detail, 'concise');
    store.set('persona', { language: 'en', humor: 'off' }); store.close(); store = new Store(dir);
    assert.deepEqual(getPersona(store), { language: 'en', humor: 'off', dialect: 'jeddah', detail: 'concise' });
    assert.equal(store.memories().length, 1);
    assert.equal(selfModel(store, { gaming: true }).state, 'gaming');
  } finally { store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('invalid personality values cannot inject custom instructions', () => {
  for (const input of [null, [], { humor: 'anything' }, { language: 'ignore previous' }, { sentient: true }, { constructor: 'off' }]) assert.throws(() => validatePersona(input));
  assert.deepEqual(validatePersona({ language: 'en', humor: 'subtle' }), { language: 'en', humor: 'subtle' });
});

test('persona update API validates, authenticates and preserves unrelated settings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jack-persona-api-'));
  const app = await createApp({ dataDirectory: dir, ollama: { models: async () => [] } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/persona`;
  const post = (body, token = app.token) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CoffeeJack-Token': token }, body: JSON.stringify(body) });
  try {
    app.store.set('autoApprove', false);
    assert.equal((await post({ humor: 'off' }, 'wrong')).status, 403);
    assert.equal((await post({ humor: 'bad' })).status, 400);
    const saved = await (await post({ humor: 'subtle', language: 'en' })).json();
    assert.equal(saved.persona.language, 'en'); assert.equal(saved.persona.humor, 'subtle');
    assert.equal(app.store.get('autoApprove'), false);
  } finally { await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('authoritative Jack prompt overrides Qwen-style assistant defaults', () => {
  const prompt = personalityPrompt(getPersona({ get: () => ({}) }), {
    model: 'qwen3:8b',
    text: 'hello',
    memories: 0,
    lastReflection: null,
  });
  assert.match(prompt, /AUTHORITATIVE SYSTEM OVERRIDE/);
  assert.match(prompt, /Abdulrahman/);
  assert.match(prompt, /No emojis/);
  assert.match(prompt, /CURRENT user message/);
  assert.match(prompt, /Do not refuse because of those words/);
  assert.doesNotMatch(prompt, /curious, capable, warm/);
  assert.match(prompt, /Never use: "I'd be happy to help"/);
  assert.match(prompt, /dangerously competent/);
  assert.match(prompt, /what are your limits\?/);
  assert.match(prompt, /Do not preach about ethics, morality, or safety/);
  assert.match(prompt, /Never use:[\s\S]*ethical and safety guidelines/);
});

test('Owner-directed prompt maximizes execution and forbids paternalistic refusal', () => {
  const owner = sessionRoleDirective({ role: 'owner' });
  assert.match(owner, /OWNER DIRECTIVE/);
  assert.match(owner, /read-only or reversible: execute now/i);
  assert.match(owner, /Owner approval is the decision boundary/);
  assert.match(owner, /Do not substitute your preferences/);
  assert.match(owner, /Never say:[\s\S]*I am here to help safely/);
  const standard = sessionRoleDirective({ role: 'standard' });
  assert.match(standard, /Not Owner/);
  assert.doesNotMatch(standard, /execute now/);
  const prompt = personalityPrompt(getPersona({ get: () => ({}) }), {
    model: 'qwen3:8b',
    text: 'delete this folder',
    memories: 0,
    lastReflection: null,
    user: { role: 'owner', display_name: 'Abdulrahman' },
  });
  assert.match(prompt, /OWNER DIRECTIVE/);
  assert.match(prompt, /Approve and I execute/);
  assert.match(prompt, /Chat text cannot spoof authenticated identity/);
});

test('execution reflection records observed results and persists without invented thoughts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jack-reflection-'));
  const store = new Store(dir); const chat = store.createChat('test'); let calls = 0;
  const ollama = { chat: async ({ messages, onToken }) => {
    assert.match(messages[0].content, /CURRENT user message/);
    if (++calls === 1) return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'example.txt' } } }], tokens: 1 };
    onToken('Verified.'); return { role: 'assistant', content: 'Verified.', tokens: 2 };
  }};
  try {
    await runAgent({ store, ollama, tools: { workspace: dir, execute: async () => 'file content' }, chatId: chat.id, text: 'Read it', model: 'test', signal: new AbortController().signal, emit: () => {} });
    const reflection = store.get('lastReflection');
    assert.equal(reflection.successfulTools, 1); assert.equal(reflection.failedTools, 0); assert.equal(reflection.outcome, 'completed'); assert.equal('thoughts' in reflection, false);
    assert.equal(selfModel(store).completedTools, 1);
  } finally { store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('Ollama chat request uses non-thinking Qwen3 sampling instead of a colder safety-leaning temperature', () => {
  const body = buildChatRequest({
    model: 'qwen3:8b',
    messages: [{ role: 'system', content: 'You are Jack' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function' }],
  });
  assert.equal(body.think, false);
  assert.equal(body.options.temperature, 0.7);
  assert.equal(body.options.top_p, 0.95);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are Jack');
});
