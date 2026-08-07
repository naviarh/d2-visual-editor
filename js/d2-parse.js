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

  // D2 unquoted strings (d2parser parseUnquotedString): spaces are NOT
  // delimiters and every token is a whole word run. Terminators depend on
  // context: `a: a.b` is the label "a.b", but in a key `.` splits a path.
  // Everywhere: \r \n ; # { } [ ]  — plus in keys: : . < > & and edge
  // markers -- -> -* *- (a single `-` is literal: `a-b` is one key).
  function isValueTerm(ch) {
    return ch === "\r" || ch === "\n" || ch === ";" || ch === "#" ||
      ch === "{" || ch === "}" || ch === "[" || ch === "]";
  }

  function isKeyTerm(ch) {
    return isValueTerm(ch) || ch === ":" || ch === "." || ch === "<" || ch === ">" || ch === "&";
  }

  // Matches d2parser decodeEscape: known escapes decode, unknown escapes
  // drop the backslash (`"\q"` -> "q"), `\`+newline is a line continuation
  // handled by the scanner itself.
  function decodeEscape(c) {
    switch (c) {
      case "a": return "\x07";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "v": return "\x0B";
      case "\\": return "\\";
      case '"': return '"';
      default: return c;
    }
  }

  // d2parser trimSpaceAfterLastNewline: drop trailing whitespace, and if the
  // last line is empty, drop the final newline too.
  function trimSpaceAfterLastNewline(s) {
    var lastNL = s.lastIndexOf("\n");
    if (lastNL === -1) return s.replace(/\s+$/, "");
    var lastLine = s.slice(lastNL + 1).replace(/\s+$/, "");
    if (lastLine.length === 0) return s.slice(0, lastNL);
    return s.slice(0, lastNL + 1) + lastLine;
  }

  // d2parser trimCommonIndent: strip the smallest leading indentation (tabs
  // count as 2 columns) shared by every non-empty line. Any line without
  // leading whitespace returns the input untouched.
  function trimCommonIndent(s) {
    var lines = s.split("\n");
    var common = null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] === "") continue;
      var ws = 0;
      while (ws < lines[i].length && (lines[i][ws] === " " || lines[i][ws] === "\t")) ws++;
      if (lines[i].slice(ws).trim() === "") continue;
      if (ws === 0) return s;
      var indentLen = 0;
      for (var j = 0; j < ws; j++) indentLen += lines[i][j] === "\t" ? 2 : 1;
      if (common === null || indentLen < common) common = indentLen;
    }
    if (common === null || common === 0) return s;
    var out = [];
    for (var k = 0; k < lines.length; k++) {
      if (lines[k] === "") { out.push(lines[k]); continue; }
      var have = 0;
      var idx = 0;
      while (idx < lines[k].length && have < common) {
        if (lines[k][idx] === "\t") have += 2;
        else if (lines[k][idx] === " ") have += 1;
        else break;
        idx++;
      }
      out.push(lines[k].slice(idx));
    }
    return out.join("\n");
  }

  function arrowLen(k, src) {
    var c = src[k];
    if (c === "-" && (src[k + 1] === "-" || src[k + 1] === ">" || src[k + 1] === "*")) return 2;
    if (c === "<" && src[k + 1] === "-") return src[k + 2] === ">" ? 3 : 2;
    if (c === "*" && src[k + 1] === "-") return 2;
    return 0;
  }

  // d2parser parseBlockString: symbol quote chars stop at whitespace, alnum
  // and underscore; the trailing `|` in `|--|` is part of the quote.
  function blockQuoteEndsAt(c) {
    return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "_" ||
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
  }

  function blockTagEndsAt(c) {
    return c === "." || c === "_" || c === "-" ||
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
  }

  // Closing sequence of a block string: last quote char + quote[1:] + "|";
  // with no quote chars it is a single `|` (any `|` terminates, like d2).
  function blockStringCloser(quote) {
    if (!quote) return "|";
    return quote.charAt(quote.length - 1) + quote.slice(1) + "|";
  }

  // Context-aware string lexer. `inValue` is true while scanning a value
  // (after `:`), which widens the word terminator set to D2 value rules.
  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;
    var line = 1, col = 1;
    var inValue = false;
    function advance(ch) {
      if (ch === "\n") { line++; col = 1; } else { col++; }
      i++;
    }
    while (i < n) {
      var ch = src[i];
      var startLine = line, startCol = col;

      if (ch === "\r") { advance(ch); continue; }
      if (ch === "\n") {
        tokens.push({ type: "nl", line: startLine, col: startCol });
        advance(ch);
        inValue = false;
        continue;
      }
      if (ch === " " || ch === "\t") { advance(ch); continue; }

      if (ch === "#") {
        var cs = i;
        while (i < n && src[i] !== "\n") advance(src[i]);
        var ctext = src.slice(cs + 1, i);
        // D2 parseCommentLine strips exactly one leading space after `#`.
        if (ctext.charAt(0) === " ") ctext = ctext.slice(1);
        tokens.push({ type: "comment", text: ctext, line: startLine, col: startCol });
        inValue = false;
        continue;
      }
      // D2 parseBlockComment: `"""` at statement position (inValue false) opens
      // a block comment; `""` is enough to open one, like d2parser. `//` is NOT
      // a comment — it is plain unquoted text.
      if (ch === '"' && src[i + 1] === '"' && !inValue) {
        var bLine = startLine, bCol = startCol;
        advance(src[i]); advance(src[i]); advance(src[i]);
        while (i < n && (src[i] === " " || src[i] === "\t")) advance(src[i]);
        if (i < n && src[i] === "\n") advance(src[i]);
        var bbuf = "";
        var bclosed = false;
        while (i < n) {
          if (src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
            advance(src[i]); advance(src[i]); advance(src[i]);
            bclosed = true;
            break;
          }
          bbuf += src[i];
          advance(src[i]);
        }
        if (!bclosed) {
          return { error: { line: bLine, col: bCol, message: 'незакрытый блочный комментарий (ожидается """)' } };
        }
        var btext = trimCommonIndent(trimSpaceAfterLastNewline(bbuf));
        tokens.push({ type: "comment", text: btext, line: bLine, col: bCol, block: true });
        inValue = false;
        continue;
      }

      // D2 parseBlockString: `|` in value position opens a block string.
      // `|quote tag` opens, content runs until the closing sequence
      // (last quote char + quote[1:] + "|"; a bare `|` when quote is empty).
      if (ch === "|" && inValue) {
        var bsLine = startLine, bsCol = startCol, bsStart = i;
        advance(ch);
        var bq = "";
        while (i < n && !blockQuoteEndsAt(src[i])) { bq += src[i]; advance(src[i]); }
        var bt = "";
        while (i < n && blockTagEndsAt(src[i])) { bt += src[i]; advance(src[i]); }
        if (!bt) bt = "md";
        while (i < n && (src[i] === " " || src[i] === "\t")) advance(src[i]);
        var bsSame = false;
        if (i < n && src[i] !== "\n" && src[i] !== "\r") {
          bsSame = true;
        } else if (i < n) {
          advance(src[i]);
        }
        var bbuf = "";
        var bclosed = false;
        var bh = "|", br = "";
        if (bq) { bh = bq.charAt(bq.length - 1); br = bq.slice(1) + "|"; }
        while (i < n) {
          var bc = src[i];
          if (bc === bh) {
            if (br === "" || src.substr(i + 1, br.length) === br) {
              var bsCloseLine = line, bsCloseCol = col;
              advance(bc);
              for (var bri = 0; bri < br.length; bri++) advance(src[i]);
              bclosed = true;
              break;
            }
            bbuf += bc;
            advance(bc);
          } else {
            bbuf += bc;
            advance(bc);
          }
        }
        if (!bclosed) {
          return { error: { line: bsLine, col: bsCol, message: "незакрытая блочная строка (ожидается " + blockStringCloser(bq) + ")" } };
        }
        tokens.push({ type: "block", tag: bt, quote: bq, content: bbuf, sameLine: bsSame, line: bsLine, col: bsCol, endLine: bsCloseLine, endCol: bsCloseCol, off: bsStart, end: i });
        inValue = false;
        continue;
      }

      if (ch === '"' || ch === "'") {
        var q = ch;
        var qs = i;
        var qLine = startLine, qCol = startCol;
        var val = "";
        var closed = false;
        advance(ch);
        while (i < n) {
          var c = src[i];
          if (c === "\n") break;
          if (c === q) {
            // single-quoted: '' is an escaped apostrophe
            if (q === "'" && src[i + 1] === "'") {
              val += "'";
              advance(c); advance(src[i]);
              continue;
            }
            advance(c);
            closed = true;
            break;
          }
          if (c === "\\") {
            var nx = src[i + 1];
            if (nx === undefined) { advance(c); break; }
            if (nx === "\n" || nx === "\r") { advance(c); advance(src[i]); continue; }
            if (q === '"') {
              val += decodeEscape(nx);
              advance(c); advance(src[i]);
            } else {
              // single-quoted: backslash is literal (only \ + newline continues)
              val += c;
              advance(c);
            }
            continue;
          }
          val += c;
          advance(c);
        }
        if (!closed) {
          return { error: { line: qLine, col: qCol, message: q === '"' ? 'незакрытая строка (ожидается ")' : "незакрытая строка (ожидается ')" } };
        }
        tokens.push({ type: "str", value: val, line: qLine, col: qCol, off: qs, end: i });
        continue;
      }

      if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
        tokens.push({ type: "punct", value: ch, line: startLine, col: startCol, off: i, end: i + 1 });
        advance(ch);
        if (ch === "{" || ch === "}" || ch === "]") inValue = false;
        continue;
      }
      if (ch === ";") {
        tokens.push({ type: "nl", line: startLine, col: startCol });
        advance(ch);
        inValue = false;
        continue;
      }

      if (!inValue) {
        var al = arrowLen(i, src);
        if (al) {
          tokens.push({ type: "arrow", value: src.substr(i, al), line: startLine, col: startCol, off: i, end: i + al });
          for (var ai = 0; ai < al; ai++) advance(src[i]);
          continue;
        }
        if (ch === ":") {
          tokens.push({ type: "punct", value: ":", line: startLine, col: startCol, off: i, end: i + 1 });
          advance(ch);
          inValue = true;
          continue;
        }
        if (ch === "." || ch === "<" || ch === ">" || ch === "&") {
          tokens.push({ type: "punct", value: ch, line: startLine, col: startCol, off: i, end: i + 1 });
          advance(ch);
          continue;
        }
      }

      // unquoted word run (key or value, depending on inValue)
      var is = i;
      var buf = "";
      var wordLine = line, wordCol = col;
      while (i < n) {
        var c2 = src[i];
        if (isValueTerm(c2)) break;
        if (!inValue && (c2 === ":" || c2 === "." || c2 === "<" || c2 === ">" || c2 === "&")) break;
        if (!inValue && c2 === "-" && (src[i + 1] === "-" || src[i + 1] === ">" || src[i + 1] === "*")) break;
        if (c2 === "\\") {
          var nx = src[i + 1];
          if (nx === undefined) { advance(c2); break; }
          if (nx === "\n" || nx === "\r") { advance(c2); advance(src[i]); continue; }
          buf += decodeEscape(nx);
          advance(c2); advance(src[i]);
          continue;
        }
        buf += c2;
        advance(c2);
      }
      var lead = 0;
      while (lead < buf.length && (buf[lead] === " " || buf[lead] === "\t")) lead++;
      var tail = buf.length;
      while (tail > lead && (buf[tail - 1] === " " || buf[tail - 1] === "\t")) tail--;
      if (tail > lead) {
        tokens.push({
          type: "ident", value: buf.slice(lead, tail),
          line: wordLine, col: wordCol + lead, off: is + lead, end: is + tail
        });
      }
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
    var nodeById = new Map();
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
    function next() {
      var t = tokens[pos++];
      if (t) {
        // A block string ends at its closing line, not its opener.
        if (t.endLine != null) { lastLine = t.endLine; lastCol = t.endCol; }
        else { lastLine = t.line; lastCol = t.col; }
      }
      return t;
    }
    function peekIs(v) { var t = peek(); return !!t && t.type === "punct" && t.value === v; }
    function isArrow() { var t = peek(); return !!t && t.type === "arrow"; }
    function skipNl() { while (peek() && peek().type === "nl") next(); }
    function commentIsInline() {
      var t = peek();
      return !!t && t.type === "comment" && !t.block && pos > 0 && tokens[pos - 1].type !== "nl";
    }

    // D2 parseComment: consecutive `#` lines (no blank line between them) form
    // one comment, joined with "\n". Block comments (`"""`) are self-contained
    // and never merge with following lines.
    function collectComment() {
      var t = next();
      var text = t.text;
      if (t.block) return text;
      var cLine = t.line;
      while (true) {
        var nt = peek();
        if (!nt) break;
        if (nt.type === "nl") { next(); continue; }
        if (nt.type === "comment" && !nt.block && nt.line === cLine + 1) {
          text += "\n" + nt.text;
          cLine = nt.line;
          next();
          continue;
        }
        break;
      }
      return text;
    }

    // D2 requires every statement to end at a line boundary, `;`, `}` or a
    // comment. Anything else on the same line is an error ("unexpected text
    // after ..." in d2parser) — e.g. `x: "a" b` or `a { b } c`.
    function checkStatementEnd() {
      var t = peek();
      if (!t) return;
      if (t.type === "nl") return;
      if (t.line > lastLine) return;
      if (t.type === "comment") {
        // `#` comments are consumed inline by attachInline*; a block comment
        // on the same line is invalid in D2 ("unexpected text after ...").
        if (t.block) errorAt(t, "неожиданный текст после оператора");
        return;
      }
      if (t.type === "punct" && (t.value === "}" || t.value === "]")) return;
      errorAt(t, "неожиданный текст после оператора");
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
      nodeById.set(localId, n);
      graph.nodes.push(n);
      addToOrder(localId);
      if (parentNode && parentNode.children.indexOf(localId) < 0) parentNode.children.push(localId);
      return n;
    }

    // is `anc` the same node as `node` or one of its parents?
    function isAncestorNode(anc, node) {
      var n = node, guard = 0;
      while (n && guard++ < 1000) {
        if (n === anc) return true;
        n = n.parentId ? nodeById.get(n.parentId) : null;
      }
      return false;
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
        var t = pathTokens[ti];
        var exp = expandSeg(t, full);
        for (var pi = 0; pi < exp.length; pi++) {
          var seg = exp[pi];
          full = full ? full + "." + seg : seg;
          var ex = nodesByPath.get(full);
          if (ex) { cur = ex; continue; }
          var clash = nodeById.get(seg);
          if (clash && isAncestorNode(clash, cur)) {
            // a path inside a scope re-referencing its own ancestor (e.g. the
            // edge "Группа 1".789 written inside "Группа 1") resolves back to
            // the existing node instead of creating a duplicate id
            cur = clash;
            full = clash._path;
            continue;
          }
          if (clash) {
            errorAt(t, "дубликат имени узла '" + seg + "': имена узлов должны быть уникальны");
          }
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

    function blockValue(t) {
      var content = t.content;
      // A first content line on the opener's own line implicitly gets the
      // current nesting indent (d2parser getIndent = depth*2 spaces).
      if (t.sameLine) content = "  ".repeat(curDepth() * 2) + content;
      return trimCommonIndent(trimSpaceAfterLastNewline(content));
    }

    function parseValue() {
      var t = peek();
      if (!t) return null;
      if (t.type === "str") { next(); return t.value; }
      if (t.type === "block") { next(); t.value = blockValue(t); return t; }
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
        if (v != null) {
          if (v.type === "block") {
            target.label = v.value;
            target.labelBlock = { tag: v.tag, quote: v.quote, value: v.value };
          } else {
            target.label = v;
          }
        }
      } else if (v != null && v.type === "block") {
        // Block string value for a non-label attribute: preserve the source
        // form in rawAttrs (content re-emitted with a stable indent).
        var parts = String(v.value || "").split("\n").map(function (l) { return "  " + l; });
        target.rawAttrs.push(key + ": |" + v.quote + v.tag + "\n" + parts.join("\n") + "\n" + blockStringCloser(v.quote));
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
          ed.comments.push(collectComment());
          continue;
        }
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
      var edges = [];
      while (isArrow()) {
        var a = next();
        var targets = [];
        while (true) {
          var p = parsePath();
          if (!p) { errorAt(peek(), "ожидается цель ребра после '->'"); }
          targets.push(p);
          if (peekIs(",")) { next(); continue; }
          break;
        }
        // D2 v0.7.1: `a <- b` means edge b -> a (source on the right).
        // `<->` is bidirectional; we model it as one forward edge.
        var rev = a.value === "<-";
        for (var si = 0; si < sources.length; si++) {
          for (var ti = 0; ti < targets.length; ti++) {
            if (rev) edges.push(createEdge(targets[ti], sources[si]));
            else edges.push(createEdge(sources[si], targets[ti]));
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
          if (v != null) {
            var le = edges[edges.length - 1];
            if (v.type === "block") {
              le.label = v.value;
              le.labelBlock = { tag: v.tag, quote: v.quote, value: v.value };
            } else {
              le.label = v;
            }
          }
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
        if (v == null) { errorAt(peek(), "ожидается значение после ':'"); }
        var cn = declareNode(pathTokens);
        if (v && v.type === "block") {
          cn.label = v.value;
          cn.labelBlock = { tag: v.tag, quote: v.quote, value: v.value };
        } else {
          cn.label = v;
        }
        // `x: a { b }` — value becomes the label, `{ b }` the container
        // (valid in D2 only when `{` is on the same line).
        if (peekIs("{") && peek().line === lastLine) {
          next();
          parseBlock(cn);
          attachInlineNode(cn);
          return;
        }
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
      // D2 has no label shortcut (`key label` without a colon): an unquoted
      // `a b` is a single key, and a quoted `"a" b` is invalid text.
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
          if (c.block) { errorAt(c, "неожиданный текст после оператора"); }
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
          pending[curDepth()].push(collectComment());
        }
        return true;
      }
      if (t.type === "punct") {
        if (t.value === "}") { errorAt(t, "лишняя закрывающая скобка '}'"); }
        if (t.value === "]") { errorAt(t, "лишняя закрывающая скобка ']'"); }
        errorAt(t, "неожиданный символ '" + t.value + "'");
      }
      if (t.type === "arrow") { errorAt(t, "стрелка без исходника"); }
      if (t.type === "ident" && t.value.charCodeAt(0) === 64) {
        errorAt(t, "директивы/переменные (@) не поддерживаются");
      }
      var path = parsePath();
      if (!path) { errorAt(t, "неожиданный токен"); }
      if (isArrow()) {
        parseEdge(path);
      } else {
        parseNodeOrAttr(path);
      }
      checkStatementEnd();
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
