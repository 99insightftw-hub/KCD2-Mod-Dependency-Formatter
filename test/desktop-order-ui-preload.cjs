'use strict';
const {contextBridge}=require('electron');
contextBridge.exposeInMainWorld('checker',{
 call:async name=>name==='fixture-postcreate-error'?{ok:false,error:'Post-create rescan failed',automaticOrder:{state:'created',message:'The list was created; recheck failed.',receipt:'C:\\fixture\\receipt.json'}}:{ok:true,value:name==='discover'?[]:name==='find-downloads'?{folder:'C:\\fixture\\downloads',candidates:[]}:null},
 progress:()=>{},cancellable:()=>{}
});
