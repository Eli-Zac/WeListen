// Minimal SPA-resilient mounting: re-attach `build()`'s element whenever it's
// missing from the DOM, debounced with requestAnimationFrame. Full version
// (yt-navigate-finish listeners, multiple keyed mounts) is Phase 4 — this is
// just enough for the Phase 1 debug overlay to survive the SPA navigation
// that Phase 0 flagged as unverified (docs/probe-findings.md Q5).
export function keepMounted(id: string, build: () => HTMLElement): void {
  let scheduled = false;

  function ensure(): void {
    scheduled = false;
    if (document.getElementById(id)) return;
    const el = build();
    el.id = id;
    el.setAttribute('data-welisten', 'true');
    document.documentElement.appendChild(el);
  }

  function scheduleEnsure(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(ensure);
  }

  scheduleEnsure();
  new MutationObserver(scheduleEnsure).observe(document.documentElement, { childList: true, subtree: false });
}
