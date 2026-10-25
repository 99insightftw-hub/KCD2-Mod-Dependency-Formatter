'use strict';
// Steam discovery adapted from the separate GPL-3.0 inventory merger.
const fs=require('fs/promises'),path=require('path');
const {execFile}=require('child_process'),{promisify}=require('util');
const run=promisify(execFile);
const {discoverWorkshop}=require('./workshop');
const exists=async p=>!!(await fs.stat(p).catch(()=>null));
async function resolveGame(input,{steamRoots=[]}={}) {
  // Windows "Copy as path" wraps the path in double quotes.
  let value=String(input||'').trim();
  if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
  if(!value)throw Error('Choose an existing KCD2 game folder or KingdomCome.exe.');
  let selected=path.resolve(value),stat=await fs.stat(selected).catch(()=>null);
  if(!stat)throw Error('Choose an existing KCD2 game folder or KingdomCome.exe.');
  if(await exists(path.join(selected,'__vortex_staging_folder')))throw Error('This is Vortex staging. Deploy first, then choose the installed game.');
  const exe=stat.isFile()&&path.basename(selected).toLowerCase()==='kingdomcome.exe'?selected:null;
  if(stat.isFile()&&!exe)throw Error('Choose KingdomCome.exe or the game folder.');
  let root=stat.isFile()?path.dirname(selected):selected;
  for(let i=0;i<5;i++,root=path.dirname(root)) {
    if(!await exists(path.join(root,'Data'))||!await exists(path.join(root,'Bin')))continue;
    const candidates=[];
    for(const e of await fs.readdir(path.join(root,'Bin'),{withFileTypes:true})) {
      if(!e.isDirectory()||!/^Win64/i.test(e.name))continue;
      const bin=path.join(root,'Bin',e.name);
      if(await exists(path.join(bin,'KingdomCome.exe'))&&await exists(path.join(bin,'WHGame.dll')))candidates.push(bin);
    }
    const bin=exe?candidates.find(b=>path.resolve(b).toLowerCase()===path.dirname(exe).toLowerCase()):candidates.length===1?candidates[0]:null;
    if(!bin)throw Error(candidates.length>1?'More than one game executable exists. Browse to the KingdomCome.exe you launch.':'No KCD2 executable and WHGame.dll pair was found.');
    const xbox=/xbox|store|gdk|gamepass/i.test(path.basename(bin))||await exists(path.join(root,'MicrosoftGame.config'));
    const documents=process.env.USERPROFILE?path.join(process.env.USERPROFILE,'Documents'):null;
    let mods=path.join(root,'mods');
    if(xbox) {
      // Vortex's KCD2 extension uses Documents/kingdomcome_mods on Xbox.
      if(!documents)throw Error('Could not locate Documents for this Xbox installation.');
      try {const {stdout}=await run('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders','/v','Personal'],{windowsHide:true,timeout:3000});
        const personal=/REG_EXPAND_SZ\s+(.+)|REG_SZ\s+(.+)/.exec(stdout);
        if(personal)mods=path.join((personal[1]||personal[2]).trim().replace(/%([^%]+)%/g,(_,n)=>process.env[n]||'%'+n+'%'),'kingdomcome_mods');
        else mods=path.join(documents,'kingdomcome_mods');
      }catch {mods=path.join(documents,'kingdomcome_mods');}
    }
    const distribution=xbox?'xbox':/steam/i.test(path.basename(bin))?'steam':/gog/i.test(path.basename(bin))?'gog':/epic/i.test(path.basename(bin))?'epic':'unknown';
    const resolvedRoot=await fs.realpath(root);
    const workshopInfo=await discoverWorkshop(resolvedRoot,{distribution,steamRoots});
    return {root:resolvedRoot,bin,mods,distribution,workshop:workshopInfo.roots[0]||null,workshopRoots:workshopInfo.roots,workshopMetadataFiles:workshopInfo.metadataFiles,workshopDiscoveryIssues:workshopInfo.issues};
  }
  throw Error('Could not find the KCD2 game root from that location. Browse to the folder containing Bin and Data.');
}
const vdfPaths=text=>[...text.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/gi)].map(m=>m[1].replace(/\\\\/g,'\\'));
async function discover(extra=[]) {
  const steamRoots=[...extra],gameRoots=[];
  for(const base of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles])if(base)steamRoots.push(path.join(base,'Steam'));
  if(process.platform==='win32') {
    for(const key of ['HKCU\\Software\\Valve\\Steam','HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam'])try {
      const {stdout}=await run('reg.exe',['query',key],{windowsHide:true,timeout:3000});
      for(const m of stdout.matchAll(/(?:SteamPath|InstallPath)\s+REG_SZ\s+(.+)/gi))steamRoots.push(m[1].trim());
    }catch{}
    for(const key of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1248083010','HKLM\\SOFTWARE\\GOG.com\\Games\\1248083010'])try {
      const {stdout}=await run('reg.exe',['query',key,'/v','path'],{windowsHide:true,timeout:3000});
      const m=/\bpath\s+REG_SZ\s+(.+)/i.exec(stdout);if(m)gameRoots.push(m[1].trim());
    }catch{}
    const epic=process.env.ProgramData&&path.join(process.env.ProgramData,'Epic/EpicGamesLauncher/Data/Manifests');
    if(epic)for(const e of (await fs.readdir(epic).catch(()=>[])).slice(0,500))if(e.endsWith('.item'))try {
      const m=JSON.parse(await fs.readFile(path.join(epic,e),'utf8'));
      if(/kingdom\s*come.*(?:ii|2)/i.test(m.DisplayName||''))gameRoots.push(m.InstallLocation);
    }catch{}
  }
  for(const root of [...new Set(steamRoots)])try{steamRoots.push(...vdfPaths(await fs.readFile(path.join(root,'steamapps/libraryfolders.vdf'),'utf8')));}catch{}
  for(const root of [...new Set(steamRoots)])try {
    const m=await fs.readFile(path.join(root,'steamapps/appmanifest_1771300.acf'),'utf8');
    const name=/"installdir"\s*"([^"\\/]+)"/.exec(m)?.[1];
    if(name)gameRoots.push(path.join(root,'steamapps/common',name));
  }catch{}
  const found=[];
  for(const root of [...new Set(gameRoots.filter(Boolean))])try {
    const game=await resolveGame(root,{steamRoots});
    if(!found.some(g=>g.root.toLowerCase()===game.root.toLowerCase()))found.push(game);
  }catch{}
  return found;
}
module.exports={resolveGame,discover,vdfPaths,exists};
