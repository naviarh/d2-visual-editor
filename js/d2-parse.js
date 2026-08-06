(function (global) {
  "use strict";

  var POS_RE = /#\s*@d2pos\s*(-?\d+),\s*(-?\d+)\s*$/;
  var POS_INNER_RE = /\s*#?\s*@d2pos\s*(-?\d+),\s*(-?\d+)\s*$/;

  var RESERVED = {
    "label": 1, "shape": 1, "style": 1, "width": 1, "height": 1, "icon": 1,
    "tooltip": 1, "link": 1, "dir": 1, "direction": 1, "gap": 1, "grid-gap": 1,
    "opacity": 1, "near": 1, "fill": 1, "stroke": 1, "stroke-width": 1,
    "font-size": 1, "border-radius": 1, "shadow": 1, "text-font-size": 1,
    "source-arrowhead": 1, "target-arrowhead": 1, "pad": 1, "pad-x": 1, "pad-y": 1
  };

  function isDelim(ch) {
    return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "#" || ch === '"' ||
      ch === "{" || ch === "}" || ch === ":" || ch === "," || ch === "." || ch === "[" || ch === "]" ||
      ch === "(" || ch === ")" || ch === ";";
  }

  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;
    var line = 1, col = 1;
    function advance(ch) {
      if (ch === "\n") { line++; col = 1; } else { col++; }
      i++;
    }
    while (i < n) {
      var ch = src[i];
      var startLine = line, startCol = col;
      if (ch === "\n") { tokens.push({ type: "nl", line: startLine, col: startCol }); advance(ch); continue; }
      if (ch === " " || ch === "\t" || ch === "\r") { advance(ch); continue; }
      if (ch === "#") {
        var cs = i;
        while (i < n && src[i] !== "\n") advance(src[i]);
        tokens.push({ type: "comment", text: src.slice(cs + 1, i).trim(), line: startLine, col: startCol });
        continue;
      }
      if (ch === '"') {
        var s = i;
        var val = "";
        var closed = false;
        i++; col++;
        while (i < n) {
          var c = src[i];
          if (c === '"') { i++; col++; closed = true; break; }
          if (c === "\\") {
            var e = src[i + 1];
            if (e === '"') val += '"';
            else if (e === "\\") val += "\\";
            else if (e === "n") val += "\n";
            else val += "\\" + (e || "");
            i += 2; col += 2;
            continue;
          }
          if (c === "\n") break;
          val += c; i++; col++;
        }
        if (!closed) return { error: { line: startLine, col: startCol, message: "незакрытая строка (ожидается \")" } };
        tokens.push({ type: "str", value: val, line: startLine, col: startCol, off: s, end: i });
        continue;
      }
      if (ch === "-" && src[i + 1] === ">") {
        tokens.push({ type: "arrow", line: startLine, col: startCol, off: i, end: i + 2 });
        advance(ch);
        advance(src[i]);
        continue;
      }
      if (ch === "{" || ch === "}" || ch === ":" || ch === "," || ch === "." || ch === "[" || ch === "]" || ch === "(" || ch === ")") {
        tokens.push({ type: "punct", value: ch, line: startLine, col: startCol, off: i, end: i + 1 });
        advance(ch);
        continue;
      }
      if (ch === ";") {
        tokens.push({ type: "nl", line: startLine, col: startCol });
        advance(ch);
        continue;
      }
      var is = i;
      while (i < n && !isDelim(src[i])) {
        var cc = src[i];
        if (cc === "-" && src[i + 1] === ">") break;
        advance(cc);
      }
      tokens.push({ type: "ident", value: src.slice(is, i), line: startLine, col: startCol, off: is, end: i });
    }
    return { tokens: tokens };
  }

  function parseD2(src) {
    var tok = tokenize(src);
    if (tok.error) return { ok: false, error: tok.error };
    var tokens = tok.tokens;
    var pos = 0;
    var lastLine = 1, lastCol = 1;

    var graph = {
      v: 2, nodes: [], edges: [], order: [], headerComments: [], trailingComments: [],
      idCounter: 1, viewport: { x: 0, y: 0, zoom: 1 }, showComments: true
    };
    var nodesByPath = new Map();
    var edgesByTriple = new Map();
    var orderSet = new Set();
    var scopeStack = [null];
    var pending = [[]];
    var sawTopLevel = false;

    function ParseError(message, line, col) {
      this.message = message;
      this.line = line || 1;
      this.col = col || 1;
    }
    ParseError.prototype = Object.create(Error.prototype);
    ParseError.prototype.name = "ParseError";

    function errorAt(tokOrNull, message) {
      throw new ParseError(message, tokOrNull ? tokOrNull.line : lastLine, tokOrNull ? tokOrNull.col : lastCol);
    }

    function peek() { return tokens[pos]; }
    function next() { var t = tokens[pos++]; if (t) { lastLine = t.line; lastCol = t.col; } return t; }
    function peekIs(v) { var t = peek(); return !!t && t.type === "punct" && t.value === v; }
    function peekNext() { return tokens[pos + 1]; }
    function isArrow() { var t = peek(); return !!t && t.type === "arrow"; }
    function skipNl() { while (peek() && peek().type === "nl") next(); }
    function commentIsInline() {
      var t = peek();
      return !!t && t.type === "comment" && pos > 0 && tokens[pos - 1].type !== "nl";
    }
    function curScope() { return scopeStack[scopeStack.length - 1]; }
    function curDepth() { return scopeStack.length - 1; }

    function addToOrder(id) {
      if (!orderSet.has(id)) { orderSet.add(id); graph.order.push(id); }
    }

    function ensureNode(localId, parentNode, fullPath) {
      var ex = nodesByPath.get(fullPath);
      if (ex) return ex;
      var n = {
        id: localId, label: localId, x: 0, y: 0, w: 150, h: 70,
        parentId: parentNode ? parentNode.id : null, children: [], comments: [],
        trailingComment: null, rawAttrs: [], implicit: true, hasPos: false,
        _path: fullPath
      };
      nodesByPath.set(fullPath, n);
      graph.nodes.push(n);
      addToOrder(localId);
      if (parentNode && parentNode.children.indexOf(localId) < 0) parentNode.children.push(localId);
      return n;
    }

    function expandSeg(t, full) {
      if (t.type === "str") return [t.value];
      var cand = full ? full + "." + t.value : t.value;
      if (nodesByPath.has(cand)) return [t.value];
      return t.value.split(".");
    }

    function resolvePath(pathTokens) {
      var full = curScope() ? curScope()._path : "";
      var cur = curScope();
      for (var ti = 0; ti < pathTokens.length; ti++) {
        var exp = expandSeg(pathTokens[ti], full);
        for (var pi = 0; pi < exp.length; pi++) {
          var seg = exp[pi];
          full = full ? full + "." + seg : seg;
          cur = ensureNode(seg, cur, full);
        }
      }
      return cur;
    }

    function extractMarker(text) {
      var m = POS_INNER_RE.exec(text);
      if (!m) return null;
      return { x: parseInt(m[1], 10), y: parseInt(m[2], 10), rest: text.replace(POS_INNER_RE, "").trim() };
    }

    function captureRawBlock() {
      var startTok = peek();
      if (!startTok) { errorAt(null, "ожидается '{'"); }
      next();
      var depth = 1;
      var openEnd = startTok.end;
      var closeStart = 0;
      while (true) {
        var t = peek();
        if (!t) { errorAt(null, "незакрытый блок атрибута"); }
        if (t.type === "punct" && t.value === "{") depth++;
        else if (t.type === "punct" && t.value === "}") {
          depth--;
          if (depth === 0) { closeStart = t.off; next(); break; }
        }
        next();
      }
      var lineStart = src.lastIndexOf("\n", startTok.off) + 1;
      var base = 0;
      while (base < lineStart && (src[lineStart + base] === " " || src[lineStart + base] === "\t")) base++;
      var raw = src.slice(openEnd, closeStart);
      var out = [];
      var rawLines = raw.split("\n");
      for (var i = 0; i < rawLines.length; i++) {
        var line = rawLines[i];
        var ws = 0;
        while (ws < line.length && (line[ws] === " " || line[ws] === "\t")) ws++;
        var content = line.slice(ws);
        if (!content.trim().length) continue;
        out.push(" ".repeat(Math.max(0, ws - base)) + content);
      }
      return out;
    }

    function parseValue() {
      var t = peek();
      if (!t) return null;
      if (t.type === "str") { next(); return t.value; }
      if (t.type === "punct" && t.value === "[") {
        var startOff = t.off;
        var depth = 0;
        var endOff = 0;
        while (true) {
          var tk = peek();
          if (!tk) { errorAt(null, "незакрытый массив"); }
          if (tk.type === "punct" && tk.value === "[") depth++;
          else if (tk.type === "punct" && tk.value === "]") {
            depth--;
            if (depth === 0) { endOff = tk.end; next(); break; }
          }
          next();
        }
        return src.slice(startOff, endOff);
      }
      if (t.type === "ident") {
        var v = t.value;
        next();
        if (/^\d+$/.test(v) && peekIs(".")) {
          var t2 = peekNext();
          if (t2 && t2.type === "ident" && /^\d+$/.test(t2.value)) {
            next(); v += "." + next().value;
            return v;
          }
        }
        while (peekIs(".")) {
          var t3 = peekNext();
          if (t3 && (t3.type === "ident" || t3.type === "str")) {
            next();
            v += "." + next().value;
          } else break;
        }
        return v;
      }
      return null;
    }

    function consumePending(entity) {
      var d = curDepth();
      if (d === 0 && !sawTopLevel) {
        graph.headerComments = graph.headerComments.concat(pending[0]);
        pending[0] = [];
        sawTopLevel = true;
        return;
      }
      if (!pending[d].length) return;
      var rest = [];
      var marker = null;
      for (var i = 0; i < pending[d].length; i++) {
        var ex = extractMarker(pending[d][i]);
        if (ex && entity.hasPos !== undefined) {
          if (!marker) marker = ex;
        } else rest.push(pending[d][i]);
      }
      if (marker && entity.hasPos !== undefined && !entity.hasPos) {
        entity.x = marker.x;
        entity.y = marker.y;
        entity.hasPos = true;
      }
      entity.comments = entity.comments.concat(rest);
      pending[d] = [];
    }

    function attachInlineNode(node) {
      if (!commentIsInline()) return;
      var c = next();
      var m = extractMarker(c.text);
      if (m) {
        if (!node.hasPos) { node.x = m.x; node.y = m.y; node.hasPos = true; }
        if (node.trailingComment == null) node.trailingComment = m.rest || null;
      } else if (node.trailingComment == null) {
        node.trailingComment = c.text;
      }
    }

    function attachInlineEdge(edges) {
      if (!commentIsInline()) return;
      var c = next();
      var last = edges[edges.length - 1];
      if (last && last.trailingComment == null) last.trailingComment = c.text;
    }

    function declareNode(pathTokens) {
      var node = resolvePath(pathTokens);
      node.implicit = false;
      consumePending(node);
      return node;
    }

    function parseAttrBody(target, key) {
      if (peekIs("{")) {
        var blockLines = captureRawBlock();
        target.rawAttrs = target.rawAttrs.concat(key + ": {" + blockLines.map(function (l) { return "\n" + l; }).join("") + "\n}");
        return;
      }
      var v = parseValue();
      var isLabel = key === "label";
      if (isLabel) {
        if (v != null) target.label = v;
      } else {
        target.rawAttrs.push(key + (v != null ? ": " + v : ":"));
      }
      if (commentIsInline()) {
        var c = next();
        if (isLabel) {
          if (target.trailingComment == null) target.trailingComment = c.text;
        } else {
          target.rawAttrs[target.rawAttrs.length - 1] += " # " + c.text;
        }
      }
    }

    function parseEdgeAttrBlock(ed) {
      if (!peekIs("{")) { errorAt(peek(), "ожидается '{'"); }
      next();
      while (true) {
        skipNl();
        var t = peek();
        if (!t) { errorAt(null, "незакрытый блок атрибутов ребра"); }
        if (t.type === "punct" && t.value === "}") { next(); return; }
        if (t.type === "comment") {
          ed.comments.push(t.text);
          next();
          continue;
        }
        if (t.type === "punct" && (t.value === "," || t.value === ";")) { next(); continue; }
        var p = parsePath();
        if (!p) { errorAt(t, "ожидается атрибут ребра"); }
        if (!peekIs(":")) { errorAt(peek(), "ожидается ':' в атрибутах ребра"); }
        next();
        parseAttrBody(ed, p[p.length - 1].value);
      }
    }

    function parsePath() {
      var t = peek();
      if (!t || (t.type !== "ident" && t.type !== "str")) return null;
      var segs = [next()];
      while (peekIs(".")) {
        next();
        var t2 = peek();
        if (t2 && (t2.type === "ident" || t2.type === "str")) segs.push(next());
        else { errorAt(t2, "ожидается сегмент пути после '.'"); }
      }
      return segs;
    }

    function createEdge(srcPath, tgtPath) {
      var src = resolvePath(srcPath);
      var tgt = resolvePath(tgtPath);
      var triple = src.id + "\u0000" + tgt.id + "\u0000";
      var ex = edgesByTriple.get(triple);
      if (ex) return ex;
      var ed = {
        id: "e" + (graph.idCounter++), source: src.id, target: tgt.id, label: null,
        comments: [], trailingComment: null, rawAttrs: []
      };
      graph.edges.push(ed);
      edgesByTriple.set(triple, ed);
      addToOrder(ed.id);
      return ed;
    }

    function parseEdge(firstPath) {
      var sources = [firstPath];
      while (peekIs(",")) {
        next();
        var sp = parsePath();
        if (!sp) { errorAt(peek(), "ожидается путь после ','"); }
        sources.push(sp);
      }
      if (!isArrow()) { errorAt(peek(), "ожидается '->'"); }
      var edges = [];
      while (isArrow()) {
        next();
        var targets = [];
        while (true) {
          var p = parsePath();
          if (!p) { errorAt(peek(), "ожидается цель ребра после '->'"); }
          targets.push(p);
          if (peekIs(",")) { next(); continue; }
          break;
        }
        for (var si = 0; si < sources.length; si++) {
          for (var ti = 0; ti < targets.length; ti++) {
            edges.push(createEdge(sources[si], targets[ti]));
          }
        }
        sources = targets;
      }
      if (edges.length) consumePending(edges[0]);
      var t = peek();
      if (t && t.type === "punct" && t.value === ":") {
        next();
        if (peekIs("{")) {
          parseEdgeAttrBlock(edges[edges.length - 1]);
        } else {
          var v = parseValue();
          if (v != null) edges[edges.length - 1].label = v;
        }
      } else if (t && t.type === "punct" && t.value === "{") {
        parseEdgeAttrBlock(edges[edges.length - 1]);
      }
      attachInlineEdge(edges);
      return edges;
    }

    function parseNodeOrAttr(pathTokens) {
      var t = peek();
      if (t && t.type === "punct" && t.value === ":") {
        var single = pathTokens.length === 1;
        var key = pathTokens[pathTokens.length - 1].value;
        var scopeNode = curScope();
        next();
        if (scopeNode && single && RESERVED[key]) {
          parseAttrBody(scopeNode, key);
          return;
        }
        if (peekIs("{")) {
          next();
          var node = declareNode(pathTokens);
          parseBlock(node);
          attachInlineNode(node);
          return;
        }
        var v = parseValue();
        var cn = declareNode(pathTokens);
        if (v != null) cn.label = v;
        attachInlineNode(cn);
        return;
      }
      if (t && t.type === "punct" && t.value === "{") {
        next();
        var bnode = declareNode(pathTokens);
        parseBlock(bnode);
        attachInlineNode(bnode);
        return;
      }
      if (t && (t.type === "ident" || t.type === "str")) {
        var lv = next().value;
        var cn2 = declareNode(pathTokens);
        cn2.label = lv;
        attachInlineNode(cn2);
        return;
      }
      var cn3 = declareNode(pathTokens);
      attachInlineNode(cn3);
    }

    function parseStatement() {
      skipNl();
      var t = peek();
      if (!t) return false;
      if (t.type === "nl") { next(); return true; }
      if (t.type === "comment") {
        if (commentIsInline()) {
          var c = next();
          var scope = curScope();
          if (scope) {
            var m = extractMarker(c.text);
            if (m) {
              if (!scope.hasPos) { scope.x = m.x; scope.y = m.y; scope.hasPos = true; }
              if (scope.trailingComment == null) scope.trailingComment = m.rest || null;
            } else if (scope.trailingComment == null) {
              scope.trailingComment = c.text;
            }
          }
        } else {
          pending[curDepth()].push(t.text);
          next();
        }
        return true;
      }
      if (t.type === "punct") {
        if (t.value === "}") { errorAt(t, "лишняя закрывающая скобка '}'"); }
        if (t.value === "]") { errorAt(t, "лишняя закрывающая скобка ']'"); }
        if (t.value === "," || t.value === ";") { next(); return true; }
        errorAt(t, "неожиданный символ '" + t.value + "'");
      }
      if (t.type === "arrow") { errorAt(t, "стрелка без исходника"); }
      if (t.type === "ident" && t.value.charCodeAt(0) === 64) {
        errorAt(t, "директивы/переменные (@) не поддерживаются");
      }
      var path = parsePath();
      if (!path) { errorAt(t, "неожиданный токен"); }
      if (isArrow() || peekIs(",")) {
        parseEdge(path);
        return true;
      }
      parseNodeOrAttr(path);
      return true;
    }

    function parseBlock(container) {
      scopeStack.push(container);
      pending.push([]);
      while (true) {
        skipNl();
        var t = peek();
        if (!t) { errorAt(null, "незакрытый блок: ожидается '}' (в '" + container.id + "')"); }
        if (t.type === "punct" && t.value === "}") { next(); break; }
        parseStatement();
      }
      var leftover = pending.pop();
      scopeStack.pop();
      if (leftover && leftover.length) {
        pending[pending.length - 1] = pending[pending.length - 1].concat(leftover);
      }
    }

    function parse() {
      while (true) {
        skipNl();
        var t = peek();
        if (!t) break;
        parseStatement();
      }
      for (var i = 0; i < graph.nodes.length; i++) delete graph.nodes[i]._path;
      graph.trailingComments = graph.trailingComments.concat(pending[0]);
      return graph;
    }

    try {
      parse();
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, error: { line: e.line, col: e.col, message: e.message } };
      throw e;
    }
    return { ok: true, graph: graph };
  }

  var api = {
    POS_RE: POS_RE,
    POS_INNER_RE: POS_INNER_RE,
    RESERVED: RESERVED,
    tokenize: tokenize,
    parseD2: parseD2
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2parse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
