import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim, ExpertTaskStore } from "./task-store.js";
import type { PersistentWorkerRegistry } from "./persistent-worker-registry.js";
import type { ExpertStore } from "./expert-store.js";

interface RegisterWorkerRequest {
  worker_id: string;
  capabilities: string[];
  proposed_credential: string;
}
interface RegisterWorkerResponse {
  status: string;
  credential?: string;
}
interface ClaimTaskRequest {
  worker_id: string;
  capability: string;
  expert_id: string;
}
interface ClaimTaskResponse {
  has_task: boolean;
  task_id?: string;
  run_id?: string;
  fencing?: string;
  problem?: string;
  repository_id?: string;
  repository_url?: string;
  repository_branch?: string;
  repository_credential_ref?: string;
  repository_git_proxy_url?: string;
  model_config_json?: string;
}
interface LeaseRequest {
  worker_id: string;
  task_id: string;
  run_id: string;
  fencing: string;
}
interface CompleteTaskRequest {
  claim?: LeaseRequest;
  result: string;
  repository_url?: string;
  repository_branch?: string;
  commit_sha?: string;
}
interface FailTaskRequest {
  claim?: LeaseRequest;
  reason: string;
}
interface TaskStageRequest {
  claim?: LeaseRequest;
  stage: string;
  details: string;
  source_sequence?: string;
  tool_code?: string;
  count?: number;
}
interface Empty {}
interface LeaseResponse {
  cancellation_requested: boolean;
}

type UnaryHandler<Request, Response> = (
  call: grpc.ServerUnaryCall<Request, Response>,
  callback: grpc.sendUnaryData<Response>,
) => void;

interface WorkerServiceClient extends grpc.Client {
  RegisterWorker(
    request: RegisterWorkerRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: RegisterWorkerResponse) => void,
  ): grpc.ClientUnaryCall;
  ClaimTask(
    request: ClaimTaskRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ClaimTaskResponse) => void,
  ): grpc.ClientUnaryCall;
  RenewLease(
    request: LeaseRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: LeaseResponse) => void,
  ): grpc.ClientUnaryCall;
  CompleteTask(
    request: CompleteTaskRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: Empty) => void,
  ): grpc.ClientUnaryCall;
  ReportTaskStage(
    request: TaskStageRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: Empty) => void,
  ): grpc.ClientUnaryCall;
  FailTask(
    request: FailTaskRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: Empty) => void,
  ): grpc.ClientUnaryCall;
}

type WorkerServiceClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => WorkerServiceClient;

interface WorkerProto {
  expert: {
    v1: {
      ExpertWorkerService: WorkerServiceClientConstructor & {
        service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
      };
    };
  };
}

function loadWorkerProto(): WorkerProto {
  const bundledProto = path.join(path.dirname(fileURLToPath(import.meta.url)), "proto/expert-worker.proto");
  const sourceTreeProto = path.resolve("src/expert-platform/proto/expert-worker.proto");
  const definition = protoLoader.loadSync(existsSync(bundledProto) ? bundledProto : sourceTreeProto, {
    defaults: true,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(definition) as unknown as WorkerProto;
}

function toClaim(request: LeaseRequest): Claim {
  const fencing = Number(request.fencing);
  if (!request.worker_id || !request.task_id || !request.run_id || !Number.isSafeInteger(fencing) || fencing < 1) {
    throw new Error("INVALID_CLAIM");
  }
  return {
    workerId: request.worker_id,
    taskId: request.task_id,
    runId: request.run_id,
    fencing,
    problem: "",
  };
}

function grpcError(code: grpc.status, message: string): grpc.ServiceError {
  return Object.assign(new Error(message), { code, details: message, metadata: new grpc.Metadata() });
}

function requireAuthorized(workers: PersistentWorkerRegistry, workerId: string, capability: string): void {
  if (!workers.isAuthorized(workerId, capability)) {
    throw grpcError(grpc.status.PERMISSION_DENIED, "WORKER_FORBIDDEN");
  }
}

function authenticatedWorkerId(workers: PersistentWorkerRegistry, metadata: grpc.Metadata): string {
  const workerId = String(metadata.get("x-expert-worker-id")[0] ?? "");
  const authorization = String(metadata.get("authorization")[0] ?? "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!workerId || !token || !workers.authenticate(workerId, token)) {
    throw grpcError(grpc.status.UNAUTHENTICATED, "WORKER_UNAUTHENTICATED");
  }
  return workerId;
}

function requireIdentityMatch(authenticatedId: string, requestedId: string): void {
  if (authenticatedId !== requestedId) {
    throw grpcError(grpc.status.PERMISSION_DENIED, "WORKER_IDENTITY_MISMATCH");
  }
}

export interface GrpcTlsServerConfig {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  requireClientCertificate?: boolean;
}

export interface GrpcTlsClientConfig {
  ca: Buffer;
  cert?: Buffer;
  key?: Buffer;
}

export interface GrpcServerOptions {
  tls?: GrpcTlsServerConfig;
  experts?: ExpertStore;
  bootstrapToken?: string;
  bootstrapAutoApprove?: boolean;
  bootstrapAllowedCapabilities?: readonly string[];
}

export interface GrpcClientOptions {
  tls?: GrpcTlsClientConfig;
}

export async function startExpertWorkerGrpcServer(
  tasks: ExpertTaskStore,
  workers: PersistentWorkerRegistry,
  address: string,
  options: GrpcServerOptions = {},
): Promise<{ address: string; close(): Promise<void> }> {
  const proto = loadWorkerProto();
  const server = new grpc.Server();

  const registerWorker: UnaryHandler<RegisterWorkerRequest, RegisterWorkerResponse> = (call, callback) => {
    try {
      const configuredToken = options.bootstrapToken ?? "";
      const authorization = String(call.metadata.get("authorization")[0] ?? "");
      const suppliedToken = authorization.startsWith("Bootstrap ") ? authorization.slice(10) : "";
      const supplied = Buffer.from(suppliedToken);
      const expected = Buffer.from(configuredToken);
      if (!configuredToken || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw grpcError(grpc.status.UNAUTHENTICATED, "WORKER_BOOTSTRAP_UNAUTHENTICATED");
      }
      const result = workers.bootstrapRegister(
        call.request.worker_id,
        call.request.capabilities,
        call.request.proposed_credential,
        options.bootstrapAutoApprove ?? false,
        options.bootstrapAllowedCapabilities ?? [],
      );
      callback(null, {
        status: result.worker.status,
        ...(result.credential ? { credential: result.credential } : {}),
      });
    } catch (error) {
      const code =
        error instanceof Error && error.message === "WORKER_BOOTSTRAP_UNAUTHENTICATED"
          ? grpc.status.UNAUTHENTICATED
          : error instanceof Error && error.message === "WORKER_REVOKED"
            ? grpc.status.PERMISSION_DENIED
            : error instanceof Error && error.message === "WORKER_CREDENTIAL_ALREADY_ISSUED"
              ? grpc.status.ALREADY_EXISTS
              : error instanceof Error &&
                  ["INVALID_WORKER", "WORKER_CAPABILITY_NOT_ALLOWED", "WORKER_CONFIGURATION_MISMATCH"].includes(
                    error.message,
                  )
                ? grpc.status.INVALID_ARGUMENT
                : grpc.status.INTERNAL;
      callback(grpcError(code, error instanceof Error ? error.message : "WORKER_BOOTSTRAP_FAILED"), null);
    }
  };

  const claimTask: UnaryHandler<ClaimTaskRequest, ClaimTaskResponse> = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      requireAuthorized(workers, call.request.worker_id, call.request.capability);
      if (!call.request.expert_id) throw new Error("INVALID_REQUEST");
      let modelConfigJson = "";
      if (options.experts) {
        let definition;
        try {
          definition = options.experts.getDefinition(call.request.expert_id);
        } catch (error) {
          if (error instanceof Error && error.message === "EXPERT_NOT_FOUND") {
            throw grpcError(grpc.status.PERMISSION_DENIED, "EXPERT_NOT_FOUND");
          }
          throw error;
        }
        if (!definition.active) throw grpcError(grpc.status.PERMISSION_DENIED, "EXPERT_INACTIVE");
        modelConfigJson = definition.modelConfig ? JSON.stringify(definition.modelConfig) : "";
        if (!definition.capabilities.includes(call.request.capability)) {
          throw grpcError(grpc.status.PERMISSION_DENIED, "WORKER_EXPERT_CAPABILITY_MISMATCH");
        }
      }
      const claim = tasks.claim(call.request.worker_id, Date.now(), 30_000, call.request.expert_id);
      callback(
        null,
        claim
          ? (() => {
              const repository =
                claim.repositoryId && options.experts
                  ? options.experts
                      .listDeployments()
                      .flatMap((deployment) => deployment.repositories ?? [])
                      .find((item) => item.id === claim.repositoryId)
                  : undefined;
              return {
                has_task: true,
                task_id: claim.taskId,
                run_id: claim.runId,
                fencing: String(claim.fencing),
                problem: claim.problem,
                repository_id: claim.repositoryId ?? "",
                repository_url: repository?.url ?? "",
                repository_branch: repository?.branch ?? "",
                repository_credential_ref: repository?.credentialRef ?? "",
                repository_git_proxy_url: repository?.gitProxyUrl ?? "",
                model_config_json: modelConfigJson,
              };
            })()
          : { has_task: false },
      );
    } catch (error) {
      callback(
        error instanceof Error && "code" in error
          ? (error as grpc.ServiceError)
          : grpcError(grpc.status.INTERNAL, "CLAIM_FAILED"),
        null,
      );
    }
  };

  const renewLease: UnaryHandler<LeaseRequest, Empty> = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      const claim = toClaim(call.request);
      const worker = workers.get(claim.workerId);
      if (worker.status !== "active") throw grpcError(grpc.status.PERMISSION_DENIED, "WORKER_FORBIDDEN");
      const cancellationRequested = tasks.renew(claim);
      callback(null, { cancellation_requested: cancellationRequested });
    } catch (error) {
      callback(
        error instanceof Error && "code" in error
          ? (error as grpc.ServiceError)
          : grpcError(grpc.status.FAILED_PRECONDITION, error instanceof Error ? error.message : "LEASE_FAILED"),
        null,
      );
    }
  };

  const completeTask: UnaryHandler<CompleteTaskRequest, Empty> = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      if (!call.request.claim || !call.request.result.trim()) throw new Error("INVALID_REQUEST");
      requireIdentityMatch(authenticatedId, call.request.claim.worker_id);
      const claim = toClaim(call.request.claim);
      const worker = workers.get(claim.workerId);
      if (worker.status !== "active") throw grpcError(grpc.status.PERMISSION_DENIED, "WORKER_FORBIDDEN");
      const source = {
        ...(call.request.repository_url ? { repositoryUrl: call.request.repository_url } : {}),
        ...(call.request.repository_branch ? { repositoryBranch: call.request.repository_branch } : {}),
        ...(call.request.commit_sha ? { commitSha: call.request.commit_sha } : {}),
      };
      tasks.complete(claim, call.request.result, Date.now(), Object.keys(source).length ? source : undefined);
      callback(null, {});
    } catch (error) {
      callback(
        error instanceof Error && "code" in error
          ? (error as grpc.ServiceError)
          : grpcError(grpc.status.FAILED_PRECONDITION, error instanceof Error ? error.message : "COMPLETE_FAILED"),
        null,
      );
    }
  };

  const failTask: UnaryHandler<FailTaskRequest, Empty> = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      if (!call.request.claim || !call.request.reason.trim()) throw new Error("INVALID_REQUEST");
      requireIdentityMatch(authenticatedId, call.request.claim.worker_id);
      const claim = toClaim(call.request.claim);
      const worker = workers.get(claim.workerId);
      if (worker.status !== "active") throw grpcError(grpc.status.PERMISSION_DENIED, "WORKER_FORBIDDEN");
      tasks.fail(claim, call.request.reason);
      callback(null, {});
    } catch (error) {
      callback(
        error instanceof Error && "code" in error
          ? (error as grpc.ServiceError)
          : grpcError(grpc.status.FAILED_PRECONDITION, error instanceof Error ? error.message : "FAIL_FAILED"),
        null,
      );
    }
  };

  const reportTaskStage: UnaryHandler<TaskStageRequest, Empty> = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      if (!call.request.claim) throw new Error("INVALID_REQUEST");
      requireIdentityMatch(authenticatedId, call.request.claim.worker_id);
      const claim = toClaim(call.request.claim);
      if (workers.get(claim.workerId).status !== "active") throw new Error("WORKER_FORBIDDEN");
      if (call.request.source_sequence && call.request.source_sequence !== "0") {
        const sequence = Number(call.request.source_sequence);
        tasks.recordActivity(
          claim,
          call.request.stage,
          sequence,
          call.request.tool_code || "",
          call.request.count || 0,
        );
      } else tasks.recordStage(claim, call.request.stage, call.request.details || "");
      callback(null, {});
    } catch (error) {
      callback(
        grpcError(grpc.status.FAILED_PRECONDITION, error instanceof Error ? error.message : "STAGE_FAILED"),
        null,
      );
    }
  };

  server.addService(proto.expert.v1.ExpertWorkerService.service, {
    RegisterWorker: registerWorker,
    ClaimTask: claimTask,
    RenewLease: renewLease,
    CompleteTask: completeTask,
    FailTask: failTask,
    ReportTaskStage: reportTaskStage,
  });

  const serverCredentials = options.tls
    ? grpc.ServerCredentials.createSsl(
        options.tls.ca,
        [{ private_key: options.tls.key, cert_chain: options.tls.cert }],
        options.tls.requireClientCertificate ?? true,
      )
    : grpc.ServerCredentials.createInsecure();
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(address, serverCredentials, (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });
  const host = address.slice(0, address.lastIndexOf(":"));
  return {
    address: `${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.tryShutdown((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function unary<Response>(
  invoke: (callback: (error: grpc.ServiceError | null, response: Response) => void) => grpc.ClientUnaryCall,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    invoke((error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function parseClaimModelConfig(value: string) {
  try {
    const config = JSON.parse(value) as {
      providerId?: unknown;
      model?: unknown;
      baseUrl?: unknown;
      wireApi?: unknown;
      credentialRef?: unknown;
      allowedEnvNames?: unknown;
    };
    if (
      typeof config.providerId !== "string" ||
      typeof config.model !== "string" ||
      typeof config.baseUrl !== "string" ||
      (config.wireApi !== "responses" && config.wireApi !== "anthropic-messages") ||
      !Array.isArray(config.allowedEnvNames) ||
      config.allowedEnvNames.some((name) => typeof name !== "string")
    )
      throw new Error();
    if (config.credentialRef !== undefined && typeof config.credentialRef !== "string") throw new Error();
    return config as import("./expert-store.js").ExpertModelConfig;
  } catch {
    throw new Error("INVALID_CLAIM_MODEL_CONFIG");
  }
}

export async function requestWorkerBootstrap(
  address: string,
  bootstrapToken: string,
  workerId: string,
  capabilities: string[],
  proposedCredential: string,
  options: GrpcClientOptions = {},
): Promise<RegisterWorkerResponse> {
  const proto = loadWorkerProto();
  if ((options.tls?.cert && !options.tls.key) || (options.tls?.key && !options.tls.cert)) {
    throw new Error("INVALID_TLS_CLIENT_CONFIG");
  }
  const credentials = options.tls
    ? grpc.credentials.createSsl(options.tls.ca, options.tls.key, options.tls.cert)
    : grpc.credentials.createInsecure();
  const client = new proto.expert.v1.ExpertWorkerService(address, credentials);
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bootstrap ${bootstrapToken}`);
  try {
    return await unary<RegisterWorkerResponse>((callback) =>
      client.RegisterWorker(
        { worker_id: workerId, capabilities, proposed_credential: proposedCredential },
        metadata,
        callback,
      ),
    );
  } finally {
    client.close();
  }
}

export class ExpertWorkerClient {
  private readonly client: WorkerServiceClient;
  private readonly metadata: grpc.Metadata;

  constructor(address: string, identity: { workerId: string; credential: string }, options: GrpcClientOptions = {}) {
    const proto = loadWorkerProto();
    if ((options.tls?.cert && !options.tls.key) || (options.tls?.key && !options.tls.cert)) {
      throw new Error("INVALID_TLS_CLIENT_CONFIG");
    }
    const credentials = options.tls
      ? grpc.credentials.createSsl(options.tls.ca, options.tls.key, options.tls.cert)
      : grpc.credentials.createInsecure();
    this.client = new proto.expert.v1.ExpertWorkerService(address, credentials);
    this.metadata = new grpc.Metadata();
    this.metadata.set("x-expert-worker-id", identity.workerId);
    this.metadata.set("authorization", `Bearer ${identity.credential}`);
  }

  async claimTask(workerId: string, expertId: string, capability = expertId): Promise<Claim | null> {
    const response = await unary<ClaimTaskResponse>((callback) =>
      this.client.ClaimTask({ worker_id: workerId, capability, expert_id: expertId }, this.metadata, callback),
    );
    if (!response.has_task) return null;
    const fencing = Number(response.fencing);
    if (!response.task_id || !response.run_id || !response.problem || !Number.isSafeInteger(fencing)) {
      throw new Error("INVALID_CLAIM_RESPONSE");
    }
    return {
      workerId,
      taskId: response.task_id,
      runId: response.run_id,
      fencing,
      problem: response.problem,
      repositoryId: response.repository_id || null,
      ...(response.repository_url ? { repositoryUrl: response.repository_url } : {}),
      ...(response.repository_branch ? { repositoryBranch: response.repository_branch } : {}),
      ...(response.repository_credential_ref ? { repositoryCredentialRef: response.repository_credential_ref } : {}),
      ...(response.repository_git_proxy_url ? { repositoryGitProxyUrl: response.repository_git_proxy_url } : {}),
      ...(response.model_config_json ? { modelConfig: parseClaimModelConfig(response.model_config_json) } : {}),
    };
  }

  renewLease(claim: Claim): Promise<LeaseResponse> {
    return unary((callback) => this.client.RenewLease(this.claimRequest(claim), this.metadata, callback));
  }

  completeTask(
    claim: Claim,
    result: string,
    source?: { repositoryUrl?: string; repositoryBranch?: string; commitSha?: string },
  ): Promise<Empty> {
    return unary((callback) =>
      this.client.CompleteTask(
        {
          claim: this.claimRequest(claim),
          result,
          repository_url: source?.repositoryUrl ?? "",
          repository_branch: source?.repositoryBranch ?? "",
          commit_sha: source?.commitSha ?? "",
        },
        this.metadata,
        callback,
      ),
    );
  }

  reportTaskStage(
    claim: Claim,
    stage: string,
    details = "",
    activity?: { sequence: number; tool?: string; count?: number },
  ): Promise<Empty> {
    return unary((callback) =>
      this.client.ReportTaskStage(
        {
          claim: this.claimRequest(claim),
          stage,
          details,
          ...(activity
            ? { source_sequence: String(activity.sequence), tool_code: activity.tool ?? "", count: activity.count ?? 0 }
            : {}),
        },
        this.metadata,
        { deadline: Date.now() + 2_000 },
        callback,
      ),
    );
  }

  failTask(claim: Claim, reason: string): Promise<Empty> {
    return unary((callback) =>
      this.client.FailTask({ claim: this.claimRequest(claim), reason }, this.metadata, callback),
    );
  }

  close(): void {
    this.client.close();
  }

  private claimRequest(claim: Claim): LeaseRequest {
    return {
      worker_id: claim.workerId,
      task_id: claim.taskId,
      run_id: claim.runId,
      fencing: String(claim.fencing),
    };
  }
}
