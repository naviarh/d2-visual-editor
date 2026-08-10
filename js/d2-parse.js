(function (global) {
  "use strict";

  var POS_RE = /#\s*(?:---\s*)?@d2pos\s*(-?\d+),\s*(-?\d+)\s*$/;
  var POS_INNER_RE = /\s*#?\s*(?:---\s*)?@d2pos\s*(-?\d+),\s*(-?\d+)\s*$/;

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
  // markers -- -> <- <-> -* *- (a single `-` is literal: `a-b` is one key).
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

  // Decode D2 escapes across a whole string the way the scanner does for
  // double-quoted values: known escapes decode, `\`+newline is a line
  // continuation (both dropped), unknown escapes drop the backslash. Used by
  // the UI dialogs so that `\n` typed by the user means a real newline.
  function decodeEscapes(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c !== "\\") {
        out += c;
        continue;
      }
      var nx = s[i + 1];
      if (nx === undefined) { out += c; break; }
      if (nx === "\n" || nx === "\r") {
        if (nx === "\r" && s[i + 2] === "\n") i++;
        i++;
        continue;
      }
      out += decodeEscape(nx);
      i++;
    }
    return out;
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

  // Decide whether a `(` at the start of a statement opens an edge reference
  // `(a -> b)`. d2 starts an "edge group" for any leading `(` but falls back to
  // a plain key when the group contains no edge — `(a, b) -> c` is an edge from
  // the node `(a, b)`, not a reference. A reference needs an arrow inside the
  // parens, or (no arrow inside) anything after `)` that is not an arrow — a
  // lone `(a)` reference is a deliberate parse error (plan §3.5).
  function looksLikeRef(src, n, i) {
    var j = i + 1;
    var contentEnd = j;
    while (j < n && src[j] !== "\n" && src[j] !== "\r" && src[j] !== ")") {
      contentEnd = ++j;
    }
    if (j >= n || src[j] !== ")") return false;
    var content = src.slice(i + 1, contentEnd);
    if (content.indexOf("->") >= 0 || content.indexOf("<-") >= 0 ||
      content.indexOf("--") >= 0 || content.indexOf("-*") >= 0 || content.indexOf("*-") >= 0) {
      return true;
    }
    var k = j + 1;
    while (k < n && (src[k] === " " || src[k] === "\t")) k++;
    if (k >= n || src[k] === "\n" || src[k] === "\r" || src[k] === "#") return true;
    var c0 = src[k];
    if (c0 === "<" && src[k + 1] === "-") return false;
    if (c0 === "-" && (src[k + 1] === "-" || src[k + 1] === ">" || src[k + 1] === "*")) return false;
    if (c0 === "*" && src[k + 1] === "-") return false;
    return true;
  }

  // Context-aware string lexer. `inValue` is true while scanning a value
  // (after `:`), which widens the word terminator set to D2 value rules.
  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;
    var line = 1, col = 1;
    var inValue = false;
    // `(` only starts an edge reference at the beginning of a statement.
    var stmtStart = true;
    // Inside `( … )` `)` terminates a word and closes the reference.
    var refMode = false;
    // Right after `)` an immediately following `[ … ]` is a reference index.
    var refIndexPending = false;
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
        stmtStart = true;
        refMode = false;
        refIndexPending = false;
        continue;
      }
      if (ch === " " || ch === "\t") { advance(ch); continue; }

      // Edge reference opener: `(a -> b)` at statement start. Elsewhere `(`
      // stays a literal character (`x: (a)` is a label, `a (b)` a key).
      if (!inValue && stmtStart && ch === "(" && looksLikeRef(src, n, i)) {
        tokens.push({ type: "punct", value: "(", line: startLine, col: startCol, off: i, end: i + 1 });
        advance(ch);
        stmtStart = false;
        refMode = true;
        continue;
      }

      // `)` closes the reference (word terminator, handled above in the word
      // run); afterwards a `[ … ]` on the same line is the reference index.
      if (refMode && ch === ")") {
        tokens.push({ type: "punct", value: ")", line: startLine, col: startCol, off: i, end: i + 1 });
        advance(ch);
        refMode = false;
        refIndexPending = true;
        continue;
      }
      if (!inValue && refIndexPending && ch === "[") {
        var closeB = src.indexOf("]", i + 1);
        var nlB = closeB >= 0 ? src.slice(i + 1, closeB).indexOf("\n") : -1;
        if (closeB >= 0 && nlB < 0) {
          tokens.push({
            type: "refIndex", value: src.slice(i + 1, closeB),
            line: startLine, col: startCol, off: i, end: closeB + 1
          });
          while (i <= closeB) advance(src[i]);
          refIndexPending = false;
          continue;
        }
        refIndexPending = false;
      }

      // Any real token ends statement-start; `{`/`}`/`;` restore it below.
      stmtStart = false;

      // Stage D: import spread (`...@`) is recognized but unsupported. d2 only
      // allows it at the start of an unquoted string (statement or value); a
      // `...@` mid-word is plain text (`x: a...@b`).
      if (ch === "." && src[i + 1] === "." && src[i + 2] === "." && src[i + 3] === "@") {
        return { error: { line: startLine, col: startCol, message: "import spread (...) не поддерживается" } };
      }

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
          // Stage D: raw $ in double quotes starts a substitution in d2
          // (single quotes keep it literal) — unsupported here.
          if (c === "$" && q === '"') {
            return { error: { line: qLine, col: qCol + (i - qs), message: "подстановки ($) не поддерживаются" } };
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
        if (ch === "{" || ch === "}") stmtStart = true;
        continue;
      }
      if (ch === ";") {
        tokens.push({ type: "nl", line: startLine, col: startCol });
        advance(ch);
        inValue = false;
        stmtStart = true;
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
        if (!inValue && c2 === "*" && src[i + 1] === "-") break;
        if (refMode && c2 === ")") break;
        if (c2 === "\\") {
          var nx = src[i + 1];
          if (nx === undefined) { advance(c2); break; }
          if (nx === "\n" || nx === "\r") { advance(c2); advance(src[i]); continue; }
          buf += decodeEscape(nx);
          advance(c2); advance(src[i]);
          continue;
        }
        // Stage D: $ substitutions and * globs are recognized but unsupported.
        // Raw chars only — `\$` (escaped) and single-quoted strings stay
        // literal, and `*` is plain text inside values.
        if (c2 === "$" && (inValue || buf.length === 0 || src[i + 1] === "{")) {
          return {
            error: {
              line: wordLine, col: wordCol + (i - is),
              message: (inValue || src[i + 1] === "{")
                ? "подстановки ($) не поддерживаются"
                : "переменные ($) не поддерживаются"
            }
          };
        }
        if (!inValue && c2 === "*") {
          return { error: { line: wordLine, col: wordCol + (i - is), message: "globs (*) не поддерживаются" } };
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

  function parseD2(src, opts) {
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
    var orderSet = new Set();
    var scopeStack = [null];
    var pending = [[]];
    // Deferred `[*]` edge references: applied to every matching edge at the
    // end of the parse (including edges declared after the reference).
    var pendingGlobs = [];
    var sawTopLevel = false;
    // For every node whose body is a `{ … }` block: id -> inline (block opened
    // and closed on the same line). Transient: only returned on request, never
    // written into the graph nodes.
    var blockForms = new Map();

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
    // and never merge with following lines; they are stored as
    // `{ text, block:true }` so the serializer can restore the `"""` form.
    function collectComment() {
      var t = next();
      var text = t.text;
      if (t.block) return { text: t.text, block: true };
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
      if (text && typeof text === "object") return null;
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
        return { type: "array", value: src.slice(startOff, endOff) };
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

    function pushRawAttr(target, key, v) {
      if (v == null) {
        target.rawAttrs.push(key + ":");
        return;
      }
      if (v.type === "block") {
        // Block string value for a non-label attribute: preserve the source
        // form in rawAttrs (content re-emitted with a stable indent).
        var parts = String(v.value || "").split("\n").map(function (l) { return "  " + l; });
        target.rawAttrs.push(key + ": |" + v.quote + v.tag + "\n" + parts.join("\n") + "\n" + blockStringCloser(v.quote));
        return;
      }
      target.rawAttrs.push(key + ": " + (v.value != null ? v.value : v));
    }

    // Applies one attribute (`pathTokens` = key path, possibly dotted) to a
    // node or edge. Dotted paths follow D2 semantics (§docs/plans/
    // d2-edge-references.md): on a node only `style.*` is an attribute, on an
    // edge only `style`/`source-arrowhead`/`target-arrowhead` sub-fields and
    // single reserved keys are accepted.
    function parseAttrBody(target, pathTokens) {
      var key = pathTokens[pathTokens.length - 1].value;
      var fullKey = pathTokens.map(function (t) { return t.value; }).join(".");
      var dotted = pathTokens.length > 1;
      var first = pathTokens[0].value;
      var isNode = Array.isArray(target.children);
      if (dotted && isNode && first !== "style" && RESERVED[first]) {
        errorAt(pathTokens[0], "поле " + first + " не может иметь под-поля");
      }
      if (dotted && !isNode && first !== "style" && first !== "source-arrowhead" && first !== "target-arrowhead") {
        errorAt(pathTokens[0], "ключ недопустим для соединения: " + fullKey);
      }
      if (!dotted && !isNode && !RESERVED[key]) {
        errorAt(pathTokens[0], "ключ недопустим для соединения: " + fullKey);
      }
      var attrKey = key;
      if (dotted && ((isNode && first === "style") ||
        (!isNode && (first === "style" || first === "source-arrowhead" || first === "target-arrowhead")))) {
        attrKey = fullKey;
      }
      if (peekIs("{")) {
        var blockLines = captureRawBlock();
        target.rawAttrs = target.rawAttrs.concat(attrKey + ": {" + blockLines.map(function (l) { return "\n" + l; }).join("") + "\n}");
        return;
      }
      var v = parseValue();
      var isLabel = !dotted && key === "label";
      // `shape` applies to nodes only (edges have no `children`); array and
      // block-string values stay in rawAttrs losslessly (d2 ignores edge shape
      // and rejects composite shape values at render time).
      var isShape = !dotted && key === "shape" && isNode;
      if (isLabel) {
        if (v != null) {
          if (v.type === "block") {
            target.label = v.value;
            target.labelBlock = { tag: v.tag, quote: v.quote, value: v.value };
          } else if (v.type === "array") {
            // `label: [a]` is an attribute array in D2 — the label stays empty.
            target.valueArray = v.value;
          } else {
            target.label = v;
          }
        }
      } else if (isShape && v != null && v.type !== "block" && v.type !== "array") {
        // Keep the raw value (case and unknown names preserved); the renderer
        // treats absent/unknown shapes as `rectangle` (fallback).
        target.shape = String(v.value != null ? v.value : v);
      } else {
        pushRawAttr(target, attrKey, v);
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
        parseAttrBody(ed, p);
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

    function createEdge(srcPath, tgtPath, dir) {
      var src = resolvePath(srcPath);
      var tgt = resolvePath(tgtPath);
      // Every connection record in the text is a distinct edge (d2: "repeated
      // connections declare new ones"). The text-order source/target and the
      // arrow form (`->`, `<-`, `<->`, `--`) are preserved as written.
      var ed = {
        id: "e" + (graph.idCounter++), source: src.id, target: tgt.id, label: null,
        comments: [], trailingComment: null, rawAttrs: []
      };
      if (dir !== "->") ed.dir = dir;
      graph.edges.push(ed);
      addToOrder(ed.id);
      return ed;
    }

    function pathName(pathTokens) {
      return pathTokens.map(function (t) { return t.value; }).join(".");
    }

    // Snapshot and clear the pending comments for the current scope (used when
    // a `[*]` reference defers its targets to the end of the parse).
    function takePending() {
      var d = curDepth();
      if (d === 0 && !sawTopLevel) {
        graph.headerComments = graph.headerComments.concat(pending[0]);
        pending[0] = [];
        sawTopLevel = true;
        return [];
      }
      var lines = pending[d];
      pending[d] = [];
      return lines;
    }

    // D2 dotted-key rule for edge references (§3.10): full path verbatim when
    // the first segment is `style`/`source-arrowhead`/`target-arrowhead`, a
    // single reserved key as-is, anything else is an error.
    function validateRefField(fieldSegs, errTok) {
      var key = fieldSegs.join(".");
      var first = fieldSegs[0];
      if (first === "style" || first === "source-arrowhead" || first === "target-arrowhead") return;
      if (fieldSegs.length === 1 && RESERVED[key]) return;
      errorAt(errTok, "ключ недопустим для соединения: " + key);
    }

    // Apply a folded reference attribute to one edge: `label` becomes the edge
    // label field, anything else goes to rawAttrs with its full path.
    function foldRefAttrs(edge, fieldSegs, value, comment) {
      var key = fieldSegs.join(".");
      if (fieldSegs.length === 1 && fieldSegs[0] === "label") {
        if (value.type === "block") {
          edge.label = value.value;
          edge.labelBlock = { tag: value.tag, quote: value.quote, value: value.value };
        } else if (value.type === "array") {
          edge.valueArray = value.value;
        } else {
          edge.label = value;
        }
      } else {
        pushRawAttr(edge, key, value);
      }
      if (comment != null) {
        if (edge.trailingComment == null) edge.trailingComment = comment;
        else edge.comments.push(comment);
      }
    }

    // Resolve one `(src dir tgt)` pair of a reference. `index` is null (no
    // index → create a new edge like a declaration), a number (N-th match),
    // or "*" (defer to all matches at the end of the parse).
    function resolveEdgeRef(pr, index, indexTok) {
      var src = resolvePath(pr.srcPath);
      var tgt = resolvePath(pr.tgtPath);
      var dirKey = pr.dir === "->" ? undefined : pr.dir;
      var matches = [];
      for (var i = 0; i < graph.edges.length; i++) {
        var e = graph.edges[i];
        if (e.source === src.id && e.target === tgt.id && (e.dir || undefined) === dirKey) matches.push(e);
      }
      if (typeof index === "number") {
        if (index < matches.length) return { kind: "edge", edge: matches[index] };
        var arrowName = pathName(pr.srcPath) + " " + pr.dir + " " + pathName(pr.tgtPath);
        var hint = matches.length === 0
          ? "выше по тексту нет записей '" + arrowName + "' — объявите соединение до строки ссылки"
          : "выше по тексту найдено " + matches.length + " (нумерация с 0: [0] — первая, последняя — [" + (matches.length - 1) + "])";
        return {
          kind: "miss",
          message: "индекс соединения (" + arrowName + ")[" + index + "] вне диапазона: " + hint
        };
      }
      if (index === "*") {
        return { kind: "glob", src: src.id, tgt: tgt.id, dirKey: dirKey };
      }
      var ed = createEdge(pr.srcPath, pr.tgtPath, pr.dir);
      return { kind: "edge", edge: ed };
    }

    // Value of a reference assignment plus its inline `#` comment.
    function parseRefValue() {
      var v = parseValue();
      if (v == null) errorAt(peek(), "ожидается значение после ':'");
      var cm = null;
      if (commentIsInline()) {
        var c = next();
        cm = c.text;
      }
      return { value: v, comment: cm };
    }

    // `(a -> b)[N].field: v` — fold into existing/new edge(s). A bare
    // reference without an index creates a connection; with an index it is a
    // silent no-op (d2 parity).
    function parseRef() {
      var startTok = next();
      var refLine = startTok.line, refCol = startTok.col;
      var indexTok = startTok;
      var pairs = [];
      var srcPath = parsePath();
      if (!srcPath) errorAt(peek(), "ожидается соединение в ссылке '(...)'");
      while (true) {
        if (!isArrow()) break;
        var a = next();
        var dir = a.value;
        if (dir === "-*" || dir === "*-") dir = "->";
        var tgtPath = parsePath();
        if (!tgtPath) errorAt(peek(), "ожидается цель соединения в ссылке");
        pairs.push({ srcPath: srcPath, dir: dir, tgtPath: tgtPath });
        // A chain reuses the previous target as the next source: `(a -> b -> c)`
        // yields pairs (a→b) and (b→c), each resolved independently (d2 parity).
        srcPath = tgtPath;
      }
      if (pairs.length === 0) errorAt(peek(), "ожидается соединение в ссылке '(...)'");
      if (!peekIs(")")) errorAt(peek(), "ожидается ')' в ссылке");
      next();
      var refEndLine = lastLine;

      var hasIndex = false;
      var index = null;
      var it = peek();
      if (it && it.type === "refIndex") {
        next();
        refEndLine = lastLine;
        indexTok = it;
        hasIndex = true;
        var raw = it.value.trim();
        if (raw === "*") index = "*";
        else if (/^\d+$/.test(raw)) index = parseInt(raw, 10);
        else errorAt(it, "неожиданный символ в индексе соединения (ожидаются цифры или *)");
      }

      // The continuation (`.field` or `: value`) must be on the same line.
      var fieldSegs = null;
      var fieldErrTok = null;
      var value = null;
      var refComment = null;
      var nt = peek();
      if (nt && nt.type === "punct" && nt.line === refEndLine && (nt.value === "." || nt.value === ":")) {
        if (nt.value === ".") {
          next();
          var fseg = parsePath();
          if (!fseg) errorAt(peek(), "ожидается поле после '.' в ссылке");
          fieldErrTok = fseg[0];
          fieldSegs = [];
          for (var fi = 0; fi < fseg.length; fi++) fieldSegs.push(fseg[fi].value);
          if (!peekIs(":")) errorAt(peek(), "ожидается ':' в ссылке");
          next();
        } else {
          next();
          fieldSegs = ["label"];
        }
        var pv = parseRefValue();
        value = pv.value;
        refComment = pv.comment;
      }

      if (fieldSegs != null) {
        validateRefField(fieldSegs, fieldErrTok || startTok);
        var firstTarget = null;
        for (var pi = 0; pi < pairs.length; pi++) {
          var pr = pairs[pi];
          var res = resolveEdgeRef(pr, index, indexTok);
          if (res.kind === "miss") {
            errorAt(indexTok, res.message);
          } else if (res.kind === "glob") {
            pendingGlobs.push({
              src: res.src, tgt: res.tgt, dirKey: res.dirKey,
              fieldSegs: fieldSegs, value: value, comment: refComment,
              comments: takePending()
            });
          } else {
            foldRefAttrs(res.edge, fieldSegs, value, refComment);
            if (firstTarget == null) firstTarget = res.edge;
          }
        }
        if (firstTarget != null) consumePending(firstTarget);
        return;
      }

      // Bare reference: no index → declare the connection(s). A numeric index
      // applies nothing but still validates the range (d2: "indexed edge does
      // not exist" fires even without an assignment); `[*]` is a silent no-op.
      if (hasIndex) {
        if (commentIsInline()) {
          pending[curDepth()].push(next().text);
        }
        if (typeof index === "number") {
          for (var ri = 0; ri < pairs.length; ri++) {
            var rp = pairs[ri];
            var rres = resolveEdgeRef(rp, index, indexTok);
            if (rres.kind === "miss") errorAt(indexTok, rres.message);
          }
        }
        return;
      }
      var bareEdges = [];
      for (var bi = 0; bi < pairs.length; bi++) {
        var bpr = pairs[bi];
        bareEdges.push(createEdge(bpr.srcPath, bpr.tgtPath, bpr.dir));
      }
      if (bareEdges.length) consumePending(bareEdges[0]);
      attachInlineEdge(bareEdges);
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
        // Text order is preserved: `a <- b` keeps source=a, target=b and stores
        // dir="<-" (the arrowhead renders at the source end). Semantic flow for
        // layout/sort is derived from `dir` by consumers. `-*`/`*-` are plain
        // forward edges (d2 edge marker shapes, not directionality).
        var dir = a.value;
        if (dir === "-*" || dir === "*-") dir = "->";
        for (var si = 0; si < sources.length; si++) {
          for (var ti = 0; ti < targets.length; ti++) {
            edges.push(createEdge(sources[si], targets[ti], dir));
          }
        }
        sources = targets;
      }
      if (edges.length) consumePending(edges[0]);
      var t = peek();
      if (t && t.type === "punct" && t.value === ":") {
        next();
        if (peekIs("{")) {
          // Parse the block once into a buffer, copy onto every edge of the
          // chain (d2 applies `a -> b -> c: {…}` to each link). Comments
          // inside the block go only to the last edge.
          var buf = { label: null, trailingComment: null, rawAttrs: [], labelBlock: null, valueArray: null, comments: [] };
          parseEdgeAttrBlock(buf);
          for (var bi = 0; bi < edges.length; bi++) {
            var be = edges[bi];
            be.label = buf.label;
            if (buf.labelBlock != null) be.labelBlock = buf.labelBlock;
            if (buf.valueArray != null) be.valueArray = buf.valueArray;
            be.rawAttrs = be.rawAttrs.concat(buf.rawAttrs);
            if (buf.trailingComment != null && be.trailingComment == null) be.trailingComment = buf.trailingComment;
          }
          if (buf.comments.length) {
            edges[edges.length - 1].comments = edges[edges.length - 1].comments.concat(buf.comments);
          }
        } else {
          var v = parseValue();
          if (v != null) {
            for (var ei = 0; ei < edges.length; ei++) {
              var le = edges[ei];
              if (v.type === "block") {
                le.label = v.value;
                le.labelBlock = { tag: v.tag, quote: v.quote, value: v.value };
              } else if (v.type === "array") {
                le.valueArray = v.value;
              } else {
                le.label = v;
              }
            }
          }
        }
      } else if (t && t.type === "punct" && t.value === "{") {
        var buf2 = { label: null, trailingComment: null, rawAttrs: [], labelBlock: null, valueArray: null, comments: [] };
        parseEdgeAttrBlock(buf2);
        for (var bj = 0; bj < edges.length; bj++) {
          var be2 = edges[bj];
          be2.label = buf2.label;
          if (buf2.labelBlock != null) be2.labelBlock = buf2.labelBlock;
          if (buf2.valueArray != null) be2.valueArray = buf2.valueArray;
          be2.rawAttrs = be2.rawAttrs.concat(buf2.rawAttrs);
          if (buf2.trailingComment != null && be2.trailingComment == null) be2.trailingComment = buf2.trailingComment;
        }
        if (buf2.comments.length) {
          edges[edges.length - 1].comments = edges[edges.length - 1].comments.concat(buf2.comments);
        }
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
        var first = pathTokens[0].value;
        // Dotted path starting with a reserved key: `style.*` is an attribute
        // of the enclosing container (rawAttrs with the full path); other
        // reserved keys cannot have sub-fields (d2 "unexpected field"). At the
        // top level `style.fill: yellow` still declares nested nodes.
        if (pathTokens.length > 1 && RESERVED[first]) {
          if (scopeNode && first === "style") {
            parseAttrBody(scopeNode, pathTokens);
            return;
          }
          if (!scopeNode && first === "style") {
            // fall through — nested containers, d2 parity
          } else {
            errorAt(pathTokens[0], "поле " + first + " не может иметь под-поля");
          }
        }
        if (scopeNode && single && RESERVED[key]) {
          parseAttrBody(scopeNode, pathTokens);
          return;
        }
        if (peekIs("{")) {
          var openTok = next();
          var node = declareNode(pathTokens);
          parseBlock(node, openTok.line);
          attachInlineNode(node);
          return;
        }
        var v = parseValue();
        if (v == null) { errorAt(peek(), "ожидается значение после ':'"); }
        var cn = declareNode(pathTokens);
        if (v && v.type === "block") {
          cn.label = v.value;
          cn.labelBlock = { tag: v.tag, quote: v.quote, value: v.value };
        } else if (v && v.type === "array") {
          // An array value is an attribute array in D2, never a label.
          cn.valueArray = v.value;
        } else {
          cn.label = v;
        }
        // `x: a { b }` — value becomes the label, `{ b }` the container
        // (valid in D2 only when `{` is on the same line).
        if (peekIs("{") && peek().line === lastLine) {
          if (v && v.type === "array") { errorAt(peek(), "массив не может иметь тело '{}'"); }
          var openTok2 = next();
          parseBlock(cn, openTok2.line);
          attachInlineNode(cn);
          return;
        }
        attachInlineNode(cn);
        return;
      }
      if (t && t.type === "punct" && t.value === "{") {
        var openTok3 = next();
        var bnode = declareNode(pathTokens);
        parseBlock(bnode, openTok3.line);
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
        if (t.value === "(") {
          parseRef();
          checkStatementEnd();
          return true;
        }
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

    function parseBlock(container, openLine) {
      scopeStack.push(container);
      pending.push([]);
      while (true) {
        skipNl();
        var t = peek();
        if (!t) { errorAt(null, "незакрытый блок: ожидается '}' (в '" + container.id + "')"); }
        if (t.type === "punct" && t.value === "}") {
          blockForms.set(container.id, openLine === t.line);
          next();
          break;
        }
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
      // Deferred `[*]` references apply to every matching edge (including ones
      // declared after the reference); no matches at all is a silent no-op.
      for (var gi = 0; gi < pendingGlobs.length; gi++) {
        var pg = pendingGlobs[gi];
        var any = false;
        for (var ei = 0; ei < graph.edges.length; ei++) {
          var e = graph.edges[ei];
          if (e.source === pg.src && e.target === pg.tgt && (e.dir || undefined) === pg.dirKey) {
            foldRefAttrs(e, pg.fieldSegs, pg.value, pg.comment);
            if (pg.comments.length) e.comments = pg.comments.concat(e.comments);
            any = true;
          }
        }
        if (!any && pg.comments.length) {
          graph.trailingComments = pg.comments.concat(graph.trailingComments);
        }
      }
      graph.trailingComments = graph.trailingComments.concat(pending[0]);
      return graph;
    }

    try {
      parse();
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, error: { line: e.line, col: e.col, message: e.message } };
      throw e;
    }
    if (opts && opts.inline) return { ok: true, graph: graph, blockForms: blockForms };
    return { ok: true, graph: graph };
  }

  /**
   * `inlineIds(text)` parses the text and returns a Map of node id -> boolean,
   * true when the node's `{ … }` body was written on a single line. Used by the
   * serializer (via refText) to keep the user's one-line/three-line form for
   * single-attribute blocks. The map is transient — nothing is written into the
   * returned graph.
   */
  function inlineIds(text) {
    var r = parseD2(text, { inline: true });
    if (!r.ok) return null;
    return r.blockForms || new Map();
  }

  var api = {
    POS_RE: POS_RE,
    POS_INNER_RE: POS_INNER_RE,
    RESERVED: RESERVED,
    tokenize: tokenize,
    parseD2: parseD2,
    inlineIds: inlineIds,
    decodeEscapes: decodeEscapes
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2parse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
