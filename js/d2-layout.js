(function (global) {
  "use strict";

  var PAD = 24, HEAD = 28, GAP = 32, STEP = 40, MARGIN = 8, MAX_TRIES = 2000;

  function indexById(graph) {
    var m = new Map();
    for (var i = 0; i < graph.nodes.length; i++) m.set(graph.nodes[i].id, graph.nodes[i]);
    return m;
  }

  function isContainer(n) {
    return !!n.children && n.children.length > 0;
  }

  function absPos(byId, n) {
    var x = n.x || 0, y = n.y || 0, p = n.parentId, guard = 0;
    while (p && byId.has(p) && guard++ < 100) {
      var par = byId.get(p);
      x += par.x || 0;
      y += par.y || 0;
      p = par.parentId;
    }
    return { x: x, y: y };
  }

  function boxSize(byId, n) {
    var memo = new Set();
    function measure(x) {
      if (!isContainer(x)) return { w: x.w || 150, h: x.h || 70 };
      if (memo.has(x.id)) return { w: 0, h: 0 };
      memo.add(x.id);
      var w = 0, h = 0;
      for (var i = 0; i < x.children.length; i++) {
        var c = byId.get(x.children[i]);
        if (!c) continue;
        var s = measure(c);
        w = Math.max(w, (c.x || 0) + s.w);
        h = Math.max(h, (c.y || 0) + s.h);
      }
      return { w: w + PAD * 2, h: h + HEAD + PAD };
    }
    return measure(n);
  }

  function absBox(byId, n) {
    var p = absPos(byId, n);
    var s = boxSize(byId, n);
    return { x: p.x, y: p.y, w: s.w, h: s.h };
  }

  function isDescendant(byId, ancId, nodeId) {
    var n = byId.get(nodeId), guard = 0;
    while (n && guard++ < 100) {
      if (n.id === ancId) return true;
      n = n.parentId ? byId.get(n.parentId) : null;
    }
    return false;
  }

  function overlaps(a, b, margin) {
    var m = margin || 0;
    return a.x < b.x + b.w + m && b.x < a.x + a.w + m &&
           a.y < b.y + b.h + m && b.y < a.y + a.h + m;
  }

  function isFree(box, others, margin) {
    for (var i = 0; i < others.length; i++) {
      if (overlaps(box, others[i], margin)) return false;
    }
    return true;
  }

  // Spiral search around the anchor for the nearest free spot (max-norm rings).
  // minX/minY (absolute) bound the region when set (e.g. container children).
  function searchFree(anchorX, anchorY, w, h, others, margin, minX, minY) {
    if (isFree({ x: anchorX, y: anchorY, w: w, h: h }, others, margin)) {
      return { x: anchorX, y: anchorY };
    }
    var tried = 1;
    for (var r = 1; r < 100000 && tried < MAX_TRIES; r++) {
      for (var d = -r; d <= r && tried < MAX_TRIES; d++) {
        var candidates = [
          [anchorX + d * STEP, anchorY - r * STEP],
          [anchorX + d * STEP, anchorY + r * STEP],
          [anchorX - r * STEP, anchorY + d * STEP],
          [anchorX + r * STEP, anchorY + d * STEP]
        ];
        for (var c = 0; c < candidates.length && tried < MAX_TRIES; c++, tried++) {
          if (minX !== undefined && candidates[c][0] < minX) continue;
          if (minY !== undefined && candidates[c][1] < minY) continue;
          var box = { x: candidates[c][0], y: candidates[c][1], w: w, h: h };
          if (isFree(box, others, margin)) return box;
        }
      }
    }
    return { x: anchorX, y: anchorY };
  }

  // Semantic flow of an edge: `a <- b` points from b to a. Text order is kept
  // in the model, so layout must follow the arrow direction.
  function edgeEndpoints(e) {
    return e.dir === "<-"
      ? { source: e.target, target: e.source }
      : { source: e.source, target: e.target };
  }

  function firstNeighbor(graph, nodeId) {
    for (var i = 0; i < graph.edges.length; i++) {
      var ep = edgeEndpoints(graph.edges[i]);
      if (ep.source === nodeId) return { id: ep.target, direction: 1 };
      if (ep.target === nodeId) return { id: ep.source, direction: -1 };
    }
    return null;
  }

  /**
   * Place a node that has no position yet (added via text merge or UI).
   * Anchor: near a connected neighbor (chains), else inside its container,
   * else at the viewport center; then spiral-search the nearest free spot.
   * Mutates the node in place; sets hasPos so the position is committed.
   */
  function placeNewNode(graph, nodeId, opts) {
    var byId = indexById(graph);
    var node = byId.get(nodeId);
    if (!node) return null;
    if (node.hasPos) return { x: node.x, y: node.y };
    var w = node.w || 150, h = node.h || 70;
    var parent = node.parentId && byId.has(node.parentId) ? byId.get(node.parentId) : null;
    var origin = parent ? absPos(byId, parent) : { x: 0, y: 0 };

    var anchorX, anchorY;
    var nb = firstNeighbor(graph, nodeId);
    if (nb) {
      var nn = byId.get(nb.id);
      if (nn) {
        var na = absPos(byId, nn);
        var ns = boxSize(byId, nn);
        anchorY = na.y + Math.max(0, (ns.h - h) / 2);
        anchorX = nb.direction === 1
          ? na.x - w - GAP   // this node is the edge source -> left of target
          : na.x + ns.w + GAP; // this node is the edge target -> right of source
      }
    }
    if (anchorX === undefined) {
      if (parent) {
        anchorX = origin.x + PAD;
        anchorY = origin.y + HEAD;
      } else {
        var c = (opts && opts.center) ? opts.center : { x: 0, y: 0 };
        anchorX = c.x - w / 2;
        anchorY = c.y - h / 2;
      }
    }

    var others = [];
    for (var i = 0; i < graph.nodes.length; i++) {
      var n = graph.nodes[i];
      if (n.id === nodeId) continue;
      if (parent && isDescendant(byId, nodeId, n.id)) continue;
      others.push(absBox(byId, n));
    }

    var found = searchFree(
      anchorX, anchorY, w, h, others, MARGIN,
      parent ? origin.x : undefined,   // children must not escape top-left corner
      parent ? origin.y : undefined
    );
    node.x = Math.round(found.x - origin.x);
    node.y = Math.round(found.y - origin.y);
    node.hasPos = true;
    return { x: node.x, y: node.y };
  }

  var api = {
    PAD: PAD, HEAD: HEAD, GAP: GAP, MARGIN: MARGIN,
    indexById: indexById, isContainer: isContainer, absPos: absPos,
    boxSize: boxSize, absBox: absBox, isDescendant: isDescendant,
    overlaps: overlaps, searchFree: searchFree, placeNewNode: placeNewNode
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2layout = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
