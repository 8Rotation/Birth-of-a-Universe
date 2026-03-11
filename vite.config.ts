import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "/Birth-of-a-Universe/",
  publicDir: "public",
  build: {
    outDir: "dist",
    target: "esnext",
  },
  server: {
    open: false,
  },
});
