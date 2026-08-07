import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const mod = require("../js/d2-shapes.js");
const {
  SHAPES, SHAPE_NAMES, getShape, renderShape, outlinePoints,
  outlineIntersect, normalizeRatio, FALLBACK
} = mod;

const NAMES = SHAPE_NAMES;

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToPolygon(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return best;
}

test("registry covers all 18 d2 shape names", () => {
  const expected = [
    "rectangle", "square", "page", "parallelogram", "document", "cylinder",
    "queue", "package", "step", "callout", "stored_data", "person",
    "diamond", "oval", "circle", "hexagon", "cloud", "c4-person"
  ];
  assert.deepEqual(NAMES, expected);
  for (const n of NAMES) {
    assert.ok(SHAPES[n], `missing registry entry: ${n}`);
    assert.equal(SHAPES[n].name, n);
  }
});

test("getShape is case-insensitive; hyphen alias works; fallback for unknown/missing", () => {
  assert.equal(getShape("Diamond"), SHAPES.diamond);
  assert.equal(getShape("c4-PERSON"), SHAPES.c4person);
  assert.equal(getShape("c4-person"), SHAPES.c4person);
  assert.equal(getShape("diamond"), SHAPES.diamond);
  assert.equal(getShape("foo"), FALLBACK);
  assert.equal(getShape(null), FALLBACK);
  assert.equal(getShape(undefined), FALLBACK);
  assert.equal(getShape(""), FALLBACK);
  assert.equal(FALLBACK.name, "fallback");
  assert.deepEqual(FALLBACK.params, { rx: 8 });
  assert.equal(FALLBACK.ratio, null);
});

test("renderShape returns non-empty SVG path strings for every shape", () => {
  const box = { x: 0, y: 0, w: 150, h: 70 };
  for (const n of NAMES) {
    const paths = renderShape(n, box);
    assert.ok(Array.isArray(paths) && paths.length > 0, n);
    for (const d of paths) {
      assert.equal(typeof d, "string", n);
      assert.ok(d.length > 0, n);
      assert.match(d, /^M/, n);
    }
  }
  for (const n of ["rectangle", "oval"]) {
    assert.equal(renderShape(n, box).length, 1, n);
  }
});

test("outline is a closed polygon with finite points within bounds", () => {
  const box = { x: 10, y: 20, w: 150, h: 70 };
  for (const n of NAMES) {
    const tol = n === "cloud" ? box.w * 0.5 : 1;
    const poly = outlinePoints(n, box);
    assert.ok(poly.length >= 3, n);
    for (const p of poly) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), n);
      assert.ok(p.x >= box.x - tol && p.x <= box.x + box.w + tol, `${n}: x=${p.x}`);
      assert.ok(p.y >= box.y - tol && p.y <= box.y + box.h + tol, `${n}: y=${p.y}`);
    }
    assert.ok(distToPolygon(poly[0], poly) < 1e-6, `${n}: outline not closed`);
  }
});

test("outlineIntersect returns a point on the polygon for all directions", () => {
  const box = { x: 0, y: 0, w: 150, h: 70 };
  const cx = box.w / 2, cy = box.h / 2;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
  for (const n of NAMES) {
    const poly = outlinePoints(n, box);
    for (const [dx, dy] of dirs) {
      const hit = outlineIntersect(poly, cx, cy, dx, dy);
      assert.ok(hit, `${n} direction ${dx},${dy}: no intersection`);
      assert.ok(Number.isFinite(hit.x) && Number.isFinite(hit.y), n);
      assert.ok(distToPolygon(hit, poly) < 1e-6, `${n} dir ${dx},${dy}: hit off polygon`);
    }
  }
});

test("outlineIntersect anchors to the shape contour, not the bounding box", () => {
  const box = { x: 0, y: 0, w: 150, h: 70 };
  // parallelogram top edge is shifted right by skew*h; a ray up from the center
  // must hit the slanted top edge, not the bbox top at y=0.
  const p = outlinePoints("parallelogram", box);
  const hit = outlineIntersect(p, box.w / 2, box.h / 2, 0, -1);
  assert.ok(hit);
  assert.ok(Math.abs(hit.y - box.h / 2) > 1, `parallelogram: hit too low, y=${hit.y}`);
  assert.ok(distToPolygon(hit, p) < 1e-6);
});

test("concave polygon: nearest intersection wins (first exit from center)", () => {
  // cap shape: two arms joined by a top bar, open at the bottom.
  const poly = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
    { x: 80, y: 100 }, { x: 80, y: 20 }, { x: 20, y: 20 },
    { x: 20, y: 100 }, { x: 0, y: 100 }
  ];
  const hit = outlineIntersect(poly, 10, 50, 1, 0);
  assert.ok(hit, "ray exits the left arm");
  assert.ok(Math.abs(hit.x - 20) < 1e-9, `expected first exit x=20, got ${hit.x}`);
  assert.equal(hit.y, 50);
});

test("outlineIntersect returns null when the ray misses the polygon", () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  const poly = outlinePoints("rectangle", box);
  assert.equal(outlineIntersect(poly, 200, 200, 1, 0), null);
});

test("c4-person: head overlaps the body, outline is the clean union contour", () => {
  const box = { x: 0, y: 0, w: 150, h: 70 };
  const rec = SHAPES.c4person;
  const r = rec.params.headR * Math.min(box.w, box.h);
  const top = (2 - rec.params.headOverlap) * r;
  assert.ok(2 * r > top + 1e-6, "head bottom dips below the body top (overlap)");
  const poly = outlinePoints("c4-person", box);
  assert.ok(poly.some((p) => Math.abs(p.y - box.y) < 0.5), "head apex reaches the box top");
  const half = r * Math.sqrt(2 * rec.params.headOverlap - rec.params.headOverlap * rec.params.headOverlap);
  const cx = box.w / 2;
  const onTop = poly.filter((p) => Math.abs(p.y - top) < 0.5);
  assert.ok(onTop.some((p) => Math.abs(p.x - (cx - half)) < 1), "left head crossing on the body top");
  assert.ok(onTop.some((p) => Math.abs(p.x - (cx + half)) < 1), "right head crossing on the body top");
  const inGap = onTop.filter((p) => p.x > cx - half + 0.5 && p.x < cx + half - 0.5);
  assert.equal(inGap.length, 0, "covered top-center segment is removed from the outline");
});

test("normalizeRatio: 1:1 forms take the maximum of w/h", () => {
  assert.deepEqual(normalizeRatio("circle", 150, 70), { w: 150, h: 150 });
  assert.deepEqual(normalizeRatio("square", 60, 90), { w: 90, h: 90 });
  assert.deepEqual(normalizeRatio("circle", 80, 80), { w: 80, h: 80 });
  assert.deepEqual(normalizeRatio("rectangle", 150, 70), { w: 150, h: 70 });
  assert.deepEqual(normalizeRatio("oval", 150, 70), { w: 150, h: 70 });
  assert.deepEqual(normalizeRatio("c4-person", 150, 70), { w: 150, h: 70 });
  assert.deepEqual(normalizeRatio("unknown", 150, 70), { w: 150, h: 70 });
});

test("fallback rectangle renders for unknown names and empty boxes are handled", () => {
  const box = { x: 0, y: 0, w: 0, h: 0 };
  const paths = renderShape("foo", box);
  assert.ok(paths.length > 0);
  const poly = outlinePoints("foo", box);
  assert.ok(poly.length >= 3);
});
