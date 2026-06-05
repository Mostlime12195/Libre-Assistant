import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In Nuxt, `~` points to the `app/` directory.
const appDir = path.join(__dirname, "app").replace(/\\/g, "/");

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["tests/**/*.test.js"],
  },
  resolve: {
    alias: {
      "~": appDir,
    },
  },
});
