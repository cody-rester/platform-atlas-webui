// Atlas WebUI client glue.
// Server renders the right data-theme (aurora|horizon) and data-mode
// (light|dark) on <html> on every page (no FOUC). This file only handles
// in-page interactions:
//   1. Topbar moon/sun — flips data-mode (theme palette is preserved).
//   2. Settings theme-pick cards — flips data-theme (Aurora ⇄ Horizon).
//   3. Settings mode segment — flips data-mode (Light ⇄ Dark).
//   4. Sidebar upgrade-panel × — dismiss & persist.
// All apply changes optimistically, then PATCH the server for durable
// persistence.

(function () {
  'use strict';

  var APPEARANCE_API = '/api/settings/appearance';
  var UPGRADE_PANEL_API = '/api/settings/upgrade-panel';
  var root = document.documentElement;

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function postForm(url, payload) {
    var body = new URLSearchParams();
    Object.keys(payload).forEach(function (k) { body.append(k, payload[k]); });
    return fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken(),
      },
      body: body.toString(),
    }).catch(function () { /* best-effort; UI already updated */ });
  }

  function currentMode() {
    return root.getAttribute('data-mode') === 'light' ? 'light' : 'dark';
  }

  // Resolve a persisted preference ("light" | "dark" | "auto") into the
  // effective mode used by CSS. "auto" follows the OS prefers-color-scheme;
  // any unknown value falls back to "dark" so a malformed config never
  // produces an unstyled page.
  function resolveEffectiveMode(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    if (pref === 'auto' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  }

  // Wrap a theme/mode swap with `.theme-changing` on <html> so every
  // element interpolates its color tokens for ~700ms (see atlas.css).
  // The class is removed afterwards so per-component transitions
  // defined elsewhere (button hovers, etc.) aren't double-animated.
  var THEME_TRANSITION_MS = 720;
  var _themeTransitionTimer = null;
  function withThemeTransition(fn) {
    root.classList.add('theme-changing');
    fn();
    if (_themeTransitionTimer) clearTimeout(_themeTransitionTimer);
    _themeTransitionTimer = setTimeout(function () {
      root.classList.remove('theme-changing');
      _themeTransitionTimer = null;
    }, THEME_TRANSITION_MS);
  }

  // Apply a mode preference. `pref` is what we persist ("light" | "dark" |
  // "auto"); `data-mode` is always the *effective* value the CSS consumes.
  // When pref is "auto" we still set data-mode-pref="auto" so the page
  // remembers the user's intent across navigations and the media-query
  // listener (bindAutoModeListener) keeps data-mode in sync with the OS.
  function applyMode(pref) {
    var effective = resolveEffectiveMode(pref);
    withThemeTransition(function () {
      root.setAttribute('data-mode', effective);
      root.setAttribute('data-mode-pref', pref);
    });
    postForm(APPEARANCE_API, { mode: pref });
  }

  function applyTheme(theme) {
    withThemeTransition(function () { root.setAttribute('data-theme', theme); });
    postForm(APPEARANCE_API, { theme: theme });
  }

  // ── Topbar moon/sun toggle (flips mode only) ───────────────────
  function bindModeToggles() {
    document.querySelectorAll('[data-atlas-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyMode(currentMode() === 'light' ? 'dark' : 'light');
      });
    });
  }

  // ── Settings: Aurora / Horizon theme-pick cards ────────────────
  function bindThemeSegment() {
    var inputs = document.querySelectorAll('[data-atlas-theme-segment] input[type="radio"]');
    inputs.forEach(function (input) {
      input.addEventListener('change', function () {
        if (!input.checked) return;
        applyTheme(input.value);
        // Manually maintain .is-active on the parent card — older browsers
        // (and CSP-restricted environments) can't rely on :has().
        inputs.forEach(function (other) {
          var card = other.closest('.theme-pick-card');
          if (!card) return;
          card.classList.toggle('is-active', other.checked);
        });
      });
    });
  }

  // ── Settings: Light / Dark mode segment ────────────────────────
  function bindModeSegment() {
    document.querySelectorAll('[data-atlas-mode-segment] input[type="radio"]').forEach(function (input) {
      input.addEventListener('change', function () {
        if (input.checked) applyMode(input.value);
      });
    });
  }

  // ── Sidebar Upgrade-to-Extended panel dismiss ──────────────────
  function bindUpgradeDismiss() {
    document.querySelectorAll('[data-atlas-upgrade-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var panel = btn.closest('.upgrade');
        if (panel) panel.style.display = 'none';
        postForm(UPGRADE_PANEL_API, { dismissed: '1' });
      });
    });
  }

  // ── Tile popovers / toggle pills (mockup parity) ────────────────
  function bindRuleToggles() {
    document.querySelectorAll('[data-toggle]').forEach(function (t) {
      t.addEventListener('click', function () { t.classList.toggle('on'); });
    });
  }

  // ── Form submit: optimistic loading state + confirmation ───────
  // Any <button data-loading-label="…"> swaps text and disables itself when
  // its enclosing form submits. Any <form data-confirm-action> shows a
  // confirmation modal before submitting. Together these cover the polish
  // pattern used on /alerts and /notifications without per-page wiring.
  //
  // Listener runs in CAPTURE phase (third arg `true` below) so it fires
  // before any other submit handler — most importantly, before htmx's
  // hx-boost submit handler that's attached directly on boosted forms.
  // For data-confirm-action forms we additionally call stopPropagation()
  // so the event never reaches htmx's listener at all; otherwise htmx
  // would issue its AJAX request the instant the form is submitted, the
  // server would delete/destroy whatever the action targets, and the
  // confirm modal would just flash on screen as the redirect-response
  // body-swap tore it down. (That was the actual bug behind "modal
  // flashes and the session is deleted anyway.")
  function bindFormFeedback() {
    document.addEventListener('submit', function (ev) {
      var form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;

      // Marker we set on a form after the user OKs the confirm modal —
      // prevents an infinite confirm-loop when we re-fire submit below.
      if (form.dataset.confirmed === '1') return;

      if (form.hasAttribute('data-confirm-action')) {
        ev.preventDefault();
        // Block htmx's form-level submit listener (and any other
        // delegated listener bound below us) from seeing this event.
        // preventDefault alone is not enough — htmx doesn't check
        // ev.defaultPrevented before issuing the AJAX request.
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        var msg   = form.getAttribute('data-confirm-message') || 'Are you sure?';
        var kind  = form.getAttribute('data-confirm-kind')    || 'primary';
        var label = form.getAttribute('data-confirm-label')   || 'Continue';
        var title = form.getAttribute('data-confirm-title')   || 'Are you sure?';
        var ask = (typeof window.atlasConfirm === 'function')
          ? window.atlasConfirm({ title: title, message: msg, kind: kind, confirmLabel: label })
          : Promise.resolve(window.confirm(msg));
        ask.then(function (ok) {
          if (!ok) return;
          // requestSubmit() fires a fresh submit event; our listener
          // sees data-confirmed === '1' on that pass and returns
          // without stopping propagation, so htmx then processes the
          // form normally.
          form.dataset.confirmed = '1';
          form.requestSubmit();
        });
        return;
      }

      var button = form.querySelector('button[type="submit"], button:not([type])');
      if (!button) return;
      var loadingLabel = button.getAttribute('data-loading-label');
      if (!loadingLabel) return;
      button.dataset.originalText = button.innerText;
      button.innerText = loadingLabel;
      button.disabled = true;
      button.classList.add('is-loading');
      // Re-enable after a long fallback so a slow server doesn't permanently
      // freeze the button if the response is delayed past the redirect window.
      setTimeout(function () {
        if (!button.isConnected) return;
        button.disabled = false;
        button.classList.remove('is-loading');
        if (button.dataset.originalText) {
          button.innerText = button.dataset.originalText;
        }
      }, 8000);
    }, true);
  }

  // ── Ack-row fade — optimistic visual on alert ack POSTs ────────
  // The form redirects on success, but we add a brief background pulse so
  // the row visibly responds the moment the user clicks Ack.
  function bindAckFade() {
    document.addEventListener('submit', function (ev) {
      var form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      var action = form.getAttribute('action') || '';
      if (action.indexOf('/alerts/') !== 0 || action.indexOf('/ack') === -1) return;
      var row = form.closest('tr');
      if (row) row.classList.add('is-acking');
    }, true);
  }

  // ── Auto-mode OS preference listener ───────────────────────────
  // When data-mode-pref="auto", the user is asking us to follow the OS
  // prefers-color-scheme. The pre-paint script in <head> handles initial
  // load; this listener keeps data-mode in sync if the OS theme flips
  // mid-session (sunset triggers macOS Auto, user toggles dark mode, etc.).
  //
  // One-time setup — like bindHtmxSwapOnFormErrors, this binds to a
  // matchMedia instance that lives outside the DOM and survives hx-boost
  // body swaps. Re-binding on every swap would stack duplicate listeners.
  function bindAutoModeListener() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function (ev) {
      if (root.getAttribute('data-mode-pref') !== 'auto') return;
      var effective = ev.matches ? 'dark' : 'light';
      withThemeTransition(function () { root.setAttribute('data-mode', effective); });
    };
    // addEventListener is the modern API; Safari < 14 only had addListener.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(onChange);
    }
  }

  // ── htmx 4xx swap policy ───────────────────────────────────────
  // htmx defaults to NOT swapping responses with non-2xx status codes,
  // which is the wrong default for forms that re-render themselves on
  // validation failure. /sessions POST returns 422 with the form
  // template re-rendered (showing an inline "session already exists"
  // flash), and the user just sees nothing happen because htmx
  // discards the response. Same pattern applies to any form route that
  // returns 4xx with a renderable HTML body.
  //
  // We allow swapping ONLY when the response is text/html — JSON 422s
  // from FastAPI's automatic validation handler shouldn't be dumped
  // into the body. Document-level listener so it survives hx-boost
  // body swaps without re-binding.
  function bindHtmxSwapOnFormErrors() {
    document.addEventListener('htmx:beforeSwap', function (evt) {
      var xhr = evt.detail && evt.detail.xhr;
      if (!xhr) return;
      var status = xhr.status;
      // Form-level validation responses we want to render: 422
      // (FastAPI semantic-validation), 400 (custom bad-request HTML),
      // 409 (conflict re-renders). Add others if/when we adopt them.
      if (status !== 422 && status !== 400 && status !== 409) return;
      var ct = (xhr.getResponseHeader('Content-Type') || '').toLowerCase();
      if (ct.indexOf('text/html') === -1) return;
      evt.detail.shouldSwap = true;
      evt.detail.isError = false;
    });
  }

  function init() {
    bindModeToggles();
    bindThemeSegment();
    bindModeSegment();
    bindUpgradeDismiss();
    bindRuleToggles();
    bindFormFeedback();
    bindAckFade();
  }

  // bindHtmxSwapOnFormErrors uses document-level delegation, so it must be
  // bound exactly once — calling it from init() on every htmx:afterSwap
  // would stack a fresh listener per navigation. Same story for
  // bindAutoModeListener (matchMedia listener lives on the media-query
  // object, not the DOM).
  bindHtmxSwapOnFormErrors();
  bindAutoModeListener();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── hx-boost re-init ───────────────────────────────────────────
  // hx-boost on <body> swaps body.innerHTML on every cross-page nav, so
  // direct addEventListener bindings (theme toggle, theme picker, upgrade
  // dismiss, etc.) on the old DOM nodes are detached. Document-level
  // delegation listeners (form submit feedback, ack fade) survive — they
  // stay attached to `document`. For the rest, re-run init() after each
  // swap. Re-binding the same handlers on the same logical buttons is
  // cheap, and addEventListener naturally dedupes if the function ref
  // matches (it doesn't here, since our handlers are anonymous closures
  // — but the SET of new DOM nodes is fresh, so there are no duplicates).
  document.body.addEventListener('htmx:afterSwap', function () {
    init();
    stampCascade();
  });

  // ── Cascade reveal stagger ─────────────────────────────────────
  // Pure CSS handles the entrance animation; this just stamps an --i
  // index on each direct child of any [data-cascade] container so the
  // CSS keyframe can compute a staggered animation-delay.
  function stampCascade() {
    document.querySelectorAll('[data-cascade]').forEach(function (group) {
      Array.prototype.forEach.call(group.children, function (child, i) {
        child.style.setProperty('--i', i);
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', stampCascade);
  } else {
    stampCascade();
  }
})();


/* ──────────────────────────────────────────────────────────────────
   v1.7.2 release-polish JS helpers (items 12, 13, 17, 18, 19).
   Each helper is a tiny IIFE-bound module that wires up to a data
   attribute, so templates opt in without bespoke JS per page.
   ────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── (18) Pluralize helper ─────────────────────────────────────
     Expose window.AtlasPluralize for templates that compose strings
     in JS. Server-rendered templates should use Jinja's own
     pluralize filter — this is for client-only paths (htmx swaps,
     SSE streams). */
  function pluralize(n, singular, plural) {
    var count = Number(n);
    if (Number.isNaN(count)) count = 0;
    var word = (count === 1) ? singular : (plural || (singular + 's'));
    return count + ' ' + word;
  }
  window.AtlasPluralize = pluralize;

  /* ── (19) Relative time with absolute hover tooltip ────────────
     Any element with `data-relative-time="<ISO>"` renders the
     relative form ("2 hours ago") with the absolute UTC time on
     hover (via `title`). Re-runs every 60s so the rendered string
     stays roughly correct without forcing a page refresh. */
  function formatRelative(iso) {
    var t = new Date(iso);
    if (Number.isNaN(t.getTime())) return iso;
    var diff = Math.round((Date.now() - t.getTime()) / 1000); // seconds, +ve = past
    var abs = Math.abs(diff);
    var future = diff < 0;
    var label;
    if (abs < 5)              label = future ? 'in a moment' : 'just now';
    else if (abs < 60)        label = abs + 's' + (future ? ' from now' : ' ago');
    else if (abs < 3600)      label = Math.round(abs / 60) + 'm' + (future ? ' from now' : ' ago');
    else if (abs < 86400)     label = Math.round(abs / 3600) + 'h' + (future ? ' from now' : ' ago');
    else if (abs < 86400 * 7) label = Math.round(abs / 86400) + 'd' + (future ? ' from now' : ' ago');
    else                      label = t.toISOString().slice(0, 10);  // YYYY-MM-DD
    return label;
  }
  function paintRelativeTimes() {
    document.querySelectorAll('[data-relative-time]').forEach(function (el) {
      var iso = el.getAttribute('data-relative-time');
      if (!iso) return;
      el.textContent = formatRelative(iso);
      if (!el.title) el.title = iso.replace('T', ' ').replace('Z', ' UTC');
    });
  }
  window.AtlasRelativeTime = formatRelative;

  /* ── (12) Last-updated badge ───────────────────────────────────
     Any element with `data-last-updated="<ISO>"` becomes a "updated
     14s ago" chip. Adds .fresh / .stale class based on age so the
     dot lights up green / orange. Reuses the relative-time render. */
  function paintLastUpdated() {
    document.querySelectorAll('[data-last-updated]').forEach(function (el) {
      var iso = el.getAttribute('data-last-updated');
      if (!iso) return;
      var t = new Date(iso);
      var ageSec = Number.isNaN(t.getTime()) ? null : (Date.now() - t.getTime()) / 1000;
      el.classList.remove('fresh', 'stale');
      if (ageSec !== null && ageSec < 60)   el.classList.add('fresh');
      else if (ageSec !== null && ageSec > 600) el.classList.add('stale');
      el.textContent = 'updated ' + (ageSec === null ? '?' : formatRelative(iso));
      if (!el.title && !Number.isNaN(t.getTime())) {
        el.title = t.toISOString().replace('T', ' ').replace('Z', ' UTC');
      }
    });
  }

  /* ── (13) Copy-to-clipboard pills ──────────────────────────────
     Markup:
       <span class="copy-pill">
         <span data-copy-text>some/path/here</span>
         <button data-copy-pill aria-label="Copy">⧉</button>
       </span>
     The button copies the sibling [data-copy-text] (or, if missing,
     the parent's textContent minus its own label). Briefly flips
     the button to a "copied" state. */
  function attachCopyPills(root) {
    var scope = root || document;
    scope.querySelectorAll('button[data-copy-pill]').forEach(function (btn) {
      if (btn.__atlasCopyBound) return;
      btn.__atlasCopyBound = true;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var pill = btn.closest('.copy-pill') || btn.parentElement;
        var src  = pill && pill.querySelector('[data-copy-text]');
        var text = src ? src.textContent.trim()
                       : (pill ? pill.textContent.trim() : btn.textContent.trim());
        if (!text) return;
        var done = function () {
          var prev = btn.textContent;
          btn.setAttribute('data-copied', '1');
          btn.textContent = '✓';
          setTimeout(function () {
            btn.removeAttribute('data-copied');
            btn.textContent = prev || '⧉';
          }, 1100);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(legacyFallback);
        } else {
          legacyFallback();
        }
        function legacyFallback() {
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('aria-hidden', 'true');
            ta.style.position = 'fixed';
            ta.style.opacity  = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            done();
          } catch (e) {
            /* swallow — copy is best-effort */
          }
        }
      });
    });
  }

  /* ── (17) Confirm-by-typing for destructive actions ────────────
     Markup:
       <form data-confirm-by-typing="prod"
             data-confirm-button="#delete-btn">
         <input data-confirm-input>
         <button id="delete-btn" type="submit" disabled>Delete</button>
       </form>
     The submit button stays disabled until the input matches the
     value of `data-confirm-by-typing` exactly. Case-sensitive on
     purpose — Stripe's pattern. */
  function attachConfirmByTyping(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-confirm-by-typing]').forEach(function (form) {
      var expected = form.getAttribute('data-confirm-by-typing');
      var btnSel = form.getAttribute('data-confirm-button');
      var input = form.querySelector('[data-confirm-input]');
      var btn = btnSel ? form.querySelector(btnSel) : null;
      if (!expected || !input || !btn) return;
      var sync = function () {
        var match = input.value === expected;
        btn.disabled = !match;
        btn.setAttribute('aria-disabled', match ? 'false' : 'true');
      };
      input.addEventListener('input', sync);
      sync();
    });
  }

  /* ── Boot + htmx-rebind ────────────────────────────────────────
     We run on DOMContentLoaded for the first paint, then re-run all
     attachers after every htmx swap so partial replacements light
     up without page-level glue. Relative timestamps tick every 60s. */
  function boot() {
    paintRelativeTimes();
    paintLastUpdated();
    attachCopyPills(document);
    attachConfirmByTyping(document);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  document.body && document.body.addEventListener('htmx:afterSettle', function (ev) {
    var target = ev && ev.target ? ev.target : document;
    attachCopyPills(target);
    attachConfirmByTyping(target);
    paintRelativeTimes();
    paintLastUpdated();
  });
  setInterval(function () {
    paintRelativeTimes();
    paintLastUpdated();
  }, 60000);

})();
