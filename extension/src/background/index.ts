import { Session } from './session.js';
import { PORT_NAME } from '../shared/port-protocol.js';

// One per browser, not per tab (docs/ARCHITECTURE.md §2). Holds the single
// WebSocket and clock estimate; survives SPA navigation and tab churn.

const session = new Session();
session.start();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;
  session.attachTab(tabId, port);
});
