import { describe, expect, it } from "vitest";
import {
  buildIco,
  buildIcoHeader,
  MYMODS_URI_PATH,
  myModsUri,
} from "../../src/core/domain/shortcut";

describe("myModsUri", () => {
  it("builds the deep link from scheme + extension id + fixed path", () => {
    expect(MYMODS_URI_PATH).toBe("/mymods");
    expect(myModsUri("vscode", "dcs-studio.dcs-studio")).toBe(
      "vscode://dcs-studio.dcs-studio/mymods",
    );
    expect(myModsUri("vscode-insiders", "pub.ext")).toBe("vscode-insiders://pub.ext/mymods");
  });
});

describe("buildIcoHeader", () => {
  it("emits the 22-byte single-image PNG-in-ICO directory", () => {
    const pngLength = 0x01020304;
    const h = buildIcoHeader(pngLength);
    expect(h.length).toBe(22);
    const dv = new DataView(h.buffer);
    expect(dv.getUint16(0, true)).toBe(0); // reserved
    expect(dv.getUint16(2, true)).toBe(1); // type: icon
    expect(dv.getUint16(4, true)).toBe(1); // one image
    expect(h[6]).toBe(0); // width: 0 = 256
    expect(h[7]).toBe(0); // height: 0 = 256
    expect(h[8]).toBe(0); // palette
    expect(h[9]).toBe(0); // reserved
    expect(dv.getUint16(10, true)).toBe(1); // color planes
    expect(dv.getUint16(12, true)).toBe(32); // bits per pixel
    expect(dv.getUint32(14, true)).toBe(pngLength); // image byte size
    expect(dv.getUint32(18, true)).toBe(22); // image data offset
  });
});

describe("buildIco", () => {
  it("concatenates the header and the PNG payload", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const ico = buildIco(png);
    expect(ico.length).toBe(22 + png.length);
    expect(Array.from(ico.slice(22))).toEqual(Array.from(png));
    const dv = new DataView(ico.buffer);
    expect(dv.getUint32(14, true)).toBe(png.length);
  });
});
