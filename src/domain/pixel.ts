export interface Raster { width: number; height: number; data: Uint8ClampedArray; }
export interface Roi { x: number; y: number; width: number; height: number; }
export interface GridGeometry { originX: number; originY: number; cellWidth: number; cellHeight: number; }
export interface PixelCell { color: [number, number, number] | null; confidence: number; }
export interface PixelMatrix { rows: number; columns: number; cells: PixelCell[]; background: [number, number, number]; }
export interface OccupancyAnalysis { scores: number[]; threshold: number; occupancy: boolean[]; }
export interface GridDetection { roi: Roi; rows: number; columns: number; geometry: GridGeometry; confidence: number; scores: number[]; threshold: number; occupancy: boolean[]; }

// 中心像素与格子底色的颜色距离超过该值就视为“墨迹”（编号/符号）。
const INK_DISTANCE = 36;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const at = (raster: Raster, x: number, y: number) => (y * raster.width + x) * 4;
const distance = (a: readonly number[], b: readonly number[]) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1)];
}

function luminance(raster: Raster, x: number, y: number): number {
  const p = at(raster, clamp(Math.floor(x), 0, raster.width - 1), clamp(Math.floor(y), 0, raster.height - 1));
  return raster.data[p] * 0.299 + raster.data[p + 1] * 0.587 + raster.data[p + 2] * 0.114;
}

function rgbAt(raster: Raster, x: number, y: number): [number, number, number] {
  const p = at(raster, clamp(Math.floor(x), 0, raster.width - 1), clamp(Math.floor(y), 0, raster.height - 1));
  return [raster.data[p], raster.data[p + 1], raster.data[p + 2]];
}

function interp(values: readonly number[], position: number): number {
  if (!values.length) return 0;
  const low = clamp(Math.floor(position), 0, values.length - 1);
  const high = clamp(low + 1, 0, values.length - 1);
  const t = clamp(position - low, 0, 1);
  return values[low] * (1 - t) + values[high] * t;
}

export function fullRoi(raster: Raster): Roi {
  return { x: 0, y: 0, width: raster.width, height: raster.height };
}

export function normalizeRoi(raster: Raster, roi?: Roi | null): Roi {
  if (!roi) return fullRoi(raster);
  const x = clamp(Math.round(Math.min(roi.x, roi.x + roi.width)), 0, Math.max(0, raster.width - 8));
  const y = clamp(Math.round(Math.min(roi.y, roi.y + roi.height)), 0, Math.max(0, raster.height - 8));
  const right = clamp(Math.round(Math.max(roi.x, roi.x + roi.width)), x + 8, raster.width);
  const bottom = clamp(Math.round(Math.max(roi.y, roi.y + roi.height)), y + 8, raster.height);
  return { x, y, width: right - x, height: bottom - y };
}

// 沿某个轴对 ROI 做“梯度能量投影”：Sobel 式亮度差分 + 0.8 分位数。
// 不用暗度中位数：格线、编号文字、色块边缘、虚线都是同周期的合法证据，
// 应该全部保留（网格越淡，编号文字越有价值）。0.8 分位数在“只留贯穿全图的
// 格线”（中位数）和“被大块色块淹没”（平均值）之间取折中。
function projection(raster: Raster, roi: Roi, axis: "x" | "y"): number[] {
  const length = axis === "x" ? roi.width : roi.height;
  const cross = axis === "x" ? roi.height : roi.width;
  const step = Math.max(1, Math.ceil(cross / 480));
  const samples: number[] = [];
  const values = new Array<number>(length).fill(0);
  for (let position = 0; position < length; position += 1) {
    samples.length = 0;
    for (let other = 0; other < cross; other += step) {
      const x = axis === "x" ? roi.x + position : roi.x + other;
      const y = axis === "x" ? roi.y + other : roi.y + position;
      // x 轴信号关心竖向结构（水平方向亮度差），y 轴反之。
      const gradient = axis === "x"
        ? Math.abs(luminance(raster, x + 1, y) - luminance(raster, x - 1, y))
        : Math.abs(luminance(raster, x, y + 1) - luminance(raster, x, y - 1));
      samples.push(gradient);
    }
    values[position] = quantile(samples, 0.8);
  }
  return values;
}

function detrend(values: readonly number[]): number[] {
  const window = 41;
  return values.map((value, index) => {
    const start = Math.max(0, index - Math.floor(window / 2));
    const end = Math.min(values.length, index + Math.ceil(window / 2));
    let local = 0;
    for (let i = start; i < end; i += 1) local += values[i];
    return value - local / Math.max(1, end - start);
  });
}

function correlation(residual: readonly number[], lag: number): number {
  const limit = residual.length - Math.ceil(lag) - 1;
  let cross = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < limit; index += 1) {
    const a = residual[index];
    const b = interp(residual, index + lag);
    cross += a * b;
    left += a * a;
    right += b * b;
  }
  return cross / Math.max(1, Math.sqrt(left * right));
}

// 自相关 + 谐波峰列拟合。不判断“哪个峰是基频”，而是找一个 p 让最多的峰
// 落在 n×p 上，再用全部峰做最小二乘 p = Σn·d / Σn²。
// 亚像素精度来自多个倍频共同回归，不再需要 ±1.5px / 0.05 步长的暴力细化。
// 候选 p 必须满足“1p 处本身有峰”，因此不会锁到 p/2；而 2p 候选会丢掉
// 一半峰（p、3p… 不再是整数倍），证据多的 p 自然胜出。
function findPitch(values: readonly number[]): { pitch: number; score: number } {
  const residual = detrend(values);
  const maxLag = Math.min(64, Math.floor(values.length / 4));
  if (maxLag < 8) return { pitch: Math.max(4, maxLag) || 18, score: 0 };
  const curve: number[] = [];
  for (let lag = 8; lag <= maxLag; lag += 1) curve.push(correlation(residual, lag));
  // 局部峰，三点抛物线插值出亚像素峰位。
  const peaks: Array<{ lag: number; score: number }> = [];
  for (let i = 1; i < curve.length - 1; i += 1) {
    if (curve[i] <= 0 || curve[i] <= curve[i - 1] || curve[i] < curve[i + 1]) continue;
    const denominator = curve[i - 1] - 2 * curve[i] + curve[i + 1];
    const delta = denominator ? clamp(0.5 * (curve[i - 1] - curve[i + 1]) / denominator, -0.5, 0.5) : 0;
    peaks.push({ lag: i + 8 + delta, score: curve[i] });
  }
  if (!peaks.length) return { pitch: 18, score: 0 };
  // 格线↔文字的交叉项会在 p/2 处产生弱峰（幅值通常不到真实谐波的 1/10），
  // 不过滤的话候选 p/2 会靠“峰多”在求和权重上险胜真正的 p。
  const strongest = Math.max(...peaks.map((peak) => peak.score));
  const significant = peaks.filter((peak) => peak.score >= strongest * 0.25);
  let best: { pitch: number; score: number; inliers: Array<{ n: number; lag: number; score: number }> } | null = null;
  for (let p = 8; p <= maxLag; p += 0.1) {
    const tolerance = Math.max(0.8, p * 0.06);
    let hasBase = false;
    let weight = 0;
    const inliers: Array<{ n: number; lag: number; score: number }> = [];
    for (const peak of significant) {
      const n = Math.round(peak.lag / p);
      if (n < 1 || Math.abs(peak.lag - n * p) > tolerance) continue;
      // 1p 基频峰必须足够强：格内若存在每格重复 3 次的结构（如多笔画编号），
      // 会产生 p/3 间隔的密集峰列，否则候选 2p/3 会靠“峰多”累计权重险胜真周期。
      if (n === 1) {
        if (peak.score < strongest * 0.4) continue;
        hasBase = true;
      }
      weight += peak.score;
      inliers.push({ n, lag: peak.lag, score: peak.score });
    }
    if (!hasBase) continue;
    if (!best || weight > best.score) best = { pitch: p, score: weight, inliers };
  }
  if (!best) return { pitch: significant[0].lag, score: 0 };
  // 最小二乘细化：d_n ≈ n·p → p = Σ(n·d) / Σ(n²)
  let sumND = 0;
  let sumNN = 0;
  for (const inlier of best.inliers) {
    sumND += inlier.n * inlier.lag;
    sumNN += inlier.n * inlier.n;
  }
  const pitch = sumNN ? sumND / sumNN : best.pitch;
  const confidence = clamp(best.score / best.inliers.length, 0, 1);
  return { pitch, score: confidence };
}

// comb 搜索：相位只需在 [0, pitch) 内找，让梳齿尽量压在梯度能量高的位置
// （格线/色块边界）。格心不再做惩罚项——编号文字本身就在格心产生梯度，
// 惩罚它会抵消文字这条证据。
// 注意 comb 的最大峰不一定锁在真实格线上：没有逐格细线的图纸里，编号文字的
// 上/下边缘也是逐格重复的梯度结构，能量可能超过每 5 格一条的粗格线，导致
// comb 锁到“文字边缘晶格”（相位偏差可达 0.3-0.4 格）。因此这里返回按能量
// 降序的局部极大候选，最终相位由格内一致性（cellUniformity）仲裁。
function combScore(proj: readonly number[], pitch: number, offset: number): number {
  let border = 0;
  let borderCount = 0;
  for (let k = 0; ; k += 1) {
    const line = offset + k * pitch;
    if (line >= proj.length) break;
    border += interp(proj, line);
    borderCount += 1;
  }
  return border / Math.max(1, borderCount);
}

function phaseCandidates(proj: readonly number[], pitch: number): Array<{ offset: number; score: number }> {
  const steps = Math.max(4, Math.round(pitch / 0.25));
  const curve: number[] = [];
  for (let i = 0; i < steps; i += 1) curve.push(combScore(proj, pitch, (i / steps) * pitch));
  const candidates: Array<{ offset: number; score: number }> = [];
  for (let i = 0; i < steps; i += 1) {
    const prev = curve[(i - 1 + steps) % steps];
    const next = curve[(i + 1) % steps];
    if (curve[i] > prev && curve[i] >= next) candidates.push({ offset: (i / steps) * pitch, score: curve[i] });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 5);
  // 最强候选的半格平移总是纳入候选（文字中心 vs 格线的 p/2 歧义）。
  if (top.length) {
    const half = (top[0].offset + pitch / 2) % pitch;
    if (!top.some((c) => Math.abs(c.offset - half) < 0.5)) top.push({ offset: half, score: 0 });
  }
  return top;
}

// 格内一致性：正确相位下每个格子的四角区域（避开格线与中心编号）应接近单色。
// 相位错半格时四角会横跨两个豆子，方差明显变大。返回归一化后的平均方差。
function cellUniformity(raster: Raster, geometry: GridGeometry, rows: number, columns: number): number {
  const stride = Math.max(1, Math.ceil((rows * columns) / 400));
  let total = 0;
  let counted = 0;
  for (let index = 0; index < rows * columns; index += stride) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const left = geometry.originX + column * geometry.cellWidth;
    const top = geometry.originY + row * geometry.cellHeight;
    const width = geometry.cellWidth;
    const height = geometry.cellHeight;
    const colors: Array<[number, number, number]> = [];
    const collect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = clamp(Math.ceil(y0), 0, raster.height - 1); y <= clamp(Math.floor(y1), 0, raster.height - 1); y += 1) {
        for (let x = clamp(Math.ceil(x0), 0, raster.width - 1); x <= clamp(Math.floor(x1), 0, raster.width - 1); x += 1) {
          colors.push(rgbAt(raster, x, y));
        }
      }
    };
    collect(left + width * 0.14, top + height * 0.14, left + width * 0.34, top + height * 0.34);
    collect(left + width * 0.66, top + height * 0.14, left + width * 0.86, top + height * 0.34);
    collect(left + width * 0.14, top + height * 0.66, left + width * 0.34, top + height * 0.86);
    collect(left + width * 0.66, top + height * 0.66, left + width * 0.86, top + height * 0.86);
    if (colors.length < 4) continue;
    const mean = [0, 0, 0];
    for (const color of colors) { mean[0] += color[0]; mean[1] += color[1]; mean[2] += color[2]; }
    mean[0] /= colors.length; mean[1] /= colors.length; mean[2] /= colors.length;
    let variance = 0;
    for (const color of colors) variance += (color[0] - mean[0]) ** 2 + (color[1] - mean[1]) ** 2 + (color[2] - mean[2]) ** 2;
    total += variance / colors.length;
    counted += 1;
  }
  return counted ? total / counted : Infinity;
}

interface CellInk { score: number; base: [number, number, number]; }

// 找“贯穿线”行/列：虚线/实线横穿格子时会形成一小段填充率 ≈1 的连续行（列），
// 且带外几乎为空。编号文字也可能整行填满窗口（窄窗口里文字横向占满），但文字
// 实心块通常 ≥4 个满行且相邻行填充较高，所以剔除按带长分级（见函数内注释）。
// 命中的整段连同过渡行一起从统计中剔除，否则背景虚线会把空格的墨迹比例抬到
// 0.2-0.4。漏网的线头由 cellInk 末尾的“线头 veto”兜底。
function lineBands(fills: number[]): boolean[] {
  const excluded = new Array<boolean>(fills.length).fill(false);
  const at = (i: number) => (i >= 0 && i < fills.length ? fills[i] : 0);
  let start = 0;
  while (start < fills.length) {
    if (fills[start] < 0.95) { start += 1; continue; }
    let end = start;
    while (end + 1 < fills.length && fills[end + 1] >= 0.95) end += 1;
    const len = end - start + 1;
    // 过渡行容差只给 ≤2 行的细线；3 行带要求紧邻行直接为空，
    // 避免误伤小号文字（文字实心块通常 ≥4 个满行、相邻行填充 0.6-0.9）。
    const sideOk = (i1: number, i2: number) => (len <= 2 ? at(i1) <= 0.3 || (at(i1) <= 0.75 && at(i2) <= 0.3) : at(i1) <= 0.3);
    if (len <= 3 && sideOk(start - 1, start - 2) && sideOk(end + 1, end + 2)) {
      for (let i = start; i <= end; i += 1) excluded[i] = true;
      // 细线的抗锯齿过渡行（fill > 0.3 的贴边行）一并剔除。
      if (start > 0 && at(start - 1) > 0.3) excluded[start - 1] = true;
      if (end + 1 < fills.length && at(end + 1) > 0.3) excluded[end + 1] = true;
    }
    start = end + 1;
  }
  return excluded;
}

// 每格先用自己的四角估计底色，再统计中心区域与底色差异超过阈值的像素比例。
// 黑底白字、白底灰字、红底浅字都能识别，因为比较的是距离而不是明暗。
function cellInk(raster: Raster, left: number, top: number, right: number, bottom: number): CellInk {
  const width = right - left;
  const height = bottom - top;
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const collect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = clamp(Math.ceil(y0), 0, raster.height - 1); y <= clamp(Math.floor(y1), 0, raster.height - 1); y += 1) {
      for (let x = clamp(Math.ceil(x0), 0, raster.width - 1); x <= clamp(Math.floor(x1), 0, raster.width - 1); x += 1) {
        const color = rgbAt(raster, x, y);
        red.push(color[0]);
        green.push(color[1]);
        blue.push(color[2]);
      }
    }
  };
  // 四角 14%..34%，避开格线。
  collect(left + width * 0.14, top + height * 0.14, left + width * 0.34, top + height * 0.34);
  collect(right - width * 0.34, top + height * 0.14, right - width * 0.14, top + height * 0.34);
  collect(left + width * 0.14, bottom - height * 0.34, left + width * 0.34, bottom - height * 0.14);
  collect(right - width * 0.34, bottom - height * 0.34, right - width * 0.14, bottom - height * 0.14);
  const base: [number, number, number] = [median(red), median(green), median(blue)];
  const centerLeft = left + width * 0.24;
  const centerRight = left + width * 0.76;
  const centerTop = top + height * 0.24;
  const centerBottom = top + height * 0.76;
  const x0 = clamp(Math.ceil(centerLeft), 0, raster.width - 1);
  const x1 = clamp(Math.floor(centerRight), 0, raster.width - 1);
  const y0 = clamp(Math.ceil(centerTop), 0, raster.height - 1);
  const y1 = clamp(Math.floor(centerBottom), 0, raster.height - 1);
  const rows = y1 - y0 + 1;
  const cols = x1 - x0 + 1;
  if (rows <= 0 || cols <= 0) return { score: 0, base };
  const inkMask = new Array<boolean>(rows * cols).fill(false);
  const rowFill = new Array<number>(rows).fill(0);
  const colFill = new Array<number>(cols).fill(0);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (distance(rgbAt(raster, x, y), base) > INK_DISTANCE) {
        inkMask[(y - y0) * cols + (x - x0)] = true;
        rowFill[y - y0] += 1;
        colFill[x - x0] += 1;
      }
    }
  }
  const rowExcluded = lineBands(rowFill.map((count) => count / cols));
  const colExcluded = lineBands(colFill.map((count) => count / rows));
  let ink = 0;
  let total = 0;
  // 剩余墨迹的外接框，用于识别“局部线头”：虚线端点落在窗口内时只剩几列宽，
  // 够不到整行 95% 填充的剔除条件，但形状仍是细长实心条（长宽比大、矩形填充率高）。
  let inkMinX = cols;
  let inkMaxX = -1;
  let inkMinY = rows;
  let inkMaxY = -1;
  for (let dy = 0; dy < rows; dy += 1) {
    if (rowExcluded[dy]) continue;
    for (let dx = 0; dx < cols; dx += 1) {
      if (colExcluded[dx]) continue;
      total += 1;
      if (inkMask[dy * cols + dx]) {
        ink += 1;
        if (dx < inkMinX) inkMinX = dx;
        if (dx > inkMaxX) inkMaxX = dx;
        if (dy < inkMinY) inkMinY = dy;
        if (dy > inkMaxY) inkMaxY = dy;
      }
    }
  }
  if (ink > 0) {
    const spanX = inkMaxX - inkMinX + 1;
    const spanY = inkMaxY - inkMinY + 1;
    const aspect = Math.max(spanX, spanY) / Math.min(spanX, spanY);
    const boxFill = ink / (spanX * spanY);
    // 文字笔画是带孔洞的紧凑块（填充率 <0.5、长宽比 <2），线头是细长实心条。
    if (aspect >= 2.2 && boxFill >= 0.55) ink = 0;
  }
  return { score: total ? ink / total : 0, base };
}

// 多级 Otsu（3 类），返回较低的那个分割点。
// 为什么不用普通二分类 Otsu：墨迹分数经常出现三个群体——空白背景（≈0）、
// 有编号文字的有豆格（0.05-0.4，字号越小分数越低）、图样边缘被“底色污染”的格
// （四角采到格外背景，整格误判墨迹，0.6-1.0）。二分类 Otsu 会把阈值放在文字格
// 与污染格之间（≈0.4），小号文字格全部被误判为空。三分割的低阈值正好落在
// 背景与文字之间；只有两类时，低阈值也退化为正常的二分类结果。
export function otsuThreshold(values: readonly number[]): number {
  if (!values.length) return 0;
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max <= 1e-6) return 0;
  const BINS = 64;
  const histogram = new Array<number>(BINS).fill(0);
  for (const value of values) histogram[Math.min(BINS - 1, Math.floor((value / max) * (BINS - 1e-9)))] += 1;
  const total = values.length;
  // 前缀和：w[i]=累计格数，s[i]=累计 bin 值，便于 O(BINS²) 枚举两个分割点。
  const w = new Array<number>(BINS + 1).fill(0);
  const s = new Array<number>(BINS + 1).fill(0);
  for (let i = 0; i < BINS; i += 1) {
    w[i + 1] = w[i] + histogram[i];
    s[i + 1] = s[i] + i * histogram[i];
  }
  const meanTotal = s[BINS] / total;
  const classVariance = (a: number, b: number) => {
    const weight = w[b] - w[a];
    if (!weight) return 0;
    const mean = (s[b] - s[a]) / weight;
    return weight * (mean - meanTotal) ** 2;
  };
  let bestT1 = 0;
  let bestT2 = 0;
  let bestVariance = -Infinity;
  for (let t1 = 1; t1 < BINS - 1; t1 += 1) {
    if (w[t1] === 0 || w[t1] === total) continue;
    const v0 = classVariance(0, t1);
    for (let t2 = t1 + 1; t2 < BINS; t2 += 1) {
      if (w[t2] === w[t1] || w[t2] === total) continue;
      const variance = v0 + classVariance(t1, t2) + classVariance(t2, BINS);
      if (variance > bestVariance) { bestVariance = variance; bestT1 = t1; bestT2 = t2; }
    }
  }
  const split = bestT1 || bestT2;
  return (split / BINS) * max;
}

export function applyThreshold(scores: readonly number[], threshold: number): boolean[] {
  return scores.map((score) => score > threshold);
}

export function analyzeOccupancy(raster: Raster, geometry: GridGeometry, rows: number, columns: number): OccupancyAnalysis {
  const scores: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = geometry.originX + column * geometry.cellWidth;
      const top = geometry.originY + row * geometry.cellHeight;
      scores.push(cellInk(raster, left, top, left + geometry.cellWidth, top + geometry.cellHeight).score);
    }
  }
  const threshold = otsuThreshold(scores);
  return { scores, threshold, occupancy: applyThreshold(scores, threshold) };
}

function trimAnalysis(geometry: GridGeometry, rows: number, columns: number, analysis: OccupancyAnalysis): { geometry: GridGeometry; rows: number; columns: number; analysis: OccupancyAnalysis } {
  let rowMin = rows;
  let rowMax = -1;
  let colMin = columns;
  let colMax = -1;
  analysis.occupancy.forEach((occupied, index) => {
    if (!occupied) return;
    const row = Math.floor(index / columns);
    const column = index % columns;
    rowMin = Math.min(rowMin, row);
    rowMax = Math.max(rowMax, row);
    colMin = Math.min(colMin, column);
    colMax = Math.max(colMax, column);
  });
  if (rowMax < 0) return { geometry, rows, columns, analysis };
  const nextRows = rowMax - rowMin + 1;
  const nextColumns = colMax - colMin + 1;
  if (nextRows === rows && nextColumns === columns) return { geometry, rows, columns, analysis };
  const scores: number[] = [];
  const occupancy: boolean[] = [];
  for (let row = rowMin; row <= rowMax; row += 1) {
    for (let column = colMin; column <= colMax; column += 1) {
      scores.push(analysis.scores[row * columns + column]);
      occupancy.push(analysis.occupancy[row * columns + column]);
    }
  }
  return {
    geometry: { ...geometry, originX: geometry.originX + colMin * geometry.cellWidth, originY: geometry.originY + rowMin * geometry.cellHeight },
    rows: nextRows,
    columns: nextColumns,
    analysis: { scores, threshold: analysis.threshold, occupancy },
  };
}

// 完整自动流程：ROI 内梯度投影 → 谐波拟合亚像素周期 → X/Y 联合校正倍频
// → comb 搜索相位 → 格内一致性裁决 p/2 歧义 → inkRatio + Otsu → 裁剪到有效格外接框。
export function detectGrid(raster: Raster, roi?: Roi | null): GridDetection {
  const region = normalizeRoi(raster, roi);
  const projectionX = projection(raster, region, "x");
  const projectionY = projection(raster, region, "y");
  const pitchX = findPitch(projectionX);
  const pitchY = findPitch(projectionY);
  // 拼豆格近似正方形：两边周期相差整数倍时，几乎必有一边锁到了倍频，
  // 把大的一边除回来（谐波拟合要求 1p 处有峰，小的一边更可信）。
  const ratio = pitchX.pitch / pitchY.pitch;
  const multiple = Math.round(ratio);
  if (multiple >= 2 && Math.abs(ratio - multiple) < 0.12) {
    if (pitchX.pitch > pitchY.pitch) pitchX.pitch /= multiple;
    else pitchY.pitch /= multiple;
  }
  // 相位：comb 给出按能量排序的候选，用格内一致性仲裁——真实格线下每个豆子
  // 格内四角同色，方差最小；锁到文字边缘/文字中心的相位会让格子横跨两个豆子。
  // 平局（单色大色块里多个相位同样均匀）时取 comb 能量高的。
  const candidatesX = phaseCandidates(projectionX, pitchX.pitch);
  const candidatesY = phaseCandidates(projectionY, pitchY.pitch);
  // 行列数按“格心落在 ROI 内”计数：comb 锁到的相位可能偏到格线边缘
  // （梯度投影里一条格线有两个边缘峰），用 round((size-origin)/pitch) 会在
  // ROI 边缘丢掉一整行/列。先按格心归属算出首格索引，再反推原点。
  const lattice = (offset: number, size: number, pitch: number) => {
    const kMin = Math.ceil((0 - offset) / pitch - 0.5);
    const kMax = Math.floor((size - offset) / pitch - 0.5);
    return { start: offset + kMin * pitch, count: Math.max(1, kMax - kMin + 1) };
  };
  let geometry: GridGeometry | null = null;
  let rows = 0;
  let columns = 0;
  let bestUniformity = Infinity;
  let bestComb = -Infinity;
  for (const candX of candidatesX) {
    const latticeX = lattice(candX.offset, region.width, pitchX.pitch);
    for (const candY of candidatesY) {
      const latticeY = lattice(candY.offset, region.height, pitchY.pitch);
      const candidate: GridGeometry = {
        originX: region.x + latticeX.start,
        originY: region.y + latticeY.start,
        cellWidth: pitchX.pitch,
        cellHeight: pitchY.pitch,
      };
      const uniformity = cellUniformity(raster, candidate, latticeY.count, latticeX.count);
      const comb = candX.score + candY.score;
      // 方差差异 <15% 视为平局，让 comb 能量决定（保护文字极少的图纸）。
      if (uniformity < bestUniformity * 0.85 || (uniformity < bestUniformity * 1.15 && comb > bestComb)) {
        bestUniformity = uniformity;
        bestComb = comb;
        geometry = candidate;
        rows = latticeY.count;
        columns = latticeX.count;
      }
    }
  }
  if (!geometry) {
    geometry = { originX: region.x, originY: region.y, cellWidth: pitchX.pitch, cellHeight: pitchY.pitch };
    rows = Math.max(1, Math.round(region.height / pitchY.pitch));
    columns = Math.max(1, Math.round(region.width / pitchX.pitch));
  }
  const trimmed = trimAnalysis(geometry, rows, columns, analyzeOccupancy(raster, geometry, rows, columns));
  return {
    roi: region,
    rows: trimmed.rows,
    columns: trimmed.columns,
    geometry: trimmed.geometry,
    confidence: clamp((pitchX.score + pitchY.score) / 2, 0, 1),
    scores: trimmed.analysis.scores,
    threshold: trimmed.analysis.threshold,
    occupancy: trimmed.analysis.occupancy,
  };
}

// 占位确定后的颜色采样：去掉边缘 16%（格线）和中心 28%..72%（编号），取剩余环形区域的中位数。
export function sampleCellColor(raster: Raster, geometry: GridGeometry, row: number, column: number): [number, number, number] {
  const left = geometry.originX + column * geometry.cellWidth;
  const top = geometry.originY + row * geometry.cellHeight;
  const width = geometry.cellWidth;
  const height = geometry.cellHeight;
  const innerLeft = left + width * 0.16;
  const innerRight = left + width * 0.84;
  const innerTop = top + height * 0.16;
  const innerBottom = top + height * 0.84;
  const centerLeft = left + width * 0.28;
  const centerRight = left + width * 0.72;
  const centerTop = top + height * 0.28;
  const centerBottom = top + height * 0.72;
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = clamp(Math.ceil(innerTop), 0, raster.height - 1); y <= clamp(Math.floor(innerBottom), 0, raster.height - 1); y += 1) {
    for (let x = clamp(Math.ceil(innerLeft), 0, raster.width - 1); x <= clamp(Math.floor(innerRight), 0, raster.width - 1); x += 1) {
      if (x >= centerLeft && x <= centerRight && y >= centerTop && y <= centerBottom) continue;
      const color = rgbAt(raster, x, y);
      red.push(color[0]);
      green.push(color[1]);
      blue.push(color[2]);
    }
  }
  return [Math.round(median(red)), Math.round(median(green)), Math.round(median(blue))];
}

export function recognizeMatrix(raster: Raster, detection: Pick<GridDetection, "rows" | "columns" | "geometry"> & { occupancy?: boolean[] }, _backgroundCell = 0, maxColors?: number): PixelMatrix {
  const analysis = detection.occupancy ? null : analyzeOccupancy(raster, detection.geometry, detection.rows, detection.columns);
  const occupancy = detection.occupancy ?? analysis?.occupancy ?? [];
  const cells = Array.from({ length: detection.rows * detection.columns }, (_, index) => {
    const row = Math.floor(index / detection.columns);
    const column = index % detection.columns;
    const confidence = analysis?.scores[index] ?? 1;
    return occupancy[index]
      ? { color: sampleCellColor(raster, detection.geometry, row, column), confidence }
      : { color: null, confidence };
  });
  // 拼豆色号很少：把抗锯齿/印刷造成的相近采样色合并成少数几个代表色。
  if (maxColors && maxColors > 0) {
    const quantized = quantizeColors(cells.filter((cell) => cell.color).map((cell) => cell.color as [number, number, number]), maxColors);
    let cursor = 0;
    cells.forEach((cell) => { if (cell.color) { cell.color = quantized[cursor]; cursor += 1; } });
  }
  return { rows: detection.rows, columns: detection.columns, background: [255, 255, 255], cells };
}

export function renderMatrix(matrix: PixelMatrix): ImageData {
  const image = typeof ImageData === "function" ? new ImageData(matrix.columns, matrix.rows) : ({ width: matrix.columns, height: matrix.rows, data: new Uint8ClampedArray(matrix.columns * matrix.rows * 4) } as ImageData);
  matrix.cells.forEach((cell, index) => {
    if (!cell.color) return;
    const p = index * 4;
    image.data[p] = cell.color[0];
    image.data[p + 1] = cell.color[1];
    image.data[p + 2] = cell.color[2];
    image.data[p + 3] = 255;
  });
  return image;
}

export function colorKey(color: readonly number[] | null): string {
  return color ? color.join(",") : "empty";
}

// ---------- 颜色量化：把相近的采样色合并成少数几个代表色 ----------

// sRGB → CIE Lab（D65），用感知距离而不是 RGB 欧氏距离判断“相近”。
function rgbToLab(color: readonly number[]): [number, number, number] {
  const linear = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(color[0]);
  const g = linear(color[1]);
  const b = linear(color[2]);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (v: number) => (v > 0.008856 ? v ** (1 / 3) : 7.787 * v + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

interface ColorCluster { sum: [number, number, number]; count: number; lab: [number, number, number]; }

function clusterCentroid(cluster: ColorCluster): [number, number, number] {
  return [cluster.sum[0] / cluster.count, cluster.sum[1] / cluster.count, cluster.sum[2] / cluster.count];
}

/**
 * 凝聚式聚类（平均联动）：反复合并质心最近的两个簇，
 * 直到剩余簇数 ≤ maxColors 且最近簇对的 Lab 距离 ≥ mergeDistance。
 * 返回与输入等长的代表色数组（簇质心取整）。
 */
export function quantizeColors(colors: readonly (readonly number[])[], maxColors = 10, mergeDistance = 14): [number, number, number][] {
  const buckets = new Map<string, { color: [number, number, number]; count: number }>();
  colors.forEach((color) => {
    const key = colorKey(color);
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { color: [color[0], color[1], color[2]], count: 1 });
  });
  const clusters: ColorCluster[] = [...buckets.values()].map(({ color, count }) => ({
    sum: [color[0] * count, color[1] * count, color[2] * count],
    count,
    lab: rgbToLab(color),
  }));
  const cap = Math.max(1, Math.round(maxColors));
  while (clusters.length > 1) {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const d = distance(clusters[i].lab, clusters[j].lab);
        if (d < bestDistance) { bestDistance = d; best = i * clusters.length + j; }
      }
    }
    // 簇数已达标、且最近的两个簇也算不上“相近”时停止。
    if (clusters.length <= cap && bestDistance >= mergeDistance) break;
    const i = Math.floor(best / clusters.length);
    const j = best % clusters.length;
    const a = clusters[i];
    const b = clusters[j];
    const merged: ColorCluster = {
      sum: [a.sum[0] + b.sum[0], a.sum[1] + b.sum[1], a.sum[2] + b.sum[2]],
      count: a.count + b.count,
      lab: [0, 0, 0],
    };
    merged.lab = rgbToLab(clusterCentroid(merged));
    clusters.splice(j, 1);
    clusters.splice(i, 1, merged);
  }
  // 每个原始颜色归到质心最近的簇（簇数极少，代价可忽略），用簇质心取整作为代表色。
  const centroids = clusters.map((cluster) => ({ lab: cluster.lab, rgb: clusterCentroid(cluster).map(Math.round) as [number, number, number] }));
  const assignment = new Map<string, [number, number, number]>();
  buckets.forEach(({ color }) => {
    const lab = rgbToLab(color);
    let bestIndex = 0;
    let bestDistance = Infinity;
    centroids.forEach((centroid, index) => {
      const d = distance(lab, centroid.lab);
      if (d < bestDistance) { bestDistance = d; bestIndex = index; }
    });
    assignment.set(colorKey(color), centroids[bestIndex].rgb);
  });
  return colors.map((color) => assignment.get(colorKey(color)) ?? [color[0], color[1], color[2]]);
}
