import type { Raster, Roi } from "../../domain/types";
import { RoiCanvas } from "../RoiCanvas";
import type { ModeSetting } from "../types";

const MODE_LABELS: Array<{ value: ModeSetting; label: string }> = [
  { value: "auto", label: "自动识别" },
  { value: "chart", label: "拼豆图纸" },
  { value: "pixel", label: "像素图" },
];

export function CropStep({ raster, roi, mode, onModeChange, onRoiChange, onUseFullImage, onConfirm }: {
  raster: Raster;
  roi: Roi | null;
  mode: ModeSetting;
  onModeChange: (mode: ModeSetting) => void;
  onRoiChange: (roi: Roi) => void;
  onUseFullImage: () => void;
  onConfirm: () => void;
}) {
  return (
    <section className="panel image-panel">
      <div className="panel-heading"><div><p className="eyebrow">REGION OF INTEREST</p><h3>框出要转换的图案</h3></div></div>
      <p className="muted">拖动鼠标框住真正要转换的区域，不用特别精确。标题、坐标轴、图例和其他图纸都留在框外。当前区域：{roi ? `${Math.round(roi.width)} × ${Math.round(roi.height)} px` : "未框选"}</p>
      <div className="canvas-wrap"><RoiCanvas raster={raster} roi={roi} onChange={onRoiChange} /></div>
      <div className="action-row">
        <span className="mode-switch">
          <span className="mode-label">图片类型</span>
          {MODE_LABELS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`button ${mode === value ? "primary" : "secondary"}`}
              onClick={() => onModeChange(value)}
            >{label}</button>
          ))}
        </span>
        <button type="button" className="button secondary" onClick={onUseFullImage}>使用整张图片</button>
        <button type="button" className="button primary" disabled={!roi} onClick={onConfirm}>确认区域，自动检测网格</button>
      </div>
    </section>
  );
}
