import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { parseD2 } = require("../js/d2-parse.js");
const { mergeGraph } = require("../js/d2-merge.js");
const {
  placeNewNode, absBox, indexById, PAD, HEAD, MARGIN
} = require("../js/d2-layout.js");

function node(id, extra = {}) {
  return { id, label: id, x: 0, y: 0, w: 150, h: 70, parentId: null, children: [],
    comments: [], trailingComment: null, rawAttrs: [], implicit: false, hasPos: false, ...extra };
}
const edge = (id, source, target, extra = {}) => ({ id, source, target, label: null,
  comments: [], trailingComment: null, rawAttrs: [], ...extra });

function graphOf(nodes, edges = []) {
  return { v: 2, nodes, edges, order: nodes.map((n) => n.id).concat(edges.map((e) => e.id)),
    headerComments: [], trailingComments: [], idCounter: 1,
    viewport: { x: 0, y: 0, zoom: 1 }, showComments: true };
}

function allBoxes(graph, excludeId) {
  const byId = indexById(graph);
  return graph.nodes.filter((n) => n.id !== excludeId).map((n) => absBox(byId, n));
}

test("fresh root node: placed at viewport center", () => {
  const g = graphOf([node("a")]);
  const r = placeNewNode(g, "a", { center: { x: 1000, y: 500 } });
  assert.equal(r.x, 925);
  assert.equal(r.y, 465);
  assert.equal(g.nodes[0].hasPos, true);
});

test("new target of an edge placed to the right of the source", () => {
  const a = node("a", { x: 100, y: 100, hasPos: true });
  const b = node("b");
  const g = graphOf([a, b], [edge("e1", "a", "b")]);
  placeNewNode(g, "b");
  const ba = absBox(indexById(g), b);
  const aa = absBox(indexById(g), a);
  assert.ok(ba.x >= aa.x + aa.w, "b right of a");
  assert.ok(!require("../js/d2-layout.js").overlaps(ba, aa, MARGIN), "no overlap");
});

test("new source of an edge placed to the left of the target", () => {
  const b = node("b", { x: 300, y: 100, hasPos: true });
  const a = node("a");
  const g = graphOf([a, b], [edge("e1", "a", "b")]);
  placeNewNode(g, "a");
  const aa = absBox(indexById(g), a);
  const ba = absBox(indexById(g), b);
  assert.ok(aa.x + aa.w <= ba.x, "a left of b");
});

test("new child lands inside container at PAD,HEAD, avoiding siblings", () => {
  const child = node("c1", { x: PAD, y: HEAD, hasPos: true });
  const container = node("box", { children: ["c1"], hasPos: true, x: 50, y: 50 });
  const fresh = node("c2");
  const g = graphOf([container, child, fresh]);
  fresh.parentId = "box";
  container.children = ["c1", "c2"];

  placeNewNode(g, "c2");

  const byId = indexById(g);
  const abs = absBox(byId, container);
  const c2 = absBox(byId, fresh);
  assert.ok(c2.x >= abs.x, "inside container left edge");
  assert.ok(c2.y >= abs.y, "inside container top edge");
  const c1 = absBox(byId, child);
  assert.ok(!require("../js/d2-layout.js").overlaps(c2, c1, MARGIN), "no overlap with sibling");
});

test("hasPos node is left untouched", () => {
  const a = node("a", { x: 42, y: 42, hasPos: true });
  const g = graphOf([a]);
  const r = placeNewNode(g, "a", { center: { x: 0, y: 0 } });
  assert.deepEqual(r, { x: 42, y: 42 });
  assert.equal(a.x, 42);
});

test("dense cluster: inserted node lands collision-free", () => {
  const g = graphOf([
    node("n0", { x: 0, y: 0, hasPos: true }),
    node("n1", { x: 170, y: 0, hasPos: true }),
    node("n2", { x: 0, y: 90, hasPos: true }),
    node("n3", { x: 170, y: 90, hasPos: true }),
    node("n4", { x: 340, y: 0, hasPos: true }),
    node("n5", { x: 340, y: 90, hasPos: true })
  ]);
  const fresh = node("x");
  g.nodes.push(fresh);
  placeNewNode(g, "x", { center: { x: 85, y: 45 } });

  const byId = indexById(g);
  const mine = absBox(byId, fresh);
  for (const n of g.nodes) {
    if (n.id === "x") continue;
    const b = absBox(byId, n);
    assert.ok(!require("../js/d2-layout.js").overlaps(mine, b, MARGIN),
      "x overlaps " + n.id);
  }
});

test("merge added nodes placed sequentially without overlaps", () => {
  const current = parseD2('a: {\n  b # @d2pos 30,40\n}\n').graph;
  const text2 = 'a: {\n  b # @d2pos 30,40\n  c\n}\nd: {}\nx\n\na -> d\na -> x\n';
  const parsed = parseD2(text2);
  assert.ok(parsed.ok, JSON.stringify(parsed.error));
  const out = mergeGraph(parsed.graph, current);
  assert.equal(out.added.length, 3, "c, d, x added");
  for (const id of out.added) placeNewNode(out.graph, id, { center: { x: 400, y: 300 } });

  const byId = indexById(out.graph);
  const isAncestor = (ancId, n) => {
    let cur = n;
    while (cur) {
      if (cur.id === ancId) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return false;
  };
  for (const n of out.graph.nodes) {
    for (const m of out.graph.nodes) {
      if (m.id === n.id) continue;
      if (isAncestor(n.id, m) || isAncestor(m.id, n)) continue;
      assert.ok(!require("../js/d2-layout.js").overlaps(absBox(byId, n), absBox(byId, m), MARGIN),
        "collision between " + n.id + " and " + m.id);
    }
  }
  const c = out.graph.nodes.find((n) => n.id === "c");
  assert.equal(c.parentId, "a", "c inside container a");
  const inside = absBox(byId, c);
  const ab = absBox(byId, out.graph.nodes.find((n) => n.id === "a"));
  assert.ok(inside.x >= ab.x && inside.y >= ab.y, "c inside container bounds");
});
