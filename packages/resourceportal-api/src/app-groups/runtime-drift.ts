export type ExpectedRuntimeService = {
  name: string;
  image: string;
  desiredReplicas: number;
};

export type ObservedRuntimeService = {
  name: string;
  image: string;
  desiredReplicas: number;
};

export type AppGroupDriftStatus = "InSync" | "Drifted" | "Unknown";

export function deriveAppGroupDriftStatus(
  expected: ExpectedRuntimeService[],
  observed: ObservedRuntimeService[] | null,
): AppGroupDriftStatus {
  if (observed === null) {
    return "Unknown";
  }

  if (expected.length !== observed.length) {
    return "Drifted";
  }

  const observedByName = new Map(
    observed.map((service) => [service.name, service]),
  );

  for (const expectedService of expected) {
    const actual = observedByName.get(expectedService.name);

    if (!actual) {
      return "Drifted";
    }

    if (
      normalizeImage(actual.image) !== normalizeImage(expectedService.image) ||
      actual.desiredReplicas !== expectedService.desiredReplicas
    ) {
      return "Drifted";
    }
  }

  return "InSync";
}

function normalizeImage(image: string) {
  return image.replace(/@sha256:[a-f0-9]+$/i, "");
}
