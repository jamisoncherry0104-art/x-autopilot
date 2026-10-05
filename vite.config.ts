import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// MV3 构建配置：
// - sidepanel (HTML) 走标准 Vite 流程
// - service worker / content script 必须打成单文件 IIFE，且不能有 code-split
// - manifest.json 直接拷贝为产物根目录的清单
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [
    react(),
    {
      name: 'copy-manifest',
      generateBundle() {
        // manifest 通过 public/ 目录自动拷贝，这里仅保留钩子便于后续做版本号注入
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    // Chrome 扩展禁止动态 import 之外的内联脚本，关闭 modulepreload 生成
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
