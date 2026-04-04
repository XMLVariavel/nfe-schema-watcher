# NF-e Schema Watcher

Automação que roda diariamente via GitHub Actions, detecta mudanças no schema NF-e e envia e-mail de alerta.

## O que ele faz

```
Todo dia às 07:00 BRT
  ↓
Acessa o MOC SEFAZ-PR → lê a versão atual ("NT 2025.002 v.1.35 publicada em 31/03/2026")
  ↓
Compara com o snapshot anterior (data/snapshot.json)
  ↓
Se mudou → baixa os XSDs da SEFAZ → extrai campos novos/removidos/alterados
  ↓
Gera relatório com o template pronto para nfePatches.ts
  ↓
Envia e-mail com tabela de campos novos e relatório completo
  ↓
Salva novo snapshot → commit automático
```

---

## Setup (10 minutos)

### 1. Criar repositório privado no GitHub

```bash
# Opção A: Repositório separado (recomendado — fica privado)
gh repo create nfe-schema-watcher --private --clone
cd nfe-schema-watcher

# Copiar os arquivos deste projeto para a pasta
# Depois:
git add .
git commit -m "feat: schema watcher inicial"
git push

# Opção B: Pasta dentro do repositório atual do editor XML
# Crie a pasta schema-watcher/ na raiz do projeto
# O GitHub Actions funciona normalmente em subpastas
```

### 2. Configurar secrets no GitHub

Vá em: `Settings → Secrets and variables → Actions → New repository secret`

| Secret | Valor |
|---|---|
| `EMAIL_TO` | seu@email.com |
| `EMAIL_FROM` | noreply@seudominio.com |
| `SENDGRID_API_KEY` | `SG.xxxxxxxxxx` |

**SendGrid gratuito:** [sendgrid.com](https://sendgrid.com) → criar conta → 100 emails/dia grátis → API Keys → Create API Key

### 3. Instalar dependências

```bash
npm install
```

### 4. Testar localmente antes de subir

```bash
# Roda o watcher e imprime o relatório no terminal (sem enviar e-mail)
npm run watch

# Força envio do e-mail mesmo sem mudança (para testar o e-mail)
EMAIL_TO=seu@email.com \
EMAIL_FROM=noreply@seudominio.com \
SENDGRID_API_KEY=SG.xxxxx \
FORCE_REPORT=true \
npm run watch:force
```

### 5. Ativar o GitHub Actions

O arquivo `.github/workflows/watch-schema.yml` já está configurado para rodar:
- **Todo dia às 07:00 BRT** (cron: `0 10 * * *`)
- **Manualmente** via GitHub → Actions → "Watcher Schema NF-e" → Run workflow

---

## Exemplo de e-mail recebido

**Assunto:** `[NF-e Watcher] 🔴 3 campo(s) NOVO(S) — NT 2025.003 v.1.01 publicada em 15/08/2026`

```
╔══════════════════════════════════════════════════════════════╗
║        WATCHER SCHEMA NF-e — RELATÓRIO DE MUDANÇAS          ║
╚══════════════════════════════════════════════════════════════╝

Data/hora:   15/08/2026 07:00:00
Versão MOC:  NT 2025.003 v.1.01 publicada em 15/08/2026
Total campos: 487

🔔 NOVA VERSÃO DO MOC DETECTADA
   Anterior: NT 2025.002 v.1.35 publicada em 31/03/2026
   Atual:    NT 2025.003 v.1.01 publicada em 15/08/2026

✅ CAMPOS NOVOS (3) — VOCÊ PRECISA ADICIONAR OS LABELS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  TAG:         II2
  Descrição:   Novo campo de importação especial
  Tipo XSD:    TDec_1302
  Obrigatório: Não (minOccurs=0)
  MaxLength:   15

  ── Para adicionar no editor, acrescente em nfePatches.ts: ──
  {
    groupId: 'GRUPO_AQUI',
    afterTag: 'TAG_ANTERIOR',
    field: {
      tag: 'II2',
      label: 'Novo campo de importação especial (NT 2025.003)',
      type: 'text',
      maxLength: 15,
      // Opcional (minOccurs=0)
      nt: '2025.003',
      vigencia: 'AAAA-MM-DD',
    },
  },
```

---

## Arquivos gerados

| Arquivo | O que é |
|---|---|
| `data/snapshot.json` | Snapshot atual do schema (commitado automaticamente) |
| `data/last-report.txt` | Último relatório gerado |

---

## Custo

- **GitHub Actions:** gratuito (repositório privado tem 2.000 min/mês grátis; cada execução usa ~1 min)
- **SendGrid:** gratuito até 100 emails/dia
- **Total:** R$ 0,00/mês
