# Event-Auszahlungen

Eine statische GitHub-Pages-Weboberflaeche mit einem Google-Apps-Script-Backend. Der Browser bekommt nie direkten Bearbeitungszugriff auf Google Sheets. Er kann nur ueber die Web-App mit einer eigenen Anmeldung neue Meldungen anhaengen oder, im GOTA-Zugang, einen append-only Status `AUSGEZAHLT` protokollieren.

## Sicherheitsmodell

- `Data` wird nur gelesen. Das Script fuehrt darauf keine Schreib-, Umbenennungs-, Schutz- oder Loeschoperation aus.
- `PayoutSubmissions` wird nur mit `appendRow` erweitert. Bestehende Meldungen werden nie aktualisiert oder geloescht.
- `AUSGEZAHLT` wird als neue Zeile in `PayoutStatusLog` gespeichert. Der sichtbare Status wird aus der letzten Statuszeile abgeleitet.
- Benutzer, Sitzungen, Loginversuche und Audit-Ereignisse sind ebenfalls reine Anhangsprotokolle.
- Passwoerter werden nicht im Repository oder Tabellenblatt als Klartext gespeichert. Das Script nutzt zufaelligen Salt, einen geheimen Script-Property-Pepper und 10.000 HMAC-SHA-256-Runden.
- Das GOTA-Konto ist `gota`. Der einmalige, separat bekannte Bootstrap-Wert wird als Script Property gesetzt, gehasht gespeichert und anschliessend sofort aus den Properties entfernt.
- Das Apps-Script akzeptiert nur exakt konfigurierte Origins. Die iframe-Antwort wird nur an diese Origin zurueckgesendet; jede schreibende Aktion braucht einen gueltigen Sitzungstoken.

Google Sheets kann den Eigentumer eines Dokuments technisch nie vollstaendig von Aenderungen ausschliessen. Das Script sperrt deshalb alle neu angelegten Systemtabs fuer alle anderen Bearbeiter. Teile die Tabelle nicht mit Bearbeitungsrechten ausserhalb des Besitzerkontos; Anwender nutzen ausschliesslich die Web-App. Damit kann niemand mit der GitHub-URL direkt Tabelleninhalte loeschen.

## Angelegte Tabellenblaetter

Beim einmaligen Setup entstehen nur diese neuen Tabs:

- `SystemUsers`
- `PayoutSubmissions`
- `PayoutStatusLog`
- `SystemSessions`
- `SessionRevocations`
- `AuthLog`
- `SystemAuditLog`

Das vorhandene Tabellenblatt `Data` bleibt unveraendert. Die Ereignisauswahl erkennt eine kombinierte Spalte wie `Event/Kategorie - Abkuerzung` sowie getrennte Event- und Abkuerzungs-Spalten.

## Google Apps Script einrichten

1. Oeffne [script.google.com](https://script.google.com) mit dem Google-Konto, das die angegebene Tabelle bearbeiten darf, und erstelle ein neues Standalone-Projekt.
2. Kopiere den Inhalt von [apps-script/Code.gs](apps-script/Code.gs) in die Projektdatei `Code.gs` und den Inhalt von [apps-script/appsscript.json](apps-script/appsscript.json) in das Projektmanifest.
3. Oeffne im Apps-Script-Projekt `Project Settings` und lege unter `Script properties` einmalig `INITIAL_GOTA_PASSWORD` mit dem separat vereinbarten GOTA-Startwert an.
4. Fuehre `initializeSystem` im Editor einmal aus und erteile die geforderten Tabellenberechtigungen. Dabei werden die Systemtabs angelegt, gesperrt und der GOTA-Hash erzeugt. Die Klartext-Property wird danach automatisch entfernt.
5. Fuehre `configureAllowedOrigins` aus. Als Argument muss die lokale und die GitHub-Pages-Origin angegeben werden:

```javascript
configureAllowedOrigins('http://localhost:5173,https://deltateam1.github.io')
```

Die produktive Seite lautet `https://deltateam1.github.io/Auszahlen/`. Die Origin enthaelt bewusst keinen Repository-Pfad.

6. Waehle `Deploy` > `New deployment` > `Web app`:
   - `Execute as`: `Me`
   - Zugriff: die breiteste in deinem Google-Konto verfuegbare Option fuer anonyme Nutzung, normalerweise `Anyone`
   - Kopiere die produktive URL, die auf `/exec` endet. Verwende nie die Entwicklungs-URL `/dev` in GitHub Pages.

Die Web-App darf oeffentlich erreichbar sein, weil alle Datenaktionen trotzdem durch die Anwendungskonten, die Origin-Whitelist und Sitzungstoken geschuetzt sind. Ein beliebiger Besucher kann sich registrieren, aber nur seine eigenen Meldungen sehen; ausschliesslich `gota` sieht das Gesamtregister und kann Auszahlungen markieren.

## Frontend und GitHub Pages einrichten

1. Trage die `/exec`-URL in [payout-system/public/runtime-config.js](payout-system/public/runtime-config.js) ein:

```javascript
window.__PAYOUT_CONFIG__ = {
  endpoint: 'https://script.google.com/macros/s/AKfycbxSdWF-hxFtzeN3Rmpb1cKeBPbeEThp4jEMZTL_doNxbV0DtbBf4sG96UXWJn52O9GK/exec',
  requestTimeoutMs: 25000,
};
```

Die URL ist absichtlich oeffentlich; sie ist kein Geheimnis und ermoeglicht allein keinen Tabellenzugriff.

2. Der Repository-Remote lautet `https://github.com/deltateam1/Auszahlen.git`; der Projektstand wird auf `main` veroeffentlicht.
3. Oeffne in GitHub `Settings` > `Pages` und waehle bei `Build and deployment` die Option `GitHub Actions`.
4. Der Workflow [deploy-pages.yml](.github/workflows/deploy-pages.yml) baut den Unterordner `payout-system` und veroeffentlicht ihn unter `https://deltateam1.github.io/Auszahlen/`.

## Lokale Pruefung

```powershell
npm.cmd --prefix payout-system run build
node.exe --test tests/apps-script.integration.test.mjs
```

Der Integrations-Test prueft den append-only Ablauf mit einer lokalen Apps-Script- und Google-Sheets-Nachbildung: Systeminitialisierung, GOTA-Hash, Benutzerregistrierung, Ereignislesen, Meldung, Statusprotokoll und die Unveraendertheit von `Data` sowie `PayoutSubmissions` nach der Auszahlung.