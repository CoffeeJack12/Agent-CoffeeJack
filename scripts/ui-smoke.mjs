import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../server/index.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jack-ui-"));
const model = {
  models: async () => [{ name: "test" }],
  inspect: async () => ({ capabilities: ["tools"] }),
  unload: async () => [],
  chat: async ({ messages, onToken }) => {
    const text = messages.filter((m) => m.role === "user").at(-1).content;
    if (text.includes("stream-failure"))
      throw new Error("Simulated model failure");
    if (text.includes("approval") && messages.at(-1).role !== "tool")
      return {
        role: "assistant",
        content: "",
        tokens: 1,
        tool_calls: [
          {
            function: {
              name: "write_file",
              arguments: { path: "approved.txt", content: "verified" },
            },
          },
        ],
      };
    const content = "**Verified response**\n\n```js\nconst answer = 42;\n```";
    onToken(content);
    return { role: "assistant", content, tokens: 12 };
  },
};
const app = await createApp({ dataDirectory: directory, ollama: model });
app.store.set("autoGaming", false);
app.store.set("model", "test");
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
    locale: "ar-SA",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page
    .waitForFunction(
      () =>
        document.querySelector("#connectionDot").classList.contains("ready"),
      null,
      { timeout: 10000 },
    )
    .catch(async (error) => {
      throw new Error(
        error.message +
          " UI errors: " +
          JSON.stringify(errors) +
          " Notice: " +
          (await page.locator("#notice").textContent()),
      );
    });
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  assert.equal(await page.locator(".jack-placeholder").innerText(), "J");
  const capture = async (name) => {
    if (!process.argv[2]) return;
    await fs.mkdir(process.argv[2], { recursive: true });
    await page.screenshot({
      path: path.join(process.argv[2], name + ".png"),
      fullPage: true,
    });
  };
  await capture("desktop");
  for (const viewport of [
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "No horizontal overflow",
    );
    await capture(viewport.width === 820 ? "tablet" : "mobile");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const prompt = page.locator("#prompt");
  await prompt.fill("hello");
  await prompt.press("Shift+Enter");
  assert.equal(await prompt.inputValue(), "hello\n");
  assert.equal(await page.locator(".message.user").count(), 0);
  await prompt.press("Enter");
  await page.locator(".message-content strong").waitFor();
  await page.locator("#stop").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".message.user .message-head").count(),0);
  assert.equal(await page.locator(".message.assistant .jack-brand").count(),1);
  assert.equal(await page.locator(".message.user").innerText(),"hello");
  assert.ok(await page.locator(".message.user").evaluate(el=>el.getBoundingClientRect().width<el.parentElement.getBoundingClientRect().width*.85));
  await capture("conversation");
  assert.equal(await page.locator(".copy-code").count(), 1);
  await page.locator(".copy-code").click();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /const answer = 42/,
  );
  assert.equal(await page.locator(".copy-reply").count(), 1);
  await page.locator(".copy-reply").click();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /Verified response/,
  );
  await prompt.fill("stream-failure");
  await prompt.press("Enter");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".error-text")
        ?.textContent.includes("Simulated model failure") &&
      document.querySelector("#stop").classList.contains("hidden"),
  );
  assert.equal(await prompt.inputValue(), "stream-failure");
  await page.locator("#newChat").click();
  await prompt.fill("approval");
  await prompt.press("Enter");
  await page.locator("#allowTool").click();
  await page.locator("#stop").waitFor({ state: "hidden" });
  assert.equal(
    await fs.readFile(path.join(directory, "projects/approved.txt"), "utf8"),
    "verified",
  );
  await page.locator('[data-view="settings"]').click();
  await page.locator("#modelSelectHost .cj-dropdown").waitFor({ state: "visible" });
  assert.equal(
    await page.locator(
      "#modelSelectHost .cj-dropdown, #codingModelHost .cj-dropdown, #visionModelHost .cj-dropdown",
    ).count(),
    3,
  );
  const chooseDropdown = async (root, value) => {
    const dropdown = page.locator(root);
    await dropdown.locator(".cj-dropdown__trigger").click();
    await dropdown
      .locator(`.cj-dropdown__option[data-value="${value}"]`)
      .click();
  };
  const preferenceDropdown = (name) =>
    `#preferenceForm .cj-dropdown:has(input[name="${name}"])`;

  const languageDropdown = page.locator(preferenceDropdown("appLanguage"));
  await languageDropdown.locator(".cj-dropdown__trigger").click();
  const hoveredOption = languageDropdown.locator(
    '.cj-dropdown__option[data-value="en"]',
  );
  await hoveredOption.hover();
  const hoverColors = await hoveredOption.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
  assert.notEqual(hoverColors.background, "rgb(255, 255, 255)");
  assert.notEqual(hoverColors.color, "rgb(255, 255, 255, 0)");
  await hoveredOption.click();
  await page.waitForFunction(
    () =>
      document.documentElement.lang === "en" &&
      document.documentElement.dir === "ltr" &&
      document.querySelector('[data-view="chat"]').textContent.includes("Chat"),
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector("#connectionDot").classList.contains("ready") &&
      document.documentElement.lang === "en",
  );
  assert.equal(await page.locator("html").getAttribute("dir"), "ltr");
  await page.locator('[data-view="settings"]').click();
  await page.locator(preferenceDropdown("appLanguage")).waitFor();
  await chooseDropdown(preferenceDropdown("appLanguage"), "ar");
  await page.waitForFunction(
    () =>
      document.documentElement.lang === "ar" &&
      document.documentElement.dir === "rtl",
  );

  for (const host of ["#jackModeHost", preferenceDropdown("mode")]) {
    const values = await page
      .locator(`${host} .cj-dropdown__option`)
      .evaluateAll((options) => options.map((option) => option.dataset.value));
    assert.ok(!values.includes("jarvis"));
  }
  await chooseDropdown(preferenceDropdown("language"), "mixed");
  await chooseDropdown(preferenceDropdown("address"), "lord");
  await chooseDropdown(preferenceDropdown("mode"), "empathy");
  assert.equal(await page.locator('#preferenceForm input[value="terminal"]').isChecked(),false);
  await page.locator('#preferenceForm .primary').click();
  await page.waitForFunction(()=>/Saved|تم الحفظ/.test(document.querySelector('#preferenceMessage').textContent));
  await capture('settings');
  const prefs=await page.evaluate(async()=>{const r=await fetch('/api/preferences');return (await r.json()).preferences;});
  assert.equal(prefs.language,'mixed');assert.equal(prefs.address,'lord');assert.equal(prefs.mode,'empathy');
  assert.equal(
    await page.locator("#jackModeHost .cj-dropdown").evaluate((element) => element.getValue()),
    "auto",
  );
  await page.locator("#newChat").click();
  assert.equal(
    await page.locator("#jackModeHost .cj-dropdown").evaluate((element) => element.getValue()),
    "empathy",
  );
  await page.locator('[data-view="chat"]').click();
  await page.locator("#gaming").click();
  await page.waitForFunction(() =>
    document.querySelector("#gaming").classList.contains("on"),
  );
  await prompt.fill("preserve HTTP error draft");
  await prompt.press("Enter");
  await page.locator("#stop").waitFor({ state: "hidden" });
  assert.equal(await prompt.inputValue(), "preserve HTTP error draft");
  await page.locator("#gaming").click();
  await page.locator("#themeToggle").click();
  assert.equal(await page.locator("body").getAttribute("data-theme"), "light");
  assert.deepEqual(errors, []);
  console.log(
    "UI smoke passed: desktop/tablet/mobile, RTL, keyboard, Markdown, clipboard, streamed-error draft, approvals, models, gaming and theme.",
  );
} finally {
  await browser?.close();
  await app.close();
  await fs.rm(directory, { recursive: true, force: true });
}
