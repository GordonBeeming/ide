import { describe, expect, it } from "vitest";
import { clampLineNumber } from "./editorNavigation";

describe("editor navigation", () => {
  it("clamps requested lines to the document range", () => {
    expect(clampLineNumber(0, 10)).toBe(1);
    expect(clampLineNumber(7, 10)).toBe(7);
    expect(clampLineNumber(99, 10)).toBe(10);
  });

  it("ignores missing or invalid line numbers", () => {
    expect(clampLineNumber(undefined, 10)).toBeUndefined();
    expect(clampLineNumber(Number.NaN, 10)).toBeUndefined();
  });
});
