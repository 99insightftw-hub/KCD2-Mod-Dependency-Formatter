'use strict';
// GPL-3.0. Derived from KCD2 Dependency Checker and its attributed merger UI.
const $ = id => document.getElementById(id);
const el = (tag, value, cls) => { const node=document.createElement(tag); if(value!==undefined)node.textContent=value; if(cls)node.className=cls; if(tag==='pre')node.tabIndex=0; return node; };
let downloadGeneration=0, downloadPolling=false, downloadSnapshot=null;
let busy=false, report=null, preview=null, archive=null, undoKind=null, cancellable=false, savedReceiptPath=null;
let modChangePolling=false, staleReview=false, monitoringIncomplete=false;
let renderedDependencySnapshot=null, renderedAlertSnapshot=null;
let detailedDependencies=false;
let vortexBridge=null, vortexPolling=false;
let automaticCandidates=[],automaticReviews=new Set();
const labels={installed:'Files found',ready:'Files found',found:'Files found',located:'Files found',ambiguous:'Multiple copies',missing:'Not found',incomplete:'Incomplete',review:'Check details',disabled:'Not enabled',misplaced:'Needs moving',blocked:'Needs attention'};
async function call(name,...args){const result=await window.checker.call(name,...args);if(!result.ok){if(result.automaticOrder)showAutomaticOrder(result.automaticOrder);throw Error(result.error||'The operation could not be completed.');}return result.value;}
function status(message,kind=''){ $('status').textContent=message; $('status').className='status'+(kind?' '+kind:''); $('retry-check').hidden=kind!=='error'&&!monitoringIncomplete; }
function drawLaunchStatus(checking){
 const node=$('launch-status'),details=$('launch-needs');details.replaceChildren();
 node.className='small';node.setAttribute('aria-busy',String(checking));
 if(checking){node.textContent='⟳ Automatic scan in progress…';return;}
 if(!report){node.textContent='Choose your game folder to check what is needed.';return;}
 const rows=uniqueDependencies(Array.isArray(report.dependencies)?report.dependencies:[]);
 const missing=rows.filter(item=>item.status==='missing'&&(item.requiredBy?.length||item.conditionalRequiredBy?.length));
 const mods=new Map((report.mods||[]).map(m=>[m.id,m.name||m.loadName||m.id]));
 const names=new Map(rows.map(r=>[r.id,r.name||r.id]));
 for(const item of missing){
  const row=el('li');
  row.append(el('span',(item.requiredBy?.length?item.requiredBy:item.conditionalRequiredBy).map(id=>consumerName(id,mods,names)).join(', ')+(item.requiredBy?.length?' requires ':' (Workshop, if used) requires ')+(item.name||item.id)+'. '));
  const button=el('button','Download '+(item.name||item.id));
  button.addEventListener('click',()=>run(async()=>{await call(item.id==='asi'?'open-asi-author':'open-nexus',...(item.id==='asi'?[]:[item.id]));}));
  row.append(button);details.append(row);
 }
 const incomplete=monitoringIncomplete||$('status').classList.contains('error')||!rows.length;
 // Technical findings stay in the lower findings panel, not the launch summary.
 const reviewRows=rows.filter(r=>r.status!=='missing'&&!['installed','ready','found'].includes(r.status)&&r.reviewReason!=='workshop-activation-unverified');
 const issues=reviewRows.filter(r=>!unverifiedVersion(r)&&(['incomplete','disabled','misplaced'].includes(r.status)||r.needsNativePlacement||r.reviewReason==='workshop-native-placement'));
 const recovery=report.automaticOrder?.state==='recovery';
 const workshop=workshopContext(report);
 const pendingWorkshop=report.workshop?.pending||report.workshop?.items?.some(i=>i.state==='pending');
 const incompleteWorkshop=report.workshop?.complete===false||report.workshop?.items?.some(i=>i.state==='missing');
 for(const item of issues){
  const row=el('li'),name=el('span',item.name||item.id);name.translate=false;
  const explanation=item.missingNativeFile?`${item.missingNativeFile} is missing from KCSE/Plugins.`:unverifiedVersion(item)?versionCheckText(item):item.needsNativePlacement||item.reviewReason==='workshop-native-placement'?'Files found — native plugin needs installation':['review','blocked'].includes(item.status)?item.detail||'Check the author’s installation instructions.':labels[item.status]||item.detail||'Check the author’s installation instructions.';
  row.append(name,document.createTextNode(' — '),el('span',explanation));
  details.append(row);
 }
 if(pendingWorkshop)details.append(el('li','Steam is downloading mods. Wait for it to finish.'));
 else if(incompleteWorkshop)details.append(el('li','Some Workshop files could not be checked. Open Steam to check your downloads.'));
 if(recovery)details.append(el('li',report.automaticOrder.message||'Recovery needed. Undo last change will check the saved transaction before attempting recovery.'));
 if(missing.length){node.textContent=missing.some(item=>item.requiredBy?.length)?'Download required dependencies':'Dependencies for your Workshop mods';node.className='small warning';}
 else if(incomplete){node.textContent='Check not finished — choose Retry check.';}
 else if(issues.length||recovery||pendingWorkshop||incompleteWorkshop){node.textContent=issues.some(item=>item.missingNativeFile)?'Plugin file missing':'Items to check';}
 else if(workshop){node.textContent='Workshop mods detected.';}
 else if(report.findings?.length||reviewRows.length){node.textContent='Dependencies checked.';}
 else{node.textContent='✓ Ready to launch game';node.className='small success';}
 if(incomplete)details.append(el('li','Choose Retry check to finish checking your setup.'));
}
function sync(){
  document.querySelectorAll('button').forEach(button=>button.disabled=busy);
  $('game').disabled=busy;
  $('browse').hidden=!!report;
  $('game-selected').hidden=!report;
  $('game-selected').textContent=report?'Game found: '+$('game').value.trim():'';
  $('retry-check').disabled=busy;
  $('retry-check').hidden=!monitoringIncomplete&&!$('status').classList.contains('error');
  $('scan').disabled=busy||!$('game').value.trim();
  for(const id of ['launch-devmode','download','choose-download-folder','refresh-downloads'])$(id).disabled=busy||!report;
  const checking=busy||modChangePolling||downloadPolling||vortexPolling;
  drawLaunchStatus(checking);
  $('launch-devmode').disabled=checking||monitoringIncomplete||!report;
  $('launch-devmode').textContent=checking?'Checking setup…':'Launch game with -devmode';
  $('launch-devmode').title=checking?'Wait for automatic checks to finish.':!report?'Check your game before launching.':'Launch the checked game with -devmode.';
  $('undo').disabled=busy||!undoKind;
  $('install').disabled=busy||!archive||archive.canApply===false;
  $('export').disabled=busy||!archive;
  $('export-vortex').disabled=busy||!archive;
  const vortexBlockers=Array.isArray(archive?.vortexBlockers)?archive.vortexBlockers:[];
  $('install-vortex').disabled=busy||!archive||vortexBlockers.length>0||vortexBridge?.connected!==true||vortexBridge?.ready!==true;
  $('vortex-install-blockers').hidden=!vortexBlockers.length;
  $('vortex-install-blockers').textContent=vortexBlockers.length?'Cannot install with Vortex: '+vortexBlockers.map(warningText).join(' '):'';
  $('install-vortex').title=vortexBlockers.length?vortexBlockers.map(warningText).join(' '):vortexBridge?.connected===true&&vortexBridge?.ready===true?'Import, enable and deploy this reviewed dependency through Vortex.':'The Vortex helper is not connected.';
  $('refresh-vortex').disabled=busy||!report;
  $('vortex-setup').hidden=!vortexContext()||vortexBridge?.connected===true;
  $('export-vortex-helper').disabled=busy;
  $('vortex-connect').hidden=!detailedDependencies&&!vortexContext()&&!vortexBridge?.connected;
  syncRecommendedInstall();
  $('cancel').hidden=!cancellable;$('cancel').disabled=!cancellable;
  $('undo').title=!undoKind?'No change from this app session is available to undo.':'';
}
async function run(action){if(busy)return;busy=true;downloadGeneration++;sync();try{await action();}catch(error){status(error.message||String(error),/cancelled/i.test(error.message)?'':'error');}finally{busy=false;sync();}}
function showReceipt(result){const path=result.receipt||result.backup||result.backupPath;if(path){savedReceiptPath=path;$('previous-receipt').hidden=true;$('previous-receipt').textContent='';$('receipt').hidden=false;$('receipt').textContent='Backup / receipt: '+path;}}
function bind(id,action){$(id).addEventListener('click',()=>run(action));}
function clearPlans(){preview=archive=null;$('archive-review').hidden=true;$('archive-result').textContent='';$('download-plan').textContent='No download selected.';}
function markStaleReview(){
  const hadReview=!$('archive-review').hidden;
  preview=archive=null;staleReview=hadReview;
  $('stale-review-notice').hidden=!hadReview;
  sync();
}
function clearStaleReview(){staleReview=false;$('stale-review-notice').hidden=true;}
async function change(name){clearPlans();try{return await call(name);}catch(error){reset();throw error;}}
function reset(){
 monitoringIncomplete=false;$('monitoring-notice').hidden=true;
 downloadGeneration++;downloadSnapshot=null;automaticCandidates=[];report=preview=archive=null;
 vortexBridge=null;drawVortexBridge();
 clearStaleReview();renderedDependencySnapshot=renderedAlertSnapshot=null;$('dependency-alert').hidden=true;$('dependency-alert-items').replaceChildren();
 $('choices').replaceChildren();
 $('workshop-note').hidden=true;$('workshop-note').replaceChildren();$('order-startup').hidden=true;$('order-startup').replaceChildren();$('manager-note').hidden=true;$('manager-note').replaceChildren();
 $('download-candidates').replaceChildren();$('download-folder').textContent='Check your game to find your Downloads folder.';$('archive-review').hidden=true;$('archive-result').textContent='';
 $('dependencies').replaceChildren(el('p','Check your game to see supported dependencies.','small'));$('summary').textContent='Check your game to refresh the results.';$('findings-panel').hidden=true;$('findings-details').open=false;$('findings-list').replaceChildren();$('download-plan').textContent='No download selected.';
 $('runtime-evidence').open=false;$('runtime-evidence-body').replaceChildren(el('p','Check your game to look for game log clues.','small'));sync();
}
function clearSessionUndo(){undoKind=null;$('receipt').hidden=true;$('receipt').textContent='';if(savedReceiptPath){$('previous-receipt').hidden=false;$('previous-receipt').textContent='Earlier receipt: '+savedReceiptPath;}}
async function selectGame(path){if($('game').value!==path)clearSessionUndo();$('game').value=path;reset();await call('invalidate-scan');}
$('game').addEventListener('input',()=>{clearSessionUndo();reset();status('Game selection changed. Check this folder to continue.');call('invalidate-scan').catch(error=>status(error.message,'error'));});
function unverifiedVersion(item){return item?.status==='review'&&item.reviewReason==='unverified-native-version';}
function vortexContext(value=report){return !!(value?.vortex?.detected||value?.vortex?.orderMayBeManaged);}
function workshopProviders(item){return (Array.isArray(item?.providers)?item.providers:[]).filter(p=>p.workshop===true||p.source==='workshop');}
function workshopContext(value=report){return !!(value?.mods?.some(m=>m.workshop===true||m.source==='workshop')||value?.dependencies?.some(item=>workshopProviders(item).length)||value?.workshop?.pending===true||value?.workshop?.detected||value?.workshop?.items?.length||value?.workshop?.issues?.length); }
function workshopButton(provider){
 const id=String(provider?.workshopItemId||'');if(!/^[1-9][0-9]{0,19}$/.test(id))return null;
 const button=el('button','Workshop page ↗','quiet');button.dataset.help='Open this Steam Workshop item. Use Steam for downloads and updates; this app does not change your subscription.';
 button.addEventListener('click',()=>run(async()=>{await call('open-workshop-item',id);}));return button;
}
function appendProviderSources(node,item){
 for(const provider of Array.isArray(item.providers)?item.providers:[]){
  const workshop=provider.workshop===true||provider.source==='workshop';
  const sourceLine=el('p',undefined,'small');sourceLine.append(el('span','Source: '),el('span',workshop?'Steam Workshop':provider.managed||provider.source==='vortex'?'Vortex-managed files':'Local game folder'));node.append(sourceLine);
  if(workshop){node.append(el('p','Files found in Workshop storage. Subscription and in-game activation are not verified here. Manage this item through Steam and your Steam subscriptions and custom mod list.','small'));const button=workshopButton(provider);if(button)node.append(button);}
 }
}
function drawWorkshop(value){
 const host=$('workshop-note');host.hidden=!workshopContext(value);host.replaceChildren();if(host.hidden)return;
 const data=value.workshop;
 if(data?.pending||data?.items?.some(i=>i.state==='pending'))host.append(el('p','Steam is downloading mods. Wait for it to finish.'));
 else if(data?.complete===false||data?.items?.some(i=>i.state==='missing'))host.append(el('p','Some Workshop files could not be checked. Open Steam to check your downloads.'));
 const node=el('details');node.append(el('summary','Steam Workshop — advanced details'));host.append(node);
 node.append(el('strong',value.workshop?.complete===false?'Steam Workshop needs review':'Steam Workshop information')); 
 node.append(el('p','Steam manages these downloads and updates. File presence does not confirm that an item is subscribed, fully downloaded, or enabled in the game.'));
 const metadata=value.workshop,items=Array.isArray(metadata?.items)?metadata.items:[];
 const pending=items.filter(item=>item.state==='pending').length,missing=items.filter(item=>item.state==='missing').length;
 if(pending||metadata?.pending===true||missing||metadata?.complete===false)node.append(el('p',(pending?pending+' Workshop download(s) pending. ':metadata?.pending===true?'Steam reports pending Workshop downloads. Wait for Steam to finish, then check again. ':'')+(missing?missing+' recorded Workshop item(s) unavailable. ':'')+(metadata?.complete===false?'The Workshop scan is incomplete; resolve the findings before relying on dependency results.':''),'warning'));
 const mods=(Array.isArray(value.mods)?value.mods:[]).filter(mod=>mod.workshop===true||mod.source==='workshop');
 if(mods.length){const details=el('details');details.append(el('summary','Workshop mods found ('+mods.length+')'));for(const mod of mods.slice(0,50)){const row=el('div');row.append(el('p',(mod.name||mod.id||'Workshop item')+' — activation not verified','small'));const link=workshopButton(mod);if(link)row.append(link);details.append(row);}if(mods.length>50)details.append(el('p','Showing the first 50 mods. The scan report contains the full inventory.','small'));node.append(details);}

 node.append(el('p','Recommended — Finish pending Steam downloads, check your Steam subscriptions and custom mod list, then check dependencies again. Keep Workshop files in Steam’s folder; do not copy them into Mods.','small'));
}
function manifestVersion(item){
 const provider=item.providers?.length===1?item.providers[0]:null;
 return typeof provider?.version==='string'&&provider.version.trim()?provider.version.trim():null;
}
function versionCheckText(item){const version=manifestVersion(item);return (version?'Detected manifest version: '+version+'. ':'Installed version could not be detected. ')+'Compare with the version on the author’s page.';}
function appendVersion(node,item){const version=manifestVersion(item);if(version)node.append(el('p','Detected manifest version: '+version,'small'));}
function badge(state,item=null){
 const nativePlacement=item?.needsNativePlacement===true||item?.reviewReason==='workshop-native-placement';
 const unverified=unverifiedVersion(item),workshopUnknown=item?.reviewReason==='workshop-activation-unverified';
 const good=['installed','ready','found'].includes(state);
 const node=el('div',undefined,'badge '+(good?'good':['missing','incomplete','blocked'].includes(state)?'bad':'warn'));
 const icon=el('span',good?'✓':state==='missing'?'!':'•','status-icon');icon.setAttribute('aria-hidden','true');
 const copy=el('div');copy.append(el('strong',nativePlacement?'Files found — native plugin needs installation':workshopUnknown?'Files found — check Workshop activation':unverified?'Files found — version needs verification':good?'Files found':labels[state]||'Needs review'));
 if(nativePlacement)copy.append(el('span','Workshop activation alone cannot load this DLL. Follow the author’s native dependency installation instructions.','status-explanation'));
 else if(good)copy.append(el('span',workshopProviders(item).length?'Workshop activation not verified.':'Not tested in game.','status-explanation'));
 else if(workshopUnknown)copy.append(el('span','Steam enables subscribed mods on launch. Check your custom mod list if this mod does not load.','status-explanation'));
 else if(unverified)copy.append(el('span',versionCheckText(item),'status-explanation'));
 else if(state==='missing')copy.append(el('span',item?.requiredBy?.length?'Needed by a detected mod. Check the author’s instructions.':'Optional unless a mod asks for it.','status-explanation'));
 else if(['located','misplaced'].includes(state))copy.append(el('span','Files need placement — preview the changes.','status-explanation'));
 node.append(icon,copy);return node;
}
function dependencyHeader(item){
 const header=el('div',undefined,'dependency-titlebar'),frame=el('span',undefined,'dependency-thumbnail');
 const fallback=el('span',String(item.id||'MOD').slice(0,5).toUpperCase(),'dependency-thumbnail-fallback');
 fallback.setAttribute('aria-hidden','true');frame.append(fallback);
 const art=window.dependencyArt&&Object.hasOwn(window.dependencyArt,item.id)?window.dependencyArt[item.id]:null;
 if(art){
  const image=el('img');image.alt=(item.name||item.id)+' author-page thumbnail';image.width=72;image.height=72;
  image.title='Thumbnail from the author’s page';image.src=art.file;
  image.addEventListener('load',()=>{fallback.hidden=true;});
  image.addEventListener('error',()=>{image.hidden=true;fallback.hidden=false;frame.setAttribute('aria-label','Thumbnail unavailable');});
  frame.append(image);
 }
 header.append(frame,el('h3',item.name||item.id||'Dependency'));return header;
}
function dependencyCard(item){
 const node=el('article',undefined,'dependency-card');node.dataset.dependencyId=item.id;node.append(dependencyHeader(item),badge(item.status,item),el('p',item.detail||'Check the author’s installation instructions.'));appendVersion(node,item);appendProviderSources(node,item);
 const alreadyFound=['installed','found','ready','disabled'].includes(item.status);
 if(alreadyFound){node.classList.add('files-already-found');node.append(el('p','No additional download needed — files already found.','download-not-needed'));}
 const required=Array.isArray(item.requiredBy)?item.requiredBy:[];
 const displayName=id=>(report?.mods||[]).find(m=>m.id===id)?.name||(report?.dependencies||[]).find(d=>d.id===id)?.name||id;
 if(required.length){
  node.append(el('p','Used by these mods:','requirement'));
  const list=el('ol',undefined,'requirement-list');
  for(const name of required)list.append(el('li',displayName(name)));
  node.append(list);
 }else if(item.conditionalRequiredBy?.length)node.append(el('p','Needed by Workshop mods, if used: '+item.conditionalRequiredBy.map(displayName).join(', '),'requirement'));
 else node.append(el('p','Optional · install only if a mod asks for it.','small'));
 if(item.folder){const folder=el('p',item.folder,'small');folder.translate=false;node.append(folder);}
 if(item.status==='disabled'&&item.providers?.length)node.append(el('p',workshopProviders(item).length?'Workshop files found. Check Steam downloads and enable the item in your Steam subscriptions and custom mod list, then check again.':vortexContext()?'Files found, but this dependency is not in the mod list.':'Files found, but this plugin is not in the mod list. Check the author’s load-order instructions.','small'));
 if(item.requires?.includes('kcse')||['mcm','ptfextender'].includes(item.id))node.append(el('p','Needs Kingdom Come Script Extender (KCSE).','small'));
 if(item.id==='soundframework'||item.id==='soundframework_asi')node.append(el('p','Choose one Sound Framework build: KCSE or ASI. Keep its settings and lip model files together.','small'));
 if(item.id==='mcm')node.append(el('p','MCM only lists mods that add MCM settings. An empty list may mean none registered this time. If you expected a mod, check its requirements and Game log clues after opening the menu.','small'));
 if(item.id==='luadb')node.append(el('p','For mods that use LuaDB database or configuration features. An ASI loader or compatible KCSE build is needed.','small'));
 if(item.id==='asi')node.append(el('p','Use the x64 loader only when a mod needs ASI support. Check dinput8.dll conflicts before installing.','small'));
 const label=workshopProviders(item).length?'Author page ↗':unverifiedVersion(item)?'Verify on author page ↗':['installed','found','ready','disabled'].includes(item.status)?'Author page ↗':'Download ↗';const button=el('button',label);
 button.setAttribute('aria-label',(unverifiedVersion(item)?'Verify version of ':'Open author page for ')+item.name);
 button.addEventListener('click',()=>run(async()=>{if(item.id==='asi')await call('open-asi-author');else await call('open-nexus',item.id);$('download-watch-status').textContent=vortexContext()?'Downloads are checked automatically while this app is open.':'Save the author’s ZIP or 7z, then review it in Your downloads. Install only if you need this plugin.';}));const linkHost=['installed','found','ready','disabled'].includes(item.status)||!required.length&&!item.conditionalRequiredBy?.length?el('details'):node;if(linkHost!==node){linkHost.classList.add('author-download-options');linkHost.append(el('summary','Download from author page'));node.append(linkHost);}linkHost.append(button,el('p',"Save the author's ZIP or 7z in Downloads. Leave it zipped; the app extracts supported files for you.",'small'));if(item.github){const github=el('button','GitHub release ↗','quiet');github.addEventListener('click',()=>run(async()=>{await call('open-plugin-github',item.id);}));linkHost.append(github);}return node;
}
function uniqueDependencies(rows){
 const seen=new Set();return rows.filter(row=>{if(!row||!row.id||seen.has(row.id))return false;seen.add(row.id);return true;});
}
function setDependencyMode(detailed){
 detailedDependencies=detailed;
 $('plugins-panel').classList.toggle('dependency-simple',!detailed);
 $('dependencies-simple').setAttribute('aria-pressed',String(!detailed));
 $('dependencies-detailed').setAttribute('aria-pressed',String(detailed));
 $('dependency-mode-help').textContent=detailed?'All supported dependencies and installation details.':'Dependencies used by your mods. Missing files are marked below.';
 if(report)drawDependencies(uniqueDependencies(report.dependencies||[]));
 sync();
}
$('dependencies-simple').addEventListener('click',()=>setDependencyMode(false));
$('dependencies-detailed').addEventListener('click',()=>setDependencyMode(true));
function drawDependencies(rows){
 const snapshot=JSON.stringify([rows,vortexContext(),detailedDependencies]);if(snapshot===renderedDependencySnapshot)return;renderedDependencySnapshot=snapshot;
 const nodes=$('dependencies');nodes.replaceChildren();
 if(!rows.length){nodes.append(el('p','No dependency results were returned. Check your game again.','small'));return;}
 let visible=0;
 for(const row of rows){
  const card=dependencyCard(row);
  const important=row.requiredBy?.length||row.conditionalRequiredBy?.length||!['missing','installed','ready','found'].includes(row.status);
  card.hidden=!detailedDependencies&&!important;
  if(!card.hidden)visible++;
  if(!detailedDependencies){
   for(const child of [...card.children]){
    if(child.matches('.dependency-titlebar,.badge,.download-not-needed,.requirement,.requirement-list,.author-download-options,button'))continue;
    child.classList.add('dependency-extra');
   }
  }
  nodes.append(card);
 }
 if(!visible)nodes.prepend(el('p','No required dependencies need attention. Choose Detailed to browse all supported dependencies.','small'));
}
function consumerName(id,modNames,dependencyNames){return modNames.get(id)||dependencyNames.get(id)||id;}
function drawDependencyAlert(value,rows){
 const snapshot=JSON.stringify([vortexContext(value),rows,value.prospectiveDependencies,value.prospectiveRequirements,value.requirements,value.loaderNotices,value.mods?.map(mod=>[mod.id,mod.name,mod.active])]);
 if(snapshot===renderedAlertSnapshot)return;
 renderedAlertSnapshot=snapshot;
 const panel=$('dependency-alert'),items=$('dependency-alert-items');items.replaceChildren();
 const dependencyNames=new Map(rows.map(row=>[row.id,row.name||row.id]));
 const mods=Array.isArray(value.mods)?value.mods:[];
 const modNames=new Map(mods.map(mod=>[mod.id,mod.name||mod.loadName||mod.id]));
 const inactive=new Set(mods.filter(mod=>mod.active===false).map(mod=>mod.id));
 const good=new Set(['installed','ready','found']);
 const catalog=new Set(rows.map(row=>row.id));
 const knownTargets=new Set([...rows.flatMap(row=>[row.id,row.name]),...mods.flatMap(mod=>[mod.id,mod.loadName])].filter(Boolean).map(name=>String(name).toLowerCase()));
 const loaderNotices=Array.isArray(value.loaderNotices)?value.loaderNotices.filter(notice=>notice?.id==='asi-loader-choice'):[];
 const active=rows.filter(row=>(row.requiredBy?.length||row.conditionalRequiredBy?.length)&&!good.has(row.status)&&!(row.id==='asi'&&loaderNotices.length)).map(row=>({...row,workshopConditional:!row.requiredBy?.length,requiredBy:row.requiredBy?.length?row.requiredBy:row.conditionalRequiredBy}));
 const prospectiveRows=Array.isArray(value.prospectiveDependencies)?value.prospectiveDependencies:[];
 const origins=new Map([...inactive].map(id=>[String(id).toLowerCase(),new Set([id])]));
 let expanded=true;
 while(expanded){
  expanded=false;
  for(const row of prospectiveRows){
   if(!row?.id)continue;
   const key=String(row.id).toLowerCase(),found=origins.get(key)||new Set();
   for(const consumer of Array.isArray(row.requiredBy)?row.requiredBy:[])
    for(const origin of origins.get(String(consumer).toLowerCase())||[])
     if(!found.has(origin)){found.add(origin);expanded=true;}
   if(found.size)origins.set(key,found);
  }
 }
 const prospective=prospectiveRows.filter(row=>row&&catalog.has(row.id)&&!good.has(row.status))
   .map(row=>({...row,requiredBy:[...(origins.get(String(row.id).toLowerCase())||[])]}))
   .filter(row=>row.requiredBy.length);
 const unsupported=[];
 const actualRequirements=(Array.isArray(value.requirements)?value.requirements:[]).filter(r=>r?.active).map(r=>({...r,inactiveOrigins:[]}));
 const futureRequirements=(Array.isArray(value.prospectiveRequirements)?value.prospectiveRequirements:[])
  .map(r=>({...r,inactiveOrigins:[...(origins.get(String(r?.consumer||'').toLowerCase())||[])]}))
  .filter(r=>r.inactiveOrigins.length);
 for(const requirement of [...actualRequirements,...futureRequirements]){
  if(!requirement||requirement.kind==='optional'||!requirement.target||knownTargets.has(String(requirement.target).toLowerCase()))continue;
  const key=String(requirement.consumer)+'\u0000'+String(requirement.target);
  if(unsupported.some(item=>item.key===key))continue;
  unsupported.push({key,...requirement,inactive:requirement.inactiveOrigins.length>0});
 }
 if(!active.length&&!prospective.length&&!unsupported.length&&!loaderNotices.length){panel.hidden=true;return;}
 panel.hidden=false;
 $('dependency-alert-title').textContent=active.some(row=>row.status==='missing'&&!row.workshopConditional)||loaderNotices.length?'Required dependency missing':active.some(row=>row.workshopConditional)?'Dependencies for your Workshop mods':prospective.some(row=>row.status==='missing')?'New mod needs dependencies':'Dependencies to check';
 const canReviewDownload=!!(active.length||prospective.length||loaderNotices.length);
 $('dependency-alert-summary').textContent=canReviewDownload?(vortexContext(value)?'Dependencies used by your mods. Missing files are marked below.':'These are file checks. Download from the author, review changes here, then test in game.'):'Read each mod’s author instructions. This tool has no download link for these requirements.';
 $('dependency-alert-choose').hidden=!canReviewDownload;
 const addRow=(row,prospectiveOnly)=>{
  const names=row.requiredBy.map(id=>consumerName(id,modNames,dependencyNames));
  const item=el('article',undefined,'dependency-alert-item'+(prospectiveOnly?' dependency-alert-prospective':''));
  const identity=el('strong',row.name||row.id);identity.translate=false;item.append(identity);
  const context=prospectiveOnly?'Inactive mod'+(names.length===1?'':'s')+' '+names.join(', ')+' will need this before being enabled.':
    names.join(', ')+(row.workshopConditional?' (Workshop, if used) requires ':' requires ')+(row.name||row.id)+'.';
  let guidance='Download this dependency from its author.';
  if(unverifiedVersion(row))guidance=versionCheckText(row);
  else if(row.status==='review')guidance=row.reviewReason==='duplicate-providers'?'Multiple copies found. Review which copy you use.':row.reviewReason==='identity-conflict'?'The files do not match this dependency. Check the author’s instructions.':row.needsNativePlacement?'Download the author’s files to install this plugin.':'Files found. Review the installation details.';
  else if(row.missingNativeFile)guidance=`${row.missingNativeFile} is missing from KCSE/Plugins. Download the complete plugin from its author.`;
  else if(row.status==='disabled')guidance='Files found, but this dependency is not in the mod list.';
  else if(['incomplete','located','misplaced','blocked','ambiguous'].includes(row.status))guidance='Check the files and repair this dependency.';
  item.append(el('p',context+' '+guidance));
  const actions=el('div',undefined,'dependency-alert-actions');
  if(row.needsNativePlacement||row.reviewReason==='workshop-native-placement'){
   item.append(el('p','This plugin needs files outside Steam’s Workshop folder. Download the author’s archive below; the app will check it and offer Install and format files. Existing Workshop files stay in Steam’s folder.','small'));
   const button=el('button','Download '+(row.name||row.id));button.addEventListener('click',()=>run(()=>call(row.id==='asi'?'open-asi-author':'open-nexus',...(row.id==='asi'?[]:[row.id]))));actions.append(button);
  }else if(workshopProviders(row).length&&['disabled','incomplete','located','misplaced','blocked','ambiguous','review'].includes(row.status)){
   item.append(el('p',row.needsNativePlacement||row.reviewReason==='workshop-native-placement'?'Files found in Steam Workshop storage, but the native DLL is not installed where its loader expects it. Workshop activation alone is insufficient. Open the author page and follow its manual or Vortex installation instructions; keep Steam-managed files in place.':'This provider is in Steam Workshop storage. Check its download and your Steam subscriptions and custom mod list; direct repairs here must not replace Steam-managed files.','small'));
   for(const provider of workshopProviders(row)){const button=workshopButton(provider);if(button)actions.append(button);}
  }else if(vortexContext(value)&&['disabled','incomplete','located','misplaced','blocked','ambiguous'].includes(row.status)){
   item.append(el('p','Vortex-managed files','small'));
   const button=el('button','Show installation details');button.dataset.help='Show installation details';
   button.addEventListener('click',()=>{if(!busy){setDependencyMode(true);$('findings-details').open=true;$('plugins-panel').scrollIntoView({block:'start'});}});actions.append(button);
  }else if(row.status==='disabled'){
   const button=el('button','Show installation details');button.dataset.help='Show why this dependency is not enabled. Nothing changes.';
   button.addEventListener('click',()=>{if(!busy){setDependencyMode(true);$('findings-details').open=true;$('plugins-panel').scrollIntoView({block:'start'});}});actions.append(button);
  }else if(row.missingNativeFile){
   const button=el('button','Download '+(row.name||row.id));button.dataset.help='Open the author’s download page. Nothing is installed.';
   button.addEventListener('click',()=>run(()=>call('open-nexus',row.id)));actions.append(button);
  }else if(['incomplete','located','misplaced','blocked','ambiguous'].includes(row.status)){
   const button=el('button','Repair dependency');button.dataset.help='Choose the author’s ZIP or 7z and review its files before installing.';
   button.addEventListener('click',()=>{if(!busy)$('download').click();});actions.append(button);
  }else{
   const button=el('button',unverifiedVersion(row)?'Check dependency version':row.status==='review'?'Open author page':'Download '+(row.name||row.id));
   button.dataset.help='Open the author’s page in your browser. Nothing is installed.';
   button.addEventListener('click',()=>run(async()=>{if(row.id==='asi')await call('open-asi-author');else await call('open-nexus',row.id);}));actions.append(button);
  }
  item.append(actions);items.append(item);
 };
 for(const row of active)addRow(row,false);
 for(const notice of loaderNotices){
  const item=el('article',undefined,'dependency-alert-item dependency-alert-loader');
  item.append(el('strong','ASI plugin loader needed'));
  item.append(el('p',(notice.consumers?.length?'Needed by '+notice.consumers.join(', ')+'. ':'')+(notice.detail||'These ASI plugins need a loader. Use Ultimate ASI Loader or a KCSE build that supports ASI loading.')));
  const actions=el('div',undefined,'dependency-alert-actions'),button=el('button','Download ASI Loader');
  button.dataset.help='Open the Ultimate ASI Loader author page. A compatible KCSE build may also load ASI plugins. Nothing is installed.';
  button.addEventListener('click',()=>run(()=>call('open-asi-author')));actions.append(button);item.append(actions);items.append(item);
 }
 for(const row of prospective)addRow(row,true);
 for(const row of unsupported){
  const item=el('article',undefined,'dependency-alert-item dependency-alert-unsupported');
  const consumer=row.inactive?row.inactiveOrigins.map(id=>consumerName(id,modNames,dependencyNames)).join(', '):consumerName(row.consumer,modNames,dependencyNames);
  const identity=el('strong',row.target);identity.translate=false;item.append(identity,el('p',(row.inactive?'Inactive mod ':'Mod ')+consumer+' lists this requirement. Check that mod’s author instructions; this tool has no download link for it.'));
  items.append(item);
 }
}
function drawRuntimeEvidence(evidence){
 const body=$('runtime-evidence-body'),expanded=new Set([...body.querySelectorAll('details.runtime-log[data-pinned="true"]')].map(node=>node.dataset.logKey));body.replaceChildren();
 body.append(el('p',evidence?.note||'These messages were saved by the game and may be out of date. Launch the game and try your mods to check that they work.','small'));
 const logs=Array.isArray(evidence?.logs)?evidence.logs:[];
 if(!logs.length){body.append(el('p','No game logs were checked in this scan.','small'));return;}
 const state={read:'Read',missing:'Not found',unreadable:'Could not read',skipped:'Not checked'};
 for(const log of logs){
  const section=el('details',undefined,'runtime-log'),summary=el('summary',log.file||'Game log'),content=el('div',undefined,'runtime-log-content');
  if(log.file){const file=el('span',log.file);file.translate=false;summary.replaceChildren(file);}section.dataset.logKey=log.file||'Game log';let pinned=expanded.has(section.dataset.logKey),timer;
  const pin=value=>{pinned=value;section.dataset.pinned=String(value);section.open=value;};pin(pinned);
  const closeLater=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!pinned&&!section.contains(document.activeElement))section.open=false;},180);};
  summary.title='Hover to preview. Click or press Enter to keep details open.';
  summary.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch'){clearTimeout(timer);section.open=true;}});
  section.addEventListener('pointerenter',()=>clearTimeout(timer));section.addEventListener('pointerleave',closeLater);section.addEventListener('focusout',closeLater);
  summary.addEventListener('click',event=>{event.preventDefault();clearTimeout(timer);pin(!pinned);});
  summary.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();clearTimeout(timer);pin(!pinned);}});
  section.addEventListener('keydown',event=>{if(event.key==='Escape'){clearTimeout(timer);pin(false);event.preventDefault();}});
  section.append(summary,content);
  const modified=log.modified?new Date(log.modified):null;
  const date=modified&&!Number.isNaN(modified.getTime())?modified.toLocaleString():'Date unavailable';
  const metadata=el('p',undefined,'small'),timestamp=el('span',date);timestamp.translate=!(modified&&!Number.isNaN(modified.getTime()));metadata.append(el('span',state[log.status]||'Unknown status'),el('span',' · File updated: '),timestamp);content.append(metadata);
  if(log.detail)content.append(el('p',log.detail,'small'));
  if(log.changedDuringRead)content.append(el('p','This log changed during the check. Check again for a stable result.','small'));
  if(log.truncated)content.append(el('p','Only the last part of this log was checked. Earlier messages may be missing.','small'));
  const clues=Array.isArray(log.clues)?log.clues:[];
  if(log.status==='read'&&clues.length){const list=el('ul',undefined,'runtime-clues');const kinds={startup:'Startup message in log',loaded:'Load message in log',activity:'Activity line in log',error:'Warning or error in log'};for(const clue of clues){const line=el('li'),name=el('span',clue.name||clue.plugin||'Mod'),raw=el('span',clue.line||'No line text');name.translate=false;raw.translate=false;line.append(name,document.createTextNode(' · '),el('span',kinds[clue.kind]||'Log line'),document.createTextNode(': '),raw);list.append(line);}content.append(list);}
  else content.append(el('p',log.status==='read'?'No relevant lines found. This does not confirm whether the mod works.':'No log clues available from this file.','small'));
  body.append(section);
 }
}
function drawFindings(findings){
 const items=(Array.isArray(findings)?findings:[]).filter(item=>item&&['error','review'].includes(item.severity));
 const panel=$('findings-panel'),list=$('findings-list'),details=$('findings-details');list.replaceChildren();panel.hidden=!items.length;details.open=items.length<=3;
 if(!items.length)return 0;
 const errors=items.filter(item=>item.severity==='error').length;
 $('findings-title').textContent='Items to check ('+items.length+')';
 $('findings-summary').textContent=(errors?errors+' problem'+(errors===1?'':'s')+(items.length>errors?' · ':''):'')+(items.length>errors?(items.length-errors)+' review note'+(items.length-errors===1?'':'s'):'')+'. These are file-scan findings, not a game test.';
 $('findings-toggle').textContent=items.length>3?'Show all '+items.length+' findings':'Show findings';
 for(const item of [...items].sort((a,b)=>(a.severity==='error'?0:1)-(b.severity==='error'?0:1))){
  const node=el('article',undefined,'finding '+item.severity);const heading=el('strong');heading.append(el('span',item.severity==='error'?'Problem: ':'Review: '),el('span',item.title||'Unnamed finding'));node.append(heading);
  if(item.detail)node.append(el('p',item.detail));
  if(Array.isArray(item.files)&&item.files.length)node.append(el('p','File'+(item.files.length===1?'':'s')+': '+item.files.join(' · '),'small'));
  list.append(node);
 }
 return items.length;
}
function showAutomaticOrder(automatic){
 const startup=$('order-startup');
 startup.hidden=!automatic?.message;startup.replaceChildren();startup.classList.toggle('created',automatic?.state==='created');
 if(automatic?.message)startup.append(el('p',automatic.message));
 if(['created','recovery'].includes(automatic?.state)&&automatic.receipt){undoKind='setup';showReceipt(automatic);startup.append(el('p',automatic.state==='created'?'Use Undo last change to remove this newly created list if its contents have not changed.':'Recovery needed. Undo last change will check the saved transaction before attempting recovery.','small'));}
}
function draw(value,{preserveReviews=false,quiet=false}={}){
  monitoringIncomplete=false;$('monitoring-notice').hidden=true;
  report=value;if(!preserveReviews)preview=null;
  const rows=uniqueDependencies(Array.isArray(value.dependencies)?value.dependencies:[]);
  drawDependencies(rows);drawDependencyAlert(value,rows);drawWorkshop(value);drawRuntimeEvidence(value.runtimeEvidence);const findingCount=drawFindings(value.findings);
  const active=rows.filter(item=>item&&(Array.isArray(item.requiredBy)&&item.requiredBy.length||item.status!=='missing'));
  const attention=active.filter(item=>!['installed','ready','found'].includes(item.status)).length;
  const summary=!rows.length?'No dependency results were returned. Check your game again.':attention?'Review '+attention+' needed or detected plugin'+(attention===1?'':'s')+' below. Optional plugins that are not installed need no action.':findingCount?'No needed plugins are missing. Review '+findingCount+' item'+(findingCount===1?'':'s')+' to check below.':'No needed plugins are missing. Optional plugins can stay uninstalled. ';
  $('summary').textContent=summary;
  showAutomaticOrder(value.automaticOrder);
  const manager=value.vortex,note=$('manager-note');note.hidden=!vortexContext(value);note.replaceChildren();
  if(vortexContext(value)){const details=el('details');details.append(el('summary','Vortex — advanced details'));details.append(el('p',manager.summary||manager.message||'Vortex records found.'));note.append(details);}
  $('download-guidance').textContent=vortexContext(value)?'Downloads are checked automatically while this app is open.':'Download a needed dependency from its author. Save the ZIP or 7z file in the folder below; you do not need to extract it.';
  if(!quiet){
    const dependenciesReady=rows.length>0&&attention===0&&findingCount===0&&!workshopContext(value);
    status(dependenciesReady?'✓ All set! '+summary:'Dependencies checked. '+summary,dependenciesReady?'success':'');
  }
}
function drawVortexBridge(){
 const ready=vortexBridge?.connected===true&&vortexBridge?.ready===true;
 $('vortex-connection').textContent=vortexBridge?.message||(report?'The Vortex helper is not connected.':'Check your game to connect with Vortex.');
 $('vortex-connection').className='notice'+(ready?' success':'');
 $('vortex-profile').textContent=ready&&vortexBridge.profileName?'Selected Vortex profile: '+vortexBridge.profileName:'';
 $('vortex-profile').hidden=!$('vortex-profile').textContent;
 if(ready)$('download-guidance').textContent='Downloads are checked automatically while this app is open.';
 sync();
}
async function refreshVortexBridge(foreground=true){
 if(!foreground&&(busy||vortexPolling||!report))return;
 if(vortexPolling)return;vortexPolling=true;sync();
 const checkedReport=report,checkedGame=$('game').value.trim();
 if(!checkedReport){vortexBridge=null;vortexPolling=false;drawVortexBridge();return;}
 try{const value=await call('vortex-bridge-status');if(report===checkedReport&&$('game').value.trim()===checkedGame&&(foreground||!busy)){if(vortexBridge?.ready&&value?.profileId!==vortexBridge.profileId&&archive)markStaleReview();vortexBridge=value||{connected:false,ready:false,message:'The Vortex helper is not connected.'};}}
 catch(error){if(report===checkedReport&&$('game').value.trim()===checkedGame)vortexBridge={connected:false,ready:false,message:'Could not connect to Vortex. '+(error.message||String(error))};}
 vortexPolling=false;drawVortexBridge();
}
async function scan(){reset();status('Checking your game and installed mods…');const value=await call('scan',$('game').value.trim());draw(value);await refreshDownloads(true);await refreshVortexBridge();}
async function discover(){status('Looking for installed copies of the game…');const games=await call('discover');$('choices').replaceChildren();if(games.length===1){await selectGame(games[0].root);await scan();}else if(games.length){status('More than one installation found. Choose the one you play.');for(const game of games){const button=el('button',`${(game.distribution||'Game').toUpperCase()} · ${game.root}`);button.translate=false;button.addEventListener('click',()=>run(async()=>{await selectGame(game.root);$('choices').replaceChildren();await scan();}));$('choices').append(button);}}else{$('game').placeholder='Select your KingdomComeDeliverance2 folder';status('Game not found automatically. Use Browse to choose your game folder.');}}
function warningText(warning){return typeof warning==='string'?warning:typeof warning?.detail==='string'?warning.detail:typeof warning?.message==='string'?warning.message:'An item needs manual review.';}
function appendOrderNames(container,label,names){
 if(!Array.isArray(names)||!names.length)return;
 const details=el('details');details.open=names.length<=8;details.append(el('summary',label+' ('+names.length+')'));
 const list=el('ul');for(const name of names)list.append(el('li',name));details.append(list);container.append(details);
}
bind('retry-check',async()=>{automaticReviews.clear();if($('game').value.trim())await scan();else await discover();});
$('change-game').addEventListener('click',()=>{if(!busy)$('browse').click();});
bind('detect',discover);bind('browse',async()=>{const path=await call('browse','folder');if(path){await selectGame(path);await scan();}});bind('browse-exe',async()=>{const path=await call('browse','exe');if(path){await selectGame(path);await scan();}});bind('scan',scan);
bind('launch-devmode',async()=>{const plan=await call('launch-devmode');status(plan.kind==='steam'?'Asked Steam to start the game with -devmode. Approve the launch option if Steam asks.':'Started the game with -devmode.','success');});
bind('undo',async()=>{const result=await change(undoKind==='setup'?'undo-setup':'undo');if(result){undoKind=null;await scan();status('Last change undone. Your dependencies have been checked again.','success');}});
function archiveStateLabel(state){return {missing:'New file',conflict:'Replace existing file',identical:'Already installed'}[state]||'File';}
function showArchive(value){if(!value)return;clearStaleReview();archive=value;$('archive-review').hidden=false;const files=value.files||[];const count=state=>files.filter(file=>file.state===state).length;const summary=`${count('missing')} new · ${count('conflict')} replace · ${count('identical')} already installed`;const plan=$('download-plan');plan.replaceChildren(document.createTextNode(summary+'\n\n'+(value.warning||'Review the files below.')+((value.blockers||[]).length?'\n\nCannot install:\n'+value.blockers.join('\n'):'')+'\n\n'));files.forEach((file,index)=>{if(index)plan.append(document.createTextNode('\n\n'));const source=el('span',file.source),target=el('span',file.target);source.translate=false;target.translate=false;plan.append(el('span',archiveStateLabel(file.state)),document.createTextNode(' · '),source,document.createTextNode('\n→ '),target);});plan.append(document.createTextNode('\n\nOther files ignored: '+(value.ignored||[]).length));const alreadyInstalled=files.length>0&&files.every(file=>file.state==='identical')&&!(value.blockers||[]).length;const message=alreadyInstalled?'The supported files in this download are already installed. No changes needed.':value.canApply===false?'This download cannot be installed yet. Review the items shown.':'Download checked. Review where its files will go.';$('archive-result').textContent=message;status(message);$('archive-review').scrollIntoView({block:'nearest'});}
async function reviewArchive(name,...args){clearPlans();try{showArchive(await call(name,...args));}catch(error){if(/ENOENT/.test(error.message))throw Error('That download could not be found. Choose the file again or refresh your downloads.');throw error;}}
function drawDownloads(value){
  automaticCandidates=Array.isArray(value.candidates)?value.candidates:[];
  const snapshot=JSON.stringify(value);if(snapshot===downloadSnapshot)return;downloadSnapshot=snapshot;
  $('download-folder').textContent='Watching: '+(value.folders?.length?value.folders.join(' · '):value.folder||'No folder selected');
  const count=Array.isArray(value.pending)?value.pending.length:Number(value.pending)||0;
  $('download-watch-status').textContent=value.warning||(count?count+' download(s) still in progress. Finished archives will appear here.':'Checking this folder every 5 seconds. Choose the version you want to review.');
  $('download-candidates').replaceChildren();
  if(!(value.candidates||[]).length)$('download-candidates').append(el('p','No completed dependency archives found yet. Save the author’s download to this folder, or use Choose ZIP or 7z.','download-empty'));
  for(const candidate of value.candidates||[]){
    const row=el('article',undefined,'download-candidate'),info=el('div');const identity=el('strong',candidate.name);identity.translate=false;info.append(identity);
    const date=new Date(candidate.mtimeMs),size=Number(candidate.size)||0;
    info.append(el('p',(size/1048576).toFixed(1)+' MB'+(Number.isNaN(date.getTime())?'':' · '+date.toLocaleString()),'small'));
    if(candidate.dependencyHints?.length)info.append(el('p','Possible match: '+candidate.dependencyHints.join(', '),'small'));
    const review=el('button','Review files');review.disabled=busy||!report;review.addEventListener('click',()=>run(()=>reviewArchive('check-found-download',candidate.path)));row.append(info,review);$('download-candidates').append(row);
  }
}
async function refreshDownloads(foreground=false){
  if(!report||(!foreground&&(busy||downloadPolling)))return;
  const generation=downloadGeneration;if(!foreground){downloadPolling=true;sync();}
  try{const value=await call('find-downloads');if(generation===downloadGeneration&&(foreground||!busy))drawDownloads(value);}
  catch(error){if(generation===downloadGeneration&&(foreground||!busy)){downloadSnapshot=null;$('download-watch-status').textContent='Could not check downloads. Use Choose ZIP or 7z or Refresh.';}}
  finally{if(!foreground){downloadPolling=false;sync();}}
}
bind('download',()=>reviewArchive('check-download'));
bind('choose-extracted',()=>reviewArchive('check-extracted-folder'));
bind('dependency-alert-choose',()=>reviewArchive('check-download'));
bind('refresh-downloads',()=>refreshDownloads(true));
bind('choose-download-folder',async()=>{const value=await call('choose-download-folder');if(value)drawDownloads(value);});
bind('recover',async()=>{const result=await change('recover-setup');if(result){undoKind=null;showReceipt(result);if($('game').value.trim())await scan();status('Previous repair restored.','success');}});
async function checkModChanges(){
 if(!report||busy||modChangePolling)return;
 modChangePolling=true;sync();
 let view=null,ownsBusy=false;
 try{
  const checkedReport=report,checkedGame=$('game').value.trim();
  const result=await call('check-mod-changes');
  if(busy||report!==checkedReport||$('game').value.trim()!==checkedGame)return;
  if(result?.waiting){
   if(!monitoringIncomplete){markStaleReview();status(result.detail?'Automatic checking could not finish. Results may be out of date.':'Mods are changing. Waiting for Steam or Vortex to finish…');}
   monitoringIncomplete=true;$('monitoring-notice').hidden=false;sync();return;
  }
  if(!result?.changed&&!(monitoringIncomplete&&result&&!result.waiting&&!result.busy&&result.available!==false))return;
  const focused=document.activeElement,card=focused?.closest?.('.dependency-card'),alertItem=focused?.closest?.('.dependency-alert-item');
  view={scroll:document.scrollingElement?.scrollTop,mainScroll:document.querySelector('main')?.scrollTop,
   focusId:focused?.id||null,cardId:card?.dataset.dependencyId||null,
   cardButton:card?[...card.querySelectorAll('button')].indexOf(focused):-1,
   alertRow:alertItem?[...$('dependency-alert-items').children].indexOf(alertItem):-1,
   alertButton:alertItem?[...alertItem.querySelectorAll('button')].indexOf(focused):-1};
  busy=true;ownsBusy=true;downloadGeneration++;markStaleReview();
  status('Mods changed. Checking dependencies again…');sync();
  const value=await call('scan',$('game').value.trim());
  draw(value,{preserveReviews:true,quiet:true});
  await refreshDownloads(true);
  await refreshVortexBridge();
  status(staleReview?'Mods changed; review files and mod list again before making a change.':'Mods changed. Dependencies checked again.');
 }catch(error){monitoringIncomplete=true;status('Could not recheck changed mods: '+(error.message||String(error)),'error');}
 finally{
  modChangePolling=false;
  if(ownsBusy)busy=false;
  sync();
  if(view){
   const card=view.cardId?[...$('dependencies').querySelectorAll('.dependency-card')].find(node=>node.dataset.dependencyId===view.cardId):null;
   const alertItem=view.alertRow>=0?$('dependency-alert-items').children[view.alertRow]:null;
   const target=card&&view.cardButton>=0?card.querySelectorAll('button')[view.cardButton]:
    alertItem&&view.alertButton>=0?alertItem.querySelectorAll('button')[view.alertButton]:view.focusId?$(view.focusId):null;
   target?.focus({preventScroll:true});
   if(document.scrollingElement&&Number.isFinite(view.scroll))document.scrollingElement.scrollTop=view.scroll;
   const main=document.querySelector('main');if(main&&Number.isFinite(view.mainScroll))main.scrollTop=view.mainScroll;
  }
 }
}
window.addEventListener('focus',()=>{refreshDownloads();checkModChanges();refreshVortexBridge(false);});
setInterval(()=>{refreshDownloads();checkModChanges();refreshVortexBridge(false);autoReviewDownload();},5000);
bind('install',async()=>{const result=await change('install-download');if(result){undoKind='download';showReceipt(result);await scan();status('Dependency files installed and backed up. Test your mods in game.','success');}});
bind('export',async()=>{const result=await call('export-download');if(result)status('Manual-layout files exported to '+result.destination+'. '+(vortexContext()?'This is not a Vortex installer. For Vortex-managed dependencies, use the author’s archive and Vortex installation instructions.':'Follow INSTALL.txt, then check dependencies again.'),'success');});
bind('export-vortex',async()=>{const result=await call('export-vortex-download');if(result)status('Vortex packages exported to '+result.destination+'. Read INSTALL.txt first: install the included helper extension, then import the dependency packages, Enable and Deploy in Vortex. Check dependencies again afterward.','success');});
bind('refresh-vortex',refreshVortexBridge);
$('vortex-setup').addEventListener('click',()=>{$('vortex-advanced').open=true;const setup=$('vortex-advanced').querySelector('details');if(setup)setup.open=true;});
bind('export-vortex-helper',async()=>{const result=await call('export-vortex-helper');if(result)status('Helper saved to '+result.destination+'. Install this ZIP in Vortex Extensions, enable it, restart Vortex, then choose Check connection here.');});
bind('install-vortex',async()=>{
 if(!archive||vortexBridge?.connected!==true||vortexBridge?.ready!==true)throw Error('Review a dependency archive and connect to Vortex first.');
 if(archive.vortexBlockers?.length)throw Error('Resolve the Vortex installation blockers before continuing.');
 const resultNode=$('vortex-operation-result');resultNode.hidden=false;resultNode.textContent='Waiting for Vortex. Respond to any conflict or permission prompt there; do not submit this installation again.';
 clearPlans();status('Installing through Vortex…');
 let result;
 try{result=await call('install-with-vortex');}
 catch(error){vortexBridge=null;drawVortexBridge();resultNode.textContent='The Vortex result is unknown. Check Vortex before retrying; some steps may already have finished. '+(error.message||String(error));throw error;}
 if(!result){resultNode.textContent='No Vortex installation result was returned. Check Vortex before retrying.';vortexBridge=null;drawVortexBridge();return;}
 const message=result.message||(result.state==='completed'?'Vortex finished importing, enabling and deploying the reviewed dependency.':'Vortex needs attention. Check its prompts and installation status before retrying.');
 resultNode.textContent=message+(result.receipt?' Vortex operation record: '+result.receipt:'');
 if(result.state==='completed'){
  try{await scan();status(message+' Dependencies checked again.','success');}
  catch(error){status(message+' Could not refresh dependency results: '+(error.message||String(error)),'error');}
 }else{vortexBridge=null;drawVortexBridge();status(message,result.state==='failed'?'error':'');}
});
$('cancel').addEventListener('click',async()=>{cancellable=false;sync();try{await call('cancel');status('Cancelling safely…');}catch(error){status(error.message,'error');}});
window.checker.progress(message=>status(message));window.checker.cancellable(value=>{cancellable=value;sync();});
async function startup(){
 let saved;try{saved=await call('get-preferences');}catch{}
 if(saved?.gameRoot){try{await selectGame(saved.gameRoot);await scan();return;}catch{reset();}}
 await discover();
}
sync();run(startup);

function syncRecommendedInstall(){
 const button=$('install-recommended');if(!button)return;
 const changes=archive?.files?.some(f=>f.state!=='identical');
 const managed=vortexContext()||vortexBridge?.ready===true;
 const target=managed?'install-vortex':'install';
 button.dataset.target=target;
 button.textContent=!changes&&archive?'Files already installed':managed?'Install with Vortex':'Install and format files';
 button.disabled=busy||!archive||!changes||$(target).disabled;
 $('install-route').textContent=!archive?'Review a download first.':!changes?'No reinstall needed.':managed?(vortexBridge?.ready?'Vortex will import, enable and deploy this download in '+(vortexBridge.profileName||'the selected profile')+'.': 'The Vortex helper is not connected.'):'The app will place these files in the checked game folder and save a recovery record.';
}
$('install-recommended').addEventListener('click',()=>{const target=$($('install-recommended').dataset.target);if(target&&!target.disabled)target.click();});
async function autoReviewDownload(){
 if(busy||!report||archive||preview||monitoringIncomplete)return;
 if(report.workshop?.pending||report.workshop?.complete===false||report.workshop?.items?.some(item=>['pending','missing'].includes(item.state)))return;
 const needed=new Set((report.dependencies||[]).filter(d=>(['missing','incomplete','misplaced'].includes(d.status)||d.needsNativePlacement||d.reviewReason==='workshop-native-placement')&&(d.requiredBy?.length||d.conditionalRequiredBy?.length)).map(d=>d.id));
 const matches=automaticCandidates.filter(c=>c.dependencyHints?.some(id=>needed.has(id)));
 const unambiguous=matches.filter(candidate=>candidate.dependencyHints.filter(id=>needed.has(id)).every(id=>matches.filter(other=>other.dependencyHints.includes(id)).length===1));
 if(!unambiguous.length)return;
 const file=unambiguous.find(candidate=>!automaticReviews.has(JSON.stringify([$('game').value,candidate.path,candidate.size,candidate.mtimeMs,candidate.fingerprint])));
 if(!file)return;
 const key=JSON.stringify([$('game').value,file.path,file.size,file.mtimeMs,file.fingerprint]);
 if(automaticReviews.has(key))return;automaticReviews.add(key);
 await run(()=>reviewArchive('check-found-download',file.path));
}
