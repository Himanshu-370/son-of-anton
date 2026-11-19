export type AcceptanceCheck = { id: string; text: string };

/** `test` must write JUnit XML to `$ANTON_JUNIT`. */
export type Commands = { install: string; test: string; run?: string };

export type CheckResult = {
  id: string;
  status: 'pass' | 'fail';
  reason?: 'no_test' | 'failing' | 'run_failed';
  tests: string[];
  error?: string;
};

export type VerifyContext = {
  container: string;
  jobDir: string;
  checks: AcceptanceCheck[];
  commands: Commands;
};

export type VerifyOutcome = { results: CheckResult[]; runOk: boolean; failureReport: string };

export interface Kit {
  name: string;
  dockerfile: string;
  /** 0..1 confidence that this kit suits the job description. */
  detect(description: string): number;
  verify(ctx: VerifyContext): Promise<VerifyOutcome>;
}
