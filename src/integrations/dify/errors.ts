/** Typed errors of the Dify client. Messages never contain the API key or document contents. */
export class DifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Non-2xx HTTP response (after retries for 429/5xx). `body` is truncated. */
export class DifyHttpError extends DifyError {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Dify HTTP ${status}: ${body}`);
  }
}

export class DifyTimeoutError extends DifyError {
  constructor(readonly timeoutS: number) {
    super(`Dify request timed out after ${timeoutS}s`);
  }
}

export class DifyNetworkError extends DifyError {
  constructor(detail: string) {
    super(`Dify network error: ${detail}`);
  }
}

/** Workflow ran but its status was not "succeeded". */
export class DifyWorkflowError extends DifyError {
  constructor(status: string, detail: string) {
    super(`Dify workflow ${status}${detail ? `: ${detail}` : ""}`);
  }
}

/** Workflow succeeded but an expected output variable is missing or malformed. */
export class DifyOutputError extends DifyError {}
