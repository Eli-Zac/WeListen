// MAIN world. Runs after probe.js has attached window.__weListenProbe.
// Auto-runs once on load, writes the report into a hidden DOM element (the
// only channel plain data can cross to the ISOLATED-world content.js on),
// and re-runs on request.

(function () {
  function publish(report) {
    let el = document.getElementById('weListen-probe-report');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'weListen-probe-report';
      el.style.display = 'none';
      document.documentElement.appendChild(el);
    }
    el.textContent = JSON.stringify(report);
    document.dispatchEvent(new CustomEvent('weListenProbeReady'));
  }

  async function runAndPublish() {
    const report = await window.__weListenProbe.runAll();
    publish(report);
  }

  document.addEventListener('weListenProbeRun', runAndPublish);

  // Give the SPA a moment to finish its own boot before the first run.
  setTimeout(runAndPublish, 1500);
})();
