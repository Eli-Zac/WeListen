// Active-tab designation — docs/ARCHITECTURE.md §3 "Multiple tabs". Only one
// tab drives the player; the service worker sees every tab so this is
// bookkeeping here, not a distributed algorithm.
export class TabRegistry {
  private ports = new Map<number, chrome.runtime.Port>();
  private activeTabId: number | null = null;

  add(tabId: number, port: chrome.runtime.Port): { becameActive: boolean } {
    this.ports.set(tabId, port);
    if (this.activeTabId === null) {
      this.activeTabId = tabId;
      return { becameActive: true };
    }
    return { becameActive: false };
  }

  remove(tabId: number): { activeChanged: boolean; newActiveTabId: number | null } {
    this.ports.delete(tabId);
    if (this.activeTabId !== tabId) return { activeChanged: false, newActiveTabId: this.activeTabId };
    const next = this.ports.keys().next();
    this.activeTabId = next.done ? null : next.value;
    return { activeChanged: true, newActiveTabId: this.activeTabId };
  }

  isActive(tabId: number): boolean {
    return this.activeTabId === tabId;
  }

  allPorts(): chrome.runtime.Port[] {
    return [...this.ports.values()];
  }

  activePort(): chrome.runtime.Port | null {
    if (this.activeTabId === null) return null;
    return this.ports.get(this.activeTabId) ?? null;
  }
}
