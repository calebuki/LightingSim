// TV groups. TVs in the same group are one display: the picture covers the box around all of them,
// and each TV shows the part of it where it physically sits, gaps included.
// TVs in no group each show the whole picture: the scene's, or their own if they have one.

export const TV_WIDTH = 0.22; // of the stage's width, at size 1
export const GROUPS = ['A', 'B', 'C'];

/** A TV's rectangle in stage space (x 0..aspect, y 0..1 downward). */
export function tvBox(f, stageAspect) {
  const w = TV_WIDTH * (f.size || 1) * stageAspect;
  const h = (w * 9) / 16;
  return { l: f.x * stageAspect - w / 2, t: f.y - h / 2, w, h };
}

/**
 * One entry per picture that has to be drawn, biggest group first.
 * region is [u, v, du, dv] in texture space (v runs upward).
 */
export function wallsOf(fixtures, stageAspect) {
  const screens = fixtures.filter((f) => f.shape === 'screen');
  const solo = screens.filter((f) => !f.wall && !f.own);
  const own = screens.filter((f) => !f.wall && f.own);
  const walls = [];
  for (const id of new Set(screens.filter((f) => f.wall).map((f) => f.wall))) {
    const members = screens.filter((f) => f.wall === id);
    const boxes = members.map((f) => tvBox(f, stageAspect));
    const l = Math.min(...boxes.map((b) => b.l)), t = Math.min(...boxes.map((b) => b.t));
    const r = Math.max(...boxes.map((b) => b.l + b.w)), bt = Math.max(...boxes.map((b) => b.t + b.h));
    const W = r - l, H = bt - t;
    walls.push({
      id,
      aspect: W / H,
      unitsWide: Math.max(1, (W * members.length) / boxes.reduce((a, b) => a + b.w, 0)),
      tvs: members.map((f, i) => {
        const b = boxes[i];
        return { f, region: [(b.l - l) / W, 1 - (b.t + b.h - t) / H, b.w / W, b.h / H] };
      }),
    });
  }
  walls.sort((a, b) => b.tvs.length - a.tvs.length);
  if (solo.length || (!walls.length && !own.length)) {
    walls.push({ id: '', aspect: 16 / 9, unitsWide: 1, tvs: solo.map((f) => ({ f, region: [0, 0, 1, 1] })) });
  }
  for (const f of own) {
    walls.push({ id: `tv:${f.id}`, aspect: 16 / 9, unitsWide: 1, visual: f.own, tvs: [{ f, region: [0, 0, 1, 1] }] });
  }
  return walls;
}
