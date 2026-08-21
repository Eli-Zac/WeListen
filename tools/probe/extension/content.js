// ISOLATED world. Renders a small floating panel showing the probe result
// published by inject.js (MAIN world) via a hidden DOM element — the only
// channel that crosses the world boundary without a nonce-authenticated
// bridge, which is overkill for throwaway spike tooling.

(function () {
  const panel = document.createElement('div');
  panel.id = 'weListen-probe-panel';
  panel.style.cssText = [
    'position:fixed', 'bottom:12px', 'right:12px', 'z-index:2147483647',
    'width:360px', 'max-height:70vh', 'overflow:auto',
    'background:#111', 'color:#0f0', 'font:11px/1.4 monospace',
    'padding:10px', 'border-radius:8px', 'box-shadow:0 4px 24px rgba(0,0,0,.5)',
    'white-space:pre-wrap',
  ].join(';');
  panel.textContent = 'WeListen probe: waiting for first run…';

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;display:flex;gap:6px;transform:translateY(-100%);margin-top:-6px;';
  const rerunBtn = document.createElement('button');
  rerunBtn.textContent = 'Re-run probe';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy JSON';
  for (const b of [rerunBtn, copyBtn]) {
    b.style.cssText = 'font:11px monospace;padding:4px 8px;cursor:pointer;';
  }

  let lastReportJson = null;

  rerunBtn.addEventListener('click', () => {
    panel.textContent = 'Re-running…';
    document.dispatchEvent(new CustomEvent('weListenProbeRun'));
  });
  copyBtn.addEventListener('click', () => {
    if (lastReportJson) navigator.clipboard.writeText(lastReportJson).catch(() => {});
  });

  document.addEventListener('weListenProbeReady', () => {
    const el = document.getElementById('weListen-probe-report');
    if (!el) return;
    lastReportJson = el.textContent;
    let report;
    try {
      report = JSON.parse(lastReportJson);
    } catch (_) {
      panel.textContent = 'Probe finished but report was not valid JSON.';
      return;
    }
    panel.textContent = summarize(report);
  });

  function summarize(r) {
    const lines = [];
    lines.push(`WeListen probe — ${r.finishedAt || 'in progress'}`);
    lines.push(`loggedIn: ${r.loggedIn}`);
    lines.push('');
    lines.push(`Q1 player API: ${r.q1_playerApi && r.q1_playerApi.present}`);
    if (r.q1_playerApi && r.q1_playerApi.present) {
      lines.push(`  resolutionMs: ${r.q1_playerApi.resolutionMs}`);
      lines.push(`  jitter: ${JSON.stringify(r.q1_playerApi.jitterStats)}`);
    }
    lines.push(`Q2 fine-grained rate honoured: ${r.q2_playbackRate && r.q2_playbackRate.anyFineGrainedHonoured}`);
    lines.push(`Q3 store present: ${r.q3_store && r.q3_store.present}, dispatch: ${r.q3_store && r.q3_store.hasDispatch}`);
    lines.push(`Q4 seek testable: ${r.q4_seekCost && r.q4_seekCost.testable}`);
    lines.push(`Q5 DOM anchors found: ${r.q5_domAnchors ? Object.entries(r.q5_domAnchors.found).filter(([, v]) => v).map(([k]) => k).join(', ') : '-'}`);
    lines.push(`Q6 ad classes present now: ${r.q6_ads ? Object.entries(r.q6_ads.adClassHits).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none' : '-'}`);
    lines.push(`Q7 ytcfg present: ${r.q7_innertube && r.q7_innertube.ytcfgPresent}, search ok: ${r.q7_innertube && r.q7_innertube.searchOk}`);
    if (r.errors && r.errors.length) {
      lines.push('');
      lines.push(`errors (${r.errors.length}):`);
      for (const e of r.errors.slice(0, 8)) lines.push(`  ${e.label}: ${e.message}`);
    }
    lines.push('');
    lines.push('Full JSON: click "Copy JSON" and paste into docs/probe-findings.md.');
    return lines.join('\n');
  }

  document.documentElement.appendChild(panel);
  document.documentElement.appendChild(bar);
  bar.appendChild(rerunBtn);
  bar.appendChild(copyBtn);
})();
