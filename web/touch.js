// Tremulous Overmind – touch controls for phones and tablets.
// Talks to the engine through the Overmind_* exports (engine patch 0003): actions go
// through the normal key bindings, looking is fed as mouse motion, and in menus a
// finger works like a mouse. Loaded by play.js only on touch-first devices.
(function () {
  'use strict';

  // action ids, see overmindActionKeys[] in sdl_input.cpp
  // (USE = ENTER is "activate upgrade"; use structure / evolve is +button7, sent as a command)
  var A = { FWD: 0, BACK: 1, LEFT: 2, RIGHT: 3, JUMP: 4, CROUCH: 5, FIRE: 6, ALT: 7,
            USE: 8, RELOAD: 9, PREV: 10, NEXT: 11, SCORES: 12, MENU: 13, MEDKIT: 14, AMMO: 15, DECON: 16 };
  // console commands behind buttons that have no action key
  var CMD = {
    use: ['+button7', '-button7'],          // armoury, evolve, build menu, medistation ...
    gren: ['itemact gren'],
    jet: ['itemtoggle jetpack']
  };
  // game enums (bg_public.h) used to pick contextual buttons
  var PM_JETPACK = 3, PM_DEAD = 5, PCL_ALIEN_BUILDER0 = 1, PCL_ALIEN_BUILDER0_UPG = 2;
  var WP_HBUILD = 26, WP_LUCIFER = 18, UP_JETPACK = 5, UP_GRENADE = 7;
  // per alien class (PCL_*): primary label, secondary attack, third attack (+button2),
  // wallwalk; from bg_misc.c / bg_pmove.c. Buttons a class can't use are not shown.
  var ALIEN = {
    1: { fire: 'Build', alt: 'Cancel' },                                   // granger
    2: { fire: 'Build', alt: 'Cancel', third: 'Spit', wall: true },        // adv. granger
    3: { fire: 'Bite', wall: true },                                       // dretch
    4: { fire: 'Claw', wall: true },                                       // basilisk
    5: { fire: 'Claw', alt: 'Gas', wall: true },                           // adv. basilisk
    6: { fire: 'Claw' },                                                   // marauder
    7: { fire: 'Claw', alt: 'Zap' },                                       // adv. marauder
    8: { fire: 'Claw', alt: 'Pounce' },                                    // dragoon
    9: { fire: 'Claw', alt: 'Pounce', third: 'Barbs' },                    // adv. dragoon
    10: { fire: 'Claw', alt: 'Charge' }                                    // tyrant
  };

  var STORE = 'overmind.touch';
  // autofire: the game shoots while the crosshair is on an enemy in reach (cgame sets
  // overmind_aim), so the right thumb only aims - one thumb can't aim and press fire
  var settings = { look: 1, layout: 'right', gyro: false, haptics: true, size: 'm', autofire: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* defaults */ }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* private mode */ } }

  var AIM_STEPS = [0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5];
  var SIZES = { s: 0.85, m: 1, l: 1.18 };

  // look response: 1:1 for every normal drag, so the same swipe always turns the same
  // amount (muscle memory); only real flicks get a boost to turn around quickly;
  // vertical a bit calmer than horizontal
  var LOOK_GAIN = 2.8;         // mouse counts per CSS pixel at aim 1.0, accel 1.0
  var ACCEL_FROM = 1.4;        // finger speed (px/ms) where acceleration starts (a flick)
  var ACCEL_K = 0.4;           // extra multiplier per px/ms above that
  var ACCEL_MAX = 1.7;         // cap for flicks
  var LOOK_Y = 0.8;            // vertical / horizontal
  var AIM_FRICTION = 0.8;      // look speed while the crosshair is on an enemy in reach
  // gyro: rotation rate (deg/s) -> mouse counts
  var GYRO_GAIN = 6;           // counts per degree at aim 1.0 (about 1:1 at sensitivity 7)
  var GYRO_DZ = 1.5;           // deg/s deadzone against sensor drift and hand tremor
  var GYRO_SMOOTH = 0.45;      // EMA factor, 1 = raw
  // floating stick
  var STICK_R = 56, DEAD = 0.3;
  var SPRINT_PUSH = 0.95, SPRINT_HOLD_MS = 300, SPRINT_DROP = 0.6, DOUBLE_TAP_MS = 300;
  // soft buttons: a touch that slides further than this is aiming, not a tap; a thumb
  // resting longer than this before lifting was resting, not tapping
  var SOFT_SLOP = 12, SOFT_MAX_MS = 450;

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function attach(frame, M) {
    var root = document.getElementById('touch');
    var canvas = frame.querySelector('canvas');
    if (!root || !M || !M._Overmind_Action) return null;

    // ---------- shared state (declared first: poll() runs during attach)
    var touches = {};          // identifier -> { kind, ... }
    var pressed = {};
    var mode = '';
    var sprinting = false;
    var lastState = null;      // last overmind_state read while in game
    var lastMoveEnd = null;    // for double-tap-and-hold sprint
    var lookRemX = 0, lookRemY = 0;

    function act(a, down) {
      down = down ? 1 : 0;
      if (!!pressed[a] === !!down) return;
      pressed[a] = down;
      M._Overmind_Action(a, down);
    }
    function releaseAll() {
      Object.keys(pressed).forEach(function (a) { act(+a, 0); });
      root.querySelectorAll('[data-toggle].on').forEach(function (b) { b.classList.remove('on'); });
      autoOn = false;
      setSprint(false);
    }
    function tap(a) { act(a, 1); setTimeout(function () { act(a, 0); }, 60); }
    function buzz(ms) {
      if (!settings.haptics) return;
      try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* unsupported */ }
    }

    // ---------- markup (built here so the page stays clean without touch)
    function seg(name, opts) {
      return '<span class="t-seg">' + opts.map(function (o) {
        return '<button data-ui="' + name + ':' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</span>';
    }
    root.innerHTML =
      '<div class="t-zone t-move" data-zone="move"><i class="t-stick"><b></b><em>Sprint</em></i></div>' +
      '<div class="t-zone t-look" data-zone="look"></div>' +
      // second fire button for the left thumb: fire while the right thumb aims
      '<button class="t-lfire" data-hold="' + A.FIRE + '" aria-label="Fire (left hand)">Fire</button>' +
      '<div class="t-top">' +
        '<button data-tap="' + A.MENU + '" aria-label="Menu">Menu</button>' +
        '<button data-hold="' + A.SCORES + '" aria-label="Scores">Scores</button>' +
        '<button data-ui="chat" aria-label="Chat">Chat</button>' +
        '<button class="t-h" data-tap="' + A.MEDKIT + '" aria-label="Medkit">Med</button>' +
        '<button class="t-h" data-tap="' + A.AMMO + '" aria-label="Buy ammo">Ammo</button>' +
        '<button data-ui="gyro" aria-label="Gyro aiming">Gyro</button>' +
        '<button class="t-cog" data-ui="sheet" aria-label="Control settings">' +
          '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">' +
          '<path d="M2 4h12M2 8h12M2 12h12"/><rect x="4" y="2.5" width="2.5" height="3" fill="#000"/>' +
          '<rect x="9.5" y="6.5" width="2.5" height="3" fill="#000"/><rect x="5.5" y="10.5" width="2.5" height="3" fill="#000"/></svg>' +
        '</button>' +
      '</div>' +
      // Right thumb. Combat buttons (fire, alt, jump, third attack) act the moment they
      // are touched and keep aiming while the thumb slides. Every other button is "soft":
      // it only acts on a clean tap, so a thumb that lands on it to aim just aims. Gaps
      // between buttons belong to the look zone (the containers let touches through).
      '<div class="t-pad">' +
        '<button class="t-fire" data-hold="' + A.FIRE + '" data-look="1" aria-label="Fire">Fire</button>' +
        '<button class="t-alt" data-hold="' + A.ALT + '" data-look="1" aria-label="Alt fire">Alt</button>' +
        '<button class="t-jump" data-hold="' + A.JUMP + '" data-look="1" aria-label="Jump">Jump</button>' +
        // a toggle: holding it while moving and aiming would need a third thumb
        '<button class="t-crouch" data-toggle="' + A.CROUCH + '" data-soft="1" aria-label="Crouch">Duck</button>' +
        '<button class="t-reload" data-tap="' + A.RELOAD + '" data-soft="1" aria-label="Reload">Rld</button>' +
        // aliens never reload: their third attack takes that spot
        '<button class="t-third" data-ctx="third" data-hold="' + A.USE + '" data-look="1" aria-label="Third attack" hidden>3rd</button>' +
        // rail on the right edge, above the cluster: everything that isn't combat
        '<div class="t-rail">' +
          '<button class="t-use" data-cmd="use" data-soft="1" aria-label="Use, evolve, build">Use</button>' +
          '<button class="t-weap" data-tap="' + A.NEXT + '" data-soft="1" aria-label="Next weapon">Wpn</button>' +
          // contextual: shown from the player's class and inventory (poll)
          '<button data-ctx="build" data-ui="build" aria-label="Build menu" hidden>Build</button>' +
          '<button data-ctx="decon" data-tap="' + A.DECON + '" data-soft="1" aria-label="Deconstruct" hidden>Decon</button>' +
          '<button data-ctx="gren" data-cmd="gren" data-soft="1" aria-label="Throw grenade" hidden>Gren</button>' +
          '<button data-ctx="jet" data-cmd="jet" data-soft="1" aria-label="Jetpack on or off" hidden>Jet</button>' +
        '</div>' +
      '</div>' +
      '<div class="t-hint" hidden></div>' +
      '<div class="t-vote" hidden><span></span>' +
        '<button data-vote="yes">Yes</button><button data-vote="no">No</button></div>' +
      '<div class="t-pick" hidden><p class="t-pick-title"></p><div class="t-pick-row"></div><div class="t-pick-alt"></div></div>' +
      '<form class="t-chat" hidden autocomplete="off">' +
        '<input type="text" maxlength="140" enterkeyhint="send" placeholder="Message" aria-label="Chat message">' +
        '<button type="submit" data-chat="say">All</button><button type="submit" data-chat="say_team">Team</button>' +
        '<button type="button" data-chat="cancel" aria-label="Close chat">&times;</button>' +
      '</form>' +
      '<div class="t-sheet" hidden role="dialog" aria-label="Control settings">' +
        '<p class="t-sheet-title">Controls</p>' +
        '<div class="t-row"><span>Aim speed</span><span class="t-seg">' +
          '<button data-ui="aim-" aria-label="Slower">&minus;</button><span class="t-val" data-val="aim"></span>' +
          '<button data-ui="aim+" aria-label="Faster">+</button></span></div>' +
        '<div class="t-row"><span>Auto fire</span>' + seg('autofire', [['0', 'Off'], ['1', 'On']]) + '</div>' +
        '<div class="t-row"><span>Gyro aim</span>' + seg('gyro', [['0', 'Off'], ['1', 'On']]) + '</div>' +
        '<div class="t-row"><span>Haptics</span>' + seg('haptics', [['0', 'Off'], ['1', 'On']]) + '</div>' +
        '<div class="t-row"><span>Buttons</span>' + seg('size', [['s', 'S'], ['m', 'M'], ['l', 'L']]) + '</div>' +
        '<div class="t-row"><span>Team</span><span class="t-seg"><button data-ui="switch">Switch side</button></span></div>' +
        '<button class="t-sheet-done" data-ui="close">Done</button>' +
      '</div>';
    root.hidden = false;
    var pick = root.querySelector('.t-pick');
    var sheet = root.querySelector('.t-sheet');
    var stick = root.querySelector('.t-stick');
    var knob = stick.querySelector('b');
    var voteBar = root.querySelector('.t-vote');
    var hint = root.querySelector('.t-hint');
    var chat = root.querySelector('.t-chat');
    var chatInput = chat.querySelector('input');
    var ctx = {};
    root.querySelectorAll('[data-ctx]').forEach(function (b) { ctx[b.getAttribute('data-ctx')] = b; });
    var pad = {};
    ['fire', 'lfire', 'alt', 'crouch', 'use', 'reload', 'weap'].forEach(function (k) { pad[k] = root.querySelector('.t-' + k); });
    function setBtn(b, label, show) {
      if (b.hidden === !show && (!show || b.textContent === label)) return;
      b.hidden = !show;
      if (show) { b.textContent = label; b.setAttribute('aria-label', label); }
      if (!show) {                     // let go if it was held when the class changed
        var a = b.getAttribute('data-hold') || b.getAttribute('data-toggle');
        if (a !== null) act(+a, 0);
        b.classList.remove('down', 'on');
      }
    }

    function resetStick() {
      stick.classList.remove('on');
      stick.style.left = stick.style.top = ''; knob.style.transform = '';
    }

    // ---------- state: game controls vs. menu-as-mouse
    function setMode(m) {
      if (m === mode) return;
      mode = m;
      root.setAttribute('data-mode', m);
      Object.keys(touches).forEach(function (id) { finish(id, null); });
      releaseAll();
      resetStick();
      M._Overmind_Pointer(-1, -1);
    }
    // ---------- engine strings: cvars in, console commands out
    var names = {};
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
    function cvar(name) {
      if (!M._Cvar_VariableString || !M.UTF8ToString) return '';
      if (!names[name]) names[name] = cstr(name);   // kept for the session
      return M.UTF8ToString(M._Cvar_VariableString(names[name]));
    }
    function playerState() {
      // "team class pm_type stage blueprint placeable buildpoints weapon" (cgame patch)
      var v = cvar('overmind_state').split(' ').map(Number);
      return v.length >= 3 ? { team: v[0], cls: v[1], pm: v[2], stage: v[3] || 0,
                               bp: v[4] || 0, ok: v[5] === 1, points: v[6] || 0, weap: v[7] || 0 } : null;
    }
    function runCmd(name) {
      var c = CMD[name];
      if (!c) return;
      command(c[0]);
      if (c[1]) setTimeout(function () { command(c[1]); }, 80);
    }
    // the game skips its small team/spawn menus when this is set (cgame patch)
    command('set overmind_touch 1');
    command('set cg_disableWarningDialogs 1');

    // ---------- sprint (humans): +button8 is BUTTON_SPRINT, not in the action key table
    function setSprint(on) {
      on = !!on;
      if (on && !(lastState && lastState.team === 2 && lastState.pm !== 5)) on = false;
      if (on === sprinting) return;
      sprinting = on;
      command(on ? '+button8' : '-button8');
      stick.classList.toggle('sprint', on);
      if (on) buzz(8);
    }

    // ---------- large team and spawn pickers
    var TEAMS = { 1: 'Aliens', 2: 'Humans' };
    var SPAWNS = {
      1: [['level0', 'Dretch', 'Fast biter. Kill to evolve.'], ['builder', 'Granger', 'Builds the alien base.'],
          ['builderupg', 'Adv. Granger', 'Faster builder, spits acid.', 1]],
      2: [['rifle', 'Rifle', 'Soldier. Earn credits, buy gear.'], ['ckit', 'Builder', 'Builds the human base.']]
    };
    // build picker: [build name, label, what it does, build points, first stage (0 = S1),
    // only stage 3, advanced granger only]; costs and stages from bg_misc.c / tremulous.h
    var BUILDS = {
      1: [['eggpod', 'Egg', 'Spawn point', 10], ['acid_tube', 'Acid Tube', 'Sprays acid', 8],
          ['barricade', 'Barricade', 'Blocks the way', 8], ['overmind', 'Overmind', 'Powers the hive', 0],
          ['trapper', 'Trapper', 'Locks humans', 8, 1, 0, 1], ['booster', 'Booster', 'Heals, poisons', 12, 1, 0, 1],
          ['hive', 'Hive', 'Swarm attack', 12, 2, 1, 1]],
      2: [['telenode', 'Telenode', 'Spawn point', 10], ['mgturret', 'Turret', 'Auto gun', 8],
          ['arm', 'Armoury', 'Buy gear', 10], ['medistat', 'Medistation', 'Heals', 8],
          ['reactor', 'Reactor', 'Powers the base', 0], ['repeater', 'Repeater', 'Extends power', 4],
          ['dcc', 'Defence Comp.', 'Repairs, aims', 8, 1], ['tesla', 'Tesla', 'Zaps aliens', 10, 2, 1]]
    };
    var WP_ABUILD = 24, WP_ABUILD2 = 25;
    var buildOpen = false;     // build picker requested (Build button or the game's build menu)
    var pendingBuild = '', pendingUntil = 0;   // chosen while the construction kit was still being drawn
    var buildName = {};
    [1, 2].forEach(function (t) { BUILDS[t].forEach(function (b) { buildName[b[0]] = b[1]; }); });
    var BA_NAMES = [null, 'eggpod', 'overmind', 'barricade', 'acid_tube', 'trapper', 'booster', 'hive',
                    'telenode', 'mgturret', 'tesla', 'arm', 'dcc', 'medistat', 'reactor', 'repeater'];
    function buildButtons(st) {
      return BUILDS[st.team].filter(function (b) {
        return st.stage >= (b[4] || 0) && (!b[5] || st.stage === 2) && (!b[6] || st.weap === WP_ABUILD2);
      }).map(function (b) {
        var cls = (st.team === 1 ? 'p-alien' : 'p-human') + (b[3] > st.points ? ' p-low' : '');
        return button('!build:' + b[0], b[1], b[2] + ' · ' + (b[3] ? b[3] + ' BP' : 'free'), cls);
      }).join('');
    }
    function isBuilder(st) {
      return !!st && st.pm !== PM_DEAD && ((st.team === 1 && (st.cls === PCL_ALIEN_BUILDER0 || st.cls === PCL_ALIEN_BUILDER0_UPG)) ||
                                           (st.team === 2 && (' ' + cvar('ui_carriage')).indexOf(' W' + WP_HBUILD + ' ') >= 0));
    }
    function openBuild() {
      var st = lastState;
      if (!isBuilder(st)) return;
      // a new choice replaces a held blueprint (Cmd_Build_f), so nothing to cancel first
      if (st.team === 2 && st.weap !== WP_HBUILD) command('itemact ckit');
      buildOpen = true; pickKey = '-';
      showPick(st);
    }
    var pickKey = '', pickHold = 0;
    var queuedTeam = 0;        // picked a class and waiting in the spawn queue of this team
    var pendingClass = '';     // picked on the death screen: respawn, then spawn as this
    var nextFire = 0;
    function button(cmd, label, sub, cls) {
      return '<button class="' + (cls || '') + '" data-pick="' + cmd + '"><b>' + label + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</button>';
    }
    function spawnButtons(st, prefix) {
      return SPAWNS[st.team].filter(function (s) { return st.stage >= (s[3] || 0); }).map(function (s) {
        return button(prefix + 'class ' + s[0], s[1], s[2], st.team === 1 ? 'p-alien' : 'p-human');
      }).join('');
    }
    function pickFor(st) {
      if (!st) return '';
      if (st.team === 0) return 'team';
      if (queuedTeam && (st.team !== queuedTeam || st.cls !== 0)) queuedTeam = 0;
      if (st.pm === PM_DEAD) return 'dead' + st.team;
      if (st.cls !== 0) return '';
      if (pendingClass) { command(pendingClass); pendingClass = ''; queuedTeam = st.team; }
      return queuedTeam ? 'queue' : 'spawn' + st.team;
    }
    function showPick(st) {
      var key = pickFor(st);
      if (buildOpen && (key || !isBuilder(st))) buildOpen = false;
      if (buildOpen) key = 'build:' + st.points + ':' + st.weap + ':' + st.stage;
      // death screen with a class chosen: keep asking to respawn until the server lets us
      if (pendingClass && key.indexOf('dead') === 0) {
        key = 'wait';
        if (Date.now() > nextFire) { nextFire = Date.now() + 700; tap(A.FIRE); }
      }
      var mini = key === 'queue' || key === 'wait';
      if (Date.now() < pickHold && !mini) key = '';
      if (key === pickKey) return;
      pickKey = key;
      pick.hidden = !key;
      pick.classList.toggle('t-pick-mini', mini);
      root.toggleAttribute('data-picking', !!key && !mini);
      if (key && !mini) { Object.keys(touches).forEach(function (id) { if (touches[id].kind !== 'ui') finish(id, null); }); releaseAll(); resetStick(); }
      if (!key) return;
      var title = pick.querySelector('.t-pick-title'), row = pick.querySelector('.t-pick-row'), alt = pick.querySelector('.t-pick-alt');
      var other = st.team === 1 ? 2 : 1;
      pick.classList.toggle('t-pick-build', key.indexOf('build') === 0);
      if (key.indexOf('build') === 0) {
        title.textContent = 'Build · ' + st.points + ' BP free';
        row.innerHTML = buildButtons(st);
        alt.innerHTML = button('!close', 'Close', '', 'p-small');
      } else if (key === 'team') {
        title.textContent = 'Choose your side';
        row.innerHTML = button('team aliens', 'Aliens', 'Evolve and overrun', 'p-alien') +
                        button('team humans', 'Humans', 'Build, buy and defend', 'p-human');
        alt.innerHTML = button('team auto', 'Auto', '', 'p-small');
      } else if (mini) {
        title.textContent = key === 'wait' ? 'Respawning…' : 'Waiting to spawn…';
        row.innerHTML = '';
        alt.innerHTML = button('!requeue', 'Change class', '', 'p-small');
      } else if (key.indexOf('dead') === 0) {
        title.textContent = 'You died · respawn as';
        row.innerHTML = spawnButtons(st, '!respawn:');
        alt.innerHTML = button('team ' + TEAMS[other].toLowerCase(), 'Switch to ' + TEAMS[other], '', 'p-small');
      } else {
        title.textContent = TEAMS[st.team] + ': spawn as';
        row.innerHTML = spawnButtons(st, '');
        alt.innerHTML = button('team ' + TEAMS[other].toLowerCase(), 'Switch to ' + TEAMS[other], '', 'p-small');
      }
    }
    function choose(v) {
      if (v === '!requeue') { queuedTeam = 0; pendingClass = ''; pickKey = '-'; return; }
      if (v === '!close') { buildOpen = false; return; }
      if (v.indexOf('!build:') === 0) {
        buildOpen = false;
        var b = v.slice(7);
        // the build command needs the construction kit in hand; it may still be coming up
        if (lastState && lastState.team === 2 && lastState.weap !== WP_HBUILD) { pendingBuild = b; pendingUntil = Date.now() + 3000; }
        else command('build ' + b);
        return;
      }
      if (v.indexOf('!respawn:') === 0) {      // leave the body now, the class follows (pickFor)
        pendingClass = v.slice(9); nextFire = Date.now() + 700; tap(A.FIRE);
        return;
      }
      command(v);
      if (v.indexOf('class ') === 0 && lastState) queuedTeam = lastState.team;
      pickHold = Date.now() + 1500; // until the server has answered
    }

    // ---------- contextual buttons, humans-only buttons, votes
    var voted = '';
    function updateContext(st) {
      root.setAttribute('data-team', st ? st.team : 0);
      var carry = st ? ' ' + cvar('ui_carriage') : '';
      var builder = !!st && ((st.team === 1 && (st.cls === PCL_ALIEN_BUILDER0 || st.cls === PCL_ALIEN_BUILDER0_UPG)) ||
                             (st.team === 2 && carry.indexOf(' W' + WP_HBUILD + ' ') >= 0));
      // building: Build opens the picker; with a blueprint in hand Fire places it and Alt drops it
      var holding = !!st && st.bp > 0 && st.weap >= WP_ABUILD && st.weap <= WP_HBUILD;
      if (pendingBuild && st && st.weap === WP_HBUILD) { command('build ' + pendingBuild); pendingBuild = ''; }
      if (pendingBuild && Date.now() > pendingUntil) pendingBuild = '';
      // with the kit in hand Fire itself opens the picker; else this draws the kit first
      setBtn(ctx.build, 'Build', builder && !!st && st.team === 2 && st.weap !== WP_HBUILD);
      setBtn(ctx.decon, 'Decon', builder && !holding);
      setBtn(ctx.gren, 'Gren', !!st && carry.indexOf(' U' + UP_GRENADE + ' ') >= 0);
      setBtn(ctx.jet, 'Jet', !!st && carry.indexOf(' U' + UP_JETPACK + ' ') >= 0);
      // the thumb cluster follows the class: aliens get their own attacks, humans their gear
      var human = !!st && st.team === 2, al = st && st.team === 1 ? ALIEN[st.cls] || {} : null;
      // builders: primary with nothing in hand opens the build menu (buildFire), the
      // granger's secondary claws then (cancelBuildFire)
      var alt = holding ? 'Cancel' : al ? (builder ? 'Claw' : al.alt) : carry.indexOf(' W' + WP_LUCIFER + ' ') >= 0 ? 'Alt' : '';
      var fire = holding ? 'Place' : builder && (al || st.weap === WP_HBUILD) ? 'Build' : al && al.fire || 'Fire';
      setBtn(pad.fire, fire, true);
      setBtn(pad.lfire, fire, !!st && st.team !== 0);
      setBtn(pad.alt, alt || 'Alt', !!alt);
      pad.fire.classList.toggle('place', holding);
      pad.fire.classList.toggle('ok', holding && st.ok);
      pad.lfire.classList.toggle('place', holding);
      pad.lfire.classList.toggle('ok', holding && st.ok);
      var h = holding ? (buildName[BA_NAMES[st.bp]] || 'Structure') + (st.ok ? ' · tap Place' : ' · can’t build here, aim elsewhere') : '';
      if (hint.textContent !== h) hint.textContent = h;
      hint.hidden = !h;
      hint.classList.toggle('ok', holding && st.ok);
      setBtn(ctx.third, al && al.third || '3rd', !!(al && al.third));
      setBtn(pad.crouch, al ? 'Wall' : 'Duck', human || !!(al && al.wall));
      setBtn(pad.use, al ? 'Evolve' : 'Use', !!st);
      // blaster (9), painsaw (11) and the construction kit have nothing to reload
      setBtn(pad.reload, 'Rld', human && st.weap !== 9 && st.weap !== 11 && st.weap !== WP_HBUILD);
      setBtn(pad.weap, 'Wpn', human);
      ctx.jet.classList.toggle('on', !!st && st.pm === PM_JETPACK);
      // running votes: everyone's, then the own team's
      var team = st && st.team ? (st.team === 1 ? 'ui_alienTeamVoteActive' : 'ui_humanTeamVoteActive') : '';
      var kind = cvar('ui_voteActive') === '1' ? 'vote' : team && cvar(team) === '1' ? 'teamvote' : '';
      if (!kind) voted = '';
      voteBar.hidden = !kind || voted === kind || !st;
      if (kind) voteBar.querySelector('span').textContent = kind === 'vote' ? 'Vote' : 'Team vote';
      voteBar.setAttribute('data-kind', kind);
    }
    // ---------- auto fire: polled fast; the cgame only writes overmind_aim when it changes
    var autoOn = false, onTarget = false;
    function fireHeld() {
      for (var id in touches) { var o = touches[id]; if (o.kind === 'hold' && o.a === A.FIRE) return true; }
      return false;
    }
    function autoFire() {
      onTarget = mode === 'game' && !root.hasAttribute('data-picking') && cvar('overmind_aim') === '1';
      var want = !!settings.autofire && onTarget && chat.hidden;
      if (want === autoOn) return;
      autoOn = want;
      pad.fire.classList.toggle('auto', want);
      if (want) act(A.FIRE, 1);
      else if (!fireHeld()) act(A.FIRE, 0);
    }

    function vote(v) {
      var kind = voteBar.getAttribute('data-kind');
      if (!kind) return;
      command(kind + ' ' + v);
      voted = kind; voteBar.hidden = true; buzz(10);
    }

    // ---------- chat with the device keyboard (the engine's chat line needs a real keyboard)
    function openChat() {
      Object.keys(touches).forEach(function (id) { if (touches[id].kind !== 'ui') finish(id, null); });
      releaseAll(); resetStick();
      chat.hidden = false;
      chatInput.value = '';
      chatInput.focus();
    }
    function closeChat() { chatInput.blur(); chat.hidden = true; }
    // keys typed here must not reach the engine's window listeners
    ['keydown', 'keyup', 'keypress'].forEach(function (t) {
      chatInput.addEventListener(t, function (e) { e.stopPropagation(); if (t === 'keydown' && e.key === 'Escape') closeChat(); });
    });
    chat.addEventListener('submit', function (e) {
      e.preventDefault();
      var how = e.submitter && e.submitter.getAttribute('data-chat') === 'say_team' ? 'say_team' : 'say';
      // the console splits at ';' and quotes end the argument
      var text = chatInput.value.replace(/["\\;\r\n]/g, ' ').trim();
      if (text) command(how + ' "' + text + '"');
      closeChat();
    });
    chat.querySelector('[data-chat="cancel"]').addEventListener('click', closeChat);

    var pollN = 0;
    function poll() {
      var s = M._Overmind_State();
      var inGame = (s & 0x100) && !(s & 0x7);
      // KEYCATCH_UI (2) / CONSOLE (1) / MESSAGE (4) or not in a game: menus
      setMode(inGame ? 'game' : 'menu');
      if ((pollN++ & 1) === 0) {
        lastState = inGame ? playerState() : null;
        // the game asked for its build menu (builder fired with nothing in hand)
        if (cvar('overmind_menu') === 'build') { command('set overmind_menu ""'); if (inGame) buildOpen = true; }
        showPick(lastState);
        updateContext(lastState);
        // died or switched team while sprinting
        if (sprinting && !(lastState && lastState.team === 2 && lastState.pm !== 5)) setSprint(false);
      }
    }

    // ---------- looking: finger drag with response curve, plus optional gyro
    function emit(fx, fy) {
      var x = fx + lookRemX, y = fy + lookRemY;
      var ix = Math.trunc(x), iy = Math.trunc(y);
      lookRemX = x - ix; lookRemY = y - iy;   // keep sub-count remainder for slow aim
      if (ix || iy) M._Overmind_Look(ix, iy);
    }
    // Touch events and frames tick at different rates (60/120 Hz panels, coalesced
    // events): applying each event at once moves the camera in uneven steps. Finger
    // movement is collected and handed to the engine per animation frame instead,
    // mostly in the same frame and the rest in the next one or two.
    // Straight through: the engine adds up all motion between two of its frames, so
    // each frame turns exactly as far as the finger moved. (Spreading it over later
    // frames only added lag, worst at the 20-30 fps of a busy phone.)
    function look(fx, fy) { emit(fx, fy); }
    function lookTouch(o, t) {
      var tn = now(), dt = Math.max(4, Math.min(64, tn - o.t));
      var dx = t.clientX - o.x, dy = t.clientY - o.y;
      o.x = t.clientX; o.y = t.clientY; o.t = tn;
      var v = Math.hypot(dx, dy) / dt;                 // px per ms
      o.v = o.v ? o.v * 0.6 + v * 0.4 : v;             // smoothed finger speed
      var accel = Math.min(ACCEL_MAX, 1 + ACCEL_K * Math.max(0, o.v - ACCEL_FROM));
      var g = LOOK_GAIN * settings.look * accel * (onTarget ? AIM_FRICTION : 1);
      look(dx * g, dy * g * LOOK_Y);
    }

    var gyro = { listening: false, granted: false, wantPerm: false, t: 0, x: 0, y: 0 };
    var gyroNeedsPerm = typeof window.DeviceMotionEvent !== 'undefined' &&
                        typeof window.DeviceMotionEvent.requestPermission === 'function';
    function deadzone(v) { return Math.abs(v) < GYRO_DZ ? 0 : v - (v > 0 ? GYRO_DZ : -GYRO_DZ); }
    function onMotion(e) {
      var r = e.rotationRate, tn = now();
      var dt = gyro.t ? Math.min(50, tn - gyro.t) : 16;
      gyro.t = tn;
      if (!r || mode !== 'game' || pickKey) { gyro.x = gyro.y = 0; return; }
      // device axes -> screen axes for the current orientation (beta: device x, gamma: device y)
      var ang = (screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : (window.orientation || 0)) * Math.PI / 180;
      var b = r.beta || 0, g = r.gamma || 0, c = Math.cos(ang), s = Math.sin(ang);
      var sx = deadzone(b * c - g * s);   // around the screen's horizontal axis: pitch
      var sy = deadzone(b * s + g * c);   // around the screen's vertical axis: yaw
      gyro.x += (sx - gyro.x) * GYRO_SMOOTH;
      gyro.y += (sy - gyro.y) * GYRO_SMOOTH;
      var k = GYRO_GAIN * settings.look * dt / 1000;
      emit(-gyro.y * k, -gyro.x * k);
    }
    function gyroListen(on) {
      if (on === gyro.listening) return;
      gyro.listening = on;
      gyro.t = 0; gyro.x = gyro.y = 0;
      if (on) window.addEventListener('devicemotion', onMotion);
      else window.removeEventListener('devicemotion', onMotion);
    }
    // iOS: must run inside a user gesture (we call it from touchend)
    function requestGyro() {
      gyro.wantPerm = false;
      try {
        window.DeviceMotionEvent.requestPermission().then(function (state) {
          if (state === 'granted') { gyro.granted = true; gyroListen(!!settings.gyro); }
          else { settings.gyro = false; save(); gyroListen(false); refreshUi(); }
        }, function () { gyro.wantPerm = !!settings.gyro; });   // not a gesture yet: retry on next tap
      } catch (e) { gyro.wantPerm = !!settings.gyro; }
    }
    function setGyro(on) {
      if (on && typeof window.DeviceMotionEvent === 'undefined') on = false;
      settings.gyro = on; save();
      if (on && gyroNeedsPerm && !gyro.granted) requestGyro();
      else gyroListen(on);
      if (on) buzz(10);
    }
    if (settings.gyro) {
      if (gyroNeedsPerm) gyro.wantPerm = true;   // asked on the first tap
      else gyroListen(true);
    }

    // ---------- settings sheet and top bar toggles
    function refreshUi() {
      root.querySelectorAll('[data-ui]').forEach(function (b) {
        var p = b.getAttribute('data-ui').split(':');
        var on = p[0] === 'gyro' && p.length === 1 ? !!settings.gyro :
                 p[0] === 'sheet' ? !sheet.hidden :
                 p.length === 2 ? String(p[0] === 'size' ? settings.size : settings[p[0]] ? 1 : 0) === p[1] : false;
        b.classList.toggle('on', on);
      });
      root.querySelector('[data-val="aim"]').textContent = settings.look.toFixed(2).replace(/0$/, '');
      root.style.setProperty('--t-scale', SIZES[settings.size] || 1);
    }
    function stepAim(dir) {
      var i = 0, best = Infinity;
      AIM_STEPS.forEach(function (s, j) { var d = Math.abs(s - settings.look); if (d < best) { best = d; i = j; } });
      settings.look = AIM_STEPS[Math.max(0, Math.min(AIM_STEPS.length - 1, i + dir))];
    }
    function uiAction(name) {
      var p = name.split(':');
      switch (p[0]) {
        case 'sheet': sheet.hidden = !sheet.hidden; break;
        case 'close': sheet.hidden = true; break;
        case 'aim-': stepAim(-1); break;
        case 'aim+': stepAim(1); break;
        case 'gyro': setGyro(p.length === 2 ? p[1] === '1' : !settings.gyro); break;
        case 'haptics': settings.haptics = p[1] === '1'; buzz(10); break;
        case 'autofire': settings.autofire = p[1] === '1'; break;
        case 'size': if (SIZES[p[1]]) settings.size = p[1]; break;
        case 'chat': sheet.hidden = true; openChat(); break;
        case 'build': openBuild(); break;
        case 'switch':
          sheet.hidden = true;
          if (lastState && lastState.team) command(lastState.team === 1 ? 'team humans' : 'team aliens');
          break;
      }
      save();
      refreshUi();
    }
    refreshUi();

    // ---------- touches
    function canvasPoint(t) {
      var r = canvas.getBoundingClientRect();
      return [Math.round((t.clientX - r.left) * canvas.width / r.width),
              Math.round((t.clientY - r.top) * canvas.height / r.height)];
    }

    function updateStick(o, t) {
      var dx = t.clientX - o.x0, dy = t.clientY - o.y0;
      var d = Math.hypot(dx, dy), push = d / STICK_R;
      if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
      knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      var nx = dx / STICK_R, ny = dy / STICK_R;
      act(A.FWD, ny < -DEAD); act(A.BACK, ny > DEAD);
      act(A.LEFT, nx < -DEAD); act(A.RIGHT, nx > DEAD);
      if (o.lock) return;                       // double-tap sprint holds until release
      // push the stick (mostly forward) to the rim and keep it there to sprint
      var full = push >= SPRINT_PUSH && ny < -0.5;
      if (full && !o.timer && !sprinting) {
        o.timer = setTimeout(function () { o.timer = 0; if (touches[o.id] === o) setSprint(true); }, SPRINT_HOLD_MS);
      } else if (!full && o.timer) { clearTimeout(o.timer); o.timer = 0; }
      if (sprinting && (push < SPRINT_DROP || ny > -0.3)) setSprint(false);
    }

    // what a soft button does once its tap is confirmed
    function softAction(el) {
      if (el.hasAttribute('data-toggle')) {
        var ta = +el.getAttribute('data-toggle');
        act(ta, !pressed[ta]);
        el.classList.toggle('on', !!pressed[ta]);
      } else {
        if (el.hasAttribute('data-cmd')) runCmd(el.getAttribute('data-cmd'));
        else if (el.hasAttribute('data-tap')) tap(+el.getAttribute('data-tap'));
        el.classList.add('down'); setTimeout(function () { el.classList.remove('down'); }, 120);
      }
      buzz(8);
    }

    // the chat form is a normal page form: native focus, keyboard and button clicks
    function inChat(e) { return e.target && e.target.closest && !!e.target.closest('.t-chat'); }

    function start(e) {
      wakeAudio();
      if (inChat(e)) return;
      if (!chat.hidden) closeChat();           // tapping the game closes the chat line
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i], id = t.identifier;
        if (touches[id]) finish(id, null);     // missed end for a reused identifier
        var pk = t.target.closest ? t.target.closest('[data-pick]') : null;
        if (pk) {
          pk.classList.add('down');
          choose(pk.getAttribute('data-pick'));
          if (pickKey !== '-') showPick(null); else showPick(lastState);
          buzz(10);
          continue;
        }
        var vb = t.target.closest ? t.target.closest('[data-vote]') : null;
        if (vb) { vote(vb.getAttribute('data-vote')); continue; }
        if (mode === 'menu') {
          var p = canvasPoint(t);
          M._Overmind_Pointer(p[0], p[1]);
          touches[id] = { kind: 'menu' };
          // let the cursor land for a frame before the click
          setTimeout(function () { act(A.FIRE, 1); }, 40);
          continue;
        }
        // the settings sheet swallows every touch on it; buttons act on release
        var el = t.target.closest ? t.target.closest('[data-ui],[data-hold],[data-toggle],[data-tap],[data-cmd],[data-zone],.t-sheet') : null;
        if (!el || el.classList.contains('t-sheet')) continue;
        if (el.hasAttribute('data-ui')) {
          el.classList.add('down');
          touches[id] = { kind: 'ui', el: el };
          continue;
        }
        // soft button: decided on release - a tap acts, a drag was aiming all along
        if (el.hasAttribute('data-soft')) {
          el.classList.add('down');
          touches[id] = { kind: 'soft', el: el, x0: t.clientX, y0: t.clientY, t0: now(), moved: false,
                          x: t.clientX, y: t.clientY, t: now(), v: 0 };
          continue;
        }
        // every button in the right thumb cluster keeps aiming when the thumb slides on
        var inPad = !!el.closest('.t-pad');
        if (el.hasAttribute('data-toggle') || el.hasAttribute('data-cmd') || el.hasAttribute('data-tap')) {
          if (el.hasAttribute('data-toggle')) {
            var ta = +el.getAttribute('data-toggle');
            act(ta, !pressed[ta]);
            el.classList.toggle('on', !!pressed[ta]);
          } else {
            if (el.hasAttribute('data-cmd')) runCmd(el.getAttribute('data-cmd'));
            else tap(+el.getAttribute('data-tap'));
            el.classList.add('down'); setTimeout(function (b) { b.classList.remove('down'); }.bind(null, el), 120);
          }
          buzz(8);
          if (inPad) touches[id] = { kind: 'look', x: t.clientX, y: t.clientY, t: now(), v: 0 };
          continue;
        }
        if (el.hasAttribute('data-hold')) {
          var a = +el.getAttribute('data-hold');
          act(a, 1); el.classList.add('down');
          if (a === A.FIRE || a === A.JUMP) buzz(10);
          touches[id] = { kind: 'hold', a: a, el: el, look: inPad || el.hasAttribute('data-look'), x: t.clientX, y: t.clientY, t: now(), v: 0 };
          continue;
        }
        var zone = el.getAttribute('data-zone');
        if (zone === 'move') {
          var tn = now();
          var dbl = lastMoveEnd && tn - lastMoveEnd.t < DOUBLE_TAP_MS &&
                    Math.hypot(t.clientX - lastMoveEnd.x, t.clientY - lastMoveEnd.y) < 80;
          lastMoveEnd = null;
          stick.style.left = t.clientX + 'px'; stick.style.top = t.clientY + 'px';
          stick.classList.add('on'); knob.style.transform = '';
          touches[id] = { kind: 'move', id: id, x0: t.clientX, y0: t.clientY, t0: tn, lock: false, timer: 0 };
          if (dbl) { setSprint(true); touches[id].lock = sprinting; }
        } else if (zone === 'look') {
          touches[id] = { kind: 'look', x: t.clientX, y: t.clientY, t: now(), v: 0 };
        }
      }
      e.preventDefault();
    }

    function move(e) {
      if (inChat(e)) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i], o = touches[t.identifier];
        if (!o) continue;
        if (o.kind === 'menu') { var p = canvasPoint(t); M._Overmind_Pointer(p[0], p[1]); }
        else if (o.kind === 'move') updateStick(o, t);
        else if (o.kind === 'soft') {
          if (!o.moved && Math.hypot(t.clientX - o.x0, t.clientY - o.y0) > SOFT_SLOP) {
            o.moved = true;
            o.el.classList.remove('down');
          }
          if (o.moved) lookTouch(o, t);
        }
        else if (o.kind === 'look' || (o.kind === 'hold' && o.look)) lookTouch(o, t);
      }
      e.preventDefault();
    }

    // end one tracked touch; t is null when cancelled or cleaned up (no ui click then)
    function finish(id, t) {
      var o = touches[id];
      if (!o) return;
      delete touches[id];
      if (o.kind === 'menu') setTimeout(function () { act(A.FIRE, 0); }, 60);
      else if (o.kind === 'hold') {
        // auto fire still on target: keep shooting (and the other fire button may be held)
        if (!(o.a === A.FIRE && (autoOn || fireHeld()))) act(o.a, 0);
        o.el.classList.remove('down');
      }
      else if (o.kind === 'soft') {
        o.el.classList.remove('down');
        // a clean tap: lifted without sliding off, not a long rest of the thumb
        if (t && !o.moved && now() - o.t0 < SOFT_MAX_MS) softAction(o.el);
      }
      else if (o.kind === 'ui') {
        o.el.classList.remove('down');
        var hit = t && document.elementFromPoint(t.clientX, t.clientY);
        if (hit && o.el.contains(hit)) uiAction(o.el.getAttribute('data-ui'));
      } else if (o.kind === 'move') {
        if (o.timer) clearTimeout(o.timer);
        resetStick();
        act(A.FWD, 0); act(A.BACK, 0); act(A.LEFT, 0); act(A.RIGHT, 0);
        setSprint(false);
        // a short tap arms double-tap-and-hold sprint
        if (t && now() - o.t0 < 250) lastMoveEnd = { t: now(), x: o.x0, y: o.y0 };
      }
    }

    function end(e) {
      if (inChat(e)) return;
      var ended = e.type === 'touchend';
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        finish(t.identifier, ended ? t : null);
      }
      // drop anything the browser no longer reports as down (lost touchend)
      var alive = {};
      for (var j = 0; j < e.touches.length; j++) alive[e.touches[j].identifier] = 1;
      Object.keys(touches).forEach(function (id) { if (!alive[id]) finish(id, null); });
      if (ended && gyro.wantPerm) requestGyro();
      e.preventDefault();
    }

    root.addEventListener('touchstart', start, { passive: false });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end, { passive: false });
    root.addEventListener('touchcancel', end, { passive: false });
    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // ---------- iOS/Android only start audio after a touch
    function wakeAudio() {
      var ctx = M.SDL2 && M.SDL2.audioContext;
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
    }

    // background tab or app switch: let go of everything
    function onHidden() {
      if (!document.hidden) return;
      Object.keys(touches).forEach(function (id) { finish(id, null); });
      releaseAll();
    }
    document.addEventListener('visibilitychange', onHidden);

    var pollTimer = setInterval(poll, 120);
    var aimTimer = setInterval(autoFire, 40);
    poll();

    return { openSheet: function () { sheet.hidden = false; refreshUi(); }, detach: function () {
      clearInterval(pollTimer);
      clearInterval(aimTimer);
      Object.keys(touches).forEach(function (id) { finish(id, null); });
      releaseAll();
      gyroListen(false);
      document.removeEventListener('visibilitychange', onHidden);
      root.hidden = true;
    } };
  }

  window.OvermindTouch = { attach: attach };
})();
