// ==============================================================================
// EJC TRÂNSITO MONTE SIÃO - LANDING EVENTS & CONTADORES REGRESSIVOS
// Módulo de Contadores de Eventos, Docking no Calendário e Espaço Transiteiro
// ==============================================================================

(function (window, document) {
  "use strict";

  // Previne inicialização duplicada
  if (window.__EJC_LANDING_EVENTS_INITIALIZED__) return;
  window.__EJC_LANDING_EVENTS_INITIALIZED__ = true;

  var config = window.EJC_EVENTS_CONFIG || {};

  // ----------------------------------------------------------------------------
  // 1. UTILITÁRIOS TEMPORAIS E CÁLCULO DE INSTANTES
  // ----------------------------------------------------------------------------

  /**
   * Calcula o tempo restante até um instante ISO 8601 comparado com nowMs
   * @param {string|null} isoString
   * @param {number} nowMs
   * @returns {{ status: string, total: number, days: number, hours: number, minutes: number, seconds: number }}
   */
  function calculateRemaining(isoString, nowMs) {
    if (!isoString) {
      return { status: "sem_data", total: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
    }
    var targetMs = new Date(isoString).getTime();
    if (isNaN(targetMs)) {
      return { status: "invalido", total: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
    }

    var diff = targetMs - nowMs;
    if (diff <= 0) {
      return { status: "atingido", total: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
    }

    var seconds = Math.floor((diff / 1000) % 60);
    var minutes = Math.floor((diff / (1000 * 60)) % 60);
    var hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    var days = Math.floor(diff / (1000 * 60 * 60 * 24));

    return {
      status: "futuro",
      total: diff,
      days: Math.max(0, days),
      hours: Math.max(0, hours),
      minutes: Math.max(0, minutes),
      seconds: Math.max(0, seconds)
    };
  }

  function pad(num) {
    return num < 10 ? "0" + num : String(num);
  }

  // ----------------------------------------------------------------------------
  // 2. RENDERIZAÇÃO DOS CARDS DE CONTADORES
  // ----------------------------------------------------------------------------

  /**
   * Atualiza os elementos visuais de um contador
   * @param {HTMLElement} cardEl
   * @param {object} rem
   * @param {object} eventData
   */
  function updateCardUI(cardEl, rem, eventData) {
    if (!cardEl) return;

    var daysEl = cardEl.querySelector('[data-unit="days"]');
    var hoursEl = cardEl.querySelector('[data-unit="hours"]');
    var minsEl = cardEl.querySelector('[data-unit="minutes"]');
    var secsEl = cardEl.querySelector('[data-unit="seconds"]');
    var statusEl = cardEl.querySelector(".ejc-events-status-msg");
    var timerWrap = cardEl.querySelector(".ejc-events-timer");

    if (rem.status === "atingido") {
      if (daysEl) daysEl.textContent = "00";
      if (hoursEl) hoursEl.textContent = "00";
      if (minsEl) minsEl.textContent = "00";
      if (secsEl) secsEl.textContent = "00";
      if (statusEl) {
        statusEl.textContent = "Horário de início atingido!";
        statusEl.style.display = "block";
      }
      if (timerWrap) timerWrap.classList.add("is-finished");
    } else if (rem.status === "sem_data") {
      if (statusEl) {
        statusEl.textContent = "Data e horário a serem confirmados";
        statusEl.style.display = "block";
      }
      if (timerWrap) timerWrap.style.display = "none";
    } else {
      if (timerWrap) timerWrap.style.display = "flex";
      if (timerWrap) timerWrap.classList.remove("is-finished");

      var dStr = rem.days < 10 ? "0" + rem.days : String(rem.days);
      if (daysEl && daysEl.textContent !== dStr) daysEl.textContent = dStr;
      if (hoursEl && hoursEl.textContent !== pad(rem.hours)) hoursEl.textContent = pad(rem.hours);
      if (minsEl && minsEl.textContent !== pad(rem.minutes)) minsEl.textContent = pad(rem.minutes);
      if (secsEl && secsEl.textContent !== pad(rem.seconds)) secsEl.textContent = pad(rem.seconds);

      if (statusEl) {
        if (eventData && eventData.horarioConfirmado === false) {
          statusEl.textContent = "Data confirmada • Horário oficial a confirmar";
          statusEl.style.display = "block";
        } else {
          statusEl.style.display = "none";
        }
      }
    }
  }

  // ----------------------------------------------------------------------------
  // 3. SELEÇÃO DINÂMICA DA PRÓXIMA REUNIÃO
  // ----------------------------------------------------------------------------

  function getProximaReuniao(nowMs) {
    var lista = config.reunioes || [];
    for (var i = 0; i < lista.length; i++) {
      var r = lista[i];
      var startMs = r.inicio ? new Date(r.inicio).getTime() : NaN;
      var endMs = r.termino ? new Date(r.termino).getTime() : NaN;

      // Se não há término válido definido
      if (isNaN(endMs)) {
        if (!isNaN(startMs)) {
          return { reuniao: r, index: i, total: lista.length, hasValidEnd: false };
        }
        continue;
      }

      // Se nowMs é estritamente menor que o término da reunião, ela é a ativa
      // (cobre tanto o período antes do início quanto o período em andamento)
      if (nowMs < endMs) {
        return { reuniao: r, index: i, total: lista.length, hasValidEnd: true };
      }
    }
    // Todas as reuniões cadastradas já atingiram seu término
    return null;
  }

  function updateReuniaoCard(cardEl, nowMs) {
    if (!cardEl) return;
    var info = getProximaReuniao(nowMs);
    var titleEl = cardEl.querySelector(".ejc-events-card-title");
    var badgeEl = cardEl.querySelector(".ejc-events-badge");
    var dateEl = cardEl.querySelector(".ejc-events-date-label");
    var subtitleEl = cardEl.querySelector(".ejc-events-card-subtitle");
    var statusEl = cardEl.querySelector(".ejc-events-status-msg");
    var timerWrap = cardEl.querySelector(".ejc-events-timer");

    // 4. Após o término da última reunião, apresenta "Não há próximas reuniões agendadas"
    if (!info) {
      if (titleEl) titleEl.textContent = "Reunião Geral – Sorteio de Ficha";
      if (badgeEl) badgeEl.textContent = "Sorteio de Ficha";
      if (dateEl) dateEl.innerHTML = '<i class="fa-regular fa-calendar-check" aria-hidden="true"></i> Cronograma finalizado';
      if (subtitleEl) subtitleEl.textContent = "Não há próximas reuniões agendadas";
      if (statusEl) {
        statusEl.textContent = "Não há próximas reuniões agendadas";
        statusEl.style.display = "block";
      }
      if (timerWrap) timerWrap.style.display = "none";
      return;
    }

    var r = info.reuniao;
    if (titleEl) titleEl.textContent = r.titulo;
    if (badgeEl) badgeEl.textContent = r.badge || r.tipo;
    if (dateEl) dateEl.innerHTML = '<i class="fa-regular fa-calendar" aria-hidden="true"></i> ' + r.dataTexto;
    if (subtitleEl) subtitleEl.textContent = r.subtitulo || "Faltam para o início da reunião";

    var startMs = r.inicio ? new Date(r.inicio).getTime() : NaN;
    var endMs = r.termino ? new Date(r.termino).getTime() : NaN;

    var daysEl = cardEl.querySelector('[data-unit="days"]');
    var hoursEl = cardEl.querySelector('[data-unit="hours"]');
    var minsEl = cardEl.querySelector('[data-unit="minutes"]');
    var secsEl = cardEl.querySelector('[data-unit="seconds"]');

    // Se faltar um término válido e já passou do início, informa a pendência sem inventar dados
    if (!info.hasValidEnd && !isNaN(startMs) && nowMs >= startMs) {
      if (timerWrap) timerWrap.style.display = "flex";
      if (daysEl) daysEl.textContent = "00";
      if (hoursEl) hoursEl.textContent = "00";
      if (minsEl) minsEl.textContent = "00";
      if (secsEl) secsEl.textContent = "00";
      if (statusEl) {
        statusEl.textContent = "Horário de término a confirmar";
        statusEl.style.display = "block";
      }
      return;
    }

    // 2. Entre inicio e termino: apresenta "Reunião em andamento", sem contagem negativa
    if (!isNaN(startMs) && !isNaN(endMs) && nowMs >= startMs && nowMs < endMs) {
      if (timerWrap) timerWrap.style.display = "flex";
      if (daysEl) daysEl.textContent = "00";
      if (hoursEl) hoursEl.textContent = "00";
      if (minsEl) minsEl.textContent = "00";
      if (secsEl) secsEl.textContent = "00";
      if (statusEl) {
        statusEl.textContent = "Reunião em andamento";
        statusEl.style.display = "block";
      }
      return;
    }

    // 1. Antes de inicio: o card conta regressivamente para a reunião
    var rem = calculateRemaining(r.inicio, nowMs);
    updateCardUI(cardEl, rem, r);
  }

  // 4. AGENDADOR ÚNICO DE TICK (1000ms)
  // ----------------------------------------------------------------------------

  var principalCard = null;
  var reuniaoCard = null;
  var cultoCard = null;
  var timerInterval = null;

  function tick() {
    var nowMs = Date.now();

    // 1. Principal (Encontro)
    if (principalCard && config.encontro) {
      var remPrincipal = calculateRemaining(config.encontro.inicio, nowMs);
      updateCardUI(principalCard, remPrincipal, config.encontro);
    }

    // 2. Próxima Reunião
    if (reuniaoCard) {
      updateReuniaoCard(reuniaoCard, nowMs);
    }

    // 3. Culto de Entrega
    if (cultoCard && config.cultoEntrega) {
      var remCulto = calculateRemaining(config.cultoEntrega.inicio, nowMs);
      updateCardUI(cultoCard, remCulto, config.cultoEntrega);
    }
  }

  function startScheduler() {
    if (timerInterval) clearInterval(timerInterval);
    tick(); // Execução imediata
    timerInterval = setInterval(tick, 1000);
  }

  // Tratamento de suspensão e retorno à aba
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) tick();
  });
  window.addEventListener("pageshow", function () {
    tick();
  });

  // ----------------------------------------------------------------------------
  // 5. ENCAIXE SUAVE (DOCKING / UNDOCKING) DO CONTADOR PRINCIPAL
  // ----------------------------------------------------------------------------

  function initDockingMechanism() {
    var slot = document.getElementById("ejcEventsSlotPrincipal");
    principalCard = document.getElementById("ejcPrincipalCounter");
    if (!slot || !principalCard) return;

    var isDocked = false;
    var isManuallyClosed = false;

    // Configura botão de fechar do contador flutuante
    var closeBtn = principalCard.querySelector(".ejc-events-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        isManuallyClosed = true;
        updateFloatingVisibility();
      });
    }

    // Garante dimensões estáveis no slot para evitar qualquer salto de layout (CLS)
    function ensureSlotStability() {
      if (principalCard) {
        var cardHeight = principalCard.offsetHeight;
        if (cardHeight > 100) {
          slot.style.minHeight = cardHeight + "px";
        }
      }
    }
    ensureSlotStability();
    window.addEventListener("resize", function () {
      ensureSlotStability();
      updateFloatingVisibility();
    }, { passive: true });

    // Rastreia quais cards de contadores estão atualmente visíveis na viewport
    var visibleCountdowns = new Set();

    // Elementos de contagem observados na landing page (área útil abaixo do cabeçalho)
    var countdownCards = [
      slot,
      document.getElementById("ejcEventsCardReuniao"),
      document.getElementById("ejcEventsCardCulto"),
      document.getElementById("ejcEventsCardEnsaios")
    ].filter(Boolean);

    function updateFloatingVisibility() {
      if (isDocked) {
        // Quando encaixado no Calendário, SEMPRE visível no espaço nativo da seção
        principalCard.classList.remove("is-hidden");
        return;
      }

      // Quando em modo flutuante:
      // Oculta se o usuário fechou manualmente OU se qualquer outro countdown estiver visível na viewport
      var anyCountdownVisible = visibleCountdowns.size > 0;
      if (isManuallyClosed || anyCountdownVisible) {
        principalCard.classList.add("is-hidden");
      } else {
        principalCard.classList.remove("is-hidden");
      }
    }

    function setDockedState(dock) {
      if (dock === isDocked) return;
      isDocked = dock;

      if (dock) {
        // Encaixa no slot da seção Calendário
        slot.appendChild(principalCard);
        principalCard.classList.remove("ejc-events-floating");
        principalCard.classList.add("ejc-events-docked");
        principalCard.setAttribute("data-state", "docked");
      } else {
        // Retorna à posição flutuante
        document.body.appendChild(principalCard);
        principalCard.classList.remove("ejc-events-docked");
        principalCard.classList.add("ejc-events-floating");
        principalCard.setAttribute("data-state", "floating");
      }
      updateFloatingVisibility();
    }

    // IntersectionObserver observando os próprios cards de contadores
    // rootMargin: -70px no topo desconta o cabeçalho fixo, considerando a área útil real
    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            // Atualiza o conjunto de contadores visíveis
            if (entry.isIntersecting) {
              visibleCountdowns.add(entry.target);
            } else {
              visibleCountdowns.delete(entry.target);
            }

            // Gerencia o encaixe (docking) no slot com histerese suave
            if (entry.target === slot) {
              if (entry.isIntersecting && entry.intersectionRatio >= 0.20) {
                setDockedState(true);
              } else if (!entry.isIntersecting || entry.intersectionRatio <= 0.05) {
                setDockedState(false);
              }
            }
          });

          updateFloatingVisibility();
        },
        {
          root: null,
          rootMargin: "-70px 0px 0px 0px",
          threshold: [0.0, 0.05, 0.20, 0.5, 1.0]
        }
      );

      countdownCards.forEach(function (el) {
        observer.observe(el);
      });

      // Verificação inicial síncrona para evitar qualquer piscada no carregamento
      var headerOffset = 70;
      var windowHeight = window.innerHeight || document.documentElement.clientHeight;
      var shouldDockInitially = false;

      countdownCards.forEach(function (el) {
        var rect = el.getBoundingClientRect();
        var inView = rect.bottom > headerOffset && rect.top < windowHeight;
        if (inView) {
          visibleCountdowns.add(el);
          if (el === slot) {
            var visibleHeight = Math.min(rect.bottom, windowHeight) - Math.max(rect.top, headerOffset);
            var ratio = visibleHeight / (rect.height || 1);
            if (ratio >= 0.25) {
              shouldDockInitially = true;
            }
          }
        }
      });

      if (shouldDockInitially) {
        setDockedState(true);
      } else {
        updateFloatingVisibility();
      }
    } else {
      // Fallback sem IntersectionObserver: mantém encaixado no Calendário
      setDockedState(true);
    }
  }

  // ----------------------------------------------------------------------------
  // 6. GALERIA DA SEÇÃO "TRANSITEIRO" (CAMISAS & BRINCADEIRAS)
  // ----------------------------------------------------------------------------

  function initTransiteiroGallery() {
    var galleryWrap = document.querySelector(".ejc-transiteiro-camisas");
    if (!galleryWrap) return;

    var tabs = galleryWrap.querySelectorAll(".ejc-sub-tab");
    var mainImg = galleryWrap.querySelector("#ejcCamisaPreviewImg");
    var titleEl = galleryWrap.querySelector("#ejcCamisaActiveTitle");
    var descEl = galleryWrap.querySelector("#ejcCamisaActiveDesc");
    var badgeEl = galleryWrap.querySelector("#ejcCamisaActiveBadge");

    var camisaData = {
      Verde: {
        nome: "Sub Verde",
        cor: "#24a764",
        imagem: "images/transiteiro/camisa-sub-verde.png",
        descricao: "Camisa oficial Sub Verde — Coordenação Abraão e Sara."
      },
      Vermelho: {
        nome: "Sub Vermelho",
        cor: "#e8333e",
        imagem: "images/transiteiro/camisa-sub-vermelho.png",
        descricao: "Camisa oficial Sub Vermelho — Coordenação Kadmiel e Bia."
      },
      Amarelo: {
        nome: "Sub Amarelo",
        cor: "#e9dd3c",
        imagem: "images/transiteiro/camisa-sub-amarelo.png",
        descricao: "Camisa oficial Sub Amarelo — Coordenação Mateus e Gabriely."
      },
      Laranja: {
        nome: "Sub Laranja",
        cor: "#f97316",
        imagem: "images/transiteiro/camisa-sub-laranja.png",
        descricao: "Camisa oficial Sub Laranja — Coordenação Alan e Kallyne."
      }
    };

    tabs.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var subKey = btn.getAttribute("data-sub");
        var data = camisaData[subKey];
        if (!data) return;

        // Atualiza estado das tabs
        tabs.forEach(function (t) {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");

        // Transição suave de imagem
        if (mainImg) {
          mainImg.style.opacity = "0.2";
          setTimeout(function () {
            mainImg.src = data.imagem;
            mainImg.alt = "Camisa oficial da Equipe do Trânsito do " + data.nome;
            mainImg.style.opacity = "1";
          }, 120);
        }

        if (titleEl) titleEl.textContent = data.nome;
        if (descEl) descEl.textContent = data.descricao;
        if (badgeEl) {
          badgeEl.textContent = data.nome;
          badgeEl.style.backgroundColor = data.cor;
          badgeEl.style.color = (subKey === "Amarelo") ? "#1e293b" : "#ffffff";
        }
      });
    });

    // Integração com o Modal de Imagem nativo do projeto (<dialog class="image-modal">)
    var modal = document.querySelector(".image-modal");
    var modalImage = modal ? modal.querySelector("img") : null;

    var btnZoomCamisa = galleryWrap.querySelector(".ejc-camisa-zoom-trigger");
    if (btnZoomCamisa && modal && modalImage && mainImg) {
      btnZoomCamisa.addEventListener("click", function () {
        modalImage.src = mainImg.src;
        modalImage.alt = mainImg.alt;
        if (typeof modal.showModal === "function") modal.showModal();
      });
    }

    var btnZoomCapa = document.querySelector(".ejc-brincadeiras-zoom-trigger");
    if (btnZoomCapa && modal && modalImage) {
      btnZoomCapa.addEventListener("click", function () {
        var capaImg = btnZoomCapa.querySelector("img");
        if (capaImg) {
          modalImage.src = capaImg.src;
          modalImage.alt = capaImg.alt;
          if (typeof modal.showModal === "function") modal.showModal();
        }
      });
    }
  }

  // ----------------------------------------------------------------------------
  // 7. INICIALIZAÇÃO NO CARREGAMENTO DO DOM
  // ----------------------------------------------------------------------------

  function init() {
    reuniaoCard = document.getElementById("ejcEventsCardReuniao");
    cultoCard = document.getElementById("ejcEventsCardCulto");

    initDockingMechanism();
    initTransiteiroGallery();
    startScheduler();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})(window, document);

