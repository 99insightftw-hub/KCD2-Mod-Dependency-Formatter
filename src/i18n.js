'use strict';
// Offline presentation-only localization. File names, data values and IPC stay unchanged.
(() => {
 const locales=['en','cs','de','fr','es','it','pl','ru','pt-BR','zh-CN','ja','ko','tr'];
 const storageKey='kcd2-formatter-language';
 const originals=new WeakMap(),attributes=new WeakMap();
 const translatedAttributes=['title','aria-label','placeholder','alt'];
 const excluded='script,style,option,textarea,code,[translate="no"],[data-i18n-skip],.dependency-titlebar h3,.requirement-list,.dependency-thumbnail-fallback';
 const selector=document.getElementById('languageSelect');
 let language='en',patterns=[],paragraphs=new Map(),observer=null;
 function normalizeLocale(value){
  const raw=String(value||'').replace(/_/g,'-').toLowerCase();
  if(raw==='pt'||raw==='pt-br')return 'pt-BR';
  if(raw==='zh'||raw==='zh-cn'||raw==='zh-sg'||raw.startsWith('zh-hans'))return 'zh-CN';
  const base=raw.split('-')[0];
  return locales.includes(base)?base:null;
 }
 function dictionary(){return window.KCD2_TRANSLATIONS?.[language]||{};}
 function compilePatterns(){
  patterns=[];paragraphs=new Map();
  for(const [source,target] of Object.entries(dictionary())){
   if(typeof target!=='string'||!target)continue;
   if(!source.includes('{')){
    // Scanner details are composed from complete, known author guidance and
    // complete warning paragraphs. Never replace fragments within raw data.
    if(source.length>=24&&/[.!?]$/.test(source)){
     const first=source[0];if(!paragraphs.has(first))paragraphs.set(first,[]);
     paragraphs.get(first).push({source,target});
    }
    continue;
   }
   const tokens=[...source.matchAll(/\{(\d+)\}/g)];
   if(!tokens.length||source.replace(/\{\d+\}/g,'').trim().length<4)continue;
   let position=0,expression='^';const numbers=[];
   for(const token of tokens){
    expression+=source.slice(position,token.index).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([\\s\\S]*?)';
    position=token.index+token[0].length;numbers.push(token[1]);
   }
   expression+=source.slice(position).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
   patterns.push({regex:new RegExp(expression),target,numbers,specificity:source.replace(/\{\d+\}/g,'').length});
  }
  patterns.sort((a,b)=>b.specificity-a.specificity);
  for(const entries of paragraphs.values())entries.sort((a,b)=>b.source.length-a.source.length);
 }
 function translateComposition(text){
  if(text.length>24000)return null;
  const failed=new Set();
  function visit(position,count){
   if(position===text.length)return count>1?'':null;
   if(count>20||failed.has(position))return null;
   for(const entry of paragraphs.get(text[position])||[]){
    if(!text.startsWith(entry.source,position))continue;
    const end=position+entry.source.length;
    if(end<text.length&&!/\s/.test(text[end]))continue;
    const whitespace=text.slice(end).match(/^\s*/)[0];
    const remainder=visit(end+whitespace.length,count+1);
    if(remainder!==null)return entry.target+whitespace+remainder;
   }
   failed.add(position);return null;
  }
  return visit(0,0);
 }
 function translate(value){
  const source=String(value??'');
  if(language==='en'||!source.trim())return source;
  const leading=source.match(/^\s*/)[0],trailing=source.match(/\s*$/)[0],text=source.trim();
  // Raw filesystem paths are data, even when a folder name resembles UI text.
  if(/^(?:[a-z]:[\\/]|\\\\|\/|→\s*)/i.test(text))return source;
  const catalog=dictionary();
  if(Object.hasOwn(catalog,text)&&typeof catalog[text]==='string'&&catalog[text])return leading+catalog[text]+trailing;
  const composed=translateComposition(text);
  if(composed!==null)return leading+composed+trailing;
  for(const pattern of patterns){
   const match=pattern.regex.exec(text);if(!match)continue;
   const values={};let valid=true;
   pattern.numbers.forEach((number,index)=>{if(Object.hasOwn(values,number)&&values[number]!==match[index+1])valid=false;values[number]=match[index+1];});
   if(valid)return leading+pattern.target.replace(/\{(\d+)\}/g,(token,index)=>Object.hasOwn(values,index)?values[index]:token)+trailing;
  }
  return source;
 }
 function translateNode(node){
  if(!node.parentElement||node.parentElement.closest(excluded))return;
  const current=node.nodeValue;let entry=originals.get(node);
  if(!entry||current!==entry.rendered)entry={source:current,rendered:current};
  // Plans contain exact paths on separate lines. Match complete lines only;
  // raw log/diagnostic text that has no catalog entry stays verbatim.
  entry.rendered=node.parentElement.closest('pre')?entry.source.split(/(\r?\n)/).map(line=>translate(line)).join(''):translate(entry.source);originals.set(node,entry);
  if(current!==entry.rendered)node.nodeValue=entry.rendered;
 }
 function translateAttributes(element){
  if(element.closest(excluded))return;
  let saved=attributes.get(element);if(!saved){saved={};attributes.set(element,saved);}
  for(const name of translatedAttributes){
   if(!element.hasAttribute(name)){delete saved[name];continue;}
   const current=element.getAttribute(name);let entry=saved[name];
   if(!entry||current!==entry.rendered)entry={source:current,rendered:current};
   entry.rendered=translate(entry.source);saved[name]=entry;
   if(current!==entry.rendered)element.setAttribute(name,entry.rendered);
  }
 }
 function refresh(){
  if(!document.body)return;
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
  let node;while((node=walker.nextNode())){
   if(node.nodeType===Node.TEXT_NODE)translateNode(node);else translateAttributes(node);
  }
  // Presentation writes must not trigger another observer pass.
  observer?.takeRecords();
 }
 function originalText(node){
  if(!node)return '';
  if(node.nodeType===Node.TEXT_NODE){const entry=originals.get(node);return entry&&node.nodeValue===entry.rendered?entry.source:node.nodeValue;}
  return [...node.childNodes].map(originalText).join('');
 }
 function setLanguage(value,{persist=true}={}){
  const selected=normalizeLocale(value)||'en';
  language=selected;compilePatterns();document.documentElement.lang=selected;
  if(selector)selector.value=selected;
  if(persist){try{localStorage.setItem(storageKey,selected);}catch{}}
  try{if(window.checker?.call)Promise.resolve(window.checker.call('set-language',selected)).catch(()=>{});}catch{}
  refresh();window.dispatchEvent(new CustomEvent('languagechange',{detail:{language:selected}}));
  return selected;
 }
 let preferred=null;
 try{preferred=normalizeLocale(localStorage.getItem(storageKey));}catch{}
 if(!preferred)for(const candidate of navigator.languages||[navigator.language]){preferred=normalizeLocale(candidate);if(preferred)break;}
 window.i18n=Object.freeze({locales:Object.freeze([...locales]),setLanguage,translate,refresh,originalText,normalizeLocale,get language(){return language;}});
 selector?.addEventListener('change',()=>setLanguage(selector.value));
 setLanguage(preferred||'en',{persist:false});
 observer=new MutationObserver(()=>refresh());
 observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:translatedAttributes});
})();
