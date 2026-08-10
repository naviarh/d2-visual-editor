import { test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const EXE = process.env.CHROME || "/usr/bin/google-chrome-stable";
const URL = "file:///mnt/Data/Documents/D2/index.html";

async function freshPage(browser, uiPrefs) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((p) => {
    localStorage.clear();
    if (p) localStorage.setItem("d2editor:ui:v1", JSON.stringify(p));
  }, uiPrefs || null);
  await page.goto(URL);
  await page.waitForSelector("#out");
  await new Promise((r) => setTimeout(r, 300));
  return page;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitEdit = () => new Promise((r) => setTimeout(r, 3400));

const nodesCount = (page) => page.$$eval("#nodes .node", (els) => els.length);
const edgesCount = (page) => page.$$eval("#edges .edge-g", (els) => els.length);
const text = (page) => page.$eval("#out", (el) => el.value);
const undoEnabled = (page) => page.$eval("#btnUndo", (el) => !el.disabled);
const redoEnabled = (page) => page.$eval("#btnRedo", (el) => !el.disabled);
const hasLabel = (page, label) =>
  page.$$eval("#nodes .node .nlabel", (els, l) => els.some((e) => e.textContent === l), label);

async function setText(page, s) {
  await page.$eval("#out", (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, s);
}

async function addBlock(page, name) {
  await page.click("#btnBlock");
  await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
  await page.$eval("#modal-input", (el, v) => { el.value = v; }, name);
  await page.click("#modal-ok");
  await page.$eval("body", (el) => el.focus());
  await wait(150);
}

const undoClick = (page) => page.click("#btnUndo").then(() => wait(250));
const redoClick = (page) => page.click("#btnRedo").then(() => wait(250));

async function ctrlKey(page, key) {
  await page.keyboard.down("Control");
  if (key === "y") {
    await page.keyboard.press("y");
  } else if (key === "shift-z") {
    await page.keyboard.down("Shift");
    await page.keyboard.press("z");
    await page.keyboard.up("Shift");
  } else {
    await page.keyboard.press("z");
  }
  await page.keyboard.up("Control");
  await wait(200);
}

test("history: add block, undo and redo restore graph and code (buttons)", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    const before = await nodesCount(page);
    assert.equal(await undoEnabled(page), false, "empty history disables undo");
    assert.equal(await redoEnabled(page), false, "empty history disables redo");

    await addBlock(page, "H1");
    assert.equal(await nodesCount(page), before + 1, "block added");
    assert.equal(await hasLabel(page, "H1"), true, "block visible in diagram");
    assert.equal(await undoEnabled(page), true, "action recorded, undo enabled");

    await undoClick(page);
    assert.equal(await nodesCount(page), before, "undo removes the block");
    assert.equal(await hasLabel(page, "H1"), false, "block gone from diagram");
    assert.ok(!(await text(page)).includes("H1"), "block gone from code");
    assert.equal(await undoEnabled(page), false, "single entry undone, undo disabled");
    assert.equal(await redoEnabled(page), true, "redo enabled");

    await redoClick(page);
    assert.equal(await nodesCount(page), before + 1, "redo re-adds the block");
    assert.equal(await hasLabel(page, "H1"), true, "block back in diagram");
    assert.ok((await text(page)).includes("H1"), "block back in code");
  } finally {
    await browser.close();
  }
});

test("history: Ctrl+Z / Ctrl+Shift+Z outside the textarea undo and redo", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    const before = await nodesCount(page);
    await addBlock(page, "K1");
    assert.equal(await nodesCount(page), before + 1);

    await ctrlKey(page, "z");
    assert.equal(await nodesCount(page), before, "Ctrl+Z undoes the block add");
    assert.ok(!(await text(page)).includes("K1"), "code reverted too");

    await ctrlKey(page, "shift-z");
    assert.equal(await nodesCount(page), before + 1, "Ctrl+Shift+Z redoes the block add");
    assert.ok((await text(page)).includes("K1"), "code restored too");
  } finally {
    await browser.close();
  }
});

test("history: whitespace-only text edit creates no history entry", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    const before = await nodesCount(page);
    await addBlock(page, "W1");
    await wait(1500); // let queueGen put W1 into the code editor

    // The first blank-line edit reconciles the graph order with the scoped
    // edge emission (a one-time order diff caused by the form change), so it
    // is recorded.
    await setText(page, (await text(page)) + "\n");
    await waitEdit();
    assert.equal(await nodesCount(page), before + 1, "blank line changes nothing in the graph");

    // A second identical edit is a true no-op and must not be recorded: the
    // history holds exactly [add W1, order reconcile].
    await setText(page, (await text(page)) + "\n");
    await waitEdit();
    assert.equal(await nodesCount(page), before + 1, "second blank line changes nothing in the graph");
    assert.equal(await undoEnabled(page), true, "undo still available");

    // Two undos remove W1: one for the order reconcile, one for the add. Had
    // the second blank line been recorded, three would be needed.
    await undoClick(page);
    assert.equal(await nodesCount(page), before + 1, "first undo reverts the order reconcile, W1 stays");
    await undoClick(page);
    assert.equal(await nodesCount(page), before, "second undo removes the added block");
    assert.equal(await hasLabel(page, "W1"), false, "W1 gone after two undos");
  } finally {
    await browser.close();
  }
});

test("history: native Ctrl+Z inside the textarea, the app does not record typing", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    const before = await nodesCount(page);
    await page.$eval("#out", (el) => { el.focus(); const l = el.value.length; el.setSelectionRange(l, l); });
    await page.keyboard.type("ZZZ-extra");
    await wait(150);
    assert.ok((await text(page)).includes("ZZZ-extra"), "typed text present before undo");

    await ctrlKey(page, "z"); // focus is still in the textarea -> native undo
    assert.ok(!(await text(page)).includes("ZZZ-extra"), "native undo reverts the typing");
    assert.equal(await nodesCount(page), before, "the graph is untouched by typing");
    assert.equal(await undoEnabled(page), false, "typing in the editor is not recorded");
  } finally {
    await browser.close();
  }
});

test("history: dragging a node is undoable and restores its position", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    await page.setViewport({ width: 1280, height: 800 });
    await page.reload();
    await page.waitForSelector("#out");

    // pick the leaf whose center has the most room towards the bottom-right
    const target = await page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      let best = { score: -1, x: 0, y: 0 };
      for (const el of document.querySelectorAll("#nodes .node:not(.container)")) {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const score = Math.min(vw - cx - 150, vh - cy - 120);
        if (score > best.score) best = { score, x: cx, y: cy };
      }
      return best;
    });

    const before = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      const node = el && el.closest ? el.closest(".node") : null;
      const r = node && node.getBoundingClientRect();
      return r ? { x: r.x, y: r.y } : null;
    }, target);
    assert.ok(before, "node located at the chosen point");

    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 120, target.y + 80, { steps: 10 });
    await page.mouse.up();
    await wait(250);

    const moved = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      const node = el && el.closest ? el.closest(".node") : null;
      const r = node && node.getBoundingClientRect();
      return r ? { x: r.x, y: r.y } : null;
    }, { x: target.x + 120, y: target.y + 80 });
    assert.ok(moved, "the dragged node sits under the pointer after the drag");
    assert.ok(Math.abs(moved.x - (before.x + 120)) < 5 && Math.abs(moved.y - (before.y + 80)) < 5,
      "node followed the pointer by the drag delta");

    await undoClick(page);
    const restored = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      const node = el && el.closest ? el.closest(".node") : null;
      const r = node && node.getBoundingClientRect();
      return r ? { x: r.x, y: r.y } : null;
    }, target);
    assert.ok(restored, "node present after undo");
    assert.ok(Math.abs(restored.x - before.x) < 3 && Math.abs(restored.y - before.y) < 3,
      "undo restores the exact pre-drag position");
  } finally {
    await browser.close();
  }
});

test("history: deleting a node is undoable and restores its edges", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    // the seed node "1" has outgoing edges
    const center = await page.$$eval("#nodes .node:not(.container)", (els) => {
      const list = [...els];
      const target = list.find((el) => {
        const lab = el.querySelector(".nlabel");
        return lab && lab.textContent === "1";
      }) || list[0];
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const nodesBefore = await nodesCount(page);
    const edgesBefore = await edgesCount(page);

    await page.mouse.click(center.x, center.y);
    await wait(150);
    await page.keyboard.press("Delete");
    await wait(250);
    assert.ok((await nodesCount(page)) < nodesBefore, "node removed by Delete");
    assert.ok((await edgesCount(page)) < edgesBefore, "its edges removed too");

    await undoClick(page);
    assert.equal(await nodesCount(page), nodesBefore, "undo restores the node");
    assert.equal(await edgesCount(page), edgesBefore, "undo restores its edges");
  } finally {
    await browser.close();
  }
});

test("history: renaming via double-click is undoable", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    // rename a leaf (the first non-container node); the container center is
    // covered by its children, so clicking it would hit a child instead
    const target = await page.$eval("#nodes .node:not(.container)", (el) => {
      const r = el.getBoundingClientRect();
      const lab = el.querySelector(".nlabel");
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: lab ? lab.textContent : "" };
    });
    assert.ok(target.label, "leaf has a label");
    assert.equal(await hasLabel(page, target.label), true, "old label present");

    await page.mouse.click(target.x, target.y, { clickCount: 1 });
    await wait(60);
    await page.mouse.click(target.x, target.y, { clickCount: 2 });
    await page.waitForSelector("#modal-overlay", { visible: true, timeout: 3000 });
    await page.$eval("#modal-input", (el, v) => { el.value = v; }, "WebClient");
    await page.click("#modal-ok");
    await wait(300);

    assert.equal(await hasLabel(page, "WebClient"), true, "rename applied");
    assert.equal(await hasLabel(page, target.label), false, "old name gone");

    await undoClick(page);
    assert.equal(await hasLabel(page, target.label), true, "undo restores the old name");
    assert.equal(await hasLabel(page, "WebClient"), false, "new name gone");
  } finally {
    await browser.close();
  }
});

test("history: changing a block's shape via the selector is undoable", { timeout: 90000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser);
    // pick a leaf without an explicit shape and capture its default geometry.
    // Every non-container node renders an svg.nshape (default = rectangle),
    // so the shape change is detected by comparing the SVG geometry.
    const target = await page.$eval("#nodes .node:not(.container)", (el) => {
      const r = el.getBoundingClientRect();
      const lab = el.querySelector(".nlabel");
      const svg = el.querySelector("svg.nshape");
      return {
        x: r.x + r.width / 2, y: r.y + r.height / 2,
        label: lab ? lab.textContent : "",
        svg: svg ? svg.outerHTML : null
      };
    });
    assert.ok(target.svg, "default node renders a shape svg");

    await page.mouse.click(target.x, target.y);
    await wait(150);
    assert.equal(await page.$eval("#shapeSel", (el) => el.disabled), false, "selector enabled");

    await page.select("#shapeSel", "diamond");
    await wait(300);
    const shaped = await page.evaluate((lab) => {
      const n = [...document.querySelectorAll("#nodes .node")].find((el) => {
        const l = el.querySelector(".nlabel");
        return l && l.textContent === lab;
      });
      const svg = n && n.querySelector("svg.nshape");
      return svg ? svg.outerHTML : null;
    }, target.label);
    assert.ok(shaped && shaped !== target.svg, "shape geometry applied");

    await undoClick(page);
    const unshaped = await page.evaluate((lab) => {
      const n = [...document.querySelectorAll("#nodes .node")].find((el) => {
        const l = el.querySelector(".nlabel");
        return l && l.textContent === lab;
      });
      const svg = n && n.querySelector("svg.nshape");
      return svg ? svg.outerHTML : null;
    }, target.label);
    assert.equal(unshaped, target.svg, "undo restores the original geometry");
  } finally {
    await browser.close();
  }
});

test("history: undo limit from ui prefs evicts old entries; a new action discards redo", { timeout: 60000 }, async (t) => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await freshPage(browser, { undoLimit: 2 });
    const base = await nodesCount(page);

    await addBlock(page, "L1");
    await addBlock(page, "L2");
    await addBlock(page, "L3");
    assert.equal(await nodesCount(page), base + 3);

    await undoClick(page);
    assert.equal(await nodesCount(page), base + 2, "undo removes L3");
    await undoClick(page);
    assert.equal(await nodesCount(page), base + 1, "undo removes L2");
    assert.equal(await redoEnabled(page), true, "redo still available");

    // the third undo is a no-op: L1 was evicted by the limit
    await undoClick(page);
    assert.equal(await nodesCount(page), base + 1, "L1 survives the third undo (evicted)");
    assert.equal(await undoEnabled(page), false, "undo disabled after eviction");

    // a fresh action discards the redo branch
    await addBlock(page, "L4");
    assert.equal(await redoEnabled(page), false, "new action clears the redo stack");
    await undoClick(page);
    assert.equal(await nodesCount(page), base + 1, "undo removes L4");
  } finally {
    await browser.close();
  }
});
