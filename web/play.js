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
    enterFullscreen();
    progress(8, 'Loading engine…');

    var size = renderSize();
    lastRestart = Date.now() + 5000; // the engine boots at this size, give it time
    var args = [
      // quoted: the engine's command parser treats a bare "//" as a comment
      '+set', 'fs_cdn', '"' + location.origin + BASE + 'assets"',
      '+set', 'fs_basepath', 'tremulous_base',
      '+set', 'fs_homepath', 'tremulous_home',
      '+set', 'cl_allowDownload', '0',
      // no SOCKS relay: each attempt opened an extra websocket that only failed,
      // and they ate the per-IP connection limit (slow or refused server switches)
      '+set', 'net_socksEnabled', '0',
      '+set', 'name', '"' + playerName() + '"',
      // network: 40-player snapshots need more than the 25 kB/s default, and 30 input
      // packets a second feel sluggish; frames uncapped for 120 Hz displays
      '+set', 'rate', '90000', '+set', 'snaps', '40', '+set', 'cl_maxpackets', '125',
      '+set', 'com_maxfps', '0',
      // the page owns fullscreen: an engine-side fullscreen window leaves and re-enters
      // browser fullscreen on every vid_restart, which loops with resize handling
      '+set', 'r_fullscreen', '0',
      // render at the play area's size; later resizes go through Overmind_Resize
      '+set', 'r_mode', '-1',
      '+set', 'r_width', String(size[0]), '+set', 'r_height', String(size[1]),
      '+set', 'r_customwidth', String(size[0]), '+set', 'r_customheight', String(size[1])
    ];
    // the engine's tutorial lines talk about keys and mouse buttons; on touch the
    // on-screen buttons are labelled instead
    args.push('+set', 'cg_tutorial', isTouch ? '0' : '1');
    // touch: the page draws large team/spawn pickers instead of the engine's menus
    args.push('+set', 'overmind_touch', isTouch ? '1' : '0');
    // audio runs on the page's main thread (ScriptProcessorNode): the default 512-sample
    // buffer means ~90 callbacks a second competing with rendering; larger buffers cut
    // that 2-4x for 20-45 ms more sound latency, which nobody hears in this game
    args.push('+set', 's_sdlDevSamps', isTouch ? '2048' : '1024');
    // touch: the team list sits exactly where the left thumb steers
    if (isTouch) args.push('+set', 'cg_drawTeamOverlay', '0');
    // warnings ("team full", "can't build here") as a text line, not a modal box
    // in the middle of the screen that has to be clicked away
    args.push('+set', 'cg_disableWarningDialogs', '1');
    // desktop: the player's own key bindings and mouse settings (touch.js needs the stock keys).
    // Sent as console commands after start, not on the command line: the engine keeps only
    // 32 "+" commands from it, and ~30 binds pushed "+connect" out (no auto-join on PC).
    var settings = !isTouch && window.OvermindSettings;
    if (settings) settings.installPointerLockPatch();
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
          if (/[?&]debug=1\b/.test(location.search)) window.__overmind = M;
          progress(85, 'Downloading game data…');
          M.callMain(args);
          if (settings && M._Overmind_Command) settingsCommands(settings.args()).forEach(function (c) { engineCommand(M, c); });
          // keep the brand splash up for a moment, then hand over to the engine loader
          var wait = Math.max(0, 1400 - (performance.now() - t0));
          setTimeout(function () { progress(100); splash.classList.add('done'); }, wait);
          if (isTouch) attachTouch(M, 0);
          if (settings) attachSettings(M);
          watchNav(M);
          watchTutorial(M);
        }
      });
    }).catch(function (e) {
      progress(100, 'Could not start: ' + e.message + '. Reload to try again.');
    });
  }

  var engineModule = null;

  // ---- in-game main menu -> page: the menu (branding pk3, ui/main.menu) sets
  // overmind_nav to 1/2 (join that server) or "home" (back to the website).
  // The engine opens one websocket per server address and reads the gateway URL
  // from Module.websocket each time, so switching servers needs no reload.
  function engineString(M, s) {
    var n = s.length * 3 + 1, p = M._malloc(n);
    M.stringToUTF8(s, p, n);
    return p;
  }
  function engineCommand(M, text) {
    var p = engineString(M, text);
    M._Overmind_Command(p);
    M._free(p);
  }
  // ['+bind','w','"+forward"','+set','sensitivity','5'] -> ['bind w "+forward"', 'set sensitivity 5']
  // (bound commands are quoted, so only command names start with "+")
  function settingsCommands(list) {
    var out = [];
    list.forEach(function (t) {
      if (t.charAt(0) === '+') out.push(t.slice(1));
      else if (out.length) out[out.length - 1] += ' ' + t;
    });
    return out;
  }

  // desktop controls panel: the ⚙ button or F10; bindings apply live and are saved
  function attachSettings(M) {
    if (!M._Overmind_Command) return;
    var btn = document.getElementById('controls');
    var toggle = function () {
      if (OvermindSettings.isOpen()) OvermindSettings.close();
      else OvermindSettings.open(function (cmd) { engineCommand(M, cmd); });
    };
    btn.hidden = false;
    btn.addEventListener('click', toggle);
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'F10') return;
      e.preventDefault(); e.stopPropagation();
      toggle();
    }, true);
  }

  // in-game menu "Options" (branding pk3, ui/ingame.menu): the page's own settings
  function openOptions(M) {
    if (touchUi && touchUi.openSheet) touchUi.openSheet();
    else if (window.OvermindSettings && !OvermindSettings.isOpen())
      OvermindSettings.open(function (cmd) { engineCommand(M, cmd); });
  }

  // PC: the tutorial key hints are useful right after spawning or evolving and noise
  // after that - show them for a few seconds whenever team or class changes
  var TUTORIAL_MS = 12000;
  function watchTutorial(M) {
    if (isTouch || !M._Cvar_VariableString || !M.UTF8ToString) return;
    var stateName = engineString(M, 'overmind_state'), last = null, hideAt = 0, shown = true;
    setInterval(function () {
      var s = M.UTF8ToString(M._Cvar_VariableString(stateName)).split(' ');
      var key = s[0] + ' ' + s[1];
      if (key !== last) {
        last = key; hideAt = Date.now() + TUTORIAL_MS;
        if (!shown) { engineCommand(M, 'set cg_tutorial 1'); shown = true; }
      } else if (shown && Date.now() > hideAt) {
        engineCommand(M, 'set cg_tutorial 0'); shown = false;
      }
    }, 500);
  }

  var navName = 0;
  function watchNav(M) {
    if (!M._Cvar_VariableString || !M._Overmind_Command || !M.UTF8ToString) return;
    setInterval(function () {
      if (!navName) navName = engineString(M, 'overmind_nav');
      var v = M.UTF8ToString(M._Cvar_VariableString(navName));
      if (!v) return;
      engineCommand(M, 'set overmind_nav ""');
      if (v === 'home') { leave(); return; }
      if (v === 'options') { openOptions(M); return; }
      var server = v === '2' ? 2 : 1;
      M.websocket.url = wsUrl(server);
      engineCommand(M, 'connect overmind-' + server);
    }, 300);
  }

  // touch layer needs the canvas and an engine with the Overmind_* API
  var touchUi = null;
  function attachTouch(M, tries) {
    if (frame.querySelector('canvas') && M._Overmind_Action && window.OvermindTouch) {
      touchUi = window.OvermindTouch.attach(frame, M);
    } else if (tries < 100) {
      setTimeout(function () { attachTouch(M, tries + 1); }, 200);
    }
  }

  // render size: the play area in device pixels, so text and edges are sharp on
  // high-density phones and laptops. Capped by a pixel budget (about 1920x1200)
  // so a 4K or 3x screen doesn't turn into a GPU benchmark; the aspect ratio is
  // always the play area's, so nothing is ever stretched.
  var PIXEL_BUDGET = 1920 * 1200;
  function renderSize() {
    var w = frame.offsetWidth || innerWidth, h = frame.offsetHeight || innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var k = Math.min(dpr, Math.sqrt(PIXEL_BUDGET / (w * h)));
    return [Math.round(w * k), Math.round(h * k)];
  }

  // Keep the engine's canvas matched to the play area. Rotation, fullscreen and
  // mobile browser bars change it, sometimes several times in a row and while the
  // engine is still loading, so instead of trusting single events the page checks
  // the real canvas every second and fixes any mismatch. Each fix restarts the
  // renderer, so tiny jitter is ignored and fixes are at least 3 s apart.
  var lastRestart = 0, resizeTimer = 0;
  function syncSize() {
    if (!engineModule || !engineModule._Overmind_Resize || game.hidden) return;
    var c = frame.querySelector('canvas');
    if (!c || !c.width || !c.height) return;
    var want = renderSize();
    var aspectOff = Math.abs(c.width / c.height - want[0] / want[1]) > 0.02;
    var sizeOff = Math.abs(c.width - want[0]) > want[0] * 0.08;
    if (!aspectOff && !sizeOff) return;
    if (Date.now() - lastRestart < 3000) return;
    lastRestart = Date.now();
    engineModule._Overmind_Resize(want[0], want[1]);
  }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncSize, 500);
  }
  setInterval(syncSize, 1000);
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

  // Fullscreen: entered on "Play" (needs that click), toggled with the ⛶ button.
  // On PC, Keyboard Lock keeps Esc for the game menu while fullscreen (Chrome/Edge);
  // the browser then leaves fullscreen on a long Esc press instead.
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
  function enterFullscreen() {
    var req = game.requestFullscreen || game.webkitRequestFullscreen;
    if (!req) return;   // iPhone: no element fullscreen, the rotate hint covers portrait
    var p;
    try { p = req.call(game, { navigationUI: 'hide' }); } catch (e) { return; }
    Promise.resolve(p).then(function () {
      if (isTouch && screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape');
      if (!isTouch && navigator.keyboard && navigator.keyboard.lock) return navigator.keyboard.lock(['Escape']);
    }).catch(function () { /* refused or unsupported: windowed is fine */ });
  }
  function toggleFullscreen() {
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else enterFullscreen();
  }
  var fsBtn = document.getElementById('fullscreen');
  if (fsBtn && (game.requestFullscreen || game.webkitRequestFullscreen)) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', toggleFullscreen);
  }

  function leave() {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    location.href = BASE; // full reload is the cleanest teardown of the wasm runtime
  }
  document.getElementById('exit').addEventListener('click', leave);

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
