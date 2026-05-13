(function () {
  var streamEl = document.getElementById('job-stream');
  if (!streamEl) return;

  var jobId = streamEl.dataset.jobId;
  var startedAt = parseFloat(streamEl.dataset.startedAt) || 0;
  var statusEl = document.getElementById('job-status');
  var killBar = document.getElementById('kill-bar');
  var killBtn = document.getElementById('kill-btn');
  var evt = new EventSource('/jobs/' + jobId + '/stream');
  var isTerminal = false;
  var errorCount = 0;
  var killTimer = null;

  // Cap the rendered buffer at this many rows. The full event log is
  // persisted server-side; this is purely DOM hygiene to keep long
  // pipelines (100 rules × N nodes) from accumulating thousands of
  // children and pegging layout/paint.
  var BUFFER_CAP = 2000;

  // ── Cleanup on hx-boost navigation away ────────────────────────
  // Without this the EventSource keeps the connection open until the
  // tab is closed — every job page visited leaks one persistent SSE.
  // `once: true` so accumulated listeners don't pile up across nav.
  function cleanup() {
    if (evt) { try { evt.close(); } catch (_) {} evt = null; }
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
  }
  document.addEventListener('htmx:beforeSwap', cleanup, { once: true });
  // pagehide covers tab close, hard reload, and bfcache evictions —
  // releases the server-side stream FD faster than waiting for TCP RST.
  window.addEventListener('pagehide', cleanup, { once: true });

  // ── rAF-batched auto-scroll ────────────────────────────────────
  // Setting scrollTop after every appended line forces a synchronous
  // layout. With high-frequency events (preflight phase, large fleets)
  // that's hundreds of forced reflows per second. One scroll per paint
  // frame is indistinguishable to the user and dramatically cheaper.
  var pendingScroll = false;
  function scheduleScroll() {
    if (pendingScroll) return;
    pendingScroll = true;
    requestAnimationFrame(function () {
      streamEl.scrollTop = streamEl.scrollHeight;
      pendingScroll = false;
    });
  }

  function trimBuffer() {
    while (streamEl.children.length > BUFFER_CAP) {
      streamEl.removeChild(streamEl.firstChild);
    }
  }

  // ── Output mode toggle (human vs raw) ──────────────────────────
  // Default to human-friendly; raw additionally shows kind='debug'
  // events forwarded from the platform_atlas Python logger. State is
  // persisted in localStorage so the choice survives page reloads.
  var MODE_KEY = 'atlas-job-stream-mode';
  var savedMode = localStorage.getItem(MODE_KEY) || 'human';
  function applyMode(mode) {
    streamEl.classList.remove('mode-human', 'mode-raw');
    streamEl.classList.add('mode-' + mode);
    var hint = document.getElementById('stream-mode-hint');
    if (hint) {
      hint.textContent = mode === 'raw'
        ? 'curated narrative + raw debug logs'
        : 'curated narrative only';
    }
  }
  applyMode(savedMode);

  var modeWrap = document.getElementById('stream-mode');
  if (modeWrap) {
    modeWrap.dataset.mode = savedMode;
    var pills = modeWrap.querySelectorAll('.stream-mode-pill');
    pills.forEach(function (pill) {
      var isCurrent = pill.dataset.mode === savedMode;
      pill.classList.toggle('is-active', isCurrent);
      pill.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
      pill.addEventListener('click', function () {
        var mode = pill.dataset.mode;
        applyMode(mode);
        modeWrap.dataset.mode = mode;
        localStorage.setItem(MODE_KEY, mode);
        pills.forEach(function (p) {
          var active = p.dataset.mode === mode;
          p.classList.toggle('is-active', active);
          p.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      });
    });
  }

  // ── Kill button timer ──────────────────────────────────────────
  if (killBar && startedAt) {
    var elapsed = Date.now() / 1000 - startedAt;
    var delay = Math.max(0, 60 - elapsed) * 1000;
    killTimer = setTimeout(function () {
      killTimer = null;
      // isConnected guard handles the race where the timer fires after
      // the user has already navigated and the killBar node is detached.
      if (!isTerminal && killBar.isConnected) {
        killBar.removeAttribute('hidden');
        killBar.style.display = 'flex';
      }
    }, delay);
  }

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  // Bind directly to the button instead of exposing a window.forceStopJob
  // global. Avoids name collisions and lets the closure capture jobId
  // without re-reading dataset on each click.
  if (killBtn) {
    killBtn.addEventListener('click', function () {
      killBtn.disabled = true;
      killBtn.textContent = 'Stopping…';
      fetch('/jobs/' + jobId + '/cancel', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken() },
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) {
            killBtn.disabled = false;
            killBtn.textContent = 'Force stop';
          }
        })
        .catch(function () {
          killBtn.disabled = false;
          killBtn.textContent = 'Force stop';
        });
    });
  }

  // ── SSE stream ─────────────────────────────────────────────────
  function formatTs(epoch) {
    return new Date(epoch * 1000).toLocaleTimeString([], {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function appendLine(payload) {
    var line = document.createElement('div');
    line.className = 'job-line job-line--' + (payload.kind || 'info');
    line.textContent = '[' + formatTs(payload.timestamp) + '] ' + payload.message;
    streamEl.appendChild(line);
    trimBuffer();
    scheduleScroll();
  }

  var STATUS_LABELS = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', warn: 'WARN' };

  function appendCheck(payload) {
    var data = payload.data || {};
    var status = (data.status || 'skip').toLowerCase();
    var row = document.createElement('div');
    row.className = 'check-row check-row--' + status;

    var dot = document.createElement('span');
    dot.className = 'check-dot check-dot--' + status;

    var name = document.createElement('span');
    name.className = 'check-name';
    name.textContent = data.name || payload.message;

    var badge = document.createElement('span');
    badge.className = 'check-badge check-badge--' + status;
    badge.textContent = STATUS_LABELS[status] || status.toUpperCase();

    var msg = document.createElement('span');
    msg.className = 'check-msg';
    msg.textContent = data.message || '';

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(badge);
    if (data.message) { row.appendChild(msg); }

    if (data.details) {
      var det = document.createElement('span');
      det.className = 'check-detail';
      det.title = data.details;
      det.textContent = data.details;
      row.appendChild(det);
    }

    streamEl.appendChild(row);
    trimBuffer();
    scheduleScroll();
  }

  // ── Preflight target cards (live status on /preflight) ───────
  // When the page contains [data-target-name] cards, route SSE events to
  // them: marching-ants while checking, green/red/amber on completion.
  // Independent of the inline checks panel below, which is only present
  // on the dedicated job page.
  var pfCards = document.querySelectorAll('[data-target-name]');
  var hasCards = pfCards.length > 0;
  var pfSummary = document.getElementById('pf-summary');
  var pfCounts = { pass: 0, fail: 0, warn: 0, skip: 0, total: 0 };

  // Build name/module indexes once instead of linear-scanning per event.
  var pfByName = {};
  var pfByModule = {};
  pfCards.forEach(function (c) {
    var n = c.dataset.targetName;
    if (n) pfByName[n] = c;
    var mods = (c.dataset.targetModules || '').split(',');
    mods.forEach(function (m) {
      m = m.trim();
      // First-wins: matches the previous linear-scan semantics.
      if (m && !pfByModule[m]) pfByModule[m] = c;
    });
  });

  function pfCardByName(name) { return name ? (pfByName[name] || null) : null; }
  function pfCardByModule(mod) { return mod ? (pfByModule[mod] || null) : null; }

  function pfMarkChecking(card) {
    if (!card) return;
    if (card.dataset.pfState === 'checking') return;
    card.dataset.pfState = 'checking';
    var badge = card.querySelector('.pf-status-badge');
    if (badge) { badge.textContent = 'CHECKING'; badge.hidden = false; badge.style.color=''; badge.style.borderColor=''; badge.style.background=''; }
  }
  // Worst-status-wins so a single failure on a target doesn't get
  // overwritten by a later passing check on the same card.
  var STATUS_WEIGHT = { pass: 1, skip: 2, warn: 3, fail: 4 };
  function pfMarkResult(card, status) {
    if (!card || !status) return;
    var s = String(status).toLowerCase();
    if (!STATUS_WEIGHT[s]) return;
    var prev = card.dataset.pfState;
    if (STATUS_WEIGHT[prev] && STATUS_WEIGHT[prev] >= STATUS_WEIGHT[s]) return;
    card.dataset.pfState = s;
    var badge = card.querySelector('.pf-status-badge');
    if (badge) { badge.textContent = s.toUpperCase(); badge.hidden = false; }
  }
  // Hoisted regexes — compiled once at module load instead of per-event.
  var RE_PROBE_SSH    = /Probing\s+SSH\s+→\s+(\S+)/i;
  var RE_CHECK_SVCS   = /Checking\s+services\s+on\s+(\S+?):/i;
  var RE_CONN_MONGO   = /Connecting\s+to\s+MongoDB/i;
  var RE_CONN_REDIS   = /Connecting\s+to\s+Redis/i;
  var RE_CONN_PLATFORM= /Connecting\s+to\s+Platform\s+OAuth/i;
  var RE_CONN_GW4     = /Connecting\s+to\s+Gateway4/i;
  var RE_TRAIL        = /[…\.\s]+$/;
  var RE_ARROW        = /[→]|->|—/;
  var RE_HOST_PARENS  = /\s*\([^)]*\)\s*$/;

  function pfStripTrailing(s) { return String(s || '').replace(RE_TRAIL, ''); }
  function pfCardFromInfo(message) {
    if (!message) return null;
    var m;
    m = message.match(RE_PROBE_SSH);     if (m) return pfCardByName(pfStripTrailing(m[1]));
    m = message.match(RE_CHECK_SVCS);    if (m) return pfCardByName(pfStripTrailing(m[1]));
    if (RE_CONN_MONGO.test(message))     return pfCardByModule('mongo');
    if (RE_CONN_REDIS.test(message))     return pfCardByModule('redis');
    if (RE_CONN_PLATFORM.test(message))  return pfCardByModule('platform');
    if (RE_CONN_GW4.test(message))       return pfCardByModule('gateway4_api');
    return null;
  }
  function pfCardFromCheck(data) {
    if (!data || !data.name) return null;
    var n = String(data.name);
    var match = n.match(RE_ARROW);
    if (match) {
      var idx = n.lastIndexOf(match[0]);
      var rhs = n.substring(idx + match[0].length).trim();
      rhs = rhs.replace(RE_HOST_PARENS, '').trim();
      if (rhs) {
        var card = pfCardByName(rhs);
        if (card) return card;
      }
    }
    if (/mongo/i.test(n))    return pfCardByModule('mongo');
    if (/redis/i.test(n))    return pfCardByModule('redis');
    if (/platform/i.test(n)) return pfCardByModule('platform');
    if (/gateway/i.test(n))  return pfCardByModule('gateway4_api');
    return null;
  }
  function pfFinalize() {
    pfCards.forEach(function (c) {
      if (c.dataset.pfState === 'checking' || c.dataset.pfState === 'pending') {
        pfMarkResult(c, 'skip');
      }
    });
    if (pfSummary) {
      pfCards.forEach(function (c) {
        var s = c.dataset.pfState;
        if (STATUS_WEIGHT[s]) { pfCounts[s] = (pfCounts[s]||0) + 1; pfCounts.total++; }
      });
      var pass = 0, fail = 0;
      pfCards.forEach(function (c) {
        if (c.dataset.pfState === 'pass') pass++;
        else if (c.dataset.pfState === 'fail') fail++;
      });
      pfSummary.textContent = pass + ' pass · ' + fail + ' fail';
      // Use the existing theme tokens so the colors track [data-mode]
      // and [data-theme] instead of being hardcoded oklch literals.
      pfSummary.style.background = fail ? 'var(--bad-soft)' : 'var(--ok-soft)';
      pfSummary.style.color = fail ? 'var(--bad)' : 'var(--ok)';
    }
  }

  // ── Preflight checks panel (preflight jobs only) ─────────────
  var pfCard = document.querySelector('[data-pf-logs]');
  var pfList = document.getElementById('pf-list');
  var pfCurrent = document.getElementById('pf-current');
  var pfCurrentText = document.getElementById('pf-current-text');
  var pfToggle = document.getElementById('pf-toggle-logs');
  var isPreflight = !!pfList;

  if (pfToggle && pfCard) {
    pfToggle.addEventListener('click', function () {
      var hidden = pfCard.getAttribute('data-pf-logs') === 'hidden';
      if (hidden) {
        pfCard.removeAttribute('data-pf-logs');
        pfToggle.textContent = 'Hide full output logs ↑';
        pfToggle.setAttribute('aria-expanded', 'true');
      } else {
        pfCard.setAttribute('data-pf-logs', 'hidden');
        pfToggle.textContent = 'Show full output logs ↓';
        pfToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function pfAddPhase(message) {
    if (!pfList) return;
    var div = document.createElement('div');
    div.className = 'pf-phase';
    div.textContent = message;
    pfList.appendChild(div);
  }
  function pfAddCheck(payload) {
    if (!pfList) return;
    var data = payload.data || {};
    var status = (data.status || 'skip').toLowerCase();
    var row = document.createElement('div');
    row.className = 'pf-row ' + status;
    var dot = document.createElement('span'); dot.className = 'pf-dot';
    var name = document.createElement('span'); name.className = 'pf-name';
    name.textContent = data.name || payload.message || '';
    var badge = document.createElement('span'); badge.className = 'pf-badge';
    badge.textContent = status.toUpperCase();
    row.appendChild(dot); row.appendChild(name); row.appendChild(badge);
    if (data.message && data.message !== data.name) {
      var msg = document.createElement('span'); msg.className = 'pf-msg';
      msg.textContent = data.message;
      row.appendChild(msg);
    }
    pfList.appendChild(row);
    pfHideCurrent();
  }
  function pfShowCurrent(text) {
    if (!pfCurrent) return;
    pfCurrentText.textContent = text;
    pfCurrent.hidden = false;
  }
  function pfHideCurrent() {
    if (!pfCurrent) return;
    pfCurrent.hidden = true;
  }
  var PF_ACTIVITY = [
    /^Probing\s+SSH\s+→\s+(.+?)\s*[…\.]*$/i,
    /^Checking\s+services\s+on\s+(.+?):/i,
    /^Connecting\s+to\s+(.+?)\s*[…\.]*$/i,
  ];
  function pfMaybeShowFromInfo(message) {
    if (!message || !pfCurrent) return;
    for (var i = 0; i < PF_ACTIVITY.length; i++) {
      var m = String(message).match(PF_ACTIVITY[i]);
      if (m) { pfShowCurrent(m[1]); return; }
    }
  }

  // ── Pipeline progress bar (Run full pipeline only) ───────────
  // Per-stage state tracking: each stop independently goes pending → active
  // → pass | fail. The fill bar is anchored to the highest "advanced past"
  // stage and refuses to move past a failure point so the user has visual
  // proof that Capture/Validate/Report each actually completed.
  var isPipeline = streamEl.dataset.jobKind === 'pipeline';
  var ppEl = isPipeline ? document.getElementById('pipeline-progress') : null;
  var ppStatus = isPipeline ? document.getElementById('pp-status') : null;
  var ppFill = isPipeline ? document.getElementById('pp-fill') : null;
  var ppStops = isPipeline ? [
    null,
    document.getElementById('pp-stop-1'),
    document.getElementById('pp-stop-2'),
    document.getElementById('pp-stop-3')
  ] : null;
  var STAGE_LABEL = { 1: 'Capture', 2: 'Validate', 3: 'Report' };
  // 'pending' | 'active' | 'pass' | 'fail' — index 0 unused
  var stageState = [null, 'pending', 'pending', 'pending'];
  var currentStage = 0;

  function ppApplyClasses(stage) {
    if (!ppStops || !ppStops[stage]) return;
    var s = ppStops[stage];
    s.classList.remove('is-active', 'is-done', 'is-pass', 'is-fail');
    var st = stageState[stage];
    if (st === 'active') s.classList.add('is-active');
    else if (st === 'pass') { s.classList.add('is-done', 'is-pass'); }
    else if (st === 'fail') { s.classList.add('is-done', 'is-fail'); }
  }
  function ppSetFill(pct, isFail) {
    if (!ppEl) return;
    ppEl.style.setProperty('--pp-pct', pct + '%');
    if (ppFill) ppFill.classList.toggle('is-fail', !!isFail);
  }
  function ppMarkActive(stage) {
    if (!ppEl || stage < 1 || stage > 3) return;
    // Don't move backward — once a stage has a terminal state, leave it.
    if (currentStage > stage) return;
    // Any earlier stage that hasn't been explicitly marked pass/fail counts
    // as pass at this point (the runner only emits "Stage N of 3" for N+1
    // after N completed successfully).
    for (var i = 1; i < stage; i++) {
      if (stageState[i] === 'pending' || stageState[i] === 'active') {
        stageState[i] = 'pass';
        ppApplyClasses(i);
      }
    }
    stageState[stage] = 'active';
    currentStage = stage;
    ppApplyClasses(stage);
    var pct = ((stage - 1) / 3) * 100 + 8;
    ppSetFill(pct, false);
    if (ppStatus) ppStatus.innerHTML = 'Stage ' + stage + ' of 3 &mdash; <b>' + STAGE_LABEL[stage] + '</b>';
  }
  function ppMarkPass(stage) {
    if (!ppEl || stage < 1 || stage > 3) return;
    stageState[stage] = 'pass';
    ppApplyClasses(stage);
    ppSetFill((stage / 3) * 100, false);
  }
  function ppMarkFail(stage) {
    if (!ppEl || stage < 1 || stage > 3) return;
    stageState[stage] = 'fail';
    ppApplyClasses(stage);
    // Pin the fill to "just past the previous stage" so it visibly stops
    // before the failed dot — never advance through a failure.
    ppSetFill(((stage - 1) / 3) * 100 + 8, true);
    if (ppStatus) {
      ppStatus.innerHTML = '<b style="color:var(--bad)">Stage ' + stage + ' of 3 failed &mdash; ' + STAGE_LABEL[stage] + '</b>';
    }
  }
  function ppAllPassed() {
    return stageState[1] === 'pass' && stageState[2] === 'pass' && stageState[3] === 'pass';
  }
  function ppHandle(message) {
    if (!ppEl || !message) return;
    var m = String(message);
    var match = m.match(/Stage\s+(\d)\s+of\s+3/i);
    if (match) { ppMarkActive(parseInt(match[1], 10)); return; }
    var cm = m.match(/^Stage\s+(\d)\s+complete/i);
    if (cm) {
      var s = parseInt(cm[1], 10);
      ppMarkPass(s);
      return;
    }
    if (/^Pipeline halted at Capture/i.test(m))   { ppMarkFail(1); return; }
    if (/^Pipeline halted at Validate/i.test(m))  { ppMarkFail(2); return; }
    if (/^Report stage failed/i.test(m))           { ppMarkFail(3); return; }
    if (/^Pipeline complete/i.test(m)) {
      // Force any still-pending/active stage to pass (the runner only emits
      // this line once all three sub-jobs returned ok=True).
      for (var i = 1; i <= 3; i++) {
        if (stageState[i] !== 'fail') { stageState[i] = 'pass'; ppApplyClasses(i); }
      }
      ppSetFill(100, false);
      if (ppStatus) ppStatus.innerHTML = '<b style="color:var(--ok)">Pipeline complete</b>';
    }
  }

  // ── Collapsible logs (pipeline only) ──────────────────────────
  // The verbose live-output stream is hidden by default for pipelines so
  // the post-success mini-report has the screen to itself. Users can
  // expand to see the raw event log if they want.
  var logsToggle = document.getElementById('logs-toggle');
  var logsBody   = document.getElementById('logs-body');
  if (logsToggle && logsBody) {
    logsToggle.addEventListener('click', function () {
      var expanded = logsToggle.getAttribute('aria-expanded') === 'true';
      var next = !expanded;
      logsToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      var label = logsToggle.querySelector('.label');
      if (label) label.textContent = next ? 'Hide live output & debug log' : 'Show live output & debug log';
      if (next) { logsBody.removeAttribute('hidden'); }
      else      { logsBody.setAttribute('hidden', ''); }
    });
  }

  // ── Mini-report rendering (pipeline succeeded) ────────────────
  // Only revealed when (a) the terminal status was 'succeeded' AND (b)
  // every stop is in 'pass' state. If the pipeline halted partway, the
  // mini-report stays hidden and the failed dot does the talking.
  function loadMiniReport() {
    var host = document.getElementById('mini-report');
    if (!host) return;
    var sessionName = host.dataset.sessionName;
    if (!sessionName) return;
    fetch('/sessions/' + encodeURIComponent(sessionName) + '/summary.json', {
      credentials: 'same-origin',
    })
      .then(function (r) { if (!r.ok) throw new Error('summary fetch failed'); return r.json(); })
      .then(function (data) { renderMiniReport(host, data); })
      .catch(function (err) {
        // Fail soft — the user still has the standard "Continue" button
        // in the page header so the failure path isn't dead-ended.
        appendLine({ kind: 'warning', message: 'Could not load mini-report summary: ' + err.message,
                     timestamp: Date.now() / 1000 });
      });
  }
  function renderMiniReport(host, data) {
    var pct = data.compliance_pct || 0;
    var fail = data.fail_count || 0;
    document.getElementById('mr-eyebrow').textContent = fail === 0 ? 'PASSED · 100% PASS RATE' : 'COMPLETED · ' + fail + ' FINDING' + (fail === 1 ? '' : 'S');
    document.getElementById('mr-title').textContent = 'Compliance audit · ' + (data.environment || data.name);
    var subParts = [];
    if (data.ruleset_id) subParts.push(data.ruleset_id);
    if (data.ruleset_profile) subParts.push(data.ruleset_profile);
    subParts.push(data.total_rules + ' rules');
    document.getElementById('mr-sub').textContent = subParts.join(' · ');
    document.getElementById('mr-pass').textContent = data.pass_count || 0;
    document.getElementById('mr-fail').textContent = fail;
    document.getElementById('mr-skip').textContent = data.skip_count || 0;

    // Findings pills were removed from the compact mini-report; the full
     // breakdown is one click away via "Open full report". Keep the host
     // lookup defensive so future re-additions of #mr-pills just work.
    var pillsHost = document.getElementById('mr-pills');
    var fails = data.failures || [];
    if (pillsHost) {
      pillsHost.innerHTML = '';
      fails.forEach(function (f) {
        var p = document.createElement('span');
        p.className = 'pmr-pill ' + (f.severity === 'critical' ? 'bad' : 'warn');
        var rn = document.createElement('code');
        rn.textContent = f.rule_number;
        p.appendChild(rn);
        p.appendChild(document.createTextNode(' ' + f.name));
        pillsHost.appendChild(p);
      });
    }

    var continueBtn = document.getElementById('mr-continue');
    if (continueBtn) {
      continueBtn.href = streamEl.dataset.returnUrl || ('/sessions/' + encodeURIComponent(data.name));
    }
    var openBtn = document.getElementById('mr-open-report');
    if (openBtn) {
      if (data.report_file_url) {
        openBtn.href = data.report_file_url;
        openBtn.removeAttribute('hidden');
      } else {
        openBtn.setAttribute('hidden', '');
      }
    }

    host.removeAttribute('hidden');
    animateMiniReport(pct, fails.length);
  }
  function animateMiniReport(pct, pillCount) {
    var ring = document.getElementById('mr-ring');
    var num = document.getElementById('mr-num');
    var pills = document.querySelectorAll('#mr-pills .pmr-pill');
    var C_LEN = 666;
    // Use anime.js v4 if loaded (script tag in jobs/detail.html), with a
    // plain-rAF fallback so a missing CDN never leaves the user looking
    // at a static "0%" badge.
    if (window.anime && typeof anime.animate === 'function') {
      var proxy = { v: 0 };
      anime.animate(proxy, {
        v: pct, duration: 1500, ease: 'outQuart',
        onUpdate: function () { if (num) num.textContent = Math.round(proxy.v) + '%'; },
      });
      anime.animate(ring, {
        strokeDashoffset: C_LEN * (1 - pct/100),
        duration: 1500, ease: 'outQuart',
      });
      if (pills.length) {
        anime.animate(pills, {
          opacity: [0, 1], translateY: [8, 0],
          duration: 600, ease: 'outQuart',
          delay: anime.stagger(40, { start: 700 }),
        });
      }
    } else {
      var DURATION = 1500;
      var start = performance.now();
      function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }
      function frame(now) {
        var t = Math.min(1, (now - start) / DURATION);
        var e = easeOutQuart(t);
        if (ring) ring.setAttribute('stroke-dashoffset', String(C_LEN * (1 - (pct/100) * e)));
        if (num)  num.textContent = Math.round(pct * e) + '%';
        if (t < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      pills.forEach(function (p, i) {
        setTimeout(function () {
          p.style.transition = 'opacity 0.4s, transform 0.4s';
          p.style.opacity = '1';
          p.style.transform = 'translateY(0)';
        }, 700 + i * 40);
      });
    }
  }

  // ── Single dispatch for narrative events ───────────────────────
  // Was previously six listeners each calling JSON.parse on the same
  // payload — same JSON parsed 6× per event. One handler, one parse.
  function handleNarrative(e) {
    errorCount = 0;
    var payload;
    try { payload = JSON.parse(e.data); } catch (_) { return; }
    appendLine(payload);
    if (isPipeline) ppHandle(payload.message);
    if (isPreflight) {
      if (payload.kind === 'phase') pfAddPhase(payload.message);
      else if (payload.kind === 'info') pfMaybeShowFromInfo(payload.message);
    }
    if (hasCards && payload.kind === 'info') {
      var c = pfCardFromInfo(payload.message);
      if (c) pfMarkChecking(c);
    }
  }
  ['info', 'success', 'warning', 'error', 'phase', 'debug'].forEach(function (k) {
    evt.addEventListener(k, handleNarrative);
  });

  evt.addEventListener('check', function (e) {
    errorCount = 0;
    var payload;
    try { payload = JSON.parse(e.data); } catch (_) { return; }
    appendCheck(payload);
    if (isPreflight) pfAddCheck(payload);
    if (hasCards) {
      var c = pfCardFromCheck(payload.data);
      if (c) pfMarkResult(c, (payload.data || {}).status);
    }
  });

  evt.addEventListener('status', function (e) {
    // Close the stream FIRST so any late event delivered between flag-set
    // and close (the previous race) cannot append after the terminal line.
    if (evt) { try { evt.close(); } catch (_) {} evt = null; }
    isTerminal = true;
    if (killBar) { killBar.hidden = true; }
    var payload;
    try { payload = JSON.parse(e.data); } catch (_) { return; }
    if (statusEl) {
      statusEl.className = 'job-status job-status--' + (payload.data.status || 'failed');
      statusEl.textContent = payload.data.status || 'failed';
    }
    appendLine({
      kind: payload.data.status === 'succeeded' ? 'success' : 'error',
      message: 'Job ' + (payload.data.status || 'finished') + (payload.data.error ? ' — ' + payload.data.error : ''),
      timestamp: payload.timestamp,
    });
    if (isPreflight) pfHideCurrent();
    if (hasCards) pfFinalize();
    if (isPipeline) {
      // If the job ended in failure and a stage was still in-flight, mark
      // it failed now — the runner doesn't always emit a "halted" line for
      // unexpected exceptions.
      if (payload.data.status !== 'succeeded' && currentStage > 0
          && stageState[currentStage] !== 'pass'
          && stageState[currentStage] !== 'fail') {
        ppMarkFail(currentStage);
      }
      // Only reveal the mini-report when *every* stage is verifiably
      // passing AND the terminal status agrees. Either signal alone isn't
      // enough — better to show nothing than to show a misleading score.
      if (payload.data.status === 'succeeded' && ppAllPassed()) {
        loadMiniReport();
      }
    }
  });

  evt.onerror = function () {
    errorCount++;
    // EventSource auto-reconnects on transient blips; logging on every
    // retry produces a flood of "connection closed" lines for what is
    // really one momentary network hiccup. Emit one warning at the
    // third consecutive failure and stay quiet otherwise — successful
    // events reset the counter.
    if (errorCount === 3) {
      appendLine({
        kind: 'warning',
        message: 'Stream connection lost — retrying…',
        timestamp: Date.now() / 1000,
      });
    }
  };
})();
