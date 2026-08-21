// WeListen — Phase 0 probe.
//
// NOTE: this file is a synced copy of ../probe.js (MV3 content scripts cannot
// reference files outside the extension directory). Edit ../probe.js and copy
// it here — `cp ../probe.js probe.js` — do not edit the two independently.
//
// Throwaway code. Answers the seven questions in docs/ROADMAP.md "Phase 0" by
// inspecting music.youtube.com's live internals. Must run in the page's MAIN
// world (same JS heap as the page) because it reads `window.ytcfg` and
// `document.querySelector('ytmusic-app').store`, neither of which an
// ISOLATED-world content script can see.
//
// Usage:
//   - Bookmarklet: see bookmarklet.js (wraps this file's source as a javascript: URL)
//   - Scratch extension: see extension/ (loads this file as a MAIN-world content script)
//   - Headless: see ../run-headless.mjs (evaluates this file's source via Playwright)
//
// Call `await window.__weListenProbe.runAll()` and read the returned report, or
// `window.__weListenProbe.report()` to print + copy it after runAll() has finished.
// Every check is independently try/caught: one missing API does not stop the rest.

(function () {
  const report = {
    startedAt: new Date().toISOString(),
    url: location.href,
    userAgent: navigator.userAgent,
    loggedIn: null,
    q1_playerApi: null,
    q2_playbackRate: null,
    q3_store: null,
    q4_seekCost: null,
    q5_domAnchors: null,
    q6_ads: null,
    q7_innertube: null,
    errors: [],
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function tryCatch(label, fn) {
    try {
      return fn();
    } catch (err) {
      report.errors.push({ label, message: String(err && err.message || err) });
      return null;
    }
  }

  async function tryCatchAsync(label, fn) {
    try {
      return await fn();
    } catch (err) {
      report.errors.push({ label, message: String(err && err.message || err) });
      return null;
    }
  }

  function getPlayer() {
    return document.querySelector('#movie_player');
  }

  function getApp() {
    return document.querySelector('ytmusic-app');
  }

  // ---- Q1: player API surface + getCurrentTime resolution/jitter ----------

  async function probePlayerApi() {
    const player = getPlayer();
    if (!player) return { present: false };

    const methods = [
      'seekTo',
      'getCurrentTime',
      'getPlayerState',
      'getVideoData',
      'loadVideoById',
      'setPlaybackRate',
      'getPlaybackRate',
      'getDuration',
      'playVideo',
      'pauseVideo',
    ];
    const surface = {};
    for (const m of methods) {
      surface[m] = typeof player[m] === 'function';
    }

    let videoData = null;
    let playerState = null;
    tryCatch('q1.getVideoData', () => {
      videoData = player.getVideoData();
    });
    tryCatch('q1.getPlayerState', () => {
      playerState = player.getPlayerState();
    });

    // Sample getCurrentTime() as fast as the event loop allows for ~2s to see
    // its real resolution/jitter (not the same as the timer we sample it with).
    const samples = [];
    if (surface.getCurrentTime) {
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const t = tryCatch('q1.getCurrentTime.sample', () => player.getCurrentTime());
        samples.push({ perfMs: performance.now(), currentTimeSec: t });
        await sleep(16); // ~60Hz poll; the interesting signal is how often the value actually changes
      }
    }

    // Resolution: smallest non-zero delta between consecutive distinct readings.
    // Jitter: stddev of the *rate* of reported time advance vs. wall-clock advance.
    let resolutionMs = null;
    let jitterStats = null;
    if (samples.length > 2) {
      const distinctDeltas = [];
      for (let i = 1; i < samples.length; i++) {
        const dt = samples[i].currentTimeSec - samples[i - 1].currentTimeSec;
        if (dt > 0) distinctDeltas.push(dt * 1000);
      }
      if (distinctDeltas.length) resolutionMs = Math.min(...distinctDeltas);

      const rates = [];
      for (let i = 1; i < samples.length; i++) {
        const wallDeltaMs = samples[i].perfMs - samples[i - 1].perfMs;
        const playerDeltaMs =
          (samples[i].currentTimeSec - samples[i - 1].currentTimeSec) * 1000;
        if (wallDeltaMs > 0) rates.push(playerDeltaMs / wallDeltaMs);
      }
      if (rates.length) {
        const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
        const variance =
          rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
        jitterStats = { meanRate: mean, stddevRate: Math.sqrt(variance), n: rates.length };
      }
    }

    return {
      present: true,
      methods: surface,
      videoData,
      playerState,
      resolutionMs,
      jitterStats,
      sampleCount: samples.length,
    };
  }

  // ---- Q2: does setPlaybackRate honour fine-grained values? ---------------

  async function probePlaybackRate() {
    const player = getPlayer();
    if (!player || typeof player.setPlaybackRate !== 'function') {
      return { testable: false };
    }
    const original = tryCatch('q2.getOriginal', () => player.getPlaybackRate());
    const attempts = [1.02, 0.98, 1.05, 0.95, 1.002];
    const results = [];
    for (const target of attempts) {
      tryCatch('q2.set', () => player.setPlaybackRate(target));
      await sleep(50);
      const actual = tryCatch('q2.get', () => player.getPlaybackRate());
      results.push({ target, actual, honoured: actual === target });
    }
    // Restore.
    tryCatch('q2.restore', () => player.setPlaybackRate(original == null ? 1 : original));
    const availableRates = tryCatch('q2.getAvailable', () =>
      typeof player.getAvailablePlaybackRates === 'function'
        ? player.getAvailablePlaybackRates()
        : null
    );
    return {
      testable: true,
      original,
      results,
      anyFineGrainedHonoured: results.some((r) => r.honoured),
      availableRates,
    };
  }

  // ---- Q3: ytmusic-app.store — read, subscribe, and observed dispatches ---

  function probeStore() {
    const app = getApp();
    if (!app) return { present: false };
    const store = app.store;
    if (!store) return { present: false, appFound: true };

    const hasGetState = typeof store.getState === 'function';
    const hasSubscribe = typeof store.subscribe === 'function';
    const hasDispatch = typeof store.dispatch === 'function';

    let state = null;
    let queuePath = null;
    if (hasGetState) {
      state = tryCatch('q3.getState', () => store.getState());
      if (state) {
        for (const path of ['queue.items', 'player.queue.items', 'queue']) {
          const parts = path.split('.');
          let cur = state;
          let ok = true;
          for (const p of parts) {
            if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
            else {
              ok = false;
              break;
            }
          }
          if (ok && cur != null) {
            queuePath = { path, sample: Array.isArray(cur) ? cur.slice(0, 2) : cur };
            break;
          }
        }
      }
    }

    // Non-destructive: wrap dispatch to *observe* action types the app itself
    // sends (e.g. as the tester clicks play/pause/skip in the real UI), rather
    // than us dispatching anything. Left installed for the caller to inspect
    // via window.__weListenProbe.observedActions after interacting with the UI.
    const observedActions = [];
    if (hasDispatch && !store.__weListenWrapped) {
      const originalDispatch = store.dispatch.bind(store);
      store.dispatch = function (action) {
        try {
          observedActions.push({
            type: action && action.type,
            at: Date.now(),
          });
          if (observedActions.length > 200) observedActions.shift();
        } catch (_) {
          // observation must never break the real dispatch
        }
        return originalDispatch(action);
      };
      store.__weListenWrapped = true;
    }

    return {
      present: true,
      appFound: true,
      hasGetState,
      hasSubscribe,
      hasDispatch,
      queuePath,
      stateTopLevelKeys: state && typeof state === 'object' ? Object.keys(state) : null,
      observedActions, // live reference; grows as the user interacts with the UI
      note:
        'Actual write-capability (does a dispatched queue mutation get honoured by the UI) ' +
        'is NOT tested automatically — it is destructive to a real session. Use ' +
        'window.__weListenProbe.tryDispatchTest() manually in a throwaway session, and only ' +
        'after reading observedActions to find a real action type string to mimic.',
    };
  }

  // Manual, opt-in, deliberately not called by runAll(). Human-run only.
  function tryDispatchTest(actionType, actionPayload) {
    const app = getApp();
    const store = app && app.store;
    if (!store || typeof store.dispatch !== 'function') {
      return { ok: false, reason: 'no store.dispatch' };
    }
    const before = tryCatch('q3.dispatchTest.before', () => store.getState());
    tryCatch('q3.dispatchTest.dispatch', () =>
      store.dispatch({ type: actionType, payload: actionPayload })
    );
    const after = tryCatch('q3.dispatchTest.after', () => store.getState());
    return { ok: true, before, after };
  }

  // ---- Q4: seek cost — latency, re-buffer probability, overshoot ----------

  async function probeSeekCost() {
    const player = getPlayer();
    if (!player || typeof player.seekTo !== 'function' || typeof player.getCurrentTime !== 'function') {
      return { testable: false };
    }
    const state0 = tryCatch('q4.state0', () => player.getPlayerState());
    // 1 = playing. Only meaningful to test while something is actually playing.
    if (state0 !== 1) {
      return { testable: false, reason: 'no track playing (state=' + state0 + ')', playerState: state0 };
    }

    const trials = [];
    for (let i = 0; i < 3; i++) {
      const cur = tryCatch('q4.current', () => player.getCurrentTime());
      const target = cur + 20; // jump forward 20s
      const t0 = performance.now();
      tryCatch('q4.seek', () => player.seekTo(target, true));

      let bufferedAt = null;
      let reboffered = false;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const st = tryCatch('q4.pollState', () => player.getPlayerState());
        if (st === 3) reboffered = true; // buffering
        if (st === 1 && bufferedAt == null) {
          bufferedAt = performance.now();
          break;
        }
        await sleep(50);
      }
      const landedAt = tryCatch('q4.landed', () => player.getCurrentTime());
      trials.push({
        targetSec: target,
        latencyMs: bufferedAt != null ? bufferedAt - t0 : null,
        reboffered,
        overshootSec: landedAt != null ? landedAt - target : null,
      });
      await sleep(500);
    }
    return { testable: true, trials };
  }

  // ---- Q5: stable DOM mount anchors ----------------------------------------

  function probeDomAnchors() {
    const candidates = [
      'ytmusic-app',
      'ytmusic-app-layout',
      'ytmusic-nav-bar',
      '#right-content.ytmusic-nav-bar',
      'ytmusic-player-bar',
      '#movie_player',
      'ytmusic-player-page',
      'ytmusic-player-queue',
      'tp-yt-app-drawer',
      '#layout ytmusic-player-queue',
      'ytmusic-popup-container',
    ];
    const found = {};
    for (const sel of candidates) {
      found[sel] = tryCatch('q5.query.' + sel, () => !!document.querySelector(sel));
    }
    return { snapshotAt: new Date().toISOString(), found };
  }

  // ---- Q6: ad detection ------------------------------------------------------

  function probeAds() {
    const player = getPlayer();
    const adClassHits = [
      '.ad-showing',
      '.ytp-ad-player-overlay',
      '.ytp-ad-text',
      'ytmusic-player-bar[has-ad]',
      '.ad-interrupting',
    ].reduce((acc, sel) => {
      acc[sel] = tryCatch('q6.query.' + sel, () => !!document.querySelector(sel));
      return acc;
    }, {});

    let playerAdData = null;
    tryCatch('q6.adData', () => {
      if (player && typeof player.getAdState === 'function') {
        playerAdData = { getAdState: player.getAdState() };
      } else if (player && typeof player.getAdData === 'function') {
        playerAdData = { getAdData: player.getAdData() };
      }
    });

    return { adClassHits, playerAdData, note: 'Best captured while an ad is actually playing; run interactively.' };
  }

  // ---- Q7: ytcfg + InnerTube search from page context ----------------------

  async function probeInnertube() {
    const ytcfgPresent = typeof window.ytcfg !== 'undefined';
    if (!ytcfgPresent) return { ytcfgPresent: false };

    const apiKey = tryCatch('q7.apiKey', () => window.ytcfg.get('INNERTUBE_API_KEY'));
    const clientVersion = tryCatch('q7.clientVersion', () =>
      window.ytcfg.get('INNERTUBE_CLIENT_VERSION')
    );
    const clientName = tryCatch('q7.clientName', () => window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_NAME'));
    const context = tryCatch('q7.context', () => window.ytcfg.get('INNERTUBE_CONTEXT'));

    let searchOk = null;
    let searchStatus = null;
    if (apiKey && context) {
      searchOk = await tryCatchAsync('q7.search', async () => {
        const res = await fetch(
          `https://music.youtube.com/youtubei/v1/search?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ context, query: 'test' }),
            credentials: 'include',
          }
        );
        searchStatus = res.status;
        return res.ok;
      });
    }

    return { ytcfgPresent: true, apiKey: !!apiKey, clientVersion, clientName, searchOk, searchStatus };
  }

  // ---- login heuristic (does not touch credentials, just DOM signal) -------

  function probeLoggedIn() {
    return tryCatch('loggedIn', () => {
      const avatar = document.querySelector('#avatar-btn, ytmusic-settings-button img, #account-name');
      return !!avatar;
    });
  }

  async function runAll() {
    report.loggedIn = probeLoggedIn();
    report.q1_playerApi = await probePlayerApi();
    report.q2_playbackRate = await probePlaybackRate();
    report.q3_store = probeStore();
    report.q4_seekCost = await probeSeekCost();
    report.q5_domAnchors = probeDomAnchors();
    report.q6_ads = probeAds();
    report.q7_innertube = await probeInnertube();
    report.finishedAt = new Date().toISOString();
    return report;
  }

  function printReport() {
    const json = JSON.stringify(report, null, 2);
    console.log('[WeListen probe]', report);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).catch(() => {});
    }
    return json;
  }

  window.__weListenProbe = {
    runAll,
    report: printReport,
    tryDispatchTest,
    _internal: { probePlayerApi, probePlaybackRate, probeStore, probeSeekCost, probeDomAnchors, probeAds, probeInnertube },
    _report: report,
  };
})();
