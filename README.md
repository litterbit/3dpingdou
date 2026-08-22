# 拼豆图纸转透明像素图

一个完全在浏览器本地运行的拼豆图纸处理工具。它把带有背景、网格线和编号的规则拼豆图纸转换成每格一个逻辑像素的透明 PNG，适合后续 3D 打印流程。

## 使用

```bash
npm install
npm run dev
```

上传图片后，工具会自动寻找周期性网格。校准页面可以修改行列、起点和单元尺寸，并点击一个确定的空白格作为透明背景样本。识别后可以逐格填色、擦除、吸取颜色，最后下载逻辑尺寸 PNG。

所有图片处理均在浏览器内完成，不上传原图。

## 构建和测试

```bash
npm test
npm run build
```

推送到 `main` 或 `master` 后，`.github/workflows/pages.yml` 会构建并发布 GitHub Pages。仓库设置中需要将 Pages Source 设为 GitHub Actions。

第一版针对正视、规则网格图纸。`perfectPixel` 的模糊像素图校正属于后续模式，不参与当前拼豆编号图纸识别。
