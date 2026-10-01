import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { apiRequest } from "../api/client";
import { Button, Dialog, Field, Textarea, TextInput } from "./design-system";
import { toast } from "./toast";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function BugReportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [image, setImage] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && typeof window !== "undefined") setUrl(window.location.href);
  }, [open]);

  useEffect(() => {
    if (!image) {
      setPreviewUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(image);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image]);

  function close() {
    if (submitting) return;
    setError(undefined);
    onClose();
  }

  function acceptImage(file: File | undefined) {
    setError(undefined);
    if (!file) {
      setImage(undefined);
      return false;
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setImage(undefined);
      setError("Use a PNG, JPEG, GIF or WebP image.");
      return false;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImage(undefined);
      setError("Image attachments must be 3 MB or smaller.");
      return false;
    }
    setImage(file);
    return true;
  }

  function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const accepted = acceptImage(event.target.files?.[0]);
    if (!accepted) event.target.value = "";
  }

  function pasteImage(event: ClipboardEvent<HTMLFormElement>) {
    const item = Array.from(event.clipboardData.items).find(
      (entry) => entry.kind === "file" && entry.type.startsWith("image/"),
    );
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    acceptImage(file);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanDescription = description.trim();
    if (cleanDescription.length < 5) {
      setError("Describe the problem in at least 5 characters.");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const body: Record<string, unknown> = {
        description: cleanDescription,
        url: url.trim() || undefined,
      };
      if (image) {
        body.imageData = await fileToBase64(image);
        body.imageMimeType = image.type;
        body.imageFileName = image.name || "clipboard-image";
      }
      await apiRequest("/api/bug-reports", { method: "POST", body });
      setDescription("");
      setImage(undefined);
      toast.success(
        "Bug report sent.",
        "The report is now available to Global Admins for triage.",
      );
      onClose();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Bug report could not be sent.";
      setError(message);
      toast.errorFrom(cause, "Bug report could not be sent.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Report a bug"
      description="Describe what went wrong. The current page URL is included automatically, and you can choose or paste a screenshot."
      onClose={close}
      actions={
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            form="bug-report-form"
            disabled={submitting || description.trim().length < 5}
          >
            {submitting ? "Sending…" : "Send report"}
          </Button>
        </>
      }
    >
      <form
        id="bug-report-form"
        className="space-y-5"
        onPaste={pasteImage}
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label="Description"
          required
          hint="Include what you expected, what happened, and any steps that make the issue reproducible."
        >
          <Textarea
            aria-label="Bug description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={4000}
            rows={7}
            placeholder="Example: When I click Deploy in…"
          />
        </Field>
        <Field
          label="URL"
          hint="Prefilled from the page that was open when the report dialog was launched."
        >
          <TextInput
            aria-label="Bug page URL"
            value={url}
            maxLength={2048}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field
          label="Image"
          hint="Optional. Choose a PNG, JPEG, GIF or WebP up to 3 MB, or paste an image from the clipboard with Ctrl/Cmd+V."
        >
          <input
            aria-label="Bug image"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={chooseImage}
            className="block w-full rounded-md border border-[#B9C5D6] bg-white px-3 py-2 text-sm text-[#526070] file:mr-3 file:rounded file:border-0 file:bg-[#E7F1FF] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[#0F56A7]"
          />
        </Field>
        {image && previewUrl ? (
          <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[#5B6678]">
              <span className="truncate" title={image.name}>
                {image.name || "Clipboard image"}
              </span>
              <button
                type="button"
                className="font-semibold text-[#0F56A7] hover:underline"
                onClick={() => setImage(undefined)}
              >
                Remove
              </button>
            </div>
            <img
              src={previewUrl}
              alt="Bug attachment preview"
              className="max-h-48 w-full rounded-md object-contain"
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-[#B42318]">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const separator = value.indexOf(",");
      if (separator < 0) {
        reject(new Error("The image could not be encoded."));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}