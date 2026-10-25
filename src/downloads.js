'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const {execFile}=require('child_process'),{promisify}=require('util');
const {hash,hashFile,zipInspect,safeRelative,crc32}=require('./io');
const {parseManifest}=require('./scanner'),{canonical,catalog,fingerprints}=require('./catalog');
const {locked,freshGate,ensurePlainPath,gameClosed,assertManualScope}=require('./repairs');
const {inspectWorkshop,rootsForGame}=require('./workshop');
async function workshopBlockers(game,files) {
  const inventory=await inspectWorkshop(game),wanted=new Set(files.map(f=>f.dependency)),blockers=[];
  if(!inventory.complete||inventory.pending||inventory.items.some(item=>['pending','missing'].includes(item.state)))return ['Steam Workshop could not be checked completely. Rescan after Steam finishes updating before importing dependencies.'];
  for(const item of inventory.items)for(const mod of item.modRoots) {
    let info;
    try {
      await ensurePlainPath(mod.root,mod.manifestPath);
      const stat=await fs.lstat(mod.manifestPath);if(stat.size>256*1024)throw Error('oversized');
      const bytes=await fs.readFile(mod.manifestPath);
      if(hash(bytes)!==mod.manifestHash)throw Error('changed');
      info=parseManifest(bytes);
    }catch {return ['Steam Workshop changed while dependencies were checked. Rescan before importing.'];}
    const id=info.id?canonical(info.id):canonical(info.name);
    const usableName=typeof info.name==='string'&&info.name.trim().length>0&&!/[\x00-\x1f\x7f]/.test(info.name);
    if(info.id?!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(info.id)||info.id.endsWith('.'):!usableName)return ['An existing Steam Workshop mod has no usable identity. Review its manifest and rescan before importing dependencies.'];
    if(id&&wanted.has(id))blockers.push('File found in Steam Workshop: '+(info.name||id)+'. Do not install a second copy. Manage this dependency through Steam, then rescan.');
    if(id==='soundframework'&&wanted.has('soundframework_asi'))blockers.push('The KCSE Sound Framework files are present in Steam Workshop, where KCSE does not load plugins directly. Review the author’s separate plugin installation steps before adding the ASI variant.');
    const nativeNames=new Set(files.filter(f=>/\.dll$/i.test(f.target)&&/[/\\]KCSE[/\\]Plugins[/\\]/i.test(f.target)).map(f=>path.basename(f.target)));
    if(wanted.has('soundframework_asi'))nativeNames.add('KCD2_SoundFramework.dll');
    for(const name of nativeNames){
      const plugin=path.join(mod.root,'KCSE','Plugins',name);
      try{await ensurePlainPath(mod.root,plugin,{fileMayNotExist:true});const stat=await fs.lstat(plugin).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(stat)blockers.push('Matching plugin files found in Steam Workshop: '+name+'. KCSE does not load plugins directly from that folder. Review the author’s separate plugin installation steps before importing this copy or variant.');}
      catch{return ['Steam Workshop plugin paths could not be checked safely. Rescan before importing dependencies.'];}
    }
  }
  return [...new Set(blockers)];
}
async function assertWorkshopSafe(game,files) {
  const blockers=await workshopBlockers(game,files);if(blockers.length)throw Error(blockers.join(' '));
}
const {inspectFolder,sourceHash:hashSource}=require('./extracted-folder');
const run=promisify(execFile);
const MAX=512*1024*1024,ENTRY=80*1024*1024;
const optionalMods=new Map(catalog.filter(c=>c.id==='soundframework'&&c.importable&&!c.nativeOnly).map(c=>[c.id,c]));
const consoleProfile=catalog.find(c=>c.id==='consolerpgparam');
const soundBase='KCD2_SoundFramework';
const soundCompanions=['_License.txt','_lipmodel.bin','_moods.ini','_Readme.txt','.ini'];
const soundKcseNames=new Set(['mod.manifest',...['.dll',...soundCompanions].map(s=>'KCSE/Plugins/'+soundBase+s)].map(s=>s.toLowerCase()));
const soundAsiNames=new Set(['.asi',...soundCompanions].map(s=>(soundBase+s).toLowerCase()));
function optionalFileAllowed(profile,relative) {
  return profile.id==='soundframework'&&soundKcseNames.has(relative.toLowerCase());
}
async function activeOpposite(game,variant) {
  if(variant==='soundframework')return !!await fs.lstat(path.join(game.bin,soundBase+'.asi')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(await fs.lstat(path.join(game.root,'KCSE','Plugins',soundBase+'.dll')).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))return true;
  const plugin=path.join(game.mods,'soundframework','KCSE','Plugins',soundBase+'.dll');
  if(!await fs.lstat(plugin).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))return false;
  const order=await fs.readFile(path.join(game.mods,'mod_order.txt'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  return order===null||order.split(/\r\n|\r|\n/).some(line=>line.trim().toLowerCase()==='soundframework');
}
const oppositeMessage='The other Sound Framework variant is already active. Choose either the KCSE plugin or the ASI variant; resolve the existing installation manually before importing this one.';
const sharedLoaderReplacement=files=>files.find(f=>f.existing&&/^(dinput8|version)\.dll$/i.test(path.basename(f.target)));
const loaderAliases=catalog.find(c=>c.id==='asi').files;
async function duplicateLoaderAlias(game,files) {
  const proposed=files.filter(f=>f.state!=='identical'&&/^(dinput8|version)\.dll$/i.test(path.basename(f.target)));
  for(const f of proposed)for(const alias of loaderAliases) {
    if(alias===path.basename(f.target).toLowerCase())continue;
    const other=path.join(game.bin,alias);
    const inPlan=files.find(p=>p.target.toLowerCase()===other.toLowerCase());
    if(inPlan&&inPlan.sha256===f.sha256)return {target:f.target,other};
    const stat=await fs.lstat(other).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(stat?.isFile()&&await hashFile(other)===f.sha256)return {target:f.target,other};
  }
  return null;
}
const duplicateLoaderMessage=pair=>`The same loader bytes already exist as ${path.basename(pair.other)}. Installing ${path.basename(pair.target)} would add a second copy under another supported name. Keep one loader alias or review the author’s instructions.`;
async function exportGate(game,destination) {
  const out=path.resolve(destination);
  for(const base of [game.root,game.mods,...rootsForGame(game)].filter(Boolean)) {
    const b=path.resolve(base).toLowerCase(),o=out.toLowerCase();
    if(o===b||o.startsWith(b+path.sep))throw Error('Export outside the game, deployed mods and Workshop folders.');
  }
  let cursor=out;
  while(true) {
    const stat=await fs.lstat(cursor).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(stat?.isSymbolicLink()||stat?.isFile()&&stat.nlink>1)throw Error('Output must not use a junction, symbolic link or shared hardlink.');
    if(await fs.stat(path.join(cursor,'__vortex_staging_folder')).catch(()=>null))throw Error('Do not export into Vortex staging.');
    const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
}
async function readDownload(file,sevenZip,{check=()=>{},onProgress=()=>{},signal}={}) {
  check();onProgress('Reading dependency archive');
  if((await fs.lstat(file)).isDirectory())return (await inspectFolder(file,{check,read:true})).contents;
  const stat=await fs.stat(file);if(!stat.isFile()||stat.size>256*1024*1024)throw Error('Choose a dependency ZIP or 7z download under 256 MB.');
  if(/\.zip$/i.test(file))return (await zipInspect(file,{read:()=>true,maxEntries:3000,maxReadBytes:MAX,maxEntryBytes:ENTRY,check,onProgress})).contents;
  if(!/\.7z$/i.test(file)||!sevenZip)throw Error('Choose a ZIP or 7z dependency download.');
  const {stdout}=await run(sevenZip,['l','-slt','-ba','--',file],{windowsHide:true,timeout:20000,maxBuffer:4*1024*1024,signal});
  const rows=stdout.trim().split(/\r?\n\r?\n/).filter(Boolean).map(block=>Object.fromEntries(block.split(/\r?\n/).map(line=>{const at=line.indexOf(' = ');return at<0?[]:[line.slice(0,at),line.slice(at+3)];}).filter(p=>p.length)));
  if(rows.length>3000)throw Error('Archive file-count limit reached.');
  const contents=new Map(),seen=new Set();let total=0;
  for(const row of rows) {
    check();onProgress('Reading archive entry '+(contents.size+1));
    if(!row.Path)throw Error('Unsupported 7z listing');const name=safeRelative(row.Path),key=name.toLowerCase();
    if(seen.has(key))throw Error('Duplicate archive path');seen.add(key);
    if(row['Symbolic Link']||row['Hard Link']||/L/.test(row.Attributes||''))throw Error('Linked archive entries are not supported.');
    if(row.Folder==='+'||/^D/.test(row.Attributes||''))continue;
    const size=Number(row.Size);if(!Number.isSafeInteger(size)||size<0||size>ENTRY||(total+=size)>MAX)throw Error('Archive size limit reached.');
    const result=await run(sevenZip,['e','-so','-spd','--',file,row.Path],{windowsHide:true,timeout:30000,encoding:'buffer',maxBuffer:ENTRY+1024,signal});
    if(result.stdout.length!==size)throw Error('Archive entry size differs: '+name);contents.set(name,result.stdout);
  }
  if(!contents.size)throw Error('No supported files were read from the download.');return contents;
}
async function readPrepared(file,game,sevenZip,options={}) {
  const {check=()=>{},onProgress=()=>{}}=options;
  check();onProgress('Hashing source download');
  const sourceHash=await hashSource(file,options),contents=await readDownload(file,sevenZip,options),manifestRoots=[];
  for(const [name,bytes] of contents)if(path.posix.basename(name).toLowerCase()==='mod.manifest') {
    const info=parseManifest(bytes),explicit=info.id?canonical(info.id):null,named=canonical(info.name);
    if(info.id&&named&&explicit!==named)throw Error('Manifest ID conflicts with its dependency name: '+name);
    const id=info.id?explicit:named;
    if(!id||!['luautils','kcdutils','mcm','ptfextender',...optionalMods.keys()].includes(id))continue;
    const folder=info.id||id;if(!/^[a-zA-Z0-9_.-]+$/.test(folder)||safeRelative(folder)!==folder)throw Error('Manifest has an unsafe mod ID');
    if(optionalMods.has(id)&&(!optionalMods.get(id)?.importable||info.id!==id||path.posix.basename(path.posix.dirname(name))!==id))throw Error('Optional mod manifest must use its exact ID and folder: '+id);
    manifestRoots.push({prefix:path.posix.dirname(name)==='.'?'':path.posix.dirname(name)+'/',id,folder,manifest:name});
  }
  if(new Set(manifestRoots.map(m=>m.id)).size!==manifestRoots.length)throw Error('Download contains alternative/duplicate versions. Import one dependency version at a time.');
  if(manifestRoots.some(m=>optionalMods.has(m.id)))for(const name of contents.keys()) {
    const inside=manifestRoots.some(m=>name.startsWith(m.prefix));
    if(!inside&&/\.(?:dll|asi|exe|bat|cmd|ps1|js|vbs|com|scr|msi)$/i.test(name))throw Error('Unsupported code payload outside optional mod: '+name);
  }
  const files=[],ignored=[];const seen=new Set();
  for(const [name,bytes] of contents) {
    check();onProgress('Validating '+name);
    let target=null,dependency=null;
    const mod=manifestRoots.filter(m=>name.startsWith(m.prefix)).sort((a,b)=>b.prefix.length-a.prefix.length)[0];
    if(mod) {
      const relative=name.slice(mod.prefix.length);
      if(optionalMods.has(mod.id)) {
        const profile=optionalMods.get(mod.id);
        if(!optionalFileAllowed(profile,relative))throw Error('Unsupported file in optional mod '+mod.id+': '+relative);
      }
      // Copy complete resources, but never arbitrary executable installers.
      if(/\.exe$|\.bat$|\.cmd$|\.ps1$|\.lnk$/i.test(relative))throw Error('Executable installer inside mod payload: '+relative);
      if(!/^(?:Data\/|Localization\/|KCSE\/Plugins\/|mod\.manifest$|mod\.cfg$|[^/]+\.(?:txt|md|png|jpg|ico|json)$)/i.test(relative)) {ignored.push(name);continue;}
      target=path.join(game.mods,mod.folder,...safeRelative(relative).split('/'));dependency=mod.id;
    }else if(catalog.some(c=>c.id==='soundframework_asi'&&c.importable)&&soundAsiNames.has(name.toLowerCase())) {
      target=path.join(game.bin,name);dependency='soundframework_asi';
    }else if(consoleProfile?.importable&&path.posix.basename(name).toLowerCase()==='consolerpgparam.dll'&&
      (name.toLowerCase()==='consolerpgparam.dll'||/^(?:[^/]+\/)*KCSE\/Plugins\/ConsoleRpgParam\.dll$/i.test(name))) {
      target=path.join(game.root,'KCSE','Plugins','ConsoleRpgParam.dll');dependency='consolerpgparam';
    }else if(/^kcd_addresslib_[a-z0-9_-]+\.bin$/i.test(path.posix.basename(name))) {
      target=path.join(game.root,'KCSE/addresslib',path.posix.basename(name));dependency='addresslib';
    }else if(/^(kcd2db\.asi|dinput8\.dll|version\.dll)$/i.test(path.posix.basename(name))) {
      target=path.join(game.bin,path.posix.basename(name));dependency=path.posix.basename(name).toLowerCase()==='kcd2db.asi'?'luadb':fingerprints[hash(bytes)]||'loader-unverified';
    }else {ignored.push(name);continue;}
    const key=target.toLowerCase();if(seen.has(key))throw Error('Two archive entries map to the same destination.');seen.add(key);
    if(/\.(dll|asi)$/i.test(target)) {
      if(bytes.length<64||bytes.readUInt16LE(0)!==0x5a4d)throw Error('Invalid native binary: '+name);
      const pe=bytes.readUInt32LE(60);if(pe>bytes.length-26||bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(pe+4)!==0x8664||bytes.readUInt16LE(pe+24)!==0x20b)throw Error('Dependency is not a valid x64 PE binary: '+name);
    }
    if(/\.pak$/i.test(target)) {
      const entries=new (require('adm-zip'))(bytes).getEntries(),paths=new Set();let expanded=0;
      if(entries.length>50000)throw Error('Dependency PAK file-count limit reached.');
      for(const e of entries) {
        check();
        const key=safeRelative(e.entryName).toLowerCase();if(paths.has(key))throw Error('Duplicate path inside dependency PAK: '+key);paths.add(key);
        if(((e.header.attr>>>16)&0xf000)===0xa000)throw Error('Linked path inside dependency PAK.');
        if((expanded+=e.header.size)>256*1024*1024)throw Error('Dependency PAK expansion limit reached.');
        if(!e.isDirectory&&crc32(e.getData())!==e.header.crc)throw Error('Dependency PAK CRC mismatch.');
      }
    }
    const current=await fs.lstat(target).catch(()=>null),currentHash=current?.isFile()?await hashFile(target):null;
    files.push({source:name,target,dependency,bytes:bytes.length,sha256:hash(bytes),existing:currentHash,existingIdentity:current?.isFile()?fileIdentity(current):null,state:current?currentHash===hash(bytes)?'identical':'conflict':'missing'});
  }
  for(const mod of manifestRoots.filter(m=>optionalMods.has(m.id))) {
    const profile=optionalMods.get(mod.id),present=new Set(files.filter(f=>f.dependency===mod.id).map(f=>path.relative(path.join(game.mods,mod.folder),f.target).replace(/\\/g,'/').toLowerCase()));
    for(const resource of soundKcseNames)
      if(!present.has(resource.toLowerCase()))throw Error('Optional mod '+mod.id+' is missing required file: '+resource);
      else if(!files.some(f=>f.dependency===mod.id&&path.relative(path.join(game.mods,mod.folder),f.target).replace(/\\/g,'/').toLowerCase()===resource.toLowerCase()&&f.bytes>0))throw Error('Optional mod '+mod.id+' has an empty required file: '+resource);
  }
  if(files.some(f=>f.dependency==='soundframework_asi')) {
    if(manifestRoots.length||contents.size!==soundAsiNames.size||[...contents.keys()].some(n=>!soundAsiNames.has(n.toLowerCase())))throw Error('Sound Framework ASI archive contains unsupported files or another mod.');
    for(const name of soundAsiNames)if(!files.some(f=>f.source.toLowerCase()===name&&f.bytes>0))throw Error('Sound Framework ASI is missing or has an empty required file: '+name);
  }
  if(!files.length)throw Error('No supported dependency files were found in this download. This installer accepts KCSE, Address Library, LuaUtils, KCDUtils, LuaDB, MCM, PTF Extender, ASI Loader, Console RPG Param and Sound Framework downloads. For other mods, follow the author’s installation steps.');
  check();onProgress('Verifying source remained unchanged');
  if(await hashSource(file,options)!==sourceHash)throw Error('The source download changed while it was being read.');
  check();
  const changes=files.filter(f=>f.state!=='identical'),blockers=[];
  blockers.push(...await workshopBlockers(game,files));
  const soundVariant=files.some(f=>f.dependency==='soundframework')?'soundframework':files.some(f=>f.dependency==='soundframework_asi')?'soundframework_asi':null;
  if(soundVariant&&await activeOpposite(game,soundVariant))blockers.push(oppositeMessage);
  const replacingLoader=sharedLoaderReplacement(changes);
  if(replacingLoader)blockers.push('Replacing an existing '+path.basename(replacingLoader.target)+' is blocked. Resolve the loader conflict manually with the authors first.');
  const duplicateAlias=await duplicateLoaderAlias(game,files);
  if(duplicateAlias)blockers.push(duplicateLoaderMessage(duplicateAlias));
  const vortexBlockers=[...blockers];
  if(changes.length)try{await assertManualScope(game,{subtrees:[],files:changes.map(f=>f.target)});}catch(e){blockers.push(e.message);}
  check();
  return {contents,plan:{kind:'download',source:file,sourceHash,files,ignored,blockers,vortexBlockers,canApply:changes.length>0&&!blockers.length,dependencies:[...new Set(files.map(f=>f.dependency))],
    warning:'Review the author and download source. Recognition of a layout does not certify a DLL’s safety or game compatibility.'}};
}
async function prepareDownload(file,game,sevenZip,options={}) {return (await readPrepared(file,game,sevenZip,options)).plan;}
async function exportPrepared(plan,game,destination,sevenZip,{vortex=false,check=()=>{},onProgress=()=>{},signal,workshopFingerprint}={}) {
  const checkWorkshop=async()=>{await assertWorkshopSafe(game,plan.files);if(workshopFingerprint!==undefined&&(await inspectWorkshop(game)).fingerprint!==workshopFingerprint)throw Error('Steam Workshop changed while preparing this installation. Check your setup again.');};
  check();
  await exportGate(game,destination);
  await checkWorkshop();
  if(await hashSource(plan.source)!==plan.sourceHash)throw Error('The source download changed. Choose the file again and review it: '+plan.source);
  const {plan:fresh,contents}=await readPrepared(plan.source,game,sevenZip,{check,onProgress,signal});
  if(fresh.sourceHash!==plan.sourceHash)throw Error('The source download changed. Choose the file again and review it: '+plan.source);
  if(JSON.stringify(fresh.files)!==JSON.stringify(plan.files))throw Error('Game files changed since you reviewed the download. Review the download again before exporting.');
  const existing=await fs.readdir(destination).catch(e=>{if(e.code==='ENOENT')return [];throw e;});if(existing.length)throw Error('Choose an empty output folder.');
  const Zip=require('adm-zip'),groups=new Map();
  // Cancellation/crash leaves an explicit marker, never a falsely complete export.
  check();await exportGate(game,destination);await fs.mkdir(destination,{recursive:true});
  const marker=path.join(destination,'INCOMPLETE.txt');
  await fs.writeFile(marker,'Incomplete dependency export. Do NOT import, deploy or install these files. Retry in a new empty folder.\r\n',{flag:'wx'});
  try {
  for(const entry of plan.files) {
    check();onProgress('Preparing '+entry.source);
    const bytes=contents.get(entry.source);if(hash(bytes)!==entry.sha256)throw Error('Download contents changed');
    let relative,group;
    if(entry.target.startsWith(game.mods+path.sep)){relative=path.relative(game.mods,entry.target);group='mods';}
    else if(entry.target.startsWith(game.bin+path.sep)){relative=path.relative(game.bin,entry.target);group='binaries';}
    else{relative=path.relative(game.root,entry.target);group='game-root';}
    relative=safeRelative(relative);
    if(vortex){
      // Separate providers so Vortex never merges/discards sibling manifests.
      const key=group==='mods'?group+'-'+relative.split('/')[0]:group+'-'+entry.dependency;
      if(!groups.has(key))groups.set(key,{zip:new Zip(),kind:group,files:[]});
      const bundle=groups.get(key),source='payload/'+relative;
      // Match the import helper's bounded path and row contract before marking
      // an export complete. A manual archive can have longer accepted paths.
      if(source.length>240||relative.length>240||bundle.files.length>=3000)throw Error('This dependency exceeds the Vortex import helper path or file-count limit. Use the author\'s Vortex installation instructions.');
      bundle.zip.addFile(source,bytes);
      bundle.files.push({source,destination:relative,bytes:bytes.length,sha256:entry.sha256});
    }
    else {
      const prefix=group==='mods'?'mods':group==='binaries'?path.relative(game.root,game.bin):'';
      const out=path.join(destination,prefix,...relative.split('/'));await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,bytes,{flag:'wx'});
    }
    contents.delete(entry.source);
  }
  if(vortex) {
    await fs.mkdir(destination,{recursive:true});
    for(const [name,bundle] of groups){
      check();onProgress('Compressing '+name);
      const markerBytes=Buffer.from(JSON.stringify({format:'kcd2-dependency-checker.vortex.v1',kind:bundle.kind,files:bundle.files},null,2));
      if(markerBytes.length>1024*1024)throw Error('This dependency exceeds the Vortex import helper metadata limit. Use the author\'s Vortex installation instructions.');
      bundle.zip.addFile('kcd2-dependency-layout.json',markerBytes);
      const compressed=bundle.zip.toBuffer();check();
      await fs.writeFile(path.join(destination,'dependency-'+name+'.zip'),compressed,{flag:'wx'});
      groups.delete(name);
    }
    await exportVortexHelper(path.join(destination,'KCD2-Dependency-Checker-Vortex-Helper.zip'));
  }
  check();onProgress('Finalizing export');await checkWorkshop();await exportGate(game,destination);await fs.mkdir(destination,{recursive:true});
  await fs.writeFile(path.join(destination,'INSTALL.txt'),vortex?
    'FIRST install KCD2-Dependency-Checker-Vortex-Helper.zip through the Vortex Extensions page (not Mods), enable it and restart Vortex. Keep the KCD2 game extension enabled. Then import each dependency-*.zip in the Mods page. These marked packages REQUIRE the helper; do not import without it. Verify each mod type: mods, root or binaries. Enable, resolve conflicts and Deploy with the game closed, then rescan. Do not overwrite a different dinput8.dll without resolving which loader owns it. The checker never edits Vortex staging/state or deploys these files itself.\r\n':
    'These files are arranged for the selected installation. Copy mods to the deployed mod folder, executable-folder files beside KingdomCome.exe, and KCSE/addresslib to the game root. Close the game first. Keep backups of existing files. Do not overwrite a different dinput8.dll without resolving which loader owns it. Rescan after installation.\r\n',{flag:'wx'});
  await fs.writeFile(path.join(destination,'dependency-checker-receipt.json'),JSON.stringify({...plan,exported:new Date().toISOString(),format:vortex?'vortex-zips':'manual-folder'},null,2),{flag:'wx'});
  check();await checkWorkshop();await exportGate(game,destination);await fs.unlink(marker);
  return {destination,files:plan.files.length};
  }catch(e){throw Error(e.message+' Incomplete output retained at '+destination+'; do not install it. Retry in a new empty folder.');}
}
async function exportVortexHelper(file) {
  const zip=new (require('adm-zip'))();
  for(const name of ['index.js','info.json','README.txt','bridge-host.js','bridge-protocol.js'])zip.addFile(name,await fs.readFile(path.join(__dirname,'vortex-helper',name)));
  const workshopBytes=await fs.readFile(path.join(__dirname,'workshop.js'));
  if(!workshopBytes.equals(await fs.readFile(path.join(__dirname,'vortex-helper/workshop.js'))))throw Error('Workshop helper source is out of date. Rebuild the formatter.');
  zip.addFile('workshop.js',workshopBytes);
  const zipRoot=path.dirname(require.resolve('adm-zip/package.json'));
  async function includeZipRuntime(dir,relative=''){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw Error('Linked ZIP runtime entry');
      const rel=relative?relative+'/'+entry.name:entry.name;
      if(entry.isDirectory())await includeZipRuntime(path.join(dir,entry.name),rel);
      else if(entry.isFile())zip.addFile('node_modules/adm-zip/'+rel,await fs.readFile(path.join(dir,entry.name)));
    }
  }
  await includeZipRuntime(zipRoot);
  zip.addFile('LICENSE',await fs.readFile(path.join(__dirname,'..','LICENSE')));
  if(await fs.stat(file).catch(()=>null))throw Error('Helper export already exists');
  await fs.writeFile(file,zip.toBuffer(),{flag:'wx'});
}
function targetBase(game,target) {
  if(path.resolve(target).startsWith(path.resolve(game.mods)+path.sep))return game.mods;
  if(path.resolve(target).startsWith(path.resolve(game.root)+path.sep))return game.root;
  throw Error('Dependency target is outside the selected installation.');
}
const fileIdentity=stat=>({dev:stat.dev,ino:stat.ino,birthtimeMs:stat.birthtimeMs});
const owns=(stat,identity)=>!!stat&&!!identity&&stat.dev===identity.dev&&stat.ino===identity.ino&&stat.birthtimeMs===identity.birthtimeMs;
const sameInode=(stat,identity)=>!!stat&&!!identity&&stat.dev===identity.dev&&stat.ino===identity.ino;
async function unlinkOwnedTemp(temp,identity,expectedHash) {
  if(!identity)return;
  const current=await fs.lstat(temp).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(current?.isFile()&&current.nlink===1&&owns(current,identity)&&await hashFile(temp)===expectedHash)await fs.unlink(temp);
}
async function checkTargets(game,files) {
  for(const f of files) {
    await ensurePlainPath(targetBase(game,f.target),f.target,{fileMayNotExist:true});
    const current=await fs.lstat(f.target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(current&&!current.isFile())throw Error('Target is not a regular file: '+f.target);
    const sha=current?await hashFile(f.target):null;
    if(sha!==f.existing)throw Error('A game file changed since you reviewed the download. Review the download again before installing: '+f.target);
    if(!Object.hasOwn(f,'existingIdentity')||current&&!owns(current,f.existingIdentity)||!current&&f.existingIdentity!==null)throw Error('A game file changed since you reviewed the download, even though its contents look the same. Review the download again before installing: '+f.target);
  }
}
async function installPrepared(plan,report,store,sevenZip,{closed=gameClosed}={}) {
  return locked(store,report.game,async()=>{
    const game=report.game;
    await assertWorkshopSafe(game,plan.files);
    const changes=plan.files.filter(f=>f.state!=='identical');
    const soundVariant=plan.files.some(f=>f.dependency==='soundframework')?'soundframework':plan.files.some(f=>f.dependency==='soundframework_asi')?'soundframework_asi':null;
    if(soundVariant&&await activeOpposite(game,soundVariant))throw Error(oppositeMessage);
    if(!changes.length)throw Error('These dependency files are already identical. No installation is needed.');
    const scope={subtrees:[],files:changes.map(f=>f.target)};
    // Exact destination hashes below replace the unrelated whole-game layout.
    await freshGate(game,report.snapshots,closed,null,scope);
    if(soundVariant&&await activeOpposite(game,soundVariant))throw Error(oppositeMessage);
    await checkTargets(game,plan.files);
    if(await hashSource(plan.source)!==plan.sourceHash)throw Error('The download changed since you reviewed it. Choose the file again and review it before installing: '+plan.source);
    const contents=await readDownload(plan.source,sevenZip);
    const replacingLoader=sharedLoaderReplacement(changes);
    if(replacingLoader)throw Error('Replacing an existing '+path.basename(replacingLoader.target)+' is blocked. Resolve the loader conflict manually with the authors first.');
    const duplicateAlias=await duplicateLoaderAlias(game,plan.files);
    if(duplicateAlias)throw Error(duplicateLoaderMessage(duplicateAlias));
    for(const f of changes)if(hash(contents.get(f.source))!==f.sha256)throw Error('Download contents changed.');
    const dir=path.join(store,crypto.randomUUID());await fs.mkdir(dir);
    const receipt={kind:'dependency',identityVersion:1,game,time:new Date().toISOString(),sourceHash:plan.sourceHash,state:'prepared',files:[],createdDirectories:[]};
    const receiptPath=path.join(dir,'receipt.json');
    for(let i=0;i<changes.length;i++) {
      const f=changes[i],backup=f.existing?path.join(dir,'before-'+i+'.bin'):null;
      if(backup)await fs.copyFile(f.target,backup,require('fs').constants.COPYFILE_EXCL);
      if(backup&&await hashFile(backup)!==f.existing)throw Error('Backup changed during preparation.');
      receipt.files.push({target:f.target,before:f.existing,after:f.sha256,backup,applied:false,installedIdentity:null,temp:null});
    }
    const save=()=>saveReceipt(receiptPath,receipt);await save();
    try {
      await freshGate(game,report.snapshots,closed,null,scope);await checkTargets(game,changes);await assertWorkshopSafe(game,plan.files);
      for(let i=0;i<changes.length;i++) {
        const f=changes[i],parent=path.dirname(f.target),missing=[];let cursor=parent;
        if(soundVariant&&await activeOpposite(game,soundVariant))throw Error(oppositeMessage);
        await assertManualScope(game,scope);await assertWorkshopSafe(game,plan.files);
        while(!await fs.stat(cursor).catch(()=>null)){missing.push(cursor);cursor=path.dirname(cursor);}
        await fs.mkdir(parent,{recursive:true});receipt.createdDirectories.push(...missing.reverse());
        await ensurePlainPath(targetBase(game,f.target),f.target,{fileMayNotExist:true});await checkTargets(game,[f]);
        if(!await closed())throw Error('KCD2 started during installation.');
        const temp=path.join(parent,'.dependency-checker-'+crypto.randomUUID()+'.tmp');
        let tempIdentity=null;
        try {
          const handle=await fs.open(temp,'wx');
          try{tempIdentity=fileIdentity(await handle.stat());await handle.writeFile(contents.get(f.source));}finally{await handle.close();}
          if(await hashFile(temp)!==f.sha256)throw Error('Staged dependency file changed.');
          if(!owns(await fs.lstat(temp),tempIdentity))throw Error('Staged dependency file identity changed.');
          receipt.files[i].installedIdentity=tempIdentity;receipt.files[i].temp=temp;receipt.files[i].applied=true;await save();
          await assertManualScope(game,scope);if(!await closed())throw Error('KCD2 started during installation.');await checkTargets(game,[f]);
          if(soundVariant&&await activeOpposite(game,soundVariant))throw Error(oppositeMessage);
          await ensurePlainPath(targetBase(game,temp),temp);
          await assertWorkshopSafe(game,plan.files);
          if(!owns(await fs.lstat(temp),receipt.files[i].installedIdentity)||await hashFile(temp)!==f.sha256)throw Error('Staged dependency file identity changed.');
          await fs.rename(temp,f.target);
          const installedStat=await fs.lstat(f.target);
          // NTFS may retain the replaced name's creation time after rename.
          if(!sameInode(installedStat,receipt.files[i].installedIdentity)||await hashFile(f.target)!==f.sha256)throw Error('Installed file verification failed.');
          receipt.files[i].installedIdentity=fileIdentity(installedStat);
          receipt.files[i].temp=null;await save();
        }
        finally{
          const current=await fs.lstat(temp).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
          if(current)await unlinkOwnedTemp(temp,tempIdentity,f.sha256);
        }
      }
      await assertWorkshopSafe(game,plan.files);
      receipt.state='applied';await save();return {receipt:receiptPath,changed:changes.map(f=>f.target)};
    }catch(e){receipt.error=e.message;receipt.state='failed';
      const saveRecovery=async()=>{try{await save();}catch(writeError){throw Error(e.message+' Could not update the recovery record: '+writeError.message+' Recovery record: '+receiptPath);}};
      if(!await closed()){receipt.state='rollback-needs-review';await saveRecovery();throw Error(e.message+' Game is running; backup retained without further installation writes. Recovery record: '+receiptPath);}
      // Only revert bytes still belonging to this transaction; never an external edit.
      for(const f of [...receipt.files].reverse().filter(f=>f.applied))try{
        if(!await closed())throw Error('KCD2 started during rollback');
        await assertManualScope(game,{subtrees:[],files:[f.target]});
        await ensurePlainPath(targetBase(game,f.target),f.target,{fileMayNotExist:true});
        const current=await fs.lstat(f.target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        const currentHash=current?await hashFile(f.target):null;
        if(currentHash!==f.before)await restoreFile(game,f,closed,true);
        f.applied=false;await save();
      }catch(re){receipt.rollbackError=(receipt.rollbackError||[]).concat(re.message);}
      receipt.state=receipt.rollbackError?'rollback-needs-review':'rolled-back';await saveRecovery();throw Error(e.message+(receipt.rollbackError?' Backup retained; inspect repair receipt. Recovery record: '+receiptPath:' Changes rolled back.'));
    }
  });
}
async function restoreFile(game,f,closed=gameClosed,requireIdentity=false) {
  await ensurePlainPath(targetBase(game,f.target),f.target);
  if(await hashFile(f.target)!==f.after)throw Error('Cannot undo an externally changed file. Undo stopped to protect your changes; review this file before retrying: '+f.target);
  if(requireIdentity&&!owns(await fs.lstat(f.target),f.installedIdentity))throw Error('Installed file identity changed: this file was replaced after installation. Undo stopped to protect it; review the file and repair receipt before retrying: '+f.target);
  if(f.before===null){await assertManualScope(game,{subtrees:[],files:[f.target]});if(!await closed())throw Error('KCD2 started during rollback');await ensurePlainPath(targetBase(game,f.target),f.target);if(await hashFile(f.target)!==f.after||requireIdentity&&!owns(await fs.lstat(f.target),f.installedIdentity))throw Error('File identity changed while undoing');await fs.unlink(f.target);return;}
  const bytes=await fs.readFile(f.backup);if(hash(bytes)!==f.before)throw Error('Backup integrity failure.');
  const temp=path.join(path.dirname(f.target),'.dependency-checker-undo-'+crypto.randomUUID()+'.tmp');
  let tempIdentity=null;
  try{
    const handle=await fs.open(temp,'wx');
    try{tempIdentity=fileIdentity(await handle.stat());await handle.writeFile(bytes);}finally{await handle.close();}
    if(!owns(await fs.lstat(temp),tempIdentity)||await hashFile(temp)!==f.before)throw Error('Undo backup staging changed. Undo stopped; review the repair receipt before retrying.');
    await assertManualScope(game,{subtrees:[],files:[f.target]});if(!await closed())throw Error('KCD2 started during rollback');await ensurePlainPath(targetBase(game,f.target),f.target);
    if(await hashFile(f.target)!==f.after||requireIdentity&&!owns(await fs.lstat(f.target),f.installedIdentity))throw Error('File identity changed while undoing');
    if(!owns(await fs.lstat(temp),tempIdentity)||await hashFile(temp)!==f.before)throw Error('Undo backup staging changed. Undo stopped; review the repair receipt before retrying.');
    await fs.rename(temp,f.target);
  }finally{await unlinkOwnedTemp(temp,tempIdentity,f.before).catch(()=>{});}
}
async function saveReceipt(file,receipt) {
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  const bytes=Buffer.from(JSON.stringify(receipt,null,2)),expectedHash=hash(bytes);let tempIdentity=null;
  try {
    const handle=await fs.open(temp,'wx');
    try{tempIdentity=fileIdentity(await handle.stat());await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    if(!owns(await fs.lstat(temp),tempIdentity)||await hashFile(temp)!==expectedHash)throw Error('Repair receipt staging changed. Installation stopped; review the receipt before retrying.');
    await fs.rename(temp,file);
  }finally{await unlinkOwnedTemp(temp,tempIdentity,expectedHash).catch(()=>{});}
}
async function undoPrepared(receiptPath,store,{closed=gameClosed}={}) {
  const rp=path.resolve(receiptPath),base=path.resolve(store);
  if(!rp.startsWith(base+path.sep)||path.basename(rp)!=='receipt.json')throw Error('Unknown repair receipt.');
  await ensurePlainPath(base,rp);const receipt=JSON.parse(await fs.readFile(rp,'utf8'));
  if(receipt.kind!=='dependency'||!['prepared','applied','failed','partial','rollback-needs-review','undo-in-progress','undo-needs-review'].includes(receipt.state))throw Error('No dependency installation to undo.');
  if(receipt.identityVersion!==undefined&&receipt.identityVersion!==1)throw Error('Unsupported dependency receipt identity version.');
  const guarded=receipt.identityVersion===1; // Older receipts have hashes only; never treat a v1 receipt as legacy.
  if(!Array.isArray(receipt.files)||receipt.files.length>3000)throw Error('Invalid dependency receipt.');
  if(!guarded&&receipt.files.some(f=>f&&('installedIdentity' in f||'temp' in f)))throw Error('Dependency receipt identity version is missing.');
  const seen=new Set();
  for(const f of receipt.files){
    if(typeof f.target!=='string'||!/^([a-f0-9]{64})$/.test(f.after)||f.before!==null&&!/^[a-f0-9]{64}$/.test(f.before))throw Error('Invalid receipt file.');
    targetBase(receipt.game,f.target);
    const relative=path.relative(receipt.game.root,f.target).replace(/\\/g,'/'),modRelative=path.relative(receipt.game.mods,f.target).replace(/\\/g,'/');
    const modTarget=!modRelative.startsWith('../')&&!path.isAbsolute(modRelative)&&/^[a-z0-9_.-]+\/(Data\/|Localization\/|KCSE\/Plugins\/|mod\.manifest$|mod\.cfg$|[^/]+\.(txt|md|png|jpg|ico|json)$)/i.test(modRelative);
    const nativeTarget=path.dirname(f.target)===receipt.game.bin&&(/^(dinput8\.dll|version\.dll|kcd2db\.asi)$/i.test(path.basename(f.target))||soundAsiNames.has(path.basename(f.target).toLowerCase()));
    const consoleTarget=relative.toLowerCase()==='kcse/plugins/consolerpgparam.dll';
    if(!modTarget&&!nativeTarget&&!consoleTarget&&!/^KCSE\/addresslib\/kcd_addresslib_[a-z0-9_-]+\.bin$/i.test(relative))throw Error('Unsupported dependency rollback target.');
    if(seen.has(f.target.toLowerCase()))throw Error('Duplicate receipt target.');seen.add(f.target.toLowerCase());
    if(f.before!==null){if(!f.backup||path.dirname(f.backup)!==path.dirname(rp)||!/^before-\d+\.bin$/.test(path.basename(f.backup)))throw Error('Unexpected backup path.');await ensurePlainPath(base,f.backup);}
    if(guarded){
      if(f.installedIdentity!==null&&(!f.installedIdentity||!['dev','ino','birthtimeMs'].every(k=>Number.isFinite(f.installedIdentity[k]))))throw Error('Invalid installed file identity.');
      if(f.temp!==null&&(typeof f.temp!=='string'||path.dirname(f.temp)!==path.dirname(f.target)||!/^\.dependency-checker-[a-f0-9-]+\.tmp$/i.test(path.basename(f.temp))))throw Error('Invalid staged file path.');
    }
  }
  return locked(store,receipt.game,async()=>{
    const scope={subtrees:[],files:receipt.files.map(f=>f.target)};
    await freshGate(receipt.game,{},closed,null,scope);
    async function state(f) {
      await ensurePlainPath(targetBase(receipt.game,f.target),f.target,{fileMayNotExist:true});
      const current=await fs.lstat(f.target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(current&&!current.isFile())throw Error('Rollback target is not a file.');
      return current?hashFile(f.target):null;
    }
    const pending=[];
    // Preflight the entire receipt before restoring any file. A prior attempt may
    // already have restored some files or recorded intent without writing them.
    for(const f of receipt.files) {
      if(f.before!==null&&await hashFile(f.backup)!==f.before)throw Error('Backup changed.');
      const current=await state(f);
      if(current===f.before)continue;
      if(current!==f.after)throw Error('Cannot undo an externally changed file: '+f.target);
      if(guarded&&!owns(await fs.lstat(f.target),f.installedIdentity))throw Error('Installed file identity changed: '+f.target);
      pending.push(f);
    }
    // Verify every staged file before restoring any target. A changed leftover
    // temp must block the entire receipt rather than fail halfway through undo.
    if(guarded)for(const f of receipt.files.filter(f=>f.temp)){
      await ensurePlainPath(targetBase(receipt.game,f.temp),f.temp,{fileMayNotExist:true});
      const staged=await fs.lstat(f.temp).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(staged&&(!owns(staged,f.installedIdentity)||await hashFile(f.temp)!==f.after))throw Error('Staged dependency file changed: '+f.temp);
    }
    receipt.state='undo-in-progress';await saveReceipt(rp,receipt);
    try{for(const f of pending.reverse()){
      if(!await closed())throw Error('KCD2 started during undo');
      await assertManualScope(receipt.game,scope);
      if(await state(f)!==f.after)throw Error('File changed while undoing: '+f.target);
      if(guarded&&!owns(await fs.lstat(f.target),f.installedIdentity))throw Error('Installed file identity changed: '+f.target);
      if(f.before===null){
        const quarantine=path.join(path.dirname(rp),'removed-'+receipt.files.indexOf(f)+'.bin');
        await ensurePlainPath(base,quarantine,{fileMayNotExist:true});
        if(!await fs.lstat(quarantine).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))await fs.copyFile(f.target,quarantine,require('fs').constants.COPYFILE_EXCL);
        if(await hashFile(quarantine)!==f.after)throw Error('Quarantine verification failed.');
        await assertManualScope(receipt.game,scope);
        if(!await closed())throw Error('KCD2 started during undo');
        if(await state(f)!==f.after||guarded&&!owns(await fs.lstat(f.target),f.installedIdentity))throw Error('Quarantine verification failed.');
        await fs.unlink(f.target);
      }else await restoreFile(receipt.game,f,closed,guarded);
      f.applied=false;await saveReceipt(rp,receipt);
    }
      if(guarded)for(const f of receipt.files.filter(f=>f.temp)){
        await ensurePlainPath(targetBase(receipt.game,f.temp),f.temp,{fileMayNotExist:true});
        const staged=await fs.lstat(f.temp).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
        if(!staged)continue;
        if(!owns(staged,f.installedIdentity)||await hashFile(f.temp)!==f.after)throw Error('Staged dependency file changed: '+f.temp);
        if(!await closed())throw Error('KCD2 started during staged cleanup');
        await assertManualScope(receipt.game,{subtrees:[],files:[f.temp]});
        if(!owns(await fs.lstat(f.temp),f.installedIdentity)||await hashFile(f.temp)!==f.after)throw Error('Staged dependency file changed: '+f.temp);
        await fs.unlink(f.temp);f.temp=null;await saveReceipt(rp,receipt);
      }
    }catch(e){receipt.state='undo-needs-review';receipt.error=e.message;await saveReceipt(rp,receipt);throw e;}
    receipt.state='undone';await saveReceipt(rp,receipt);return {changed:pending.map(f=>f.target)};
  });
}
module.exports={prepareDownload,exportPrepared,readDownload,exportGate,exportVortexHelper,installPrepared,undoPrepared};
