export type ResourceBotProviderConfiguration = {
  apiKey: string;
  generationModel: string;
  embeddingModel: string;
};

export type ResourceBotEmbeddingResult = {
  vectors: number[][];
  inputTokens: number;
};

export type ResourceBotGroundingSource = {
  chunkId: string;
  sectionId: string;
  title: string;
  anchor: string;
  text: string;
};

export type ResourceBotAnswerInput = {
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  sources: ResourceBotGroundingSource[];
};

export type ResourceBotAnswerResult = {
  answer: string;
  supportedByHelp: boolean;
  sourceChunkIds: string[];
  providerRequestId?: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export interface ResourceBotProvider {
  validateCredential(configuration: ResourceBotProviderConfiguration): Promise<void>;
  embed(
    configuration: ResourceBotProviderConfiguration,
    texts: string[],
  ): Promise<ResourceBotEmbeddingResult>;
  answer(
    configuration: ResourceBotProviderConfiguration,
    input: ResourceBotAnswerInput,
  ): Promise<ResourceBotAnswerResult>;
}
