import { clamp } from "./helpers";
import type { PixelMatrix } from "./types";

// ---------- 角接修复：仅靠一个角连在主体上的色块，3D 打印时会断裂脱落 ----------

/**
 * 找出"仅靠一个角与主体相连"的悬空色块（4-连通意义下与最大连通域分离、但存在对角相邻），
 * 为其中每个格子给出指向主体的 45° 单位方向 (±1, ±1)。矩阵本身不被修改；
 * 导出渲染时把这些格子沿该方向偏移几个像素，与主体产生小面积重叠，打印后即粘住。
 * 只锚定直接角接触主体的块；完全孤立的块计入 stranded。
 */
export interface FloatingBlockOffsets {
  /** 格子索引 → 偏移方向（行、列各 ±1）；无偏移的格子不在表中。 */
  offsets: Map<number, readonly [number, number]>;
  /** 与主体角接、将被偏移的连通域个数。 */
  fixed: number;
  /** 与主体完全分离（连角接触都没有）的连通域个数。 */
  stranded: number;
}

const ORTHO_DIRECTIONS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL_DIRECTIONS: readonly [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** 4-连通（共享边）标记所有有豆格的连通域；颜色不影响连通性——打印件不分颜色。返回每格标签（空格为 -1）与连通域个数。 */
function occupiedLabels(matrix: PixelMatrix): { labels: Int32Array; count: number } {
  const labels = new Int32Array(matrix.cells.length).fill(-1);
  let count = 0;
  const queue: number[] = [];
  matrix.cells.forEach((cell, seed) => {
    if (!cell.color || labels[seed] !== -1) return;
    const label = count;
    count += 1;
    labels[seed] = label;
    queue.push(seed);
    while (queue.length) {
      const current = queue.pop() as number;
      const row = Math.floor(current / matrix.columns);
      const column = current % matrix.columns;
      for (const [dr, dc] of ORTHO_DIRECTIONS) {
        const nr = row + dr;
        const nc = column + dc;
        if (nr < 0 || nc < 0 || nr >= matrix.rows || nc >= matrix.columns) continue;
        const next = nr * matrix.columns + nc;
        if (matrix.cells[next].color && labels[next] === -1) {
          labels[next] = label;
          queue.push(next);
        }
      }
    }
  });
  return { labels, count };
}

export function floatingBlockOffsets(matrix: PixelMatrix): FloatingBlockOffsets {
  const offsets = new Map<number, readonly [number, number]>();
  const { labels, count } = occupiedLabels(matrix);
  if (count <= 1) return { offsets, fixed: 0, stranded: 0 };
  const members = new Map<number, number[]>();
  labels.forEach((label, index) => {
    if (label < 0) return;
    const list = members.get(label);
    if (list) list.push(index);
    else members.set(label, [index]);
  });
  // 最大的连通域视为主体。
  let mainLabel = -1;
  let mainSize = -1;
  members.forEach((list, label) => { if (list.length > mainSize) { mainSize = list.length; mainLabel = label; } });
  let fixed = 0;
  members.forEach((cells, label) => {
    if (label === mainLabel) return;
    // 找与主体的对角（角）接触：组件格 (r,c) 与主体格 (r+dr, c+dc)，dr/dc ∈ {±1}。
    let direction: readonly [number, number] | null = null;
    for (const index of cells) {
      if (direction) break;
      const row = Math.floor(index / matrix.columns);
      const column = index % matrix.columns;
      for (const [dr, dc] of DIAGONAL_DIRECTIONS) {
        const nr = row + dr;
        const nc = column + dc;
        if (nr < 0 || nc < 0 || nr >= matrix.rows || nc >= matrix.columns) continue;
        if (labels[nr * matrix.columns + nc] === mainLabel) { direction = [dr, dc]; break; }
      }
    }
    if (!direction) return;
    cells.forEach((index) => offsets.set(index, direction));
    fixed += 1;
  });
  return { offsets, fixed, stranded: count - 1 - fixed };
}

export interface RenderOptions {
  /** 每格像素数（默认 1）。 */
  scale?: number;
  /** 悬空色块的偏移像素数（默认 0，会被钳制到 ≤ scale）。 */
  offsetPx?: number;
  /** 格子索引 → 偏移方向（见 floatingBlockOffsets）。 */
  offsets?: ReadonlyMap<number, readonly [number, number]>;
}

/**
 * 渲染为 RGBA 图像。默认每格 1 像素、无偏移，画布恰为 列×行；
 * 有偏移时四周各留 offsetPx 内边距，被偏移的格子最后绘制（压在主体之上），
 * 使其与主体产生 offsetPx 的小面积重叠——3D 打印后悬空块即粘在主体上。
 */
export function renderMatrix(matrix: PixelMatrix, options?: RenderOptions): ImageData {
  const scale = Math.max(1, Math.round(options?.scale ?? 1));
  const offsetPx = clamp(Math.round(options?.offsetPx ?? 0), 0, scale);
  const offsets = options?.offsets;
  const pad = offsetPx;
  const width = matrix.columns * scale + pad * 2;
  const height = matrix.rows * scale + pad * 2;
  const image = typeof ImageData === "function" ? new ImageData(width, height) : ({ width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData);
  const paint = (index: number) => {
    const cell = matrix.cells[index];
    if (!cell.color) return;
    const row = Math.floor(index / matrix.columns);
    const column = index % matrix.columns;
    const direction = offsets?.get(index);
    const left = pad + column * scale + (direction ? direction[1] * offsetPx : 0);
    const top = pad + row * scale + (direction ? direction[0] * offsetPx : 0);
    for (let y = top; y < top + scale; y += 1) {
      for (let x = left; x < left + scale; x += 1) {
        const p = (y * width + x) * 4;
        image.data[p] = cell.color[0];
        image.data[p + 1] = cell.color[1];
        image.data[p + 2] = cell.color[2];
        image.data[p + 3] = 255;
      }
    }
  };
  matrix.cells.forEach((cell, index) => { if (!offsets?.has(index)) paint(index); });
  if (offsets) offsets.forEach((_direction, index) => paint(index));
  return image;
}
