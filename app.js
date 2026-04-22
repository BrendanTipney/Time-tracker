// Time Tracker — client-side app using Supabase for storage + auth.
(() => {
  const cfg = window.APP_CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    document.body.innerHTML = `<div style="padding:40px;max-width:520px;margin:40px auto;font-family:system-ui;color:#e5efef;background:#121a1a;border:1px solid #1f2c2c;border-radius:12px;">
      <h2 style="color:#2dd4bf;margin-top:0;">Setup needed</h2>
      <p>Copy <code>config.example.js</code> to <code>config.js</code> and fill in your Supabase <code>URL</code> and <code>anon key</code>.</p>
    </div>`;
    return;
  }

  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const state = {
    user: null,
    profiles: {},
    projects: [],
    projectsById: {},
    entries: [],
    runningEntry: null,
    tickInterval: null,
    editingId: null,
    editingProject: null,  // project id during project modal
    calDate: startOfMonth(new Date()),
    calSelected: null,
    chart: null,
    authMode: "signin",
  };

  const WORK_DAY_HOURS = 7;
  const WORK_WEEK_HOURS = WORK_DAY_HOURS * 5;
  const USER_PALETTE = ["#2dd4bf", "#fb7185", "#a78bfa", "#facc15", "#60a5fa", "#fb923c", "#4ade80", "#38bdf8"];
  const PROJECT_PALETTE = [
    "#2dd4bf", "#5eead4", "#38bdf8", "#60a5fa", "#a78bfa", "#f472b6",
    "#fb7185", "#fb923c", "#facc15", "#a3e635", "#4ade80", "#94a3b8",
  ];

  const $ = (id) => document.getElementById(id);
  const lastProjectKey = () => `lastProject:${state.user?.id || "anon"}`;

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
    await loadProjects();
    await loadEntries();
    subscribeRealtime();
    renderAll();
    restoreLastProject();
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
      state.profiles[p.id] = { ...p, color: p.color || USER_PALETTE[i % USER_PALETTE.length] };
    });
  }

  async function loadProjects() {
    const { data, error } = await sb.from("projects").select("*").eq("archived", false).order("name");
    if (error) { toast(error.message, true); return; }
    state.projects = data || [];
    state.projectsById = {};
    state.projects.forEach((p) => { state.projectsById[p.id] = p; });
  }

  function profileOf(userId) {
    return state.profiles[userId] || { display_name: "Unknown", color: "#888" };
  }

  function projectOf(projectId) {
    return state.projectsById[projectId] || null;
  }

  // ---------- App UI bindings ----------
  function bindAppUI() {
    $("sign-out").addEventListener("click", () => sb.auth.signOut());
    $("timer-button").addEventListener("click", toggleTimer);
    $("project-select").addEventListener("change", (e) => {
      if (state.user) localStorage.setItem(lastProjectKey(), e.target.value);
    });
    $("project-add").addEventListener("click", () => openProjectModal());

    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("cal-prev").addEventListener("click", () => { state.calDate = addMonths(state.calDate, -1); renderCalendar(); });
    $("cal-next").addEventListener("click", () => { state.calDate = addMonths(state.calDate, 1); renderCalendar(); });
    $("chart-range").addEventListener("change", renderChart);

    $("edit-form").addEventListener("submit", saveEdit);
    $("edit-cancel").addEventListener("click", closeEditModal);
    $("edit-delete").addEventListener("click", deleteEdit);

    $("project-form").addEventListener("submit", saveProject);
    $("project-cancel").addEventListener("click", closeProjectModal);
    $("project-delete").addEventListener("click", deleteProject);

    $("export-btn").addEventListener("click", downloadCsv);

    $("user-dot").addEventListener("click", openUserColorModal);
    $("user-color-cancel").addEventListener("click", () => $("user-color-modal").classList.add("hidden"));
    $("user-color-save").addEventListener("click", saveUserColor);

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

  // ---------- Projects ----------
  function populateProjectSelect() {
    const sel = $("project-select");
    const current = sel.value;
    sel.innerHTML = `<option value="">— select project —</option>`;
    state.projects.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  }

  function populateEditProjectSelect(selectedId) {
    const sel = $("edit-project");
    sel.innerHTML = `<option value="">— none —</option>`;
    state.projects.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    if (selectedId) sel.value = selectedId;
  }

  function restoreLastProject() {
    const stored = localStorage.getItem(lastProjectKey());
    if (stored && state.projectsById[stored]) {
      $("project-select").value = stored;
    } else if (state.runningEntry?.project_id) {
      $("project-select").value = state.runningEntry.project_id;
    }
  }

  function renderColorSwatches(selectedColor) {
    const wrap = $("color-swatches");
    wrap.innerHTML = "";
    PROJECT_PALETTE.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = c;
      b.dataset.color = c;
      if (c === selectedColor) b.classList.add("selected");
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
        b.classList.add("selected");
      });
      wrap.appendChild(b);
    });
  }

  function openProjectModal(project) {
    state.editingProject = project?.id || null;
    $("project-modal-title").textContent = project ? "Edit project" : "New project";
    $("project-name").value = project?.name || "";
    renderColorSwatches(project?.color || PROJECT_PALETTE[Math.floor(Math.random() * PROJECT_PALETTE.length)]);
    $("project-delete").classList.toggle("hidden", !project || project.created_by !== state.user.id);
    $("project-modal").classList.remove("hidden");
    setTimeout(() => $("project-name").focus(), 0);
  }

  function closeProjectModal() {
    $("project-modal").classList.add("hidden");
    state.editingProject = null;
  }

  async function saveProject(e) {
    e.preventDefault();
    const name = $("project-name").value.trim();
    const selected = $("color-swatches").querySelector("button.selected");
    const color = selected?.dataset.color || PROJECT_PALETTE[0];
    if (!name) return;

    if (state.editingProject) {
      const { error } = await sb.from("projects").update({ name, color }).eq("id", state.editingProject);
      if (error) return toast(error.message, true);
    } else {
      const { data, error } = await sb.from("projects").insert({ name, color, created_by: state.user.id }).select().single();
      if (error) return toast(error.message, true);
      await loadProjects();
      populateProjectSelect();
      $("project-select").value = data.id;
      localStorage.setItem(lastProjectKey(), data.id);
    }
    await loadProjects();
    populateProjectSelect();
    closeProjectModal();
    renderAll();
  }

  async function deleteProject() {
    if (!state.editingProject) return;
    if (!confirm("Delete this project? Entries will be kept but lose their project link.")) return;
    const { error } = await sb.from("projects").delete().eq("id", state.editingProject);
    if (error) return toast(error.message, true);
    await loadProjects();
    populateProjectSelect();
    closeProjectModal();
    renderAll();
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
    sb.channel("tt_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "time_entries" }, async () => { await loadEntries(); renderAll(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, async () => { await loadProfiles(); renderAll(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, async () => { await loadProjects(); populateProjectSelect(); renderAll(); })
      .subscribe();
  }

  // ---------- Timer ----------
  async function toggleTimer() {
    const btn = $("timer-button");
    btn.classList.remove("bump");
    void btn.offsetWidth;
    btn.classList.add("bump");
    if (state.runningEntry) {
      const { error } = await sb.from("time_entries").update({ ended_at: new Date().toISOString() }).eq("id", state.runningEntry.id);
      if (error) return toast(error.message, true);
      state.runningEntry = null;
      await loadEntries(); renderAll();
    } else {
      const projectId = $("project-select").value || null;
      if (!projectId) return toast("Pick a project first (or create one with + New).", true);
      const payload = {
        user_id: state.user.id,
        started_at: new Date().toISOString(),
        project_id: projectId,
        task: "",
      };
      const { data, error } = await sb.from("time_entries").insert(payload).select().single();
      if (error) return toast(error.message, true);
      state.runningEntry = data;
      localStorage.setItem(lastProjectKey(), projectId);
      await loadEntries(); renderAll();
    }
    updateTimerUI();
  }

  function updateTimerUI() {
    const panel = document.querySelector(".timer-panel");
    const btn = $("timer-button");
    const status = $("timer-status");
    const sel = $("project-select");
    if (state.runningEntry) {
      panel.classList.add("running");
      btn.textContent = "Stop";
      status.textContent = "Running since " + formatTime(new Date(state.runningEntry.started_at));
      if (state.runningEntry.project_id) sel.value = state.runningEntry.project_id;
      sel.disabled = true;
      if (!state.tickInterval) state.tickInterval = setInterval(tickTimer, 1000);
      tickTimer();
    } else {
      panel.classList.remove("running");
      btn.textContent = "Start";
      status.textContent = "";
      sel.disabled = false;
      $("timer-display").textContent = "00:00:00";
      if (state.tickInterval) { clearInterval(state.tickInterval); state.tickInterval = null; }
    }
  }

  function tickTimer() {
    if (!state.runningEntry) return;
    const elapsed = Date.now() - new Date(state.runningEntry.started_at).getTime();
    $("timer-display").textContent = formatDuration(elapsed, true);
    updateDaySummary();
  }

  // ---------- Day summary ----------
  function computeTodayHoursForUser() {
    const today = isoDate(new Date());
    let ms = 0;
    state.entries.forEach((e) => {
      if (e.user_id !== state.user.id) return;
      if (isoDate(new Date(e.started_at)) !== today) return;
      const start = new Date(e.started_at);
      const end = e.ended_at ? new Date(e.ended_at) : new Date();
      ms += end - start;
    });
    return ms;
  }

  function lerpColor(a, b, t) {
    const parse = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    const [r1,g1,b1] = parse(a), [r2,g2,b2] = parse(b);
    const mix = (x,y) => Math.round(x + (y - x) * t);
    const hex = (n) => n.toString(16).padStart(2,"0");
    return `#${hex(mix(r1,r2))}${hex(mix(g1,g2))}${hex(mix(b1,b2))}`;
  }

  function updateDaySummary() {
    const ms = computeTodayHoursForUser();
    const hours = ms / 3600000;
    const goalHours = 7;
    const rawPct = (hours / goalHours) * 100;
    const clampedPct = Math.min(100, rawPct);

    $("day-hours").textContent = hours.toFixed(1) + "h";
    $("day-pct").textContent = rawPct.toFixed(0) + "%";

    const t = Math.min(1, hours / goalHours);
    const color = lerpColor("#fb7185", "#2dd4bf", t);
    const fill = $("day-progress-fill");
    fill.style.width = clampedPct + "%";
    fill.style.background = color;
    $("day-hours").style.color = color;
    $("day-pct").style.color = color;

    // Marker stays at the 7h line; visible only when we've crossed into overtime.
    const marker = $("day-progress-marker");
    if (rawPct > 100) {
      // Shrink the fill to show the 7h mark at an appropriate position within an extended bar.
      const barPct = Math.min(100, (goalHours / hours) * 100);
      marker.style.left = barPct + "%";
      marker.style.opacity = "1";
      fill.style.width = "100%"; // visually full
    } else {
      marker.style.opacity = "0";
    }

    const panel = $("day-summary");
    panel.classList.toggle("running", !!state.runningEntry);
    panel.classList.toggle("complete", hours >= goalHours);
    panel.classList.toggle("overtime", hours > goalHours);

    const footer = $("day-summary-footer");
    if (hours === 0) footer.textContent = "No time tracked today yet.";
    else if (hours < goalHours) footer.textContent = `${(goalHours - hours).toFixed(1)}h left to goal.`;
    else if (hours === goalHours) footer.textContent = `Goal hit.`;
    else footer.innerHTML = `<span class="over">+${(hours - goalHours).toFixed(1)}h</span> over goal.`;
  }

  // ---------- Render ----------
  function renderAll() {
    populateUserChip();
    populateProjectSelect();
    renderEntries();
    updateDaySummary();
    if (document.querySelector(".tab.active")?.dataset.tab === "calendar") renderCalendar();
    if (document.querySelector(".tab.active")?.dataset.tab === "chart") renderChart();
  }

  function openUserColorModal() {
    const current = profileOf(state.user.id).color;
    const wrap = $("user-color-swatches");
    wrap.innerHTML = "";
    USER_PALETTE.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = c;
      b.dataset.color = c;
      if (c.toLowerCase() === (current || "").toLowerCase()) b.classList.add("selected");
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
        b.classList.add("selected");
        $("user-color-custom").value = c;
      });
      wrap.appendChild(b);
    });
    $("user-color-custom").value = current || "#2dd4bf";
    $("user-color-custom").addEventListener("input", () => {
      wrap.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
    }, { once: true });
    $("user-color-modal").classList.remove("hidden");
  }

  async function saveUserColor() {
    const selected = $("user-color-swatches").querySelector("button.selected");
    const color = (selected?.dataset.color || $("user-color-custom").value || "#2dd4bf").toLowerCase();
    const { error } = await sb.from("profiles").update({ color }).eq("id", state.user.id);
    if (error) return toast(error.message, true);
    $("user-color-modal").classList.add("hidden");
    await loadProfiles();
    renderAll();
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
    const list = state.entries.filter((e) => e.user_id === state.user.id);
    const container = $("entries-list");
    if (!list.length) {
      container.innerHTML = `<p class="empty">No entries yet. Pick a project and press Start.</p>`;
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
    const proj = projectOf(e.project_id);
    const running = !e.ended_at;
    const start = new Date(e.started_at);
    const end = e.ended_at ? new Date(e.ended_at) : new Date();
    const dur = end - start;
    const row = document.createElement("div");
    row.className = "entry" + (running ? " running" : "");
    const title = proj ? escapeHtml(proj.name) : (e.task ? escapeHtml(e.task) : "(no project)");
    const projColor = proj?.color || "#555";
    const note = proj && e.task ? ` · ${escapeHtml(e.task)}` : "";
    const hours = dur / 3600000;
    const pct = Math.min(100, (hours / WORK_DAY_HOURS) * 100);
    const fillColor = proj?.color || p.color;
    row.innerHTML = `
      <div class="stripe" style="background:${p.color}"></div>
      <div class="main">
        <div class="task"><span class="project-chip"><span class="dot" style="background:${projColor}"></span>${title}</span>${note}</div>
        <div class="meta">${escapeHtml(p.display_name)} · ${formatTime(start)} – ${running ? "running" : formatTime(end)}<span class="pct">${pct.toFixed(0)}% of ${WORK_DAY_HOURS}h</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${fillColor}"></div></div>
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
    populateEditProjectSelect(entry.project_id);
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
      project_id: $("edit-project").value || null,
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
      cells.push({ date: new Date(date.getFullYear(), date.getMonth() - 1, day), otherMonth: true });
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
    cells.forEach(({ date: d, otherMonth }, i) => {
      const key = isoDate(d);
      const total = dayTotals[key];
      const cell = document.createElement("div");
      cell.className = "cal-cell" + (otherMonth ? " other-month" : "") + (key === today ? " today" : "") + (state.calSelected === key ? " selected" : "");
      const dotColors = total ? Object.keys(total.byProject).slice(0, 4).map((pid) => projectOf(pid)?.color || "#555") : [];
      cell.innerHTML = `
        <div class="day-num">${d.getDate()}</div>
        <div class="dots">${dotColors.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="day-hours">${total ? formatHours(total.total) : ""}</div>
      `;
      cell.addEventListener("click", () => {
        state.calSelected = key;
        renderCalendar();
        renderDayDetail(key);
      });
      grid.appendChild(cell);

      if ((i + 1) % 7 === 0) {
        const weekStart = cells[i - 6].date;
        const byUser = sumWeekByUser(weekStart, dayTotals);
        const weekCell = document.createElement("div");
        weekCell.className = "cal-week-total";
        // Always list every known profile so both users are visible, even with 0h.
        const userIds = Object.keys(state.profiles);
        // Self first.
        userIds.sort((a, b) => (a === state.user.id ? -1 : b === state.user.id ? 1 : 0));
        const rows = userIds.map((uid) => {
          const ms = byUser[uid] || 0;
          const hours = ms / 3600000;
          const delta = hours - WORK_WEEK_HOURS;
          const hasData = ms > 0;
          const cls = hasData ? (delta >= 0 ? "met" : "under") : "zero";
          const p = profileOf(uid);
          const sign = delta >= 0 ? "+" : "−";
          const deltaTxt = hasData ? `<span class="delta">${sign}${Math.abs(delta).toFixed(1)}h</span>` : "";
          const initial = (p.display_name || "?").trim().charAt(0);
          return `<div class="wk-row ${cls}">
            <span class="wk-initial" style="background:${p.color}">${escapeHtml(initial)}</span>
            <span class="hours">${hasData ? formatHours(ms) : "—"}</span>
            ${deltaTxt}
          </div>`;
        });
        weekCell.innerHTML = rows.join("");
        grid.appendChild(weekCell);
      }
    });

    if (state.calSelected) renderDayDetail(state.calSelected);
  }

  function sumWeekByUser(weekStart, dayTotals) {
    const byUser = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const key = isoDate(d);
      if (!dayTotals[key]) continue;
      Object.entries(dayTotals[key].byUser).forEach(([uid, ms]) => {
        byUser[uid] = (byUser[uid] || 0) + ms;
      });
    }
    return byUser;
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
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}h` } },
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
    let bucketKey, labelFmt;

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

    const byUser = {};
    const totals = {};
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

    // Aggregate into daily totals per user per project.
    const groups = {};  // key "date|userId|projectId" -> { date, userId, projectId, ms }
    rows.forEach((e) => {
      const s = new Date(e.started_at);
      const end = new Date(e.ended_at);
      const date = isoDate(s);
      const key = `${date}|${e.user_id}|${e.project_id || ""}`;
      if (!groups[key]) groups[key] = { date, userId: e.user_id, projectId: e.project_id, ms: 0 };
      groups[key].ms += end - s;
    });

    const sorted = Object.values(groups).sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return profileOf(a.userId).display_name.localeCompare(profileOf(b.userId).display_name);
    });

    const header = ["Date", "User", "Project", "Hours"];
    const lines = [header.join(",")];
    sorted.forEach((g) => {
      lines.push([
        csv(g.date),
        csv(profileOf(g.userId).display_name),
        csv(projectOf(g.projectId)?.name || ""),
        (g.ms / 3600000).toFixed(2),
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
  function formatTime(d) { return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
  function formatDuration(ms, withSeconds) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return withSeconds ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}`;
  }
  function formatHours(ms) {
    const h = ms / 3600000;
    return h >= 10 ? h.toFixed(0) + "h" : h.toFixed(1) + "h";
  }
  function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
      totals[key] = totals[key] || { total: 0, byProject: {}, byUser: {} };
      totals[key].total += ms;
      if (e.project_id) totals[key].byProject[e.project_id] = (totals[key].byProject[e.project_id] || 0) + ms;
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
