'use strict';
// Read-only extraction from this app's own source; Node's bundled Acorn avoids a new dependency.
const fs=require('fs'),path=require('path'),vm=require('vm');
const acornModule={exports:{}};
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'],{exports:acornModule.exports,module:acornModule});
const acorn=acornModule.exports,root=path.resolve(__dirname,'..'),strings=new Set(),backend=process.argv.includes('--backend');
const exclude=new Set(['use strict','KCD2 Mod Dependency Formatter','Kingdom Come Script Extender (KCSE)','Address Library for KCSE','Ultimate ASI Loader','Mod Configuration Menu (MCM)','PTF Extender','Console RPG Param','Sound Framework (KCSE plugin)','Sound Framework (ASI plugin)','Sound Framework','Vortex','Steam Workshop','GitHub','Elfis Combat']);
function natural(s){return typeof s==='string'&&s.length<1400&&/[a-zA-Z]/.test(s)&&!exclude.has(s)&&!/[\r\n]/.test(s)&&!s.startsWith('http')&&!/[{}<>]/.test(s)&&(/\s/.test(s)||/^[A-Z][a-z]{2,}(?:[ .…↗:]|$)/.test(s))&&!/^[a-z0-9 _./\\-]+$/.test(s)&&!/^#[a-z]/.test(s);}
function add(s){s=String(s).replace(/\s+/g,' ').trim();if(natural(s))strings.add(s);}
const html=fs.readFileSync(path.join(root,'src/index.html'),'utf8');
if(!backend){for(const m of html.matchAll(/>([^<>]+)</g))add(m[1]);
for(const m of html.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/g))add(m[1]);}
for(const file of backend?['src/scanner.js','src/vortex-bridge.js','src/download-discovery.js']:['src/renderer.js','src/button-help.js','src/catalog.js','main.js','src/runtime-evidence.js']){
 const ast=acorn.parse(fs.readFileSync(path.join(root,file),'utf8'),{ecmaVersion:'latest'});
 function walk(node){if(!node||typeof node!=='object')return;if(node.type==='Literal'&&typeof node.value==='string')add(node.value);if(backend&&node.type==='TemplateLiteral'){const s=node.quasis.map((q,i)=>q.value.cooked+(i<node.expressions.length?'{'+i+'}':'')).join('');if(natural(s.replace(/\{\d+\}/g,'VALUE')))strings.add(s);}for(const [k,v]of Object.entries(node)){if(k==='start'||k==='end')continue;if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}}
 walk(ast);
}
// Exact whole-message templates keep names, paths, numbers and user input untranslated.
const templates=[
'Game found: {0}','Download {0}','{0} requires {1}.','{0} (Workshop, if used) requires {1}.',
'Needed by Workshop mods, if used: {0}','Backup / receipt: {0}','Saved backup: {0}',
'Version: {0}','Installed version: {0}','Detected version: {0}','Source: {0}',
'Verify version of {0}','Open author page for {0}','{0} author-page thumbnail',
'Use “{0}” to continue with this action.','Cannot install with Vortex: {0}',
'Inactive mod {0} will need this before being enabled.','Inactive mods {0} will need this before being enabled.',
'Needed by {0}.','Mod {0} lists this requirement. Check that mod’s author instructions; this tool has no download link for it.',
'Inactive mod {0} lists this requirement. Check that mod’s author instructions; this tool has no download link for it.',
'{0} · File updated: {1}','{0} mod(s) checked.','{0} dependency result(s).',
];
for(const s of templates)strings.add(s);
if(backend){
 const additions=[
 'Vortex records were found, so automatic load-order creation is paused. Review the selected profile and Deploy in Vortex; its Load Order page creates this file.',
 'mod_order.txt was not created: {0}',
 'Created mods\\mod_order.txt from the installed mod folders. A recovery record was saved.',
 'Automatic load-order creation did not finish cleanly. The file may have been created. Review the saved recovery record before continuing. {0}',
 'Automatic load-order creation was deferred: {0}',
 'Vortex is ready for the selected KCD2 profile.',
 'Vortex is switching profiles.',
 'Wait for Vortex to finish its current installation before continuing.',
 'Wait for Vortex to finish switching profiles.',
 'Deploying through Vortex. Respond to any Vortex conflict prompts.',
 'Enabling dependencies in the selected Vortex profile',
 'Importing dependency {0} into Vortex',
 'Vortex installed, enabled and deployed the reviewed dependency runtime files.',
 'Checking {0}',
 'Vortex connection unavailable: {0}',
 '{0} deployed file(s) share their file identity with Vortex staging.',
 '{0} file(s) listed by Vortex are present in the game; their link to staging is unverified.',
 '{0} recorded file(s) are absent from the game.',
 '{0} of these were found only in staging and do not count as installed.',
 '{0} staging identity check(s) could not be completed; deployed-file presence is reported separately.',
 '{0} recorded file(s) remain unverified.',
 'A linked download was skipped: {0}',
 'Download exceeds the {0} MB discovery limit: {1}',
 'Only the first {0} entries were checked. Choose a smaller download folder to see the rest.',
 ];
 additions.forEach(s=>strings.add(s));
 const known={...require('../src/locales/en.json'),...require('../src/locales/en-extra.json')};for(const k of Object.keys(known))strings.delete(k);
 for(const k of ['Data','Localization','Scripts','Plugins','Checking','A linked download was skipped:','Download exceeds the','MB discovery limit:','Only the first','entries were checked. Choose a smaller download folder to see the rest.','Vortex connection unavailable:','{0}: {1}','{0} → {1}','{0} is {1}'])strings.delete(k);
}
const result=Object.fromEntries([...strings].sort().map(s=>[s,s]));
fs.writeFileSync(path.join(root,'src/locales/'+(backend?'en-backend':'en')+'.json'),JSON.stringify(result,null,2)+'\n');
console.log(Object.keys(result).length);
