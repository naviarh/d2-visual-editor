import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createHistory, pushState, undo, redo, canUndo, canRedo, clearHistory, diffStates, applyStatePatch } = require("../js/d2-history.js");

function node(id, extra) {
  return { id, label: id, x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], hasPos: true, ...extra };
}

function edge(id, extra) {
  return { id, source: "A", target: "B", label: null, ...extra };
}

function state(opts) {
  return {
    v: 2,
    nodes: (opts.nodes || []).map((n) => ({ ...n })),
    edges: (opts.edges || []).map((e) => ({ ...e })),
    order: (opts.order || []).slice(),
    idCounter: opts.idCounter != null ? opts.idCounter : 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    showComments: false
  };
}

test("createHistory: defaults and clamping (numeric limit)", () => {
  const h = createHistory();
  assert.equal(h.limit, 100);
  assert.deepEqual(h.stack, []);
  assert.deepEqual(h.redo, []);
  assert.equal(createHistory(0).limit, 1, "limit clamped up to 1");
  assert.equal(createHistory(2).limit, 2);
  assert.equal(createHistory("x").limit, 100, "non-numeric limit falls back to default");
  assert.equal(createHistory({ limit: 5 }).limit, 100, "object form (plan draft) falls back to default");
});

test("push/undo/redo: LIFO, redo cleared by a new push", () => {
  const h = createHistory({ limit: 5 });
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);

  pushState(h, { n: 1 });
  pushState(h, { n: 2 });
  assert.equal(canUndo(h), true);
  assert.equal(canRedo(h), false);

  assert.deepEqual(undo(h), { n: 2 }, "undo pops the newest patch");
  assert.equal(canRedo(h), true);
  assert.deepEqual(undo(h), { n: 1 });
  assert.equal(undo(h), null, "empty undo stack");
  assert.deepEqual(redo(h), { n: 1 }, "redo restores in order");
  assert.deepEqual(redo(h), { n: 2 });
  assert.equal(redo(h), null, "empty redo stack");

  pushState(h, { n: 1 });
  undo(h);
  pushState(h, { n: 3 });
  assert.equal(canRedo(h), false, "new push discards the redo branch");
  assert.deepEqual(undo(h), { n: 3 });
});

test("limit: oldest entries are evicted", () => {
  const h = createHistory(2);
  pushState(h, "p1");
  pushState(h, "p2");
  pushState(h, "p3");
  assert.equal(h.stack.length, 2, "stack trimmed to the limit");
  assert.equal(undo(h), "p3");
  assert.equal(undo(h), "p2");
  assert.equal(undo(h), null, "p1 was evicted");
});

test("diffStates: identical states (even with shuffled node key order) yield null", () => {
  const a = state({ nodes: [node("A")], order: ["A"] });
  const b = state({
    nodes: [{ parentId: null, w: 150, hasPos: true, x: 0, label: "A", id: "A", y: 0, children: [], h: 70 }],
    order: ["A"]
  });
  assert.equal(diffStates(a, b), null, "key order must not matter");
});

test("diffStates: node added / removed / changed", () => {
  const a = state({ nodes: [node("A")], order: ["A"] });

  const addB = state({ nodes: [node("A"), node("B")], order: ["A", "B"] });
  const pAdd = diffStates(a, addB);
  assert.ok(pAdd && pAdd.nodes && pAdd.nodes.B, "added node recorded");
  assert.equal(pAdd.nodes.B.before, null);
  assert.equal(pAdd.nodes.B.after.label, "B");
  assert.ok(pAdd.order, "order change recorded");

  const pDel = diffStates(addB, a);
  assert.ok(pDel && pDel.nodes && pDel.nodes.B, "removed node recorded");
  assert.equal(pDel.nodes.B.after, null);

  const ch = state({ nodes: [node("A", { label: "Renamed" })], order: ["A"] });
  const pCh = diffStates(a, ch);
  assert.ok(pCh && pCh.nodes && pCh.nodes.A, "changed node recorded");
  assert.equal(pCh.nodes.A.before.label, "A");
  assert.equal(pCh.nodes.A.after.label, "Renamed");
});

test("diffStates: edges added / removed", () => {
  const a = state({ nodes: [node("A"), node("B")], order: ["A", "B"] });
  const withE = state({ nodes: [node("A"), node("B")], edges: [edge("e1")], order: ["A", "B", "e1"] });
  const pAdd = diffStates(a, withE);
  assert.ok(pAdd && pAdd.edges && pAdd.edges.e1, "added edge recorded");
  assert.equal(pAdd.edges.e1.before, null);
  const pDel = diffStates(withE, a);
  assert.equal(pDel.edges.e1.after, null, "removed edge recorded");
});

test("diffStates: viewport and showComments", () => {
  const a = state({ nodes: [node("A")], order: ["A"] });
  const b = state({ nodes: [node("A")], order: ["A"] });
  b.viewport = { x: 100, y: 50, zoom: 1.5 };
  const pv = diffStates(a, b);
  assert.ok(pv && pv.viewport, "viewport change recorded");
  assert.deepEqual(pv.viewport.before, { x: 0, y: 0, zoom: 1 });

  const c = state({ nodes: [node("A")], order: ["A"] });
  c.showComments = true;
  const pc = diffStates(a, c);
  assert.ok(pc && pc.showComments, "showComments change recorded");
  assert.equal(pc.showComments.before, false);
  assert.equal(pc.showComments.after, true);
});

test("diffStates: idCounter is excluded from comparison", () => {
  const a = state({ nodes: [node("A")], order: ["A"], idCounter: 3 });
  const b = state({ nodes: [node("A")], order: ["A"], idCounter: 99 });
  assert.equal(diffStates(a, b), null, "idCounter alone must not create a patch");
});

test("diffStates: raw '' vs null edge labels ARE a diff — normalization must happen upstream", () => {
  // diffStates compares values as-is: the visual editor stores an empty dialog
  // result as label:"", the parser stores label:null. These must be normalized
  // to a single form (currentGraph() in index.html maps label:"" -> null)
  // BEFORE diffing; the module itself has no such policy.
  const a = state({ nodes: [node("A"), node("B")], edges: [edge("e1", { label: "" })], order: ["A", "B", "e1"] });
  const b = state({ nodes: [node("A"), node("B")], edges: [edge("e1", { label: null })], order: ["A", "B", "e1"] });
  const p = diffStates(a, b);
  assert.ok(p && p.edges && p.edges.e1, "module flags '' vs null (upstream must normalize)");
});

test("diffStates: missing implicit key equals implicit:false (no spurious patch)", () => {
  // Visually created nodes carry no implicit key; the parser sets it explicitly
  // (implicit:false for declared nodes). currentGraph() normalizes to false;
  // diffStates must not flag the absent key.
  const a = state({ nodes: [{ id: "V", label: "V", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], hasPos: true }], order: ["V"] });
  const b = state({ nodes: [node("V")], order: ["V"] });
  assert.equal(diffStates(a, b), null, "missing implicit key compares equal to false");
});

test("diffStates: whitespace-only text edit is an empty diff", () => {
  // Regression: a text edit that changes nothing structural (e.g. an added
  // blank line) must not be recorded in history.
  const g = state({ nodes: [node("A"), node("B")], edges: [edge("e1")], order: ["A", "B", "e1"] });
  const copy = JSON.parse(JSON.stringify(g));
  copy.showComments = false;
  assert.equal(diffStates(g, copy), null);
});

function liveGraph(patch) {
  const nodes = new Map();
  for (const n of patch.nodes) nodes.set(n.id, n);
  return {
    nodes,
    edges: patch.edges.slice(),
    order: patch.order.slice(),
    idCounter: patch.idCounter,
    viewport: { ...patch.viewport },
    showComments: patch.showComments
  };
}

test("applyStatePatch: undo/redo round-trip restores the exact pre/post state", () => {
  const pre = state({ nodes: [node("A"), node("B")], order: ["A", "B"], idCounter: 5 });
  const post = state({ nodes: [node("A"), node("B"), node("C")], order: ["A", "B", "C"], idCounter: 6 });
  post.viewport = { x: 10, y: 20, zoom: 2 };
  post.showComments = true;
  const patch = diffStates(pre, post);

  const live = liveGraph(post);
  applyStatePatch(live, patch, "before");
  assert.equal(live.nodes.size, 2, "undo removes the added node");
  assert.ok(!live.nodes.has("C"));
  assert.deepEqual(live.order, ["A", "B"]);
  assert.equal(live.viewport.zoom, 1, "viewport restored");
  assert.equal(live.showComments, false, "showComments restored");

  applyStatePatch(live, patch, "after");
  assert.equal(live.nodes.size, 3, "redo re-adds the node");
  assert.equal(live.nodes.get("C").label, "C");
  assert.deepEqual(live.order, ["A", "B", "C"]);
  assert.deepEqual(live.viewport, { x: 10, y: 20, zoom: 2 });
  assert.equal(live.showComments, true);
});

test("applyStatePatch: deleting a node also drops its incident edges", () => {
  const pre = state({
    nodes: [node("A"), node("B"), node("C")],
    edges: [edge("e1", { source: "A", target: "B" }), edge("e2", { source: "A", target: "C" })],
    order: ["A", "B", "C", "e1", "e2"]
  });
  const post = state({
    nodes: [node("A"), node("B")],
    edges: [edge("e1", { source: "A", target: "B" })],
    order: ["A", "B", "e1"]
  });
  const patch = diffStates(pre, post);

  const live = liveGraph(post);
  applyStatePatch(live, patch, "before");
  assert.equal(live.nodes.size, 3, "undo restores the deleted node");
  assert.equal(live.edges.length, 2, "undo restores its incident edges");
  assert.deepEqual(live.edges.map((e) => e.id), ["e1", "e2"], "edges rebuilt in order");
  assert.deepEqual(live.order, ["A", "B", "C", "e1", "e2"]);

  applyStatePatch(live, patch, "after");
  assert.equal(live.nodes.size, 2);
  assert.equal(live.edges.length, 1, "redo removes the node's edges again");
});

test("applyStatePatch: edge array is rebuilt along the restored order", () => {
  // Reversed order in the patch must reorder the live array, not append.
  const pre = state({
    nodes: [node("A"), node("B")],
    edges: [edge("e1"), edge("e2"), edge("e3")],
    order: ["A", "B", "e1", "e2", "e3"]
  });
  const post = state({
    nodes: [node("A"), node("B")],
    edges: [edge("e3"), edge("e2"), edge("e1")],
    order: ["A", "B", "e3", "e2", "e1"]
  });
  const patch = diffStates(pre, post);
  assert.ok(patch, "edge order change is a diff");

  const live = liveGraph(post);
  applyStatePatch(live, patch, "before");
  assert.deepEqual(live.edges.map((e) => e.id), ["e1", "e2", "e3"], "undo restores the original draw order");
});

test("clearHistory empties both stacks", () => {
  const h = createHistory({ limit: 5 });
  pushState(h, { n: 1 });
  undo(h);
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), true);
  clearHistory(h);
  assert.equal(canRedo(h), false);
  assert.equal(h.stack.length, 0);
  assert.equal(h.redo.length, 0);
});
