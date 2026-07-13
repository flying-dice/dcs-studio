import { describe, it, expect } from "vitest";
import {
  EXPORT_OPEN_LIMIT_BYTES,
  exportFileBase,
  shouldOpenExport,
} from "../../src/core/domain/bridgeConsole";

describe("shouldOpenExport (<5MB open rule)", () => {
  it("opens exports strictly under 5 MB", () => {
    expect(EXPORT_OPEN_LIMIT_BYTES).toBe(5 * 1024 * 1024);
    expect(shouldOpenExport(EXPORT_OPEN_LIMIT_BYTES - 1)).toBe(true);
    expect(shouldOpenExport(0)).toBe(true);
  });

  it("announces (does not open) at or above 5 MB", () => {
    expect(shouldOpenExport(EXPORT_OPEN_LIMIT_BYTES)).toBe(false);
    expect(shouldOpenExport(EXPORT_OPEN_LIMIT_BYTES + 1)).toBe(false);
  });
});

describe("exportFileBase", () => {
  it("falls back to lua-export when the label is missing or empty", () => {
    expect(exportFileBase(undefined)).toBe("lua-export");
    expect(exportFileBase("")).toBe("lua-export");
  });

  it("collapses runs of unsafe characters to a single underscore", () => {
    expect(exportFileBase("my table / values")).toBe("my_table_values");
  });

  it("keeps word characters, dots and dashes", () => {
    expect(exportFileBase("units-v1.2_final")).toBe("units-v1.2_final");
  });

  it("trims leading/trailing underscores produced by sanitization", () => {
    expect(exportFileBase("!!weird label!!")).toBe("weird_label");
  });

  it("falls back when nothing survives sanitization", () => {
    expect(exportFileBase("!!!")).toBe("lua-export");
  });

  it("caps the base name at 60 characters", () => {
    expect(exportFileBase("a".repeat(80))).toBe("a".repeat(60));
  });
});
