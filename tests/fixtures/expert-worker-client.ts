import { ExpertWorkerClient } from "../../src/expert-platform/grpc-transport.js";

const [address, workerId, capability, credential] = process.argv.slice(2);
if (!address || !workerId || !capability || !credential) process.exit(2);

const client = new ExpertWorkerClient(address, { workerId, credential });
try {
  const claim = await client.claimTask(workerId, capability);
  if (!claim) process.exitCode = 3;
  else {
    await client.renewLease(claim);
    await client.completeTask(claim, "completed by separate worker process");
  }
} finally {
  client.close();
}
