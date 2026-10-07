// supabase/functions/admin-write/whatsapp-validator.ts
// Módulo compartilhado de validação canônica para links de WhatsApp (OP05)
// Compatível com Deno (Edge Function) e Node 24 (Testes de Integração).

export const CANONICAL_SUBS = ["Verde", "Vermelho", "Amarelo", "Laranja", "Geral"] as const;
export type CanonicalSub = typeof CANONICAL_SUBS[number];

export const SUB_MAP: Record<string, CanonicalSub> = {
  verde: "Verde",
  vermelho: "Vermelho",
  amarelo: "Amarelo",
  laranja: "Laranja",
  geral: "Geral"
};

// Regex de validação para chat.whatsapp.com:
// Exige código de grupo alfanumérico com 5 a 64 caracteres.
// Aceita opcionalmente prefixo /invite/.
// Rejeita identificador ausente ou que seja meramente a palavra 'invite'.
// Aceita query parameters e fragments legítimos.
export const WPP_CHAT_REGEX = /^https:\/\/chat\.whatsapp\.com\/(invite\/[A-Za-z0-9_\-]{5,64}|(?!invite(\/|\?|#|$))[A-Za-z0-9_\-]{5,64})\/?(\?[A-Za-z0-9_\-\.\?=&%#+\/,\!:]+)?(#.*)?$/i;

// Regex de validação para wa.me:
// Exige número de telefone numérico com 8 a 16 dígitos (opcionalmente com +).
// Rejeita identificador vazio ou não numérico.
// Aceita query parameters legítimos (ex: ?text=Mensagem,%20Olá!).
export const WPP_WAME_REGEX = /^https:\/\/wa\.me\/(\+)?[0-9]{8,16}\/?(\?[A-Za-z0-9_\-\.\?=&%#+\/,\!:]+)?(#.*)?$/i;

export interface UrlValidationResult {
  ok: boolean;
  cleanUrl?: string;
  error?: string;
}

export function validateWhatsAppUrl(rawUrl: unknown, groupName: string): UrlValidationResult {
  if (typeof rawUrl !== "string") {
    return {
      ok: false,
      error: `Link para o grupo ${groupName} deve ser uma string não vazia.`
    };
  }

  // 1. Verificação de vazios e comprimento
  if (!rawUrl || rawUrl.trim().length === 0) {
    return {
      ok: false,
      error: `Link para o grupo ${groupName} não pode ser vazio.`
    };
  }

  if (rawUrl.length > 500) {
    return {
      ok: false,
      error: `Link para o grupo ${groupName} excede o limite máximo de 500 caracteres.`
    };
  }

  // 2. Rejeição de espaços ou caracteres de controle (inclusive internos)
  if (/[\s\r\n\t]/.test(rawUrl)) {
    return {
      ok: false,
      error: `Link para o grupo ${groupName} não pode conter espaços ou quebras de linha.`
    };
  }

  const cleanUrl = rawUrl.trim();

  // 3. Verificação de autoridade: rejeição estrita de credenciais embutidas (@) ou portas (:porta, inclusive :443)
  // Analisa estritamente a autoridade entre https:// e o primeiro terminador (/, ? ou #)
  const authMatch = cleanUrl.match(/^https:\/\/([^\/\?#]+)/i);
  if (!authMatch) {
    return {
      ok: false,
      error: `Link para o grupo ${groupName} deve utilizar o protocolo HTTPS e possuir autoridade válida.`
    };
  }

  const rawAuthority = authMatch[1];
  if (rawAuthority.includes("@") || rawAuthority.includes(":")) {
    return {
      ok: false,
      error: `Link para o grupo ${groupName} não pode conter portas explícitas ou credenciais de usuário.`
    };
  }

  // 4. Verificação de host oficial e estrutura de caminho/parâmetros
  if (!WPP_CHAT_REGEX.test(cleanUrl) && !WPP_WAME_REGEX.test(cleanUrl)) {
    return {
      ok: false,
      error: `Link inválido para o grupo ${groupName}: formato incompatível com os padrões oficiais de chat.whatsapp.com ou wa.me.`
    };
  }

  return {
    ok: true,
    cleanUrl
  };
}

export interface PayloadValidationResult {
  ok: boolean;
  verifiedLinks?: Record<string, string>;
  error?: string;
}

export function validateWhatsAppPayload(rawInput: unknown): PayloadValidationResult {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return {
      ok: false,
      error: "Payload de links ('subs', 'links' ou 'whatsapp') é obrigatório e deve ser um objeto."
    };
  }

  const inputMap = rawInput as Record<string, unknown>;
  const keys = Object.keys(inputMap);

  if (keys.length === 0) {
    return {
      ok: false,
      error: "Nenhum link fornecido para atualização."
    };
  }

  // Rejeitar grupos desconhecidos ou campos inesperados no payload
  const unknownKeys: string[] = [];
  for (const key of keys) {
    const norm = key.trim().toLowerCase();
    if (!SUB_MAP[norm]) {
      unknownKeys.push(key);
    }
  }

  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `Grupos não reconhecidos no payload: ${unknownKeys.join(", ")}. Permitidos apenas: Verde, Vermelho, Amarelo, Laranja, Geral.`
    };
  }

  const verifiedLinks: Record<string, string> = {};
  for (const [key, val] of Object.entries(inputMap)) {
    const canonicalName = SUB_MAP[key.trim().toLowerCase()];
    if (!canonicalName) continue;

    const valResult = validateWhatsAppUrl(val, canonicalName);
    if (!valResult.ok || !valResult.cleanUrl) {
      return {
        ok: false,
        error: valResult.error || `Link inválido para o grupo ${canonicalName}.`
      };
    }

    verifiedLinks[canonicalName] = valResult.cleanUrl;
  }

  if (Object.keys(verifiedLinks).length === 0) {
    return {
      ok: false,
      error: "Nenhum link válido fornecido para atualização."
    };
  }

  return {
    ok: true,
    verifiedLinks
  };
}
