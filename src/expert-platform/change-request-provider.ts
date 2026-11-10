export interface CreateChangeRequestInput {
  repositoryIdentity: string;
  headBranch: string;
  headCommit: string;
  baseBranch: string;
  title: string;
  body: string;
  idempotencyKey: string;
  credentialGrantRef: string;
}

export interface ChangeRequestResult {
  provider: string;
  externalId: string;
  url: string;
  headCommit: string;
  baseBranch: string;
}

export interface ChangeRequestProvider {
  create(input: CreateChangeRequestInput): Promise<ChangeRequestResult>;
}
