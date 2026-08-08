import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { parseD2 } = require("../js/d2-parse.js");
const { serializeClean, serializeAnnotated, stripMarkers } = require("../js/d2-serialize.js");
const exec = promisify(execFile);

const N = (id, parentId = null, extra = {}) => ({
  id, label: id, x: 0, y: 0, w: 150, h: 70, parentId, children: [],
  comments: [], trailingComment: null, rawAttrs: [], implicit: false, hasPos: false,
  ...extra
});
const E = (id, source, target, extra = {}) => ({
  id, source, target, label: null, comments: [], trailingComment: null, rawAttrs: [], ...extra
});

const emptyGraph = {
  v: 2, nodes: [], edges: [], order: [], headerComments: [], trailingComments: [],
  idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
};

function demoExpected(positions) {
  const p = positions
    ? { "Client": [60, 300], "API Server": [340, 230], Database: [40, 60], Cache: [40, 170], Worker: [340, 520] }
    : {};
  const pos = (id) => (p[id] ? { x: p[id][0], y: p[id][1], hasPos: true } : {});
  return {
    v: 2,
    nodes: [
      N("Client", null, { children: [], ...pos("Client") }),
      N("API Server", null, { children: ["Database", "Cache"], ...pos("API Server") }),
      N("Database", "API Server", pos("Database")),
      N("Cache", "API Server", pos("Cache")),
      N("Worker", null, pos("Worker"))
    ],
    edges: [
      E("e1", "Client", "API Server", { label: "HTTPS" }),
      E("e2", "API Server", "Worker", { label: "queue" }),
      E("e3", "Worker", "Database", { label: "read/write" })
    ],
    order: ["Client", "API Server", "Database", "Cache", "Worker", "e1", "e2", "e3"],
    headerComments: [], trailingComments: [], idCounter: 4,
    viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
}

const DEMO_CLEAN = [
  "Client",
  '"API Server": {',
  "  Database",
  "  Cache",
  "}",
  "Worker",
  "",
  'Client -> "API Server" {label: HTTPS}',
  '"API Server" -> Worker {label: queue}',
  'Worker -> "API Server".Database {label: read/write}'
].join("\n");

const DEMO_ANNOTATED = [
  "Client # --- @d2pos 60,300",
  '"API Server": { # --- @d2pos 340,230',
  "  Database # --- @d2pos 40,60",
  "  Cache # --- @d2pos 40,170",
  "}",
  "Worker # --- @d2pos 340,520",
  "",
  'Client -> "API Server" {label: HTTPS}',
  '"API Server" -> Worker {label: queue}',
  'Worker -> "API Server".Database {label: read/write}'
].join("\n");

test("parseD2: demo clean code -> exact graph (no positions)", () => {
  const r = parseD2(DEMO_CLEAN);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph, demoExpected(false));
});

test("parseD2: demo annotated code -> exact graph (positions from markers)", () => {
  const r = parseD2(DEMO_ANNOTATED);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph, demoExpected(true));
});

test("round-trip: demo clean -> parse -> clean is identical text", () => {
  const r = parseD2(DEMO_CLEAN);
  assert.ok(r.ok);
  assert.equal(serializeClean(r.graph), DEMO_CLEAN);
});

test("round-trip: demo annotated -> parse -> annotated is identical text", () => {
  const r = parseD2(DEMO_ANNOTATED);
  assert.ok(r.ok);
  assert.equal(serializeAnnotated(r.graph), DEMO_ANNOTATED);
});

test("idempotent: serializing a re-parsed graph reproduces the same text", () => {
  const sources = [DEMO_CLEAN, DEMO_ANNOTATED, "a -> b\n", '"b.c" -> x\n', "a: { b -> c }\n"];
  for (const src of sources) {
    const g1 = parseD2(src);
    assert.ok(g1.ok, JSON.stringify(g1.error));
    const text1 = serializeAnnotated(g1.graph);
    const g2 = parseD2(text1);
    assert.ok(g2.ok, JSON.stringify(g2.error));
    assert.equal(serializeAnnotated(g2.graph), text1, "stable under re-serialize for: " + src);
  }
});

test("rich annotated code: label, rawAttrs, comments, header/trailing, trailingComment without stray marker", () => {
  const src = [
    "# Схема продакшена",
    "# внешний клиент",
    "Client # front-end сервис # @d2pos 60,300",
    "srv: {",
    '  label: "Backend API"',
    "  shape: cylinder",
    "  db # @d2pos 40,60",
    "}",
    "",
    "# важный переход",
    "Client -> srv # по HTTPS",
    "# конец файла"
  ].join("\n");
  const r = parseD2(src);
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  assert.deepEqual(g.headerComments, ["Схема продакшена\nвнешний клиент"], "consecutive # lines merge (D2 parseComment)");
  assert.deepEqual(g.trailingComments, ["конец файла"]);
  assert.deepEqual(g.order, ["Client", "srv", "db", "e1"]);
  const client = g.nodes.find((n) => n.id === "Client");
  assert.equal(client.trailingComment, "front-end сервис");
  assert.deepEqual([client.x, client.y, client.hasPos], [60, 300, true]);
  const srv = g.nodes.find((n) => n.id === "srv");
  assert.equal(srv.label, "Backend API");
  assert.equal(srv.shape, "cylinder");
  assert.deepEqual(srv.rawAttrs, []);
  const db = g.nodes.find((n) => n.id === "db");
  assert.deepEqual([db.x, db.y, db.hasPos, db.parentId], [40, 60, true, "srv"]);
  const e = g.edges[0];
  assert.equal(e.trailingComment, "по HTTPS");
  assert.deepEqual(e.comments, ["важный переход"]);
});

test("implicit node: a -> b creates b; later declaration merges by id and clears implicit", () => {
  const r = parseD2("a -> b\nb: { c }\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  assert.deepEqual(g.order, ["a", "b", "e1", "c"]);
  const a = g.nodes.find((n) => n.id === "a");
  const b = g.nodes.find((n) => n.id === "b");
  const c = g.nodes.find((n) => n.id === "c");
  assert.equal(a.implicit, true);
  assert.equal(b.implicit, false, "explicit declaration wins");
  assert.equal(b.parentId, null);
  assert.equal(c.parentId, "b");
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].source, "a");
  assert.equal(g.edges[0].target, "b");
  assert.ok(serializeClean(g).includes("b: {"));
});

test('literal key with dot: "b.c" is one node, not a path', () => {
  const r = parseD2('"b.c" -> x\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const ids = g.nodes.map((n) => n.id);
  assert.deepEqual(ids, ["b.c", "x"]);
  assert.equal(g.edges[0].source, "b.c");
  assert.ok(serializeClean(g).includes('"b.c"'));
});

test('literal priority: "b.c" exists, b.c -> x resolves to the literal', () => {
  const r = parseD2('"b.c" -> x\nb.c -> x\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.ok(byId["b.c"], "literal node exists");
  assert.equal(g.edges.length, 2, "repeated connections stay separate (no dedup)");
  assert.equal(g.edges[0].source, "b.c");
  assert.equal(g.edges[1].source, "b.c");
});

test("nested edges: edges inside a container are scoped to it", () => {
  const r = parseD2("a: { b -> c }\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const b = g.nodes.find((n) => n.id === "b");
  const c = g.nodes.find((n) => n.id === "c");
  assert.equal(b.parentId, "a");
  assert.equal(c.parentId, "a");
  assert.deepEqual(g.edges.map((e) => [e.source, e.target]), [["b", "c"]]);
  assert.ok(serializeClean(g).includes("a.b -> a.c") || serializeClean(g).includes('"a".b -> "a".c'));
});

test("chain a -> b -> c produces two edges", () => {
  const r = parseD2("a -> b -> c\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.edges.map((e) => [e.source, e.target]), [["a", "b"], ["b", "c"]]);
});

test("comma is literal in D2 keys: a, b -> c, d is one edge between two nodes", () => {
  const r = parseD2("a, b -> c, d\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const ids = r.graph.nodes.map((n) => n.id);
  assert.deepEqual(ids, ["a, b", "c, d"]);
  assert.deepEqual(r.graph.edges.map((e) => [e.source, e.target]), [["a, b", "c, d"]]);
  const out = serializeClean(r.graph);
  assert.ok(out.includes('"a, b" -> "c, d"'), out);
});

test("deep path p.q.r -> s creates nested nodes", () => {
  const r = parseD2("p.q.r -> s\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const q = g.nodes.find((n) => n.id === "q");
  const rr = g.nodes.find((n) => n.id === "r");
  assert.equal(q.parentId, "p");
  assert.equal(rr.parentId, "q");
  assert.equal(g.edges[0].source, "r");
});

test("order invariants: every id unique, nodes/edges all present", () => {
  const r = parseD2(DEMO_ANNOTATED);
  assert.ok(r.ok);
  const g = r.graph;
  const orderIds = new Set(g.order);
  assert.equal(orderIds.size, g.order.length, "no duplicate ids in order");
  for (const n of g.nodes) assert.ok(orderIds.has(n.id), "node in order: " + n.id);
  for (const e of g.edges) assert.ok(orderIds.has(e.id), "edge in order: " + e.id);
  assert.equal(orderIds.size, g.nodes.length + g.edges.length);
});

test("reserved attrs become node fields/rawAttrs, others become children", () => {
  const r = parseD2("a: {\n  label: hi\n  shape: cylinder\n  child: val\n}\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const a = g.nodes.find((n) => n.id === "a");
  assert.equal(a.label, "hi");
  assert.equal(a.shape, "cylinder");
  assert.deepEqual(a.rawAttrs, []);
  const child = g.nodes.find((n) => n.id === "child");
  assert.equal(child.parentId, "a");
  assert.equal(child.label, "val");
});

test("array attr value (pad: [10, 20]) preserved as rawAttrs", () => {
  const r = parseD2("a {\n  pad: [10, 20]\n}\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes[0].rawAttrs, ["pad: [10, 20]"]);
  const out = serializeClean(r.graph);
  assert.ok(out.includes("pad: [10, 20]"), out);
  const r2 = parseD2(out);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.deepEqual(r2.graph.nodes[0].rawAttrs, ["pad: [10, 20]"]);
});

test("style block stored as multi-line rawAttrs and round-trips to valid D2", () => {
  const src = "n: {\n  style: {\n    fill: red\n  }\n}\n";
  const r = parseD2(src);
  assert.ok(r.ok, JSON.stringify(r.error));
  const n = r.graph.nodes[0];
  assert.deepEqual(n.rawAttrs, ["style: {\n  fill: red\n}"]);
  const out = serializeClean(r.graph);
  assert.ok(out.includes("style: {"), out);
  assert.ok(out.includes("fill: red"), out);
  const r2 = parseD2(out);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.deepEqual(r2.graph, r.graph);
});

test("edge label forms: {label: x} block and : 'l' string", () => {
  for (const [src, label] of [["a -> b {label: HTTPS}\n", "HTTPS"], ['a -> b: "l"\n', "l"]]) {
    const r = parseD2(src);
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.equal(r.graph.edges[0].label, label, src);
  }
});

test("container syntax without colon: a { label: x } — comma is literal in values", () => {
  const r = parseD2("a {label: x, shape: cylinder}\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const a = r.graph.nodes.find((n) => n.id === "a");
  assert.equal(a.label, "x, shape: cylinder");
  assert.deepEqual(a.rawAttrs, []);
});

test("unquoted key keeps inner spaces: a b c is one node", () => {
  const r = parseD2("a b c\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes.length, 1);
  const a = r.graph.nodes[0];
  assert.equal(a.id, "a b c");
  assert.equal(a.label, "a b c");
});

test("unquoted multi-word label after colon", () => {
  const r = parseD2('x: hello world\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes.length, 1);
  assert.equal(r.graph.nodes[0].id, "x");
  assert.equal(r.graph.nodes[0].label, "hello world");
});

test("D2 string parity: unquoted values absorb D2-valid characters (v0.7.1)", () => {
  const cases = [
    ["x: don't", "don't"],
    ['x: a"b', 'a"b'],
    ["x: (a)", "(a)"],
    ["x: a.b", "a.b"],
    ["x: a,b", "a,b"],
    ["x: a:b", "a:b"],
    ["x: a -> b", "a -> b"],
    ["x: a->b", "a->b"],
    ["x: a--b", "a--b"],
    ["x: a*b", "a*b"],
    ["x: a&b", "a&b"],
    ["x: a<b>c", "a<b>c"],
    ["x: 1.5", "1.5"],
    ["x: a b c", "a b c"],
    ['x: a"b"', 'a"b"'],
    ["x: a\\", "a"],
    ["x: a#b", "a"]
  ];
  for (const [src, label] of cases) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    assert.equal(r.graph.nodes[0].label, label, src);
  }
});

test("D2 string parity: quoted strings (single/double) decode per v0.7.1", () => {
  const cases = [
    ["x: 'it''s'", "it's"],
    ["x: 'a b'", "a b"],
    ["x: 'a\\nb'", "a\\nb"],
    ["x: 'a$b'", "a$b"],
    ["x: 'a\\\\b'", "a\\\\b"],
    ['x: "a b"', "a b"],
    ['x: "a\\qb"', "aqb"],
    ['x: "a\\tb"', "a\tb"],
    ['x: "a\\"b"', 'a"b'],
    ['x: "a\\\\b"', "a\\b"],
    ['x: ""', ""],
    ["x: ''", ""]
  ];
  for (const [src, label] of cases) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    assert.equal(r.graph.nodes[0].label, label, src);
  }
});

test("D2 string parity: \\ + newline continues the line in every string kind", () => {
  const cases = [
    "x: a\\\nb",
    'x: "a\\\nb"',
    "x: 'a\\\nb'"
  ];
  for (const src of cases) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    assert.equal(r.graph.nodes[0].label, "ab", JSON.stringify(src));
  }
});

test("D2 string parity: keys, paths and arrows per v0.7.1", () => {
  const single = parseD2("a-b\n");
  assert.ok(single.ok);
  assert.deepEqual(single.graph.nodes.map((n) => n.id), ["a-b"], "single dash is literal");
  const pairs = [
    ["a--b\n", ["a", "b"], "-- is an edge"],
    ["a -- b\n", ["a", "b"], "-- with spaces"],
    ["a -* b\n", ["a", "b"], "-*"],
    ["a <- b\n", ["a", "b"], "<- keeps text order"],
    ["a <-> b\n", ["a", "b"], "<-> text order"]
  ];
  for (const [src, pair, why] of pairs) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    assert.deepEqual(r.graph.edges.map((e) => [e.source, e.target]), [pair], why);
  }
  assert.deepEqual(
    parseD2("a <- b\n").graph.edges.map((e) => e.dir),
    ["<-"], "reverse direction is stored, not swapped");
  assert.deepEqual(
    parseD2("a <-> b\n").graph.edges.map((e) => e.dir),
    ["<->"], "bidirectional direction is stored");
  assert.deepEqual(
    parseD2("a -- b\n").graph.edges.map((e) => e.dir),
    ["--"], "no-arrow direction is stored");
  const fwd = parseD2("a -> b\n").graph.edges[0];
  assert.equal(fwd.dir, undefined, "forward direction is the default (no dir field)");
  const group = parseD2("(a, b) -> c\n");
  assert.ok(group.ok);
  assert.deepEqual(group.graph.nodes.map((n) => n.id), ["(a, b)", "c"], "edge groups are not D2 v0.7.1");
  const path = parseD2("a.b -> c\n");
  assert.ok(path.ok);
  assert.deepEqual(path.graph.edges.map((e) => [e.source, e.target]), [["b", "c"]]);
  assert.deepEqual(path.graph.nodes.map((n) => n.id), ["a", "b", "c"]);
  const q = parseD2('"a b": x\n');
  assert.ok(q.ok);
  const n = q.graph.nodes[0];
  assert.equal(n.id, "a b");
  assert.equal(n.label, "x");
});

test("arrow directionality: one-line chained connections keep each link's direction", () => {
  const r = parseD2("Stage One -> Stage Two <- Stage Three <-> Stage Four\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(
    r.graph.edges.map((e) => [e.source, e.target, e.dir || "->"]),
    [["Stage One", "Stage Two", "->"], ["Stage Two", "Stage Three", "<-"], ["Stage Three", "Stage Four", "<->"]],
    "each link keeps text order and its own direction");
});

test("arrow directionality: repeated connections are distinct edges", () => {
  const r = parseD2("a -> b\na -> b\na <- b\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.edges.length, 3, "three records, three edges");
  assert.deepEqual(
    r.graph.edges.map((e) => [e.source, e.target, e.dir || "->"]),
    [["a", "b", "->"], ["a", "b", "->"], ["a", "b", "<-"]],
    "identical records stay separate, reverse stays separate too");
  assert.notEqual(r.graph.edges[0].id, r.graph.edges[1].id, "distinct ids");
});

test("D2 string parity: value then container on the same line sets the label", () => {
  for (const src of ["x: a { b }\n", 'x: "a" { b }\n']) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    const x = r.graph.nodes.find((n) => n.id === "x");
    assert.equal(x.label, "a", src);
    assert.deepEqual(x.children, ["b"], src);
  }
});

test("array value is an attribute array, not a label (D2 parity)", () => {
  const r = parseD2("x: [a, b]\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const x = r.graph.nodes[0];
  assert.equal(x.id, "x");
  assert.equal(x.label, "x", "no explicit label (defaults to id) — arrays are never labels in D2");
  assert.equal(x.valueArray, "[a, b]");
});

test("array value on an edge is kept verbatim", () => {
  const r = parseD2("a -> b: [x]\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.edges[0].label, null);
  assert.equal(r.graph.edges[0].valueArray, "[x]");
});

test("label: [a] and shape: [a, b] keep the array, label stays empty", () => {
  const r = parseD2("x: {\n  label: [a]\n  shape: [a, b]\n}\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const x = r.graph.nodes[0];
  assert.equal(x.label, "x", "no explicit label");
  assert.equal(x.valueArray, "[a]");
  assert.deepEqual(x.rawAttrs, ["shape: [a, b]"]);
});

test("an array value cannot have a container body (D2: unexpected text after array)", () => {
  const r = parseD2("x: [a] { b }\n");
  assert.ok(!r.ok, "expected error");
  assert.ok(/массив не может иметь тело/.test(r.error.message), r.error.message);
});

test("unterminated array is an error", () => {
  const r = parseD2("x: [a\n");
  assert.ok(!r.ok, "expected error");
  assert.ok(/незакрытый массив/.test(r.error.message), r.error.message);
});

test("D2 string parity: syntax errors match v0.7.1 line/col behavior", () => {
  const cases = [
    ["x: \n", "ожидается значение после ':'"],
    ["x: 'a\\'b'\n", "неожиданный текст"],
    ['x: "unterminated\n', "незакрытая строка"],
    ['x: "a" b\n', "неожиданный текст"],
    ["a { b } c\n", "неожиданный текст"]
  ];
  for (const [src, msg] of cases) {
    const r = parseD2(src);
    assert.equal(r.ok, false, "should fail: " + src);
    assert.ok(r.error.message.includes(msg), src + " -> " + r.error.message);
    assert.equal(typeof r.error.line, "number", src);
    assert.equal(typeof r.error.col, "number", src);
  }
});

test("stage D: $ substitutions error with d2-parity line/col", () => {
  const cases = [
    ["x: $var\n", 1, 4],
    ["x: 5$foo\n", 1, 5],
    ["x: a$b\n", 1, 5],
    ["x: ${a}\n", 1, 4],
    ['x: "a$b"\n', 1, 6],
    ['x: "${a}"\n', 1, 5]
  ];
  for (const [src, line, col] of cases) {
    const r = parseD2(src);
    assert.equal(r.ok, false, "should fail: " + src);
    assert.ok(/подстановки \(\$\) не поддерживаются/.test(r.error.message), src + " -> " + r.error.message);
    assert.equal(r.error.line, line, src);
    assert.equal(r.error.col, col, src);
  }
});

test("stage D: $ variable declarations/references in keys error", () => {
  const cases = [
    ["$x: 1\n", 1, 1],
    ["$x -> y\n", 1, 1],
    ["a: { $y: 1 }\n", 1, 6]
  ];
  for (const [src, line, col] of cases) {
    const r = parseD2(src);
    assert.equal(r.ok, false, "should fail: " + src);
    assert.ok(/переменные \(\$\) не поддерживаются/.test(r.error.message), src + " -> " + r.error.message);
    assert.equal(r.error.line, line, src);
    assert.equal(r.error.col, col, src);
  }
  const subst = parseD2("a${b}: 1\n");
  assert.equal(subst.ok, false, "mid-key ${ is a substitution");
  assert.ok(/подстановки \(\$\) не поддерживаются/.test(subst.error.message), subst.error.message);
  assert.equal(subst.error.col, 2, "points at the $");
});

test("stage D: * globs in keys error (values keep * literal)", () => {
  const cases = [
    ["a*b: 1\n", 1, 2],
    ["*a -> b\n", 1, 1],
    ["*: x\n", 1, 1],
    ["a: { * -> b }\n", 1, 6]
  ];
  for (const [src, line, col] of cases) {
    const r = parseD2(src);
    assert.equal(r.ok, false, "should fail: " + src);
    assert.ok(/globs \(\*\) не поддерживаются/.test(r.error.message), src + " -> " + r.error.message);
    assert.equal(r.error.line, line, src);
    assert.equal(r.error.col, col, src);
  }
});

test("stage D: import spread ...@ errors at token start", () => {
  const cases = [
    ["...@import\n", 1, 1],
    ["x: ...@y\n", 1, 4],
    ["x ...@y\n", 1, 3]
  ];
  for (const [src, line, col] of cases) {
    const r = parseD2(src);
    assert.equal(r.ok, false, "should fail: " + src);
    assert.ok(/import spread \(\.\.\.\) не поддерживается/.test(r.error.message), src + " -> " + r.error.message);
    assert.equal(r.error.line, line, src);
    assert.equal(r.error.col, col, src);
  }
});

test("stage D: $, * and ... stay literal where d2 keeps them literal", () => {
  const cases = [
    ["x: a*b", "a*b"],
    ["x: a\\$b", "a$b"],
    ["x: 'a$b'", "a$b"],
    ['x: "a\\$b"', "a$b"],
    ["x: 'a*b'", "a*b"],
    ['x: "a*b"', "a*b"],
    ["x: a...b", "a...b"],
    ["x: |md\n$foo * bar\n|", "$foo * bar"]
  ];
  for (const [src, label] of cases) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    assert.equal(r.graph.nodes[0].label, label, src);
  }
  const k1 = parseD2("a$b: 1\n");
  assert.ok(k1.ok, JSON.stringify(k1.error));
  assert.equal(k1.graph.nodes[0].id, "a$b", "mid-key $ is a literal key name");
  const k2 = parseD2("a$: 1\n");
  assert.ok(k2.ok, JSON.stringify(k2.error));
  assert.equal(k2.graph.nodes[0].id, "a$", "trailing $ in a key is a literal");
  const edge = parseD2("a -* b\n");
  assert.ok(edge.ok, JSON.stringify(edge.error));
  assert.deepEqual(edge.graph.edges.map((e) => [e.source, e.target]), [["a", "b"]], "-* arrow does not trip the glob check");
});

test("D2 string parity: parse -> serialize -> parse is stable for string forms", () => {
  const sources = [
    "x: don't\n",
    "x: 'it''s'\n",
    'x: "a\\qb"\n',
    "x: 'a\\nb'\n",
    "a <- b\n",
    "a -- b\n",
    "x: a { b }\n",
    "x: a.b\n",
    '"a b": x\n',
    "a-b -> c\n",
    "x: a\\$b\n",
    "a$b: 1\n",
    "x: a...b\n",
    "x: 'a*b'\n",
    "a -* b\n"
  ];
  for (const src of sources) {
    const g1 = parseD2(src);
    assert.ok(g1.ok, JSON.stringify(g1.error) + " for " + src);
    const text1 = serializeAnnotated(g1.graph);
    const g2 = parseD2(text1);
    assert.ok(g2.ok, JSON.stringify(g2.error) + " for serialized " + src);
    assert.equal(serializeAnnotated(g2.graph), text1, "stable for: " + src);
  }
});

test("// is NOT a comment: it is plain unquoted text (D2 v0.7.1)", () => {
  const r = parseD2("// header\nClient\n// tail\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.id), ["// header", "Client", "// tail"]);
  assert.deepEqual(r.graph.headerComments, []);
  const e = parseD2("x -> y // note\n");
  assert.ok(e.ok, JSON.stringify(e.error));
  assert.deepEqual(e.graph.edges.map((ed) => [ed.source, ed.target]), [["x", "y // note"]], "target absorbs // note");
});

test("// mid-key is part of the key (matches d2 lexer)", () => {
  const r = parseD2("Client // note\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].id, "Client // note");
});

test("consecutive # lines merge into one comment with \\n (d2 parseComment)", () => {
  const r1 = parseD2("# one\n# two\nx\n");
  assert.ok(r1.ok, JSON.stringify(r1.error));
  assert.deepEqual(r1.graph.headerComments, ["one\ntwo"]);
  const r2 = parseD2("x\n# a\n# b\n");
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.deepEqual(r2.graph.trailingComments, ["a\nb"]);
  const r3 = parseD2("x: { # c1\n# c2\ny\n}\n");
  assert.ok(r3.ok, JSON.stringify(r3.error));
  const x = r3.graph.nodes.find((n) => n.id === "x");
  const y = r3.graph.nodes.find((n) => n.id === "y");
  assert.equal(x.trailingComment, "c1", "inline comment stays on its line's entity");
  assert.deepEqual(y.comments, ["c2"]);
});

test("blank line separates # comment runs (d2 parseComment)", () => {
  const r = parseD2("# one\n\n# two\nx\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.headerComments, ["one", "two"]);
});

test("block string value: |tag …| → labelBlock with tag/quote and trimmed value", () => {
  const r = parseD2("x: |md\n# heading\nsome **text**\n|\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const n = r.graph.nodes[0];
  assert.equal(n.id, "x");
  assert.equal(n.label, "# heading\nsome **text**");
  assert.deepEqual(n.labelBlock, { tag: "md", quote: "", value: "# heading\nsome **text**" });
});

test("block string: empty lines preserved, indentation stripped via common indent", () => {
  const r = parseD2("x: |md\n  line1\n\n  line3\n|\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].label, "line1\n\nline3");
});

test("block string: same-line content after the tag (x: | foo)", () => {
  const r = parseD2("x: | foo\nbar\n|\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const n = r.graph.nodes[0];
  assert.equal(n.labelBlock.tag, "md", "space stops the tag, default md");
  assert.equal(n.labelBlock.quote, "");
  assert.equal(n.label, "foo\nbar");
});

test("block string: quote symbols widen and move the closer (d2 parser rules)", () => {
  const r = parseD2("x: |++\nline with | pipe\nmore\n++|\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const n = r.graph.nodes[0];
  assert.equal(n.labelBlock.tag, "md");
  assert.equal(n.labelBlock.quote, "++");
  assert.equal(n.label, "line with | pipe\nmore");
});

test("block string: quote chars include trailing | (|--| closes with |-||)", () => {
  const r = parseD2("x: |--|\ncontent\n|-||\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].labelBlock.quote, "--|");
  assert.equal(r.graph.nodes[0].label, "content");
});

test("unterminated block string is an error naming the expected closer", () => {
  const r1 = parseD2("x: |md\ncontent\n");
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /незакрытая блочная строка \(ожидается \|\)/);
  const r2 = parseD2("x: |++\ncontent\n");
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /ожидается \+\+\|/);
  const r3 = parseD2("x: |\n");
  assert.equal(r3.ok, false);
  assert.match(r3.error.message, /незакрытая блочная строка/);
});

test("block string label inside a container and on an edge", () => {
  const rc = parseD2("a: {\n  label: |md\n  **bold**\n  |\n  y\n}\n");
  assert.ok(rc.ok, JSON.stringify(rc.error));
  const a = rc.graph.nodes[0];
  assert.equal(a.labelBlock.tag, "md");
  assert.equal(a.label, "**bold**");
  const re = parseD2("a -> b: |md\nedge label\n|\n");
  assert.ok(re.ok, JSON.stringify(re.error));
  const e = re.graph.edges[0];
  assert.equal(e.labelBlock.tag, "md");
  assert.equal(e.label, "edge label");
});

test("non-label attribute with block string value is stored as rawAttrs block form", () => {
  const r = parseD2("a: {\n  tooltip: |md\n  tip text\n  |\n}\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes[0].rawAttrs, ["tooltip: |md\n  tip text\n|"]);
});

test("position marker after the closer line is applied as the node position", () => {
  const r = parseD2("x: |md\ncontent\n| # @d2pos 30,40\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const n = r.graph.nodes[0];
  assert.equal(n.x, 30);
  assert.equal(n.y, 40);
  assert.equal(n.hasPos, true);
});

test("block string round-trips: parse -> clean -> parse is stable", () => {
  const src = "x: |md\nfirst\nsecond\n|\ny\n";
  const r1 = parseD2(src);
  assert.ok(r1.ok, JSON.stringify(r1.error));
  const clean = serializeClean(r1.graph);
  const r2 = parseD2(clean);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.equal(serializeClean(r2.graph), clean);
  assert.equal(r2.graph.nodes[0].label, r1.graph.nodes[0].label);
});

test("text after the closing line of a block string is an error (matches d2)", () => {
  const r = parseD2("x: |md\nc\n|y\n");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /неожиданный текст после оператора/);
  assert.equal(r.error.line, 3);
  const ok = parseD2("x: |md\nc\n|\ny\n");
  assert.ok(ok.ok, JSON.stringify(ok.error));
  assert.deepEqual(ok.graph.nodes.map((n) => n.id), ["x", "y"]);
});

test('""" after a | block string stays plain text inside the block (lexer order)', () => {
  const r = parseD2("x: |md\n\"\"\" not a comment here\n|\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].label, '""" not a comment here');
});

test('""" block comments: multi-line, single-line, indent-stripped', () => {
  const multi = parseD2('"""\nblock\ncomment\n"""\nx\n');
  assert.ok(multi.ok, JSON.stringify(multi.error));
  assert.deepEqual(multi.graph.headerComments, [{ text: "block\ncomment", block: true }]);
  const single = parseD2('"""one line"""\nx\n');
  assert.ok(single.ok, JSON.stringify(single.error));
  assert.deepEqual(single.graph.headerComments, [{ text: "one line", block: true }]);
  const ind = parseD2('"""\n  indented\n  lines\n"""\nx\n');
  assert.ok(ind.ok, JSON.stringify(ind.error));
  assert.deepEqual(ind.graph.headerComments, [{ text: "indented\nlines", block: true }]);
});

test('""" in statement position after a word is plain text (matches d2 lexer)', () => {
  const r = parseD2('x """inline"""\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].id, 'x """inline"""');
});

test('unterminated """ block comment is an error at 1:1', () => {
  const r = parseD2('"""\nnever closed\nx\n');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /незакрытый блочный комментарий/);
  assert.equal(r.error.line, 1);
  assert.equal(r.error.col, 1);
});

test('""" block comment inside edge attribute block', () => {
  const r = parseD2('a -> b {\n  """\n  edge note\n  """\n  label: hi\n}\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  const e = r.graph.edges[0];
  assert.deepEqual(e.comments, [{ text: "edge note", block: true }]);
});

test("serializer emits multi-line comments as separate # lines, round-trip stable", () => {
  const r1 = parseD2("# one\n# two\nx\n");
  assert.ok(r1.ok, JSON.stringify(r1.error));
  const text = serializeClean(r1.graph);
  assert.equal(text, "# one\n# two\nx");
  const r2 = parseD2(text);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.deepEqual(r2.graph.headerComments, ["one\ntwo"]);
  const annotated = serializeAnnotated(r1.graph);
  assert.equal(stripMarkers(annotated), text, "parity: annotated = clean + markers");
});

test("; acts as statement separator", () => {
  const r = parseD2("a; b -> c\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.order, ["a", "b", "c", "e1"]);
});

test("empty container a: {} and empty input", () => {
  const r1 = parseD2("a: {}\n");
  assert.ok(r1.ok);
  assert.deepEqual(r1.graph.nodes.map((n) => n.id), ["a"]);
  const r2 = parseD2("");
  assert.ok(r2.ok);
  assert.deepEqual(r2.graph, emptyGraph);
});

test("comment lines before first element become headerComments, at end trailingComments", () => {
  const r = parseD2("# one\n# two\na\n# end\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.headerComments, ["one\ntwo"], "adjacent # lines merge with \\n");
  assert.deepEqual(r.graph.trailingComments, ["end"]);
  assert.deepEqual(r.graph.nodes.map((n) => n.id), ["a"]);
});

test("syntax errors: return {ok:false, error:{line,col,message}} without touching graph", () => {
  const cases = [
    ["a: { b\n", "незакрытый блок"],
    ["}\n", "лишняя закрывающая скобка"],
    ["-> a\n", "стрелка без исходника"],
    ["a ->\n", "ожидается цель ребра"],
    ['"unclosed\n', "незакрытая строка"],
    ["@ x\n", "директивы"],
    ['x: "a" b\n', "неожиданный текст"],
    ["a: { }\n", null]
  ];
  for (const [src, msgPart] of cases) {
    const r = parseD2(src);
    if (msgPart === null) {
      assert.equal(r.ok, true, "should parse: " + src);
      continue;
    }
    assert.equal(r.ok, false, "should fail: " + src);
    assert.ok(r.error, "error object present");
    assert.ok(r.error.message.includes(msgPart), r.error.message + " contains " + msgPart);
    assert.equal(typeof r.error.line, "number");
    assert.equal(typeof r.error.col, "number");
    assert.equal(r.graph, undefined, "no graph on error");
  }
});

test("marker line on edge line is kept as trailing comment, never applied as position", () => {
  const r = parseD2("a -> b # @d2pos 1,2\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const e = r.graph.edges[0];
  assert.equal(e.trailingComment, "@d2pos 1,2");
  assert.equal(e.hasPos, undefined);
});

test("# --- @d2pos marker (dashed form) parses like the legacy form", () => {
  const r = parseD2("Client # note # --- @d2pos 60,300\n\"API Server\" # --- @d2pos 340,230\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const cl = r.graph.nodes.find((n) => n.id === "Client");
  assert.equal(cl.trailingComment, "note", "user comment kept, dashes consumed by the marker");
  assert.equal(cl.hasPos, true);
  assert.equal(cl.x, 60);
  assert.equal(cl.y, 300);
  const srv = r.graph.nodes.find((n) => n.id === "API Server");
  assert.equal(srv.trailingComment, null);
  assert.equal(srv.x, 340);
  assert.equal(srv.y, 230);
  const bare = parseD2("x # --- @d2pos -5,10\n");
  assert.ok(bare.ok, JSON.stringify(bare.error));
  assert.equal(bare.graph.nodes[0].x, -5);
  assert.equal(bare.graph.nodes[0].trailingComment, null);
});

test("d2 CLI: parsed round-trips (clean and annotated) compile to identical structure", async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const sources = [
    DEMO_ANNOTATED,
    "# Схема продакшена\nClient # front-end сервис # @d2pos 60,300\nsrv: {\n  label: \"Backend API\"\n  shape: cylinder\n  db # @d2pos 40,60\n}\nClient -> srv # по HTTPS\n",
    "n: {\n  style: {\n    fill: red\n  }\n}\n",
    "a, b -> c, d\n",
    '"b.c" -> x\n',
    "intro: |md\n# heading\nsome **text**\n|\n",
    "notes: {\n  label: |md\n  **bold**\n  |\n  tooltip: |md\n  custom tip\n  |\n}\n",
    "a -> b: |md\nedge block\n|\n",
    "x: a*b\n",
    "a$b: 1\n",
    "x: a...b\n",
    "x: 'a$b'\n"
  ];
  const dir = await mkdtemp(join(tmpdir(), "d2parse-"));
  try {
    for (let i = 0; i < sources.length; i++) {
      const r = parseD2(sources[i]);
      assert.ok(r.ok, JSON.stringify(r.error));
      const clean = serializeClean(r.graph);
      const annotated = serializeAnnotated(r.graph);
      await writeFile(join(dir, `c${i}.d2`), clean);
      await writeFile(join(dir, `a${i}.d2`), annotated);
      await exec("d2", [join(dir, `c${i}.d2`), join(dir, `c${i}.svg`)]);
      await exec("d2", [join(dir, `a${i}.d2`), join(dir, `a${i}.svg`)]);
      const c = await readFile(join(dir, `c${i}.svg`), "utf8");
      const a = await readFile(join(dir, `a${i}.svg`), "utf8");
      assert.equal(a, c, `case ${i}: annotated must compile to same structure`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge referencing its own container, written inside it, resolves to existing nodes (no duplicates)", () => {
  const r = parseD2('"Группа 1": {\n'
    + '  "подгруппа 1": {\n    456\n  }\n'
    + '  789\n'
    + '  "Группа 1".789 -> "Группа 1"."подгруппа 1".456\n'
    + '}\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const ids = g.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate node ids");
  assert.equal(g.nodes.length, 4);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].source, "789");
  assert.equal(g.edges[0].target, "456");
  const g1 = g.nodes.find((n) => n.id === "Группа 1");
  assert.equal(g1.parentId, null, "container stays top-level");
});

test("same node name in sibling scopes is a parse error, not a corrupt graph", () => {
  const r = parseD2("a: { x }\nb: { x }\n");
  assert.ok(!r.ok, "expected duplicate-name error");
  assert.ok(/дубликат имени узла/.test(r.error.message), r.error.message);
  assert.equal(r.error.line, 2, "error points at the duplicate declaration");
});

test("same local name on both sides of an edge is a parse error, not a corrupt graph", () => {
  const r = parseD2("a.x -> b.x\n");
  assert.ok(!r.ok, "expected duplicate-name error");
  assert.ok(/дубликат имени узла 'x'/.test(r.error.message), r.error.message);
});

test("shape: value becomes a node field (case preserved); top-level shape: is a node", () => {
  const r = parseD2("x: a {\n  shape: Diamond\n}\nshape: foo\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const x = g.nodes.find((n) => n.id === "x");
  assert.equal(x.shape, "Diamond", "raw case preserved");
  assert.deepEqual(x.rawAttrs, [], "shape leaves rawAttrs");
  const sh = g.nodes.find((n) => n.id === "shape");
  assert.ok(sh, "top-level shape: is a node, not an attribute");
  assert.equal(sh.label, "foo");
});

test("shape on edges / as array / as block string stays in rawAttrs", () => {
  const r = parseD2("a -> b: { shape: diamond }\nc: { shape: [x] }\nd: { shape: |md\n   text\n  | }\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const e = g.edges[0];
  assert.equal(e.shape, undefined, "edges have no shape field");
  assert.deepEqual(e.rawAttrs, ["shape: diamond"]);
  const c = g.nodes.find((n) => n.id === "c");
  assert.equal(c.shape, undefined, "array shape value is not a field");
  assert.deepEqual(c.rawAttrs, ["shape: [x]"]);
  const d = g.nodes.find((n) => n.id === "d");
  assert.equal(d.shape, undefined, "block-string shape value is not a field");
  assert.ok(d.rawAttrs.length === 1 && d.rawAttrs[0].startsWith("shape: |"), JSON.stringify(d.rawAttrs));
});

test("shape on a container applies to the container node", () => {
  const r = parseD2("a: {\n  shape: cloud\n  b\n}\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  const g = r.graph;
  const a = g.nodes.find((n) => n.id === "a");
  assert.equal(a.shape, "cloud");
  assert.deepEqual(a.rawAttrs, []);
});

test("arrow directionality: all four forms round-trip parse -> serialize -> parse", () => {
  const forms = ["a -> b\n", "a <- b\n", "a <-> b\n", "a -- b\n"];
  for (const src of forms) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    const out = serializeClean(r.graph);
    const r2 = parseD2(out);
    assert.ok(r2.ok, "re-parse of " + JSON.stringify(out));
    assert.deepEqual(
      r2.graph.edges.map((e) => [e.source, e.target, e.dir || "->"]),
      r.graph.edges.map((e) => [e.source, e.target, e.dir || "->"]),
      src + " round-trips");
    assert.ok(out.includes(src.trim()), src + " is emitted in its own form");
  }
});
