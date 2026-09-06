// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type {
  ProviderAuthenticationStatusParams,
  ProviderAuthenticationStatusResult,
  ProviderCatalogRefreshParams,
  ProviderCatalogRefreshResult,
  ProviderListParams,
  ProviderListResult,
  ProviderLoginParams,
  ProviderLoginResult,
  ProviderLogoutParams,
  ProviderLogoutResult,
  ProviderRpcErrorCode,
  ProviderRpcErrorDetails,
} from "@axl/protocol";

import { DaemonError } from "./session-manager.ts";

/** Daemon-owned provider operations implemented by the process runtime. */
export interface ProviderManagementService {
  list(params: ProviderListParams, signal?: AbortSignal): Promise<ProviderListResult>;
  refresh(
    params: ProviderCatalogRefreshParams,
    signal?: AbortSignal,
  ): Promise<ProviderCatalogRefreshResult>;
  authenticationStatus(
    params: ProviderAuthenticationStatusParams,
    signal?: AbortSignal,
  ): Promise<ProviderAuthenticationStatusResult>;
  login(params: ProviderLoginParams, signal?: AbortSignal): Promise<ProviderLoginResult>;
  logout(params: ProviderLogoutParams, signal?: AbortSignal): Promise<ProviderLogoutResult>;
  dispose?(): void | Promise<void>;
}

export class ProviderManagementError extends DaemonError {
  declare readonly code: ProviderRpcErrorCode;

  constructor(code: ProviderRpcErrorCode, message: string, details: ProviderRpcErrorDetails) {
    super(code, message, { details: { ...details } });
    this.name = "ProviderManagementError";
    this.code = code;
  }
}
