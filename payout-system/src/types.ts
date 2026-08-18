export type UserRole = 'USER' | 'GOTA'

export interface AuthenticatedUser {
  id: string
  username: string
  displayName: string
  role: UserRole
}

export interface Session {
  token: string
  expiresAt: string
  user: AuthenticatedUser
}

export interface EventChoice {
  id: string
  label: string
  eventName: string
  abbreviation: string
}

export type PayoutOutcome = 'GEWONNEN' | 'VERLOREN'
export type EvidenceType = 'BILD' | 'VIDEO'
export type PayoutStatus = 'OFFEN' | 'AUSGEZAHLT'

export interface PayoutRecord {
  id: string
  submittedAt: string
  submittedById: string
  submittedByUsername: string
  submittedByName: string
  eventLabel: string
  eventName: string
  eventAbbreviation: string
  evidenceType: EvidenceType
  evidenceUrl: string
  soldierNames: string[]
  soldierCount: number
  outcome: PayoutOutcome
  status: PayoutStatus
  paidAt?: string
  paidByName?: string
}

export interface ApiErrorPayload {
  code: string
  message: string
}

export interface ApiResult<T> {
  ok: boolean
  data?: T
  error?: ApiErrorPayload
}