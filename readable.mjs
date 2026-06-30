#!/usr/bin/env node
// claude-readable — browse your recent Claude Code sessions and read any one's
// latest response in a clean, frosted-glass reading panel.
//
// Usage:
//   node readable.mjs           -> session list (opens in your browser)
//   node readable.mjs --glass   -> session list in the native glass panel
//   node readable.mjs --print   -> print the most recent response as markdown
//   node readable.mjs --file X  -> open one specific .jsonl transcript
//   node readable.mjs --out P   -> write the HTML to path P and exit (no window)

import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { marked } from 'marked';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const MAX_SESSIONS = 12;

// ---- args ----
const args = process.argv.slice(2);
let fileArg = null, printOnly = false, outArg = null, glass = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--file') fileArg = args[++i];
  else if (a === '--out') outArg = args[++i];
  else if (a === '--print') printOnly = true;
  else if (a === '--glass') glass = true;
}

// ---- gather transcripts ----
function allTranscripts() {
  const out = [];
  let projects;
  try { projects = readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, p.name);
    let files; try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(dir, f);
      try { out.push({ path: full, mtime: statSync(full).mtimeMs, project: p.name, sessionId: f.slice(0, -6) }); }
      catch { /* skip */ }
    }
  }
  return out;
}

// Currently-OPEN Claude Code sessions only (live processes). Claude Code writes
// ~/.claude/sessions/<pid>.json = {pid, sessionId, cwd, ...}; we keep the ones whose
// pid is still alive. Returns [{sessionId, cwd, pid}].
function runningSessions() {
  let files; try { files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
      if (!j.sessionId || !j.pid) continue;
      try { process.kill(j.pid, 0); } catch { continue; }   // dead pid -> not open anymore
      out.push({ sessionId: j.sessionId, cwd: j.cwd || '', pid: j.pid });
    } catch { /* skip */ }
  }
  return out;
}

// Last assistant response (all assistant text since the last human turn), read from
// the tail so big transcripts stay fast. Returns markdown.
function lastResponseFromLines(lines) {
  const isHuman = ev => {
    if (!ev || ev.type !== 'user') return false;
    const c = ev.message?.content;
    if (typeof c === 'string') return c.trim().length > 0;
    if (Array.isArray(c)) return c.some(b => b?.type === 'text' && (b.text || '').trim());
    return false;
  };
  const aText = ev => {
    if (!ev || ev.type !== 'assistant') return '';
    const c = ev.message?.content;
    if (!Array.isArray(c)) return '';
    return c.filter(b => b?.type === 'text').map(b => b.text || '').join('\n\n').trim();
  };
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (isHuman(ev)) break;            // reached the prompt that began this response
    const t = aText(ev);
    if (t) out.unshift(t);
  }
  return out.join('\n\n').trim();
}

// Read one transcript -> { ...t, md, title } or null if it has no assistant text.
function readSession(t) {
  let txt; try { txt = readFileSync(t.path, 'utf8'); } catch { return null; }
  const md = lastResponseFromLines(txt.split('\n').filter(Boolean));
  if (!md) return null;
  const m = [...txt.matchAll(/"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  let title = '';
  if (m.length) { try { title = JSON.parse('"' + m[m.length - 1][1] + '"'); } catch { title = ''; } }
  return { ...t, md, title };
}

function plainPreview(md) {
  return md.replace(/```[\s\S]*?```/g, ' ⟨code⟩ ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>#`~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim().slice(0, 160);
}

function relTime(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function folderLabel(t, cwdById) {
  const cwd = cwdById[t.sessionId];
  if (cwd) return cwd.replace(homedir(), '~');
  return '/' + t.project.replace(/^-/, '').replace(/-/g, '/');   // lossy decode, just a hint
}

// ---- build the session list ----
marked.setOptions({ gfm: true, breaks: false });

let cards;
let single = false;
if (fileArg) {
  single = true;
  const s = readSession({ path: fileArg, mtime: 0, project: basename(fileArg), sessionId: basename(fileArg).replace(/\.jsonl$/, '') });
  if (!s) { console.error('No assistant text in ' + fileArg); process.exit(1); }
  cards = [s];
} else {
  // Only the sessions that are open right now, newest activity first.
  const byId = {};
  for (const t of allTranscripts()) {
    if (!byId[t.sessionId] || t.mtime > byId[t.sessionId].mtime) byId[t.sessionId] = t;
  }
  const seen = new Set();
  cards = [];
  for (const s of runningSessions()) {
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    const t = byId[s.sessionId];
    if (!t) continue;                            // session with no transcript yet
    const rs = readSession(t);
    if (!rs) continue;                           // no assistant response yet
    rs.running = true;
    rs.folder = s.cwd ? s.cwd.replace(homedir(), '~') : folderLabel(t, {});
    cards.push(rs);
  }
  cards.sort((a, b) => b.mtime - a.mtime);
  cards = cards.slice(0, MAX_SESSIONS);
}

if (printOnly) { process.stdout.write((cards[0] && cards[0].md ? cards[0].md : '') + '\n'); process.exit(0); }

// ---- render ----
const data = cards.map(c => ({
  title: c.title || plainPreview(c.md).slice(0, 60) || '(untitled session)',
  folder: c.folder || '',
  time: c.mtime ? relTime(c.mtime) : '',
  running: !!c.running,
  preview: plainPreview(c.md),
  html: marked.parse(c.md),
}));
const html = pageHtml(data, { glass, single });

let outPath;
if (outArg) {
  writeFileSync(outArg, html, 'utf8');
  console.error('Wrote ' + outArg + ' (not opening)');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'claude-readable-'));
outPath = join(dir, 'reading.html');
writeFileSync(outPath, html, 'utf8');

const glassApp = join(homedir(), '.claude-readable', 'GlassReader.app');
const glassBin = join(homedir(), '.claude-readable', 'GlassReader');
if (glass && existsSync(glassApp)) {
  spawn('open', ['-n', '-a', glassApp, '--args', outPath], { detached: true, stdio: 'ignore' }).unref();
} else if (glass && existsSync(glassBin)) {
  spawn(glassBin, [outPath], { detached: true, stdio: 'ignore' }).unref();
} else {
  execFile('open', [outPath], err => { if (err) { console.error('Could not open:', err.message); process.exit(1); } });
}

// ---- HTML template ----
function pageHtml(items, meta) {
  const glassClass = meta.glass ? ' class="glass"' : '';
  // Safe to embed: escape < (no </script> breakout) and JS line separators.
  const dataJson = JSON.stringify(items)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en"${glassClass}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude — sessions</title>
<style>
:root{
  --fs:19px;
  --bg:#faf8f3; --fg:#2b2b29; --muted:#8a857c;
  --code-bg:#f0ede6; --code-fg:#33312c; --rule:#e6e1d8; --link:#9a5b2e; --accent:#b5683a; --card:#fffdf8;
}
html.theme-white{ --bg:#fff; --fg:#222; --muted:#888; --code-bg:#f3f3f3; --code-fg:#222; --rule:#eaeaea; --link:#2257b5; --accent:#2257b5; --card:#fafafa; }
html.theme-sepia{ --bg:#f4ecd8; --fg:#4a3f2e; --muted:#9a8c70; --code-bg:#eadfc4; --code-fg:#4a3f2e; --rule:#ddd0b0; --link:#8a5a1e; --accent:#a06520; --card:#f7f0dd; }
html.theme-dark{ --bg:#1f2023; --fg:#d8d4cc; --muted:#8d897f; --code-bg:#2a2c30; --code-fg:#e2ddd2; --rule:#34363b; --link:#e0a06a; --accent:#e0a06a; --card:#26282c; }
html.glass, html.glass body{ background:transparent !important; }
html.glass{ --bg:transparent; --fg:#f3f0ea; --muted:#c4beb2; --code-bg:rgba(255,255,255,.10); --code-fg:#f3f0ea;
  --rule:rgba(255,255,255,.18); --link:#ffce9b; --accent:#ffce9b; --card:rgba(255,255,255,.06); }
html.glass .bar{ background:rgba(30,30,34,.30); border-bottom-color:rgba(255,255,255,.14); }
html.glass pre{ background:rgba(0,0,0,.22); }
html.glass .content{ text-shadow:0 1px 1px rgba(0,0,0,.18); }

*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);}
body{ color:var(--fg); font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,ui-serif,serif;
  font-size:var(--fs); line-height:1.85; -webkit-font-smoothing:antialiased; transition:background .15s,color .15s; }
.sans{font-family:ui-sans-serif,system-ui,sans-serif;}

/* toolbar */
.bar{position:fixed;top:0;left:0;right:0;display:flex;gap:.4rem;align-items:center;justify-content:center;
  padding:.6rem;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(8px);
  border-bottom:1px solid var(--rule);font-family:ui-sans-serif,system-ui,sans-serif;z-index:10;}
.bar button{font:inherit;font-size:.8rem;color:var(--fg);background:transparent;border:1px solid var(--rule);
  border-radius:7px;padding:.3rem .6rem;cursor:pointer;line-height:1}
.bar button:hover{border-color:var(--accent);color:var(--accent)}
.bar #back{position:absolute;left:.7rem}
.bar #close{position:absolute;right:.7rem;font-size:.95rem;line-height:1;padding:.28rem .55rem}
.bar .sep{width:1px;height:1.1rem;background:var(--rule);margin:0 .25rem}
.bar .dot{width:1.05rem;height:1.05rem;border-radius:50%;border:1px solid var(--rule);cursor:pointer;padding:0}
.dot.paper{background:#faf8f3}.dot.white{background:#fff}.dot.sepia{background:#f4ecd8}.dot.dark{background:#1f2023}

/* list */
.list{max-width:46rem;margin:0 auto;padding:4.6rem 1.4rem 4rem;}
.list h1{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.74rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.06em;color:var(--muted);margin:0 0 1rem .2rem;}
.card{display:block;width:100%;text-align:left;background:var(--card);border:1px solid var(--rule);border-radius:13px;
  padding:.85rem 1.05rem;margin:0 0 .65rem;cursor:pointer;color:var(--fg);transition:border-color .12s,transform .06s;}
.card:hover,.card.sel{border-color:var(--accent);}
.card:active{transform:scale(.992);}
.card .t{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:600;font-size:1rem;line-height:1.3;margin-bottom:.2rem;}
.card .s{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.74rem;color:var(--muted);margin-bottom:.4rem;}
.card .p{font-size:.86rem;color:var(--muted);line-height:1.5;max-height:3em;overflow:hidden;}
.run{color:#54c98a;font-weight:700;}
.empty{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.9rem;color:var(--muted);line-height:1.7;padding:1rem .2rem;}
.empty code{font-family:ui-monospace,Menlo,monospace;font-size:.85em;background:var(--code-bg);padding:.1em .4em;border-radius:5px;}

/* reading view */
.wrap{max-width:46rem;margin:0 auto;padding:4.6rem 1.6rem 7rem;}
.content > *:first-child{margin-top:0}
.content h1,.content h2,.content h3,.content h4{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.3;margin:2.2em 0 .7em;font-weight:650;letter-spacing:-.01em;}
.content h1{font-size:1.5em}.content h2{font-size:1.28em}.content h3{font-size:1.1em}.content h4{font-size:1em}
.content p{margin:0 0 1.15em}
.content ul,.content ol{margin:0 0 1.15em;padding-left:1.5em}
.content li{margin:.35em 0}
.content a{color:var(--link);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--link) 35%,transparent)}
.content a:hover{border-bottom-color:var(--link)}
.content strong{font-weight:680}
.content hr{border:none;border-top:1px solid var(--rule);margin:2.2em 0}
.content blockquote{margin:1.2em 0;padding:.2em 0 .2em 1.1em;border-left:3px solid var(--rule);color:var(--muted)}
.content code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em;background:var(--code-bg);color:var(--code-fg);padding:.12em .38em;border-radius:5px}
.content pre{background:var(--code-bg);border:1px solid var(--rule);border-radius:10px;padding:1em 1.15em;overflow-x:auto;line-height:1.55;margin:0 0 1.3em}
.content pre code{background:none;padding:0;font-size:.84em}
.content table{border-collapse:collapse;width:100%;margin:0 0 1.3em;font-size:.92em;display:block;overflow-x:auto}
.content th,.content td{border:1px solid var(--rule);padding:.5em .7em;text-align:left}
.content th{background:var(--code-bg)}
.content img{max-width:100%}
[hidden]{display:none!important}
</style>
</head>
<body>
<div class="bar">
  <button id="back" hidden>← Sessions</button>
  <button id="dec" title="Smaller">A−</button>
  <button id="inc" title="Larger">A+</button>
  <span class="sep"></span>
  <button class="dot paper"  data-theme=""      title="Paper"></button>
  <button class="dot white"  data-theme="white" title="White"></button>
  <button class="dot sepia"  data-theme="sepia" title="Sepia"></button>
  <button class="dot dark"   data-theme="dark"  title="Soft dark"></button>
  <button id="close" title="Close (Esc)">✕</button>
</div>

<div id="list" class="list"></div>
<div id="detail" class="wrap" hidden><div id="content" class="content"></div></div>

<script>
const DATA = ${dataJson};
const SINGLE = ${meta.single ? 'true' : 'false'};
const root = document.documentElement;
const LS_FS='cr_fs', LS_TH='cr_theme';
function applyFs(px){root.style.setProperty('--fs',px+'px');localStorage.setItem(LS_FS,px);}
function applyTheme(t){root.className=t?('theme-'+t):'';localStorage.setItem(LS_TH,t||'');}
let fs=parseInt(localStorage.getItem(LS_FS)||'19',10); applyFs(fs);
applyTheme(localStorage.getItem(LS_TH)||'');
document.getElementById('inc').onclick=function(){applyFs(fs=Math.min(30,fs+1));};
document.getElementById('dec').onclick=function(){applyFs(fs=Math.max(13,fs-1));};
var dots=document.querySelectorAll('.dot');
for(var i=0;i<dots.length;i++){(function(b){b.onclick=function(){applyTheme(b.dataset.theme);};})(dots[i]);}

function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
var listEl=document.getElementById('list');
var detailEl=document.getElementById('detail');
var contentEl=document.getElementById('content');
var backEl=document.getElementById('back');

if(DATA.length===0){
  listEl.innerHTML='<h1>Open Claude sessions</h1>'
    +'<div class="empty">No Claude session is open right now.<br>Run <code>claude</code> in a terminal, then press the hotkey again.</div>';
}else{
  listEl.innerHTML='<h1>Open Claude sessions</h1>'+DATA.map(function(it,i){
    return '<button class="card" data-i="'+i+'">'
      +'<div class="t">'+(it.running?'<span class="run">● </span>':'')+esc(it.title)+'</div>'
      +'<div class="s">'+esc(it.folder)+(it.time?' · '+esc(it.time):'')+'</div>'
      +'<div class="p">'+esc(it.preview)+'</div>'
    +'</button>';
  }).join('');
}

function openItem(i){
  contentEl.innerHTML=DATA[i].html;
  listEl.hidden=true; detailEl.hidden=false; backEl.hidden=false;
  window.scrollTo(0,0);
}
function showList(){ detailEl.hidden=true; listEl.hidden=false; backEl.hidden=true; window.scrollTo(0,0); }
var cardsEls=listEl.querySelectorAll('.card');
var sel=0;
function setSel(i){
  if(!cardsEls.length) return;
  sel=Math.max(0,Math.min(cardsEls.length-1,i));
  for(var k=0;k<cardsEls.length;k++) cardsEls[k].classList.toggle('sel',k===sel);
  cardsEls[sel].scrollIntoView({block:'nearest'});
}
for(var j=0;j<cardsEls.length;j++){(function(c,idx){
  c.onclick=function(){openItem(idx);};
  c.onmouseenter=function(){setSel(idx);};
})(cardsEls[j],j);}
setSel(0);
backEl.onclick=showList;

function closeWin(){
  try{
    if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.control){
      window.webkit.messageHandlers.control.postMessage('close'); return;
    }
  }catch(e){}
  window.close();
}
document.getElementById('close').onclick=closeWin;

document.addEventListener('keydown',function(e){
  if(e.key==='+'||e.key==='='){ applyFs(fs=Math.min(30,fs+1)); return; }
  if(e.key==='-'||e.key==='_'){ applyFs(fs=Math.max(13,fs-1)); return; }
  if(detailEl.hidden){            // list view: arrow-key navigation
    if(e.key==='ArrowDown'){ setSel(sel+1); e.preventDefault(); }
    else if(e.key==='ArrowUp'){ setSel(sel-1); e.preventDefault(); }
    else if(e.key==='Enter'||e.key==='ArrowRight'){ openItem(sel); e.preventDefault(); }
  } else {                        // reading view
    if(e.key==='Backspace'||e.key==='ArrowLeft'){ showList(); e.preventDefault(); }
  }
});

if(SINGLE && DATA.length===1) openItem(0);
</script>
</body>
</html>`;
}
