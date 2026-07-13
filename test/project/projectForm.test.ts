import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { defaultLocation, initialForm, browseStart } from "../../src/core/domain/projectForm";

const HOME = path.join("C:", "Users", "jo");
const DEFAULT = path.join(HOME, "DCSStudio");

describe("defaultLocation", () => {
  it("is <home>/DCSStudio", () => {
    expect(defaultLocation(HOME)).toBe(DEFAULT);
  });
});

describe("initialForm", () => {
  const folder = path.join("D:", "work", "My Mod");

  it("with a folder open: bootstraps in place, name from the folder basename", () => {
    const form = initialForm(folder, undefined, HOME);
    expect(form.folder).toBe(folder);
    expect(form.name).toBe("My Mod");
    expect(form.location).toBe(DEFAULT);
  });

  it("with a folder open and a remembered location: prefers the remembered one", () => {
    const form = initialForm(folder, "E:\\projects", HOME);
    expect(form.location).toBe("E:\\projects");
  });

  it("with a folder open and a blank remembered location: falls back to the default", () => {
    expect(initialForm(folder, "   ", HOME).location).toBe(DEFAULT);
    expect(initialForm(folder, "", HOME).location).toBe(DEFAULT);
  });

  it("with no folder open: asks for one — null folder, empty name and location", () => {
    const form = initialForm(undefined, "E:\\projects", HOME);
    expect(form.folder).toBeNull();
    expect(form.name).toBe("");
    expect(form.location).toBe("");
  });
});

describe("browseStart", () => {
  it("prefers the location typed into the form", () => {
    expect(browseStart("E:\\here", "E:\\last", HOME)).toBe("E:\\here");
  });

  it("falls back to the remembered last location when the form is blank", () => {
    expect(browseStart("   ", "E:\\last", HOME)).toBe("E:\\last");
    expect(browseStart(undefined, "E:\\last", HOME)).toBe("E:\\last");
  });

  it("falls back to the default when nothing else is available", () => {
    expect(browseStart(undefined, undefined, HOME)).toBe(DEFAULT);
    expect(browseStart("", "  ", HOME)).toBe(DEFAULT);
  });
});
