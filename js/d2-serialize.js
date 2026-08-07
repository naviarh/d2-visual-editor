(function (global) {
  "use strict";

  var POS_RE = /#\s*@d2pos\s*(-?\d+),\s*(-?\d+)\s*$/;

  function d2Key(s) {
    var str = String(s);
    if (/^[A-Za-z0-9_]+$/.test(str)) return str;
    return '"' + str.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function indexNodes(graph) {
    var byId = new Map();
    for (var i = 0; i < graph.nodes.length; i++) byId.set(graph.nodes[i].id, graph.nodes[i]);
    return byId;
  }

  function indexEdges(graph) {
    var byId = new Map();
    for (var i = 0; i < graph.edges.length; i++) byId.set(graph.edges[i].id, graph.edges[i]);
    return byId;
  }

  function nodePath(byId, id) {
    var path = [];
    var n = byId.get(id);
    var guard = 0;
    while (n && guard++ < 1000) {
      path.unshift(n.id);
      n = n.parentId ? byId.get(n.parentId) : null;
    }
    return path;
  }

  function treeOrder(graph) {
    var byId = indexNodes(graph);
    var order = [];
    var visiting = new Set();
    function visit(n) {
      if (visiting.has(n.id)) return;
      visiting.add(n.id);
      order.push(n.id);
      for (var i = 0; i < (n.children || []).length; i++) {
        var c = byId.get(n.children[i]);
        if (c) visit(c);
      }
      visiting.delete(n.id);
    }
    for (var j = 0; j < graph.nodes.length; j++) {
      var n = graph.nodes[j];
      if (!n.parentId || !byId.has(n.parentId)) visit(n);
    }
    return order;
  }

  function defaultOrder(graph) {
    return treeOrder(graph).concat(graph.edges.map(function (e) { return e.id; }));
  }

  function intCoord(v) {
    return Number.isFinite(v) ? Math.round(v) : 0;
  }

  // A comment entry may span several lines (merged `#` lines, `"""` blocks);
  // D2 emits each line as its own `#`-comment, so split on newlines.
  function pushComment(lines, ind, text) {
    var parts = String(text).split("\n");
    for (var i = 0; i < parts.length; i++) lines.push(ind + "# " + parts[i]);
  }

  function serialize(graph, options) {
    options = options || {};
    var annotated = !!options.annotated;
    var byId = indexNodes(graph);
    var byEdge = indexEdges(graph);
    var order = Array.isArray(graph.order) && graph.order.length
      ? graph.order.slice()
      : defaultOrder(graph);
    var lines = [];
    var emitted = new Set();
    var visiting = new Set();

    function markTree(n) {
      emitted.add(n.id);
      for (var i = 0; i < (n.children || []).length; i++) {
        var c = byId.get(n.children[i]);
        if (c) markTree(c);
      }
    }

    // Emit n at top level, hoisting missing ancestors so no subtree is lost.
    // Returns true if any new content was emitted (for section blank lines).
    function ensureEmitted(n, depth) {
      if (emitted.has(n.id)) return false;
      if (visiting.has(n.id)) return false;
      if (n.parentId && byId.has(n.parentId)) {
        visiting.add(n.id);
        ensureEmitted(byId.get(n.parentId), depth);
        visiting.delete(n.id);
        return true;
      }
      emitNode(n, depth, byId, lines, annotated);
      markTree(n);
      return true;
    }

    for (var h = 0; h < (graph.headerComments || []).length; h++) {
      pushComment(lines, "", graph.headerComments[h]);
    }

    var prevType = null;
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var n = byId.get(id);
      if (n) {
        if (ensureEmitted(n, 0)) prevType = "node";
        continue;
      }
      var ed = byEdge.get(id);
      if (ed && !emitted.has(id)) {
        if (prevType === "node") lines.push("");
        emitEdge(ed, byId, lines);
        emitted.add(id);
        prevType = "edge";
      }
    }

    for (var t = 0; t < (graph.trailingComments || []).length; t++) {
      pushComment(lines, "", graph.trailingComments[t]);
    }

    return lines.join("\n");
  }

  function lineSuffix(n, annotated) {
    var parts = [];
    if (n.trailingComment) parts.push("# " + n.trailingComment);
    if (annotated) parts.push("# @d2pos " + intCoord(n.x) + "," + intCoord(n.y));
    return parts.length ? " " + parts.join(" ") : "";
  }

  function emitNode(n, depth, byId, lines, annotated) {
    var ind = "  ".repeat(depth);
    for (var c = 0; c < (n.comments || []).length; c++) {
      pushComment(lines, ind, n.comments[c]);
    }
    var key = d2Key(n.id);
    var kids = [];
    for (var k = 0; k < (n.children || []).length; k++) {
      var kid = byId.get(n.children[k]);
      if (kid) kids.push(kid);
    }
    var props = [];
    if (n.label != null && n.label !== n.id) props.push("label: " + d2Key(n.label));
    var raw = n.rawAttrs || [];
    if (kids.length || props.length || raw.length) {
      var open = ind + key + ": {" + lineSuffix(n, annotated);
      lines.push(open);
      for (var p = 0; p < props.length; p++) lines.push(ind + "  " + props[p]);
      for (var r = 0; r < raw.length; r++) appendRaw(lines, ind, raw[r]);
      for (var d = 0; d < kids.length; d++) emitNode(kids[d], depth + 1, byId, lines, annotated);
      lines.push(ind + "}");
    } else {
      lines.push(ind + key + lineSuffix(n, annotated));
    }
  }

  function appendRaw(lines, ind, raw) {
    var parts = String(raw).split("\n");
    for (var i = 0; i < parts.length; i++) lines.push(ind + "  " + parts[i]);
  }

  function emitEdge(ed, byId, lines) {
    var s = byId.get(ed.source);
    var t = byId.get(ed.target);
    if (!s || !t) return;
    for (var c = 0; c < (ed.comments || []).length; c++) {
      pushComment(lines, "", ed.comments[c]);
    }
    var src = nodePath(byId, ed.source).map(d2Key).join(".");
    var tgt = nodePath(byId, ed.target).map(d2Key).join(".");
    var line = src + " -> " + tgt;
    var attrs = [];
    if (ed.label) attrs.push("label: " + d2Key(ed.label));
    for (var r = 0; r < (ed.rawAttrs || []).length; r++) attrs.push(ed.rawAttrs[r]);
    if (attrs.length === 1) {
      line += " {" + attrs[0] + "}";
      if (ed.trailingComment) line += " # " + ed.trailingComment;
      lines.push(line);
      return;
    }
    if (attrs.length > 1) {
      lines.push(line + " {");
      for (var a = 0; a < attrs.length; a++) appendRaw(lines, "", attrs[a]);
      if (ed.trailingComment) lines.push("} # " + ed.trailingComment);
      else lines.push("}");
      return;
    }
    if (ed.trailingComment) line += " # " + ed.trailingComment;
    lines.push(line);
  }

  function serializeClean(graph) {
    return serialize(graph, { annotated: false });
  }

  function serializeAnnotated(graph) {
    return serialize(graph, { annotated: true });
  }

  function stripMarkers(text) {
    return text.split("\n").map(function (l) { return l.replace(POS_RE, "").replace(/\s+$/, ""); }).join("\n");
  }

  var api = {
    POS_RE: POS_RE,
    d2Key: d2Key,
    indexNodes: indexNodes,
    indexEdges: indexEdges,
    nodePath: nodePath,
    treeOrder: treeOrder,
    defaultOrder: defaultOrder,
    serializeClean: serializeClean,
    serializeAnnotated: serializeAnnotated,
    stripMarkers: stripMarkers
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2mod = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
