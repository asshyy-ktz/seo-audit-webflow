/**
 * App Panel controller for seo-audit-webflow. Talks to this app's own backend (/api/sites/:siteId/...);
 * site identity comes from the ?site= query param set by the OAuth callback, or from the Designer
 * runtime's webflow.getSiteInfo(). No chart library: the trend is a hand-rolled Canvas sparkline.
 */
(function () {
  "use strict";

  var API_BASE = window.location.origin.replace(/\/designer-extension.*/, "");
  var SEV_RANK = { critical: 0, warning: 1, info: 2 };

  var state = {
    siteId: null,
    tab: "open",
    severity: "",
    findings: [],
    subjects: {},
    runs: [],
    ignoreRules: {},
    running: false,
    pollTimer: null,
    sparkPoints: [],
    sparkHover: -1,
  };

  // ---------- helpers ----------

  function api(path, options) {
    var opts = Object.assign({ headers: { "Content-Type": "application/json" } }, options || {});
    return fetch(API_BASE + "/api/sites/" + state.siteId + path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || r.statusText);
        return body;
      });
    });
  }

  function $(id) { return document.getElementById(id); }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "class") node.className = props[k];
      else if (k === "text") node.textContent = props[k];
      else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function notify(msg, isError) {
    var s = $("status");
    s.hidden = !msg;
    s.textContent = msg || "";
    s.className = "status" + (isError ? " error" : "");
  }

  function scoreClass(score) { return score >= 85 ? "good" : score >= 60 ? "ok" : "bad"; }

  function resolveSiteId() {
    var q = new URL(window.location.href).searchParams.get("site");
    if (q) return Promise.resolve(q);
    if (window.webflow && window.webflow.getSiteInfo) {
      return window.webflow.getSiteInfo().then(function (i) { return i.siteId; });
    }
    return Promise.resolve(null);
  }

  // ---------- summary + sparkline ----------

  function renderSummary(data) {
    var latest = data.latest;
    state.running = data.running;
    $("run-audit").disabled = data.running;
    $("run-audit").textContent = data.running ? "Auditing..." : "Run audit";
    $("thin-words").value = data.settings.thinContentWords;

    if (latest) {
      var s = $("score");
      s.textContent = Math.round(latest.siteScore);
      s.className = "score " + scoreClass(latest.siteScore);
      $("count-critical").textContent = latest.critical;
      $("count-warning").textContent = latest.warning;
      $("count-info").textContent = latest.info;
      $("last-run").textContent = "Last audit " + latest.finishedAt + " UTC | " + latest.pagesScanned + " pages, " + latest.itemsScanned + " CMS items in last full run";
      if (data.previousScore != null) {
        var d = Math.round((latest.siteScore - data.previousScore) * 10) / 10;
        $("score-delta").textContent = (d > 0 ? "+" : "") + d + " vs previous run";
      } else {
        $("score-delta").textContent = "first run";
      }
    } else {
      $("score").textContent = "--";
      $("score").className = "score";
      $("last-run").textContent = "No audit yet. Run one to get started.";
      $("score-delta").textContent = "";
    }
    if (data.lastFailure) notify("Last audit failed: " + data.lastFailure, true);
  }

  function loadSummary() {
    return api("/summary").then(function (d) { renderSummary(d); return d; });
  }

  function loadRuns() {
    return api("/runs?limit=60").then(function (d) {
      state.runs = d.runs;
      state.sparkPoints = d.runs
        .filter(function (r) { return r.status === "complete" && r.siteScore != null; })
        .map(function (r) { return { score: r.siteScore, at: r.finishedAt || r.startedAt, kind: r.kind }; });
      drawSparkline();
    });
  }

  function drawSparkline() {
    var canvas = $("sparkline");
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 300;
    var h = 64;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var cs = getComputedStyle(document.documentElement);
    var accent = cs.getPropertyValue("--accent").trim() || "#4353ff";
    var border = cs.getPropertyValue("--border").trim() || "#ddd";
    var pts = state.sparkPoints;
    var padX = 6, padY = 8;

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    [0, 50, 100].forEach(function (v) {
      var y = padY + (1 - v / 100) * (h - 2 * padY);
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(w - padX, y); ctx.stroke();
    });

    if (!pts.length) return;
    var xs = pts.map(function (_, i) {
      return pts.length === 1 ? w / 2 : padX + (i / (pts.length - 1)) * (w - 2 * padX);
    });
    var ys = pts.map(function (p) { return padY + (1 - p.score / 100) * (h - 2 * padY); });
    state.sparkXs = xs;

    ctx.beginPath();
    ctx.moveTo(xs[0], h - padY);
    xs.forEach(function (x, i) { ctx.lineTo(x, ys[i]); });
    ctx.lineTo(xs[xs.length - 1], h - padY);
    ctx.closePath();
    ctx.fillStyle = accent + "22";
    ctx.fill();

    ctx.beginPath();
    xs.forEach(function (x, i) { if (i === 0) ctx.moveTo(x, ys[i]); else ctx.lineTo(x, ys[i]); });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    var focus = state.sparkHover >= 0 ? state.sparkHover : pts.length - 1;
    ctx.beginPath();
    ctx.arc(xs[focus], ys[focus], 3.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    $("spark-tip").textContent = Math.round(pts[focus].score) + " on " + pts[focus].at + " UTC (" + pts[focus].kind + ")  |  " + pts.length + " runs";
  }

  function onSparkMove(e) {
    var pts = state.sparkPoints;
    if (!pts.length || !state.sparkXs) return;
    var rect = $("sparkline").getBoundingClientRect();
    var x = e.clientX - rect.left;
    var best = 0, bestD = Infinity;
    state.sparkXs.forEach(function (px, i) { var d = Math.abs(px - x); if (d < bestD) { bestD = d; best = i; } });
    state.sparkHover = best;
    drawSparkline();
  }

  // ---------- findings ----------

  function loadIgnoreRules() {
    return api("/ignore-rules").then(function (d) {
      state.ignoreRules = {};
      d.rules.forEach(function (r) { state.ignoreRules[r.id] = r; });
    });
  }

  function loadFindings() {
    if (state.tab === "settings") return Promise.resolve();
    var pre = state.tab === "ignored" ? loadIgnoreRules() : Promise.resolve();
    return pre.then(function () { return api("/findings?tab=" + state.tab); }).then(function (d) {
      state.findings = d.findings;
      state.subjects = d.subjects;
      renderFindings();
    });
  }

  function refreshAll() {
    return Promise.all([loadSummary(), loadRuns(), loadFindings()]).catch(function (e) { notify(e.message, true); });
  }

  function typeLabel(t) { return t === "page" ? "Page" : t === "cms_item" ? "CMS item" : "Site"; }

  function renderFindings() {
    var root = $("findings");
    root.textContent = "";
    var list = state.findings.filter(function (f) { return !state.severity || f.severity === state.severity; });
    if (!list.length) {
      root.appendChild(el("p", { class: "muted empty", text: state.tab === "open" ? "No open findings. Nice work." : "Nothing here." }));
      return;
    }

    var groups = new Map();
    list.forEach(function (f) {
      var key = f.subjectType + ":" + f.subjectId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    });
    var ordered = Array.from(groups.values()).sort(function (a, b) {
      var ra = Math.min.apply(null, a.map(function (f) { return SEV_RANK[f.severity]; }));
      var rb = Math.min.apply(null, b.map(function (f) { return SEV_RANK[f.severity]; }));
      return ra - rb;
    });

    ordered.forEach(function (fs) {
      var first = fs[0];
      var score = state.subjects[first.subjectId] ? state.subjects[first.subjectId].score : null;
      var meta = el("div", { class: "group-meta" }, [
        el("span", { class: "muted", text: typeLabel(first.subjectType) }),
        score != null ? el("span", { class: "mini-score score " + scoreClass(score), text: String(score) }) : null,
      ]);
      if (first.subjectType === "page" && state.tab === "open") {
        meta.appendChild(el("button", { class: "btn small", text: "Go to page", onclick: function () { jumpTo(first); } }));
      }
      var group = el("div", { class: "group" }, [
        el("div", { class: "group-head" }, [el("span", { class: "group-title", text: first.subjectLabel }), meta]),
      ]);
      fs.forEach(function (f) { group.appendChild(renderFinding(f)); });
      root.appendChild(group);
    });
  }

  function renderFinding(f) {
    var card = el("div", { class: "finding " + f.severity + (f.status === "resolved" ? " done" : "") }, [
      el("div", { class: "finding-title", text: f.ruleTitle + " (" + f.severity + ")" }),
      el("p", { class: "finding-msg", text: f.message }),
    ]);
    if (f.currentValue) card.appendChild(el("div", { class: "kv" }, [el("b", { text: "Current: " }), document.createTextNode(f.currentValue)]));

    var valueInput = null;
    var publishBox = null;
    if (state.tab === "open") {
      if (f.fixKind === "api_patch" && f.suggestedValue) {
        var row = el("div", { class: "suggest" });
        if (f.canOverrideValue) {
          valueInput = el("input", { type: "text", value: f.suggestedValue });
          row.appendChild(valueInput);
        } else {
          row.appendChild(el("div", { class: "kv" }, [el("b", { text: "Suggested: " }), document.createTextNode(f.suggestedValue)]));
        }
        card.appendChild(row);
      } else if (f.suggestedValue) {
        card.appendChild(el("div", { class: "kv" }, [
          el("b", { text: "Suggested: " }), document.createTextNode(f.suggestedValue + " "),
          el("button", { class: "btn small", text: "Copy", onclick: function () { copy(f.suggestedValue); } }),
        ]));
      }
      if (f.fixKind === "manual" && f.manualSteps) {
        card.appendChild(el("div", { class: "steps" }, [el("b", { text: "Manual fix: " }), document.createTextNode(f.manualSteps)]));
      }
    }

    var actions = el("div", { class: "actions" });
    if (state.tab === "open") {
      if (f.fixKind === "api_patch" && f.suggestedValue) {
        publishBox = el("input", { type: "checkbox" });
        var applyBtn = el("button", { class: "btn small primary", text: "Apply suggested fix" });
        applyBtn.addEventListener("click", function () {
          applyBtn.disabled = true;
          api("/findings/" + f.id + "/apply-fix", {
            method: "POST",
            body: JSON.stringify({ value: valueInput ? valueInput.value : undefined, publish: publishBox.checked }),
          }).then(function () {
            notify("Fix applied to the CMS item" + (publishBox.checked ? " and published." : " (staged; publish the site to go live)."));
            return refreshAll();
          }).catch(function (e) { applyBtn.disabled = false; notify(e.message, true); });
        });
        actions.appendChild(applyBtn);
        actions.appendChild(el("label", { class: "muted" }, [publishBox, document.createTextNode(" publish item live")]));
      }
      if (f.subjectType === "page") {
        actions.appendChild(el("button", { class: "btn small", text: f.elementId ? "Select element" : "Go to page", onclick: function () { jumpTo(f); } }));
      }
      actions.appendChild(el("button", { class: "btn small", text: "Resolve", onclick: function () { post("/findings/" + f.id + "/resolve"); } }));
      actions.appendChild(ignoreMenu(f));
    } else if (state.tab === "ignored") {
      var rule = state.ignoreRules[f.ignoreRuleId];
      var why = rule
        ? (rule.scope === "rule" ? "Rule ignored everywhere: " + (rule.ruleTitle || rule.ruleId)
          : rule.scope === "item" ? "All rules ignored for: " + (rule.subjectLabel || rule.subjectId)
          : "This finding ignored")
        : "Ignored";
      actions.appendChild(el("span", { class: "muted", text: why }));
      actions.appendChild(el("button", {
        class: "btn small", text: "Restore",
        onclick: function () { del("/ignore-rules/" + f.ignoreRuleId); },
      }));
    } else if (state.tab === "resolved") {
      actions.appendChild(el("button", { class: "btn small", text: "Reopen", onclick: function () { post("/findings/" + f.id + "/reopen"); } }));
    }
    card.appendChild(actions);
    return card;
  }

  function ignoreMenu(f) {
    var sel = el("select", {}, [
      el("option", { value: "", text: "Ignore..." }),
      el("option", { value: "finding", text: "This finding only" }),
      el("option", { value: "item", text: "This " + (f.subjectType === "page" ? "page" : f.subjectType === "cms_item" ? "item" : "site") + " (all rules)" }),
      el("option", { value: "rule", text: "This rule everywhere" }),
    ]);
    sel.addEventListener("change", function () {
      if (!sel.value) return;
      var body = { scope: sel.value, ruleId: f.ruleId, subjectId: f.subjectId, subjectLabel: f.subjectLabel };
      api("/ignore-rules", { method: "POST", body: JSON.stringify(body) })
        .then(function () { notify("Ignored. Restore it any time from the Ignored tab."); return refreshAll(); })
        .catch(function (e) { notify(e.message, true); });
    });
    return sel;
  }

  function post(path) {
    return api(path, { method: "POST", body: "{}" }).then(refreshAll).catch(function (e) { notify(e.message, true); });
  }

  function del(path) {
    return api(path, { method: "DELETE" }).then(function () { notify("Restored."); return refreshAll(); }).catch(function (e) { notify(e.message, true); });
  }

  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { notify("Copied to clipboard."); });
  }

  // ---------- Designer jump ----------

  function jumpTo(f) {
    var w = window.webflow;
    if (!w || !w.getAllPagesAndFolders) {
      notify("The Designer API is not available in this context. " + (f.manualSteps || ""), true);
      return Promise.resolve();
    }
    return w.getAllPagesAndFolders().then(function (items) {
      var target = null;
      var lookups = items.map(function (p) {
        var namePromise = typeof p.getName === "function" ? p.getName() : Promise.resolve(p.name);
        return Promise.resolve(namePromise).then(function (name) {
          if (!target && (p.id === f.subjectId || (p.id && p.id.toString() === f.subjectId))) target = p;
          else if (!target && name && name === f.subjectLabel) target = p;
        });
      });
      return Promise.all(lookups).then(function () { return target; });
    }).then(function (target) {
      if (!target) { notify("Could not find that page in the Designer. " + (f.manualSteps || ""), true); return null; }
      return w.switchPage(target).then(function () { return true; });
    }).then(function (switched) {
      if (!switched) return;
      if (!f.elementId || !w.getAllElements || !w.setSelectedElement) {
        notify("Switched to the page. " + (f.manualSteps || ""));
        return;
      }
      return w.getAllElements().then(function (els) {
        var match = els.filter(function (e) {
          var id = e.id;
          return id && (id === f.elementId || id.element === f.elementId);
        })[0];
        if (!match) { notify("Switched to the page but the element was not found. " + (f.manualSteps || "")); return; }
        return w.setSelectedElement(match).then(function () { notify("Element selected. " + (f.manualSteps || "")); });
      });
    }).catch(function (e) { notify("Designer jump failed: " + e.message, true); });
  }

  // ---------- audit run ----------

  function runAudit() {
    notify("");
    $("run-audit").disabled = true;
    api("/runs", { method: "POST", body: "{}" }).then(function () {
      notify("Audit started. Large sites can take a few minutes (Data API rate limits).");
      pollUntilDone();
    }).catch(function (e) { $("run-audit").disabled = false; notify(e.message, true); });
  }

  function pollUntilDone() {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(function () {
      loadSummary().then(function (d) {
        if (d.running) pollUntilDone();
        else { if (!d.lastFailure) notify("Audit complete."); refreshAll(); }
      }).catch(function (e) { notify(e.message, true); });
    }, 3000);
  }

  // ---------- tabs / settings ----------

  function selectTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === tab);
    });
    $("settings").hidden = tab !== "settings";
    $("findings").hidden = tab === "settings";
    if (tab !== "settings") loadFindings().catch(function (e) { notify(e.message, true); });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () { selectTab(b.getAttribute("data-tab")); });
    });
    $("severity-filter").addEventListener("change", function (e) { state.severity = e.target.value; renderFindings(); });
    $("run-audit").addEventListener("click", runAudit);
    $("save-settings").addEventListener("click", function () {
      api("/settings", { method: "PUT", body: JSON.stringify({ thinContentWords: Number($("thin-words").value) }) })
        .then(function () { notify("Settings saved. Re-run the audit to apply."); })
        .catch(function (e) { notify(e.message, true); });
    });
    var canvas = $("sparkline");
    canvas.addEventListener("mousemove", onSparkMove);
    canvas.addEventListener("mouseleave", function () { state.sparkHover = -1; drawSparkline(); });
    window.addEventListener("resize", drawSparkline);

    resolveSiteId().then(function (id) {
      if (!id) { notify("Could not determine the site. Open this panel from the Designer or via the install redirect.", true); return; }
      state.siteId = id;
      return refreshAll().then(function () { if (state.running) pollUntilDone(); });
    });
  }

  init();
})();
