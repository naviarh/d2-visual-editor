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
const { serializeClean } = require("../js/d2-serialize.js");
const exec = promisify(execFile);

// Table §8 of docs/plans/d2-string-syntax.md, verified against `d2` v0.7.1.
// For every row the CLI verdict (and error line) must match our parser.
// `label` is the value extracted by our parser from node `x` on success.
// Unsupported constructs ($, ...@) are valid-or-invalid d2 too — the CLI
// rejects them with its own message, we reject with ours, at the same line.
const CASES = [
  { src: "x: don't", ok: true, label: "don't" },
  { src: 'x: a"b', ok: true, label: 'a"b' },
  { src: "x: (a)", ok: true, label: "(a)" },
  { src: "x: a.b", ok: true, label: "a.b" },
  { src: "x: a,b", ok: true, label: "a,b" },
  { src: "x: a:b", ok: true, label: "a:b" },
  { src: "x: a # tail", ok: true, label: "a" },
  { src: "x: a; b", ok: true, label: "a" },
  { src: "x: [a]", ok: true, array: "[a]" },
  { src: "x: {a}", ok: true, label: "x" },
  { src: "x: 'it''s'", ok: true, label: "it's" },
  { src: "x: 'a\\nb'", ok: true, label: "a\\nb" },
  { src: "x: 'a\\'b'", ok: false, line: 1 },
  { src: 'x: "a\\qb"', ok: true, label: "aqb" },
  { src: 'x: "a\tb"', ok: true, label: "a\tb" },
  { src: 'x: "a\\"b"', ok: true, label: 'a"b' },
  { src: 'x: "unterminated', ok: false, line: 1 },
  { src: "// header\nx -> y", ok: true },
  { src: "# header\nx -> y", ok: true },
  { src: "x: |md\n  a\n  b|", ok: true, label: "a\nb", noTxt: true },
  { src: "x: ||\n  code\n||", ok: true, label: "code", noTxt: true },
  { src: "a <-> b", ok: true },
  { src: "a <- b", ok: true },
  { src: "(a, b) -> c", ok: true },
  { src: "a.b -> c", ok: true },
  { src: '""" unterminated', ok: false, line: 1 },
  { src: "x: |md\n  no close", ok: false, line: 1 },
  { src: "x: $var", ok: false, line: 1 },
  { src: "x: a$b", ok: false, line: 1 },
  { src: "x: *g", ok: true, label: "*g" },
  { src: "x: ...@y", ok: false, line: 1 }
];

function cliValidate(file) {
  return exec("d2", ["validate", file])
    .then(() => ({ ok: true, line: null }))
    .catch((e) => {
      const m = /(\d+):(\d+):/.exec(String(e.stderr || e.message));
      return { ok: false, line: m ? Number(m[1]) : null };
    });
}

test("shape catalog: all 18 names pass d2 validate; our parser round-trips them", async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const { SHAPE_NAMES } = require("../js/d2-shapes.js");
  const dir = await mkdtemp(join(tmpdir(), "d2parity-shape-"));
  try {
    for (let i = 0; i < SHAPE_NAMES.length; i++) {
      const name = SHAPE_NAMES[i];
      const src = "x: { shape: " + name + " }";
      const r = parseD2(src);
      assert.ok(r.ok, `shape ${name}: parser accepts`);
      const n = r.graph.nodes.find((n) => n.id === "x");
      assert.equal(n.shape, name, `shape ${name}: field set`);
      const file = join(dir, `s${i}.d2`);
      await writeFile(file, src + "\n");
      const cli = await cliValidate(file);
      assert.equal(cli.ok, true, `shape ${name}: d2 validate accepts`);
      const round = parseD2(serializeClean(r.graph) + "\n");
      assert.ok(round.ok, `shape ${name}: re-serialized graph reparses`);
      const rn = round.graph.nodes.find((n) => n.id === "x");
      assert.equal(rn.shape, name, `shape ${name}: round-trip keeps the field`);
    }
    // case is preserved in the model, valid for d2 (registry is case-insensitive)
    const src = "x: { shape: Diamond }";
    const r = parseD2(src);
    assert.ok(r.ok, "shape: Diamond parses");
    assert.equal(r.graph.nodes.find((n) => n.id === "x").shape, "Diamond", "case preserved");
    const file = join(dir, "case.d2");
    await writeFile(file, src + "\n");
    assert.equal((await cliValidate(file)).ok, true, "shape: Diamond valid for d2 validate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("§8 parity table: our parser agrees with d2 validate (verdict and error line)", async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "d2parity-"));
  try {
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      const r = parseD2(c.src);
      assert.equal(r.ok, c.ok, `case ${i} (${JSON.stringify(c.src)}): parser verdict`);
      if (r.ok && c.label !== undefined) {
        const n = r.graph.nodes.find((n) => n.id === "x");
        assert.ok(n, `case ${i}: node 'x' present`);
        assert.equal(n.label, c.label, `case ${i} (${JSON.stringify(c.src)}): label`);
      }
      if (r.ok && c.array !== undefined) {
        const n = r.graph.nodes.find((n) => n.id === "x");
        assert.equal(n.valueArray, c.array, `case ${i} (${JSON.stringify(c.src)}): array value`);
      }
      if (!r.ok && c.line !== undefined) {
        assert.equal(r.error.line, c.line, `case ${i} (${JSON.stringify(c.src)}): our error line`);
      }
      const file = join(dir, `c${i}.d2`);
      await writeFile(file, c.src + "\n");
      const cli = await cliValidate(file);
      assert.equal(cli.ok, c.ok, `case ${i} (${JSON.stringify(c.src)}): d2 validate verdict`);
      if (!cli.ok && c.line !== undefined) {
        assert.equal(cli.line, c.line, `case ${i} (${JSON.stringify(c.src)}): d2 validate error line`);
      }
      if (c.ok && !c.noTxt && c.label !== undefined && !c.label.includes("\n")) {
        // The real CLI must render the same label we extracted.
        await exec("d2", [file, join(dir, `c${i}.txt`)]);
        const txt = await readFile(join(dir, `c${i}.txt`), "utf8");
        assert.ok(txt.includes(c.label), `case ${i} (${JSON.stringify(c.src)}): label rendered by d2`);
      }
      if (r.ok) {
        const round = parseD2(serializeClean(r.graph) + "\n");
        assert.ok(round.ok, `case ${i}: re-serialized graph reparses: ${serializeClean(r.graph)}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toStandardD2 output passes d2 validate even when the source is annotated", async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const { toStandardD2, serializeAnnotated } = require("../js/d2-serialize.js");
  const dir = await mkdtemp(join(tmpdir(), "d2parity-std-"));
  try {
    const src = '"Клиент" # --- @d2pos 60,300\n"Сервер": {\n  "База" # --- @d2pos 40,60\n}\n"Клиент" -> "Сервер" {label: запрос}\n';
    const r = parseD2(src);
    assert.ok(r.ok, "annotated source parses");
    const std = toStandardD2(r.graph, src);
    assert.ok(!std.includes("@d2pos"), "standard form has no markers");
    const file = join(dir, "std.d2");
    await writeFile(file, std + "\n");
    assert.equal((await cliValidate(file)).ok, true, "d2 validate accepts toStandardD2 output");
    // And the annotated source itself is also valid D2 (markers are comments).
    const ann = serializeAnnotated(r.graph, { refText: src });
    const file2 = join(dir, "ann.d2");
    await writeFile(file2, ann + "\n");
    assert.equal((await cliValidate(file2)).ok, true, "d2 validate accepts annotated form");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge references: folded output passes d2 validate and renders the same edges", async (t) => {
  try {
    await exec("d2", ["--version"]);
  } catch {
    t.skip("d2 CLI not available");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "d2parity-eref-"));
  try {
    const fixtures = [
      // [source with refs, expected folded edge lines]
      ["a -> b\n(a -> b)[0].label: Отправка\n", "a -> b {label: Отправка}"],
      ["a -> b\n(a -> b)[0].style.stroke: red\n", "a -> b {style.stroke: red}"],
      ["a -> b\na -> b\n(a -> b)[*].style.stroke: red\n", "a -> b {style.stroke: red}"],
      ["a -> b\n(a -> b).label: X\n", "a -> b {label: X}"],
      ["a -> b -> c\n(a -> b -> c)[0].style.stroke: red\n", "a -> b {style.stroke: red}"],
      ["a -> b\n(a -> b)[0]: hi\n", "a -> b {label: hi}"],
      ["a -> b\n(a -> b)[0].label: hi # note\n", "a -> b {label: hi}"]
    ];
    for (let i = 0; i < fixtures.length; i++) {
      const [src, folded] = fixtures[i];
      // The reference source itself must be valid d2 and compile.
      const file = join(dir, `f${i}.d2`);
      await writeFile(file, src);
      assert.equal((await cliValidate(file)).ok, true, `fixture ${i}: source valid d2`);
      // Our parse -> serialize must produce the canonical folded inline form.
      const r = parseD2(src);
      assert.ok(r.ok, `fixture ${i}: parses (${JSON.stringify(r.error)})`);
      const out = serializeClean(r.graph);
      assert.ok(out.includes(folded), `fixture ${i}: folded form emitted\n${out}`);
      // The folded output must be valid d2 and render the same edges.
      const outFile = join(dir, `o${i}.d2`);
      await writeFile(outFile, out + "\n");
      assert.equal((await cliValidate(outFile)).ok, true, `fixture ${i}: folded output valid`);
      const svgA = join(dir, `s${i}a.svg`);
      const svgB = join(dir, `s${i}b.svg`);
      await exec("d2", [file, svgA]);
      await exec("d2", [outFile, svgB]);
      const a = await readFile(svgA, "utf8");
      const b = await readFile(svgB, "utf8");
      const strokes = (s) => (s.match(/stroke="red"/g) || []).length;
      const edges = (s) => (s.match(/class="edge"/g) || []).length;
      assert.equal(strokes(a), strokes(b), `fixture ${i}: same red strokes`);
      assert.equal(edges(a), edges(b), `fixture ${i}: same edge count`);
    }
    // Verdict parity for error cases (compile-time errors, checked via the
    // real render: `d2 validate` is purely syntactic).
    const errors = [
      ["a -> b\n(a -> b)[5].label: hi\n", 2],
      ["(c -> d)[0].label: hi\n", 1]
    ];
    for (const [src, line] of errors) {
      const file = join(dir, "e.d2");
      await writeFile(file, src);
      const err = await exec("d2", [file, join(dir, "e.svg")]).catch((e) => e);
      assert.ok(err.stderr, `error case errors in d2: ${src.trim()}`);
      const m = /\.d2:(\d+):(\d+):/.exec(String(err.stderr || err.message));
      assert.equal(Number(m && m[1]), line, `error case line matches: ${src.trim()}`);
      const r = parseD2(src);
      assert.equal(r.ok, false, `error case errors in our parser: ${src.trim()}`);
      assert.equal(r.error.line, line, `error case line matches ours: ${src.trim()}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
