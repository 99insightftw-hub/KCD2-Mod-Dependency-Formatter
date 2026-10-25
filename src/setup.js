'use strict';
// Focused, offline layout repair. Recognition is not a compatibility verdict.
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const {hash,hashFile,safeRelative,nativeInfo,zipInspect}=require('./io');
const {parseManifest}=require('./scanner');
const {canonical,fingerprints,gameReferences,catalog}=require('./catalog');
const {ensurePlainPath,freshGate,gameClosed,locked,assertManualScope}=require('./repairs');
const MODS=new Set(['elfis_combat','kcdutils','luautils']);
const DEPENDENCIES=new Set(['kcse','addresslib','kcdutils','luautils']);
const OPTIONAL_NATIVE=new Set(catalog.filter(c=>c.activation===true).map(c=>c.id));
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const within=(a,b)=>same(a,b)||path.resolve(b).toLowerCase().startsWith(path.resolve(a).toLowerCase()+path.sep);
const stat=async p=>fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const seal=x=>hash(Buffer.from(JSON.stringify(x)));
const lockRoot=game=>path.join(game.root,'_mod_audit_backup','elfis-combat-setup-lock');
async function saveReceipt(file,value) {
  const temp=path.join(path.dirname(file),'.receipt-'+crypto.randomUUID()+'.tmp');
  const handle=await fs.open(temp,'wx');
  try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
  try{await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
}
async function plainAncestors(target) {
  let p=path.resolve(target);
  while(true){const s=await stat(p);if(s?.isSymbolicLink())throw Error('Linked path or ancestor is not supported: '+p);const parent=path.dirname(p);if(parent===p)break;p=parent;}
}

async function inventory(game) {
  // Find manifests before descending. An unrelated mod is a discovery boundary;
  // only a supported payload that will move needs a complete recursive inventory.
  const files=[],warnings=[],blockers=[],linked=[];let wrapperCount=0,wrapperLimited=false;
  async function list(dir,limit,onLimit) {
    const rows=[],handle=await fs.opendir(dir);
    for await(const entry of handle){if(rows.length===limit){onLimit();break;}rows.push(entry);}
    return rows.sort((a,b)=>a.name.localeCompare(b.name));
  }
  function add(file,s){files.push({path:file,size:s.size,linked:s.nlink>1});}
  async function shallow(dir,accept) {
    const s=await stat(dir);if(!s)return;
    if(s.isSymbolicLink()){linked.push(dir);warnings.push('Linked dependency evidence left in place: '+dir);return;}
    if(!s.isDirectory())return;
    for(const e of await list(dir,3000,()=>warnings.push('Some installed dependency evidence was outside the shallow scan limit.'))) {
      if(!accept(e.name))continue;const p=path.join(dir,e.name),st=await fs.lstat(p);
      if(st.isSymbolicLink()){linked.push(p);continue;}if(st.isFile())add(p,st);
    }
  }
  async function payload(root) {
    let count=0,limited=false;
    const limit=()=>{if(!limited)blockers.push('Supported mod payload exceeds the safe scan limit: '+root);limited=true;};
    async function walk(dir,depth) {
      if(limited)return;
      for(const e of await list(dir,12000,limit)) {
        if(++count>12000){limit();return;}
        const p=path.join(dir,e.name),s=await fs.lstat(p);
        if(s.isSymbolicLink()){linked.push(p);continue;}
        if(s.isDirectory()){if(depth>=12){limit();return;}await walk(p,depth+1);}
        else if(s.isFile())add(p,s);
      }
    }
    await walk(root,0);
  }
  async function discover(dir,depth) {
    const s=await stat(dir);if(!s)return;
    if(s.isSymbolicLink()){linked.push(dir);return;}if(!s.isDirectory())return;
    const entries=await list(dir,3000,()=>{wrapperLimited=true;});
    const manifest=entries.find(e=>e.name.toLowerCase()==='mod.manifest');
    if(manifest) {
      const p=path.join(dir,manifest.name),ms=await fs.lstat(p);
      if(ms.isSymbolicLink()){linked.push(p);return;}
      if(!ms.isFile()||ms.size>1024*1024){warnings.push('An unreadable or oversized manifest was left for manual review: '+p);return;}
      let info;try{info=parseManifest(await fs.readFile(p));}catch{warnings.push('An invalid mod manifest was left for manual review: '+p);return;}
      const id=info.id==='elfis_combat'?'elfis_combat':canonical(info.id);
      if(!MODS.has(id))return; // Do not inspect another mod's loose data or embedded downloads.
      if(same(path.dirname(dir),game.mods)) {
        add(p,ms);
        await shallow(path.join(dir,'Data'),name=>/\.pak$/i.test(name));
        await shallow(path.join(dir,'KCSE','Plugins'),name=>/\.dll$/i.test(name));
      }else await payload(dir); // Complete payload enumeration, independent of wrapper depth.
      return;
    }
    for(const e of entries) {
      if(++wrapperCount>12000){wrapperLimited=true;return;}
      const p=path.join(dir,e.name);
      if(same(dir,game.root)&&(e.name.startsWith('.')||e.name.startsWith('_')||/^(Data|Localization|Engine|Tools|Logs|LogBackups|Screenshots|Saves|AftermathDumps|BugSplatAttachments|mod_backups|research|Bin)$/i.test(e.name)))continue;
      const st=await fs.lstat(p);
      if(st.isSymbolicLink()){linked.push(p);continue;}
      if(st.isDirectory()) {
        if(depth>=7){wrapperLimited=true;continue;}
        await discover(p,depth+1);
      }else if(st.isFile())add(p,st);
    }
  }
  await plainAncestors(game.root);await ensurePlainPath(game.root,game.root);
  await discover(game.root,0);
  if(wrapperLimited)warnings.push('Unrecognized folders beyond the bounded wrapper search were skipped. Place a supported download closer to the game folder if it was not found.');
  if(!within(game.root,game.mods))blockers.push('This setup version supports mods inside the selected game folder only.');
  await ensurePlainPath(game.root,game.bin);
  await shallow(game.bin,name=>/^(dinput8\.dll|LuaUtils\.dll)$/i.test(name));
  return {files,warnings,blockers,linked};
}
async function inspectSetup(report) {
  const game=report.game,{files:all,warnings,blockers,linked}=await inventory(game),groups=[],files=[];
  for(const f of all.filter(f=>path.basename(f.path).toLowerCase()==='mod.manifest')) {
    if(f.size>1024*1024){warnings.push('Oversized manifest skipped: '+f.path);continue;}
    let m;try{m=parseManifest(await fs.readFile(f.path));}catch{continue;}
    const id=m.id==='elfis_combat'?'elfis_combat':canonical(m.id);
    if(!MODS.has(id))continue;
    // Canonical top-level deployed names are preserved. Never rename an existing mod.
    const source=path.dirname(f.path),direct=same(path.dirname(source),game.mods);
    const folder=direct?path.basename(source):id;
    if(!/^[a-z0-9_.-]+$/.test(folder)){blockers.push('Supported mod folder must have a lowercase safe name: '+source);continue;}
    const hasPak=all.some(f=>within(source,f.path)&&/^Data[/\\].+\.pak$/i.test(path.relative(source,f.path)));
    groups.push({id,source,target:path.join(game.mods,folder),folder,hasPak});
  }
  for(const id of MODS)if(groups.filter(g=>g.id===id).length>1)blockers.push('More than one '+id+' payload was found. Keep one intended version before setup.');
  for(const g of groups) {
    if(!g.hasPak){blockers.push('No Data PAK was found for '+g.id+'. Install its complete author download.');continue;}
    if(same(g.source,g.target))continue;
    if(linked.some(p=>within(g.source,p))){blockers.push('A linked component belongs to this payload. Use its mod manager: '+g.source);continue;}
    if(within(g.source,g.target)){blockers.push('A mod manifest is above its intended destination: '+g.source);continue;}
    const payload=all.filter(f=>within(g.source,f.path));
    if(!payload.some(f=>/^Data[/\\].+\.pak$/i.test(path.relative(g.source,f.path)))) {
      blockers.push('No Data PAK was found for '+g.id+'. Install its complete author download.');continue;
    }
    for(const f of payload) {
      const rel=safeRelative(path.relative(g.source,f.path));
      if(!/^(Data\/|Localization\/|KCSE\/Plugins\/|mod\.manifest$|mod\.cfg$|[^/]+\.(txt|md|png|jpg|ico|json)$)/i.test(rel)||/\.(exe|bat|cmd|ps1|lnk)$/i.test(rel)) {
        blockers.push('Unexpected file in '+g.id+' payload; review manually: '+f.path);continue;
      }
      // Mod-local native plugins remain mod-local; no loose DLL identity inference.
      if(/\.(dll|asi)$/i.test(rel)&&!/^KCSE\/Plugins\/[^/]+\.dll$/i.test(rel)) {
        blockers.push('Unexpected native file inside mod payload: '+f.path);continue;
      }
      files.push({source:f.path,target:path.join(g.target,...rel.split('/')),dependency:g.id,sha256:await hashFile(f.path),bytes:f.size});
    }
  }
  const reference=gameReferences[game.whHash];
  for(const f of all) {
    if(all.some(m=>path.basename(m.path).toLowerCase()==='mod.manifest'&&within(path.dirname(m.path),f.path)))continue;
    const name=path.basename(f.path);let target,id;
    if(/^dinput8\.dll$/i.test(name)) {
      const sha=await hashFile(f.path);
      if(fingerprints[sha]!=='kcse') {if(!same(path.dirname(f.path),game.bin))warnings.push('Unrecognized dinput8.dll left in place: '+f.path);continue;}
      target=path.join(game.bin,'dinput8.dll');id='kcse';
    }else if(/^LuaUtils\.dll$/i.test(name)) {
      if(fingerprints[await hashFile(f.path)]!=='luautils'){warnings.push('Unrecognized LuaUtils.dll left in place: '+f.path);continue;}
      target=path.join(game.root,'KCSE','Plugins','LuaUtils.dll');id='luautils';
    }else if(/^kcd_addresslib_[a-z0-9_-]+\.bin$/i.test(name)) {
      if(!reference||name!==reference.address||await hashFile(f.path)!==reference.addressHash){warnings.push('Address table needs manual build verification: '+f.path);continue;}
      target=path.join(game.root,'KCSE','addresslib',reference.address);id='addresslib';
    }else continue;
    if(!same(f.path,target))files.push({source:f.path,target,dependency:id,sha256:await hashFile(f.path),bytes:f.size});
  }
  const targets=new Set();
  for(const f of files) {
    if(targets.has(f.target.toLowerCase()))blockers.push('Multiple files would occupy '+f.target);targets.add(f.target.toLowerCase());
    try{await ensurePlainPath(game.root,f.source);await ensurePlainPath(game.root,f.target,{fileMayNotExist:true});}catch(e){blockers.push(e.message);}
    if(await stat(f.target))blockers.push('Destination already exists; no files will be overwritten: '+f.target);
  }
  if(files.length)try{await assertManualScope(game,setupScope({files,groups}));}catch(e){blockers.push(e.message);}
  const elf=groups.filter(g=>g.id==='elfis_combat');
  const dependencies=catalog.filter(d=>DEPENDENCIES.has(d.id)).map(d=>{
    const current=(report.dependencies||[]).find(x=>x.id===d.id),group=groups.find(g=>g.id===d.id),located=groups.some(g=>g.id===d.id&&!same(g.source,g.target))||files.some(f=>f.dependency===d.id);
    return {...d,reviewReason:!located&&!(group&&!group.hasPak)?current?.reviewReason||null:null,providers:current?.providers||[],requirement:d.id==='luautils'?'recommended':'required',status:group&&!group.hasPak?'incomplete':located?'located':current?.status||'missing',detail:(located?'Files found; review the placement preview. ':(current?.detail||d.help))+(d.id==='luautils'?' LuaUtils improves injury support; combat has a fallback without it.':''),requiredBy:d.id==='luautils'?['Recommended for full feature support']:['Elfis Combat']};
  });
  return {elfis:{status:elf.length===1?(!elf[0].hasPak?'incomplete':same(elf[0].source,elf[0].target)?'installed':'misplaced'):elf.length?'ambiguous':'missing',folder:elf[0]?.source||null,detail:elf.length===1?(elf[0].hasPak?'Elfis Combat manifest and Data PAK found. Runtime compatibility is not established by placement.':'Elfis Combat manifest found, but its Data PAK is missing. Reinstall the complete download.'):'Install one complete Elfis Combat download, then scan again.'},dependencies,files:files.sort((a,b)=>a.target.localeCompare(b.target)),groups,blockers:[...new Set(blockers)],warnings:[...new Set(warnings)]};
}

// Activation-only evidence: these exact direct folders never enter relocation inventory.
async function orderProviders(game) {
  const result=[];
  const dirs=await fs.readdir(game.mods,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  for(const id of ['zzmiscoverhaul_parttwo','zzmiscoverhaul_parttwo_dbjcompatible','ptfextender','mcm',...OPTIONAL_NATIVE]) {
    const folder=dirs.find(e=>e.isDirectory()&&e.name.toLowerCase()===id)?.name||id;
    const root=path.join(game.mods,folder),manifest=path.join(root,'mod.manifest');
    const st=await stat(manifest);if(!st||!st.isFile()||st.size>1024*1024)continue;
    try {
      await ensurePlainPath(game.root,manifest);
      const bytes=await fs.readFile(manifest),m=parseManifest(bytes);
      if((id==='ptfextender'||id==='mcm'||OPTIONAL_NATIVE.has(id)?canonical(m.id||m.name):m.id)!==id)continue;
      const evidence=[{path:manifest,sha256:hash(bytes)}];
      // Retain exact Misc identities even when incomplete so another edition
      // cannot be silently selected as the sole installed provider.
      const provider={id,folder,evidence,complete:false};
      if(id.startsWith('zzmiscoverhaul_'))result.push(provider);
      if(OPTIONAL_NATIVE.has(id)) {
        // Enabling this mod must not also enable both alternative builds.
        if(id==='soundframework'&&await stat(path.join(game.bin,'KCD2_SoundFramework.asi')))continue;
        const profile=catalog.find(c=>c.id===id&&c.importable&&c.optional);
        if(!profile||profile.files.length!==1)continue;
        const native=path.join(root,'KCSE','Plugins',profile.files[0]);
        await ensurePlainPath(game.root,native);
        const pe=await nativeInfo(native);if(!pe.valid||pe.architecture!=='x64')continue;
        const sha256=await hashFile(native);if(fingerprints[sha256]!==id)continue;
        evidence.push({path:native,sha256});
        let complete=true;
        for(const rel of profile.requiredResources||[]) {
          const file=path.join(root,...safeRelative(rel).split('/'));
          await ensurePlainPath(game.root,file);
          const s=await stat(file);if(!s?.isFile()||!s.size||s.size>64*1024*1024){complete=false;break;}
          evidence.push({path:file,sha256:await hashFile(file)});
        }
        if(!complete)continue;
        // A corrupt localization or Data PAK makes the provider incomplete even
        // when its native DLL and loose resources are intact.
        for(const subdir of ['Data','Localization']) {
          const dir=path.join(root,subdir);await ensurePlainPath(game.root,dir,{fileMayNotExist:true});
          const rows=await fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
          if(rows.length>3000){complete=false;break;}
          for(const entry of rows.filter(e=>/\.pak$/i.test(e.name))) {
            if(!entry.isFile()){complete=false;break;}
            const file=path.join(dir,entry.name);await ensurePlainPath(game.root,file);
            await zipInspect(file,{read:()=>true,maxEntryBytes:8*1024*1024,maxReadBytes:32*1024*1024});
            evidence.push({path:file,sha256:await hashFile(file)});
          }
          if(!complete)break;
        }
        if(!complete)continue;
      }else if(id==='ptfextender') {
        const file=path.join(root,'KCSE','Plugins','PTFextender.dll');
        await ensurePlainPath(game.root,file);
        const pe=await nativeInfo(file);if(!pe.valid||pe.architecture!=='x64')continue;
        const sha256=await hashFile(file);if(fingerprints[sha256]!=='ptfextender')continue;
        evidence.push({path:file,sha256});
      }else if(id==='mcm') {
        const dll=path.join(root,'KCSE','Plugins','MCM.dll');await ensurePlainPath(game.root,dll);
        const pe=await nativeInfo(dll);if(!pe.valid||pe.architecture!=='x64')continue;
        const dllHash=await hashFile(dll);if(fingerprints[dllHash]!=='mcm')continue;
        evidence.push({path:dll,sha256:dllHash});
        const data=path.join(root,'Data');await ensurePlainPath(game.root,data);
        const rows=await fs.readdir(data,{withFileTypes:true});if(rows.length>3000)continue;
        let xml=false,gfx=false;
        for(const pak of rows.filter(e=>e.isFile()&&/\.pak$/i.test(e.name))){
          const file=path.join(data,pak.name);await ensurePlainPath(game.root,file);
          const entries=(await zipInspect(file,{
            read:name=>/^Libs\/UI\/UIElements\/MCM\.xml$/i.test(name)||/^Libs\/UI\/.*mcm.*\.gfx$/i.test(name),
            maxEntryBytes:8*1024*1024,maxReadBytes:32*1024*1024
          })).entries.map(e=>e.name);
          xml ||=entries.some(e=>/^Libs\/UI\/UIElements\/MCM\.xml$/i.test(e));
          gfx ||=entries.some(e=>/^Libs\/UI\/.*mcm.*\.gfx$/i.test(e));
          evidence.push({path:file,sha256:await hashFile(file)});
        }
        if(!xml||!gfx)continue;
      }else {
        const data=path.join(root,'Data');await ensurePlainPath(game.root,data);
        const rows=await fs.readdir(data,{withFileTypes:true});if(rows.length>3000)continue;
        const pak=rows.find(e=>e.isFile()&&/\.pak$/i.test(e.name));if(!pak)continue;
        const file=path.join(data,pak.name);await ensurePlainPath(game.root,file);
        evidence.push({path:file,sha256:await hashFile(file)});
      }
      provider.complete=true;
      if(id==='ptfextender'||id==='mcm'||OPTIONAL_NATIVE.has(id))result.push(provider);
    }catch{ /* Ambiguous or incomplete evidence cannot authorize activation. */ }
  }
  return result;
}
// Every load name the game would otherwise load. A created list is restrictive,
// so an unreadable entry blocks creation instead of silently disabling a mod.
async function installedLoadNames(game) {
  const names=[];
  const local=await fs.readdir(game.mods,{withFileTypes:true});
  if(local.length>1000)throw Error('More than 1000 entries exist in mods; a complete mod_order.txt cannot be created safely.');
  for(const e of local) {
    if(!(e.isDirectory()||e.isSymbolicLink())||e.name.startsWith('.'))continue;
    if(await stat(path.join(game.mods,e.name,'mod.manifest')))names.push(e.name);
  }
  if(game.workshop){
   const workshop=await fs.readdir(game.workshop,{withFileTypes:true});
   if(workshop.length>1000)throw Error('More than 1000 Workshop entries exist; a complete mod_order.txt cannot be created safely.');
   for(const e of workshop)if(e.isDirectory()) {
    const base=path.join(game.workshop,e.name),roots=[];
    if(await stat(path.join(base,'mod.manifest')))roots.push(base);
    else {
      const children=await fs.readdir(base,{withFileTypes:true});
      if(children.length>50)throw Error('More than 50 entries exist in a Workshop item; a complete mod_order.txt cannot be created safely: '+base);
      for(const c of children)if(c.isDirectory()&&await stat(path.join(base,c.name,'mod.manifest')))roots.push(path.join(base,c.name));
    }
    for(const root of roots) {
      let id;try{const m=path.join(root,'mod.manifest'),st=await stat(m);if(st.size>256*1024)throw 0;id=parseManifest(await fs.readFile(m)).id||path.basename(root);}
      catch{throw Error('A Workshop mod manifest could not be read, so a complete mod_order.txt cannot be created: '+root);}
      names.push(id);
    }
   }
  }
  const seen=new Set();return names.filter(n=>{const k=n.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}
async function validTuning(game) {
  const root=path.join(game.mods,'elfis_setup_tweaks');
  const manifest=path.join(root,'mod.manifest'),pak=path.join(root,'Data','elfis_setup_tweaks.pak');
  const m=await stat(manifest),p=await stat(pak);
  if(!m||!p)return false;
  await ensurePlainPath(game.root,manifest);await ensurePlainPath(game.root,pak);
  if(!m.isFile()||m.size>1024*1024||!p.isFile())return false;
  return parseManifest(await fs.readFile(manifest)).id.toLowerCase()==='elfis_setup_tweaks';
}
async function createdOrder(report,target,primary,utilities) {
  // Unrelated mods alphabetically, then utilities before the primaries (as
  // scopedOrder keeps them for existing lists), Misc next, Elfis Combat, then
  // a valid installed Elfis tuning override if present.
  const TUNING='elfis_setup_tweaks';
  const special=new Set([...primary,...utilities].map(g=>g.folder.toLowerCase()));
  const installed=await installedLoadNames(report.game);
  const tuning=installed.find(n=>n.toLowerCase()===TUNING)&&await validTuning(report.game)?TUNING:null;
  const others=installed.filter(n=>!special.has(n.toLowerCase())&&(!tuning||n.toLowerCase()!==TUNING)).sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
  const tail=[...primary.filter(g=>!OPTIONAL_NATIVE.has(g.id))].sort((a,b)=>(a.folder==='elfis_combat')-(b.folder==='elfis_combat'));
  tail.push(...primary.filter(g=>OPTIONAL_NATIVE.has(g.id)));
  const rows=[...new Set([...others,...utilities.map(g=>g.folder),...tail.map(g=>g.folder),...(tuning?[tuning]:[])])];
  const after=Buffer.from(rows.map(r=>r+'\r\n').join(''));
  return {target,created:true,before:null,after:hash(after),beforeText:null,afterText:after.toString('utf8')};
}
async function scopedOrder(report,setup) {
  const target=path.join(report.game.mods,'mod_order.txt'),s=await stat(target);
  const optional=setup.orderProviders.filter(g=>OPTIONAL_NATIVE.has(g.id)&&g.complete);
  if(!s) {
    const primary=setup.groups.filter(g=>g.id==='elfis_combat'&&g.hasPak);
    const misc=setup.orderProviders.filter(g=>g.id.startsWith('zzmiscoverhaul_'));
    if(misc.length===1&&misc[0].complete)primary.push(misc[0]);
    if(!primary.length&&!optional.length||!await stat(report.game.mods))return null;
    const utilities=setup.groups.filter(g=>['kcdutils','luautils'].includes(g.id)&&g.hasPak);
    utilities.push(...setup.orderProviders.filter(g=>g.id==='mcm'));
    if(misc.length===1&&misc[0].complete)utilities.push(...setup.orderProviders.filter(g=>g.id==='ptfextender'));
    return createdOrder(report,target,[...primary,...optional],utilities);
  }
  if(s.size>1024*1024)throw Error('Load order is too large.');
  await ensurePlainPath(report.game.root,target);
  const bytes=await fs.readFile(target);
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('Load order must contain valid UTF-8 before it can be repaired.');}
  if(text.includes('\0'))throw Error('Load order contains NUL bytes; review its encoding before repair.');
  const bom=text.startsWith('\uFEFF')?'\uFEFF':'',body=text.replace(/^\uFEFF/,'');
  const rows=body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  const key=row=>row.trim().toLowerCase();
  const primary=setup.groups.filter(g=>g.id==='elfis_combat'&&g.hasPak);
  const misc=setup.orderProviders.filter(g=>g.id.startsWith('zzmiscoverhaul_'));
  if(misc.length===1&&misc[0].complete)primary.push(misc[0]);
  if(!primary.length&&!optional.length)return null;
  const utilities=setup.groups.filter(g=>['kcdutils','luautils'].includes(g.id)&&g.hasPak);
  utilities.push(...setup.orderProviders.filter(g=>g.id==='mcm'));
  if(misc.length===1&&misc[0].complete)utilities.push(...setup.orderProviders.filter(g=>g.id==='ptfextender'));
  const primaryKeys=new Set(primary.map(g=>g.folder.toLowerCase()));
  // Existing primary rows keep their relative positions, except Elfis Combat,
  // which moves after other primaries. A valid active Elfis tuning override
  // follows it. Utilities move only before the first primary.
  const utilityNames=new Map(utilities.map(g=>[g.folder.toLowerCase(),g.folder]));
  const utilityKeys=new Set(utilityNames.keys()),seen=new Set(),kept=[];
  for(const row of rows) {
    const k=key(row);if(utilityKeys.has(k)||k==='elfis_combat')continue;
    if(primaryKeys.has(k)){
      if(seen.has(k))continue;seen.add(k);
      kept.push(k+(row.match(/(?:\r\n|\n|\r)$/)?.[0]||''));
    }else kept.push(row);
  }
  const nl=text.includes('\r\n')?'\r\n':'\n';
  const tuningRows=rows.filter(row=>key(row)==='elfis_setup_tweaks');
  if(tuningRows.length>1)throw Error('Duplicate Elfis tuning load-order entries require manual review.');
  const tuningRow=tuningRows.length&&await validTuning(report.game)?tuningRows[0]:null;
  if(tuningRow)for(let i=kept.length-1;i>=0;i--)if(key(kept[i])==='elfis_setup_tweaks')kept.splice(i,1);
  for(const g of [...primary].sort((a,b)=>(a.folder==='elfis_combat')-(b.folder==='elfis_combat')))if(!seen.has(g.folder.toLowerCase())) {
    if(kept.length&&!/[\r\n]$/.test(kept.at(-1)))kept[kept.length-1]+=nl;
    kept.push(g.folder+nl);seen.add(g.folder.toLowerCase());
  }
  const index=kept.findIndex(row=>primaryKeys.has(key(row)));
  if(index>=0)kept.splice(index,0,...[...utilityNames.values()].map(name=>name+nl));
  if(tuningRow){
    if(kept.length&&!/[\r\n]$/.test(kept.at(-1)))kept[kept.length-1]+=nl;
    kept.push(tuningRow.replace(/(?:\r\n|\n|\r)?$/,nl));
  }
  const present=new Set(kept.map(key));
  for(const provider of optional)if(!present.has(provider.folder.toLowerCase())) {
    if(kept.length&&!/[\r\n]$/.test(kept.at(-1)))kept[kept.length-1]+=nl;
    kept.push(provider.folder+nl);present.add(provider.folder.toLowerCase());
  }
  const after=Buffer.from(bom+kept.join(''));
  if(bytes.equals(after))return null;
  return {target,before:hash(bytes),after:hash(after),beforeText:text,afterText:after.toString('utf8')};
}

async function previewSetup(report) {
  const setup=await inspectSetup(report);setup.orderProviders=await orderProviders(report.game);
  let order=null;
  try{order=await scopedOrder(report,setup);}catch(e){setup.blockers.push(e.message);}
  if(order)try{await assertManualScope(report.game,{subtrees:[],files:[order.target]});}catch(e){setup.blockers.push(e.message);}
  const changes=setup.files.map(f=>({type:'move',source:f.source,target:f.target,detail:'Place '+f.dependency+' in its expected folder.'}));
  if(order)changes.push({type:'order',source:order.target,target:order.target,detail:order.created?'Create mod_order.txt listing every installed mod, with Elfis Combat last except for an active Elfis tuning override.':'Enable found supported mods, place their verified utility mods first, and keep active Elfis tuning after Elfis Combat.'});
  const plan={...setup,kind:'setup',root:report.game.root,order,changes,changed:changes.length>0,canApply:changes.length>0&&setup.blockers.length===0&&(setup.elfis.status!=='missing'||setup.orderProviders.some(g=>OPTIONAL_NATIVE.has(g.id)&&g.complete)||setup.orderProviders.filter(g=>g.id.startsWith('zzmiscoverhaul_')).length===1&&setup.orderProviders.some(g=>g.id.startsWith('zzmiscoverhaul_')&&g.complete)),summary:changes.length+' placement / load-order change(s)'};
  plan.signature=seal({files:plan.files,order:plan.order,blockers:plan.blockers,groups:plan.groups,orderProviders:plan.orderProviders});return plan;
}

function setupScope(plan) {
  const files=plan.files.flatMap(f=>[f.source,f.target]);
  if(plan.order)files.push(plan.order.target);
  // Entire movable mod payloads are inventoried and copied. Ownership anywhere
  // inside either payload root prevents treating it as a manual installation.
  const subtrees=(plan.groups||[]).filter(g=>!same(g.source,g.target)&&plan.files.some(f=>within(g.source,f.source))).flatMap(g=>[g.source,g.target]);
  return {files,subtrees};
}

async function transaction(store,game,fn) {
  // Lock location is game-wide, independent of the user's receipt directory.
  await plainAncestors(game.root);
  const lock=lockRoot(game);await ensurePlainPath(game.root,lock,{fileMayNotExist:true});
  return locked(lock,game,fn);
}
async function writableStore(store,game) {
  const absolute=path.resolve(store);
  if(within(game.mods,absolute)||within(game.bin,absolute))throw Error('Backup storage cannot be inside mods or Bin.');
  if(within(game.root,absolute)&&!within(path.join(game.root,'_mod_audit_backup'),absolute))throw Error('Store game-local backups under _mod_audit_backup.');
  await plainAncestors(absolute);await fs.mkdir(absolute,{recursive:true});await ensurePlainPath(absolute,absolute);
  return absolute;
}
async function verifyMove(game,f,reverse=false) {
  if(!within(game.root,f.source)||!within(game.root,f.target)||same(f.source,f.target))throw Error('Invalid setup file path.');
  const from=reverse?f.target:f.source,to=reverse?f.source:f.target;
  await ensurePlainPath(game.root,from);await ensurePlainPath(game.root,to,{fileMayNotExist:true});
  if(await hashFile(from)!==f.sha256)throw Error('Setup file changed: '+from);
  if(await stat(to))throw Error('Destination changed or already exists: '+to);
}
async function applySetup(report,plan,store,{closed=gameClosed}={}) {
  return transaction(store,report.game,async()=>{
    const fresh=await previewSetup(report);
    if(plan.kind!=='setup'||plan.root!==report.game.root||fresh.signature!==plan.signature||!fresh.canApply)throw Error('Setup preview is stale or blocked. Scan and review again.');
    const scope=setupScope(fresh);
    // The fresh setup inventory covers every moved payload. A whole-game
    // dependency-layout hash would include unrelated installed mods.
    await freshGate(report.game,report.snapshots||{},closed,null,scope);
    // Always act on freshly generated paths, never caller-supplied preview paths.
    const base=await writableStore(store,report.game),dir=path.join(base,crypto.randomUUID());await fs.mkdir(dir);
    const receipt={kind:'elfis-setup-v1',state:'prepared',game:report.game,files:fresh.files,order:fresh.order,time:new Date().toISOString(),completed:[]};
    const rp=path.join(dir,'receipt.json'),save=()=>saveReceipt(rp,receipt);
    for(let i=0;i<receipt.files.length;i++) {
      const f=receipt.files[i];await verifyMove(report.game,f);
      await fs.copyFile(f.source,path.join(dir,'file-'+i+'.before'),fs.constants.COPYFILE_EXCL);
      if(await hashFile(path.join(dir,'file-'+i+'.before'))!==f.sha256)throw Error('Backup verification failed.');
    }
    if(receipt.order&&!receipt.order.created)await fs.writeFile(path.join(dir,'order.before'),Buffer.from(receipt.order.beforeText),{flag:'wx'});
    await save();
    try {
      // No mutations until all bytes, backups, layout and game state pass again.
      await freshGate(report.game,report.snapshots||{},closed,null,scope);
      if((await previewSetup(report)).signature!==fresh.signature)throw Error('Setup changed during backup. Scan again.');
      for(let i=0;i<receipt.files.length;i++) {
        const f=receipt.files[i];if(!await closed())throw Error('Close KCD2 before setup.');await verifyMove(report.game,f);
        await assertManualScope(report.game,scope);
        await fs.mkdir(path.dirname(f.target),{recursive:true});
        await ensurePlainPath(report.game.root,f.target,{fileMayNotExist:true});
        // Journal intent before touching the target, so interrupted copies can be recovered.
        receipt.completed.push(i);await save();
        if(!await closed())throw Error('Close KCD2 before setup.');
        await assertManualScope(report.game,scope);await verifyMove(report.game,f);
        await fs.copyFile(f.source,f.target,fs.constants.COPYFILE_EXCL);
        if(await hashFile(f.target)!==f.sha256||await hashFile(f.source)!==f.sha256)throw Error('File changed during placement.');
        if(!await closed())throw Error('Close KCD2 before setup.');
        await assertManualScope(report.game,scope);
        await ensurePlainPath(report.game.root,f.source);await ensurePlainPath(report.game.root,f.target);
        if(await hashFile(f.target)!==f.sha256||await hashFile(f.source)!==f.sha256)throw Error('File changed before placement commit.');
        if(!await closed())throw Error('Close KCD2 before setup.');
        await fs.unlink(f.source);
      }
      if(receipt.order) {
        const o=receipt.order;
        if(!await closed())throw Error('Close KCD2 before setup.');
        await assertManualScope(report.game,scope);
        await ensurePlainPath(report.game.root,o.target,{fileMayNotExist:o.created});
        if(o.created?await stat(o.target):await hashFile(o.target)!==o.before)throw Error('Load order changed.');
        for(const provider of fresh.orderProviders)for(const evidence of provider.evidence) {
          await ensurePlainPath(report.game.root,evidence.path);
          if(await hashFile(evidence.path)!==evidence.sha256)throw Error('Mod activation evidence changed. Scan and review again.');
        }
        const temp=path.join(path.dirname(o.target),'.elfis-setup-'+crypto.randomUUID()+'.tmp');
        await fs.writeFile(temp,Buffer.from(o.afterText),{flag:'wx'});
        receipt.orderApplied=true;await save();
        try{
          if(!await closed())throw Error('Close KCD2 before setup.');
          await assertManualScope(report.game,scope);
          await ensurePlainPath(report.game.root,o.target,{fileMayNotExist:o.created});await ensurePlainPath(report.game.root,temp);
          if((o.created?await stat(o.target):await hashFile(o.target)!==o.before)||await hashFile(temp)!==o.after)throw Error('Load order changed before commit.');
          if(!await closed())throw Error('Close KCD2 before setup.');
          // A created order never replaces a file that appeared meanwhile.
          if(o.created)await fs.copyFile(temp,o.target,fs.constants.COPYFILE_EXCL);
          else await fs.rename(temp,o.target);
        }finally{await fs.unlink(temp).catch(()=>{});}
        if(await hashFile(o.target)!==o.after)throw Error('Load-order verification failed.');
      }
      receipt.state='applied';await save();return {receipt:rp,changed:fresh.changes.map(c=>c.target)};
    }catch(e){receipt.state='partial';receipt.error=e.message;await save();throw Error(e.message+' Recovery receipt: '+rp);}
  });
}

async function undoSetup(receiptPath,store,{closed=gameClosed}={}) {
  const rp=path.resolve(receiptPath),base=path.resolve(store);
  if(!within(base,rp)||path.basename(rp)!=='receipt.json'||same(base,path.dirname(rp)))throw Error('Unknown setup receipt.');
  await plainAncestors(base);await ensurePlainPath(base,rp);const r=JSON.parse(await fs.readFile(rp,'utf8'));
  if(r.kind!=='elfis-setup-v1'||!['prepared','applied','partial'].includes(r.state))throw Error('No reversible setup is recorded.');
  if(!r.game||!Array.isArray(r.files)||!Array.isArray(r.completed)||r.files.length>12000||new Set(r.completed).size!==r.completed.length)throw Error('Invalid setup receipt schema.');
  if(!same(r.game.mods,path.join(r.game.root,'mods')))throw Error('Unexpected receipt mod root.');
  for(const f of r.files) {
    if(!f||typeof f.source!=='string'||typeof f.target!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||!within(r.game.root,f.source)||!within(r.game.root,f.target)||same(f.source,f.target))throw Error('Invalid receipt file paths or hash.');
    const sourceRel=safeRelative(path.relative(r.game.root,f.source));
    if(/^(Data|Engine|Localization|Saves|_mod_audit_backup|_codex_reference)(\/|$)/i.test(sourceRel))throw Error('Receipt source is protected.');
    let valid=false;
    if(MODS.has(f.dependency)) {
      const modRoot=path.join(r.game.mods,f.dependency);
      if(within(modRoot,f.target)&&!same(modRoot,f.target)) {
        const rel=safeRelative(path.relative(modRoot,f.target));
        valid=/^(Data\/|Localization\/|KCSE\/Plugins\/|mod\.manifest$|mod\.cfg$|[^/]+\.(txt|md|png|jpg|ico|json)$)/i.test(rel)&&! /\.(exe|bat|cmd|ps1|lnk)$/i.test(rel)&&sourceRel.toLowerCase().endsWith('/'+rel.toLowerCase());
      }
    }
    if(f.dependency==='kcse')valid=same(f.target,path.join(r.game.bin,'dinput8.dll'))&&fingerprints[f.sha256]==='kcse';
    if(f.dependency==='luautils'&&same(f.target,path.join(r.game.root,'KCSE/Plugins/LuaUtils.dll')))valid=fingerprints[f.sha256]==='luautils';
    if(f.dependency==='addresslib'){const ref=gameReferences[r.game.whHash];valid=!!ref&&same(f.target,path.join(r.game.root,'KCSE/addresslib',ref.address))&&f.sha256===ref.addressHash;}
    if(!valid)throw Error('Receipt target is not a supported setup placement.');
  }
  for(const i of r.completed)if(!Number.isSafeInteger(i)||i<0||i>=r.files.length)throw Error('Invalid receipt index.');
  return transaction(store,r.game,async()=>{
    await plainAncestors(r.game.root);
    const scope=setupScope({files:r.completed.map(i=>r.files[i]),order:r.orderApplied?r.order:null});
    if(scope.files.length)await freshGate(r.game,{},closed,null,scope);
    else {if(!await closed())throw Error('Close KCD2 before undo.');}
    const pending=[];
    for(const i of r.completed) {
      const f=r.files[i];if(!f)throw Error('Invalid receipt file index.');
      const backup=path.join(path.dirname(rp),'file-'+i+'.before');await ensurePlainPath(base,backup);
      if(await hashFile(backup)!==f.sha256)throw Error('Setup backup changed.');
      // A failed copy can leave the original intact. Keep it and quarantine only our copy.
      await ensurePlainPath(r.game.root,f.source,{fileMayNotExist:true});
      const source=await stat(f.source);
      if(source&&await hashFile(f.source)!==f.sha256)throw Error('Original path changed; undo stopped: '+f.source);
      if(!within(r.game.root,f.source)||!within(r.game.root,f.target))throw Error('Receipt path escapes game.');
      await ensurePlainPath(r.game.root,f.target,{fileMayNotExist:true});
      if(!await stat(f.target)) {if(source)continue;throw Error('Both placement and original file are missing. Restore the verified backup manually.');}
      if(await hashFile(f.target)!==f.sha256)throw Error('Installed file changed; undo stopped: '+f.target);
      pending.push({f,i,source:!!source});
    }
    if(r.orderApplied) {
      const o=r.order;if(o.target!==path.join(r.game.mods,'mod_order.txt'))throw Error('Invalid order target.');
      if(typeof o.created!=='undefined'&&o.created!==true||o.created&&o.before!==null)throw Error('Invalid order receipt.');
      await ensurePlainPath(r.game.root,o.target,{fileMayNotExist:!!o.created});
      const current=o.created&&!await stat(o.target)?null:await hashFile(o.target);if(current===o.before)r.orderApplied=false;
      else if(current!==o.after)throw Error('Load order changed; undo stopped.');
      if(!o.created&&await hashFile(path.join(path.dirname(rp),'order.before'))!==o.before)throw Error('Load order backup changed.');
    }
    // Validate everything before undoing anything. Retain placed bytes in receipt quarantine.
    for(const {f,i,source} of pending.reverse()) {
      if(!await closed())throw Error('Close KCD2 before undo.');
      await assertManualScope(r.game,scope);
      await ensurePlainPath(r.game.root,f.source,{fileMayNotExist:true});await ensurePlainPath(r.game.root,f.target);
      if(await hashFile(f.target)!==f.sha256)throw Error('File drift during undo.');
      if(!source){await fs.mkdir(path.dirname(f.source),{recursive:true});await fs.copyFile(f.target,f.source,fs.constants.COPYFILE_EXCL);}
      const quarantine=path.join(path.dirname(rp),'file-'+i+'.undone');
      await ensurePlainPath(base,quarantine,{fileMayNotExist:true});
      if(!await stat(quarantine))await fs.copyFile(f.target,quarantine,fs.constants.COPYFILE_EXCL);
      if(await hashFile(quarantine)!==f.sha256||await hashFile(f.source)!==f.sha256||await hashFile(f.target)!==f.sha256)throw Error('Undo verification failed; files retained.');
      if(!await closed())throw Error('Close KCD2 before undo.');
      await assertManualScope(r.game,scope);
      await ensurePlainPath(r.game.root,f.source);await ensurePlainPath(r.game.root,f.target);await ensurePlainPath(base,quarantine);
      if(await hashFile(quarantine)!==f.sha256||await hashFile(f.source)!==f.sha256||await hashFile(f.target)!==f.sha256)throw Error('File changed before undo commit.');
      if(!await closed())throw Error('Close KCD2 before undo.');
      await fs.unlink(f.target);
    }
    if(r.orderApplied) {
      if(!await closed())throw Error('Close KCD2 before undo.');
      await assertManualScope(r.game,scope);
      const o=r.order;await ensurePlainPath(r.game.root,o.target);
      if(await hashFile(o.target)!==o.after)throw Error('Load order changed during undo.');
      if(o.created) {
        // Retain the created list in the receipt, then remove it.
        const quarantine=path.join(path.dirname(rp),'order.undone');
        await ensurePlainPath(base,quarantine,{fileMayNotExist:true});
        if(!await stat(quarantine))await fs.copyFile(o.target,quarantine,fs.constants.COPYFILE_EXCL);
        if(await hashFile(quarantine)!==o.after)throw Error('Undo verification failed; load order retained.');
        if(!await closed())throw Error('Close KCD2 before undo.');
        await assertManualScope(r.game,scope);
        if(await hashFile(o.target)!==o.after)throw Error('Load order changed before undo commit.');
        await fs.unlink(o.target);
        r.state='undone';await saveReceipt(rp,r);return {changed:[...r.completed.map(i=>r.files[i].source),o.target]};
      }
      const temp=path.join(path.dirname(o.target),'.elfis-undo-'+crypto.randomUUID()+'.tmp');
      await fs.copyFile(path.join(path.dirname(rp),'order.before'),temp,fs.constants.COPYFILE_EXCL);
      try{
        if(!await closed())throw Error('Close KCD2 before undo.');
        await assertManualScope(r.game,scope);
        await ensurePlainPath(r.game.root,o.target);await ensurePlainPath(r.game.root,temp);
        if(await hashFile(o.target)!==o.after||await hashFile(temp)!==o.before)throw Error('Load order changed before undo commit.');
        if(!await closed())throw Error('Close KCD2 before undo.');
        await fs.rename(temp,o.target);
      }finally{await fs.unlink(temp).catch(()=>{});}
    }
    r.state='undone';await saveReceipt(rp,r);return {changed:r.completed.map(i=>r.files[i].source)};
  });
}
module.exports={inspectSetup,previewSetup,applySetup,undoSetup};
