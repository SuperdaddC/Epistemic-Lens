/* EpistemicLens Popup Script */

(function () {
  const analyzeBtn = document.getElementById("analyze-btn");
  const errorBox = document.getElementById("error-box");
  let weakSentences = [];

  function showState(name) {
    document.getElementById("input-state").classList.toggle("hidden", name !== "input");
    document.getElementById("loading-state").classList.toggle("hidden", name !== "loading");
    document.getElementById("results-state").classList.toggle("hidden", name !== "results");
    document.getElementById("invalid-state").classList.toggle("hidden", name !== "invalid");
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }

  function clearError() {
    errorBox.classList.add("hidden");
  }

  function scoreColor(score) {
    if (score >= 80) return "score-green";
    if (score >= 50) return "score-amber";
    return "score-red";
  }

  function barColor(score) {
    if (score >= 7) return "var(--green)";
    if (score >= 5) return "var(--amber)";
    return "var(--red)";
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  function copyText(idx) {
    const text = weakSentences[idx]?.text || "";
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.querySelector(`[data-copy-idx="${idx}"]`);
      if (btn) {
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      }
    });
  }

  function renderResults(data) {
    const c = data.composite_score;
    const colorClass = scoreColor(c);
    const dims = data.dimensions;
    const dimOrder = [
      ["source_quality", "Source Quality"],
      ["claim_grounding", "Claim Grounding"],
      ["logical_integrity", "Logical Integrity"],
      ["completeness_balance", "Completeness & Balance"],
      ["language_precision", "Language Precision"],
      ["author_transparency", "Author Transparency"],
    ];

    let dimCards = dimOrder
      .map(([key, label]) => {
        const d = dims[key];
        const isLocked = d.score === null || d.score === undefined;
        const score = isLocked ? "\u2014" : d.score;
        const pct = isLocked ? 0 : (d.score / 10) * 100;
        const color = isLocked ? "var(--border)" : barColor(d.score);
        return `
        <div class="dim-card${isLocked ? " locked" : ""}">
          <div class="dim-name">${label}</div>
          <div class="dim-bar-track"><div class="dim-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <div class="dim-score-label">${score}${isLocked ? "" : " / 10"}</div>
          <div class="dim-notes">${escHtml(d.notes)}</div>
        </div>`;
      })
      .join("");

    weakSentences = data.weak_sentences || [];
    let weakItems = "";
    if (weakSentences.length > 0) {
      weakItems = weakSentences
        .map(
          (w, i) => `
        <div class="weak-item">
          <div class="weak-sentence">${escHtml(w.text)}</div>
          <div class="weak-reason">${escHtml(w.reason)}</div>
          <div class="weak-meta">
            <span class="weak-category">${escHtml(w.category)}</span>
            <button class="copy-btn" data-copy-idx="${i}">Copy</button>
          </div>
        </div>`
        )
        .join("");
    }

    document.getElementById("results-state").innerHTML = `
      <div class="score-header">
        <span class="composite-score ${colorClass}">${c}</span>
        <span class="grade ${colorClass}">${data.grade}</span>
      </div>
      <p class="summary">${escHtml(data.summary)}</p>
      <div class="section-title">Dimensions</div>
      ${dimCards}
      ${weakItems ? `<div class="section-title">Weak Sentences</div>${weakItems}` : ""}
      <div class="footer-links">
        <a id="open-web" href="#">Open in EpistemicLens</a>
        <button id="reanalyze-btn">Analyze again</button>
      </div>
    `;

    document.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => copyText(parseInt(btn.dataset.copyIdx)));
    });

    document.getElementById("open-web").addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: BACKEND_URL.replace("/api/score", "") });
    });

    document.getElementById("reanalyze-btn").addEventListener("click", () => {
      showState("input");
    });
  }

  // Check if current tab is a valid article page
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("about:")) {
      showState("invalid");
      return;
    }

    analyzeBtn.addEventListener("click", () => {
      clearError();
      analyzeBtn.disabled = true;
      showState("loading");

      chrome.tabs.sendMessage(tab.id, { action: "EXTRACT" }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.success) {
          showState("input");
          analyzeBtn.disabled = false;
          showError(resp?.error || "Could not extract article text.");
          return;
        }

        const articleText = resp.text;
        if (!articleText || articleText.trim().length < 50) {
          showState("input");
          analyzeBtn.disabled = false;
          showError("Article text too short to analyze.");
          return;
        }

        fetch(BACKEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: articleText, input_type: "text" }),
        })
          .then((r) => {
            if (!r.ok) return r.json().then((e) => Promise.reject(new Error(e.detail || `HTTP ${r.status}`)));
            return r.json();
          })
          .then((data) => {
            renderResults(data);
            showState("results");
            analyzeBtn.disabled = false;

            // Highlight weak sentences in the article
            chrome.tabs.sendMessage(tab.id, {
              action: "HIGHLIGHT",
              weak_sentences: data.weak_sentences || [],
            });
          })
          .catch((e) => {
            showState("input");
            analyzeBtn.disabled = false;
            showError(e.message);
          });
      });
    });
  });
})();
