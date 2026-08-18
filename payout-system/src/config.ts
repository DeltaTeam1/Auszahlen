declare global {
  interface Window {
    __PAYOUT_CONFIG__?: {
      endpoint?: string
      requestTimeoutMs?: number
    }
  }
}

const configuredEndpoint = window.__PAYOUT_CONFIG__?.endpoint?.trim() ?? ''
const configuredTimeout = window.__PAYOUT_CONFIG__?.requestTimeoutMs

export const appConfig = {
  endpoint: configuredEndpoint,
  requestTimeoutMs:
    typeof configuredTimeout === 'number' && configuredTimeout >= 5_000
      ? configuredTimeout
      : 25_000,
}

export function isEndpointConfigured(): boolean {
  try {
    const endpoint = new URL(appConfig.endpoint)
    return endpoint.protocol === 'https:' && endpoint.hostname === 'script.google.com'
  } catch {
    return false
  }
}