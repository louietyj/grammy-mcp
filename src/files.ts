export function isDataUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/zip": "zip",
};

/**
 * Decode `data:[<mime>][;name=<filename>][;base64],<data>`. `name` is our
 * extension, since data URIs carry no filename and Telegram infers the file
 * type from it.
 */
export function decodeDataUri(uri: string): { bytes: Uint8Array; filename: string } {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new Error("Malformed data: URI (no comma)");
  const meta = uri.slice("data:".length, comma).split(";");
  const data = uri.slice(comma + 1);
  const mime = meta[0] || "application/octet-stream";
  const nameParam = meta.find((p) => p.startsWith("name="));

  const bytes = meta.includes("base64")
    ? Uint8Array.from(atob(data.replace(/\s+/g, "")), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(data));
  const filename = nameParam
    ? decodeURIComponent(nameParam.slice("name=".length))
    : `file.${EXTENSIONS[mime] ?? "bin"}`;
  return { bytes, filename };
}
