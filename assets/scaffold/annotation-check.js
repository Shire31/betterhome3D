import * as THREE from 'three/webgpu';

// Run only in a disposable generated project after adding one furniture comment by double click.
// Exercises the actual UI/store and leaves test comments closed with an explicit resolution.
export async function checkAnnotations() {
  const app=window.studio,{annotations:notes,editor,camera,controls}=app,checks=[];
  const assert=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async predicate=>{const end=performance.now()+6000;while(!predicate()){if(performance.now()>end)throw Error('Timed out waiting for annotation UI');await wait(40);}};
  await notes.reload();const oldIds=new Set(notes.list({status:'all'}).map(r=>r.id));const record=notes.list()[0];if(!record)throw Error('Add one furniture comment in this disposable viewer first');
  await notes.goTo(record.id);const object=app.scene.getObjectByName(record.target.id.replace('asset:',''));
  if(!object?.userData.editableLabel)throw Error('The first comment must target editable furniture');
  const original={x:object.position.x,z:object.position.z,angle:THREE.MathUtils.radToDeg(object.rotation.y)},cameraBefore=camera.position.clone(),targetBefore=controls.target.clone(),oldFetch=window.fetch;
  const rect=document.querySelector('canvas').getBoundingClientRect();
  const point=()=>object.localToWorld(new THREE.Vector3().fromArray(record.target.localPoint));
  const screen=()=>{const p=point().project(camera);return {x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2};};
  const refresh=async()=>{app.invalidate();await wait(180);notes.update();};
  const pin=()=>app.scene.getObjectByName('Annotation markers').children.find(o=>o.userData.commentId===record.id);
  try {
    assert(record.currentTarget.state==='attached','Durable comment resolves to the original stable object');
    assert(record.target.localNormal.length===3&&record.target.hitPath.length>0&&record.target.source,'Surface normal, node path and source asset are retained');
    const bitmap=await createImageBitmap(await(await fetch(record.snapshot)).blob());
    const preview=document.createElement('canvas');preview.width=bitmap.width;preview.height=bitmap.height;const context=preview.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
    const p=screen(),pixel=context.getImageData(Math.round(p.x/rect.width*preview.width),Math.round(p.y/rect.height*preview.height),1,1).data;
    assert(preview.width===960&&pixel[2]>pixel[0]+60,'Persisted screenshot includes a blue marker at the clicked surface');
    editor.setEnabled(true);editor.select(object);editor.setPose({x:original.x+.25,z:original.z+.1,angle:original.angle+25});await refresh();
    const moved=screen();assert(notes.list()[0].currentTarget.state==='moved','Moved or rotated furniture is reported explicitly');
    assert(pin().visible&&new THREE.Vector3().fromArray(pin().userData.surfacePoint).distanceTo(point())<1e-8,'GPU sphere follows the same local surface point through translation and yaw');
    const oldPosition=pin().position.clone();camera.position.x+=.05;controls.update();notes.update();assert(pin().position.distanceTo(oldPosition)>0,'Marker updates in the same frame without a DOM projection throttle');camera.position.x-=.05;controls.update();
    editor.setPose(original);await refresh();
    assert(pin().isMesh&&pin().geometry.type==='SphereGeometry'&&pin().material.depthTest&&!pin().castShadow,'Markers use ordinary GPU depth testing and do not cast shadows');
    const close=await notes.close(record.id,'自动验证完成：移动跟随、遮挡与原截图均通过');
    assert(close.status==='closed'&&close.history.at(-1).actor==='assistant'&&!notes.list().some(r=>r.id===record.id),'Assistant can close a comment with a retained resolution');
    assert(!pin(),'Closed comment has no default marker');
    assert(notes.list({status:'closed'}).find(r=>r.id===record.id).snapshot===record.snapshot,'Closing retains the original snapshot and text');
    await notes.reopen(record.id,'验证重新打开');await refresh();assert(notes.list().some(r=>r.id===record.id)&&pin().visible,'Reopening restores the existing spatial marker');
    const other=[...document.querySelectorAll('[data-layout]')].find(b=>b.dataset.layout!==record.sceneId);
    if(other){await app.loadScene(other.dataset.layout);assert(notes.list()[0].currentTarget.state==='other'&&!pin(),'Comments do not attach to another layout');await app.loadScene(record.sceneId);await refresh();assert(notes.list()[0].currentTarget.state==='attached','Stable target resolves after unloading and rebuilding the GLB');}
    const loaded=app.scene.getObjectByName(object.name),tag=loaded.userData.annotation;
    loaded.userData.annotation={...tag,id:'temporarily-removed'};await notes.bind({id:record.sceneId,label:record.sceneLabel});
    assert(notes.list()[0].currentTarget.state==='missing','Missing target is reported rather than attached to a nearby object');
    loaded.userData.annotation={...tag,source:'replacement.glb'};await notes.bind({id:record.sceneId,label:record.sceneLabel});
    assert(notes.list()[0].currentTarget.state==='changed','Replacement source is flagged and does not inherit a misleading pin');
    loaded.userData.annotation=tag;await notes.bind({id:record.sceneId,label:record.sceneLabel});
    await notes.goTo(record.id);
    const clickPoint=loaded.localToWorld(new THREE.Vector3().fromArray(record.target.localPoint)).project(camera);
    await notes.beginAt((clickPoint.x+1)*rect.width/2+rect.left,(1-clickPoint.y)*rect.height/2+rect.top);
    const form=document.querySelector('#annotation-composer'),field=form.querySelector('textarea'),submit=form.querySelector('[type=submit]');
    assert(notes.composing&&!controls.enabled&&editor.state.busy,'Composer pauses camera and furniture controls');
    const typingStart=camera.position.clone();field.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w',bubbles:true}));await wait(100);field.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w',bubbles:true}));
    assert(camera.position.distanceTo(typingStart)<1e-8,'Typing a comment cannot move the camera');
    field.value='自动验证：保存响应丢失后重试';let loseResponse=true;
    window.fetch=async(...args)=>{const response=await oldFetch(...args);if(loseResponse&&args[0]==='/api/annotations'&&args[1]?.method==='POST'){loseResponse=false;throw Error('Simulated lost response');}return response;};
    form.requestSubmit();await until(()=>!submit.disabled);assert(notes.composing&&field.value.includes('保存响应'),'A failed save retains the draft and does not claim success');
    window.fetch=oldFetch;form.requestSubmit();await until(()=>!notes.composing);
    await notes.reload();const retries=notes.list({status:'all'}).filter(r=>r.text==='自动验证：保存响应丢失后重试'&&!oldIds.has(r.id));
    assert(retries.length===1,'Retrying a committed request creates exactly one comment');
    await notes.close(retries[0].id,'自动验证完成：幂等重试通过');await notes.close(record.id,'自动验证完成：全部空间批注检查通过');
    return {passed:true,checks,snapshot:record.snapshot,backend:window.studioStats.backend};
  } finally {
    window.fetch=oldFetch;camera.position.copy(cameraBefore);controls.target.copy(targetBefore);controls.update();app.invalidate();
  }
}
