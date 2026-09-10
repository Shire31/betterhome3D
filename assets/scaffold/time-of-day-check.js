// Same visible page; no comments or furniture edits are created.
export async function checkTimeOfDay() {
  const app=window.studio,stats=window.studioStats,select=document.getElementById('time-of-day'),checks=[];
  if(stats.phase!=='ready'||document.hidden||app.annotations.composing||app.editor.state.dragging)throw Error('Use an idle visible scene');
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const assert=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const saved={id:app.timeOfDay,camera:app.camera.position.toArray(),target:app.controls.target.toArray(),editor:JSON.stringify(app.editor.session),candidates:JSON.stringify(app.candidates.session),canvas:app.renderer.domElement,version:stats.sceneVersion,focus:document.activeElement};
  const meshes=[];app.scene.traverse(o=>{if(o.isMesh)meshes.push(o);});
  const measurements=[];
  try {
    select.focus();
    for(const id of ['morning','noon','evening','night']) {
      app.renderer.backend.device.pushErrorScope('validation');
      try{await app.setTimeOfDay(id);await wait(250);}finally{const error=await app.renderer.backend.device.popErrorScope();assert(!error,'GPU accepts '+id+' lighting and reflection textures'+(error?': '+error.message:''));}
      assert(app.timeOfDay===id&&select.value===id,'Applied '+id+' while dropdown remains focused');
      assert(stats.sceneVersion===saved.version&&app.renderer.domElement===saved.canvas&&meshes.every(o=>o.parent),'Changing time retains the existing scene and renderer');
      measurements.push({...stats.timeOfDay});
    }
    const suns=[],lamps=[];app.scene.traverse(o=>{if(o.isDirectionalLight)suns.push(o);if(o.isPointLight)lamps.push(o);});
    assert(suns.every(o=>o.intensity===0)&&lamps.some(o=>o.intensity>0),'Night turns the sun off and keeps indoor lights on');
    const png=await app.exportPNG({width:360,download:false});assert(png.size>1000&&stats.lastExport.timeOfDay==='night','PNG captures the selected period');
    const bitmap=await createImageBitmap(png),sample=document.createElement('canvas');sample.width=32;sample.height=32;
    const ctx=sample.getContext('2d');ctx.drawImage(bitmap,0,0,32,32);bitmap.close();
    assert(ctx.getImageData(0,0,32,32).data.some((v,i)=>i%4!==3&&v>15),'Export contains lit pixels, not a blank GPU frame');
    const results=await Promise.allSettled([app.setTimeOfDay('morning'),app.setTimeOfDay('evening'),app.setTimeOfDay('noon')]);
    assert(results.every(r=>r.status==='fulfilled')&&app.timeOfDay==='noon','Queued changes finish at the last chosen period');
    await app.setTimeOfDay('invalid').then(()=>{throw Error('Invalid period accepted');},()=>{});assert(app.timeOfDay==='noon','Invalid period preserves the current lighting');
    const render=app.pipeline.render;
    app.pipeline.render=function(){app.pipeline.render=render;throw Error('Injected time-change render failure');};
    try {await app.setTimeOfDay('night').then(()=>{throw Error('Failed draw was accepted');},()=>{});}finally{app.pipeline.render=render;}
    assert(app.timeOfDay==='noon'&&select.value==='noon'&&app.renderer.getMRT()===null,'Failed switch restores lighting and renderer state');
    await app.setTimeOfDay('night');assert(app.timeOfDay==='night','Failed switch can be retried');
    await wait(700);const frames=stats.renderedFrames,reflections=stats.reflectionUpdates;await wait(600);
    assert(stats.renderedFrames===frames&&stats.reflectionUpdates===reflections,'Static lighting does not render or recapture continuously');
    assert(JSON.stringify(app.camera.position.toArray())===JSON.stringify(saved.camera)&&JSON.stringify(app.controls.target.toArray())===JSON.stringify(saved.target),'Camera remains unchanged');
    assert(JSON.stringify(app.editor.session)===saved.editor&&JSON.stringify(app.candidates.session)===saved.candidates,'Furniture positions and candidate choices remain unchanged');
    return {passed:true,checks,measurements,backend:stats.backend};
  } finally {await app.setTimeOfDay(saved.id);select.blur();saved.focus?.focus?.();}
}
