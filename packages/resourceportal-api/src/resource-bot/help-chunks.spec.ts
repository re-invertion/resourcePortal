import { describe, expect, it } from "vitest";
import { buildResourceBotHelpChunks, resourceBotCorpusHash } from "./help-chunks";
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
} from "./resource-bot-retrieval.service";

describe("ResourceBot Help corpus", () => {
  it("builds stable bounded chunks for every Help section", () => {
    const chunks = buildResourceBotHelpChunks();
    expect(chunks.length).toBeGreaterThanOrEqual(14);
    expect(new Set(chunks.map((chunk) => chunk.chunkId)).size).toBe(chunks.length);
    expect(chunks.every((chunk) => chunk.text.length > 40)).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length < 1_800)).toBe(true);
    expect(resourceBotCorpusHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(chunks.some((chunk) => chunk.sectionId === "billing")).toBe(true);
    expect(chunks.some((chunk) => chunk.sectionId === "tenant-mcp")).toBe(true);
  });

  it("round-trips float embeddings and computes cosine similarity", () => {
    const source = [0.125, -0.25, 0.75, 0.5];
    expect(decodeVector(encodeVector(source))).toEqual(source);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
});
