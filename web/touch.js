// Tremulous Overmind – touch controls for phones and tablets.
// Talks to the engine through the Overmind_* exports (engine patch 0003): actions go
// through the normal key bindings, looking is fed as mouse motion, and in menus a
// finger works like a mouse. Loaded by play.js only on touch-first devices.
(function () {
  'use strict';

  // action ids, see overmindActionKeys[] in sdl_input.cpp
  var A = { FWD: 0, BACK: 1, LEFT: 2, RIGHT: 3, JUMP: 4, CROUCH: 5, FIRE: 6, ALT: 7,
            USE: 8, RELOAD: 9, PREV: 10, NEXT: 11, SCORES: 12, MENU: 13, MEDKIT: 14, AMMO: 15 };

  var STORE = 'overmind.touch';
  var settings = { look: 1, layout: 'right' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* defaults */ }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* private mode */ } }

  function attach(frame, M) {
    var root = document.getElementById('touch');
    var canvas = frame.querySelector('canvas');
    if (!root || !M || !M._Overmind_Action) return null;

    var pressed = {};
    function act(a, down) {
      down = down ? 1 : 0;
      if (!!pressed[a] === !!down) return;
      pressed[a] = down;
      M._Overmind_Action(a, down);
    }
    function releaseAll() { Object.keys(pressed).forEach(function (a) { act(+a, 0); }); }
    function tap(a) { act(a, 1); setTimeout(function () { act(a, 0); }, 60); }

    // ---------- markup (built here so the page stays clean without touch)
    root.innerHTML =
      '<div class="t-zone t-move" data-zone="move"><i class="t-stick"><b></b></i></div>' +
      '<div class="t-zone t-look" data-zone="look"></div>' +
      '<div class="t-top">' +
        '<button data-tap="' + A.MENU + '" aria-label="Menu">Menu</button>' +
        '<button data-hold="' + A.SCORES + '" aria-label="Scores">Scores</button>' +
        '<button data-tap="' + A.MEDKIT + '" aria-label="Medkit">Med</button>' +
        '<button data-tap="' + A.AMMO + '" aria-label="Buy ammo">Ammo</button>' +
        '<button data-ui="sens" aria-label="Look speed">Look ' + settings.look.toFixed(1) + '</button>' +
      '</div>' +
      '<div class="t-pad">' +
        '<button class="t-fire" data-hold="' + A.FIRE + '" data-look="1" aria-label="Fire">Fire</button>' +
        '<button class="t-alt" data-hold="' + A.ALT + '" data-look="1" aria-label="Alt fire">Alt</button>' +
        '<button class="t-jump" data-hold="' + A.JUMP + '" aria-label="Jump">Jump</button>' +
        '<button class="t-crouch" data-hold="' + A.CROUCH + '" aria-label="Crouch">Duck</button>' +
        '<button class="t-use" data-tap="' + A.USE + '" aria-label="Use, evolve, build">Use</button>' +
        '<button class="t-reload" data-tap="' + A.RELOAD + '" aria-label="Reload">Rld</button>' +
        '<button class="t-weap" data-tap="' + A.NEXT + '" aria-label="Next weapon">Wpn</button>' +
      '</div>' +
      '<div class="t-pick" hidden><p class="t-pick-title"></p><div class="t-pick-row"></div><div class="t-pick-alt"></div></div>';
    root.hidden = false;
    var pick = root.querySelector('.t-pick');
    var stick = root.querySelector('.t-stick');
    var knob = stick.querySelector('b');
    var sensBtn = root.querySelector('[data-ui="sens"]');

    // ---------- state: game controls vs. menu-as-mouse
    var mode = '';
    function setMode(m) {
      if (m === mode) return;
      mode = m;
      root.setAttribute('data-mode', m);
      releaseAll();
      touches = {};
      stick.classList.remove('on');
      stick.style.left = stick.style.top = ''; knob.style.transform = '';
      M._Overmind_Pointer(-1, -1);
    }
    // ---------- engine strings: cvars in, console commands out
    var namePtr = 0;
    function cstr(s) {
      var n = s.length * 3 + 1, p = M._malloc(n);
      M.stringToUTF8(s, p, n);
      return p;
    }
    function command(text) {
      var p = cstr(text);
      M._Overmind_Command(p);
      M._free(p);
    }
    function playerState() {
      if (!M._Cvar_VariableString || !M.UTF8ToString) return null;
      if (!namePtr) namePtr = cstr('overmind_state');
      var v = M.UTF8ToString(M._Cvar_VariableString(namePtr)).split(' ').map(Number);
      return v.length >= 3 ? { team: v[0], cls: v[1], pm: v[2], stage: v[3] || 0 } : null;
    }
    // the game skips its small team/spawn menus when this is set (cgame patch)
    command('set overmind_touch 1');
    command('set cg_disableWarningDialogs 1');

    // ---------- large team and spawn pickers
    var TEAMS = { 1: 'Aliens', 2: 'Humans' };
    var SPAWNS = {
      1: [['level0', 'Dretch', 'Fast biter. Kill to evolve.'], ['builder', 'Granger', 'Builds the alien base.']],
      2: [['rifle', 'Rifle', 'Soldier. Earn credits, buy gear.'], ['ckit', 'Builder', 'Builds the human base.']]
    };
    var pickKey = '', pickHold = 0;
    function button(cmd, label, sub, cls) {
      return '<button class="' + (cls || '') + '" data-pick="' + cmd + '"><b>' + label + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</button>';
    }
    function showPick(st) {
      var key = !st ? '' : st.team === 0 ? 'team' : st.cls === 0 && st.pm !== 5 ? 'spawn' + st.team : '';
      if (Date.now() < pickHold) key = '';
      if (key === pickKey) return;
      pickKey = key;
      pick.hidden = !key;
      root.toggleAttribute('data-picking', !!key);
      if (!key) return;
      var title = pick.querySelector('.t-pick-title'), row = pick.querySelector('.t-pick-row'), alt = pick.querySelector('.t-pick-alt');
      if (key === 'team') {
        title.textContent = 'Choose your side';
        row.innerHTML = button('team aliens', 'Aliens', 'Evolve and overrun', 'p-alien') +
                        button('team humans', 'Humans', 'Build, buy and defend', 'p-human');
        alt.innerHTML = button('team auto', 'Auto', '', 'p-small');
      } else {
        title.textContent = TEAMS[st.team] + ': spawn as';
        row.innerHTML = SPAWNS[st.team].map(function (s) {
          return button('class ' + s[0], s[1], s[2], st.team === 1 ? 'p-alien' : 'p-human');
        }).join('');
        alt.innerHTML = button(st.team === 1 ? 'team humans' : 'team aliens', 'Switch to ' + TEAMS[st.team === 1 ? 2 : 1], '', 'p-small');
      }
    }

    var pollN = 0;
    function poll() {
      var s = M._Overmind_State();
      var inGame = (s & 0x100) && !(s & 0x7);
      // KEYCATCH_UI (2) / CONSOLE (1) / MESSAGE (4) or not in a game: menus
      setMode(inGame ? 'game' : 'menu');
      if ((pollN++ & 1) === 0) showPick(inGame ? playerState() : null);
    }
    var pollTimer = setInterval(poll, 120);
    poll();

    // ---------- touches
    var touches = {};          // identifier -> { kind, ... }
    var LOOK_GAIN = 2.6;       // mouse counts per CSS pixel at look 1.0
    var lookRemX = 0, lookRemY = 0;

    function look(dx, dy) {
      var g = LOOK_GAIN * settings.look;
      var x = dx * g + lookRemX, y = dy * g + lookRemY;
      var ix = Math.trunc(x), iy = Math.trunc(y);
      lookRemX = x - ix; lookRemY = y - iy;
      M._Overmind_Look(ix, iy);
    }

    function canvasPoint(t) {
      var r = canvas.getBoundingClientRect();
      return [Math.round((t.clientX - r.left) * canvas.width / r.width),
              Math.round((t.clientY - r.top) * canvas.height / r.height)];
    }

    var STICK_R = 56, DEAD = 0.3;
    function updateStick(o, t) {
      var dx = t.clientX - o.x0, dy = t.clientY - o.y0;
      var d = Math.hypot(dx, dy);
      if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
      knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      var nx = dx / STICK_R, ny = dy / STICK_R;
      act(A.FWD, ny < -DEAD); act(A.BACK, ny > DEAD);
      act(A.LEFT, nx < -DEAD); act(A.RIGHT, nx > DEAD);
    }

    function start(e) {
      wakeAudio();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var pk = t.target.closest ? t.target.closest('[data-pick]') : null;
        if (pk) {
          command(pk.getAttribute('data-pick'));
          pk.classList.add('down');
          pickHold = Date.now() + 1500; // until the server has answered
          showPick(null);
          continue;
        }
        if (mode === 'menu') {
          var p = canvasPoint(t);
          M._Overmind_Pointer(p[0], p[1]);
          touches[t.identifier] = { kind: 'menu' };
          // let the cursor land for a frame before the click
          setTimeout(function () { act(A.FIRE, 1); }, 40);
          continue;
        }
        var el = t.target.closest ? t.target.closest('[data-hold],[data-tap],[data-zone],[data-ui]') : null;
        if (!el) continue;
        if (el.hasAttribute('data-ui')) { cycleSens(); continue; }
        if (el.hasAttribute('data-tap')) { tap(+el.getAttribute('data-tap')); el.classList.add('down'); setTimeout(function (b) { b.classList.remove('down'); }.bind(null, el), 120); continue; }
        if (el.hasAttribute('data-hold')) {
          var a = +el.getAttribute('data-hold');
          act(a, 1); el.classList.add('down');
          touches[t.identifier] = { kind: 'hold', a: a, el: el, look: el.hasAttribute('data-look'), x: t.clientX, y: t.clientY };
          continue;
        }
        var zone = el.getAttribute('data-zone');
        if (zone === 'move') {
          stick.style.left = t.clientX + 'px'; stick.style.top = t.clientY + 'px';
          stick.classList.add('on'); knob.style.transform = '';
          touches[t.identifier] = { kind: 'move', x0: t.clientX, y0: t.clientY };
        } else if (zone === 'look') {
          touches[t.identifier] = { kind: 'look', x: t.clientX, y: t.clientY };
        }
      }
      e.preventDefault();
    }

    function move(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i], o = touches[t.identifier];
        if (!o) continue;
        if (o.kind === 'menu') { var p = canvasPoint(t); M._Overmind_Pointer(p[0], p[1]); }
        else if (o.kind === 'move') updateStick(o, t);
        else if (o.kind === 'look' || (o.kind === 'hold' && o.look)) {
          look(t.clientX - o.x, t.clientY - o.y);
          o.x = t.clientX; o.y = t.clientY;
        }
      }
      e.preventDefault();
    }

    function end(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i], o = touches[t.identifier];
        if (!o) continue;
        delete touches[t.identifier];
        if (o.kind === 'menu') setTimeout(function () { act(A.FIRE, 0); }, 60);
        else if (o.kind === 'hold') { act(o.a, 0); o.el.classList.remove('down'); }
        else if (o.kind === 'move') {
          stick.classList.remove('on');
          stick.style.left = stick.style.top = ''; knob.style.transform = '';
          act(A.FWD, 0); act(A.BACK, 0); act(A.LEFT, 0); act(A.RIGHT, 0);
        }
      }
      e.preventDefault();
    }

    root.addEventListener('touchstart', start, { passive: false });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end, { passive: false });
    root.addEventListener('touchcancel', end, { passive: false });
    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // ---------- look speed: tap to cycle 0.6 .. 2.0
    var steps = [0.6, 0.8, 1, 1.25, 1.5, 2];
    function cycleSens() {
      var i = steps.indexOf(settings.look);
      settings.look = steps[(i + 1) % steps.length];
      sensBtn.textContent = 'Look ' + settings.look.toFixed(1);
      save();
    }

    // ---------- iOS/Android only start audio after a touch
    function wakeAudio() {
      var ctx = M.SDL2 && M.SDL2.audioContext;
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
    }

    // background tab or app switch: let go of everything
    document.addEventListener('visibilitychange', function () { if (document.hidden) { releaseAll(); touches = {}; } });

    return { detach: function () { clearInterval(pollTimer); releaseAll(); root.hidden = true; } };
  }

  window.OvermindTouch = { attach: attach };
})();
