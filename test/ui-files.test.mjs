import { test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";

const EXE = process.env.CHROME || "/usr/bin/google-chrome-stable";
const URL = "file:///mnt/Data/Documents/D2/index.html";

// freshPage: при ПЕРВОЙ навигации таба чистит localStorage (и применяет uiPrefs);
// page.reload() уже не чистит — так E2E проверяет персистентность браузерных файлов.
async function freshPage(browser, uiPrefs) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((p) => {
    if (!sessionStorage.getItem("__d2init")) {
      sessionStorage.setItem("__d2init", "1");
      localStorage.clear();
      if (p) localStorage.setItem("d2editor:ui:v1", JSON.stringify(p));
    }
  }, uiPrefs || null);
  await page.goto(URL);
  await page.waitForSelector("#out");
  await new Promise((r) => setTimeout(r, 300));
  return page;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitEdit = () => wait(3400);

const nodesCount = (page) => page.$$eval("#nodes .node", (els) => els.length);
const text = (page) => page.$eval("#out", (el) => el.value);
const status = (page) => page.$eval("#outStatus", (el) => el.textContent);
const modalVisible = (page) => page.$eval("#modal-overlay", (el) => !el.hidden);
const modalText = (page) => page.$eval("#modal-content", (el) => el.textContent || "");
const modalInputValue = (page) => page.$eval("#modal-input", (el) => el.value);
const undoEnabled = (page) => page.$eval("#btnUndo", (el) => !el.disabled);

async function setText(page, s) {
  await page.$eval("#out", (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, s);
}

async function setModalInput(page, v) {
  await page.$eval("#modal-input", (el, val) => { el.value = val; }, v);
}

async function openMenu(page) {
  await page.click("#btnCopyMenu");
  await page.waitForSelector("#copy-menu:not([hidden])", { visible: true, timeout: 3000 });
}

async function menuAction(page, act) {
  await openMenu(page);
  await page.click('#copy-menu button[data-act="' + act + '"]');
}

async function saveAs(page, name) {
  await menuAction(page, "save-browser");
  await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
  await setModalInput(page, name);
  await page.click("#modal-ok");
  await wait(400);
}

test("ui-files: save to browser persists a file and reports the status", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await saveAs(page, "schema1");
    assert.equal(await modalVisible(page), false, "modal closed after save");
    assert.match(await status(page), /Сохранено в браузер: schema1/, "status reports the save");
    const label = await page.$eval("#fileLabel", (el) => el.textContent);
    assert.equal(label, "Файл: schema1", "file label shows the current file");
  } finally {
    await browser.close();
  }
});

test("ui-files: save dialog prefills the current file name", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser, { currentFile: "schema1" });
    await menuAction(page, "save-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    assert.equal(await modalInputValue(page), "schema1", "input prefilled with currentFile");
    assert.equal(await page.$eval("#fileLabel", (el) => el.textContent), "Файл: schema1", "label from pref");
  } finally {
    await browser.close();
  }
});

test("ui-files: empty name keeps the dialog open with an inline message", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await menuAction(page, "save-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await setModalInput(page, "");
    await page.click("#modal-ok");
    await wait(200);
    assert.equal(await modalVisible(page), true, "dialog stays open on empty name");
    assert.match(await modalText(page), /Введите имя диаграммы/, "inline message shown");
    await page.keyboard.press("Escape");
    await wait(100);
    assert.equal(await modalVisible(page), false, "Escape closes the dialog");
  } finally {
    await browser.close();
  }
});

test("ui-files: overwrite asks for confirmation without closing the dialog", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await saveAs(page, "schema1");

    await menuAction(page, "save-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.click("#modal-ok");
    await wait(200);
    assert.equal(await modalVisible(page), true, "dialog stays open on existing name");
    assert.match(await modalText(page), /Диаграмма с именем "schema1" уже существует\./, "overwrite message");
    assert.equal(await page.$eval("#modal-ok", (el) => el.textContent), "Заменить", "primary button is Заменить");
    assert.equal(await page.$eval("#modal-cancel", (el) => el.textContent), "Отмена", "cancel button is Отмена");

    await page.click("#modal-cancel");
    await wait(100);
    assert.equal(await modalVisible(page), true, "cancel returns to input phase");
    assert.equal(await modalInputValue(page), "schema1", "input keeps the entered name");

    await page.click("#modal-ok");
    await wait(200);
    await page.click("#modal-ok");
    await wait(400);
    assert.equal(await modalVisible(page), false, "modal closed after replacing");
    assert.match(await status(page), /Сохранено в браузер: schema1/, "status after overwrite");
  } finally {
    await browser.close();
  }
});

test("ui-files: opening a file restores the graph, text, and clears history", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await page.click("#btnPos");
    await wait(100);
    await setText(page, "Client # --- @d2pos 60,300\nServer -> Client\n");
    await waitEdit();
    assert.equal(await nodesCount(page), 2, "two nodes merged");
    await saveAs(page, "schema1");

    await setText(page, "Other\n");
    await waitEdit();
    assert.equal(await nodesCount(page), 1, "schema changed before reopen");

    await menuAction(page, "open-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.waitForSelector(".file-row", { visible: true, timeout: 3000 });
    await page.click('.file-row[data-name="schema1"] button[data-open="1"]');
    await wait(400);

    assert.equal(await modalVisible(page), false, "modal closed after open");
    assert.equal(await nodesCount(page), 2, "nodes restored");
    assert.match(await text(page), /Client/, "textarea restored the saved code");
    assert.match(await text(page), /@d2pos/, "annotated markers restored");
    assert.equal(await undoEnabled(page), false, "undo history cleared on open");
    assert.match(await status(page), /Открыт: schema1/, "status reports the open");
  } finally {
    await browser.close();
  }
});

test("ui-files: empty base shows a hint; saved files appear as rows in savedAt order", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await menuAction(page, "open-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await wait(200);
    assert.match(await modalText(page), /Нет сохранённых файлов/, "empty base hint");
    await page.keyboard.press("Escape");
    await wait(100);

    await saveAs(page, "a1");
    await wait(50);
    await saveAs(page, "b2");

    await menuAction(page, "open-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.waitForSelector(".file-row", { visible: true, timeout: 3000 });
    const names = await page.$$eval(".file-row", (els) => els.map((e) => e.getAttribute("data-name")));
    assert.deepEqual(names, ["b2", "a1"], "rows in savedAt desc order");
    const hasBtns = await page.$$eval(".file-row", (els) =>
      els.every((e) => e.querySelector('button[data-open="1"]') && e.querySelector('button[data-del="1"]')));
    assert.equal(hasBtns, true, "each row has open and delete buttons");
  } finally {
    await browser.close();
  }
});

test("ui-files: save dialog lists files with delete buttons only and lets you delete", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await saveAs(page, "schema1");

    await menuAction(page, "save-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.waitForSelector(".file-row", { visible: true, timeout: 3000 });
    const names = await page.$$eval(".file-row", (els) => els.map((e) => e.getAttribute("data-name")));
    assert.deepEqual(names, ["schema1"], "save dialog lists the saved file");
    const btns = await page.$$eval(".file-row", (els) => els.map((e) => ({
      open: !!e.querySelector('button[data-open="1"]'),
      del: !!e.querySelector('button[data-del="1"]')
    })));
    assert.deepEqual(btns, [{ open: false, del: true }], "rows have delete but no open buttons");
    const boxW = await page.$eval("#modal-box", (el) => Math.round(el.getBoundingClientRect().width));
    assert.ok(boxW >= 500, "modal widened to ~500px, got " + boxW);

    await page.click('.file-row[data-name="schema1"] button[data-del="1"]');
    await wait(150);
    assert.match(await modalText(page), /Удалить файл "schema1" из браузера\?/, "confirm phase text");
    await page.click("#modal-ok");
    await wait(400);
    assert.equal(await modalVisible(page), true, "dialog stays open after delete");
    assert.match(await modalText(page), /Нет сохранённых файлов/, "list refreshed, empty");
    assert.equal(await modalInputValue(page), "schema1", "name input kept after delete");
  } finally {
    await browser.close();
  }
});

test("ui-files: delete removes the row after inline confirmation", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await saveAs(page, "schema1");

    await menuAction(page, "open-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.waitForSelector(".file-row", { visible: true, timeout: 3000 });
    await page.click('.file-row[data-name="schema1"] button[data-del="1"]');
    await wait(150);
    assert.match(await modalText(page), /Удалить файл "schema1" из браузера\?/, "confirm phase text");
    await page.click("#modal-ok");
    await wait(400);
    assert.match(await modalText(page), /Нет сохранённых файлов/, "list refreshed, empty");
  } finally {
    await browser.close();
  }
});

test("ui-files: files survive a reload (browser storage is persistent)", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await saveAs(page, "schema1");

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#out");
    await wait(300);

    await menuAction(page, "open-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.waitForSelector(".file-row", { visible: true, timeout: 3000 });
    const names = await page.$$eval(".file-row", (els) => els.map((e) => e.getAttribute("data-name")));
    assert.deepEqual(names, ["schema1"], "file survived reload");
    assert.equal(await page.$eval("#fileLabel", (el) => el.textContent), "Файл: schema1", "currentFile restored");
  } finally {
    await browser.close();
  }
});

test("ui-files: storage line counts files and falls back when estimate fails", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await saveAs(page, "schema1");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "storage", {
        value: { estimate: () => Promise.reject(new Error("nope")) }, configurable: true
      });
    });
    await menuAction(page, "open-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.waitForSelector("#files-storage", { visible: true, timeout: 3000 });
    await wait(200);
    const line1 = await page.$eval("#files-storage", (el) => el.textContent);
    assert.match(line1, /Файлы: 1, занято \d+/, "counter present: " + line1);
    assert.ok(!line1.includes("· Занято"), "estimate fallback part absent");

    await page.keyboard.press("Escape");
    await wait(100);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "storage", {
        value: { estimate: async () => ({ quota: 1e9, usage: 5 }) }, configurable: true
      });
    });
    await menuAction(page, "open-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.waitForSelector("#files-storage", { visible: true, timeout: 3000 });
    await wait(200);
    const line2 = await page.$eval("#files-storage", (el) => el.textContent);
    assert.match(line2, /· Занято .* из .* \(свободно .*\)/, "estimate detail shown: " + line2);
  } finally {
    await browser.close();
  }
});

test("ui-files: a failing IndexedDB goes through the recreate route and recovers", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      if (!sessionStorage.getItem("__d2init")) {
        sessionStorage.setItem("__d2init", "1");
        localStorage.clear();
        const realOpen = indexedDB.open.bind(indexedDB);
        let failures = 2;
        indexedDB.open = (...args) => {
          if (failures > 0) {
            failures--;
            const req = {};
            setTimeout(() => { if (req.onerror) req.onerror({ target: req }); }, 0);
            return req;
          }
          return realOpen(...args);
        };
      }
    });
    await page.goto(URL);
    await page.waitForSelector("#out");
    await wait(300);

    // Первая попытка: база падает уже при открытии окна сохранения →
    // инлайн «недоступна» (список не загружается), Отмена закрывает.
    await menuAction(page, "save-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await wait(200);
    assert.equal(await modalVisible(page), true, "modal stays open on idb failure");
    assert.match(await modalText(page), /База файлов браузера недоступна/, "idb-down message");
    await page.click("#modal-cancel");
    await wait(100);
    assert.equal(await modalVisible(page), false, "cancel closes the dialog");

    // Вторая попытка: снова недоступна, но «Пересоздать базу файлов» чинит
    // (последний сбой уже израсходован) → сохранение проходит по введённому
    // имени из поля ввода.
    await menuAction(page, "save-browser");
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await wait(200);
    assert.equal(await modalVisible(page), true, "second attempt fails the same way");
    assert.match(await modalText(page), /База файлов браузера недоступна/, "idb-down again");
    await setModalInput(page, "schema1");
    await page.click("#modal-ok");
    await wait(400);
    assert.equal(await modalVisible(page), false, "recreate recovers the save");
    assert.match(await status(page), /Сохранено в браузер: schema1/, "save succeeded after recreate");
  } finally {
    await browser.close();
  }
});

test("ui-files: import of an annotated .dd2 applies positions and keeps markers", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await page.click("#btnPos");
    await wait(100);

    const file = join(tmpdir(), "d2editor-e2e-files.dd2");
    fs.writeFileSync(file, "Client # --- @d2pos 60,300\nServer -> Client\n");

    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 5000 }),
      menuAction(page, "import-file")
    ]);
    await chooser.accept([file]);
    await wait(400);

    assert.match(await text(page), /@d2pos/, "annotated markers kept in textarea");
    assert.equal(await nodesCount(page), 2, "nodes rendered");
    const left = await page.$eval("#nodes .node", (el) => el.style.left);
    assert.equal(left, "60px", "marker position applied to the node");
  } finally {
    await browser.close();
  }
});

test("ui-files: import of a plain .d2 works without markers", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    const file = join(tmpdir(), "d2editor-e2e-plain.d2");
    fs.writeFileSync(file, "PlainNode\nPlainNode2 -> PlainNode\n");

    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 5000 }),
      menuAction(page, "import-file")
    ]);
    await chooser.accept([file]);
    await wait(400);

    assert.ok((await text(page)).includes("PlainNode"), "plain d2 loaded");
    assert.equal(await nodesCount(page), 2, "nodes rendered");
  } finally {
    await browser.close();
  }
});

test("ui-files: export to file (.dd2) keeps the annotated markers", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await setText(page, "Client # --- @d2pos 60,300\n");
    await waitEdit();

    await page.evaluate(() => {
      window.__exported = null;
      window.__suggested = null;
      window.showSaveFilePicker = async (opts) => {
        window.__suggested = opts.suggestedName;
        return {
          name: opts.suggestedName,
          createWritable: async () => ({ write: async (c) => { window.__exported = c; }, close: async () => {} })
        };
      };
    });
    await menuAction(page, "export-file");
    await wait(300);

    const data = await page.evaluate(() => ({
      suggested: window.__suggested,
      content: window.__exported
    }));
    assert.equal(data.suggested, "diagram.dd2", "suggests diagram.dd2");
    assert.match(data.content || "", /# --- @d2pos 60,300/, "annotated markers exported");
  } finally {
    await browser.close();
  }
});

test("ui-files: export to D2 (.d2) strips the markers and enforces the extension", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await setText(page, "Client # --- @d2pos 60,300\nServer -> Client\n");
    await waitEdit();

    await page.evaluate(() => {
      window.__exported = null;
      window.__suggested = null;
      window.showSaveFilePicker = async (opts) => {
        window.__suggested = opts.suggestedName;
        const handle = {
          name: "myfile",
          move: async (n) => { handle.name = n; },
          createWritable: async () => ({ write: async (c) => { window.__exported = c; }, close: async () => {} })
        };
        return handle;
      };
    });
    await menuAction(page, "export-d2");
    await wait(300);

    const data = await page.evaluate(() => ({
      suggested: window.__suggested,
      content: window.__exported,
      status: document.getElementById("outStatus").textContent
    }));
    assert.equal(data.suggested, "diagram.d2", "first export suggests diagram.d2");
    assert.ok(data.content && !data.content.includes("@d2pos"), "standard export has no markers");
    assert.ok(data.content.includes("Server -> Client"), "edges kept in standard export");
    assert.match(data.status, /Экспортировано в myfile\.d2/, ".d2 enforced in status");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("d2editor:ui:v1")));
    assert.equal(saved && saved.exportName, "myfile.d2", "exportName persisted");
  } finally {
    await browser.close();
  }
});
