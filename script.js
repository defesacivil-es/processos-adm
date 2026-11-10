"use strict";

// URL da aba PUBLICADA. Nunca inclua credenciais ou dados secretos neste arquivo.
const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSKboflgKKsF6HALNdKCyua_BjL9gFsdag-WmJM_huh1HJMsjES6foHHxQ7c8OBnTWvx8kN6e_5YCUz/pub?gid=509268684&single=true&output=csv";
const REFRESH_EVERY_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
// O ano padrão é calculado no navegador, inclusive depois da virada do ano.
const CURRENT_YEAR = String(new Date().getFullYear());
const STEP_NAMES = [
  "ETP",
  "Matriz de Risco",
  "Lista de Verificação do ETP",
  "TR",
  "Orçamentos",
];
const STEP_SHORT = ["ETP", "MR", "LV", "TR", "ORÇ"];
const $ = (id) => document.getElementById(id);
let allProcesses = [];
let currentPage = 1;
let loaded = false;
let refreshing = false;
let sortColumn = null;
let sortDirection = "asc";

// Parser CSV com suporte a aspas escapadas, separadores e quebras de linha em células.
function parseCSV(text) {
  const result = [];
  let row = [],
    field = "",
    quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) result.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error("Arquivo CSV incompleto (aspas sem fechamento).");
  row.push(field);
  if (row.some((v) => v.trim() !== "")) result.push(row);
  return result;
}

function boolValue(value) {
  return /^(true|verdadeiro|sim|1)$/i.test(String(value ?? "").trim());
}
function norm(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function escapeHTML(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function parseProcess(row) {
  const get = (i) => String(row[i] ?? "").trim();
  const steps = [13, 14, 15, 16, 17].map((i) => boolValue(get(i)));
  return {
    year: get(0),
    object: get(1),
    unit: get(2),
    quantity: get(3),
    edocs: get(7),
    steps,
    done: steps.filter(Boolean).length,
    situation: get(18),
  };
}

function applyData(data) {
  allProcesses = data;
  loaded = true;
  currentPage = 1;
  // Na primeira carga, seleciona o ano atual. Em sincronizações futuras,
  // preserva a seleção manual (inclusive "Todos os anos").
  const yearFilter = $("yearFilter");
  const firstLoad = yearFilter.dataset.initialized !== "true";
  populateSelect(
    "yearFilter",
    [
      ...new Set([...data.map((p) => p.year).filter(Boolean), CURRENT_YEAR]),
    ].sort((a, b) => b.localeCompare(a, "pt-BR", { numeric: true })),
    "Todos os anos",
  );
  if (firstLoad) {
    yearFilter.value = CURRENT_YEAR;
    yearFilter.dataset.initialized = "true";
  }
  populateSelect(
    "statusFilter",
    [...new Set(data.map((p) => p.situation).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR"),
    ),
    "Todas as situações",
  );
  $("footerInfo").textContent =
    `Fonte: Google Sheets (CSV publicado) • ${data.length} registros • Consulta somente leitura`;
  setStatus(
    `Sincronizado às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`,
  );
  render();
}
function situationKind(status) {
  const s = norm(status);
  if (!s) return "undefined";
  if (
    s.includes("nao executado") ||
    s.includes("encerrado") ||
    s.includes("cancelado")
  )
    return "closed";
  if (s.includes("concluido") || s.includes("finalizado")) return "success";
  return "other";
}
function setStatus(message) {
  $("syncStatus").textContent = message;
}
function populateSelect(id, values, allLabel) {
  const element = $(id),
    previous = element.value;
  element.replaceChildren(new Option(allLabel, "all"));
  values.forEach((value) => element.add(new Option(value, value)));
  element.value = values.includes(previous) ? previous : "all";
}
function getFiltered() {
  const year = $("yearFilter").value,
    search = norm($("searchInput").value),
    status = $("statusFilter").value,
    progress = $("progressFilter").value;
  return allProcesses.filter((p) => {
    if (year !== "all" && p.year !== year) return false;
    if (status !== "all" && p.situation !== status) return false;
    if (search && !norm(`${p.object} ${p.edocs} ${p.unit}`).includes(search))
      return false;
    if (progress === "complete" && p.done !== 5) return false;
    if (progress === "partial" && (p.done === 0 || p.done === 5)) return false;
    if (progress === "none" && p.done !== 0) return false;
    return true;
  });
}
function renderEdocs(processNumber) {
  const number = String(processNumber ?? "").trim();
  if (!number) return '<span class="edocs">—</span>';
  const url = `https://e-docs.es.gov.br/Processo/Protocolo/${encodeURIComponent(number)}`;
  return `<a class="edocs" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir processo ${escapeHTML(number)} no E-Docs (nova aba)">${escapeHTML(number)}</a>`;
}

function sortProcesses(processes) {
  if (!sortColumn) return processes;
  const direction = sortDirection === "asc" ? 1 : -1;
  const compareText = (a, b) =>
    a.localeCompare(b, "pt-BR", { sensitivity: "base", numeric: true });
  return [...processes].sort((a, b) => {
    const byObject =
      compareText(a.object, b.object) || compareText(a.unit, b.unit);
    return sortColumn === "progress"
      ? (a.done - b.done) * direction || byObject
      : byObject * direction;
  });
}

function updateSortHeaders() {
  for (const column of ["object", "progress"]) {
    const active = column === sortColumn;
    $(`${column}SortHeader`).setAttribute(
      "aria-sort",
      active ? (sortDirection === "asc" ? "ascending" : "descending") : "none",
    );
    $(`${column}SortIcon`).textContent = active
      ? sortDirection === "asc"
        ? "↑"
        : "↓"
      : "↕";
    const label = column === "object" ? "Objeto / unidade" : "Progresso";
    const nextDirection =
      active && sortDirection === "asc" ? "decrescente" : "crescente";
    $(`${column}SortBtn`).setAttribute(
      "aria-label",
      `${label}: ordenar em ordem ${nextDirection}`,
    );
  }
}

function render() {
  const filtered = sortProcesses(getFiltered());
  updateSortHeaders();
  $("totalProcesses").textContent = filtered.length.toLocaleString("pt-BR");
  $("completeProcesses").textContent = filtered
    .filter((p) => p.done === 5)
    .length.toLocaleString("pt-BR");
  $("partialProcesses").textContent = filtered
    .filter((p) => p.done > 0 && p.done < 5)
    .length.toLocaleString("pt-BR");
  const pct = filtered.length
    ? Math.round(
        (filtered.reduce((sum, p) => sum + p.done, 0) / (5 * filtered.length)) *
          100,
      )
    : 0;
  $("averageProgress").textContent = `${pct}%`;
  $("resultCount").textContent =
    `${filtered.length} processo${filtered.length === 1 ? "" : "s"} encontrado${filtered.length === 1 ? "" : "s"}`;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pages);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  $("processRows").innerHTML = visible.length
    ? visible
        .map((p) => {
          const docs = p.steps
            .map(
              (done, i) =>
                `<span class="doc ${done ? "done" : "pending"}" title="${escapeHTML(STEP_NAMES[i])}: ${done ? "Concluída" : "Pendente"}" aria-label="${escapeHTML(STEP_NAMES[i])}: ${done ? "Concluída" : "Pendente"}">${done ? "✓" : "·"} ${STEP_SHORT[i]}</span>`,
            )
            .join("");
          return `<tr><td><span class="year-pill">${escapeHTML(p.year || "—")}</span></td><td><div class="object">${escapeHTML(p.object)}</div><div class="unit">${escapeHTML(p.unit || "Unidade não informada")}</div></td><td>${escapeHTML(p.quantity || "—")}</td><td>${renderEdocs(p.edocs)}</td><td><div class="docs" role="group" aria-label="Etapas documentais">${docs}</div></td><td class="progress-cell"><div class="progress-label"><span>${p.done}/5 etapas</span><strong>${p.done * 20}%</strong></div><div class="progress-track"><div class="progress-bar" style="width:${p.done * 20}%"></div></div></td><td><span class="status ${situationKind(p.situation)}">${escapeHTML(p.situation || "Não informada")}</span></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">${loaded ? "Nenhum processo corresponde aos filtros selecionados." : "Aguardando dados da planilha..."}</td></tr>`;
  $("pageInfo").textContent = `${currentPage} de ${pages}`;
  $("prevBtn").disabled = currentPage <= 1;
  $("nextBtn").disabled = currentPage >= pages;
}
async function loadData() {
  if (refreshing) return;
  refreshing = true;
  $("refreshBtn").disabled = true;
  setStatus("Consultando Google Sheets...");
  $("alert").hidden = true;
  try {
    const response = await fetch(`${CSV_URL}&_=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = parseCSV(await response.text());
    if (
      norm(rows?.[0]?.[0]) !== "ano" ||
      norm(rows?.[0]?.[1]) !== "objeto" ||
      norm(rows?.[0]?.[18]) !== "situacao"
    ) {
      throw new Error("Resposta CSV inválida");
    }
    const data = rows
      .slice(1)
      .filter(
        (row) => String(row[0] ?? "").trim() || String(row[1] ?? "").trim(),
      )
      .map(parseProcess);
    applyData(data);
  } catch (error) {
    setStatus(
      loaded
        ? "Falha na sincronização • Dados anteriores"
        : "Falha na sincronização",
    );
    $("alert").hidden = false;
    $("alert").textContent = loaded
      ? "Não foi possível atualizar o CSV publicado. Os dados exibidos são da última consulta bem-sucedida e podem estar desatualizados. Tente novamente em Atualizar dados."
      : "Não foi possível consultar o CSV publicado. Tente novamente em Atualizar dados.";
    if (!loaded) {
      $("processRows").innerHTML =
        '<tr><td colspan="7" class="empty">Não foi possível carregar os processos.</td></tr>';
      $("resultCount").textContent = "Dados indisponíveis";
    }
  } finally {
    refreshing = false;
    $("refreshBtn").disabled = false;
  }
}
for (const column of ["object", "progress"]) {
  $(`${column}SortBtn`).addEventListener("click", () => {
    sortDirection =
      sortColumn === column && sortDirection === "asc" ? "desc" : "asc";
    sortColumn = column;
    currentPage = 1;
    render();
  });
}
updateSortHeaders();
["yearFilter", "statusFilter", "progressFilter"].forEach((id) =>
  $(id).addEventListener("change", () => {
    currentPage = 1;
    render();
  }),
);
$("searchInput").addEventListener("input", () => {
  currentPage = 1;
  render();
});
$("clearBtn").addEventListener("click", () => {
  $("yearFilter").value = CURRENT_YEAR;
  $("statusFilter").value = "all";
  $("progressFilter").value = "all";
  $("searchInput").value = "";
  currentPage = 1;
  render();
});
$("prevBtn").addEventListener("click", () => {
  currentPage--;
  render();
});
$("nextBtn").addEventListener("click", () => {
  currentPage++;
  render();
});
$("refreshBtn").addEventListener("click", loadData);
loadData();
setInterval(() => {
  if (document.visibilityState === "visible") loadData();
}, REFRESH_EVERY_MS);
