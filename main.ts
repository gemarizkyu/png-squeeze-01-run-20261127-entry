// png-squeeze-01's entry: squeeze each screenshot into the smallest PNG, losslessly.
//
// For every instance under /input/<id>/image.png it writes /output/<id>/image.png:
//   1. decode the stored RGBA PNG;
//   2. screen every form the image can take exactly (palette by count and by
//      luminance, grey, grey+alpha, RGB, RGBA, a tRNS key where one applies)
//      under every filter choice (fixed, minimum-sum, fewest-pairs, brute
//      force), weighed by zlib, and keep the smallest;
//   3. deflate the winner's filtered data three ways — the screen's zlib
//      level 6 stream, zlib level 9, and this entry's own optimal-parsing
//      DEFLATE encoder (zdeflate.mjs) — and keep the smallest stream;
//   4. write the PNG with only the chunks the checker reads.
//
// The optimal parse is the slow part: at full strength (two refinement
// passes, 64-deep hash chains) it takes 2-7 s per screenshot and the
// round-1 entry timed out the grader's 60 s wall budget. It runs a single
// pass over 16-deep chains here: that keeps nearly all of its edge over
// zlib level 9 (a few hundred bytes per image on the practice set) at
// roughly a third of the cost, and the whole run finishes in ~19 s for
// eight screenshots instead of ~43 s. Deterministic: fixed sizes, fixed
// chain depths, no clock.
//
// Deterministic: fixed work budgets, no wall clock, no randomness, no
// environment input beyond the input/output directories. Node 22 runs it as
// `node /bot/main.ts`; it uses only Node's built-ins and the modules beside it.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodePng } from './png.mjs';
import { pngOfForm, screen } from './screen.mjs';
import { deflateOptimal, zlibWrap } from './zdeflate.mjs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  const best = screen(image.rgba, image.width, image.height, { brute: true });

  // The winner's filtered data, deflated three ways; the smallest stream wins.
  // Every candidate shares the winner's form, so the PLTE/tRNS chunk bytes
  // are the same for each and the stream lengths alone decide.
  const candidates: Uint8Array[] = [best.zlib];
  const level9 = deflateSync(best.data, { level: 9, memLevel: 9 });
  candidates.push(new Uint8Array(level9.buffer, level9.byteOffset, level9.length));
  // One optimal-parsing pass over 16-deep chains: the second refinement
  // pass costs as much as the first and buys little, while the single
  // pass still beats zlib level 9 on most images.
  const raw = deflateOptimal(best.data, { blockSize: 131072, iterations: 1, maxChain: 16 });
  candidates.push(zlibWrap(raw, best.data));
  let smallest = candidates[0];
  for (const c of candidates) if (c.length < smallest.length) smallest = c;

  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOfForm(image.width, image.height, best.form, smallest));
}
