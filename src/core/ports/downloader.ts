// Port: streaming download of a URL to a file (release assets can be multi-GB, so
// the adapter must stream, never buffer). The `fetch`-based adapter implements it.

export interface DownloadPort {
  /**
   * Download `url` to `dest`, creating parent directories. `token` (when given) is
   * sent as a bearer credential for private repos / higher limits. `onProgress`
   * receives a 0..1 fraction when the response advertises a length.
   */
  download(
    url: string,
    dest: string,
    token?: string,
    onProgress?: (fraction: number) => void,
  ): Promise<void>;
}
