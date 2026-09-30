# Central de Envio Seletivo de E-mails do EJC

Projeto 100% independente e isolado para envio seletivo de e-mails institucionais aos participantes do EJC com inscrição concluída.

---

## ⚠️ REGRA ABSOLUTA DE ISOLAMENTO
- **Este projeto é completamente autônomo** e opera dentro de sua própria pasta (`central-emails/`).
- **Nenhum arquivo do site principal do EJC foi ou deve ser alterado.**
- As inscrições, checkout, pagamentos (Pix / Cartão / Mercado Pago), contador de vagas, RPCs, banco de dados e arquivos existentes permanecem **100% intocados**.
- A Central apenas **consulta/lê** dados em tempo real através do endpoint administrativo oficial (`/api/admin`).

---

## 🎯 Funcionalidades Principais

1. **Painel de Participantes Elegíveis:**
   - Exibe exclusivamente participantes com inscrição **CONCLUÍDA** (`!arquivado`).
   - Tabela responsiva com Nome, E-mail, Sub, Inscrição, Status de Pagamento e Verificação do Link do WhatsApp.

2. **Filtros Avançados:**
   - **Status da Inscrição:** Fixo em `CONCLUÍDA`.
   - **Filtro de Pagamento:**
     - `TODOS OS PARTICIPANTES` (seleciona pagos e não pagos).
     - `PAGO (Confirmado)` (somente pagamentos confirmados no sistema).
     - `NÃO PAGO (Pendente)` (somente participantes com pagamento pendente).
   - **Filtro por Sub:**
     - `TODOS OS SUBS`, `Sub Verde`, `Sub Vermelho`, `Sub Amarelo`, `Sub Laranja`.
     - Subs obtidos dinamicamente dos dados oficiais do sistema (sem hardcoding).
   - **Busca Rápida:** Filtragem em tempo real por nome ou e-mail.

3. **Gerenciamento de Seleção:**
   - Checkbox individual por participante.
   - Botão **Selecionar Todos os Filtrados**.
   - Botão **Desmarcar Todos**.
   - Contador dinâmico: `X participantes selecionados de Y`.

4. **Regra Crítica — Link de WhatsApp Dinâmico por Sub:**
   - **Cada e-mail gerado recebe individualmente o link do grupo de WhatsApp do Sub do participante**, consultado da configuração oficial existente da aba *"Links de WPP"*.
   - **Nunca** usa links hardcoded.
   - **Nunca** usa o link de outro Sub como fallback.
   - **Proteção Ativa:** Se um Sub não possuir link configurado, o envio para participantes daquele Sub é **estritamente bloqueado** pelo backend com alerta específico.

5. **Compositor de E-mails com Variáveis Dinâmicas:**
   - Suporte a tags:
     - `{{nome}}`: Substituído pelo nome do participante.
     - `{{sub}}`: Substituído pelo Sub (ex.: Verde, Vermelho, etc.).
     - `{{link_whatsapp}}`: Transformado no backend em um **botão visual verde interativo de alta conversão** apontando para o link oficial do WhatsApp do respectivo Sub.
   - Layout de e-mail institucional responsivo com cabeçalho do EJC e badge colorida do Sub.

6. **Pré-visualização Real (Amostra):**
   - Permite inspecionar o e-mail exato que qualquer participante selecionado irá receber, testando a substituição de tags, o botão e a URL do Sub correspondente.

7. **Revisão Pré-Voo & Anti-Duplicidade:**
   - Modal com resumo de destinatários, quantidade de inscritos pagos e não pagos, e distribuição quantitativa por Sub antes da confirmação.

8. **Envio Controlado em Lotes (Batch):**
   - Envio sequencial em lotes (configurável para 5, 10 ou 15 e-mails por lote) com pausas de segurança de 400ms para respeitar limites da API da Brevo.
   - Barra de progresso em tempo real e tabela detalhada de status individual de entrega (`Enviado`, `Bloqueado`, `Falha`).

9. **Modo Teste Independente:**
   - Permite disparar um e-mail de teste seguro para qualquer endereço simulando o Sub desejado (Verde, Vermelho, Amarelo ou Laranja) para validação antes do envio em massa.

10. **Logs de Auditoria e Histórico:**
    - Registro local (`data/audit-logs.json`) contendo data/hora, assunto, selecionados, enviados, falhas e distribuição de pagamento. Nenhuma credencial ou API Key é gravada.

11. **Autenticação Própria:**
    - Acesso protegido por senha administrativa (`transitoejc26`) com tokens de sessão em memória.

---

## 🚀 Como Executar

### Pré-requisitos
- **Node.js** (versão 18+ recomendada). Zero pacotes npm extras necessários (o servidor utiliza 100% módulos nativos do Node: `http`, `https`, `crypto`, `fs`).

### 1. Iniciar no Windows:
Dê um duplo clique no arquivo:
```cmd
start.bat
```
Ou via terminal:
```bash
cd central-emails
node server.js
```

### 2. Acessar no Navegador:
Abra a URL:
```
http://localhost:3333
```
- **Senha Padrão:** `transitoejc26`

---

## 🔒 Configuração da Chave da Brevo (BREVO_API_KEY)

A Central lê a chave de API diretamente da variável de ambiente `BREVO_API_KEY` ou do arquivo local `.env` em `central-emails/.env`:

1. Abra o arquivo `central-emails/.env` (ou crie a partir de `central-emails/.env.example`).
2. Defina a variável:
   ```env
   BREVO_API_KEY=xkeysib-sua-chave-aqui-sem-aspas
   ```
3. Reinicie o servidor (`start.bat` ou `node server.js`).
4. Ao iniciar, o servidor confirmará:
   ```text
   BREVO_API_KEY configurada: SIM
   ```

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `BREVO_API_KEY` | *(Lida do .env)* | Chave oficial de API v3 da Brevo |
| `BREVO_FROM_EMAIL` | `hugogeeta.gamer@gmail.com` | E-mail verificado do remetente na Brevo |
| `BREVO_FROM_NAME` | `EJC — AD Monte Sião` | Nome do remetente |
| `CENTRAL_ADMIN_PASSWORD` | `transitoejc26` | Senha de login da Central |
| `SITE_URL` | `https://www.transitoejc.site` | URL da API oficial para leitura de dados |
| `ADMIN_TOKEN` | `transitoejc26` | Token de leitura da API `/api/admin` |
| `PORT` | `3333` | Porta HTTP local do servidor |

---

## 📁 Estrutura de Arquivos

```
central-emails/
├── .env                   # Arquivo local com BREVO_API_KEY (protegido no .gitignore)
├── .env.example           # Exemplo de configuração
├── .gitignore             # Garante que chaves e credenciais nunca sejam commitadas
├── server.js              # Servidor HTTP/REST autônomo (Zero dependências externas)
├── config.json            # Configuração local
├── start.bat              # Inicializador rápido para Windows
├── README.md              # Documentação completa
├── data/
│   └── audit-logs.json    # Histórico de auditoria persistido
└── public/
    ├── index.html         # Painel visual com todos os modais e ferramentas
    ├── css/
    │   └── style.css      # Design System moderno, responsivo com suporte a temas
    └── js/
        └── app.js         # Lógica client-side, filtros, seleção e compositor
```
