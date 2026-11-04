# T-5.4 report
Implemented src/matching/run.ts (runRuleCheck -> RuleCheckOutcome|null, InvalidStateError, SecretariatMissingError) and tests/matching/run.test.ts (15 DB tests a-o, actually run).
RED: first run failed at import (src/matching/run.ts missing). One test bug fixed (case b needed mdPath), then GREEN.
GREEN: full npm test all pass; lint, typecheck, build pass.
Design: read phase unlocked; agent call outside any tx; write phase one tx (FOR UPDATE recheck, column update, transition(..., tx)). Concurrent double run yields one event.
Concern: db cast `as never` for loadAliases and `as unknown as DbLike` for tx (type-width mismatches only).
