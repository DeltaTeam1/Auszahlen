const CONFIG = Object.freeze({
  SPREADSHEET_ID: '1-4DdMUvW3P2DuLCQkQgCVITedywN5PLkaqJgbIFKL1E',
  DATA_SHEET_NAME: 'Data',
  SESSION_DURATION_MS: 8 * 60 * 60 * 1000,
  LOGIN_WINDOW_MS: 15 * 60 * 1000,
  MAX_LOGIN_FAILURES: 5,
  PASSWORD_ROUNDS: 10000,
  GOTA_BOOTSTRAP_PASSWORD_SHA256: '0b155a8e953642f2ef3e82781ad19b6b128ea5e77cbd2f841053c46d36529bd4',
  RPC_CHANNEL: 'event-payout-rpc',
  PROTECTION_DESCRIPTION_PREFIX: 'Event payout system: ',
});

const SHEETS = Object.freeze({
  USERS: {
    name: 'SystemUsers',
    headers: [
      'user_id',
      'username',
      'display_name',
      'password_hash',
      'password_salt',
      'role',
      'is_active',
      'created_at',
      'created_by',
    ],
  },
  SUBMISSIONS: {
    name: 'PayoutSubmissions',
    headers: [
      'submission_id',
      'submitted_at',
      'submitted_by_id',
      'submitted_by_username',
      'submitted_by_name',
      'event_id',
      'event_label',
      'event_name',
      'event_abbreviation',
      'evidence_type',
      'evidence_url',
      'soldier_names_json',
      'soldier_count',
      'outcome',
      'source',
    ],
  },
  STATUS_LOG: {
    name: 'PayoutStatusLog',
    headers: [
      'status_log_id',
      'submission_id',
      'status',
      'recorded_at',
      'recorded_by_id',
      'recorded_by_username',
      'recorded_by_name',
      'note',
    ],
  },
  SESSIONS: {
    name: 'SystemSessions',
    headers: [
      'session_id',
      'user_id',
      'token_hash',
      'created_at',
      'expires_at',
      'issued_from',
    ],
  },
  SESSION_REVOCATIONS: {
    name: 'SessionRevocations',
    headers: ['revocation_id', 'token_hash', 'revoked_at', 'revoked_by_id'],
  },
  AUTH_LOG: {
    name: 'AuthLog',
    headers: ['auth_log_id', 'occurred_at', 'username', 'action', 'succeeded', 'detail'],
  },
  AUDIT_LOG: {
    name: 'SystemAuditLog',
    headers: [
      'audit_id',
      'occurred_at',
      'actor_id',
      'actor_username',
      'action',
      'subject_id',
      'detail_json',
    ],
  },
});

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/**
 * Run this once from the Apps Script editor while signed into the spreadsheet
 * owner account. It creates only new system tabs; the Data tab is read-only.
 */
function initializeSystem() {
  return withScriptLock_(function () {
    const spreadsheet = getSpreadsheet_();
    requireDataSheet_(spreadsheet);

    Object.keys(SHEETS).forEach(function (key) {
      ensureSystemSheet_(spreadsheet, SHEETS[key]);
    });

    ensureSecretProperty_('PASSWORD_PEPPER');
    ensureSecretProperty_('SESSION_PEPPER');

    let gota = findUserByUsername_('gota');
    let gotaCreated = false;
    if (!gota) {
      const properties = PropertiesService.getScriptProperties();
      const initialPassword = properties.getProperty('INITIAL_GOTA_PASSWORD');
      if (sha256Hex_(initialPassword) !== CONFIG.GOTA_BOOTSTRAP_PASSWORD_SHA256) {
        throw new Error(
          'Setze vor initializeSystem die Script Property INITIAL_GOTA_PASSWORD auf den vorgesehenen GOTA-Wert.',
        );
      }

      gota = createUser_({
        username: 'gota',
        displayName: 'GOTA',
        password: initialPassword,
        role: 'GOTA',
        createdBy: 'SYSTEM_BOOTSTRAP',
      });
      properties.deleteProperty('INITIAL_GOTA_PASSWORD');
      gotaCreated = true;
    }

    protectSystemSheets_(spreadsheet);
    appendAudit_(gota, 'SYSTEM_INITIALIZED', CONFIG.SPREADSHEET_ID, {
      gotaCreated: gotaCreated,
      dataSheetUntouched: true,
    });

    return {
      ok: true,
      gotaCreated: gotaCreated,
      protectedSheets: Object.keys(SHEETS).map(function (key) {
        return SHEETS[key].name;
      }),
    };
  });
}

/**
 * Configure exact origins only, for example:
 * configureAllowedOrigins('http://localhost:5173,https://account.github.io')
 */
function configureAllowedOrigins(origins) {
  const values = String(origins || '')
    .split(',')
    .map(function (origin) {
      return normalizeOrigin_(origin);
    })
    .filter(function (origin, index, all) {
      return origin && all.indexOf(origin) === index;
    });

  if (!values.length) {
    throw new Error('Mindestens eine erlaubte Origin ist erforderlich.');
  }

  PropertiesService.getScriptProperties().setProperty('ALLOWED_ORIGINS', values.join(','));
  return values;
}

/**
 * Read-only helper for the owner to confirm the append-only storage lock.
 */
function verifySystemProtection() {
  const spreadsheet = getSpreadsheet_();
  return Object.keys(SHEETS).map(function (key) {
    const definition = SHEETS[key];
    const sheet = requireSystemSheet_(spreadsheet, definition);
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    const protection = protections[0];
    return {
      sheet: definition.name,
      protected: Boolean(protection),
      warningOnly: protection ? protection.isWarningOnly() : null,
      editorEmails: protection
        ? protection.getEditors().map(function (editor) {
            return editor.getEmail();
          })
        : [],
    };
  });
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({
      service: 'event-payout-system',
      status: 'ready',
      message: 'Use the configured application client for requests.',
    }),
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(event) {
  const parameter = (event && event.parameter) || {};
  const requestId = sanitizeRequestId_(parameter.requestId);
  const requestedOrigin = safeNormalizeOrigin_(parameter.origin);
  const allowedOrigins = getAllowedOrigins_();
  const targetOrigin = allowedOrigins.indexOf(requestedOrigin) !== -1 ? requestedOrigin : allowedOrigins[0];

  if (!targetOrigin) {
    return HtmlService.createHtmlOutput('Origin configuration missing.');
  }

  let result;
  if (allowedOrigins.indexOf(requestedOrigin) === -1) {
    result = failure_('INVALID_ORIGIN', 'Diese Website ist nicht fuer den Dienst freigegeben.');
  } else if (!requestId) {
    result = failure_('INVALID_REQUEST', 'Die Anforderung ist unvollstaendig.');
  } else {
    try {
      const payload = parsePayload_(parameter.payload);
      result = success_(dispatchRequest_(payload));
    } catch (error) {
      result = toFailure_(error);
    }
  }

  return createPostMessageOutput_(targetOrigin, requestId, result);
}

function dispatchRequest_(payload) {
  const action = requireString_(payload.action, 'action', 40);
  switch (action) {
    case 'getBootstrap':
      return { events: getEventChoices_() };
    case 'register':
      return register_(payload);
    case 'login':
      return login_(payload);
    case 'logout':
      return logout_(payload);
    case 'listPayouts':
      return listPayouts_(payload);
    case 'submitPayout':
      return submitPayout_(payload);
    case 'markPaid':
      return markPaid_(payload);
    default:
      throw new RpcError('UNKNOWN_ACTION', 'Diese Aktion ist nicht erlaubt.');
  }
}

function register_(payload) {
  const username = normalizeUsername_(payload.username);
  const displayName = normalizeDisplayName_(payload.displayName);
  const password = validateNewPassword_(payload.password);

  if (username === 'gota') {
    throw new RpcError('RESERVED_USERNAME', 'Dieser Benutzername ist reserviert.');
  }

  return withScriptLock_(function () {
    assertSystemReady_();
    if (findUserByUsername_(username)) {
      appendAuthLog_(username, 'REGISTRATION_REJECTED', false, 'USERNAME_EXISTS');
      throw new RpcError('USERNAME_EXISTS', 'Dieser Benutzername ist bereits vergeben.');
    }

    const user = createUser_({
      username: username,
      displayName: displayName,
      password: password,
      role: 'USER',
      createdBy: 'SELF_REGISTRATION',
    });
    appendAuthLog_(username, 'REGISTRATION_SUCCEEDED', true, 'USER_CREATED');
    appendAudit_(user, 'USER_REGISTERED', user.id, { role: user.role });
    return createSession_(user, 'REGISTER');
  });
}

function login_(payload) {
  const username = normalizeUsername_(payload.username);
  const password = requirePassword_(payload.password);

  return withScriptLock_(function () {
    assertSystemReady_();
    assertLoginAllowed_(username);

    const user = findUserByUsername_(username);
    const candidateHash = user ? hashPassword_(password, user.passwordSalt) : hashPassword_(password, randomSecret_());
    const passwordMatches = user && constantTimeEquals_(candidateHash, user.passwordHash);

    if (!user || !user.isActive || !passwordMatches) {
      appendAuthLog_(username, 'LOGIN_FAILED', false, 'INVALID_CREDENTIALS');
      throw new RpcError('INVALID_CREDENTIALS', 'Benutzername oder Passwort ist nicht korrekt.');
    }

    appendAuthLog_(username, 'LOGIN_SUCCEEDED', true, 'SESSION_CREATED');
    appendAudit_(user, 'USER_LOGGED_IN', user.id, {});
    return createSession_(user, 'LOGIN');
  });
}

function logout_(payload) {
  return withScriptLock_(function () {
    const session = assertSession_(payload.sessionToken);
    appendRow_(SHEETS.SESSION_REVOCATIONS, [
      Utilities.getUuid(),
      session.tokenHash,
      nowIso_(),
      session.user.id,
    ]);
    appendAudit_(session.user, 'SESSION_REVOKED', session.sessionId, {});
    return {};
  });
}

function listPayouts_(payload) {
  const session = assertSession_(payload.sessionToken);
  const payouts = getPayouts_();
  const visible = session.user.role === 'GOTA'
    ? payouts
    : payouts.filter(function (payout) {
        return payout.submittedById === session.user.id;
      });
  return { payouts: visible };
}

function submitPayout_(payload) {
  return withScriptLock_(function () {
    const session = assertSession_(payload.sessionToken);
    if (session.user.role !== 'USER') {
      throw new RpcError('FORBIDDEN', 'Nur Benutzerkonten duerfen neue Meldungen erfassen.');
    }

    const eventId = requireString_(payload.eventId, 'eventId', 128);
    const event = getEventChoices_().filter(function (choice) {
      return choice.id === eventId;
    })[0];
    if (!event) {
      throw new RpcError('INVALID_EVENT', 'Das gewaehlte Event ist nicht mehr in Data vorhanden.');
    }

    const evidenceType = payload.evidenceType;
    if (evidenceType !== 'BILD' && evidenceType !== 'VIDEO') {
      throw new RpcError('INVALID_EVIDENCE_TYPE', 'Die Nachweisart ist nicht gueltig.');
    }

    const evidenceUrl = validateHttpUrl_(payload.evidenceUrl);
    const soldierNames = normalizeSoldierNames_(payload.soldierNames);
    const soldierCount = validateSoldierCount_(payload.soldierCount, soldierNames.length);
    const outcome = payload.outcome;
    if (outcome !== 'GEWONNEN' && outcome !== 'VERLOREN') {
      throw new RpcError('INVALID_OUTCOME', 'Der Ausgang ist nicht gueltig.');
    }

    const submissionId = Utilities.getUuid();
    const submittedAt = nowIso_();
    appendRow_(SHEETS.SUBMISSIONS, [
      submissionId,
      submittedAt,
      session.user.id,
      session.user.username,
      session.user.displayName,
      event.id,
      event.label,
      event.eventName,
      event.abbreviation,
      evidenceType,
      evidenceUrl,
      JSON.stringify(soldierNames),
      soldierCount,
      outcome,
      'GITHUB_WEB',
    ]);
    appendAudit_(session.user, 'PAYOUT_SUBMITTED', submissionId, {
      eventId: event.id,
      soldierCount: soldierCount,
      outcome: outcome,
    });

    return {
      payout: {
        id: submissionId,
        submittedAt: submittedAt,
        submittedById: session.user.id,
        submittedByUsername: session.user.username,
        submittedByName: session.user.displayName,
        eventLabel: event.label,
        eventName: event.eventName,
        eventAbbreviation: event.abbreviation,
        evidenceType: evidenceType,
        evidenceUrl: evidenceUrl,
        soldierNames: soldierNames,
        soldierCount: soldierCount,
        outcome: outcome,
        status: 'OFFEN',
      },
    };
  });
}

function markPaid_(payload) {
  return withScriptLock_(function () {
    const session = assertSession_(payload.sessionToken);
    if (session.user.role !== 'GOTA') {
      throw new RpcError('FORBIDDEN', 'Nur GOTA darf Auszahlungen markieren.');
    }

    const payoutId = requireUuid_(payload.payoutId, 'payoutId');
    const payout = getPayouts_().filter(function (entry) {
      return entry.id === payoutId;
    })[0];
    if (!payout) {
      throw new RpcError('PAYOUT_NOT_FOUND', 'Die Auszahlung wurde nicht gefunden.');
    }
    if (payout.status === 'AUSGEZAHLT') {
      throw new RpcError('ALREADY_PAID', 'Diese Auszahlung ist bereits markiert.');
    }

    const recordedAt = nowIso_();
    appendRow_(SHEETS.STATUS_LOG, [
      Utilities.getUuid(),
      payoutId,
      'AUSGEZAHLT',
      recordedAt,
      session.user.id,
      session.user.username,
      session.user.displayName,
      'GOTA_PAYMENT_CONFIRMED',
    ]);
    appendAudit_(session.user, 'PAYOUT_MARKED_PAID', payoutId, {
      previousStatus: payout.status,
      recordedAt: recordedAt,
    });

    payout.status = 'AUSGEZAHLT';
    payout.paidAt = recordedAt;
    payout.paidByName = session.user.displayName;
    return { payout: payout };
  });
}

function getPayouts_() {
  assertSystemReady_();
  const statusBySubmissionId = getLatestStatuses_();
  return readRows_(SHEETS.SUBMISSIONS)
    .map(function (row) {
      const status = statusBySubmissionId[row.submission_id];
      return {
        id: String(row.submission_id),
        submittedAt: String(row.submitted_at),
        submittedById: String(row.submitted_by_id),
        submittedByUsername: String(row.submitted_by_username),
        submittedByName: String(row.submitted_by_name),
        eventLabel: String(row.event_label),
        eventName: String(row.event_name),
        eventAbbreviation: String(row.event_abbreviation),
        evidenceType: String(row.evidence_type),
        evidenceUrl: String(row.evidence_url),
        soldierNames: parseSoldierNamesJson_(row.soldier_names_json),
        soldierCount: Number(row.soldier_count),
        outcome: String(row.outcome),
        status: status ? status.status : 'OFFEN',
        paidAt: status && status.status === 'AUSGEZAHLT' ? status.recordedAt : undefined,
        paidByName: status && status.status === 'AUSGEZAHLT' ? status.recordedByName : undefined,
      };
    })
    .sort(function (left, right) {
      return new Date(right.submittedAt).getTime() - new Date(left.submittedAt).getTime();
    });
}

function getLatestStatuses_() {
  const latest = {};
  readRows_(SHEETS.STATUS_LOG).forEach(function (row) {
    const submissionId = String(row.submission_id);
    if (!submissionId) {
      return;
    }
    latest[submissionId] = {
      status: String(row.status),
      recordedAt: String(row.recorded_at),
      recordedByName: String(row.recorded_by_name),
    };
  });
  return latest;
}

function getEventChoices_() {
  const spreadsheet = getSpreadsheet_();
  const sheet = requireDataSheet_(spreadsheet);
  const rowCount = sheet.getLastRow();
  const columnCount = sheet.getLastColumn();
  if (rowCount < 2 || columnCount < 1) {
    return [];
  }

  const values = sheet.getRange(1, 1, rowCount, columnCount).getDisplayValues();
  const headers = values[0].map(normalizeHeader_);
  const combinedIndex = headers.findIndex(function (header) {
    return header.indexOf('event') !== -1 && (
      header.indexOf('abkurzung') !== -1 ||
      header.indexOf('abkuerzung') !== -1 ||
      header.indexOf('abbreviation') !== -1 ||
      header.indexOf('kuerzel') !== -1
    );
  });
  const eventIndex = findHeaderIndex_(headers, ['event', 'eventkategorie', 'kategorie', 'category']);
  const abbreviationIndex = findHeaderIndex_(headers, ['abkurzung', 'abkuerzung', 'abbreviation', 'kuerzel', 'shortcode']);

  if (combinedIndex === -1 && eventIndex === -1) {
    throw new RpcError(
      'DATA_SCHEMA_UNSUPPORTED',
      'Data braucht eine Spalte fuer Event/Kategorie oder Event/Kategorie - Abkuerzung.',
    );
  }

  const seen = {};
  const choices = [];
  values.slice(1).forEach(function (row) {
    let eventName = '';
    let abbreviation = '';
    let label = '';

    if (combinedIndex !== -1) {
      label = String(row[combinedIndex] || '').trim();
      const parts = label.split(/\s+-\s+/);
      eventName = parts.length > 1 ? parts.slice(0, -1).join(' - ') : label;
      abbreviation = parts.length > 1 ? parts[parts.length - 1] : '';
    } else {
      eventName = String(row[eventIndex] || '').trim();
      abbreviation = abbreviationIndex === -1 ? '' : String(row[abbreviationIndex] || '').trim();
      label = abbreviation ? eventName + ' - ' + abbreviation : eventName;
    }

    if (!label || seen[label]) {
      return;
    }
    seen[label] = true;
    choices.push({
      id: sha256Hex_('event:' + label),
      label: label,
      eventName: eventName,
      abbreviation: abbreviation,
    });
  });

  return choices;
}

function createSession_(user, source) {
  const token = randomSecret_();
  const sessionId = Utilities.getUuid();
  const createdAt = nowIso_();
  const expiresAt = new Date(Date.now() + CONFIG.SESSION_DURATION_MS).toISOString();
  appendRow_(SHEETS.SESSIONS, [
    sessionId,
    user.id,
    hashSessionToken_(token),
    createdAt,
    expiresAt,
    source,
  ]);

  return {
    token: token,
    expiresAt: expiresAt,
    user: publicUser_(user),
  };
}

function assertSession_(rawToken) {
  assertSystemReady_();
  const token = requireString_(rawToken, 'sessionToken', 512);
  if (token.length < 32) {
    throw new RpcError('SESSION_INVALID', 'Die Sitzung ist ungueltig.');
  }

  const tokenHash = hashSessionToken_(token);
  const session = readRows_(SHEETS.SESSIONS).filter(function (row) {
    return constantTimeEquals_(String(row.token_hash), tokenHash);
  })[0];
  if (!session) {
    throw new RpcError('SESSION_INVALID', 'Die Sitzung ist ungueltig.');
  }

  if (isTokenRevoked_(tokenHash)) {
    throw new RpcError('SESSION_REVOKED', 'Die Sitzung wurde beendet.');
  }
  if (new Date(String(session.expires_at)).getTime() <= Date.now()) {
    throw new RpcError('SESSION_EXPIRED', 'Die Sitzung ist abgelaufen.');
  }

  const user = findUserById_(String(session.user_id));
  if (!user || !user.isActive) {
    throw new RpcError('SESSION_INVALID', 'Das Benutzerkonto ist nicht aktiv.');
  }

  return {
    sessionId: String(session.session_id),
    tokenHash: tokenHash,
    user: user,
  };
}

function isTokenRevoked_(tokenHash) {
  return readRows_(SHEETS.SESSION_REVOCATIONS).some(function (row) {
    return constantTimeEquals_(String(row.token_hash), tokenHash);
  });
}

function createUser_(input) {
  const salt = randomSecret_();
  const user = {
    id: Utilities.getUuid(),
    username: input.username,
    displayName: input.displayName,
    passwordHash: hashPassword_(input.password, salt),
    passwordSalt: salt,
    role: input.role,
    isActive: true,
    createdAt: nowIso_(),
    createdBy: input.createdBy,
  };
  appendRow_(SHEETS.USERS, [
    user.id,
    user.username,
    user.displayName,
    user.passwordHash,
    user.passwordSalt,
    user.role,
    user.isActive,
    user.createdAt,
    user.createdBy,
  ]);
  return user;
}

function findUserByUsername_(username) {
  const normalized = String(username || '').toLowerCase();
  const row = readRows_(SHEETS.USERS).filter(function (candidate) {
    return String(candidate.username).toLowerCase() === normalized;
  })[0];
  return row ? rowToUser_(row) : null;
}

function findUserById_(userId) {
  const row = readRows_(SHEETS.USERS).filter(function (candidate) {
    return String(candidate.user_id) === userId;
  })[0];
  return row ? rowToUser_(row) : null;
}

function rowToUser_(row) {
  return {
    id: String(row.user_id),
    username: String(row.username),
    displayName: String(row.display_name),
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
    role: String(row.role) === 'GOTA' ? 'GOTA' : 'USER',
    isActive: row.is_active === true || String(row.is_active).toLowerCase() === 'true',
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
  };
}

function publicUser_(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

function assertLoginAllowed_(username) {
  const threshold = Date.now() - CONFIG.LOGIN_WINDOW_MS;
  const failures = readRows_(SHEETS.AUTH_LOG).filter(function (row) {
    return (
      String(row.username).toLowerCase() === username &&
      String(row.action) === 'LOGIN_FAILED' &&
      new Date(String(row.occurred_at)).getTime() >= threshold
    );
  }).length;
  if (failures >= CONFIG.MAX_LOGIN_FAILURES) {
    throw new RpcError('RATE_LIMITED', 'Zu viele Anmeldeversuche. Bitte warte einige Minuten.');
  }
}

function appendAuthLog_(username, action, succeeded, detail) {
  appendRow_(SHEETS.AUTH_LOG, [
    Utilities.getUuid(),
    nowIso_(),
    username,
    action,
    succeeded,
    detail,
  ]);
}

function appendAudit_(actor, action, subjectId, detail) {
  appendRow_(SHEETS.AUDIT_LOG, [
    Utilities.getUuid(),
    nowIso_(),
    actor && actor.id ? actor.id : 'SYSTEM',
    actor && actor.username ? actor.username : 'SYSTEM',
    action,
    subjectId,
    JSON.stringify(detail || {}),
  ]);
}

function appendRow_(definition, values) {
  const spreadsheet = getSpreadsheet_();
  const sheet = requireSystemSheet_(spreadsheet, definition);
  if (values.length !== definition.headers.length) {
    throw new Error('Interner Schemafehler beim Schreiben in ' + definition.name + '.');
  }
  sheet.appendRow(values);
}

function readRows_(definition) {
  const spreadsheet = getSpreadsheet_();
  const sheet = requireSystemSheet_(spreadsheet, definition);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, definition.headers.length).getValues();
  return values.map(function (row) {
    const object = {};
    definition.headers.forEach(function (header, index) {
      object[header] = row[index];
    });
    return object;
  });
}

function assertSystemReady_() {
  const spreadsheet = getSpreadsheet_();
  requireDataSheet_(spreadsheet);
  Object.keys(SHEETS).forEach(function (key) {
    requireSystemSheet_(spreadsheet, SHEETS[key]);
  });
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function requireDataSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(CONFIG.DATA_SHEET_NAME);
  if (!sheet) {
    throw new RpcError('DATA_SHEET_MISSING', 'Das Tabellenblatt Data wurde nicht gefunden.');
  }
  return sheet;
}

function ensureSystemSheet_(spreadsheet, definition) {
  let sheet = spreadsheet.getSheetByName(definition.name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(definition.name);
    sheet.appendRow(definition.headers);
    sheet.setFrozenRows(1);
    return sheet;
  }
  return requireSystemSheet_(spreadsheet, definition);
}

function requireSystemSheet_(spreadsheet, definition) {
  const sheet = spreadsheet.getSheetByName(definition.name);
  if (!sheet) {
    throw new RpcError(
      'SYSTEM_NOT_INITIALIZED',
      'Das System ist noch nicht initialisiert. Bitte initializeSystem ausfuehren.',
    );
  }
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < definition.headers.length) {
    throw new RpcError('SYSTEM_SCHEMA_INVALID', 'Das Schema von ' + definition.name + ' ist ungueltig.');
  }

  const headers = sheet
    .getRange(1, 1, 1, definition.headers.length)
    .getDisplayValues()[0]
    .map(String);
  const valid = definition.headers.every(function (header, index) {
    return headers[index] === header;
  });
  if (!valid) {
    throw new RpcError('SYSTEM_SCHEMA_INVALID', 'Die Kopfzeile von ' + definition.name + ' wurde veraendert.');
  }
  return sheet;
}

function protectSystemSheets_(spreadsheet) {
  Object.keys(SHEETS).forEach(function (key) {
    const definition = SHEETS[key];
    const sheet = requireSystemSheet_(spreadsheet, definition);
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    const protection = protections[0] || sheet.protect();
    protection
      .setDescription(CONFIG.PROTECTION_DESCRIPTION_PREFIX + definition.name)
      .setWarningOnly(false)
      .setUnprotectedRanges([]);

    const currentUser = Session.getEffectiveUser();
    protection.addEditor(currentUser);
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) {
      protection.setDomainEdit(false);
    }
  });
}

function parsePayload_(rawPayload) {
  if (typeof rawPayload !== 'string' || !rawPayload) {
    throw new RpcError('INVALID_REQUEST', 'Die Anforderung enthaelt keine Daten.');
  }
  try {
    const payload = JSON.parse(rawPayload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Payload is not an object.');
    }
    return payload;
  } catch (error) {
    throw new RpcError('INVALID_REQUEST', 'Die Anforderungsdaten sind ungueltig.');
  }
}

function requireString_(value, fieldName, maxLength) {
  if (typeof value !== 'string') {
    throw new RpcError('VALIDATION_ERROR', fieldName + ' ist erforderlich.');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new RpcError('VALIDATION_ERROR', fieldName + ' ist ungueltig.');
  }
  return normalized;
}

function requireUuid_(value, fieldName) {
  const uuid = requireString_(value, fieldName, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new RpcError('VALIDATION_ERROR', fieldName + ' ist ungueltig.');
  }
  return uuid;
}

function normalizeUsername_(value) {
  const username = requireString_(value, 'Benutzername', 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    throw new RpcError(
      'VALIDATION_ERROR',
      'Der Benutzername braucht 3-40 Zeichen und darf nur Kleinbuchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich enthalten.',
    );
  }
  return username;
}

function normalizeDisplayName_(value) {
  const displayName = requireString_(value, 'Anzeigename', 80).replace(/[\r\n\t]/g, ' ');
  if (displayName.length < 2) {
    throw new RpcError('VALIDATION_ERROR', 'Der Anzeigename ist zu kurz.');
  }
  return displayName;
}

function requirePassword_(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new RpcError('VALIDATION_ERROR', 'Das Passwort ist ungueltig.');
  }
  return value;
}

function validateNewPassword_(value) {
  const password = requirePassword_(value);
  if (password.length < 10) {
    throw new RpcError('VALIDATION_ERROR', 'Neue Passwoerter brauchen mindestens zehn Zeichen.');
  }
  return password;
}

function validateHttpUrl_(value) {
  const url = requireString_(value, 'Nachweislink', 2048);
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    throw new RpcError('VALIDATION_ERROR', 'Der Nachweislink muss mit http:// oder https:// beginnen.');
  }
  return url;
}

function normalizeSoldierNames_(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 300) {
    throw new RpcError('VALIDATION_ERROR', 'Mindestens ein Soldatenname ist erforderlich.');
  }

  const names = [];
  const seen = {};
  value.forEach(function (item) {
    if (typeof item !== 'string') {
      throw new RpcError('VALIDATION_ERROR', 'Ein Soldatenname ist ungueltig.');
    }
    const name = item.trim().replace(/[\r\n\t]/g, ' ');
    if (!name || name.length > 120) {
      throw new RpcError('VALIDATION_ERROR', 'Ein Soldatenname ist ungueltig.');
    }
    const key = name.toLowerCase();
    if (!seen[key]) {
      seen[key] = true;
      names.push(name);
    }
  });
  return names;
}

function validateSoldierCount_(value, listedNames) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10000 || count < listedNames) {
    throw new RpcError('VALIDATION_ERROR', 'Die Anzahl Soldaten ist ungueltig.');
  }
  return count;
}

function parseSoldierNamesJson_(value) {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.map(String)
      : [];
  } catch (error) {
    return [];
  }
}

function normalizeHeader_(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function findHeaderIndex_(headers, candidates) {
  return headers.findIndex(function (header) {
    return candidates.some(function (candidate) {
      return header === candidate || header.indexOf(candidate) !== -1;
    });
  });
}

function getAllowedOrigins_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ALLOWED_ORIGINS') || '';
  return raw
    .split(',')
    .map(safeNormalizeOrigin_)
    .filter(Boolean);
}

function normalizeOrigin_(value) {
  const normalized = safeNormalizeOrigin_(value);
  if (!normalized) {
    throw new Error('Origin muss nur Protokoll, Host und optionalen Port enthalten.');
  }
  return normalized;
}

function safeNormalizeOrigin_(value) {
  const match = /^(https?):\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(String(value || '').trim());
  if (!match) {
    return '';
  }
  return match[1].toLowerCase() + '://' + match[2].toLowerCase() + (match[3] ? ':' + match[3] : '');
}

function sanitizeRequestId_(value) {
  const requestId = String(value || '');
  return /^[a-z0-9-]{16,100}$/i.test(requestId) ? requestId : '';
}

function createPostMessageOutput_(targetOrigin, requestId, result) {
  const envelope = {
    channel: CONFIG.RPC_CHANNEL,
    requestId: requestId,
    result: result,
  };
  const message = JSON.stringify(envelope)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const target = JSON.stringify(targetOrigin).replace(/</g, '\\u003c');
  const html = '<!doctype html><html><head><base target="_top"></head><body>' +
    '<script>window.parent.postMessage(' + message + ',' + target + ');</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function success_(data) {
  return { ok: true, data: data };
}

function failure_(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

function toFailure_(error) {
  if (error instanceof RpcError) {
    return failure_(error.code, error.message);
  }
  console.error(error && error.stack ? error.stack : error);
  return failure_('SERVER_ERROR', 'Der Dienst konnte die Anforderung nicht verarbeiten.');
}

function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(15000);
    locked = true;
    return callback();
  } finally {
    if (locked) {
      lock.releaseLock();
    }
  }
}

function nowIso_() {
  return new Date().toISOString();
}

function randomSecret_() {
  return Utilities.base64EncodeWebSafe(
    Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + nowIso_(),
    Utilities.Charset.UTF_8,
  ).replace(/=+$/g, '');
}

function ensureSecretProperty_(key) {
  const properties = PropertiesService.getScriptProperties();
  let value = properties.getProperty(key);
  if (!value) {
    value = randomSecret_();
    properties.setProperty(key, value);
  }
  return value;
}

function hashPassword_(password, salt) {
  const pepper = ensureSecretProperty_('PASSWORD_PEPPER');
  let state = 'v1:' + salt + ':' + password;
  for (let round = 0; round < CONFIG.PASSWORD_ROUNDS; round += 1) {
    state = hmacSha256Hex_(state, pepper);
  }
  return 'v1$' + state;
}

function hashSessionToken_(token) {
  return 'v1$' + hmacSha256Hex_('session:' + token, ensureSecretProperty_('SESSION_PEPPER'));
}

function sha256Hex_(value) {
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8,
  ));
}

function hmacSha256Hex_(value, key) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(
    String(value),
    String(key),
    Utilities.Charset.UTF_8,
  ));
}

function bytesToHex_(bytes) {
  return bytes.map(function (byte) {
    const normalized = (byte + 256) % 256;
    return (normalized < 16 ? '0' : '') + normalized.toString(16);
  }).join('');
}

function constantTimeEquals_(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}