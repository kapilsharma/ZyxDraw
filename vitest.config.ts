import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plain Node: any accidental DOM use in core fails here.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
