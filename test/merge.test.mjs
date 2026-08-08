import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { parseD2 } = require("../js/d2-parse.js");
const { serializeClean, serializeAnnotated } = require("../js/d2-serialize.js");
const { mergeGraph } = require("../js/d2-merge.js");

function parse(text) {
  const r = parseD2(text);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r.error)}`);
  return r.graph;
}

function nodeById(graph, id) {
  return graph.nodes.find((n) => n.id === id);
}

test("§10 rename on annotated line: position survives via marker", () => {
  const g1 = parse('Client # note # @d2pos 60,300\n"API Server" # @d2pos 340,230\nDatabase\n');

  const g2 = parse('RenamedClient # note # @d2pos 60,300\n"API Server" # @d2pos 340,230\nDatabase\n');
  const out = mergeGraph(g2, g1);

  assert.equal(out.graph.nodes.length, 3);
  const rn = nodeById(out.graph, "RenamedClient");
  assert.ok(rn, "renamed node present");
  assert.equal(rn.hasPos, true);
  assert.equal(rn.x, 60);
  assert.equal(rn.y, 300);
  assert.equal(rn.trailingComment, "note");
  assert.equal(out.removed.length, 0);
  assert.equal(out.added.length, 0);
});

test("§10 rename in clean view: position survives via heuristics", () => {
  const g1 = parse("Client\n\"API Server\"\nDatabase\n\nClient -> \"API Server\"\n\"API Server\" -> Database\n");
  g1.nodes.forEach((n) => {
    n.x = 111;
    n.y = 222;
    n.hasPos = true;
  });

  const g2 = parse("Client\n\"API Server\"\nCache\n\nClient -> \"API Server\"\n\"API Server\" -> Cache\n");
  const out = mergeGraph(g2, g1);

  const cache = nodeById(out.graph, "Cache");
  assert.ok(cache, "renamed node present");
  assert.equal(cache.hasPos, true);
  assert.equal(cache.x, 111);
  assert.equal(cache.y, 222);
});

test("§10 move line of element: position survives (same id)", () => {
  const g1 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\nDatabase\n\nClient -> "API Server"\n');
  const g2 = parse('"API Server" # @d2pos 340,230\nClient # @d2pos 60,300\nDatabase\n\nClient -> "API Server"\n');
  const out = mergeGraph(g2, g1);

  assert.deepEqual(
    out.graph.order,
    ["API Server", "Client", "Database", "e1"],
    "emission order follows the moved text"
  );
  const api = nodeById(out.graph, "API Server");
  assert.equal(api.x, 340);
  const cl = nodeById(out.graph, "Client");
  assert.equal(cl.x, 60);
});

test("§10 insert new block: auto position (fallback), order at end of its scope", () => {
  const g1 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\nDatabase\n');
  const g2 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\nNewBlock # note\nDatabase\n');
  const out = mergeGraph(g2, g1);

  const nb = nodeById(out.graph, "NewBlock");
  assert.ok(nb);
  assert.equal(nb.hasPos, false, "no heuristic match -> no transferred position");
  assert.equal(out.added.length, 1);
  assert.equal(out.added[0], "NewBlock");
  assert.deepEqual(out.graph.order, ["Client", "API Server", "NewBlock", "Database"]);
});

test("§10 delete block: node and its edges removed, others untouched", () => {
  const g1 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\nDatabase # @d2pos 40,60\n\nClient -> "API Server"\n"API Server" -> Database\n');
  g1.edges.forEach((e) => (e.x = 1, e.y = 2));
  const g2 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\n\nClient -> "API Server"\n');
  const out = mergeGraph(g2, g1);

  assert.equal(nodeById(out.graph, "Database"), undefined);
  assert.equal(out.removed.length, 1);
  assert.equal(out.removed[0], "Database");
  assert.equal(out.graph.edges.length, 1);
  assert.deepEqual(out.graph.edges.map((e) => e.target), ["API Server"]);
  const api = nodeById(out.graph, "API Server");
  assert.equal(api.x, 340);
});

test("§10 change edge label: edge identity kept, positions untouched", () => {
  const g1 = parse('Client\n"API Server"\n\nClient -> "API Server": "call" # @d2pos 100,50\n');
  const g2 = parse('Client\n"API Server"\n\nClient -> "API Server": "fetch" # @d2pos 100,50\n');
  const out = mergeGraph(g2, g1);

  const e = out.graph.edges[0];
  assert.ok(e);
  assert.equal(e.label, "fetch");
  assert.equal(e.id, g1.edges[0].id, "edge id preserved on label change");
  assert.deepEqual(out.graph.order, ["Client", "API Server", g1.edges[0].id]);
});

test("§10 syntax error: graph untouched", () => {
  const g1 = parse('Client # @d2pos 60,300\n"API Server"\n');
  const r = parseD2('Client\n"API Server" ->\nDatabase # @d2pos 5,5\n');
  assert.equal(r.ok, false);
  assert.ok(r.error.line, "line reported");
  assert.ok(r.error.message.includes("цель ребра"), "specific error message");
  assert.deepEqual(g1.nodes.map((n) => n.id), ["Client", "API Server"], "current graph not mutated");
});

test("§10 quoted dot key is a literal, longest-key priority", () => {
  const g1 = parse('"b.c" # @d2pos 60,300\nb # @d2pos 200,200\nb.c # @d2pos 300,300\n');
  const g2 = parse('"b.c" # @d2pos 60,300\nb # @d2pos 200,200\n');
  const out = mergeGraph(g2, g1);

  assert.deepEqual(out.graph.nodes.map((n) => n.id), ["b.c", "b"]);
  assert.equal(nodeById(out.graph, "b.c").x, 60);
  assert.equal(nodeById(out.graph, "b").x, 200);
});

test("§10 edge to undeclared block: implicit node created; later explicit merge", () => {
  const g1 = parse('Client # @d2pos 60,300\n\nClient -> "API Server" # @d2pos 300,200\n');
  const implicit = nodeById(g1, "API Server");
  assert.ok(implicit, "implicit node created by parser");
  implicit.hasPos = true;

  const g2 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\n\nClient -> "API Server" # @d2pos 300,200\n');
  const out = mergeGraph(g2, g1);

  const api = nodeById(out.graph, "API Server");
  assert.equal(api.hasPos, true);
  assert.equal(api.x, 340, "explicit declaration position wins");
  assert.equal(out.graph.edges[0].id, g1.edges[0].id);
});

test("§10 row comment preserved as comments[], marker appended", () => {
  const g1 = parse('# header\nClient # @d2pos 60,300\n');
  const g2 = parse('# header\nClient # note # @d2pos 60,300\n');
  const out = mergeGraph(g2, g1);

  const cl = nodeById(out.graph, "Client");
  assert.equal(cl.trailingComment, "note");
  assert.equal(out.graph.headerComments.length, 1);
  assert.equal(out.graph.headerComments[0], "header");
});

test("§10 comments before first element / at end preserved", () => {
  const g1 = parse('# top\nClient\n# bottom\n');
  const g2 = parse('# top\nClient # @d2pos 10,10\n# bottom\n');
  const out = mergeGraph(g2, g1);

  assert.equal(out.graph.headerComments[0], "top");
  assert.equal(out.graph.trailingComments[0], "bottom");
});

test("§10 selection reset when node deleted", () => {
  const g1 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\n');
  const g2 = parse('Client # @d2pos 60,300\n');
  const out = mergeGraph(g2, g1, { selectedId: "API Server", selectedEdgeId: null });

  assert.equal(out.selectedId, null);
  assert.equal(nodeById(out.graph, "Client") !== undefined, true);
});

test("selection survives when id stays", () => {
  const g1 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\nClient -> "API Server"\n');
  const g2 = parse('Client\n"API Server"\nClient -> "API Server"\n');
  const out = mergeGraph(g2, g1, { selectedId: "Client", selectedEdgeId: g1.edges[0].id });

  assert.equal(out.selectedId, "Client");
  assert.equal(out.selectedEdgeId, g1.edges[0].id);
});

test("selection resets when renamed node disappears", () => {
  const g1 = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\n');
  const g2 = parse('Client # @d2pos 60,300\nRenamed # @d2pos 340,230\n');
  const out = mergeGraph(g2, g1, { selectedId: "API Server", selectedEdgeId: null });

  assert.equal(out.selectedId, null, "selection follows id, not heuristics");
});

test("container rename propagates position to descendants via label heuristic", () => {
  const g1 = parse('services: {\n  label: "Backend"\n  api\n}\n');
  const api1 = nodeById(g1, "api");
  api1.x = 5;
  api1.y = 6;
  api1.hasPos = true;
  const g2 = parse('platform: {\n  label: "Backend"\n  api\n}\n');
  const out = mergeGraph(g2, g1);

  assert.equal(out.removed.length, 0, "old container consumed by heuristic match");
  assert.equal(out.added.length, 0);
  const api = nodeById(out.graph, "api");
  assert.ok(api, "descendant exists under new container");
  assert.equal(api.parentId, "platform");
  assert.equal(api.x, 5, "descendant position transferred on container rename");
});

test("fresh parse (no current): no crashes, everything added", () => {
  const g = parse('Client # @d2pos 60,300\nClient -> "API Server"\n');
  const out = mergeGraph(g, null);

  assert.equal(out.added.length, 2);
  assert.equal(out.removed.length, 0);
  assert.equal(out.graph.edges.length, 1);
  assert.equal(out.selectedId, null);
});

test("deep path nodes keep local ids, full path used for matching", () => {
  const g1 = parse('a: {\n  b: { label: "inner" } # @d2pos 10,20\n}\n');
  const g2 = parse('a: {\n  b: { label: "inner" } # @d2pos 10,20\n}\n');
  const out = mergeGraph(g2, g1);

  const b = nodeById(out.graph, "b");
  assert.equal(b.x, 10);
  assert.equal(b.y, 20);
  assert.equal(b.parentId, "a");
});

test("new edge in parsed graph gets fresh unique id, order updated", () => {
  const g1 = parse('Client\n"API Server"\nClient -> "API Server"\n');
  const g2 = parse('Client\n"API Server"\nClient -> "API Server"\n"API Server" -> Client\n');
  const out = mergeGraph(g2, g1);

  assert.equal(out.graph.edges.length, 2);
  const second = out.graph.edges[1];
  assert.equal(second.id, "e2");
  assert.deepEqual(out.graph.order, ["Client", "API Server", g1.edges[0].id, "e2"]);
  assert.ok(out.graph.idCounter > 2);
});

test("end-to-end pipeline: rename+insert+delete in annotated text keeps positions", () => {
  const current = parse('Client # @d2pos 60,300\n"API Server" # @d2pos 340,230\nDatabase # @d2pos 40,60\n\nClient -> "API Server" # note\n');
  current.edges[0].x = 100;
  current.edges[0].y = 200;
  const text = serializeAnnotated(current);
  assert.ok(text.includes("@d2pos"), "annotated text carries markers");

  const edited = text
    .replace("Client # --- @d2pos 60,300", 'WebClient # --- @d2pos 60,300')
    .replace("Client -> \"API Server\"", 'WebClient -> "API Server"')
    .replace("Database # --- @d2pos 40,60", "Database # --- @d2pos 40,60\nNewBlock # --- @d2pos 5,5");

  const parsed = parse(edited);
  const out = mergeGraph(parsed, current, { selectedId: "Client" });

  assert.equal(out.selectedId, null, "selection reset after rename");
  assert.equal(out.added.length, 1);
  assert.equal(out.added[0], "NewBlock");
  assert.equal(out.removed.length, 0, "no deletions in this edit");
  const wc = nodeById(out.graph, "WebClient");
  assert.equal(wc.x, 60, "renamed node keeps marker position");
  const nb = nodeById(out.graph, "NewBlock");
  assert.equal(nb.x, 5, "new node takes its own marker");
  const e = out.graph.edges[0];
  assert.equal(e.id, current.edges[0].id, "edge id stable across rename");

  const reText = serializeAnnotated(out.graph);
  const round = mergeGraph(parse(reText), out.graph);
  assert.deepEqual(
    serializeAnnotated(round.graph),
    reText,
    "annotated text is stable through parse+merge"
  );
});

test("edge directionality: reverse and forward text forms are distinct connections", () => {
  const g1 = parse("a <- b\nb -> a\n");
  assert.equal(g1.edges.length, 2, "two records, two edges");
  const ids = new Set(g1.edges.map((e) => e.id));
  const out = mergeGraph(g1, g1);
  assert.equal(out.removed.length, 0);
  assert.equal(out.added.length, 0);
  assert.equal(out.graph.edges.length, 2);
  assert.deepEqual(
    new Set(out.graph.edges.map((e) => e.id)),
    ids,
    "both edges keep their ids (each form is its own connection)");
});

test("edge directionality: editing -> into <- replaces the connection with the reverse record", () => {
  const g1 = parse("a -> b\n");
  const g2 = parse("a <- b\n");
  const out = mergeGraph(g2, g1);
  assert.equal(out.graph.edges.length, 1);
  assert.equal(out.graph.edges[0].dir, "<-", "reverse form wins");
  assert.deepEqual(
    [out.graph.edges[0].source, out.graph.edges[0].target],
    ["a", "b"],
    "text order preserved");
});

test("edge directionality: repeated identical records keep ids on re-merge", () => {
  const g1 = parse("a -> b\na -> b\n");
  assert.equal(g1.edges.length, 2);
  const out = mergeGraph(g1, g1);
  assert.equal(out.graph.edges.length, 2);
  assert.deepEqual(
    out.graph.edges.map((e) => e.id),
    g1.edges.map((e) => e.id),
    "both records matched in order and kept their ids");
});

test("edge directionality: direction survives a node rename via record key", () => {
  const g1 = parse('a <- "b c"\n');
  const g2 = parse('a <- "b c d"\n');
  const out = mergeGraph(g2, g1);
  const e = out.graph.edges[0];
  assert.equal(e.dir, "<-", "reverse direction kept after the target rename");
});
