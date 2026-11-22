// ASCII jellyfish — the whole screen is a grid of characters.
// Each frame every creature writes brightness into the grid, then each
// cell's brightness picks a glyph from RAMP and a colour from the atlas.
//
// Five designs, one per section:
//   1. Scypho  — true jellyfish (moon-jelly style)
//   2. Cubo    — box jelly
//   3. Stauro  — stalked jellyfish (attached to the seabed)
//   4. Hydro   — hydromedusa (crystal-jelly style)
//   5. Siphono — siphonophore (Portuguese man o' war, floats at the surface)

(() => {
  const canvas = document.getElementById('sea');
  const ctx = canvas.getContext('2d');

  const FONT = 'Consolas, "SF Mono", Menlo, "Courier New", monospace';
  const RAMP = ' .,:-~=+*o#%&@';
  const LEVELS = RAMP.length;

  // Colours: the full hue wheel in 5° steps, plus three soft star colours.
  const HUE_STEP = 5;
  const HUES = 360 / HUE_STEP;
  const PALETTES = [
    ...Array.from({ length: HUES }, (_, i) => [i * HUE_STEP, 88]),
    [220, 15], // star: soft white
    [210, 45], // star: cool blue-white
    [45, 45],  // star: warm yellow-white
    [215, 22], // seabed sand: muted blue-grey (moonlit)
    [225, 12], // seabed rock: dark grey
    [205, 18], // marine snow: pale blue-grey
  ];
  const SAND_PAL = HUES + 3;
  const SNOW_PAL = HUES + 5;
  const ROCK_PAL = HUES + 4;
  // white & blue-white listed twice so they're more common than warm stars
  const STAR_PALS = [HUES, HUES + 1, HUES, HUES + 1, HUES + 2];
  const hueIdx = (h) => ((Math.round(h / HUE_STEP) % HUES) + HUES) % HUES;
  const SPREAD = 32; // shades within one creature: degrees either side of its base

  const TIME_SCALE = 0.6; // < 1 slows every motion

  // Scenes, each listing which designs appear and how many at once.
  // They're stacked top to bottom in SCENE_ORDER; the ↑/↓ buttons (or arrow
  // keys) move between neighbours.
  const SCENES = {
    surface:   { siphono: 3 },                      // Portuguese man o' war
    openWater: { scypho: 3, cubo: 2, hydro: 4 },    // the free swimmers
    seabed:    { stauro: 3 },                       // stalked jellyfish
  };
  const SCENE_ORDER = ['surface', 'openWater', 'seabed'];
  const SCENE_LABEL = { surface: 'Surface', openWater: 'Open water', seabed: 'Seabed' };
  let scene = 'openWater';

  // which scene a design lives in
  const sceneOf = (kind) => SCENE_ORDER.find((s) => SCENES[s][kind] > 0) || scene;

  let dpr, fontSize, cellW, cellH, cols, rows, aspect, pad, gw, gh;
  let atlas, field, owner;
  let creatures = [];

  const rand = (a, b) => a + Math.random() * (b - a);
  const gauss = (d, w) => Math.exp(-(d * d) / (w * w));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const worldW = () => cols * aspect;

  // ================= layout & glyph atlas =================

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    // character size: bigger characters = fewer cells = less detail
    fontSize = Math.max(9, Math.min(24, Math.round(w / 150)));
    ctx.font = `${fontSize}px ${FONT}`;
    cellW = ctx.measureText('M').width;
    cellH = Math.round(fontSize * 1.1);
    cols = Math.ceil(w / cellW);
    rows = Math.ceil(h / cellH);
    aspect = cellW / cellH; // world units: 1 unit = one row of height

    field = new Float32Array(cols * rows);
    owner = new Uint8Array(cols * rows);

    buildAtlas();
    populate();
  }

  // Pre-render every glyph in every colour once, then blit from it.
  function buildAtlas() {
    pad = Math.ceil(fontSize * 0.6); // room for the glow
    gw = Math.ceil((cellW + pad * 2) * dpr);
    gh = Math.ceil((cellH + pad * 2) * dpr);

    atlas = document.createElement('canvas');
    atlas.width = gw * LEVELS;
    atlas.height = gh * PALETTES.length;
    const a = atlas.getContext('2d');
    a.font = `${fontSize * dpr}px ${FONT}`;
    a.textAlign = 'center';
    a.textBaseline = 'middle';

    PALETTES.forEach(([hue, sat], p) => {
      for (let l = 1; l < LEVELS; l++) {
        const t = l / (LEVELS - 1);
        const light = 14 + 74 * Math.pow(t, 1.1);
        a.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
        if (t > 0.45) {
          a.shadowColor = `hsla(${hue}, ${sat}%, 60%, ${t})`;
          a.shadowBlur = fontSize * 0.7 * dpr * t;
        } else {
          a.shadowBlur = 0;
        }
        a.fillText(RAMP[l], l * gw + gw / 2, p * gh + gh / 2);
      }
    });
  }

  // ================= drawing helpers =================

  // brightness multiplier for whatever is being drawn (used to fade the
  // other creatures out while one is zoomed in on)
  let plotGain = 1;

  // vertical view offset in rows (the whole picture follows a swipe on empty
  // space, then springs back) — see "swiping between scenes"
  let camY = 0;

  // light one cell (world coords); the brightest thing in a cell wins
  // While a creature is being drawn (countLit), plot counts the visible
  // characters it lights: litOwn = on its own scene's screen, litView = on
  // the screen you're actually looking at (they differ while scrolling).
  // A creature is only removed once both are zero — nothing of it showing.
  const LIT_MIN = 0.04;   // dimmest brightness that still draws a character
  let countLit = false, litOwn = 0, litView = 0;
  let countOnly = false;  // count what would be lit, but don't draw it

  function plot(wx, wy, I, p) {
    const c = Math.round(wx / aspect);
    if (!(c >= 0 && c < cols)) return;                  // (also rejects NaN)
    if (countLit && I > LIT_MIN) {
      const ro = Math.round(wy);
      if (ro >= 0 && ro < rows) litOwn++;
    }
    const r = Math.round(wy + camY);
    if (!(r >= 0 && r < rows)) return;
    if (countLit && I > LIT_MIN) litView++;
    if (countOnly) return;
    const k = r * cols + c;
    I *= plotGain;
    if (I > field[k]) {
      field[k] = I;
      owner[k] = p;
    }
  }

  // filled disc of radius `rad` rows, for thick strokes and knobs
  function blob(wx, wy, rad, I, p) {
    if (rad < 0.6) { plot(wx, wy, I, p); return; }
    const n = Math.ceil(rad);
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx += aspect) {
        const d = Math.hypot(dx, dy) / rad;
        if (d <= 1) plot(wx + dx, wy + dy, I * (1 - 0.4 * d * d), p);
      }
    }
  }

  // creature-local (u right, v down, in rows) → world, using j.angle.
  // k (0..1) is how far along a trailing part (tentacle/arm) the point is.
  // Points further down use the lag offset for their k (see jiggle), so the
  // tips trail behind and only catch up later.
  function toWorld(j, u, v, k = 0) {
    let ang = j.angle, lx = 0, ly = 0;
    if (k > 0 && j.lagX) {
      const f = Math.min(1, k) * LAG_N;
      const i = Math.min(LAG_N - 1, Math.floor(f)), w = f - i;
      lx = j.lagX[i] + (j.lagX[i + 1] - j.lagX[i]) * w;
      ly = j.lagY[i] + (j.lagY[i + 1] - j.lagY[i]) * w;
      // lower parts of a tentacle turn later than the bell does
      ang = j.lagA[i] + (j.lagA[i + 1] - j.lagA[i]) * w;
    }
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return [j.x + u * ca - v * sa + lx, j.y + u * sa + v * ca + ly];
  }

  // ================= drag & jiggle physics =================

  const drag = { j: null, e: null, x: 0, y: 0, offX: 0, offY: 0 }; // e: a held baby jellyfish

  // Physics settings.
  const WATER = {
    follow: 10,      // how quickly a held jelly catches up with the pointer
    turn: 6,         // how quickly it tilts toward its motion
    drag: 2.2,       // how quickly a throw slows down
    delay: 0.6,      // seconds before a pull reaches the tentacle tips
    delayCurve: 1.3, // > 1: the upper tentacle stays tighter, the tips floppier
    squash: 0.25,    // how much a jolt squashes the bell
    bellStiff: 140,  // bell wobble stiffness
    bellDamp: 7,     // bell wobble damping
  };
  const LAG_N = 32;   // lag is sampled at this many points down a tentacle
  const CHAIN_N = 12;  // links in the drag chain (fewer, lazier links = more smoothing)

  // Runs every frame for every creature (real time, not TIME_SCALE'd).
  //
  // Tentacles as a chain in water: link 0 is the bell, and each link lazily
  // follows the link above it (water resistance stops it keeping up). So a
  // pull reaches the tips late, and fast small jiggles get smoothed out link
  // by link and barely reach the tips at all — only slow, big moves do.
  //
  // Separately, sudden changes of speed squash and stretch the bell (j.wob).
  function jiggle(j, rdt) {
    // first time: set up the physics state. (Checked by the chain, not by
    // ex, because a bump or a drag can set ex before this ever runs.)
    if (!j.chainX) {
      Object.assign(j, { ex: j.ex || 0, ey: j.ey || 0, Ex: 0, Ey: 0, vx: 0, vy: 0, pvx: 0, pvy: 0,
                         wob: j.wob || 0, wv: j.wv || 0, tvx: j.tvx || 0, tvy: j.tvy || 0,
                         chainX: new Float32Array(CHAIN_N + 1), chainY: new Float32Array(CHAIN_N + 1),
                         lagX: new Float32Array(LAG_N + 1), lagY: new Float32Array(LAG_N + 1),
                         chainA: new Float32Array(CHAIN_N + 1).fill(j.angle),
                         lagA: new Float32Array(LAG_N + 1).fill(j.angle) });
    }
    // only movement caused by dragging / throwing counts — a jelly's own
    // swimming doesn't sweep its tentacles back
    const vx = j.ex / rdt, vy = j.ey / rdt;
    j.Ex += j.ex; j.Ey += j.ey;          // total dragged displacement so far
    j.ex = 0; j.ey = 0;
    const sm = Math.min(1, rdt * 12);
    j.vx += (vx - j.vx) * sm;
    j.vy += (vy - j.vy) * sm;

    // drag chain: update from the tip upward so each link chases where the
    // link above it was last frame (a pull takes one step per link to travel)
    // each link closes the gap with exponential smoothing; the time constants
    // of all links add up to WATER.delay
    // The bell's tilt goes down the same chain, so when the bell rotates the
    // tentacles don't swing round rigidly — the tips turn late and smoothly.
    const cx = j.chainX, cy = j.chainY, ca = j.chainA;
    const a = 1 - Math.exp(-rdt * CHAIN_N / WATER.delay);
    for (let i = CHAIN_N; i >= 1; i--) {
      cx[i] += (cx[i - 1] - cx[i]) * a;
      cy[i] += (cy[i - 1] - cy[i]) * a;
      ca[i] += (ca[i - 1] - ca[i]) * a;
    }
    cx[0] = j.Ex; cy[0] = j.Ey; ca[0] = j.angle;

    // lag offset at each point down the tentacle (k = i/LAG_N), relative to
    // the bell. delayCurve maps more of the chain onto the lower tentacle.
    for (let i = 0; i <= LAG_N; i++) {
      const f = Math.pow(i / LAG_N, WATER.delayCurve) * CHAIN_N;
      const n = Math.min(CHAIN_N - 1, Math.floor(f)), w = f - n;
      j.lagX[i] = cx[n] + (cx[n + 1] - cx[n]) * w - j.Ex;
      j.lagY[i] = cy[n] + (cy[n + 1] - cy[n]) * w - j.Ey;
      j.lagA[i] = ca[n] + (ca[n + 1] - ca[n]) * w;
    }

    // a man o' war moving through the water sets off plankton flashes
    if (j.kind === 'siphono' && !j.wasInAir) floatSparks(j, rdt);

    // bell squash & stretch, kicked by changes in velocity
    const dv = Math.hypot(j.vx - j.pvx, j.vy - j.pvy);
    j.pvx = j.vx; j.pvy = j.vy;
    j.wv += Math.min(dv / j.R, 6) * WATER.squash; // kick, relative to body size
    j.wv += (-WATER.bellStiff * j.wob - WATER.bellDamp * j.wv) * rdt;
    j.wob = clamp(j.wob + j.wv * rdt, -0.25, 0.25);
  }

  // while held: the creature is pulled toward the pointer through thick
  // water — it lags behind and catches up slowly — and tilts with motion
  function dragFollow(j, rdt) {
    const tx = drag.x + drag.offX, ty = drag.y + drag.offY;
    const f = Math.min(1, rdt * WATER.follow);
    const mx = (tx - j.x) * f, my = (ty - j.y) * f;
    j.x += mx; j.y += my;
    j.ex = (j.ex || 0) + mx; j.ey = (j.ey || 0) + my;
    const tilt = clamp((j.vx || 0) * 0.012, -0.7, 0.7);
    j.angle += (tilt - j.angle) * Math.min(1, rdt * WATER.turn);
  }

  // after release: keep the throw's momentum, but water drag slows it fast
  function coast(j, rdt) {
    if (!j.tvx && !j.tvy) return;
    j.tvx = j.tvx || 0; j.tvy = j.tvy || 0;
    j.x += j.tvx * rdt;
    j.y += j.tvy * rdt;
    j.ex = (j.ex || 0) + j.tvx * rdt;
    j.ey = (j.ey || 0) + j.tvy * rdt;
    const decay = Math.exp(-rdt * WATER.drag);
    j.tvx *= decay; j.tvy *= decay;
    if (Math.abs(j.tvx) + Math.abs(j.tvy) < 0.05) { j.tvx = 0; j.tvy = 0; }
  }

  // Stalked jellyfish can't be dragged away — pulling one stretches it
  // toward the pointer (rubbery: it gives less the further you pull). Pull
  // past the limit and it slips free, springing back with a wobble; letting
  // go early springs it back too.
  const STRETCH = {
    give: 0.75,   // how much it stretches compared to how far you pull
    firm: 0.6,    // how much it resists more the further you pull (0 = never)
    snap: 2,      // pull distance (× its height) at which it slips free
    stiff: 90,    // spring-back stiffness (higher = faster wobble)
    damp: 5,      // spring-back damping (lower = wobbles for longer)
  };

  function stauroPull(j, rdt, held) {
    j.sX = j.sX || 0; j.sY = j.sY || 0; j.svX = j.svX || 0; j.svY = j.svY || 0;
    if (held) {
      const rx = drag.x - drag.startX, ry = drag.y - drag.startY;
      const dist = Math.hypot(rx, ry);
      const limit = (j.Hs + j.Hc) * STRETCH.snap;
      if (dist > limit) {
        // slipped free — the spring below takes over from here
        drag.j = null;
        canvas.style.cursor = 'grab';
      } else {
        const g = STRETCH.give / (1 + (STRETCH.firm * dist) / limit);
        const f = Math.min(1, rdt * 15);
        const nx = j.sX + (rx * g - j.sX) * f, ny = j.sY + (ry * g - j.sY) * f;
        j.svX = (nx - j.sX) / rdt; j.svY = (ny - j.sY) / rdt;
        j.sX = nx; j.sY = ny;
        return;
      }
    }
    // spring back to rest, overshooting a little each way
    j.svX += (-STRETCH.stiff * j.sX - STRETCH.damp * j.svX) * rdt;
    j.svY += (-STRETCH.stiff * j.sY - STRETCH.damp * j.svY) * rdt;
    j.sX += j.svX * rdt; j.sY += j.svY * rdt;
    if (Math.abs(j.sX) + Math.abs(j.sY) + Math.abs(j.svX) + Math.abs(j.svY) < 0.01) {
      j.sX = j.sY = j.svX = j.svY = 0;
    }
  }

  // ================= collisions =================
  // Every creature's main body is a round, soft bumper: the bell for
  // swimmers, the float for a man o' war, the cup for a stalked jellyfish
  // (tentacles pass through each other). Overlapping bumpers are eased apart
  // and given a bounce that water drag then slows (via the same tvx/tvy a
  // throw uses). The push also counts as "external" movement, so tentacles
  // swing and bells squash from the knock. Bigger creatures push harder.
  // A held creature is immovable (shove others with it); a stalked one
  // can't move, so it sways with its springy stretch instead.
  const BOUNCE = {
    push: 30,     // how quickly overlaps are eased apart (per second)
    kick: 5,      // bounce speed per row of overlap
    squash: 0.6,  // how much a bump squashes the bell
    sway: 4,      // how hard a bump sways a stalked jellyfish
  };

  // A creature's bumper follows the real outline of just its bell (or float
  // / cup) — nothing below the rim, so tentacles never collide.
  //
  // Bells are a dome on top with straight sides down to the rim, so their
  // bottom corners stick out. Each bumper gives:
  //   x, y   — the creature's anchor point
  //   cx, cy — the middle of the bell (used to aim the push)
  //   reach(nx, ny) — how far the outline extends from (x, y) in that
  //                   direction (its furthest point that way, corners included)
  function bumper(j) {
    const R = j.R;
    const ca = Math.cos(j.angle || 0), sa = Math.sin(j.angle || 0);
    // dome (half-height b) on top of a box from the centre line down to the
    // rim (depth `bot`), width ±a; tilted with the bell
    const bell = (a, b, bot, boxy) => ({
      x: j.x, y: j.y,
      // middle of the bell: halfway between dome top and rim, tilted
      cx: j.x - sa * (bot - b) / 2,
      cy: j.y + ca * (bot - b) / 2,
      reach(nx, ny) {
        const lx = nx * ca + ny * sa, ly = -nx * sa + ny * ca; // into the bell's frame
        const side = a * Math.abs(lx);
        const dome = boxy ? side + Math.max(0, -ly) * b             // box-shaped top
                   : ly <= 0 ? Math.hypot(a * lx, b * ly) : side;     // rounded dome
        return Math.max(dome, side + Math.max(0, ly) * bot);          // + skirt corners
      },
    });
    const oval = (x, y, a, b) => ({ x, y, cx: x, cy: y, reach: (nx, ny) => Math.hypot(a * nx, b * ny) });
    switch (j.kind) {
      case 'scypho': return bell(R * j.wid, R * j.dome * 1.08, R * (0.06 + j.skirt), false);
      case 'cubo':   return bell(R, R * j.h, R * 0.12, true);
      case 'hydro':  return bell(R * j.wid, R * j.dome * 1.12, R * 0.11, false);
      // float plus its crest
      case 'siphono': return oval(j.x, j.y - R * j.fh * 0.2, R * 0.95, R * j.fh * 1.2);
      // the cup (not the stalk), moved with its stretch
      case 'stauro': return oval(j.x + (j.sX || 0) * 0.8, j.y - (j.Hs + j.Hc * 0.6) + (j.sY || 0) * 0.8,
                                 R * 1.05, j.Hc * 0.6);
      default: return null;
    }
  }

  function collide(rdt, list = creatures) {
    const n = list.length;
    const B = list.map(bumper);
    const ease = 1 - Math.exp(-rdt * BOUNCE.push);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = B[a], C = B[b];
        if (!A || !C) continue;
        // push direction: from the middle of one bell toward the other's
        let dx = C.cx - A.cx, dy = C.cy - A.cy;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
        const nx = dx / d, ny = dy / d;          // from a toward b
        // along that direction: how far apart the anchors are, minus how far
        // each outline reaches toward the other (corners included)
        const along = (C.x - A.x) * nx + (C.y - A.y) * ny;
        const overlap = A.reach(nx, ny) + C.reach(-nx, -ny) - along;
        if (overlap <= 0) continue;

        const ja = list[a], jb = list[b];
        // who gives way: anchored or held creatures don't move at all
        const fixedA = ja.kind === 'stauro' || drag.j === ja;
        const fixedB = jb.kind === 'stauro' || drag.j === jb;
        if (fixedA && fixedB) {
          // two immovable bodies: stalked ones still sway apart
          swayStauro(ja, -nx, -ny, overlap, rdt);
          swayStauro(jb, nx, ny, overlap, rdt);
          continue;
        }
        const ma = ja.R * ja.R, mb = jb.R * jb.R;
        const shareA = fixedA ? 0 : fixedB ? 1 : mb / (ma + mb);
        const shareB = 1 - shareA;

        bump(ja, -nx, -ny, overlap * shareA, ease);
        bump(jb, nx, ny, overlap * shareB, ease);
        swayStauro(ja, -nx, -ny, overlap, rdt);
        swayStauro(jb, nx, ny, overlap, rdt);
      }
    }
  }

  // push one creature along (nx, ny) by part of `amount` rows, and bounce it
  function bump(j, nx, ny, amount, ease) {
    if (amount <= 0 || j.kind === 'stauro' || drag.j === j) return;
    const mx = nx * amount * ease, my = ny * amount * ease;
    j.x += mx; j.y += my;
    j.ex = (j.ex || 0) + mx; j.ey = (j.ey || 0) + my;     // tentacles feel it
    j.tvx = (j.tvx || 0) + nx * amount * BOUNCE.kick * ease;
    j.tvy = (j.tvy || 0) + ny * amount * BOUNCE.kick * ease;
    j.wv = (j.wv || 0) + (amount / j.R) * BOUNCE.squash;  // bell squashes
  }

  // push a stalked jellyfish's stretch spring: it leans away while touched
  // and wobbles back once free
  function swayStauro(j, nx, ny, overlap, rdt) {
    if (j.kind !== 'stauro' || drag.j === j) return;
    const f = overlap * BOUNCE.sway * 25 * rdt;
    j.svX = (j.svX || 0) + nx * f;
    j.svY = (j.svY || 0) + ny * f * 0.4;
  }

  // ================= replacing cleared-out creatures =================
  // If a creature has been pushed, thrown or dragged completely off screen
  // (any direction) and stays off for a moment, a new one replaces it —
  // arriving the usual way for its kind. Only counts once it has been on
  // screen, so newcomers waiting just off-screen aren't swapped out.
  const CLEAR_AFTER = 1; // seconds fully off screen before it's replaced

  // draw a creature and record how much of it is visible (see plot)
  // Make sure a newly made creature isn't visible in the current view (the
  // view may be half-scrolled, showing water just past its scene's edge where
  // newcomers normally wait). If any of it would show, it starts further
  // away — deeper below for swimmers, further upwind for a man o' war — so
  // nothing ever appears out of nowhere. camY must be set for its scene.
  function spawnHidden(j) {
    const sp = SPECIES[j.kind];
    j.wob = j.wob || 0;
    for (let i = 0; i < 10; i++) {
      countLit = true; countOnly = true; litOwn = 0; litView = 0;
      sp.draw(j, simTime - (j.tOff || 0));
      countLit = false; countOnly = false;
      if (litView === 0) break;
      if (j.kind === 'siphono') j.x += (j.dir > 0 ? -1 : 1) * j.R * 2;
      else if (j.kind === 'stauro') break;               // anchored; never respawns anyway
      else j.y += rows * 0.5;
    }
    j.litOwn = j.litView = 0;
    return j;
  }

  function drawCounted(sp, j, jt) {
    countLit = true; litOwn = 0; litView = 0;
    sp.draw(j, jt);
    countLit = false;
    j.litOwn = litOwn; j.litView = litView;
  }

  // nothing of it visible — not on its own screen, nor in the current view
  // (undefined = not drawn yet, which counts as not visible)
  const invisible = (j) => !j.litOwn && !j.litView;

  // Should this creature be removed and replaced?
  //  - it swam off the way its kind leaves (update said so), and nothing of
  //    it is visible any more; or
  //  - it was cleared off (pushed / thrown / dragged) and nothing of it has
  //    been visible for CLEAR_AFTER seconds.
  function shouldReplace(j, left, rdt) {
    return (left && invisible(j)) || clearedOff(j, rdt);
  }

  function clearedOff(j, rdt) {
    if (j.kind === 'stauro') return false; // anchored — can't be cleared
    if (!invisible(j)) { j.seen = true; j.offFor = 0; return false; }
    if (!j.seen) return false;             // hasn't arrived yet
    j.offFor = (j.offFor || 0) + rdt;
    return j.offFor > CLEAR_AFTER;
  }

  // pointer position → world coords (1 unit = 1 row)
  const toWorldPt = (e) => [e.clientX / cellH, e.clientY / cellH];

  // which creature is under the pointer? (bell, or the top of its tentacles)
  // Stalked jellyfish are anchored, so they're only included when
  // `anchored` is true (double-click to zoom in), never for dragging.
  function hitTest(wx, wy, anchored = false) {
    let best = null, bestD = Infinity;
    for (const j of creatures) {
      if (j.kind === 'stauro') {
        if (!anchored) continue;
        // base at (x, y), reaching up through stalk, cup and arms
        const up = j.Hs + j.Hc + j.R * 0.8;
        const inX = Math.abs(wx - j.x) < j.R * 1.4;
        const inY = wy <= j.y + 1 && wy >= j.y - up;
        if (inX && inY && 0.95 < bestD) { bestD = 0.95; best = j; }
        continue;
      }
      const R = j.R * (j.wid || 1);
      const dx = (wx - j.x) / (R * 1.15);
      const dy = (wy - j.y + j.R * 0.3) / (j.R * 0.95);
      let d = Math.hypot(dx, dy);
      const below = wy - j.y;
      if (j.L && below > 0 && below < j.L * 0.5 && Math.abs(wx - j.x) < R * 0.8) {
        d = Math.min(d, 0.9); // grabbed by the tentacles
      }
      if (d < 1 && d < bestD) { bestD = d; best = j; }
    }
    return best;
  }

  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', (e) => {
    if (focus.mode !== 'none' || scrollBusy()) return; // no dragging while zoomed / scrolling
    const [wx, wy] = toWorldPt(e);
    const hs = hitScenery(wx, wy);      // small things first: a polyp or baby jellyfish
    const j = hs ? null : hitTest(wx, wy, true);
    if (!j) {
      if (hs && hs.kind === 'ephyra') {   // a baby jellyfish: grab it
        drag.e = hs.src;
        drag.x = wx; drag.y = wy;
        drag.offX = hs.src.x - wx; drag.offY = hs.src.y - wy;
        hs.src.tvx = 0; hs.src.tvy = 0;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (hs) return;                     // a polyp: no scroll, so it can be double-clicked
      // empty space: swipe to change scene
      pan.active = true;
      pan.x0 = e.clientX; pan.y0 = e.clientY; pan.dx = 0; pan.dy = 0;
      pan.vy = 0; pan.lastY = e.clientY; pan.lastT = performance.now();
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (j.kind === 'stauro') {        // anchored: pull to stretch it
      drag.j = j;
      drag.x = drag.startX = wx; drag.y = drag.startY = wy;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    drag.j = j;
    drag.x = wx; drag.y = wy;
    drag.offX = j.x - wx; drag.offY = j.y - wy;
    j.tvx = 0; j.tvy = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  const grassPtr = { x: 0, t: 0 };
  canvas.addEventListener('pointermove', (e) => {
    const [wx, wy] = toWorldPt(e);
    if (drag.j || drag.e) { drag.x = wx; drag.y = wy; return; }
    if (pan.active) {
      pan.dx = e.clientX - pan.x0; pan.dy = e.clientY - pan.y0;
      const tNow = performance.now(), dtm = Math.max(1, tNow - pan.lastT) / 1000;
      pan.vy += ((e.clientY - pan.lastY) / dtm - pan.vy) * 0.5; // smoothed speed, px/s
      pan.lastY = e.clientY; pan.lastT = tNow;
      return;
    }
    if (focus.mode !== 'none') { canvas.style.cursor = 'zoom-out'; return; }
    const hs = hitScenery(wx, wy);
    canvas.style.cursor = hs ? (hs.kind === 'ephyra' ? 'grab' : 'zoom-in')
                        : hitTest(wx, wy, true) ? 'grab' : 'default';
    // moving the cursor through the seagrass pushes the blades aside
    const tNow = performance.now();
    if (grassPtr.t) {
      const dts = Math.max(0.005, (tNow - grassPtr.t) / 1000);
      pushGrass(wx, wy, clamp((wx - grassPtr.x) / dts, -60, 60));
    }
    grassPtr.x = wx; grassPtr.t = tNow;
  });

  function release() {
    if (drag.e) {                         // let go of a baby jellyfish: fling it
      const e = drag.e;
      e.tvx = clamp(e.hvx || 0, -rows, rows);
      e.tvy = clamp(e.hvy || 0, -rows, rows);
      drag.e = null;
      canvas.style.cursor = 'grab';
      return;
    }
    const j = drag.j;
    if (!j) return;
    if (j.kind === 'stauro') {        // springs back on its own (stauroPull)
      drag.j = null;
      canvas.style.cursor = 'grab';
      return;
    }
    // throw: carry on with the speed it had when let go
    j.tvx = clamp(j.vx || 0, -rows * 2, rows * 2);
    j.tvy = clamp(j.vy || 0, -rows * 2, rows * 2);
    if (j.kind === 'cubo') j.target = clamp(j.angle, -1, 1);
    drag.j = null;
    canvas.style.cursor = 'grab';
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // ================= scrolling between scenes =================
  // The scenes are stacked like sections of a web page: surface on top, then
  // open water, then seabed. Dragging on empty space scrolls the view 1:1 —
  // the next scene slides in from below (or above) while this one slides
  // away, both alive. Let go past SCROLL.snap of a screen (or flick) and it
  // rushes on to the next scene — starting slow, fast through the middle,
  // slowing into place, with speed lines streaking past; otherwise it eases
  // back. At the top or bottom it only rubber-bands. The ↑/↓ buttons and
  // arrow keys scroll the same way.
  const SCROLL = {
    snap: 0.45,   // fraction of a screen you must scroll before it snaps onward
    flick: 2.5,   // a flick faster than this (screens per second) also snaps
    time: 2,      // seconds for the rush to the next scene (incl. speeding up & slowing down)
    back: 0.35,   // seconds to ease back when it doesn't snap
    edge: 0.15,   // how much it moves when there's no scene that way
    gap: 6,       // distance between scenes, in screen heights (> 1 leaves a
                  // stretch of open water between them, so creatures hanging
                  // past a scene's edge are out of view before it's left behind)
  };
  const sceneSpan = () => rows * SCROLL.gap; // rows from one scene to the next
  const pan = { active: false, x0: 0, y0: 0, dx: 0, dy: 0, vy: 0, lastY: 0, lastT: 0 };
  // scroll position in rows: 0 = this scene; +sceneSpan() = fully at the
  // scene below; −sceneSpan() = fully at the scene above
  const scroll = { s: 0, target: null, anim: null, v: 0 };

  // ease in and out: slow start, fast middle, slow end
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

  // animate the scroll from where it is now to `to` over `dur` seconds
  function scrollTo(to, dur) {
    scroll.target = to;
    scroll.anim = { from: scroll.s, to, t: 0, dur };
  }

  const neighbourOf = (dir) => SCENE_ORDER[SCENE_ORDER.indexOf(scene) + dir];
  const scrollBusy = () => pan.active || scroll.target !== null || scroll.s !== 0;

  // each scene keeps its own creatures, so they're where you left them
  let sceneLists = {};
  const listFor = (name) => sceneLists[name] || (sceneLists[name] = buildCreatures(name));

  function endPan() {
    if (!pan.active) return;
    pan.active = false;
    if (Math.abs(pan.dy) < 4 && Math.abs(scroll.s) < 0.5) { scroll.s = 0; updateNav(); return; }
    const dir = Math.sign(scroll.s);
    const flick = (-pan.vy / window.innerHeight) * dir;  // screens/s toward that scene
    const far = Math.abs(scroll.s) > rows * SCROLL.snap;
    const onward = dir && neighbourOf(dir) && (far || flick > SCROLL.flick);
    if (onward) scrollTo(dir * sceneSpan(), SCROLL.time);
    else scrollTo(0, SCROLL.back);
    updateNav();
  }
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);

  // buttons / arrow keys: scroll smoothly to the next scene
  function moveScene(dir) {
    if (focus.mode !== 'none' || scrollBusy() || !neighbourOf(dir)) return;
    release();
    // start it moving so the right neighbour is picked straight away
    scroll.s = dir * 0.01;
    scrollTo(dir * sceneSpan(), SCROLL.time);
    updateNav();
  }

  function stepScroll(rdt) {
    const before = scroll.s;
    if (pan.active) {
      let raw = -pan.dy / cellH;                       // rows; + = scrolling deeper
      if (!neighbourOf(Math.sign(raw))) raw *= SCROLL.edge;
      scroll.s = clamp(raw, -sceneSpan(), sceneSpan());
      scroll.v = (scroll.s - before) / rdt;
      return;
    }
    const a = scroll.anim;
    if (!a) { scroll.v = 0; return; }
    a.t += rdt;
    const p = Math.min(1, a.t / a.dur);
    scroll.s = a.from + (a.to - a.from) * easeInOut(p);
    scroll.v = (scroll.s - before) / rdt;              // rows per second (for the speed lines)
    if (p >= 1) {
      scroll.anim = null;
      if (scroll.target !== 0) {
        // arrived: the neighbour becomes the current scene
        scene = neighbourOf(Math.sign(scroll.target));
        creatures = listFor(scene);
      }
      scroll.s = 0;
      scroll.target = null;
      updateNav();
    }
  }

  // ---------- speed lines ----------
  // Vertical streaks that rush past while scrolling between scenes: longer
  // and brighter the faster it's going, moving the opposite way to the
  // scroll (streaming upward as you dive, downward as you rise).
  const SPEED_LINES = {
    count: 0.35,     // streaks per screen column
    minSpeed: 0.6,   // screens/s before any streaks appear
    length: 0.06,    // streak length per (row/s) of speed, in rows
    bright: 0.55,    // brightness at full speed
  };
  let streaks = [];

  function makeStreaks() {
    streaks = Array.from({ length: Math.round(cols * SPEED_LINES.count) }, () => ({
      x: rand(0, worldW()), y: rand(0, rows), k: rand(0.5, 1.3), b: rand(0.5, 1),
    }));
  }

  function drawSpeedLines(rdt) {
    const v = scroll.v;                                  // rows/s, + = going deeper
    const speed = Math.abs(v) / rows;                    // screens/s
    if (!scroll.anim || scroll.anim.to === 0) return; // only once the rush to a new scene has begun
    if (speed < SPEED_LINES.minSpeed) return;
    const fade = Math.min(1, (speed - SPEED_LINES.minSpeed) / 2);
    const pal = hueIdx(v > 0 ? 205 : 190);              // deeper blue diving, lighter rising
    camY = 0;
    for (const st of streaks) {
      // streaks travel the opposite way to the view, a bit faster for depth
      st.y -= v * st.k * 1.2 * rdt;
      const len = Math.min(rows * 0.6, Math.abs(v) * SPEED_LINES.length * st.k);
      if (st.y < -len) { st.y += rows + len * 2; st.x = rand(0, worldW()); }
      if (st.y > rows + len) { st.y -= rows + len * 2; st.x = rand(0, worldW()); }
      // the head is brightest; the tail trails behind the way it's moving
      const tail = v > 0 ? 1 : -1;
      for (let d = 0; d < len; d += 0.5) {
        const I = SPEED_LINES.bright * fade * st.b * (1 - d / len);
        plot(st.x, st.y + tail * d, I, pal);
      }
    }
  }

  // Simulate and draw a scene that isn't the current one (the one sliding
  // into view while scrolling). Simpler than the main loop: no dragging,
  // zooming or freezing.
  function runNeighbour(list, rdt, dt, t) {
    for (const j of list) {
      if (j.kind === 'stauro') stauroPull(j, rdt, false); else coast(j, rdt);
    }
    collide(rdt, list);
    const prev = creatures;
    for (let i = 0; i < list.length; i++) {
      const j = list[i], sp = SPECIES[j.kind];
      const jt = t - (j.tOff || 0);
      jiggle(j, rdt);
      drawCounted(sp, j, jt);
      if (shouldReplace(j, sp.update(j, dt, jt), rdt)) {
        creatures = list;                              // so placement spaces against this scene
        list[i] = spawnHidden(sp.make());
        creatures = prev;
      }
    }
  }

  // ================= double-click focus (zoom in on one jellyfish) =================
  // Double-click a jellyfish: it grows to fill the screen and glides to the
  // centre while everything else fades out and time stops for the rest of
  // the scene. It keeps pulsing in place. Double-click again: it shrinks back
  // to exactly where it was, the others fade back in, and time carries on.

  const FOCUS_TIME = 1.2; // seconds for the zoom in / out
  const focus = { mode: 'none', j: null, p: 0, from: null, to: null };
  let othersFade = 1;     // brightness of everything except the focused jelly

  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p));
  const lerp = (a, b, e) => a + (b - a) * e;

  const MORPH_TIME = 0.8; // seconds to swap to another group's jellyfish
  // size-related fields that scale together when zooming
  const SIZE_KEYS = ['R', 'L', 'Hs', 'Hc'];
  // the five groups' designs, in the panel's order
  const GROUP_KINDS = ['scypho', 'cubo', 'stauro', 'hydro', 'siphono'];

  // snapshot a creature's position, angle and size
  function pose(j) {
    const p = { x: j.x, y: j.y, angle: j.angle };
    for (const k of SIZE_KEYS) if (j[k] !== undefined) p[k] = j[k];
    return p;
  }

  // The free part of the screen (world units) — everything not covered by
  // the info panel. Measured from the panel itself, so it follows any
  // restyling.
  function freeArea() {
    const W = worldW(), H = rows;
    const a = { x0: 0, x1: W, y0: 0, y1: H };
    if (infoEl && !infoEl.hidden) {
      const r = infoEl.getBoundingClientRect();
      const gap = 16;
      if (window.innerWidth > 760) a.x0 = Math.min(W * 0.8, (r.right + gap) / cellH);
      else a.y1 = Math.max(H * 0.3, (r.top - gap) / cellH);
    }
    return a;
  }

  // Where (and how big) a creature should be when zoomed in: as large as
  // fits, centred in the free area.
  function focusTarget(j, a) {
    const aw = a.x1 - a.x0, ah = a.y1 - a.y0;
    const cx = (a.x0 + a.x1) / 2;
    const t = { x: cx, angle: 0 };
    let Rt;
    if (j.kind === 'polyp') {
      // base near the bottom, tall enough to see the disc stack and crown
      const tall = j.src.h * 1.6 + 2;
      Rt = Math.min((ah * 0.62) / tall, (aw * 0.4) / 4);
      t.y = a.y1 - ah * 0.12;
      t.angle = 0;
    } else if (j.kind === 'ephyra') {
      const span = 4.2 * j.src.size;                     // arm tip to arm tip at scale 1
      Rt = Math.min((aw * 0.55) / span, (ah * 0.4) / (1.2 * j.src.size));
      t.y = (a.y0 + a.y1) / 2;
    } else if (j.kind === 'stauro') {
      // anchored at its base; reaches ~(stalk + cup + arms) upward
      const up = (j.Hs + j.Hc) / j.R + 0.75;
      Rt = Math.min((aw / 2) * 0.75 / 1.45, (ah * 0.85) / up);
      t.y = a.y1 - ah * 0.06;
    } else if (j.kind === 'siphono') {
      // float near the top, tentacles hanging down
      Rt = Math.min((aw / 2) * 0.75, ah * 0.32);
      t.y = a.y0 + ah * 0.18;
    } else {
      const top = j.kind === 'cubo' ? j.h : (j.dome || 1); // bell height above centre
      Rt = Math.min((aw / 2) * 0.8 / (j.wid || 1), (ah * 0.62) / (top + 0.3));
      t.y = a.y0 + ah * 0.06 + Rt * top;
    }
    const f = Rt / j.R;
    for (const k of SIZE_KEYS) if (j[k] !== undefined) t[k] = j[k] * f;
    return t;
  }

  // set every size field to `factor` × the zoomed-in size
  function setSize(j, factor) {
    for (const k of SIZE_KEYS) if (focus.to[k] !== undefined) j[k] = focus.to[k] * factor;
    j.zs = j.R / focus.from.R;
  }

  function startFocus(j) {
    focus.mode = 'in';
    focus.j = j;
    focus.p = 0;
    focus.from = pose(j);
    // the spot in the scene it was zoomed from — whatever it gets swapped
    // into returns here
    focus.home = { x: j.x, y: j.y, angle: j.angle };
    focus.homeScene = scene;
    focus.homeKind = j.kind;
    j.tvx = 0; j.tvy = 0;
    canvas.style.cursor = 'zoom-out';
    updateNav();
    showInfo(j);                         // unhides the panel so it can be measured
    focus.to = focusTarget(j, freeArea());
  }

  function zoomOut() {
    if (focus.mode !== 'on') return;
    focus.mode = 'out';
    focus.p = 0;
    hideInfo();

    // If the jellyfish now belongs to another scene (e.g. it was swapped to a
    // stalked jellyfish), zoom out into that scene: build it now so it fades
    // in around the jellyfish as it shrinks into place.
    const j = focus.j;
    const target = sceneOf(j.kind);
    if (target !== scene) {
      // the scene it came from gets a fresh one of the original kind back
      const oldList = creatures, oi = oldList.indexOf(j);
      if (oi >= 0) oldList[oi] = SPECIES[focus.homeKind].make();
      scene = target;
      const list = listFor(target);
      // it takes the place of the same-kind creature nearest its spot
      let best = -1, bestD = Infinity;
      list.forEach((c, i) => {
        const d = Math.abs(c.x - focus.from.x);
        if (c.kind === j.kind && d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0) list[best] = j; else list.push(j);
      creatures = list;
    } else if (!j.proxy && !creatures.includes(j)) {
      // swapped in from a polyp / ephyra: take the place of the nearest of its kind
      let best = -1, bestD = Infinity;
      creatures.forEach((c, i) => {
        const d = Math.abs(c.x - focus.from.x);
        if (c.kind === j.kind && d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0) creatures[best] = j; else creatures.push(j);
    }
  }

  // Swap the focused jellyfish for one from another group: the old one
  // shrinks and fades, the new one (same colours) grows in its place. On zoom
  // out, the new one goes back to the old one's spot in the scene.
  function morphTo(kind) {
    if (focus.mode !== 'on' || focus.j.kind === kind) return;
    const old = focus.j;
    const n = SPECIES[kind].make();
    Object.assign(n, { hue: old.hue, hueDir: old.hueDir, shade: old.shade, tOff: old.tOff });
    // where it goes when zooming out: the old one's spot (non-swimmers go to
    // their natural place — seabed or surface)
    const home = { ...focus.home };
    if (kind === 'stauro') home.y = seabedY(home.x);
    else if (kind === 'siphono') home.y = surfaceBase();
    else if (focus.homeScene !== 'openWater') home.y = rows * 0.55; // swimmer from seabed/surface
    if (kind === 'stauro' || kind === 'siphono') home.angle = 0;
    focus.morph = { p: 0, old, next: n, home };
    focus.mode = 'morph';
    renderInfo(n);
  }

  function stepMorph(rdt) {
    const m = focus.morph;
    m.p = Math.min(1, m.p + rdt / MORPH_TIME);
    if (m.p < 0.5) {
      // old one shrinks away
      const e = ease(m.p * 2);
      setSize(m.old, 1 - 0.85 * e);
      focusGain = 1 - e;
    } else {
      if (focus.j === m.old) {
        // swap in the new one, sized and placed for the zoomed-in view
        const n = m.next;
        const i = creatures.indexOf(m.old);
        if (i >= 0) creatures[i] = n;
        Object.assign(n, { x: focus.to.x, y: focus.to.y, angle: 0 });
        focus.j = n;
        focus.from = { ...pose(n), ...m.home }; // its own normal size, the old spot
        focus.to = focusTarget(n, freeArea());
        Object.assign(n, { x: focus.to.x, y: focus.to.y });
      }
      const e = ease((m.p - 0.5) * 2);
      setSize(focus.j, 0.15 + 0.85 * e);
      focusGain = e;
    }
    if (m.p >= 1) {
      focusGain = 1;
      setSize(focus.j, 1);
      focus.morph = null;
      focus.mode = 'on';
    }
  }

  let focusGain = 1; // brightness of the focused jelly (fades during a swap)

  // ================= info panel content =================
  // One entry per design. `group` describes the section (one of the five);
  // `species` describes the real animal that design is drawn after.
  // Facts are a starting point — check them against a source before publishing.

  const SECTIONS = ['True jellyfish', 'Box jellies', 'Stalked jellyfish', 'Hydromedusae', 'Siphonophores'];

  const INFO = {
    scypho: {
      section: 0,
      group: {
        name: 'True jellyfish',
        latin: 'Class Scyphozoa',
        blurb: 'The classic jellyfish: big, bell-shaped drifters. For them the swimming medusa is the main stage of life — the polyp stage is small and brief.',
        stats: [['Species', '~200'], ['Size', 'a few cm to 2 m across'], ['Found', 'every ocean, surface to deep sea']],
        features: [
          'Body plan built in fours: four arms, four gonads',
          'No velum (shelf) under the bell rim',
          'Sense organs (rhopalia) in notches around the rim',
          'Polyps split into a stack of discs that swim off as babies',
        ],
      },
      species: {
        name: 'Moon jelly',
        latin: 'Aurelia aurita',
        blurb: 'Recognisable by the four glowing horseshoes in its bell — its gonads. It catches plankton in mucus on the bell and sweeps it to the mouth.',
        stats: [['Size', 'usually up to ~40 cm'], ['Found', 'coastal waters worldwide'], ['Sting', 'very mild']],
      },
    },
    cubo: {
      section: 1,
      group: {
        name: 'Box jellies',
        latin: 'Class Cubozoa',
        blurb: 'Cube-shaped jellies that steer and swim actively instead of just drifting — and look where they are going.',
        stats: [['Species', '~50'], ['Size', 'mm to ~30 cm across'], ['Found', 'mostly warm, coastal waters']],
        features: [
          'Square bell with tentacles from the four corners',
          '24 eyes in four clusters — some have lenses',
          'Fast, directed swimming; can dodge obstacles',
          'Some are among the most venomous animals known',
        ],
      },
      species: {
        name: 'Sea wasp',
        latin: 'Chironex fleckeri',
        blurb: 'The largest box jelly. Each corner carries a bundle of long tentacles packed with stinging cells.',
        stats: [['Size', 'bell up to ~30 cm'], ['Tentacles', 'up to ~15 per corner, ~3 m long'], ['Found', 'northern Australia & Indo-Pacific']],
      },
    },
    stauro: {
      section: 2,
      group: {
        name: 'Stalked jellyfish',
        latin: 'Class Staurozoa',
        blurb: 'Jellyfish that never swim: they live attached to seaweed or rock by a stalk, upside-down compared to other jellies.',
        stats: [['Species', '~50'], ['Size', 'a few cm'], ['Found', 'cold, shallow coastal waters']],
        features: [
          'Trumpet-shaped cup on a stalk',
          'Eight arms tipped with tufts of tiny knobbed tentacles',
          'Can slowly creep to a new spot',
        ],
      },
      species: {
        name: 'Stalked jellyfish',
        latin: 'Haliclystus',
        blurb: 'Clings to seaweed and catches tiny animals that drift into its tentacle tufts.',
        stats: [['Size', '~2–3 cm'], ['Found', 'northern coasts']],
      },
    },
    hydro: {
      section: 3,
      group: {
        name: 'Hydromedusae',
        latin: 'Class Hydrozoa (medusa stage)',
        blurb: 'Mostly small, delicate jellies. In many hydrozoans the polyp is the main stage, and the medusa is a small swimming phase.',
        stats: [['Species', '~850 with a medusa stage'], ['Size', 'mostly mm to a few cm'], ['Found', 'oceans worldwide — even lakes']],
        features: [
          'A velum: a thin shelf under the rim that sharpens their jet',
          'Usually small, clear and glassy',
          'Includes the "immortal" jellyfish, which can turn back into a polyp',
        ],
      },
      species: {
        name: 'Crystal jelly',
        latin: 'Aequorea victoria',
        blurb: 'A flat, glassy saucer with around a hundred fine canals. It glows green around its rim — the source of GFP, a protein now used in labs worldwide (Nobel Prize in Chemistry, 2008).',
        stats: [['Size', 'up to ~10 cm'], ['Found', 'Pacific coast of North America'], ['Glow', 'green, around the rim']],
      },
    },
    siphono: {
      section: 4,
      group: {
        name: 'Siphonophores',
        latin: 'Order Siphonophorae (Hydrozoa)',
        blurb: 'Not one animal but a colony: many specialised individuals (zooids) working together as one body.',
        stats: [['Species', '~175'], ['Size', 'cm to ~40 m long'], ['Found', 'open ocean, surface to deep sea']],
        features: [
          'Zooids split the jobs: floating, swimming, catching, eating, breeding',
          'Some have pulsing swimming bells; some float at the surface',
          'Close cousins of the hydromedusae',
        ],
      },
      species: {
        name: "Portuguese man o' war",
        latin: 'Physalia physalis',
        blurb: 'A gas-filled float with a crest that catches the wind like a sail. Long fishing tentacles hang beneath and deliver a painful sting.',
        stats: [['Float', '~30 cm long'], ['Tentacles', 'typically ~10 m, sometimes longer'], ['Found', 'warm open ocean']],
      },
    },
  };

  // life stages of a true jellyfish (shown when zooming in on one at the seabed)
  INFO.polyp = {
    section: 0,
    group: INFO.scypho.group,
    species: {
      name: 'Polyp',
      latin: 'Scyphistoma — the first life stage of a true jellyfish',
      blurb: 'Most true jellyfish start life as a tiny polyp stuck to a hard surface (usually the underside of a rock or shell), catching food with a ring of tentacles. It can live like this for months or years, even budding off clones of itself. When conditions change (often the water temperature), it stretches and splits into a stack of discs: strobilation. Each disc swims off as a baby jellyfish.',
      stats: [['Size', 'a few mm'], ['Lives', 'attached to rocks & shells'], ['Next stage', 'ephyra (baby jellyfish)']],
    },
  };
  INFO.ephyra = {
    section: 0,
    group: INFO.scypho.group,
    species: {
      name: 'Ephyra',
      latin: 'Baby jellyfish — a disc released by a polyp',
      blurb: 'Each disc that pops off a strobilating polyp swims away as an ephyra: a tiny eight-armed star that already pulses like an adult, with a sense organ at the tip of each arm. Over the following weeks it fills in between its arms, grows tentacles and becomes an adult medusa.',
      stats: [['Size', '~1–5 mm'], ['Arms', '8, each tipped with a sense organ'], ['Next stage', 'adult medusa, in weeks']],
    },
  };

  const infoEl = document.getElementById('info');
  let hideTimer = null;

  const statsHTML = (rows) =>
    `<dl class="info__stats">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  // fill the panel with a creature's group + species info
  function renderInfo(j) {
    const d = INFO[j.kind];
    if (!infoEl || !d) return;
    const g = d.group, s = d.species;
    infoEl.style.setProperty('--accent', `hsl(${Math.round(j.hue)}, 80%, 65%)`);
    infoEl.innerHTML = `
      <button class="info__close" type="button" aria-label="Zoom out">×</button>
      <ul class="info__sections" aria-label="The five groups — pick one to see it">
        ${SECTIONS.map((n, i) => `<li><button type="button" data-kind="${GROUP_KINDS[i]}"
            class="${i === d.section ? 'is-current' : ''}"
            ${i === d.section ? 'aria-current="true"' : ''}>${i + 1}. ${n}</button></li>`).join('')}
      </ul>
      <p class="info__eyebrow">Group ${d.section + 1} of 5</p>
      <h2>${g.name}</h2>
      <p class="info__latin">${g.latin}</p>
      <p>${g.blurb}</p>
      ${statsHTML(g.stats)}
      <ul class="info__features">${g.features.map((f) => `<li>${f}</li>`).join('')}</ul>
      <section class="info__species">
        <p class="info__eyebrow">This jellyfish</p>
        <h3>${s.name}</h3>
        <p class="info__latin">${s.latin}</p>
        <p>${s.blurb}</p>
        ${statsHTML(s.stats)}
      </section>
      <p class="info__hint">Pick a group above to see it · double-click anywhere or press Esc to zoom out</p>`;
    infoEl.querySelector('.info__close').addEventListener('click', zoomOut);
    infoEl.querySelectorAll('[data-kind]').forEach((b) =>
      b.addEventListener('click', () => morphTo(b.dataset.kind)));
  }

  function showInfo(j) {
    if (!infoEl) return;
    renderInfo(j);
    clearTimeout(hideTimer);
    infoEl.hidden = false;
    infoEl.scrollTop = 0;
    // let the zoom get going before the panel slides in
    hideTimer = setTimeout(() => infoEl.classList.add('show'), FOCUS_TIME * 450);
  }

  function hideInfo() {
    if (!infoEl) return;
    clearTimeout(hideTimer);
    infoEl.classList.remove('show');
    hideTimer = setTimeout(() => { infoEl.hidden = true; }, 500);
  }

  function applyFocus(e) {
    const j = focus.j, a = focus.from, b = focus.to;
    j.x = lerp(a.x, b.x, e);
    j.y = lerp(a.y, b.y, e);
    j.angle = lerp(a.angle, b.angle, e);
    for (const k of SIZE_KEYS) if (a[k] !== undefined) j[k] = lerp(a[k], b[k], e);
    j.zs = j.R / a.R; // current zoom scale (keeps tentacle waves in proportion)
    othersFade = 1 - e;
  }

  function stepFocus(rdt) {
    if (focus.mode === 'morph') { stepMorph(rdt); return; }
    if (focus.mode === 'in' || focus.mode === 'out') {
      focus.p = Math.min(1, focus.p + rdt / FOCUS_TIME);
      applyFocus(ease(focus.mode === 'in' ? focus.p : 1 - focus.p));
      if (focus.p >= 1) {
        if (focus.mode === 'in') {
          focus.mode = 'on';
        } else {
          // restore exactly, then let time run again
          const j = focus.j;
          Object.assign(j, focus.from, { zs: 1 });
          if (j.proxy && j.kind === 'ephyra') scenery.ephyrae.push({ ...j.src, x: j.x, y: j.y });
          if (j.kind === 'cubo') j.target = j.angle; // don't swerve on resume
          othersFade = 1;
          focus.mode = 'none';
          focus.j = null;
          canvas.style.cursor = 'default';
          updateNav();
        }
      }
    }
  }

  // zoom out: double-click anywhere (except on the panel, so its text can be
  // selected), the panel's × button, or Esc
  window.addEventListener('dblclick', (e) => {
    if (focus.mode === 'on' && !(infoEl && infoEl.contains(e.target))) zoomOut();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') zoomOut();
    if (e.key === 'ArrowUp') moveScene(-1);
    if (e.key === 'ArrowDown') moveScene(1);
  });

  canvas.addEventListener('dblclick', (e) => {
    if (focus.mode !== 'none' || scrollBusy()) return; // zooming / zoomed / scrolling
    const [wx, wy] = toWorldPt(e);
    const hs = hitScenery(wx, wy);                       // small things first: polyp / baby jellyfish
    if (hs) { drag.e = null; startFocus(sceneryView(hs)); return; }
    const j = hitTest(wx, wy, true);
    if (j) {
      release();
      drag.j = null;
      startFocus(j);
    }
  });

  // visit every cell within `ext` rows of the creature, giving local coords
  // in units of j.R (so shapes can be described at unit size)
  function eachCell(j, ext, fn) {
    const ca = Math.cos(j.angle), sa = Math.sin(j.angle);
    const c0 = Math.max(0, Math.floor((j.x - ext) / aspect));
    const c1 = Math.min(cols - 1, Math.ceil((j.x + ext) / aspect));
    const r0 = Math.max(Math.floor(-camY), Math.floor(j.y - ext));
    const r1 = Math.min(Math.ceil(rows - 1 - camY), Math.ceil(j.y + ext));
    const inv = 1 / j.R;
    for (let r = r0; r <= r1; r++) {
      const wy = r - j.y;
      for (let col = c0; col <= c1; col++) {
        const wx = col * aspect - j.x;
        fn((wx * ca + wy * sa) * inv, (-wx * sa + wy * ca) * inv, col, r);
      }
    }
  }

  // bell contraction 0..1 — quick squeeze, slow relax
  const pulse = (j, t) => Math.pow(0.5 + 0.5 * Math.sin(t * j.freq * Math.PI * 2 + j.ph), 2);

  // shared colour traits; shade(off) gives a hue near the base (off -1..1)
  function colourTraits() {
    const hue = Math.random() * 360;
    const hueDir = Math.random() < 0.5 ? 1 : -1;
    return { hue, hueDir, shade: (off) => hueIdx(hue + off * SPREAD * hueDir) };
  }

  // Brightness/colour accumulator for one cell: parts add brightness with
  // their own shade; the colour is the brightness-weighted mix.
  let accI = 0, accH = 0;
  const reset = () => { accI = 0; accH = 0; };
  const add = (a, off) => { accI += a; accH += a * off; };
  function flush(j, col, r, t) {
    if (accI <= 0.02) return;
    const I = accI * (0.86 + 0.14 * Math.sin(col * 0.5 + r * 1.1 + t * 2.4)); // shimmer
    plot(col * aspect, r, Math.min(1, I), j.shade(accH / accI));
  }

  // pick an x position far from other free swimmers
  function pickX(R, y) {
    const W = worldW();
    let x = rand(R, W - R), best = -1;
    for (let k = 0; k < 8; k++) {
      const cx = rand(R * 0.8, W - R * 0.8);
      let near = Infinity;
      for (const o of creatures) {
        if (!o.swims) continue;
        near = Math.min(near, Math.hypot(cx - o.x, (y - o.y) * 0.6));
      }
      if (near > best) { best = near; x = cx; }
    }
    return x;
  }

  const spawnBelow = (R, extra) => rows + R * 1.3 + extra + rand(0, rows * 0.3);

  // ================= environment =================

  // where the water surface (surface scene) and seabed (seabed scene) are;
  // also used to place the man o' war and the stalked jellyfish
  const SURFACE_LEVEL = 0.3;  // waterline, as a fraction down the screen
  const SEABED_LEVEL = 0.86;  // top of the sand, as a fraction down the screen
  const surfaceBase = () => Math.max(3, rows * SURFACE_LEVEL);
  // Wind direction (+1 = blowing right, −1 = left), random per page load.
  // The waves, the floats' drift and the rain all follow it.
  const windDir = Math.random() < 0.5 ? 1 : -1;
  // phase of the main swell at x — it travels downwind
  const swellPhase = (x, t) => x * 0.07 - windDir * t * 0.9;
  // waterline height: a big swell plus faster, smaller wind chop, both
  // travelling downwind (screen y points down, so smaller y = higher water)
  const surfaceY = (x, t) => surfaceBase() + 0.7 * Math.sin(swellPhase(x, t)) +
                             0.35 * Math.sin(x * 0.19 - windDir * t * 1.6);
  const seabedY = (x) => rows * SEABED_LEVEL - 1.6 * Math.sin(x * 0.025 + 1) -
                         0.8 * Math.sin(x * 0.07) - 0.4 * Math.sin(x * 0.19 + 2);
  const hash = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  // ---------- night sky (surface scene, above the water only) ----------
  // Stars fill the sky above the waterline: mostly faint, a few bright ones
  // with a small sparkle, each twinkling at its own speed, the whole sky
  // drifting slowly sideways, and now and then a shooting star. The sky is
  // part of the surface scene, so it scrolls away with it as you dive —
  // underwater there are no stars.
  const STAR_DENSITY = 1 / 45;  // stars per cell of sky
  const SKY_DRIFT = 0.02;       // sideways drift, rows per second
  let stars = [];
  let shooting = null;
  let nextShoot = 0;

  function makeStars() {
    const n = Math.round(cols * surfaceBase() * STAR_DENSITY);
    stars = Array.from({ length: n }, () => ({
      x: rand(0, worldW()), y: rand(0, surfaceBase()),
      b: Math.pow(Math.random(), 3),          // brightness: most stars faint
      f: rand(0.3, 1.6), ph: rand(0, Math.PI * 2),
      pal: STAR_PALS[Math.floor(Math.random() * STAR_PALS.length)],
    }));
    nextShoot = rand(4, 10);
  }

  function drawSky(t, dt) {
    const W = worldW();
    for (const s of stars) {                  // drift even while out of view
      s.x += SKY_DRIFT * dt;
      if (s.x > W) s.x -= W;
    }
    const so = surfaceOffset();               // where the surface scene is on screen
    if (so === null) { shooting = null; return; }
    camY = so;
    const above = (x, y) => y < surfaceY(x, t) - 0.8;  // stays clear of the waves
    for (const s of stars) {
      if (!above(s.x, s.y)) continue;
      const tw = 0.7 + 0.3 * Math.sin(t * s.f + s.ph);
      const I = (0.06 + 0.5 * s.b) * tw;
      plot(s.x, s.y, I, s.pal);
      if (s.b > 0.75) { // bright star: small cross-shaped sparkle
        const sp = I * 0.35;
        plot(s.x - aspect, s.y, sp, s.pal);
        plot(s.x + aspect, s.y, sp, s.pal);
        if (s.y > 1) plot(s.x, s.y - 1, sp, s.pal);
        if (above(s.x, s.y + 1)) plot(s.x, s.y + 1, sp, s.pal);
      }
    }

    // shooting star: a bright head with a fading tail, skimming across the
    // sky above the water in about a second
    nextShoot -= dt;
    if (!shooting && nextShoot <= 0) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const ang = rand(0.06, 0.22);
      shooting = {
        x: rand(W * 0.15, W * 0.85), y: rand(0, surfaceBase() * 0.45),
        vx: dir * Math.cos(ang), vy: Math.sin(ang),
        speed: rows * rand(0.8, 1.3), life: 0, dur: rand(0.7, 1.2),
      };
    }
    if (shooting) {
      const sh = shooting;
      sh.life += dt;
      const k = sh.life / sh.dur;
      const fade = Math.sin(Math.PI * Math.min(1, k));       // fade in and out
      const hx = sh.x + sh.vx * sh.speed * sh.life;
      const hy = sh.y + sh.vy * sh.speed * sh.life;
      const tail = rows * 0.12;
      for (let d = 0; d < tail; d += 0.4) {
        const x = hx - sh.vx * d, y = hy - sh.vy * d;
        if (above(x, y)) plot(x, y, 0.85 * fade * Math.pow(1 - d / tail, 1.5), STAR_PALS[0]);
      }
      if (k >= 1) { shooting = null; nextShoot = rand(6, 15); }
    }
    camY = 0;
  }

  // ---------- marine snow (all through the water) ----------
  // Specks of drifting organic matter sinking slowly. They belong to the
  // ocean, not to a scene: one continuous field that fills all the water —
  // in the scenes, in the open water between them, while dragging and while
  // rushing — moving with the view as it scrolls. Hidden above the waterline
  // and below the sand. Near ones (z → 1) are bigger, brighter and sink
  // faster; far ones are faint and slow. They sway gently.
  const SNOW = {
    density: 1 / 70,   // specks per screen cell
    bright: 1,         // overall brightness
    settle: [3, 5],    // seconds a speck rests on the sand before fading
    fade: 1.2,         // seconds of that spent fading out
  };
  let snow = [];
  let snowStackY = null; // view position in the stack last frame

  function makeSnow() {
    snow = Array.from({ length: Math.round(cols * rows * SNOW.density) }, () => ({
      x: rand(0, worldW()), y: rand(0, rows), z: Math.random(), ph: rand(0, 6.28),
    }));
    snowStackY = null;
  }

  // the view's position in the stack of scenes, in rows from the top of the
  // surface scene (continuous through scrolling and scene changes)
  const stackY = () => SCENE_ORDER.indexOf(scene) * sceneSpan() + scroll.s;

  function drawSnow(t, dt) {
    const W = worldW(), sy = stackY();
    const moved = snowStackY === null ? 0 : sy - snowStackY; // rows the view scrolled
    snowStackY = sy;
    const iS = SCENE_ORDER.indexOf('surface') * sceneSpan();
    const iB = SCENE_ORDER.indexOf('seabed') * sceneSpan();
    camY = 0;
    // start a fresh speck sinking from the top edge of the view
    const respawn = (f) => { f.y = -1; f.x = rand(0, W); f.z = Math.random(); f.rest = 0; f.pat = null; };
    for (const f of snow) {
      const tw = 0.75 + 0.25 * Math.sin(t * 1.3 + f.ph * 5);
      const I = (0.05 + 0.2 * f.z * f.z) * tw * SNOW.bright;

      // resting on the sand: stays put (it moves with the view only because
      // the seabed does), then fades out and a new speck starts at the top
      if (f.rest > 0) {
        f.rest -= dt;
        f.y = f.landAt - sy;
        if (f.rest <= 0 || f.y < -1 || f.y > rows + 1) { respawn(f); continue; }
        plot(f.x, f.y, I * Math.min(1, f.rest / SNOW.fade), SNOW_PAL);
        continue;
      }

      // the water moves with the view (scroll), plus sinking and swaying
      f.y += (0.12 + f.z * 0.55) * dt - moved;
      f.x += Math.sin(t * 0.3 + f.ph) * (0.03 + f.z * 0.05) * dt;
      if (f.y < -1 || f.y > rows + 1) {                  // wrap: a fresh speck at the other edge
        f.y = f.y < -1 ? f.y + rows + 2 : f.y - rows - 2;
        f.x = rand(0, W); f.z = Math.random();
        f.pat = null;                                    // jumped: don't treat as landing
      }
      // where this speck is in the stack, to skip sky and sand
      const at = sy + f.y, sand = iB + seabedY(f.x) - 0.5, prev = f.pat;
      f.pat = at;
      if (at < iS + surfaceY(f.x, t) + 1) continue;      // above the waterline
      if (at > sand) {
        // just sank onto the sand (it was above it last frame): settle there
        if (prev !== null && prev !== undefined && prev <= sand) {
          f.rest = rand(SNOW.settle[0], SNOW.settle[1]);
          f.landAt = sand;
          f.y = sand - sy;
          plot(f.x, f.y, I, SNOW_PAL);
        }
        continue;                                        // otherwise: under the sand, hidden
      }
      plot(f.x, f.y, I, SNOW_PAL);
      if (f.z > 0.85) plot(f.x + aspect, f.y, I * 0.5, SNOW_PAL); // a few bigger flakes
    }
  }

  // ---------- surface scene: the waterline ----------
  function drawSurface(t) {
    const depth = rows * 0.4;  // how far the ripples reach below the waterline
    for (let col = 0; col < cols; col++) {
      const x = col * aspect;
      const sy = surfaceY(x, t);
      // the wave line, with sparkles where the crests catch the light
      const sparkle = Math.pow(Math.max(0, Math.sin(x * 0.31 - windDir * t * 2.2)), 14);
      plot(x, sy, 0.6 + 0.35 * sparkle, hueIdx(192));
      plot(x, sy + 1, 0.28, hueIdx(198));
      // ripple bands just under the surface, fading into the dark
      for (let r = Math.round(sy) + 2; r < sy + depth && r < rows; r++) {
        const d = (r - sy) / depth;                           // 0 at surface → 1 deep
        const band = Math.pow(Math.max(0, Math.sin(x * 0.11 + r * 0.9 - windDir * t * 1.2) *
                                          Math.sin(x * 0.04 - r * 0.35 - windDir * t * 0.6)), 3);
        const I = (0.05 + 0.3 * band) * Math.pow(1 - d, 1.3);
        if (I > 0.04) plot(x, r, I, hueIdx(200 + 20 * d));
      }
    }
  }

  // ---------- seabed scene: sand, rocks and seaweed ----------
  let scenery = { rocks: [], weeds: [], rain: [], splashes: [], sparks: [] };

  // ---------- surface scene: plankton sparkles ----------
  // At night some plankton (dinoflagellates) flash blue-green when the water
  // around them is disturbed. Here: where raindrops hit, and around a man o'
  // war moving through the water (dragged, thrown, bobbing back up, splashing
  // down — just drifting with the wind barely sets them off). Each flash
  // lights almost instantly and fades within about half a second.
  const SPARK = {
    rain: 0.12,      // chance a raindrop sets off a flash
    float: 5,        // flashes per second per row/s a float moves through the water
    max: 700,        // most flashes at once
    bright: 1,
  };

  function spark(x, y, b = 1) {
    if (scenery.sparks.length >= SPARK.max) return;
    scenery.sparks.push({ x, y, born: simTime, dur: rand(0.3, 0.8), b: rand(0.5, 1) * b, hue: rand(170, 195) });
  }

  function drawSparks(t, dt) {
    const keep = [];
    for (const p of scenery.sparks) {
      const k = (simTime - p.born) / p.dur;               // by the clock, so off-screen ones expire too
      if (k >= 1) continue;
      keep.push(p);
      if (p.y < surfaceY(p.x, t) + 0.5) continue;         // only underwater
      // flash: up in the first 15% of its life, then a slower fade
      const I = SPARK.bright * p.b * Math.pow(k < 0.15 ? k / 0.15 : (1 - k) / 0.85, 1.5);
      const pal = hueIdx(p.hue);
      plot(p.x, p.y, I, pal);
      if (I > 0.5) {
        const sp = I * 0.4;
        plot(p.x - aspect, p.y, sp, pal); plot(p.x + aspect, p.y, sp, pal);
        plot(p.x, p.y - 1, sp, pal); plot(p.x, p.y + 1, sp, pal);
      }
    }
    scenery.sparks = keep;
  }

  // a man o' war disturbing the water: flashes around its float and along a
  // random stretch of its tentacles, more the faster it moves through it
  function floatSparks(j, dt) {
    if (!scenery.sparks) return;
    // movement through the water (not the steady wind drift, which carries
    // the water along with it): drags/throws/bumps + bobbing up and down
    const through = Math.hypot(j.vx || 0, j.vy || 0) + Math.abs(j.fvy || 0);
    let n = through * SPARK.float * dt;
    while (n > 0) {
      if (Math.random() < n) {
        if (Math.random() < 0.5) {
          spark(j.x + rand(-1, 1) * j.R, j.y + j.R * j.fh * rand(0.5, 1.4));
        } else {
          const f = j.fishing[Math.floor(Math.random() * j.fishing.length)];
          const along = rand(0, f.len * (j.zs || 1) * 0.8);
          spark(j.x + f.u * j.flip * j.R + rand(-1, 1), j.y + j.R * j.fh + along, 0.8);
        }
      }
      n -= 1;
    }
  }

  // ---------- surface scene: rain ----------
  // Slanted streaks blown by the wind, falling from the sky and splashing
  // where they hit the water. Only in the surface scene (the others are
  // underwater).
  const RAIN = {
    density: 0.7,   // drops per screen column
    speed: 1.6,     // fall speed, screen heights per second
    slant: 0.28,    // sideways drift per unit of fall (follows the wind)
    length: 3,      // streak length, rows
    bright: 0.32,   // streak brightness
  };
  const RAIN_PAL = HUES + 1; // cool blue-white

  function newDrop(d, top) {
    d.x = rand(-rows * 0.4, worldW() + rows * 0.4);
    d.y = top ? rand(-rows, surfaceBase()) : rand(-rows * 0.3, 0);
    d.v = rows * RAIN.speed * rand(0.85, 1.15);
    d.b = RAIN.bright * rand(0.6, 1.1);
    return d;
  }

  function drawRain(t, dt) {
    const L = RAIN.length, vx = windDir * RAIN.slant;
    for (const d of scenery.rain) {
      d.y += d.v * dt;
      d.x += vx * d.v * dt;
      const hit = surfaceY(d.x, t);
      if (d.y >= hit) {
        // splash where it lands, then start again at the top
        scenery.splashes.push({ x: d.x, y: hit - 0.5, age: 0 });
        if (Math.random() < SPARK.rain) spark(d.x + rand(-0.5, 0.5), hit + rand(0.8, 2.5), 0.85);
        newDrop(d, false);
        continue;
      }
      // streak from the head back along its direction of travel
      for (let s = 0; s < L; s += 0.5) {
        const y = d.y - s, x = d.x - vx * s;
        if (y < hit) plot(x, y, d.b * (1 - s / (L + 0.5)), RAIN_PAL);
      }
    }
    // splashes: a tiny burst of droplets that fades in ~0.3 s
    const keep = [];
    for (const sp of scenery.splashes) {
      sp.age += dt;
      const k = sp.age / 0.3;
      if (k >= 1) continue;
      const I = 0.45 * (1 - k);
      const spread = 0.5 + 2 * k, lift = 1.2 * Math.sin(Math.PI * k);
      plot(sp.x, sp.y, I, RAIN_PAL);
      plot(sp.x - spread * aspect, sp.y - lift, I * 0.8, RAIN_PAL);
      plot(sp.x + spread * aspect, sp.y - lift, I * 0.8, RAIN_PAL);
      keep.push(sp);
    }
    scenery.splashes = keep;
  }

  // ---------- seabed: seagrass meadow ----------
  // Ribbon-like blades rooted in the sand, swaying in the current (tips most).
  // Sweeping the cursor through them pushes them aside; they spring back.
  // Each stalked jellyfish sits in its own clump of it.
  const GRASS = {
    clumps: 1 / 9,          // clumps per screen column (world unit)
    perClump: [4, 9],       // blades per clump
    height: [0.1, 0.36],    // blade height range (× screen height)
    sway: 0.18,             // how far the current tilts the tips (radians)
    stiff: 6,               // spring-back stiffness after being pushed
    damp: 2.2,              // spring-back damping
    push: 0.022,            // how strongly a passing cursor pushes blades
    maxBend: 1.1,           // most a blade can be bent over (radians, ~60°)
  };

  const newBlade = (x, h) => ({ x, h, ph: rand(0, 6.28), hue: rand(95, 150),
    bright: rand(0.25, 0.45), wide: Math.random() < 0.35, bend: 0, bv: 0 });

  // A blade bends like a stalk: it curves more toward the tip, and keeps its
  // length (a blade pushed over leans and gets lower, it doesn't stretch).
  // Calls fn(x, y, k) for points along it, k = 0 at the root → 1 at the tip.
  function walkBlade(b, rootX, rootY, t, fn, zs = 1) {
    const H = b.h * zs;
    const tip = clamp(Math.sin(t * 0.7 + b.ph) * GRASS.sway + b.bend, -GRASS.maxBend, GRASS.maxBend);
    let x = rootX, y = rootY;
    for (let s = 0; s < H; s += 0.4) {
      const k = s / H;
      const ang = tip * k * (1 + 0.15 * Math.sin(t * 1.1 + b.ph * 2 - k * 3)); // a slight ripple along it
      x += Math.sin(ang) * 0.4;
      y -= Math.cos(ang) * 0.4;
      fn(x, y, k);
    }
  }

  function stepBlade(b, dt) {
    b.bv += (-GRASS.stiff * b.bend - GRASS.damp * b.bv) * dt;
    b.bend = clamp(b.bend + b.bv * dt, -GRASS.maxBend, GRASS.maxBend);
  }

  function drawBlade(b, rootX, rootY, t, zs = 1) {
    walkBlade(b, rootX, rootY, t, (x, y, k) => {
      const I = b.bright * (1 - 0.35 * k), pal = hueIdx(b.hue + 18 * k);
      plot(x, y, I, pal);
      if (b.wide && k < 0.6) plot(x + aspect, y, I * 0.7, pal); // broader at the base
    }, zs);
  }

  // the cursor sweeping through the grass pushes blades along with it
  function pushGrass(wx, wy, vx) {
    if (scene !== 'seabed' || scrollBusy()) return;
    const t = simTime;
    for (const b of scenery.weeds) {
      const ry = seabedY(b.x);
      if (wy > ry || wy < ry - b.h) continue;
      // does the cursor pass close to the blade? (the higher up, the more leverage)
      let hitK = -1;
      walkBlade(b, b.x, ry, t, (x, y, k) => {
        if (hitK < 0 && Math.abs(x - wx) < 2 && Math.abs(y - wy) < 1) hitK = k;
      });
      if (hitK >= 0) b.bv += vx * GRASS.push * (0.3 + hitK);
    }
  }

  // ---------- seabed: the jellyfish life cycle ----------
  // On a few bigger rocks live tiny polyps — the first stage of a true
  // jellyfish. Every so often one stretches and segments into a stack of
  // discs (strobilation); the discs pop off one at a time as baby jellyfish
  // (ephyrae: tiny eight-armed stars) that pulse their way up out of the
  // scene. Then the polyp regrows its tentacles and starts over.
  const POLYP = {
    rocks: 3,              // rocks with polyps on them
    perRock: [1, 1],       // polyps per rock
    size: [0.025, 0.035],  // drawing scale (× screen height): bigger = easier to see
    period: [35, 60],      // seconds for a full cycle
    chance: 0.5,           // fraction of cycles in which a polyp strobilates
    discs: [3, 6],         // discs (future ephyrae) per stack
    hue: 28,               // pale orange-cream
  };
  const EPHYRA = {
    rise: 10,         // swim speed per pulse
    hue: 345, bright: 0.55,
    life: 30,         // seconds before one that lingers fades out
    atLeast: 1,       // always at least this many swimming in the scene
    keepAbove: 0.15,  // ...counting only ones below this fraction from the top
  };

  // height of a rock's outline at f (−1..1 across it)
  const rockTop = (k, f) => k.h * Math.sqrt(Math.max(0, 1 - f * f)) * (0.85 + 0.15 * Math.sin(f * 5 + k.seed));

  function makeScenery() {
    const W = worldW();
    scenery.rocks = Array.from({ length: Math.round(W / 45) + 2 }, () => ({
      x: rand(0, W), w: rand(3, 9), h: rand(1.5, 4), seed: Math.random() * 10,
    }));
    // a few bigger rocks, spread out, for the polyps
    scenery.polyps = [];
    scenery.ephyrae = [];
    for (let i = 0; i < POLYP.rocks; i++) {
      const rock = { x: W * (i + 0.5) / POLYP.rocks + rand(-W * 0.08, W * 0.08),
                     w: rand(8, 12), h: rand(4, 6), seed: Math.random() * 10 };
      scenery.rocks.push(rock);
      const n = POLYP.perRock[0] + Math.floor(Math.random() * (POLYP.perRock[1] - POLYP.perRock[0] + 1));
      for (let p = 0; p < n; p++) {
        scenery.polyps.push({
          rock, f: n === 1 ? rand(-0.25, 0.25) : rand(-0.65, 0.65), h: rand(2.5, 4),
          scale: rows * rand(POLYP.size[0], POLYP.size[1]),
          P: rand(POLYP.period[0], POLYP.period[1]), off: rand(0, 60), ph: rand(0, 6.28),
          n: POLYP.discs[0] + Math.floor(Math.random() * (POLYP.discs[1] - POLYP.discs[0] + 1)),
          cycle: -1, released: 0,
        });
      }
    }
    scenery.rain = Array.from({ length: Math.round(cols * RAIN.density) }, () => newDrop({}, true));
    scenery.splashes = [];
    scenery.sparks = [];
    // the seagrass meadow
    scenery.weeds = [];
    const clumps = Math.round(W * GRASS.clumps) + 2;
    for (let c = 0; c < clumps; c++) {
      const cx = rand(0, W);
      const n = GRASS.perClump[0] + Math.floor(Math.random() * (GRASS.perClump[1] - GRASS.perClump[0] + 1));
      for (let b = 0; b < n; b++) {
        scenery.weeds.push(newBlade(cx + rand(-2.5, 2.5), rows * rand(GRASS.height[0], GRASS.height[1])));
      }
    }
    grassAroundStalked();
  }

  // seagrass growing up around each stalked jellyfish, so it sits in the grass
  function grassAroundStalked() {
    for (const j of (sceneLists.seabed || [])) {
      if (j.kind !== 'stauro') continue;
      const n = 7 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        scenery.weeds.push(newBlade(j.x + rand(-1.8, 1.8) * j.R, rows * rand(0.08, 0.24)));
      }
    }
  }

  // where a polyp sits on its rock, and which way it leans
  function polypGeom(p, t) {
    const k = p.rock, base = seabedY(k.x) + 0.5;
    const slope = (rockTop(k, p.f + 0.05) - rockTop(k, p.f - 0.05)) / (0.1 * k.w);
    return { bx: k.x + p.f * k.w, by: base - rockTop(k, p.f),
             tilt: Math.atan(-slope) * 0.8 + 0.08 * Math.sin(t * 0.6 + p.ph) };
  }

  // where a polyp is in its cycle: body length, discs stacked, tentacles out.
  // With `g` (its position), it also releases ephyrae as discs pop off.
  function polypState(p, t, g) {
    const cyc = Math.floor((t + p.off) / p.P), q = ((t + p.off) % p.P) / p.P;
    if (g && cyc !== p.cycle) { p.cycle = cyc; p.released = 0; }
    let len = p.h, discs = 0, tent = 1;
    const strobilates = hash(cyc, p.ph * 100) < POLYP.chance; // not every cycle
    if (!strobilates) { /* this cycle it just sits with its tentacles out */ }
    else if (q < 0.08) tent = q / 0.08;                  // tentacles regrowing
    else if (q >= 0.5 && q < 0.72) {                     // strobilating: stretch + segment
      const e = (q - 0.5) / 0.22;
      len = p.h * (1 + 0.6 * e); discs = Math.ceil(p.n * e); tent = 1 - e;
    } else if (q >= 0.72) {                              // releasing discs one by one
      const r = (q - 0.72) / 0.28;
      const gone = Math.min(p.n, Math.floor(r * (p.n + 1)));
      while (g && p.released < gone) {                   // each one swims off as an ephyra
        p.released++;
        const ux = Math.sin(g.tilt), uy = -Math.cos(g.tilt), L = len * (p.scale || 1);
        scenery.ephyrae.push({ x: g.bx + ux * L, y: g.by + uy * L, age: 0,
          size: rand(0.85, 1.25) * babyScale(p), ph: rand(0, 6.28), vx: rand(-0.3, 0.3) });
      }
      discs = p.n - p.released; len = p.h * (1 + 0.6 * discs / p.n); tent = 0;
    }
    return { len, discs, tent };
  }

  // draw a polyp from its base (bx, by), leaning by tilt, scaled by zs
  // (zs > 1 when zoomed in on it)
  function drawPolypAt(p, st, t, bx, by, tilt, zs = 1) {
    const ux = Math.sin(tilt), uy = -Math.cos(tilt);     // "up" along the polyp
    const nx = -uy, ny = ux;                             // across it
    const len = st.len * zs, discs = st.discs, tent = st.tent;
    const pal = hueIdx(POLYP.hue);
    const segStart = len * 0.35;                         // discs stack on the upper body
    for (let sAlong = 0; sAlong <= len; sAlong += 0.35) {
      const kk = sAlong / len;
      let hw = 0.3 + 0.55 * Math.pow(kk, 1.4);           // slim stalk widening to the top
      let I = 0.32 + 0.12 * kk;
      if (discs > 0 && sAlong > segStart) {              // segmented: rims with pinches between
        const seg = (sAlong - segStart) / ((len - segStart) / discs);
        const rim = Math.pow(Math.abs(Math.sin(Math.PI * seg)), 0.6);
        hw = 0.55 + 0.7 * rim; I = 0.3 + 0.3 * rim;
      }
      hw *= zs;
      const cx = bx + ux * sAlong, cy = by + uy * sAlong;
      plot(cx + nx * hw, cy + ny * hw, I, pal);
      plot(cx - nx * hw, cy - ny * hw, I, pal);
      if (zs > 1.5) for (let w = -hw + 0.5; w < hw; w += 0.6) plot(cx + nx * w, cy + ny * w, I * 0.35, pal);
      else plot(cx, cy, I * 0.5, pal);
    }
    // crown of tentacles (shrinks away while strobilating)
    if (tent > 0.05) {
      const tx = bx + ux * len, ty = by + uy * len;
      const count = zs > 1.5 ? 12 : 6;
      for (let i = 0; i < count; i++) {
        const a = tilt + (i / (count - 1) - 0.5) * 2.2 + 0.15 * Math.sin(t * 1.5 + i + p.ph);
        const L = (1.2 + 0.5 * Math.sin(i * 1.7)) * tent * zs;
        for (let d = 0.3; d < L; d += 0.3) plot(tx + Math.sin(a) * d, ty - Math.cos(a) * d, 0.35 * tent, pal);
      }
    }
  }

  function drawPolyp(p, t) {
    const g = polypGeom(p, t);
    drawPolypAt(p, polypState(p, t, g), t, g.bx, g.by, g.tilt, p.scale || 1);
  }

  // babies are sized to match the polyp they came from
  const babyScale = (p) => Math.max(1, (p.scale || 1) * 0.6);

  // one ephyra: seen slightly from the side, a flattened star of 8 arms, each
  // tipped with a bright sense organ; it squeezes in on each pulse (c)
  function drawEphyraAt(x, y, size, c, spin, fade, zs = 1) {
    const pal = hueIdx(EPHYRA.hue);
    const w = (1.4 - 0.4 * c) * size * zs;
    blob(x, y, 0.25 * size * zs, EPHYRA.bright * fade, pal);
    for (let a = 0; a < 8; a++) {
      const th = spin + (a * Math.PI) / 4;
      const ax = Math.cos(th) * w * 1.5, ay = Math.sin(th) * w * 0.4;
      const front = Math.sin(th) > 0 ? 1 : 0.55;
      const L = Math.hypot(ax, ay), n = Math.max(3, Math.ceil(L / 0.35));
      for (let i = 1; i < n; i++) plot(x + ax * i / n, y + ay * i / n, 0.35 * front * fade, pal);
      blob(x + ax, y + ay, 0.12 * size * zs, EPHYRA.bright * 1.2 * front * fade, pal);
    }
  }

  // ephyrae: tiny eight-armed baby jellyfish pulsing their way upward
  function drawEphyrae(dt, t) {
    const keep = [];
    const rdt = dt / TIME_SCALE;                          // real seconds, for dragging
    for (const e of scenery.ephyrae) {
      e.age += dt;
      const c = Math.pow(0.5 + 0.5 * Math.sin(e.age * 3.2 + e.ph), 2);   // pulse
      if (drag.e === e) {
        // held: follows the pointer (and keeps pulsing); measure its speed for a fling
        const f = Math.min(1, rdt * 12);
        const mx = (drag.x + drag.offX - e.x) * f, my = (drag.y + drag.offY - e.y) * f;
        e.x += mx; e.y += my;
        e.hvx = mx / rdt; e.hvy = my / rdt;
        e.age = Math.min(e.age, EPHYRA.life - 5);         // doesn't fade away while held
      } else {
        e.y -= (0.3 + EPHYRA.rise * c) * e.size * dt;
        e.x += (e.vx + Math.sin(e.age * 0.7 + e.ph) * 0.3) * dt;
        if (e.tvx || e.tvy) {                             // flung: glides to a stop in the water
          e.x += e.tvx * rdt; e.y += e.tvy * rdt;
          const k = Math.exp(-rdt * 2.2);
          e.tvx *= k; e.tvy *= k;
          if (Math.abs(e.tvx) + Math.abs(e.tvy) < 0.05) e.tvx = e.tvy = 0;
        }
      }
      if (drag.e !== e && (e.y < -8 || e.age > EPHYRA.life)) continue;
      keep.push(e);
      const fade = Math.min(1, e.age * 2, (EPHYRA.life - e.age) / 4); // fade in, and out if it lingers
      drawEphyraAt(e.x, e.y, e.size, c, e.age * 0.25 + e.ph, fade, 1);
    }
    scenery.ephyrae = keep;

    // always at least one baby jellyfish swimming in the scene: if none are
    // (or the last is about to swim out the top), a polyp releases another
    const inScene = keep.filter((e) => e.y > rows * EPHYRA.keepAbove && e.y < rows).length;
    if (inScene < EPHYRA.atLeast && scenery.polyps && scenery.polyps.length) releaseOne(t);
  }

  // pop a baby jellyfish off the top of a polyp — one that's mid-strobilation
  // if there is one, so it usually comes off a stack of discs
  function releaseOne(t) {
    const busy = scenery.polyps.filter((p) => polypState(p, t, null).discs > 0);
    const pool = busy.length ? busy : scenery.polyps;
    const p = pool[Math.floor(Math.random() * pool.length)];
    const g = polypGeom(p, t), st = polypState(p, t, null), L = st.len * (p.scale || 1);
    scenery.ephyrae.push({ x: g.bx + Math.sin(g.tilt) * L, y: g.by - Math.cos(g.tilt) * L,
      age: 0, size: rand(0.85, 1.25) * babyScale(p), ph: rand(0, 6.28), vx: rand(-0.3, 0.3) });
  }

  // ---------- zooming in on a polyp or an ephyra ----------
  // They're scenery, not creatures, so zooming uses a stand-in ("view") that
  // the focus system can grow and move like a creature. A polyp's stand-in
  // keeps following the real polyp's cycle; an ephyra is lifted out of the
  // water while you look at it and put back where it was afterwards.
  const POLYP_VIEW = {
    draw(j, t) { drawPolypAt(j.src, polypState(j.src, t, null), t, j.x, j.y, j.angle, j.R); },
    update() { return false; },
  };
  const EPHYRA_VIEW = {
    draw(j, t) {
      const c = Math.pow(0.5 + 0.5 * Math.sin(t * 3.2 + j.src.ph), 2);
      drawEphyraAt(j.x, j.y, j.src.size, c, t * 0.25 + j.src.ph, 1, j.R);
    },
    update() { return false; },
  };

  // a polyp or ephyra under the pointer (seabed scene only)
  function hitScenery(wx, wy) {
    if (scene !== 'seabed' || !scenery.polyps) return null;
    for (const e of scenery.ephyrae) {
      if (Math.hypot((wx - e.x) / (2.2 * e.size), (wy - e.y) / (1.4 * e.size)) < 1) return { kind: 'ephyra', src: e };
    }
    const t = simTime;
    for (const p of scenery.polyps) {
      const g = polypGeom(p, t), st = polypState(p, t, null);
      const ux = Math.sin(g.tilt), uy = -Math.cos(g.tilt);
      // distance from the pointer to the polyp's body (plus its crown)
      const dx = wx - g.bx, dy = wy - g.by;
      const sc = p.scale || 1;
      const along = clamp(dx * ux + dy * uy, 0, (st.len + 1.5) * sc);
      if (Math.hypot(dx - ux * along, dy - uy * along) < 1.6 * sc) return { kind: 'polyp', src: p };
    }
    return null;
  }

  // make the stand-in for a hit polyp / ephyra, ready to zoom
  function sceneryView(hit) {
    const H = hit.kind === 'polyp' ? POLYP.hue : EPHYRA.hue;
    const v = { proxy: true, kind: hit.kind, src: hit.src, R: hit.kind === 'polyp' ? (hit.src.scale || 1) : 1, swims: false,
                hue: H, hueDir: 1, shade: (o) => hueIdx(H + o * SPREAD), tvx: 0, tvy: 0 };
    if (hit.kind === 'polyp') {
      const g = polypGeom(hit.src, simTime);
      Object.assign(v, { x: g.bx, y: g.by, angle: g.tilt });
    } else {
      Object.assign(v, { x: hit.src.x, y: hit.src.y, angle: 0 });
      scenery.ephyrae.splice(scenery.ephyrae.indexOf(hit.src), 1); // lifted out while viewed
    }
    return v;
  }

  function drawSeabed(t, dt) {
    // sand: a bright-ish contour, textured below and darker with depth
    for (let col = 0; col < cols; col++) {
      const x = col * aspect;
      const by = seabedY(x);
      plot(x, by, 0.45 + 0.1 * hash(col, 1), SAND_PAL);
      for (let r = Math.round(by) + 1; r < rows; r++) {
        const n = hash(col, r);
        const fade = 1 - Math.min(1, (r - by) / (rows * 0.16));
        const I = (0.1 + 0.25 * n) * (0.35 + 0.65 * fade);
        if (n > 0.25) plot(x, r, I, SAND_PAL);
      }
    }

    // rocks: lumpy mounds sitting on the sand, lit from above
    for (const k of scenery.rocks) {
      const base = seabedY(k.x) + 0.5;
      for (let dx = -k.w; dx <= k.w; dx += aspect) {
        const f = dx / k.w;
        const top = k.h * Math.sqrt(Math.max(0, 1 - f * f)) * (0.85 + 0.15 * Math.sin(f * 5 + k.seed));
        for (let up = 0; up <= top; up += 1) {
          const edge = up > top - 1 ? 0.45 : 0.18 + 0.12 * (up / k.h); // brighter rim on top
          plot(k.x + dx, base - up, edge * (0.8 + 0.2 * hash(dx * 3 + k.seed, up)), ROCK_PAL);
        }
      }
    }

    // the seagrass meadow
    for (const b of scenery.weeds) {
      stepBlade(b, dt);
      drawBlade(b, b.x, seabedY(b.x), t);
    }

    // polyps on the rocks, and the baby jellyfish they release
    for (const p of scenery.polyps || []) drawPolyp(p, t);
    drawEphyrae(dt, t);
  }

  function drawSceneryFor(name, t, dt) {
    if (name === 'surface') { drawSurface(t); drawRain(t, dt); drawSparks(t, dt); }
    if (name === 'seabed') drawSeabed(t, dt);
  }

  function drawEnvironment(t, dt) {
    camY = 0;
    drawSky(t, dt);                       // the sky (surface scene, above water)
    drawSnow(t, dt);                      // marine snow through all the water
    // Every scene's scenery keeps running (rain, sparkles, seagrass, polyps,
    // baby jellyfish...) as if you were watching each one, drawn in its place
    // in the stack. This scene's fades when zooming in.
    for (const name of SCENE_ORDER) {
      plotGain = name === scene ? othersFade : 1;
      camY = offsetOf(name);
      drawSceneryFor(name, t, dt);
    }
    plotGain = 1;
    camY = 0;
  }

  // how far (rows) a scene is drawn from the view: 0 = exactly in view
  const offsetOf = (name) =>
    (SCENE_ORDER.indexOf(name) - SCENE_ORDER.indexOf(scene)) * sceneSpan() - scroll.s;

  // where the surface scene currently is on screen (rows), or null if it's
  // nowhere near the view
  function surfaceOffset() {
    const o = offsetOf('surface');
    return Math.abs(o) < rows * 1.5 ? o : null;
  }

  // ================= 1. TRUE JELLYFISH (Scyphozoa) =================

  // 16 radial canals: 8 main, 8 fainter; sin > 0 = near side (brighter)
  const CANALS = Array.from({ length: 16 }, (_, i) => {
    const th = (i / 16) * Math.PI * 2 + 0.1;
    return { c: Math.cos(th), I: (i % 2 ? 0.1 : 0.2) * (Math.sin(th) > 0 ? 1 : 0.55) };
  });

  const Scypho = {
    make(initialY) {
      const R = Math.max(5, rows * rand(0.12, 0.2));
      const y = initialY !== undefined ? initialY : spawnBelow(R, 0);
      const nT = 24 + Math.floor(Math.random() * 8);
      return {
        kind: 'scypho', swims: true, R, y, x: pickX(R, y), angle: 0,
        ...colourTraits(),
        freq: rand(0.28, 0.6),
        ph: rand(0, Math.PI * 2),
        rise: R * rand(0.5, 1.15),
        drift: rand(-0.6, 0.6),
        L: R * rand(1.6, 3.4),
        tentacles: Array.from({ length: nT }, (_, i) => {
          const th = (i / nT) * Math.PI * 2 + rand(-0.08, 0.08);
          return { x: Math.cos(th), front: Math.sin(th) > 0, len: rand(0.7, 1),
                   ph: rand(0, Math.PI * 2), hue: rand(-1, 0.4) };
        }),
        wid: rand(0.85, 1.15),
        dome: rand(0.68, 1.0),
        skirt: rand(0.14, 0.3),
        scallops: rand(28, 52),
        gonad: rand(0.8, 1.2),
        pulseAmt: rand(0.7, 1.3),
        sway: rand(0.7, 1.35),
        arms: 3 + Math.floor(Math.random() * 3),
        armLen: rand(0.35, 0.7),
        armWidth: rand(0.7, 1.4),
      };
    },

    draw(j, t) {
      const c = (j.c = pulse(j, t));
      const sx = (1 - 0.18 * c * j.pulseAmt) * j.wid * (1 + j.wob);
      const sy = (1 + 0.1 * c * j.pulseAmt) * (1 - j.wob);
      const dome = j.dome;
      const R = j.R;
      const w = Math.max(0.015, 0.8 / R);
      const bot = (nx) => 0.06 + j.skirt * nx * nx + 0.02 * Math.sin(nx * j.scallops + t * 1.5);

      eachCell(j, R * 1.45 * Math.max(1, j.wid), (u, v, col, r) => {
        const nx = u / sx, ny = v / sy;
        const e = ny < 0 ? Math.hypot(nx, ny / dome) - 1 : Math.abs(nx) - 1;
        const db = bot(nx) - ny;
        if (e > 3 * w || db < -3 * w || ny < -dome - 0.35) return;
        reset();
        const grad = clamp(ny * 1.2, -1, 1);

        if (e < 0 && db > 0) {
          add(0.08 + 0.12 * Math.max(0, -ny), -0.3 + 0.5 * grad);   // body
          add(0.3 * Math.exp(e / 0.18), -0.1 + 0.4 * grad);         // edge glow
          const ei = Math.hypot(nx / 0.88, (ny - 0.12) / (0.78 * dome)) - 1;
          if (ny > -0.6) add(0.22 * gauss(ei, w * 1.2), 0.45);       // inner dome
          const hw = ny < 0 ? Math.sqrt(Math.max(0, 1 - (ny / dome) ** 2)) : 1;
          const fadeApex = Math.min(1, hw * 2.5);
          let cI = 0;
          for (let k = 0; k < 16; k++) {
            cI += CANALS[k].I * fadeApex * gauss(nx - hw * CANALS[k].c, w * 1.1);
          }
          add(cI, 0.3);                                             // canals
          add(0.22 * gauss(db - 0.06, w), 0.6);                     // ring canal
          const gx = nx / (0.55 * j.gonad);
          const gy = (ny + 0.42 * dome) / (0.28 * j.gonad * dome / 0.85);
          const gr = Math.hypot(gx, gy);
          add(0.38 * gauss(gr - 0.75, 0.2) *
              (0.55 + 0.45 * Math.cos(Math.atan2(gy, gx) * 2 + 0.6)), 1); // gonads
          add(0.15 * gauss(gr - 0.45, 0.12), 0.8);
          add(0.05 * Math.pow(Math.sin(e * Math.PI * 7), 8), -0.5);  // growth bands
        }
        if (db > -w) add(0.85 * gauss(e, w), -0.6 + 0.6 * grad);     // membrane
        if (e < w) add(0.6 * gauss(db, w), 0.2);                     // rim
        flush(j, col, r, t);
      });

      // rim beads (sense organs)
      for (let i = 0; i < 16; i++) {
        const th = (i / 16) * Math.PI * 2 + 0.3;
        const bx = Math.cos(th);
        const [x, y] = toWorld(j, bx * sx * R, bot(bx) * sy * R);
        const glow = (0.7 + 0.3 * Math.sin(t * 2 + i * 1.7)) * (Math.sin(th) > 0 ? 1 : 0.6);
        blob(x, y, R * 0.025, glow, j.shade(0.7 + 0.2 * Math.sin(i * 2.1)));
      }

      // tentacles
      for (const tn of j.tentacles) {
        const u0 = tn.x * R * sx, v0 = bot(tn.x) * R * sy;
        const len = j.L * tn.len;
        const dim = tn.front ? 1 : 0.6;
        for (let s = 0; s < len; s += 0.4) {
          const k = s / len; const sz = s / (j.zs || 1); // wave spacing scales with zoom
          const sway = (Math.sin(sz * 0.12 - t * 1.4 + tn.ph) * (0.1 + 0.9 * k) * R * 0.16 +
                        Math.sin(sz * 0.31 - t * 2.1 + tn.ph * 2) * k * R * 0.04) * j.sway;
          const [x, y] = toWorld(j, u0 * (1 - 0.3 * k) + sway, v0 + s * (1 - 0.08 * c), k);
          const flick = 0.8 + 0.2 * Math.sin(sz * 1.5 + t * 3 + tn.ph);
          plot(x, y, (0.55 - 0.45 * k) * flick * dim, j.shade(tn.hue - 0.5 * k));
        }
      }

      // oral arms
      const armL = j.L * j.armLen;
      for (let i = 0; i < j.arms; i++) {
        const u0 = (-0.18 + (0.36 * i) / (j.arms - 1)) * R * sx;
        for (let s = 0; s < armL; s += 0.4) {
          const k = s / armL; const sz = s / (j.zs || 1); // wave spacing scales with zoom
          const sway = Math.sin(sz * 0.18 - t * 1.1 + i * 1.7 + j.ph) * (0.15 + 0.6 * k) * R * 0.14;
          const [x, y] = toWorld(j, u0 + sway, 0.1 * R + s, k * 0.7);
          const width = R * j.armWidth * (0.02 + 0.025 * (1 - k)) *
                        (0.6 + 0.4 * Math.sin(sz * 0.9 + i + t * 2));
          const I = (0.65 - 0.4 * k) * (0.75 + 0.25 * Math.sin(sz * 2.2 - t * 4 + i));
          const armShade = 0.55 + 0.25 * Math.sin(sz * 0.25 + i * 1.3) + 0.2 * k;
          blob(x, y, width, I, j.shade(armShade));
          const fr = Math.sin(sz * 1.3 + i * 2 - t * 2) * width * 2.2;
          plot(x + fr, y, I * 0.6, j.shade(armShade - 0.35));
        }
      }
    },

    update: riseUpdate,
  };

  // shared motion for bell-pulsing drifters: thrust upward on each pulse
  function riseUpdate(j, dt, t) {
    j.y -= j.rise * (0.25 + 1.1 * (j.c || 0)) * dt;
    j.x += j.drift * dt;
    // ease toward the resting tilt (so it settles smoothly after being dragged)
    const tilt = j.drift * 0.15 + 0.06 * Math.sin(t * 0.22 + j.ph);
    j.angle += (tilt - j.angle) * Math.min(1, dt * 2);
    return j.y + j.L + j.R < -1 || j.x < -j.R * 2 || j.x > worldW() + j.R * 2;
  }

  // ================= 2. BOX JELLY (Cubozoa) =================
  // Seen in three-quarter view: two front corners at the sides, two back
  // corners showing faintly through the body. A flat blade (pedalium) hangs
  // from each corner with a bundle of tentacles. Eyes sit on each face.
  // Box jellies pulse fast and steer.

  const BOX_CORNERS = [
    { x: -1, front: true }, { x: -0.38, front: false },
    { x: 0.38, front: false }, { x: 1, front: true },
  ];
  const BOX_EYES = [{ x: -0.69, front: true }, { x: 0.69, front: true }, { x: 0, front: false }];

  const Cubo = {
    make(initialY) {
      const R = Math.max(4, rows * rand(0.06, 0.09));
      const L = R * rand(2.5, 4.2);
      const y = initialY !== undefined ? initialY : spawnBelow(R, L * 0.3);
      const perCorner = Math.random() < 0.35 ? 1 : 4 + Math.floor(Math.random() * 5);
      const angle = rand(-0.4, 0.4);
      return {
        kind: 'cubo', swims: true, R, y, x: pickX(R, y), angle, target: angle,
        turnIn: rand(2, 5),
        ...colourTraits(),
        h: rand(1.15, 1.45),                 // bell height (box jellies are tall)
        freq: rand(1.1, 1.6),
        ph: rand(0, Math.PI * 2),
        speed: R * rand(0.9, 1.4),
        L,
        corners: BOX_CORNERS.map((co) => ({
          ...co,
          tents: Array.from({ length: perCorner }, (_, i) => ({
            spread: perCorner === 1 ? 0 : i / (perCorner - 1) - 0.5,
            len: rand(0.75, 1),
            ph: rand(0, Math.PI * 2),
            hue: rand(-0.8, 0.3),
          })),
        })),
      };
    },

    draw(j, t) {
      const c = (j.c = pulse(j, t));
      const sx = (1 - 0.16 * c) * (1 + j.wob);
      const sy = (1 + 0.05 * c) * (1 - j.wob);
      const R = j.R, h = j.h;
      const w = Math.max(0.03, 0.8 / R);
      const botY = 0.12;
      const p4 = (a) => a * a * a * a;

      eachCell(j, R * (h + 0.6), (u, v, col, r) => {
        const nx = u / sx, ny = v / sy;
        const ax = Math.abs(nx);
        // rounded-box outline: superellipse on top, straight sides below
        const e = ny < 0 ? Math.pow(p4(ax) + p4(ny / h), 0.25) - 1 : ax - 1;
        const db = botY - ny;
        if (e > 3 * w || db < -3 * w || ny < -h - 0.3) return;
        reset();
        if (e < 0 && db > 0) {
          add(0.07, -0.2);
          add(0.28 * Math.exp(e / 0.14), 0);
          // back corner edges, seen through the body
          if (ny > -h * 0.8) add(0.16 * gauss(ax - 0.38, w), 0.4);
          // manubrium (stomach) hanging from the top centre
          if (ny > -0.75 * h && ny < 0.02) {
            const q = (ny + 0.75 * h) / (0.75 * h);
            const mw = 0.08 + 0.06 * q;
            add(0.24 * gauss(Math.abs(nx - 0.03 * Math.sin(ny * 6 + t * 2)) - mw, w), 0.6);
          }
          // velarium: the inward shelf around the bottom opening
          if (ax > 0.7) add(0.3 * gauss(ny - (botY - 0.05), w), 0.3);
        }
        if (db > -w) add(0.85 * gauss(e, w), -0.5); // membrane
        if (e < w) add(0.6 * gauss(db, w), 0.2);    // rim
        flush(j, col, r, t);
      });

      // eyes (rhopalia): a bright pair on each visible face
      for (const eye of BOX_EYES) {
        const dim = eye.front ? 1 : 0.5;
        const [x, y] = toWorld(j, eye.x * R * sx, (botY - 0.25) * R * sy);
        blob(x, y, R * 0.05, 0.95 * dim, j.shade(0.9));
        const [x2, y2] = toWorld(j, eye.x * R * sx, (botY - 0.34) * R * sy);
        plot(x2, y2, 0.7 * dim, j.shade(0.9));
      }

      // pedalia + tentacle bundles
      for (const co of j.corners) {
        const dim = co.front ? 1 : 0.55;
        const bu = co.x * R * sx, bv = botY * R * sy;
        const dx = Math.sign(co.x) * 0.25 * Math.abs(co.x), dl = Math.hypot(dx, 1);
        const du = dx / dl, dv = 1 / dl;
        const Lp = 0.4 * R;
        for (let s = 0; s < Lp; s += 0.35) {
          const [x, y] = toWorld(j, bu + du * s, bv + dv * s);
          blob(x, y, R * 0.06 * (1 - 0.3 * s / Lp), 0.6 * dim, j.shade(0.1));
        }
        const tu = bu + du * Lp, tv = bv + dv * Lp;
        for (const tt of co.tents) {
          const len = j.L * tt.len;
          for (let s = 0; s < len; s += 0.4) {
            const k = s / len; const sz = s / (j.zs || 1); // wave spacing scales with zoom
            const sway = Math.sin(sz * 0.25 - t * 2.4 + tt.ph) * (0.1 + 0.8 * k) * R * 0.15;
            const [x, y] = toWorld(j, tu + tt.spread * R * 0.12 + tt.spread * s * 0.12 + sway, tv + s, k);
            const band = 0.8 + 0.2 * Math.sin(sz * 3);
            plot(x, y, (0.5 - 0.35 * k) * band * dim, j.shade(tt.hue - 0.4 * k));
          }
        }
      }
    },

    update(j, dt) {
      // pick a new heading every few seconds; never point downward
      j.turnIn -= dt;
      if (j.turnIn <= 0) {
        j.target = clamp(j.angle + rand(-0.8, 0.8), -1.0, 1.0);
        j.turnIn = rand(2, 5);
      }
      j.angle += (j.target - j.angle) * Math.min(1, dt * 1.5);
      const sp = j.speed * (0.2 + 1.3 * (j.c || 0)) * dt;
      j.x += Math.sin(j.angle) * sp;
      j.y -= Math.cos(j.angle) * sp;
      const m = j.R * 3 + j.L;
      return j.y + j.L + j.R * 2 < 0 || j.x < -m || j.x > worldW() + m;
    },
  };

  // ================= 3. STALKED JELLYFISH (Staurozoa) =================
  // Anchored to the seabed: a stalk, a cup (calyx) opening upward, and
  // eight arms each ending in a pom-pom of knobbed tentacles.

  const Stauro = {
    make() {
      const R = Math.max(4, rows * rand(0.07, 0.1));
      // spread along the seabed, away from other stalked jellies
      const W = worldW();
      let x = rand(R * 2, W - R * 2), best = -1;
      for (let k = 0; k < 10; k++) {
        const cx = rand(R * 2, W - R * 2);
        let near = Infinity;
        for (const o of creatures) if (o.kind === 'stauro') near = Math.min(near, Math.abs(cx - o.x));
        if (near > best) { best = near; x = cx; }
      }
      return {
        kind: 'stauro', swims: false, R, x, y: seabedY(x), angle: 0,
        ...colourTraits(),
        ph: rand(0, Math.PI * 2),
        Hs: R * rand(0.7, 1.3),   // stalk height
        Hc: R * rand(1.0, 1.3),   // cup height
        tuft: 7 + Math.floor(Math.random() * 5),
      };
    },

    draw(j, t) {
      // the whole animal sways from its base in the current
      j.angle = 0.1 * Math.sin(t * 0.5 + j.ph) + 0.04 * Math.sin(t * 1.3 + j.ph * 2);
      const R = j.R;
      const hs = j.Hs / R, hc = j.Hc / R;
      const top = -(hs + hc);   // rim height (local, R units; up is negative)
      const ry = 0.22;          // rim ellipse half-height (cup seen slightly from above)
      const w = Math.max(0.03, 0.8 / R);

      // Stretch from being pulled (see stauroPull): the base stays stuck to
      // the seabed and each part moves further the higher up it is.
      const ca = Math.cos(j.angle), sa = Math.sin(j.angle);
      const lx = (j.sX || 0) * ca + (j.sY || 0) * sa;   // stretch in local rows
      const ly = -(j.sX || 0) * sa + (j.sY || 0) * ca;
      const Htot = hs + hc + 0.65;                       // full height, R units
      const bend = (up) => Math.pow(clamp(up / Htot, 0, 1), 1.6);
      const D = (u, v) => { const q = bend(-v / R); return [u + lx * q, v + ly * q]; };
      const stretchExt = Math.hypot(lx, ly);

      eachCell(j, j.Hs + j.Hc + R * 0.9 + stretchExt, (u0, v0, col, r) => {
        // Undo the stretch to find which point of the unstretched shape this
        // cell shows. The stretch only depends on height, so search for the
        // height whose stretched position lands on this cell (bisection) —
        // exact even for big stretches, so the body stays joined to the arms.
        let u = u0, v = v0;
        if (stretchExt > 0.01) {
          const Ly = ly / R;
          let lo = -0.6, hi = Htot + 0.6;           // heights to search between
          for (let it = 0; it < 14; it++) {
            const mid = (lo + hi) / 2;
            if (-mid + Ly * bend(mid) > v0) lo = mid; else hi = mid;
          }
          const up0 = (lo + hi) / 2;
          v = -up0;
          u = u0 - (lx / R) * bend(up0);
        }
        const up = -v;
        if (up < -0.3 || up > hs + hc + 0.5 || Math.abs(u) > 1.3) return;
        reset();
        // stalk, flaring into a small sticky disc at the base
        if (up <= hs + 0.05) {
          const sw = 0.09 + 0.05 * Math.max(0, 1 - up / (hs * 0.25));
          add(0.55 * gauss(Math.abs(u) - sw, w), 0);
          if (Math.abs(u) < sw) add(0.2, -0.2);
          add(0.45 * gauss(up, w) * (Math.abs(u) < 0.28 ? 1 : 0), -0.3);
        }
        // calyx: a funnel widening toward the rim
        const q = (up - hs) / hc;
        if (q >= 0 && q <= 1.02) {
          const hw = 0.12 + 0.88 * Math.pow(clamp(q, 0, 1), 1.5);
          const e = Math.abs(u) - hw;
          add(0.7 * gauss(e, w), -0.4);
          if (e < 0) {
            add(0.08 + 0.25 * Math.exp(e / 0.12), -0.1);
            // four internal septa (dividing walls) as faint lines
            let sI = 0;
            for (let k = 0; k < 4; k++) {
              const th = Math.PI / 8 + (k * Math.PI) / 4;
              sI += 0.12 * gauss(u - hw * Math.cos(th), w);
            }
            add(sI, 0.3);
            // gonads: glowing bands in the upper cup
            add(0.28 * gauss(q - 0.72, 0.14) * gauss(Math.abs(u) - hw * 0.6, 0.1), 0.9);
          }
        }
        // rim: an ellipse, since the cup is seen slightly from above
        const e2 = Math.hypot(u, (v - top) / ry) - 1;
        add(0.7 * gauss(e2, w * 1.2), 0.3);
        flush(j, col, r, t);
      });

      // eight arms, each tipped with a tuft of knobbed tentacles
      for (let k = 0; k < 8; k++) {
        const phi = (k * Math.PI) / 4 + 0.2;
        const dim = Math.sin(phi) > 0 ? 1 : 0.6; // front of the rim is lower on screen
        const bu = Math.cos(phi) * R, bv = (top + ry * Math.sin(phi)) * R;
        const flex = 0.15 * Math.sin(t * 0.9 + k * 1.3 + j.ph);
        const a0 = Math.atan2(-0.75, Math.cos(phi) * 0.7) + flex;
        const La = 0.42 * R;
        for (let s = 0; s < La; s += 0.3) {
          const [x, y] = toWorld(j, ...D(bu + Math.cos(a0) * s, bv + Math.sin(a0) * s));
          blob(x, y, R * 0.05, 0.55 * dim, j.shade(0.1));
        }
        const tu = bu + Math.cos(a0) * La, tv = bv + Math.sin(a0) * La;
        for (let m = 0; m < j.tuft; m++) {
          const a = a0 + (m / (j.tuft - 1) - 0.5) * 1.6 + 0.08 * Math.sin(t * 2 + m + k);
          const len = 0.2 * R * (0.8 + 0.2 * Math.sin(m * 1.7 + k));
          for (let s = 0; s < len; s += 0.3) {
            const [x, y] = toWorld(j, ...D(tu + Math.cos(a) * s, tv + Math.sin(a) * s));
            plot(x, y, 0.45 * dim, j.shade(0.4));
          }
          const [kx, ky] = toWorld(j, ...D(tu + Math.cos(a) * len, tv + Math.sin(a) * len));
          blob(kx, ky, R * 0.035, 0.85 * dim, j.shade(0.8));
        }
        // anchor (rhopalioid) between this arm and the next
        const pa = phi + Math.PI / 8;
        const [ax, ay] = toWorld(j, ...D(Math.cos(pa) * R, (top + ry * Math.sin(pa)) * R));
        blob(ax, ay, R * 0.04, 0.6 * (Math.sin(pa) > 0 ? 1 : 0.6), j.shade(0.6));
      }
    },

    update() { return false; }, // stays put on the sand
  };

  // ================= 4. HYDROMEDUSA (Hydrozoa) =================
  // Crystal-jelly style: a small flat glassy saucer, many fine canals with
  // gonads along them, a glowing rim, a velum shelf, a vase-shaped stomach
  // and a fringe of many short, fine tentacles.

  const Hydro = {
    make(initialY) {
      const R = Math.max(4, rows * rand(0.05, 0.085));
      const L = R * rand(0.6, 1.4);
      const y = initialY !== undefined ? initialY : spawnBelow(R, L);
      const nT = 50 + Math.floor(Math.random() * 40);
      const nC = Math.min(40 + Math.floor(Math.random() * 40), Math.max(10, Math.floor(R * 1.6)));
      return {
        kind: 'hydro', swims: true, R, y, x: pickX(R, y), angle: 0,
        ...colourTraits(),
        dome: rand(0.32, 0.48),
        wid: rand(0.9, 1.1),
        freq: rand(0.6, 0.95),
        ph: rand(0, Math.PI * 2),
        rise: R * rand(0.6, 1.1),
        drift: rand(-0.5, 0.5),
        pulseAmt: rand(0.8, 1.2),
        L,
        canals: Array.from({ length: nC }, (_, i) => {
          const th = (i / nC) * Math.PI * 2;
          return { c: Math.cos(th), dim: Math.sin(th) > 0 ? 1 : 0.5 };
        }),
        tentacles: Array.from({ length: nT }, (_, i) => {
          const th = (i / nT) * Math.PI * 2 + rand(-0.03, 0.03);
          return { x: Math.cos(th), front: Math.sin(th) > 0, len: rand(0.6, 1),
                   ph: rand(0, Math.PI * 2), hue: rand(-0.6, 0.2) };
        }),
      };
    },

    draw(j, t) {
      const c = (j.c = pulse(j, t));
      const sx = (1 - 0.12 * c * j.pulseAmt) * j.wid * (1 + j.wob);
      const sy = (1 + 0.15 * c * j.pulseAmt) * (1 - j.wob);
      const R = j.R, dome = j.dome;
      const w = Math.max(0.03, 0.8 / R);
      const bot = (nx) => 0.04 + 0.07 * nx * nx;
      const mTop = -dome * 0.55;

      eachCell(j, R * 1.3 * j.wid, (u, v, col, r) => {
        const nx = u / sx, ny = v / sy;
        const ax = Math.abs(nx);
        const e = ny < 0 ? Math.hypot(nx, ny / dome) - 1 : ax - 1;
        const db = bot(nx) - ny;
        if (e > 3 * w || db < -3 * w || ny < -dome - 0.3) return;
        reset();
        if (e < 0 && db > 0) {
          add(0.06, -0.3);
          add(0.28 * Math.exp(e / 0.14), -0.1);
          // canals, brighter in the middle where the gonads run along them
          const hw = ny < 0 ? Math.sqrt(Math.max(0, 1 - (ny / dome) ** 2)) : 1;
          const gonad = gauss(hw - 0.65, 0.2);
          let cI = 0;
          for (const cn of j.canals) cI += cn.dim * gauss(nx - hw * cn.c, w);
          add(Math.min(0.6, cI * (0.08 + 0.18 * gonad)) * Math.min(1, hw * 3), 0.35);
          // vase-shaped stomach (manubrium) with mouth lips
          if (ny > mTop) {
            const q = (ny - mTop) / (bot(0) - mTop);
            const mw = 0.2 + 0.08 * q + 0.02 * Math.sin(q * 12 + t * 2);
            add(0.35 * gauss(ax - mw, w), 0.6);
            if (ax < mw + 0.05) add(0.4 * gauss(ny - bot(0) + 0.02, w), 0.7);
          }
          // velum: thin shelf reaching inward from the rim
          if (ax > 0.68) add(0.35 * gauss(ny - (bot(nx) - 0.05), w), 0.2);
        }
        if (db > -w) add(0.75 * gauss(e, w), -0.5); // membrane
        if (e < w) add(0.85 * gauss(db, w), 1.0);   // glowing rim ring
        flush(j, col, r, t);
      });

      // fringe of fine tentacles, each with a bright bulb at its base
      for (const tn of j.tentacles) {
        const u0 = tn.x * R * sx, v0 = bot(tn.x) * R * sy;
        const dim = tn.front ? 1 : 0.55;
        const [bx, by] = toWorld(j, u0, v0);
        plot(bx, by, 0.75 * dim, j.shade(0.9));
        const len = j.L * tn.len;
        for (let s = 0.35; s < len; s += 0.35) {
          const k = s / len; const sz = s / (j.zs || 1); // wave spacing scales with zoom
          const sway = Math.sin(sz * 0.5 - t * 1.8 + tn.ph) * (0.1 + 0.6 * k) * R * 0.12;
          const [x, y] = toWorld(j, u0 * (1 + 0.1 * k) + sway, v0 + s, k);
          plot(x, y, (0.4 - 0.3 * k) * dim, j.shade(tn.hue - 0.3 * k));
        }
      }
    },

    update: riseUpdate,
  };

  // ================= 5. SIPHONOPHORE (Portuguese man o' war) =================
  // A colony, not one animal: a gas float with a pleated crest sits at the
  // surface, a cluster of feeding polyps hangs beneath, and a few very long
  // beaded fishing tentacles trail down. Drifts sideways with the wind.

  // how the man o' war's float returns to the waterline
  const FLOAT = {
    spring: 5,     // pull toward the waterline per row away
    maxRise: 40,   // strongest pull (caps the rising/sinking speed when far away)
    drag: 2.4,     // water resistance (lower = more bobbing as it settles)
    gravity: 90,   // pull down when lifted out of the water (rows/s²)
    airDrag: 0.4,  // air resistance while falling (much less than water)
    splash: 0.35,  // speed kept when it hits the water (lower = shallower plunge)
    surge: 1.2,    // back-and-forth push from passing waves (rows/s)
    tilt: 1.5,     // how strongly it tilts with the wave slope
  };

  const Siphono = {
    make(initial) {
      const Fl = Math.max(5, rows * rand(0.09, 0.13)); // float half-length
      const dir = windDir;
      const W = worldW();
      let x;
      if (initial) {
        // spread out across the screen, away from the other floats
        let best = -1;
        for (let k = 0; k < 10; k++) {
          const cx = rand(Fl, W - Fl);
          let near = Infinity;
          for (const o of creatures) if (o.kind === 'siphono') near = Math.min(near, Math.abs(cx - o.x));
          if (near > best) { best = near; x = cx; }
        }
      } else {
        // drift in from just past the upwind edge — but behind any float
        // that is still coming in there, so they don't overlap
        let out = Fl * 1.3;
        for (const o of creatures) {
          if (o.kind !== 'siphono') continue;
          const oOut = dir > 0 ? -o.x : o.x - W;     // how far past the edge it is (−ve = on screen)
          if (oOut > Fl * 4) continue;               // far off-screen: about to be replaced, ignore
          out = Math.max(out, oOut + (o.R + Fl) * 1.15); // just far enough not to overlap
        }
        x = dir > 0 ? -out : W + out;
      }
      const nF = 5 + Math.floor(Math.random() * 5);
      const nZ = 18 + Math.floor(Math.random() * 10);
      return {
        kind: 'siphono', swims: false, R: Fl, x, y: surfaceBase(), angle: 0,
        ...colourTraits(),
        fh: rand(0.3, 0.38),                 // float height / length
        flip: Math.random() < 0.5 ? 1 : -1,  // which end tapers
        dir,
        speed: rand(1.2, 2.0),             // wind drift, rows per second
        ph: rand(0, Math.PI * 2),
        fishing: Array.from({ length: nF }, () => ({
          u: rand(-0.7, 0.1), len: rows * rand(0.45, 0.9),
          ph: rand(0, Math.PI * 2), hue: rand(-0.8, 0.2),
        })),
        zooids: Array.from({ length: nZ }, () => ({
          u: rand(-0.75, 0.55), len: Fl * rand(0.12, 0.35),
          ph: rand(0, Math.PI * 2), hue: rand(-0.2, 0.8),
        })),
      };
    },

    draw(j, t) {
      const Fl = j.R, fh = j.fh, flip = j.flip;
      const w = Math.max(0.02, 0.8 / Fl);
      // float profile: half-height along its length, tapered at one end
      const hh = (U) => fh * Math.sqrt(Math.max(0, 1 - U * U)) * (1 - 0.3 * U);
      const crest = (U) => 0.55 * fh * Math.max(0, Math.sin((Math.PI * (U + 0.65)) / 1.35)) *
                           (U > -0.65 && U < 0.7 ? 1 : 0);

      eachCell(j, Fl * 1.25, (u, v, col, r) => {
        const U = u * flip;
        if (Math.abs(U) > 1.05) return;
        const h = hh(U);
        const av = Math.abs(v);
        const ch = crest(U);
        const crestTop = -(h + ch * (0.85 + 0.15 * Math.sin(U * 28 + t * 0.5)));
        if (av > h + 3 * w && !(v < 0 && v > crestTop - 3 * w)) return;
        reset();
        add(0.8 * gauss(av - h, w), -0.4);          // float outline
        if (av < h) {
          add(0.1 + 0.25 * Math.exp((av - h) / 0.05), -0.1);
          add(0.2 * gauss(v + h * 0.55, 0.06) * (Math.abs(U) < 0.6 ? 1 : 0), 0.5); // sheen
        }
        if (ch > 0 && v < -h + w) {                  // pleated crest (sail)
          if (v > crestTop) add(0.08 + 0.25 * Math.pow(Math.abs(Math.sin(U * 26)), 6), 0.7);
          add(0.75 * gauss(v - crestTop, w), 0.6);
        }
        flush(j, col, r, t);
      });

      // feeding polyps: short curly strands with knobs, under the float
      const zs = j.zs || 1; // zoom scale (lengths below are stored unzoomed)
      for (const z of j.zooids) {
        const bu = z.u * flip * Fl, bv = hh(z.u) * Fl;
        const zlen = z.len * zs;
        let x = 0, y = 0;
        for (let s = 0; s < zlen; s += 0.35) {
          const k = s / zlen;
          const curl = Math.sin((s / zs) * 0.9 - t * 1.5 + z.ph) * k * Fl * 0.05;
          [x, y] = toWorld(j, bu + curl, bv + s, k * 0.4);
          plot(x, y, 0.45, j.shade(z.hue));
        }
        blob(x, y, Fl * 0.03, 0.6, j.shade(z.hue + 0.2));
      }

      // long fishing tentacles, beaded with stinging-cell clusters,
      // trailing behind the drift and slowly contracting
      for (const f of j.fishing) {
        const bu = f.u * flip * Fl, bv = hh(f.u) * Fl;
        const len = f.len * zs * (0.75 + 0.25 * Math.sin(t * 0.25 + f.ph));
        for (let s = 0; s < len; s += 0.4) {
          const k = s / len, sz = s / zs;
          const sway = Math.sin(sz * 0.06 - t * 0.9 + f.ph) * (0.05 + 0.95 * k) * rows * 0.04 * zs;
          const lag = -j.dir * k * len * 0.15;
          const [x, y] = toWorld(j, bu + sway + lag, bv + s, k);
          const bead = 0.65 + 0.6 * Math.pow(Math.max(0, Math.sin(sz * 1.4 + f.ph)), 10);
          plot(x, y, Math.min(1, (0.45 - 0.3 * k) * bead), j.shade(f.hue - 0.3 * k));
        }
      }
    },

    update(j, dt) {
      const wt = simTime; // the same clock the drawn waves use
      // blown along by the wind, plus a little back-and-forth as each wave
      // passes underneath (water at a crest moves forward, in a trough back)
      // height of the swell here: +1 at a crest, −1 in a trough
      const crest = -Math.sin(swellPhase(j.x, wt));
      j.x += (j.dir * j.speed + j.dir * FLOAT.surge * crest) * dt;

      // Buoyancy: the float wants to ride the wave right under it. Pushed
      // under, it rises back at a steady rate, slowed by the water; lifted
      // into the air, it drops back. A little overshoot gives a bob.
      const rest = surfaceY(j.x, wt) - j.R * j.fh * 0.35;
      j.fvy = j.fvy || 0;
      const inAir = j.y < rest - 0.5;
      if (inAir) {
        // out of the water: falls under gravity, with only light air drag
        j.fvy += (FLOAT.gravity - FLOAT.airDrag * j.fvy) * dt;
      } else {
        // hitting the water from the air: the splash soaks up most of the speed
        if (j.wasInAir) {
          j.fvy *= FLOAT.splash;
          j.tvy = (j.tvy || 0) * FLOAT.splash;
          j.wv = (j.wv || 0) + 1.5; // float squashes on impact
        }
        // in the water: buoyancy pulls it back to the waterline
        const pull = clamp((rest - j.y) * FLOAT.spring, -FLOAT.maxRise, FLOAT.maxRise);
        j.fvy += (pull - FLOAT.drag * j.fvy) * dt;
      }
      j.wasInAir = inAir;
      j.y += j.fvy * dt;

      // tilt to match the slope of the water under it
      const slope = (surfaceY(j.x + 1, wt) - surfaceY(j.x - 1, wt)) / 2;
      const tilt = Math.atan(slope) * FLOAT.tilt;
      j.angle += (tilt - j.angle) * Math.min(1, dt * 3);

      // gone as soon as all of it (float + tentacles trailing upwind) has
      // drifted off the downwind edge, so a replacement comes in right away
      if (j.trail === undefined) j.trail = Math.max(...j.fishing.map((f) => f.len)) * 0.15;
      const m = j.R * 1.1 + j.trail + 1;
      return j.dir > 0 ? j.x > worldW() + m : j.x < -m;
    },
  };

  const SPECIES = { scypho: Scypho, cubo: Cubo, stauro: Stauro, hydro: Hydro, siphono: Siphono,
                    polyp: POLYP_VIEW, ephyra: EPHYRA_VIEW };

  // ================= population & loop =================

  // a fresh set of creatures for a scene (the current one by default)
  function buildCreatures(name = scene) {
    const list = [];
    const prev = creatures;
    creatures = list; // so placement (pickX etc.) spaces them against each other
    for (const [kind, n] of Object.entries(SCENES[name])) {
      for (let i = 0; i < n; i++) {
        // spread the first swimmers from the top of the screen to just below it
        const y = rows * (0.1 + ((i + Math.random()) / n) * 1.1);
        list.push(kind === 'siphono' ? Siphono.make(true) : SPECIES[kind].make(y));
      }
    }
    creatures = prev;
    return list;
  }

  function populate() {
    // a new set of creatures (e.g. after a resize) cancels any zoom
    focus.mode = 'none'; focus.j = null; othersFade = 1;
    scroll.s = 0; scroll.target = null; scroll.anim = null; scroll.v = 0; pan.active = false;
    hideInfo();
    sceneLists = {};
    for (const name of SCENE_ORDER) listFor(name);    // every scene exists from the start
    creatures = listFor(scene);
    makeStars();
    makeSnow();
    makeScenery();
    makeStreaks();
    updateNav();
  }

  const navEl = document.getElementById('scene-nav');

  // show ↑ / ↓ buttons for the neighbouring scenes (hidden while zoomed in)
  function updateNav() {
    if (!navEl) return;
    const i = SCENE_ORDER.indexOf(scene);
    const busy = focus.mode !== 'none' || scrollBusy();
    navEl.classList.toggle('is-hidden', focus.mode !== 'none');
    navEl.innerHTML = `
      ${i > 0 ? `<button type="button" data-dir="-1" ${busy ? 'disabled' : ''}>↑ ${SCENE_LABEL[SCENE_ORDER[i - 1]]}</button>` : ''}
      <span class="scene-nav__here">${SCENE_LABEL[scene]}</span>
      ${i < SCENE_ORDER.length - 1 ? `<button type="button" data-dir="1" ${busy ? 'disabled' : ''}>↓ ${SCENE_LABEL[SCENE_ORDER[i + 1]]}</button>` : ''}`;
    navEl.querySelectorAll('[data-dir]').forEach((b) =>
      b.addEventListener('click', () => moveScene(+b.dataset.dir)));
  }

  let last = performance.now();
  let simTime = 0;

  function frame(now) {
    const rdt = Math.max(0.001, Math.min(0.05, (now - last) / 1000)); // real seconds
    const dt = rdt * TIME_SCALE;
    last = now;
    simTime += dt;
    const t = simTime;

    field.fill(0);
    stepScroll(rdt); // scroll position first, so everything this frame uses it
    drawEnvironment(t, dt);

    stepFocus(rdt);
    const focused = focus.mode !== 'none'; // time stops for everything else
    camY = -scroll.s;                      // this scene scrolls with the view

    // dragging / throws / pulls first, then bump everything apart, so the
    // tentacle and bell jiggle below responds to both
    if (!focused) {
      for (const j of creatures) {
        const held = drag.j === j;
        if (j.kind === 'stauro') stauroPull(j, rdt, held);
        else if (held) dragFollow(j, rdt); else coast(j, rdt);
      }
      collide(rdt);
    }

    for (let i = 0; i < creatures.length; i++) {
      const j = creatures[i];
      const sp = SPECIES[j.kind];
      const isFocus = focus.j === j;
      // each creature has its own clock; frozen creatures' clocks stop, so
      // they resume exactly where they left off
      if (focused && !isFocus) j.tOff = (j.tOff || 0) + dt;
      const jt = t - (j.tOff || 0);
      plotGain = isFocus ? focusGain : othersFade;
      if (!focused) {
        const held = drag.j === j;
        jiggle(j, rdt);
        if (plotGain > 0.01) drawCounted(sp, j, jt); // (faded out: keep the last count)
        // a held creature doesn't swim on its own and can't leave the screen
        if (!held && shouldReplace(j, sp.update(j, dt, jt), rdt)) {
          creatures.splice(i, 1);
          creatures.splice(i, 0, spawnHidden(sp.make()));
        }
      } else {
        // focused jelly keeps pulsing in place; the rest are frozen
        if (isFocus) jiggle(j, rdt);
        if (plotGain > 0.01) drawCounted(sp, j, jt);
      }
    }
    if (focus.j && focus.j.proxy) {
      plotGain = focusGain;
      drawCounted(SPECIES[focus.j.kind], focus.j, t);
    }
    plotGain = 1;

    // Every other scene keeps running too, as if you were on each one, and
    // is drawn in its place in the stack — so whatever of them comes into
    // view (a scene sliding in, a straggler hanging past an edge) is already
    // there, and only ever leaves by moving out of view.
    if (!focused) {
      for (const name of SCENE_ORDER) {
        if (name === scene) continue;
        camY = offsetOf(name);
        runNeighbour(listFor(name), rdt, dt, t);
      }
    }
    camY = 0;
    drawSpeedLines(rdt);

    // render the grid
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter';

    for (let r = 0; r < rows; r++) {
      const dy = (r * cellH - pad) * dpr;
      for (let col = 0; col < cols; col++) {
        const k = r * cols + col;
        const I = field[k];
        if (I < 0.04) continue;
        const l = Math.min(LEVELS - 1, Math.max(1, Math.round(I * (LEVELS - 1))));
        ctx.drawImage(atlas, l * gw, owner[k] * gh, gw, gh,
                      (col * cellW - pad) * dpr, dy, gw, gh);
      }
    }

    requestAnimationFrame(frame);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  resize();
  requestAnimationFrame(frame);
})();
