# ADR-0002: All contracts are Zod schemas in `@bridge/spec`; the Manifest is versioned and migratable

Status: accepted (2026-08-12)

## Context
The Bridge Manifest must be typed, versioned, extensible, validated,
migratable, and provider-independent. Templates, blank creation, and
AI-generated agents must all produce the same representation. AI editing
requires structured data with machine-checkable validity.

## Decision
- `@bridge/spec` holds Zod schemas for: the Manifest, dashboard spec,
  permission policy, typed events, and templates. TS types are `z.infer` —
  schemas are the single source of truth, no parallel type definitions.
- `@bridge/spec` depends on **zod only**. No runtime, DB, or provider
  imports. Every other package/app depends on it; it depends on nothing.
- `specVersion` is an integer literal. `parseManifest(unknown)` runs
  `migrateManifest()` (a chain of `vN → vN+1` upgrade functions) before
  validation. Old stored manifests always parse; schema changes ship with a
  migration or they don't ship.
- Zod (v4) chosen over JSON Schema authoring or Protobuf: native TS
  inference, runtime validation, structured-output compatibility for the
  Agent Architect, and `z.toJSONSchema` when JSON Schema is needed at edges.

## Consequences
- One vocabulary across API, runtime, clients, and AI editing.
- Schema evolution is deliberate: adding fields is cheap (optional +
  default), breaking changes require a version bump + migration function.
- Validation errors are structured and can be surfaced to users/AI directly.
