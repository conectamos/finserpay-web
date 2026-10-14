import path from "node:path";

export function runnerBuilderCopies(dockerfile) {
  const runner = dockerfile.split(/^FROM .* AS runner\s*$/im)[1];
  if (!runner) throw new Error("Dockerfile must define its production runner stage");
  const instructions = runner.replace(/\\\r?\n[ \t]*/g, " ");
  return [...instructions.matchAll(/^COPY\s+--from=builder\s+([^\r\n]+)$/gm)]
    .flatMap(([, argumentsText]) => {
      const argumentsList = argumentsText.trim().startsWith("[")
        ? JSON.parse(argumentsText)
        : argumentsText.trim().split(/\s+/);
      if (argumentsList.length < 2) throw new Error("COPY needs a source and a destination");
      const destination = argumentsList.at(-1);
      const sources = argumentsList.slice(0, -1);
      if (sources.length > 1 && !destination.endsWith("/")) {
        throw new Error("A multi-source COPY needs a trailing-slash directory destination");
      }
      const normalize = value => path.posix.normalize(value.startsWith("/app/")
        ? value.slice("/app/".length)
        : value);
      return sources.map(source => ({
        source: normalize(source),
        destination: normalize(destination),
        directoryDestination: destination.endsWith("/"),
        multipleSources: sources.length > 1,
      }));
    });
}

export function runnerPackagesFile(dockerfile, file) {
  return runnerBuilderCopies(dockerfile).some(({ source, destination, directoryDestination, multipleSources }) => {
    if (file === source) {
      const resolvedDestination = directoryDestination || multipleSources
        ? path.posix.join(destination, path.posix.basename(source))
        : destination;
      return resolvedDestination === file;
    }
    return !multipleSources && file.startsWith(source.replace(/\/$/, "") + "/") &&
      path.posix.join(destination, path.posix.relative(source, file)) === file;
  });
}
