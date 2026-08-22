import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  colorKey,
  detectGrid,
  recognizeMatrix,
  renderMatrix,
  sampleCell,
  type GridDetection,
  type GridGeometry,
  type PixelCell,
  type PixelMatrix,
  type Raster,
} from "../domain/pixel";

type Step = "upload" | "calibrate" | "edit";
type Tool = "paint" | "erase" | "pick";

const emptyGeometry: GridGeometry = { originX: 0, originY: 0, cellWidth: 16, cellHeight: 16 };

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
  if (step === "calibrate") return "校准你的拼豆网格";
  return "检查并导出像素图";
}

function CanvasPreview({ raster, detection, onCellClick, selectedCell }: {
  raster: Raster;
  detection: GridDetection;
  onCellClick?: (index: number) => void;
  selectedCell: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    context.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
    context.strokeStyle = "rgba(19, 92, 87, .82)";
    context.lineWidth = Math.max(1, Math.min(3, raster.width / 600));
    context.beginPath();
    for (let column = 0; column <= detection.columns; column += 1) {
      const x = detection.geometry.originX + column * detection.geometry.cellWidth;
      context.moveTo(x, detection.geometry.originY);
      context.lineTo(x, detection.geometry.originY + detection.rows * detection.geometry.cellHeight);
    }
    for (let row = 0; row <= detection.rows; row += 1) {
      const y = detection.geometry.originY + row * detection.geometry.cellHeight;
      context.moveTo(detection.geometry.originX, y);
      context.lineTo(detection.geometry.originX + detection.columns * detection.geometry.cellWidth, y);
    }
    context.stroke();
    if (selectedCell >= 0) {
      const row = Math.floor(selectedCell / detection.columns);
      const column = selectedCell % detection.columns;
      context.fillStyle = "rgba(221, 101, 55, .25)";
      context.fillRect(
        detection.geometry.originX + column * detection.geometry.cellWidth,
        detection.geometry.originY + row * detection.geometry.cellHeight,
        detection.geometry.cellWidth,
        detection.geometry.cellHeight,
      );
    }
  }, [detection, raster, selectedCell]);

  function click(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!onCellClick) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * raster.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * raster.height;
    const column = Math.floor((x - detection.geometry.originX) / detection.geometry.cellWidth);
    const row = Math.floor((y - detection.geometry.originY) / detection.geometry.cellHeight);
    if (row >= 0 && column >= 0 && row < detection.rows && column < detection.columns) {
      onCellClick(row * detection.columns + column);
    }
  }

  return <canvas ref={canvasRef} onPointerDown={click} className="source-canvas" aria-label="带网格覆盖的原始图纸" />;
}

function PixelPreview({ matrix, onCellClick, showGrid = true }: { matrix: PixelMatrix; onCellClick?: (index: number) => void; showGrid?: boolean }) {
  return (
    <div className={`pixel-preview ${showGrid ? "show-grid" : ""}`} style={{ "--columns": matrix.columns } as React.CSSProperties}>
      {matrix.cells.map((cell, index) => (
        <button
          type="button"
          key={index}
          className="pixel-cell"
          aria-label={`第 ${Math.floor(index / matrix.columns) + 1} 行，第 ${index % matrix.columns + 1} 列`}
          style={{ backgroundColor: cell.color ? hex(cell.color) : undefined }}
          onClick={() => onCellClick?.(index)}
        />
      ))}
    </div>
  );
}

function Field({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : 0} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function App() {
  const [step, setStep] = useState<Step>("upload");
  const [raster, setRaster] = useState<Raster | null>(null);
  const [fileName, setFileName] = useState("拼豆图纸");
  const [detection, setDetection] = useState<GridDetection | null>(null);
  const [selectedCell, setSelectedCell] = useState(0);
  const [matrix, setMatrix] = useState<PixelMatrix | null>(null);
  const [history, setHistory] = useState<PixelCell[][]>([]);
  const [future, setFuture] = useState<PixelCell[][]>([]);
  const [tool, setTool] = useState<Tool>("paint");
  const [paintColor, setPaintColor] = useState("#164e63");
  const [showGrid, setShowGrid] = useState(true);
  const [error, setError] = useState("");

  const palette = useMemo(() => {
    if (!matrix) return [];
    const seen = new Map<string, [number, number, number]>();
    matrix.cells.forEach((cell) => { if (cell.color) seen.set(colorKey(cell.color), cell.color); });
    return [...seen.values()];
  }, [matrix]);

  async function loadFile(file: File) {
    setError("");
    if (!file.type.startsWith("image/")) { setError("请选择 PNG、JPG 或 WebP 图片。"); return; }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const nextRaster = imageToRaster(image);
      const nextDetection = detectGrid(nextRaster);
      setRaster(nextRaster);
      setDetection(nextDetection);
      setFileName(file.name.replace(/\.[^.]+$/, "") || "拼豆图纸");
      setSelectedCell(0);
      setStep("calibrate");
    } catch {
      setError("图片读取失败，请换一张清晰的规则网格图纸。");
    } finally { URL.revokeObjectURL(url); }
  }

  function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void loadFile(file);
  }

  function updateGeometry(patch: Partial<GridGeometry>) {
    if (!detection) return;
    setDetection({ ...detection, geometry: { ...detection.geometry, ...patch } });
  }

  function updateDimensions(key: "rows" | "columns", value: number) {
    if (!detection || !raster || !Number.isFinite(value)) return;
    const safe = Math.max(1, Math.min(256, Math.round(value)));
    const geometry = { ...detection.geometry };
    if (key === "columns") geometry.cellWidth = (raster.width - geometry.originX) / safe;
    else geometry.cellHeight = (raster.height - geometry.originY) / safe;
    setDetection({ ...detection, [key]: safe, geometry });
  }

  function recognize() {
    if (!raster || !detection) return;
    const nextMatrix = recognizeMatrix(raster, detection, selectedCell);
    setMatrix(nextMatrix);
    setHistory([]);
    setFuture([]);
    setStep("edit");
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
    const canvas = document.createElement("canvas");
    canvas.width = matrix.columns;
    canvas.height = matrix.rows;
    canvas.getContext("2d")?.putImageData(renderMatrix(matrix), 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${fileName}-像素图.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }

  const confidence = detection ? Math.round(detection.confidence * 100) : 0;
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">豆</div>
        <div><p className="eyebrow">BEAD PATTERN TOOL</p><h1>拼豆图纸转像素图</h1></div>
        <div className="topbar-actions"><label className="button secondary">打开图片<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} /></label>{raster && <button className="button secondary" type="button" onClick={() => { setStep("upload"); setRaster(null); setDetection(null); setMatrix(null); }}>重新开始</button>}</div>
      </header>

      <section className="intro"><div><p className="eyebrow">LOCAL · PRIVATE · PNG</p><h2>{titleFor(step)}</h2><p>把带背景、网格线和编号的拼豆图纸，整理成适合 3D 打印的透明像素 PNG。</p></div><div className="steps"><span className={step === "upload" ? "active" : "done"}>01 上传</span><span className={step === "calibrate" ? "active" : step === "edit" ? "done" : ""}>02 校准</span><span className={step === "edit" ? "active" : ""}>03 编辑导出</span></div></section>

      {error && <div className="notice error">{error}</div>}
      {step === "upload" && <section className="upload-zone"><label className="drop-target" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void loadFile(file); }}><span className="drop-icon">↑</span><strong>拖入图纸，或点击选择文件</strong><small>支持 PNG、JPG、WebP · 图片只在本地浏览器处理</small><input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} /></label><div className="feature-row"><span>规则网格自动检测</span><span>编号干扰颜色采样</span><span>透明 PNG 导出</span></div></section>}

      {step === "calibrate" && raster && detection && <section className="workspace calibrate-layout"><div className="panel image-panel"><div className="panel-heading"><div><p className="eyebrow">SOURCE IMAGE</p><h3>选择一个空白单元</h3></div><span className="metric">识别置信度 {confidence}%</span></div><p className="muted">点击图纸中确定没有拼豆的格子。系统会用它区分背景与白色拼豆。</p><div className="canvas-wrap"><CanvasPreview raster={raster} detection={detection} selectedCell={selectedCell} onCellClick={setSelectedCell} /></div></div><div className="panel controls-panel"><div className="panel-heading"><div><p className="eyebrow">GRID CALIBRATION</p><h3>网格参数</h3></div></div><div className="form-grid"><Field label="列数" value={detection.columns} min={1} max={256} onChange={(value) => updateDimensions("columns", value)} /><Field label="行数" value={detection.rows} min={1} max={256} onChange={(value) => updateDimensions("rows", value)} /><Field label="起点 X" value={detection.geometry.originX} step={0.5} onChange={(value) => updateGeometry({ originX: value })} /><Field label="起点 Y" value={detection.geometry.originY} step={0.5} onChange={(value) => updateGeometry({ originY: value })} /><Field label="单元宽" value={detection.geometry.cellWidth} min={1} step={0.5} onChange={(value) => updateGeometry({ cellWidth: value })} /><Field label="单元高" value={detection.geometry.cellHeight} min={1} step={0.5} onChange={(value) => updateGeometry({ cellHeight: value })} /></div><div className="selected-sample"><span className="sample-dot" /><span>当前空白样本：第 {Math.floor(selectedCell / detection.columns) + 1} 行，第 {selectedCell % detection.columns + 1} 列</span></div><button className="button primary full" type="button" onClick={recognize}>识别并进入编辑</button><button className="text-button" type="button" onClick={() => { const next = detectGrid(raster); setDetection(next); }}>重新自动检测</button></div></section>}

      {step === "edit" && matrix && <section className="workspace editor-layout"><div className="panel matrix-panel"><div className="panel-heading"><div><p className="eyebrow">PIXEL MATRIX</p><h3>{matrix.columns} × {matrix.rows} 逻辑像素</h3></div><label className="toggle"><input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} /><span>网格</span></label></div><div className="matrix-stage"><PixelPreview matrix={matrix} showGrid={showGrid} onCellClick={editCell} /></div><div className="matrix-caption"><span>透明区域</span><span className="checker-chip" /> <span>{matrix.cells.filter((cell) => !cell.color).length} 格</span><span className="caption-spacer" /><span>{palette.length} 种颜色</span></div></div><aside className="panel tool-panel"><div className="panel-heading"><div><p className="eyebrow">TOOLS</p><h3>编辑图案</h3></div></div><div className="tool-buttons"><button type="button" className={tool === "paint" ? "tool active" : "tool"} onClick={() => setTool("paint")}>画笔</button><button type="button" className={tool === "erase" ? "tool active" : "tool"} onClick={() => setTool("erase")}>橡皮</button><button type="button" className={tool === "pick" ? "tool active" : "tool"} onClick={() => setTool("pick")}>吸管</button></div><label className="color-picker"><span>当前颜色</span><input type="color" value={paintColor} onChange={(event) => setPaintColor(event.target.value)} /><code>{paintColor.toUpperCase()}</code></label><div className="palette"><span className="label">图案颜色</span>{palette.map((color) => <button type="button" key={colorKey(color)} className="swatch" style={{ backgroundColor: hex(color) }} aria-label={`选择颜色 ${hex(color)}`} onClick={() => { setPaintColor(hex(color)); setTool("paint"); }} />)}</div><div className="history-buttons"><button type="button" className="button secondary" disabled={!history.length} onClick={undo}>撤销</button><button type="button" className="button secondary" disabled={!future.length} onClick={redo}>重做</button></div><button className="button primary full" type="button" onClick={exportPng}>下载透明 PNG</button><button className="text-button" type="button" onClick={() => setStep("calibrate")}>返回校准</button></aside></section>}
      <footer>图像处理完全在浏览器本地完成 · 不上传原图</footer>
    </main>
  );
}
