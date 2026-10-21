import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";
import { ExpertWorkerClient, startExpertWorkerGrpcServer } from "../src/expert-platform/grpc-transport.js";

function createCertificates(dir: string) {
  const caKey = path.join(dir, "ca.key");
  const caCert = path.join(dir, "ca.crt");
  const serverKey = path.join(dir, "server.key");
  const serverCsr = path.join(dir, "server.csr");
  const serverCert = path.join(dir, "server.crt");
  const clientKey = path.join(dir, "client.key");
  const clientCsr = path.join(dir, "client.csr");
  const clientCert = path.join(dir, "client.crt");
  const ext = path.join(dir, "server.ext");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-subj",
      "/CN=Expert Test CA",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-subj", "/CN=localhost"],
    { stdio: "ignore" },
  );
  writeFileSync(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      serverCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverCert,
      "-days",
      "1",
      "-extfile",
      ext,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", clientKey, "-out", clientCsr, "-subj", "/CN=worker-1"],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      clientCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      clientCert,
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  return {
    ca: readFileSync(caCert),
    serverKey: readFileSync(serverKey),
    serverCert: readFileSync(serverCert),
    clientKey: readFileSync(clientKey),
    clientCert: readFileSync(clientCert),
  };
}

test("mTLS allows trusted worker and rejects client without certificate", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-tls-"));
  const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
  const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
  const certs = createCertificates(dir);
  workers.enroll("worker-1", ["ota"]);
  workers.approve("worker-1");
  const token = workers.issueCredential("worker-1");
  tasks.submit({ principalId: "alice", scope: "org", idempotencyKey: "tls", problem: "OTA failure", expertId: "ota" });

  const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0", {
    tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey, requireClientCertificate: true },
  });
  try {
    const trusted = new ExpertWorkerClient(
      server.address,
      { workerId: "worker-1", credential: token },
      { tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey } },
    );
    assert.ok(await trusted.claimTask("worker-1", "ota"));
    trusted.close();

    const untrusted = new ExpertWorkerClient(
      server.address,
      { workerId: "worker-1", credential: token },
      { tls: { ca: certs.ca } },
    );
    await assert.rejects(() => untrusted.claimTask("worker-1", "ota"));
    untrusted.close();
  } finally {
    await server.close();
    tasks.close();
    workers.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
