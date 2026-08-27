export function getDockerImageHost(image: string) {
  const [firstPart, ...rest] = image.split("/");

  if (
    rest.length === 0 ||
    !firstPart ||
    (!firstPart.includes(".") &&
      !firstPart.includes(":") &&
      firstPart !== "localhost")
  ) {
    return "docker.io";
  }

  return firstPart.toLowerCase();
}
