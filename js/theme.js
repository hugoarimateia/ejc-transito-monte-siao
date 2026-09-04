// ==============================================================================
// EJC DESIGN SYSTEM: GERENCIADOR GLOBAL DE TEMA (CLARO / ESCURO)
// ==============================================================================

(function() {
  const STORAGE_KEY = "ejc_theme";

  function getPreferredTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") {
      return saved;
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme, persist) {
    if (persist === undefined) persist = false;
    document.documentElement.setAttribute("data-theme", theme);
    if (persist) {
      localStorage.setItem(STORAGE_KEY, theme);
    }
    updateToggleButtons(theme);

    // Dispara evento customizado para componentes reativos
    window.dispatchEvent(new CustomEvent("ejc:themechange", { detail: { theme: theme } }));
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || getPreferredTheme();
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next, true);
  }

  function updateToggleButtons(theme) {
    const buttons = document.querySelectorAll(".theme-toggle-btn");
    buttons.forEach(function(btn) {
      const isDark = theme === "dark";
      btn.setAttribute("aria-label", isDark ? "Mudar para modo claro" : "Mudar para modo escuro");
      btn.setAttribute("title", isDark ? "Modo Claro" : "Modo Escuro");

      const icon = btn.querySelector("i");
      if (icon) {
        icon.className = isDark ? "fa-solid fa-sun" : "fa-solid fa-moon";
      }

      const textSpan = btn.querySelector(".theme-toggle-text");
      if (textSpan) {
        textSpan.textContent = isDark ? "Modo Claro" : "Modo Escuro";
      }
    });
  }

  // Execução imediata no carregamento para evitar FOUC
  const initialTheme = getPreferredTheme();
  document.documentElement.setAttribute("data-theme", initialTheme);

  // Inicialização pós-DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    updateToggleButtons(document.documentElement.getAttribute("data-theme") || initialTheme);

    // Event delegation para botões de alternância
    document.addEventListener("click", function(e) {
      const btn = e.target.closest(".theme-toggle-btn");
      if (btn) {
        e.preventDefault();
        toggleTheme();
      }
    });

    // Sincronização entre abas do navegador
    window.addEventListener("storage", function(e) {
      if (e.key === STORAGE_KEY && (e.newValue === "dark" || e.newValue === "light")) {
        applyTheme(e.newValue, false);
      }
    });

    // Detecção dinâmica de preferência do sistema operacional
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function(e) {
        if (!localStorage.getItem(STORAGE_KEY)) {
          applyTheme(e.matches ? "dark" : "light", false);
        }
      });
    }
  }

  // Expõe API global para integração
  window.EJC_THEME = {
    getTheme: function() { return document.documentElement.getAttribute("data-theme") || initialTheme; },
    setTheme: function(theme) { applyTheme(theme, true); },
    toggleTheme: toggleTheme
  };
})();
