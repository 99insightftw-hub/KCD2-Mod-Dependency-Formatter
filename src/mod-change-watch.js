'use strict';
// Cheap evidence for deciding when to request a fresh full scan. Never a status verdict.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {parseManifest}=require('./scanner');
const {discoverWorkshop,inspectWorkshop}=require('./workshop');
const MAX_ROWS=12000,MAX_DIR=3000,MAX_MODS=1000,MAX_MANIFEST=256*1024,MAX_ORDER=2*1024*1024;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const stat=async p=>fs.lstat(p,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const metadata=s=>({type:s.isDirectory()?'dir':s.isFile()?'file':s.isSymbolicLink()?'link':'other',size:String(s.size),mtimeNs:String(s.mtimeNs),dev:String(s.dev),ino:String(s.ino),links:String(s.nlink)});
const normalized=p=>path.resolve(p).replace(/\\/g,'/').toLowerCase();
async function snapshot(game){
  if(!game||typeof game.root!=='string'||typeof game.mods!=='string'||typeof game.bin!=='string')throw Error('Select a game before checking for mod changes.');
  const rows=[],issues=[],warnings=[],counts={mods:0,workshopMods:0,files:0},issue=(p,reason)=>{if(issues.length<30)issues.push({path:p,reason});},warn=(p,reason)=>{if(warnings.length<30)warnings.push({path:p,reason});};
  function record(p,kind,value){if(rows.length>=MAX_ROWS){issue(p,'Snapshot row limit reached');throw Error('Snapshot row limit reached');}rows.push([normalized(p),kind,value]);}
  async function file(p,{manifest=false,order=false,steamMetadata=false}={}){
    let s;try{s=await stat(p);}catch(e){issue(p,'Cannot inspect file: '+e.message);return null;}
    if(!s){record(p,'missing',null);return null;}
    record(p,'metadata',metadata(s));
    // Vortex deploys regular hardlinks. Reading them is safe; shared identity is
    // recorded above and must not disable change monitoring for the whole game.
    if(!s.isFile()){issue(p,'Linked or non-file evidence');return null;}
    counts.files++;
    if(!manifest&&!order&&!steamMetadata)return s;
    const label=manifest?'Manifest':steamMetadata?'Steam Workshop metadata':'Load order';
    const cap=manifest?MAX_MANIFEST:MAX_ORDER;if(s.size>BigInt(cap)){issue(p,label+' exceeds read limit');return null;}
    try{
      const bytes=await fs.readFile(p),again=await stat(p);
      if(!again?.isFile()||again.dev!==s.dev||again.ino!==s.ino||again.mtimeNs!==s.mtimeNs||again.size!==s.size){issue(p,'File changed during snapshot');return null;}
      record(p,'sha256',sha(bytes));
      if(manifest){
        try{const info=parseManifest(bytes);if(!info.id&&!info.name)warn(p,'Manifest has no mod identity');record(p,'manifest-id',info.id||'');}
        catch(e){warn(p,'Manifest XML needs review: '+e.message);}
      }else if(order){
        try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(text.includes('\0'))warn(p,'Load order contains NUL bytes');}
        catch(e){warn(p,'Load-order encoding needs review: '+e.message);}
      }
    }catch(e){issue(p,'Invalid or unreadable '+label.toLowerCase()+': '+e.message);}
    return s;
  }
  async function directory(p,{optional=true}={}){
    let before,entries;try{before=await stat(p);if(!before){record(p,'missing',null);if(!optional)issue(p,'Required directory is missing');return null;}
      record(p,'metadata',metadata(before));if(!before.isDirectory()||before.isSymbolicLink()){issue(p,'Directory is linked or is not a directory');return null;}
      entries=await fs.readdir(p,{withFileTypes:true});
    }catch(e){issue(p,'Cannot list directory: '+e.message);return null;}
    if(entries.length>MAX_DIR){issue(p,`Directory has more than ${MAX_DIR} entries`);return null;}
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const e of entries)record(path.join(p,e.name),'entry',e.isDirectory()?'dir':e.isFile()?'file':e.isSymbolicLink()?'link':'other');
    try{const after=await stat(p);if(!after||after.dev!==before.dev||after.ino!==before.ino||after.mtimeNs!==before.mtimeNs)issue(p,'Directory changed during snapshot');}
    catch(e){issue(p,'Directory changed during snapshot: '+e.message);}
    return entries;
  }
  async function shallow(p,accept,{optional=true}={}){
    const entries=await directory(p,{optional});if(!entries)return;
    for(const e of entries.filter(accept))await file(path.join(p,e.name));
  }
  async function scripts(root){
    let visited=0;
    async function walk(dir,depth){
      const entries=await directory(dir);if(!entries)return;
      for(const e of entries){
        if(++visited>3000){issue(root,'Scripts subtree exceeds 3000 entries');return;}
        const p=path.join(dir,e.name);
        if(e.isSymbolicLink()){issue(p,'Linked script path');continue;}
        if(e.isDirectory()){if(depth>=5){issue(p,'Scripts subtree exceeds depth 5');continue;}await walk(p,depth+1);}
        else if(/\.lua$/i.test(e.name))await file(p);
      }
    }
    await walk(root,0);
  }
  async function mod(root,workshop=false,entries=null){
    entries ||=await directory(root,{optional:false});if(!entries)return;
    const manifest=entries.find(e=>e.name.toLowerCase()==='mod.manifest');
    if(!manifest)warn(root,'Folder has no direct mod.manifest; observed as non-mod or partial install');
    else{await file(path.join(root,manifest.name),{manifest:true});if(workshop)counts.workshopMods++;else counts.mods++;}
    for(const name of ['Data','Localization'])await shallow(path.join(root,name),e=>/\.(pak|lua)$/i.test(e.name));
    await shallow(path.join(root,'KCSE','Plugins'),e=>/\.(dll|asi|ini|bin)$/i.test(e.name));
    await shallow(path.join(root,'KCSE','addresslib'),e=>/\.(bin|ini)$/i.test(e.name));
    const scriptsRoot=path.join(root,'Scripts');if(await stat(scriptsRoot))await scripts(scriptsRoot);
    const dataScripts=path.join(root,'Data','Scripts');if(await stat(dataScripts))await scripts(dataScripts);
    for(const e of entries.filter(e=>e.isFile()&&/^(?:mod\.cfg|[^/]+\.(?:ini|lua))$/i.test(e.name)))await file(path.join(root,e.name));
  }
  try{
    const rootEntries=await directory(game.root,{optional:false});
    for(const e of rootEntries||[])if(/^vortex\.deployment.*\.json$/i.test(e.name))await file(path.join(game.root,e.name),{order:true});
    await shallow(game.bin,e=>/\.(dll|asi|ini|bin)$/i.test(e.name)||/^KingdomCome\.exe$/i.test(e.name),{optional:false});
    await shallow(path.join(game.root,'KCSE','Plugins'),e=>/\.(dll|asi|ini|bin)$/i.test(e.name));
    await shallow(path.join(game.root,'KCSE','addresslib'),e=>/\.(bin|ini)$/i.test(e.name));
    const local=await directory(game.mods);
    for(const e of local||[])if(/^vortex\.deployment.*\.json$/i.test(e.name))await file(path.join(game.mods,e.name),{order:true});
    if(local){
      if(local.length>MAX_MODS)issue(game.mods,`Mods folder exceeds ${MAX_MODS} entries`);
      for(const e of local.slice(0,MAX_MODS)){
        if(e.name.toLowerCase()==='mod_order.txt'){await file(path.join(game.mods,e.name),{order:true});continue;}
        if(e.isSymbolicLink()){issue(path.join(game.mods,e.name),'Linked mod folder');continue;}
        if(!e.isDirectory()||e.name.startsWith('.'))continue;
        if(/^(?:logs?|backups?|mod_backups|_mod_audit_backup)$/i.test(e.name))continue;
        const root=path.join(game.mods,e.name),s=await directory(root);
        if(!s)continue;
        if(s.length)await mod(root,false,s);
      }
    }
    // Keep absent candidates: a first subscription can create the folder after
    // the full scan. Steam's ACF can change before any payload directory does.
    // The selected report can outlive Steam's library list. Rediscover bounded
    // candidates so a newly registered library is noticed without reopening.
    const discovered=game.distribution==='steam'?await discoverWorkshop(game.root,{distribution:game.distribution}):{roots:[],metadataFiles:[],issues:[]};
    for(const problem of discovered.issues)issue(problem.path,problem.reason);
    record(game.root,'workshop-libraries',discovered.roots.map(normalized).sort());
    const candidates=[...(Array.isArray(game.workshopRoots)?game.workshopRoots:[game.workshop]),...discovered.roots].filter(p=>typeof p==='string'&&p);
    const workshopRoots=[...new Map(candidates.map(p=>[normalized(p),p])).values()];
    const metadataFiles=[...new Map([...(Array.isArray(game.workshopMetadataFiles)?game.workshopMetadataFiles:[]),...discovered.metadataFiles].filter(p=>typeof p==='string'&&p).map(p=>[normalized(p),p])).values()];
    if(workshopRoots.length>32||metadataFiles.length>32)throw Error('Workshop library count exceeds 32');
    // The full bounded inventory includes nested payload metadata (not PAK
    // contents). Shallow conventional locations alone miss in-place updates.
    // ACF bytes are monitored separately below; this pass tracks payload only.
    const inventory=await inspectWorkshop({...game,workshopRoots,workshopMetadataFiles:[],workshopDiscoveryIssues:discovered.issues});
    record(game.root,'workshop-inventory',inventory.fingerprint);
    for(const problem of inventory.issues){
      if(problem.reason==='Workshop item has no discoverable mod manifest')warn(problem.path,problem.reason);
      else issue(problem.path,problem.reason);
    }
    for(const metadataFile of metadataFiles)await file(metadataFile,{steamMetadata:true});
    for(const workshopRoot of workshopRoots){
      const workshop=await directory(workshopRoot);
      if(workshop){
        if(workshop.length>MAX_MODS)issue(workshopRoot,`Workshop folder exceeds ${MAX_MODS} entries`);
        for(const e of workshop.slice(0,MAX_MODS)){
          if(e.isSymbolicLink()){issue(path.join(workshopRoot,e.name),'Linked Workshop item');continue;}
          if(!e.isDirectory())continue;
          const item=path.join(workshopRoot,e.name),children=await directory(item);if(!children)continue;
          if(children.some(c=>c.name.toLowerCase()==='mod.manifest'))await mod(item,true,children);
          else{
            if(children.length>50){issue(item,'Workshop item exceeds 50 entries');continue;}
            for(const child of children){
              if(child.isSymbolicLink()){issue(path.join(item,child.name),'Linked Workshop mod');continue;}
              if(!child.isDirectory())continue;
              const root=path.join(item,child.name),sub=await directory(root);if(sub?.some(c=>c.name.toLowerCase()==='mod.manifest'))await mod(root,true,sub);
            }
          }
        }
      }
    }
  }catch(e){issue(game.root,'Snapshot stopped: '+e.message);}
  rows.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
  return {signature:sha(Buffer.from(JSON.stringify(rows))),complete:issues.length===0,detail:{...counts,rows:rows.length,issues,warnings}};
}
module.exports={snapshot};
