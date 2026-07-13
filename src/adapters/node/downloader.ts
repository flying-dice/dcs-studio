import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { DownloadPort } from "../../core/ports/downloader";

// Node adapter for `DownloadPort`: stream a URL to a file (release assets can be
// multi-GB, so never buffer the whole body). GitHub `browser_download_url`s work
// unauthenticated for public repos; a token is included when present for private
// repos / higher limits.
export async function downloadTo(
  url: string,
  dest: string,
  token: string | undefined,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const headers: Record<string, string> = {
    "User-Agent": "dcs-studio-vscode",
    Accept: "application/octet-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  if (onProgress && total) {
    let received = 0;
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      onProgress(Math.min(1, received / total));
    });
  }
  await pipeline(body, fs.createWriteStream(dest));
}

/** `DownloadPort` over global fetch + a streamed file write. */
export class FetchDownloader implements DownloadPort {
  download(url: string, dest: string, token?: string, onProgress?: (fraction: number) => void): Promise<void> {
    return downloadTo(url, dest, token, onProgress);
  }
}
