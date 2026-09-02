import * as React from "react";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./App";

const TAILWIND_PREVIEW_URL = "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4";
const FORMIK_PREVIEW_URL = "https://cdn.jsdelivr.net/npm/formik@2.2.9/dist/formik.umd.production.min.js";
const YUP_PREVIEW_URL = "https://cdn.jsdelivr.net/npm/yup@1.7.1/+esm";

type PreviewWindow = Window & {
  React?: typeof React;
  Formik?: unknown;
  Yup?: unknown;
};

async function loadPreviewScript(url: string, marker: string, warning: string) {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-resource-portal-preview="${marker}"]`);

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
      console.warn(warning);
      finish();
    }, { once: true });

    if (!existing) {
      script.src = url;
      script.crossOrigin = "anonymous";
      script.dataset.resourcePortalPreview = marker;
      document.head.appendChild(script);
    }
  });
}

async function loadPreviewYup(browser: PreviewWindow) {
  if (browser.Yup) return;
  try {
    browser.Yup = await import(/* @vite-ignore */ YUP_PREVIEW_URL);
  } catch {
    console.warn("Yup preview runtime could not be loaded; browser-native validation remains available.");
  }
}

async function loadPreviewUi() {
  if (!import.meta.env.DEV) return;

  const browser = window as PreviewWindow;
  browser.React = React;

  const loaders: Promise<void>[] = [
    loadPreviewScript(
      TAILWIND_PREVIEW_URL,
      "tailwind",
      "Tailwind preview runtime could not be loaded; using unstyled semantic HTML.",
    ),
    loadPreviewYup(browser),
  ];

  if (!browser.Formik) {
    loaders.push(loadPreviewScript(
      FORMIK_PREVIEW_URL,
      "formik",
      "Formik preview runtime could not be loaded; using semantic form fallback.",
    ));
  }

  await Promise.all(loaders);
}

async function bootstrap() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root mount point");

  await loadPreviewUi();
  hydrateRoot(root, <StrictMode><App initialPath={window.location.pathname} /></StrictMode>);
}

void bootstrap();
