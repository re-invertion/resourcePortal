import * as React from "react";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./App";

const FORMIK_PREVIEW_URL = "https://cdn.jsdelivr.net/npm/formik@2.2.9/dist/formik.umd.production.min.js";

type PreviewWindow = Window & {
  React?: typeof React;
  Formik?: unknown;
};

async function loadPreviewFormik() {
  const browser = window as PreviewWindow;
  if (browser.Formik) return;

  // Formik's preview-only UMD build reuses the exact React instance already bundled by Web Console.
  browser.React = React;
  const existing = document.querySelector<HTMLScriptElement>("script[data-resource-portal-formik]");

  await new Promise<void>((resolve) => {
    const script = existing ?? document.createElement("script");
    const finish = () => resolve();

    if (script.dataset.loaded === "true") {
      finish();
      return;
    }

    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      finish();
    }, { once: true });
    script.addEventListener("error", () => {
      script.dataset.loaded = "true";
      console.warn("Formik preview runtime could not be loaded; using semantic form fallback.");
      finish();
    }, { once: true });

    if (!existing) {
      script.src = FORMIK_PREVIEW_URL;
      script.crossOrigin = "anonymous";
      script.dataset.resourcePortalFormik = "preview";
      document.head.appendChild(script);
    }
  });
}

async function bootstrap() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root mount point");

  await loadPreviewFormik();
  hydrateRoot(root, <StrictMode><App initialPath={window.location.pathname} /></StrictMode>);
}

void bootstrap();
