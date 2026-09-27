import {
  HELP_CORPUS_REVISION,
  HELP_SECTIONS,
} from "@resource-portal/help";

export type ResourceBotHelpChunk = {
  chunkId: string;
  sectionId: string;
  title: string;
  anchor: string;
  text: string;
};

const TARGET_CHUNK_CHARS = 1_100;

export function buildResourceBotHelpChunks(): ResourceBotHelpChunk[] {
  return HELP_SECTIONS.flatMap((section) => {
    const text = [section.description, section.body].filter(Boolean).join(" ");
    const pieces = splitSentences(text);
    const chunks: string[] = [];
    let current = "";

    for (const piece of pieces) {
      if (!piece) continue;
      if (current && current.length + piece.length + 1 > TARGET_CHUNK_CHARS) {
        chunks.push(current.trim());
        current = "";
      }
      current = current ? `${current} ${piece}` : piece;
    }
    if (current.trim()) chunks.push(current.trim());

    return chunks.map((chunk, index) => ({
      chunkId: `${HELP_CORPUS_REVISION.slice(0, 12)}:${section.id}:${index + 1}`,
      sectionId: section.id,
      title: section.title,
      anchor: section.id,
      text: chunk,
    }));
  });
}

export function resourceBotCorpusHash() {
  return HELP_CORPUS_REVISION;
}

function splitSentences(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/g)
    .map((part) => part.trim())
    .filter(Boolean);
}
