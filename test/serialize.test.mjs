import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const mod = require("../js/d2-serialize.js");
const { d2Key, d2Value, d2Escape, serializeClean, serializeAnnotated, stripMarkers, defaultOrder, treeOrder, POS_RE } = mod;
const { parseD2 } = require("../js/d2-parse.js");
const exec = promisify(execFile);

const demoGraph = {
  v: 2,
  nodes: [
    { id: "Client", label: "Client", x: 60, y: 300, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] },
    { id: "API Server", label: "API Server", x: 340, y: 230, w: 150, h: 70, parentId: null, children: ["Database", "Cache"], comments: [], trailingComment: null, rawAttrs: [] },
    { id: "Database", label: "Database", x: 40, y: 60, w: 150, h: 70, parentId: "API Server", children: [], comments: [], trailingComment: null, rawAttrs: [] },
    { id: "Cache", label: "Cache", x: 40, y: 170, w: 150, h: 70, parentId: "API Server", children: [], comments: [], trailingComment: null, rawAttrs: [] },
    { id: "Worker", label: "Worker", x: 340, y: 520, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] }
  ],
  edges: [
    { id: "e1", source: "Client", target: "API Server", label: "HTTPS", comments: [], trailingComment: null },
    { id: "e2", source: "API Server", target: "Worker", label: "queue", comments: [], trailingComment: null },
    { id: "e3", source: "Worker", target: "Database", label: "read/write", comments: [], trailingComment: null }
  ],
  order: ["Client", "API Server", "Database", "Cache", "Worker", "e1", "e2", "e3"],
  headerComments: [],
  trailingComments: [],
  idCounter: 4,
  viewport: { x: 0, y: 0, zoom: 1 },
  showComments: true
};

const richGraph = {
  v: 2,
  nodes: [
    { id: "Client", label: "Client", x: 60, y: 300, w: 150, h: 70, parentId: null, children: [], comments: ["внешний клиент"], trailingComment: "front-end сервис", rawAttrs: [] },
    { id: "srv", label: "Backend API", x: 340, y: 230, w: 150, h: 70, parentId: null, children: ["db"], comments: [], trailingComment: null, rawAttrs: ["shape: cylinder"] },
    { id: "db", label: "db", x: 40, y: 60, w: 150, h: 70, parentId: "srv", children: [], comments: [], trailingComment: null, rawAttrs: [] }
  ],
  edges: [
    { id: "e1", source: "Client", target: "srv", label: null, comments: ["важный переход"], trailingComment: "по HTTPS" }
  ],
  order: ["Client", "srv", "db", "e1"],
  headerComments: ["Схема продакшена"],
  trailingComments: ["конец файла"],
  idCounter: 2,
  viewport: { x: 0, y: 0, zoom: 1 },
  showComments: true
};

test("d2Key: plain keys unquoted, others quoted+escaped", () => {
  assert.equal(d2Key("Client"), "Client");
  assert.equal(d2Key("API Server"), '"API Server"');
  assert.equal(d2Key('a"b'), '"a\\"b"');
  assert.equal(d2Key("a\\b"), '"a\\\\b"');
  assert.equal(d2Key("a$b"), '"a\\$b"', "$ escaped: d2 would read \"a$b\" as a substitution in values");
  assert.equal(d2Key("$"), '"\\$"');
});

test("treeOrder: pre-order, roots first, children in order", () => {
  assert.deepEqual(treeOrder(demoGraph), ["Client", "API Server", "Database", "Cache", "Worker"]);
});

test("defaultOrder: treeOrder + edges at end (v1 migration)", () => {
  assert.deepEqual(defaultOrder(demoGraph), ["Client", "API Server", "Database", "Cache", "Worker", "e1", "e2", "e3"]);
});

test("serializeClean: demo graph", () => {
  assert.equal(serializeClean(demoGraph), [
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
  ].join("\n"));
});

test("serializeClean: rich graph (comments, label, rawAttrs, header/trailing)", () => {
  assert.equal(serializeClean(richGraph), [
    "# Схема продакшена",
    "# внешний клиент",
    "Client # front-end сервис",
    "srv: {",
    "  label: Backend API",
    "  shape: cylinder",
    "  db",
    "}",
    "",
    "# важный переход",
    "Client -> srv # по HTTPS",
    "# конец файла"
  ].join("\n"));
});

test("serializeAnnotated: markers appended after trailingComment, local coords", () => {
  const out = serializeAnnotated(richGraph);
  assert.ok(out.includes("Client # front-end сервис # @d2pos 60,300"));
  assert.ok(out.includes("srv: { # @d2pos 340,230"));
  assert.ok(out.includes("  db # @d2pos 40,60"));
  const edgeLine = out.split("\n").find((l) => l.startsWith("Client -> srv"));
  assert.ok(edgeLine, "edge present");
  assert.ok(!edgeLine.includes("@d2pos"), "edges must not get markers");
});

test("parity: annotated = clean + markers (stripMarkers)", () => {
  assert.equal(stripMarkers(serializeAnnotated(demoGraph)), serializeClean(demoGraph));
  assert.equal(stripMarkers(serializeAnnotated(richGraph)), serializeClean(richGraph));
});

test("POS_RE extracts local coords from every annotated node line", () => {
  const out = serializeAnnotated(demoGraph);
  const lines = out.split("\n");
  let marked = 0;
  for (const line of lines) {
    const m = line.match(POS_RE);
    if (!m) continue;
    marked++;
    const x = Number(m[1]), y = Number(m[2]);
    const node = demoGraph.nodes.find((n) => line.trimStart().startsWith(d2Key(n.id)));
    assert.ok(node, "marker line belongs to a known node: " + line);
    assert.equal(x, node.x, line);
    assert.equal(y, node.y, line);
  }
  assert.equal(marked, demoGraph.nodes.length, "every node line carries a marker");
});

test("POS_RE anchored: matches at end of line only", () => {
  assert.equal("a # @d2pos 1,2".match(POS_RE)[1], "1");
  assert.equal("a # @d2pos -12,300".match(POS_RE)[2], "300");
  assert.equal("a # @d2pos 1,2 x".match(POS_RE), null, "trailing junk after marker");
  assert.equal("a # x @d2pos 1,2".match(POS_RE), null, "no '#' immediately before @d2pos");
  assert.equal("a @d2pos 1,2".match(POS_RE), null, "no comment at all");
});

test("empty graph serializes to empty string", () => {
  const empty = { v: 2, nodes: [], edges: [], order: [], headerComments: [], trailingComments: [], idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true };
  assert.equal(serializeClean(empty), "");
  assert.equal(serializeAnnotated(empty), "");
});

test("fractional/undefined coords round to integer markers", () => {
  const g = {
    v: 2,
    nodes: [
      { id: "a", label: "a", x: 60.5, y: -12.4, w: 10, h: 10, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] },
      { id: "b", label: "b", parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] }
    ],
    edges: [],
    order: ["a", "b"],
    headerComments: [],
    trailingComments: [],
    idCounter: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    showComments: true
  };
  const out = serializeAnnotated(g);
  assert.ok(out.includes("a # @d2pos 61,-12"), out);
  assert.ok(out.includes("b # @d2pos 0,0"), out);
});

test("node without label emits no label:", () => {
  const g = {
    v: 2,
    nodes: [{ id: "srv", label: undefined, x: 0, y: 0, w: 10, h: 10, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] }],
    edges: [],
    order: ["srv"],
    headerComments: [],
    trailingComments: [],
    idCounter: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    showComments: true
  };
  assert.equal(serializeClean(g), "srv");
});

test("child before parent in order: parent hoisted, each node emitted once", () => {
  const order = ["Client", "Database", "Worker", "API Server", "e1", "e2", "e3"];
  assert.equal(serializeClean({ ...demoGraph, order }), [
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
  ].join("\n"));
});

test("duplicate ids in order: emitted only once", () => {
  const order = ["Client", "Client", "API Server", "Database", "Cache", "Worker", "e1", "e2", "e3"];
  const out = serializeClean({ ...demoGraph, order });
  const clientLines = out.split("\n").filter((l) => l === "Client");
  assert.equal(clientLines.length, 1, "node line appears exactly once");
  assert.ok(!out.includes("\nClient\nClient"), "no duplicated node line");
});

test("parentId cycle does not hang", () => {
  const g = {
    v: 2,
    nodes: [
      { id: "a", label: "a", x: 0, y: 0, w: 10, h: 10, parentId: "b", children: [], comments: [], trailingComment: null, rawAttrs: [] },
      { id: "b", label: "b", x: 0, y: 0, w: 10, h: 10, parentId: "a", children: [], comments: [], trailingComment: null, rawAttrs: [] }
    ],
    edges: [],
    order: ["a", "b"],
    headerComments: [],
    trailingComments: [],
    idCounter: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    showComments: true
  };
  const out = serializeClean(g);
  assert.equal(typeof out, "string");
});

test("edge with comment lines is emitted with them", () => {
  const out = serializeClean(richGraph);
  assert.ok(out.includes("# важный переход\nClient -> srv # по HTTPS"), out);
});

test("d2 CLI: clean and annotated compile to identical structure", async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "d2ser-"));
  try {
    const clean = serializeClean(demoGraph);
    const annotated = serializeAnnotated(demoGraph);
    await writeFile(join(dir, "clean.d2"), clean);
    await writeFile(join(dir, "annotated.d2"), annotated);
    await exec("d2", [join(dir, "clean.d2"), join(dir, "clean.svg")]);
    await exec("d2", [join(dir, "annotated.d2"), join(dir, "annotated.svg")]);
    const c = await readFile(join(dir, "clean.svg"), "utf8");
    const a = await readFile(join(dir, "annotated.svg"), "utf8");
    assert.equal(a, c, "annotated (comments+markers) must compile to the same diagram");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("d2 CLI: rich graph with labels/rawAttrs compiles", async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "d2ser-"));
  try {
    await writeFile(join(dir, "rich.d2"), serializeClean(richGraph));
    await exec("d2", [join(dir, "rich.d2"), join(dir, "rich.svg")]);
    const svg = await readFile(join(dir, "rich.svg"), "utf8");
    assert.ok(svg.includes("<svg"), "expected valid svg output");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("block string node: emits key: |tag … | with the marker on the closer line", () => {
  const g = {
    v: 2,
    nodes: [{ id: "x", label: "line one\nline two", labelBlock: { tag: "md", quote: "", value: "line one\nline two" }, x: 12, y: 340, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [], hasPos: true }],
    edges: [],
    order: ["x"],
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "x: |md\n  line one\n  line two\n|");
  assert.equal(serializeAnnotated(g), "x: |md\n  line one\n  line two\n| # @d2pos 12,340");
  assert.equal(stripMarkers(serializeAnnotated(g)), serializeClean(g), "parity: annotated = clean + markers");
});

test("block string with quote keeps opener and closer form", () => {
  const g = {
    v: 2,
    nodes: [{ id: "x", label: "a | b\nc", labelBlock: { tag: "md", quote: "++", value: "a | b\nc" }, x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] }],
    edges: [],
    order: ["x"],
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "x: |++md\n  a | b\n  c\n++|");
});

test("block string inside a container: label prop form", () => {
  const g = {
    v: 2,
    nodes: [{
      id: "a", label: "**bold**", labelBlock: { tag: "md", quote: "", value: "**bold**" },
      x: 0, y: 0, w: 150, h: 70, parentId: null, children: ["y"],
      comments: [], trailingComment: null, rawAttrs: []
    }, {
      id: "y", label: "y", x: 0, y: 0, w: 150, h: 70, parentId: "a", children: [], comments: [], trailingComment: null, rawAttrs: []
    }],
    edges: [],
    order: ["a", "y"],
    headerComments: [], trailingComments: [],
    idCounter: 2, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "a: {\n  label: |md\n    **bold**\n  |\n  y\n}");
});

test("block string edge label with trailing comment on the closer", () => {
  const g = {
    v: 2,
    nodes: [
      { id: "a", label: "a", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] },
      { id: "b", label: "b", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [] }
    ],
    edges: [{
      id: "e1", source: "a", target: "b", label: "x", labelBlock: { tag: "md", quote: "", value: "x" },
      comments: [], trailingComment: "note", rawAttrs: []
    }],
    order: ["a", "b", "e1"],
    headerComments: [], trailingComments: [],
    idCounter: 2, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "a\nb\n\na -> b: |md\n  x\n| # note");
});

test("d2Value: unquoted when safe, quoted+escaped otherwise", () => {
  const safe = ["read/write", "HTTPS 2", "Backend API", "a:b", "a.b", "-x", "*glob", "C++", "просто тест"];
  for (const v of safe) {
    assert.equal(d2Value(v), v, "kept unquoted: " + JSON.stringify(v));
  }
  const quoted = [
    ["", '""'],
    ['a#b', '"a#b"'],
    ['a$b', '"a\\$b"'],
    ['a\\b', '"a\\\\b"'],
    ['a;b', '"a;b"'],
    ['{x}', '"{x}"'],
    ['"x"', '"\\"x\\""'],
    ["a b ", '"a b "'],
    [" a b", '" a b"'],
    ['|x', '"|x"'],
    ["$x", '"\\$x"'],
    ["...@y", '"...@y"']
  ];
  for (const [input, expected] of quoted) {
    assert.equal(d2Value(input), expected, "quoted: " + JSON.stringify(input));
  }
});

test("d2Escape: full D2 escape set, `$` and control chars", () => {
  assert.equal(d2Escape('a"b'), 'a\\"b');
  assert.equal(d2Escape("a\\b"), "a\\\\b");
  assert.equal(d2Escape("a$b"), "a\\$b");
  assert.equal(d2Escape("a\tb"), "a\\tb");
  assert.equal(d2Escape("a\rb"), "a\\rb");
  assert.equal(d2Escape("a\bb"), "a\\bb");
  assert.equal(d2Escape("a\fb"), "a\\fb");
  assert.equal(d2Escape("a\vb"), "a\\vb");
});

test("round-trip: values with special chars re-parse to the same label", () => {
  const srcs = [
    "x: { label: \"a#b\" }\n",
    "x: { label: \"a\\b\" }\n",
    "x: { label: \"a;b\" }\n",
    "a -> b {label: \"a#b\"}\n",
    "x: { label: \"  pad  \" }\n"
  ];
  for (const src of srcs) {
    const r = parseD2(src);
    assert.ok(r.ok, src + " " + JSON.stringify(r.error));
    const out = serializeClean(r.graph);
    const r2 = parseD2(out);
    assert.ok(r2.ok, out + " " + JSON.stringify(r2.error));
    assert.equal(serializeClean(r2.graph), out, "stable under re-serialize: " + out);
  }
});

test("d2Value: multi-line label falls back to a block string when re-parsed", () => {
  const src = "x: |md\n  line one\n  line two\n|";
  const r = parseD2(src);
  assert.ok(r.ok, JSON.stringify(r.error));
  const out = serializeClean(r.graph);
  assert.ok(out.includes("|md"), "multi-line label emitted as a block: " + JSON.stringify(out));
  const r2 = parseD2(out);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  const label = r2.graph.nodes.find((n) => n.id === "x").label;
  assert.equal(label, "line one\nline two");
});

test("graph label with newline but no labelBlock is emitted as a block string", () => {
  const g = {
    v: 2,
    nodes: [{
      id: "x", label: "l1\nl2", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [],
      comments: [], trailingComment: null, rawAttrs: []
    }],
    edges: [],
    order: ["x"],
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "x: |-md\n  l1\n  l2\n-|");
  const r = parseD2(serializeClean(g));
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].label, "l1\nl2");
  assert.equal(serializeClean(r.graph), serializeClean(g), "stable");
});
