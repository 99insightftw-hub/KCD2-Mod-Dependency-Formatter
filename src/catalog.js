'use strict';
const nexus = id => `https://www.nexusmods.com/kingdomcomedeliverance2/mods/${id}`;
const catalog = [
  {id:'kcse',name:'Kingdom Come Script Extender (KCSE)',kind:'loader',files:['dinput8.dll'],requires:['addresslib'],url:nexus(3332),
   help:'KCSE’s dinput8.dll belongs beside KingdomCome.exe and WHGame.dll. A generic ASI loader using the same filename is a different file.'},
  {id:'addresslib',name:'Address Library for KCSE',kind:'addresses',requires:[],url:nexus(3381),
   help:'Install KCSE/addresslib under the game root. The table must match the game distribution and build.'},
  {id:'luautils',name:'LuaUtils',kind:'plugin',files:['LuaUtils.dll'],requires:['kcse'],url:nexus(3439),
   help:'Needs both the KCSE plugin and its PAK-owned Lua bootstrap. LuaUtils is different from KCDUtils.'},
  {id:'kcdutils',name:'KCDUtils',kind:'lua',files:['kcdutils.lua'],requires:[],url:nexus(2410),
   help:'Needs the KCDUtils Lua bootstrap and utility scripts. LuaDB is conditional: database/configuration features use it.'},
  {id:'luadb',name:'LuaDB',kind:'asi',files:['kcd2db.asi'],requires:[],url:nexus(1523),
   help:'kcd2db.asi belongs beside KingdomCome.exe. Needs an ASI loader or a KCSE build supporting ASI loading.'},
  {id:'asi',name:'Ultimate ASI Loader',kind:'loader',files:['version.dll','dinput8.dll','winmm.dll','dsound.dll','d3d9.dll','dxgi.dll','xinput1_3.dll'],requires:[],url:'https://github.com/ThirteenAG/Ultimate-ASI-Loader',
   help:'Use the x64 loader beside KingdomCome.exe. Do not overwrite KCSE’s dinput8.dll with another loader.'},
  {id:'mcm',name:'Mod Configuration Menu (MCM)',kind:'plugin',files:['MCM.dll'],requires:['kcse'],url:nexus(3363),
   help:'The native plugin and its UI resources must both be installed. A DLL alone is incomplete.'},
  {id:'ptfextender',name:'PTF Extender',kind:'plugin',files:['PTFextender.dll'],requires:['kcse'],url:nexus(3398),
   help:'Install the complete mod with KCSE/Plugins/PTFextender.dll. Does not resolve every kind of XML conflict.'},
  {id:'consolerpgparam',name:'Console RPG Param',kind:'plugin',files:['ConsoleRpgParam.dll'],requires:['kcse'],url:nexus(3333),importable:true,optional:true,nativeOnly:true,requiredResources:[],
   help:'Install ConsoleRpgParam.dll in KCSE/Plugins, either in the game root or its own mod folder. File recognition cannot confirm runtime loading.'},
  {id:'soundframework',name:'Sound Framework (KCSE plugin)',kind:'plugin',files:['KCD2_SoundFramework.dll'],requires:['kcse'],url:nexus(3860),importable:true,optional:true,activation:true,requiredResources:['KCSE/Plugins/KCD2_SoundFramework.ini','KCSE/Plugins/KCD2_SoundFramework_moods.ini','KCSE/Plugins/KCD2_SoundFramework_lipmodel.bin'],
   help:'Use the complete Sound Framework KCSE plugin mod, including its configuration and lip model. Requires an enabled soundframework provider.'},
  {id:'soundframework_asi',name:'Sound Framework (ASI plugin)',kind:'asi',files:['KCD2_SoundFramework.asi'],requires:[],url:nexus(3860),importable:true,optional:true,nativeOnly:true,requiredResources:['KCD2_SoundFramework.ini','KCD2_SoundFramework_moods.ini','KCD2_SoundFramework_lipmodel.bin'],
   help:'Install the ASI variant and its three companion files beside KingdomCome.exe. Requires an ASI loader or KCSE with ASI loading.'}
];
const aliases = {
  kcse:'kcse',addresslibrary:'addresslib',addresslibraryforkcse:'addresslib',addresslib:'addresslib',
  kingdomcomescriptextender:'kcse',luautils:'luautils',kcd2luautils:'luautils',kcdutils:'kcdutils',
  luadb:'luadb',kcd2db:'luadb',mcm:'mcm',modconfigurationmenu:'mcm',modmenu:'mcm',
  ptfextender:'ptfextender',ultimateasiloader:'asi',asiloader:'asi',
  consolerpgparam:'consolerpgparam',consolerpgparameter:'consolerpgparam',
  soundframework:'soundframework',kcd2soundframework:'soundframework',soundframeworkkcse:'soundframework',soundframeworkkcseplugin:'soundframework',soundframeworkasiplugin:'soundframework_asi',soundframeworkasi:'soundframework_asi',
};
function canonical(name) {return aliases[String(name).toLowerCase().replace(/[^a-z0-9]/g,'')] || null;}
const fingerprints = {
 '44bb25ca2baabbc75b25fa6361b38e621a3d24c43d2c1a614492122c5aeb36eb': 'kcse',
 '22fda9c71eaae02460f311bf3441638340ab591586d78f1de213c4819dcb883c': 'asi',
 '2b375fedb59e7de0448345e24ecd7eb7c3138f692f13cdcf0311d0100103945d': 'luadb',
 '679d912777a2304f944f4dbecbfe3072181bff52d24fd0b80a7ec726338c34a3': 'luautils',
 'c8c6c84de60b6327cfbcfacbbf273927eaacdaeeb168f98e70b8493d5bbbe3d1': 'ptfextender',
 '4a633054acd1bebf2e119d54921da24a89687a99b4485a87fab68ec998602e90': 'mcm',
 'a34bebf2786951a6fc3ed3b0d2476ec0099a3537d48d1f0848c59dd7000764e7':'soundframework',
 '56dc6bf77fd33c83b67ce4560beebcffb0fff88bb2f2118ba26a612c281f2aa8':'soundframework_asi'
};
// A reference identity is recognition only, never an exhaustive compatibility list.
const gameReferences = {
 'bdf8f9e4a11257a72b64c84700e284c29e4c4ccaf5b8d4bfa7d0b2a7294479f7': {
   distribution:'steam',build:'release_1_5-15693',version:'1.5.6',
   address:'kcd_addresslib_steam_release_1_5-15693.bin',
   addressHash:'420ec1da4a60675b2bfaFefc76deddcf95ce9806926747722d0b45f7ae052352'.toLowerCase()
 }
};
const nexusIds={kcse:3332,addresslib:3381,luautils:3439,kcdutils:2410,luadb:1523,mcm:3363,ptfextender:3398,consolerpgparam:3333,soundframework:3860,soundframework_asi:3860};
function nexusFiles(id){if(!Object.hasOwn(nexusIds,id))throw Error('No verified Nexus download page for this dependency.');return nexus(nexusIds[id])+'?tab=files';}
const githubPages={soundframework:'https://github.com/tkhquang/KCD2Tools/releases/tag/SoundFramework-v1.2.0',soundframework_asi:'https://github.com/tkhquang/KCD2Tools/releases/tag/SoundFramework-v1.2.0'};
function githubRelease(id){if(!Object.hasOwn(githubPages,id))throw Error('No verified GitHub release page for this plugin.');return githubPages[id];}
for(const plugin of catalog)if(Object.hasOwn(githubPages,plugin.id))plugin.github=true;
module.exports={catalog,canonical,fingerprints,gameReferences,nexusIds,nexusFiles,githubRelease};
