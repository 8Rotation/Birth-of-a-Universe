import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: process.env.VITE_BASE ?? "/Birth-of-a-Universe/",
  publicDir: "public",
  build: {
    outDir: "dist",
    target: "es2022",
  },
  server: {
    open: false,
  },
});
