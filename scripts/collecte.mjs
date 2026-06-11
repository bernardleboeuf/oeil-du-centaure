import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES = JSON.parse(readFileSync(join(__dir, "sources.json"), "utf8"));

const KW = {
  dpa: ["marché","commande publique","concession","délégation","contrat public","appel d'offres","accord-cadre","ccag","occupation du domaine","référé précontractuel","passation","concessions","candidat"],
  urba: ["permis","urbanisme","aménagement","plu","foncier","domanialité","copropriété","habitat indigne","environnement","icpe","installation classée","éolien","photovolta","construire","logement"],
  constr: ["construction","désordre","décennale","dommage ouvrage","assurance construction","maître d'œuvre","réception des travaux","garantie décennale","malfaçon"],
  dpriv: ["société","bail commercial","marque","propriété intellectuelle","procédure collective","redressement","liquidation","fonds de commerce","déspécialisation"],
  penal: ["pénal","prise illégale","favoritisme","corruption","détournement","garde à vue","correctionnel","probité","escroquerie"],
  perso: ["fonction publique","agent","discipline","statut","fonctionnaire","révocation","fph","fpt","carrière","disciplinaire","traitement"],
  enfance: ["aide sociale","ase","mineur","mna","handicap","apa","rsa","essms","protection de l'enfance","médico-social"],
  etrangers: ["étranger","oqtf","séjour","asile","rétention","éloignement","titre de séjour","reconduite","cnda","visa","ressortissant"],
  dpg: ["acte administratif","référé","responsabilité","police administrative","excès de pouvoir","légalité","retrait","abrogation","arrêté"]
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
    const link = pick(b,"link") || attr(b,"link","href");
    const date = pick(b,"pubDate")||pick(b,"published")||pick(b,"updated")||"";
    const desc = clean(pick(b,"description")||pick(b,"summary")||pick(b,"content"));
    items.push({ titre:title, lien:link, date:normDate(date), source:srcNom, srcType, resume:desc.slice(0,240) });
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
    const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0 (OeilDuCentaure; veille juridique)", "Accept":"application/rss+xml, application/xml, text/xml, */*" }, signal: ctrl.signal });
    clearTimeout(to);
    if(!r.ok) return { ok:false, reason:"HTTP "+r.status };
    const xml = await r.text();
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
  const sys = "Tu classes des actualités juridiques pour Centaure Avocats. Pour chaque item: compétence (dpa,urba,constr,dpriv,penal,perso,enfance,etrangers,dpg ou null) et impact (3=fort: loi/décret/revirement, 2=à suivre, 1=info). JSON strict: [{\"i\":0,\"comp\":\"dpa\",\"impact\":3}]. Rien d'autre.";
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
  items.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  items = items.slice(0,150);

  const ai = await classifyAI(items);
  items = items.map((it,idx)=>{
    if(ai){ const tag=ai.find(x=>x.i===idx); return {...it, comp: tag?.comp||classifyKW(it.titre+" "+it.resume), impact: tag?.impact||impactKW(it.titre)}; }
    return {...it, comp: classifyKW(it.titre+" "+it.resume), impact: impactKW(it.titre+" "+it.resume)};
  }).filter(it=>it.comp);

  const out = { generatedAt:new Date().toISOString(), juridictionsOk:ok.length, count:items.length, items };
  writeFileSync(join(__dir,"..","veille.json"), JSON.stringify(out,null,2));
  console.log("✓ "+items.length+" actualités classées → veille.json");
}
main();
