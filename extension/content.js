/* EpistemicLens Content Script */

(function () {
  let tooltipEl = null;

  function injectStyles() {
    if (document.getElementById("el-styles")) return;
    const style = document.createElement("style");
    style.id = "el-styles";
    style.textContent = `
      .el-highlight {
        text-decoration: underline wavy #f59e0b;
        text-underline-offset: 3px;
        cursor: help;
      }
      #el-tooltip {
        position: absolute;
        z-index: 2147483647;
        background: #1a1a1a;
        color: #e8e6e3;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px;
        line-height: 1.5;
        max-width: 320px;
        padding: 10px 12px;
        border: 1px solid #2a2a2a;
        pointer-events: none;
        display: none;
      }
      #el-tooltip .el-tip-reason { margin-bottom: 4px; }
      #el-tooltip .el-tip-cat {
        color: #f59e0b;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    `;
    document.head.appendChild(style);
  }

  function createTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement("div");
    tooltipEl.id = "el-tooltip";
    document.body.appendChild(tooltipEl);
  }

  function extractArticle() {
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();
    return article ? article.textContent : document.body.innerText;
  }

  function findAndWrapText(sentence, reason, category) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    const normalized = sentence.replace(/\s+/g, " ").trim();
    let node;

    while ((node = walker.nextNode())) {
      const nodeText = node.textContent.replace(/\s+/g, " ");
      const idx = nodeText.indexOf(normalized);
      if (idx === -1) continue;

      // Skip if already highlighted
      if (node.parentElement && node.parentElement.classList.contains("el-highlight")) continue;

      const range = document.createRange();
      // Find actual character positions in original text
      let charCount = 0;
      let startOffset = -1;
      let endOffset = -1;
      const raw = node.textContent;
      let ni = 0;
      let si = 0;

      // Map normalized positions back to raw positions
      // Simple approach: find the substring allowing whitespace variation
      const words = normalized.split(" ");
      const regex = new RegExp(
        words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
      );
      const match = raw.match(regex);
      if (!match) continue;

      startOffset = raw.indexOf(match[0]);
      endOffset = startOffset + match[0].length;

      range.setStart(node, startOffset);
      range.setEnd(node, endOffset);

      const mark = document.createElement("mark");
      mark.className = "el-highlight";
      mark.dataset.reason = reason;
      mark.dataset.category = category;
      range.surroundContents(mark);

      mark.addEventListener("mouseenter", showTooltip);
      mark.addEventListener("mouseleave", hideTooltip);
      break;
    }
  }

  function showTooltip(e) {
    if (!tooltipEl) return;
    const mark = e.currentTarget;
    const reason = mark.dataset.reason;
    const category = mark.dataset.category;

    tooltipEl.innerHTML = `
      <div class="el-tip-reason">${escHtml(reason)}</div>
      <div class="el-tip-cat">${escHtml(category)}</div>
    `;

    const rect = mark.getBoundingClientRect();
    tooltipEl.style.display = "block";
    const tipRect = tooltipEl.getBoundingClientRect();
    let left = rect.left + window.scrollX;
    let top = rect.top + window.scrollY - tipRect.height - 8;
    if (top < window.scrollY) top = rect.bottom + window.scrollY + 8;
    if (left + tipRect.width > window.innerWidth) left = window.innerWidth - tipRect.width - 8;

    tooltipEl.style.left = left + "px";
    tooltipEl.style.top = top + "px";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "EXTRACT") {
      try {
        const text = extractArticle();
        sendResponse({ success: true, text: text });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }

    if (msg.action === "HIGHLIGHT") {
      injectStyles();
      createTooltip();
      const sentences = msg.weak_sentences || [];
      sentences.forEach((ws) => {
        findAndWrapText(ws.text, ws.reason, ws.category);
      });
      sendResponse({ success: true });
      return true;
    }
  });
})();
