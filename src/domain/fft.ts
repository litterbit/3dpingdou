// 纯 TS radix-2 FFT（ Cooley-Tukey 迭代版 ），像素图模式估计网格数量的唯一数值依赖。
// 实部/虚部分开存储，长度必须是 2 的幂。

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 原地 1D FFT（正变换）。 */
export function fft1d(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const vr = re[b] * curR - im[b] * curI;
        const vi = re[b] * curI + im[b] * curR;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

/**
 * 任意长度 FFT（Bluestein chirp-z）：n 不必是 2 的幂。
 * 零填充到 2 的幂会改变频谱峰位置（实测让检测完全失效），所以这里必须支持原尺寸。
 */
export function fftArbitrary(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) === 0) { fft1d(re, im); return; }
  const m = nextPow2(2 * n - 1);
  // chirp: c[k] = exp(iπk²/n)
  const chirpR = new Float64Array(n);
  const chirpI = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const angle = (Math.PI * ((k * k) % (2 * n))) / n;
    chirpR[k] = Math.cos(angle);
    chirpI[k] = Math.sin(angle);
  }
  // a[k] = x[k] * conj(chirp[k])，b[k] = chirp[k]，卷积长度 m
  const ar = new Float64Array(m);
  const ai = new Float64Array(m);
  const br = new Float64Array(m);
  const bi = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = re[k] * chirpR[k] + im[k] * chirpI[k];
    ai[k] = im[k] * chirpR[k] - re[k] * chirpI[k];
    br[k] = chirpR[k];
    bi[k] = chirpI[k];
  }
  // b 需要按卷积对称填尾：b[m - k] = chirp[k]
  for (let k = 1; k < n; k++) {
    br[m - k] = chirpR[k];
    bi[m - k] = chirpI[k];
  }
  fft1d(ar, ai);
  fft1d(br, bi);
  for (let k = 0; k < m; k++) {
    const vr = ar[k] * br[k] - ai[k] * bi[k];
    const vi = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = vr;
    ai[k] = vi;
  }
  // 逆变换：共轭 → FFT → 共轭 → /m
  for (let k = 0; k < m; k++) ai[k] = -ai[k];
  fft1d(ar, ai);
  for (let k = 0; k < n; k++) {
    const convR = ar[k] / m;
    const convI = -ai[k] / m;
    // X[k] = conj(chirp[k]) * conv[k]
    re[k] = convR * chirpR[k] + convI * chirpI[k];
    im[k] = convI * chirpR[k] - convR * chirpI[k];
  }
}

/**
 * 2D FFT 幅度谱（原尺寸，不填充），输出 fftshift 后（低频居中）的幅度谱。
 */
export function fft2Magnitude(gray: Float64Array, width: number, height: number): { mag: Float64Array; width: number; height: number } {
  const w = width;
  const h = height;
  const re = new Float64Array(w * h);
  const im = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) re[y * w + x] = gray[y * w + x];
  }
  const rowR = new Float64Array(w);
  const rowI = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    rowR.set(re.subarray(y * w, (y + 1) * w));
    rowI.fill(0);
    fftArbitrary(rowR, rowI);
    re.set(rowR, y * w);
    im.set(rowI, y * w);
  }
  const colR = new Float64Array(h);
  const colI = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { colR[y] = re[y * w + x]; colI[y] = im[y * w + x]; }
    fftArbitrary(colR, colI);
    for (let y = 0; y < h; y++) { re[y * w + x] = colR[y]; im[y * w + x] = colI[y]; }
  }
  const mag = new Float64Array(w * h);
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  for (let y = 0; y < h; y++) {
    const sy = (y + halfH) % h;
    for (let x = 0; x < w; x++) {
      const sx = (x + halfW) % w;
      mag[y * w + x] = Math.hypot(re[sy * w + sx], im[sy * w + sx]);
    }
  }
  return { mag, width: w, height: h };
}
