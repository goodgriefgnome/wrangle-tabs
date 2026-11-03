const DASHBOARD_URL = chrome.runtime.getURL("dashboard.html");

// Clicking the toolbar button (or pressing Alt+Shift+T) opens the dashboard,
// or focuses it and re-scans if it is already open.
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  const open = tabs.find((t) => t.url?.startsWith(DASHBOARD_URL));
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
    chrome.runtime.sendMessage({ type: "rescan" }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  }
});
