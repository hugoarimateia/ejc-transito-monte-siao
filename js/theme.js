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
    updateThemeLogos(theme);
    updateFavicon(theme);

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

  function updateThemeLogos(theme) {
    const isDark = theme === "dark";
    const logos = document.querySelectorAll("[data-logo-light][data-logo-dark], .brand img, .logo-card img, .footer-grid > img, .checkout-brand img, .admin-auth-card > img");
    logos.forEach(function(img) {
      let lightSrc = img.getAttribute("data-logo-light");
      let darkSrc = img.getAttribute("data-logo-dark");
      if (!lightSrc || !darkSrc) {
        const cur = img.getAttribute("src") || "";
        const isSubdir = cur.startsWith("../") || window.location.pathname.includes("/admin");
        const prefix = isSubdir ? "../images/" : "images/";
        lightSrc = prefix + "10 EJC MONTE SIÃO2.png?v=2";
        darkSrc = prefix + "10 EJC MONTE SIÃO.png?v=2";
      }
      const targetSrc = isDark ? darkSrc : lightSrc;
      if (img.getAttribute("src") !== targetSrc) {
        img.setAttribute("src", targetSrc);
      }
    });
  }

  function updateFavicon(theme) {
    const isSubdir = window.location.pathname.includes("/admin");
    const prefix = isSubdir ? "../images/" : "images/";
    // Favicon oficial do navegador: favicondefault.png para ambos os temas (Light e Dark)
    const targetFavicon = prefix + "favicondefault.png?v=4";

    // 1. Atualiza ou cria favicon padrão <link rel="icon">
    let favicon = document.querySelector('link[rel="icon"]');
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      favicon.type = "image/png";
      document.head.appendChild(favicon);
    }
    favicon.href = targetFavicon;

    // 2. Atualiza ou cria shortcut icon <link rel="shortcut icon">
    let shortcutIcon = document.querySelector('link[rel="shortcut icon"]');
    if (shortcutIcon) {
      shortcutIcon.href = targetFavicon;
    }
  }

  // Execução imediata no carregamento para sincronizar tema, logos e favicon
  const initialTheme = getPreferredTheme();
  document.documentElement.setAttribute("data-theme", initialTheme);
  try {
    updateThemeLogos(initialTheme);
    updateFavicon(initialTheme);
  } catch (e) {}

  // Inicialização pós-DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    const currentTheme = document.documentElement.getAttribute("data-theme") || initialTheme;
    updateToggleButtons(currentTheme);
    updateThemeLogos(currentTheme);
    updateFavicon(currentTheme);

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
    toggleTheme: toggleTheme,
    updateLogos: updateThemeLogos,
    updateFavicon: updateFavicon
  };
})();
