/* Receipt Expense Tracker — frontend.
 * Receipt photos are parsed by an open vision model via our own Node backend
 * (POST /api/parse). No OCR libraries, no fallback parsers: without the
 * backend running, uploads are refused with a clear message.
 */
(function () {
  "use strict";

  var state = { items: [], seq: 0 };
  try {
    var saved = JSON.parse(localStorage.getItem("receipts-v1") || "[]");
    if (Array.isArray(saved)) state.items = saved;
  } catch (e) { /* fresh start */ }

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $("dropzone"), fileInput = $("file-input"), statusEl = $("ocr-status");
  var expBody = $("exp-body"), grandTotal = $("grand-total"), validCount = $("valid-count");

  function setStatus(msg, isErr) {
    statusEl.innerHTML = msg;
    statusEl.className = "status" + (isErr ? " err" : "");
  }

  /* ---------- vision-model backend ---------- */
  var backend = { checked: false, ok: false };

  function checkBackend() {
    if (typeof fetch === "undefined") return;
    fetch("api/health").then(function (r) { return r.json(); }).then(function (j) {
      backend.checked = true;
      backend.ok = !!(j && j.ok && j.configured);
      if (backend.ok) {
        setStatus("AI parsing enabled (Meta Llama vision model).");
      } else {
        setStatus("Backend unavailable or token missing — start it with npm start (see README).", true);
      }
    }).catch(function () {
      backend.checked = true;
      backend.ok = false;
      setStatus("Backend unavailable — start it with npm start (see README).", true);
    });
  }

  function parseWithBackend(file) {
    var fd = new FormData();
    fd.append("image", file, file.name);
    return fetch("api/parse", { method: "POST", body: fd }).then(function (r) {
      if (!r.ok) throw new Error("server responded " + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.result) throw new Error("bad server response");
      return j.result;
    });
  }

  function addAIItem(name, r) {
    state.items.push({
      id: "r" + (++state.seq) + "-" + Date.now(),
      name: name,
      merchant: r.merchant || "Unknown",
      date: r.date || "—",
      total: (typeof r.total === "number") ? r.total : null,
      items: Array.isArray(r.items) ? r.items.filter(function (it) {
        return it && typeof it.price === "number";
      }) : [],
      status: r.is_receipt ? "valid" : "invalid",
      reason: r.reason || ""
    });
    persist(); render();
  }

  function processFile(f) {
    if (!backend.ok) {
      setStatus("Backend unavailable — start it with npm start, then retry.", true);
      return Promise.resolve();
    }
    setStatus("Parsing " + f.name + " with vision model…");
    return parseWithBackend(f).then(function (r) {
      addAIItem(f.name, r);
      setStatus(r.is_receipt ? "" : f.name + " is not a receipt.");
    }).catch(function (err) {
      setStatus("AI parsing failed (" + (err && err.message ? err.message : "unknown error") + ").", true);
    });
  }

  function handleFiles(files) {
    files = Array.prototype.slice.call(files || []);
    var images = files.filter(function (f) { return /^image\//.test(f.type); });
    if (images.length < files.length) {
      setStatus("Skipped " + (files.length - images.length) + " non-image file(s).", true);
    }
    if (images.length === 0) return;
    var chain = Promise.resolve();
    images.forEach(function (f) {
      chain = chain.then(function () { return processFile(f); });
    });
  }

  /* ---------- rendering ---------- */
  function money(v) { return v == null || isNaN(v) ? "—" : "$" + v.toFixed(2); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function rowCells(file, merchant, date, amount, status, id) {
    var del = id
      ? '<button class="del" data-id="' + id + '" aria-label="Remove">×</button>'
      : "";
    return "<tr><td>" + esc(file) + "</td><td>" + esc(merchant) + "</td><td>" +
      esc(date) + '</td><td class="num">' + amount + "</td><td>" + status + "</td><td>" + del + "</td></tr>";
  }

  function render() {
    if (state.items.length === 0) {
      expBody.innerHTML = '<tr class="empty"><td colspan="6">No receipts yet. Upload one above.</td></tr>';
    } else {
      var html = "";
      state.items.forEach(function (it) {
        if (it.status === "valid" && it.items && it.items.length > 0) {
          // One row per expense line, last row carries only the total.
          it.items.forEach(function (line) {
            html += rowCells(it.name, line.label || it.merchant, it.date, money(line.price), "", null);
          });
          html += '<tr class="total-row"><td>—</td><td>' + esc(it.merchant) + " total</td><td>—</td>" +
            '<td class="num">' + money(it.total) + '</td><td><span class="badge valid">valid</span></td>' +
            '<td><button class="del" data-id="' + it.id + '" aria-label="Remove">×</button></td></tr>';
        } else {
          var badge = it.status === "valid"
            ? '<span class="badge valid">valid</span>'
            : '<span class="badge invalid">invalid</span><span class="reason">' + esc(it.reason || "") + "</span>";
          html += rowCells(it.name, it.merchant, it.date, money(it.total), badge, it.id);
        }
      });
      expBody.innerHTML = html;
    }
    var valid = state.items.filter(function (it) { return it.status === "valid" && it.total != null; });
    var sum = valid.reduce(function (a, it) { return a + it.total; }, 0);
    grandTotal.textContent = "$" + sum.toFixed(2);
    validCount.textContent = valid.length + " valid";
  }

  function persist() {
    try { localStorage.setItem("receipts-v1", JSON.stringify(state.items)); } catch (e) { /* ignore */ }
  }

  /* ---------- events ---------- */
  dropzone.addEventListener("click", function (e) {
    if (e.target !== fileInput) fileInput.click();
  });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  ["dragover", "dragenter"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("over"); });
  });
  dropzone.addEventListener("drop", function (e) {
    handleFiles(e.dataTransfer && e.dataTransfer.files);
  });
  fileInput.addEventListener("change", function () { handleFiles(fileInput.files); fileInput.value = ""; });

  expBody.addEventListener("click", function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute("data-id");
    if (!id) return;
    if (typeof fetch !== "undefined") {
      fetch("api/receipts/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {});
    }
    state.items = state.items.filter(function (it) { return it.id !== id; });
    persist(); render();
  });

  $("clear-all").addEventListener("click", function () {
    state.items = []; persist(); render(); setStatus("");
  });

  $("export-csv").addEventListener("click", function () {
    var rows = [["file", "merchant", "date", "total", "status"]];
    state.items.forEach(function (it) {
      if (it.status === "valid" && it.items && it.items.length > 0) {
        it.items.forEach(function (line) {
          rows.push([it.name, line.label || it.merchant, it.date, line.price.toFixed(2), "valid"]);
        });
        rows.push([it.name, it.merchant + " TOTAL", it.date, it.total.toFixed(2), "valid"]);
      } else {
        rows.push([it.name, it.merchant, it.date, it.total == null ? "" : it.total.toFixed(2), it.status]);
      }
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\n");
    var blob = new Blob([csv], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "expenses.csv";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  /* ---------- history + tabs + ask ---------- */
  function loadHistory() {
    if (typeof fetch === "undefined") return;
    fetch("api/receipts").then(function (r) {
      if (!r.ok) throw new Error("no history");
      return r.json();
    }).then(function (j) {
      // DB is source of truth when it has rows; otherwise keep the local cache.
      if (j && Array.isArray(j.receipts) && j.receipts.length > 0) {
        state.items = j.receipts.map(function (it, i) {
          return {
            id: it.id || ("db-" + i),
            name: it.name || "upload",
            merchant: it.merchant || "Unknown",
            date: it.date || "—",
            total: (typeof it.total === "number") ? it.total : null,
            items: Array.isArray(it.items) ? it.items : [],
            status: "valid",
            reason: ""
          };
        });
        persist(); render();
      }
    }).catch(function () { /* keep local cache */ });
  }

  function showTab(which) {
    $("view-expenses").hidden = which !== "expenses";
    $("view-ask").hidden = which !== "ask";
    $("tab-expenses").classList.toggle("active", which === "expenses");
    $("tab-ask").classList.toggle("active", which === "ask");
  }

  $("tab-expenses").addEventListener("click", function () { showTab("expenses"); });
  $("tab-ask").addEventListener("click", function () { showTab("ask"); });

  $("ask-btn").addEventListener("click", function () {
    var q = $("ask-input").value.trim();
    var box = $("ask-answer");
    if (!q) return;
    box.textContent = "Thinking…";
    fetch("api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }).then(function (x) {
      box.textContent = x.ok ? (x.body.answer || "No answer.") : ("Error: " + (x.body.error || ("status " + x.status)));
    }).catch(function (err) {
      box.textContent = "Error: " + (err && err.message ? err.message : "request failed");
    });
  });

  checkBackend();
  render();
  loadHistory();
})();
