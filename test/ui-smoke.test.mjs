import { test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

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
      .replace('Client # @d2pos 60,300', 'WebClient # @d2pos 60,300')
      .replace('Client -> "API Server"', 'WebClient -> "API Server"');
    await setText(page, renamed);
    await new Promise((r) => setTimeout(r, 1400));
    const afterRename = await text(page);
    assert.ok(afterRename.includes("WebClient # @d2pos 60,300"), "rename kept marker");
    assert.ok(afterRename.includes('WebClient -> "API Server"'), "edge reference renamed");
    assert.ok(afterRename.includes("@d2pos 60,300"), "position preserved");
    assert.equal(await page.$eval("#outStatus", (el) => el.textContent), "Синхронизировано");

    // insert a new block -> auto-position, order at end, status message
    const inserted = afterRename.replace("Database # @d2pos 40,60",
      "Database # @d2pos 40,60\nNewBlock # @d2pos 5,5");
    await setText(page, inserted);
    await new Promise((r) => setTimeout(r, 1400));
    const afterInsert = await text(page);
    assert.ok(afterInsert.includes("NewBlock"), "new block present");
    const status = await page.$eval("#outStatus", (el) => el.textContent);
    assert.ok(/Новых блоков/.test(status), "status mentions new blocks: " + status);
    const nodeLabels = await page.$$eval("#nodes .node .nlabel", (els) => els.map((e) => e.textContent));
    assert.ok(nodeLabels.includes("NewBlock"), "NewBlock rendered in diagram");

    // syntax error -> graph untouched, status shows error line
    const bad = (await text(page)).replace('"API Server" -> Worker', '"API Server" ->');
    await setText(page, bad);
    await new Promise((r) => setTimeout(r, 1400));
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
    await new Promise((r) => setTimeout(r, 1400));
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
