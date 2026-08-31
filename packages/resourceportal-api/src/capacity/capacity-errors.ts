import {
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";

export const INSUFFICIENT_CAPACITY = "InsufficientCapacity" as const;
export const PLATFORM_UNAVAILABLE = "PlatformUnavailable" as const;

export function insufficientCapacityException(message: string) {
  return new ConflictException({
    code: INSUFFICIENT_CAPACITY,
    message,
  });
}

export function platformUnavailableException(message: string) {
  return new ServiceUnavailableException({
    code: PLATFORM_UNAVAILABLE,
    message,
  });
}
