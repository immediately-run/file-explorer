import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config for the file-explorer app's unit tests (FX-3 regression guard).
// jsdom DOM + Testing Library; the SDK and the sandbox `readdir` are mocked per
// test so the tree renders without a live sandbox.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
