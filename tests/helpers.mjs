// Curve helpers for the tests.
import * as C from "../scripts/lib/protocol.mjs";

const P = C.P, A = 168700n, D = 168696n;

export function pow(b, e) {
  let r = 1n;
  b %= P;
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = r * b % P;
    b = b * b % P;
  }
  return r;
}

/** Tonelli-Shanks square root. The field is 1 mod 4, so the short formula does not apply. Null for non-residues. */
export function sqrtMod(v) {
  v = ((v % P) + P) % P;
  if (v === 0n) return 0n;
  if (pow(v, (P - 1n) / 2n) !== 1n) return null;
  let q = P - 1n, s = 0n;
  while (q % 2n === 0n) { q /= 2n; s += 1n; }
  let z = 2n;
  while (pow(z, (P - 1n) / 2n) !== P - 1n) z += 1n;
  let m = s, c = pow(z, q), t = pow(v, q), r = pow(v, (q + 1n) / 2n);
  while (t !== 1n) {
    let i = 0n, tt = t;
    while (tt !== 1n) { tt = tt * tt % P; i += 1n; }
    const b = pow(c, 1n << (m - i - 1n));
    m = i; c = b * b % P; t = t * c % P; r = r * b % P;
  }
  return r;
}

/** A uniformly random point of the curve. It lies in the prime-order subgroup with probability 1/8. */
export function randomCurvePoint() {
  for (;;) {
    const x = C.randomField() % P;
    if (x === 0n) continue;
    const y2 = (1n - A * x * x % P) * pow((1n - D * x * x) % P, P - 2n) % P;
    const y = sqrtMod(y2);
    if (y !== null && y !== 0n) return [x, y];
  }
}

/** A curve point of order 2, 4 or 8 (whichever comes out first). Never the identity. */
export function randomTorsionPoint() {
  for (;;) {
    const t = C.pointMul(randomCurvePoint(), C.SUBGROUP_ORDER);
    if (!C.isIdentity(t)) return t;
  }
}

/** The point of order 4 whose x-coordinate is a square root of 1/a. */
export function order4Point() {
  const x = sqrtMod(pow(BigInt(A), P - 2n));
  return [x, 0n];
}
