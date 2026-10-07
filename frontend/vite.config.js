import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    host: true,
    port: 5173,
    watch: {
      usePolling: true,
      interval: 300,
    },
    hmr: {
      clientPort: 5173,
    },
    proxy: {
      "/api": {
        target: process.env.API_PROXY || "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
