'use strict';
// Vortex-side bridge. Only explicit, authenticated prepared-package requests run.
// All game writes are delegated to Vortex's public actions/events.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),zlib=require('node:zlib');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const wire=require('./bridge-protocol');
const {discoverWorkshop,inspectWorkshop}=require('./workshop');
const GAME='kingdomcomedeliverance2',VERSION='0.2.6',run=promisify(execFile);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const key=value=>path.resolve(value).toLowerCase();
// KCD2 Vortex extension 1.1.1 ignores **/readme*, **/license*, **/changelog*.
// Only these exact documentation basenames may be absent; runtime files and
// prefixed Sound Framework companions still require deployed byte equality.
const deploymentReason=c=>c.selectedActivator==='hardlink_activator'&&c.availableActivator==='hardlink_activator'?'':'The formatter requires Hardlink Deployment. Select it in Vortex Settings > Mods, or manage this dependency directly in Vortex.';
const optionalDocumentation=target=>/^(readme|license|changelog)\.(txt|md)$/i.test(path.basename(target));
const stat=async p=>fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
async function plain(p,{file=false}={}){
 let cursor=path.resolve(p);
 for(;;){const s=await stat(cursor);if(s&&(s.isSymbolicLink()||s.isFile()&&s.nlink>1))throw Error('Bridge path is linked or shared.');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
 const s=await stat(p);if(file&&(!s?.isFile()||s.nlink!==1))throw Error('Bridge package must be an independent regular file.');return s;
}
async function gameClosed(){
 if(process.platform!=='win32')throw Error('The Vortex bridge supports Windows only.');
 const {stdout}=await run('tasklist.exe',['/FI','IMAGENAME eq KingdomCome.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:5000});
 return !/^"KingdomCome\.exe"/im.test(stdout);
}
function archivePath(name){
 if(typeof name!=='string'||name.length>240||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/'))throw Error('Unsafe prepared archive path.');
 const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[<>"|?*]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe prepared archive path.');return name;
}
async function validateArchive(file,destination,validatePrepared,maxExpandedBytes=512*1024*1024){
 const Zip=require('adm-zip'),zip=new Zip(file),entries=zip.getEntries();
 if(entries.length>3001)throw Error('Prepared archive has too many entries.');
 let total=0;const names=[],seen=new Set();
 await fs.mkdir(destination);
 for(const entry of entries){
  if(entry.isDirectory)continue;
  const name=archivePath(entry.entryName),lower=name.toLowerCase();if(seen.has(lower))throw Error('Duplicate prepared archive path.');seen.add(lower);
  if(entry.header.flags&1)throw Error('Encrypted packages are unsupported.');
  const size=entry.header.size;if(!Number.isSafeInteger(size)||size<0||size>80*1024*1024||(total+=size)>maxExpandedBytes)throw Error('Prepared archives expand beyond the combined limit.');
  const compressed=entry.getCompressedData();
  const bytes=entry.header.method===0?compressed:entry.header.method===8?zlib.inflateRawSync(compressed,{maxOutputLength:Math.max(1,size+1)}):null;
  if(!bytes||bytes.length!==size)throw Error('Invalid prepared archive compression or size.');
  const output=path.join(destination,...name.split('/'));await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes,{flag:'wx'});names.push(name);
 }
 if(!seen.has('kcd2-dependency-layout.json'))throw Error('Only formatter-prepared packages can be sent to Vortex.');
 const instructions=await validatePrepared(names,destination);
 const layout=JSON.parse(await fs.readFile(path.join(destination,'kcd2-dependency-layout.json'),'utf8'));
 return {layout,instructions:instructions.instructions,expandedBytes:total};
}
function createVortexAdapter(api,vortex,{timeoutMs=14*60*1000}={}){
 function bounded(operation){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{const error=Error('Vortex did not finish this step in time. It may still be running. Check Vortex and restart it before another formatter request.');error.uncertain=true;reject(error);},timeoutMs);Promise.resolve().then(operation).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}
 function context(){
  const state=api.store.getState(),profile=vortex.selectors.activeProfile(state),discovery=vortex.selectors.discoveryByGame(state,GAME);
  let availableActivator;try{availableActivator=vortex.util.getCurrentActivator(state,GAME,false)?.id;}catch{}
  const selectedActivator=state.settings?.mods?.activator?.[GAME];
  return {profileId:profile?.id,profileName:profile?.name||'',gameId:profile?.gameId,gameRoot:discovery?.path,nextProfileId:state.settings?.profiles?.nextProfileId,
   toolsRunning:Object.keys(state.session?.base?.toolsRunning||{}).length>0,selectedActivator,availableActivator,profile,state};
 }
 const callback=(name,args,{importIds=false}={})=>bounded(()=>new Promise((resolve,reject)=>{
  const cb=(error,value)=>importIds?resolve(error):error?reject(error instanceof Error?error:Error(String(error))):resolve(value);
  const emitted=api.events.emit(name,...args,cb);if(emitted===false)reject(Error('Vortex has no handler for '+name));
 }));
 return {context,
  inspectProviders:async(prepared,{baseDir,accepted,request,validatePrepared,guard})=>{
   const current=await guard(),state=current.state||api.store.getState(),all=Object.values(state.persistent?.mods?.[GAME]||{});
   if(all.length>1000)throw Error('Too many Vortex providers to verify safely. Review this dependency in Vortex.');
   const staging=vortex.selectors.installPathForGame(state,GAME);if(!staging||!path.isAbsolute(staging))throw Error('Vortex staging path is unavailable.');await plain(staging);
   const mapped=vortex.util.getGame(GAME).getModPaths(request.gameRoot),providers=[];let inspected=0;
   async function inventory(directory,prefix='',depth=0){
    if(depth>32)throw Error('Vortex provider nesting exceeds the verification limit.');
    const entries=await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;}),files=[];
    for(const entry of entries){if(++inspected>30000)throw Error('Vortex provider scan limit reached. Review this dependency in Vortex.');const full=path.join(directory,entry.name),s=await fs.lstat(full);if(s.isSymbolicLink())throw Error('Linked Vortex staging paths require manual review.');const relative=prefix?prefix+'/'+entry.name:entry.name;if(s.isDirectory())files.push(...await inventory(full,relative,depth+1));else if(s.isFile())files.push({relative,full,size:s.size});else throw Error('Unsupported staged file type.');}return files;
   }
   for(const mod of all){
    const mappedBase=mapped[mod.type];if(!mappedBase||!path.isAbsolute(mappedBase))continue;
    const relativeBase=path.relative(request.gameRoot,mappedBase);if(relativeBase==='..'||relativeBase.startsWith('..'+path.sep)||path.isAbsolute(relativeBase))continue;
    if(mod.state==='installing')throw Error('Wait for Vortex to finish its current installation before continuing.');
    if(mod.state!=='installed')continue;
    if(typeof mod.id!=='string'||typeof mod.installationPath!=='string'||path.isAbsolute(mod.installationPath)||mod.installationPath.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'))throw Error('Invalid installed Vortex provider identity.');
    const directory=path.join(staging,mod.installationPath);await plain(directory);const files=await inventory(directory);
    const download=state.persistent?.downloads?.files?.[mod.archiveId],local=download?.localPath;
    const match=typeof local==='string'?/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-(dependency-[a-z0-9_.-]+\.zip)$/i.exec(local):null;
    providers.push({mod,files,download,match,mappedBase});
   }
   const reused=new Map(),used=new Set(),verifiedProviders=[];let priorExpanded=0;
   const verifyStaging=async(provider,layout)=>{
    const fresh=api.store.getState().persistent?.mods?.[GAME]?.[provider.mod.id];
    if(!fresh||fresh.state!=='installed'||fresh.type!==provider.mod.type||fresh.archiveId!==provider.mod.archiveId||fresh.installationPath!==provider.mod.installationPath)throw Error('Existing Vortex provider identity changed. Review it again.');
    const directory=path.join(staging,fresh.installationPath);await plain(directory);const files=await inventory(directory);
    if(files.length!==layout.files.length)throw Error('Existing Vortex dependency staging has added or missing files. Repair it in Vortex first.');
    for(const f of layout.files){const stored=files.find(x=>x.relative.toLowerCase()===f.destination.toLowerCase());if(!stored||stored.size!==f.bytes||sha(await fs.readFile(stored.full))!==f.sha256)throw Error('Existing Vortex dependency staging has changed. Repair it in Vortex first.');}
   };
   for(let index=0;index<prepared.length;index++){
    await guard();const pkg=prepared[index],destinations=new Set(pkg.layout.files.map(f=>key(path.join(mapped[pkg.type],...f.destination.split('/'))))),folder=pkg.layout.kind==='mods'?pkg.layout.files[0].destination.split('/')[0].toLowerCase():null;
    const packageName=path.basename(pkg.file).replace(/^[a-f0-9-]{36}-/i,'');
    const candidates=providers.filter(p=>p.files.some(f=>destinations.has(key(path.join(p.mappedBase,...f.relative.split('/')))))||folder&&key(p.mappedBase)===key(mapped[pkg.type])&&[p.mod.attributes?.modFolderDerived,p.mod.attributes?.modRootPath].some(x=>typeof x==='string'&&x.toLowerCase()===folder)||p.match?.[2]?.toLowerCase()===packageName.toLowerCase());
    if(!candidates.length)continue;
    if(candidates.length!==1)throw Error('Multiple Vortex mods provide this dependency. Resolve duplicate providers in Vortex before continuing.');
    const provider=candidates[0],{mod,match,download}=provider;
    if(mod.type!==pkg.type||!match||download?.state!=='finished'||!Array.isArray(download.game)||!download.game.includes(GAME))throw Error('This dependency is already provided by another Vortex mod. Update or repair that mod in Vortex; no duplicate was imported.');
    const priorDir=path.join(baseDir,'accepted',match[1]),priorFile=path.join(priorDir,'host-receipt.json');await plain(priorFile,{file:true});
    const priorStat=await fs.stat(priorFile);if(priorStat.size>4*1024*1024)throw Error('Previous formatter receipt exceeds the verification limit.');
    const prior=JSON.parse(await fs.readFile(priorFile,'utf8'));
    if(prior.id!==match[1]||prior.state!=='completed'||key(prior.gameRoot)!==key(request.gameRoot)||!Array.isArray(prior.modIds)||!prior.modIds.includes(mod.id)||!Array.isArray(prior.expected))throw Error('Existing Vortex dependency has no matching completed formatter receipt. Review it in Vortex.');
    const snapshot=path.join(priorDir,download.localPath);await plain(snapshot,{file:true});const st=await fs.stat(snapshot);if(st.size>wire.MAX_PACKAGE_BYTES)throw Error('Previous dependency package is too large.');
    const checked=await validateArchive(snapshot,path.join(accepted,'prior-provider-'+index),validatePrepared,512*1024*1024-priorExpanded);priorExpanded+=checked.expandedBytes;
    if(checked.instructions.find(x=>x.type==='setmodtype')?.value!==pkg.type)throw Error('Existing dependency type changed. Review it in Vortex.');
    const destinationBase=vortex.util.getGame(GAME).getModPaths(request.gameRoot)[pkg.type];
    const signature=layout=>layout.files.map(f=>[f.destination.toLowerCase(),f.sha256.toLowerCase(),f.bytes]).sort((a,b)=>a[0].localeCompare(b[0]));
    if(JSON.stringify(signature(checked.layout))!==JSON.stringify(signature(pkg.layout)))throw Error('A different version of this dependency is already installed in Vortex. Update the existing mod in Vortex first; no duplicate was imported.');
    for(const f of checked.layout.files){const target=key(path.join(destinationBase,...f.destination.split('/')));if(!prior.expected.some(x=>typeof x.target==='string'&&key(x.target)===target&&x.sha256===f.sha256))throw Error('Previous dependency receipt does not match its package.');}
    await verifyStaging(provider,checked.layout);verifiedProviders.push({provider,layout:checked.layout});
    if(used.has(mod.id))throw Error('Multiple packages map to one existing provider. Review them in Vortex.');used.add(mod.id);reused.set(index,mod.id);
   }
   reused.verify=async()=>{await guard();for(const item of verifiedProviders)await verifyStaging(item.provider,item.layout);};return reused;
  },
  importArchive:async archive=>{
   const expected=sha(await fs.readFile(archive)),ids=await callback('import-downloads',[[archive]],{importIds:true});
   if(!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=='string')throw Error('Vortex did not identify the imported archive.');
   const state=api.store.getState(),download=state.persistent?.downloads?.files?.[ids[0]];
   if(download?.state!=='finished'||!Array.isArray(download.game)||!download.game.includes(GAME)||typeof download.localPath!=='string'||path.basename(download.localPath)!==download.localPath)throw Error('Vortex archive metadata does not match the KCD2 import.');
   const root=vortex.selectors.downloadPathForGame(state,GAME),target=path.join(root,download.localPath);await plain(root);const s=await stat(target);
   if(!s?.isFile()||s.isSymbolicLink()||s.size>wire.MAX_PACKAGE_BYTES||sha(await fs.readFile(target))!==expected)throw Error('Vortex imported archive does not match the reviewed bytes.');return ids;
  },
  installDownload:async(id,profileId,type)=>{const modId=await callback('start-install-download',[id,{allowAutoEnable:false,profileId}]);const mod=api.store.getState().persistent?.mods?.[GAME]?.[modId];if(!modId||mod?.state!=='installed'||mod.archiveId!==id||mod.type!==type)throw Error('Vortex installed mod metadata does not match the reviewed package type.');return modId;},
  enableMods:async(profileId,ids)=>{await bounded(()=>vortex.actions.setModsEnabled(api,profileId,ids,true,{allowAutoDeploy:false}));const state=api.store.getState();for(const id of ids)if(state.persistent?.profiles?.[profileId]?.modState?.[id]?.enabled!==true)throw Error('Vortex did not enable an imported dependency.');},
  paths:root=>vortex.util.getGame(GAME).getModPaths(root),
  ensureLoadOrder:async(profileId,imports,root,guard)=>{
   if(!imports.length)return;
   const rows=api.store.getState().persistent?.loadOrder?.[profileId];if(!Array.isArray(rows))throw Error('Vortex load order is not ready. Review its Load Order page.');
   for(const imported of imports){
    await guard();const current=api.store.getState().persistent?.loadOrder?.[profileId],matches=Array.isArray(current)?current.filter(e=>typeof e.id==='string'&&e.id.toLowerCase()===imported.folder.toLowerCase()):[];
    if(matches.length!==1||matches[0].modId&&matches[0].modId!==imported.modId)throw Error('Vortex load-order identity is ambiguous for an imported dependency.');
    if(matches[0].enabled!==true)api.store.dispatch(vortex.actions.setFBLoadOrderEntry(profileId,{...matches[0],enabled:true}));
   }
   const order=path.join(vortex.util.getGame(GAME).getModPaths(root)[GAME+'-mod'],'mod_order.txt');
   for(let attempt=0;attempt<50;attempt++){
    await guard();const s=await stat(order);if(s?.isFile()&&!s.isSymbolicLink()&&s.size<=2*1024*1024){const lines=(await fs.readFile(order,'utf8')).replace(/^\uFEFF/,'').split(/\r\n|\r|\n/).map(x=>x.trim().toLowerCase());if(imports.every(m=>lines.filter(x=>x===m.folder.toLowerCase()).length===1))return;}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   throw Error('Vortex has not confirmed the dependency folders as active in mod_order.txt. Review its Load Order page.');
  },
  deploy:async(profileId,onProgress)=>{
   let observed=false;const listener=id=>{if(id===profileId)observed=true;};api.events.on('mods-did-deploy',listener);
   try{await bounded(()=>new Promise((resolve,reject)=>{const emitted=api.events.emit('deploy-mods',error=>error?reject(error):resolve(),profileId,(message,_percent)=>onProgress(String(message||'Vortex deployment in progress').slice(0,900)),{manual:true});if(emitted===false)reject(Error('Vortex deployment handler is unavailable.'));}));}
   finally{api.events.removeListener('mods-did-deploy',listener);}
   const state=api.store.getState(),failures=state.session?.mods?.deploymentFailures?.[GAME];
   return {observed,failed:Array.isArray(failures)?failures.length>0:!!failures&&Object.keys(failures).length>0,necessary:state.persistent?.deployment?.needToDeploy?.[GAME]===true};
  }
 };
}
async function workshopGuard(request){
 if(typeof request.workshopFingerprint!=='string'||! /^[a-f0-9]{64}$/.test(request.workshopFingerprint))throw Error('The Workshop review is missing. Rescan and prepare dependencies again.');
 const root=await fs.realpath(request.gameRoot),bin=request.gameBin;
 if(typeof bin!=='string'||!path.isAbsolute(bin)||!/^Bin\/Win64[^/]*$/i.test(path.relative(root,bin).replace(/\\/g,'/')))throw Error('The selected game executable directory is unavailable. Rescan before importing.');
 await plain(bin);for(const name of ['KingdomCome.exe','WHGame.dll']){const s=await stat(path.join(bin,name));if(!s?.isFile()||s.isSymbolicLink())throw Error('The selected game executable pair changed. Rescan before importing.');}
 const xbox=/xbox|store|gdk|gamepass/i.test(path.basename(bin))||!!await stat(path.join(root,'MicrosoftGame.config'));
 const distribution=xbox?'xbox':/steam/i.test(path.basename(bin))?'steam':/gog/i.test(path.basename(bin))?'gog':/epic/i.test(path.basename(bin))?'epic':'unknown';
 const found=await discoverWorkshop(root,{distribution});
 const inventory=await inspectWorkshop({root,workshopRoots:found.roots,workshopMetadataFiles:found.metadataFiles,workshopDiscoveryIssues:found.issues});
 if(!inventory.complete||inventory.pending||inventory.items.some(item=>['pending','missing'].includes(item.state)))throw Error('Steam Workshop could not be checked completely. Wait for Steam to finish, then rescan and prepare dependencies again.');
 if(inventory.fingerprint!==request.workshopFingerprint)throw Error('Steam Workshop changed since these dependencies were reviewed. Rescan and prepare dependencies again; no further installation steps were started.');
}
function createController(adapter,{baseDir,closed=gameClosed,validatePrepared,helperVersion=VERSION}={}){
 if(!baseDir||typeof validatePrepared!=='function')throw Error('Bridge storage and prepared-package validator required.');
 let busy=false,uncertain=false;
 async function status(){
  const c=adapter.context();let reason='';
  if(c.gameId!==GAME||!c.profileId||!c.gameRoot)reason='Select your KCD2 profile in Vortex.';
  else if(c.nextProfileId&&c.nextProfileId!==c.profileId)reason='Wait for Vortex to finish switching profiles.';
  else if(deploymentReason(c))reason=deploymentReason(c);
  else if(c.toolsRunning)reason='Close running game tools before installing.';
  else if(uncertain)reason='A prior request timed out and may still be running. Review Vortex and restart it before another formatter request.';
  else if(busy)reason='A formatter operation is already running in Vortex.';
  else {try{if(!await closed())reason='Close KCD2 before installing.';}catch(e){reason='Could not confirm that KCD2 is closed.';}}
  return {connected:true,ready:!reason,reason,message:reason||'Vortex is ready for the selected KCD2 profile.',profileId:c.profileId||null,profileName:c.profileName||'',gameRoot:c.gameRoot||null,helperVersion};
 }
 function currentContext(request,validatedRoot){
  const fresh=adapter.context();
  if(fresh.gameId!==GAME||fresh.profileId!==request.profileId||!fresh.gameRoot||key(fresh.gameRoot)!==key(validatedRoot))throw Error('The active Vortex game or profile changed. No further steps were started.');
  if(fresh.nextProfileId&&fresh.nextProfileId!==request.profileId)throw Error('Vortex is switching profiles.');
  if(deploymentReason(fresh))throw Error(deploymentReason(fresh));
  if(fresh.toolsRunning)throw Error('Close KCD2 and running game tools before continuing.');
  return fresh;
 }
 async function guard(request){
  const c=adapter.context(),validatedRoot=c.gameRoot;
  if(c.gameId!==GAME||c.profileId!==request.profileId||!validatedRoot||key(await fs.realpath(validatedRoot))!==key(await fs.realpath(request.gameRoot)))throw Error('The active Vortex game or profile changed. No further steps were started.');
  currentContext(request,validatedRoot);
  if(!await closed())throw Error('Close KCD2 and running game tools before continuing.');
  await workshopGuard(request);
  // Recheck after asynchronous work; the earlier context may now be stale.
  return currentContext(request,validatedRoot);
 }
 async function install(request,onProgress=()=>{}){
  wire.validateRequest(request);if(request.op!=='install')throw Error('Install request required.');
  if(busy)throw Error('Another formatter request is already running.');if(uncertain)throw Error('A timed-out operation may still be running. Review Vortex and restart it first.');busy=true;
  const accepted=path.join(baseDir,'accepted',request.id),receipt=path.join(accepted,'host-receipt.json');
  const fingerprint=sha(Buffer.from(JSON.stringify({gameRoot:key(request.gameRoot),gameBin:request.gameBin?key(request.gameBin):null,profileId:request.profileId,workshopFingerprint:request.workshopFingerprint,packages:request.packages})));
  let record={id:request.id,state:'needs-attention',phase:'validating',fingerprint,workshopFingerprint:request.workshopFingerprint,profileId:request.profileId,gameRoot:request.gameRoot,modIds:[],startedAt:new Date().toISOString(),receipt};
  let claimed=false,validatedRoot;
  const result=value=>({id:value.id,state:value.state,phase:value.phase,message:value.message||'Review the saved operation before retrying.',receipt:value.receipt,profileId:value.profileId,gameRoot:value.gameRoot,modIds:value.modIds,completedAt:value.completedAt,omittedDocumentation:(value.omittedDocumentation||[]).slice(0,32),omittedDocumentationCount:(value.omittedDocumentation||[]).length});
  const save=async()=>{await plain(accepted);const temp=path.join(accepted,'receipt-'+crypto.randomBytes(8).toString('hex')+'.tmp');await fs.writeFile(temp,JSON.stringify(record,null,2),{flag:'wx'});await fs.rename(temp,receipt);};
  const progress=message=>{try{onProgress(message.slice(0,900));}catch{}};
  try{
   validatedRoot=(await guard(request)).gameRoot;await plain(baseDir);await fs.mkdir(path.join(baseDir,'accepted'),{recursive:true});await plain(path.join(baseDir,'accepted'));
   try{await fs.mkdir(accepted);claimed=true;}catch(e){if(e.code!=='EEXIST')throw e;await plain(receipt,{file:true});const old=JSON.parse(await fs.readFile(receipt,'utf8'));if(old.fingerprint!==fingerprint)throw Error('Request identifier already belongs to different packages.');return {...result(old),replayed:true,message:'This request was already recorded. No operation was repeated.'};}
   await save();const prepared=[];let expandedBytes=0;
   for(let i=0;i<request.packages.length;i++){
    const item=request.packages[i],source=wire.packagePath(baseDir,request.id,item.name);const s=await plain(source,{file:true});if(s.size!==item.bytes)throw Error('Prepared package size changed.');
    const snapshot=path.join(accepted,request.id+'-'+item.name);await fs.copyFile(source,snapshot,fs.constants.COPYFILE_EXCL);await plain(snapshot,{file:true});
    const bytes=await fs.readFile(snapshot);if(bytes.length!==item.bytes||sha(bytes)!==item.sha256)throw Error('Prepared package hash changed.');
    const checked=await validateArchive(snapshot,path.join(accepted,'validated-'+i),validatePrepared,512*1024*1024-expandedBytes);expandedBytes+=checked.expandedBytes;if(expandedBytes>512*1024*1024)throw Error('Prepared archives expand beyond the combined limit.');prepared.push({file:snapshot,...checked});
   }
   // Validate the target mapping before importing anything.
   const paths=adapter.paths(request.gameRoot),expected=[];
   for(const pkg of prepared){const type=pkg.instructions.find(x=>x.type==='setmodtype')?.value,base=paths[type];if(!base||!path.isAbsolute(base))throw Error('Vortex did not provide a deployment path for this package.');
    const relative=path.relative(request.gameRoot,base).replace(/\\/g,'/');
    if(type===GAME+'-root'?key(base)!==key(request.gameRoot):type===GAME+'-mod'?key(base)!==key(path.join(request.gameRoot,'mods')):type===GAME+'-binaries'?!request.gameBin||key(base)!==key(request.gameBin)||!/^Bin\/Win64[^/]*$/i.test(relative):true)throw Error('Vortex deployment paths do not match the selected game and executable folder. Custom external paths need manual review.');
    await plain(base);pkg.type=type;for(const f of pkg.layout.files)expected.push({target:path.join(base,...f.destination.split('/')),sha256:f.sha256});}
   const targets=new Set();for(const f of expected){const target=key(f.target);if(targets.has(target))throw Error('Prepared packages target the same file.');targets.add(target);}
   const guardLoaders=async()=>{
    const aliases=['version.dll','dinput8.dll','winmm.dll','dsound.dll','d3d9.dll','dxgi.dll','xinput1_3.dll'];
    for(const f of expected)if(/^(dinput8|version)\.dll$/i.test(path.basename(f.target))){
     const current=await stat(f.target);if(current){if(!current.isFile()||current.isSymbolicLink()||sha(await fs.readFile(f.target))!==f.sha256)throw Error('A different shared loader already exists. Resolve its ownership before installing through Vortex.');continue;}
     for(const alias of aliases){const other=path.join(path.dirname(f.target),alias);if(key(other)===key(f.target))continue;const planned=expected.find(x=>key(x.target)===key(other));const s=await stat(other);if(planned?.sha256===f.sha256||s?.isFile()&&!s.isSymbolicLink()&&sha(await fs.readFile(other))===f.sha256)throw Error('The same loader already exists under another alias. Resolve duplicate loaders first.');}
    }
    const soundAsi=expected.some(f=>/KCD2_SoundFramework\.asi$/i.test(f.target)),soundKcse=expected.some(f=>/KCD2_SoundFramework\.dll$/i.test(f.target));
    if(soundAsi&&soundKcse)throw Error('Only one Sound Framework variant may be installed.');
    if(soundAsi){const global=path.join(request.gameRoot,'KCSE','Plugins','KCD2_SoundFramework.dll'),local=path.join(request.gameRoot,'mods','soundframework','KCSE','Plugins','KCD2_SoundFramework.dll');let active=!!await stat(global);if(await stat(local)){const order=await fs.readFile(path.join(request.gameRoot,'mods','mod_order.txt'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});active ||=order===null||order.split(/\r\n|\r|\n/).some(x=>x.trim().toLowerCase()==='soundframework');}if(active)throw Error('The KCSE Sound Framework variant is already active.');}
    if(soundKcse){const bin=paths[GAME+'-binaries'];if(!bin||!/^Bin\/Win64[^/]*$/i.test(path.relative(request.gameRoot,bin).replace(/\\/g,'/')))throw Error('Cannot verify the alternate Sound Framework path.');if(await stat(path.join(bin,'KCD2_SoundFramework.asi')))throw Error('The ASI Sound Framework variant is already present.');}
   };
   await guardLoaders();
   const reused=typeof adapter.inspectProviders==='function'?await adapter.inspectProviders(prepared,{baseDir,accepted,request,validatePrepared,guard:()=>guard(request)}):new Map();
   record.expected=expected;record.reusedModIds=[...reused.values()];record.phase='importing';await save();
   for(let i=0;i<prepared.length;i++){
    if(reused.has(i)){prepared[i].modId=reused.get(i);record.modIds.push(prepared[i].modId);await save();progress('Reusing verified dependency already installed in Vortex');continue;}
    await guard(request);record.phase='importing';record.packageIndex=i;await save();progress('Importing dependency '+(i+1)+' of '+prepared.length+' into Vortex');
    currentContext(request,validatedRoot);const ids=await adapter.importArchive(prepared[i].file);if(!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=='string'||!ids[0])throw Error('Vortex did not confirm the dependency archive import.');
    await guard(request);record.phase='installing';record.downloadId=ids[0];await save();currentContext(request,validatedRoot);const modId=await adapter.installDownload(ids[0],request.profileId,prepared[i].type);
    if(typeof modId!=='string'||!modId||modId.length>500)throw Error('Vortex did not confirm the dependency installation.');prepared[i].modId=modId;record.modIds.push(modId);await save();
   }
   await guard(request);if(reused.verify)await reused.verify();record.phase='enabling';await save();progress('Enabling dependencies in the selected Vortex profile');currentContext(request,validatedRoot);await adapter.enableMods(request.profileId,record.modIds);
   await guard(request);if(reused.verify)await reused.verify();await guardLoaders();record.phase='deploying';await save();progress('Deploying through Vortex. Respond to any Vortex conflict prompts.');currentContext(request,validatedRoot);const deployed=await adapter.deploy(request.profileId,progress);
   await guard(request);record.phase='verifying';await save();if(!deployed?.observed||deployed.failed||deployed.necessary)throw Error('Vortex did not confirm a clean completed deployment. Check its notifications before retrying.');
   record.omittedDocumentation=[];
   for(const f of expected){const s=await stat(f.target);if(!s&&optionalDocumentation(f.target)){record.omittedDocumentation.push(f.target);continue;}if(!s?.isFile()||s.isSymbolicLink()||sha(await fs.readFile(f.target))!==f.sha256)throw Error('A deployed dependency file does not match the reviewed package. Review Vortex conflicts.');}
   const imports=prepared.filter(p=>p.layout.kind==='mods').map(p=>({folder:p.layout.files[0].destination.split('/')[0],modId:p.modId}));
   if(imports.length){await guard(request);record.phase='activating-order';await save();if(typeof adapter.ensureLoadOrder!=='function')throw Error('Vortex load-order integration is unavailable.');currentContext(request,validatedRoot);await adapter.ensureLoadOrder(request.profileId,imports,request.gameRoot,()=>guard(request));}
   await guard(request);const finalContext=currentContext(request,validatedRoot);if(finalContext.profile&&record.modIds.some(id=>finalContext.profile.modState?.[id]?.enabled!==true))throw Error('A dependency was disabled in the Vortex profile before verification finished.');
   record.state='completed';record.phase='complete';record.completedAt=new Date().toISOString();record.message='Vortex installed, enabled and deployed the reviewed dependency runtime files.'+(record.omittedDocumentation.length?' Vortex omitted '+record.omittedDocumentation.length+' documentation file(s) from the game folder; the originals remain in the reviewed package.':'')+' Check dependencies again; gameplay remains untested.';await save();return result(record);
  }catch(error){if(error.uncertain)uncertain=true;record.state=record.phase==='validating'?'failed':'needs-attention';record.message=String(error.message||error).slice(0,3000);record.completedAt=new Date().toISOString();if(claimed)await save().catch(()=>{});return result(record);}
  finally{busy=false;}
 }
 return {status,install};
}
async function startBridge(context,options={}){
 const baseDir=options.baseDir||wire.bridgeRoot(process.env.APPDATA),vortex=options.apiModule||require('vortex-api');
 const validatePrepared=options.validatePrepared||require('./index').validatePrepared;
 await plain(baseDir);await fs.mkdir(baseDir,{recursive:true});
 const sessionFile=path.join(baseDir,'session.json'),existing=await stat(sessionFile);
 if(existing){await plain(sessionFile,{file:true});const prior=JSON.parse(await fs.readFile(sessionFile,'utf8'));try{process.kill(prior.pid,0);throw Error('Another Vortex bridge session is still running.');}catch(e){if(e.code!=='ESRCH')throw e;}}
 const descriptor=wire.validateDescriptor({protocol:wire.PROTOCOL,pipe:'\\\\.\\pipe\\kcd2-formatter-'+crypto.randomBytes(32).toString('hex'),token:crypto.randomBytes(32).toString('hex'),pid:process.pid,startedAt:new Date().toISOString(),helperVersion:VERSION});
 const controller=createController(options.adapter||createVortexAdapter(context.api,vortex),{baseDir,closed:options.closed||gameClosed,validatePrepared});
 const server=net.createServer(socket=>{
  socket.setTimeout(20*60*1000,()=>socket.destroy());let received=false;
  const send=value=>{if(!socket.destroyed)socket.write(wire.encodeFrame(value));};
  const parser=wire.createFrameParser(request=>{
   received=true;
   Promise.resolve().then(async()=>{
    wire.validateRequest(request);if(!wire.sameToken(request.token,descriptor.token))throw Error('Bridge authentication failed.');
    const value=request.op==='status'?await controller.status():await controller.install(request,message=>send({protocol:wire.PROTOCOL,id:request.id,type:'progress',message}));
    send({protocol:wire.PROTOCOL,id:request.id,ok:true,value});socket.end();
   }).catch(error=>{try{send({protocol:wire.PROTOCOL,id:request.id,ok:false,error:String(error.message||error).slice(0,3000)});}finally{socket.end();}});
  });
  socket.on('data',chunk=>{try{parser(chunk);}catch{socket.destroy();}});socket.on('end',()=>{if(!received)socket.destroy();});socket.on('error',()=>{});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(descriptor.pipe,resolve);});server.on('error',()=>{});
 const temp=path.join(baseDir,'session-'+crypto.randomBytes(8).toString('hex')+'.tmp');await fs.writeFile(temp,JSON.stringify(descriptor),{flag:'wx',mode:0o600});await fs.rename(temp,sessionFile);
 return {descriptor,controller,close:async()=>{await new Promise(resolve=>server.close(resolve));try{const current=JSON.parse(await fs.readFile(sessionFile,'utf8'));if(wire.sameToken(current.token,descriptor.token))await fs.unlink(sessionFile);}catch{}}};
}
module.exports={startBridge,createController,createVortexAdapter,validateArchive,gameClosed};

