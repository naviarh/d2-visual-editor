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
