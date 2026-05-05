#!/usr/bin/env tsx
/**
 * scripts/watch-schema.ts
 *
 * Monitora DUAS fontes oficiais da SEFAZ Federal:
 *
 *  1. ESQUEMAS XML (XSD)
 *     https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=
 *     Detecta novo Pacote de Liberacao (ZIP com XSDs), baixa, extrai campos, faz diff
 *
 *  2. NOTAS TECNICAS (NT)
 *     https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=
 *     Detecta nova NT publicada, inclui link PDF no e-mail
 *
 * Roda diariamente via GitHub Actions (gratis).
 * Envia e-mail via SendGrid quando detecta mudanca.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import * as zlib from 'zlib'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT          = path.resolve(__dirname, '..')
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'snapshot.json')
const REPORT_PATH   = path.join(ROOT, 'data', 'last-report.txt')
const ALERTS_PATH   = path.join(ROOT, 'data', 'alerts.json')

const BASE_URL = 'https://www.nfe.fazenda.gov.br/portal'

const URLS = {
  xsd: `${BASE_URL}/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=`,
  nt:  `${BASE_URL}/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=`,
}

// Decodifica entidades HTML — SEFAZ usa &#xD;&#xA; nos hrefs e &eacute; nos títulos
function decodeEntities(s: string): string {
  return s
    .replace(/&#xD;/gi, '').replace(/&#xA;/gi, '')
    .replace(/&eacute;/gi, 'é').replace(/&Eacute;/g, 'É')
    .replace(/&aacute;/gi, 'á').replace(/&atilde;/gi, 'ã')
    .replace(/&otilde;/gi, 'õ').replace(/&ccedil;/gi, 'ç')
    .replace(/&iacute;/gi, 'í').replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú').replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n)))
}

// Interfaces
interface PublishedItem {
  title: string
  url: string
  date: string
  ntRef?: string
  version?: string
  pacote?: string
}

interface FieldInfo {
  tag: string
  description: string
  required: boolean
  minOccurs: number
  maxOccurs: string
  maxLength?: number
  minLength?: number
  pattern?: string
  enums?: string[]
  type: string
}

interface Snapshot {
  latestXsd: PublishedItem | null
  latestNts: PublishedItem[]
  fieldCount: number
  fields: Record<string, FieldInfo>
  capturedAt: string
}

interface Diff {
  xsdChanged: boolean
  newXsd: PublishedItem | null
  newNts: PublishedItem[]
  addedFields: FieldInfo[]
  removedFields: string[]
  changedFields: Array<{ tag: string; before: Partial<FieldInfo>; after: Partial<FieldInfo> }>
}

// HTTP helpers
function fetchRaw(url: string, timeoutMs = 25000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${BASE_URL}/${res.headers.location}`
        fetchRaw(loc, timeoutMs).then(resolve, reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
    req.on('error', reject)
  })
}

async function fetchText(url: string): Promise<string | null> {
  try {
    console.log(`  GET ${url.slice(0, 100)}`)
    return (await fetchRaw(url)).toString('utf-8')
  } catch (e) {
    console.warn(`  Falhou: ${(e as Error).message}`)
    return null
  }
}

async function fetchBinary(url: string): Promise<Buffer | null> {
  try {
    console.log(`  GET binary ${url.slice(0, 100)}`)
    return await fetchRaw(url)
  } catch (e) {
    console.warn(`  Falhou: ${(e as Error).message}`)
    return null
  }
}

// Parser pagina Esquemas XML
function parseXsdPage(html: string): PublishedItem[] {
  const items: PublishedItem[] = []
  // href real: href="&#xD;&#xA;                exibirArquivo.aspx?conteudo=xxx"
  const linkRe = /href="[^"]*?(exibirArquivo\.aspx\?conteudo=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    const relUrl = decodeEntities(m[1]).trim()
    const inner  = m[2]
    const spanM  = inner.match(/<span[^>]*tituloConteudo[^>]*>([\s\S]*?)<\/span>/i)
    const title  = decodeEntities((spanM ? spanM[1] : inner).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    if (!title.match(/Esquema XML NF-e\/NFC-e|NF-e\/NFC-e.*Pacote/i)) continue
    if (title.match(/evento|NFGas|NFAg|cancelamento|carta.*corre|EPEC|GTIN|Averbaao|Suframa|distribuio/i)) continue
    const dateM  = title.match(/Publicado em\s+([\d/]+)/i)
    if (!dateM) continue
    const ntM    = title.match(/NT\s+([\d.]+)\s+v\.([\d.]+[a-z]?)/i)
    const pacM   = title.match(/Pacote de Libera[^n]+n[o.]+\s*([\w]+)/i)
    items.push({ title, url: `${BASE_URL}/${relUrl}`, date: dateM[1],
                 ntRef: ntM?.[1], version: ntM?.[2], pacote: pacM?.[1] })
  }
  items.sort((a, b) => {
    const ts = (d: string) => { const [dd,mm,yyyy] = d.split('/'); return new Date(`${yyyy}-${mm}-${dd}`).getTime() }
    return ts(b.date) - ts(a.date)
  })
  return items
}

// Parser pagina Notas Tecnicas
function parseNtPage(html: string): PublishedItem[] {
  const items: PublishedItem[] = []
  // href real: href="&#xD;&#xA;                exibirArquivo.aspx?conteudo=xxx"
  const linkRe = /href="[^"]*?(exibirArquivo\.aspx\?conteudo=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    const relUrl = decodeEntities(m[1]).trim()
    const inner  = m[2]
    // Título fica dentro de <span class="tituloConteudo">
    const spanM  = inner.match(/<span[^>]*tituloConteudo[^>]*>([\s\S]*?)<\/span>/i)
    const title  = decodeEntities((spanM ? spanM[1] : inner).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    if (!title.match(/Nota T[eé]cnica/i)) continue
    // Cobre variantes: '2026.004 v.1.00', '2025.002.v.1.20', '2016.003 - v.3.62', 'Conjunta'
    const ntM   = title.match(/Nota T[eé]cnica(?:\s+Conjunta)?\s+([\d.]+?)\.?\s+(?:-\s+)?v\.?\s*([\d.]+[a-z]?)/i)
    const dateM = title.match(/Publicad[ao] em\s+([\d/]+)/i)
    if (!dateM) continue
    items.push({ title, url: `${BASE_URL}/${relUrl}`, date: dateM[1],
                 ntRef: ntM?.[1] ?? 'conjunta', version: ntM?.[2] ?? '1.00' })
  }
  return items
}

// Extrai XSDs do ZIP
function parseZip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset < buffer.length - 4) {
    if (buffer[offset]===0x50 && buffer[offset+1]===0x4B &&
        buffer[offset+2]===0x03 && buffer[offset+3]===0x04) {
      const compression = buffer.readUInt16LE(offset + 8)
      const compSize    = buffer.readUInt32LE(offset + 18)
      const uncompSize  = buffer.readUInt32LE(offset + 22)
      const nameLen     = buffer.readUInt16LE(offset + 26)
      const extraLen    = buffer.readUInt16LE(offset + 28)
      const name        = buffer.slice(offset+30, offset+30+nameLen).toString('utf-8')
      const dataStart   = offset + 30 + nameLen + extraLen
      if (name.match(/\.xsd$/i) && !name.match(/nfce|cte|mdfe|nf3e|nfcom|nfag|nfgas|bpe/i)) {
        try {
          const data = compression === 0
            ? buffer.slice(dataStart, dataStart + uncompSize)
            : zlib.inflateRawSync(buffer.slice(dataStart, dataStart + compSize))
          files.set(name, data)
        } catch { /* pular */ }
      }
      offset = dataStart + compSize
    } else {
      offset++
    }
  }
  return files
}

// Parser XSD
function parseXsd(xsdContent: string): Record<string, FieldInfo> {
  const fields: Record<string, FieldInfo> = {}
  const elRe = /<xs:element\s+name="([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/xs:element>)/gi
  for (const m of xsdContent.matchAll(elRe)) {
    const tag = m[1]; const attrs = m[2]||''; const inner = m[3]||''
    if (!tag || ['NFe','nfeProc','NFref'].includes(tag)) continue
    const minOccurs = parseInt(attrs.match(/minOccurs="(\d+)"/)?.[1] ?? '1')
    const maxOccurs = attrs.match(/maxOccurs="([^"]+)"/)?.[1] ?? '1'
    const typeName  = attrs.match(/type="([^"]+)"/)?.[1] ?? ''
    const doc = inner.match(/<xs:documentation>([\s\S]*?)<\/xs:documentation>/i)?.[1]?.replace(/\s+/g,' ').trim() ?? ''
    const enums = [...inner.matchAll(/<xs:enumeration\s+value="([^"]+)"/gi)].map(e=>e[1])
    const maxLength = inner.match(/<xs:maxLength\s+value="(\d+)"/)?.[1]
      ? parseInt(inner.match(/<xs:maxLength\s+value="(\d+)"/)![1])
      : (() => { const td = typeName.match(/TDec_(\d\d)(\d\d)/); return td ? parseInt(td[1])+parseInt(td[2])+1 : undefined })()
    fields[tag] = {
      tag, description: doc, required: minOccurs > 0, minOccurs, maxOccurs,
      maxLength,
      minLength: inner.match(/<xs:minLength\s+value="(\d+)"/)?.[1] ? parseInt(inner.match(/<xs:minLength\s+value="(\d+)"/)![1]) : undefined,
      pattern: inner.match(/<xs:pattern\s+value="([^"]+)"/)?.[1],
      enums: enums.length > 0 ? enums : undefined,
      type: typeName,
    }
  }
  return fields
}

async function extractFieldsFromZip(zipUrl: string): Promise<Record<string, FieldInfo>> {
  const buf = await fetchBinary(zipUrl)
  if (!buf) return {}
  console.log(`  ZIP: ${(buf.length/1024).toFixed(0)} KB`)
  const xsdFiles = parseZip(buf)
  console.log(`  XSDs: ${[...xsdFiles.keys()].join(', ')}`)
  let all: Record<string, FieldInfo> = {}
  for (const [name, content] of xsdFiles) {
    const parsed = parseXsd(content.toString('utf-8'))
    console.log(`  ${name}: ${Object.keys(parsed).length} elementos`)
    all = { ...all, ...parsed }
  }
  return all
}

// Snapshot
function loadSnapshot(): Snapshot | null {
  try { if (fs.existsSync(SNAPSHOT_PATH)) return JSON.parse(fs.readFileSync(SNAPSHOT_PATH,'utf-8')) } catch {}
  return null
}
// Diff
function diffSnapshots(prev: Snapshot | null, curr: Snapshot): Diff {
  const isFirst = !prev
  const prevNtKeys = new Set((prev?.latestNts ?? []).map(n => `${n.ntRef}v${n.version}`))
  const newNts = curr.latestNts.filter(n => !prevNtKeys.has(`${n.ntRef}v${n.version}`))
  const xsdChanged = !prev?.latestXsd || prev.latestXsd.url !== curr.latestXsd?.url
  if (isFirst) return { xsdChanged: true, newXsd: curr.latestXsd, newNts: curr.latestNts,
                        addedFields: Object.values(curr.fields), removedFields: [], changedFields: [] }
  const addedFields: FieldInfo[] = []
  const removedFields: string[] = []
  const changedFields: Diff['changedFields'] = []
  for (const [tag, f] of Object.entries(curr.fields)) if (!(tag in (prev?.fields??{}))) addedFields.push(f)
  for (const tag of Object.keys(prev?.fields??{})) if (!(tag in curr.fields)) removedFields.push(tag)
  const WATCHED: Array<keyof FieldInfo> = ['required','maxLength','minLength','pattern','enums','maxOccurs']
  for (const [tag, cf] of Object.entries(curr.fields)) {
    const pf = prev?.fields[tag]; if (!pf) continue
    const before: Partial<FieldInfo> = {}; const after: Partial<FieldInfo> = {}
    for (const p of WATCHED) if (JSON.stringify(pf[p]) !== JSON.stringify(cf[p])) { (before as any)[p]=pf[p]; (after as any)[p]=cf[p] }
    if (Object.keys(before).length > 0) changedFields.push({ tag, before, after })
  }
  return { xsdChanged, newXsd: xsdChanged ? curr.latestXsd : null, newNts, addedFields, removedFields, changedFields }
}

// Relatorio texto
function buildReport(diff: Diff, curr: Snapshot, isFirst: boolean): string {
  const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const L: string[] = []
  L.push('=== WATCHER SCHEMA NF-e ===')
  L.push(`Data/hora:    ${ts}`)
  L.push(`Campos total: ${curr.fieldCount}`)
  L.push('')
  L.push('--- ESQUEMAS XML (XSD) ---')
  L.push(`  ${curr.latestXsd?.title ?? 'nao detectado'}`)
  L.push(`  ${curr.latestXsd?.url ?? ''}`)
  if (diff.xsdChanged && !isFirst) L.push('  *** NOVO PACOTE DETECTADO ***')
  L.push('')
  L.push('--- NOTAS TECNICAS ---')
  if (diff.newNts.length > 0 && !isFirst) {
    L.push(`  *** ${diff.newNts.length} NOVA(S) NT(s): ***`)
    diff.newNts.forEach(n => { L.push(`  NT ${n.ntRef} v.${n.version} - ${n.date}`); L.push(`  PDF: ${n.url}`) })
  } else {
    L.push(`  Ultima: ${curr.latestNts[0]?.title ?? 'nao detectada'}`)
  }
  if (diff.addedFields.length > 0 && !isFirst) {
    L.push('')
    L.push(`--- CAMPOS NOVOS NOS XSDs (${diff.addedFields.length}) - ADICIONE OS LABELS ---`)
    diff.addedFields.forEach(f => {
      L.push(`  TAG: ${f.tag}`)
      L.push(`  Desc: ${f.description || '(sem documentacao no XSD)'}`)
      L.push(`  Tipo: ${f.type} | Obrig: ${f.required} | MaxLen: ${f.maxLength??'-'} | Valores: ${f.enums?.join(',')||'-'}`)
      L.push(`  Template nfePatches.ts:`)
      L.push(`    { groupId:'GRUPO', afterTag:'TAG', field: { tag:'${f.tag}', label:'LABEL (NT XXXX)', type:'${f.enums?'select':f.type?.includes('Dec')?'number':'text'}',${f.maxLength?` maxLength:${f.maxLength},`:''}${!f.required?' // opcional':''} nt:'XXXX', vigencia:'AAAA-MM-DD' } }`)
      L.push('')
    })
  }
  if (diff.removedFields.length > 0) L.push(`--- CAMPOS REMOVIDOS (${diff.removedFields.length}): ${diff.removedFields.join(', ')} ---`)
  if (diff.changedFields.length > 0) {
    L.push(`--- CAMPOS ALTERADOS (${diff.changedFields.length}) ---`)
    diff.changedFields.forEach(c => {
      L.push(`  ${c.tag}:`)
      Object.entries(c.before).forEach(([p,bv]) => L.push(`    ${p}: ${JSON.stringify(bv)} -> ${JSON.stringify((c.after as any)[p])}`))
    })
  }
  if (!diff.xsdChanged && diff.newNts.length===0 && !isFirst) L.push('OK - sem mudancas')
  L.push('')
  L.push(`Esquemas XML: ${URLS.xsd}`)
  L.push(`Notas Tecnicas: ${URLS.nt}`)
  return L.join('\n')
}

// HTML email
function buildHtml(diff: Diff, curr: Snapshot, text: string, isFirst: boolean): string {
  const hasNew = (diff.xsdChanged || diff.newNts.length > 0) && !isFirst
  const color = hasNew ? '#dc2626' : '#16a34a'
  const ntRows = diff.newNts.length > 0 && !isFirst
    ? `<h2 style="color:#dc2626">Novas NTs</h2><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#fee2e2"><th style="padding:8px;border:1px solid #fca5a5;text-align:left">NT</th><th style="padding:8px;border:1px solid #fca5a5;text-align:left">Versao</th><th style="padding:8px;border:1px solid #fca5a5;text-align:left">Data</th><th style="padding:8px;border:1px solid #fca5a5;text-align:left">PDF</th></tr></thead><tbody>${diff.newNts.map((n,i)=>`<tr style="background:${i%2===0?'#fff':'#fef2f2'}"><td style="padding:8px;border:1px solid #fca5a5;font-weight:bold">NT ${n.ntRef}</td><td style="padding:8px;border:1px solid #fca5a5">v.${n.version}</td><td style="padding:8px;border:1px solid #fca5a5">${n.date}</td><td style="padding:8px;border:1px solid #fca5a5"><a href="${n.url}">Baixar PDF</a></td></tr>`).join('')}</tbody></table>` : ''
  const fieldRows = diff.addedFields.length > 0 && !isFirst
    ? `<h2 style="color:#16a34a">Campos novos nos XSDs (${diff.addedFields.length})</h2><p style="color:#dc2626;font-weight:bold">Adicione os labels em nfePatches.ts</p><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#dcfce7"><th style="padding:6px;border:1px solid #86efac;text-align:left">TAG</th><th style="padding:6px;border:1px solid #86efac;text-align:left">Descricao (XSD)</th><th style="padding:6px;border:1px solid #86efac;text-align:left">Tipo</th><th style="padding:6px;border:1px solid #86efac;text-align:center">Obrig.</th><th style="padding:6px;border:1px solid #86efac;text-align:center">MaxLen</th><th style="padding:6px;border:1px solid #86efac;text-align:left">Valores</th></tr></thead><tbody>${diff.addedFields.map((f,i)=>`<tr style="background:${i%2===0?'#fff':'#f0fdf4'}"><td style="padding:6px;border:1px solid #86efac;font-family:monospace;font-weight:bold">${f.tag}</td><td style="padding:6px;border:1px solid #86efac">${f.description||'—'}</td><td style="padding:6px;border:1px solid #86efac;font-family:monospace;font-size:11px">${f.type||'inline'}</td><td style="padding:6px;border:1px solid #86efac;text-align:center">${f.required?'Sim':'—'}</td><td style="padding:6px;border:1px solid #86efac;text-align:center">${f.maxLength||'—'}</td><td style="padding:6px;border:1px solid #86efac;font-family:monospace;font-size:11px">${f.enums?.join(', ')||'—'}</td></tr>`).join('')}</tbody></table>` : ''
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;max-width:960px;margin:0 auto;padding:20px;color:#1e293b}.hdr{background:${color};color:white;padding:20px;border-radius:8px;margin-bottom:20px}.meta{background:#f1f5f9;padding:16px;border-radius:8px;margin-bottom:20px;font-size:13px;line-height:1.8}.xsd{background:#fff7ed;border:1px solid #fed7aa;padding:16px;border-radius:8px;margin:16px 0}pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow-x:auto;font-size:11px;line-height:1.6}a{color:#2563eb}</style></head><body><div class="hdr"><h1 style="margin:0">${hasNew?'🔴':'✅'} Watcher Schema NF-e</h1><p style="margin:4px 0 0">${new Date().toLocaleDateString('pt-BR')}</p></div><div class="meta"><b>Pacote XSD atual:</b> ${curr.latestXsd?.title??'nao detectado'}<br><b>Ultima NT vigente:</b> ${curr.latestNts[0]?.title??'nao detectada'}<br><b>Total campos:</b> ${curr.fieldCount}<br><b>NTs novas:</b> ${diff.newNts.length||'—'}<br><b>Campos novos:</b> ${isFirst?'—':(diff.addedFields.length||'—')}</div>${curr.latestXsd?`<div class="xsd"><b>Pacote XSD:</b> ${curr.latestXsd.title}<br><a href="${curr.latestXsd.url}">Baixar ZIP com XSDs</a></div>`:''} ${ntRows} ${fieldRows} <h2>Relatorio completo</h2><pre>${text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre><p style="font-size:11px;color:#94a3b8;margin-top:32px">Esquemas XML: <a href="${URLS.xsd}">${URLS.xsd}</a><br>Notas Tecnicas: <a href="${URLS.nt}">${URLS.nt}</a></p></body></html>`
}

// Email
async function sendEmail(subject: string, text: string, html: string) {
  const key=process.env.SENDGRID_API_KEY, to=process.env.EMAIL_TO, from=process.env.EMAIL_FROM||'noreply@github.com'
  if (!key||!to) { console.log('Email nao configurado'); return }
  const body = JSON.stringify({ personalizations:[{to:[{email:to}]}], from:{email:from,name:'Watcher Schema NF-e'}, subject, content:[{type:'text/plain',value:text},{type:'text/html',value:html}] })
  return new Promise<void>((resolve,reject) => {
    const req = https.request({ hostname:'api.sendgrid.com', path:'/v3/mail/send', method:'POST', headers:{ 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) } }, res => { console.log(`Email enviado: ${res.statusCode}`); resolve() })
    req.on('error',reject); req.write(body); req.end()
  })
}

function setOutput(name: string, value: string) {
  const f = process.env.GITHUB_OUTPUT
  if (f) fs.appendFileSync(f, `${name}=${value}\n`)
}

function saveSnapshot(s: Snapshot) {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true })
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(s, null, 2))
}

// Gera data/alerts.json consumido pelo NotificationPanel.tsx do editor
function saveAlerts(curr: Snapshot, diff: Diff, isFirst: boolean) {
  const nts = curr.latestNts.slice(0, 10).map(nt => ({
    number:      nt.ntRef,
    version:     `v.${nt.version}`,
    description: nt.title.replace(/^Nota T[eé]cnica[^-–]*[-–]\s*/i, '').trim(),
    date:        nt.date,
    url:         nt.url,
    isNew:       !isFirst && diff.newNts.some(n => n.ntRef === nt.ntRef && n.version === nt.version),
  }))
  const alerts = {
    latestSchema: curr.latestXsd ? {
      version:     curr.latestXsd.pacote ?? curr.latestXsd.ntRef ?? '',
      description: curr.latestXsd.title,
      date:        curr.latestXsd.date,
      url:         curr.latestXsd.url,
      isNew:       !isFirst && diff.xsdChanged,
    } : null,
    nts,
    fieldCount:  curr.fieldCount,
    lastUpdate:  new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    generatedAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(ALERTS_PATH), { recursive: true })
  fs.writeFileSync(ALERTS_PATH, JSON.stringify(alerts, null, 2))
  console.log(`alerts.json salvo: ${nts.length} NTs, schema: ${alerts.latestSchema?.version ?? 'nao detectado'}`)
}

// Main
async function main() {
  console.log('Watcher Schema NF-e — ' + new Date().toISOString())
  const previous = loadSnapshot()
  const isFirst  = !previous
  if (previous) console.log(`Snapshot anterior: ${previous.capturedAt}`)

  // Lê HTML de arquivo pré-baixado pelo curl no workflow (lida melhor com cookies ASP.NET)
  // ou faz fetch direto quando rodando localmente
  function readOrFetch(envVar: string, url: string): Promise<string | null> {
    const file = process.env[envVar]
    if (file && fs.existsSync(file)) {
      console.log(`  Lendo de ${file}`)
      return Promise.resolve(fs.readFileSync(file, 'utf-8'))
    }
    return fetchText(url)
  }

  console.log('\nEsquemas XML...')
  const xsdHtml  = await readOrFetch('XSD_HTML_FILE', URLS.xsd)
  const xsdItems = xsdHtml ? parseXsdPage(xsdHtml) : []
  const latestXsd = xsdItems[0] ?? null
  console.log(`Pacotes encontrados: ${xsdItems.length}`)
  if (latestXsd) console.log(`Mais recente: ${latestXsd.title}`)

  console.log('\nNotas Tecnicas...')
  const ntHtml    = await readOrFetch('NT_HTML_FILE', URLS.nt)
  const latestNts = ntHtml ? parseNtPage(ntHtml) : []
  console.log(`NTs vigentes: ${latestNts.length}`)
  if (latestNts[0]) console.log(`Mais recente: ${latestNts[0].title}`)

  // Só considera XSD mudado se realmente encontramos um XSD com URL diferente
  const xsdChanged = !!latestXsd && (previous?.latestXsd?.url !== latestXsd.url)
  let fields: Record<string, FieldInfo> = previous?.fields ?? {}

  if (xsdChanged && latestXsd) {
    console.log('\nNovo XSD detectado — baixando...')
    const extracted = await extractFieldsFromZip(latestXsd.url)
    if (Object.keys(extracted).length > 0) fields = extracted
    else console.warn('Extracao falhou — mantendo campos anteriores')
  } else {
    console.log('\nXSD sem mudanca')
  }

  const current: Snapshot = { latestXsd, latestNts, fieldCount: Object.keys(fields).length, fields, capturedAt: new Date().toISOString() }
  const diff = diffSnapshots(previous, current)
  const hasChanges = diff.xsdChanged || diff.newNts.length > 0

  const textReport = buildReport(diff, current, isFirst)
  const htmlReport = buildHtml(diff, current, textReport, isFirst)

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.writeFileSync(REPORT_PATH, textReport)
  console.log('\n' + textReport)

  saveSnapshot(current)
  saveAlerts(current, diff, isFirst)

  const forceReport = process.env.FORCE_REPORT === 'true'
  if (hasChanges || isFirst || forceReport) {
    const hasNewNt = diff.newNts.length > 0 && !isFirst
    const hasNewF  = diff.addedFields.length > 0 && !isFirst
    const subject = isFirst
      ? `[NF-e Watcher] Snapshot inicial — ${current.fieldCount} campos`
      : hasNewNt && hasNewF
        ? `[NF-e Watcher] NT nova + ${diff.addedFields.length} campo(s) — ${diff.newNts.map(n=>`NT ${n.ntRef} v.${n.version}`).join(', ')}`
        : hasNewNt
          ? `[NF-e Watcher] 🔴 Nova NT — ${diff.newNts.map(n=>`NT ${n.ntRef} v.${n.version}`).join(', ')}`
          : hasNewF
            ? `[NF-e Watcher] ${diff.addedFields.length} campo(s) novo(s) nos XSDs`
            : `[NF-e Watcher] Mudanca no schema`
    await sendEmail(subject, textReport, htmlReport)
  } else {
    console.log('Sem mudancas — email nao enviado')
  }

  setOutput('schema_changed', hasChanges ? 'true' : 'false')
  setOutput('nt_version', latestNts[0]?.ntRef ?? '')
  console.log('\nConcluido!')
}

main().catch(err => { console.error('Erro:', err); process.exit(1) })
