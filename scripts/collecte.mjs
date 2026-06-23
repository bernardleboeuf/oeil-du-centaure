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

function cleanResume(s){
  if(!s) return "";
  return s.replace(/<[^>]+>/g," ").replace(/&[a-z#0-9]+;/gi," ").replace(/\b(nbsp|amp|wysiwyg|field|wiki feed)\b/gi," ").replace(/\s+/g," ").trim();
}

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
    items.push({ titre:title, lien:link, date:normDate(date)||new Date().toISOString(), source:srcNom, srcType, resume:cleanResume(desc).slice(0,240) });
  }
  return items;
}
// Détecte si un titre est (resté) en anglais : présence de mots anglais courants
// ET absence de marqueurs français évidents (accents ou petits mots FR).
function estTitreAnglais(t){
  if(!t) return false;
  const s=String(t);
  const motsEN=/\b(the|and|for|with|new|agreement|welcomes|adopts|launches|presents|customs|trade|safeguards|emissions|trading|system|cargo|smugglers|judgment|relinquishment|favour|chamber|cross-border|guidelines|safety|list|carriers|removed|added|workforce)\b/i;
  const marqueursFR=/[àâäéèêëîïôöùûüçœ]|\b(le|la|les|des|une|un|aux|sur|dans|pour|par|du|de|et|à|en|au)\b/i;
  return motsEN.test(s) && !marqueursFR.test(s);
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
    // vrai flux ? → un seul xml. On reconnaît items/entries MAIS aussi l'enveloppe rss/channel/feed
    // (certains flux valides — ex. WordPress Polynésie — peuvent être rejetés sinon).
    if(/<item[ >]|<entry[ >]/i.test(xml) || (/<rss[ >]|<channel[ >]|<feed[ >]/i.test(xml) && /<\/(item|entry|channel|rss|feed)>/i.test(xml))) return { ok:true, xmls:[xml] };
    // sinon : page /flux_rss → découvrir TOUS les flux pertinents et les suivre (décisions + lettre de jurisprudence…)
    const origin = new URL(url).origin;
    const links = [...xml.matchAll(/href=["']([^"']*(?:flux-rss|\/rss\/|flux_rss)[^"']*)["']/gi)]
                    .map(m=>m[1])
                    .filter(l=>/decision|jurisprudence|actualit/i.test(l))
                    // Exclure les flux NON propres à la juridiction (inter-juridictions, nationaux),
                    // qui feraient hériter des décisions d'autres tribunaux de la mauvaise source.
                    .filter(l=>!/toute|ensemble|national|administrative-?fr|tous-les|inter-?juridiction/i.test(l));
    const xmls = [];
    for(const l of [...new Set(links)].slice(0,6)){
      const u = l.startsWith("http") ? l : origin + (l.startsWith("/")?l:"/"+l);
      if(u===url) continue;
      try{
        const r2 = await rawFetch(u);
        if(r2.ok && /<item[ >]|<entry[ >]/i.test(r2.text)) xmls.push(r2.text);
      }catch(e){}
    }
    if(xmls.length) return { ok:true, xmls };
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
      "/flux-rss/dernieres-decisions",      // TA standard (Grenoble…) — flux PROPRE à la juridiction
      "/rss/dernieres-decisions",           // TA variante (Paris…)
      "/flux-rss/decisions-de-justice",     // CAA (Marseille…)
      "/rss/decisions-de-justice",
      "/flux-rss/jurisprudence",
      "/rss/jurisprudence",
      "/flux-rss",
      "/rss",
      "/feed",
      "/flux-rss/actualites",
      "/rss/actualites",
      "/rss/actualites-rss",                // Conseil d'État
      "/flux_rss"                           // EN DERNIER RECOURS : page listant tous les flux
                                            // (risque de ramener des décisions inter-juridictions — évité tant qu'un flux propre répond)
    ];
    candidates = paths.map(p=>src.base+p);            // TA/CAA/CNDA/Cassation : variantes auto
  }
  let lastReason = "aucune variante ne répond";
  for(const url of candidates){
    const r = await tryUrl(url);
    if(r.ok){
      // r.xmls peut contenir plusieurs flux (ex. décisions + lettre de jurisprudence)
      const items = [];
      for(const xml of r.xmls) items.push(...parseFeed(xml, src.nom, src.type));
      // dé-doublonnage interne par lien/titre (un flux peut recouper l'autre)
      const seen = new Set(), uniq = [];
      for(const it of items){
        const k = (it.lien||it.titre||"").trim();
        if(k && !seen.has(k)){ seen.add(k); uniq.push(it); }
      }
      if(uniq.length) return { ok:true, url, items:uniq };
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

ARBITRAGES ENTRE MATIÈRES PROCHES (applique ces priorités quand deux matières se disputent un article) :
• Mécanisme carbone aux frontières (MACF/CBAM), marché carbone (ETS/SEQE), quotas d'émission → "urb" (c'est un instrument environnemental), PAS "dpe", même si l'angle est fiscal ou commercial.
• Fiscalité, douanes, taxes, accords commerciaux internationaux, sanctions économiques → "dpe".
• Système douanier de données/déclaration (ICS2, guichet unique) → "dpe" (commerce/douane), PAS "dpi" : "dpi" est réservé aux DONNÉES PERSONNELLES, RGPD, cybersécurité, propriété intellectuelle.
• Sécurité aérienne, listes de transporteurs, sûreté des transports → "dpg" (police administrative), PAS "lib".
• Énergie, climat, biodiversité, eau, déchets, pêche, agriculture environnementale → "urb".
• Un texte qui touche plusieurs domaines : choisis la matière de son DISPOSITIF principal, pas d'un thème secondaire évoqué.

IMPACT : 3 = fort (loi, décret, revirement de jurisprudence, réforme majeure) ; 2 = à suivre (décision notable, nouvelle règle) ; 1 = information courante.

TRADUCTION : si le titre est en anglais, traduis-le en français dans "titre_fr" (sinon recopie-le). Et rédige toujours dans "chapo_fr" un résumé d UNE phrase en français (20-30 mots) expliquant l enjeu de l article, même si la source est en anglais.

PERTINENCE PAR PROFIL : pour chaque article, indique dans "profils" la liste des profils de lecteurs pour qui il est PRIORITAIRE (parmi : commune, sante, departement, bailleur, etat, entreprise). Un article sur les marchés hospitaliers → ["sante","commune"]. Une réforme de l'urbanisme → ["commune","bailleur","etat"]. Une décision sur l'aide sociale → ["departement","sante"]. Mets [] si l'article n'a pas de pertinence sectorielle marquée (il restera visible pour tous, mais sans priorité).

INTÉRÊT : mets "keep":false pour ÉCARTER les contenus sans valeur juridique opérationnelle pour des lecteurs professionnels (acteurs publics, institutionnels) : nominations, inaugurations, visites officielles, recrutements, anniversaires, communiqués protocolaires, événements internes, articles purement promotionnels ou pédagogiques, newsletters administratives, annonces d'inscription à un colloque, contenus de communication institutionnelle. ÉCARTE AUSSI les simples comptes-rendus de réunion, de dialogue, de coordination ou de sommet qui n'annoncent AUCUNE décision, règle, texte ou orientation concrète (ex. « les coordinateurs discutent de… », « les ministres se réunissent pour évoquer… », « réunion du conseil sur… ») : ces contenus n'ont pas de portée normative. GARDE ("keep":true) tout ce qui a un effet juridique réel ou imminent : décisions de justice, lois, décrets, règlements, directives, avis et décisions d'autorités, accords formels adoptés, rapports d'évaluation substantiels, consultations publiques sur un projet de texte, analyses de fond sur une réforme.

PERTINENCE PAR SECTEUR D'ACTIVITÉ : dans "secteurs", indique le ou les secteurs RÉELLEMENT et DIRECTEMENT concernés par l'article (parmi : sante, transport, energie, btp, numerique, environnement, social, eau, amenagement, culture, agriculture). Règle de SOBRIÉTÉ : 1 secteur en général, 2 au maximum, et seulement si le second est tout aussi central. N'ajoute JAMAIS un secteur simplement évoqué ou mentionné en passant. Exemples : un arrêt sur les aérodromes/SNCF/RATP → ["transport"] (et rien d'autre) ; un marché de travaux → ["btp"] ; une décision purement environnementale → ["environnement"] ; un sujet hospitalier → ["sante"] ; l'aide sociale aux personnes âgées → ["social"] ; une décision sur l'eau agricole → ["eau","agriculture"] si les deux sont au cœur du texte. Les régulateurs sectoriels (ART = transports, ANSSI/CNIL = numérique) ne portent JAMAIS d'autre secteur que le leur. Mets [] si l'article est procédural ou général sans ancrage sectoriel net (élections, actes administratifs, contentieux de la fonction publique générale, etc.).

Réponds UNIQUEMENT en JSON, sans aucun texte autour : [{"i":0,"comp":"dpa","impact":3,"titre_fr":"...","chapo_fr":"...","keep":true,"profils":["commune","etat"],"secteurs":["btp","energie"]},...]`;
  try{
    // traiter par lots de 50 pour rester dans les limites
    const all = [];
    let cacheWrite=0, cacheRead=0, inputNormal=0;
    const LOT = 15;  // lots plus petits : évite que la réponse JSON soit tronquée (titres UE longs non traduits)
    for(let start=0; start<items.length; start+=LOT){
      const batch = items.slice(start, start+LOT);
      const bl = batch.map((it,j)=>`${start+j}. [${it.source}] ${it.titre}${it.resume?" — "+it.resume.slice(0,120):""}`).join("\n");
      const r = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
        body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:12000, system:[{type:"text",text:sys,cache_control:{type:"ephemeral"}}], messages:[{role:"user",content:bl}] })});
      const data = await r.json();
      if(data.error){ console.error("Erreur API:", data.error.message); return null; }
      if(data.stop_reason==="max_tokens"){ console.warn("⚠ Lot "+start+" tronqué (max_tokens atteint) — certains titres peuvent rester non traduits"); }
      // Suivi du cache : tokens écrits vs lus depuis le cache (le prompt système, répété à chaque lot)
      if(data.usage){
        const u=data.usage;
        cacheWrite += u.cache_creation_input_tokens||0;
        cacheRead  += u.cache_read_input_tokens||0;
        inputNormal+= u.input_tokens||0;
      }
      const txt = data.content.filter(b=>b.type==="text").map(b=>b.text).join("").replace(/\`\`\`json|\`\`\`/g,"").trim();
      try{ all.push(...JSON.parse(txt)); }catch(e){ console.error("Parse lot:", e.message); }
    }
    if(cacheRead||cacheWrite){
      console.log(`  Cache : ${cacheRead} tokens lus (à -90%), ${cacheWrite} écrits, ${inputNormal} entrée normale`);
    }
    console.log("✓ Classement IA :", all.length, "items classés");
    return all;
  }catch(e){ console.error("IA indisponible, repli mots-clés:", e.message); return null; }
}

// ===== Génération du réservoir outre-mer =====
// Détection d'un territoire ultramarin par source locale ou mention dans le titre/résumé.
const OM_TERRITOIRES_DEF = {
  guadeloupe:  { label:"Guadeloupe",            src:/guadeloupe/i,            txt:/\bguadeloupe\b|pointe-à-pitre|basse-terre|baie-mahault|gourbeyre/i },
  martinique:  { label:"Martinique",            src:/martinique/i,            txt:/\bmartinique\b|fort-de-france/i },
  guyane:      { label:"Guyane",                src:/guyane/i,                txt:/\bguyane française\b|\ben guyane\b|cayenne|kourou|\bguyanais/i },
  stbarthelemy:{ label:"Saint-Barthélemy",      src:/saint-barthélemy|saint-barth/i, txt:/saint-barthélemy/i },
  stmartin:    { label:"Saint-Martin",          src:/saint-martin(?!-|\s+(de|en|du|vésubie|d'))/i, txt:/saint-martin \(antilles\)|saint-martin antilles|collectivité de saint-martin/i },
  reunion:     { label:"La Réunion",            src:/réunion/i,               txt:/\bla réunion\b|saint-denis de la réunion|île de la réunion/i },
  mayotte:     { label:"Mayotte",               src:/mayotte/i,               txt:/\bmayotte\b|mamoudzou/i },
  ncaledonie:  { label:"Nouvelle-Calédonie",    src:/calédonie|caledonie/i,   txt:/nouvelle-calédonie|nouméa|\bkanak/i },
  polynesie:   { label:"Polynésie française",   src:/polynésie|polynesie/i,   txt:/polynésie française|papeete|tahiti/i },
  wallis:      { label:"Wallis-et-Futuna",      src:/wallis|futuna/i,         txt:/wallis-et-futuna|wallis et futuna/i },
  stpierre:    { label:"Saint-Pierre-et-Miquelon", src:/saint-pierre-et-miquelon|miquelon/i, txt:/saint-pierre-et-miquelon|miquelon/i }
};
function territoiresDe(it){
  const src = it.source||"";
  const txt = (it.titre||"")+" "+(it.resume||"");
  const ids=[];
  for(const [id,t] of Object.entries(OM_TERRITOIRES_DEF)){
    // Priorité à la source : si la juridiction est ultramarine, c'est ce territoire.
    if(t.src.test(src)){ ids.push(id); continue; }
    // Sinon, mention dans le texte seulement si très explicite.
    if(t.txt.test(txt)) ids.push(id);
  }
  return ids;
}
async function genererOutremer(results, juridictionsOk){
  // 1. Filtrer les décisions rattachées à un territoire, MAIS seulement les sources françaises.
  // On exclut les sources étrangères anglophones (Commission UE, CJUE, CEDH) : sans IA on ne traduit pas,
  // et ces sujets ultramarins remontent de toute façon dans la une transversale (veille.json, traduit).
  const SRC_ETRANGERE = /commission ue|cjue|cour de justice de l'ue|curia|echr|cedh/i;
  // Le flux Guyane (vie-du-tribunal) mêle décisions et événements internes du tribunal.
  // Filtre léger sans IA : on écarte ce qui n'est manifestement pas une décision de justice.
  const BRUIT_VIE_TRIBUNAL = /\b(cérémonie|ceremonie|vœux|voeux|audience solennelle|installation|nomination|communiqué de presse|portes ouvertes|colloque|conférence|conference|partenariat|convention de|signature|rentrée|rentree|hommage|visite|inauguration|recrutement|stage|concours|bilan d'activité|rapport d'activité|assemblée générale)\b/i;
  const bruts = results.filter(it=>{
    if(territoiresDe(it).length===0) return false;
    if(SRC_ETRANGERE.test(it.source||"")) return false;
    // Filtre de bruit appliqué UNIQUEMENT aux sources passant par vie-du-tribunal (Guyane)
    if(/guyane/i.test(it.source||"") && BRUIT_VIE_TRIBUNAL.test((it.titre||"")+" "+(it.resume||""))) return false;
    return true;
  });
  // 2. Dé-doublonnage par titre
  const seen=new Set();
  let oms = bruts.filter(it=>{ const k=(it.titre||"").toLowerCase().slice(0,80); if(seen.has(k))return false; seen.add(k); return true; });
  // 3. Garder les plus récentes par territoire (plafond OM_MAX_PAR_TERR), pour borner le coût IA
  const OM_MAX_PAR_TERR = 8;
  const parTerr={};
  oms.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  for(const it of oms){
    for(const id of territoiresDe(it)){
      parTerr[id]=parTerr[id]||[];
      if(parTerr[id].length<OM_MAX_PAR_TERR && !parTerr[id].includes(it)) parTerr[id].push(it);
    }
  }
  // ensemble unique à conserver (décisions brutes, sans IA — les flux sont datés, cela suffit)
  const aClasser=[...new Set(Object.values(parTerr).flat())];
  console.log("Réservoir outre-mer :", aClasser.length, "décisions sur", Object.keys(parTerr).length, "territoires");
  if(!aClasser.length){
    writeFileSync(join(__dir,"..","outremer.json"), JSON.stringify({generatedAt:new Date().toISOString(),juridictionsOk,count:0,items:[]},null,2));
    console.log("✓ outremer.json (vide)");
    return;
  }
  // Pas de classement IA : on garde le titre brut, on déduit la matière par mots-clés (gratuit),
  // l'impact par mots-clés, et on conserve le résumé comme chapô.
  const items = aClasser.map(it=>{
    const comp = classifyKW(it.titre+" "+(it.resume||"")) || "dpg";
    const impact = impactKW(it.titre+" "+(it.resume||""));
    return {...it, titre:it.titre, chapo:it.resume||"", comp, impact, territoires:territoiresDe(it)};
  });
  // tri par date (fraîcheur) — l'édition spéciale les ordonnera par impact puis date côté front
  items.sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")));
  const out={ generatedAt:new Date().toISOString(), juridictionsOk, count:items.length, items };
  writeFileSync(join(__dir,"..","outremer.json"), JSON.stringify(out,null,2));
  console.log("✓ "+items.length+" décisions ultramarines → outremer.json (sans IA)");
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

  // ===== RÉSERVOIR OUTRE-MER (outremer.json) =====
  // Indépendant du cap de fraîcheur du veille.json général. On capture TOUTES les décisions
  // ultramarines collectées (sources locales OU mention d'un territoire), on les dé-doublonne,
  // on en garde les plus récentes par territoire, et on les classe légèrement par IA.
  await genererOutremer(results, ok.length);

  // Le flux CEDH est bilingue : chaque communiqué paraît en FR et en EN. On ne garde que le FR.
  let results2 = results.filter(it=>{
    const estCEDH = /cedh|echr/i.test(it.source||"");
    if(estCEDH && estTitreAnglais(it.titre||"")) return false; // version anglaise = doublon
    return true;
  });

  const seen = new Set();
  let items = results2.filter(it=>{ const k=it.titre.toLowerCase().slice(0,80); if(seen.has(k))return false; seen.add(k); return true; });
  // Tri par fraîcheur (plus récent d'abord) — la fraîcheur reste la priorité d'affichage
  items.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  // diversité : max 8 items par source (évite qu'un TA noie tout)
  const perSrc={}; items = items.filter(it=>{ const s=it.source; perSrc[s]=(perSrc[s]||0)+1; return perSrc[s]<=8; });

  // PRÉ-FILTRAGE AVANT l'IA : on ne classe que les 250 articles les plus récents (cap pur, sans exception).
  // L'édition outre-mer dispose de son propre réservoir (outremer.json), généré en amont, indépendant de ce cap.
  items.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  items = items.slice(0,250);
  console.log("Articles envoyés au classement IA :", items.length, "(les 250 plus récents)");


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
    let comp, impact, keep=true, titre=it.titre, chapo="", profils=[], secteurs=[];
    const tag = ai ? aiByIdx[idx] : null;
    if(tag){
      comp = (tag.comp && tag.comp!=="null") ? tag.comp : classifyKW(it.titre+" "+it.resume);
      impact = tag.impact || impactKW(it.titre);
      keep = tag.keep!==false;
      if(tag.titre_fr && String(tag.titre_fr).trim()) titre = String(tag.titre_fr).trim();
      if(tag.chapo_fr && String(tag.chapo_fr).trim()) chapo = String(tag.chapo_fr).trim();
      // Filet anti-anglais : si le titre est resté en anglais (titre_fr non rempli par l'IA)
      // mais qu'on a un chapô français, on promeut le chapô en titre pour ne jamais afficher d'anglais.
      if(estTitreAnglais(titre) && chapo && !estTitreAnglais(chapo)){ titre = chapo; }
      profils = Array.isArray(tag.profils) ? tag.profils : [];
      secteurs = Array.isArray(tag.secteurs) ? tag.secteurs : [];
    } else {
      comp = classifyKW(it.titre+" "+it.resume); impact = impactKW(it.titre+" "+it.resume);
    }
    if(!comp) comp = defaultTheme(it);
    // VERROU SECTORIEL : certaines sources sont mono-sectorielles par nature.
    // Leur secteur est imposé, quel que soit le tag IA (qui sur-tague parfois).
    const src = (it.source||"").toLowerCase();
    const SECTOR_LOCK = [
      { test:/\bart\b|autorité de régulation des transports|autorite-transports/, secteurs:["transport"] },
    ];
    for(const lock of SECTOR_LOCK){
      if(lock.test.test(src)){ secteurs = lock.secteurs.slice(); break; }
    }
    return {...it, titre, chapo, comp, impact, keep, profils, secteurs};
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
