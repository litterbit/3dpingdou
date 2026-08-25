export function UploadStep({ onFile }: { onFile: (file: File) => void }) {
  return (
    <section className="upload-zone">
      <label className="drop-target" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) onFile(file); }}>
        <span className="drop-icon">↑</span><strong>拖入图纸，或点击选择文件</strong><small>支持 PNG、JPG、WebP · 图片只在本地浏览器处理</small>
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); }} />
      </label>
      <div className="feature-row"><span>手动框选主图区域</span><span>网格线能量自动定相位</span><span>编号墨迹自动二分类</span><span>透明 PNG 导出</span></div>
    </section>
  );
}
