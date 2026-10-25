'use strict';
// General, order-only dependency repair. Legacy Elfis setup receipts stay in setup.js.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {hash,hashFile}=require('./io');
const {scan,parseManifest,parseOrder}=require('./scanner');
const {resolveGame}=require('./discovery');
const {inspectWorkshop,metadataForRoot}=require('./workshop');
async function rescanSetup(game){
  const report=await scan(game.root,{modsPath:game.mods,activateLocal:true});
  report.game.workshopRoots=[...new Set([...(report.game.workshopRoots||[]),...(game.workshopRoots||[game.workshop]).filter(Boolean)])];
  report.game.workshopMetadataFiles=[...new Set([...(report.game.workshopMetadataFiles||[]),...(game.workshopMetadataFiles||[]),...report.game.workshopRoots.map(metadataForRoot).filter(Boolean)])];
  return report;
}
const {canonical,catalog}=require('./catalog');
const {ensurePlainPath,freshGate,gameClosed,locked,assertManualScope}=require('./repairs');
const stat=async p=>fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const statBig=async p=>fs.lstat(p,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const within=(base,p)=>same(base,p)||path.resolve(p).toLowerCase().startsWith(path.resolve(base).toLowerCase()+path.sep);
const identity=s=>({dev:String(s.dev),ino:String(s.ino),birthtimeNs:String(s.birthtimeNs)});
const sameInode=(s,id)=>!!s&&!!id&&(typeof id.ino==='string'?String(s.dev)===id.dev&&String(s.ino)===id.ino:s.dev===id.dev&&s.ino===id.ino);
const owns=(s,id)=>sameInode(s,id)&&(typeof id.ino==='string'?String(s.birthtimeNs)===id.birthtimeNs:s.birthtimeMs===id.birthtimeMs);
const seal=x=>hash(Buffer.from(JSON.stringify(x)));
const catalogById=new Map(catalog.map(c=>[c.id,c]));
const key=x=>String(x||'').trim().toLowerCase();
const dependencyId=x=>canonical(x)||key(x);
async function plainAncestors(target){
  let p=path.resolve(target);
  while(true){const s=await stat(p);if(s?.isSymbolicLink())throw Error('Linked backup path is not supported: '+p);const parent=path.dirname(p);if(parent===p)break;p=parent;}
}
function lines(bytes) {
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('mod_order.txt must contain valid UTF-8.');}
  if(text.includes('\0'))throw Error('mod_order.txt contains NUL bytes.');
  const bom=text.startsWith('\uFEFF')?'\uFEFF':'',body=text.slice(bom.length);
  const rows=(body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)||[]).filter(Boolean).map(raw=>{
    const m=/^(.*?)(\r\n|\n|\r)?$/.exec(raw);return {text:m[1],eol:m[2]||''};
  });
  return {bom,rows,newline:body.includes('\r\n')?'\r\n':body.includes('\n')?'\n':body.includes('\r')?'\r':'\r\n'};
}
function rowName(row){const n=row.text.trim();return n&&!/^(#|;|\/\/)/.test(n)?n:null;}
const encode=parsed=>Buffer.from(parsed.bom+parsed.rows.map(r=>r.text+r.eol).join(''));
async function inspectSetup(report) {
  if(!report?.game||!Array.isArray(report.mods)||!Array.isArray(report.dependencies)||report.game.scanScope==='elfis')throw Error('Run a full installed-mod scan before dependency setup.');
  const game=report.game,target=path.join(game.mods,'mod_order.txt'),warnings=[],blockers=[],evidence=[];
  if(!same(report.order?.path,target))blockers.push('The load-order path differs from the selected game. Scan again.');
  const manager=(report.vortex?.detected||report.vortex?.orderMayBeManaged)?{mode:'vortex',summary:report.vortex.summary||'Vortex ownership needs review',action:'In Vortex, select KCD2 and the profile you play, enable the intended mods, Deploy, then use its Load Order page. Keep manual and Workshop entries you still need. Deploy again and check dependencies here.',note:'This preview reads deployed game files. Staging-only mods and profile enable switches are not verified. Vortex may rewrite mod_order.txt even when that file is not listed in its deployment record.'}:null;
  if(report.layout?.incomplete)blockers.push('Dependency paths could not be completely inspected. Resolve scan errors and rescan.');
  if(!within(game.root,target))blockers.push('The mod-order path is outside the selected game.');
  const local=[];let folders;
  try{folders=await fs.readdir(game.mods,{withFileTypes:true});}catch(e){blockers.push(e.code==='ENOENT'?'Mods folder is missing. Create an empty Mods folder before synchronizing load order.':'Cannot inspect the installed Mods folder: '+e.message);folders=[];}
  if(folders.length>1000)blockers.push('Installed Mods folder exceeds the 1000-entry inventory limit.');
  for(const entry of folders.slice(0,1000)){
    if(/^(__?vortex|_mod_audit_backup|mod_backups|logs?|backups?)$/i.test(entry.name))continue;
    const folder=path.join(game.mods,entry.name);
    if(entry.isSymbolicLink()){
      const deployed=report.mods.find(m=>!m.workshop&&same(m.root,folder));
      if(manager&&deployed){local.push({folder:entry.name,root:folder,id:deployed.declaredId||deployed.id,manifest:deployed.manifestPath});continue;}
      blockers.push('Linked folder in Mods needs manual review: '+folder);continue;
    }
    if(!entry.isDirectory())continue;
    if(entry.name.trim()!==entry.name||/[\x00-\x1f\x7f]/.test(entry.name)||/^(#|;|\/\/)/.test(entry.name)){blockers.push('Mod folder name cannot be represented safely in mod_order.txt: '+entry.name);continue;}
    let items;try{items=await fs.readdir(folder,{withFileTypes:true});}catch(e){blockers.push('Cannot read installed mod folder: '+folder+' ('+e.message+')');continue;}
    if(items.length>3000){blockers.push('Installed mod folder exceeds the 3000-entry inventory limit: '+folder);continue;}
    const found=items.find(e=>e.name.toLowerCase()==='mod.manifest');
    if(!found){
      if(items.length)blockers.push('Folder in Mods has no direct mod.manifest; inspect it before synchronization: '+folder);
      continue;
    }
    const manifest=path.join(folder,found.name);
    if(!found.isFile()){blockers.push('Linked or non-file mod.manifest needs manual review: '+manifest);continue;}
    try{
      const s=await stat(manifest);if(!s?.isFile()||!manager&&s.nlink>1||s.size>256*1024)throw Error('Manifest is linked or oversized');
      const parsed=parseManifest(await fs.readFile(manifest));
      // KCD2 also accepts author manifests without modid; the deployed folder
      // is their load identity, as in the scanner's normal installed-mod view.
      local.push({folder:entry.name,root:folder,id:parsed.id||entry.name,manifest});
      if(!report.mods.some(m=>!m.workshop&&same(m.root,folder)))blockers.push('Installed mod was not completely resolved by the scan: '+folder);
    }catch(e){blockers.push('Invalid or unreadable mod.manifest: '+manifest+' ('+e.message+')');}
  }
  const duplicateIds=new Set();for(const m of local){const id=key(m.id);if(duplicateIds.has(id))blockers.push('Duplicate installed mod identity: '+m.id);duplicateIds.add(id);}
  for(const f of report.findings||[])if(f.severity==='error'&&['Broken mod folder/link','Cannot read mod manifest','Invalid mod manifest','Extra folder around a mod','Cannot inspect mod Data path','Cannot inspect mod PAK'].includes(f.title)&&f.files?.some(p=>within(game.mods,p)))blockers.push('Installed mod inventory is incomplete: '+f.title+' ('+f.files[0]+')');
  const workshop=await inspectWorkshop(game);
  if(report.mods.some(m=>m.workshop)||workshop.items.length||workshop.pending)
    blockers.push('Steam Workshop mods or pending downloads were found. Automatic load-order editing is paused so Workshop entries stay intact. Let Steam finish downloading, manage Workshop order in the game or your mod manager, then check dependencies again.');
  if(!workshop.complete)blockers.push('Steam Workshop could not be completely checked. Automatic load-order editing is paused. Resolve the Workshop scan notices and check dependencies again.');
  let before=null,parsed=null;
  if(report.order?.exists){
    if(!manager)await ensurePlainPath(game.root,target);
    before=await fs.readFile(target);if(hash(before)!==report.order.hash)blockers.push('mod_order.txt changed after the scan. Scan again.');
    parsed=lines(before);
  }else parsed=lines(Buffer.alloc(0));
  return {kind:'dependency-setup-order-v1',root:game.root,target,warnings,blockers,evidence,before,parsed,local,manager,workshop};
}
async function previewSetup(report) {
  const setup=await inspectSetup(report),{blockers,warnings,evidence}=setup,parsed=setup.parsed,rows=parsed.rows;
  if(!blockers.length&&report.activation!=='all-local')report=await rescanSetup(report.game);
  const mods=report.mods.filter(m=>!m.workshop),installed=new Map(setup.local.map(m=>[key(m.folder),m.folder]));
  const originalNames=rows.map(rowName).filter(Boolean);
  // A Vortex preview must not turn its disabled/commented or omitted rows into
  // an enable-all suggestion. Profile activation belongs to the manager.
  if(setup.manager){
    const enabled=new Set(originalNames.map(key));
    for(const name of installed.keys())if(!enabled.has(name))installed.delete(name);
    warnings.push('Vortex-disabled and omitted mods remain inactive in this preview. Enable intended mods in Vortex and Deploy before checking again.');
  }
  const added=[],removed=[],preserved=[],caseFixed=[],seen=new Set(),kept=[],explanations=[];
  for(const row of rows){
    const n=rowName(row);if(!n){kept.push(row);continue;}
    const k=key(n),actual=installed.get(k);
    if(!actual){preserved.push(n);kept.push(row);continue;}
    if(seen.has(k)){removed.push(n);continue;}
    seen.add(k);if(n!==actual){caseFixed.push(n+' → '+actual);row.text=actual;}
    kept.push(row);
  }
  rows.splice(0,rows.length,...kept);
  for(const folder of [...installed.values()].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())))if(!seen.has(key(folder))){
    if(rows.length&&!rows.at(-1).eol)rows.at(-1).eol=parsed.newline;
    rows.push({text:folder,eol:parsed.newline});added.push(folder);seen.add(key(folder));
  }
  const active=new Set(installed.keys()),byLoad=new Map(mods.map(m=>[key(m.loadName),m]));
  const byId=id=>mods.filter(m=>dependencyId(m.declaredId||m.id)===id||key(m.declaredId||m.id)===id);
  for(const m of setup.local)if(!byLoad.has(key(m.folder)))blockers.push('Installed mod disappeared from the active scan: '+m.folder);
  for(const [file,sha256] of Object.entries(report.snapshots||{}).filter(([file])=>within(report.game.mods,file)).sort(([a],[b])=>a.localeCompare(b)))evidence.push({path:file,sha256});
  const edges=[];const checked=new Set();
  async function checkMod(mod){
    const consumer=key(mod.loadName);if(checked.has(consumer))return;checked.add(consumer);
    const deps=[...(mod.deps||[]).filter(d=>!d.optional).map(d=>({id:d.id,kind:'required',source:mod.manifestPath,reason:'The installed manifest requires this dependency. Provider-first is the tool’s ordering recommendation; the declaration alone does not specify a winning override.'})),
      ...(report.requirements||[]).filter(r=>r.active&&key(r.consumer)===key(mod.id)&&['profile','native-plugin'].includes(r.kind)).map(r=>({id:r.target,kind:'suggested',source:mod.manifestPath,reason:'The file scan detected a '+r.kind+' requirement. This is a suggested provider-first order, not an author override rule.'}))];
    const profile=catalogById.get(dependencyId(mod.declaredId||mod.id));if(profile)deps.push(...profile.requires.map(id=>({id,kind:'suggested',source:profile.url,reason:'The tool dependency profile lists this requirement; no separate author load-order rule was verified.'})));
    for(const dependency of deps){
      const raw=dependency.id;
      const id=dependencyId(raw),profile=catalogById.get(id),candidates=byId(id);
      if(candidates.length>1){blockers.push(`Ambiguous providers for ${raw}, required by ${mod.id}. Keep one intended provider.`);continue;}
      const provider=candidates[0];
      if(!provider){
        const installed=report.dependencies.find(d=>d.id===id);
        if(!installed?.present)blockers.push(`Missing or unverified dependency ${raw}, required by ${mod.id}. Install or verify it before changing load order.`);
        continue;
      }
      const pkey=key(provider.loadName),prow=report.dependencies.find(d=>d.id===id);
      if(profile&&!prow?.present){
        blockers.push(`Active dependency ${provider.id} is incomplete or unverified. Review it before changing load order.`);continue;
      }else if(provider.inspectedPakCount!==provider.pakCount){
        blockers.push(`Provider ${provider.id} has an unreadable PAK. Review it before changing load order.`);continue;
      }
      if(pkey===consumer){blockers.push(`Self dependency declared by ${mod.id}: ${raw}. Resolve its manifest before changing load order.`);continue;}
      if(!edges.some(([p,c])=>p===pkey&&c===consumer)){
        edges.push([pkey,consumer]);
        explanations.push({kind:dependency.kind,provider:provider.loadName,consumer:mod.loadName,source:dependency.source,reason:dependency.reason+' Put '+provider.loadName+' before '+mod.loadName+' so the provider is listed first. This does not establish a winning file override or prove compatibility.'});
      }
      await checkMod(provider);
    }
  }
  for(const mod of mods.filter(m=>active.has(key(m.loadName))))await checkMod(mod);
  for(const r of (report.requirements||[]).filter(r=>r.active&&r.kind==='native-plugin'&&!mods.some(m=>key(m.id)===key(r.consumer)))){
    const dep=report.dependencies.find(d=>d.id===dependencyId(r.target));
    if(!dep?.present)blockers.push(`Native plugin ${r.consumer} requires ${r.target}, which is missing or unverified.`);
  }
  const graph=new Map();for(const [from,to] of edges){if(!graph.has(from))graph.set(from,[]);graph.get(from).push(to);}
  const visiting=new Set(),visited=new Set();function visit(n){if(visiting.has(n)){blockers.push('Declared dependency cycle detected. Resolve it with the mod authors.');return;}if(visited.has(n))return;visiting.add(n);for(const next of graph.get(n)||[])visit(next);visiting.delete(n);visited.add(n);}
  for(const n of graph.keys())visit(n);
  if(!blockers.length){
    // Reorder only provider entries, keeping comments and all other line slots intact.
    const slots=rows.map((r,i)=>rowName(r)?i:null).filter(i=>i!==null),names=slots.map(i=>rows[i].text);
    for(let pass=0;pass<Math.max(1,edges.length*slots.length);pass++){
      let moved=false;
      for(const [provider,consumer] of edges){
        const pi=names.findIndex(n=>key(n)===provider),ci=names.findIndex(n=>key(n)===consumer);
        if(pi<0||ci<0){blockers.push('A required dependency row disappeared during preview.');break;}
        if(pi>ci){names.splice(ci,0,names.splice(pi,1)[0]);moved=true;}
      }
      if(blockers.length||!moved)break;
      if(pass===Math.max(1,edges.length*slots.length)-1)blockers.push('Could not resolve dependency order without changing unrelated rows.');
    }
    if(!blockers.length)slots.forEach((slot,i)=>{rows[slot].text=names[i];});
  }
  const after=encode(parsed),created=setup.before===null,changed=created||!setup.before.equals(after);
  const encodedNames=new Set(parseOrder(after).map(e=>key(e.name)));
  for(const mod of setup.local)if(installed.has(key(mod.folder))&&!encodedNames.has(key(mod.folder)))blockers.push('Load-order output cannot represent installed mod: '+mod.folder);
  if(created)explanations.unshift({kind:'baseline',source:'https://www.deepsilver.com/games/kingdom-come-deliverance-ii/news/modding-in-kingdom-come-deliverance-2',reason:'Local mods start in alphabetical folder order, matching the publisher-documented default. Only evidenced dependency constraints can move a provider earlier.'});
  else explanations.unshift({kind:'preserved',reason:'Existing unrelated entries and comments keep their relative order. Only duplicate local entries, folder-case corrections and evidenced dependency moves are changed.'});
  if(preserved.length)warnings.push('Unmatched entries are kept: they may belong to Workshop mods or mods temporarily unavailable. Check them with the game or their manager.');
  explanations.push({kind:'unknown',reason:'No winning override or relative order is chosen for unrelated mods. Check the authors’ instructions and test in game; position alone does not prove compatibility.'});
  for(const name of added)explanations.push({kind:'activation',reason:'Add '+name+' because its valid local mod folder was found. Listing it can enable this mod when you next start the game.'});
  for(const name of preserved)explanations.push({kind:'preserved',reason:'Keep '+name+' because its ownership or availability is unknown; removing it could disable a Workshop mod.'});
  const order={target:setup.target,created,before:created?null:hash(setup.before),after:hash(after),beforeText:created?'':setup.before.toString('utf8'),afterText:after.toString('utf8'),beforeBytes:created?'':setup.before.toString('base64'),afterBytes:after.toString('base64'),added,removed,preserved,caseFixed,explanations};
  const changes=changed?[{type:'order',source:setup.target,target:setup.target,detail:'Synchronize all installed local mods and place declared dependencies before their consumers.'}]:[];
  const finalNames=rows.map(rowName).filter(Boolean);
  for(const item of explanations)if(item.provider){item.beforePosition=originalNames.findIndex(n=>key(n)===key(item.provider))+1||null;item.afterPosition=finalNames.findIndex(n=>key(n)===key(item.provider))+1||null;item.consumerPosition=finalNames.findIndex(n=>key(n)===key(item.consumer))+1||null;}
  const signature=seal({root:setup.root,workshop:setup.workshop.fingerprint,order:{target:order.target,created:order.created,before:order.before,after:order.after,explanations},manager:setup.manager,evidence,blockers,local:setup.local.map(m=>[m.folder,m.id])});
  return {kind:setup.kind,root:setup.root,manager:setup.manager,workshopFingerprint:setup.workshop.fingerprint,warnings,blockers,evidence,order,changes,changed,canApply:changed&&!blockers.length&&!setup.manager,summary:setup.manager?'Vortex load-order guidance — apply changes through Vortex':changed?'1 synchronized load-order change':'No load-order change needed',signature};
}
async function safeStore(store,game){
  const base=path.resolve(store);
  if(within(game.mods,base)||within(game.bin,base)||within(game.root,base)&&!within(path.join(game.root,'_mod_audit_backup'),base))throw Error('Keep setup backups outside mods and Bin, or under _mod_audit_backup.');
  await plainAncestors(base);
  await fs.mkdir(base,{recursive:true});await ensurePlainPath(base,base);return base;
}
async function saveReceipt(file,value){
  const temp=path.join(path.dirname(file),'.receipt-'+crypto.randomUUID()+'.tmp'),handle=await fs.open(temp,'wx');
  try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
  try{await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
}
async function ownTemp(file,id,sha){
  const s=await (typeof id.ino==='string'?statBig(file):stat(file));if(s?.isFile()&&Number(s.nlink)===1&&owns(s,id)&&await hashFile(file)===sha)await fs.unlink(file);
}
async function applySetup(report,plan,store,{closed=gameClosed,createOnly=false}={}){
  const game=report.game,base=await safeStore(store,game);
  return locked(base,game,async()=>{
    if(plan.kind!=='dependency-setup-order-v1'||!same(plan.root,game.root))throw Error('Unknown dependency setup preview.');
    const freshReport=await rescanSetup(game),fresh=await previewSetup(freshReport);
    if(createOnly&&(!plan.order?.created||!fresh.order.created))throw Error('Existing mod_order.txt is preserved. Automatic creation never replaces it.');
    if(!fresh.canApply||fresh.signature!==plan.signature)throw Error('Dependency setup preview changed. Scan and review again.');
    const order=fresh.order,scope={subtrees:[],files:[order.target]},snapshots=order.created?{}:{[order.target]:order.before};
    await freshGate(game,snapshots,closed,null,scope);
    if(order.created&&await stat(order.target))throw Error('mod_order.txt appeared after preview. Scan and review again.');
    for(const item of fresh.evidence){await ensurePlainPath(game.root,item.path);if(await hashFile(item.path)!==item.sha256)throw Error('Dependency provider changed. Scan and review again: '+item.path);}
    const dir=path.join(base,crypto.randomUUID());await fs.mkdir(dir);
    const backup=order.created?null:path.join(dir,'mod_order.before'),bytes=Buffer.from(order.beforeBytes,'base64'),after=Buffer.from(order.afterBytes,'base64');
    if(backup){await fs.writeFile(backup,bytes,{flag:'wx'});if(await hashFile(backup)!==order.before)throw Error('Load-order backup changed.');}
    const rp=path.join(dir,'receipt.json'),receipt={kind:'dependency-setup-order-v1',identityVersion:1,identityFormat:'decimal-bigint-v1',state:'prepared',game,target:order.target,created:order.created,before:order.before,after:order.after,backup,time:new Date().toISOString(),installedIdentity:null};
    await saveReceipt(rp,receipt);let temp=null,tempIdentity=null;
    try{
      await freshGate(game,snapshots,closed,null,scope);
      if((await previewSetup(await rescanSetup(game))).signature!==fresh.signature)throw Error('Dependency setup changed during backup. Scan again.');
      temp=path.join(path.dirname(order.target),'.dependency-setup-'+crypto.randomUUID()+'.tmp');
      const handle=await fs.open(temp,'wx');try{tempIdentity=identity(await handle.stat({bigint:true}));await handle.writeFile(after);await handle.sync();}finally{await handle.close();}
      if(await hashFile(temp)!==order.after)throw Error('Staged load order changed.');
      receipt.state='committing';receipt.temp=temp;receipt.tempIdentity=tempIdentity;await saveReceipt(rp,receipt);
      await freshGate(game,snapshots,closed,null,scope);await ensurePlainPath(game.root,temp);
      if(await hashFile(temp)!==order.after)throw Error('Staged load order changed before commit.');
      const currentWorkshop=await inspectWorkshop(freshReport.game);
      if(!currentWorkshop.complete||currentWorkshop.pending||currentWorkshop.items.length||currentWorkshop.fingerprint!==fresh.workshopFingerprint)throw Error('Steam Workshop changed before load-order creation. Let Steam finish and check dependencies again.');
      if(order.created){
        if(await stat(order.target))throw Error('mod_order.txt appeared before creation. Scan and review again.');
        await fs.link(temp,order.target); // Exclusive, atomic publication of the journaled staged inode.
        const linked=await statBig(order.target),stage=await statBig(temp);
        if(!linked?.isFile()||!stage?.isFile()||linked.nlink!==2n||stage.nlink!==2n||!sameInode(linked,tempIdentity)||!sameInode(stage,tempIdentity)||await hashFile(order.target)!==order.after||await hashFile(temp)!==order.after)throw Error('Created load order could not be verified.');
        await fs.unlink(temp);
      }else await fs.rename(temp,order.target);
      const installed=await statBig(order.target);
      if(!installed?.isFile()||installed.nlink!==1n||await hashFile(order.target)!==order.after)throw Error('Load-order verification failed.');
      receipt.installedIdentity=identity(installed);receipt.state='applied';delete receipt.temp;delete receipt.tempIdentity;await saveReceipt(rp,receipt);
      return {receipt:rp,changed:[order.target]};
    }catch(e){receipt.state='partial';receipt.error=e.message;await saveReceipt(rp,receipt);const failure=Error(e.message+' Recovery record: '+rp);failure.receipt=rp;throw failure;}
    finally{if(temp&&tempIdentity)await ownTemp(temp,tempIdentity,order.after);}
  });
}
async function undoSetup(receiptPath,store,{closed=gameClosed}={}){
  const rp=path.resolve(receiptPath),base=path.resolve(store);
  if(!within(base,rp)||same(base,path.dirname(rp))||path.basename(rp)!=='receipt.json')throw Error('Unknown dependency setup receipt.');
  await plainAncestors(base);
  await ensurePlainPath(base,rp);const receipt=JSON.parse(await fs.readFile(rp,'utf8'));
  if(receipt.kind!=='dependency-setup-order-v1'||receipt.identityVersion!==1||!['applied','committing','partial'].includes(receipt.state)||!receipt.game)throw Error('No reversible dependency setup is recorded.');
  const game=receipt.game,target=path.join(game.mods,'mod_order.txt'),backup=path.join(path.dirname(rp),'mod_order.before');
  const created=receipt.created===true;
  if(receipt.created!==undefined&&typeof receipt.created!=='boolean'||!same(receipt.target,target)||
    (created?(receipt.before!==null||receipt.backup!==null):(!same(receipt.backup,backup)||!/^[a-f0-9]{64}$/.test(receipt.before))))throw Error('Invalid dependency setup receipt.');
  if(!within(game.root,target)||!within(game.root,game.mods)||!within(game.root,game.bin)||!/^[a-f0-9]{64}$/.test(receipt.after))throw Error('Invalid dependency setup receipt.');
  if(receipt.identityFormat!==undefined&&receipt.identityFormat!=='decimal-bigint-v1')throw Error('Unknown dependency setup identity format.');
  const bigintFormat=receipt.identityFormat==='decimal-bigint-v1';
  const validIdentity=id=>!!id&&(bigintFormat?['dev','ino','birthtimeNs'].every(k=>typeof id[k]==='string'&&/^\d+$/.test(id[k])):
    Number.isSafeInteger(id.dev)&&Number.isSafeInteger(id.ino)&&Number.isFinite(id.birthtimeMs));
  const receiptStat=bigintFormat?statBig:stat;
  if(receipt.installedIdentity&&!validIdentity(receipt.installedIdentity)||receipt.tempIdentity&&!validIdentity(receipt.tempIdentity))throw Error('Invalid dependency setup identity record.');
  const staged=receipt.state!=='applied'&&validIdentity(receipt.tempIdentity)&&typeof receipt.temp==='string'&&same(path.dirname(receipt.temp),path.dirname(target))&&/^\.dependency-setup-[0-9a-f-]+\.tmp$/i.test(path.basename(receipt.temp));
  if(!validIdentity(receipt.installedIdentity)&&!staged)throw Error('No verified installed-file identity is recorded. Manual recovery is required.');
  // A staged inode is durable across rename even if NTFS changes birthtime on
  // replacement. This fallback is limited to interrupted commits with a saved
  // staging path and identity; an equal hash by itself never grants ownership.
  const ownsTarget=s=>!!s?.isFile()&&Number(s.nlink)===1&&(owns(s,receipt.installedIdentity)||staged&&sameInode(s,receipt.tempIdentity));
  return locked(base,game,async()=>{
    const scope={subtrees:[],files:[target]};
    // An interrupted hardlink publish can leave our staged name and the new
    // order as exactly two links to the journaled inode. Remove only that
    // verified staged name, so normal ownership checks can then run.
    if(created&&staged){
      const current=await receiptStat(target),stage=await receiptStat(receipt.temp);
      if(current?.isFile()&&stage?.isFile()&&Number(current.nlink)===2&&Number(stage.nlink)===2&&sameInode(current,receipt.tempIdentity)&&sameInode(stage,receipt.tempIdentity)){
        const resolved=await resolveGame(path.join(game.bin,'KingdomCome.exe'));
        if(!same(resolved.root,game.root)||!same(resolved.bin,game.bin)||game.whHash&&await hashFile(path.join(game.bin,'WHGame.dll'))!==game.whHash||!await closed())throw Error('Game changed or started; recovery stopped.');
        if(await hashFile(target)!==receipt.after||await hashFile(receipt.temp)!==receipt.after)throw Error('Staged load order changed; recovery stopped.');
        await fs.unlink(receipt.temp);
      }
    }
    await freshGate(game,{[target]:receipt.after},closed,null,scope);
    if(!created)await ensurePlainPath(base,backup);await ensurePlainPath(game.root,target);
    const current=await receiptStat(target);if(!ownsTarget(current))throw Error('Load order identity changed; undo stopped.');
    if(!created&&await hashFile(backup)!==receipt.before)throw Error('Load-order backup changed; undo stopped.');
    if(created){
      await freshGate(game,{[target]:receipt.after},closed,null,scope);
      const again=await receiptStat(target);if(!ownsTarget(again))throw Error('Load order changed before undo commit.');
      await fs.unlink(target);receipt.state='undone';await saveReceipt(rp,receipt);return {changed:[target]};
    }
    const temp=path.join(path.dirname(target),'.dependency-setup-undo-'+crypto.randomUUID()+'.tmp');let tempIdentity=null;
    try{
      const handle=await fs.open(temp,'wx');try{tempIdentity=identity(await handle.stat({bigint:true}));await handle.writeFile(await fs.readFile(backup));await handle.sync();}finally{await handle.close();}
      await freshGate(game,{[target]:receipt.after},closed,null,scope);
      const again=await receiptStat(target);if(!ownsTarget(again)||await hashFile(temp)!==receipt.before)throw Error('Load order changed before undo commit.');
      await fs.rename(temp,target);
      if(await hashFile(target)!==receipt.before)throw Error('Undo verification failed.');
      receipt.state='undone';await saveReceipt(rp,receipt);return {changed:[target]};
    }finally{if(tempIdentity)await ownTemp(temp,tempIdentity,receipt.before);}
  });
}
async function ensureMissingOrder(report,store,options={}){
  if(report.order?.exists)return {state:'existing',message:'Your existing mod_order.txt was kept.'};
  try{
    const plan=await previewSetup(report);
    if(plan.manager)return {state:'manager',message:'Vortex records were found, so automatic load-order creation is paused. Review the selected profile and Deploy in Vortex; its Load Order page creates this file.',action:plan.manager.action};
    if(!plan.canApply)return {state:'deferred',message:'mod_order.txt was not created: '+plan.blockers.join(' ')};
    const result=await applySetup(report,plan,store,{...options,createOnly:true});
    return {state:'created',message:'Created mods\\mod_order.txt from the installed mod folders. A recovery record was saved.',...result};
  }catch(error){if(error.receipt)return {state:'recovery',receipt:error.receipt,message:'Automatic load-order creation did not finish cleanly. The file may have been created. Review the saved recovery record before continuing. '+error.message};return {state:'deferred',message:'Automatic load-order creation was deferred: '+error.message};}
}
module.exports={inspectSetup,previewSetup,applySetup,undoSetup,ensureMissingOrder};
