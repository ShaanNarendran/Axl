<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Azure OpenAI Responses codec support record

## Scope

This record covers Azure-specific composition around the shared Responses codec in `packages/ai/src/azure-openai.ts`. It includes deployment selection, endpoint normalization, API version queries, request headers, prepared request encoding, canonical stream decoding, and deterministic fixtures.

The delivered runtime provider identity remains `azure-openai`. Its models now identify their wire dialect as `azure-openai-responses`, which keeps replay metadata bound to Azure while preserving existing runtime configuration and selection behavior.

## Reviewed sources

### Normative Microsoft sources

- Azure Responses guide: `https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses`
- Azure Responses REST reference: `https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference-preview-latest`
- Azure endpoint switching guide: `https://learn.microsoft.com/en-us/azure/developer/ai/how-to/switching-endpoints`
- Retrieved: 2026-09-05T17:02:18Z
- Reviewed surface: `/openai/v1/responses`, deployment names in the request `model` field, the default `v1` API version, dated API versions, `api-key`, and Microsoft Entra bearer authorization.

### Behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed files: `packages/ai/src/api/azure-openai-responses.ts`, `packages/ai/src/providers/azure-openai-responses.ts`, and focused Azure tests under `packages/ai/test/`.

Pi was used to identify endpoint, deployment, header, and replay compatibility cases. Axl's composition is an independent implementation around its prepared request, authentication, and canonical stream contracts.

## Implemented endpoint and header policy

- Azure OpenAI, Cognitive Services, and Foundry host roots normalize to `/openai/v1`.
- Already normalized Azure bases remain stable, including a supplied `/openai/v1/responses` URL.
- Explicit proxy and gateway paths remain intact. Existing query settings are preserved when the selected API version is added.
- Requests target `{base}/responses`. Authentication verification targets `{base}/models`.
- `AZURE_OPENAI_API_VERSION` selects an explicit version. Missing or blank values use `v1`.
- `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` maps canonical model IDs to deployment names. The selected deployment is sent in the request `model` field, not added to the URL path.
- API keys use the Azure `api-key` header. Resolved authentication headers remain composable for the later Azure ambient credential slice.

## Prepared request and stream behavior

Azure accepts only the shared immutable `PreparedModelRequest` boundary. Request bodies reuse the completed Responses encoder for verified images, tools, constraints, reasoning replay, output limits, tool choice, sampling, and prompt caching. Azure composition adds only endpoint, API version, deployment, and authentication header policy.

Streaming reuses the shared Responses decoder for text, reasoning, tools, usage, failures, cancellation, partial content, and exact terminal normalization. Replay metadata records the `azure-openai-responses` dialect and the existing `azure-openai` provider identity, preventing Azure continuation data from crossing provider or dialect boundaries.

## Deterministic verification

Local fixtures cover Azure host normalization, proxy query preservation, default and dated API versions, deployment maps, API key and resolved custom headers, prepared body composition, stream shape, Azure replay provenance, HTTP failures with credential redaction, cancellation, missing configuration, and preservation of the complete legacy model catalog.

## Deferred work

Azure provider registration under the planned canonical provider inventory, Microsoft Entra credential acquisition and refresh, timeout enforcement, bounded HTTP retries, retry guidance, and broader product integration remain in their owning slices. This codec slice does not add Codex behavior or change persisted replay formats.
