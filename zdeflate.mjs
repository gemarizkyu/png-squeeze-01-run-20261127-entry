// A DEFLATE encoder in the manner of zopfli, written from RFC 1951 and the
// optimal-parsing idea: hash-chain match search, a shortest-path (dynamic
// programming) parse whose token costs come from the block's Huffman code
// lengths, two passes of cost refinement, fixed-size block splitting so each
// block carries its own Huffman tables, and a length-limited Huffman builder.
// It returns a raw DEFLATE bitstream; zlibWrap adds the zlib header and the
// Adler-32 checksum. Deterministic: no clock, no randomness, fixed work.

import { adler32 } from './png.mjs';

export const WSIZE = 32768;
export const MIN_MATCH = 3;
export const MAX_MATCH = 258;

/** Length codes 257..285: base length and extra bits (RFC 1951 section 3.2.5). */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
/** The longest length a length code stands for. Code 284 covers 227-257 (not
 * 227-258): length 258 has its own code, 285, with no extra bits (RFC 1951). */
const LEN_MAX = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 30, 34, 42, 50, 58, 66, 82, 98, 114, 130, 162, 194, 226, 257, 258];
/** Distance codes 0..29: base distance and extra bits. */
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** The length code of a match length, and its extra bits value. */
function lengthCode(len) {
  // LEN_MAX is increasing; find the first code whose max covers len.
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (LEN_MAX[mid] < len) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The distance code of a match distance, and its extra bits value. */
function distCode(dist) {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (DIST_BASE[mid] + (DIST_EXTRA[mid] === 0 ? 0 : (1 << DIST_EXTRA[mid]) - 1) < dist) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Fixed Huffman code lengths (RFC 1951 section 3.2.6). */
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

/** A bit writer: bits go out least-significant-bit first, as DEFLATE wants. */
class BitWriter {
  constructor(capacity) {
    this.out = new Uint8Array(Math.max(1024, capacity));
    this.at = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  grow(need) {
    if (this.at + 4 + need > this.out.length) {
      const next = new Uint8Array(Math.max(this.out.length * 2, this.at + need + 1024));
      next.set(this.out.subarray(0, this.at));
      this.out = next;
    }
  }
  writeBits(value, count) {
    this.bitBuf |= (value & ((1 << count) - 1)) << this.bitCnt;
    this.bitCnt += count;
    while (this.bitCnt >= 8) {
      this.grow(1);
      this.out[this.at++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  /** Flush the partial byte, padding with zero bits. */
  align() {
    if (this.bitCnt > 0) {
      this.grow(1);
      this.out[this.at++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
  bytes() {
    return this.out.subarray(0, this.at);
  }
}

/** Reverse the low `count` bits of `value` (Huffman codes go out most-significant-bit first). */
function reverseBits(value, count) {
  let r = 0;
  for (let i = 0; i < count; i++) {
    r = (r << 1) | (value & 1);
    value >>>= 1;
  }
  return r;
}

/**
 * Code lengths (at most `maxBits`) for symbols with the given frequencies:
 * a Huffman tree built by sorting, then zlib's overflow fix when a length
 * would pass the limit, then lengths reassigned by frequency order. Symbols
 * with frequency 0 get length 0.
 */
export function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  let nonzero = 0;
  for (let i = 0; i < n; i++) if (freq[i] > 0) nonzero++;
  if (nonzero === 0) return lengths;
  if (nonzero === 1) {
    for (let i = 0; i < n; i++) if (freq[i] > 0) { lengths[i] = 1; break; }
    return lengths;
  }
  // Build the tree by repeatedly joining the two lightest nodes. `nodes` holds
  // [frequency, symbol-or-node-index]; leaves are 0..n-1, joins are n...
  const count = new Int32Array(n);
  for (let i = 0; i < n; i++) count[i] = freq[i];
  // Small priority queue by frequency, ties by depth-then-symbol for determinism.
  const heap = [];
  const push = (f, s) => {
    heap.push([f, s]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] < heap[i][0] || (heap[p][0] === heap[i][0] && heap[p][1] <= heap[i][1])) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l][0] < heap[m][0] || (heap[l][0] === heap[m][0] && heap[l][1] < heap[m][1]))) m = l;
        if (r < heap.length && (heap[r][0] < heap[m][0] || (heap[r][0] === heap[m][0] && heap[r][1] < heap[m][1]))) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) push(freq[i], i);
  // `depth[s]` grows by one each time the node holding s is joined.
  const depth = new Uint8Array(n);
  const members = new Array(n);
  for (let i = 0; i < n; i++) if (freq[i] > 0) members[i] = [i];
  let nextNode = n;
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    const ma = members[a[1]];
    const mb = members[b[1]];
    for (const s of ma) depth[s]++;
    for (const s of mb) depth[s]++;
    const joined = ma.concat(mb);
    members[nextNode] = joined;
    push(a[0] + b[0], nextNode);
    nextNode++;
  }
  for (let i = 0; i < n; i++) lengths[i] = freq[i] > 0 ? depth[i] : 0;
  // Overflow fix (zlib's gen_bitlen): move leaves down until no length passes maxBits.
  const blCount = new Int32Array(maxBits + 2);
  let overflow = 0;
  for (let i = 0; i < n; i++) {
    if (lengths[i] === 0) continue;
    if (lengths[i] > maxBits) {
      overflow++;
      lengths[i] = maxBits;
    }
    blCount[lengths[i]]++;
  }
  if (overflow > 0) {
    do {
      let bits = maxBits - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxBits]--;
      overflow -= 2;
    } while (overflow > 0);
    // Reassign lengths by frequency order from the counts.
    const order = [];
    for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
    order.sort((a, b) => freq[b] - freq[a] || a - b);
    let at = 0;
    lengths.fill(0);
    for (let bits = 1; bits <= maxBits; bits++) {
      for (let k = 0; k < blCount[bits]; k++) lengths[order[at++]] = bits;
    }
  }
  return lengths;
}

/** Canonical Huffman codes from code lengths: codes[symbol], lengths in bits. */
export function huffmanCodes(lengths) {
  const maxBits = Math.max(0, ...lengths);
  const blCount = new Int32Array(maxBits + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Int32Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Int32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (len > 0) codes[i] = reverseBits(nextCode[len]++, len);
  }
  return codes;
}

/** The order the code-length code's lengths are written in (RFC 1951 section 3.2.7). */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Hash the three bytes at `p` into 15 bits. */
function hash3(data, p) {
  return ((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) & 0x7fff;
}

/**
 * The optimal parse of one block: the token stream (literals and
 * length/distance matches) of least cost under the given per-symbol bit
 * costs, by dynamic programming over the block. Costs are in sixteenths of a
 * bit. `state` carries the hash chains across blocks (matches may reach back
 * 32 KiB into earlier blocks). Returns the tokens as two parallel arrays:
 * `tokLit` (literal byte, or -1 for a match) and `tokMatch` (length<<16 |
 * distance, or 0 for a literal).
 */
function optimalParse(data, bs, be, litCost, distCost, state, opts) {
  const len = be - bs;
  const { maxChain, niceLen, longCut } = opts;
  const cost = new Int32Array(len + 1);
  cost.fill(0x3fffffff);
  cost[0] = 0;
  const tokLen = new Uint16Array(len + 1);
  const tokDist = new Uint16Array(len + 1);
  // Length-code part of a match token's cost, by length code (extra bits included).
  const lenPart = new Int32Array(29);
  for (let r = 0; r < 29; r++) lenPart[r] = litCost[257 + r] + LEN_EXTRA[r] * 16;

  const head = state.head;
  const prev = state.prev;
  let inserted = state.inserted;
  const n = data.length;

  for (let i = 0; i < len; i++) {
    const p = bs + i;
    const base = cost[i];
    if (base >= 0x3fffffff) continue;
    // Insert every position up to p into the chains, so a later match may
    // start anywhere, even inside a token this parse already placed.
    while (inserted < p && inserted + 2 < n) {
      const h = hash3(data, inserted);
      prev[inserted] = head[h];
      head[h] = inserted;
      inserted++;
    }
    state.inserted = inserted;

    // Literal.
    const lit = base + litCost[data[p]];
    if (lit < cost[i + 1]) {
      cost[i + 1] = lit;
      tokLen[i + 1] = 1;
      tokDist[i + 1] = 0;
    }
    if (p + 2 >= n) continue;

    // Match search: walk the chain of positions with the same three bytes.
    const h = hash3(data, p);
    let cand = head[h];
    let chain = 0;
    let longLen = 0;
    let longDist = 0;
    let nearLen = 0;
    let nearDist = 0;
    const maxLen = Math.min(MAX_MATCH, n - p);
    while (cand >= 0 && chain < maxChain && p - cand <= WSIZE) {
      chain++;
      // Match length against cand, capped by the best so far (plus one: a
      // candidate must beat longLen to matter, but the nearest match is
      // recorded at its true length even when it cannot win).
      let l = 0;
      const limit = Math.min(maxLen, longLen + 1);
      while (l < limit && data[cand + l] === data[p + l]) l++;
      if (l === limit && limit <= maxLen && longLen < maxLen) {
        // It may run longer than longLen: measure the full length.
        while (l < maxLen && data[cand + l] === data[p + l]) l++;
      }
      if (l >= MIN_MATCH) {
        if (nearLen === 0) {
          nearLen = l;
          nearDist = p - cand;
        }
        if (l > longLen) {
          longLen = l;
          longDist = p - cand;
          if (longLen >= niceLen) break;
        }
      }
      cand = prev[cand];
    }
    if (longLen < MIN_MATCH && nearLen < MIN_MATCH) continue;

    const maxL = Math.min(longLen, be - p);
    // Try the longest length in each length-code range, for the longest
    // match's distance and for the nearest match's distance.
    for (let d = 0; d < 2; d++) {
      const dist = d === 0 ? longDist : nearDist;
      const ml = d === 0 ? maxL : Math.min(nearLen, be - p);
      if (dist === 0 || ml < MIN_MATCH) continue;
      if (d === 1 && dist === longDist) continue;
      const dc = distCode(dist);
      const distPart = distCost[dc] + DIST_EXTRA[dc] * 16;
      if (ml >= longCut) {
        // A long match: only its longest length can win in a flat run.
        const r = lengthCode(ml);
        const nc = base + lenPart[r] + distPart;
        if (nc < cost[i + ml]) {
          cost[i + ml] = nc;
          tokLen[i + ml] = ml;
          tokDist[i + ml] = dist;
        }
        continue;
      }
      for (let r = 0; r < 29; r++) {
        if (LEN_BASE[r] > ml) break;
        const L = Math.min(LEN_MAX[r], ml);
        if (L < MIN_MATCH) continue;
        const nc = base + lenPart[r] + distPart;
        if (nc < cost[i + L]) {
          cost[i + L] = nc;
          tokLen[i + L] = L;
          tokDist[i + L] = dist;
        }
      }
    }
  }

  // Backtrack the tokens.
  const tokLit = [];
  const tokMatch = [];
  let i = len;
  while (i > 0) {
    const L = tokLen[i];
    const D = tokDist[i];
    if (D === 0) {
      tokLit.push(data[bs + i - 1]);
      tokMatch.push(0);
      i -= 1;
    } else {
      tokLit.push(-1);
      tokMatch.push((L << 16) | D);
      i -= L;
    }
  }
  tokLit.reverse();
  tokMatch.reverse();
  return { tokLit, tokMatch };
}

/** Frequencies of the literal/length and distance symbols a token stream uses. */
function tokenFrequencies(tokLit, tokMatch) {
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(30);
  for (let k = 0; k < tokLit.length; k++) {
    if (tokLit[k] >= 0) litFreq[tokLit[k]]++;
    else {
      const m = tokMatch[k];
      const len = m >>> 16;
      const dist = m & 0xffff;
      litFreq[257 + lengthCode(len)]++;
      distFreq[distCode(dist)]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

/** The bit cost of a token stream under the given code lengths (end of block included). */
function tokensBitCost(tokLit, tokMatch, litLen, distLen) {
  let bits = litLen[256];
  for (let k = 0; k < tokLit.length; k++) {
    if (tokLit[k] >= 0) bits += litLen[tokLit[k]];
    else {
      const m = tokMatch[k];
      const len = m >>> 16;
      const dist = m & 0xffff;
      const lc = lengthCode(len);
      bits += litLen[257 + lc] + LEN_EXTRA[lc];
      const dc = distCode(dist);
      bits += distLen[dc] + DIST_EXTRA[dc];
    }
  }
  return bits;
}

/**
 * A dynamic block's header, built once and used both to weigh the block
 * (exact bit count) and to emit it: the trimmed HLIT/HDIST, the
 * run-length-coded code-length sequence, its Huffman code, and the header's
 * bit count not counting the 3-bit BFINAL/BTYPE prefix.
 */
function dynamicBlockHeader(litLen, distLen) {
  let hlit = 29;
  while (hlit > 0 && litLen[257 + hlit - 1] === 0) hlit--;
  hlit += 257;
  let hdist = 29;
  while (hdist > 0 && distLen[1 + hdist - 1] === 0) hdist--;
  hdist += 1;
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLen.subarray(0, hlit), 0);
  seq.set(distLen.subarray(0, hdist), hlit);
  const clFreq = new Int32Array(19);
  const rle = []; // [symbol, extra] pairs, symbol 0..18
  for (let i = 0; i < seq.length;) {
    const v = seq[i];
    if (v === 0) {
      let run = 0;
      while (i + run < seq.length && seq[i + run] === 0 && run < 138) run++;
      if (run >= 3) {
        if (run <= 10) {
          rle.push([17, run - 3]);
          clFreq[17]++;
        } else {
          rle.push([18, run - 11]);
          clFreq[18]++;
        }
      } else {
        for (let k = 0; k < run; k++) {
          rle.push([0, 0]);
          clFreq[0]++;
        }
      }
      i += run;
    } else {
      rle.push([v, 0]);
      clFreq[v]++;
      i++;
      let run = 0;
      while (i + run < seq.length && seq[i + run] === v && run < 6) run++;
      if (run >= 3) {
        rle.push([16, run - 3]);
        clFreq[16]++;
        i += run;
      }
    }
  }
  const clLen = huffmanLengths(clFreq, 7);
  const clCodes = huffmanCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 14 + hclen * 3;
  for (const [sym, extra] of rle) {
    bits += clLen[sym];
    if (sym === 16) bits += 2;
    else if (sym === 17) bits += 3;
    else if (sym === 18) bits += 7;
  }
  return { hlit, hdist, hclen, clLen, clCodes, rle, bits };
}

/** Emit one dynamic-Huffman block's header and tokens. */
function emitDynamicBlock(bw, last, tokLit, tokMatch, litLen, distLen, header) {
  const litCodes = huffmanCodes(litLen);
  const distCodes = huffmanCodes(distLen);
  const { hlit, hdist, hclen, clLen, clCodes, rle } = header;
  bw.writeBits(last ? 1 : 0, 1);
  bw.writeBits(2, 2);
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.writeBits(clLen[CL_ORDER[k]], 3);
  for (const [sym, extra] of rle) {
    bw.writeBits(clCodes[sym], clLen[sym]);
    if (sym === 16) bw.writeBits(extra, 2);
    else if (sym === 17) bw.writeBits(extra, 3);
    else if (sym === 18) bw.writeBits(extra, 7);
  }
  for (let k = 0; k < tokLit.length; k++) {
    if (tokLit[k] >= 0) {
      bw.writeBits(litCodes[tokLit[k]], litLen[tokLit[k]]);
    } else {
      const m = tokMatch[k];
      const len = m >>> 16;
      const dist = m & 0xffff;
      const lc = lengthCode(len);
      bw.writeBits(litCodes[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc] > 0) bw.writeBits(len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCode(dist);
      bw.writeBits(distCodes[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeBits(litCodes[256], litLen[256]);
}

/** Emit one fixed-Huffman block's tokens. */
function emitFixedBlock(bw, last, tokLit, tokMatch) {
  const litCodes = huffmanCodes(FIXED_LIT_LEN);
  const distCodes = huffmanCodes(FIXED_DIST_LEN);
  bw.writeBits(last ? 1 : 0, 1);
  bw.writeBits(1, 2);
  for (let k = 0; k < tokLit.length; k++) {
    if (tokLit[k] >= 0) {
      bw.writeBits(litCodes[tokLit[k]], FIXED_LIT_LEN[tokLit[k]]);
    } else {
      const m = tokMatch[k];
      const len = m >>> 16;
      const dist = m & 0xffff;
      const lc = lengthCode(len);
      bw.writeBits(litCodes[257 + lc], FIXED_LIT_LEN[257 + lc]);
      if (LEN_EXTRA[lc] > 0) bw.writeBits(len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCode(dist);
      bw.writeBits(distCodes[dc], 5);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeBits(litCodes[256], FIXED_LIT_LEN[256]);
}

/** Emit one stored block (no compression). */
function emitStoredBlock(bw, last, data, bs, be) {
  bw.align();
  bw.writeBits(last ? 1 : 0, 1);
  bw.writeBits(0, 2);
  bw.align();
  const len = be - bs;
  bw.grow(len + 4);
  bw.out[bw.at++] = len & 0xff;
  bw.out[bw.at++] = (len >>> 8) & 0xff;
  bw.out[bw.at++] = (~len) & 0xff;
  bw.out[bw.at++] = ((~len) >>> 8) & 0xff;
  bw.out.set(data.subarray(bs, be), bw.at);
  bw.at += len;
}

/**
 * The raw DEFLATE stream of `data`: split into blocks, each block parsed
 * optimally under its own Huffman costs (two passes of refinement), the
 * smaller of a dynamic- or fixed-Huffman block written, stored when both
 * lose. Deterministic: fixed sizes, fixed chain depths, no clock.
 */
export function deflateOptimal(data, opts = {}) {
  const blockSize = opts.blockSize ?? 131072;
  const iterations = opts.iterations ?? 2;
  const maxChain = opts.maxChain ?? 64;
  const niceLen = opts.niceLen ?? 64;
  const longCut = opts.longCut ?? 64;
  const n = data.length;
  const bw = new BitWriter(n);
  if (n === 0) {
    bw.writeBits(1, 1);
    bw.writeBits(1, 2);
    bw.writeBits(0, 7); // end of block, fixed code 0000000
    bw.align();
    return bw.bytes();
  }
  const state = {
    head: new Int32Array(32768).fill(-1),
    prev: new Int32Array(n),
    inserted: 0,
  };
  const parseOpts = { maxChain, niceLen, longCut };
  for (let bs = 0; bs < n; bs += blockSize) {
    const be = Math.min(n, bs + blockSize);
    const last = be === n;
    // The chains as they stand at this block's start, so a later refinement
    // pass re-scans the block with the same view of the past: without the
    // restore, the head would point at positions ahead of the scan.
    const headAtStart = state.head.slice();
    // Pass 0 costs: the fixed Huffman lengths.
    let litCost = new Int32Array(288);
    let distCost = new Int32Array(30);
    for (let i = 0; i < 288; i++) litCost[i] = FIXED_LIT_LEN[i] * 16;
    for (let i = 0; i < 30; i++) distCost[i] = 5 * 16;
    let tokens = null;
    let freqs = null;
    for (let it = 0; it < iterations; it++) {
      if (it > 0) {
        state.head.set(headAtStart);
        state.inserted = bs;
      }
      tokens = optimalParse(data, bs, be, litCost, distCost, state, parseOpts);
      freqs = tokenFrequencies(tokens.tokLit, tokens.tokMatch);
      const litLen = huffmanLengths(freqs.litFreq, 15);
      const distLen = huffmanLengths(freqs.distFreq, 15);
      // A symbol the last parse never used has no length in its table, but
      // the parse may still need it: price it at its fixed-Huffman length,
      // never at zero (which would make the parse take it for free and emit
      // all literals) and never at the longest code (which would price a
      // common symbol the last parse happened to cover by matches as if it
      // were rare). The fixed table is the honest prior for an unseen symbol.
      litCost = new Int32Array(288);
      distCost = new Int32Array(30);
      for (let i = 0; i < 288; i++) litCost[i] = (litLen[i] > 0 ? litLen[i] : FIXED_LIT_LEN[i]) * 16;
      for (let i = 0; i < 30; i++) distCost[i] = (distLen[i] > 0 ? distLen[i] : 5) * 16;
    }
    // Final lengths from the last parse's frequencies.
    const litLen = huffmanLengths(freqs.litFreq, 15);
    const distLen = huffmanLengths(freqs.distFreq, 15);
    const dynBits = tokensBitCost(tokens.tokLit, tokens.tokMatch, litLen, distLen);
    const fixBits = tokensBitCost(tokens.tokLit, tokens.tokMatch, FIXED_LIT_LEN, FIXED_DIST_LEN);
    const storedBits = (be - bs) * 8 + 40;
    const header = dynamicBlockHeader(litLen, distLen);
    const dynTotal = 3 + header.bits + dynBits;
    const fixTotal = 3 + fixBits;
    if (storedBits <= Math.min(dynTotal, fixTotal)) {
      emitStoredBlock(bw, last, data, bs, be);
    } else if (fixTotal <= dynTotal) {
      emitFixedBlock(bw, last, tokens.tokLit, tokens.tokMatch);
    } else {
      emitDynamicBlock(bw, last, tokens.tokLit, tokens.tokMatch, litLen, distLen, header);
    }
  }
  bw.align();
  return bw.bytes();
}

/** The zlib stream of `data`: header, the optimal raw DEFLATE stream, Adler-32. */
export function zlibWrap(raw, data) {
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  const v = new DataView(out.buffer);
  v.setUint32(2 + raw.length, adler32(data));
  return out;
}
