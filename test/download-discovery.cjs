'use strict';
const assert=require('assert/strict'),fs=require('fs/promises'),path=require('path');
const {discoverDownloads}=require('../src/download-discovery');
const root=path.resolve(__dirname,'../../test-output/download-discovery-'+Date.now());
let assertions=0;const ok=x=>{assert(x);assertions++;};
const put=async(name,bytes='archive-not-read')=>{const p=path.join(root,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,bytes);return p;};
async function main() {
 await fs.mkdir(root,{recursive:true});
 await put('KCSE-3332-1-0.zip');await put('KCDUtils-2410-1-0.7z');await put('LuaUtils (1).zip');
 await put('elfis_combat.zip');await put('Address Library for KCSE-3381.7z');await put('LuaDB-1523.zip');
 await put('KCSE.zip.crdownload');await put('KCSE.part.zip');await put('KCSE.tmp.7z');await put('holiday.zip');await put('33321.zip');
 await put('nested/KCSE-3332.zip');await put('KCSE-empty.zip','');
 let first=await discoverDownloads(root,{now:10000});ok(first.candidates.length===0);ok(first.pending.length===5);ok(first.observations.length===5);
 let early=await discoverDownloads(root,{known:first.observations,now:10500});ok(early.candidates.length===0);
 let stable=await discoverDownloads(root,{known:early.observations,now:12000});ok(stable.candidates.length===5);ok(stable.pending.length===0);
 ok(!stable.candidates.some(f=>f.name==='elfis_combat.zip'));
 ok(stable.candidates.find(f=>f.name==='LuaDB-1523.zip').dependencyHints.includes('luadb'));
 ok(stable.candidates.find(f=>f.name.startsWith('Address')).dependencyHints.includes('addresslib'));
 await fs.appendFile(path.join(root,'KCSE-3332-1-0.zip'),'still-writing');
 let growing=await discoverDownloads(root,{known:stable.observations,now:14000});ok(growing.pending.length===1);ok(growing.candidates.length===4);
 let settled=await discoverDownloads(root,{known:growing.observations,now:16000});ok(settled.candidates.length===5);
 await put('KCSE-3332-copy.zip');
 let duplicates=await discoverDownloads(root,{known:settled.observations,now:18000});ok(duplicates.candidates.length===5);ok(duplicates.pending.length===1);
 duplicates=await discoverDownloads(root,{known:duplicates.observations,now:20000});ok(duplicates.candidates.filter(f=>f.dependencyHints.includes('kcse')).length>=3);
 const linkSource=await put('shared/KCDUtils.zip');await fs.link(linkSource,path.join(root,'KCDUtils-hardlink.zip'));
 const links=await discoverDownloads(root,{known:duplicates.observations,now:22000});ok(!links.candidates.some(f=>f.name.includes('hardlink')));ok(/linked/.test(links.warning));
 const bounded=await discoverDownloads(root,{maxCandidates:1,now:22000});ok(bounded.observations.length===1);ok(/limit/.test(bounded.warning));
 const byteLimit=await discoverDownloads(root,{maxBytes:1,now:22000});ok(byteLimit.observations.length===0);ok(/limit/.test(byteLimit.warning));
 const expired=await discoverDownloads(root,{known:duplicates.observations,now:1000000});ok(expired.candidates.length===0);
 const entryLimit=await discoverDownloads(root,{maxEntries:1,now:22000});ok(/first 1 entries/.test(entryLimit.warning));
 const mainOnly=await discoverDownloads(path.join(root,'nested'),{now:1});ok(mainOnly.pending.length===1);
 await put('hints/kcd2db.7z');await put('hints/package-1523.zip');
 const dbHints=await discoverDownloads(path.join(root,'hints'),{now:1});
 ok(dbHints.pending.length===2);ok(dbHints.pending.every(f=>f.dependencyHints.includes('luadb')));
 await put('misc-dependencies/PTF_Extender-1.0.zip');await put('misc-dependencies/package-3398.7z');
 await put('misc-dependencies/MCM.zip');await put('misc-dependencies/Mod Configuration Menu.7z');await put('misc-dependencies/package-3363.zip');
 await put('misc-dependencies/package-33981.zip');
 const miscFirst=await discoverDownloads(path.join(root,'misc-dependencies'),{now:10000});
 const miscStable=await discoverDownloads(path.join(root,'misc-dependencies'),{known:miscFirst.observations,now:12000});
 ok(miscFirst.pending.length===5);ok(miscStable.candidates.length===5);
 ok(miscStable.candidates.filter(f=>f.dependencyHints.includes('ptfextender')).length===2);
 ok(miscStable.candidates.filter(f=>f.dependencyHints.includes('mcm')).length===3);
 ok(!miscStable.candidates.some(f=>f.name==='package-33981.zip'));
 await put('asi-downloads/Ultimate-ASI-Loader_x64.zip');await put('asi-downloads/ordinary-loader.zip');
 const asiFirst=await discoverDownloads(path.join(root,'asi-downloads'),{now:10000});
 const asiStable=await discoverDownloads(path.join(root,'asi-downloads'),{known:asiFirst.observations,now:12000});
 ok(asiStable.candidates.length===1);ok(asiStable.candidates[0].dependencyHints.includes('asi'));
 const optionalNames={
  'Console Editable RpgParams-3333.zip':'consolerpgparam',
  'KCD2_SoundFramework_KCSE_v1.2.0.zip':'soundframework',
  'KCD2_SoundFramework_v1.2.0.zip':'soundframework_asi'
 };
 for(const name of Object.keys(optionalNames))await put('optional/'+name);
 for(const name of ['HorseRouteFollow-1.1.3.zip','TheatricalAutoForge-1.1.2.zip','SoundFramework-source.zip','SoundFramework-readme.zip','package-38601.zip'])await put('optional/'+name);
 const optionalRoot=path.join(root,'optional');
 const optionalFirst=await discoverDownloads(optionalRoot,{now:10000});
 const optionalStable=await discoverDownloads(optionalRoot,{known:optionalFirst.observations,now:12000});
 ok(optionalStable.candidates.length===3);
 for(const [name,id] of Object.entries(optionalNames))ok(optionalStable.candidates.find(f=>f.name===name)?.dependencyHints.includes(id));
 ok(optionalStable.candidates.every(f=>Object.hasOwn(optionalNames,f.name)));
 ok(!optionalStable.candidates.find(f=>f.name.includes('SoundFramework_KCSE')).dependencyHints.includes('kcse'));
 await assert.rejects(()=>discoverDownloads(root,{maxEntries:100000}),/limit/);assertions++;
 console.log('Download discovery passed: '+assertions+' assertions. Fixtures: '+root);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
