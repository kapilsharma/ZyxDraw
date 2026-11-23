import { describe, expect, it } from "vitest";
import { escapeXml } from "../../src/core";

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml(`<a & 'b' "c">`)).toBe("&lt;a &amp; &apos;b&apos; &quot;c&quot;&gt;");
  });
});
