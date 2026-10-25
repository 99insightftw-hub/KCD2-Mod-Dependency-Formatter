'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const managerOperations=new Set(['export-vortex-download','vortex-bridge-status','export-vortex-helper','install-with-vortex']);
const allowed=new Set(['set-language','get-preferences','check-mod-changes','find-downloads','choose-download-folder','check-found-download','recover-setup','setup-status','preview-setup','apply-setup','undo-setup','discover','browse','scan','invalidate-scan','undo','check-download','check-extracted-folder','export-download','install-download','open-nexus','open-workshop-item','open-asi-author','launch-devmode','cancel']);
contextBridge.exposeInMainWorld('checker',{
  call:(name,...args)=>{if(!allowed.has(name)&&name!=='open-plugin-github'&&!managerOperations.has(name))throw Error('Unknown operation');return ipcRenderer.invoke(name,...args);},
  progress:fn=>{ipcRenderer.on('progress',(_,message)=>fn(message));},
  cancellable:fn=>{ipcRenderer.on('cancellable',(_,value)=>fn(value));}
});
