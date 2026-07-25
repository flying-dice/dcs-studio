import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadTo, FetchDownloader } from "../../../src/adapters/node/downloader";

// The downloader fetches mod release payloads, which are routinely hundreds of
// megabytes and sometimes multi-gigabyte. Two properties matter and neither is
// visible in the types: the body is *streamed* to disk rather than buffered
// (buffering a 2 GiB asset would take the extension host down with it), and the
// progress fraction stays in 0..1 so the install progress bar is meaningful.
//
// Only the network is faked — a real `Response` carrying a real web stream, so
// the `Readable.fromWeb` bridge and the pipeline are the production ones — and
// the file really lands in a temp dir, because "did the bytes arrive intact"
// is the whole point of the adapter.

let root: string;
const REAL_FETCH = globalThis.fetch;

/** A response whose body is a real web stream delivered in several chunks. */
function streamed(chunks: string[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

/** One recorded fetch: the URL asked for and the request options sent with it. */
interface FetchCall {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

/** Replace global fetch with `respond`, recording what was asked for. */
function stubFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      redirect: init.redirect,
    });
    return Promise.resolve(respond());
  }) as typeof globalThis.fetch;
  return calls;
}

beforeEach(() => {
  root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "dcs-dl-"));
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  vi.restoreAllMocks();
  nodeFs.rmSync(root, { recursive: true, force: true });
});

describe("downloadTo", () => {
  it("streams the body to disk, creating the parent directories", async () => {
    // Downloads land in <dataDir>/<repo>/… which the caller has not created.
    stubFetch(() => streamed(["hello ", "world"]));
    const dest = path.join(root, "cache", "owner__repo", "payload.7z");

    await downloadTo("https://example.test/p.7z", dest, undefined);
    expect(nodeFs.readFileSync(dest, "utf8")).toBe("hello world");
  });

  it("identifies the extension and asks for the raw asset, unauthenticated", async () => {
    // GitHub serves browser_download_url without credentials for public repos;
    // sending none is what keeps public mod installs working for signed-out users.
    const calls = stubFetch(() => streamed(["x"]));

    await downloadTo("https://example.test/p.7z", path.join(root, "p.7z"), undefined);
    expect(calls).toEqual([
      {
        url: "https://example.test/p.7z",
        headers: {
          "User-Agent": "dcs-studio-vscode",
          Accept: "application/octet-stream",
        },
        redirect: "follow",
      },
    ]);
  });

  it("sends a bearer token when one is available", async () => {
    // Private-repo assets 404 without it, and the anonymous rate limit is low
    // enough that a signed-in user should never be subject to it.
    const calls = stubFetch(() => streamed(["x"]));

    await downloadTo("https://example.test/p.7z", path.join(root, "p.7z"), "gho_secret");
    expect(calls[0].headers.Authorization).toBe("Bearer gho_secret");
  });

  it("follows redirects, as GitHub asset URLs always issue one", async () => {
    const calls = stubFetch(() => streamed(["x"]));
    await downloadTo("https://example.test/p.7z", path.join(root, "p.7z"), undefined);
    expect(calls[0].redirect).toBe("follow");
  });

  it("fails with the status code when the asset cannot be fetched", async () => {
    // A deleted release or a private repo without a token; the code is the
    // only thing that tells those apart in a bug report.
    stubFetch(() => new Response("nope", { status: 404 }));
    const dest = path.join(root, "p.7z");

    await expect(downloadTo("https://example.test/p.7z", dest, undefined)).rejects.toThrow(
      "Download failed (404) for https://example.test/p.7z",
    );
    expect(nodeFs.existsSync(dest)).toBe(false);
  });

  it("fails rather than writing an empty file when the response has no body", async () => {
    // A 204/HEAD-shaped response would otherwise produce a zero-byte archive
    // that 7-Zip then reports as corrupt, hiding the real cause.
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(
      downloadTo("https://example.test/p.7z", path.join(root, "p.7z"), undefined),
    ).rejects.toThrow("Download failed (200) for https://example.test/p.7z");
  });

  it("reports progress as a rising 0..1 fraction of the advertised length", async () => {
    stubFetch(() => streamed(["aaaa", "bbbb"], { "content-length": "8" }));
    const seen: number[] = [];

    await downloadTo("https://example.test/p.7z", path.join(root, "p.7z"), undefined, (f) =>
      seen.push(f),
    );
    expect(seen).toEqual([0.5, 1]);
  });

  it("clamps progress at 1 when the server under-reports content-length", async () => {
    // A fraction above 1 drives the VS Code progress bar past full and it never
    // resolves visually; clamping keeps the install looking finishable.
    stubFetch(() => streamed(["aaaa", "bbbb"], { "content-length": "4" }));
    const seen: number[] = [];

    await downloadTo("https://example.test/p.7z", path.join(root, "p.7z"), undefined, (f) =>
      seen.push(f),
    );
    expect(seen).toEqual([1, 1]);
  });

  it("still downloads when the length is unknown, simply reporting no progress", async () => {
    // Chunked responses carry no content-length; an indeterminate bar is fine,
    // a failed download is not.
    stubFetch(() => streamed(["chunked payload"]));
    const seen: number[] = [];
    const dest = path.join(root, "p.7z");

    await downloadTo("https://example.test/p.7z", dest, undefined, (f) => seen.push(f));
    expect(seen).toEqual([]);
    expect(nodeFs.readFileSync(dest, "utf8")).toBe("chunked payload");
  });

  it("downloads without a progress callback at all", async () => {
    stubFetch(() => streamed(["x"], { "content-length": "1" }));
    const dest = path.join(root, "p.7z");
    await downloadTo("https://example.test/p.7z", dest, undefined);
    expect(nodeFs.readFileSync(dest, "utf8")).toBe("x");
  });
});

describe("FetchDownloader", () => {
  it("passes every argument through to the streaming download", async () => {
    const calls = stubFetch(() => streamed(["ab", "cd"], { "content-length": "4" }));
    const seen: number[] = [];
    const dest = path.join(root, "nested", "p.7z");

    await new FetchDownloader().download("https://example.test/p.7z", dest, "tok", (f) =>
      seen.push(f),
    );

    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(seen).toEqual([0.5, 1]);
    expect(nodeFs.readFileSync(dest, "utf8")).toBe("abcd");
  });
});
