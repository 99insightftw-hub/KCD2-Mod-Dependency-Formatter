'use strict';
const fs=require('fs/promises'),path=require('path');
const {XMLParser,XMLValidator}=require('fast-xml-parser');
const {resolveGame,exists}=require('./discovery');
const {hash,hashFile,zipInspect,boundedWalk,nativeInfo,safeRelative}=require('./io');
const {catalog,canonical,fingerprints,gameReferences}=require('./catalog');
const {MISC_IDS}=require('./misc-profile');
const {inspectWorkshop}=require('./workshop');
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:true});
function parseManifest(bytes) {
  const text=bytes.toString('utf8').replace(/^\uFEFF/,'');
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Manifest has unsupported entity declarations.');
  const valid=XMLValidator.validate(text);if(valid!==true)throw Error(`Manifest XML: ${valid.err.msg} (line ${valid.err.line})`);
  const tree=parser.parse(text),info=tree.kcd_mod?.info;if(!info)throw Error('Manifest lacks kcd_mod/info.');
  const deps=[];
  function collect(node) {
    if(!node)return;
    if(typeof node==='string'){for(const d of node.split(/[,;\s]+/))if(d)deps.push({id:d});return;}
    if(Array.isArray(node)){node.forEach(collect);return;}
    if(typeof node==='object') {
      const id=node['@_modid']||node['@_id']||node.modid||node.id||node['#text'];
      if(id)deps.push({id:String(id),version:node['@_version']||node.version||null,optional:['true','1'].includes(String(node['@_optional']||node.optional).toLowerCase())});
      else for(const v of Object.values(node))collect(v);
    }
  }
  collect(info.dependencies);collect(tree.kcd_mod.dependencies);
  return {id:String(info.modid||'').trim(),name:String(info.name||'').trim(),version:String(info.version||'').trim(),deps};
}
function parseOrder(bytes) {
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('Load order must contain valid UTF-8.');}
  if(text.includes('\0'))throw Error('Load order contains NUL bytes; review its encoding.');
  return text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/).map((raw,index)=>({raw,index,name:raw.trim()})).filter(x=>x.name&&!/^(#|;|\/\/)/.test(x.name));
}
async function vortexState(game) {
  const manifests=[],errors=[],markers=[];
  const counts={recorded:0,present:0,missing:0,linkedToStaging:0,stagingOnly:0,stagingUnverified:0,unreadable:0,unchecked:0};
  const maxChecks=2000;let checked=0;
  const readStat=async file=>fs.stat(file,{bigint:true}).catch(e=>{if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;});
  for(const dir of [...new Set([game.root,game.mods,game.bin])]) {
    const names=await fs.readdir(dir).catch(e=>{if(e.code!=='ENOENT')errors.push({path:dir,error:'Cannot check Vortex deployment: '+e.message});return [];});
    for(const name of names)if(/^vortex\.deployment(?:\..*)?\.json$/i.test(name)) {
      const file=path.join(dir,name);
      try {
        const st=await fs.lstat(file);
        if(!st.isFile()||st.size>20*1024*1024)throw Error('Deployment manifest is not a bounded regular file');
        const bytes=await fs.readFile(file),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        const m=require('./ownership').parseLedger(text.replace(/^\uFEFF/,''));
        if(m.gameId&&m.gameId!=='kingdomcomedeliverance2')throw Error('Deployment game identity differs');
        if(!Array.isArray(m.files)||m.files.length>100000)throw Error('Unsupported deployment manifest');
        if(m.version!==undefined&&m.version!==1)throw Error('Unsupported Vortex deployment version');
        if(m.targetPath!==undefined&&(typeof m.targetPath!=='string'||!path.isAbsolute(m.targetPath)))throw Error('Deployment target must be absolute');
        const target=path.resolve(m.targetPath||dir);
        if(![game.root,game.mods].some(base=>target.toLowerCase()===path.resolve(base).toLowerCase()||target.toLowerCase().startsWith(path.resolve(base).toLowerCase()+path.sep)))throw Error('Deployment target belongs to another installation');
        const files=[],seen=new Set();
        for(const entry of m.files) {
          if(!entry||typeof entry.relPath!=='string'||entry.target!==undefined&&typeof entry.target!=='string')throw Error('Invalid Vortex deployment file record');
          const relative=safeRelative(entry.relPath),sub=entry.target?safeRelative(entry.target):'';
          const deployed=path.resolve(target,sub,relative),key=deployed.toLowerCase();
          if(seen.has(key))throw Error('Duplicate deployment path');seen.add(key);
          files.push({path:deployed,source:String(entry.source||''),relative});
        }
        // Read metadata only. Staging contents never become installed providers.
        // Bound filesystem probes; uninspected entries are explicitly unknown.
        const observed=Object.fromEntries(Object.keys(counts).map(key=>[key,0]));
        for(const entry of files) {
          observed.recorded++;
          if(checked++>=maxChecks){observed.unchecked++;entry.presence='unchecked';continue;}
          try {
            const deployed=await readStat(entry.path);
            let staged=null;
            if(typeof m.stagingPath==='string'&&path.isAbsolute(m.stagingPath)&&entry.source){
              try {staged=await readStat(path.join(m.stagingPath,safeRelative(entry.source),entry.relative));}catch(e){observed.stagingUnverified++;entry.stagingError='Staging identity could not be checked: '+e.message;}
            }
            if(deployed?.isFile()){
              observed.present++;entry.presence='present';
              if(staged?.isFile()&&deployed.dev===staged.dev&&deployed.ino!==0n&&deployed.ino===staged.ino){observed.linkedToStaging++;entry.linkedToStaging=true;}
            }else if(!deployed){observed.missing++;entry.presence='missing';if(staged?.isFile()){observed.stagingOnly++;entry.stagingOnly=true;}}
            else {observed.unreadable++;entry.presence='not-file';}
          }catch{observed.unreadable++;entry.presence='unverified';}
        }
        // A deploy/purge may replace the ledger while its file identities are inspected.
        // Do not combine old records with a new deployment or promote partial evidence.
        const after=await fs.lstat(file);
        if(!after.isFile()||after.size>20*1024*1024||hash(await fs.readFile(file))!==hash(bytes))throw Error('Vortex deployment changed during this scan. Wait for deployment to finish and check again.');
        for(const key of Object.keys(counts))counts[key]+=observed[key];
        manifests.push({path:file,sha256:hash(bytes),method:m.deploymentMethod,staging:m.stagingPath,target,files,deploymentTime:Number.isFinite(m.deploymentTime)?m.deploymentTime:null});
      }catch(e){errors.push({path:file,error:e.message});}
    }
  }
  const folders=await fs.readdir(game.mods,{withFileTypes:true}).catch(()=>[]);
  for(const folder of folders.filter(e=>e.isDirectory()||e.isSymbolicLink()).slice(0,3000)){
    const marker=path.join(game.mods,folder.name,'__folder_managed_by_vortex');
    try{if(await readStat(marker))markers.push(marker);}catch{errors.push({path:marker,error:'Cannot verify Vortex folder marker'});}
  }
  if(folders.length>3000)errors.push({path:game.mods,error:'Vortex folder-marker inspection limit reached'});
  const detected=manifests.length>0||errors.length>0||markers.length>0;
  const deploymentStatus=counts.linkedToStaging?'linked-deployment':counts.present?'files-present':counts.unreadable||counts.unchecked||errors.length?'unverified':detected?'records-only':'none';
  let summary='';
  if(deploymentStatus==='linked-deployment')summary=counts.linkedToStaging+' deployed file(s) share their file identity with Vortex staging.';
  else if(deploymentStatus==='files-present')summary=counts.present+' file(s) listed by Vortex are present in the game; their link to staging is unverified.';
  else if(deploymentStatus==='records-only')summary='Vortex records or folder markers remain, but this scan found no confirmed deployed files from those records. They may be old; they do not prove Vortex is currently in use.';
  else if(detected)summary='Vortex records could not be fully verified.';
  if(detected){
    if(counts.missing)summary+=' '+counts.missing+' recorded file(s) are absent from the game.';
    if(counts.stagingOnly)summary+=' '+counts.stagingOnly+' of these were found only in staging and do not count as installed.';
    if(counts.stagingUnverified)summary+=' '+counts.stagingUnverified+' staging identity check(s) could not be completed; deployed-file presence is reported separately.';
    if(counts.unchecked||counts.unreadable)summary+=' '+(counts.unchecked+counts.unreadable)+' recorded file(s) remain unverified.';
    summary+=' Vortex profile enable switches are unknown; results describe deployed files and the game load-order file. Load-order ownership needs review: Vortex can write mod_order.txt without listing it in a deployment ledger.';
  }
  const action=detected?'If you use Vortex, select the KCD2 profile you play, enable the intended mods, Deploy, then use its Load Order page and check here again. If you no longer use Vortex, review the remaining manager records before making direct load-order changes.':'';
  const controlled=new Set(manifests.flatMap(m=>m.files.map(f=>f.path.toLowerCase())));
  return {detected,manifests,errors,markers,counts,deploymentStatus,profileState:'unknown',orderMayBeManaged:detected,summary,action,
    managed:file=>controlled.has(path.resolve(file).toLowerCase())};
}
// This is an evidence allowlist only. Setup repair keeps its separate Elfis allowlist.
const setupIds=new Set(['elfis_combat','kcdutils','luautils','mcm','ptfextender',...catalog.filter(c=>c.importable).map(c=>c.id),...MISC_IDS]);
function setupIdentity(info,folder){return setupIds.has(String(info.id).toLowerCase())||setupIds.has(canonical(info.id))||setupIds.has(canonical(info.name))||setupIds.has(folder.toLowerCase());}
async function setupMod(root,folder){
 try{const file=path.join(root,'mod.manifest');if((await fs.stat(file)).size>256*1024)return setupIds.has(folder.toLowerCase());return setupIdentity(parseManifest(await fs.readFile(file)),folder);}
 catch{return setupIds.has(folder.toLowerCase());}
}
async function setupDataFiles(data){
 const files=[],errors=[];
 const st=await fs.lstat(data);if(st.isSymbolicLink())return {files,errors:[{path:data,error:'Linked dependency Data folder; use its owning manager.'}]};
 const entries=await fs.readdir(data,{withFileTypes:true});if(entries.length>3000)throw Error('Dependency Data file-count limit reached.');
 for(const e of entries){if(e.isFile()&&/\.(pak|lua)$/i.test(e.name))files.push(path.join(data,e.name));}
 return {files,errors};
}
async function dependencyLayout(game) {
  const rows=[],errors=[];
  async function list(dir,accept=()=>true) {
    let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];errors.push({path:dir,code:e.code});return [];}
    if(entries.length>3000)throw Error('Dependency layout scan limit reached: '+dir);
    for(const e of entries.filter(accept))rows.push(path.join(dir,e.name));
    return entries;
  }
  const native=e=>/\.(dll|asi|bin)$/i.test(e.name);
  const pluginResource=e=>native(e)||/\.(ini|amg|txt)$/i.test(e.name);
  await list(game.root,native);await list(game.bin,e=>native(e)||/^KCD2_SoundFramework_(?:moods\.ini|lipmodel\.bin)$/i.test(e.name)||/^KCD2_SoundFramework\.ini$/i.test(e.name));
  await list(path.join(game.root,'KCSE/Plugins'),pluginResource);
  await list(path.join(game.root,'KCSE/addresslib'),native);
  const mods=await list(game.mods,e=>e.isDirectory()||e.isSymbolicLink()||/\.(dll|asi)$/i.test(e.name));
  for(const e of mods.filter(e=>(e.isDirectory()||e.isSymbolicLink())&&!e.name.startsWith('.'))) {
    const root=path.join(game.mods,e.name);
    if(game.scanScope==='elfis'&&!await setupMod(root,e.name))continue;
    await list(root,e=>e.name.toLowerCase()==='mod.manifest');
    await list(path.join(root,'KCSE/Plugins'),pluginResource);
    if(catalog.some(c=>c.importable&&!c.nativeOnly&&c.id===e.name.toLowerCase()))await list(path.join(root,'Localization'),e=>e.isFile()&&/\.pak$/i.test(e.name));
    const data=path.join(root,'Data');
    const entry=await fs.lstat(data).catch(e=>{if(e.code!=='ENOENT')errors.push({path:data,code:e.code});return null;});
    if(entry){
      const result=game.scanScope==='elfis'?await setupDataFiles(data):await boundedWalk(data,{maxDepth:2,maxFiles:3000});
      rows.push(...result.files.filter(f=>/\.(pak|lua)$/i.test(f)));
      errors.push(...result.errors.map(e=>({path:e.path,error:e.error})));
    }
  }
  const workshop=await inspectWorkshop(game);
  for(const item of workshop.items)for(const mod of item.modRoots){
    await list(mod.root,e=>e.name.toLowerCase()==='mod.manifest');
    await list(path.join(mod.root,'KCSE/Plugins'),pluginResource);
    const data=path.join(mod.root,'Data');
    const entry=await fs.lstat(data).catch(e=>{if(e.code!=='ENOENT')errors.push({path:data,code:e.code});return null;});
    if(entry){const result=await boundedWalk(data,{maxDepth:2,maxFiles:3000});rows.push(...result.files.filter(f=>/\.(pak|lua)$/i.test(f)));errors.push(...result.errors.map(e=>({path:e.path,error:e.error})));}
  }
  rows.sort();errors.sort((a,b)=>a.path.localeCompare(b.path));
  return {hash:hash(Buffer.from(JSON.stringify({rows,errors,workshop:workshop.fingerprint}))),incomplete:errors.length>0||!workshop.complete};
}
async function scan(input,{modsPath=null,workshopPath=null,scope=null,activateLocal=false,onProgress=()=>{}}={}) {
  const game=await resolveGame(input);if(scope==='elfis')game.scanScope='elfis';if(modsPath)game.mods=path.resolve(modsPath);if(workshopPath){game.workshop=path.resolve(workshopPath);game.workshopRoots=[game.workshop];game.workshopMetadataFiles=[];}
  if(await exists(path.join(game.mods,'__vortex_staging_folder')))throw Error('Choose deployed mods, not Vortex staging.');
  const layout=await dependencyLayout(game);
  const findings=[],mods=[],binaries=[],hints=[],requirements=[],snapshots={};
  const add=(severity,title,detail,files=[],extra={})=>findings.push({id:'finding-'+findings.length,severity,title,detail,files,...extra});
  if(layout.incomplete)add('error','Dependency layout inspection is incomplete','A deployed dependency path could not be inspected. Direct repairs are blocked until these paths are accessible and a new scan completes.',[game.mods,game.bin]);
  const vortex=await vortexState(game);
  for(const e of vortex.errors)add('review','Vortex deployment could not be verified',e.error,[e.path]);
  const orderPath=path.join(game.mods,'mod_order.txt');const orderBytes=await fs.readFile(orderPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  const order=orderBytes?parseOrder(orderBytes):[],orderMap=new Map();
  if(orderBytes)snapshots[orderPath]=hash(orderBytes);
  for(const entry of order) {
    const key=entry.name.toLowerCase();if(orderMap.has(key))add('review','Duplicate load-order entry',entry.name,[orderPath],{repair:'order'});
    else orderMap.set(key,entry);
  }
  const seenRoots=new Set(),localLoadNames=new Set();let totalLuaBytes=0;
  async function readMod(root,folder,workshop,workshopItem=null) {
    let real;try{real=await fs.realpath(root);}catch(e){add('error','Broken mod folder/link',e.message,[root]);return;}
    if(seenRoots.has(real.toLowerCase())){add('review','Same mod folder appears twice','Linked/manual/Workshop paths resolve to the same folder.',[root]);return;}
    seenRoots.add(real.toLowerCase());
    const manifestPath=path.join(root,'mod.manifest');let bytes;
    try {bytes=await fs.readFile(manifestPath);if(bytes.length>256*1024)throw Error('Manifest size limit reached');}
    catch(e) {
      if(e.code==='ENOENT') {
        // Only two levels of wrappers, never a whole-game recursive search.
        for(const child of (await fs.readdir(root,{withFileTypes:true}).catch(()=>[])).slice(0,100))if(child.isDirectory()||child.isSymbolicLink()) {
          if(await exists(path.join(root,child.name,'mod.manifest')))add('error','Extra folder around a mod',`Move the inner ${child.name} mod folder to the deployed mods root. In Vortex, reinstall the download with the correct installer.`,[path.join(root,child.name,'mod.manifest')]);
        }
        if(!workshop&&(/lua|utils|mcm|ptf|misc|kcse/i.test(folder)||setupIds.has(folder.toLowerCase())))add('review','Mod folder has no manifest',folder,[root]);
      }else add('error','Cannot read mod manifest',e.message,[manifestPath]);return;
    }
    let info;try{info=parseManifest(bytes);}catch(e){add('error','Invalid mod manifest',e.message,[manifestPath]);return;}
    // A valid local manifest resolves its load-order entry even when its
    // payload is outside this setup scan's supported-mod scope.
    localLoadNames.add((workshop?(info.id||folder):folder).toLowerCase());
    if(game.scanScope==='elfis'&&!setupIdentity(info,folder))return;
    const identity=info.id||folder,loadName=workshop?identity:folder;
    // Steam Workshop activation is independent of local mod_order.txt.
    // Files and Steam download metadata do not prove the game's enable switch.
    const active=workshop?null:activateLocal||!orderBytes||orderMap.has(loadName.toLowerCase());
    const source=workshop?'workshop':'local',activationState=workshop?'unknown':active?'enabled':'disabled';
    const workshopItemId=workshopItem?.itemId||null;
    const workshopUrl=workshopItemId&&/^\d+$/.test(workshopItemId)?'https://steamcommunity.com/sharedfiles/filedetails/?id='+workshopItemId:null;
    const m={...info,id:identity,declaredId:info.id,folder,loadName,root,workshop,source,activationState,workshopItemId,workshopUrl,workshopState:workshopItem?.state||null,active,manifestPath,manifestHash:hash(bytes),native:[],entries:[],lua:[],pakCount:0,inspectedPakCount:0};mods.push(m);snapshots[manifestPath]=m.manifestHash;
    if(!workshop&&orderMap.has(folder.toLowerCase())&&orderMap.get(folder.toLowerCase()).name!==folder)add('review','Load-order casing differs',`${orderMap.get(folder.toLowerCase()).name} → ${folder}`,[orderPath],{repair:'order'});
    if(info.id&&info.id.toLowerCase()!==folder.toLowerCase()&&!workshop)add('review','Manifest ID differs from folder',`${folder} declares ${info.id}. This can be intentional; check author instructions before renaming.`,[manifestPath]);
    const kcsePlugins=path.join(root,'KCSE/Plugins');
    for(const name of await fs.readdir(kcsePlugins).catch(()=>[]))if(/\.dll$/i.test(name))m.native.push(path.join(kcsePlugins,name));
    const data=path.join(root,'Data');let dataFiles=[];
    // lstat preserves broken junctions: stat/exists would silently hide them.
    const dataEntry=await fs.lstat(data).catch(e=>{if(e.code==='ENOENT')return null;add('error','Cannot inspect mod Data path',e.message,[data]);return null;});
    if(dataEntry)try{
      const result=game.scanScope==='elfis'?await setupDataFiles(data):await boundedWalk(data,{maxDepth:2,maxFiles:3000});dataFiles=result.files;
      for(const e of result.errors)add('error','Cannot inspect mod Data path',e.error,[e.path]);
    }catch(e){add('review','Data scan limit reached',e.message,[data]);}
    if(catalog.some(c=>c.importable&&!c.nativeOnly&&c.id===(canonical(m.id)||m.id))) {
      const localization=path.join(root,'Localization');
      for(const name of await fs.readdir(localization).catch(()=>[]))if(/\.pak$/i.test(name))dataFiles.push(path.join(localization,name));
    }
    const paks=dataFiles.filter(f=>/\.pak$/i.test(f));m.pakCount=paks.length;
    for(const pak of paks) {
      onProgress('Checking '+folder+' / '+path.basename(pak));
      try {
        const before=await hashFile(pak);
        const mcmResources=canonical(m.id||m.name)==='mcm';
        const optionalResources=catalog.some(c=>c.importable&&!c.nativeOnly&&c.id===(canonical(m.id)||m.id));
        const result=await zipInspect(pak,{
          read:(name,e)=>optionalResources||/\.lua$/i.test(name)&&/^Scripts\/Mods\//i.test(name)&&e.uncompressedSize<=1024*1024&&totalLuaBytes+e.uncompressedSize<32*1024*1024||mcmResources&&(/^Libs\/UI\/UIElements\/MCM\.xml$/i.test(name)||/^Libs\/UI\/.*mcm.*\.gfx$/i.test(name)),
          maxEntryBytes:mcmResources||optionalResources?8*1024*1024:1024*1024,
          maxReadBytes:mcmResources||optionalResources?32*1024*1024:12*1024*1024
        });
        m.entries.push(...result.entries.filter(e=>!e.directory).map(e=>e.name));
        for(const [name,content] of result.contents)if(/\.lua$/i.test(name)&&/^Scripts\/Mods\//i.test(name)){totalLuaBytes+=content.length;m.lua.push({path:pak+' :: '+name,text:content.toString('utf8')});}
        if(await hashFile(pak)!==before)throw Error('PAK changed during inspection. Scan again.');
        m.inspectedPakCount++;
        snapshots[pak]=before;
      }catch(e){add('error','Cannot inspect mod PAK',e.message,[pak]);}
    }
    // Search only Scripts subtrees in loose packages, without walking textures.
    const loose=new Set(dataFiles.filter(f=>/\.lua$/i.test(f)));
    const scriptRoots=[path.join(data,'Scripts')];
    for(const e of await fs.readdir(data,{withFileTypes:true}).catch(()=>[]))if(e.isDirectory())scriptRoots.push(path.join(data,e.name,'Scripts'));
    for(const r of scriptRoots)if(await exists(r))try {
      const result=await boundedWalk(r,{maxDepth:8,maxFiles:3000});
      for(const f of result.files)if(/\.lua$/i.test(f))loose.add(f);
      for(const e of result.errors)add('error','Broken script path',e.error,[e.path]);
    }catch(e){add('review','Loose-script scan limit reached',e.message,[r]);}
    for(const f of loose)try {
      if((await fs.stat(f)).size>1024*1024||totalLuaBytes>32*1024*1024)continue;
      const b=await fs.readFile(f);totalLuaBytes+=b.length;m.lua.push({path:f,text:b.toString('utf8')});snapshots[f]=hash(b);
      const r=path.relative(data,f).replace(/\\/g,'/'),start=r.toLowerCase().indexOf('scripts/');if(start>=0)m.entries.push(r.slice(start));
    }catch(e){add('review','Cannot read a loose Lua script',e.message,[f]);}
    for(const dep of info.deps)requirements.push({consumer:m.id,loadName:m.loadName,target:canonical(dep.id)||dep.id,kind:dep.optional?'optional':'declared',version:dep.version,active:m.active,activationState:m.activationState,source:m.source});
    if(game.scanScope==='elfis'&&m.active&&MISC_IDS.includes(m.id.toLowerCase()))for(const target of ['kcse','luautils','kcdutils','luadb','ptfextender'])requirements.push({consumer:m.id,loadName:m.loadName,target,kind:'profile',active:true});
    if(m.active!==false&&!canonical(m.id))for(const lua of m.lua) {
      // Hints require review: a protected/optional API use is not a hard dependency.
      const text=lua.text.replace(/--\[\[[\s\S]*?\]\]/g,'').replace(/--[^\r\n]*/g,'');
      for(const [target,re] of [['kcdutils',/\bKCDUtils\s*[.:]/],['luautils',/\b(?:RTTR|SKALD|EquipmentManager|AudioManager|wh)\s*[.:]/],['luadb',/\bLuaDB\s*[.:]|\bDB\s*\.\s*Create\s*\(/],['mcm',/\bMCM\s*[.:]/]])if(re.test(text)&&!hints.some(h=>h.consumer===m.id&&h.target===target))hints.push({consumer:m.id,target,path:lua.path,kind:'possible'});
      if(/\bKCDUtils\s*\.\s*(Config|DB)\b/.test(text)&&!hints.some(h=>h.consumer===m.id&&h.target==='luadb'))hints.push({consumer:m.id,target:'luadb',path:lua.path,kind:'conditional'});
    }
  }
  onProgress('Reading installed mods');
  const localEntries=await fs.readdir(game.mods,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  if(localEntries.length>1000)throw Error('Installed mods exceed the 1000-entry scan limit; no complete dependency result can be produced.');
  for(const e of localEntries)if((e.isDirectory()||e.isSymbolicLink())&&!e.name.startsWith('.'))await readMod(path.join(game.mods,e.name),e.name,false);
  const workshop=await inspectWorkshop(game);
  for(const issue of workshop.issues)add('review','Workshop content needs review',typeof issue==='string'?issue:issue.message||issue.error||issue.reason||JSON.stringify(issue),issue.path?[issue.path]:[]);
  if(workshop.pending&&!workshop.items.some(item=>item.state==='pending'))add('review','Steam Workshop download is pending','Let Steam finish downloading or updating Workshop content, then check again.',workshop.metadataFiles);
  for(const item of workshop.items){
    if(item.state==='pending')add('review','Steam Workshop download is pending','Let Steam finish downloading or updating this item, then check again.',[item.itemRoot],{workshopItemId:item.itemId});
    if(item.state==='missing')add('review','Steam Workshop files are missing','Steam records this item, but its files were not found. Check its download in Steam.',[item.itemRoot],{workshopItemId:item.itemId});
    for(const mod of item.modRoots)await readMod(mod.root,path.basename(mod.root),true,item);
  }
  for(const entry of order)if(!mods.some(m=>m.loadName.toLowerCase()===entry.name.toLowerCase())&&!(game.scanScope==='elfis'&&localLoadNames.has(entry.name.toLowerCase())))add('review','Listed mod was not resolved locally',`${entry.name}. It may be an unavailable Workshop mod; its order entry is retained.`,[orderPath]);
  const identities=new Map();for(const m of mods) {
    const key=m.id.toLowerCase();if(identities.has(key))add('error','Duplicate mod identity',m.id,[identities.get(key).root,m.root]);else identities.set(key,m);
  }
  const nativePaths=[];
  for(const name of await fs.readdir(game.bin))if(/\.asi$/i.test(name)||catalog.filter(c=>c.kind==='loader').some(c=>c.files.includes(name.toLowerCase())))nativePaths.push({file:path.join(game.bin,name),owner:null,active:true,placed:true});
  for(const name of await fs.readdir(path.join(game.root,'KCSE/Plugins')).catch(()=>[]))if(/\.(dll|asi)$/i.test(name))nativePaths.push({file:path.join(game.root,'KCSE/Plugins',name),owner:null,active:true,placed:true});
  for(const m of mods)for(const file of m.native)nativePaths.push({file,owner:m.id,active:m.active,activationState:m.activationState,workshop:m.workshop,workshopItemId:m.workshopItemId,workshopUrl:m.workshopUrl,loaderReachable:!m.workshop,placed:!m.workshop});
  // Catch common manual misplacements without scanning the entire game.
   const misplacedNames=new Set(catalog.flatMap(c=>c.files||[]).map(s=>s.toLowerCase()));
   for(const dir of [game.root,game.mods])for(const name of await fs.readdir(dir).catch(()=>[]))if(misplacedNames.has(name.toLowerCase()))nativePaths.push({file:path.join(dir,name),owner:null,active:false,placed:false});
  onProgress('Checking native dependencies');
  for(const n of nativePaths)try {
     if(game.scanScope==='elfis'&&!n.owner&&!catalog.some(c=>c.files?.some(f=>f.toLowerCase()===path.basename(n.file).toLowerCase())))continue;
    const info=await nativeInfo(n.file),sha256=await hashFile(n.file),base=path.basename(n.file).toLowerCase();
     const known=fingerprints[sha256];let dependency=known||catalog.find(c=>['plugin','asi'].includes(c.kind)&&c.files?.some(f=>f.toLowerCase()===base))?.id||null;
    let recognized=!!known;
    if(!dependency&&base==='dinput8.dll') {
      const bytes=await fs.readFile(n.file),ascii=bytes.toString('latin1');
      if(/KCSE v|KCSE_Plugin|KCSE\\logs|Address library not found|KCSEAPI/.test(ascii)){dependency='kcse';recognized=true;}
      else if(/Ultimate ASI Loader|Ultimate-ASI-Loader/.test(ascii)||bytes.includes(Buffer.from('Ultimate ASI Loader','utf16le'))){dependency='asi';recognized=true;}
    }
    if(!dependency&&catalog.find(c=>c.id==='asi').files.includes(base)) {
      const bytes=await fs.readFile(n.file);
      if(bytes.includes(Buffer.from('Ultimate ASI Loader','utf16le'))||bytes.includes(Buffer.from('Ultimate-ASI-Loader'))){dependency='asi';recognized=true;}
    }
    snapshots[n.file]=sha256;
    binaries.push({...n,...info,sha256,dependency,recognized,managed:vortex.managed(n.file)});
    if(dependency&&!known)add('review','Native dependency version is unverified',`${base} has a recognized name or identifying strings, but its hash is not a tested reference. File presence is not compatibility proof.`,[n.file]);
    if(!info.valid||info.architecture!=='x64')add('error','Native file is not valid x64',info.reason||`${base} is ${info.architecture}`,[n.file]);
    if(!n.placed)add('error','Dependency binary is in the wrong folder',`${base}: install using the dependency author’s documented layout.`,[n.file]);
    if(!dependency&&base==='dinput8.dll')add('review','Unrecognized dinput8.dll','This could be KCSE, an ASI loader, or another proxy. Its filename alone cannot identify it. Do not overwrite it blindly.',[n.file]);
  }catch(e){add('error','Cannot inspect native dependency',e.message,[n.file]);}
  const duplicates=new Map();for(const b of binaries.filter(b=>b.active&&b.placed&&b.dependency&&catalog.find(c=>c.id===b.dependency)?.kind==='plugin')) {
    if(duplicates.has(b.dependency))add('error','Duplicate native dependency plugins',b.dependency,[duplicates.get(b.dependency).file,b.file]);else duplicates.set(b.dependency,b);
  }
  for(const m of mods.filter(m=>m.active!==false&&m.native.length))requirements.push({consumer:m.id,loadName:m.loadName,target:'kcse',kind:'native-plugin',active:m.active,activationState:m.activationState,source:m.source});
  // A loose DLL in the game-root KCSE plugin directory has no owning mod
  // manifest, but its placement still implies KCSE. Use the bounded directory
  // listing so this requirement appears even in the focused scan, which skips
  // inspection of unrelated binary payloads.
  const rootPlugins=path.join(game.root,'KCSE/Plugins').toLowerCase();
  for(const n of nativePaths.filter(n=>n.active&&n.placed&&!n.owner&&/\.dll$/i.test(n.file)&&path.dirname(n.file).toLowerCase()===rootPlugins))
    requirements.push({consumer:path.basename(n.file),target:'kcse',kind:'native-plugin',active:true});
  const whHash=await hashFile(path.join(game.bin,'WHGame.dll')),reference=gameReferences[whHash];
  snapshots[path.join(game.bin,'WHGame.dll')]=whHash;
  snapshots[path.join(game.bin,'KingdomCome.exe')]=await hashFile(path.join(game.bin,'KingdomCome.exe'));
  const addresses=[];
  for(const name of await fs.readdir(path.join(game.root,'KCSE/addresslib')).catch(()=>[]))if(/^kcd_addresslib_.*\.bin$/i.test(name))addresses.push({file:path.join(game.root,'KCSE/addresslib',name),name,size:(await fs.stat(path.join(game.root,'KCSE/addresslib',name))).size});
  let addressMatch=null;
  for(const a of addresses)snapshots[a.file]=await hashFile(a.file);
  if(reference&&game.distribution===reference.distribution) {
    addressMatch=addresses.find(a=>a.name===reference.address);
    if(addressMatch&&await hashFile(addressMatch.file)!==reference.addressHash){add('review','Address Library differs from the tested reference','Filename matches, but bytes differ. Verify the download/build with the author.',[addressMatch.file]);addressMatch=null;}
  }
  const dependencyRows=[];
  for(const c of catalog) {
    const providers=mods.filter(m=>canonical(m.declaredId||m.id)===c.id||!m.declaredId&&canonical(m.name)===c.id);
    const conflicting=mods.filter(m=>m.active!==false&&m.declaredId&&canonical(m.name)===c.id&&canonical(m.declaredId)!==c.id);
     const foundNative=binaries.filter(b=>b.dependency===c.id&&b.active!==false&&b.valid&&b.architecture==='x64'&&(b.placed||b.workshop));
    const native=foundNative.filter(b=>!b.workshop&&b.placed);
    const enabled=providers.filter(m=>m.active!==false);let present=false,status='missing',detail=c.help,reviewReason=null;
    if(c.id==='addresslib'){present=!!addressMatch;status=present?'installed':addresses.length?'review':'missing';if(addresses.length&&!present){reviewReason='address-unverified';detail+=' Found tables, but this game build is not verified against them.';}}
     else if(c.id==='soundframework_asi'){
       const found=await Promise.all(c.requiredResources.map(async relative=>{
         const file=path.join(game.bin,relative);
         try {const st=await fs.stat(file);if(!st.isFile()||!st.size)return false;snapshots[file]=await hashFile(file);return true;}catch{return false;}
       }));
       present=native.length>0&&found.every(Boolean);
       status=present?'installed':native.length?'incomplete':'missing';
       if(native.length&&!present)detail+=' One or more companion files are missing or empty.';
     }
     else if(c.kind==='loader'||c.kind==='asi'){present=native.length>0;status=present?'installed':'missing';}
     else if(c.kind==='plugin') {
       let resource=c.id==='luautils'?enabled.some(m=>m.entries.some(e=>/^Scripts\/Mods\/.*luautils.*\.lua$/i.test(e))):c.id==='mcm'?enabled.some(m=>m.entries.some(e=>/^Libs\/UI\/UIElements\/MCM\.xml$/i.test(e))&&m.entries.some(e=>/^Libs\/UI\/.*mcm.*\.gfx$/i.test(e))):enabled.length>0;
       if(c.nativeOnly)resource=true;
       else if(c.importable) {
         resource=false;
         for(const m of enabled) {
           if(!native.some(b=>b.owner===m.id&&b.file.toLowerCase().startsWith(path.join(m.root,'KCSE/Plugins').toLowerCase()+path.sep)))continue;
           const found=await Promise.all(c.requiredResources.map(async relative=>{
             const file=path.join(m.root,...relative.split('/'));
             try {const st=await fs.stat(file);if(!st.isFile()||!st.size)return false;snapshots[file]=await hashFile(file);return true;}catch{return false;}
           }));
           if(found.every(Boolean)){resource=true;break;}
         }
       }
       present=native.length>0&&resource;status=present?'installed':native.length||providers.length?'incomplete':'missing';
      if(native.length&&!resource)detail+=' Its required mod resources/bootstrap were not found in an enabled provider.';
    }else {
      present=enabled.some(m=>m.entries.some(e=>/^Scripts\/Mods\/kcdutils\.lua$/i.test(e))&&m.entries.some(e=>/^Scripts\/Mods\/KCDUtils\//i.test(e)));
      status=present?'installed':providers.length?'incomplete':'missing';
    }
    // A readable bootstrap does not establish a complete dependency when another
    // package from the same enabled provider could not be inspected.
    if(enabled.some(m=>m.inspectedPakCount!==m.pakCount)) {
      status='incomplete';present=false;reviewReason='provider-incomplete';
      detail+=' Some provider PAK files could not be inspected. Check or reinstall the complete author download.';
    }else if(present&&native.some(b=>fingerprints[b.sha256]!==c.id)) {
      status='review';present=false;reviewReason='unverified-native-version';
      detail+=' Files found, but the native version is unverified: its file hash is not in this app’s reference list. This does not establish incompatibility or mean you must reinstall. Compare the file with the author download if needed.';
    }
    const workshopProviders=providers.filter(m=>m.workshop),workshopNative=foundNative.filter(b=>b.workshop);
    const uncertainWorkshop=workshopProviders.length>0||workshopNative.length>0;
    if(uncertainWorkshop&&present){
      status='review';present=false;reviewReason='workshop-activation-unverified';
      detail+=' Workshop files were found. Steam normally enables subscribed mods on launch; finish downloads and check whether your custom mod list excludes the item. This scan cannot verify Workshop activation; do not install a second local copy just to enable it.';
    }else if(uncertainWorkshop&&reviewReason==='unverified-native-version'){
      detail+=' Workshop activation is also unverified; check Steam subscriptions and your custom mod list.';
    }
    if(workshopNative.length&&!native.length){
      status='review';present=false;reviewReason='workshop-native-placement';
      detail+=' Native plugin files were found inside Workshop storage, which KCSE does not scan. Follow the author manual installation instructions for the native dependency; enabling the Workshop item alone does not place its DLL in a KCSE plugin folder.';
    }
    if(workshopProviders.some(m=>m.workshopState==='pending'||m.workshopState==='missing')){
      status='incomplete';present=false;reviewReason='workshop-download-pending';
      detail+=' Steam reports a pending or missing Workshop download. Wait for Steam to finish before relying on these files.';
    }
    if(providers.length&&!enabled.length){status='disabled';present=false;reviewReason=null;}
    if(conflicting.length||native.length>1||enabled.length>1) {
      status='review';present=false;reviewReason=conflicting.length?'identity-conflict':'duplicate-providers';
      detail+=conflicting.length?' A matching display name has a conflicting explicit mod ID. Review the author manifest.':(uncertainWorkshop?' Local and/or Workshop provider copies were found. Workshop activation is unknown; review possible duplicates before continuing.':' Multiple active providers or native copies were found. Review the duplicates before continuing.');
    }
    const requiredBy=requirements.filter(r=>r.active&&r.target===c.id&&r.kind!=='optional').map(r=>r.consumer);
    dependencyRows.push({...c,status,present,detail,reviewReason,filesFound:providers.length>0||foundNative.length>0,nativePresent:native.length>0,needsNativePlacement:workshopNative.length>0&&!native.length,needsActivationCheck:uncertainWorkshop,conditionalRequiredBy:[...new Set(requirements.filter(r=>r.active===null&&r.target===c.id&&r.kind!=='optional').map(r=>r.consumer))],providers:providers.map(m=>({id:m.id,folder:m.folder,root:m.root,active:m.active,activationState:m.activationState,source:m.source,workshop:m.workshop,workshopItemId:m.workshopItemId,workshopUrl:m.workshopUrl,workshopState:m.workshopState,version:m.version})),files:[...foundNative.map(b=>b.file),...(c.id==='addresslib'?addresses.map(a=>a.file):[])],requiredBy:[...new Set(requiredBy)]});
  }
  const needed=new Set(dependencyRows.filter(d=>d.present||d.requiredBy.length).map(d=>d.id));
  for(let changed=true;changed;) {changed=false;for(const c of catalog.filter(c=>needed.has(c.id)))for(const target of c.requires) {
    if(!requirements.some(r=>r.consumer===c.id&&r.target===target&&r.active===true&&r.kind!=='optional'))requirements.push({consumer:c.id,target,kind:'dependency',active:true});
    if(!needed.has(target)){needed.add(target);changed=true;}
  }}
  // Keep the original Workshop consumer visible throughout conditional chains.
  // These edges never establish activation or become hard missing requirements.
  const conditionalQueue=requirements.filter(r=>r.active===null&&r.kind!=='optional');
  const conditionalSeen=new Set(conditionalQueue.map(r=>r.consumer+'\0'+r.target));
  for(let i=0;i<conditionalQueue.length;i++){
    const edge=conditionalQueue[i],provider=catalog.find(c=>c.id===edge.target);
    for(const target of provider?.requires||[]){
      const key=edge.consumer+'\0'+target;if(conditionalSeen.has(key))continue;
      conditionalSeen.add(key);
      const next={consumer:edge.consumer,target,kind:'dependency',active:null,activationState:'unknown',source:'workshop'};
      requirements.push(next);conditionalQueue.push(next);
    }
  }
  const kcse=dependencyRows.find(d=>d.id==='kcse'),asi=dependencyRows.find(d=>d.id==='asi');
  const soundKcse=dependencyRows.find(d=>d.id==='soundframework'),soundAsi=dependencyRows.find(d=>d.id==='soundframework_asi');
  if(binaries.some(b=>b.dependency==='soundframework'&&b.active&&b.placed&&b.valid&&b.architecture==='x64')&&binaries.some(b=>b.dependency==='soundframework_asi'&&b.active&&b.placed&&b.valid&&b.architecture==='x64'))
    add('review','Both Sound Framework variants are active','The author supplies KCSE and ASI variants as alternatives. Disable one variant, then scan again.',[...soundKcse.files,...soundAsi.files]);
  const validLuaDb=binaries.filter(b=>b.active&&b.placed&&b.dependency==='luadb'&&b.valid&&b.architecture==='x64').map(b=>b.file);
  const possibleProxy=binaries.some(b=>b.active&&b.placed&&b.valid&&b.architecture==='x64'&&path.dirname(b.file).toLowerCase()===game.bin.toLowerCase()&&/^(dinput8|version|winmm|dsound|d3d9|dxgi|xinput1_3)\.dll$/i.test(path.basename(b.file)));
  if(validLuaDb.length&&!asi.present&&!kcse.present)add(possibleProxy?'review':'error',possibleProxy?'LuaDB loader needs review':'LuaDB has no recognized loader',possibleProxy?'A possible loader DLL exists, but its identity or version is unverified. Confirm with its author that it loads this ASI plugin.':'Install x64 Ultimate ASI Loader or a current KCSE build with ASI support.',validLuaDb);
  if(validLuaDb.length&&!asi.present&&kcse.present)add('review','LuaDB relies on KCSE ASI support','KCSE release 5 added ASI loading. This file scan cannot guarantee the installed KCSE build has loaded LuaDB.',validLuaDb);
  const otherAsi=[];
  for(const n of nativePaths.filter(n=>n.active&&n.placed&&!n.owner&&path.dirname(n.file).toLowerCase()===game.bin.toLowerCase()&&/\.asi$/i.test(n.file)&&path.basename(n.file).toLowerCase()!=='kcd2db.asi'&&!validLuaDb.includes(n.file))) {
    const entry=await fs.lstat(n.file).catch(()=>null);
    if(entry?.isFile())try{const info=await nativeInfo(n.file);if(info.valid&&info.architecture==='x64')otherAsi.push(n.file);}catch(e){add('review','Cannot inspect ASI plugin header',e.message,[n.file]);}
  }
  if(otherAsi.length&&!asi.present&&!kcse.present)add(possibleProxy?'review':'error',possibleProxy?'ASI plugin loader needs review':'ASI plugins have no recognized loader',possibleProxy?'A possible loader DLL exists, but its identity or version is unverified. Confirm with the plugin author that it loads these ASI files.':'ASI files are beside KingdomCome.exe, but no recognized ASI loader was found. Install a loader supported by the plugin author.',otherAsi);
  if(otherAsi.length&&!asi.present&&kcse.present)add('review','ASI plugins rely on KCSE ASI support','KCSE release 5 added ASI loading. This file scan cannot prove these ASI plugins loaded in the current game session.',otherAsi);
  for(const d of dependencyRows){d.conditionalRequiredBy=[...new Set(requirements.filter(r=>r.active===null&&r.target===d.id&&r.kind!=='optional').map(r=>r.consumer))];d.requiredBy=[...new Set(requirements.filter(r=>r.active&&r.target===d.id&&r.kind!=='optional').map(r=>r.consumer))];if(d.requiredBy.length&&!d.present)add(d.status==='review'?'review':'error',`${d.name}: ${d.status}`,`Required by ${d.requiredBy.join(', ')}. ${d.detail}`,d.files);}
  for(const r of requirements.filter(r=>r.active&&r.kind==='declared'&&!catalog.some(c=>c.id===r.target))) {
    const provider=mods.find(m=>m.active!==false&&m.id.toLowerCase()===r.target.toLowerCase());
    if(!provider)add('error','Declared mod dependency is missing',`${r.consumer} requires ${r.target}.`,[]);
    else if(provider.workshop)add('review','Workshop dependency activation is unverified',`${r.consumer} requires ${r.target}. Files were found in Steam Workshop; confirm it is enabled in the game mod manager.`,[provider.manifestPath]);
    else if(r.version)add('review','Dependency version constraint needs review',`${r.consumer} declares ${r.target} ${r.version}; installed ${provider.version||'unknown'}. Arbitrary author version syntax is not auto-sorted.`,[provider.manifestPath]);
  }
  for(const r of requirements.filter(r=>r.active)) {
    const provider=mods.find(m=>m.active&&(canonical(m.id)||m.id).toLowerCase()===r.target.toLowerCase()),consumer=mods.find(m=>m.id===r.consumer);
    if(orderBytes&&provider&&consumer&&!provider.workshop&&!consumer.workshop&&orderMap.get(provider.loadName.toLowerCase())?.index>orderMap.get(consumer.loadName.toLowerCase())?.index)add('review','Dependency loads after its consumer',`${provider.loadName} should precede ${consumer.loadName}.`,[orderPath],{repair:'order'});
  }
  for(const h of hints)if(!requirements.some(r=>r.consumer===h.consumer&&r.target===h.target))add('review','Possible undeclared/optional dependency',`${h.consumer} uses ${h.target} APIs. Check author requirements; conditional calls do not establish a hard requirement.`,[h.path]);
  for(const d of dependencyRows.filter(d=>d.status==='disabled'&&d.requiredBy.length))add('review','Required provider is excluded from mod_order.txt',d.providers.map(p=>p.folder).join(', '),[orderPath],{repair:'order'});
  // Logs are supporting evidence only. Dates and hashes are supplied explicitly.
  const logs=[];
  for(const file of [path.join(game.root,'KCSE/logs/KCSE.log'),path.join(game.root,'kcd2db.log')]) {
    try {
      const stat=await fs.stat(file),fh=await fs.open(file,'r');const b=Buffer.alloc(Math.min(stat.size,128*1024));
      try{await fh.read(b,0,b.length,Math.max(0,stat.size-b.length));}finally{await fh.close();}
      logs.push({file,modified:stat.mtime.toISOString(),historical:true,lines:b.toString('utf8').split(/\r?\n/).filter(l=>/error|failed|incompatible|not found|KCSE v|LuaDB|kcd2db/i.test(l)).slice(-30)});
    }catch(e){if(e.code!=='ENOENT')add('review','Cannot read historical dependency log',`${file}: ${e.message}`,[file]);}
  }
  if((await dependencyLayout(game)).hash!==layout.hash)throw Error('Dependency layout changed during the scan. Scan again.');
  return {schema:1,activation:activateLocal?'all-local':'current',created:new Date().toISOString(),layout,game:{...game,whHash,reference:reference||null},order:{path:orderPath,exists:!!orderBytes,hash:orderBytes?hash(orderBytes):null,entries:order},
    workshop:{roots:workshop.roots,metadataFiles:workshop.metadataFiles,items:workshop.items,issues:workshop.issues,complete:workshop.complete,pending:workshop.pending,fingerprint:workshop.fingerprint,activationState:'unknown'},vortex:Object.fromEntries(Object.entries(vortex).filter(([name])=>name!=='managed')),dependencies:dependencyRows,mods:mods.map(({lua,entries,...m})=>({...m,entryCount:entries.length})),requirements,hints,binaries,findings,logs,snapshots,
    scope:'Installed-file and package checks. Current runtime compatibility and undeclared dependencies remain unverified.'};
}
module.exports={scan,parseManifest,parseOrder,vortexState,dependencyLayout};
