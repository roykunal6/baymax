/**
 * Baymax — bank & card alerts from Gmail.
 *
 * Every 15 minutes this reads new bank/credit-card alert emails in this Gmail account and sends
 * them to Baymax, which logs each transaction (or marks an EMI/SIP/card bill as paid).
 * Nothing else in your mailbox is read or sent.
 *
 * Setup (once):
 *   1. Open https://script.google.com while signed in to the Gmail that receives your bank alerts.
 *   2. New project → paste this whole file → replace PASTE_SECRET_HERE with the secret Baymax gave you.
 *   3. Choose the function "setup" in the toolbar and click Run. Allow the permissions Google asks for.
 * To stop: Triggers (clock icon) → delete the trigger, or delete the project.
 */
const BAYMAX_URL = 'https://mybaymax.netlify.app/api/ingest';
const BAYMAX_SECRET = 'PASTE_SECRET_HERE';

// Alert emails from banks and card issuers mentioning money moving.
const QUERY = 'newer_than:2d (debited OR credited OR spent OR "transaction" OR UPI OR refund OR withdrawn OR "payment received") ' +
  '-category:promotions -category:social ' +
  '(from:alerts OR from:bank OR from:card OR from:hdfcbank OR from:icicibank OR from:axisbank OR from:sbi OR from:sbicard ' +
  'OR from:kotak OR from:americanexpress OR from:yesbank OR from:indusind OR from:idfcfirstbank OR from:aubank ' +
  'OR from:federalbank OR from:sc.com OR from:hsbc OR from:rblbank OR from:bobcard OR from:onecard OR from:bandhanbank)';

function syncBankAlerts() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('lastRun') || 0) - 60 * 60 * 1000; // 1 h overlap; Baymax ignores repeats
  const started = Date.now();
  const messages = [];
  GmailApp.search(QUERY, 0, 100).forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      if (m.getDate().getTime() < since) return;
      messages.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(), body: m.getPlainBody().slice(0, 4000), date: m.getDate().toISOString() });
    });
  });
  if (messages.length) {
    const res = UrlFetchApp.fetch(BAYMAX_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-baymax-secret': BAYMAX_SECRET },
      payload: JSON.stringify({ messages: messages }),
    });
    if (res.getResponseCode() !== 200) { console.error('Baymax said', res.getResponseCode(), res.getContentText()); return; }
    console.log('Sent ' + messages.length + ' emails → ' + res.getContentText());
  }
  props.setProperty('lastRun', String(started));
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncBankAlerts').timeBased().everyMinutes(15).create();
  PropertiesService.getScriptProperties().setProperty('lastRun', String(Date.now() - 2 * 24 * 60 * 60 * 1000));
  syncBankAlerts();
}
