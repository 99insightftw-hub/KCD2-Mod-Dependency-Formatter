'use strict';
const {parentPort,workerData}=require('worker_threads');
require('./scanner').scan(workerData.input,{activateLocal:workerData.activateLocal===true,onProgress:progress=>parentPort.postMessage({progress})})
  .then(report=>parentPort.postMessage({report})).catch(e=>parentPort.postMessage({error:e.message}));
