(function (global) {
  "use strict";

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

  // Returns a new graph (shallow copies of nodes, reordered children + order)
  // whose node order is a DFS pre-order following arrows, per scope.
  // Incoming edges are counted within the current scope only (direct children
  // of a container / top-level roots), never globally. Cycles are broken by a
  // visited set (order is "roughly topological"). Deterministic in edge order.
  function sortByArrows(graph) {
    graph = graph || { nodes: [], edges: [] };
    var byId = indexNodes(graph);
    var byEdge = indexEdges(graph);

    var outBy = {};
    for (var i = 0; i < graph.edges.length; i++) {
      var e = graph.edges[i];
      if (!outBy[e.source]) outBy[e.source] = [];
      outBy[e.source].push(e);
    }

    var currentOrder = [];
    var inCurrent = new Set();
    if (Array.isArray(graph.order)) {
      for (var o = 0; o < graph.order.length; o++) {
        if (byId.get(graph.order[o])) { currentOrder.push(graph.order[o]); inCurrent.add(graph.order[o]); }
      }
    }
    var fallback = treeOrder(graph);
    for (var f = 0; f < fallback.length; f++) {
      if (!inCurrent.has(fallback[f])) { currentOrder.push(fallback[f]); inCurrent.add(fallback[f]); }
    }

    var nodes = graph.nodes.map(function (n) {
      return Object.assign({}, n, { children: (n.children || []).slice() });
    });
    var newById = new Map();
    for (var m = 0; m < nodes.length; m++) newById.set(nodes[m].id, nodes[m]);

    var sorted = [];
    var visited = new Set();
    var doneScopes = new Set();

    function isTopLevel(n) {
      return !n.parentId || !newById.has(n.parentId);
    }

    function membersOf(parentId) {
      var members = [];
      for (var c = 0; c < currentOrder.length; c++) {
        var n = newById.get(currentOrder[c]);
        if (!n) continue;
        if (parentId === null ? isTopLevel(n) : n.parentId === parentId) members.push(n.id);
      }
      var extra;
      if (parentId !== null) {
        var p = newById.get(parentId);
        extra = p ? p.children : [];
      } else {
        extra = nodes.filter(function (n) { return isTopLevel(n); }).map(function (n) { return n.id; });
      }
      for (var x = 0; x < extra.length; x++) {
        if (members.indexOf(extra[x]) < 0) members.push(extra[x]);
      }
      return members;
    }

    function ancestorWithinScope(id, scopeParent, memberSet) {
      var n = newById.get(id);
      while (n && n.parentId) {
        if (n.parentId === scopeParent) return n.id;
        if (memberSet.has(n.parentId)) return n.parentId;
        n = newById.get(n.parentId);
      }
      return null;
    }

    function sortScope(parentId) {
      if (doneScopes.has(String(parentId))) return;
      var members = membersOf(parentId);
      var memberSet = new Set(members);
      var inScope = new Map();
      for (var a = 0; a < members.length; a++) {
        var outs = outBy[members[a]] || [];
        for (var b = 0; b < outs.length; b++) {
          var e = outs[b];
          if (e.source !== e.target && memberSet.has(e.target)) {
            inScope.set(e.target, (inScope.get(e.target) || 0) + 1);
          }
        }
      }
      var deferred = [];
      function visit(m) {
        if (visited.has(m)) return;
        visited.add(m);
        sorted.push(m);
        var n = newById.get(m);
        if (n && n.children && n.children.length) sortScope(m);
        var outs = outBy[m] || [];
        for (var v = 0; v < outs.length; v++) {
          var e = outs[v];
          if (e.source === e.target) continue;
          var t = newById.get(e.target);
          if (!t) continue;
          if (memberSet.has(t.id)) {
            visit(t.id);
          } else {
            var anc = ancestorWithinScope(t.id, parentId, memberSet);
            if (anc && !visited.has(anc)) deferred.push(anc);
          }
        }
      }
      for (var c = 0; c < members.length; c++) {
        if (!inScope.get(members[c]) && !visited.has(members[c])) visit(members[c]);
      }
      for (var d = 0; d < deferred.length; d++) {
        if (!visited.has(deferred[d])) visit(deferred[d]);
      }
      for (var r = 0; r < members.length; r++) {
        if (!visited.has(members[r])) visit(members[r]);
      }
      if (parentId !== null) {
        var p = newById.get(parentId);
        if (p) {
          var kids = [];
          for (var sf = 0; sf < sorted.length; sf++) {
            if (memberSet.has(sorted[sf])) kids.push(sorted[sf]);
          }
          p.children = kids;
        }
      }
      doneScopes.add(String(parentId));
    }

    sortScope(null);

    for (var s = 0; s < sorted.length; s++) {
      if (visited.has(sorted[s]) && !inCurrent.has(sorted[s])) inCurrent.add(sorted[s]);
    }

    var edgeOrder = [];
    var seenEdge = new Set();
    if (Array.isArray(graph.order)) {
      for (var eo = 0; eo < graph.order.length; eo++) {
        var id = graph.order[eo];
        if (byEdge.get(id) && !seenEdge.has(id)) { edgeOrder.push(id); seenEdge.add(id); }
      }
    }
    for (var ea = 0; ea < graph.edges.length; ea++) {
      if (!seenEdge.has(graph.edges[ea].id)) { edgeOrder.push(graph.edges[ea].id); seenEdge.add(graph.edges[ea].id); }
    }

    return {
      v: graph.v,
      nodes: nodes,
      edges: graph.edges,
      order: sorted.concat(edgeOrder),
      headerComments: graph.headerComments || [],
      trailingComments: graph.trailingComments || [],
      idCounter: graph.idCounter,
      viewport: graph.viewport,
      showComments: graph.showComments
    };
  }

  var api = {
    sortByArrows: sortByArrows,
    treeOrder: treeOrder
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2sort = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
