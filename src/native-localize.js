'use strict';
// Native dialog localization is independent of game state and never changes paths.
const path=require('node:path');
const SUPPORTED=Object.freeze(['en','cs','de','fr','es','it','pl','ru','pt-BR','zh-CN','ja','ko','tr']);
const supported=new Set(SUPPORTED);
const cache=new Map();
function dictionary(locale){
 if(cache.has(locale))return cache.get(locale);
 let value={};
 if(supported.has(locale)&&locale!=='en'){
  try{value=require(path.join(__dirname,'locales',locale+'.json'));}catch{value={};}
 }
 cache.set(locale,value);return value;
}
function createLocalizer(){
 let language='en';
 function setLanguage(locale){
  if(typeof locale!=='string'||!supported.has(locale))throw Error('Unsupported language');
  language=locale;return language;
 }
 function translate(text){
  if(typeof text!=='string'||language==='en')return text;
  const entries=dictionary(language);
  if(Object.hasOwn(entries,text)&&typeof entries[text]==='string')return entries[text];
  for(const [source,target]of Object.entries(entries)){
   if(!/\{\d+\}/.test(source)||typeof target!=='string')continue;
   const slots=[];
   const pattern=source.split(/(\{\d+\})/).map(part=>{
    if(/^\{\d+\}$/.test(part)){slots.push(part);return '([\\s\\S]*?)';}
    return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   }).join('');
   const match=new RegExp('^'+pattern+'$').exec(text);if(!match)continue;
   const values=new Map(slots.map((slot,i)=>[slot,match[i+1]]));
   return target.replace(/\{\d+\}/g,slot=>values.has(slot)?values.get(slot):slot);
  }
  return text;
 }
 function dialogOptions(options){
  const localized={...options};
  for(const key of ['title','message','detail','buttonLabel'])if(typeof options[key]==='string')localized[key]=translate(options[key]);
  if(Array.isArray(options.buttons))localized.buttons=options.buttons.map(translate);
  if(Array.isArray(options.filters))localized.filters=options.filters.map(filter=>({...filter,name:translate(filter.name)}));
  return localized;
 }
 return {setLanguage,translate,dialogOptions,get language(){return language;}};
}
module.exports={createLocalizer,SUPPORTED};
