export function getDockerImageHost(image: string) {
  const firstPart = image.split("/")[0];

  if (
    !firstPart ||
    (!firstPart.includes(".") &&
      !firstPart.includes(":") &&
      firstPart !== "localhost")
  ) {
    return "docker.io";
  }

  return firstPart.toLowerCase();
}
