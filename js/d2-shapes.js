(function (global) {
  "use strict";

  var PI = Math.PI;

  function n1(v) { return Math.round(v * 10) / 10; }
  function P(x, y) { return { x: x, y: y }; }

  // Closed polygon helpers. Outline arrays do NOT repeat the start point at the
  // end: the shape is implicitly closed (last point connects to the first).

  function polyD(pts) {
    var d = 'M' + n1(pts[0].x) + ' ' + n1(pts[0].y);
    for (var i = 1; i < pts.length; i++) d += 'L' + n1(pts[i].x) + ' ' + n1(pts[i].y);
    return d + 'Z';
  }

  // Points along an ellipse arc between angles a0..a1 (screen space: angle 0 is
  // right, +pi/2 is down). Used both to approximate outlines and to render arcs.
  function arcPoints(cx, cy, rx, ry, a0, a1, steps) {
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * (i / steps);
      pts.push(P(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
    }
    return pts;
  }

  // Points along a quadratic Bezier p0 -> pc -> p1.
  function quadPoints(p0, pc, p1, steps) {
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps, u = 1 - t;
      pts.push(P(
        u * u * p0.x + 2 * u * t * pc.x + t * t * p1.x,
        u * u * p0.y + 2 * u * t * pc.y + t * t * p1.y
      ));
    }
    return pts;
  }

  // SVG "A" arc segment from the current point (angle a0 on the ellipse) to the
  // point at angle a1. sweep=1 means increasing angle (clockwise on screen).
  function svgArc(cx, cy, rx, ry, a0, a1) {
    var delta = a1 - a0;
    var x1 = cx + Math.cos(a1) * rx, y1 = cy + Math.sin(a1) * ry;
    var large = Math.abs(delta) > PI ? 1 : 0;
    var sweep = delta > 0 ? 1 : 0;
    return 'A' + n1(rx) + ' ' + n1(ry) + ' 0 ' + large + ' ' + sweep + ' ' + n1(x1) + ' ' + n1(y1);
  }

  function ellipseD(cx, cy, rx, ry) {
    return 'M' + n1(cx + rx) + ' ' + n1(cy) +
      'A' + n1(rx) + ' ' + n1(ry) + ' 0 1 1 ' + n1(cx - rx) + ' ' + n1(cy) +
      'A' + n1(rx) + ' ' + n1(ry) + ' 0 1 1 ' + n1(cx + rx) + ' ' + n1(cy) + 'Z';
  }

  function roundedRectD(b, r) {
    var x = b.x, y = b.y, w = b.w, h = b.h;
    r = Math.min(r, w / 2, h / 2);
    return 'M' + n1(x + r) + ' ' + n1(y) +
      'H' + n1(x + w - r) +
      'A' + n1(r) + ' ' + n1(r) + ' 0 0 1 ' + n1(x + w) + ' ' + n1(y + r) +
      'V' + n1(y + h - r) +
      'A' + n1(r) + ' ' + n1(r) + ' 0 0 1 ' + n1(x + w - r) + ' ' + n1(y + h) +
      'H' + n1(x + r) +
      'A' + n1(r) + ' ' + n1(r) + ' 0 0 1 ' + n1(x) + ' ' + n1(y + h - r) +
      'V' + n1(y + r) +
      'A' + n1(r) + ' ' + n1(r) + ' 0 0 1 ' + n1(x + r) + ' ' + n1(y) +
      'Z';
  }

  function roundedRectOutline(b, r) {
    var x = b.x, y = b.y, w = b.w, h = b.h;
    if (r <= 0) return [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
    var pts = [P(x + r, y), P(x + w - r, y)];
    pts = pts.concat(arcPoints(x + w - r, y + r, r, r, -PI / 2, 0, 6));
    pts.push(P(x + w, y + h - r));
    pts = pts.concat(arcPoints(x + w - r, y + h - r, r, r, 0, PI / 2, 6));
    pts.push(P(x + r, y + h));
    pts = pts.concat(arcPoints(x + r, y + h - r, r, r, PI / 2, PI, 6));
    pts.push(P(x, y + r));
    pts = pts.concat(arcPoints(x + r, y + r, r, r, PI, PI * 3 / 2, 6));
    return pts;
  }

  function rectRecord(name, rx, ratio) {
    return {
      name: name, ratio: ratio || null,
      params: { rx: rx },
      render: function (b, p) { return [roundedRectD(b, p.rx)]; },
      outline: function (b, p) { return roundedRectOutline(b, p.rx); }
    };
  }

  var SHAPES = {};

  SHAPES.rectangle = rectRecord('rectangle', 8, null);
  SHAPES.square = rectRecord('square', 0, 1);

  SHAPES.page = {
    name: 'page', ratio: null,
    params: { fold: 0.25 },
    fold: function (b, p) { return Math.min(b.w, b.h) * p.fold; },
    render: function (b, p) {
      var f = this.fold(b, p);
      return [polyD([
        P(b.x, b.y), P(b.x + b.w - f, b.y),
        P(b.x + b.w, b.y + f), P(b.x + b.w, b.y + b.h), P(b.x, b.y + b.h)
      ])];
    },
    outline: function (b, p) {
      var f = this.fold(b, p);
      return [
        P(b.x, b.y), P(b.x + b.w - f, b.y),
        P(b.x + b.w, b.y + f), P(b.x + b.w, b.y + b.h), P(b.x, b.y + b.h)
      ];
    }
  };

  SHAPES.parallelogram = {
    name: 'parallelogram', ratio: null,
    params: { skew: 0.4 },
    render: function (b, p) {
      var s = p.skew * b.h;
      return [polyD([
        P(b.x + s, b.y), P(b.x + b.w, b.y),
        P(b.x + b.w - s, b.y + b.h), P(b.x, b.y + b.h)
      ])];
    },
    outline: function (b, p) {
      var s = p.skew * b.h;
      return [
        P(b.x + s, b.y), P(b.x + b.w, b.y),
        P(b.x + b.w - s, b.y + b.h), P(b.x, b.y + b.h)
      ];
    }
  };

  SHAPES.document = {
    name: 'document', ratio: null,
    params: { waveAmp: 0.12, waveUp: 0.67 },
    render: function (b, p) {
      var amp = b.h * p.waveAmp;
      var by = b.y + b.h - amp;
      var mx = b.x + b.w / 2;
      var up = amp * p.waveUp;
      return ['M' + n1(b.x) + ' ' + n1(b.y) +
        'H' + n1(b.x + b.w) +
        'V' + n1(by) +
        'Q' + n1(b.x + 3 * b.w / 4) + ' ' + n1(b.y + b.h) + ' ' + n1(mx) + ' ' + n1(by + amp) +
        'Q' + n1(b.x + b.w / 4) + ' ' + n1(by + amp - up) + ' ' + n1(b.x) + ' ' + n1(by) +
        'V' + n1(b.y) + 'Z'];
    },
    outline: function (b, p) {
      var amp = b.h * p.waveAmp;
      var by = b.y + b.h - amp;
      var mx = b.x + b.w / 2;
      var up = amp * p.waveUp;
      var right = quadPoints(P(b.x + b.w, by), P(b.x + 3 * b.w / 4, b.y + b.h), P(mx, by + amp), 6);
      var left = quadPoints(P(mx, by + amp), P(b.x + b.w / 4, by + amp - up), P(b.x, by), 6);
      return [P(b.x, b.y), P(b.x + b.w, b.y)].concat(right, left);
    }
  };

  SHAPES.cylinder = {
    name: 'cylinder', ratio: null,
    params: { ellipseRise: 0.11 },
    render: function (b, p) {
      var ry = Math.min(p.ellipseRise * b.w, b.h * 0.3);
      var rx = b.w / 2, cx = b.x + rx;
      var topCy = b.y + ry, botCy = b.y + b.h - ry;
      var body = 'M' + n1(b.x) + ' ' + n1(topCy) +
        svgArc(cx, topCy, rx, ry, PI, PI * 2) +
        'L' + n1(b.x + b.w) + ' ' + n1(botCy) +
        svgArc(cx, botCy, rx, ry, 0, PI) +
        'L' + n1(b.x) + ' ' + n1(topCy) + 'Z';
      var rim = 'M' + n1(b.x) + ' ' + n1(topCy) +
        svgArc(cx, topCy, rx, ry, PI, 0);
      return [body, rim];
    },
    outline: function (b, p) {
      var ry = Math.min(p.ellipseRise * b.w, b.h * 0.3);
      var rx = b.w / 2, cx = b.x + rx;
      var topCy = b.y + ry, botCy = b.y + b.h - ry;
      var top = arcPoints(cx, topCy, rx, ry, PI, PI * 2, 8);
      var bot = arcPoints(cx, botCy, rx, ry, 0, PI, 8);
      return top.concat(P(b.x + b.w, botCy), bot, P(b.x, topCy));
    }
  };

  SHAPES.queue = {
    name: 'queue', ratio: null,
    params: { bubbleRise: 0.26 },
    render: function (b, p) {
      var bw = p.bubbleRise * b.h;
      var ry = b.h / 2;
      var cxL = b.x + bw, cxR = b.x + b.w - bw;
      return ['M' + n1(cxL) + ' ' + n1(b.y) +
        'H' + n1(cxR) +
        svgArc(cxR, b.y + ry, bw, ry, -PI / 2, PI / 2) +
        'H' + n1(cxL) +
        svgArc(cxL, b.y + ry, bw, ry, PI / 2, PI * 3 / 2) + 'Z'];
    },
    outline: function (b, p) {
      var bw = p.bubbleRise * b.h;
      var ry = b.h / 2;
      var cxL = b.x + bw, cxR = b.x + b.w - bw;
      var right = arcPoints(cxR, b.y + ry, bw, ry, -PI / 2, PI / 2, 8);
      var left = arcPoints(cxL, b.y + ry, bw, ry, PI / 2, PI * 3 / 2, 8);
      return [P(cxL, b.y), P(cxR, b.y)].concat(right, P(cxL, b.y + b.h), left);
    }
  };

  SHAPES.package = {
    name: 'package', ratio: null,
    params: { flapW: 0.5, flapH: 0.2 },
    render: function (b, p) {
      var fw = p.flapW * b.w, fh = p.flapH * b.h;
      return [polyD([
        P(b.x, b.y), P(b.x + fw, b.y), P(b.x + fw, b.y + fh),
        P(b.x + b.w, b.y + fh), P(b.x + b.w, b.y + b.h), P(b.x, b.y + b.h)
      ])];
    },
    outline: function (b, p) {
      var fw = p.flapW * b.w, fh = p.flapH * b.h;
      return [
        P(b.x, b.y), P(b.x + fw, b.y), P(b.x + fw, b.y + fh),
        P(b.x + b.w, b.y + fh), P(b.x + b.w, b.y + b.h), P(b.x, b.y + b.h)
      ];
    }
  };

  SHAPES.step = {
    name: 'step', ratio: null,
    params: { bevel: 0.3 },
    render: function (b, p) {
      var s = p.bevel * b.w;
      return [polyD([
        P(b.x, b.y), P(b.x + b.w - s, b.y), P(b.x + b.w, b.y + b.h / 2),
        P(b.x + b.w - s, b.y + b.h), P(b.x, b.y + b.h), P(b.x + s, b.y + b.h / 2)
      ])];
    },
    outline: function (b, p) {
      var s = p.bevel * b.w;
      return [
        P(b.x, b.y), P(b.x + b.w - s, b.y), P(b.x + b.w, b.y + b.h / 2),
        P(b.x + b.w - s, b.y + b.h), P(b.x, b.y + b.h), P(b.x + s, b.y + b.h / 2)
      ];
    }
  };

  SHAPES.callout = {
    name: 'callout', ratio: null,
    params: { tailW: 0.42, tailH: 0.38 },
    render: function (b, p) {
      var tw = p.tailW * b.w, th = p.tailH * b.h;
      var by = b.y + b.h - th;
      var lx = b.x + (b.w - tw) / 2, rx = b.x + (b.w + tw) / 2;
      return ['M' + n1(b.x) + ' ' + n1(b.y) +
        'H' + n1(b.x + b.w) + 'V' + n1(by) +
        'L' + n1(rx) + ' ' + n1(by) + 'L' + n1(lx) + ' ' + n1(b.y + b.h) +
        'L' + n1(lx) + ' ' + n1(by) + 'L' + n1(b.x) + ' ' + n1(by) + 'V' + n1(b.y) + 'Z'];
    },
    outline: function (b, p) {
      var tw = p.tailW * b.w, th = p.tailH * b.h;
      var by = b.y + b.h - th;
      var lx = b.x + (b.w - tw) / 2, rx = b.x + (b.w + tw) / 2;
      return [
        P(b.x, b.y), P(b.x + b.w, b.y), P(b.x + b.w, by), P(rx, by),
        P(lx, b.y + b.h), P(lx, by), P(b.x, by)
      ];
    }
  };

  function ellipseRecord(name, ratio) {
    return {
      name: name, ratio: ratio || null,
      params: {},
      render: function (b) {
        return [ellipseD(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2)];
      },
      outline: function (b) {
        return arcPoints(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, PI * 2, 16);
      }
    };
  }
  SHAPES.stored_data = ellipseRecord('stored_data', null);
  SHAPES.oval = ellipseRecord('oval', null);
  SHAPES.circle = ellipseRecord('circle', 1);

  SHAPES.person = {
    name: 'person', ratio: null,
    params: { headR: 0.13, shoulderTop: 0.33, shoulderH: 0.27 },
    render: function (b, p) {
      var r = p.headR * Math.min(b.w, b.h);
      var cx = b.x + b.w / 2, cy = b.y + r;
      var neckY = cy + r;
      var stY = neckY + p.shoulderH * b.h;
      var st = p.shoulderTop * b.w / 2;
      return ['M' + n1(cx - r) + ' ' + n1(cy) +
        svgArc(cx, cy, r, r, PI, PI * 2) +
        'L' + n1(cx + st) + ' ' + n1(stY) +
        'L' + n1(b.x + b.w) + ' ' + n1(b.y + b.h) +
        'L' + n1(b.x) + ' ' + n1(b.y + b.h) +
        'L' + n1(cx - st) + ' ' + n1(stY) + 'Z'];
    },
    outline: function (b, p) {
      var r = p.headR * Math.min(b.w, b.h);
      var cx = b.x + b.w / 2, cy = b.y + r;
      var neckY = cy + r;
      var stY = neckY + p.shoulderH * b.h;
      var st = p.shoulderTop * b.w / 2;
      var head = arcPoints(cx, cy, r, r, PI, PI * 2, 8);
      return head.concat(P(cx + st, stY), P(b.x + b.w, b.y + b.h),
        P(b.x, b.y + b.h), P(cx - st, stY));
    }
  };

  SHAPES.diamond = {
    name: 'diamond', ratio: null,
    params: {},
    render: function (b) {
      return [polyD([
        P(b.x + b.w / 2, b.y), P(b.x + b.w, b.y + b.h / 2),
        P(b.x + b.w / 2, b.y + b.h), P(b.x, b.y + b.h / 2)
      ])];
    },
    outline: function (b) {
      return [
        P(b.x + b.w / 2, b.y), P(b.x + b.w, b.y + b.h / 2),
        P(b.x + b.w / 2, b.y + b.h), P(b.x, b.y + b.h / 2)
      ];
    }
  };

  SHAPES.hexagon = {
    name: 'hexagon', ratio: null,
    params: {},
    render: function (b) {
      return [polyD([
        P(b.x + b.w * 0.25, b.y), P(b.x + b.w * 0.75, b.y),
        P(b.x + b.w, b.y + b.h / 2), P(b.x + b.w * 0.75, b.y + b.h),
        P(b.x + b.w * 0.25, b.y + b.h), P(b.x, b.y + b.h / 2)
      ])];
    },
    outline: function (b) {
      return [
        P(b.x + b.w * 0.25, b.y), P(b.x + b.w * 0.75, b.y),
        P(b.x + b.w, b.y + b.h / 2), P(b.x + b.w * 0.75, b.y + b.h),
        P(b.x + b.w * 0.25, b.y + b.h), P(b.x, b.y + b.h / 2)
      ];
    }
  };

  function cloudCurve(cx, cy, rx, ry, p) {
    var n = p.bumps * 2;
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * PI * 2;
      var rr = (i % 2 === 0) ? 1 : p.lobe;
      pts.push(P(cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr));
    }
    var d = '';
    for (var j = 0; j < n; j++) {
      var a0 = (j / n) * PI * 2, a1 = ((j + 1) / n) * PI * 2;
      var am = (a0 + a1) / 2;
      var cf = 1 + (p.lobe - 1) * 1.6;
      var cxp = cx + Math.cos(am) * rx * cf, cyp = cy + Math.sin(am) * ry * cf;
      if (j === 0) d = 'M' + n1(pts[0].x) + ' ' + n1(pts[0].y);
      d += 'Q' + n1(cxp) + ' ' + n1(cyp) + ' ' + n1(pts[j + 1].x) + ' ' + n1(pts[j + 1].y);
    }
    return { d: d, pts: pts };
  }

  SHAPES.cloud = {
    name: 'cloud', ratio: null,
    params: { bumps: 6, lobe: 1.22 },
    render: function (b, p) {
      var c = cloudCurve(b.x + b.w / 2, b.y + b.h / 2, b.w * 0.4, b.h * 0.4, p);
      return [c.d + 'Z'];
    },
    outline: function (b, p) {
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      var rx = b.w * 0.4, ry = b.h * 0.4;
      var n = p.bumps * 2;
      var pts = [];
      for (var j = 0; j < n; j++) {
        var a0 = (j / n) * PI * 2, a1 = ((j + 1) / n) * PI * 2;
        var am = (a0 + a1) / 2;
        var cf = 1 + (p.lobe - 1) * 1.6;
        var rr = (j % 2 === 0) ? 1 : p.lobe;
        var r1 = ((j + 1) % 2 === 0) ? 1 : p.lobe;
        var p0 = P(cx + Math.cos(a0) * rx * rr, cy + Math.sin(a0) * ry * rr);
        var pc = P(cx + Math.cos(am) * rx * cf, cy + Math.sin(am) * ry * cf);
        var p1 = P(cx + Math.cos(a1) * rx * r1, cy + Math.sin(a1) * ry * r1);
        var seg = quadPoints(p0, pc, p1, 3);
        for (var k = 1; k < seg.length; k++) pts.push(seg[k]);
      }
      return pts;
    }
  };

  SHAPES.c4person = {
    name: 'c4-person', ratio: null,
    params: { headR: 0.21, rx: 8 },
    render: function (b, p) {
      var r = p.headR * Math.min(b.w, b.h);
      var cx = b.x + b.w / 2, cy = b.y + r;
      var bodyTop = b.y + 2 * r;
      var head = ellipseD(cx, cy, r, r);
      var body = roundedRectD({ x: b.x, y: bodyTop, w: b.w, h: b.h - 2 * r }, p.rx);
      return [head, body];
    },
    outline: function (b, p) {
      var r = p.headR * Math.min(b.w, b.h);
      var cx = b.x + b.w / 2, cy = b.y + r;
      var bodyTop = b.y + 2 * r;
      var body = { x: b.x, y: bodyTop, w: b.w, h: b.h - 2 * r };
      var headTop = arcPoints(cx, cy, r, r, PI, PI * 2, 8);
      var headRight = arcPoints(cx, cy, r, r, 0, PI / 2, 4);
      var headLeft = arcPoints(cx, cy, r, r, PI / 2, PI, 4);
      var bodyLoop = roundedRectOutline(body, p.rx);
      var rrc = Math.min(p.rx, body.w / 2, body.h / 2);
      var startIdx = 0, bestD = Infinity;
      for (var i = 0; i < bodyLoop.length; i++) {
        var d = Math.hypot(bodyLoop[i].x - (body.x + body.w - rrc), bodyLoop[i].y - bodyTop);
        if (d < bestD) { bestD = d; startIdx = i; }
      }
      var bodyPart = bodyLoop.slice(startIdx).concat(bodyLoop.slice(0, startIdx));
      return headTop.concat(headRight, bodyPart, headLeft);
    }
  };

  var FALLBACK = rectRecord('fallback', 8, null);

  SHAPES['c4-person'] = SHAPES.c4person;

  function getShape(name) {
    if (name == null) return FALLBACK;
    var rec = SHAPES[String(name).toLowerCase()];
    return rec || FALLBACK;
  }

  // SVG path strings for the shape (one or more filled paths). Coordinates are
  // absolute within the box {x,y,w,h}.
  function renderShape(name, box, opts) {
    var rec = getShape(name);
    var p = (opts && opts.params) ? opts.params : rec.params;
    return rec.render(box, p);
  }

  // Closed polygon approximating the shape contour (implicitly closed).
  function outlinePoints(name, box, opts) {
    var rec = getShape(name);
    var p = (opts && opts.params) ? opts.params : rec.params;
    return rec.outline(box, p);
  }

  // Nearest intersection of the ray (cx,cy)->(cx+dx,cy+dy) with the polygon.
  // Returns {x,y} or null when no segment is hit.
  function outlineIntersect(points, cx, cy, dx, dy) {
    var n = points.length;
    var best = null, bestU = Infinity;
    for (var i = 0; i < n; i++) {
      var a = points[i], b = points[(i + 1) % n];
      var rx = b.x - a.x, ry = b.y - a.y;
      var det = rx * (-dy) - (-dx) * ry;
      if (det === 0) continue;
      var qx = cx - a.x, qy = cy - a.y;
      var t = (qx * (-dy) - (-dx) * qy) / det;
      var u = (rx * qy - qx * ry) / det;
      if (t < 0 || t > 1 || u < 0) continue;
      if (u < bestU) {
        bestU = u;
        best = { x: a.x + t * rx, y: a.y + t * ry };
      }
    }
    return best;
  }

  // 1:1 shapes normalize to the maximum of w/h (e.g. circle, square).
  function normalizeRatio(name, w, h) {
    var rec = getShape(name);
    if (rec.ratio === 1) {
      var m = Math.max(w, h);
      return { w: m, h: m };
    }
    return { w: w, h: h };
  }

  var SHAPE_NAMES = [
    'rectangle', 'square', 'page', 'parallelogram', 'document', 'cylinder',
    'queue', 'package', 'step', 'callout', 'stored_data', 'person',
    'diamond', 'oval', 'circle', 'hexagon', 'cloud', 'c4-person'
  ];

  var api = {
    SHAPES: SHAPES, SHAPE_NAMES: SHAPE_NAMES,
    getShape: getShape, renderShape: renderShape,
    outlinePoints: outlinePoints, outlineIntersect: outlineIntersect,
    normalizeRatio: normalizeRatio, FALLBACK: FALLBACK
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.d2shapes = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
