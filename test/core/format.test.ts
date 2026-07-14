import { describe, expect, it } from "vitest";
import { fmtBytes } from "../../src/core/domain/format";

describe("fmtBytes", () => {
  it("renders zero and negative counts as 0 B", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(-5)).toBe("0 B");
  });

  it("renders sub-KB counts as whole bytes", () => {
    expect(fmtBytes(1)).toBe("1 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  it("uses one decimal place below 10 in a scaled unit", () => {
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(5.25 * 1024 * 1024)).toBe("5.3 MB");
  });

  it("rounds at or above 10 in a scaled unit", () => {
    expect(fmtBytes(10 * 1024)).toBe("10 KB");
    expect(fmtBytes(500 * 1024 * 1024)).toBe("500 MB");
  });

  it("scales through GB to TB", () => {
    expect(fmtBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
    expect(fmtBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  });

  it("caps at TB for absurd sizes", () => {
    expect(fmtBytes(1024 ** 5)).toBe("1024 TB");
  });
});
