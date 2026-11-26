/**
 * "At most … KB": the best setting whose file stays under a size.
 *
 * The settings go from the best (the largest file) to the smallest: JPG and WebP qualities from
 * the chosen one down, or PNG palettes from 256 colours down. A file's size falls with each
 * step, nearly always; the search halves the range between a setting known to be too large and
 * one known to fit, so 86 qualities (90 down to 5) take 9 encodings at most. When the size
 * does not fall evenly, what it returns still fits; it may not be the very best that does.
 *
 * When not even the last setting fits, the smallest file made is returned with `fits: false`:
 * the closest result, which the panel saves and marks as over the size.
 */

export interface Fitted<T> {
  readonly blob: Blob;
  readonly setting: T;
  readonly fits: boolean;
  /** How many files were made. */
  readonly tries: number;
}

export async function fitUnder<T>(
  settings: readonly T[],
  maxBytes: number,
  encode: (setting: T) => Promise<Blob>,
  signal?: AbortSignal,
): Promise<Fitted<T>> {
  if (settings.length === 0) throw new Error('Nothing to try.');
  const made = new Map<number, Blob>();
  const at = async (index: number): Promise<Blob> => {
    let blob = made.get(index);
    if (!blob) {
      signal?.throwIfAborted();
      blob = await encode(settings[index]!);
      made.set(index, blob);
    }
    return blob;
  };
  const result = async (index: number, fits: boolean): Promise<Fitted<T>> => ({
    blob: await at(index),
    setting: settings[index]!,
    fits,
    tries: made.size,
  });

  if ((await at(0)).size <= maxBytes) return result(0, true);
  const last = settings.length - 1;
  if ((await at(last)).size > maxBytes) {
    // The closest: the smallest file made (the last, unless the sizes did not fall evenly).
    let smallest = last;
    for (const [index, blob] of made) if (blob.size < made.get(smallest)!.size) smallest = index;
    return result(smallest, false);
  }
  // `over` is too large, `fits` fits.
  let over = 0;
  let fits = last;
  while (fits - over > 1) {
    const middle = (over + fits) >> 1;
    if ((await at(middle)).size <= maxBytes) fits = middle;
    else over = middle;
  }
  return result(fits, true);
}

/** Whole-number steps from `from` down to `to` (qualities in percent). */
export function steps(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = Math.round(from); value >= Math.round(to); value--) out.push(value);
  return out;
}
