// ==============================================================================
// EJC TRÂNSITO MONTE SIÃO - CONFIGURAÇÃO DOS EVENTOS E DATAS OFICIAIS
// Fuso Horário Oficial: Campina Grande/PB (America/Fortaleza - UTC-03:00)
// ==============================================================================

(function (window) {
  "use strict";

  // Fuso oficial para referência
  var TIMEZONE_OFFSET = "-03:00";
  var TIMEZONE_IANA = "America/Fortaleza";

  /**
   * MAPA CENTRAL DE CONFIGURAÇÃO DE EVENTOS
   * Todos os instantes utilizam o formato ISO 8601 com offset explícito -03:00.
   *
   * FONTES OFICIAIS ENCONTRADAS:
   * 1. Cartaz oficial (images/calendario-reunioes.png):
   *    - Reunião de coordenadores: 04/11
   *    - Reuniões com sorteio de ficha: 11, 18 e 25 de novembro
   *    - Culto de entrega: 02/12
   * 2. Caderno de Brincadeiras (images/transiteiro/brincadeiras-transito-adms.pdf):
   *    - Encontro 10º EJC: 04, 05 e 06 de Dezembro de 2026.
   * 3. Horários exatos:
   *    - Ainda pendentes de confirmação detalhada pela coordenação.
   *    - A flag 'horarioConfirmado' controla a exibição transparente.
   */
  window.EJC_EVENTS_CONFIG = {
    timezone: TIMEZONE_IANA,
    offset: TIMEZONE_OFFSET,

    // 1. EVENTO PRINCIPAL: 10º EJC (ENCONTRO)
    encontro: {
      id: "encontro-principal",
      titulo: "10º EJC — Encontro de Jovens com Cristo",
      subtitulo: "Faltam para o início do encontro",
      badge: "10º EJC • AD Monte Sião",
      dataTexto: "04 a 06 de Dezembro de 2026",
      // Sexta-feira, 04 de Dezembro de 2026 às 19:00 (horário previsto canônico)
      inicio: "2026-12-04T19:00:00" + TIMEZONE_OFFSET,
      termino: "2026-12-06T22:00:00" + TIMEZONE_OFFSET,
      dataConfirmada: true,
      horarioConfirmado: false, // Horário exato pendente de confirmação final pela coordenação
      localNome: "Local do encontro",
      mapsUrl: "https://maps.app.goo.gl/W32NggvNxfmQzZ9M7"
    },

    // 2. REUNIÕES (Ordenadas cronologicamente para seleção automática da próxima)
    reunioes: [
      {
        id: "reuniao-coord-04-11",
        titulo: "Reunião de Coordenadores",
        dataTexto: "04 de Novembro de 2026",
        inicio: "2026-11-04T19:30:00" + TIMEZONE_OFFSET,
        termino: "2026-11-04T21:30:00" + TIMEZONE_OFFSET,
        tipo: "Coordenadores",
        badge: "Coordenação",
        dataConfirmada: true,
        horarioConfirmado: false,
        localNome: "Local das reuniões",
        mapsUrl: "https://maps.app.goo.gl/LzukqmEfCe2GnL6E8"
      },
      {
        id: "reuniao-geral-11-11",
        titulo: "Reunião Geral • Sorteio de Ficha",
        dataTexto: "11 de Novembro de 2026",
        inicio: "2026-11-11T19:30:00" + TIMEZONE_OFFSET,
        termino: "2026-11-11T21:30:00" + TIMEZONE_OFFSET,
        tipo: "Geral",
        badge: "Sorteio de Ficha",
        dataConfirmada: true,
        horarioConfirmado: false,
        localNome: "Local das reuniões",
        mapsUrl: "https://maps.app.goo.gl/LzukqmEfCe2GnL6E8"
      },
      {
        id: "reuniao-geral-18-11",
        titulo: "Reunião Geral • Sorteio de Ficha",
        dataTexto: "18 de Novembro de 2026",
        inicio: "2026-11-18T19:30:00" + TIMEZONE_OFFSET,
        termino: "2026-11-18T21:30:00" + TIMEZONE_OFFSET,
        tipo: "Geral",
        badge: "Sorteio de Ficha",
        dataConfirmada: true,
        horarioConfirmado: false,
        localNome: "Local das reuniões",
        mapsUrl: "https://maps.app.goo.gl/LzukqmEfCe2GnL6E8"
      },
      {
        id: "reuniao-geral-25-11",
        titulo: "Reunião Geral • Sorteio de Ficha",
        dataTexto: "25 de Novembro de 2026",
        inicio: "2026-11-25T19:30:00" + TIMEZONE_OFFSET,
        termino: "2026-11-25T21:30:00" + TIMEZONE_OFFSET,
        tipo: "Geral",
        badge: "Sorteio de Ficha",
        dataConfirmada: true,
        horarioConfirmado: false,
        localNome: "Local das reuniões",
        mapsUrl: "https://maps.app.goo.gl/LzukqmEfCe2GnL6E8"
      }
    ],

    // 3. CULTO DE ENTREGA
    cultoEntrega: {
      id: "culto-entrega",
      titulo: "Culto de Entrega",
      subtitulo: "Faltam para o Culto de Entrega",
      badge: "Culto Especial",
      dataTexto: "02 de Dezembro de 2026",
      inicio: "2026-12-02T19:30:00" + TIMEZONE_OFFSET,
      termino: "2026-12-02T22:00:00" + TIMEZONE_OFFSET,
      dataConfirmada: true,
      horarioConfirmado: false,
      localNome: "Local do culto de entrega",
      mapsUrl: "https://maps.app.goo.gl/LzukqmEfCe2GnL6E8"
    },

    // 4. ENSAIOS (Informação Complementar)
    ensaios: {
      id: "ensaios-transito",
      titulo: "Ensaios da Equipe do Trânsito",
      badge: "Ensaios",
      dataTexto: "Datas a serem divulgadas pela coordenação",
      inicio: null, // Sem programação oficial confirmada
      dataConfirmada: false,
      horarioConfirmado: false,
      localNome: "Local dos ensaios",
      mapsUrl: "https://maps.app.goo.gl/m93X2Qwj6AdEBcYFA"
    }
  };

})(window);

