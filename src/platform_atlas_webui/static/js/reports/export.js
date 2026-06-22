/*
 * Report Export modal controller.
 *
 * Drives the "Report Export" button + modal on the report view — the WebUI
 * twin of the CLI `session export`. Submits the export, shows a working state,
 * then renders the archive's name / size / contents / on-disk path with a
 * Download button, all without leaving the report page.
 *
 * Strict-CSP friendly: no inline handlers. Bound once via event delegation on
 * `document` so it survives htmx-boost body swaps (the modal node is re-created
 * on each navigation, but the delegated listeners persist and re-query live).
 */
(function () {
  "use strict";

  if (window.__atlasReportExportInit) return;
  window.__atlasReportExportInit = true;

  function modal() {
    return document.querySelector("[data-rx-modal]");
  }

  // Toggle the visible body state (form | working | result | error) and the
  // matching footer buttons.
  function setState(m, state) {
    m.querySelectorAll("[data-rx-state]").forEach(function (el) {
      el.hidden = el.getAttribute("data-rx-state") !== state;
    });
    var submit = m.querySelector("[data-rx-submit]");
    var download = m.querySelector("[data-rx-download]");
    var again = m.querySelector("[data-rx-again]");
    var cancel = m.querySelector("[data-rx-cancel]");
    if (submit) submit.hidden = state !== "form";
    if (download) download.hidden = state !== "result";
    if (again) again.hidden = !(state === "result" || state === "error");
    // Once there's a result/error the dialog is "done" — relabel Cancel → Close.
    if (cancel) cancel.textContent = (state === "result" || state === "error") ? "Close" : "Cancel";
  }

  function openModal() {
    var m = modal();
    if (!m) return;
    setState(m, "form");
    m.hidden = false;
    document.body.style.overflow = "hidden";
    var first = m.querySelector('input[name="rx-format"]');
    if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
  }

  function closeModal() {
    var m = modal();
    if (!m) return;
    m.hidden = true;
    document.body.style.overflow = "";
  }

  function fmtSize(bytes) {
    if (typeof bytes !== "number") return "—";
    if (bytes < 1024) return bytes + " B";
    var kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(1) + " KB";
    return (kb / 1024).toFixed(2) + " MB";
  }

  function renderResult(m, data) {
    var name = m.querySelector("[data-rx-archive-name]");
    var size = m.querySelector("[data-rx-size]");
    var contents = m.querySelector("[data-rx-contents]");
    var path = m.querySelector("[data-rx-path]");
    var download = m.querySelector("[data-rx-download]");
    if (name) name.textContent = data.archive_name || "—";
    if (size) size.textContent = fmtSize(data.size_bytes);
    if (contents) {
      contents.textContent = (data.contents && data.contents.length)
        ? data.contents.join(" · ")
        : "—";
    }
    if (path) path.textContent = data.archive_path || "—";
    if (download && data.download_url) download.setAttribute("href", data.download_url);
    setState(m, "result");
  }

  function renderError(m, msg) {
    var box = m.querySelector("[data-rx-error]");
    if (box) box.textContent = msg;
    setState(m, "error");
  }

  function submitExport() {
    var m = modal();
    if (!m) return;
    var action = m.getAttribute("data-rx-action");
    var csrf = m.getAttribute("data-rx-csrf") || "";
    var fmtEl = m.querySelector('input[name="rx-format"]:checked');
    var fmt = fmtEl ? fmtEl.value : "zip";
    var dbgEl = m.querySelector("[data-rx-debug]");
    var dbg = !!(dbgEl && dbgEl.checked);

    setState(m, "working");

    var fd = new FormData();
    fd.append("archive_format", fmt);
    fd.append("include_debug", dbg ? "true" : "false");

    fetch(action, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: fd,
      credentials: "same-origin",
    }).then(function (resp) {
      return resp.json().catch(function () { return null; }).then(function (data) {
        if (!resp.ok) {
          var detail = (data && (data.detail || data.error)) || ("Export failed (HTTP " + resp.status + ")");
          throw new Error(detail);
        }
        renderResult(m, data || {});
      });
    }).catch(function (err) {
      renderError(m, (err && err.message) || "Export failed. Please try again.");
    });
  }

  // ── Delegated listeners (bound once; survive htmx-boost body swaps) ──
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest("[data-rx-open]")) { ev.preventDefault(); openModal(); return; }
    if (t.closest("[data-rx-close], [data-rx-cancel]")) { ev.preventDefault(); closeModal(); return; }
    if (t.closest("[data-rx-submit]")) { ev.preventDefault(); submitExport(); return; }
    if (t.closest("[data-rx-again]")) {
      ev.preventDefault();
      var m = modal();
      if (m) setState(m, "form");
      return;
    }
    // The download link is a native <a download> — let it proceed untouched.
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    var m = modal();
    if (m && !m.hidden) closeModal();
  });
})();
