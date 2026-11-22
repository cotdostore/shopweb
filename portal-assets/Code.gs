// Configure ONLY in Project Settings > Script properties; never paste secrets in source.
// PORTAL_SYNC_URL   https://<your-worker>/portal/api/sync
// PORTAL_SYNC_TOKEN token generated on the portal admin page
// Document IDs are discovered automatically from active accounts on the portal.
function installSync() {
  portalConfig_();
  // Confirm an initial sync succeeds before replacing the trigger.
  syncPortal();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncPortal')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncPortal').timeBased().everyMinutes(5).create();
}
function portalConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const url = properties.getProperty('PORTAL_SYNC_URL');
  const token = properties.getProperty('PORTAL_SYNC_TOKEN');
  if (!/^https:\/\/[^/]+\/portal\/api\/sync$/.test(url || '') || !token)
    throw new Error('Set PORTAL_SYNC_URL and PORTAL_SYNC_TOKEN in Script properties.');
  return {url: url, token: token};
}
// Rank tabs by account content and title; ties keep document order.
function portalSourceContent_(doc) {
  if (!doc.tabs || !doc.tabs.length) return (doc.body || {}).content;
  let best, bestScore = -Infinity;
  function hasAccount(items) {
    return (items || []).some(function(item) {
      const text = ((item.paragraph || {}).elements || []).map(e => (e.textRun || {}).content || '').join('').trim()
        .replace(/^(?:tk|tài khoản|tai khoan|email)\s*:\s*/i, '');
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || ((item.table || {}).tableRows || [])
        .some(row => (row.tableCells || []).some(cell => hasAccount(cell.content)));
    });
  }
  function visit(items, archivedParent) {
    (items || []).forEach(function(tab) {
      const title = String((tab.tabProperties || {}).title || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const archived = archivedParent || /\b(het han|expired|archive|archived|backup|old|cu|du phong|khong dung|inactive)\b/.test(title);
      const primary = /\b(acc chinh|tai khoan chinh|main|primary)\b/.test(title);
      const active = /\b(dang dung|dang hoat dong|active|current|moi)\b/.test(title);
      const content = (((tab.documentTab || {}).body || {}).content || []);
      const score = (hasAccount(content) ? 1000 : 0) + (archived ? -200 : primary ? 40 : active ? 30 : 0);
      if (score > bestScore) { bestScore = score; best = content; }
      visit(tab.childTabs, archived);
    });
  }
  visit(doc.tabs, false);
  return best;
}
function syncPortal() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const config = portalConfig_();
    // Refresh every run: newly added Docs need no Script property changes.
    const sources = UrlFetchApp.fetch(config.url, {
      method: 'get', headers: {Authorization: 'Bearer ' + config.token},
      muteHttpExceptions: true, followRedirects: false
    });
    if (sources.getResponseCode() !== 200)
      throw new Error('Cannot load portal documents, status ' + sources.getResponseCode());
    const ids = JSON.parse(sources.getContentText()).sourceIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(id)))
      throw new Error('Invalid portal document list.');
    let failures = 0;
    ids.forEach(function(id, index) {
      try {
        const observedAt = Date.now();
        // Advanced Docs service accepts documents.readonly; DocumentApp.openById
        // would require the broader documents write scope.
        const doc = Docs.Documents.get(id, {includeTabsContent: true});
        const paragraphs = [];
        function walkContent(items) {
          (items || []).forEach(function(item) {
            if (item.paragraph) {
              const runs = (item.paragraph.elements || []).map(e => e.textRun).filter(Boolean);
              paragraphs.push({
                text: runs.map(r => r.content || '').join(''),
                links: runs.filter(r => r.textStyle && r.textStyle.link && r.textStyle.link.url)
                  .map(r => ({url: r.textStyle.link.url}))
              });
            }
            ((item.table || {}).tableRows || []).forEach(function(row) {
              (row.tableCells || []).forEach(cell => walkContent(cell.content));
            });
          });
        }
        walkContent(portalSourceContent_(doc));
        const response = UrlFetchApp.fetch(config.url, {
          method: 'post', contentType: 'application/json',
          headers: {Authorization: 'Bearer ' + config.token},
          payload: JSON.stringify({sourceId: id, observedAt: observedAt, paragraphs: paragraphs}),
          muteHttpExceptions: true, followRedirects: false
        });
        if (response.getResponseCode() !== 200) throw new Error('Portal rejected sync, status ' + response.getResponseCode());
      } catch (error) {
        failures++;
        // Do not log document text, credentials, URLs, token or response bodies.
        console.error('Portal document sync failed at index ' + index);
      }
    });
    if (failures) throw new Error(failures + ' document(s) could not sync. Check access and portal account status.');
  } finally {lock.releaseLock();}
}
function stopSync() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncPortal')
    .forEach(t => ScriptApp.deleteTrigger(t));
}
