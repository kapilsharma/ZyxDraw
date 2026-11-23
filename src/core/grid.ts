/**
 * Helpers for the drawing view's grid and mouse coordinates (pure: no DOM).
 */

/**
 * Grid spacing for a zoom of `pxPerUnit` screen pixels per drawing unit: the smallest step of
 * 1, 2, 5, 10, 20, 50, ... that is at least `minPx` pixels apart on screen, and a major step
 * on round numbers: 1 -> 5, 2 -> 10, 5 -> 10, 10 -> 50, ...
 */
export function gridSteps(pxPerUnit: number, minPx = 8): { minor: number; major: number } {
  const scale = pxPerUnit > 0 && Number.isFinite(pxPerUnit) ? pxPerUnit : 1;
  let minor = 1;
  for (let decade = 0.01; ; decade *= 10) {
    const found = [1, 2, 5].map((m) => m * decade).find((s) => s * scale >= minPx);
    if (found !== undefined) {
      minor = round(found);
      break;
    }
    if (decade > 1e6) break;
  }
  const lead = Number(String(minor).replace(/[0.]/g, "")[0]);
  const major = round(lead === 5 ? minor * 2 : minor * 5);
  return { minor, major };
}

/**
 * Path data for grid lines every `step` units across the area, as `M x y V y2` and `M x y H x2`
 * segments. Lines on multiples of `skip` are left out (they are drawn as major lines).
 */
export function gridPath(x: number, y: number, w: number, h: number, step: number, skip?: number): string {
  if (!(step > 0) || !(w > 0) || !(h > 0)) return "";
  const parts: string[] = [];
  const onSkip = (v: number) => skip !== undefined && Math.abs(v / skip - Math.round(v / skip)) < 1e-6;
  for (let v = Math.ceil(x / step - 1e-9) * step; v <= x + w + 1e-9; v += step) {
    const at = round(v);
    if (!onSkip(at)) parts.push(`M${at} ${round(y)}V${round(y + h)}`);
  }
  for (let v = Math.ceil(y / step - 1e-9) * step; v <= y + h + 1e-9; v += step) {
    const at = round(v);
    if (!onSkip(at)) parts.push(`M${round(x)} ${at}H${round(x + w)}`);
  }
  return parts.join("");
}

/**
 * Snaps a drag: the movement `d` changed so that `anchor + d` lands on a multiple of `step`.
 * A null anchor (that axis is not being dragged) leaves `d` as it is.
 */
export function snapDelta(anchor: number | null, d: number, step: number): number {
  if (anchor === null || !(step > 0)) return d;
  return round(Math.round((anchor + d) / step) * step - anchor);
}

/** A coordinate with as many decimals as the zoom makes meaningful (0, 1 or 2). */
export function formatCoordinate(n: number, pxPerUnit: number): string {
  const decimals = pxPerUnit >= 10 ? 2 : pxPerUnit >= 1 ? 1 : 0;
  const f = 10 ** decimals;
  const v = Math.round(n * f) / f;
  return String(Object.is(v, -0) ? 0 : v);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
