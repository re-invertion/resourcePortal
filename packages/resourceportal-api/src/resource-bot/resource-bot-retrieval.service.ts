import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OpenAiResourceBotProvider } from "./openai-resource-bot.provider";
import {
  buildResourceBotHelpChunks,
  resourceBotCorpusHash,
} from "./help-chunks";
import type {
  ResourceBotGroundingSource,
  ResourceBotProviderConfiguration,
} from "./resource-bot-provider";

const EMBEDDING_BATCH_SIZE = 32;
const DEFAULT_LIMIT = 5;
const MIN_SCORE = 0.18;

@Injectable()
export class ResourceBotRetrievalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: OpenAiResourceBotProvider,
  ) {}

  async retrieve(
    question: string,
    configuration: ResourceBotProviderConfiguration,
    limit = DEFAULT_LIMIT,
  ): Promise<{
    sources: ResourceBotGroundingSource[];
    embeddingInputTokens: number;
  }> {
    await this.ensureIndex(configuration);
    const queryEmbedding = await this.provider.embed(configuration, [question]);
    const queryVector = queryEmbedding.vectors[0];
    if (!queryVector?.length) {
      return {
        sources: [],
        embeddingInputTokens: queryEmbedding.inputTokens,
      };
    }

    const rows = await this.prisma.resourceBotKnowledgeEmbedding.findMany({
      where: {
        corpusHash: resourceBotCorpusHash(),
        embeddingModel: configuration.embeddingModel,
      },
      orderBy: { chunkId: "asc" },
    });

    const sources = rows
      .map((row) => {
        const vector = decodeVector(row.vector);
        const semantic = cosineSimilarity(queryVector, vector);
        const lexical = lexicalBonus(question, `${row.title} ${row.text}`);
        return { row, score: semantic + lexical };
      })
      .filter(({ score }) => Number.isFinite(score) && score >= MIN_SCORE)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(limit, 8)))
      .map(({ row }) => ({
        chunkId: row.chunkId,
        sectionId: row.sectionId,
        title: row.title,
        anchor: row.anchor,
        text: row.text,
      }));

    return {
      sources,
      embeddingInputTokens: queryEmbedding.inputTokens,
    };
  }

  async ensureIndex(configuration: ResourceBotProviderConfiguration) {
    const corpusHash = resourceBotCorpusHash();
    const chunks = buildResourceBotHelpChunks();
    const existing = await this.prisma.resourceBotKnowledgeEmbedding.findMany({
      where: {
        corpusHash,
        embeddingModel: configuration.embeddingModel,
      },
      select: { chunkId: true },
    });
    const existingIds = new Set(existing.map((row) => row.chunkId));
    const missing = chunks.filter((chunk) => !existingIds.has(chunk.chunkId));
    if (missing.length === 0) return;

    for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const embedded = await this.provider.embed(
        configuration,
        batch.map((chunk) => chunk.text),
      );
      if (embedded.vectors.length !== batch.length) {
        throw new Error("ResourceBot embedding provider returned an unexpected vector count");
      }

      await this.prisma.resourceBotKnowledgeEmbedding.createMany({
        data: batch.map((chunk, index) => ({
          corpusHash,
          embeddingModel: configuration.embeddingModel,
          chunkId: chunk.chunkId,
          sectionId: chunk.sectionId,
          title: chunk.title,
          anchor: chunk.anchor,
          text: chunk.text,
          vector: encodeVector(embedded.vectors[index] ?? []),
        })),
        skipDuplicates: true,
      });
    }

    await this.prisma.resourceBotKnowledgeEmbedding.deleteMany({
      where: {
        OR: [
          { corpusHash: { not: corpusHash } },
          {
            corpusHash,
            embeddingModel: configuration.embeddingModel,
            chunkId: { notIn: chunks.map((chunk) => chunk.chunkId) },
          },
        ],
      },
    });
  }
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function encodeVector(vector: number[]) {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

export function decodeVector(value: Uint8Array) {
  const buffer = Buffer.from(value);
  const vector: number[] = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    vector.push(buffer.readFloatLE(offset));
  }
  return vector;
}

function lexicalBonus(question: string, haystack: string) {
  const tokens = normalizeTokens(question);
  if (tokens.length === 0) return 0;
  const target = haystack.toLocaleLowerCase("en-US");
  const matches = tokens.filter((token) => target.includes(token)).length;
  return Math.min(0.15, (matches / tokens.length) * 0.12);
}

function normalizeTokens(value: string) {
  const stop = new Set([
    "the", "and", "for", "with", "this", "that", "from",
    "jak", "czy", "jest", "oraz", "dla", "ten", "ta", "to", "się", "sie",
  ]);
  return [...new Set(
    value
      .toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}._-]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !stop.has(token)),
  )];
}
