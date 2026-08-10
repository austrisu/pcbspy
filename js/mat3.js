/* mat3.js — 3x3 matrix math (row-major) + 4-point homography (DLT).
   A matrix is a flat array of 9 numbers laid out row-major:
       [ m0 m1 m2      [ a b c
         m3 m4 m5   =    d e f
         m6 m7 m8 ]      g h i ]
   Points are [x, y] and treated as homogeneous [x, y, 1]. */
(function (global) {
  'use strict';

  const Mat3 = {
    identity() {
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    },

    translate(tx, ty) {
      return [1, 0, tx, 0, 1, ty, 0, 0, 1];
    },

    scale(sx, sy) {
      return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
    },

    rotate(rad) {
      const c = Math.cos(rad), s = Math.sin(rad);
      return [c, -s, 0, s, c, 0, 0, 0, 1];
    },

    // A * B  (both row-major 3x3)
    multiply(A, B) {
      const out = new Array(9);
      for (let r = 0; r < 3; r++) {
        for (let col = 0; col < 3; col++) {
          out[r * 3 + col] =
            A[r * 3 + 0] * B[0 * 3 + col] +
            A[r * 3 + 1] * B[1 * 3 + col] +
            A[r * 3 + 2] * B[2 * 3 + col];
        }
      }
      return out;
    },

    // Chain multiply left-to-right: mul(A, B, C) === A*B*C
    mul(...mats) {
      return mats.reduce((acc, m) => Mat3.multiply(acc, m));
    },

    // Apply a homography to a point, with the perspective divide.
    apply(m, p) {
      const x = p[0], y = p[1];
      const X = m[0] * x + m[1] * y + m[2];
      const Y = m[3] * x + m[4] * y + m[5];
      const W = m[6] * x + m[7] * y + m[8];
      return [X / W, Y / W];
    },

    // Compose a transform T applied about a world pivot: T'(p) = pivot + T(p - pivot)
    aboutPivot(T, px, py) {
      return Mat3.mul(Mat3.translate(px, py), T, Mat3.translate(-px, -py));
    },

    // Inverse of a row-major 3x3 (identity if near-singular).
    invert(m) {
      const [a, b, c, d, e, f, g, h, i] = m;
      const C11 = e * i - f * h, C12 = -(d * i - f * g), C13 = d * h - e * g;
      const C21 = -(b * i - c * h), C22 = a * i - c * g, C23 = -(a * h - b * g);
      const C31 = b * f - c * e, C32 = -(a * f - c * d), C33 = a * e - b * d;
      const det = a * C11 + b * C12 + c * C13;
      if (Math.abs(det) < 1e-12) return Mat3.identity();
      const s = 1 / det;
      // adjugate (transpose of cofactors) / det
      return [C11 * s, C21 * s, C31 * s,
              C12 * s, C22 * s, C32 * s,
              C13 * s, C23 * s, C33 * s];
    },

    /* Least-squares homography from n>=4 correspondences (normalized DLT with the
       inhomogeneous h33=1 constraint, solved via 8x8 normal equations). src/dst are
       arrays of [x,y]. Robust for over-determined landmark alignment. */
    homographyLS(src, dst) {
      const n = Math.min(src.length, dst.length);
      if (n < 4) return Mat3.identity();
      if (n === 4) return Mat3.homography(src, dst);

      const [Ts, ns] = normalizePoints(src);
      const [Td, nd] = normalizePoints(dst);

      // Normal equations A^T A h = A^T b for h (8 unknowns), rows per correspondence.
      const ATA = Array.from({ length: 8 }, () => new Array(8).fill(0));
      const ATb = new Array(8).fill(0);
      const acc = (row, val) => {
        for (let p = 0; p < 8; p++) {
          ATb[p] += row[p] * val;
          for (let q = 0; q < 8; q++) ATA[p][q] += row[p] * row[q];
        }
      };
      for (let i = 0; i < n; i++) {
        const [x, y] = ns[i];
        const [u, v] = nd[i];
        acc([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
        acc([0, 0, 0, x, y, 1, -v * x, -v * y], v);
      }
      const h = solveN(ATA, ATb);
      if (!h) return Mat3.identity();
      const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
      // Denormalize: H = inv(Td) * Hn * Ts
      return Mat3.mul(Mat3.invert(Td), Hn, Ts);
    },

    // Reorder row-major -> column-major for uniformMatrix3fv (WebGL1 needs transpose=false).
    toGL(m) {
      return new Float32Array([
        m[0], m[3], m[6],
        m[1], m[4], m[7],
        m[2], m[5], m[8],
      ]);
    },

    /* Solve the homography H mapping the 4 source points to the 4 dest points.
       src, dst: arrays of four [x, y] pairs. Returns a row-major 3x3 with m8 == 1.
       Classic DLT: 8 unknowns from 4 correspondences via an 8x8 linear solve. */
    homography(src, dst) {
      const A = [];
      const b = [];
      for (let i = 0; i < 4; i++) {
        const [x, y] = src[i];
        const [u, v] = dst[i];
        A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
        A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
      }
      const h = solve8(A, b);
      if (!h) return Mat3.identity();
      return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    },
  };

  // Gaussian elimination with partial pivoting for an 8x8 system A h = b.
  function solve8(A, b) {
    const n = 8;
    // Augmented matrix
    const M = A.map((row, i) => row.concat(b[i]));
    for (let col = 0; col < n; col++) {
      // pivot
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null; // singular
      [M[col], M[piv]] = [M[piv], M[col]];
      // eliminate
      const pv = M[col][col];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / pv;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
    return x;
  }

  // Hartley normalization: translate to centroid, scale so mean distance is sqrt(2).
  // Returns [T (row-major 3x3), normalizedPoints].
  function normalizePoints(pts) {
    const n = pts.length;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= n; cy /= n;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy);
    d /= n;
    const s = d > 1e-12 ? Math.SQRT2 / d : 1;
    const T = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
    const out = pts.map(p => [s * (p[0] - cx), s * (p[1] - cy)]);
    return [T, out];
  }

  // Gaussian elimination with partial pivoting for an n x n system M x = b.
  function solveN(M, b) {
    const n = b.length;
    const A = M.map((row, i) => row.concat(b[i]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        if (f === 0) continue;
        for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
      }
    }
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = A[i][n] / A[i][i];
    return x;
  }

  global.Mat3 = Mat3;
})(window);
