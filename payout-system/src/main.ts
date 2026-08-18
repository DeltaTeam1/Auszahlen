import {
  CheckCircle2,
  ChevronRight,
  CircleCheck,
  ClipboardList,
  Clock3,
  ExternalLink,
  FileText,
  Image,
  LockKeyhole,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  TriangleAlert,
  UserPlus,
  Users,
  Video,
  WalletCards,
  createIcons,
} from 'lucide'
import { isEndpointConfigured } from './config.ts'
import { PayoutApiError, payoutApi } from './rpc.ts'
import type {
  EventChoice,
  EvidenceType,
  PayoutOutcome,
  PayoutRecord,
  PayoutStatus,
  Session,
} from './types.ts'
import './style.css'

type AuthMode = 'login' | 'register'
type AppTab = 'submit' | 'history' | 'payouts'
type NoticeKind = 'success' | 'error' | 'info'

interface Notice {
  kind: NoticeKind
  text: string
}

interface BootstrapResponse {
  events: EventChoice[]
}

interface PayoutListResponse {
  payouts: PayoutRecord[]
}

interface SubmitPayoutResponse {
  payout: PayoutRecord
}

const SESSION_STORAGE_KEY = 'event-payout-session-v1'
const appElement = document.querySelector<HTMLDivElement>('#app')

if (!appElement) {
  throw new Error('Der Anwendungsknoten #app wurde nicht gefunden.')
}

const app: HTMLDivElement = appElement

const state = {
  authMode: 'login' as AuthMode,
  activeTab: 'submit' as AppTab,
  busy: false,
  events: [] as EventChoice[],
  filterStatus: 'ALLE' as 'ALLE' | PayoutStatus,
  filterText: '',
  loading: false,
  notice: null as Notice | null,
  payouts: [] as PayoutRecord[],
  session: readStoredSession(),
}

const iconSet = {
  CheckCircle2,
  ChevronRight,
  CircleCheck,
  ClipboardList,
  Clock3,
  ExternalLink,
  FileText,
  Image,
  LockKeyhole,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  TriangleAlert,
  UserPlus,
  Users,
  Video,
  WalletCards,
}

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return '-'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return escapeHtml(value)
  }

  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<Session>
  return (
    typeof candidate.token === 'string' &&
    typeof candidate.expiresAt === 'string' &&
    typeof candidate.user === 'object' &&
    candidate.user !== null &&
    typeof candidate.user.id === 'string' &&
    typeof candidate.user.username === 'string' &&
    typeof candidate.user.displayName === 'string' &&
    (candidate.user.role === 'USER' || candidate.user.role === 'GOTA')
  )
}

function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const session: unknown = JSON.parse(raw)
    if (!isSession(session) || new Date(session.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(SESSION_STORAGE_KEY)
      return null
    }

    return session
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEY)
    return null
  }
}

function storeSession(session: Session): void {
  state.session = session
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  state.activeTab = session.user.role === 'GOTA' ? 'payouts' : 'submit'
}

function clearSession(): void {
  state.session = null
  state.payouts = []
  state.activeTab = 'submit'
  localStorage.removeItem(SESSION_STORAGE_KEY)
}

function formValue(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name)
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.value.trim()
  }
  return ''
}

function formRawValue(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name)
  return element instanceof HTMLInputElement ? element.value : ''
}

function displayError(error: unknown): string {
  if (error instanceof PayoutApiError) {
    if (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_REVOKED') {
      clearSession()
      return 'Die Sitzung ist abgelaufen. Bitte melde dich erneut an.'
    }
    return error.message
  }

  return 'Der Vorgang konnte nicht abgeschlossen werden. Bitte versuche es erneut.'
}

function setNotice(kind: NoticeKind, text: string): void {
  state.notice = { kind, text }
}

function renderNotice(): string {
  if (!state.notice) {
    return ''
  }

  const icon = state.notice.kind === 'error' ? 'triangle-alert' : 'check-circle-2'
  return `
    <div class="notice notice--${state.notice.kind}" role="status">
      <i data-lucide="${icon}" aria-hidden="true"></i>
      <span>${escapeHtml(state.notice.text)}</span>
    </div>
  `
}

function renderConnectionStatus(): string {
  const ready = isEndpointConfigured()
  const loading = state.loading
  const stateClass = ready && !loading ? 'connection--ready' : 'connection--attention'
  const text = loading
    ? 'Verbindung wird geprueft'
    : ready
      ? 'Dienst konfiguriert'
      : 'Dienst noch nicht eingerichtet'

  return `
    <div class="connection ${stateClass}">
      <span class="connection__dot" aria-hidden="true"></span>
      <span>${text}</span>
    </div>
  `
}

function renderAuth(): string {
  const register = state.authMode === 'register'
  const disabled = state.busy || !isEndpointConfigured() ? 'disabled' : ''
  const actionIcon = register ? 'user-plus' : 'log-in'
  const actionText = register ? 'Zugang anlegen' : 'Anmelden'

  return `
    <div class="auth-shell">
      <aside class="identity-rail" aria-label="Systemkennung">
        <div class="identity-rail__brand">
          <div class="brand-mark" aria-hidden="true"><i data-lucide="shield-check"></i></div>
          <div>
            <p class="eyebrow">Einsatzverwaltung</p>
            <p class="brand-name">EVENT<br>PAYMENTS</p>
          </div>
        </div>
        <div class="identity-rail__copy">
          <p class="rail-index">01 / AUSZAHLUNG</p>
          <h1>Jede Meldung bleibt nachvollziehbar.</h1>
          <p>Erfasse die Besetzung, den Einsatz und den Nachweis in einem geschuetzten Register.</p>
        </div>
        <div class="rail-steps" aria-label="Ablauf">
          <div><span>01</span><p>Meldung erfassen</p></div>
          <div><span>02</span><p>Pruefung im Register</p></div>
          <div><span>03</span><p>Auszahlung markieren</p></div>
        </div>
        ${renderConnectionStatus()}
      </aside>
      <main class="auth-main">
        <div class="auth-main__inner">
          <div class="auth-heading">
            <p class="eyebrow">Geschuetzter Zugang</p>
            <h2>${register ? 'Neuen Benutzer anlegen' : 'Anmeldung'}</h2>
            <p>Dein Konto ordnet jede Meldung dauerhaft dem richtigen Benutzer zu.</p>
          </div>
          <section class="auth-panel" aria-label="Zugangsdaten">
            <div class="auth-switch" role="tablist" aria-label="Zugangsart">
              <button class="${!register ? 'is-active' : ''}" type="button" role="tab" data-action="auth-mode" data-mode="login">Anmelden</button>
              <button class="${register ? 'is-active' : ''}" type="button" role="tab" data-action="auth-mode" data-mode="register">Registrieren</button>
            </div>
            ${
              !isEndpointConfigured()
                ? `
                  <div class="setup-callout">
                    <i data-lucide="lock-keyhole" aria-hidden="true"></i>
                    <p>Die Google-Apps-Script-Web-App muss zuerst in <code>runtime-config.js</code> hinterlegt werden.</p>
                  </div>
                `
                : ''
            }
            <form id="auth-form" novalidate>
              ${
                register
                  ? `
                    <label class="field">
                      <span>Anzeigename</span>
                      <input name="displayName" autocomplete="name" maxlength="80" required placeholder="Name im Register">
                    </label>
                  `
                  : ''
              }
              <label class="field">
                <span>Benutzername</span>
                <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="40" required placeholder="z. B. alpha.1">
              </label>
              <label class="field">
                <span>Passwort</span>
                <input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="${register ? '10' : '1'}" required>
              </label>
              ${
                register
                  ? `
                    <label class="field">
                      <span>Passwort wiederholen</span>
                      <input name="passwordConfirm" type="password" autocomplete="new-password" minlength="10" required>
                    </label>
                  `
                  : ''
              }
              <button class="button button--primary button--wide" type="submit" ${disabled}>
                <i data-lucide="${actionIcon}" aria-hidden="true"></i>
                <span>${state.busy ? 'Bitte warten' : actionText}</span>
                <i data-lucide="chevron-right" aria-hidden="true"></i>
              </button>
            </form>
          </section>
        </div>
      </main>
    </div>
  `
}

function renderSidebar(): string {
  const session = state.session
  if (!session) {
    return ''
  }

  const isGota = session.user.role === 'GOTA'
  const active = (tab: AppTab): string => (state.activeTab === tab ? 'is-active' : '')

  return `
    <aside class="side-nav">
      <div class="side-nav__head">
        <div class="brand-mark brand-mark--compact" aria-hidden="true"><i data-lucide="shield-check"></i></div>
        <div>
          <p class="eyebrow">Einsatzverwaltung</p>
          <p class="side-nav__title">EVENT<br>PAYMENTS</p>
        </div>
      </div>
      <div class="operator">
        <span class="operator__initials">${escapeHtml(getInitials(session.user.displayName))}</span>
        <div>
          <strong>${escapeHtml(session.user.displayName)}</strong>
          <span>${isGota ? 'GOTA / Freigabe' : `@${escapeHtml(session.user.username)}`}</span>
        </div>
      </div>
      <nav class="nav-list" aria-label="Arbeitsbereiche">
        ${
          isGota
            ? `
              <button class="${active('payouts')}" type="button" data-action="tab" data-tab="payouts">
                <i data-lucide="wallet-cards" aria-hidden="true"></i><span>Auszahlungsregister</span>
              </button>
            `
            : `
              <button class="${active('submit')}" type="button" data-action="tab" data-tab="submit">
                <i data-lucide="file-text" aria-hidden="true"></i><span>Neue Meldung</span>
              </button>
              <button class="${active('history')}" type="button" data-action="tab" data-tab="history">
                <i data-lucide="clipboard-list" aria-hidden="true"></i><span>Meine Meldungen</span>
              </button>
            `
        }
      </nav>
      <div class="side-nav__foot">
        ${renderConnectionStatus()}
        <button class="button button--ghost button--wide" title="Sitzung beenden" type="button" data-action="logout" ${state.busy ? 'disabled' : ''}>
          <i data-lucide="log-out" aria-hidden="true"></i><span>Abmelden</span>
        </button>
      </div>
    </aside>
  `
}

function renderStats(): string {
  const open = state.payouts.filter((payout) => payout.status === 'OFFEN').length
  const paid = state.payouts.filter((payout) => payout.status === 'AUSGEZAHLT').length
  const isGota = state.session?.user.role === 'GOTA'

  return `
    <section class="stat-strip" aria-label="Registerstatus">
      <div><span>${state.payouts.length}</span><p>${isGota ? 'Eintraege' : 'Meine Meldungen'}</p></div>
      <div><span>${open}</span><p>Offen</p></div>
      <div><span>${paid}</span><p>Ausgezahlt</p></div>
    </section>
  `
}

function renderPayoutForm(): string {
  const disabled = state.busy || state.loading || state.events.length === 0 ? 'disabled' : ''
  const eventOptions = state.events
    .map(
      (event) =>
        `<option value="${escapeHtml(event.id)}">${escapeHtml(event.label)}</option>`,
    )
    .join('')

  return `
    <section class="work-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Neue Einsatzmeldung</p>
          <h2>Auszahlung erfassen</h2>
        </div>
        <span class="record-rule"><i data-lucide="lock-keyhole" aria-hidden="true"></i>Append-only Register</span>
      </div>
      ${
        state.events.length === 0
          ? `
            <div class="empty-state empty-state--compact">
              <i data-lucide="triangle-alert" aria-hidden="true"></i>
              <div><strong>${state.loading ? 'Ereignisse werden geladen' : 'Keine Ereignisse verfuegbar'}</strong><p>Die Auswahl kommt ausschliesslich aus dem Tabellenblatt Data.</p></div>
            </div>
          `
          : ''
      }
      <form id="payout-form" class="payout-form" novalidate>
        <div class="form-grid">
          <label class="field field--wide">
            <span>Event / Kategorie - Abkuerzung</span>
            <select name="eventId" required ${disabled}>
              <option value="">Einsatz auswaehlen</option>
              ${eventOptions}
            </select>
          </label>
          <fieldset class="field-group">
            <legend>Nachweisart</legend>
            <div class="segmented-control">
              <label><input type="radio" name="evidenceType" value="BILD" checked ${disabled}><span><i data-lucide="image" aria-hidden="true"></i>Bild</span></label>
              <label><input type="radio" name="evidenceType" value="VIDEO" ${disabled}><span><i data-lucide="video" aria-hidden="true"></i>Video</span></label>
            </div>
          </fieldset>
          <label class="field field--wide">
            <span>Link zum Nachweis</span>
            <input name="evidenceUrl" type="url" inputmode="url" autocomplete="url" placeholder="https://..." maxlength="2048" required ${disabled}>
          </label>
          <label class="field field--wide">
            <span>Namen der Soldaten</span>
            <textarea name="soldierNames" rows="5" maxlength="5000" required placeholder="Ein Name pro Zeile oder durch Komma getrennt" ${disabled}></textarea>
          </label>
          <label class="field">
            <span>Anzahl Soldaten</span>
            <input name="soldierCount" type="number" min="1" max="10000" step="1" required ${disabled}>
          </label>
          <fieldset class="field-group">
            <legend>Ausgang</legend>
            <div class="segmented-control segmented-control--outcome">
              <label><input type="radio" name="outcome" value="GEWONNEN" checked ${disabled}><span><i data-lucide="check-circle-2" aria-hidden="true"></i>Gewonnen</span></label>
              <label><input type="radio" name="outcome" value="VERLOREN" ${disabled}><span><i data-lucide="triangle-alert" aria-hidden="true"></i>Verloren</span></label>
            </div>
          </fieldset>
        </div>
        <div class="form-footer">
          <p>Mit dem Absenden wird eine neue, unveraenderbare Meldung im Register angelegt.</p>
          <button class="button button--primary" type="submit" ${disabled}>
            <i data-lucide="send" aria-hidden="true"></i><span>${state.busy ? 'Wird gespeichert' : 'Meldung absenden'}</span>
          </button>
        </div>
      </form>
    </section>
  `
}

function renderEvidenceLink(payout: PayoutRecord): string {
  const href = safeUrl(payout.evidenceUrl)
  if (!href) {
    return '<span class="muted">Kein gueltiger Link</span>'
  }

  const icon = payout.evidenceType === 'VIDEO' ? 'video' : 'image'
  return `
    <a class="evidence-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
      <i data-lucide="${icon}" aria-hidden="true"></i><span>${payout.evidenceType === 'VIDEO' ? 'Video oeffnen' : 'Bild oeffnen'}</span><i data-lucide="external-link" aria-hidden="true"></i>
    </a>
  `
}

function statusLabel(status: PayoutStatus): string {
  return status === 'AUSGEZAHLT' ? 'Ausgezahlt' : 'Offen'
}

function renderPayoutCard(payout: PayoutRecord, isGota: boolean): string {
  const payoutId = escapeHtml(payout.id)
  const canPay = isGota && payout.status === 'OFFEN'
  const soldierNames = payout.soldierNames
    .map((name) => `<li>${escapeHtml(name)}</li>`)
    .join('')

  return `
    <article class="payout-card">
      <div class="payout-card__top">
        <div>
          <p class="payout-card__event">${escapeHtml(payout.eventLabel)}</p>
          <p class="payout-card__meta">${escapeHtml(payout.submittedByName)} <span aria-hidden="true">/</span> ${formatDate(payout.submittedAt)}</p>
        </div>
        <span class="status status--${payout.status.toLowerCase()}">${statusLabel(payout.status)}</span>
      </div>
      <div class="payout-card__body">
        <div class="payout-card__facts">
          <span><i data-lucide="users" aria-hidden="true"></i>${payout.soldierCount} Soldaten</span>
          <span class="outcome outcome--${payout.outcome.toLowerCase()}">${payout.outcome === 'GEWONNEN' ? 'Gewonnen' : 'Verloren'}</span>
        </div>
        <div class="soldier-list"><span>Besetzung</span><ul>${soldierNames}</ul></div>
        ${renderEvidenceLink(payout)}
      </div>
      <div class="payout-card__foot">
        <span>${payout.status === 'AUSGEZAHLT' ? `Markiert: ${formatDate(payout.paidAt)}` : 'Wartet auf Auszahlung'}</span>
        ${
          canPay
            ? `
              <button class="button button--paid" type="button" data-action="mark-paid" data-payout-id="${payoutId}" ${state.busy ? 'disabled' : ''}>
                <i data-lucide="circle-check" aria-hidden="true"></i><span>Ausgezahlt markieren</span>
              </button>
            `
            : ''
        }
      </div>
    </article>
  `
}

function renderEmptyRegister(isGota: boolean): string {
  return `
    <div class="empty-state">
      <i data-lucide="clipboard-list" aria-hidden="true"></i>
      <div>
        <strong>${isGota ? 'Keine Eintraege im Register' : 'Noch keine Meldungen'}</strong>
        <p>${isGota ? 'Neue Meldungen erscheinen hier automatisch nach der Erfassung.' : 'Deine gespeicherten Meldungen erscheinen hier dauerhaft.'}</p>
      </div>
    </div>
  `
}

function renderHistory(): string {
  return `
    <section class="work-section">
      <div class="section-heading">
        <div><p class="eyebrow">Persoenliches Register</p><h2>Meine Meldungen</h2></div>
        <span class="record-rule"><i data-lucide="clipboard-list" aria-hidden="true"></i>${state.payouts.length} Eintraege</span>
      </div>
      <div class="payout-grid">
        ${state.payouts.length ? state.payouts.map((payout) => renderPayoutCard(payout, false)).join('') : renderEmptyRegister(false)}
      </div>
    </section>
  `
}

function filteredPayouts(): PayoutRecord[] {
  const search = state.filterText.trim().toLocaleLowerCase('de-DE')
  return state.payouts.filter((payout) => {
    const statusMatches = state.filterStatus === 'ALLE' || payout.status === state.filterStatus
    if (!search) {
      return statusMatches
    }

    const haystack = [
      payout.eventLabel,
      payout.submittedByName,
      payout.submittedByUsername,
      payout.soldierNames.join(' '),
    ]
      .join(' ')
      .toLocaleLowerCase('de-DE')
    return statusMatches && haystack.includes(search)
  })
}

function renderGotaPayouts(): string {
  const payouts = filteredPayouts()
  return `
    <section class="work-section">
      <div class="section-heading">
        <div><p class="eyebrow">GOTA / Freigabe</p><h2>Auszahlungsregister</h2></div>
        <span class="record-rule"><i data-lucide="lock-keyhole" aria-hidden="true"></i>Keine Loeschfunktion</span>
      </div>
      <div class="register-controls">
        <label class="search-field"><i data-lucide="search" aria-hidden="true"></i><input id="payout-search" type="search" value="${escapeHtml(state.filterText)}" placeholder="Name, Event oder Besetzung filtern"></label>
        <select id="payout-status-filter" aria-label="Auszahlungsstatus filtern">
          <option value="ALLE" ${state.filterStatus === 'ALLE' ? 'selected' : ''}>Alle Status</option>
          <option value="OFFEN" ${state.filterStatus === 'OFFEN' ? 'selected' : ''}>Offen</option>
          <option value="AUSGEZAHLT" ${state.filterStatus === 'AUSGEZAHLT' ? 'selected' : ''}>Ausgezahlt</option>
        </select>
      </div>
      <p class="register-result">${payouts.length} ${payouts.length === 1 ? 'Eintrag' : 'Eintraege'} angezeigt</p>
      <div class="payout-grid">
        ${payouts.length ? payouts.map((payout) => renderPayoutCard(payout, true)).join('') : renderEmptyRegister(true)}
      </div>
    </section>
  `
}

function renderDashboard(): string {
  const session = state.session
  if (!session) {
    return renderAuth()
  }

  const isGota = session.user.role === 'GOTA'
  const pageTitle = isGota
    ? 'Freigabe und Uebersicht'
    : state.activeTab === 'history'
      ? 'Dein Einsatzregister'
      : 'Neue Einsatzmeldung'
  const content = isGota
    ? renderGotaPayouts()
    : state.activeTab === 'history'
      ? renderHistory()
      : renderPayoutForm()

  return `
    <div class="dashboard-shell">
      ${renderSidebar()}
      <main class="workspace">
        <header class="topbar">
          <div><p class="eyebrow">${isGota ? 'GOTA / Auszahlungen' : 'Einsatzmeldung'}</p><h1>${pageTitle}</h1></div>
          <button class="icon-button" type="button" data-action="refresh" title="Daten aktualisieren" aria-label="Daten aktualisieren" ${state.busy ? 'disabled' : ''}>
            <i data-lucide="refresh-cw" aria-hidden="true"></i>
          </button>
        </header>
        ${renderStats()}
        ${content}
      </main>
    </div>
  `
}

function render(): void {
  app.innerHTML = `${renderNotice()}${state.session ? renderDashboard() : renderAuth()}`
  createIcons({
    icons: iconSet,
    attrs: {
      'aria-hidden': 'true',
      'stroke-width': 1.8,
    },
  })
  wireInteractions()
}

function parseSoldierNames(value: string): string[] {
  return [...new Set(value.split(/[\n,;]/).map((name) => name.trim()).filter(Boolean))]
}

async function fetchData(): Promise<void> {
  const bootstrap = await payoutApi.call<BootstrapResponse>('getBootstrap')
  state.events = bootstrap.events

  if (state.session) {
    const register = await payoutApi.call<PayoutListResponse>('listPayouts', {
      sessionToken: state.session.token,
    })
    state.payouts = register.payouts
  }
}

async function withBusy(operation: () => Promise<void>): Promise<void> {
  if (state.busy) {
    return
  }

  state.busy = true
  render()
  try {
    await operation()
  } catch (error) {
    setNotice('error', displayError(error))
  } finally {
    state.busy = false
    render()
  }
}

async function submitAuth(form: HTMLFormElement): Promise<void> {
  const username = formValue(form, 'username').toLowerCase()
  const password = formRawValue(form, 'password')

  if (!username || !password) {
    setNotice('error', 'Bitte fuelle Benutzername und Passwort aus.')
    render()
    return
  }

  if (state.authMode === 'register') {
    const displayName = formValue(form, 'displayName')
    const passwordConfirm = formRawValue(form, 'passwordConfirm')
    if (!displayName || password.length < 10) {
      setNotice('error', 'Bitte verwende einen Anzeigenamen und mindestens zehn Passwortzeichen.')
      render()
      return
    }
    if (password !== passwordConfirm) {
      setNotice('error', 'Die beiden Passwoerter stimmen nicht ueberein.')
      render()
      return
    }

    await withBusy(async () => {
      const session = await payoutApi.call<Session>('register', {
        username,
        displayName,
        password,
      })
      storeSession(session)
      await fetchData()
      setNotice('success', 'Dein Zugang wurde angelegt.')
    })
    return
  }

  await withBusy(async () => {
    const session = await payoutApi.call<Session>('login', { username, password })
    storeSession(session)
    await fetchData()
    setNotice('success', `Willkommen, ${session.user.displayName}.`)
  })
}

async function submitPayout(form: HTMLFormElement): Promise<void> {
  const eventId = formValue(form, 'eventId')
  const evidenceUrl = formValue(form, 'evidenceUrl')
  const soldierNames = parseSoldierNames(formValue(form, 'soldierNames'))
  const soldierCount = Number(formValue(form, 'soldierCount'))
  const formData = new FormData(form)
  const evidenceType = formData.get('evidenceType') as EvidenceType | null
  const outcome = formData.get('outcome') as PayoutOutcome | null

  if (!eventId || !safeUrl(evidenceUrl) || !soldierNames.length || !Number.isInteger(soldierCount) || soldierCount < 1 || !evidenceType || !outcome) {
    setNotice('error', 'Bitte pruefe Event, Link, Besetzung, Anzahl und Ausgang.')
    render()
    return
  }

  if (soldierNames.length > soldierCount) {
    setNotice('error', 'Die Anzahl Soldaten darf nicht kleiner als die erfassten Namen sein.')
    render()
    return
  }

  await withBusy(async () => {
    const response = await payoutApi.call<SubmitPayoutResponse>('submitPayout', {
      sessionToken: state.session?.token,
      eventId,
      evidenceType,
      evidenceUrl,
      soldierNames,
      soldierCount,
      outcome,
    })
    state.payouts = [response.payout, ...state.payouts]
    state.activeTab = 'history'
    setNotice('success', 'Die Meldung wurde dauerhaft im Register gespeichert.')
  })
}

async function markPaid(payoutId: string): Promise<void> {
  const payout = state.payouts.find((entry) => entry.id === payoutId)
  if (!payout || payout.status !== 'OFFEN') {
    return
  }

  if (!window.confirm(`Auszahlung fuer ${payout.submittedByName} als ausgezahlt markieren?`)) {
    return
  }

  await withBusy(async () => {
    await payoutApi.call<SubmitPayoutResponse>('markPaid', {
      sessionToken: state.session?.token,
      payoutId,
    })
    await fetchData()
    setNotice('success', 'Die Auszahlung wurde als ausgezahlt protokolliert.')
  })
}

async function refresh(): Promise<void> {
  if (!isEndpointConfigured()) {
    setNotice('error', 'Die Web-App-URL wurde noch nicht eingerichtet.')
    render()
    return
  }

  await withBusy(async () => {
    await fetchData()
    setNotice('info', 'Register und Ereignisse wurden aktualisiert.')
  })
}

async function logout(): Promise<void> {
  const token = state.session?.token
  await withBusy(async () => {
    try {
      if (token) {
        await payoutApi.call<Record<string, never>>('logout', { sessionToken: token })
      }
    } finally {
      clearSession()
      setNotice('info', 'Die Sitzung wurde beendet.')
    }
  })
}

function wireInteractions(): void {
  app.querySelector<HTMLFormElement>('#auth-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitAuth(event.currentTarget as HTMLFormElement)
  })

  app.querySelector<HTMLFormElement>('#payout-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitPayout(event.currentTarget as HTMLFormElement)
  })

  app.querySelectorAll<HTMLButtonElement>('[data-action="auth-mode"]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode
      if (mode !== 'login' && mode !== 'register') {
        return
      }
      state.authMode = mode
      state.notice = null
      render()
    })
  })

  app.querySelectorAll<HTMLButtonElement>('[data-action="tab"]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset.tab
      if (tab !== 'submit' && tab !== 'history' && tab !== 'payouts') {
        return
      }
      state.activeTab = tab
      render()
    })
  })

  app.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener('click', () => {
    void refresh()
  })

  app.querySelector<HTMLButtonElement>('[data-action="logout"]')?.addEventListener('click', () => {
    void logout()
  })

  app.querySelectorAll<HTMLButtonElement>('[data-action="mark-paid"]').forEach((button) => {
    button.addEventListener('click', () => {
      const payoutId = button.dataset.payoutId
      if (payoutId) {
        void markPaid(payoutId)
      }
    })
  })

  app.querySelector<HTMLInputElement>('#payout-search')?.addEventListener('input', (event) => {
    state.filterText = (event.currentTarget as HTMLInputElement).value
    render()
  })

  app.querySelector<HTMLSelectElement>('#payout-status-filter')?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value
    if (value === 'ALLE' || value === 'OFFEN' || value === 'AUSGEZAHLT') {
      state.filterStatus = value
      render()
    }
  })
}

async function initialize(): Promise<void> {
  render()
  if (!isEndpointConfigured()) {
    return
  }

  state.loading = true
  render()
  try {
    await fetchData()
  } catch (error) {
    setNotice('error', displayError(error))
  } finally {
    state.loading = false
    render()
  }
}

void initialize()
