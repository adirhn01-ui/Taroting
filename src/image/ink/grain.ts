// The pencil's paper grain: a 64×64 tile of alpha noise the pencil mark is cut
// through (destination-in), so graphite reads as graphite rather than a flat
// felt-tip line.
//
// SEEDED, not random: the same stroke must paint the same pixels in the preview,
// in every export and after every reload, or WYSIWYG breaks and an exported file
// changes between two runs of the same project. xorshift32 from a fixed seed
// gives that for the price of a few integer ops per texel, once.
//
// Nothing here exists until the first pencil mark is painted: the tile is built
// lazily and cached for the life of the chunk (16 KB).

export const GRAIN_SIZE = 64;
export const GRAIN_SEED = 0x7a2b;
/** Texel alpha range: never fully clear (a pencil line with holes in it looks
 *  broken, not grainy), never below ~60% cover. */
export const GRAIN_ALPHA_MIN = 150;
export const GRAIN_ALPHA_MAX = 255;

/** The tile's alpha values, row-major, deterministic from GRAIN_SEED. */
export function grainAlpha(): Uint8Array {
  const out = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE);
  let x = GRAIN_SEED >>> 0;
  const span = GRAIN_ALPHA_MAX - GRAIN_ALPHA_MIN + 1;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = GRAIN_ALPHA_MIN + (x % span);
  }
  return out;
}

let tile: OffscreenCanvas | null = null;

/** The tile as an image (black, alpha = grain). Built on first use. */
export function grainTile(): OffscreenCanvas {
  if (tile) return tile;
  const c = new OffscreenCanvas(GRAIN_SIZE, GRAIN_SIZE);
  const g = c.getContext("2d");
  if (g) {
    const a = grainAlpha();
    const img = g.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    for (let i = 0; i < a.length; i++) img.data[i * 4 + 3] = a[i]!;
    g.putImageData(img, 0, 0);
  }
  tile = c;
  return c;
}

const patterns = new WeakMap<object, CanvasPattern | null>();

/** A repeating grain pattern for one context (patterns are created per context
 *  and kept for as long as that context lives). Its space is the user space in
 *  force when it is used, so filling in LAYER-LOCAL coordinates anchors the
 *  grain to the drawing: it does not swim when the view pans or zooms. */
export function grainPattern(ctx: OffscreenCanvasRenderingContext2D): CanvasPattern | null {
  let p = patterns.get(ctx);
  if (p === undefined) {
    p = ctx.createPattern(grainTile(), "repeat");
    patterns.set(ctx, p);
  }
  return p;
}
