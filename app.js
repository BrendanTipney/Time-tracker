// Time Tracker — client-side app using Supabase for storage + auth.
(() => {
  const cfg = window.APP_CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    document.body.innerHTML = `<div style="padding:40px;max-width:520px;margin:40px auto;font-family:system-ui;color:#e5efef;background:#121a1a;border:1px solid #1f2c2c;border-radius:12px;">
      <h2 style="color:#2dd4bf;margin-top:0;">Setup needed</h2>
      <p>Copy <code>config.example.js</code> to <code>config.js</code> and fill in your Supabase <code>URL</code> and <code>anon key</code> (found in your Supabase dashboard under Settings → API).</p>
    </div>`;
    return;
  }

  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // ---------- State ----------
  const state = {
    user: null,
    profiles: {},        // id -> { display_name, color }
    entries: [],         // all entries (sorted desc)
    runningEntry: null,  // { id, started_at, task }
    tickInterval: null,
    editingId: null,
    calDate: startOfMonth(new Date()),
    calSelected: null,
    chart: null,
    authMode: "signin",  // or "signup"
  };

  // Teal palette for per-user coloring.
  const PALETTE = ["#2dd4bf", "#f472b6", "#a78bfa", "#facc15", "#60a5fa", "#fb923c"];

  // ---------- Element shortcuts ----------
  const $ = (id) => document.getElementById(id);

  // ---------- Init ----------
  init();

  async function init() {
    bindAuthUI();
    bindAppUI();
    const { data } = await sb.auth.getSession();
    if (data.session) onSignedIn(data.session.user);
    else showAuth();

    sb.auth.onAuthStateChange((_event, session) => {
      if (session) onSignedIn(session.user);
      else showAuth();
    });
  }

  // ---------- Auth ----------
  function bindAuthUI() {
    $("auth-form").addEventListener("submit", handleAuthSubmit);
    $("auth-toggle-link").addEventListener("click", (e) => {
      e.preventDefault();
      toggleAuthMode();
    });
  }

  function toggleAuthMode() {
    state.authMode = state.authMode === "signin" ? "signup" : "signin";
    const signup = state.authMode === "signup";
    $("auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("auth-subtitle").textContent = signup ? "Create an account to start tracking." : "Sign in to continue.";
    $("auth-toggle-text").textContent = signup ? "Already have an account?" : "Don't have an account?";
    $("auth-toggle-link").textContent = signup ? "Sign in" : "Sign up";
    $("auth-name-field").classList.toggle("hidden", !signup);
    $("auth-error").classList.add("hidden");
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const name = $("auth-name").value.trim();
    const errEl = $("auth-error");
    errEl.classList.add("hidden");
    $("auth-submit").disabled = true;

    try {
      if (state.authMode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { data: { display_name: name || email.split("@")[0] } }
        });
        if (error) throw error;
        if (!data.session) {
          errEl.textContent = "Check your email to confirm, then sign in.";
          errEl.classList.remove("hidden");
          toggleAuthMode();
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      errEl.textContent = err.message || "Something went wrong.";
      errEl.classList.remove("hidden");
    } finally {
      $("auth-submit").disabled = false;
    }
  }

  function showAuth() {
    $("auth-screen").classList.remove("hidden");
    $("app").classList.add("hidden");
    state.user = null;
    if (state.tickInterval) { clearInterval(state.tickInterval); state.tickInterval = null; }
  }

  async function onSignedIn(user) {
    state.user = user;
    $("auth-screen").classList.add("hidden");
    $("app").classList.remove("hidden");
    await ensureProfile();
    await loadProfiles();
    await loadEntries();
    subscribeRealtime();
    renderAll();
  }

  async function ensureProfile() {
    const { data } = await sb.from("profiles").select("*").eq("id", state.user.id).maybeSingle();
    if (!data) {
      const name = state.user.user_metadata?.display_name || state.user.email.split("@")[0];
      await sb.from("profiles").insert({ id: state.user.id, display_name: name });
    }
  }

  async function loadProfiles() {
    const { data } = await sb.from("profiles").select("*");
    state.profiles = {};
    (data || []).forEach((p, i) => {
      state.profiles[p.id] = { ...p, color: p.color || PALETTE[i % PALETTE.length] };
    });
  }

  function profileOf(userId) {
    return state.profiles[userId] || { display_name: "Unknown", color: "#888" };
  }

  // ---------- App UI bindings ----------
  function bindAppUI() {
    $("sign-out").addEventListener("click", () => sb.auth.signOut());
    $("timer-button").addEventListener("click", toggleTimer);
    $("task-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); toggleTimer(); }
    });

    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("filter-user").addEventListener("change", renderEntries);
    $("cal-prev").addEventListener("click", () => { state.calDate = addMonths(state.calDate, -1); renderCalendar(); });
    $("cal-next").addEventListener("click", () => { state.calDate = addMonths(state.calDate, 1); renderCalendar(); });
    $("chart-range").addEventListener("change", renderChart);

    $("edit-form").addEventListener("submit", saveEdit);
    $("edit-cancel").addEventListener("click", closeEditModal);
    $("edit-delete").addEventListener("click", deleteEdit);

    $("export-btn").addEventListener("click", downloadCsv);

    // Default export range = current month.
    const now = new Date();
    $("export-from").value = isoDate(startOfMonth(now));
    $("export-to").value = isoDate(now);
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    if (name === "calendar") renderCalendar();
    if (name === "chart") renderChart();
  }

  // ---------- Entries ----------
  async function loadEntries() {
    const { data, error } = await sb.from("time_entries").select("*").order("started_at", { ascending: false });
    if (error) { toast(error.message, true); return; }
    state.entries = data || [];
    state.runningEntry = state.entries.find((e) => e.user_id === state.user.id && !e.ended_at) || null;
    updateTimerUI();
  }

  function subscribeRealtime() {
    sb.channel("time_entries_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "time_entries" }, async () => {
        await loadEntries();
        renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, async () => {
        await loadProfiles();
        renderAll();
      })
      .subscribe();
  }

  // ---------- Timer ----------
  async function toggleTimer() {
    if (state.runningEntry) {
      const { error } = await sb.from("time_entries").update({ ended_at: new Date().toISOString() }).eq("id", state.runningEntry.id);
      if (error) return toast(error.message, true);
      state.runningEntry = null;
      $("task-input").value = "";
      await loadEntries(); renderAll();
    } else {
      const task = $("task-input").value.trim();
      const payload = {
        user_id: state.user.id,
        started_at: new Date().toISOString(),
        task,
      };
      const { data, error } = await sb.from("time_entries").insert(payload).select().single();
      if (error) return toast(error.message, true);
      state.runningEntry = data;
      await loadEntries(); renderAll();
    }
    updateTimerUI();
  }

  function updateTimerUI() {
    const panel = document.querySelector(".timer-panel");
    const btn = $("timer-button");
    const status = $("timer-status");
    if (state.runningEntry) {
      panel.classList.add("running");
      btn.textContent = "Stop";
      status.textContent = "Running since " + formatTime(new Date(state.runningEntry.started_at));
      $("task-input").value = state.runningEntry.task || "";
      if (!state.tickInterval) state.tickInterval = setInterval(tickTimer, 1000);
      tickTimer();
    } else {
      panel.classList.remove("running");
      btn.textContent = "Start";
      status.textContent = "";
      $("timer-display").textContent = "00:00:00";
      if (state.tickInterval) { clearInterval(state.tickInterval); state.tickInterval = null; }
    }
  }

  function tickTimer() {
    if (!state.runningEntry) return;
    const elapsed = Date.now() - new Date(state.runningEntry.started_at).getTime();
    $("timer-display").textContent = formatDuration(elapsed, true);
  }

  // ---------- Render ----------
  function renderAll() {
    populateUserChip();
    populateUserFilter();
    renderEntries();
    if (document.querySelector(".tab.active")?.dataset.tab === "calendar") renderCalendar();
    if (document.querySelector(".tab.active")?.dataset.tab === "chart") renderChart();
  }

  function populateUserChip() {
    const p = profileOf(state.user.id);
    $("user-name").textContent = p.display_name;
    $("user-dot").style.background = p.color;
  }

  function populateUserFilter() {
    const sel = $("filter-user");
    const current = sel.value || "all";
    sel.innerHTML = `<option value="all">Everyone</option>`;
    Object.values(state.profiles).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.display_name + (p.id === state.user.id ? " (you)" : "");
      sel.appendChild(opt);
    });
    sel.value = [...sel.options].some((o) => o.value === current) ? current : "all";
  }

  function renderEntries() {
    const filter = $("filter-user").value;
    const list = state.entries.filter((e) => filter === "all" || e.user_id === filter);
    const container = $("entries-list");
    if (!list.length) {
      container.innerHTML = `<p class="empty">No entries yet. Press Start to track your first session.</p>`;
      return;
    }
    const groups = groupByDay(list);
    container.innerHTML = "";
    for (const [label, items] of groups) {
      const g = document.createElement("div");
      g.className = "day-group";
      g.innerHTML = `<div class="day-label">${label}</div>`;
      items.forEach((e) => g.appendChild(renderEntry(e)));
      container.appendChild(g);
    }
  }

  function renderEntry(e) {
    const p = profileOf(e.user_id);
    const running = !e.ended_at;
    const start = new Date(e.started_at);
    const end = e.ended_at ? new Date(e.ended_at) : new Date();
    const dur = end - start;
    const row = document.createElement("div");
    row.className = "entry" + (running ? " running" : "");
    row.innerHTML = `
      <div class="stripe" style="background:${p.color}"></div>
      <div class="main">
        <div class="task">${escapeHtml(e.task || "(no label)")}</div>
        <div class="meta">${escapeHtml(p.display_name)} · ${formatTime(start)} – ${running ? "running" : formatTime(end)}</div>
      </div>
      <div class="duration">${formatDuration(dur, false)}</div>
      <button class="edit-btn" title="Edit">✎</button>
    `;
    const editBtn = row.querySelector(".edit-btn");
    if (e.user_id === state.user.id) {
      editBtn.addEventListener("click", () => openEditModal(e));
    } else {
      editBtn.style.visibility = "hidden";
    }
    return row;
  }

  // ---------- Edit modal ----------
  function openEditModal(entry) {
    state.editingId = entry.id;
    $("edit-task").value = entry.task || "";
    $("edit-started").value = toLocalInput(new Date(entry.started_at));
    $("edit-ended").value = entry.ended_at ? toLocalInput(new Date(entry.ended_at)) : "";
    $("edit-modal").classList.remove("hidden");
  }

  function closeEditModal() {
    $("edit-modal").classList.add("hidden");
    state.editingId = null;
  }

  async function saveEdit(e) {
    e.preventDefault();
    const started = $("edit-started").value;
    const ended = $("edit-ended").value;
    const payload = {
      task: $("edit-task").value.trim(),
      started_at: new Date(started).toISOString(),
      ended_at: ended ? new Date(ended).toISOString() : null,
    };
    const { error } = await sb.from("time_entries").update(payload).eq("id", state.editingId);
    if (error) return toast(error.message, true);
    closeEditModal();
    await loadEntries(); renderAll();
  }

  async function deleteEdit() {
    if (!confirm("Delete this entry?")) return;
    const { error } = await sb.from("time_entries").delete().eq("id", state.editingId);
    if (error) return toast(error.message, true);
    closeEditModal();
    await loadEntries(); renderAll();
  }

  // ---------- Calendar ----------
  function renderCalendar() {
    const date = state.calDate;
    $("cal-title").textContent = date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const grid = $("cal-grid");
    grid.innerHTML = "";

    const first = startOfMonth(date);
    const startDay = first.getDay();
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const prevDays = new Date(date.getFullYear(), date.getMonth(), 0).getDate();

    const dayTotals = computeDayTotals(state.entries);

    const cells = [];
    for (let i = 0; i < startDay; i++) {
      const day = prevDays - startDay + 1 + i;
      const d = new Date(date.getFullYear(), date.getMonth() - 1, day);
      cells.push({ date: d, otherMonth: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(date.getFullYear(), date.getMonth(), d), otherMonth: false });
    }
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const last = cells[cells.length - 1].date;
      cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), otherMonth: true });
      if (cells.length >= 42) break;
    }

    const today = isoDate(new Date());
    cells.forEach(({ date: d, otherMonth }) => {
      const key = isoDate(d);
      const total = dayTotals[key];
      const cell = document.createElement("div");
      cell.className = "cal-cell" + (otherMonth ? " other-month" : "") + (key === today ? " today" : "") + (state.calSelected === key ? " selected" : "");
      const userColors = total ? Object.keys(total.byUser).map((uid) => profileOf(uid).color) : [];
      cell.innerHTML = `
        <div class="day-num">${d.getDate()}</div>
        <div class="dots">${userColors.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="day-hours">${total ? formatHours(total.total) : ""}</div>
      `;
      cell.addEventListener("click", () => {
        state.calSelected = key;
        renderCalendar();
        renderDayDetail(key);
      });
      grid.appendChild(cell);
    });

    if (state.calSelected) renderDayDetail(state.calSelected);
  }

  function renderDayDetail(key) {
    const box = $("cal-day-detail");
    const entries = state.entries.filter((e) => isoDate(new Date(e.started_at)) === key);
    box.classList.remove("hidden");
    if (!entries.length) {
      box.innerHTML = `<h3>${key}</h3><p class="muted">No entries.</p>`;
      return;
    }
    box.innerHTML = `<h3>${key}</h3>`;
    entries.forEach((e) => box.appendChild(renderEntry(e)));
  }

  // ---------- Chart ----------
  function renderChart() {
    const range = $("chart-range").value;
    const { labels, datasets, totals } = buildChartData(range);

    const ctx = $("chart-canvas").getContext("2d");
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, ticks: { color: "#7b8d8d" }, grid: { color: "#1f2c2c" } },
          y: { stacked: true, ticks: { color: "#7b8d8d", callback: (v) => v + "h" }, grid: { color: "#1f2c2c" } },
        },
        plugins: {
          legend: { labels: { color: "#e5efef" } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}h` } },
        },
      },
    });

    const summary = $("chart-summary");
    summary.innerHTML = "";
    Object.entries(totals).forEach(([uid, hours]) => {
      const p = profileOf(uid);
      const card = document.createElement("div");
      card.className = "summary-card";
      card.innerHTML = `<div class="label">${escapeHtml(p.display_name)}</div><div class="value" style="color:${p.color}">${hours.toFixed(1)}h</div>`;
      summary.appendChild(card);
    });
    if (!Object.keys(totals).length) {
      summary.innerHTML = `<p class="empty" style="flex:1">No data in range.</p>`;
    }
  }

  function buildChartData(range) {
    const now = new Date();
    let buckets = [];
    let bucketKey;
    let labelFmt;

    if (range === "week") {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        buckets.push(d);
      }
      bucketKey = (d) => isoDate(d);
      labelFmt = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
    } else if (range === "month") {
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        buckets.push(d);
      }
      bucketKey = (d) => isoDate(d);
      labelFmt = (d) => `${d.getMonth()+1}/${d.getDate()}`;
    } else {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        buckets.push(d);
      }
      bucketKey = (d) => d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
      labelFmt = (d) => d.toLocaleDateString(undefined, { month: "short" });
    }

    const keys = buckets.map(bucketKey);
    const labels = buckets.map(labelFmt);
    const earliest = buckets[0];

    const byUser = {};   // uid -> { key -> hours }
    const totals = {};   // uid -> hours
    state.entries.forEach((e) => {
      if (!e.ended_at) return;
      const start = new Date(e.started_at);
      if (start < earliest) return;
      const hours = (new Date(e.ended_at) - start) / 3600000;
      const k = bucketKey(start);
      byUser[e.user_id] = byUser[e.user_id] || {};
      byUser[e.user_id][k] = (byUser[e.user_id][k] || 0) + hours;
      totals[e.user_id] = (totals[e.user_id] || 0) + hours;
    });

    const datasets = Object.entries(byUser).map(([uid, byKey]) => {
      const p = profileOf(uid);
      return {
        label: p.display_name,
        data: keys.map((k) => +(byKey[k] || 0).toFixed(3)),
        backgroundColor: p.color,
        borderColor: p.color,
        borderWidth: 0,
        borderRadius: 4,
      };
    });

    return { labels, datasets, totals };
  }

  // ---------- Export ----------
  function downloadCsv() {
    const from = $("export-from").value;
    const to = $("export-to").value;
    const who = $("export-who").value;
    if (!from || !to) return toast("Pick a date range.", true);
    const fromDt = new Date(from + "T00:00:00");
    const toDt = new Date(to + "T23:59:59");

    const rows = state.entries.filter((e) => {
      if (!e.ended_at) return false;
      if (who === "me" && e.user_id !== state.user.id) return false;
      const s = new Date(e.started_at);
      return s >= fromDt && s <= toDt;
    });

    if (!rows.length) return toast("No entries in that range.", true);

    const header = ["Date", "User", "Task", "Started", "Ended", "Duration (hours)"];
    const lines = [header.join(",")];
    rows.forEach((e) => {
      const s = new Date(e.started_at);
      const end = new Date(e.ended_at);
      const hours = ((end - s) / 3600000).toFixed(3);
      lines.push([
        csv(isoDate(s)),
        csv(profileOf(e.user_id).display_name),
        csv(e.task || ""),
        csv(s.toISOString()),
        csv(end.toISOString()),
        hours,
      ].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `time-tracker-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("CSV downloaded.");
  }

  // ---------- Utils ----------
  function csv(s) {
    if (s == null) return "";
    s = String(s);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function isoDate(d) {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }

  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

  function formatTime(d) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function formatDuration(ms, withSeconds) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return withSeconds ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}`;
  }

  function formatHours(ms) {
    const h = ms / 3600000;
    return h >= 10 ? h.toFixed(0) + "h" : h.toFixed(1) + "h";
  }

  function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function groupByDay(entries) {
    const map = new Map();
    const today = isoDate(new Date());
    const yest = isoDate(new Date(Date.now() - 86400000));
    entries.forEach((e) => {
      const key = isoDate(new Date(e.started_at));
      let label;
      if (key === today) label = "Today";
      else if (key === yest) label = "Yesterday";
      else label = new Date(e.started_at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      if (!map.has(label)) map.set(label, []);
      map.get(label).push(e);
    });
    return [...map.entries()];
  }

  function computeDayTotals(entries) {
    const totals = {};
    entries.forEach((e) => {
      if (!e.ended_at) return;
      const key = isoDate(new Date(e.started_at));
      const ms = new Date(e.ended_at) - new Date(e.started_at);
      totals[key] = totals[key] || { total: 0, byUser: {} };
      totals[key].total += ms;
      totals[key].byUser[e.user_id] = (totals[key].byUser[e.user_id] || 0) + ms;
    });
    return totals;
  }

  let toastTimer;
  function toast(msg, isError) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
  }
})();
