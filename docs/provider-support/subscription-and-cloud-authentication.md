<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Subscription and cloud authentication support record

## Scope

This record covers Step 10 authentication in `packages/ai`: subscription OAuth for OpenAI Codex, Anthropic, GitHub Copilot, OpenRouter, Kimi For Coding, Radius, and xAI; Microsoft Entra credentials for Azure OpenAI; Application Default Credentials and service accounts for Google Vertex AI; and the AWS default credential chain plus SigV4 signing for Amazon Bedrock.

Provider construction and model listing remain free of credential reads and network work. Runtime, daemon, SDK, CLI, and TUI provider selection and trusted login presentation are complete.

## Subscription OAuth

The shared provider authentication lifecycle retains stored credential precedence, provider isolation, cancellation, generation-safe login and logout, serialized refresh, and explicit reauthentication failures. OAuth responses are strictly validated before persistence. Access tokens, refresh tokens, generated API keys, GitHub tokens, authorization headers, account identifiers, and signing credentials never enter prompts, notifications, diagnostics, catalogs, model configuration, or extension-visible configuration.

| Provider | Flow and endpoint policy | Stored result and refresh |
| --- | --- | --- |
| OpenAI Codex | Browser authorization with PKCE or headless device authorization at `auth.openai.com` | Refreshable OAuth tokens. The ChatGPT account claim is validated before storage. Codex models are available only through this OAuth method. |
| Anthropic | Browser authorization with PKCE at `claude.ai`, token exchange at `platform.claude.com/v1/oauth/token` | Refreshable OAuth tokens. Requests use bearer authentication and the required Claude Code OAuth beta declarations. |
| GitHub Copilot | GitHub or GitHub Enterprise device authorization, followed by the Copilot token exchange | The GitHub token remains the refresh credential. Short-lived Copilot tokens are refreshed serially. The token's `proxy-ep` selects the account-specific API endpoint. `COPILOT_GITHUB_TOKEN` is exchanged when it is a GitHub token and accepted directly only when it is already a Copilot token. `GITHUB_ENTERPRISE_URL` and `GH_HOST` select enterprise routing. |
| OpenRouter | Browser PKCE authorization and `POST /api/v1/auth/keys` exchange | The provider-issued permanent API key is stored as an API-key credential, not represented as a fictitious refresh token. |
| Kimi For Coding | RFC 8628 device authorization at `auth.kimi.com` | Refreshable OAuth tokens with cancellation and server-directed polling intervals. |
| Radius | Gateway-owned browser PKCE or device authorization discovered under `/v1/oauth` | Refreshable gateway OAuth tokens. The configured Radius gateway owns every OAuth endpoint. |
| xAI | Device authorization at `auth.x.ai` for the documented Grok CLI subscription scope | Refreshable OAuth tokens, including refresh-token rotation when returned. API-key authentication remains independently available. |

Browser flows publish only the authorization URL and accept the final redirect URL or authorization code through the UI-neutral `manual_code` prompt. Device flows publish only the user code, trusted verification URL, interval, and expiry. Polling obeys cancellation, expiry, and `slow_down` guidance.

## Cloud authentication

### Azure OpenAI

When no provider-scoped credential or `AZURE_OPENAI_API_KEY` exists, Azure OpenAI resolves `DefaultAzureCredential` lazily and requests `https://cognitiveservices.azure.com/.default`. The official Azure Identity library owns its environment, workload identity, managed identity, developer-tool, and cache behavior. Every provider resolution asks the credential for a current token. The resolved token is confined to the Authorization header and redaction set. Azure base URL, resource name, API version, and deployment mapping remain explicit provider settings.

### Google Vertex AI

Vertex retains Express Mode API-key precedence. With no API key, `GOOGLE_APPLICATION_CREDENTIALS` selects an explicit service-account file source before ambient ADC. Ambient ADC uses `GoogleAuth` with the Cloud Platform scope. Project discovery uses the official library when no project is configured, while location remains required. Stored provider credentials can explicitly select API key, ADC, or service-account mode. The official Google Auth Library owns token caching and refresh, and Axl requests a current access token for each provider resolution.

### Amazon Bedrock

`AWS_BEARER_TOKEN_BEDROCK` remains the first environment source. Otherwise the official AWS Node credential provider chain resolves environment credentials, SSO, web identity, shared configuration and profiles, process credentials, ECS task roles, and EC2 instance roles. A stored provider credential can select a bearer token, a named AWS profile, or the default chain. Region selection uses stored provider settings, then `AWS_REGION`, then `AWS_DEFAULT_REGION`.

SigV4 uses the resolved temporary or long-lived credential, the request's final URL and exact JSON bytes, the resolved region, and the `bedrock` signing service. Each retry is signed again. Session tokens are included by the signer. Failed acquisition or signing stops before dispatch, and no unsigned fallback occurs.

## Dependency review

Platform APIs do not implement the cloud credential chains or SigV4. Step 10 therefore pins official maintained packages through the repository lockfile:

- `@azure/identity` 4.13.2, MIT, Azure SDK for JavaScript
- `google-auth-library` 11.0.2, Apache-2.0, Google Auth Library for Node.js
- `@aws-sdk/credential-provider-node` 3.972.82, Apache-2.0, AWS SDK for JavaScript v3
- `@smithy/signature-v4` 5.7.3, Apache-2.0, Smithy TypeScript
- `@smithy/protocol-http` 5.6.2, Apache-2.0, Smithy TypeScript
- `@smithy/hash-node` 4.5.2, Apache-2.0, Smithy TypeScript

OAuth protocol handling remains local because no official common SDK owns these provider-specific public-client and device flows.

## Reviewed official sources

- OpenAI Codex authentication source and documentation: `https://github.com/openai/codex/tree/ad2012d645b7146d31bb03f98e2bd9371635d11a/codex-rs/login` and `https://developers.openai.com/codex/auth/`
- Anthropic authentication: `https://code.claude.com/docs/en/authentication`
- GitHub OAuth device flow: `https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow`
- GitHub Copilot SDK authentication: `https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate`
- OpenRouter OAuth PKCE: `https://openrouter.ai/docs/use-cases/oauth-pkce`
- Kimi Code authentication: `https://www.kimi.com/code/docs/en/`
- Radius gateway discovery: `https://radius.pi.dev/`
- xAI Grok CLI authentication: `https://docs.x.ai/build/cli/reference`
- Azure OpenAI Microsoft Entra authentication: `https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/managed-identity`
- Google Application Default Credentials: `https://cloud.google.com/docs/authentication/application-default-credentials`
- Vertex AI authentication: `https://cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth`
- AWS standardized credential providers: `https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html`
- AWS Signature Version 4: `https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html`

The incomplete public wire contracts for Anthropic subscription OAuth, GitHub Copilot entitlement exchange, Radius, and parts of the Codex, Kimi, and xAI client flows were also checked against the pinned Pi behavioral reference at commit `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`. Axl's code and fixtures are independent.

## Deterministic verification

Local tests cover all seven subscription flows, PKCE and device behavior, token rotation, cancellation, credential persistence shape, Codex account validation, Copilot enterprise routing, stored credential precedence, refresh serialization, Azure token acquisition, Vertex ADC and service-account selection, missing files, AWS profile isolation, temporary session credentials, SigV4 headers, request-body integrity, and explicit acquisition failures. No live provider credential or request was used.

## Completion status

Product-facing provider selection, authentication commands and presentation, daemon and SDK boundaries, CLI and TUI integration, and deterministic verification are complete. The complete setup matrix and current limitations are documented in [`provider-reference.md`](provider-reference.md).
