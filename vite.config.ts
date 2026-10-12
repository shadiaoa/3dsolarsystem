import { defineConfig } from "vite";

// GitHub Pages 站点路径（https://alienshun.github.io/3dsolarsystem/）；本地 dev/preview 同路径
export default defineConfig({
  base: "/3dsolarsystem/",
  server: {
    port: 5173,
    // Vite 6 默认只放行 localhost/IP，Codespaces 的端口转发域名会被 403 拦掉
    allowedHosts: [".app.github.dev"],
  },
});
