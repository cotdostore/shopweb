// Configure ONLY in Project Settings > Script properties; never paste secrets in source.
// PORTAL_SYNC_URL   https://<your-worker>/portal/api/sync
// PORTAL_SYNC_TOKEN token generated on the portal admin page
// PORTAL_DOC_IDS    JSON array of document IDs, e.g. ["your-document-id"]
function installSync() {
  portalConfig_();
  // Confirm an initial sync succeeds before replacing the trigger.
  syncPortal();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncPortal')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncPortal').timeBased().everyMinutes(1).create();
}
function portalConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const url = properties.getProperty('PORTAL_SYNC_URL');
  const token = properties.getProperty('PORTAL_SYNC_TOKEN');
  const ids = JSON.parse(properties.getProperty('PORTAL_DOC_IDS') || '[]');
  if (!/^https:\/\/[^/]+\/portal\/api\/sync$/.test(url || '') || !token || !Array.isArray(ids) || !ids.length || ids.length > 50)
    throw new Error('Set PORTAL_SYNC_URL, PORTAL_SYNC_TOKEN and PORTAL_DOC_IDS in Script properties.');
  return {url: url, token: token, ids: ids};
}
function syncPortal() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const config = portalConfig_();
    let failures = 0;
    config.ids.forEach(function(id) {
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
        function walkTabs(tabs) {
          (tabs || []).forEach(function(tab) {
            walkContent(((tab.documentTab || {}).body || {}).content);
            walkTabs(tab.childTabs);
          });
        }
        if (doc.tabs && doc.tabs.length) walkTabs(doc.tabs);
        else walkContent((doc.body || {}).content);
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
        console.error('Portal document sync failed at index ' + config.ids.indexOf(id));
      }
    });
    if (failures) throw new Error(failures + ' document(s) could not sync. Check access and portal account status.');
  } finally {lock.releaseLock();}
}
function stopSync() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncPortal')
    .forEach(t => ScriptApp.deleteTrigger(t));
}
