import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: { name: "ui", environment: "jsdom", setupFiles: ["./vitest.setup.ts"], include: ["tests/ui/**/*.test.{ts,tsx}"] },
      },
      {
        // server tests use the real MySQL/Neo4j from .env; files run one at a time (shared data)
        extends: true,
        test: {
          name: "server",
          environment: "node",
          setupFiles: ["./tests/server/setup.ts"],
          include: ["tests/server/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
