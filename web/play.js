// Tremulous Overmind – page logic: server picker, engine boot, pointer-lock handling.
(function () {
  'use strict';

  var BASE = '%BASE%';
  var isTouch = matchMedia('(pointer: coarse)').matches;
  var started = false;
  var engine = null;

  var game = document.getElementById('game');
  var frame = document.getElementById('viewport-frame');
  var splash = document.getElementById('splash');
  var bar = document.getElementById('bar');
  var msg = document.getElementById('splash-msg');

  function wsUrl(server) {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + BASE + 'ws/' + server;
  }

  function progress(pct, text) {
    bar.style.width = Math.max(4, Math.min(100, pct)) + '%';
    if (text) msg.textContent = text;
  }

  function supportsWebGL2() {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
  }

  function loadEngine() {
    return new Promise(function (resolve, reject) {
      if (window.tremulous) return resolve(window.tremulous);
      var s = document.createElement('script');
      s.src = BASE + 'tremulous.js';
      s.onload = function () { resolve(window.tremulous); };
      s.onerror = function () { reject(new Error('engine download failed')); };
      document.head.appendChild(s);
    });
  }

  function start(server) {
    if (started) return;
    if (!supportsWebGL2()) {
      alert('Your browser does not support WebGL 2, which Tremulous needs. Please try a current Chrome, Edge, Firefox or Safari.');
      return;
    }
    started = true;
    game.hidden = false;
    document.body.style.overflow = 'hidden';
    if (isTouch && game.requestFullscreen) game.requestFullscreen({ navigationUI: 'hide' }).catch(function () {});
    progress(8, 'Loading engine…');

    var args = [
      // quoted: the engine's command parser treats a bare "//" as a comment
      '+set', 'fs_cdn', '"' + location.origin + BASE + 'assets"',
      '+set', 'fs_basepath', 'tremulous_base',
      '+set', 'fs_homepath', 'tremulous_home',
      '+set', 'cl_allowDownload', '0'
    ];
    if (server) args.push('+connect', 'overmind-' + server);

    var t0 = performance.now();
    loadEngine().then(function (tremulous) {
      progress(45, 'Starting…');
      engine = tremulous({
        viewport: frame,
        elementPointerLock: true,
        // Every socket goes to our own gateway; the engine never sees a raw host.
        websocket: { url: wsUrl(server || 1), subprotocol: 'binary' },
        onRuntimeInitialized: function () {
          progress(85, 'Downloading game data…');
          this.callMain(args);
          // keep the brand splash up for a moment, then hand over to the engine loader
          var wait = Math.max(0, 1400 - (performance.now() - t0));
          setTimeout(function () { progress(100); splash.classList.add('done'); }, wait);
        }
      });
    }).catch(function (e) {
      progress(100, 'Could not start: ' + e.message + '. Reload to try again.');
    });
  }

  // ---- keep the canvas matched to the window (resize, rotation, fullscreen)
  var resizeTimer = 0;
  function fitCanvas() {
    if (!engine || !engine.canvas || !engine.setCanvasSize) return;
    if (frame.offsetWidth && frame.offsetHeight) engine.setCanvasSize(frame.offsetWidth, frame.offsetHeight);
  }
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitCanvas, 120); });
  document.addEventListener('fullscreenchange', function () { setTimeout(fitCanvas, 120); });

  // Mouse: menus follow the real cursor (engine patch), in-game the engine takes
  // the pointer lock itself on the first click. Nothing to do here but keep focus.
  frame.addEventListener('mousedown', function () {
    var c = frame.querySelector('canvas');
    if (c && document.activeElement !== c) c.focus();
  });

  document.getElementById('exit').addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    location.href = BASE; // full reload is the cleanest teardown of the wasm runtime
  });

  document.querySelectorAll('[data-server]').forEach(function (b) {
    b.addEventListener('click', function () { start(+b.getAttribute('data-server')); });
  });

  // ---- live server status (written by the host every few seconds)
  function refreshStatus() {
    fetch(BASE + 'status.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        var shots = ['atcs', 'niveus', 'karith', 'nexus6', 'uncreation', 'transit', 'atcshd', 'arachnid2', 'tremor'];
        document.querySelectorAll('[data-status]').forEach(function (el) {
          var id = el.getAttribute('data-status');
          var info = s && s[id];
          if (!info) return;
          el.textContent = info.online ? info.humans + ' / ' + info.max + (info.bots ? '  +' + info.bots + ' bots' : '') : 'offline';
          el.classList.toggle('on', !!info.online);
          if (info.online && info.map) {
            document.querySelector('[data-mapname="' + id + '"]').textContent = info.map;
            if (shots.indexOf(info.map) >= 0) document.querySelector('[data-map="' + id + '"]').src = BASE + 'img/maps/' + info.map + '.jpg';
          }
        });
      }).catch(function () {});
  }
  refreshStatus();
  setInterval(function () { if (!started) refreshStatus(); }, 15000);

  // ?play=1 / ?play=2 deep links (e.g. from ads or webnova360.com)
  var deep = new URLSearchParams(location.search).get('play');
  if (deep === 'menu') start(0); // menu only, no auto-connect (handy for testing)
  else if (deep) document.querySelector('[data-server="' + (deep === '2' ? 2 : 1) + '"]').focus();
})();
