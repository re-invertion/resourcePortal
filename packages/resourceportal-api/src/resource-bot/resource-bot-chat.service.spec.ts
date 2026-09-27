import { describe, expect, it, vi } from "vitest";
import { ResourceBotChatService } from "./resource-bot-chat.service";

function actor() {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    email: "user@example.test",
    displayName: "User",
    status: "Active",
  } as const;
}

describe("ResourceBotChatService", () => {
  it("returns backend-mapped Help sources and settled usage", async () => {
    const settings = { assertEnabled: vi.fn().mockResolvedValue(undefined) };
    const platform = {
      getRuntimeConfiguration: vi.fn().mockResolvedValue({
        apiKey: "secret",
        generationModel: "gpt-5.6-luna",
        embeddingModel: "text-embedding-3-small",
      }),
    };
    const retrieval = {
      retrieve: vi.fn().mockResolvedValue({
        embeddingInputTokens: 12,
        sources: [
        {
          chunkId: "chunk-1",
          sectionId: "billing",
          title: "Credits, usage and vouchers",
          anchor: "billing",
          text: "Billing Help.",
        },
      ],
      }),
    };
    const provider = {
      answer: vi.fn().mockResolvedValue({
        answer: "Use the Billing page.",
        supportedByHelp: true,
        sourceChunkIds: ["chunk-1"],
        providerRequestId: "resp_1",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
          totalTokens: 130,
        },
      }),
    };
    const billing = {
      reserve: vi.fn().mockResolvedValue({ duplicate: false, reservationId: "r" }),
      settle: vi.fn().mockResolvedValue({
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        embeddingInputTokens: 12,
        totalTokens: 142,
        chargedCredits: "0.01",
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const rateLimit = {
      consumeWithPolicy: vi.fn().mockResolvedValue({
        allowed: true,
        retryAfterSeconds: 1,
      }),
    };

    const observability = {
      recordResourceBotDuration: vi.fn(),
      recordResourceBotUsage: vi.fn(),
      recordResourceBotRequest: vi.fn(),
    };
    const service = new ResourceBotChatService(
      settings as never,
      platform as never,
      retrieval as never,
      provider as never,
      billing as never,
      rateLimit as never,
      observability as never,
    );
    const result = await service.answer(
      "00000000-0000-4000-8000-000000000201",
      { question: "Jak działa billing?", history: [] },
      actor(),
    );

    expect(result.supportedByHelp).toBe(true);
    expect(result.sources).toEqual([
      {
        chunkId: "chunk-1",
        sectionId: "billing",
        title: "Credits, usage and vouchers",
        href:
          "/tenants/00000000-0000-4000-8000-000000000201/help#billing",
      },
    ]);
    expect(result.usage.chargedCredits).toBe("0.01");
    expect(billing.settle).toHaveBeenCalledOnce();
  });

  it("releases a reservation when provider generation fails", async () => {
    const billing = {
      reserve: vi.fn().mockResolvedValue({ duplicate: false, reservationId: "r" }),
      settle: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const service = new ResourceBotChatService(
      { assertEnabled: vi.fn() } as never,
      {
        getRuntimeConfiguration: vi.fn().mockResolvedValue({
          apiKey: "secret",
          generationModel: "gpt-5.6-luna",
          embeddingModel: "text-embedding-3-small",
        }),
      } as never,
      {
        retrieve: vi.fn().mockResolvedValue({
          embeddingInputTokens: 7,
          sources: [
            {
              chunkId: "chunk-1",
              sectionId: "help",
              title: "Help",
              anchor: "getting-started",
              text: "Help text",
            },
          ],
        }),
      } as never,
      { answer: vi.fn().mockRejectedValue(new Error("provider failed")) } as never,
      billing as never,
      {
        consumeWithPolicy: vi.fn().mockResolvedValue({
          allowed: true,
          retryAfterSeconds: 1,
        }),
      } as never,
      {
        recordResourceBotDuration: vi.fn(),
        recordResourceBotUsage: vi.fn(),
        recordResourceBotRequest: vi.fn(),
      } as never,
    );

    await expect(
      service.answer(
        "00000000-0000-4000-8000-000000000201",
        { question: "Question", history: [] },
        actor(),
      ),
    ).rejects.toThrow("provider failed");
    expect(billing.release).toHaveBeenCalledOnce();
    expect(billing.settle).not.toHaveBeenCalled();
  });
});
