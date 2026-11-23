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
 *      The first run also imports this month's alerts so far (from the 1st); after that it checks every 15 min.
 * To stop: Triggers (clock icon) → delete the trigger, or delete the project.
 */
const BAYMAX_URL = 'https://mybaymax.netlify.app/api/ingest';
const BAYMAX_SECRET = 'PASTE_SECRET_HERE';

// Alert emails from banks and card issuers mentioning money moving.
const FILTER = '(debited OR credited OR spent OR "transaction" OR UPI OR refund OR withdrawn OR "payment received") ' +
  '-category:promotions -category:social ' +
  '(from:alerts OR from:bank OR from:card OR from:hdfcbank OR from:icicibank OR from:axisbank OR from:sbi OR from:sbicard ' +
  'OR from:kotak OR from:americanexpress OR from:yesbank OR from:indusind OR from:idfcfirstbank OR from:aubank ' +
  'OR from:federalbank OR from:sc.com OR from:hsbc OR from:rblbank OR from:bobcard OR from:onecard OR from:bandhanbank)';

function syncBankAlerts() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('lastRun') || 0) - 60 * 60 * 1000; // 1 h overlap; Baymax ignores repeats
  const started = Date.now();
  const days = Math.min(40, Math.max(2, Math.ceil((started - since) / 86400000) + 1));
  if (!send(collect('newer_than:' + days + 'd ' + FILTER, since))) return;
  props.setProperty('lastRun', String(started));
}

/** Alert emails matching the search, received after `since` (ms). */
function collect(query, since) {
  const messages = [];
  for (let start = 0; start < 500; start += 100) {
    const threads = GmailApp.search(query, start, 100);
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        if (m.getDate().getTime() < since) return;
        messages.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(), body: readableText(m).slice(0, 4000), date: m.getDate().toISOString() });
      });
    });
    if (threads.length < 100) break;
  }
  return messages;
}

/** The words of an email without its styling code (some banks put pages of CSS before the details). */
function readableText(m) {
  const html = m.getBody() || '';
  const text = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|th|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return text || m.getPlainBody();
}

/** Send to Baymax in batches. Returns false if Baymax refused (wrong secret, server down). */
function send(messages) {
  for (let i = 0; i < messages.length; i += 150) {
    const res = UrlFetchApp.fetch(BAYMAX_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-baymax-secret': BAYMAX_SECRET },
      payload: JSON.stringify({ messages: messages.slice(i, i + 150) }),
    });
    if (res.getResponseCode() !== 200) { console.error('Baymax said', res.getResponseCode(), res.getContentText()); return false; }
    console.log('Sent ' + Math.min(150, messages.length - i) + ' emails → ' + res.getContentText());
  }
  if (!messages.length) console.log('No new bank alerts.');
  return true;
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncBankAlerts').timeBased().everyMinutes(15).create();
  // First run: everything since the 1st of this month.
  const now = new Date();
  PropertiesService.getScriptProperties().setProperty('lastRun', String(new Date(now.getFullYear(), now.getMonth(), 1).getTime() + 60 * 60 * 1000));
  syncBankAlerts();
}
