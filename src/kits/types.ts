export type AcceptanceCheck = { id: string; text: string };

/** `test` must write JUnit XML to `$ANTON_JUNIT`. */
export type Commands = { install: string; test: string; run?: string };

export type CheckResult = {
  id: string;
  status: 'pass' | 'fail';
  reason?: 'no_test' | 'failing' | 'run_failed';
  tests: string[];
  /** real: a passing `[real]` test covers it; stand-in: tests exist but none is a passing `[real]` one. */
  evidence?: 'real' | 'stand-in';
  error?: string;
};

export type VerifyContext = {
  container: string;
  jobDir: string;
  checks: AcceptanceCheck[];
  commands: Commands;
  /** Project secrets: the kit redacts them from everything it saves. */
  secrets?: Record<string, string>;
};

/** `tests` lists every testcase (named as in BaselineOutcome.passingTests) so verify can compare with the baseline. */
export type VerifyOutcome = { results: CheckResult[]; runOk: boolean; failureReport: string; tests: { name: string; passed: boolean }[];
  /** False when install failed or the test run left no valid JUnit XML (so `tests` says nothing); undefined counts as true. */
  testsRan?: boolean;
};

export type BaselineContext = { container: string; jobDir: string; commands: Commands; secrets?: Record<string, string> };
export type BaselineOutcome = { passingTests: string[]; ran: boolean };

export interface Kit {
  name: string;
  dockerfile: string;
  /** Kit whose image this one builds on (FROM); ensured first. */
  base?: Kit;
  /** 0..1 confidence that this kit suits the job description. */
  detect(description: string): number;
  verify(ctx: VerifyContext): Promise<VerifyOutcome>;
  /** Runs install and test on the untouched repo; ran is false when install fails or no valid JUnit comes back. */
  baseline(ctx: BaselineContext): Promise<BaselineOutcome>;
}
