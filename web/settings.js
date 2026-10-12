// Tremulous Overmind – PC controls: rebindable keys, mouse settings, raw mouse input.
//
// INTEGRATION (play.js / index.html, nothing else needed):
//   1. index.html: <script src="settings.js" defer></script> BEFORE play.js (no inline code, CSP-safe).
//      Loading early matters: the key/mouse guard below must be registered before the engine's
//      own window listeners so that, while the panel is open, keys never reach the game.
//   2. As early as possible (before the engine starts):  OvermindSettings.installPointerLockPatch();
//   3. When building the engine args (desktop only – touch.js relies on the stock keys w/a/s/d,
//      ENTER, MWHEELUP ... so skip this on touch-first devices):
//        if (!isTouch) args = args.concat(OvermindSettings.args());
//   4. A settings button / menu entry:
//        OvermindSettings.open(function (cmd) { /* run cmd in the engine console, e.g.
//          M.ccall('Cbuf_AddText', ...) or the existing console bridge */ });
//      open() releases pointer lock itself. OvermindSettings.isOpen() / close() for the rest.
//
// Engine facts this relies on (verified in src/):
//   - default binds: data-1.3.0.pk3 / data-web-1.3.1.pk3 default.cfg; ui_shared.c g_bindings[]
//   - sprint = +button8 (BUTTON_SPRINT 256 = 1<<8, q_shared.h), dodge = +button6 (BUTTON_DODGE 64),
//     use structure/evolve = +button7 (BUTTON_USE_EVOLVE 128), activate upgrade = +button2
//     (BUTTON_USE_HOLDABLE 4), secondary attack = +button5 (BUTTON_ATTACK2 32)
//   - key names: client/cl_keys.cpp keynames[]; ';' must be written SEMICOLON
//   - the command line is split at '+' outside quotes (Com_ParseCommandLine), so every bound
//     command is quoted in args().
//   - Tremulous 1.3/GPP has no cg_fov: FOV is fixed per class (cg_view.c CG_CalcFov), so there
//     is deliberately no FOV slider.
(function () {
  'use strict';

  var STORE = 'overmind.settings';
  var PITCH = 0.022;

  // id, label, engine command, default keys [primary, secondary], group
  var ACTIONS = [
    ['forward', 'Move forward', '+forward', ['w', 'UPARROW'], 'move'],
    ['back', 'Move back', '+back', ['s', 'DOWNARROW'], 'move'],
    ['left', 'Strafe left', '+moveleft', ['a', ''], 'move'],
    ['right', 'Strafe right', '+moveright', ['d', ''], 'move'],
    ['jump', 'Jump', '+moveup', ['SPACE', ''], 'move'],
    ['crouch', 'Crouch / wallwalk', '+movedown', ['c', ''], 'move'],
    ['sprint', 'Sprint', '+button8', ['x', ''], 'move'],
    ['dodge', 'Dodge', '+button6', ['v', ''], 'move'],
    ['attack', 'Primary fire', '+attack', ['MOUSE1', 'CTRL'], 'fight'],
    ['attack2', 'Secondary fire', '+button5', ['MOUSE2', ''], 'fight'],
    ['reload', 'Reload', 'reload', ['r', ''], 'fight'],
    ['weapnext', 'Next weapon', 'weapnext', ['MWHEELDOWN', ']'], 'fight'],
    ['weapprev', 'Previous weapon', 'weapprev', ['MWHEELUP', '['], 'fight'],
    ['upgrade', 'Activate upgrade', '+button2', ['ENTER', 'MOUSE3'], 'fight'],
    ['use', 'Use structure / evolve', '+button7', ['q', ''], 'base'],
    ['decon', 'Deconstruct', 'deconstruct', ['e', ''], 'base'],
    ['medkit', 'Use medkit', 'itemact medkit', ['m', ''], 'base'],
    ['ammo', 'Buy ammo', 'buy ammo', ['b', ''], 'base'],
    ['scores', 'Scoreboard', '+scores', ['TAB', ''], 'talk'],
    ['chat', 'Chat', 'messagemode', ['t', ''], 'talk'],
    ['teamchat', 'Team chat', 'messagemode2', ['y', ''], 'talk'],
    ['voteyes', 'Vote yes', 'vote yes', ['F1', ''], 'talk'],
    ['voteno', 'Vote no', 'vote no', ['F2', ''], 'talk']
  ];
  var GROUPS = [['move', 'Movement'], ['fight', 'Combat'], ['base', 'Building & items'], ['talk', 'Team & chat']];
  var DEFAULTS = { sensitivity: 5, invert: false, raw: true };

  // ---------- state ----------
  function defaultBinds() {
    var b = {};
    ACTIONS.forEach(function (a) { b[a[0]] = a[3].slice(); });
    return b;
  }
  var state = { binds: defaultBinds(), sensitivity: DEFAULTS.sensitivity, invert: DEFAULTS.invert, raw: DEFAULTS.raw };
  var rawUnsupported = false;

  function load() {     // called once the key tables below exist
    var s;
    try { s = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') return;
    if (s.binds && typeof s.binds === 'object') {
      var stored = {}, seen = {};
      ACTIONS.forEach(function (a) {
        var v = s.binds[a[0]];
        if (Array.isArray(v) && v.length === 2) {
          stored[a[0]] = 1;
          state.binds[a[0]] = [validKey(v[0]) ? v[0] : '', validKey(v[1]) ? v[1] : ''];
        }
      });
      // one key, one action: saved choices win over defaults of actions added later
      [true, false].forEach(function (pass) {
        ACTIONS.forEach(function (a) {
          if (!!stored[a[0]] !== pass) return;
          var b = state.binds[a[0]];
          for (var i = 0; i < 2; i++) {
            if (b[i] && seen[b[i]]) b[i] = '';
            else if (b[i]) seen[b[i]] = 1;
          }
        });
      });
    }
    var sens = parseFloat(s.sensitivity);
    if (isFinite(sens) && sens > 0 && sens <= 30) state.sensitivity = sens;
    if (typeof s.invert === 'boolean') state.invert = s.invert;
    if (typeof s.raw === 'boolean') state.raw = s.raw;
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  function action(id) {
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i][0] === id) return ACTIONS[i];
    return null;
  }
  // which action/slot currently holds key k
  function owner(k) {
    for (var i = 0; i < ACTIONS.length; i++) {
      var b = state.binds[ACTIONS[i][0]];
      if (b[0] === k) return { id: ACTIONS[i][0], slot: 0 };
      if (b[1] === k) return { id: ACTIONS[i][0], slot: 1 };
    }
    return null;
  }

  // ---------- key names (client/cl_keys.cpp keynames[]) ----------
  var CODE = {
    Space: 'SPACE', Tab: 'TAB', Enter: 'ENTER', Backspace: 'BACKSPACE', CapsLock: 'CAPSLOCK', Pause: 'PAUSE',
    ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL', AltLeft: 'ALT', AltRight: 'ALT',
    ArrowUp: 'UPARROW', ArrowDown: 'DOWNARROW', ArrowLeft: 'LEFTARROW', ArrowRight: 'RIGHTARROW',
    Insert: 'INS', Delete: 'DEL', Home: 'HOME', End: 'END', PageUp: 'PGUP', PageDown: 'PGDN',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\',
    Semicolon: 'SEMICOLON', Comma: ',', Period: '.', Slash: '/',
    Numpad0: 'KP_INS', Numpad1: 'KP_END', Numpad2: 'KP_DOWNARROW', Numpad3: 'KP_PGDN', Numpad4: 'KP_LEFTARROW',
    Numpad5: 'KP_5', Numpad6: 'KP_RIGHTARROW', Numpad7: 'KP_HOME', Numpad8: 'KP_UPARROW', Numpad9: 'KP_PGUP',
    NumpadDecimal: 'KP_DEL', NumpadEnter: 'KP_ENTER', NumpadAdd: 'KP_PLUS', NumpadSubtract: 'KP_MINUS',
    NumpadMultiply: 'KP_STAR', NumpadDivide: 'KP_SLASH', NumpadEqual: 'KP_EQUALS'
  };
  var NAMED = {};
  Object.keys(CODE).forEach(function (c) { NAMED[CODE[c]] = 1; });
  ['ESCAPE', 'MOUSE1', 'MOUSE2', 'MOUSE3', 'MOUSE4', 'MOUSE5', 'MWHEELUP', 'MWHEELDOWN'].forEach(function (k) { NAMED[k] = 1; });
  for (var f = 1; f <= 12; f++) { CODE['F' + f] = 'F' + f; NAMED['F' + f] = 1; }
  load();

  function validKey(k) {
    return typeof k === 'string' && (k === '' || NAMED[k] === 1 || /^[a-z0-9]$/.test(k));
  }

  // Letters follow the layout (the engine binds SDL keysyms, so QWERTZ "z" is "z"),
  // digits/punctuation use the physical US position.
  function keyFromEvent(e) {
    var c = e.code || '';
    if (/^Key[A-Z]$/.test(c)) {
      return (e.key && /^[a-z]$/i.test(e.key)) ? e.key.toLowerCase() : c.charAt(3).toLowerCase();
    }
    if (/^Digit[0-9]$/.test(c)) return c.charAt(5);
    return CODE[c] || null;     // Backquote (console), Quote ('"' cannot be bound), Meta: not bindable
  }
  var MOUSE = ['MOUSE1', 'MOUSE3', 'MOUSE2', 'MOUSE4', 'MOUSE5']; // by MouseEvent.button

  var PRETTY = {
    SPACE: 'Space', TAB: 'Tab', ENTER: 'Enter', BACKSPACE: 'Backspace', CAPSLOCK: 'Caps Lock', PAUSE: 'Pause',
    SHIFT: 'Shift', CTRL: 'Ctrl', ALT: 'Alt', UPARROW: '↑', DOWNARROW: '↓', LEFTARROW: '←', RIGHTARROW: '→',
    INS: 'Ins', DEL: 'Del', HOME: 'Home', END: 'End', PGUP: 'Pg Up', PGDN: 'Pg Dn', SEMICOLON: ';',
    MOUSE1: 'Mouse 1', MOUSE2: 'Mouse 2', MOUSE3: 'Mouse 3', MOUSE4: 'Mouse 4', MOUSE5: 'Mouse 5',
    MWHEELUP: 'Wheel up', MWHEELDOWN: 'Wheel dn'
  };
  function pretty(k) {
    if (!k) return '—';
    if (PRETTY[k]) return PRETTY[k];
    if (k.indexOf('KP_') === 0) return 'Num ' + k.slice(3).replace('ARROW', '').toLowerCase();
    return k.toUpperCase();
  }

  // ---------- engine args ----------
  function pitch() { return String(state.invert ? -PITCH : PITCH); }
  function args() {
    var out = [], used = {};
    ACTIONS.forEach(function (a) {
      state.binds[a[0]].forEach(function (k) {
        if (!k) return;
        used[k] = 1;
        out.push('+bind', k, '"' + a[2] + '"');   // quoted: the command line splits at '+'
      });
    });
    // stock keys the player moved away: drop them, or default.cfg/autogen.cfg would keep them
    ACTIONS.forEach(function (a) {
      a[3].forEach(function (k) { if (k && !used[k]) { used[k] = 1; out.push('+unbind', k); } });
    });
    out.push('+set', 'sensitivity', String(state.sensitivity), '+set', 'm_pitch', pitch());
    return out;
  }

  // ---------- raw mouse (pointer lock without OS acceleration) ----------
  function installPointerLockPatch() {
    var proto = window.Element && Element.prototype;
    if (!proto || !proto.requestPointerLock || proto.requestPointerLock.__overmindRaw) return;
    var orig = proto.requestPointerLock;
    var patched = function (opts) {
      var self = this, plainArgs = arguments;
      if (!state.raw || rawUnsupported) return orig.apply(self, plainArgs);
      var o = {};
      if (opts && typeof opts === 'object') for (var k in opts) o[k] = opts[k];
      o.unadjustedMovement = true;
      var r;
      try { r = orig.call(self, o); } catch (e) { rawUnsupported = true; return orig.apply(self, plainArgs); }
      if (r && typeof r.then === 'function') {
        return r.then(null, function (err) {
          if (err && err.name === 'NotSupportedError') {
            rawUnsupported = true; updateRawNote();
            return orig.apply(self, plainArgs);
          }
          throw err;
        });
      }
      return r;
    };
    patched.__overmindRaw = true;
    proto.requestPointerLock = patched;
    // a subclass that defines its own copy would bypass the Element patch
    if (window.HTMLCanvasElement && Object.prototype.hasOwnProperty.call(HTMLCanvasElement.prototype, 'requestPointerLock')) {
      HTMLCanvasElement.prototype.requestPointerLock = patched;
    }
  }

  // ---------- panel ----------
  var root = null, statusEl = null, rawNote = null, rowEls = {};
  var send = function () {};
  var capture = null;          // { id, slot, btn }
  var swallowClick = false;
  var lastFocus = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function say(msg) { if (statusEl) statusEl.textContent = msg; }

  function cmdBind(k, cmd) { send('bind ' + k + ' "' + cmd + '"'); }

  function slotLabel(a, slot) {
    var k = state.binds[a[0]][slot];
    return a[1] + ', ' + (slot ? 'secondary' : 'primary') + ' key: ' + (k ? pretty(k) : 'none') + '. Press to change.';
  }
  function paintRow(id) {
    var a = action(id), r = rowEls[id];
    if (!r) return;
    for (var s = 0; s < 2; s++) {
      var k = state.binds[id][s];
      r.slots[s].textContent = pretty(k);
      r.slots[s].classList.toggle('empty', !k);
      r.slots[s].setAttribute('aria-label', slotLabel(a, s));
    }
  }
  function paintAll() { ACTIONS.forEach(function (a) { paintRow(a[0]); }); }

  function assign(id, slot, k) {
    var a = action(id), b = state.binds[id], old = b[slot];
    if (old === k) { say(pretty(k) + ' is already ' + a[1] + '.'); return; }
    var prev = owner(k), msg = pretty(k) + ' → ' + a[1];
    if (prev) {
      state.binds[prev.id][prev.slot] = '';
      msg += ' (taken from ' + action(prev.id)[1] + ')';
      paintRow(prev.id);
    }
    b[slot] = k;
    if (old && !owner(old)) send('unbind ' + old);
    cmdBind(k, a[2]);
    save(); paintRow(id); say(msg + '.');
  }

  function clearRow(id) {
    var b = state.binds[id];
    b.forEach(function (k) { if (k) send('unbind ' + k); });
    state.binds[id] = ['', ''];
    save(); paintRow(id); say(action(id)[1] + ' unbound.');
  }

  function startCapture(id, slot, btn) {
    stopCapture();
    capture = { id: id, slot: slot, btn: btn };
    btn.classList.add('listening');
    btn.textContent = 'Press a key';
    say('Press a key or mouse button for ' + action(id)[1] + ' – Esc cancels.');
  }
  function stopCapture() {
    if (!capture) return;
    capture.btn.classList.remove('listening');
    var id = capture.id;
    capture = null;
    paintRow(id);
  }
  function finishCapture(k) {
    var c = capture;
    stopCapture();
    assign(c.id, c.slot, k);
    c.btn.focus();
  }

  function applyCvars() {
    send('set sensitivity ' + state.sensitivity);
    send('set m_pitch ' + pitch());
  }

  function resetAll() {
    stopCapture();
    var defs = defaultBinds(), wanted = {};
    ACTIONS.forEach(function (a) { defs[a[0]].forEach(function (k) { if (k) wanted[k] = 1; }); });
    ACTIONS.forEach(function (a) {
      state.binds[a[0]].forEach(function (k) { if (k && !wanted[k]) send('unbind ' + k); });
    });
    state.binds = defs;
    ACTIONS.forEach(function (a) { defs[a[0]].forEach(function (k) { if (k) cmdBind(k, a[2]); }); });
    state.sensitivity = DEFAULTS.sensitivity; state.invert = DEFAULTS.invert; state.raw = DEFAULTS.raw;
    applyCvars(); save();
    build();            // repaint sliders/toggles too
    say('Defaults restored.');
  }

  function updateRawNote() {
    if (rawNote) rawNote.textContent = rawUnsupported
      ? 'Not supported by this browser – using normal pointer lock.'
      : 'Bypasses OS mouse acceleration. Applies the next time the mouse is captured.';
  }

  function build() {
    var focusId = document.activeElement && document.activeElement.id;
    if (root) root.parentNode.removeChild(root);
    rowEls = {};

    root = el('div', 'om-set');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'om-set-title');

    var box = el('div', 'om-set-box');
    var head = el('div', 'om-set-head');
    var h = el('h2', 'om-set-title', 'Controls'); h.id = 'om-set-title';
    var x = el('button', 'om-set-x', '×'); x.type = 'button'; x.id = 'om-set-x';
    x.setAttribute('aria-label', 'Close controls');
    x.addEventListener('click', close);
    head.appendChild(h); head.appendChild(x);

    var body = el('div', 'om-set-body');

    // mouse
    var mouse = el('section', 'om-set-sec om-set-mouse');
    mouse.appendChild(el('h3', 'om-set-h', 'Mouse'));

    var sens = el('div', 'om-set-field');
    var sl = el('label', null, 'Sensitivity'); sl.htmlFor = 'om-set-sens';
    var range = el('input'); range.type = 'range'; range.id = 'om-set-sens';
    range.min = '0.5'; range.max = '20'; range.step = '0.1'; range.value = String(state.sensitivity);
    var out = el('output', 'om-set-val', state.sensitivity.toFixed(1)); out.htmlFor = 'om-set-sens';
    range.addEventListener('input', function () {
      state.sensitivity = Math.round(parseFloat(range.value) * 10) / 10;
      out.textContent = state.sensitivity.toFixed(1);
      send('set sensitivity ' + state.sensitivity);
      save();
    });
    sens.appendChild(sl); sens.appendChild(range); sens.appendChild(out);
    mouse.appendChild(sens);

    function toggle(id, label, key, onChange, note) {
      var w = el('div', 'om-set-check');
      var cb = el('input'); cb.type = 'checkbox'; cb.id = id; cb.checked = !!state[key];
      var lb = el('label', null, label); lb.htmlFor = id;
      cb.addEventListener('change', function () { state[key] = cb.checked; save(); onChange(); });
      w.appendChild(cb); w.appendChild(lb);
      if (note) { w.appendChild(note); cb.setAttribute('aria-describedby', note.id); }
      mouse.appendChild(w);
    }
    toggle('om-set-inv', 'Invert vertical look', 'invert', function () {
      send('set m_pitch ' + pitch()); say(state.invert ? 'Vertical look inverted.' : 'Vertical look normal.');
    });
    rawNote = el('small', 'om-set-note'); rawNote.id = 'om-set-rawnote'; updateRawNote();
    toggle('om-set-raw', 'Raw mouse input', 'raw', function () {
      say(state.raw ? 'Raw input on.' : 'Raw input off.');
    }, rawNote);
    body.appendChild(mouse);

    // bindings
    GROUPS.forEach(function (g) {
      var sec = el('section', 'om-set-sec');
      var hh = el('h3', 'om-set-h', g[1]);
      hh.id = 'om-set-g-' + g[0];
      sec.appendChild(hh);
      var list = el('ul', 'om-set-list');
      list.setAttribute('aria-labelledby', hh.id);
      ACTIONS.forEach(function (a) {
        if (a[4] !== g[0]) return;
        var li = el('li', 'om-set-row');
        li.appendChild(el('span', 'om-set-name', a[1]));
        var slots = [];
        for (var s = 0; s < 2; s++) {
          (function (slot) {
            var bt = el('button', 'om-set-key'); bt.type = 'button';
            bt.id = 'om-set-k-' + a[0] + '-' + slot;
            bt.addEventListener('click', function () {
              if (capture && capture.btn === bt) { stopCapture(); say('Cancelled.'); return; }
              startCapture(a[0], slot, bt);
            });
            slots.push(bt); li.appendChild(bt);
          })(s);
        }
        var clr = el('button', 'om-set-clr', '×'); clr.type = 'button';
        clr.id = 'om-set-c-' + a[0];
        clr.setAttribute('aria-label', 'Clear ' + a[1]);
        clr.addEventListener('click', function () { stopCapture(); clearRow(a[0]); });
        li.appendChild(clr);
        rowEls[a[0]] = { slots: slots };
        list.appendChild(li);
      });
      sec.appendChild(list);
      body.appendChild(sec);
    });

    var foot = el('div', 'om-set-foot');
    statusEl = el('p', 'om-set-status');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    var reset = el('button', 'om-set-btn ghost', 'Reset to defaults'); reset.type = 'button'; reset.id = 'om-set-reset';
    reset.addEventListener('click', resetAll);
    var done = el('button', 'om-set-btn', 'Done'); done.type = 'button'; done.id = 'om-set-done';
    done.addEventListener('click', close);
    foot.appendChild(statusEl); foot.appendChild(reset); foot.appendChild(done);

    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    root.appendChild(box);
    document.body.appendChild(root);
    paintAll();

    var f = focusId && document.getElementById(focusId);
    (f || done).focus();
  }

  function focusables() {
    return root ? Array.prototype.slice.call(root.querySelectorAll('button, input')) : [];
  }

  function open(sendCommand) {
    send = typeof sendCommand === 'function' ? sendCommand : function () {};
    lastFocus = document.activeElement;
    try { if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); } catch (e) { /* ignore */ }
    if (!root) build();
    else { paintAll(); focusables()[0].focus(); }
    say('Click a key slot, then press the new key or mouse button.');
  }
  function close() {
    stopCapture();
    if (root) { root.parentNode.removeChild(root); root = null; statusEl = null; rawNote = null; rowEls = {}; }
    swallowClick = false;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
    lastFocus = null;
  }
  function isOpen() { return !!root; }

  // ---------- input guard ----------
  // Window capture listeners registered at load, i.e. before the engine's: while the panel is
  // open no key, button or wheel event reaches the game, and capture mode reads them here.
  function guard(e) {
    if (!root) return;
    var t = e.type;
    if (t === 'click' || t === 'auxclick') {
      if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    e.stopImmediatePropagation();
    if (t === 'contextmenu') { e.preventDefault(); return; }
    // the click that follows a captured button press is swallowed; if it never comes
    // (released elsewhere), forget it right after the mouseup
    if (t === 'mouseup' && swallowClick) setTimeout(function () { swallowClick = false; }, 0);

    if (capture) {
      if (t === 'keydown') {
        e.preventDefault();
        if (e.repeat) return;
        if (e.code === 'Escape' || e.key === 'Escape') { var b = capture.btn; stopCapture(); b.focus(); say('Cancelled.'); return; }
        var k = keyFromEvent(e);
        if (k) finishCapture(k);
        else say('That key cannot be bound here.');
      } else if (t === 'keyup' || t === 'keypress') {
        e.preventDefault();
      } else if (t === 'mousedown') {
        e.preventDefault();
        swallowClick = true;
        var m = MOUSE[e.button];
        if (m) finishCapture(m);
      } else if (t === 'mouseup') {
        e.preventDefault();
      } else if (t === 'wheel') {
        e.preventDefault();
        if (e.deltaY) finishCapture(e.deltaY < 0 ? 'MWHEELUP' : 'MWHEELDOWN');
      }
      return;
    }

    if (t === 'keydown') {
      if (e.key === 'Escape' || e.key === 'F10') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {                       // keep focus inside the dialog
        var list = focusables(), i = list.indexOf(document.activeElement);
        if (!list.length) return;
        if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
        else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
      }
    }
  }
  if (window.addEventListener) {
    ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'].forEach(function (t) {
      window.addEventListener(t, guard, true);
    });
    window.addEventListener('wheel', guard, { capture: true, passive: false });
  }

  window.OvermindSettings = {
    args: args,
    open: open,
    close: close,
    isOpen: isOpen,
    installPointerLockPatch: installPointerLockPatch
  };
})();
