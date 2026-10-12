/** Shared CLI/frontend boundary. Paths name files on the connected app host;
 * they are never Browser URLs or remote backend coordinates. */
export function localFilePanePath(value, { absolute = false } = {}) {
  const drivePath = typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value);
  if (typeof value !== "string" || !value.trim() || value.length > 4096
    || /[\u0000-\u001f\u007f]/.test(value)
    || (!drivePath && /^[A-Za-z][A-Za-z\d+.-]*:/.test(value))) {
    throw Object.assign(new Error("file PATH must be a local filesystem path, not a URL."), { code: "invalid_request" });
  }
  if (absolute && !(value.startsWith("/") || drivePath || value.startsWith("\\\\"))) {
    throw Object.assign(new Error("file PATH must be absolute on the connected app host."), { code: "invalid_request" });
  }
  return value;
}
