'use strict';
// Only the checker format is handled. Vortex performs all deployment writes.
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const GAME='kingdomcomedeliverance2',MARKER='kcd2-dependency-layout.json';
// Exact native resource names accepted by the checker's download preparation.
const SOUND_ASI=new Set(['.asi','_License.txt','_lipmodel.bin','_moods.ini','_Readme.txt','.ini'].map(s=>('KCD2_SoundFramework'+s).toLowerCase()));
function safe(value) {
  if(typeof value!=='string'||value.length>240||/[\\:\x00-\x1f]/.test(value)||value.startsWith('/'))throw Error('Unsafe package path');
  const parts=value.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[<>"|?*]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe package path');
  return value;
}
function names(files){return files.map(f=>f.replace(/\\/g,'/'));}
async function supported(files,gameId){return {supported:gameId===GAME&&names(files).includes(MARKER),requiredFiles:[MARKER]};}
async function install(files,destinationPath) {
  const available=names(files),seen=new Set();
  for(const name of available.filter(n=>!n.endsWith('/'))){safe(name);if(seen.has(name.toLowerCase()))throw Error('Duplicate package path');seen.add(name.toLowerCase());}
  const markerPath=path.join(destinationPath,MARKER),stat=await fs.lstat(markerPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Invalid checker marker');
  const layout=JSON.parse(await fs.readFile(markerPath,'utf8'));
  const types={mods:GAME+'-mod',binaries:GAME+'-binaries','game-root':GAME+'-root'};
  if(layout.format!=='kcd2-dependency-checker.vortex.v1'||!Object.hasOwn(types,layout.kind)||!Array.isArray(layout.files)||!layout.files.length||layout.files.length>3000)throw Error('Unsupported checker package');
  const destinations=new Set(),sources=new Set(),instructions=[];let total=0,modFolder=null;
  for(const f of layout.files) {
    const source=safe(f.source),dest=safe(f.destination);
    if(!source.startsWith('payload/')||!available.includes(source)||sources.has(source.toLowerCase()))throw Error('Missing or duplicate payload');
    if(destinations.has(dest.toLowerCase()))throw Error('Duplicate deployment destination');
    sources.add(source.toLowerCase());destinations.add(dest.toLowerCase());
    if(layout.kind==='binaries'&&!/^(kcd2db\.asi|dinput8\.dll|version\.dll)$/i.test(dest)&&!SOUND_ASI.has(dest.toLowerCase()))throw Error('Unexpected executable-folder destination');
    if(layout.kind==='game-root'&&!/^KCSE\/addresslib\/kcd_addresslib_[a-z0-9_-]+\.bin$/i.test(dest)&&!/^KCSE\/Plugins\/ConsoleRpgParam\.dll$/i.test(dest))throw Error('Unexpected game-root destination');
    if(layout.kind==='mods') {
      const [folder,...parts]=dest.split('/'),relative=parts.join('/');
      if(!/^[a-zA-Z0-9_.-]+$/.test(folder)||!relative||/\.(exe|bat|cmd|ps1|lnk)$/i.test(relative)||! /^(?:Data\/|Localization\/|KCSE\/Plugins\/|mod\.manifest$|mod\.cfg$|[^/]+\.(?:txt|md|png|jpg|ico|json)$)/i.test(relative))throw Error('Unexpected mod destination');
      if(modFolder&&modFolder!==folder)throw Error('One dependency mod per package is required');modFolder=folder;
    }
    if(!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>80*1024*1024||(total+=f.bytes)>512*1024*1024||! /^[a-f0-9]{64}$/i.test(f.sha256))throw Error('Invalid payload identity');
    const full=path.join(destinationPath,...source.split('/'));
    let cursor=destinationPath;
    for(const component of source.split('/')){cursor=path.join(cursor,component);if((await fs.lstat(cursor)).isSymbolicLink())throw Error('Linked payload');}
    const st=await fs.lstat(full);if(!st.isFile()||st.size!==f.bytes)throw Error('Payload size mismatch');
    const actual=crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');
    if(actual!==f.sha256.toLowerCase())throw Error('Payload hash mismatch');
    instructions.push({type:'copy',source:source.replace(/\//g,path.sep),destination:dest.replace(/\//g,path.sep)});
  }
  if(available.some(n=>!n.endsWith('/')&&n!==MARKER&&!sources.has(n.toLowerCase())))throw Error('Undeclared package payload');
  if(layout.kind==='binaries'&&layout.files.some(f=>SOUND_ASI.has(f.destination.toLowerCase()))) {
    if(layout.files.length!==SOUND_ASI.size||layout.files.some(f=>!SOUND_ASI.has(f.destination.toLowerCase())||f.bytes===0))throw Error('Incomplete or mixed Sound Framework ASI package');
  }
  if(layout.kind==='mods'&&!layout.files.some(f=>f.destination.toLowerCase()===(modFolder+'/mod.manifest').toLowerCase()))throw Error('Missing dependency manifest');
  instructions.push({type:'setmodtype',value:types[layout.kind]});
  if(modFolder)instructions.push({type:'attribute',key:'modFolderDerived',value:modFolder},{type:'attribute',key:'modRootPath',value:modFolder});
  return {instructions};
}
function main(context){
  context.registerInstaller('kcd2-dependency-checker-import',10,supported,install);
  if(typeof context.once==='function')context.once(()=>{
    require('./bridge-host').startBridge(context).catch(error=>context.api?.sendNotification?.({type:'warning',title:'KCD2 formatter connection unavailable',message:error.message}));
  });
  return true;
}
module.exports={default:main,validatePrepared:install};
