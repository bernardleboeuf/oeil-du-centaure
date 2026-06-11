/* ==================================================================
   L'ŒIL DU CENTAURE — COLLECTEUR
   Tourne automatiquement sur GitHub Actions (minuterie quotidienne).
   Va chercher les 62 flux, normalise, classe par compétence, note
   l'impact, et écrit le résultat dans  ../veille.json  (lu par la page).
   Aucune dépendance externe : parsing maison, fetch natif (Node 20+).
   Tri IA optionnel si la variable ANTHROPIC_API_KEY est fournie.
   ================================================================== */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES = JSON.parse(readFileSync(join(__dir, "sources.json"), "utf8"));

const KW = {
  dpa: ["marché","commande publique","concession","délégation","contrat public","appel d'offres","accord-cadre","ccag","occupation du domaine","référé précontractuel","passation","concessions"],
  urba: ["permis","urbanisme","aménagement","plu","foncier","domanialité","copropriété","habitat indigne","environnement","icpe","installation classée","éolien","photovolta","aménagement"],
  constr: ["construction","désordre","décennale","dommage ouvrage","assurance construction","maître d'œuvre","réception des travaux","garantie décennale"],
  dpriv: ["société","bail commercial","marque","propriété intellectuelle","procédure collective","redressement","liquidation","fonds de commerce","déspécialisation"],
  penal: ["pénal","prise illégale","favoritisme","corruption","détournement","garde à vue","correctionnel","probité"],
  perso: ["fonction publique","agent","discipline","statut","fonctionnaire","révocation","fph","fpt","carrière","disciplinaire"],
  enfance: ["aide sociale","ase","mineur","mna","handicap","apa","rsa","essms","protection de l'enfance","médico-social"],
  etrangers: ["étranger","oqtf","séjour","asile","rétention","éloignement","titre de séjour","reconduite","cnda","visa"],
  dpg: ["acte administratif","référé","responsabilité","police administrative","excès de pouvoir","légalité","retrait","abrogation"]
};

function pick(s, tag){ const m = s.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)<\\/"+tag+">","i")); return m ? m[1].trim() : ""; }
function attr(s, tag, a){ const m = s.match(new RegExp("<"+tag+"[^>]*"+a+"=[\"']([^\"']+)","i")); return m ? m[1] : ""; }
function clean(s){ return (s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ").replace(/&[a-z#0-9]+;/g," ").replace(/\s+/g," ").trim(); }
function normDate(s){ const d = new Date(s); return isNaN(d) ? "" : d.toISOString(); }

function parseFeed(xml, src){
  const items = [];
  const blocks = xml.split(/<item[ >]|<entry[ >]/i).slice(1);
  for (const b of blocks){
    const title = clean(pick(b,"title"));
    if (!title) continue;
    const link = pick(b,"link") || attr(b,"link","href");
    const date = pick(b,"pubDate")||pick(b,"published")||pick(b,"updated")||"";
    const desc = clean(pick(b,"description")||pick(b,"summary")||pick(b,"content"));
    items.push({ titre:title, lien:link, date:normDate(date), source:src.nom, srcType:src.type, resume:desc.slice(0,240) });
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
  if(/référé|annulation|sanction|précise|condition|encadre|resserre/.test(t)) return 2;
  return 1;
}

async function fetchFeed(src){
  try{
    const ctrl = new AbortController();
    const to = setTimeout(()=>ctrl.abort(), 9000);
    const r = await fetch(src.rss, { headers:{ "User-Agent":"OeilDuCentaure/1.0 (+veille juridique Centaure Avocats)" }, signal: ctrl.signal });
    clearTimeout(to);
    if(!r.ok) return [];
    const xml = await r.text();
    return parseFeed(xml, src);
  }catch(e){ return []; }
}

async function classifyAI(items){
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) return null;
  const list = items.slice(0,50).map((it,i)=>`${i}. ${it.titre}`).join("\n");
  const sys = "Tu classes des actualités juridiques pour Centaure Avocats. Pour chaque item: compétence (dpa,urba,constr,dpriv,penal,perso,enfance,etrangers,dpg ou null) et impact (3=fort: loi/décret/revirement, 2=à suivre, 1=info). JSON strict: [{\"i\":0,\"comp\":\"dpa\",\"impact\":3}]. Rien d'autre.";
  try{
    const r = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:3000, system:sys, messages:[{role:"user",content:list}] })
    });
    const data = await r.json();
    const txt = data.content.filter(b=>b.type==="text").map(b=>b.text).join("").replace(/```json|```/g,"").trim();
    return JSON.parse(txt);
  }catch(e){ console.error("IA indisponible, repli mots-clés:", e.message); return null; }
}

async function main(){
  const all = [...SOURCES.TA, ...SOURCES.CAA, ...SOURCES.SUPRA, ...SOURCES.EUROPE, ...SOURCES.NATIONAL];
  console.log(`Collecte de ${all.length} sources…`);
  const results = [];
  const BATCH = 12;
  for(let i=0;i<all.length;i+=BATCH){
    const chunk = await Promise.all(all.slice(i,i+BATCH).map(fetchFeed));
    chunk.forEach(a=>results.push(...a));
    process.stdout.write(`  ${Math.min(i+BATCH,all.length)}/${all.length}\r`);
  }
  console.log(`\nItems bruts: ${results.length}`);

  // dédoublonnage
  const seen = new Set();
  let items = results.filter(it=>{ const k=it.titre.toLowerCase().slice(0,80); if(seen.has(k))return false; seen.add(k); return true; });
  // tri chrono desc
  items.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  items = items.slice(0,150);

  const ai = await classifyAI(items);
  items = items.map((it,idx)=>{
    if(ai){ const tag = ai.find(x=>x.i===idx); return { ...it, comp: tag?.comp || classifyKW(it.titre+" "+it.resume), impact: tag?.impact || impactKW(it.titre) }; }
    return { ...it, comp: classifyKW(it.titre+" "+it.resume), impact: impactKW(it.titre+" "+it.resume) };
  }).filter(it=>it.comp);

  const out = { generatedAt: new Date().toISOString(), sources: all.length, count: items.length, items };
  const dest = join(__dir, "..", "veille.json");
  writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`✓ ${items.length} actualités classées → veille.json`);
}
main();
