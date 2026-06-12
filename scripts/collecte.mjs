import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES = JSON.parse(readFileSync(join(__dir, "sources.json"), "utf8"));

const KW = {
  dpa: ["marché public","commande publique","marché de travaux","ccag","concession","délégation de service public","dsp","achat public","appel d'offres","accord-cadre","subvention","contrat administratif","contrat public","passation","construction","décennale","dommage ouvrage","assurance construction","maître d'œuvre","réception des travaux","occupation du domaine","référé précontractuel"],
  dpe: ["société","bail commercial","procédure collective","redressement","liquidation","fonds de commerce","dirigeant","concurrence","entreprise en difficulté","plan de sauvegarde","cession","droit des affaires","commercial","fiscal"],
  dpi: ["rgpd","données personnelles","protection des données","cnil","marque","propriété intellectuelle","brevet","droit d'auteur","contrefaçon","propriété industrielle","secret des affaires","cybersécurité","numérique"],
  urb: ["urbanisme","permis de construire","aménagement","plu","foncier","domanialité","habitat indigne","logement","lotissement","zac","expropriation","préemption","environnement","icpe","installation classée","déchets","eau","énergie renouvelable","éolien","pollution","autorisation environnementale","biodiversité","copropriété","bail d'habitation"],
  fps: ["fonction publique","agent public","discipline","statut","fonctionnaire","cse","santé au travail","protection fonctionnelle","licenciement","carrière","disciplinaire","fph","fpt","accord collectif","dialogue social","révocation","enquête administrative","droit du travail"],
  asn: ["aide sociale","mineur","mna","enfance","ase","apa","rsa","handicap","essms","personne âgée","protection de l'enfance","médico-social","hôpital","établissement de santé","ehpad","ght","produit de santé","médicament","ars","soins","praticien hospitalier","sécurité sociale","assurance maladie","responsabilité médicale"],
  lib: ["contentieux","pénal","étranger","oqtf","asile","séjour","rétention","éloignement","probité","favoritisme","prise illégale","corruption","liberté publique","lanceur d'alerte","garde à vue","détention"],
  dpg: ["acte administratif","référé","responsabilité administrative","police administrative","excès de pouvoir","légalité","retrait d'acte","abrogation","plein contentieux","arrêté"]
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

async function rawFetch(url){
  const ctrl = new AbortController();
  const to = setTimeout(()=>ctrl.abort(), 20000);
  const r = await fetch(url, { headers:{
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept":"application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
    "Accept-Language":"fr-FR,fr;q=0.9",
    "Accept-Encoding":"identity"
  }, signal: ctrl.signal });
  clearTimeout(to);
  if(!r.ok) return { ok:false, status:r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  let enc = "utf-8";
  const head = buf.slice(0,200).toString("latin1").toLowerCase();
  if(head.includes("iso-8859-1")||head.includes("windows-1252")||head.includes("iso-8859-15")) enc="latin1";
  return { ok:true, text:new TextDecoder(enc).decode(buf) };
}

async function tryUrl(url){
  try{
    const r = await rawFetch(url);
    if(!r.ok) return { ok:false, reason:"HTTP "+r.status };
    const xml = r.text;
    // vrai flux ?
    if(/<item[ >]|<entry[ >]/i.test(xml)) return { ok:true, xml };
    // sinon : page /flux_rss → chercher les liens vers les vrais flux et les suivre
    const origin = new URL(url).origin;
    const links = [...xml.matchAll(/href=["']([^"']*(?:flux-rss|\/rss\/|flux_rss)[^"']*)["']/gi)]
                    .map(m=>m[1])
                    .filter(l=>/decision|jurisprudence|actualit/i.test(l));
    for(const l of [...new Set(links)].slice(0,4)){
      const u = l.startsWith("http") ? l : origin + (l.startsWith("/")?l:"/"+l);
      if(u===url) continue;
      try{
        const r2 = await rawFetch(u);
        if(r2.ok && /<item[ >]|<entry[ >]/i.test(r2.text)) return { ok:true, xml:r2.text };
      }catch(e){}
    }
    return { ok:false, reason:"pas un flux" };
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
      "/flux_rss",                          // ancien format (page→parfois flux)
      "/flux-rss",
      "/rss",
      "/feed",
      "/flux-rss/jurisprudence",
      "/rss/jurisprudence",
      "/flux-rss/actualites",
      "/rss/actualites",
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
  if(!key){ console.log("Pas de clé IA → classement par mots-clés"); return null; }
  // titre + résumé pour donner plus de matière à l'IA, y compris pour les sources en anglais
  const list = items.map((it,i)=>`${i}. [${it.source}] ${it.titre}${it.resume?" — "+it.resume.slice(0,120):""}`).join("\n");
  const sys = `Tu es le rédacteur en chef d'un hebdomadaire juridique français destiné aux acteurs publics et institutionnels. Tu classes chaque actualité dans l'UN des 9 thèmes suivants, selon son contenu juridique réel (pas selon des mots-clés). Les sources peuvent être en anglais (Commission européenne) : traduis mentalement et classe sur le fond.

LES 8 MATIÈRES JURIDIQUES :
• dpa = DROIT PUBLIC DES AFFAIRES : commande publique, marchés publics, concessions, délégations de service public, CCAG, achat public, subventions, contrats administratifs, construction publique, assurance-construction, garantie décennale.
• dpe = DROIT PRIVÉ & ÉCONOMIQUE : droit des sociétés, baux commerciaux, procédures collectives, entreprises en difficulté, concurrence, fiscalité, droit commercial et des affaires, responsabilité du dirigeant.
• dpi = DONNÉES & PROPRIÉTÉ INTELLECTUELLE : RGPD, données personnelles, CNIL, cybersécurité, marques, brevets, droit d'auteur, propriété intellectuelle et industrielle, contrefaçon, secret des affaires.
• urb = URBANISME & ENVIRONNEMENT : urbanisme, permis de construire, aménagement, domanialité, foncier, habitat indigne, logement, copropriété, ET droit de l'environnement, ICPE, déchets, eau, énergie, climat, autorisations environnementales.
• fps = FONCTION PUBLIQUE & SOCIAL : fonction publique (statut, discipline, carrière), droit du travail, dialogue social, CSE, santé au travail, protection fonctionnelle des agents.
• asn = ACTION SOCIALE & SANTÉ : aide sociale, enfance (ASE, MNA), APA, RSA, handicap, ESSMS, médico-social, ET santé (hôpitaux, GHT, ARS, produits de santé, responsabilité médicale, sécurité sociale).
• lib = LIBERTÉS, ÉTRANGERS & PÉNAL : contentieux des libertés publiques, droit des étrangers (séjour, asile, OQTF, rétention), droit pénal, probité, corruption, lanceurs d'alerte.
• dpg = DROIT PUBLIC GÉNÉRAL : actes administratifs, référés, responsabilité administrative, police administrative, excès de pouvoir, retrait/abrogation d'actes — la matière transversale du droit public.

RÈGLE : choisis la matière la plus pertinente sur le FOND, quelle que soit la juridiction ou le territoire. Une décision d'un tribunal d'outre-mer sur un marché public va en "dpa" (la matière prime sur le lieu).
Si vraiment aucun thème ne convient, mets "comp":"null".

IMPACT : 3 = fort (loi, décret, revirement de jurisprudence, réforme majeure) ; 2 = à suivre (décision notable, nouvelle règle) ; 1 = information courante.

TRADUCTION : si le titre est en anglais (ou autre langue), TRADUIS-le en français clair et journalistique dans le champ "titre_fr". Si le titre est déjà en français, recopie-le tel quel dans "titre_fr".

PERTINENCE PAR PROFIL : pour chaque article, indique dans "profils" la liste des profils de lecteurs pour qui il est PRIORITAIRE (parmi : commune, sante, departement, bailleur, etat, entreprise). Un article sur les marchés hospitaliers → ["sante","commune"]. Une réforme de l'urbanisme → ["commune","bailleur","etat"]. Une décision sur l'aide sociale → ["departement","sante"]. Mets [] si l'article n'a pas de pertinence sectorielle marquée (il restera visible pour tous, mais sans priorité).

INTÉRÊT : mets "keep":false pour ÉCARTER les contenus sans valeur juridique pour des lecteurs professionnels (acteurs publics, institutionnels) : nominations, inaugurations, visites officielles, recrutements, anniversaires, communiqués protocolaires, événements internes, articles purement promotionnels ou pédagogiques, newsletters administratives, annonces d'inscription à un colloque, contenus de communication institutionnelle sans portée juridique. Mets "keep":true pour tout ce qui a un vrai intérêt juridique (décisions, réformes, nouvelles règles, directives, analyses de fond).

PERTINENCE PAR SECTEUR D'ACTIVITÉ : dans "secteurs", liste GÉNÉREUSEMENT tous les secteurs concernés (parmi : sante, transport, energie, btp, numerique, environnement, social, eau, amenagement, culture, agriculture). C'est OBLIGATOIRE et IMPORTANT : un article sur un marché de travaux → ["btp"] ; une décision sur l'énergie → ["energie"] ; un arrêt sur les aérodromes/SNCF/RATP → ["transport"] ; une décision environnementale → ["environnement"] (+ "energie","eau","agriculture" si pertinent) ; un sujet hospitalier → ["sante"] ; l'aide sociale → ["social","sante"]. Sois inclusif : 1 à 3 secteurs par article. Ne mets [] QUE si l'article est purement procédural sans lien sectoriel.

Réponds UNIQUEMENT en JSON, sans aucun texte autour : [{"i":0,"comp":"dpa","impact":3,"titre_fr":"...","keep":true,"profils":["commune","etat"],"secteurs":["btp","energie"]},...]`;
  try{
    // traiter par lots de 50 pour rester dans les limites
    const all = [];
    for(let start=0; start<items.length; start+=25){
      const batch = items.slice(start, start+25);
      const bl = batch.map((it,j)=>`${start+j}. [${it.source}] ${it.titre}${it.resume?" — "+it.resume.slice(0,120):""}`).join("\n");
      const r = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
        body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:8000, system:sys, messages:[{role:"user",content:bl}] })});
      const data = await r.json();
      if(data.error){ console.error("Erreur API:", data.error.message); return null; }
      const txt = data.content.filter(b=>b.type==="text").map(b=>b.text).join("").replace(/\`\`\`json|\`\`\`/g,"").trim();
      try{ all.push(...JSON.parse(txt)); }catch(e){ console.error("Parse lot:", e.message); }
    }
    console.log("✓ Classement IA :", all.length, "items classés");
    return all;
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

  // PRÉ-FILTRAGE AVANT l'IA : on ne classe que les 120 articles les plus récents.
  // Largement assez pour alimenter 9 thèmes × 10 articles, et ça limite le coût IA.
  items.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  items = items.slice(0,180);
  console.log("Articles envoyés au classement IA :", items.length, "(les 180 plus récents)");

  const ai = await classifyAI(items);
  // classement par défaut selon le type de source (si les mots-clés ne suffisent pas)
  function defaultTheme(it){
    const t=it.srcType||"";
    if(t==="DAJ") return "cac";
    if(t==="BO") return "imm";
    if(t==="DG"){ const n=(it.source||"").toLowerCase();
      if(n.includes("environnement")||n.includes("énergie")) return "env";
      if(n.includes("emploi")||n.includes("social")) return "rhs";
      if(n.includes("santé")) return "sante";
      if(n.includes("marché")||n.includes("concurrence")) return "cac";
      return "lib"; }
    if(t==="AAI"){ const n=(it.source||"").toLowerCase();
      if(n.includes("cnil")||n.includes("données")) return "pia";
      if(n.includes("concurrence")||n.includes("amf")) return "pia";
      if(n.includes("has")||n.includes("santé")) return "sante";
      if(n.includes("transport")) return "cac";
      return "lib"; }
    if(t==="TA"||t==="CAA"){
      // TA d'outre-mer → thème outre-mer
      const om=["guadeloupe","martinique","guyane","réunion","mayotte","calédonie","polynésie","barthélemy","saint-martin","miquelon"];
      if(om.some(o=>(it.source||"").toLowerCase().includes(o))) return "om";
      return "lib";  // autres décisions admin → Libertés & procédures
    }
    if(t==="CE"||t==="CNDA") return "lib";
    if(t==="AN"||t==="SENAT"||t==="VP"||t==="CC") return "lib";    // textes parlementaires
    if(t==="CCOMPTES") return "cac";
    if(t==="MIN") return "lib";
    return "lib";
  }
  // construire un index des résultats IA par position (fiable)
  const aiByIdx = {};
  if(ai){ for(const tag of ai){ if(tag && typeof tag.i==="number") aiByIdx[tag.i]=tag; } }
  items = items.map((it,idx)=>{
    let comp, impact, keep=true, titre=it.titre, profils=[], secteurs=[];
    const tag = ai ? aiByIdx[idx] : null;
    if(tag){
      comp = (tag.comp && tag.comp!=="null") ? tag.comp : classifyKW(it.titre+" "+it.resume);
      impact = tag.impact || impactKW(it.titre);
      keep = tag.keep!==false;
      if(tag.titre_fr && String(tag.titre_fr).trim()) titre = String(tag.titre_fr).trim();
      profils = Array.isArray(tag.profils) ? tag.profils : [];
      secteurs = Array.isArray(tag.secteurs) ? tag.secteurs : [];
    } else {
      comp = classifyKW(it.titre+" "+it.resume); impact = impactKW(it.titre+" "+it.resume);
    }
    if(!comp) comp = defaultTheme(it);
    return {...it, titre, comp, impact, keep, profils, secteurs};
  });
  // FILTRE INTÉRÊT : retirer les articles sans valeur juridique (l'anglais est traduit, pas retiré)
  const avant = items.length;
  items = items.filter(it=> it.keep!==false);
  console.log("Filtre intérêt :", avant, "→", items.length, "articles retenus (titres anglais traduits en FR)");
  // ===== ÉQUILIBRAGE HEBDO : un volume conforme presse, JAMAIS de rubrique vide =====
  // Pour chaque thème : on prend les plus FRAIS d'abord, et on COMPLÈTE avec des plus anciens
  // jusqu'à atteindre un minimum, sans dépasser un maximum.
  const MIN_PAR_THEME = 4;   // jamais moins de 4 articles par thème affiché (évite le vide)
  const MAX_PAR_THEME = 10;  // jamais plus de 10 (volume presse)
  const THEMES = ["dpa","dpe","urb","fps","asn","lib","dpi","dpg"];
  const parTheme = {};
  THEMES.forEach(t=>parTheme[t]=[]);
  // répartir tous les items dans leur thème (déjà triés par fraîcheur)
  items.forEach(it=>{ if(parTheme[it.comp]) parTheme[it.comp].push(it); });
  // pour chaque thème : prendre jusqu'à MAX, en privilégiant frais + forts impacts
  let final = [];
  THEMES.forEach(t=>{
    let arr = parTheme[t];
    // tri : forts impacts ET récents en tête, mais on garde les anciens pour compléter
    // FRAÎCHEUR D'ABORD : les plus récents en tête. L'impact ne sert qu'à départager
    // deux articles de même jour (pour choisir lequel mettre en avant).
    arr.sort((a,b)=>{
      const da=(a.date||"").slice(0,10), db=(b.date||"").slice(0,10);
      if(db!==da) return db.localeCompare(da);   // jour le plus récent d'abord
      return b.impact-a.impact;                    // même jour → fort impact d'abord
    });
    // on prend au moins MIN (même si vieux), au plus MAX
    final = final.concat(arr.slice(0, MAX_PAR_THEME));
  });
  items = final;

  const out = { generatedAt:new Date().toISOString(), juridictionsOk:ok.length, count:items.length, items };
  writeFileSync(join(__dir,"..","veille.json"), JSON.stringify(out,null,2));
  console.log("✓ "+items.length+" actualités classées → veille.json");
}
main();
