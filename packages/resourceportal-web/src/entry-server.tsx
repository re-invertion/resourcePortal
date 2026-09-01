import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { parseRoute } from "./router/router";

export type RenderResult = {
  html: string;
  status: number;
};

export function render(pathname: string): RenderResult {
  const route = parseRoute(pathname);
  return {
    html: renderToString(<StrictMode><App initialPath={pathname} /></StrictMode>),
    status: route.kind === "not-found" ? 404 : 200,
  };
}
