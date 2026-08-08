(function (global) {
  "use strict";

  var POS_RE = /#\s*@d2pos\s*(-?\d+),\s*(-?\d+)\s*$/;

  // D2 escapes for double-quoted emission: backslash, quote, `$` (a
  // substitution start in values) and the control chars of the D2 escape set.
  // A real newline is intentionally NOT emitted here — d2 would decode `\n`
  // inside quotes to a line break and fail to close the string; multi-line
  // values are emitted as block strings by the callers.
  function d2Escape(s) {
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/\x08/g, "\\b")
      .replace(/\x09/g, "\\t")
      .replace(/\x0A/g, "\\n")
      .replace(/\x0B/g, "\\v")
      .replace(/\x0C/g, "\\f")
      .replace(/\x0D/g, "\\r");
  }

  function d2Key(s) {
    var str = String(s);
    if (/^[A-Za-z0-9_]+$/.test(str)) return str;
    return '"' + d2Escape(str) + '"';
  }

  // An unquoted D2 value must re-parse to the same string: no value
  // terminators (§2.2), no `$`/`\` (substitution/escape), no surrounding
  // whitespace (trimmed on parse) and a first char that would not open a
  // quoted/block/import token.
  function unquotedSafeValue(s) {
    if (s === "") return false;
    var c0 = s.charAt(0);
    if (c0 === " " || c0 === "\t" || c0 === '"' || c0 === "'" || c0 === "|" || c0 === "$") return false;
    var last = s.charAt(s.length - 1);
    if (last === " " || last === "\t") return false;
    if (s.indexOf("...@") === 0) return false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "\r" || ch === "\n" || ch === ";" || ch === "#" ||
          ch === "{" || ch === "}" || ch === "[" || ch === "]" ||
          ch === "$" || ch === "\\") return false;
    }
    return true;
  }

  function d2Value(s) {
    var str = String(s);
    if (unquotedSafeValue(str)) return str;
    return '"' + d2Escape(str) + '"';
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

  // Closing sequence of a block string: last quote char + quote[1:] + "|";
  // with no quote chars it is a single `|`.
  function blockStringCloser(quote) {
    if (!quote) return "|";
    return quote.charAt(quote.length - 1) + quote.slice(1) + "|";
  }

  // Emit a block string: opener line (`|quote tag`), content lines indented
  // two spaces, closing line. Content keeps its value (already trimmed), so a
  // re-parse strips the uniform indent and reproduces the same value.
  function emitBlockString(lines, openerLine, block) {
    lines.push(openerLine + "|" + block.quote + block.tag);
    var ws = /^[ \t]*/.exec(openerLine)[0];
    var parts = String(block.value || "").split("\n");
    for (var i = 0; i < parts.length; i++) lines.push(ws + "  " + parts[i]);
    lines.push(ws + blockStringCloser(block.quote));
    return lines.length - 1;
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
    var raw = n.rawAttrs || [];
    var hasShape = n.shape != null;
    if (hasShape) {
      // Legacy graphs may carry `shape:` inside rawAttrs; never emit twice.
      raw = raw.filter(function (r) {
        return String(r).split("\n")[0].trim().indexOf("shape:") !== 0;
      });
    }
    var lb = n.labelBlock;
    var plainLabel = n.label != null && n.label !== n.id;
    if (!lb && plainLabel && String(n.label).indexOf("\n") !== -1) {
      // A multi-line label without a parsed block: emit it as a block string.
      lb = { tag: "md", quote: "-", value: String(n.label) };
    }
    var blockLabel = !!lb;
    plainLabel = plainLabel && !blockLabel;
    if (n.valueArray) {
      // An attribute-array value: `key: [a, b]` (never a label in D2). d2 has
      // no single-line form for array + attrs, so a shape/raw/kids payload is
      // emitted as a second merged declaration (d2 merges by path).
      lines.push(ind + key + ": " + n.valueArray + lineSuffix(n, annotated));
      if (kids.length || raw.length || hasShape) {
        lines.push(ind + key + ": {" + lineSuffix(n, annotated));
        if (hasShape) lines.push(ind + "  shape: " + d2Value(n.shape));
        for (var r = 0; r < raw.length; r++) appendRaw(lines, ind, raw[r]);
        for (var d = 0; d < kids.length; d++) emitNode(kids[d], depth + 1, byId, lines, annotated);
        lines.push(ind + "}");
      }
      return;
    }
    if (kids.length || raw.length || hasShape) {
      var open = ind + key + ": {" + lineSuffix(n, annotated);
      lines.push(open);
      if (blockLabel) emitBlockString(lines, ind + "  label: ", lb);
      else if (plainLabel) lines.push(ind + "  label: " + d2Value(n.label));
      if (hasShape) lines.push(ind + "  shape: " + d2Value(n.shape));
      for (var r = 0; r < raw.length; r++) appendRaw(lines, ind, raw[r]);
      for (var d = 0; d < kids.length; d++) emitNode(kids[d], depth + 1, byId, lines, annotated);
      lines.push(ind + "}");
      return;
    }
    if (blockLabel) {
      // Node's own value is a block string: emit `key: |quote tag … |`.
      var bi = emitBlockString(lines, ind + key + ": ", lb);
      lines[bi] += lineSuffix(n, annotated);
      return;
    }
    if (plainLabel) {
      lines.push(ind + key + ": {" + lineSuffix(n, annotated));
      lines.push(ind + "  label: " + d2Value(n.label));
      lines.push(ind + "}");
      return;
    }
    lines.push(ind + key + lineSuffix(n, annotated));
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
    var line = src + " " + (ed.dir || "->") + " " + tgt;
    var lb = ed.labelBlock;
    var plainLabel = ed.label;
    if (!lb && plainLabel && String(ed.label).indexOf("\n") !== -1) {
      lb = { tag: "md", quote: "-", value: String(ed.label) };
    }
    if (lb) {
      var bi = emitBlockString(lines, line + ": ", lb);
      if (ed.trailingComment) lines[bi] += " # " + ed.trailingComment;
      return;
    }
    if (ed.valueArray) {
      var va = line + ": " + ed.valueArray;
      if (ed.trailingComment) va += " # " + ed.trailingComment;
      lines.push(va);
      return;
    }
    var attrs = [];
    if (plainLabel) attrs.push("label: " + d2Value(ed.label));
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
    d2Value: d2Value,
    d2Escape: d2Escape,
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
