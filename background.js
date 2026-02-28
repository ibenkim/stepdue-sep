chrome.runtime.onInstalled.addListener(() => {
  console.log("epoch loaded");

  chrome.storage.local.set({
    sessions: [],
    settings: {
      enabled: true
    }
  });
});
