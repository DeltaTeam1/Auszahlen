import { appConfig, isEndpointConfigured } from './config.ts'
import type { ApiErrorPayload, ApiResult } from './types.ts'

const MESSAGE_CHANNEL = 'event-payout-rpc'

interface RpcEnvelope {
  channel: string
  requestId: string
  result: ApiResult<unknown>
}

interface PendingRequest {
  iframe: HTMLIFrameElement
  form: HTMLFormElement
  timer: number
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

const pendingRequests = new Map<string, PendingRequest>()
let listenerInstalled = false

export class PayoutApiError extends Error {
  readonly code: string

  constructor(error: ApiErrorPayload) {
    super(error.message)
    this.name = 'PayoutApiError'
    this.code = error.code
  }
}

function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<RpcEnvelope>
  return (
    candidate.channel === MESSAGE_CHANNEL &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.result === 'object' &&
    candidate.result !== null
  )
}

function cleanup(requestId: string): PendingRequest | undefined {
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return undefined
  }

  window.clearTimeout(pending.timer)
  pendingRequests.delete(requestId)
  pending.form.remove()
  pending.iframe.remove()
  return pending
}

function installMessageListener(): void {
  if (listenerInstalled) {
    return
  }

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isRpcEnvelope(event.data)) {
      return
    }

    const pending = pendingRequests.get(event.data.requestId)
    if (!pending || event.source !== pending.iframe.contentWindow) {
      return
    }

    const completed = cleanup(event.data.requestId)
    if (!completed) {
      return
    }

    if (event.data.result.ok) {
      completed.resolve(event.data.result.data)
      return
    }

    completed.reject(
      new PayoutApiError(
        event.data.result.error ?? {
          code: 'UNKNOWN_ERROR',
          message: 'Der Server hat keine verwertbare Antwort geliefert.',
        },
      ),
    )
  })

  listenerInstalled = true
}

function appendField(form: HTMLFormElement, name: string, value: string): void {
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = name
  input.value = value
  form.append(input)
}

export class PayoutApi {
  call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!isEndpointConfigured()) {
      return Promise.reject(
        new PayoutApiError({
          code: 'ENDPOINT_NOT_CONFIGURED',
          message:
            'Die Verbindung zum Auszahlungsdienst ist noch nicht eingerichtet.',
        }),
      )
    }

    installMessageListener()

    return new Promise<T>((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const iframe = document.createElement('iframe')
      const form = document.createElement('form')

      iframe.name = `payout-rpc-${requestId}`
      iframe.title = 'Auszahlungsdienst'
      iframe.hidden = true
      iframe.setAttribute('aria-hidden', 'true')

      form.method = 'post'
      form.action = appConfig.endpoint
      form.target = iframe.name
      form.hidden = true
      appendField(form, 'origin', window.location.origin)
      appendField(form, 'requestId', requestId)
      appendField(form, 'payload', JSON.stringify({ action, ...payload }))

      document.body.append(iframe, form)

      const timer = window.setTimeout(() => {
        const expired = cleanup(requestId)
        expired?.reject(
          new PayoutApiError({
            code: 'REQUEST_TIMEOUT',
            message:
              'Der Auszahlungsdienst antwortet nicht. Bitte pruefe die Bereitstellung.',
          }),
        )
      }, appConfig.requestTimeoutMs)

      pendingRequests.set(requestId, {
        iframe,
        form,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      })
      form.submit()
    })
  }
}

export const payoutApi = new PayoutApi()