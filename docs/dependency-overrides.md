# Dependency Overrides

This document records the reason, introduction date, and removal condition for each override in `package.json`.

Overrides exist to enforce minimum safe versions for transitive dependencies that have known vulnerabilities. They should be removed when the upstream parent dependency updates past the minimum safe version on its own.

| Override | Reason | Introduced | Removal Condition |
|----------|--------|------------|-------------------|
| `ajv >= 8.18.0` | ReDoS vulnerability (GHSA-2g4f-4pwh-qvx6) in ajv < 8.18.0, pulled in transitively via `@modelcontextprotocol/sdk` | 2025-04 | When all transitive dependents resolve ajv >= 8.18.0 by default |
| `hono >= 4.11.10` | Timing-attack vulnerability (GHSA-gq3j-xvxp-8hrf) in hono < 4.11.10, pulled in transitively via `@modelcontextprotocol/sdk` | 2025-04 | When all transitive dependents resolve hono >= 4.11.10 by default |

## How to check override health

The test suite in `src/utils/__tests__/dep-versions.test.ts` asserts that the installed transitive versions meet or exceed the minimum safe versions. If those tests pass after removing an override, the override is safe to delete.

## Policy

- Every override must have an entry in this document.
- Overrides must specify a minimum safe version (`>=X.Y.Z`), not pin to an exact version.
- Remove overrides as soon as upstream dependencies no longer need them.
