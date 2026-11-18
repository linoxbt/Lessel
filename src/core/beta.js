"use strict";
// Beta lower bound used by the trust model (spec §11.1).
// Regularized incomplete beta via the continued fraction from Numerical Recipes (Lentz's method),
// and the inverse by bisection, which is plenty fast for (alpha, beta) in the range we use.

const PRIOR = Object.freeze({ alpha0: 3.2, beta0: 0.8 }); // fixed, documented: worth 4 tickets at 80% clean

function logGamma(x) {
  // Lanczos approximation (g = 7, n = 9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(x, a, b) {
  const MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a : 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** Inverse of I_x(a, b): the x with I_x(a, b) = p. */
function betaInv(p, a, b) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (ibeta(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 90% one-sided lower bound for c clean out of n scored outcomes. */
function lowerBound(c, n, prior = PRIOR) {
  if (!(n >= 0) || !(c >= 0) || c > n) throw new RangeError(`bad counts c=${c} n=${n}`);
  return betaInv(0.10, prior.alpha0 + c, prior.beta0 + (n - c));
}

module.exports = { PRIOR, ibeta, betaInv, lowerBound };
