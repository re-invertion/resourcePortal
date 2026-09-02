import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiTarget } from "./proxy-target.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 5173);
const apiOrigin = new URL(process.env.RESOURCE_PORTAL_API_ORIGIN ?? "http://127.0.0.1:3000");
const clientDirectory = path.join(root, "dist", "client");

let vite;
let productionTemplate;
let productionRender;

if (production) {
  productionTemplate = await readFile(path.join(clientDirectory, "index.html"), "utf8");
  ({ render: productionRender } = await import("./dist/server/entry-server.js"));
} else {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "custom",
  });
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function proxyApi(request, response) {
  const target = new URL(resolveApiTarget(request.url ?? "/api", apiOrigin));
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: { ...request.headers, host: target.host },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on("error", (error) => {
    console.error("Resource Portal API proxy error", error);
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Resource Portal API is unavailable");
    } else {
      response.destroy(error);
    }
  });

  request.pipe(upstream);
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

async function serveProductionAsset(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (!path.extname(pathname)) return false;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const candidate = path.resolve(clientDirectory, `.${decodedPath}`);
  const relative = path.relative(clientDirectory, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;

  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
  } catch {
    return false;
  }

  response.statusCode = 200;
  response.setHeader("content-type", contentTypes.get(path.extname(candidate)) ?? "application/octet-stream");
  if (pathname.startsWith("/assets/")) response.setHeader("cache-control", "public, max-age=31536000, immutable");
  if (request.method === "HEAD") response.end();
  else createReadStream(candidate).pipe(response);
  return true;
}

async function renderDocument(request, response, url) {
  try {
    let template;
    let render;
    if (production) {
      template = productionTemplate;
      render = productionRender;
    } else {
      template = await readFile(path.join(root, "index.html"), "utf8");
      template = await vite.transformIndexHtml(url.pathname + url.search, template);
      ({ render } = await vite.ssrLoadModule("/src/entry-server.tsx"));
    }

    const rendered = render(url.pathname);
    const html = template.replace("<!--ssr-outlet-->", rendered.html);
    response.statusCode = rendered.status;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(html);
  } catch (error) {
    if (vite) vite.ssrFixStacktrace(error);
    console.error("Resource Portal Web SSR error", error);
    response.statusCode = 500;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("Resource Portal Web failed to render this document");
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://resourceportal.local");

  if (isApiPath(url.pathname)) {
    if (production) proxyApi(request, response);
    else vite.middlewares(request, response, (error) => {
      if (error) {
        response.statusCode = 502;
        response.end("Resource Portal API proxy failed");
      } else {
        response.statusCode = 404;
        response.end("Resource Portal API route not found");
      }
    });
    return;
  }

  if (production) {
    void serveProductionAsset(request, response, url.pathname).then((served) => {
      if (!served) void renderDocument(request, response, url);
    });
    return;
  }

  vite.middlewares(request, response, (error) => {
    if (error) {
      vite.ssrFixStacktrace(error);
      response.statusCode = 500;
      response.end("Vite middleware failed");
      return;
    }
    void renderDocument(request, response, url);
  });
});

server.listen(port, host, () => {
  console.log(`Resource Portal Web listening on http://${host}:${port} (${production ? "production" : "development"})`);
});
