<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model provider protocol compatibility

## Scope

The issue 10 provider contract extends the in-process model stream shared by `packages/protocol`, `packages/ai`, and `packages/kernel`. It does not change the persisted JSONL event catalog or the daemon wire envelopes. The event format and local wire protocol versions therefore remain unchanged.

## Additive stream behavior

Existing providers and consumers remain valid:

- Text and thinking deltas may omit `contentIndex`.
- A complete `tool_call` remains the authoritative instruction consumed by the kernel.
- `tool_call_start` and `tool_call_delta` provide optional progress without replacing the complete call.
- Completion, error, and abort remain the only terminal variants, and exactly one terminal event is still required.
- Response attribution, partial-content status, retry guidance, and diagnostics are optional terminal metadata.

New codecs should provide stable `contentIndex` values whenever the upstream protocol can interleave text, thinking, and tool blocks. Consumers that do not render incremental tool arguments may ignore progress events and wait for `tool_call`.

## Trust boundary

`parseModelStreamEvent` validates provider events before normalized streams enter the kernel. The safe diagnostic contract accepts only a code, message, and severity. It intentionally has no arbitrary details, headers, request bodies, stack traces, or credential fields.

Response metadata may contain provider identity, requested and routed model identity, a response ID, native stop detail, and latency. Provider signatures and adapter-private continuation payloads remain inside `packages/ai` and must not be placed in canonical events.

## Model and request metadata

The `packages/ai` additions are optional for existing callers. API dialects, compatibility controls, endpoint policy, cache policy, availability, tiered prices, sampling, cache preferences, timeout, and bounded retry controls are interpreted by provider adapters. The kernel remains provider independent.

Native image generation is an optional capability on `ModelProvider`. Image bytes travel through blob reader and writer callbacks, while results contain content-addressed blob references rather than inline bytes.
