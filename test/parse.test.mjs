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
const { serializeClean, serializeAnnotated } = require("../js/d2-serialize.js");
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
  'Worker -> "API Server".Database {label: "read/write"}'
].join("\n");

const DEMO_ANNOTATED = [
  "Client # @d2pos 60,300",
  '"API Server": { # @d2pos 340,230',
  "  Database # @d2pos 40,60",
  "  Cache # @d2pos 40,170",
  "}",
  "Worker # @d2pos 340,520",
  "",
  'Client -> "API Server" {label: HTTPS}',
  '"API Server" -> Worker {label: queue}',
  'Worker -> "API Server".Database {label: "read/write"}'
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
  assert.deepEqual(g.headerComments, ["Схема продакшена", "внешний клиент"]);
  assert.deepEqual(g.trailingComments, ["конец файла"]);
  assert.deepEqual(g.order, ["Client", "srv", "db", "e1"]);
  const client = g.nodes.find((n) => n.id === "Client");
  assert.equal(client.trailingComment, "front-end сервис");
  assert.deepEqual([client.x, client.y, client.hasPos], [60, 300, true]);
  const srv = g.nodes.find((n) => n.id === "srv");
  assert.equal(srv.label, "Backend API");
  assert.deepEqual(srv.rawAttrs, ["shape: cylinder"]);
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
  assert.equal(g.edges.length, 1, "both references hit the same literal node");
  assert.equal(g.edges[0].source, "b.c");
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
  assert.deepEqual(a.rawAttrs, ["shape: cylinder"]);
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
    ["a <- b\n", ["b", "a"], "<- reverses"],
    ["a <-> b\n", ["a", "b"], "<-> forward"]
  ];
  for (const [src, pair, why] of pairs) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    assert.deepEqual(r.graph.edges.map((e) => [e.source, e.target]), [pair], why);
  }
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

test("D2 string parity: value then container on the same line sets the label", () => {
  for (const src of ["x: a { b }\n", 'x: "a" { b }\n']) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    const x = r.graph.nodes.find((n) => n.id === "x");
    assert.equal(x.label, "a", src);
    assert.deepEqual(x.children, ["b"], src);
  }
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
    "a-b -> c\n"
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

test("// line comments (D2 supports both # and //)", () => {
  const r = parseD2("// header\nClient # note\n// tail\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.graph.headerComments, ["header"]);
  assert.equal(r.graph.nodes.length, 1);
  assert.equal(r.graph.nodes[0].id, "Client");
  assert.equal(r.graph.nodes[0].trailingComment, "note");
  assert.deepEqual(r.graph.trailingComments, ["tail"]);
});

test("// mid-key is part of the key (matches d2 lexer)", () => {
  const r = parseD2("Client // note\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].id, "Client // note");
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
  assert.deepEqual(r.graph.headerComments, ["one", "two"]);
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
    '"b.c" -> x\n'
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
