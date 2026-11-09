import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios'

export interface ApiResponse<T> {
  data: T
}

export type FieldErrors = Record<string, string[]>

export type CoreApiErrorKind = 'http' | 'network' | 'server' | 'malformed'

interface CoreApiErrorOptions {
  message: string
  status?: number
  code?: string
  fieldErrors?: FieldErrors
  kind: CoreApiErrorKind
  cause?: unknown
}

export class CoreApiError extends Error {
  readonly status?: number
  readonly code?: string
  readonly fieldErrors: FieldErrors
  readonly kind: CoreApiErrorKind
  readonly isNetworkError: boolean
  readonly isServerError: boolean
  readonly cause?: unknown

  constructor({
    message,
    status,
    code,
    fieldErrors = {},
    kind,
    cause,
  }: CoreApiErrorOptions) {
    super(message)
    this.name = 'CoreApiError'
    this.status = status
    this.code = code
    this.fieldErrors = fieldErrors
    this.kind = kind
    this.isNetworkError = kind === 'network'
    this.isServerError = kind === 'server' || (status ?? 0) >= 500
    this.cause = cause
  }
}

const STATE_CHANGING_METHODS = new Set(['post', 'put', 'patch', 'delete'])

let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function resetCsrfToken(): void {
  csrfToken = null
}

const coreApiBaseUrl = import.meta.env.VITE_CORE_API_BASE_URL || '/api/v1'

export const coreApiAxios: AxiosInstance = axios.create({
  baseURL: coreApiBaseUrl,
  withCredentials: true,
})

function applyRequestSecurity(config: InternalAxiosRequestConfig) {
  const headers = config.headers
  const mutableHeaders = headers as unknown as Record<string, unknown>

  for (const headerName of [
    'Authorization',
    'authorization',
    'X-Auth-Transport',
    'x-auth-transport',
  ]) {
    if (typeof headers.delete === 'function') {
      headers.delete(headerName)
    } else {
      delete mutableHeaders[headerName]
    }
  }

  if (
    csrfToken &&
    STATE_CHANGING_METHODS.has((config.method ?? 'get').toLowerCase())
  ) {
    if (typeof headers.set === 'function') {
      headers.set('X-CSRF-Token', csrfToken)
    } else {
      mutableHeaders['X-CSRF-Token'] = csrfToken
    }
  }

  return config
}

coreApiAxios.interceptors.request.use(applyRequestSecurity)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeFieldErrors(value: unknown): FieldErrors {
  const fieldErrors: FieldErrors = {}

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue
      const field = readString(item.field ?? item.path ?? item.name)
      const message = readString(item.message)
      if (field && message) {
        fieldErrors[field] = [...(fieldErrors[field] ?? []), message]
      }
    }
    return fieldErrors
  }

  if (!isRecord(value)) return fieldErrors

  for (const [field, messages] of Object.entries(value)) {
    if (typeof messages === 'string' && messages.length > 0) {
      fieldErrors[field] = [messages]
      continue
    }

    if (Array.isArray(messages)) {
      const normalizedMessages = messages.filter(
        (message): message is string =>
          typeof message === 'string' && message.length > 0
      )
      if (normalizedMessages.length > 0) {
        fieldErrors[field] = normalizedMessages
      }
      continue
    }

    if (isRecord(messages)) {
      const message = readString(messages.message)
      if (message) fieldErrors[field] = [message]
    }
  }

  return fieldErrors
}

function getErrorPayloadValue(
  payload: unknown,
  key: string
): unknown | undefined {
  const candidates: unknown[] = [payload]

  if (isRecord(payload)) {
    candidates.push(payload.error, payload.data)
  }

  for (const candidate of candidates) {
    if (isRecord(candidate) && key in candidate) {
      return candidate[key]
    }
  }

  return undefined
}

function normalizeBackendError(error: AxiosError): CoreApiError {
  const status = error.response?.status
  const payload = error.response?.data
  const kind: CoreApiErrorKind =
    status !== undefined && status >= 500
      ? 'server'
      : error.response
        ? 'http'
        : 'network'
  const fieldErrors = normalizeFieldErrors(
    getErrorPayloadValue(payload, 'fieldErrors') ??
      getErrorPayloadValue(payload, 'errors')
  )

  return new CoreApiError({
    message:
      readString(getErrorPayloadValue(payload, 'message')) ??
      (error.message || 'Core API request failed.'),
    status,
    code:
      readString(getErrorPayloadValue(payload, 'code')) ??
      readString(getErrorPayloadValue(payload, 'errorCode')),
    fieldErrors,
    kind,
    cause: error,
  })
}

export function normalizeCoreApiError(error: unknown): CoreApiError {
  if (error instanceof CoreApiError) return error

  if (axios.isAxiosError(error)) {
    return normalizeBackendError(error)
  }

  return new CoreApiError({
    message: 'Unable to connect to the Core API.',
    code: 'NETWORK_ERROR',
    kind: 'network',
    cause: error,
  })
}

function unwrapResponse<T>(
  response: Awaited<ReturnType<AxiosInstance['request']>>
): T {
  if (!isRecord(response.data) || !('data' in response.data)) {
    throw new CoreApiError({
      message: 'Core API returned a malformed response.',
      status: response.status,
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  }

  return response.data.data as T
}

async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await coreApiAxios.request<ApiResponse<T>>(config)
    return unwrapResponse<T>(response)
  } catch (error) {
    throw normalizeCoreApiError(error)
  }
}

export const coreApi = {
  request,
  get<T>(url: string, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'GET', url })
  },
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'POST', url, data })
  },
  put<T>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'PUT', url, data })
  },
  patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'PATCH', url, data })
  },
  delete<T>(url: string, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'DELETE', url })
  },
}
