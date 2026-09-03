/*
 * Reads files out of the Workers Static Assets store (public/) and turns
 * them into data: URIs so the headless-browser HTML we hand to Browser
 * Rendering is fully self-contained — no network fetch, no CORS, no
 * dependency on the asset being publicly reachable.
 */

const MIME_BY_EXT = {
  png: "image/png",
  svg: "image/svg+xml",
  woff2: "font/woff2",
};

function extOf(path) {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : "";
}

export async function loadDataUri(env, path) {
  const response = await env.ASSETS.fetch(new URL(path, "http://assets.local"));
  if (!response.ok) {
    throw new Error(`Asset not found: ${path} (status ${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  const mime = MIME_BY_EXT[extOf(path)] || "application/octet-stream";
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}
