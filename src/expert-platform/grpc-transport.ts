import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim, DeploymentTaskSnapshot, ExpertTaskStore } from "./task-store.js";
import type { PersistentWorkerRegistry } from "./persistent-worker-registry.js";
import type { ExpertStore } from "./expert-store.js";
import type { WorkOrchestrationStore } from "./work-orchestration-store.js";
import type {
  PublicationOperationLease,
  PublicationOperationResult,
  WorkPublicationStore,
} from "./work-publication-store.js";
import type {
  ChangeRequestOperationLease,
  ChangeRequestOperationResult,
  WorkChangeRequestStore,
} from "./work-change-request-store.js";
import {
  normalizeVerificationEvidenceResults,
  normalizeVerificationPolicy,
  type VerificationEvidenceResult,
} from "./verification-policy.js";
import { normalizeWorkspaceChangeSummary, type WorkspaceChangeSummary } from "./workspace-change-summary.js";

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
  supported_backend?: string;
  supported_runtime_profiles?: string[];
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
  deployment_snapshot_json?: string;
  workspace_key?: string;
  validation_snapshot_json?: string;
  runtime_session_id?: string;
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
  verification_results_json?: string;
  workspace_change_summary_json?: string;
  runtime_session_id?: string;
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

interface WorkspaceCleanupClaimRequest {
  worker_id: string;
}
interface WorkspaceCleanupClaimResponse {
  has_cleanup: boolean;
  workspace_id?: string;
  workspace_key?: string;
  fencing?: string;
}
interface WorkspaceCleanupCompleteRequest {
  worker_id: string;
  workspace_id: string;
  workspace_key: string;
  fencing: string;
  success: boolean;
  error_code?: string;
}

interface PublicationOperationClaimRequest {
  worker_id: string;
}
interface PublicationOperationClaimResponse {
  has_operation: boolean;
  publication_id?: string;
  operation?: string;
  fencing?: string;
  workspace_id?: string;
  branch_name?: string;
  source_subject_revision?: string;
  base_commit?: string;
  commit_sha?: string;
  tree_sha?: string;
  artifact_ref?: string;
  push_refspec?: string;
  commit_timestamp?: string;
  commit_author_name?: string;
  commit_author_email?: string;
  commit_message?: string;
  execution_snapshot_json?: string;
}
interface PublicationOperationCompleteRequest {
  worker_id: string;
  publication_id: string;
  operation: string;
  fencing: string;
  success: boolean;
  commit_sha?: string;
  tree_sha?: string;
  artifact_ref?: string;
  push_refspec?: string;
  error_code?: string;
  error_context?: string;
}
interface ChangeRequestOperationClaimRequest {
  worker_id: string;
}
interface ChangeRequestOperationClaimResponse {
  has_operation: boolean;
  change_request_id?: string;
  fencing?: string;
  repository_identity?: string;
  repository_url?: string;
  head_branch?: string;
  head_commit?: string;
  base_branch?: string;
  title?: string;
  body?: string;
  idempotency_key?: string;
  credential_grant_ref?: string;
}
interface ChangeRequestOperationCompleteRequest {
  worker_id: string;
  change_request_id: string;
  fencing: string;
  success: boolean;
  provider?: string;
  external_id?: string;
  url?: string;
  head_commit?: string;
  base_branch?: string;
  error_code?: string;
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
  ClaimWorkspaceCleanup(
    request: WorkspaceCleanupClaimRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: WorkspaceCleanupClaimResponse) => void,
  ): grpc.ClientUnaryCall;
  CompleteWorkspaceCleanup(
    request: WorkspaceCleanupCompleteRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: Empty) => void,
  ): grpc.ClientUnaryCall;
  ClaimPublicationOperation(
    request: PublicationOperationClaimRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: PublicationOperationClaimResponse) => void,
  ): grpc.ClientUnaryCall;
  CompletePublicationOperation(
    request: PublicationOperationCompleteRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: Empty) => void,
  ): grpc.ClientUnaryCall;
  ClaimChangeRequestOperation(
    request: ChangeRequestOperationClaimRequest,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ChangeRequestOperationClaimResponse) => void,
  ): grpc.ClientUnaryCall;
  CompleteChangeRequestOperation(
    request: ChangeRequestOperationCompleteRequest,
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

const WORKER_ERROR_HINTS: Record<string, string> = {
  WORKER_EXPERT_CAPABILITY_MISMATCH:
    "Expert 配置的 capabilities 不包含该 Worker 的 EXPERT_CAPABILITY；请对比 Admin 专家配置与 Worker instance 配置。",
  WORKER_FORBIDDEN: "Worker 未获授权使用当前 capability；请检查 Admin 中 Worker 的审批状态和注册 capabilities。",
  WORKER_IDENTITY_MISMATCH:
    "请求中的 Worker ID 与 credential 对应身份不一致；请检查 EXPERT_WORKER_ID 和该 instance 使用的 credential。",
  EXPERT_NOT_FOUND: "Worker 配置的 EXPERT_ID 在 Hub 中不存在；请核对 Worker instance 配置和 Admin 中的 Expert ID。",
  EXPERT_INACTIVE: "Worker 配置的 Expert 已停用；请在 Admin 中启用该 Expert，或改用已启用的 Expert。",
  WORKER_UNAUTHENTICATED: "Worker 身份认证失败；请检查审批/吊销状态以及该 instance 的 credential 文件。",
};

function grpcError(code: grpc.status, message: string): grpc.ServiceError {
  const metadata = new grpc.Metadata();
  const hint = WORKER_ERROR_HINTS[message];
  if (hint) {
    metadata.set("x-expert-error-code", message);
    metadata.set("x-expert-error-hint-bin", Buffer.from(hint, "utf8"));
  }
  return Object.assign(new Error(message), { code, details: message, metadata });
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
  workStore?: WorkOrchestrationStore;
  publicationStore?: WorkPublicationStore;
  changeRequestStore?: WorkChangeRequestStore;
}

export interface GrpcClientOptions {
  tls?: GrpcTlsClientConfig;
  supportedBackend?: "claude" | "codex";
  supportedRuntimeProfiles?: string[];
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
      // ClaimTask is also the idle-worker heartbeat: the runtime polls even when no task is available.
      workers.recordHeartbeat(call.request.worker_id);
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
      const compatibility =
        call.request.supported_backend === "claude" || call.request.supported_backend === "codex"
          ? {
              backend: call.request.supported_backend as "claude" | "codex",
              runtimeProfiles: call.request.supported_runtime_profiles ?? [],
            }
          : undefined;
      const claim = tasks.claim(call.request.worker_id, Date.now(), 30_000, call.request.expert_id, compatibility);
      callback(
        null,
        claim
          ? (() => {
              const repository =
                claim.deploymentSnapshot?.repository ??
                (claim.repositoryId && options.experts
                  ? options.experts
                      .listDeployments()
                      .flatMap((deployment) => deployment.repositories ?? [])
                      .find((item) => item.id === claim.repositoryId)
                  : undefined);
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
                model_config_json: claim.deploymentSnapshot
                  ? JSON.stringify(claim.deploymentSnapshot.executor.modelConfig)
                  : modelConfigJson,
                deployment_snapshot_json: claim.deploymentSnapshot ? JSON.stringify(claim.deploymentSnapshot) : "",
                workspace_key: claim.workspaceKey ?? "",
                validation_snapshot_json: JSON.stringify(claim.validationSnapshot ?? []),
                runtime_session_id: claim.runtimeSessionId ?? "",
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
      workers.recordHeartbeat(claim.workerId);
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
      const verificationResults = call.request.verification_results_json
        ? normalizeVerificationEvidenceResults(JSON.parse(call.request.verification_results_json))
        : [];
      const workspaceChangeSummary = call.request.workspace_change_summary_json
        ? normalizeWorkspaceChangeSummary(JSON.parse(call.request.workspace_change_summary_json))
        : undefined;
      tasks.complete(
        claim,
        call.request.result,
        Date.now(),
        Object.keys(source).length ? source : undefined,
        verificationResults,
        workspaceChangeSummary,
        call.request.runtime_session_id || undefined,
      );
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
      if (call.request.stage === "workspace.ready") {
        if (!options.workStore) throw new Error("WORKSPACE_REPORT_UNAVAILABLE");
        tasks.assertActiveClaim(claim);
        let report: { workspaceKey?: unknown; path?: unknown; commitSha?: unknown };
        try {
          report = JSON.parse(call.request.details || "{}") as {
            workspaceKey?: unknown;
            path?: unknown;
            commitSha?: unknown;
          };
        } catch {
          throw new Error("INVALID_WORKSPACE_REPORT");
        }
        if (
          typeof report.workspaceKey !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(report.workspaceKey) ||
          typeof report.path !== "string" ||
          !path.isAbsolute(report.path) ||
          report.path === path.parse(report.path).root ||
          typeof report.commitSha !== "string" ||
          !/^[a-f0-9]{40,64}$/i.test(report.commitSha)
        ) {
          throw new Error("INVALID_WORKSPACE_REPORT");
        }
        const attempt = options.workStore.getAttemptByTask(claim.taskId);
        if (!attempt?.workspaceId) throw new Error("WORKSPACE_NOT_FOUND");
        const workspace = options.workStore.getWorkspace(attempt.workspaceId);
        if (workspace.workspaceKey !== report.workspaceKey) throw new Error("WORKSPACE_IDENTITY_CONFLICT");
        options.workStore.assignWorkspaceOwner(
          workspace.workspaceId,
          claim.workerId,
          report.path,
          Date.now(),
          report.commitSha,
        );
        callback(null, {});
        return;
      }
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

  const claimWorkspaceCleanup: UnaryHandler<WorkspaceCleanupClaimRequest, WorkspaceCleanupClaimResponse> = (
    call,
    callback,
  ) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      if (!options.workStore) throw new Error("WORKSPACE_CLEANUP_UNAVAILABLE");
      if (workers.get(authenticatedId).status !== "active") throw new Error("WORKER_FORBIDDEN");
      workers.recordHeartbeat(authenticatedId);
      const claim = options.workStore.claimWorkspaceCleanup(authenticatedId);
      callback(
        null,
        claim
          ? {
              has_cleanup: true,
              workspace_id: claim.workspaceId,
              workspace_key: claim.workspaceKey,
              fencing: String(claim.fencing),
            }
          : { has_cleanup: false },
      );
    } catch (error) {
      callback(
        grpcError(
          grpc.status.FAILED_PRECONDITION,
          error instanceof Error ? error.message : "WORKSPACE_CLEANUP_CLAIM_FAILED",
        ),
        null,
      );
    }
  };

  const completeWorkspaceCleanup: UnaryHandler<WorkspaceCleanupCompleteRequest, Empty> = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      if (!options.workStore) throw new Error("WORKSPACE_CLEANUP_UNAVAILABLE");
      const fencing = Number(call.request.fencing);
      if (
        !call.request.workspace_id ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(call.request.workspace_key) ||
        !Number.isSafeInteger(fencing) ||
        fencing < 1
      ) {
        throw new Error("INVALID_WORKSPACE_CLEANUP");
      }
      const workspace = options.workStore.getWorkspace(call.request.workspace_id);
      if (workspace.workspaceKey !== call.request.workspace_key) throw new Error("WORKSPACE_IDENTITY_CONFLICT");
      options.workStore.completeWorkspaceCleanup(
        call.request.workspace_id,
        authenticatedId,
        fencing,
        call.request.success,
        call.request.error_code || null,
      );
      callback(null, {});
    } catch (error) {
      callback(
        grpcError(
          grpc.status.FAILED_PRECONDITION,
          error instanceof Error ? error.message : "WORKSPACE_CLEANUP_COMPLETE_FAILED",
        ),
        null,
      );
    }
  };

  const claimPublicationOperation: UnaryHandler<PublicationOperationClaimRequest, PublicationOperationClaimResponse> = (
    call,
    callback,
  ) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      if (!options.publicationStore) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
      if (workers.get(authenticatedId).status !== "active") throw new Error("WORKER_FORBIDDEN");
      workers.recordHeartbeat(authenticatedId);
      const claim = options.publicationStore.claimPublicationOperation(authenticatedId);
      callback(
        null,
        claim
          ? {
              has_operation: true,
              publication_id: claim.publicationId,
              operation: claim.operation,
              fencing: String(claim.fencing),
              workspace_id: claim.workspaceId,
              branch_name: claim.branchName,
              source_subject_revision: claim.sourceSubjectRevision,
              base_commit: claim.baseCommit,
              commit_sha: claim.commitSha ?? "",
              tree_sha: claim.treeSha ?? "",
              artifact_ref: claim.artifactRef ?? "",
              push_refspec: claim.pushRefspec ?? "",
              commit_timestamp: String(claim.commitTimestamp),
              commit_author_name: claim.commitAuthorName,
              commit_author_email: claim.commitAuthorEmail,
              commit_message: claim.commitMessage,
              execution_snapshot_json: claim.executionSnapshot ? JSON.stringify(claim.executionSnapshot) : "",
            }
          : { has_operation: false },
      );
    } catch (error) {
      callback(
        grpcError(
          grpc.status.FAILED_PRECONDITION,
          error instanceof Error ? error.message : "PUBLICATION_OPERATION_CLAIM_FAILED",
        ),
        null,
      );
    }
  };

  const completePublicationOperation: UnaryHandler<PublicationOperationCompleteRequest, Empty> = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      if (!options.publicationStore) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
      const fencing = Number(call.request.fencing);
      if (
        !call.request.publication_id ||
        (call.request.operation !== "prepare" && call.request.operation !== "push") ||
        !Number.isSafeInteger(fencing) ||
        fencing < 1
      ) {
        throw new Error("INVALID_PUBLICATION_OPERATION");
      }
      const publication = options.publicationStore.getPublication(call.request.publication_id);
      const claim: PublicationOperationLease = {
        publicationId: publication.publicationId,
        ownerWorkerId: authenticatedId,
        operation: call.request.operation,
        fencing,
        workspaceId: publication.workspaceId,
        branchName: publication.branchName,
        sourceSubjectRevision: publication.sourceSubjectRevision,
        baseCommit: publication.baseCommit,
        commitSha: publication.commitSha,
        treeSha: publication.treeSha,
        artifactRef: publication.artifactRef,
        pushRefspec: publication.pushRefspec,
        commitTimestamp: publication.commitTimestamp,
        commitAuthorName: publication.commitAuthorName,
        commitAuthorEmail: publication.commitAuthorEmail,
        commitMessage: publication.commitMessage,
        executionSnapshot: publication.executionSnapshot,
      };
      const result: PublicationOperationResult = call.request.success
        ? {
            success: true,
            ...(call.request.commit_sha ? { commitSha: call.request.commit_sha } : {}),
            ...(call.request.tree_sha ? { treeSha: call.request.tree_sha } : {}),
            ...(call.request.artifact_ref ? { artifactRef: call.request.artifact_ref } : {}),
            ...(call.request.push_refspec ? { pushRefspec: call.request.push_refspec } : {}),
          }
        : {
            success: false,
            errorCode: call.request.error_code || "PUBLICATION_OPERATION_FAILED",
            ...(call.request.error_context ? { errorContext: call.request.error_context } : {}),
          };
      options.publicationStore.completePublicationOperation(claim, result);
      callback(null, {});
    } catch (error) {
      callback(
        grpcError(
          grpc.status.FAILED_PRECONDITION,
          error instanceof Error ? error.message : "PUBLICATION_OPERATION_COMPLETE_FAILED",
        ),
        null,
      );
    }
  };

  const claimChangeRequestOperation: UnaryHandler<
    ChangeRequestOperationClaimRequest,
    ChangeRequestOperationClaimResponse
  > = (call, callback) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      if (!options.changeRequestStore) throw new Error("CHANGE_REQUEST_STORE_UNAVAILABLE");
      if (workers.get(authenticatedId).status !== "active") throw new Error("WORKER_FORBIDDEN");
      workers.recordHeartbeat(authenticatedId);
      const claim = options.changeRequestStore.claim(authenticatedId);
      callback(
        null,
        claim
          ? {
              has_operation: true,
              change_request_id: claim.changeRequestId,
              fencing: String(claim.fencing),
              repository_identity: claim.repositoryIdentity,
              repository_url: claim.repositoryUrl,
              head_branch: claim.headBranch,
              head_commit: claim.headCommit,
              base_branch: claim.baseBranch,
              title: claim.title,
              body: claim.body,
              idempotency_key: claim.idempotencyKey,
              credential_grant_ref: claim.credentialGrantRef,
            }
          : { has_operation: false },
      );
    } catch (error) {
      callback(
        grpcError(
          grpc.status.FAILED_PRECONDITION,
          error instanceof Error ? error.message : "CHANGE_REQUEST_OPERATION_CLAIM_FAILED",
        ),
        null,
      );
    }
  };

  const completeChangeRequestOperation: UnaryHandler<ChangeRequestOperationCompleteRequest, Empty> = (
    call,
    callback,
  ) => {
    try {
      const authenticatedId = authenticatedWorkerId(workers, call.metadata);
      requireIdentityMatch(authenticatedId, call.request.worker_id);
      if (!options.changeRequestStore) throw new Error("CHANGE_REQUEST_STORE_UNAVAILABLE");
      const fencing = Number(call.request.fencing);
      if (!call.request.change_request_id || !Number.isSafeInteger(fencing) || fencing < 1) {
        throw new Error("INVALID_CHANGE_REQUEST_OPERATION");
      }
      const current = options.changeRequestStore.get(call.request.change_request_id);
      const claim: ChangeRequestOperationLease = {
        changeRequestId: current.changeRequestId,
        ownerWorkerId: authenticatedId,
        fencing,
        repositoryIdentity: current.repositoryIdentity,
        repositoryUrl: current.repositoryUrl,
        headBranch: current.headBranch,
        headCommit: current.headCommit,
        baseBranch: current.baseBranch,
        title: current.title,
        body: current.body,
        idempotencyKey: current.idempotencyKey,
        credentialGrantRef: current.credentialGrantRef,
      };
      const result: ChangeRequestOperationResult = call.request.success
        ? {
            success: true,
            provider: call.request.provider ?? "",
            externalId: call.request.external_id ?? "",
            url: call.request.url ?? "",
            headCommit: call.request.head_commit ?? "",
            baseBranch: call.request.base_branch ?? "",
          }
        : {
            success: false,
            errorCode: call.request.error_code || "CHANGE_REQUEST_CREATE_FAILED",
          };
      options.changeRequestStore.complete(claim, result);
      callback(null, {});
    } catch (error) {
      callback(
        grpcError(
          grpc.status.FAILED_PRECONDITION,
          error instanceof Error ? error.message : "CHANGE_REQUEST_OPERATION_COMPLETE_FAILED",
        ),
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
    ClaimWorkspaceCleanup: claimWorkspaceCleanup,
    CompleteWorkspaceCleanup: completeWorkspaceCleanup,
    ClaimPublicationOperation: claimPublicationOperation,
    CompletePublicationOperation: completePublicationOperation,
    ClaimChangeRequestOperation: claimChangeRequestOperation,
    CompleteChangeRequestOperation: completeChangeRequestOperation,
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

function parseClaimDeploymentSnapshot(value: string): DeploymentTaskSnapshot {
  let result: DeploymentTaskSnapshot;
  try {
    result = JSON.parse(value) as DeploymentTaskSnapshot;
  } catch {
    throw new Error("INVALID_CLAIM_DEPLOYMENT_SNAPSHOT");
  }
  if (
    !result ||
    !result.deploymentId ||
    !Number.isSafeInteger(result.configVersion) ||
    !result.repository ||
    !result.executor ||
    !["claude", "codex"].includes(result.executor.backend)
  )
    throw new Error("INVALID_CLAIM_DEPLOYMENT_SNAPSHOT");
  return result;
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
  private readonly supportedBackend?: "claude" | "codex";
  private readonly supportedRuntimeProfiles: string[];

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
    this.supportedBackend = options.supportedBackend;
    this.supportedRuntimeProfiles = options.supportedRuntimeProfiles ?? [];
  }

  async claimTask(workerId: string, expertId: string, capability = expertId): Promise<Claim | null> {
    const response = await unary<ClaimTaskResponse>((callback) =>
      this.client.ClaimTask(
        {
          worker_id: workerId,
          capability,
          expert_id: expertId,
          supported_backend: this.supportedBackend,
          supported_runtime_profiles: this.supportedRuntimeProfiles,
        },
        this.metadata,
        callback,
      ),
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
      ...(response.deployment_snapshot_json
        ? { deploymentSnapshot: parseClaimDeploymentSnapshot(response.deployment_snapshot_json) }
        : {}),
      ...(response.workspace_key ? { workspaceKey: response.workspace_key } : {}),
      ...(response.validation_snapshot_json
        ? { validationSnapshot: normalizeVerificationPolicy(JSON.parse(response.validation_snapshot_json)) }
        : {}),
      ...(response.runtime_session_id ? { runtimeSessionId: response.runtime_session_id } : {}),
    };
  }

  async claimPublicationOperation(workerId: string): Promise<PublicationOperationLease | null> {
    const response = await unary<PublicationOperationClaimResponse>((callback) =>
      this.client.ClaimPublicationOperation({ worker_id: workerId }, this.metadata, callback),
    );
    if (!response.has_operation) return null;
    const fencing = Number(response.fencing);
    const commitTimestamp = Number(response.commit_timestamp);
    if (
      !response.publication_id ||
      (response.operation !== "prepare" && response.operation !== "push") ||
      !response.workspace_id ||
      !response.branch_name ||
      !response.source_subject_revision ||
      !response.base_commit ||
      !Number.isSafeInteger(fencing) ||
      fencing < 1 ||
      !Number.isSafeInteger(commitTimestamp) ||
      commitTimestamp < 1
    ) {
      throw new Error("INVALID_PUBLICATION_OPERATION_RESPONSE");
    }
    let executionSnapshot: PublicationOperationLease["executionSnapshot"] = null;
    if (response.execution_snapshot_json) {
      try {
        executionSnapshot = JSON.parse(
          response.execution_snapshot_json,
        ) as PublicationOperationLease["executionSnapshot"];
      } catch {
        throw new Error("INVALID_PUBLICATION_OPERATION_RESPONSE");
      }
    }
    return {
      publicationId: response.publication_id,
      ownerWorkerId: workerId,
      operation: response.operation,
      fencing,
      workspaceId: response.workspace_id,
      branchName: response.branch_name,
      sourceSubjectRevision: response.source_subject_revision,
      baseCommit: response.base_commit,
      commitSha: response.commit_sha || null,
      treeSha: response.tree_sha || null,
      artifactRef: response.artifact_ref || null,
      pushRefspec: response.push_refspec || null,
      commitTimestamp,
      commitAuthorName: response.commit_author_name ?? "",
      commitAuthorEmail: response.commit_author_email ?? "",
      commitMessage: response.commit_message ?? "",
      executionSnapshot,
    };
  }

  completePublicationOperation(claim: PublicationOperationLease, result: PublicationOperationResult): Promise<Empty> {
    return unary((callback) =>
      this.client.CompletePublicationOperation(
        {
          worker_id: claim.ownerWorkerId,
          publication_id: claim.publicationId,
          operation: claim.operation,
          fencing: String(claim.fencing),
          success: result.success,
          ...(result.success
            ? {
                commit_sha: result.commitSha ?? "",
                tree_sha: result.treeSha ?? "",
                artifact_ref: result.artifactRef ?? "",
                push_refspec: result.pushRefspec ?? "",
              }
            : {
                error_code: result.errorCode,
                error_context: result.errorContext ?? "",
              }),
        },
        this.metadata,
        callback,
      ),
    );
  }
  async claimChangeRequestOperation(workerId: string): Promise<ChangeRequestOperationLease | null> {
    const response = await unary<ChangeRequestOperationClaimResponse>((callback) =>
      this.client.ClaimChangeRequestOperation({ worker_id: workerId }, this.metadata, callback),
    );
    if (!response.has_operation) return null;
    const fencing = Number(response.fencing);
    if (
      !response.change_request_id ||
      !response.repository_identity ||
      !response.repository_url ||
      !response.head_branch ||
      !response.head_commit ||
      !response.base_branch ||
      !response.title ||
      !response.body ||
      !response.idempotency_key ||
      !response.credential_grant_ref ||
      !Number.isSafeInteger(fencing) ||
      fencing < 1
    ) {
      throw new Error("INVALID_CHANGE_REQUEST_OPERATION_RESPONSE");
    }
    return {
      changeRequestId: response.change_request_id,
      ownerWorkerId: workerId,
      fencing,
      repositoryIdentity: response.repository_identity,
      repositoryUrl: response.repository_url,
      headBranch: response.head_branch,
      headCommit: response.head_commit,
      baseBranch: response.base_branch,
      title: response.title,
      body: response.body,
      idempotencyKey: response.idempotency_key,
      credentialGrantRef: response.credential_grant_ref,
    };
  }

  completeChangeRequestOperation(
    claim: ChangeRequestOperationLease,
    result: ChangeRequestOperationResult,
  ): Promise<Empty> {
    return unary((callback) =>
      this.client.CompleteChangeRequestOperation(
        {
          worker_id: claim.ownerWorkerId,
          change_request_id: claim.changeRequestId,
          fencing: String(claim.fencing),
          success: result.success,
          ...(result.success
            ? {
                provider: result.provider,
                external_id: result.externalId,
                url: result.url,
                head_commit: result.headCommit,
                base_branch: result.baseBranch,
              }
            : { error_code: result.errorCode }),
        },
        this.metadata,
        callback,
      ),
    );
  }

  async claimWorkspaceCleanup(workerId: string): Promise<import("./remote-worker.js").WorkspaceCleanupLease | null> {
    const response = await unary<WorkspaceCleanupClaimResponse>((callback) =>
      this.client.ClaimWorkspaceCleanup({ worker_id: workerId }, this.metadata, callback),
    );
    if (!response.has_cleanup) return null;
    const fencing = Number(response.fencing);
    if (!response.workspace_id || !response.workspace_key || !Number.isSafeInteger(fencing) || fencing < 1) {
      throw new Error("INVALID_WORKSPACE_CLEANUP_RESPONSE");
    }
    return {
      workspaceId: response.workspace_id,
      workspaceKey: response.workspace_key,
      ownerWorkerId: workerId,
      fencing,
    };
  }

  completeWorkspaceCleanup(
    claim: import("./remote-worker.js").WorkspaceCleanupLease,
    success: boolean,
    errorCode = "",
  ): Promise<Empty> {
    return unary((callback) =>
      this.client.CompleteWorkspaceCleanup(
        {
          worker_id: claim.ownerWorkerId,
          workspace_id: claim.workspaceId,
          workspace_key: claim.workspaceKey,
          fencing: String(claim.fencing),
          success,
          error_code: errorCode,
        },
        this.metadata,
        callback,
      ),
    );
  }

  renewLease(claim: Claim): Promise<LeaseResponse> {
    return unary((callback) => this.client.RenewLease(this.claimRequest(claim), this.metadata, callback));
  }

  completeTask(
    claim: Claim,
    result: string,
    source?: { repositoryUrl?: string; repositoryBranch?: string; commitSha?: string },
    verificationResults?: VerificationEvidenceResult[],
    workspaceChangeSummary?: WorkspaceChangeSummary,
    runtimeSessionId?: string,
  ): Promise<Empty> {
    return unary((callback) =>
      this.client.CompleteTask(
        {
          claim: this.claimRequest(claim),
          result,
          repository_url: source?.repositoryUrl ?? "",
          repository_branch: source?.repositoryBranch ?? "",
          commit_sha: source?.commitSha ?? "",
          verification_results_json: verificationResults?.length ? JSON.stringify(verificationResults) : "",
          workspace_change_summary_json: workspaceChangeSummary ? JSON.stringify(workspaceChangeSummary) : "",
          runtime_session_id: runtimeSessionId ?? "",
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
