# 拼豆图纸转透明像素图

一个完全在浏览器本地运行的拼豆图纸处理工具。它把带有背景、网格线和编号的规则拼豆图纸转换成每格一个逻辑像素的透明 PNG，适合后续 3D 打印流程。

访问链接：
https://litterbit.github.io/3dpingdou/

## 使用

```bash
npm install
npm run dev
```

上传图片后，框选目标区域，工具会自动判断图片类型（也可手动指定）：**拼豆图纸**走网格检测 + 逐格墨迹占位分析；**像素截图**（放大、模糊、无格线的像素画）走 FFT 格子数估计 + 网格线吸附 + 背景自动置空。校准页面核对网格后可微调行列数，确认后填充颜色。之后仍可逐格填色、擦除、吸取颜色，也可在“图案颜色”里点“换色”把某种颜色整体替换为新颜色（可撤销），最后下载逻辑尺寸透明 PNG。

所有图片处理均在浏览器内完成，不上传原图。

## 构建和测试

```bash
npm test
npm run build
npm run dev
```

推送到 `main` 或 `master` 后，`.github/workflows/pages.yml` 会构建并发布 GitHub Pages。仓库设置中需要将 Pages Source 设为 GitHub Actions。

图纸识别核心复用了 `Lumina-Fuse-Bead-Studio` 中独立的编号网格算法，但网页不依赖 Lumina 宿主 SDK；像素截图管线移植自 `perfectPixel`（noCV2 版，含 FFT 网格数估计与网格线吸附）。
