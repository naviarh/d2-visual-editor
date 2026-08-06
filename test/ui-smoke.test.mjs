import { test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.env.CHROME || "/usr/bin/google-chrome-stable";
const URL = "file:///mnt/Data/Documents/D2/index.html";

async function freshPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(URL);
  await page.waitForSelector("#out");
  await new Promise((r) => setTimeout(r, 300));
  return page;
}

async function text(page) {
  return page.$eval("#out", (el) => el.value);
}

async function setText(page, s) {
  await page.$eval("#out", (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, s);
}

// textarea input debounce is TEXT_EDIT_MS (3 s); wait past it with margin
const waitEdit = () => new Promise((r) => setTimeout(r, 3400));

async function toggle(page) {
  await page.click("#btnPos");
  await new Promise((r) => setTimeout(r, 200));
}

test("v1 -> v2 migration: legacy localStorage opens with built order", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const legacy = {
      v: 1,
      nodes: [
        { id: "Client", label: "Client", x: 60, y: 300, w: 150, h: 70, parentId: null, children: [] },
        { id: "API Server", label: "API Server", x: 340, y: 230, w: 150, h: 70, parentId: null, children: ["Database", "Cache"] },
        { id: "Database", label: "Database", x: 40, y: 60, w: 150, h: 70, parentId: "API Server", children: [] },
        { id: "Cache", label: "Cache", x: 40, y: 170, w: 150, h: 70, parentId: "API Server", children: [] },
        { id: "Worker", label: "Worker", x: 340, y: 520, w: 150, h: 70, parentId: null, children: [] }
      ],
      edges: [
        { id: "e1", source: "Client", target: "API Server", label: "HTTPS" },
        { id: "e2", source: "API Server", target: "Worker", label: "queue" },
        { id: "e3", source: "Worker", target: "Database", label: "read/write" }
      ],
      idCounter: 10,
      viewport: { x: 0, y: 0, zoom: 1 }
    };
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((payload) => {
      localStorage.clear();
      localStorage.setItem("d2editor:v1", payload);
    }, JSON.stringify(legacy));
    await page.goto(URL);
    await page.waitForSelector("#out");
    await new Promise((r) => setTimeout(r, 300));

    const txt = await text(page);
    for (const s of ['Client # @d2pos 60,300', '"API Server": { # @d2pos 340,230', 'Database # @d2pos 40,60',
      'Cache # @d2pos 40,170', 'Worker # @d2pos 340,520', 'HTTPS']) {
      assert.ok(txt.includes(s), "serialized: " + s);
    }
    const nodeCount = await page.$$eval("#nodes .node", (els) => els.length);
    assert.equal(nodeCount, 5, "all legacy nodes rendered");

    // legacy positions preserved as node markers, children nested inside container
    const iServer = txt.indexOf('"API Server"');
    const iDb = txt.indexOf("Database");
    assert.ok(iServer >= 0 && iServer < iDb, "container before its children");

    // a save round-trip persists the built order
    await new Promise((r) => setTimeout(r, 600));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("d2editor:v1")));
    assert.ok(Array.isArray(stored.order) && stored.order.length >= 8, "order persisted after migration");
    assert.ok(stored.order.includes("e3"), "edges in persisted order");
  } finally {
    await browser.close();
  }
});

test("UI E2E: load, toggle, edit, auto-position, error", { timeout: 120000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);

    const initial = await text(page);
    assert.ok(initial.includes("@d2pos"), "annotated view has markers");
    assert.ok(initial.includes('"API Server"'), "demo serialized");

    // toggle in a clean state switches to clean view
    await toggle(page);
    const cleanView = await text(page);
    assert.ok(!cleanView.includes("@d2pos"), "clean view has no markers");
    assert.equal(await page.$eval("#btnPos", (el) => el.textContent), "Показать позиции");
    await toggle(page); // back to annotated
    assert.ok((await text(page)).includes("@d2pos"), "back to annotated");

    // rename on an annotated line -> merge keeps position, text not clobbered
    const renamed = (await text(page))
      .replace('Client # @d2pos 80,492', 'WebClient # @d2pos 80,492')
      .replace('Client -> "API Server"', 'WebClient -> "API Server"');
    await setText(page, renamed);
    await waitEdit();
    const afterRename = await text(page);
    assert.ok(afterRename.includes("WebClient # @d2pos 80,492"), "rename kept marker");
    assert.ok(afterRename.includes('WebClient -> "API Server"'), "edge reference renamed");
    assert.ok(afterRename.includes("@d2pos 80,492"), "position preserved");
    assert.equal(await page.$eval("#outStatus", (el) => el.textContent), "Синхронизировано");

    // insert a new block -> auto-position, order at end, status message
    const inserted = afterRename.replace("Database # @d2pos 40,60",
      "Database # @d2pos 40,60\nNewBlock # @d2pos 5,5");
    await setText(page, inserted);
    await waitEdit();
    const afterInsert = await text(page);
    assert.ok(afterInsert.includes("NewBlock"), "new block present");
    const status = await page.$eval("#outStatus", (el) => el.textContent);
    assert.ok(/Новых блоков/.test(status), "status mentions new blocks: " + status);
    const nodeLabels = await page.$$eval("#nodes .node .nlabel", (els) => els.map((e) => e.textContent));
    assert.ok(nodeLabels.includes("NewBlock"), "NewBlock rendered in diagram");

    // syntax error -> graph untouched, status shows error line
    const bad = (await text(page)).replace('"API Server" -> Worker', '"API Server" ->');
    await setText(page, bad);
    await waitEdit();
    const errStatus = await page.$eval("#outStatus", (el) => el.textContent);
    assert.ok(/Ошибка D2/.test(errStatus), "error status: " + errStatus);
    const nodeCount = await page.$$eval("#nodes .node", (els) => els.length);
    assert.ok(nodeCount >= 5, "diagram still rendered after error");

    // toggle while text is in an error state: only flag flips, text untouched
    await toggle(page);
    const stillAnnotated = await text(page);
    assert.ok(stillAnnotated.includes("@d2pos"), "unmerged text not rewritten by toggle");

    // fix the error, edit synchronizes again
    const good = stillAnnotated.replace('"API Server" ->', '"API Server" -> Worker');
    await setText(page, good);
    await waitEdit();
    assert.equal(await page.$eval("#outStatus", (el) => el.textContent), "Синхронизировано");

    // sort by arrows: chain order stable, positions untouched, status synced
    await page.click("#btnSort");
    await new Promise((r) => setTimeout(r, 300));
    const sorted = await text(page);
    const iClient = sorted.indexOf("Client");
    const iWorker = sorted.indexOf("Worker");
    const iDb = sorted.indexOf("Database");
    assert.ok(iClient >= 0 && iWorker >= 0 && iDb >= 0, "all blocks present after sort");
    assert.ok(iClient < iWorker, "Client before Worker after sort");
    assert.equal(await page.$eval("#outStatus", (el) => el.textContent), "Синхронизировано");
    const nodePos = await page.$$eval("#nodes .node", (els) => els.map((e) => {
      const st = e.getAttribute("style") || "";
      const lm = st.match(/left:\s*(-?[\d.]+)px/);
      const tm = st.match(/top:\s*(-?[\d.]+)px/);
      return lm && tm ? [lm[1], tm[1]] : null;
    }));
    assert.ok(nodePos.every((p) => p), "all nodes positioned after sort");

    // cleanup
    await page.evaluate(() => localStorage.clear());
  } finally {
    await browser.close();
  }
});

test("code panel width is saved on divider drag and restored on reload", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(URL);
    await page.waitForSelector("#out");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector("#out");

    const width = () => page.$eval("#code-panel", (el) => Math.round(el.getBoundingClientRect().width));
    const before = await width();

    const divider = await page.$("#divider");
    const box = await divider.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy, { steps: 8 });
    await page.mouse.up();
    const after = await width();
    assert.ok(after > before + 50, "divider drag widened the code panel");

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("d2editor:ui:v1")));
    assert.ok(saved && Math.round(saved.codeWidth) === after, "width persisted to localStorage");

    await page.reload();
    await page.waitForSelector("#out");
    assert.equal(await width(), after, "width restored after reload");
  } finally {
    await browser.close();
  }
});

test("UI E2E: double-click on a block renames it (modal)", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);

    const box = await page.$eval("#nodes .node", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    // the first click re-renders the node element; double-click must still rename
    await page.mouse.click(box.x, box.y, { clickCount: 1 });
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.click(box.x, box.y, { clickCount: 2 });

    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    assert.equal(await page.$eval("#modal-title", (el) => el.textContent), "Новое название блока:");
    await page.$eval("#modal-input", (el, v) => { el.value = v; }, "WebClient");
    await page.click("#modal-ok");
    await new Promise((r) => setTimeout(r, 1400));

    const labels = await page.$$eval("#nodes .node .nlabel", (els) => els.map((e) => e.textContent));
    assert.ok(labels.includes("WebClient"), "node renamed in diagram");
    assert.ok((await text(page)).includes("WebClient"), "node renamed in code");
  } finally {
    await browser.close();
  }
});

test("UI E2E: double-click on an edge edits its label (modal)", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);

    const box = await page.$eval("#edges .edge-hit", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    // the first click re-renders the SVG; the double click must still rename
    await page.mouse.click(box.x, box.y, { clickCount: 1 });
    await new Promise((r) => setTimeout(r, 80));
    await page.mouse.click(box.x, box.y, { clickCount: 2 });

    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    assert.equal(await page.$eval("#modal-title", (el) => el.textContent), "Подпись стрелки:");
    await page.$eval("#modal-input", (el, v) => { el.value = v; }, "HTTPS 2");
    await page.click("#modal-ok");
    await new Promise((r) => setTimeout(r, 1400));

    assert.ok((await text(page)).includes("HTTPS 2"), "edge label renamed in code");
    const edgeLabels = await page.$$eval("#edges .elabel", (els) => els.map((e) => e.textContent));
    assert.ok(edgeLabels.includes("HTTPS 2"), "edge label renamed in diagram");
  } finally {
    await browser.close();
  }
});

test("UI E2E: edit modal is draggable by its title", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);

    const box = await page.$eval("#nodes .node", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y, { clickCount: 1 });
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.click(box.x, box.y, { clickCount: 2 });
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });

    const before = await page.$eval("#modal-box", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    const title = await page.$eval("#modal-title", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(title.x, title.y);
    await page.mouse.down();
    await page.mouse.move(title.x + 120, title.y + 90, { steps: 10 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 150));

    const after = await page.$eval("#modal-box", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    assert.ok(Math.abs(after.x - before.x - 120) < 3 && Math.abs(after.y - before.y - 90) < 3,
      "modal moved with the pointer by the drag delta");

    await page.click("#modal-cancel");
  } finally {
    await browser.close();
  }
});

test("UI E2E: copy split button menu — items, Escape and outside click close it", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);

    await page.click("#btnCopyMenu");
    await page.waitForSelector("#copy-menu:not([hidden])", { visible: true, timeout: 3000 });
    const acts = await page.$$eval("#copy-menu button[data-act]", (els) => els.map((e) => e.dataset.act));
    assert.deepEqual(acts, ["paste", "replace", "import", "export", "export-svg", "export-drawio", "export-mermaid", "import-mermaid"]);

    // the format items are stubs for now — clicking reports "в разработке" and closes the menu
    await page.click('#copy-menu button[data-act="export-drawio"]');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await page.$eval("#copy-menu", (el) => el.hidden), "menu closes after picking export-drawio");
    assert.ok(/(в разработке)/.test(await page.$eval("#outStatus", (el) => el.textContent)), "stub status shown");

    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await page.$eval("#copy-menu", (el) => el.hidden), "Escape closes the menu");

    await page.click("#btnCopyMenu");
    await new Promise((r) => setTimeout(r, 50));
    await page.mouse.click(5, 5);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await page.$eval("#copy-menu", (el) => el.hidden), "outside click closes the menu");
  } finally {
    await browser.close();
  }
});

test("UI E2E: replace and paste apply clipboard content", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await page.evaluate(() => {
      window.__clip = "ClipNode # @d2pos 5,5\n";
      Object.defineProperty(navigator, "clipboard", {
        value: { readText: async () => window.__clip, writeText: async () => {} },
        configurable: true
      });
    });

    // replace the whole code with the clipboard
    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="replace"]');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok((await text(page)).includes("ClipNode"), "replace set the code from clipboard");
    assert.ok(/Новых блоков/.test(await page.$eval("#outStatus", (el) => el.textContent)), "replace merged into graph");
    assert.equal(await page.$$eval("#nodes .node", (els) => els.length), 1, "only the clip node in the diagram");

    // paste inserts at the caret, keeping surrounding text
    await page.evaluate(() => { window.__clip = "PasteNode # @d2pos 3,3\n"; });
    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="replace"]');
    await new Promise((r) => setTimeout(r, 200));
    const base = await text(page);
    const mid = Math.floor(base.length / 2);
    await page.$eval("#out", (el, m) => { el.focus(); el.setSelectionRange(m, m); }, mid);
    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="paste"]');
    await new Promise((r) => setTimeout(r, 200));
    const after = await text(page);
    assert.ok(after.length > base.length, "paste inserted text");
    assert.ok(after.includes("PasteNode"), "paste inserted the clipboard fragment");
  } finally {
    await browser.close();
  }
});

test("UI E2E: import reads a .d2 file and replaces the code", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    const file = join(tmpdir(), "d2editor-e2e-import.d2");
    fs.writeFileSync(file, "FromFileNode # @d2pos 9,9\nFromFileNode2 -> FromFileNode\n");

    await page.click("#btnCopyMenu");
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 5000 }),
      page.click('#copy-menu button[data-act="import"]')
    ]);
    await chooser.accept([file]);
    await new Promise((r) => setTimeout(r, 300));

    assert.ok((await text(page)).includes("FromFileNode"), "import loaded the file content");
    assert.equal(await page.$$eval("#nodes .node", (els) => els.length), 2, "file nodes rendered");
  } finally {
    await browser.close();
  }
});

test("UI E2E: export opens the native save dialog and writes the file", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await page.evaluate(() => {
      window.__exported = null;
      window.__suggested = null;
      window.__pickerTypes = null;
      window.showSaveFilePicker = async (opts) => {
        window.__suggested = opts.suggestedName;
        window.__pickerTypes = opts.types;
        return {
          name: opts.suggestedName,
          createWritable: async () => ({
            write: async (c) => { window.__exported = c; },
            close: async () => {}
          })
        };
      };
    });

    const before = await text(page);
    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="export"]');
    await new Promise((r) => setTimeout(r, 200));

    const ex = await page.evaluate(() => ({
      suggested: window.__suggested,
      content: window.__exported,
      status: document.getElementById("outStatus").textContent,
      pickerAccept: window.__pickerTypes && window.__pickerTypes[0] && window.__pickerTypes[0].accept
    }));
    assert.equal(ex.suggested, "diagram.d2", "save dialog suggests diagram.d2");
    assert.equal(ex.content, before, "export wrote the current code");
    assert.ok(/Экспортировано в diagram\.d2/.test(ex.status), "status reports the export");
    assert.ok(ex.pickerAccept && !("text/plain" in ex.pickerAccept), "picker filter no longer uses text/plain");
    assert.deepEqual(ex.pickerAccept && ex.pickerAccept["application/x-d2"], [".d2"], "picker requests only the .d2 extension");
  } finally {
    await browser.close();
  }
});

test("UI E2E: export forces the .d2 extension and remembers the filename", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    // simulate the user typing "myfile" (no extension) in the save dialog
    const stubPicker = () => page.evaluate(() => {
      window.__suggested = null;
      window.showSaveFilePicker = async (opts) => {
        window.__suggested = opts.suggestedName;
        const handle = {
          name: "myfile",
          move: async (n) => { handle.name = n; },
          createWritable: async () => ({
            write: async () => {},
            close: async () => {}
          })
        };
        return handle;
      };
    });
    await stubPicker();

    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="export"]');
    await new Promise((r) => setTimeout(r, 200));
    const status = await page.$eval("#outStatus", (el) => el.textContent);
    assert.ok(/Экспортировано в myfile\.d2/.test(status), ".d2 enforced in status: " + status);
    assert.equal(await page.evaluate(() => window.__suggested), "diagram.d2", "first export suggests diagram.d2");

    // next export suggests the remembered name
    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="export"]');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page.evaluate(() => window.__suggested), "myfile.d2", "remembered name suggested next time");

    // persisted to localStorage
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("d2editor:ui:v1")));
    assert.equal(saved && saved.exportName, "myfile.d2", "exportName persisted to ui prefs");

    // restored on a fresh page that shares localStorage (no clear)
    const page2 = await browser.newPage();
    await page2.goto(URL);
    await page2.waitForSelector("#out");
    await page2.evaluate(() => {
      window.__suggested = null;
      window.showSaveFilePicker = async (opts) => {
        window.__suggested = opts.suggestedName;
        return { name: opts.suggestedName, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      };
    });
    await page2.click("#btnCopyMenu");
    await page2.click('#copy-menu button[data-act="export"]');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page2.evaluate(() => window.__suggested), "myfile.d2", "name restored from localStorage");
  } finally {
    await browser.close();
  }
});

test("UI E2E: export falls back to a diagram.d2 download without the save picker", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await page.evaluate(() => {
      window.__exported = null;
      window.__blob = null;
      window.showSaveFilePicker = undefined;
      URL.createObjectURL = (b) => { window.__blob = b; return "blob:stub"; };
      HTMLAnchorElement.prototype.click = function () { window.__exported = { download: this.download }; };
    });

    const before = await text(page);
    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="export"]');
    await new Promise((r) => setTimeout(r, 200));

    const ex = await page.evaluate(async () => ({
      download: window.__exported && window.__exported.download,
      content: window.__blob ? await window.__blob.text() : null
    }));
    assert.equal(ex.download, "diagram.d2", "fallback export filename");
    assert.equal(ex.content, before, "fallback export contains the current code");
  } finally {
    await browser.close();
  }
});

test("UI E2E: export SVG produces a self-contained vector document", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await page.evaluate(() => {
      window.__svg = null;
      window.showSaveFilePicker = async (opts) => ({
        name: opts.suggestedName,
        createWritable: async () => ({
          write: async (c) => { window.__svg = c; },
          close: async () => {}
        })
      });
    });

    await setText(page, '"Клиент" # @d2pos 60,300\n"Сервер": {\n  "База" # @d2pos 40,60\n}\n"Клиент" -> "Сервер" {label: запрос}\n"Сервер" -> "Клиент"\n');
    await waitEdit();

    await page.click("#btnCopyMenu");
    await page.click('#copy-menu button[data-act="export-svg"]');
    await new Promise((r) => setTimeout(r, 200));

    const svg = await page.evaluate(() => window.__svg);
    assert.ok(svg.startsWith("<?xml"), "xml declaration present");
    assert.ok(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+"/.test(svg), "svg root with xmlns and viewBox");
    assert.ok(!/foreignObject/i.test(svg), "no foreignObject, native primitives only");
    assert.ok(/<marker id="arrow"/.test(svg), "arrow marker defined in defs");
    assert.ok(/marker-end="url\(#arrow\)"/.test(svg), "edge path uses the arrow marker");
    assert.ok(svg.includes('stroke-dasharray="8 5"'), "container uses dashed border");
    assert.ok(svg.includes('fill="#ffffff"'), "white background and node fill present");
    assert.ok(svg.includes("Клиент") && svg.includes("Сервер") && svg.includes("База"), "node labels present");
    assert.ok(svg.includes("запрос"), "edge label present");
    assert.ok(!svg.includes(">null<"), "edges without a label render no text at all");
    const dashIdx = svg.indexOf('stroke-dasharray="8 5"');
    const edgeIdx = svg.indexOf("marker-end=");
    assert.ok(dashIdx !== -1 && edgeIdx !== -1 && dashIdx < edgeIdx, "container background renders below edges (edges stay visible inside groups)");
    assert.ok(svg.endsWith("</svg>\n"), "document closed");
  } finally {
    await browser.close();
  }
});

test("UI E2E: diagram content stays below the flowbar when panning", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);

    const barBottom = await page.$eval(".flowbar", (el) => el.getBoundingClientRect().bottom);

    // pan: drag empty pane area upward so diagram content would slide over the bar
    await page.mouse.move(900, 400);
    await page.mouse.down();
    await page.mouse.move(900, 150, { steps: 10 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 300));

    const hit = await page.evaluate((y) => {
      const el = document.elementFromPoint(640, y);
      return {
        isFlowbar: !!(el && el.closest && el.closest(".flowbar")),
        isDiagram: !!(el && el.closest && (el.closest("#nodes") || el.closest("#edges")))
      };
    }, barBottom - 8);
    assert.equal(hit.isFlowbar, true, "flowbar receives the pointer at its bottom edge");
    assert.equal(hit.isDiagram, false, "diagram does not cover the flowbar");
  } finally {
    await browser.close();
  }
});

test("moving an edge line inside its container does not freeze the page (no duplicate ids)", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(URL);
    await page.waitForSelector("#out");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector("#out");

    const scenario = '"Группа 1": { # @d2pos 300,100\n'
      + '  "подгруппа 1": { # @d2pos 30,30\n'
      + '    456 # @d2pos 20,20\n'
      + '  }\n'
      + '  789 # @d2pos 20,110\n'
      + '}\n'
      + '\n'
      + '"Группа 1".789 -> "Группа 1"."подгруппа 1".456\n';
    await setText(page, scenario);
    await waitEdit();
    assert.ok(/Новых блоков/.test(await page.$eval("#outStatus", (el) => el.textContent)), "scenario applied");

    // move the edge line inside the "Группа 1" block scope
    const live = await text(page);
    const edge = '"Группа 1".789 -> "Группа 1"."подгруппа 1".456';
    const moved = live.replace("\n}\n\n" + edge, "\n  " + edge + "\n}");
    assert.notEqual(moved, live, "edge moved inside the container");
    await setText(page, moved);

    // if the page had frozen, this evaluate would never resolve and the test would time out
    await waitEdit();
    const status = await page.$eval("#outStatus", (el) => el.textContent);
    assert.equal(status, "Синхронизировано", "moved edge is a rename-free sync, not a hang");

    const nodeCount = await page.$$eval("#nodes .node", (els) => els.length);
    assert.equal(nodeCount, 4, "still the 4 original nodes, no duplicates rendered");

    const finalText = await text(page);
    assert.equal((finalText.match(/"Группа 1": \{/g) || []).length, 1, "container declared once, no nested duplicate");
    assert.ok(finalText.includes("  " + edge), "edge stays inside the container scope");
  } finally {
    await browser.close();
  }
});
