import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  analyzeOccupancy,
  applyThreshold,
  colorKey,
  detectGrid,
  fullRoi,
  recognizeMatrix,
  renderMatrix,
  floatingBlockOffsets,
  type GridGeometry,
  type PixelCell,
  type PixelMatrix,
  type Raster,
  type Roi,
} from "../domain/pixel";

type Step = "upload" | "crop" | "calibrate" | "edit";
type Tool = "paint" | "erase" | "pick";

interface GridState {
  roi: Roi;
  rows: number;
  columns: number;
  geometry: GridGeometry;
  confidence: number;
}

const STEP_ORDER: Step[] = ["upload", "crop", "calibrate", "edit"];
const STEP_LABELS = ["01 上传", "02 框选", "03 校准", "04 导出"];

function imageToRaster(image: HTMLImageElement): Raster {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持 Canvas");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: data.data };
}

function hex(color: readonly number[] | null): string {
  if (!color) return "#ffffff";
  return `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): [number, number, number] {
  const clean = value.replace("#", "");
  return [0, 1, 2].map((index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)) as [number, number, number];
}

function titleFor(step: Step): string {
  if (step === "upload") return "把图纸变成真正的像素图";
  if (step === "crop") return "框出要转换的拼豆图";
  if (step === "calibrate") return "校准网格，确认识别";
  return "检查并导出像素图";
}

function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>, raster: Raster): { x: number; y: number } {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * raster.width,
    y: ((event.clientY - bounds.top) / bounds.height) * raster.height,
  };
}

function drawRaster(context: CanvasRenderingContext2D, raster: Raster) {
  context.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
}

/** 框选步骤：用户拖出主图区域。 */
function RoiCanvas({ raster, roi, onChange }: { raster: Raster; roi: Roi | null; onChange: (roi: Roi) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Roi | null>(null);
  const shown = draft ?? roi;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    drawRaster(context, raster);
    if (!shown) return;
    const x = Math.min(shown.x, shown.x + shown.width);
    const y = Math.min(shown.y, shown.y + shown.height);
    const width = Math.abs(shown.width);
    const height = Math.abs(shown.height);
    context.fillStyle = "rgba(10, 20, 20, .5)";
    context.fillRect(0, 0, raster.width, y);
    context.fillRect(0, y + height, raster.width, raster.height - y - height);
    context.fillRect(0, y, x, height);
    context.fillRect(x + width, y, raster.width - x - width, height);
    context.strokeStyle = "#e76f43";
    context.lineWidth = Math.max(2, raster.width / 500);
    context.strokeRect(x, y, width, height);
  }, [raster, shown]);

  function down(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = canvasPoint(event, raster);
    setDraft({ ...dragStart.current, width: 0, height: 0 });
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!dragStart.current) return;
    const point = canvasPoint(event, raster);
    setDraft({ x: dragStart.current.x, y: dragStart.current.y, width: point.x - dragStart.current.x, height: point.y - dragStart.current.y });
  }

  function up() {
    if (draft && Math.abs(draft.width) >= 8 && Math.abs(draft.height) >= 8) {
      onChange({
        x: Math.min(draft.x, draft.x + draft.width),
        y: Math.min(draft.y, draft.y + draft.height),
        width: Math.abs(draft.width),
        height: Math.abs(draft.height),
      });
    }
    dragStart.current = null;
    setDraft(null);
  }

  return <canvas ref={canvasRef} className="source-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} aria-label="拖动框选主图区域" />;
}

/** 校准步骤：原图 + 网格叠加，支持点击交点对齐。 */
function GridCanvas({ raster, grid, selectedCell, alignMode, onCellClick, onAlign }: {
  raster: Raster;
  grid: GridState;
  selectedCell: number;
  alignMode: boolean;
  onCellClick: (index: number) => void;
  onAlign: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    drawRaster(context, raster);
    const { geometry, roi, rows, columns } = grid;
    context.strokeStyle = "rgba(231, 111, 67, .9)";
    context.lineWidth = Math.max(1.5, raster.width / 700);
    context.strokeRect(roi.x, roi.y, roi.width, roi.height);
    context.strokeStyle = "rgba(19, 92, 87, .82)";
    context.lineWidth = Math.max(1, Math.min(2.5, raster.width / 800));
    const right = geometry.originX + columns * geometry.cellWidth;
    const bottom = geometry.originY + rows * geometry.cellHeight;
    context.beginPath();
    for (let column = 0; column <= columns; column += 1) {
      const x = geometry.originX + column * geometry.cellWidth;
      context.moveTo(x, geometry.originY);
      context.lineTo(x, bottom);
    }
    for (let row = 0; row <= rows; row += 1) {
      const y = geometry.originY + row * geometry.cellHeight;
      context.moveTo(geometry.originX, y);
      context.lineTo(right, y);
    }
    context.stroke();
    if (selectedCell >= 0 && selectedCell < rows * columns) {
      const row = Math.floor(selectedCell / columns);
      const column = selectedCell % columns;
      context.fillStyle = "rgba(221, 101, 55, .3)";
      context.fillRect(geometry.originX + column * geometry.cellWidth, geometry.originY + row * geometry.cellHeight, geometry.cellWidth, geometry.cellHeight);
    }
  }, [raster, grid, selectedCell]);

  function click(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = canvasPoint(event, raster);
    if (alignMode) {
      onAlign(point.x, point.y);
      return;
    }
    const { geometry, rows, columns } = grid;
    const column = Math.floor((point.x - geometry.originX) / geometry.cellWidth);
    const row = Math.floor((point.y - geometry.originY) / geometry.cellHeight);
    if (row >= 0 && column >= 0 && row < rows && column < columns) onCellClick(row * columns + column);
  }

  return <canvas ref={canvasRef} onPointerDown={click} className={`source-canvas ${alignMode ? "aligning" : ""}`} aria-label="带网格覆盖的原始图纸" />;
}

function PixelPreview({ matrix, onCellClick, showGrid = true, labels }: { matrix: PixelMatrix; onCellClick?: (index: number) => void; showGrid?: boolean; labels?: string[] }) {
  return (
    <div className={`pixel-preview ${showGrid ? "show-grid" : ""}`} style={{ "--columns": matrix.columns, "--rows": matrix.rows } as React.CSSProperties}>
      {matrix.cells.map((cell, index) => (
        <button
          type="button"
          key={index}
          className="pixel-cell"
          aria-label={`第 ${Math.floor(index / matrix.columns) + 1} 行，第 ${index % matrix.columns + 1} 列`}
          style={{ backgroundColor: cell.color ? hex(cell.color) : undefined }}
          onClick={() => onCellClick?.(index)}
        >{labels?.[index] ? <span className="score">{labels[index]}</span> : null}</button>
      ))}
    </div>
  );
}

function Field({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function App() {
  const [step, setStep] = useState<Step>("upload");
  const [raster, setRaster] = useState<Raster | null>(null);
  const [fileName, setFileName] = useState("拼豆图纸");
  const [roi, setRoi] = useState<Roi | null>(null);
  const [grid, setGrid] = useState<GridState | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [flips, setFlips] = useState<Record<number, boolean>>({});
  const [alignMode, setAlignMode] = useState(false);
  const [showScores, setShowScores] = useState(false);
  const [selectedCell, setSelectedCell] = useState(0);
  const [matrix, setMatrix] = useState<PixelMatrix | null>(null);
  const [history, setHistory] = useState<PixelCell[][]>([]);
  const [future, setFuture] = useState<PixelCell[][]>([]);
  const [tool, setTool] = useState<Tool>("paint");
  const [paintColor, setPaintColor] = useState("#164e63");
  const [showGrid, setShowGrid] = useState(true);
  const [exportScale, setExportScale] = useState(10);
  const [maxColors, setMaxColors] = useState(16);
  const [overlapPx, setOverlapPx] = useState(2);
  const [error, setError] = useState("");

  // 网格几何一旦变化就重新计算每格 inkRatio；几何变化同时清空人工修正。
  const analysis = useMemo(
    () => (raster && grid ? analyzeOccupancy(raster, grid.geometry, grid.rows, grid.columns) : null),
    [raster, grid],
  );

  useEffect(() => {
    setThreshold(null);
    setFlips({});
    setSelectedCell(0);
  }, [analysis]);

  const effectiveThreshold = threshold ?? analysis?.threshold ?? 0;
  const maxScore = useMemo(() => (analysis ? Math.max(0.02, ...analysis.scores) : 0.02), [analysis]);

  const occupancy = useMemo(() => {
    if (!analysis) return [];
    const automatic = applyThreshold(analysis.scores, effectiveThreshold);
    return automatic.map((occupied, index) => flips[index] ?? occupied);
  }, [analysis, effectiveThreshold, flips]);

  const palette = useMemo(() => {
    if (!matrix) return [];
    const seen = new Map<string, [number, number, number]>();
    matrix.cells.forEach((cell) => { if (cell.color) seen.set(colorKey(cell.color), cell.color); });
    return [...seen.values()];
  }, [matrix]);

  const occupancyPreview = useMemo<PixelMatrix | null>(() => {
    if (!grid || !analysis) return null;
    // 分数落在阈值 ±30% 的格子标记为“不确定”，用橙色提示人工检查；
    // 人工点击过的格子视为已确认，直接显示切换后的状态色。
    const band = Math.max(0.004, effectiveThreshold * 0.3);
    return {
      rows: grid.rows,
      columns: grid.columns,
      background: [255, 255, 255],
      cells: analysis.scores.map((score, index) => {
        const occupied = occupancy[index];
        const manual = Object.prototype.hasOwnProperty.call(flips, index);
        const uncertain = !manual && Math.abs(score - effectiveThreshold) <= band;
        return {
          color: uncertain ? [217, 119, 6] as [number, number, number] : occupied ? [20, 93, 89] as [number, number, number] : null,
          confidence: score,
        };
      }),
    };
  }, [grid, analysis, occupancy, effectiveThreshold, flips]);

  async function loadFile(file: File) {
    setError("");
    if (!file.type.startsWith("image/")) { setError("请选择 PNG、JPG 或 WebP 图片。"); return; }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const nextRaster = imageToRaster(image);
      setRaster(nextRaster);
      setRoi(fullRoi(nextRaster));
      setGrid(null);
      setMatrix(null);
      setFileName(file.name.replace(/\.[^.]+$/, "") || "拼豆图纸");
      setStep("crop");
    } catch {
      setError("图片读取失败，请换一张清晰的规则网格图纸。");
    } finally { URL.revokeObjectURL(url); }
  }

  function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void loadFile(file);
  }

  function confirmRoi() {
    if (!raster || !roi) return;
    runDetection(roi);
  }

  function runDetection(region: Roi) {
    if (!raster) return;
    const detection = detectGrid(raster, region);
    setGrid({ roi: detection.roi, rows: detection.rows, columns: detection.columns, geometry: detection.geometry, confidence: detection.confidence });
    setAlignMode(false);
    setStep("calibrate");
  }

  /** 几何变化后，行列数始终按 ROI 重新推导，保证网格不漂出框选区域。 */
  function updateGeometry(patch: Partial<GridGeometry>) {
    if (!grid) return;
    const geometry = { ...grid.geometry, ...patch };
    const columns = Math.max(1, Math.round((grid.roi.x + grid.roi.width - geometry.originX) / geometry.cellWidth));
    const rows = Math.max(1, Math.round((grid.roi.y + grid.roi.height - geometry.originY) / geometry.cellHeight));
    setGrid({ ...grid, geometry, rows, columns });
  }

  function updateDimensions(key: "rows" | "columns", value: number) {
    if (!grid || !Number.isFinite(value)) return;
    const safe = Math.max(1, Math.min(256, Math.round(value)));
    const geometry = { ...grid.geometry };
    if (key === "columns") geometry.cellWidth = (grid.roi.x + grid.roi.width - geometry.originX) / safe;
    else geometry.cellHeight = (grid.roi.y + grid.roi.height - geometry.originY) / safe;
    setGrid({ ...grid, geometry, rows: key === "rows" ? safe : grid.rows, columns: key === "columns" ? safe : grid.columns });
  }

  /** 点击一个真实格线交点：相位对齐到点击处，整个无限 lattice 随之确定。 */
  function alignAt(x: number, y: number) {
    if (!grid) return;
    const { geometry, roi } = grid;
    const originX = x - Math.round((x - roi.x) / geometry.cellWidth) * geometry.cellWidth;
    const originY = y - Math.round((y - roi.y) / geometry.cellHeight) * geometry.cellHeight;
    const columns = Math.max(1, Math.round((roi.x + roi.width - originX) / geometry.cellWidth));
    const rows = Math.max(1, Math.round((roi.y + roi.height - originY) / geometry.cellHeight));
    setGrid({ ...grid, geometry: { ...geometry, originX, originY }, rows, columns });
  }

  function toggleOccupancy(index: number) {
    setSelectedCell(index);
    setFlips((previous) => ({ ...previous, [index]: !occupancy[index] }));
  }

  function recognize() {
    if (!raster || !grid) return;
    const nextMatrix = recognizeMatrix(raster, { rows: grid.rows, columns: grid.columns, geometry: grid.geometry, occupancy }, 0, maxColors);
    setMatrix(nextMatrix);
    setHistory([]);
    setFuture([]);
    setStep("edit");
  }

  function reset() {
    setStep("upload");
    setRaster(null);
    setRoi(null);
    setGrid(null);
    setMatrix(null);
    setError("");
  }

  function changeCell(index: number, color: [number, number, number] | null) {
    if (!matrix) return;
    setHistory((items) => [...items.slice(-29), matrix.cells]);
    setFuture([]);
    setMatrix({ ...matrix, cells: matrix.cells.map((cell, cellIndex) => cellIndex === index ? { ...cell, color } : cell) });
  }

  function editCell(index: number) {
    if (!matrix) return;
    if (tool === "erase") changeCell(index, null);
    else if (tool === "pick") {
      const color = matrix.cells[index].color;
      if (color) { setPaintColor(hex(color)); setTool("paint"); }
    } else changeCell(index, parseHex(paintColor));
  }

  function undo() {
    if (!matrix || !history.length) return;
    const previous = history[history.length - 1];
    setFuture((items) => [...items, matrix.cells]);
    setHistory((items) => items.slice(0, -1));
    setMatrix({ ...matrix, cells: previous });
  }

  function redo() {
    if (!matrix || !future.length) return;
    const next = future[future.length - 1];
    setHistory((items) => [...items, matrix.cells]);
    setFuture((items) => items.slice(0, -1));
    setMatrix({ ...matrix, cells: next });
  }

  function exportPng() {
    if (!matrix) return;
    const scale = Math.max(1, Math.min(50, Math.round(exportScale) || 1));
    const fix = floatingBlockOffsets(matrix);
    const canvas = document.createElement("canvas");
    // 逐格按 scale×scale 实心矩形绘制；仅靠角相连的悬空块朝主体偏移 overlapPx，与主体产生小重叠。
    const image = renderMatrix(matrix, { scale, offsetPx: overlapPx, offsets: fix.offsets });
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${fileName}-像素图.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }

  const confidence = grid ? Math.round(grid.confidence * 100) : 0;
  const occupiedCount = occupancy.filter(Boolean).length;
  const safeExportScale = Math.max(1, Math.min(50, Math.round(exportScale) || 1));
  const safeOverlap = Math.max(0, Math.min(safeExportScale, Math.round(overlapPx) || 0));
  const cornerFix = useMemo(() => (matrix ? floatingBlockOffsets(matrix) : null), [matrix]);
  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">豆</div>
        <div><p className="eyebrow">BEAD PATTERN TOOL</p><h1>拼豆图纸转像素图</h1></div>
        <div className="topbar-actions">
          <label className="button secondary">打开图片<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} /></label>
          {raster && <button className="button secondary" type="button" onClick={reset}>重新开始</button>}
        </div>
      </header>

      <section className="intro">
        <div><p className="eyebrow">LOCAL · PRIVATE · PNG</p><h2>{titleFor(step)}</h2><p>框选带编号的拼豆图纸，校准网格后确认识别结果，导出适合 3D 打印的透明像素 PNG。</p></div>
        <div className="steps">{STEP_LABELS.map((label, index) => <span key={label} className={index === stepIndex ? "active" : index < stepIndex ? "done" : ""}>{label}</span>)}</div>
      </section>

      {error && <div className="notice error">{error}</div>}

      {step === "upload" && (
        <section className="upload-zone">
          <label className="drop-target" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void loadFile(file); }}>
            <span className="drop-icon">↑</span><strong>拖入图纸，或点击选择文件</strong><small>支持 PNG、JPG、WebP · 图片只在本地浏览器处理</small>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} />
          </label>
          <div className="feature-row"><span>手动框选主图区域</span><span>网格线能量自动定相位</span><span>编号墨迹自动二分类</span><span>透明 PNG 导出</span></div>
        </section>
      )}

      {step === "crop" && raster && (
        <section className="panel image-panel">
          <div className="panel-heading"><div><p className="eyebrow">REGION OF INTEREST</p><h3>框出要转换的拼豆图</h3></div></div>
          <p className="muted">拖动鼠标框住真正要转换的那张拼豆图，不用特别精确。标题、坐标轴、图例和其他图纸都留在框外。当前区域：{roi ? `${Math.round(roi.width)} × ${Math.round(roi.height)} px` : "未框选"}</p>
          <div className="canvas-wrap"><RoiCanvas raster={raster} roi={roi} onChange={setRoi} /></div>
          <div className="action-row">
            <button type="button" className="button secondary" onClick={() => setRoi(fullRoi(raster))}>使用整张图片</button>
            <button type="button" className="button primary" disabled={!roi} onClick={confirmRoi}>确认区域，自动检测网格</button>
          </div>
        </section>
      )}

      {step === "calibrate" && raster && grid && analysis && occupancyPreview && (
        <section className="workspace calibrate-layout">
          <div className="panel image-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">OCCUPANCY</p><h3>确认识别结果</h3></div>
              <span className="metric">网格置信度 {confidence}%</span>
            </div>
            <p className="hint-strong">绿色是有豆格，棋盘格是空位，橙色是分数接近阈值的“不确定”格。<strong>点击矩阵中的任意格子可逐格切换有豆/空位</strong>（橙色格点一下即可确认或排除）；打开“显示分数”可查看每格墨迹比例。</p>
            <div className="binary-stage">
              <PixelPreview matrix={occupancyPreview} onCellClick={toggleOccupancy} labels={showScores ? analysis.scores.map((score) => score.toFixed(2)) : undefined} />
            </div>
            <div className="matrix-caption">
              <span>有效格 {occupiedCount} 格</span>
              <label className="toggle"><input type="checkbox" checked={showScores} onChange={(event) => setShowScores(event.target.checked)} /><span>显示分数</span></label>
              <span className="caption-spacer" />
              <span>{grid.columns} × {grid.rows}</span>
            </div>
            <div className="canvas-wrap source-reference"><GridCanvas raster={raster} grid={grid} selectedCell={selectedCell} alignMode={alignMode} onCellClick={setSelectedCell} onAlign={alignAt} /></div>
            <p className="muted">核对下方网格线是否精确压在原图格线上。没对齐时点“点击对齐交点”，再点一个真实格线交叉点即可。</p>
          </div>
          <div className="panel controls-panel">
            <div className="panel-heading"><div><p className="eyebrow">GRID</p><h3>网格与阈值</h3></div></div>
            <p className="muted">自动检测周期约 {grid.geometry.cellWidth.toFixed(2)} × {grid.geometry.cellHeight.toFixed(2)} px。行列数改变时会按框选区域重新均分。</p>
            <div className="form-grid">
              <Field label="列数" value={grid.columns} min={1} max={256} onChange={(value) => updateDimensions("columns", value)} />
              <Field label="行数" value={grid.rows} min={1} max={256} onChange={(value) => updateDimensions("rows", value)} />
              <Field label="起点 X" value={grid.geometry.originX} step={0.5} onChange={(value) => updateGeometry({ originX: value })} />
              <Field label="起点 Y" value={grid.geometry.originY} step={0.5} onChange={(value) => updateGeometry({ originY: value })} />
              <Field label="格宽" value={grid.geometry.cellWidth} min={2} step={0.1} onChange={(value) => updateGeometry({ cellWidth: value })} />
              <Field label="格高" value={grid.geometry.cellHeight} min={2} step={0.1} onChange={(value) => updateGeometry({ cellHeight: value })} />
            </div>
            <div className="form-grid">
              <Field label="颜色上限" value={maxColors} min={1} max={64} onChange={(value) => setMaxColors(Math.max(1, Math.min(64, Math.round(value) || 1)))} />
            </div>
            <p className="muted">拼豆色号通常很少：填充颜色时，相近的采样色会自动合并，最终颜色不会超过这个数量。</p>
            <label className="field threshold-field">
              <span>占位阈值（墨迹比例 &gt; {effectiveThreshold.toFixed(3)} 判为有豆，自动值由 Otsu 给出）</span>
              <input type="range" min={0} max={maxScore} step={maxScore / 200} value={effectiveThreshold} onChange={(event) => setThreshold(Number(event.target.value))} />
            </label>
            <div className="action-column">
              <button type="button" className={`button ${alignMode ? "primary" : "secondary"}`} onClick={() => setAlignMode((value) => !value)}>{alignMode ? "对齐模式已开启：点击一个格线交点" : "点击对齐交点"}</button>
              <button type="button" className="button secondary" onClick={() => runDetection(grid.roi)}>重新自动检测</button>
              <button type="button" className="button secondary" onClick={() => setStep("crop")}>返回重新框选</button>
              <button type="button" className="button primary" onClick={recognize}>确认占位并填充颜色</button>
            </div>
          </div>
        </section>
      )}

      {step === "edit" && matrix && (
        <section className="workspace editor-layout">
          <div className="panel matrix-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">PIXEL MATRIX</p><h3>{matrix.columns} × {matrix.rows} 逻辑像素</h3></div>
              <label className="toggle"><input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} /><span>网格</span></label>
            </div>
            <div className="matrix-stage"><PixelPreview matrix={matrix} showGrid={showGrid} onCellClick={editCell} /></div>
            <div className="matrix-caption">
              <span>透明区域</span><span className="checker-chip" />
              <span>{matrix.cells.filter((cell) => !cell.color).length} 格</span>
              <span className="caption-spacer" />
              <button type="button" className="text-button" onClick={() => setStep("calibrate")}>返回校准</button>
              <span>{palette.length} 种颜色</span>
            </div>
          </div>
          <aside className="panel tool-panel">
            <div className="panel-heading"><div><p className="eyebrow">TOOLS</p><h3>编辑图案</h3></div></div>
            <div className="tool-buttons">
              <button type="button" className={tool === "paint" ? "tool active" : "tool"} onClick={() => setTool("paint")}>画笔</button>
              <button type="button" className={tool === "erase" ? "tool active" : "tool"} onClick={() => setTool("erase")}>橡皮</button>
              <button type="button" className={tool === "pick" ? "tool active" : "tool"} onClick={() => setTool("pick")}>吸管</button>
            </div>
            <label className="color-picker"><span>当前颜色</span><input type="color" value={paintColor} onChange={(event) => setPaintColor(event.target.value)} /><code>{paintColor.toUpperCase()}</code></label>
            <div className="palette">
              <span className="label">图案颜色</span>
              {palette.map((color) => <button type="button" key={colorKey(color)} className="swatch" style={{ backgroundColor: hex(color) }} aria-label={`选择颜色 ${hex(color)}`} onClick={() => { setPaintColor(hex(color)); setTool("paint"); }} />)}
            </div>
            <div className="history-buttons">
              <button type="button" className="button secondary" disabled={!history.length} onClick={undo}>撤销</button>
              <button type="button" className="button secondary" disabled={!future.length} onClick={redo}>重做</button>
            </div>
            <div className="export-size">
              <Field label="每格像素" value={exportScale} min={1} max={50} onChange={(value) => setExportScale(Math.max(1, Math.min(50, Math.round(value) || 1)))} />
              <Field label="悬空块偏移（像素）" value={overlapPx} min={0} max={safeExportScale} onChange={(value) => setOverlapPx(Math.max(0, Math.min(safeExportScale, Math.round(value) || 0)))} />
              <span className="muted">导出尺寸 {matrix.columns * safeExportScale + safeOverlap * 2} × {matrix.rows * safeExportScale + safeOverlap * 2} px</span>
              {cornerFix && cornerFix.fixed > 0 && <span className="muted">{cornerFix.fixed} 个仅靠角相连的色块，导出时会朝主体偏移 {safeOverlap} px 产生重叠，打印后即粘在主体上。</span>}
              {cornerFix && cornerFix.stranded > 0 && <span className="muted">{cornerFix.stranded} 个色块与主体完全分离（连角都不挨着），无法自动粘连，请先用画笔补连。</span>}
            </div>
            <button type="button" className="button primary full" onClick={exportPng}>下载透明 PNG</button>
          </aside>
        </section>
      )}

      <footer>图像处理完全在浏览器本地完成 · 不上传原图</footer>
    </main>
  );
}
