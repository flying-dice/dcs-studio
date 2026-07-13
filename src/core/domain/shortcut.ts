// Pure bits of the My Mods desktop-shortcut feature: the deep-link URI the .lnk
// targets, and the PNG-in-ICO byte assembly (a .lnk can't reference a PGN, so the
// bundled 256×256 icon.png is wrapped in a single-image ICO container, supported
// since Vista). The adapter (`install/shortcut.ts`) owns the fs write + the
// PowerShell that creates the .lnk; this module owns the exact bytes and the URI.

/** The path component of the My Mods deep link (`vscode://<ext-id>/mymods`). */
export const MYMODS_URI_PATH = "/mymods";

/** The `vscode://` deep link that opens My Mods (scheme varies per product). */
export function myModsUri(uriScheme: string, extensionId: string): string {
  return `${uriScheme}://${extensionId}${MYMODS_URI_PATH}`;
}

/**
 * The 22-byte ICONDIR + ICONDIRENTRY header for a single 256×256 32-bpp PNG image
 * of `pngLength` bytes. Width/height 0 mean 256; the image data follows the
 * 22-byte header. Little-endian, matching the Windows ICO format.
 */
export function buildIcoHeader(pngLength: number): Uint8Array {
  const buf = new Uint8Array(22);
  const dv = new DataView(buf.buffer);
  dv.setUint16(2, 1, true); // type: 1 = icon
  dv.setUint16(4, 1, true); // one image
  dv.setUint8(6, 0); // width: 0 = 256
  dv.setUint8(7, 0); // height: 0 = 256
  dv.setUint16(10, 1, true); // color planes
  dv.setUint16(12, 32, true); // bits per pixel
  dv.setUint32(14, pngLength, true); // image byte size
  dv.setUint32(18, 22, true); // offset: image data follows the directory
  return buf;
}

/** The full ICO file bytes wrapping `png` (header + PNG payload). */
export function buildIco(png: Uint8Array): Uint8Array {
  const header = buildIcoHeader(png.length);
  const out = new Uint8Array(header.length + png.length);
  out.set(header, 0);
  out.set(png, header.length);
  return out;
}
