// Decides what the TV shows right now and draws it, locked to the same beat clock as the lights.
import { S, beatNow, scene } from '../state.js';
import { Renderer } from './renderer.js';
import { resolveVisual } from './library.js';

/** The visual a scene plays. */
export const visualOfScene = (id) => resolveVisual(scene(id)?.visual);

export class TV {
  constructor(glCanvas) {
    this.canvas = glCanvas;
    this.r = new Renderer(glCanvas);
    this.stamp = 0;
    this.lastT = performance.now();
    this.black = 0;
    this.levelSlow = 0;
    this.frameRef = null;
    this.level = 0;
    this.hit = 0;
    this.current = null;
    this.frame = null;
    this.next = 0;
  }

  /** Feedback trails are tuned per step, so the picture advances at 60 Hz on any display. */
  due(now = performance.now()) {
    if (now < this.next - 3) return false;
    this.next = Math.max(this.next + 1000 / 60, now);
    return true;
  }

  get ok() { return !!this.r.gl; }

  /** What should be on screen at this beat, predicting launches the server has queued. */
  program(beat) {
    const e = S.status?.engine;
    const set = S.show.settings.tv || {};
    if (set.hold && set.held) return { vis: resolveVisual(set.held) };
    if (!e) return { vis: resolveVisual(null) };
    if (e.preview) return { vis: visualOfScene(e.preview) };
    let cur = e.current, tr = e.transition;
    const q = e.queued;
    if (q && beat >= q.at) {
      if (q.tr && q.tr.type !== 'cut' && q.tr.beats > 0) tr = { from: cur, start: q.at, beats: q.tr.beats, type: q.tr.type };
      cur = q.scene;
    }
    const vis = visualOfScene(cur);
    if (tr) {
      const p = (beat - tr.start) / tr.beats;
      if (p >= 0 && p < 1) {
        const from = visualOfScene(tr.from);
        if (from.id !== vis.id) return { vis, from, mix: p, mixType: tr.type };
      }
    }
    return { vis };
  }

  /** Tracks how hard the lights are hitting, so the TV moves with the actual pattern. */
  _lights(dt) {
    const f = S.frame;
    if (f && f !== this.frameRef) {
      this.frameRef = f;
      let sum = 0;
      const n = f.length;
      for (let i = 0; i < n; i += 3) sum += Math.max(f[i], f[i + 1], f[i + 2]);
      this.level = n ? sum / (n / 3) / 255 : 0;
    }
    this.levelSlow += (this.level - this.levelSlow) * (1 - Math.exp(-dt / 400));
    const rise = Math.max(0, this.level - this.levelSlow) * 3;
    this.hit = Math.max(rise, this.hit * Math.exp(-dt / 140));
    return Math.min(1, this.hit);
  }

  /** The energy fader's effect on motion, kept by the server so every screen agrees. */
  _phase(beat, energy) {
    const e = S.status?.engine;
    return e?.tv_phase == null ? 0 : e.tv_phase + (energy - 0.5) * Math.max(0, beat - e.beat);
  }

  /** Shared per-frame clock for the main output and every thumbnail. */
  tick(latencyMs = 0) {
    const now = performance.now();
    const dt = Math.min(100, now - this.lastT);
    this.lastT = now;
    this.r.pump();
    this.r.setPalette(S.show.palette.colors);
    const st = S.show.settings;
    const bpm = Math.max(1, (S.status?.clock.bpm || S.bpm || 120) * (S.speed || 1));
    const beat = beatNow() + (latencyMs / 60000) * bpm;
    const inBeat = beat - Math.floor(beat);
    const limit = st.max_flash_hz || 0;
    const maxDiv = limit > 0 ? Math.max(0.25, (limit * 60) / bpm) : 64;
    this.frame = {
      stamp: ++this.stamp,
      beat,
      time: now / 1000,
      kick: Math.max((1 - inBeat) ** 4, this._lights(dt)),
      maxDiv,
      maxStrobe: Math.min(maxDiv, (20 * 60) / bpm), // a 60 Hz picture can't flash cleanly past 20 a second
      energy: st.tv?.energy ?? 0.5,
      phase: this._phase(beat, st.tv?.energy ?? 0.5),
    };
    const e = S.status?.engine;
    const want = e?.blackout ? 1 : 0;
    this.black += (want - this.black) * Math.min(1, dt / 60);
    let gain = (e?.master ?? 1) * (e?.group_levels?.screens ?? 1) * (1 - this.black);
    if (e?.strobe) {
      const d = Math.min(st.strobe_div || 16, this.frame.maxDiv);
      gain *= (beat * d) % 1 < 0.5 ? 1 : 0;
    }
    this.output = { gain, flash: (e?.flash || 0) * (e?.blackout ? 0 : 1), flashColor: st.flash_color || '#ffffff' };
    return this.frame;
  }

  /** Render the live program into the bottom-left w x h of the GL canvas: a wall, or a part of one. */
  draw(w, h, wall, region) {
    const beat = this.frame.beat;
    const p = wall?.visual ? { vis: resolveVisual(wall.visual) } : this.program(beat);
    this.current = p.vis;
    // a shader that hasn't finished compiling keeps the old picture rather than flashing black
    if (!this.r.isReady(p.vis.id)) return false;
    if (p.from && !this.r.isReady(p.from.id)) p.from = null;
    this.r.fit(w, h);
    const layout = wall ? { slot: `main:${wall.id}`, aspect: wall.aspect, colsScale: wall.unitsWide, region } : {};
    return this.r.draw(w, h, { ...p, frame: this.frame, ...this.output, ...layout });
  }

  /** Render a small preview of any visual, with its own feedback state. */
  drawThumb(vis, w, h, slot = 'thumb') {
    if (!this.r.isReady(vis.id)) return false;
    this.r.fit(w, h);
    return this.r.draw(w, h, { vis, frame: this.frame, slot });
  }
}
