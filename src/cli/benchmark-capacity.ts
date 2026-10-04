import { runCapacityBenchmark } from "../capacity.js";

function numberArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

const result = await runCapacityBenchmark({
  users: numberArg("--users"),
  chunks: numberArg("--chunks"),
  searchesPerUser: numberArg("--searches"),
  writesPerUser: numberArg("--writes")
});

console.log(JSON.stringify(result, null, 2));
if (result.writeErrors > 0 || result.persistedWrites !== result.totalWrites) {
  process.exitCode = 1;
}
