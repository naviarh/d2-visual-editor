// Undo/redo: store only the delta between pre- and post-state (a patch), never
// full diagrams. A patch is self-contained: undo/redo do not need the current
// state. diffStates/applyStatePatch work on v2 graph payloads; applyStatePatch
// also accepts the live index.html structure (nodes as a Map, edges as an array)
// and mutates it in place.
(function (global) {
  'use strict';

  function createHistory(limit) {
    var lim = (typeof limit === 'number' && isFinite(limit)) ? Math.max(1, Math.floor(limit)) : 100;
    return { limit: lim, stack: [], redo: [] };
  }

  function pushState(hist, patch) {
    if (!patch) return;
    hist.stack.push(patch);
    hist.redo.length = 0;
    while (hist.stack.length > hist.limit) hist.stack.shift();
  }

  function undo(hist) {
    if (!hist.stack.length) return null;
    var patch = hist.stack.pop();
    hist.redo.push(patch);
    return patch;
  }

  function redo(hist) {
    if (!hist.redo.length) return null;
    var patch = hist.redo.pop();
    hist.stack.push(patch);
    return patch;
  }

  function canUndo(hist) {
    return !!(hist && hist.stack.length);
  }

  function canRedo(hist) {
    return !!(hist && hist.redo.length);
  }

  function clearHistory(hist) {
    hist.stack.length = 0;
    hist.redo.length = 0;
  }

  function cloneValue(v) {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
  }

  // Canonical JSON with recursively sorted object keys: the order of keys in a
  // node built by the visual editor (addBlock) and by the parser (after a text
  // merge) differs, and a naive stringify would report identical values as
  // changed — turning every text edit into a patch containing all nodes.
  function canonicalSorted(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(canonicalSorted(v[i]));
      return arr;
    }
    var keys = Object.keys(v).sort();
    var out = {};
    for (var j = 0; j < keys.length; j++) out[keys[j]] = canonicalSorted(v[keys[j]]);
    return out;
  }

  function canonStr(v) {
    return JSON.stringify(canonicalSorted(v));
  }

  function stateEqual(a, b) {
    return canonStr(a) === canonStr(b);
  }

  function arrEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function unionKeys(a, b) {
    var out = [];
    var seen = {};
    a.forEach(function (v, k) {
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    });
    b.forEach(function (v, k) {
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
  }

  // diffStates(prevState, nextState) -> patch | null.
  // Patch shape: { nodes: {id: {before, after}}, edges: {id: {before, after}},
  // order: {before, after} | null, viewport: {before, after} | null,
  // showComments: {before, after} | null }. before: null — element added by the
  // action, after: null — element deleted. idCounter is deliberately excluded
  // from comparison: after a text merge it is deterministically recomputed
  // (maxSuffix + 1) and does not reflect user intent.
  function diffStates(prev, next) {
    var patch = {};
    var any = false;

    var pn = new Map();
    var nn = new Map();
    for (var i = 0; i < (prev.nodes || []).length; i++) pn.set(prev.nodes[i].id, prev.nodes[i]);
    for (var j = 0; j < (next.nodes || []).length; j++) nn.set(next.nodes[j].id, next.nodes[j]);
    unionKeys(pn, nn).forEach(function (id) {
      var a = pn.has(id) ? pn.get(id) : null;
      var b = nn.has(id) ? nn.get(id) : null;
      if (!stateEqual(a, b)) {
        if (!patch.nodes) patch.nodes = {};
        patch.nodes[id] = { before: cloneValue(a), after: cloneValue(b) };
        any = true;
      }
    });

    var pe = new Map();
    var ne = new Map();
    for (var k = 0; k < (prev.edges || []).length; k++) pe.set(prev.edges[k].id, prev.edges[k]);
    for (var l = 0; l < (next.edges || []).length; l++) ne.set(next.edges[l].id, next.edges[l]);
    unionKeys(pe, ne).forEach(function (id) {
      var a = pe.has(id) ? pe.get(id) : null;
      var b = ne.has(id) ? ne.get(id) : null;
      if (!stateEqual(a, b)) {
        if (!patch.edges) patch.edges = {};
        patch.edges[id] = { before: cloneValue(a), after: cloneValue(b) };
        any = true;
      }
    });

    if (!arrEqual(prev.order, next.order)) {
      patch.order = { before: (prev.order || []).slice(), after: (next.order || []).slice() };
      any = true;
    }

    if (!stateEqual(prev.viewport, next.viewport)) {
      patch.viewport = { before: cloneValue(prev.viewport), after: cloneValue(next.viewport) };
      any = true;
    }

    if (prev.showComments !== next.showComments) {
      patch.showComments = { before: prev.showComments, after: next.showComments };
      any = true;
    }

    return any ? patch : null;
  }

  // applyStatePatch(state, patch, dir): dir "before" restores the pre-state
  // (undo), "after" — the post-state (redo). Mutates state in place: state.nodes
  // is a Map (id -> node), state.edges an array. Edges are rebuilt in the order
  // of state.order so the draw order of the restored graph is preserved (an edge
  // missing from the array is inserted at the stable position of its id in the
  // restored order, not appended).
  function applyStatePatch(state, patch, dir) {
    if (patch.order) state.order = patch.order[dir].slice();
    if (patch.idCounter) state.idCounter = patch.idCounter[dir];
    if (patch.viewport) state.viewport = cloneValue(patch.viewport[dir]);
    if (patch.showComments) state.showComments = patch.showComments[dir];

    if (patch.nodes) {
      Object.keys(patch.nodes).forEach(function (id) {
        var val = patch.nodes[id][dir];
        if (val === null) {
          state.nodes.delete(id);
        } else {
          state.nodes.set(id, cloneValue(val));
        }
      });
    }

    // Edges are rebuilt from state.order whenever the order changed, not only
    // when edge contents changed: an order-only patch (e.g. a text edit that
    // reordered edge lines) must still restore the draw order of the array.
    if (patch.edges || patch.order) {
      var byId = new Map();
      for (var i = 0; i < state.edges.length; i++) {
        var e = state.edges[i];
        if (e && e.id != null) byId.set(e.id, e);
      }
      if (patch.edges) {
        Object.keys(patch.edges).forEach(function (id) {
          var val = patch.edges[id][dir];
          if (val === null) byId.delete(id);
          else byId.set(id, cloneValue(val));
        });
      }
      var out = [];
      var used = {};
      if (Array.isArray(state.order)) {
        for (var j = 0; j < state.order.length; j++) {
          var eid = state.order[j];
          var ee = byId.get(eid);
          if (ee && !used[eid]) {
            out.push(ee);
            used[eid] = 1;
            byId.delete(eid);
          }
        }
      }
      byId.forEach(function (ee, eid2) {
        if (!used[eid2]) { out.push(ee); used[eid2] = 1; }
      });
      state.edges.length = 0;
      for (var m = 0; m < out.length; m++) state.edges.push(out[m]);
    }
  }

  var api = {
    createHistory: createHistory,
    pushState: pushState,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    clearHistory: clearHistory,
    diffStates: diffStates,
    applyStatePatch: applyStatePatch
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2history = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
