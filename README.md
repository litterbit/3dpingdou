# 拼豆图纸转透明像素图

一个完全在浏览器本地运行的拼豆图纸处理工具。它把带有背景、网格线和编号的规则拼豆图纸转换成每格一个逻辑像素的透明 PNG，适合后续 3D 打印流程。

## 使用

```bash
npm install
npm run dev
```

上传图片后，工具先估计覆盖整张图片的基础网格 `pitch/phase`，再逐格分析中心 glyph，最后从占位图中选择主图区域。校准页面展示 `0/1` 占位矩阵：有中心编号结构的格子是有效拼豆，空白格是透明区域；白色和浅肤色拼豆不会因为接近背景而被删除。你可以点击矩阵逐格修正，再确认并填充颜色。之后仍可逐格填色、擦除、吸取颜色，最后下载逻辑尺寸 PNG。

所有图片处理均在浏览器内完成，不上传原图。

## 构建和测试

```bash
npm test
npm run build
```

推送到 `main` 或 `master` 后，`.github/workflows/pages.yml` 会构建并发布 GitHub Pages。仓库设置中需要将 Pages Source 设为 GitHub Actions。

第一版针对正视、规则、带中心编号的拼豆图纸。识别核心复用了 `Lumina-Fuse-Bead-Studio` 中独立的编号网格算法，但网页不依赖 Lumina 宿主 SDK。`perfectPixel` 的模糊像素图校正属于后续模式，不参与当前拼豆编号图纸识别。
