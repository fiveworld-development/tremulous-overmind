// Tremulous Overmind - anonymous frame-time reports.
// While a game is running, every 30 s one GET to <base>perf?... carries numbers only:
// frame interval percentiles, engine time per frame, WebGL calls per frame, the slowest
// frames in detail, plus GPU name, browser family, pixel ratio and canvas size. No name,
// no address, no ids beyond a random per-page session tag. Lets us see why a device
// stutters without asking players to dig in developer tools.
(function () {
  'use strict';

  var ENDPOINT = location.pathname.replace(/[^/]*$/, '') + 'perf';
  var PERIOD = 30000, MAX_REPORTS = 40;
  var session = Math.random().toString(36).slice(2, 8);

  // per-frame counters, filled by the WebGL hooks
  var cur = { draws: 0, bufs: 0, bufBytes: 0, tex: 0, prog: 0, calls: 0, attr: 0, unif: 0, use: 0, bindTex: 0 };
  var gpu = '', glCanvas = null;

  function hook(proto, name, fn) {
    var orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function () { fn.apply(this, arguments); return orig.apply(this, arguments); };
  }
  var G = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  hook(G, 'drawElements', function () { cur.draws++; });
  hook(G, 'drawArrays', function () { cur.draws++; });
  // emscripten uses the WebGL2 overloads (whole heap + offset + length): count the length
  hook(G, 'bufferData', function (t, d, u, off, len) {
    cur.bufs++; cur.bufBytes += typeof d === 'number' ? d : len !== undefined ? len : d && d.byteLength || 0;
  });
  hook(G, 'bufferSubData', function (t, o, d, off, len) {
    cur.bufs++; cur.bufBytes += len !== undefined ? len : d && d.byteLength || 0;
  });
  hook(G, 'texImage2D', function () { cur.tex++; });
  hook(G, 'texSubImage2D', function () { cur.tex++; });
  hook(G, 'linkProgram', function () { cur.prog++; });
  hook(G, 'vertexAttribPointer', function () { cur.attr++; });
  hook(G, 'useProgram', function () { cur.use++; });
  hook(G, 'bindTexture', function () { cur.bindTex++; });
  // every other GL call, for the total per frame (uniforms counted separately)
  if (G) Object.getOwnPropertyNames(G).forEach(function (n) {
    if (/^(drawElements|drawArrays|bufferData|bufferSubData|texImage2D|texSubImage2D|linkProgram|compileShader|clear|vertexAttribPointer|useProgram|bindTexture|constructor|canvas|drawingBuffer\w*)$/.test(n)) return;
    var d = Object.getOwnPropertyDescriptor(G, n);
    if (!d || typeof d.value !== 'function') return;
    var isUnif = /^uniform/.test(n);
    hook(G, n, isUnif ? function () { cur.unif++; } : function () { cur.calls++; });
  });
  hook(G, 'compileShader', function () { cur.prog++; });
  hook(G, 'clear', function () {
    if (gpu || glCanvas === this.canvas) return;
    glCanvas = this.canvas;
    try {
      var d = this.getExtension('WEBGL_debug_renderer_info');
      gpu = String((d && this.getParameter(d.UNMASKED_RENDERER_WEBGL)) || this.getParameter(this.RENDERER) || '?');
    } catch (e) { gpu = '?'; }
  });

  // frame timing: the engine's main loop runs in requestAnimationFrame
  var frames = [];          // {dt, work, draws, bufs, kb, tex, prog}
  var lastT = 0, work = 0;
  var raf = window.requestAnimationFrame;
  if (typeof raf === 'function') {
    window.requestAnimationFrame = function (cb) {
      return raf.call(window, function (t) {
        var a = performance.now();
        try { cb(t); } finally { work += performance.now() - a; }
      });
    };
    (function tick(t) {
      if (lastT && document.visibilityState === 'visible' && glCanvas) {
        frames.push({ dt: t - lastT, work: work, draws: cur.draws, bufs: cur.bufs,
                      kb: Math.round(cur.bufBytes / 1024), tex: cur.tex, prog: cur.prog,
                      gl: cur.calls + cur.unif + cur.attr + cur.use + cur.bindTex + cur.draws + cur.bufs,
                      attr: cur.attr, unif: cur.unif, use: cur.use, bt: cur.bindTex });
        if (frames.length > 6000) frames.splice(0, 3000);
      }
      lastT = t; work = 0;
      for (var k in cur) cur[k] = 0;
      raf.call(window, tick);
    })(0);
  }

  // Chrome's Long Animation Frame entries split a long frame into script time and
  // rendering (style/layout/paint/commit); what is left over is waiting (GPU process)
  var longFrames = [];
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        if (!glCanvas || longFrames.length > 200) return;
        var script = 0;
        (e.scripts || []).forEach(function (s) { script += s.duration; });
        var render = e.renderStart ? e.startTime + e.duration - e.renderStart : 0;
        longFrames.push([Math.round(e.duration), Math.round(e.blockingDuration || 0), Math.round(script),
                         Math.round(render), (e.scripts || []).length]);
      });
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch (e) { /* not Chrome */ }

  function pct(a, p) { return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function browser() {
    var u = navigator.userAgent;
    var b = /Edg\//.test(u) ? 'edge' : /OPR\//.test(u) ? 'opera' : /Firefox\//.test(u) ? 'firefox' :
            /Chrome\//.test(u) ? 'chrome' : /Safari\//.test(u) ? 'safari' : 'other';
    var v = (u.match(/(?:Edg|OPR|Firefox|Chrome|Version)\/(\d+)/) || [])[1] || '';
    var os = /iPhone|iPad/.test(u) ? 'ios' : /Android/.test(u) ? 'android' : /Mac OS X/.test(u) ? 'mac' :
             /Windows/.test(u) ? 'win' : /Linux/.test(u) ? 'linux' : 'other';
    return b + v + '-' + os;
  }

  var sent = 0;
  function report() {
    if (sent >= MAX_REPORTS || frames.length < 30) { frames = []; return; }
    var f = frames; frames = [];
    var dts = f.map(function (x) { return x.dt; }).sort(function (a, b) { return a - b; });
    var works = f.map(function (x) { return x.work; }).sort(function (a, b) { return a - b; });
    var draws = f.map(function (x) { return x.draws; }).sort(function (a, b) { return a - b; });
    // dt_work_draws_bufs_kb_tex_prog_gl_attr_unif_use_bindtex
    var slow = f.slice().sort(function (a, b) { return b.dt - a.dt; }).slice(0, 6).map(function (x) {
      return [Math.round(x.dt), r1(x.work), x.draws, x.bufs, x.kb, x.tex, x.prog, x.gl, x.attr, x.unif, x.use, x.bt].join('_');
    });
    var mid = f.slice().sort(function (a, b) { return a.gl - b.gl; })[f.length >> 1];
    var loaf = longFrames.splice(0).sort(function (a, b) { return b[0] - a[0]; }).slice(0, 6)
      .map(function (x) { return x.join('_'); }).join('.');
    var sum = 0; f.forEach(function (x) { sum += x.dt; });
    var q = {
      s: session, n: sent, b: browser(), g: gpu.slice(0, 60), dpr: r1(window.devicePixelRatio || 1),
      c: glCanvas ? glCanvas.width + 'x' + glCanvas.height : '', cores: navigator.hardwareConcurrency || 0,
      fps: Math.round(f.length * 1000 / sum),
      dt: [pct(dts, .5), pct(dts, .9), pct(dts, .99), dts[dts.length - 1]].map(r1).join('_'),
      over25: f.filter(function (x) { return x.dt > 25; }).length,
      over50: f.filter(function (x) { return x.dt > 50; }).length,
      work: [pct(works, .5), pct(works, .9), pct(works, .99), works[works.length - 1]].map(r1).join('_'),
      draws: [pct(draws, .5), pct(draws, .99)].join('_'),
      prog: f.reduce(function (s, x) { return s + x.prog; }, 0),
      tex: f.reduce(function (s, x) { return s + x.tex; }, 0),
      slow: slow.join('.'),
      // a typical frame: gl_attr_unif_use_bindtex_draws_bufs
      mid: mid ? [mid.gl, mid.attr, mid.unif, mid.use, mid.bt, mid.draws, mid.bufs].join('_') : '',
      // Chrome long animation frames: dur_blocking_script_render(start->end)_scriptCount
      loaf: loaf
    };
    sent++;
    var qs = Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
    try { fetch(ENDPOINT + '?' + qs, { method: 'GET', keepalive: true, credentials: 'omit', cache: 'no-store' }); }
    catch (e) { /* reporting is best effort */ }
  }
  setInterval(report, PERIOD);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') report(); });
})();
