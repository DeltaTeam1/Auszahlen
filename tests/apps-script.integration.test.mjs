import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

class FakeRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet
    this.row = row
    this.column = column
    this.rowCount = rowCount
    this.columnCount = columnCount
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) => {
        const sourceRow = this.sheet.rows[this.row - 1 + rowOffset] ?? []
        return sourceRow[this.column - 1 + columnOffset] ?? ''
      }),
    )
  }

  getDisplayValues() {
    return this.getValues().map((row) => row.map((value) => String(value)))
  }
}

class FakeProtection {
  constructor(ownerEmail) {
    this.ownerEmail = ownerEmail
    this.description = ''
    this.warningOnly = false
    this.editorEmails = new Set([ownerEmail])
  }

  setDescription(description) {
    this.description = description
    return this
  }

  setWarningOnly(value) {
    this.warningOnly = value
    return this
  }

  setUnprotectedRanges() {
    return this
  }

  addEditor(user) {
    this.editorEmails.add(user.getEmail())
    return this
  }

  removeEditors() {
    this.editorEmails = new Set([this.ownerEmail])
    return this
  }

  canDomainEdit() {
    return false
  }

  setDomainEdit() {
    return this
  }

  isWarningOnly() {
    return this.warningOnly
  }

  getEditors() {
    return [...this.editorEmails].map((email) => ({ getEmail: () => email }))
  }
}

class FakeSheet {
  constructor(name, rows, ownerEmail) {
    this.name = name
    this.rows = rows
    this.ownerEmail = ownerEmail
    this.protections = []
  }

  getLastRow() {
    return this.rows.length
  }

  getLastColumn() {
    return this.rows.reduce((largest, row) => Math.max(largest, row.length), 0)
  }

  getRange(row, column, rowCount, columnCount) {
    return new FakeRange(this, row, column, rowCount, columnCount)
  }

  appendRow(values) {
    this.rows.push([...values])
    return this
  }

  setFrozenRows() {
    return this
  }

  getProtections() {
    return this.protections
  }

  protect() {
    const protection = new FakeProtection(this.ownerEmail)
    this.protections.push(protection)
    return protection
  }
}

class FakeSpreadsheet {
  constructor(ownerEmail) {
    this.ownerEmail = ownerEmail
    this.sheets = new Map()
  }

  getSheetByName(name) {
    return this.sheets.get(name) ?? null
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name, [], this.ownerEmail)
    this.sheets.set(name, sheet)
    return sheet
  }
}

function signedBytes(buffer) {
  return [...buffer].map((byte) => (byte > 127 ? byte - 256 : byte))
}

async function createRuntime() {
  const ownerEmail = 'owner@example.com'
  const bootstrapPassword = String.fromCharCode(49, 50, 48, 56, 48, 49)
  const spreadsheet = new FakeSpreadsheet(ownerEmail)
  const dataSheet = new FakeSheet(
    'Data',
    [
      ['Event/Kategorie - Abkuerzung'],
      ['Training Alpha - TA'],
      ['Operation Dawn - OD'],
    ],
    ownerEmail,
  )
  spreadsheet.sheets.set('Data', dataSheet)

  const properties = new Map([['INITIAL_GOTA_PASSWORD', bootstrapPassword]])
  const effectiveUser = { getEmail: () => ownerEmail }
  const context = vm.createContext({
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    console,
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({
        text,
        setMimeType() {
          return this
        },
      }),
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutput: (html) => ({
        html,
        setXFrameOptionsMode(mode) {
          this.mode = mode
          return this
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() {},
        releaseLock() {},
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) ?? null,
        setProperty: (key, value) => properties.set(key, value),
        deleteProperty: (key) => properties.delete(key),
      }),
    },
    Session: {
      getEffectiveUser: () => effectiveUser,
    },
    SpreadsheetApp: {
      ProtectionType: { SHEET: 'SHEET' },
      openById: () => spreadsheet,
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64EncodeWebSafe: (value) => Buffer.from(String(value)).toString('base64url'),
      computeDigest: (_algorithm, value) => signedBytes(createHash('sha256').update(String(value)).digest()),
      computeHmacSha256Signature: (value, key) =>
        signedBytes(createHmac('sha256', String(key)).update(String(value)).digest()),
      getUuid: () => randomUUID(),
    },
  })

  const source = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8')
  vm.runInContext(source, context)
  return { bootstrapPassword, context, dataSheet, properties, spreadsheet }
}

test('append-only payout lifecycle preserves Data and source submissions', async () => {
  const { bootstrapPassword, context, dataSheet, properties, spreadsheet } = await createRuntime()
  const dataSnapshot = JSON.stringify(dataSheet.rows)

  const initialized = context.initializeSystem()
  assert.equal(initialized.ok, true)
  assert.equal(initialized.gotaCreated, true)
  assert.equal(properties.has('INITIAL_GOTA_PASSWORD'), false)
  assert.equal(JSON.stringify(dataSheet.rows), dataSnapshot)

  const protectedSheets = [
    'SystemUsers',
    'PayoutSubmissions',
    'PayoutStatusLog',
    'SystemSessions',
    'SessionRevocations',
    'AuthLog',
    'SystemAuditLog',
  ]
  for (const name of protectedSheets) {
    const sheet = spreadsheet.getSheetByName(name)
    assert.ok(sheet)
    assert.equal(sheet.getProtections().length, 1)
    assert.equal(sheet.getProtections()[0].isWarningOnly(), false)
  }

  const users = spreadsheet.getSheetByName('SystemUsers')
  assert.equal(users.rows.length, 2)
  assert.match(users.rows[1][3], /^v1\$/)
  assert.equal(JSON.stringify(users.rows).includes(bootstrapPassword), false)

  context.configureAllowedOrigins('https://example.github.io')
  const bootstrap = context.dispatchRequest_({ action: 'getBootstrap' })
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.events)), [
    {
      id: context.sha256Hex_('event:Training Alpha - TA'),
      label: 'Training Alpha - TA',
      eventName: 'Training Alpha',
      abbreviation: 'TA',
    },
    {
      id: context.sha256Hex_('event:Operation Dawn - OD'),
      label: 'Operation Dawn - OD',
      eventName: 'Operation Dawn',
      abbreviation: 'OD',
    },
  ])

  const registered = context.dispatchRequest_({
    action: 'register',
    username: 'alpha.1',
    displayName: 'Alpha One',
    password: 'correct horse battery staple',
  })
  assert.equal(registered.user.role, 'USER')
  assert.equal(users.rows.length, 3)

  const submission = context.dispatchRequest_({
    action: 'submitPayout',
    sessionToken: registered.token,
    eventId: bootstrap.events[1].id,
    evidenceType: 'BILD',
    evidenceUrl: 'https://example.com/proof.png',
    soldierNames: ['Alpha One', 'Bravo Two'],
    soldierCount: 2,
    outcome: 'GEWONNEN',
  })
  assert.equal(submission.payout.status, 'OFFEN')
  assert.equal(spreadsheet.getSheetByName('PayoutSubmissions').rows.length, 2)
  assert.equal(JSON.stringify(dataSheet.rows), dataSnapshot)

  const sourceRowsBeforePayment = JSON.stringify(spreadsheet.getSheetByName('PayoutSubmissions').rows)
  const gota = context.dispatchRequest_({
    action: 'login',
    username: 'gota',
    password: bootstrapPassword,
  })
  const registerBeforePayment = context.dispatchRequest_({
    action: 'listPayouts',
    sessionToken: gota.token,
  })
  assert.equal(registerBeforePayment.payouts.length, 1)
  assert.equal(registerBeforePayment.payouts[0].status, 'OFFEN')

  const paid = context.dispatchRequest_({
    action: 'markPaid',
    sessionToken: gota.token,
    payoutId: submission.payout.id,
  })
  assert.equal(paid.payout.status, 'AUSGEZAHLT')
  assert.equal(spreadsheet.getSheetByName('PayoutStatusLog').rows.length, 2)
  assert.equal(JSON.stringify(spreadsheet.getSheetByName('PayoutSubmissions').rows), sourceRowsBeforePayment)
  assert.equal(JSON.stringify(dataSheet.rows), dataSnapshot)

  const response = context.doPost({
    parameter: {
      origin: 'https://example.github.io',
      requestId: '00000000-0000-4000-8000-000000000001',
      payload: JSON.stringify({ action: 'getBootstrap' }),
    },
  })
  assert.equal(response.mode, 'ALLOWALL')
  assert.match(response.html, /event-payout-rpc/)
  assert.match(response.html, /https:\/\/example\.github\.io/)
})