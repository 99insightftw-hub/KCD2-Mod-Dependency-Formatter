'use strict';
const {catalog}=require('./catalog');

// Exact author manifest identities; a folder/name containing "misc" is insufficient.
const MISC_IDS=Object.freeze(['zzmiscoverhaul_parttwo','zzmiscoverhaul_parttwo_dbjcompatible']);
const MISC_SOURCE=Object.freeze({id:'misc',url:'https://www.nexusmods.com/kingdomcomedeliverance2/mods/3584?tab=description',filesUrl:'https://www.nexusmods.com/kingdomcomedeliverance2/mods/3584?tab=files',version:null});
const required=['kcse','luadb','kcdutils','luautils','ptfextender'];
const statuses=new Set(['installed','missing','incomplete','disabled','review','unknown']);

async function inspectMisc(report) {
  const mods=(report.mods||[]).filter(m=>MISC_IDS.includes(String(m.id).toLowerCase()));
  const incomplete=!!report.layout?.incomplete;
  let status='missing',detail='Misc Overhaul was not found among the inspected mod manifests. Install the complete author download, then scan again.';
  const mod=mods.length===1?mods[0]:null;
  if(mods.length>1){status='ambiguous';detail='More than one Misc Overhaul edition was found. Select one intended edition using its author instructions.';}
  else if(mod) {
    if(!mod.active){status='disabled';detail='Misc Overhaul was found but is excluded from mod_order.txt.';}
    else if(!Number.isInteger(mod.pakCount)||!Number.isInteger(mod.inspectedPakCount)){status='unknown';detail='The manifest was found, but this scan does not establish its Data PAK inspection.';}
    else if(mod.pakCount===0||mod.inspectedPakCount!==mod.pakCount){status='incomplete';detail='The manifest was found, but its complete Data PAK contents could not be inspected. Reinstall the complete author download or resolve the scan finding.';}
    else if(incomplete){status='review';detail='Misc Overhaul files were found, but the dependency layout scan is incomplete.';}
    else {status='installed';detail='Misc Overhaul manifest and readable Data PAK files found. File placement does not establish runtime compatibility.';}
  }else if(incomplete){status='unknown';detail='The dependency layout scan is incomplete; Misc Overhaul presence could not be established.';}
  const dependencies=[...required,'addresslib'].map(id=>{
    const entry=catalog.find(d=>d.id===id),current=(report.dependencies||[]).find(d=>d.id===id);
    let state=current&&statuses.has(current.status)?current.status:'unknown';
    if(incomplete&&state==='missing')state='unknown';
    const evidence=(report.binaries||[]).filter(b=>b.dependency===id);
    const unidentified=id==='kcse'?(report.binaries||[]).filter(b=>!b.dependency&&/(?:^|[/\\])dinput8\.dll$/i.test(b.file)):[];
    if(state==='missing'&&evidence.length)state='incomplete';
    if(state==='missing'&&unidentified.length)state='review';
    const native=evidence.filter(b=>b.active&&b.placed);
    const versionVerified=native.length>0&&native.every(b=>b.recognized);
    const note=id==='addresslib'?'Supporting requirement of KCSE and PTF Extender. ':'';
    let description=note+(current?.detail||entry.help);
    if(state==='incomplete'&&current?.status==='missing')description+=' A matching native filename was found, but placement, activation or x64 validation is incomplete.';
    if(unidentified.length)description+=' An unidentified dinput8.dll was found. Its filename cannot establish KCSE; do not replace it without checking the author instructions.';
    if(state==='unknown')description=note+'This scan did not establish whether the required files are installed. Scan again after resolving inaccessible paths.';
    if(state==='installed'&&id!=='addresslib')description+=' Files found; dependency version compatibility and loading this launch remain unverified.';
    return {...entry,status:state,reviewReason:state===current?.status?current?.reviewReason||null:null,present:state==='installed',requirement:required.includes(id)?'required':'supporting',detail:description,files:[...new Set([...(current?.files||[]),...evidence.map(b=>b.file),...unidentified.map(b=>b.file)])],providers:current?.providers||[],requiredBy:['Misc Overhaul'],nativeIdentityRecognized:versionVerified,runtimeVerified:false};
  });
  const note='Add -devmode to your game launch options. This file scan cannot verify the options used when the game starts.';
  return {name:'Misc Overhaul',source:{...MISC_SOURCE},readOnly:true,
    mod:{status,folder:mod?.root||null,expectedFolder:mod?.id||MISC_IDS[0],version:mod?.version||null,detail},dependencies,
    launch:{status:'unknown',argument:'-devmode',note,detail:note},
    summary:'Read-only file check. Follow the author instructions for installation and load order; current runtime behavior is unverified.',
    limitations:['No files or load-order entries are changed by this profile.','A recognized native identity or installed status does not prove runtime compatibility.']};
}

module.exports={inspectMisc,MISC_IDS,MISC_SOURCE};
