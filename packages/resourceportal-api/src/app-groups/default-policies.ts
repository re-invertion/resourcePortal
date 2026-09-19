import { Prisma } from "@prisma/client";

export const DEFAULT_RESTART_POLICY = {
  condition: "any",
  delaySeconds: 5,
} satisfies Prisma.InputJsonObject;

export const DEFAULT_UPDATE_POLICY = {
  parallelism: 1,
  delaySeconds: 10,
  order: "start-first",
} satisfies Prisma.InputJsonObject;
