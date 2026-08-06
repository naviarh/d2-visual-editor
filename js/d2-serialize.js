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
    while (n) {
      path.unshift(n.id);
      n = n.parentId ? byId.get(n.parentId) : null;
    }
    return path;
  }

  function treeOrder(graph) {
    var byId = indexNodes(graph);
    var order = [];
    function visit(n) {
      order.push(n.id);
      for (var i = 0; i < (n.children || []).length; i++) {
        var c = byId.get(n.children[i]);
        if (c) visit(c);
      }
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

  function serialize(graph, options) {
    options = options || {};
    var annotated = !!options.annotated;
    var byId = indexNodes(graph);
    var byEdge = indexEdges(graph);
    var order = Array.isArray(graph.order) && graph.order.length
      ? graph.order.slice()
      : defaultOrder(graph);
    var lines = [];

    for (var h = 0; h < (graph.headerComments || []).length; h++) {
      lines.push("# " + graph.headerComments[h]);
    }

    var prevType = null;
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var n = byId.get(id);
      if (n) {
        if (n.parentId && byId.has(n.parentId)) continue;
        emitNode(n, 0, byId, lines, annotated);
        prevType = "node";
        continue;
      }
      var ed = byEdge.get(id);
      if (ed) {
        if (prevType === "node") lines.push("");
        emitEdge(ed, byId, lines);
        prevType = "edge";
      }
    }

    for (var t = 0; t < (graph.trailingComments || []).length; t++) {
      lines.push("# " + graph.trailingComments[t]);
    }

    return lines.join("\n");
  }

  function lineSuffix(n, annotated) {
    var parts = [];
    if (n.trailingComment) parts.push("# " + n.trailingComment);
    if (annotated) parts.push("# @d2pos " + n.x + "," + n.y);
    return parts.length ? " " + parts.join(" ") : "";
  }

  function emitNode(n, depth, byId, lines, annotated) {
    var ind = "  ".repeat(depth);
    for (var c = 0; c < (n.comments || []).length; c++) {
      lines.push(ind + "# " + n.comments[c]);
    }
    var key = d2Key(n.id);
    var kids = [];
    for (var k = 0; k < (n.children || []).length; k++) {
      var kid = byId.get(n.children[k]);
      if (kid) kids.push(kid);
    }
    var props = [];
    if (n.label !== n.id) props.push("label: " + d2Key(n.label));
    var raw = n.rawAttrs || [];
    if (kids.length || props.length || raw.length) {
      var open = ind + key + ": {" + lineSuffix(n, annotated);
      lines.push(open);
      for (var p = 0; p < props.length; p++) lines.push(ind + "  " + props[p]);
      for (var r = 0; r < raw.length; r++) lines.push(ind + "  " + raw[r]);
      for (var d = 0; d < kids.length; d++) emitNode(kids[d], depth + 1, byId, lines, annotated);
      lines.push(ind + "}");
    } else {
      lines.push(ind + key + lineSuffix(n, annotated));
    }
  }

  function emitEdge(ed, byId, lines) {
    var s = byId.get(ed.source);
    var t = byId.get(ed.target);
    if (!s || !t) return;
    var src = nodePath(byId, ed.source).map(d2Key).join(".");
    var tgt = nodePath(byId, ed.target).map(d2Key).join(".");
    var line = src + " -> " + tgt;
    if (ed.label) line += " {label: " + d2Key(ed.label) + "}";
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
