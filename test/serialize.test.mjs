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
  assert.ok(out.includes("Client # front-end сервис # --- @d2pos 60,300"));
  assert.ok(out.includes("srv: { # --- @d2pos 340,230"));
  assert.ok(out.includes("  db # --- @d2pos 40,60"));
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

test("POS_RE anchored: matches at end of line only, both marker forms", () => {
  assert.equal("a # @d2pos 1,2".match(POS_RE)[1], "1", "legacy form still parses");
  assert.equal("a # --- @d2pos 1,2".match(POS_RE)[1], "1", "dashed form");
  assert.equal("a # --- @d2pos -12,300".match(POS_RE)[2], "300");
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
  assert.ok(out.includes("a # --- @d2pos 61,-12"), out);
  assert.ok(out.includes("b # --- @d2pos 0,0"), out);
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

test('""" block comments round-trip as """ blocks (not # lines)', () => {
  const multi = parseD2('"""\nblock\ncomment\n"""\nx\n');
  assert.ok(multi.ok, JSON.stringify(multi.error));
  assert.equal(serializeClean(multi.graph), '"""\nblock\ncomment\n"""\nx');
  const single = parseD2('"""one line"""\nx\n');
  assert.ok(single.ok, JSON.stringify(single.error));
  assert.equal(serializeClean(single.graph), '""" one line """\nx');
  const empty = parseD2('""""""\nx\n');
  assert.ok(empty.ok, JSON.stringify(empty.error));
  assert.equal(serializeClean(empty.graph), '"""  """\nx', "empty block normalizes to d2 fmt");
});

test('""" block comment: annotated = clean + markers (stripMarkers parity)', () => {
  const r = parseD2('"""\nnote\n"""\nx\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(stripMarkers(serializeAnnotated(r.graph)), serializeClean(r.graph));
});

test('""" block comment in a nested scope re-emits indented like d2 fmt', () => {
  const r = parseD2('n: {\n  """\n  deep\n    content\n  """\n  child\n}\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(serializeClean(r.graph), [
    'n: {',
    '  """',
    '  deep',
    '    content',
    '  """',
    '  child',
    '}'
  ].join("\n"));
});

test('""" block comment plus trailing # comment both preserved (mixed entries)', () => {
  const r = parseD2('"""\nnote\nlines\n"""\n# plain\nx\n');
  assert.ok(r.ok, JSON.stringify(r.error));
  const text = serializeClean(r.graph);
  assert.equal(text, '"""\nnote\nlines\n"""\n# plain\nx');
  const r2 = parseD2(text);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.deepEqual(r2.graph.headerComments, [{ text: "note\nlines", block: true }, "plain"]);
});

test('d2 CLI: re-emitted """ block comments are byte-identical after d2 fmt', async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "d2ser-"));
  try {
    const src = '"""\nheader note\nlines\n"""\na -> b\n"""\nedge note\n"""\nc\n';
    const r = parseD2(src);
    assert.ok(r.ok, JSON.stringify(r.error));
    const text = serializeClean(r.graph);
    const file = join(dir, "blocks.d2");
    await writeFile(file, text + "\n");
    await exec("d2", [file, join(dir, "blocks.svg")]);
    const fmtFile = join(dir, "blocks-fmt.d2");
    await writeFile(fmtFile, text + "\n");
    await exec("d2", ["fmt", fmtFile]);
    const formatted = await readFile(fmtFile, "utf8");
    assert.equal(formatted.trim(), text, "our emission is d2-fmt-stable (block comments stay as \"\"\" blocks)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  assert.equal(serializeAnnotated(g), "x: |md\n  line one\n  line two\n| # --- @d2pos 12,340");
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

test("graph label with newline but no labelBlock is emitted as escaped \\n (not a block string)", () => {
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
  assert.equal(serializeClean(g), 'x: {label: "l1 \\n l2"}');
  assert.ok(!serializeClean(g).includes("|md"), "no block string synthesized");
  const r = parseD2(serializeClean(g) + "\n");
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].label, "l1 \n l2", "re-parse gains the normalized spaces");
  assert.equal(serializeClean(r.graph), serializeClean(g), "stable");
});

test("multi-line labels keep the \\n escape in code (d2 fmt form), round-trip stable", () => {
  const cases = [
    ["блок \\n первый", '"блок \\n первый"'],
    ['"блок \\n второй"', '"блок \\n второй"'],
    ["a -> b: связь \\n первая", 'a\nb\n\na -> b {label: "связь \\n первая"}'],
    ['с -> в {label: "связь \\n вторая"}', '"с"\n"в"\n\n"с" -> "в" {label: "связь \\n вторая"}'],
    ["block3: блок\\nтретий", 'block3: {label: "блок \\n третий"}']
  ];
  for (const [src, expected] of cases) {
    const r = parseD2(src + "\n");
    assert.ok(r.ok, src + " -> " + JSON.stringify(r.error));
    const out = serializeClean(r.graph);
    assert.equal(out, expected, src);
    assert.ok(out.includes("\\n"), "the code editor keeps the \\n escape: " + JSON.stringify(out));
    assert.ok(!out.includes("|md"), "no block string synthesized: " + JSON.stringify(out));
    const r2 = parseD2(out + "\n");
    assert.ok(r2.ok, JSON.stringify(r2.error));
    assert.equal(serializeClean(r2.graph), out, "stable under re-serialize: " + src);
  }
  const r = parseD2(cases[0][0] + "\n");
  assert.ok(r.ok);
  assert.ok(r.graph.nodes[0].label.includes("\n"), "parsed label contains a real newline");
  assert.equal(r.graph.nodes[0].label, "блок \n первый");
});

test("attribute-array values round-trip verbatim (nodes and edges)", () => {
  const src = "x: [a, b]\ny: [1, 2]\nx -> y: [x]\n";
  const r = parseD2(src);
  assert.ok(r.ok, JSON.stringify(r.error));
  const out = serializeClean(r.graph);
  assert.equal(out, "x: [a, b]\ny: [1, 2]\n\nx -> y: [x]", "array values re-emitted as-is");
  const x = r.graph.nodes.find((n) => n.id === "x");
  assert.equal(x.label, "x", "arrays are not labels");
  assert.equal(x.valueArray, "[a, b]");
  const r2 = parseD2(out);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.equal(serializeClean(r2.graph), out, "stable under re-serialize");
});

test("parity: array-value nodes carry markers on the value line", () => {
  const g = {
    v: 2,
    nodes: [{ id: "x", label: null, valueArray: "[a, b]", x: 4, y: 90, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [], hasPos: true }],
    edges: [],
    order: ["x"],
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "x: [a, b]");
  assert.equal(serializeAnnotated(g), "x: [a, b] # --- @d2pos 4,90");
  assert.equal(stripMarkers(serializeAnnotated(g)), serializeClean(g), "parity: annotated = clean + markers");
});

test("shape: emitted right after label; round-trip and annotated parity", () => {
  const g = {
    v: 2,
    nodes: [{ id: "x", label: "X", shape: "diamond", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [], hasPos: true }],
    edges: [],
    order: ["x"],
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "x: {\n  label: X\n  shape: diamond\n}");
  assert.equal(stripMarkers(serializeAnnotated(g)), serializeClean(g), "annotated = clean + markers");
  const r = parseD2(serializeClean(g));
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].shape, "diamond");
  assert.equal(serializeClean(r.graph), serializeClean(g), "stable under re-serialize");
});

test("shape with no label / unknown name: emitted, never duplicated with legacy rawAttrs", () => {
  const g = {
    v: 2,
    nodes: [
      { id: "a", label: "a", shape: "cylinder", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: ["shape: cylinder", "tooltip: t"], hasPos: true },
      { id: "b", label: "b", shape: "foo bar", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [], hasPos: true }
    ],
    edges: [],
    order: ["a", "b"],
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  const out = serializeClean(g);
  assert.equal(out, "a: {\n  shape: cylinder\n  tooltip: t\n}\nb: {shape: foo bar}");
  const r = parseD2(out);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.graph.nodes[0].shape, "cylinder");
  assert.deepEqual(r.graph.nodes[0].rawAttrs, ["tooltip: t"]);
  assert.equal(r.graph.nodes[1].shape, "foo bar");
  assert.equal(serializeClean(r.graph), out, "stable under re-serialize");
});

test("valueArray node with shape emits two merged declarations (d2 form)", () => {
  const g = {
    v: 2,
    nodes: [{ id: "x", label: null, valueArray: "[a]", shape: "diamond", x: 0, y: 0, w: 150, h: 70, parentId: null, children: [], comments: [], trailingComment: null, rawAttrs: [], hasPos: true }],
    edges: [],
    order: ["x"],
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  };
  assert.equal(serializeClean(g), "x: [a]\nx: {shape: diamond}");
  const r = parseD2(serializeClean(g));
  assert.ok(r.ok, JSON.stringify(r.error));
  const x = r.graph.nodes.find((n) => n.id === "x");
  assert.equal(x.valueArray, "[a]");
  assert.equal(x.shape, "diamond");
  assert.equal(serializeClean(r.graph), serializeClean(g), "stable under re-serialize");
});

test("single-attribute blocks: one line by default, form kept from refText", () => {
  const node = (over) => Object.assign({
    id: "x", label: "x", shape: "oval", x: 0, y: 0, w: 150, h: 70, parentId: null,
    children: [], comments: [], trailingComment: null, rawAttrs: [], hasPos: true
  }, over);
  const graph = (nodes, order) => ({
    v: 2, nodes, edges: [], order,
    headerComments: [], trailingComments: [],
    idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
  });

  // No refText: a single simple attribute collapses to one line.
  assert.equal(serializeClean(graph([node({})], ["x"])), "x: {shape: oval}");
  assert.equal(
    serializeAnnotated(graph([node({})], ["x"])),
    "x: {shape: oval} # --- @d2pos 0,0"
  );

  // refText written on one line -> kept on one line.
  assert.equal(
    serializeClean(graph([node({})], ["x"]), { refText: "x: {shape: oval}\n" }),
    "x: {shape: oval}"
  );

  // refText written across three lines -> kept across three lines.
  assert.equal(
    serializeClean(graph([node({})], ["x"]), { refText: "x: {\n  shape: oval\n}\n" }),
    "x: {\n  shape: oval\n}"
  );

  // A node absent from refText (newly created) collapses like the default.
  assert.equal(
    serializeClean(graph([node({})], ["x"]), { refText: "a: {shape: diamond}\n" }),
    "x: {shape: oval}"
  );

  // RefIds map (from D2P.inlineIds) drives the same decision.
  assert.equal(
    serializeClean(graph([node({})], ["x"]), { refIds: new Map([["x", false]]) }),
    "x: {\n  shape: oval\n}"
  );
  assert.equal(
    serializeClean(graph([node({})], ["x"]), { refIds: new Map([["x", true]]) }),
    "x: {shape: oval}"
  );

  // Two attributes never collapse, regardless of refText.
  assert.equal(
    serializeClean(graph([node({ label: "X" })], ["x"]), { refText: "x: {shape: oval}\n" }),
    "x: {\n  label: X\n  shape: oval\n}"
  );

  // A group (children) never collapses.
  const k = { id: "k", label: "k", x: 0, y: 0, w: 150, h: 70, parentId: "x", children: [], comments: [], trailingComment: null, rawAttrs: [], hasPos: true };
  assert.equal(
    serializeClean(graph([node({ children: ["k"] }), k], ["x"]), { refText: "x: {shape: oval}\n" }),
    "x: {\n  shape: oval\n  k\n}"
  );

  // A single-attribute rawAttr block keeps its form too.
  const rawNode = node({ shape: undefined, rawAttrs: ["tooltip: t"] });
  assert.equal(
    serializeClean(graph([rawNode], ["x"]), { refText: "x: {\n  tooltip: t\n}\n" }),
    "x: {\n  tooltip: t\n}"
  );
  assert.equal(serializeClean(graph([rawNode], ["x"])), "x: {tooltip: t}");

  // Parity holds with and without refText.
  const opts = { refText: "x: {\n  shape: oval\n}\n" };
  assert.equal(stripMarkers(serializeAnnotated(graph([node({})], ["x"]), opts)),
    serializeClean(graph([node({})], ["x"]), opts));
});
