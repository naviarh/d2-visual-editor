import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { sortByArrows, treeOrder } = require("../js/d2-sort.js");

function node(id, extra = {}) {
  return { id, label: id, x: 0, y: 0, w: 150, h: 70, parentId: null, children: [],
    comments: [], trailingComment: null, rawAttrs: [], implicit: false, hasPos: false, ...extra };
}
const edge = (id, source, target, extra = {}) => ({ id, source, target, label: null,
  comments: [], trailingComment: null, rawAttrs: [], ...extra });

function graphOf(nodes, edges = [], order = null) {
  return { v: 2, nodes, edges, order: order || nodes.map((n) => n.id).concat(edges.map((e) => e.id)),
    headerComments: [], trailingComments: [], idCounter: 1,
    viewport: { x: 0, y: 0, zoom: 1 }, showComments: true };
}

function idx(g) {
  const m = new Map();
  for (const n of g.nodes) m.set(n.id, n);
  return m;
}

function posOf(order, id) {
  return order.indexOf(id);
}

test("empty graph and single node", () => {
  let g = sortByArrows(graphOf([]));
  assert.deepEqual(g.order, []);
  g = sortByArrows(graphOf([node("a")]));
  assert.deepEqual(g.order, ["a"]);
});

test("linear chain a -> b -> c", () => {
  const g = graphOf([node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c")],
    ["c", "b", "a", "e1", "e2"]);
  const s = sortByArrows(g);
  const p = posOf(s.order, "a"), q = posOf(s.order, "b"), r = posOf(s.order, "c");
  assert.ok(p < q && q < r, "topological chain order: " + s.order.join(","));
  assert.equal(s.order.slice(0, 3).join(","), "a,b,c");
  assert.equal(s.order.length, 5, "edges kept in order array");
  assert.ok(posOf(s.order, "e1") < posOf(s.order, "e2"), "edge relative order preserved");
});

test("diamond/rhombus a->b,a->c,b->d,c->d: a first, DFS follows edges", () => {
  const g = graphOf([node("a"), node("b"), node("c"), node("d")],
    [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")]);
  const s = sortByArrows(g);
  const p = posOf(s.order, "a"), b = posOf(s.order, "b"), d = posOf(s.order, "d");
  assert.equal(p, 0, "root first");
  assert.ok(b < d && p < posOf(s.order, "c"), "DFS follows a->b->d before a->c");
  // roughly topological: every arrow's source precedes target except DFS short-circuits
  const order = s.order.slice(0, 4);
  for (const [src, tgt] of [["a", "b"], ["a", "c"], ["b", "d"]]) {
    assert.ok(order.indexOf(src) < order.indexOf(tgt), src + " before " + tgt);
  }
});

test("cycle a->b->a: deterministic, no hang, all emitted once", () => {
  const g = graphOf([node("a"), node("b")],
    [edge("e1", "a", "b"), edge("e2", "b", "a")]);
  const s = sortByArrows(g);
  const before = new Set(s.order);
  assert.equal(before.size, s.order.length, "no duplicates");
  for (const id of ["a", "b"]) assert.ok(before.has(id), id + " present");
  assert.deepEqual(s.order.slice(0, 2).sort(), ["a", "b"]);
});

test("self-loop does not count as incoming and does not hang", () => {
  const g = graphOf([node("a"), node("b")],
    [edge("e1", "a", "a"), edge("e2", "a", "b")], ["b", "a"]);
  const s = sortByArrows(g);
  assert.equal(posOf(s.order, "a"), 0, "a has no incoming (self-loop ignored)");
  assert.equal(posOf(s.order, "b"), 1);
});

test("container: edge to container defers it, children sorted inside", () => {
  const cluster = node("cluster", { parentId: null });
  const api = node("api", { parentId: "cluster" });
  const db = node("db", { parentId: "cluster" });
  cluster.children = ["db", "api"];
  const server = node("server");
  const g = graphOf([cluster, api, db, server],
    [edge("e1", "server", "cluster"), edge("e2", "api", "db")],
    ["cluster", "server", "db", "api", "e1", "e2"]);
  const s = sortByArrows(g);
  const byId = idx(s);
  // container block position: server is root (no incoming in top scope), cluster deferred after it
  assert.ok(posOf(s.order, "server") < posOf(s.order, "cluster"), "server before container");
  // children of cluster are sorted: api has no incoming within scope -> first; db after
  const kids = byId.get("cluster").children;
  assert.equal(kids.length, 2);
  assert.equal(kids[0], "api");
  assert.equal(kids[1], "db");
});

test("cross-scope edge: top-level arrow into container child defers the container", () => {
  const web = node("web");
  const cluster = node("cluster");
  const app = node("app", { parentId: "cluster" });
  cluster.children = ["app"];
  const g = graphOf([web, cluster, app],
    [edge("e1", "web", "app")], ["web", "cluster", "app", "e1"]);
  const s = sortByArrows(g);
  assert.equal(posOf(s.order, "web"), 0, "root first");
  assert.equal(posOf(s.order, "cluster"), 1, "container follows, not its inner child");
  assert.equal(posOf(s.order, "app"), 2, "child inside its container");
});

test("incoming counted within scope only: cross-scope edge does not suppress child", () => {
  const cluster = node("cluster");
  const child = node("child", { parentId: "cluster" });
  cluster.children = ["child"];
  const server = node("server");
  const g = graphOf([cluster, child, server],
    [edge("e1", "server", "child")], ["cluster", "child", "server", "e1"]);
  const s = sortByArrows(g);
  const byId = idx(s);
  assert.equal(byId.get("cluster").children[0], "child", "child kept as sole child");
  const top = s.order.filter((id) => { const n = byId.get(id); return n && !n.parentId; });
  assert.deepEqual(top, ["cluster", "server"]);
});

test("two independent roots keep relative text order", () => {
  const g = graphOf([node("a"), node("b")], [], ["b", "a"]);
  const s = sortByArrows(g);
  assert.deepEqual(s.order.slice(0, 2), ["b", "a"]);
});

test("star a->b, a->c: children follow in edge creation order", () => {
  const g = graphOf([node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "a", "c")]);
  const s = sortByArrows(g);
  assert.deepEqual(s.order.slice(0, 3), ["a", "b", "c"]);
});

test("nested containers: deep child edge defers nearest top-level container", () => {
  const outer = node("outer");
  const inner = node("inner", { parentId: "outer" });
  const leaf = node("leaf", { parentId: "inner" });
  outer.children = ["inner"];
  inner.children = ["leaf"];
  const src = node("src");
  const g = graphOf([outer, inner, leaf, src],
    [edge("e1", "src", "leaf")], ["src", "outer", "leaf", "inner", "e1"]);
  const s = sortByArrows(g);
  assert.equal(posOf(s.order, "src"), 0);
  assert.equal(posOf(s.order, "outer"), 1, "outer container deferred");
  const byId = idx(s);
  assert.deepEqual(byId.get("outer").children, ["inner"]);
  assert.deepEqual(byId.get("inner").children, ["leaf"]);
});

test("treeOrder of sorted graph equals new order nodes", () => {
  const g = graphOf([node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c")], ["c", "b", "a"]);
  const s = sortByArrows(g);
  const nodes = treeOrder(s);
  assert.deepEqual(nodes, s.order.slice(0, 3));
});

test("idempotent: sorting a sorted graph is a no-op for node order", () => {
  const g = graphOf([node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c")], ["a", "b", "c"]);
  const s1 = sortByArrows(g);
  const s2 = sortByArrows(s1);
  assert.deepEqual(s2.order, s1.order);
});

test("deterministic across identical inputs", () => {
  const mk = () => graphOf([node("a"), node("b"), node("c"), node("d")],
    [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")]);
  assert.deepEqual(sortByArrows(mk()).order, sortByArrows(mk()).order);
});

test("does not mutate the input graph", () => {
  const cluster = node("cluster");
  const api = node("api", { parentId: "cluster" });
  const db = node("db", { parentId: "cluster" });
  cluster.children = ["db", "api"];
  const g = graphOf([cluster, api, db], [edge("e1", "api", "db")]);
  const before = JSON.stringify(g);
  sortByArrows(g);
  assert.equal(JSON.stringify(g), before, "input graph untouched");
});

test("edge directionality: a <- b sorts the semantic source (b) before a", () => {
  const g = graphOf([node("a"), node("b")], [edge("e1", "a", "b", { dir: "<-" })], ["a", "b"]);
  const s = sortByArrows(g);
  assert.ok(posOf(s.order, "b") < posOf(s.order, "a"), "arrow flow b -> a comes first");
});

test("edge directionality: <-> behaves like a forward edge for ordering", () => {
  const g = graphOf([node("a"), node("b")], [edge("e1", "a", "b", { dir: "<->" })], ["b", "a"]);
  const s = sortByArrows(g);
  assert.ok(posOf(s.order, "a") < posOf(s.order, "b"), "a precedes b");
});
