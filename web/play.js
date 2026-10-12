// Tremulous Overmind – page logic: server picker, engine boot, pointer-lock handling.
(function () {
  'use strict';

  var BASE = '%BASE%';
  // touch-first devices get the on-screen controls (?touch=1 forces them for testing)
  var isTouch = matchMedia('(pointer: coarse)').matches || /[?&]touch=1\b/.test(location.search);
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
      s.src = BASE + 'tremulous.js?v=%ENGINE_VER%';
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
    game.classList.toggle('touch-on', isTouch);
    document.body.style.overflow = 'hidden';
    if (isTouch && game.requestFullscreen) {
      game.requestFullscreen({ navigationUI: 'hide' }).then(function () {
        if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape');
      }).catch(function () { /* iPhone: no element fullscreen, the rotate hint covers portrait */ });
    }
    progress(8, 'Loading engine…');

    var size = renderSize();
    var args = [
      // quoted: the engine's command parser treats a bare "//" as a comment
      '+set', 'fs_cdn', '"' + location.origin + BASE + 'assets"',
      '+set', 'fs_basepath', 'tremulous_base',
      '+set', 'fs_homepath', 'tremulous_home',
      '+set', 'cl_allowDownload', '0',
      '+set', 'name', '"' + playerName() + '"',
      // network: 40-player snapshots need more than the 25 kB/s default, and 30 input
      // packets a second feel sluggish; frames uncapped for 120 Hz displays
      '+set', 'rate', '90000', '+set', 'snaps', '40', '+set', 'cl_maxpackets', '125',
      '+set', 'com_maxfps', '0',
      // render at the play area's size; later resizes go through Overmind_Resize
      '+set', 'r_mode', '-1',
      '+set', 'r_width', String(size[0]), '+set', 'r_height', String(size[1]),
      '+set', 'r_customwidth', String(size[0]), '+set', 'r_customheight', String(size[1])
    ];
    if (server) args.push('+connect', 'overmind-' + server);

    // SDL's "desktop mode" in the browser is screen.width/height, so a windowed browser
    // renders at monitor size and gets squashed into the window. Report the play area
    // instead (the page reloads when the game is left, so this never outlives it).
    ['width', 'height', 'availWidth', 'availHeight'].forEach(function (k) {
      var h = /height/i.test(k);
      try {
        Object.defineProperty(screen, k, { configurable: true, get: function () { return renderSize()[h ? 1 : 0]; } });
      } catch (e) { /* engine falls back to the real screen size */ }
    });

    var t0 = performance.now();
    loadEngine().then(function (tremulous) {
      progress(45, 'Starting…');
      engine = tremulous({
        viewport: frame,
        elementPointerLock: true,
        // Every socket goes to our own gateway; the engine never sees a raw host.
        websocket: { url: wsUrl(server || 1), subprotocol: 'binary' },
        onRuntimeInitialized: function () {
          var M = this;
          engineModule = M;
          progress(85, 'Downloading game data…');
          M.callMain(args);
          // keep the brand splash up for a moment, then hand over to the engine loader
          var wait = Math.max(0, 1400 - (performance.now() - t0));
          setTimeout(function () { progress(100); splash.classList.add('done'); }, wait);
          if (isTouch) attachTouch(M, 0);
        }
      });
    }).catch(function (e) {
      progress(100, 'Could not start: ' + e.message + '. Reload to try again.');
    });
  }

  var engineModule = null;

  // touch layer needs the canvas and an engine with the Overmind_* API
  function attachTouch(M, tries) {
    if (frame.querySelector('canvas') && M._Overmind_Action && window.OvermindTouch) {
      window.OvermindTouch.attach(frame, M);
    } else if (tries < 100) {
      setTimeout(function () { attachTouch(M, tries + 1); }, 200);
    }
  }

  // render size: the play area in CSS pixels, capped so huge monitors don't
  // turn into a CPU/GPU benchmark (CSS stretches the rest)
  function renderSize() {
    var w = frame.offsetWidth || innerWidth, h = frame.offsetHeight || innerHeight;
    var k = Math.min(1, 1920 / w, 1200 / h);
    return [Math.round(w * k), Math.round(h * k)];
  }

  // follow window resizes, rotation and fullscreen changes once they settle
  var resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!engineModule || !engineModule._Overmind_Resize || game.hidden) return;
      var s = renderSize();
      engineModule._Overmind_Resize(s[0], s[1]);
    }, 400);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  document.addEventListener('fullscreenchange', onResize);

  // name: typed on the page (phones have no keyboard in game), remembered locally
  var nameInput = document.getElementById('callsign');
  function storedName() { try { return localStorage.getItem('overmind.name') || ''; } catch (e) { return ''; } }
  function playerName() {
    var n = cleanName(nameInput ? nameInput.value : '') || cleanName(storedName());
    if (!n) n = 'Player' + (1000 + Math.floor(Math.random() * 9000));
    try { localStorage.setItem('overmind.name', n); } catch (e) { /* private mode */ }
    return n;
  }
  function cleanName(s) {
    return String(s || '').replace(/[^A-Za-z0-9 _.\-\[\]()!?#*+=:]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  }
  if (nameInput) {
    nameInput.value = storedName();
    nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(1); });
  }


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
          el.textContent = info.online ? (info.players != null ? info.players : info.humans) + ' / ' + info.max : 'offline';
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

  // ---- installable app: service worker, install button, iOS hint
  var standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE }).catch(function () {});
  }
  var installBtn = document.getElementById('install');
  var iosHint = document.getElementById('ios-hint');
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
    if (!standalone) installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', function () { installBtn.hidden = true; installPrompt = null; });
  // iPhone/iPad Safari has no install prompt, only Share > Add to Home Screen
  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && !standalone) installBtn.hidden = false;
  installBtn.addEventListener('click', function () {
    if (installPrompt) {
      installPrompt.prompt();
      installPrompt.userChoice.then(function () { installPrompt = null; installBtn.hidden = true; });
    } else {
      iosHint.hidden = !iosHint.hidden;
    }
  });

  // ?play=1 / ?play=2 deep links (e.g. from ads or webnova360.com);
  // the home screen app (?app=1) goes straight into the game
  var params = new URLSearchParams(location.search);
  var deep = params.get('play');
  if (params.get('app') === '1' && standalone) start(1);
  else if (deep === 'menu') start(0); // menu only, no auto-connect (handy for testing)
  else if (deep) document.querySelector('[data-server="' + (deep === '2' ? 2 : 1) + '"]').focus();
})();
