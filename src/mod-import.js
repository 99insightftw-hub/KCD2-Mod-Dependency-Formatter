'use strict';
// This deliberately recognizes one author identity, not arbitrary desktop folders.
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const {hash,hashFile,safeRelative}=require('./io');
const {parseManifest}=require('./scanner');
const {ensurePlainPath,freshGate,gameClosed,locked,assertManualScope}=require('./repairs');
const {inspectWorkshop}=require('./workshop');
const ID='zzmiscoverhaul_parttwo',KIND='mod-import-v1';
const LIMITS=Object.freeze({discovery:4096,children:512,entries:12000,depth:12,bytes:2*1024**3,fileBytes:512*1024**2});
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const within=(a,b)=>same(a,b)||path.resolve(b).toLowerCase().startsWith(path.resolve(a).toLowerCase()+path.sep);
const seal=value=>hash(Buffer.from(JSON.stringify(value)));
const stat=async p=>fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const fileIdentity=s=>({dev:s.dev,ino:s.ino,birthtimeMs:s.birthtimeMs});
const owns=(s,identity)=>!!s&&!!identity&&seal(fileIdentity(s))===seal(identity);
const ownershipScope=(game,order)=>({subtrees:[path.join(game.mods,ID)],files:order?.changed?[path.join(game.mods,'mod_order.txt')]:[]});
async function ancestors(target) {
  let cursor=path.resolve(target);
  for(;;){const s=await stat(cursor);if(s&&(s.isSymbolicLink()||s.isFile()&&s.nlink>1))throw Error('Linked or shared path is not supported: '+cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
}
async function list(dir,max) {
  const rows=[],handle=await fs.opendir(dir);
  for await(const e of handle){if(rows.length>=max)throw Error('Folder scan limit reached: '+dir);rows.push(e);}
  return rows.sort((a,b)=>a.name.localeCompare(b.name));
}
function payloadPath(relative) {
  const rel=safeRelative(relative);
  if(/\.(exe|com|bat|cmd|ps1|vbs|js|lnk|url|msi|scr)$/i.test(rel))throw Error('Executable installer or shortcut inside mod payload: '+rel);
  if(!/^(Data\/|Localization\/|KCSE\/Plugins\/|mod\.manifest$|mod\.cfg$|[^/]+\.(txt|md|png|jpg|jpeg|ico|json)$)/i.test(rel))throw Error('Unexpected mod payload path: '+rel);
  if(/\.(dll|asi)$/i.test(rel)&&!/^KCSE\/Plugins\//i.test(rel))throw Error('Native files must remain inside the mod-local KCSE/Plugins folder: '+rel);
  return rel;
}
async function inventory(source,{allowMissing=false}={}) {
  source=path.resolve(source);await ancestors(source);const root=await stat(source);
  if(!root&&allowMissing)return {files:[],directories:[],bytes:0};
  if(!root?.isDirectory())throw Error('Select a regular mod folder.');
  const files=[],directories=[],seen=new Set();let count=0,bytes=0;
  async function walk(dir,depth) {
    for(const entry of await list(dir,LIMITS.entries)) {
      if(++count>LIMITS.entries)throw Error('Mod payload entry limit reached.');
      const file=path.join(dir,entry.name),rel=safeRelative(path.relative(source,file)),key=rel.toLowerCase();
      if(seen.has(key))throw Error('Case-colliding mod payload paths: '+rel);seen.add(key);
      const s=await fs.lstat(file);
      if(s.isSymbolicLink()||s.isFile()&&s.nlink>1)throw Error('Linked or shared mod payload: '+file);
      if(s.isDirectory()) {
        if(depth>=LIMITS.depth)throw Error('Mod payload depth limit reached.');
        directories.push(rel);await walk(file,depth+1);
      }else if(s.isFile()) {
        payloadPath(rel);
        if(s.size>LIMITS.fileBytes||(bytes+=s.size)>LIMITS.bytes)throw Error('Mod payload byte limit reached.');
        files.push({relative:rel,source:file,bytes:s.size,sha256:await hashFile(file)});
      }else throw Error('Special filesystem entry in mod payload: '+file);
    }
  }
  await walk(source,0);files.sort((a,b)=>a.relative.localeCompare(b.relative));directories.sort();
  return {files,directories,bytes};
}
async function identity(source) {
  await ancestors(source);const rows=await list(source,LIMITS.children),manifest=rows.find(e=>e.name.toLowerCase()==='mod.manifest');
  if(!manifest)return null;
  const file=path.join(source,manifest.name),s=await fs.lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink>1||s.size>1024*1024)throw Error('Manifest is linked, shared or oversized: '+file);
  const info=parseManifest(await fs.readFile(file));
  if(info.id!==ID)return {supported:false};
  if(manifest.name!=='mod.manifest')throw Error('Expected the author manifest path mod.manifest.');
  return {supported:true,...info};
}
async function discover(root) {
  root=path.resolve(root);await ancestors(root);const candidates=[],warnings=[],blockers=[];let inspected=0;
  async function visit(dir,depth) {
    try {
      if(++inspected>LIMITS.discovery)throw Error('Desktop folder search limit reached.');
      const s=await stat(dir);if(!s?.isDirectory()||s.isSymbolicLink())return;
      const info=await identity(dir);
      if(info){
        if(info.supported) {
          const candidate={id:ID,name:info.name||'Misc Overhaul Part2',version:info.version,source:dir,folder:ID,blockers:[]};
          try{Object.assign(candidate,await inventory(dir));}catch(e){candidate.blockers.push(e.message);}
          candidates.push(candidate);
        }
        return; // An unrelated mod is a search boundary.
      }
      if(depth>=2)return;
      for(const entry of await list(dir,LIMITS.children))if(entry.isDirectory()&&!entry.isSymbolicLink())await visit(path.join(dir,entry.name),depth+1);
    }catch(e){warnings.push(e.message);}
  }
  await visit(root,0);
  return {root,candidates,warnings:[...new Set(warnings)],blockers};
}
function validateGame(game) {
  if(!game?.root||!game.mods||!game.bin||!same(game.mods,path.join(game.root,'mods'))||!within(game.root,game.bin)||same(game.root,game.bin))throw Error('Import requires the selected game root, mods and executable folder.');
}
function appendOrder(text) {
  const bom=text.startsWith('\uFEFF')?'\uFEFF':'',body=text.slice(bom.length),nl=body.includes('\r\n')?'\r\n':'\n';
  const rows=body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  let kept=rows.filter(row=>row.replace(/[\r\n]+$/,'').trim().toLowerCase()!==ID).join('');
  if(kept&&!/[\r\n]$/.test(kept))kept+=nl;
  return bom+kept+ID+nl;
}
async function orderPlan(game) {
  const target=path.join(game.mods,'mod_order.txt');await ensurePlainPath(game.root,target,{fileMayNotExist:true});const s=await stat(target);
  if(!s)throw Error('No mod_order.txt exists. Use the game or mod manager to establish its load order first.');
  if(!s.isFile()||s.size>1024*1024)throw Error('Load order is not a bounded regular file.');
  const bytes=await fs.readFile(target),text=bytes.toString('utf8');
  if(!Buffer.from(text).equals(bytes)||text.includes('\0'))throw Error('Load order must be valid UTF-8 text.');
  const afterText=appendOrder(text);
  return {target,before:hash(bytes),after:hash(Buffer.from(afterText)),beforeText:text,afterText,changed:text!==afterText};
}
// A local import must not become a second provider for a Steam-managed mod.
// Re-read the bounded inventory: the scan can predate a Steam download/update.
async function workshopGuard(game,source,expected) {
  const workshop=await inspectWorkshop(game),identities=[];
  if(workshop.complete===false||workshop.issues.length)throw Error('Workshop inventory needs review before importing a local mod. Check Steam downloads and scan again.');
  if(workshop.pending)throw Error('Workshop content is incomplete or changing. Finish Steam downloads and scan again.');
  for(const root of workshop.roots)if(within(root,source)||within(source,root))throw Error('Choose an original author download outside Steam Workshop content. Workshop files are managed by Steam.');
  for(const item of workshop.items) {
    if(item.issues?.length||item.state==='pending'||item.state==='missing')throw Error('Workshop content is incomplete or changing. Finish Steam downloads and scan again.');
    for(const mod of item.modRoots) {
      await ancestors(mod.manifestPath);const s=await fs.lstat(mod.manifestPath);
      if(!s.isFile()||s.size>1024*1024)throw Error('Workshop manifest cannot be verified. Scan again after Steam finishes.');
      const bytes=await fs.readFile(mod.manifestPath),info=parseManifest(bytes);
      if(!info.id)throw Error('Workshop mod identity is unknown. Review it in Steam before importing a local mod.');
      identities.push([mod.manifestPath,hash(bytes)]);
      if(info.id.toLowerCase()===ID)throw Error('Misc Overhaul Part2 is already present in Steam Workshop. Manage that copy in Steam; a second local copy will not be imported.');
    }
  }
  const fingerprint=seal({inventory:workshop.fingerprint,identities:identities.sort((a,b)=>a[0].localeCompare(b[0]))});
  if(expected&&fingerprint!==expected)throw Error('Workshop content changed after the import preview. Scan and review again.');
  return fingerprint;
}
function signature(plan) {return seal({root:plan.root,id:plan.id,source:plan.source,target:plan.target,files:plan.files,directories:plan.directories,order:plan.order,workshopFingerprint:plan.workshopFingerprint,blockers:plan.blockers});}
async function preview(report,selected) {
  validateGame(report.game);const game=report.game,source=path.resolve(typeof selected==='string'?selected:selected.source),target=path.join(game.mods,ID);
  const plan={kind:'mod-import',id:ID,name:'Misc Overhaul Part2',root:game.root,source,target,folder:ID,files:[],directories:[],bytes:0,order:null,changes:[],blockers:[],warnings:[]};
  try {
    await ancestors(game.root);await ensurePlainPath(game.root,game.mods);
    if(within(game.root,source)||within(source,game.root))throw Error('Choose an external downloaded mod folder outside the selected game.');
    plan.workshopFingerprint=await workshopGuard(game,source);
    const info=await identity(source);if(!info?.supported)throw Error('The selected folder must have the exact manifest ID '+ID+'.');
    plan.name=info.name||plan.name;plan.version=info.version;Object.assign(plan,await inventory(source));
    if(!plan.files.some(f=>f.relative==='mod.manifest')||!plan.files.some(f=>/^Data\/.+\.pak$/i.test(f.relative)))throw Error('A complete author mod.manifest and Data PAK are required.');
    // Keep the entire mod-local KCSE tree, including plugin resources and config.
    plan.files=plan.files.map(f=>({...f,target:path.join(target,...f.relative.split('/'))}));
    await ensurePlainPath(game.root,target,{fileMayNotExist:true});
    if(await stat(target))throw Error('Destination mod folder already exists. No existing mod will be overwritten or renamed: '+target);
    plan.order=await orderPlan(game);
    await assertManualScope(game,ownershipScope(game,plan.order));
    plan.changes.push({type:'copy',source,target,detail:'Copy the complete Misc Overhaul Part2 folder; keep the download.'});
    if(plan.order.changed)plan.changes.push({type:'order',source:plan.order.target,target:plan.order.target,detail:'Place '+ID+' at the bottom of mod_order.txt.'});
  }catch(e){plan.blockers.push(e.message);}
  plan.changed=plan.changes.length>0;plan.canApply=plan.changed&&!plan.blockers.length;
  plan.summary=plan.canApply?'Import '+plan.files.length+' files and enable Misc Overhaul Part2.':'Import needs review.';
  plan.warning='Use the original author download. File placement does not establish native-plugin safety or runtime compatibility.';
  plan.signature=signature(plan);return plan;
}
async function saveReceipt(file,value) {
  const temp=path.join(path.dirname(file),'.receipt-'+crypto.randomUUID()+'.tmp');
  try{const fh=await fs.open(temp,'wx');try{await fh.writeFile(JSON.stringify(value,null,2));await fh.sync();}finally{await fh.close();}await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
}
async function storePath(store,game,source) {
  const base=path.resolve(store);
  if(within(game.mods,base)||within(game.bin,base)||within(base,game.root)||source&&(within(source,base)||within(base,source)))throw Error('Backup storage overlaps the game or source payload.');
  if(within(game.root,base)&&!within(path.join(game.root,'_mod_audit_backup'),base))throw Error('Game-local receipts belong under _mod_audit_backup.');
  await ancestors(base);await fs.mkdir(base,{recursive:true});await ensurePlainPath(base,base);return base;
}
async function writeOrder(game,order,expected,text,closed,checkWorkshop=async()=>{}) {
  await ensurePlainPath(game.root,order.target);if(await hashFile(order.target)!==expected)throw Error('Load order changed. Scan again.');
  const temp=path.join(path.dirname(order.target),'.mod-import-'+crypto.randomUUID()+'.tmp');
  try{await fs.writeFile(temp,Buffer.from(text),{flag:'wx'});await ensurePlainPath(game.root,order.target);if(await hashFile(order.target)!==expected)throw Error('Load order changed during import.');if(!await closed())throw Error('Close KCD2 before changing load order.');await assertManualScope(game,{subtrees:[],files:[order.target]});await ensurePlainPath(game.root,order.target);if(await hashFile(order.target)!==expected)throw Error('Load order changed during import.');await checkWorkshop();await fs.rename(temp,order.target);}finally{await fs.unlink(temp).catch(()=>{});}
}
async function apply(report,plan,store,{closed=gameClosed}={}) {
  validateGame(report.game);const game=report.game;
  await ancestors(game.root);const base=await storePath(store,game,plan.source);
  return locked(base,game,async()=>{
    await freshGate(game,report.snapshots||{},closed,null,ownershipScope(game,plan.order));
    const fresh=await preview(report,plan.source);
    if(plan.kind!=='mod-import'||plan.signature!==fresh.signature||!fresh.canApply)throw Error('Import preview is stale or blocked. Review the folder again.');
    const dir=path.join(base,crypto.randomUUID());await fs.mkdir(dir);const rp=path.join(dir,'receipt.json');
    const r={kind:KIND,state:'prepared',game,id:ID,source:fresh.source,target:fresh.target,files:fresh.files,directories:fresh.directories,order:fresh.order,time:new Date().toISOString(),completed:[],fileIdentities:{},directoryIdentities:{},rootCreated:false,orderApplied:false};
    const save=()=>saveReceipt(rp,r);
    for(let i=0;i<r.files.length;i++) {
      const f=r.files[i];await ensurePlainPath(r.source,f.source);if(await hashFile(f.source)!==f.sha256)throw Error('Source changed during backup.');
      const backup=path.join(dir,'file-'+i+'.before');await fs.copyFile(f.source,backup,fs.constants.COPYFILE_EXCL);
      if(await hashFile(backup)!==f.sha256)throw Error('Import backup verification failed.');
    }
    await fs.writeFile(path.join(dir,'order.before'),Buffer.from(r.order.beforeText),{flag:'wx'});await save();
    try {
      await freshGate(game,report.snapshots||{},closed,null,ownershipScope(game,r.order));
      if((await preview(report,r.source)).signature!==fresh.signature)throw Error('Import changed during backup. Review again.');
      if(!await closed())throw Error('Close KCD2 before importing.');
      r.rootIntent=true;await save();if(!await closed())throw Error('KCD2 started during import.');await assertManualScope(game,{subtrees:[r.target],files:[]});await workshopGuard(game,r.source,fresh.workshopFingerprint);await fs.mkdir(r.target);
      r.rootCreated=true;r.rootIdentity=fileIdentity(await fs.lstat(r.target));await save();
      for(const relative of [...r.directories].sort((a,b)=>a.split('/').length-b.split('/').length)) {
        const dir=path.join(r.target,...relative.split('/'));await ensurePlainPath(game.root,dir,{fileMayNotExist:true});if(!await closed())throw Error('KCD2 started during import.');await assertManualScope(game,{subtrees:[r.target],files:[]});await fs.mkdir(dir);
        r.directoryIdentities[relative]=fileIdentity(await fs.lstat(dir));await save();
      }
      for(let i=0;i<r.files.length;i++) {
        const f=r.files[i];if(!await closed())throw Error('KCD2 started during import.');
        await ensurePlainPath(r.source,f.source);await ensurePlainPath(game.root,f.target,{fileMayNotExist:true});
        if(await hashFile(f.source)!==f.sha256)throw Error('Source changed during import.');
        r.copyIntent=i;await save();if(!await closed())throw Error('KCD2 started during import.');await assertManualScope(game,{subtrees:[r.target],files:[]});await workshopGuard(game,r.source,fresh.workshopFingerprint);await fs.copyFile(f.source,f.target,fs.constants.COPYFILE_EXCL);
        if(await hashFile(f.target)!==f.sha256||await hashFile(f.source)!==f.sha256)throw Error('Import copy verification failed.');
        r.completed.push(i);r.fileIdentities[i]=fileIdentity(await fs.lstat(f.target));delete r.copyIntent;await save();
      }
      if(r.order.changed){if(!await closed())throw Error('KCD2 started during import.');r.orderIntent=true;await save();await writeOrder(game,r.order,r.order.before,r.order.afterText,closed,()=>workshopGuard(game,r.source,fresh.workshopFingerprint));r.orderApplied=true;await save();}
      const installed=await inventory(r.target);
      if(seal(installed.files.map(({relative,bytes,sha256})=>({relative,bytes,sha256})))!==seal(r.files.map(({relative,bytes,sha256})=>({relative,bytes,sha256}))))throw Error('Installed payload changed during import.');
      if(await hashFile(r.order.target)!==r.order.after)throw Error('Load-order verification failed.');
      r.state='applied';await save();return {receipt:rp,changed:fresh.changes.map(c=>c.target)};
    }catch(e){r.state='partial';r.error=e.message;await save();throw Error(e.message+' Recovery receipt: '+rp);}
  });
}
async function undo(receiptPath,store,{closed=gameClosed}={}) {
  const rp=path.resolve(receiptPath),base=path.resolve(store);
  if(!within(base,rp)||same(base,path.dirname(rp))||path.basename(rp)!=='receipt.json')throw Error('Unknown import receipt.');
  await ancestors(base);await ensurePlainPath(base,rp);const r=JSON.parse(await fs.readFile(rp,'utf8'));
  if(r.kind!==KIND||r.id!==ID||!['prepared','applied','partial','undo-in-progress','undo-needs-review'].includes(r.state))throw Error('No reversible mod import is recorded.');
  validateGame(r.game);await ancestors(r.game.root);await storePath(base,r.game);
  if(!same(r.target,path.join(r.game.mods,ID))||!Array.isArray(r.files)||!r.files.length||r.files.length>LIMITS.entries||!Array.isArray(r.directories)||r.directories.length>LIMITS.entries)throw Error('Invalid import receipt target or payload.');
  if(!Array.isArray(r.completed)||r.completed.some(i=>!Number.isInteger(i)||i<0||i>=r.files.length)||new Set(r.completed).size!==r.completed.length)throw Error('Invalid import ownership receipt.');
  const seen=new Set();
  for(let i=0;i<r.files.length;i++) {
    const f=r.files[i],rel=payloadPath(f.relative);
    if(!same(f.target,path.join(r.target,...rel.split('/')))||seen.has(rel.toLowerCase())||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid import receipt file.');
    seen.add(rel.toLowerCase());const backup=path.join(path.dirname(rp),'file-'+i+'.before');await ensurePlainPath(base,backup);if(await hashFile(backup)!==f.sha256)throw Error('Import backup changed.');
  }
  const dirs=new Set();for(const rel of r.directories){safeRelative(rel);if(dirs.has(rel.toLowerCase()))throw Error('Duplicate receipt directory.');dirs.add(rel.toLowerCase());}
  if(!r.order||typeof r.order.beforeText!=='string'||typeof r.order.afterText!=='string'||r.order.beforeText.length>1024*1024||!same(r.order.target,path.join(r.game.mods,'mod_order.txt'))||hash(Buffer.from(r.order.beforeText))!==r.order.before||hash(Buffer.from(r.order.afterText))!==r.order.after||appendOrder(r.order.beforeText)!==r.order.afterText||r.order.changed!==(r.order.before!==r.order.after))throw Error('Invalid import load-order receipt.');
  const orderBackup=path.join(path.dirname(rp),'order.before');await ensurePlainPath(base,orderBackup);if(await hashFile(orderBackup)!==r.order.before)throw Error('Load-order backup changed.');
  return locked(base,r.game,async()=>{
    await freshGate(r.game,{},closed,null,ownershipScope(r.game,r.order));
    async function preflight() {
      await assertManualScope(r.game,ownershipScope(r.game,r.order));
      await ensurePlainPath(r.game.root,r.target,{fileMayNotExist:true});
      const targetStat=await stat(r.target);
      if(targetStat&&(!r.rootCreated||!owns(targetStat,r.rootIdentity)))throw Error('Import target ownership is ambiguous. Inspect its recovery receipt.');
      const installed=await inventory(r.target,{allowMissing:true});
      for(const f of installed.files){const index=r.files.findIndex(x=>x.relative===f.relative),expected=r.files[index];if(!expected||expected.sha256!==f.sha256)throw Error('Cannot undo an externally changed import: '+f.source);if(!r.completed.includes(index)||!owns(await fs.lstat(f.source),r.fileIdentities?.[index]))throw Error('Imported file ownership is ambiguous: '+f.source);}
      for(const rel of installed.directories){if(!dirs.has(rel.toLowerCase()))throw Error('Cannot undo a folder added after import: '+rel);if(!owns(await fs.lstat(path.join(r.target,...rel.split('/'))),r.directoryIdentities?.[rel]))throw Error('Imported directory ownership is ambiguous: '+rel);}
      let current=null;if(r.order.changed){await ensurePlainPath(r.game.root,r.order.target);current=await hashFile(r.order.target);}
      if(r.order.changed&&current!==r.order.before&&current!==r.order.after)throw Error('Load order changed after import. Undo is blocked.');
      if(r.order.changed&&current===r.order.after&&!r.orderApplied)throw Error('Load-order change ownership is ambiguous. Inspect the recovery receipt.');
      return {installed,current};
    }
    await preflight();r.state='undo-in-progress';await saveReceipt(rp,r);
    try {
      const {installed,current}=await preflight();
      if(current===r.order.after&&r.order.changed){if(!await closed())throw Error('Close KCD2 before undo.');await writeOrder(r.game,r.order,r.order.after,r.order.beforeText,closed);}
      for(const f of installed.files.reverse()) {
        if(!await closed())throw Error('KCD2 started during undo.');await ensurePlainPath(r.game.root,f.source);
        const index=r.files.findIndex(x=>x.relative===f.relative),quarantine=path.join(path.dirname(rp),'removed-'+index+'.bin');
        if(await hashFile(f.source)!==f.sha256||!owns(await fs.lstat(f.source),r.fileIdentities[index]))throw Error('Imported file changed during undo.');
        await ensurePlainPath(base,quarantine,{fileMayNotExist:true});if(!await stat(quarantine))await fs.copyFile(f.source,quarantine,fs.constants.COPYFILE_EXCL);
        if(await hashFile(quarantine)!==f.sha256||await hashFile(f.source)!==f.sha256)throw Error('Undo quarantine verification failed.');if(!await closed())throw Error('KCD2 started during undo.');await assertManualScope(r.game,{subtrees:[r.target],files:[]});await ensurePlainPath(r.game.root,f.source);if(!owns(await fs.lstat(f.source),r.fileIdentities[index])||await hashFile(f.source)!==f.sha256)throw Error('Imported file changed during undo.');await fs.unlink(f.source);await saveReceipt(rp,r);
      }
      for(const relative of [...r.directories].sort((a,b)=>b.split('/').length-a.split('/').length)) {
        const dir=path.join(r.target,...relative.split('/'));await ensurePlainPath(r.game.root,dir,{fileMayNotExist:true});const s=await stat(dir);if(s){if(!await closed())throw Error('KCD2 started during undo.');if(!owns(s,r.directoryIdentities[relative]))throw Error('Imported directory changed during undo.');await assertManualScope(r.game,{subtrees:[r.target],files:[]});await fs.rmdir(dir);}
      }
      await ensurePlainPath(r.game.root,r.target,{fileMayNotExist:true});const rootStat=await stat(r.target);if(rootStat){if(!await closed())throw Error('KCD2 started during undo.');if(!owns(rootStat,r.rootIdentity))throw Error('Import root changed during undo.');await assertManualScope(r.game,{subtrees:[r.target],files:[]});await fs.rmdir(r.target);}
      if(r.order.changed&&await hashFile(r.order.target)!==r.order.before)throw Error('Undo load-order verification failed.');
      r.state='undone';await saveReceipt(rp,r);return {changed:[r.target,...r.order.changed?[r.order.target]:[]]};
    }catch(e){r.state='undo-needs-review';r.error=e.message;await saveReceipt(rp,r);throw e;}
  });
}
module.exports={discover,preview,apply,undo,ID,LIMITS};
