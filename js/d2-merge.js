(function (global) {
  "use strict";

  var MATCH_THRESHOLD = 3;

  function nodePathByIds(byId, id) {
    var path = [];
    var n = byId.get(id);
    var guard = new Set();
    while (n && !guard.has(n.id)) {
      guard.add(n.id);
      path.unshift(n.id);
      n = n.parentId ? byId.get(n.parentId) : null;
    }
    return path.join(".");
  }

  function indexById(graph) {
    var m = new Map();
    for (var i = 0; i < graph.nodes.length; i++) m.set(graph.nodes[i].id, graph.nodes[i]);
    return m;
  }

  function indexByFullPath(graph) {
    var byId = indexById(graph);
    var byPath = new Map();
    for (var i = 0; i < graph.nodes.length; i++) {
      var n = graph.nodes[i];
      byPath.set(nodePathByIds(byId, n.id), n);
    }
    return byPath;
  }

  function parentLabel(graph, byId, node) {
    var p = node.parentId ? byId.get(node.parentId) : null;
    return p ? p.label : null;
  }

  function neighborLabels(graph, byId, nodeId) {
    var labels = new Set();
    for (var i = 0; i < graph.edges.length; i++) {
      var e = graph.edges[i];
      if (e.source === nodeId) {
        var t = byId.get(e.target);
        if (t) labels.add(t.label);
      } else if (e.target === nodeId) {
        var s = byId.get(e.source);
        if (s) labels.add(s.label);
      }
    }
    return labels;
  }

  function overlapCount(a, b) {
    var n = 0;
    a.forEach(function (v) { if (b.has(v)) n++; });
    return n;
  }

  // Score how likely pnode (parsed) is the same logical node as cnode (current).
  // identical marker position +3 (annotated rename), label +2, same parent +1,
  // each shared neighbor label +2 (capped at +4).
  function candidateScore(parsed, current, parsedById, curById, pnode, cnode) {
    var score = 0;
    if (pnode.hasPos && cnode.hasPos &&
      Math.abs(pnode.x - cnode.x) <= 1 && Math.abs(pnode.y - cnode.y) <= 1) {
      score += 3;
    }
    if (pnode.label === cnode.label) score += 2;
    if (parentLabel(parsed, parsedById, pnode) === parentLabel(current, curById, cnode)) score += 1;
    var shared = overlapCount(
      neighborLabels(parsed, parsedById, pnode.id),
      neighborLabels(current, curById, cnode.id)
    );
    score += Math.min(shared, 2) * 2;
    return score;
  }

  function transferNodeFields(pnode, cnode) {
    if (!pnode.hasPos) {
      pnode.x = cnode.x;
      pnode.y = cnode.y;
      pnode.hasPos = !!cnode.hasPos;
    }
    if (typeof cnode.w === "number") pnode.w = cnode.w;
    if (typeof cnode.h === "number") pnode.h = cnode.h;
  }

  function numericId(id) {
    var m = /^e(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * Merge the freshly parsed graph into the current graph so that element
   * positions and selection survive edits to the D2 text.
   *
   * parsed  — result of parseD2(text).graph (mutated in place and returned)
   * current — the persisted v2 graph (positions source), or null for a fresh parse
   * selection — { selectedId, selectedEdgeId } to resolve against the merged graph
   *
   * Returns { graph, added, removed, selectedId, selectedEdgeId }.
   */
  function mergeGraph(parsed, current, selection) {
    selection = selection || {};
    var hasCurrent = !!current && Array.isArray(current.nodes);

    var byPathNew = indexByFullPath(parsed);
    var byIdNew = indexById(parsed);
    var byPathCur = hasCurrent ? indexByFullPath(current) : new Map();
    var byIdCur = hasCurrent ? indexById(current) : new Map();

    var matchedCur = new Set();  // current full paths consumed (exact or heuristic)
    var matchedNew = new Set();  // parsed full paths matched to a current node
    var renameMap = new Map();   // current full path -> parsed full path

    // ---- pass 1: nodes ----
    // 1) exact full-path match (the 90% path)
    byPathNew.forEach(function (pnode, np) {
      if (byPathCur.has(np)) {
        matchedCur.add(np);
        matchedNew.add(np);
        renameMap.set(np, np);
        transferNodeFields(pnode, byPathCur.get(np));
      }
    });

    // 2) heuristics for the rest: candidates are current nodes not yet matched
    if (hasCurrent) {
      var curCandidates = [];
      byPathCur.forEach(function (cnode, cp) { if (!matchedCur.has(cp)) curCandidates.push(cp); });
      var parsedCandidates = [];
      byPathNew.forEach(function (pnode, np) { if (!matchedNew.has(np)) parsedCandidates.push(np); });

      for (var pi = 0; pi < parsedCandidates.length; pi++) {
        var np2 = parsedCandidates[pi];
        if (matchedNew.has(np2)) continue;
        var pnode2 = byPathNew.get(np2);
        var bestPath = null, bestScore = -1;
        for (var ci = 0; ci < curCandidates.length; ci++) {
          var cp2 = curCandidates[ci];
          if (matchedCur.has(cp2)) continue;
          var s = candidateScore(parsed, current, byIdNew, byIdCur, pnode2, byPathCur.get(cp2));
          if (s > bestScore) { bestScore = s; bestPath = cp2; }
        }
        if (bestPath !== null && bestScore >= MATCH_THRESHOLD) {
          matchedCur.add(bestPath);
          matchedNew.add(np2);
          renameMap.set(bestPath, np2);
          transferNodeFields(pnode2, byPathCur.get(bestPath));
          // 3) propagate the rename to descendants: a.b -> x.b
          var prefix = bestPath + ".";
          var suffix = np2 + ".";
          for (var ci2 = 0; ci2 < curCandidates.length; ci2++) {
            var cp3 = curCandidates[ci2];
            if (matchedCur.has(cp3) || cp3.indexOf(prefix) !== 0) continue;
            var newDesc = suffix + cp3.slice(prefix.length);
            if (byPathNew.has(newDesc)) {
              matchedCur.add(cp3);
              matchedNew.add(newDesc);
              renameMap.set(cp3, newDesc);
              transferNodeFields(byPathNew.get(newDesc), byPathCur.get(cp3));
            }
          }
        }
      }
    }

    // ---- pass 2: edges ----
    function translateId(curId) {
      var path = nodePathByIds(byIdCur, curId);
      var np = renameMap.get(path);
      if (!np) return null;
      var pnode = byPathNew.get(np);
      return pnode ? pnode.id : null;
    }

    // current edges -> buckets by (new source, new target, dir). Direction is
    // part of the identity: `a <- b` and `b -> a` are distinct connections.
    var byPair = new Map();
    if (hasCurrent) {
      for (var i = 0; i < current.edges.length; i++) {
        var ce = current.edges[i];
        var ns = translateId(ce.source);
        var nt = translateId(ce.target);
        if (ns === null || nt === null) continue;
        var key = ns + "\u0000" + nt + "\u0000" + (ce.dir || "->");
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key).push(ce);
      }
    }

    // unique id allocation: matched edges keep current ids, unmatched ones keep
    // their parsed id when free, otherwise allocate fresh
    var usedIds = new Set();
    var nextNum = 1;
    if (hasCurrent) {
      for (var i2 = 0; i2 < current.edges.length; i2++) {
        nextNum = Math.max(nextNum, numericId(current.edges[i2].id) + 1);
      }
    }
    function allocEdgeId() {
      var id;
      do { id = "e" + (nextNum++); } while (usedIds.has(id));
      usedIds.add(id);
      return id;
    }

    var usedCur = new Set();
    var edgeIdMap = new Map();
    for (var i4 = 0; i4 < parsed.edges.length; i4++) {
      var pe = parsed.edges[i4];
      var list = byPair.get(pe.source + "\u0000" + pe.target + "\u0000" + (pe.dir || "->"));
      var match = null;
      if (list) {
        for (var li = 0; li < list.length; li++) {
          if (usedCur.has(list[li].id)) continue;
          if (list[li].label === pe.label) { match = list[li]; break; }
        }
        if (!match) {
          for (var li2 = 0; li2 < list.length; li2++) {
            if (usedCur.has(list[li2].id)) continue;
            match = list[li2];
            break;
          }
        }
      }
      if (match) {
        usedCur.add(match.id);
        usedIds.add(match.id);
        edgeIdMap.set(pe.id, match.id);
      } else if (!usedIds.has(pe.id)) {
        usedIds.add(pe.id);
        edgeIdMap.set(pe.id, pe.id);
      } else {
        edgeIdMap.set(pe.id, allocEdgeId());
      }
    }
    for (var i5 = 0; i5 < parsed.edges.length; i5++) {
      parsed.edges[i5].id = edgeIdMap.get(parsed.edges[i5].id);
    }
    parsed.order = parsed.order.map(function (id) {
      return edgeIdMap.has(id) ? edgeIdMap.get(id) : id;
    });

    // ---- results ----
    var added = [];
    byPathNew.forEach(function (pnode, np) { if (!matchedNew.has(np)) added.push(pnode.id); });
    var removed = [];
    if (hasCurrent) {
      byPathCur.forEach(function (cnode, cp) { if (!matchedCur.has(cp)) removed.push(cp); });
    }

    var maxSuffix = 0;
    for (var i6 = 0; i6 < parsed.edges.length; i6++) {
      maxSuffix = Math.max(maxSuffix, numericId(parsed.edges[i6].id));
    }
    parsed.idCounter = maxSuffix + 1;
    if (hasCurrent) {
      parsed.viewport = current.viewport || parsed.viewport;
      parsed.showComments = current.showComments != null ? current.showComments : parsed.showComments;
    }

    var selectedId = selection.selectedId != null && byIdNew.has(selection.selectedId)
      ? selection.selectedId : null;
    var finalEdgeIds = new Set(parsed.edges.map(function (e) { return e.id; }));
    var selectedEdgeId = selection.selectedEdgeId != null && finalEdgeIds.has(selection.selectedEdgeId)
      ? selection.selectedEdgeId : null;

    return {
      graph: parsed,
      added: added,
      removed: removed,
      selectedId: selectedId,
      selectedEdgeId: selectedEdgeId
    };
  }

  var api = {
    MATCH_THRESHOLD: MATCH_THRESHOLD,
    nodePathByIds: nodePathByIds,
    indexById: indexById,
    indexByFullPath: indexByFullPath,
    candidateScore: candidateScore,
    mergeGraph: mergeGraph
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2merge = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
