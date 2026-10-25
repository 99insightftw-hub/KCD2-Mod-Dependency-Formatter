'use strict';
// Content/layout recovery only. Never changes Vortex profiles or staging.
const fs=require('fs/promises'),nodefs=require('fs'),path=require('path'),crypto=require('crypto');
const {exportGate}=require('./downloads'),{ensurePlainPath,locked}=require('./repairs');
const {vortexState}=require('./scanner'),{safeRelative}=require('./io');
const {execFile}=require('child_process'),{promisify}=require('util');
const run=promisify(execFile);
const rootFile=n=>/\.(dll|asi|ini|cfg|json)$/i.test(n);
const deployment=n=>/^vortex\.deployment(?:\..*)?\.json$/i.test(n)||n.toLowerCase()==='vortex.deployment.json';
const roots=g=>({mods:g.mods,bin:g.bin,kcse:path.join(g.root,'KCSE'),root:g.root});
async function digest(file){const h=crypto.createHash('sha256');for await(const b of nodefs.createReadStream(file))h.update(b);return h.digest('hex');}
function processesStopped(stdout){
 const lines=stdout.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
 if(!lines.length||lines.some(l=>!/^"[^"]+","/.test(l)))throw Error('Could not verify the game/Vortex process list. No baseline operation is allowed.');
 return !lines.some(l=>/^"(KingdomCome|Vortex)\.exe",/i.test(l));
}
async function stopped(){const {stdout}=await run('tasklist.exe',['/FO','CSV','/NH'],{windowsHide:true,timeout:5000,maxBuffer:4*1024*1024});return processesStopped(stdout);}
async function gate(game,closed,{copyOnly=false}={}){
 if(!await closed())throw Error('Close KCD2 and Vortex first.');
 const v=await vortexState(game);
 if(!copyOnly&&(v.errors.length||v.manifests.some(m=>m.files.length)))throw Error('Vortex deployment is present or unverified. Purge through Vortex and close it before restoring.');
 return {kind:v.errors.length?'vortex-unverified':v.manifests.some(m=>m.files.length)?'vortex-deployed':'unmanaged-or-purged',deploymentRecords:v.manifests.length};
}
async function inventory(game,{progress=()=>{}}={}){
 const files=[],dirs=[],map=roots(game);let count=0,bytes=0;
 async function walk(scope,dir,relative='',depth=0){
  if(depth>32)throw Error('Backup depth limit reached.');
  const stat=await fs.lstat(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!stat)return;
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Backup folder is linked or invalid: '+dir);
  if(scope!=='root')dirs.push(scope+(relative?'/'+relative:''));
  for(const e of await fs.readdir(dir,{withFileTypes:true})){
   if(deployment(e.name))continue; // Vortex owns these receipts, even after purge.
   if(scope==='root'&&!rootFile(e.name))continue;
   if(++count>200000)throw Error('Backup file-count limit reached.');
   const file=path.join(dir,e.name),rel=relative?relative+'/'+e.name:e.name;
   safeRelative(rel);
   if(e.isSymbolicLink())throw Error('Linked backup path is not supported: '+file);
   if(e.isDirectory()){if(scope!=='root')await walk(scope,file,rel,depth+1);}
   else if(e.isFile()){
    const s=await fs.stat(file);bytes+=s.size;if(bytes>100*1024**3)throw Error('Backup exceeds 100 GiB. Reduce or relocate unrelated archives first.');
    progress('Checking backup file: '+scope+'/'+rel);
    files.push({key:scope+'/'+rel,size:s.size,sha256:await digest(file)});
   }else throw Error('Unsupported backup path: '+file);
  }
 }
 for(const [scope,dir] of Object.entries(map))await walk(scope,dir);
 files.sort((a,b)=>a.key.localeCompare(b.key));dirs.sort();
 return {schema:1,game:{root:game.root,bin:game.bin,mods:game.mods},dirs,files,bytes};
}
const signature=x=>JSON.stringify({dirs:x.dirs,files:x.files});
function target(game,key){
 const parts=safeRelative(key).split('/'),scope=parts.shift(),map=roots(game);
 if(!Object.hasOwn(map,scope)||!parts.length)throw Error('Unsafe baseline member');
 if(scope==='root'&&(parts.length!==1||!rootFile(parts[0])))throw Error('Unexpected root baseline member');
 return path.join(map[scope],...parts);
}
async function plain(game,key){const file=target(game,key);const base=key.startsWith('mods/')?path.dirname(game.mods):game.root;await ensurePlainPath(base,file,{fileMayNotExist:true});}
async function previewBackup(game,{closed=stopped,progress}={}){const origin=await gate(game,closed,{copyOnly:true});return {...await inventory(game,{progress}),origin};}
async function createBackup(game,plan,destination,{closed=stopped,progress=()=>{}}={}){
 const origin=await gate(game,closed,{copyOnly:true});await exportGate(game,destination);
 if((await fs.readdir(destination).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).length)throw Error('Choose a new empty backup folder.');
 const current=await inventory(game,{progress});if(signature(current)!==signature(plan))throw Error('Backup source changed. Preview again.');
 await fs.mkdir(destination,{recursive:true});
 const receipt=path.join(destination,'baseline.json');await fs.writeFile(receipt,JSON.stringify({state:'incomplete',...plan},null,2),{flag:'wx'});
 for(const d of plan.dirs){const dir=path.join(destination,'payload',...safeRelative(d).split('/'));await ensurePlainPath(destination,dir,{fileMayNotExist:true});await fs.mkdir(dir,{recursive:true});}
 let copied=0;
 for(const f of plan.files){
  if(copied++%50===0)await gate(game,closed,{copyOnly:true});const src=target(game,f.key),out=path.join(destination,'payload',...f.key.split('/'));
  progress('Backing up: '+f.key);await ensurePlainPath(destination,out,{fileMayNotExist:true});await fs.mkdir(path.dirname(out),{recursive:true});await fs.copyFile(src,out,nodefs.constants.COPYFILE_EXCL);
  if(await digest(out)!==f.sha256||await digest(src)!==f.sha256)throw Error('Backup verification failed: '+f.key);
 }
 if(signature(await inventory(game,{progress}))!==signature(plan))throw Error('Setup changed during backup. Backup remains incomplete.');
 const finalOrigin=await gate(game,closed,{copyOnly:true});
 if(JSON.stringify(origin)!==JSON.stringify(finalOrigin))throw Error('Vortex deployment state changed during backup. Backup remains incomplete.');
 const complete={state:'complete',created:new Date().toISOString(),...plan,origin};await fs.writeFile(receipt,JSON.stringify(complete,null,2));
 return {destination,files:plan.files.length,bytes:plan.bytes};
}
async function loadBackup(game,folder){
 await exportGate(game,folder);await ensurePlainPath(folder,path.join(folder,'baseline.json'));
 const stat=await fs.stat(path.join(folder,'baseline.json'));if(stat.size>64*1024**2)throw Error('Backup manifest too large.');
 const r=JSON.parse(await fs.readFile(path.join(folder,'baseline.json'),'utf8'));
 if(r.schema!==1||r.state!=='complete'||!Array.isArray(r.files)||!Array.isArray(r.dirs)||r.files.length>200000||r.dirs.length>200000)throw Error('Incomplete or unsupported backup.');
 if(JSON.stringify(r.game)!==JSON.stringify({root:game.root,bin:game.bin,mods:game.mods}))throw Error('Backup belongs to another installation.');
 const seen=new Set();
 for(const key of ['bin/WHGame.dll','bin/KingdomCome.exe'])if(!r.files.some(f=>f.key.toLowerCase()===key.toLowerCase()))throw Error('Backup is missing the game identity files.');
 for(const f of r.files){
  target(game,f.key);if(seen.has(f.key.toLowerCase()))throw Error('Duplicate backup member');seen.add(f.key.toLowerCase());
  if(!/^[a-f0-9]{64}$/i.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0)throw Error('Invalid backup member');
  const file=path.join(folder,'payload',...f.key.split('/'));await ensurePlainPath(folder,file);
  if((await fs.stat(file)).size!==f.size||await digest(file)!==f.sha256)throw Error('Backup bytes changed: '+f.key);
 }
 const directoryKeys=new Set();
 for(const d of r.dirs){
  const parts=safeRelative(d).split('/');if(!['mods','bin','kcse'].includes(parts[0])||directoryKeys.has(d.toLowerCase()))throw Error('Unsafe or duplicate backup directory');
  directoryKeys.add(d.toLowerCase());const dir=path.join(folder,'payload',...parts);await ensurePlainPath(folder,dir);
  if(!(await fs.stat(dir)).isDirectory())throw Error('Backup directory is missing');
 }
 for(const f of r.files.filter(f=>!f.key.startsWith('root/'))){let parent=path.posix.dirname(f.key);while(parent!=='.'){if(!directoryKeys.has(parent.toLowerCase()))throw Error('Incomplete backup directory closure');parent=path.posix.dirname(parent);}}
 return r;
}
async function previewRestore(game,folder,{closed=stopped,progress}={}){
 await gate(game,closed);const backup=await loadBackup(game,folder),current=await inventory(game,{progress});
 const before=new Map(current.files.map(f=>[f.key,f])),after=new Map(backup.files.map(f=>[f.key,f]));
 const changed=backup.files.filter(f=>before.get(f.key)?.sha256!==f.sha256),extra=current.files.filter(f=>!after.has(f.key));
 // Game binary identity must match: never roll back an updated game installation.
 const wh=key=>key.toLowerCase()==='bin/whgame.dll'||key.toLowerCase()==='bin/kingdomcome.exe';
 if(backup.files.filter(f=>wh(f.key)).some(f=>before.get(f.key)?.sha256!==f.sha256))throw Error('Game build changed. Do not restore this baseline over a different game version.');
 for(const f of [...changed,...extra])await plain(game,f.key);
 return {folder,backup,current,changed:changed.map(f=>f.key),extra:extra.map(f=>f.key)};
}
async function restoreBackup(game,plan,store,{closed=stopped,progress=()=>{}}={}){
 return locked(store,game,async()=>{
  const fresh=await previewRestore(game,plan.folder,{closed,progress});if(signature(fresh.current)!==signature(plan.current)||signature(fresh.backup)!==signature(plan.backup))throw Error('Restore preview changed. Preview again.');
  const recovery=path.join(path.dirname(plan.folder),'safety-before-restore-'+crypto.randomUUID());
  await createBackup(game,fresh.current,recovery,{closed,progress});
  if(signature(await inventory(game,{progress}))!==signature(fresh.current))throw Error('Setup changed. Restore cancelled; safety backup retained.');
  const receipt=path.join(recovery,'restore.json'),r={state:'prepared',baseline:plan.folder,recovery,changed:[],extra:[]};
  await fs.writeFile(receipt,JSON.stringify(r,null,2),{flag:'wx'});
  try{
   const expected=new Map(fresh.current.files.map(f=>[f.key,f.sha256]));
   for(const key of [...fresh.changed,...fresh.extra]){
    await gate(game,closed);await plain(game,key);const file=target(game,key),s=await fs.stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if((s?await digest(file):undefined)!==expected.get(key))throw Error('External file change during restore: '+key);
    if(fresh.extra.includes(key)){await fs.unlink(file);r.extra.push(key);}
    else{
     await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.baseline-'+crypto.randomUUID()+'.tmp';
     try{await fs.copyFile(path.join(plan.folder,'payload',...key.split('/')),tmp,nodefs.constants.COPYFILE_EXCL);if(await digest(tmp)!==fresh.backup.files.find(f=>f.key===key).sha256)throw Error('Backup changed during restore');await plain(game,key);await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(()=>{});}
     r.changed.push(key);
    }
    r.state='in-progress';await fs.writeFile(receipt,JSON.stringify(r,null,2));
   }
   const map=roots(game);
   for(const d of fresh.backup.dirs){const [scope,...rel]=d.split('/'),dir=path.join(map[scope],...rel);await ensurePlainPath(scope==='mods'?path.dirname(game.mods):game.root,dir,{fileMayNotExist:true});await fs.mkdir(dir,{recursive:true});}
   for(const d of [...fresh.current.dirs].reverse().filter(d=>!fresh.backup.dirs.includes(d))){const [scope,...rel]=d.split('/'),dir=path.join(map[scope],...rel);await ensurePlainPath(scope==='mods'?path.dirname(game.mods):game.root,dir);await fs.rmdir(dir);}
   if(signature(await inventory(game,{progress}))!==signature(fresh.backup))throw Error('Restored setup does not match the baseline.');
   r.state='restored';await fs.writeFile(receipt,JSON.stringify(r,null,2));return {recovery,receipt};
  }catch(e){r.state='needs-review';r.error=e.message;await fs.writeFile(receipt,JSON.stringify(r,null,2));throw Error(e.message+' Safety backup retained at '+recovery);}
 });
}
module.exports={previewBackup,createBackup,previewRestore,restoreBackup,inventory,processesStopped};
