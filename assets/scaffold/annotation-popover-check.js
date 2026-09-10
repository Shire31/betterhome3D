import * as THREE from 'three/webgpu';

// Run in the existing viewer with one open, attached comment. All API writes stay in memory.
export async function checkAnnotationPopover() {
  const app=window.studio,{annotations:notes,camera,controls,editor}=app,canvas=app.renderer.domElement,host=canvas.parentElement,checks=[];
  const assert=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const frame=async()=>{app.invalidate();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
  const until=async test=>{const end=performance.now()+6000;while(!test()){if(performance.now()>end)throw Error('Annotation UI timed out');await new Promise(r=>setTimeout(r,40));}};
  await notes.reload();const original=notes.list({status:'all'}),record=notes.list().find(r=>['attached','moved'].includes(r.currentTarget.state));
  if(!record)throw Error('Open a scene with one attached comment first');
  const saved={position:camera.position.clone(),target:controls.target.clone(),fov:camera.fov,damping:controls.enableDamping,enabled:controls.enabled,editorBusy:editor.state.busy,view:document.querySelector('#view').value,cutaway:document.querySelector('#cutaway').getAttribute('aria-pressed')};
  const oldFetch=window.fetch;let comments=structuredClone(original),loseResponse=true,loseEditResponse=true,conflict=false,writes=0;
  window.fetch=async(url,options={})=>{
    if(typeof url!=='string'||!url.startsWith('/api/annotations'))return oldFetch(url,options);
    const body=options.body&&JSON.parse(options.body);let result;
    if(options.method==='POST'){
      writes++;result=comments.find(r=>r.id===body.id);
      if(!result){const {snapshotDataUrl,...data}=body;result={...data,number:99,status:'open',snapshot:record.snapshot,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),history:[]};comments.push(result);}
      if(loseResponse){loseResponse=false;throw Error('Simulated lost save response');}
    }else if(options.method==='PATCH'){
      writes++;const index=comments.findIndex(r=>r.id===url.split('/').at(-1));
      if(conflict)return new Response(JSON.stringify({error:'评论已更新，请重新打开核对。当前输入仍保留。'}),{status:409});
      const old=comments[index];result=old;
      if(old.text!==body.text){result={...old,text:body.text,updatedAt:new Date().toISOString(),history:[...old.history,{action:'edit',previousText:old.text,text:body.text,actor:body.actor}]};comments[index]=result;}
      if(loseEditResponse){loseEditResponse=false;throw Error('Simulated lost edit response');}
    }else result={comments};
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
  };
  const popup=()=>document.querySelector('#annotation-composer'),panel=()=>document.querySelector('#annotation-panel');
  const pin=()=>app.scene.getObjectByName('Annotation markers').children.find(p=>p.userData.commentId===record.id);
  const screen=()=>{const p=pin().position.clone().project(camera),r=canvas.getBoundingClientRect();return {x:(p.x+1)*r.width/2+r.left,y:(1-p.y)*r.height/2+r.top};};
  const click=()=>{const p=screen();for(const type of ['pointerdown','pointerup'])canvas.dispatchEvent(new PointerEvent(type,{clientX:p.x,clientY:p.y,pointerId:1,button:0,bubbles:true}));};
  const dismiss=()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  try {
    await notes.goTo(record.id);controls.enableDamping=false;controls.enabled=false;await frame();click();await frame();
    assert(!popup().hidden&&panel().hidden,'Sphere click opens the adjacent card without opening the right panel');
    assert(popup().querySelector('textarea').value===record.text&&!popup().querySelector('details,.annotation-actions'),'Sphere opens the existing text in the same composer, without close/history actions');
    assert(notes.composing&&!controls.enabled&&editor.state.busy,'Editing protects the draft from camera controls and scene commits');
    const p=screen(),bounds=popup().getBoundingClientRect();
    assert(Math.min(Math.abs(bounds.left-p.x),Math.abs(bounds.right-p.x))<=25&&Math.abs(bounds.top-p.y)<30,'Card sits beside its sphere');
    const before=bounds.x,shift=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0).multiplyScalar(.2);
    camera.position.add(shift);controls.target.add(shift);controls.update();await frame();
    assert(Math.abs(popup().getBoundingClientRect().x-before)>2&&getComputedStyle(popup()).transitionDuration==='0s','Open card follows camera movement without a delayed CSS transition');
    const normalPose={position:camera.position.clone(),target:controls.target.clone()};
    const point=pin().position.clone(),ndc=point.clone().project(camera),depth=-point.applyMatrix4(camera.matrixWorldInverse).z;
    const pan=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0).multiplyScalar((ndc.x-.96)*depth*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*camera.aspect);
    camera.position.add(pan);controls.target.add(pan);controls.update();await frame();
    const edge=popup().getBoundingClientRect(),rect=host.getBoundingClientRect();
    assert(!popup().hidden&&edge.left>=rect.left+9&&edge.right<=rect.right-9&&edge.right<screen().x,'Card flips left and stays inside the viewport at the right edge');
    camera.position.add(pan.multiplyScalar(10));controls.target.add(pan);controls.update();await frame();assert(popup().hidden,'Offscreen anchor hides its card');
    camera.position.copy(normalPose.position);controls.target.copy(normalPose.target);controls.update();await frame();assert(!popup().hidden,'Returning to the anchor restores its card');
    notes.setExporting(true);notes.update();assert(popup().hidden&&!app.scene.getObjectByName('Annotation markers').visible,'Export hides both the open card and markers');notes.setExporting(false);await frame();
    dismiss();assert(popup().hidden,'Escape dismisses the anchored comment');
    document.querySelector('#annotations-toggle').click();await notes.reload();assert(!panel().hidden&&popup().hidden,'The global list opens only through its toolbar button');
    dismiss();await notes.goTo(record.id);await frame();
    let root;app.scene.traverse(o=>{if(o.userData.annotation?.id===record.target.id)root=o;});
    const hit=root.localToWorld(new THREE.Vector3().fromArray(record.target.localPoint)).project(camera),r=canvas.getBoundingClientRect();
    await notes.beginAt((hit.x+1)*r.width/2+r.left,(1-hit.y)*r.height/2+r.top);await frame();
    const form=document.querySelector('#annotation-composer'),input=form.querySelector('textarea'),save=form.querySelector('[type=submit]');
    assert(notes.composing&&!form.hidden&&form.offsetHeight<=48,'New comment opens as a compact single-row composer');
    input.value='<b>UI check only</b>';form.requestSubmit();await until(()=>!save.disabled);
    assert(notes.composing&&input.value==='<b>UI check only</b>'&&form.querySelector('.annotation-error').textContent.includes('未确认保存'),'Failed save retains the comment and a retry message');
    form.requestSubmit();await until(()=>!notes.composing);await frame();
    assert(comments.filter(r=>r.text===input.value).length===1&&popup().hidden,'Creating a comment saves once and dismisses the composer');
    comments=comments.filter(r=>original.some(o=>o.id===r.id));await notes.reload(); // Remove only the in-memory creation probe at the same surface point.
    await notes.goTo(record.id);await frame();click();await frame();
    input.value='<b>Edited UI check</b>';input.dispatchEvent(new Event('input'));form.requestSubmit();await until(()=>!save.disabled);
    assert(notes.composing&&input.value==='<b>Edited UI check</b>','Failed edit retains the draft for retry');
    await notes.reload();assert(input.value==='<b>Edited UI check</b>','Reloading server records does not replace an unsaved edit');
    form.requestSubmit();await until(()=>!notes.composing);await frame();
    const updated=notes.list().find(r=>r.id===record.id);
    assert(updated.text==='<b>Edited UI check</b>'&&comments.filter(r=>r.id===record.id).length===1,'Send updates the same comment without creating another marker');
    assert(updated.history.filter(e=>e.action==='edit').length===record.history.filter(e=>e.action==='edit').length+1,'Retrying a committed edit adds one text revision');
    assert(JSON.stringify(updated.target)===JSON.stringify(record.target)&&updated.snapshot===record.snapshot&&updated.status===record.status,'Editing preserves the spatial anchor, snapshot and resolution status');
    click();await frame();assert(input.value==='<b>Edited UI check</b>'&&!form.querySelector('b'),'Reopening shows saved text without interpreting HTML');
    input.value='Unsent revision';dismiss();click();await frame();assert(input.value==='<b>Edited UI check</b>','Cancel discards only the unsaved edit');
    conflict=true;input.value='Conflicting revision';form.requestSubmit();await until(()=>!save.disabled);
    assert(notes.composing&&input.value==='Conflicting revision'&&form.querySelector('.annotation-error').textContent.includes('评论已更新'),'A conflicting edit preserves the draft and shows the conflict');
    dismiss();
    assert(getComputedStyle(document.querySelector('header')).backgroundColor==='rgb(255, 255, 255)','Viewer toolbar uses the neutral white theme');
    return {passed:true,checks,interceptedWrites:writes,serverWrites:0};
  } finally {
    window.fetch=oldFetch;notes.setExporting(false);
    if(notes.composing)document.querySelector('[aria-label="取消评论"]')?.click();dismiss();
    await notes.reload();app.setView(saved.view);camera.position.copy(saved.position);controls.target.copy(saved.target);camera.fov=saved.fov;camera.updateProjectionMatrix();
    controls.enableDamping=false;controls.update();controls.enableDamping=saved.damping;controls.enabled=saved.enabled;editor.setBusy(saved.editorBusy);
    const cutaway=document.querySelector('#cutaway');if(cutaway.getAttribute('aria-pressed')!==saved.cutaway)cutaway.click();app.invalidate();
  }
}
