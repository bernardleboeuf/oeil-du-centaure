import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES = JSON.parse(readFileSync(join(__dir, "sources.json"), "utf8"));

const KW = {
  imm: ["bail","copropriété","domanialité","habitat indigne","urbanisme","permis","foncier","plu","logement","recouvrement locatif","aménagement","construire","lotissement","zac","syndic","asl"],
  cac: ["marché public","commande publique","ccag","concession","délégation","dsp","achat public","appel d'offres","accord-cadre","subvention","construction","décennale","dommage ouvrage","assurance","chantier","maître d'œuvre","réception","occupation du domaine","référé précontractuel"],
  env: ["environnement","icpe","installation classée","police de l'environnement","transition écologique","déchets","eau","énergie","éolien","photovolta","biodiversité","pollution","climat"],
  lib: ["contentieux","pénal","étranger","oqtf","asile","séjour","rétention","éloignement","rgpd","données personnelles","surveillance","probité","favoritisme","prise illégale","corruption","acte administratif","référé","excès de pouvoir","liberté","police administrative","retrait","abrogation","lanceur d'alerte"],
  pia: ["société","contrat","marque","propriété intellectuelle","brevet","droit d'auteur","dirigeant","bail commercial","procédure collective","redressement","liquidation","fonds de commerce","déspécialisation","cession"],
  enf: ["mineur","mna","enfance","aide sociale","apa","rsa","handicap","essms","personne âgée","protection de l'enfance","médico-social","ase","vulnérable","audition de l'enfant","allocation"],
  rhs: ["fonction publique","agent","discipline","statut","fonctionnaire","cse","santé au travail","protection fonctionnelle","licenciement","carrière","disciplinaire","fph","fpt","accord collectif","syndical","révocation","enquête administrative","dialogue social"]
};

function pick(s, tag){ const m = s.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)<\\/"+tag+">","i")); return m ? m[1].trim() : ""; }
function attr(s, tag, a){ const m = s.match(new RegExp("<"+tag+"[^>]*"+a+"=[\"']([^\"']+)","i")); return m ? m[1] : ""; }
function clean(s){ return (s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ").replace(/&[a-z#0-9]+;/g," ").replace(/\s+/g," ").trim(); }
function normDate(s){ const d = new Date(s); return isNaN(d) ? "" : d.toISOString(); }

function parseFeed(xml, srcNom, srcType){
  const items = [];
  const blocks = xml.split(/<item[ >]|<entry[ >]/i).slice(1);
  for (const b of blocks){
    const title = clean(pick(b,"title"));
    if (!title) continue;
    let link = attr(b,"link","href") || pick(b,"link") || pick(b,"guid") || pick(b,"id") || "";
    link = link.trim();
    if(link && !/^https?:/i.test(link)) link = "";  // ignorer les liens non-http
    const date = pick(b,"pubDate")||pick(b,"published")||pick(b,"updated")||"";
    const desc = clean(pick(b,"description")||pick(b,"summary")||pick(b,"content"));
    items.push({ titre:title, lien:link, date:normDate(date)||new Date().toISOString(), source:srcNom, srcType, resume:desc.slice(0,240) });
  }
  return items;
}
function classifyKW(text){
  const t = text.toLowerCase(); let best=null, bs=0;
  for (const [c,w] of Object.entries(KW)){ const s=w.reduce((a,k)=>a+(t.includes(k)?1:0),0); if(s>bs){bs=s;best=c;} }
  return bs>0?best:null;
}
function impactKW(text){
  const t=text.toLowerCase();
  if(/décret|loi |ordonnance|seuil|réforme|revirement|grande chambre|assemblée|seuils/.test(t)) return 3;
  if(/référé|annulation|sanction|précise|condition|encadre|resserre|suspen/.test(t)) return 2;
  return 1;
}

async function tryUrl(url){
  try{
    const ctrl = new AbortController();
    const to = setTimeout(()=>ctrl.abort(), 20000);
    const r = await fetch(url, { headers:{
      "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept":"application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
      "Accept-Language":"fr-FR,fr;q=0.9",
      "Accept-Encoding":"identity"
    }, signal: ctrl.signal });
    clearTimeout(to);
    if(!r.ok) return { ok:false, reason:"HTTP "+r.status };
    // gérer l'encodage : certains flux sont en ISO-8859-1, pas UTF-8
    const buf = Buffer.from(await r.arrayBuffer());
    let enc = "utf-8";
    const head = buf.slice(0, 200).toString("latin1").toLowerCase();
    if(head.includes("iso-8859-1") || head.includes("windows-1252") || head.includes("iso-8859-15")) enc = "latin1";
    let xml = new TextDecoder(enc).decode(buf);
    if(!/<item[ >]|<entry[ >]/i.test(xml)) return { ok:false, reason:"pas un flux" };
    return { ok:true, xml };
  }catch(e){ return { ok:false, reason: e.name==="AbortError"?"timeout":"injoignable" }; }
}

// pour une source : essaie plusieurs variantes d'URL, garde la 1re qui répond
async function fetchSource(src){
  let candidates;
  if(src.direct){
    candidates = src.direct;                          // URLs vérifiées (CE, CJUE, Légifrance…)
  } else {
    const paths = [
      "/flux-rss/dernieres-decisions",      // TA standard (Grenoble…)
      "/rss/dernieres-decisions",           // TA variante (Paris…)
      "/flux-rss/decisions-de-justice",     // CAA (Marseille…)
      "/rss/decisions-de-justice",
      "/flux-rss/actualites",
      "/rss/actualites-rss"                 // Conseil d'État
    ];
    candidates = paths.map(p=>src.base+p);            // TA/CAA/CNDA/Cassation : variantes auto
  }
  let lastReason = "aucune variante ne répond";
  for(const url of candidates){
    const r = await tryUrl(url);
    if(r.ok){
      const items = parseFeed(r.xml, src.nom, src.type);
      if(items.length) return { ok:true, url, items };
      lastReason = "0 item";
    } else { lastReason = r.reason; }
  }
  return { ok:false, reason:lastReason };
}

async function classifyAI(items){
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) return null;
  const list = items.slice(0,60).map((it,i)=>`${i}. ${it.titre}`).join("\n");
  const sys = "Tu classes des actualités juridiques pour Centaure Avocats. Pour chaque item: thème (imm, cac, env, lib, pia, enf, rhs ou null) et impact (3=fort: loi/décret/revirement, 2=à suivre, 1=info). JSON strict: [{\"i\":0,\"comp\":\"cac\",\"impact\":3}]. Rien d'autre.";
  try{
    const r = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:4000, system:sys, messages:[{role:"user",content:list}] })});
    const data = await r.json();
    const txt = data.content.filter(b=>b.type==="text").map(b=>b.text).join("").replace(/```json|```/g,"").trim();
    return JSON.parse(txt);
  }catch(e){ console.error("IA indisponible, repli mots-clés:", e.message); return null; }
}

async function main(){
  const all = [...SOURCES.TA, ...SOURCES.CAA, ...SOURCES.SUPRA, ...(SOURCES.EUROPE||[]), ...(SOURCES.NATIONAL||[])];
  console.log("=================================================");
  console.log("COLLECTE — "+all.length+" juridictions (variantes d'URL auto)");
  console.log("=================================================\n");

  const results = [], ok = [], ko = [];
  const BATCH = 8;
  for(let i=0;i<all.length;i+=BATCH){
    const chunk = await Promise.all(all.slice(i,i+BATCH).map(async src=>({src, res: await fetchSource(src)})));
    for(const {src,res} of chunk){
      if(res.ok){ ok.push({nom:src.nom, n:res.items.length, url:res.url}); results.push(...res.items); }
      else ko.push({nom:src.nom, reason:res.reason});
    }
  }

  console.log("----- ✓ RÉPONDENT ("+ok.length+") -----");
  ok.sort((a,b)=>b.n-a.n).forEach(s=>console.log("  ✓ "+String(s.n).padStart(2)+" items · "+s.nom));
  console.log("\n----- ✗ MUETS ("+ko.length+") -----");
  ko.forEach(s=>console.log("  ✗ "+s.reason.padEnd(24)+"· "+s.nom));
  console.log("\nBILAN : "+ok.length+"/"+all.length+" juridictions · "+results.length+" items bruts\n");

  const seen = new Set();
  let items = results.filter(it=>{ const k=it.titre.toLowerCase().slice(0,80); if(seen.has(k))return false; seen.add(k); return true; });
  // Tri par fraîcheur (plus récent d'abord) — la fraîcheur reste la priorité d'affichage
  items.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  // diversité : max 6 items par source (évite qu'un TA noie tout)
  const perSrc={}; items = items.filter(it=>{ const s=it.source; perSrc[s]=(perSrc[s]||0)+1; return perSrc[s]<=6; });

  const ai = await classifyAI(items);
  // classement par défaut selon le type de source (si les mots-clés ne suffisent pas)
  function defaultTheme(it){
    const t=it.srcType||"";
    if(t==="DAJ") return "cac";
    if(t==="BO") return "imm";
    if(t==="DG"){ const n=(it.source||"").toLowerCase();
      if(n.includes("environnement")||n.includes("énergie")) return "env";
      if(n.includes("emploi")||n.includes("social")) return "rhs";
      if(n.includes("santé")) return "enf";
      if(n.includes("marché")||n.includes("concurrence")) return "cac";
      return "lib"; }
    if(t==="AAI"){ const n=(it.source||"").toLowerCase();
      if(n.includes("cnil")||n.includes("données")) return "lib";
      if(n.includes("concurrence")||n.includes("amf")) return "pia";
      if(n.includes("has")||n.includes("santé")) return "enf";
      if(n.includes("transport")) return "cac";
      return "lib"; }
    if(t==="TA"||t==="CAA"||t==="CE"||t==="CNDA") return "lib";   // décisions admin → Libertés & procédures par défaut
    if(t==="AN"||t==="SENAT"||t==="VP"||t==="CC") return "lib";    // textes parlementaires
    if(t==="CCOMPTES") return "cac";
    if(t==="MIN") return "lib";
    return "lib";
  }
  items = items.map((it,idx)=>{
    let comp, impact;
    if(ai){ const tag=ai.find(x=>x.i===idx); comp=tag?.comp||classifyKW(it.titre+" "+it.resume); impact=tag?.impact||impactKW(it.titre); }
    else { comp=classifyKW(it.titre+" "+it.resume); impact=impactKW(it.titre+" "+it.resume); }
    if(!comp) comp = defaultTheme(it);   // au lieu de jeter, ranger par défaut selon la source
    return {...it, comp, impact};
  });
  // ===== ÉQUILIBRAGE HEBDO : un volume conforme presse, JAMAIS de rubrique vide =====
  // Pour chaque thème : on prend les plus FRAIS d'abord, et on COMPLÈTE avec des plus anciens
  // jusqu'à atteindre un minimum, sans dépasser un maximum.
  const MIN_PAR_THEME = 4;   // jamais moins de 4 articles par thème affiché (évite le vide)
  const MAX_PAR_THEME = 10;  // jamais plus de 10 (volume presse)
  const THEMES = ["imm","cac","env","lib","pia","enf","rhs"];
  const parTheme = {};
  THEMES.forEach(t=>parTheme[t]=[]);
  // répartir tous les items dans leur thème (déjà triés par fraîcheur)
  items.forEach(it=>{ if(parTheme[it.comp]) parTheme[it.comp].push(it); });
  // pour chaque thème : prendre jusqu'à MAX, en privilégiant frais + forts impacts
  let final = [];
  THEMES.forEach(t=>{
    let arr = parTheme[t];
    // tri : forts impacts ET récents en tête, mais on garde les anciens pour compléter
    arr.sort((a,b)=> b.impact-a.impact || (b.date||"").localeCompare(a.date||""));
    // on prend au moins MIN (même si vieux), au plus MAX
    final = final.concat(arr.slice(0, MAX_PAR_THEME));
  });
  items = final;

  const out = { generatedAt:new Date().toISOString(), juridictionsOk:ok.length, count:items.length, items };
  writeFileSync(join(__dir,"..","veille.json"), JSON.stringify(out,null,2));
  console.log("✓ "+items.length+" actualités classées → veille.json");
}
main();
