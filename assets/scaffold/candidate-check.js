import * as THREE from 'three/webgpu';
import {pickSurface} from './furniture-editor.js';

// Run in a disposable generated viewer with seat / shell / broken / other fixtures.
// This creates real test comments and closes them in finally; never run on a user's project.
export async function checkCandidates() {
  const app=window.studio,{editor,candidates,annotations:notes,camera,controls}=app,checks=[],created=[];
  const assert=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async condition=>{const end=performance.now()+8000;while(!condition()){if(performance.now()>end)throw Error('Timed out');await wait(30);}};
  const selected=()=>app.scene.getObjectByName('seat');
  const oldRender=app.pipeline.render;
  async function comment(text) {
    const object=selected(),box=new THREE.Box3().setFromObject(object,true),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length();
    controls.enableDamping=false;controls.update();camera.position.copy(center).add(new THREE.Vector3(size*.8,size*.55,size*1.2));controls.target.copy(center);camera.fov=44;camera.updateProjectionMatrix();controls.update();app.invalidate();
    const rect=app.renderer.domElement.getBoundingClientRect();let hit;
    for(const y of [.5,.4,.6,.3,.7])for(const x of [.5,.4,.6,.3,.7]) {
      const event={clientX:rect.left+rect.width*x,clientY:rect.top+rect.height*y};let owner=pickSurface(app.scene,camera,app.renderer.domElement,event)?.object;
      while(owner&&!owner.userData.annotation)owner=owner.parent;
      if(owner===object){hit=event;break;}
    }
    assert(!!hit,'A visible candidate surface can be picked');
    await notes.beginAt(hit.clientX,hit.clientY);
    const form=document.querySelector('#annotation-composer');form.querySelector('textarea').value=text;form.requestSubmit();
    await until(()=>!notes.composing);await notes.reload();
    const record=notes.list().find(r=>r.text===text);assert(!!record,'Comment persisted');created.push(record.id);return record;
  }
  try {
    await app.loadScene('test');editor.select('seat');await candidates.choose('default');editor.reset();
    assert(!document.querySelector('#furniture-candidates').hidden,'Selecting furniture opens the left candidate rail');
    const original=await comment('Candidate check original '+crypto.randomUUID());
    editor.select('seat');editor.setPose({x:1.12,z:1.07,angle:137});
    const root=selected(),pose=root.matrix.clone(),position=camera.position.clone(),target=controls.target.clone(),canvas=app.renderer.domElement;
    const rail=document.querySelector('#furniture-candidates'),railTop=rail.getBoundingClientRect().top;
    const swap=candidates.choose('shell');
    assert(rail.getBoundingClientRect().top===railTop&&[...rail.querySelectorAll('button')].every(b=>getComputedStyle(b).opacity==='1'),'Pending swap keeps candidate positions and opacity stable');
    await swap;
    assert(rail.getBoundingClientRect().top===railTop,'Completed swap keeps the candidate rail in place');
    assert(selected()===root&&root.matrix.equals(pose),'Swap preserves the original furniture root, position and yaw');
    assert(camera.position.equals(position)&&controls.target.equals(target)&&app.renderer.domElement===canvas,'Swap preserves camera, target and canvas');
    assert(root.userData.annotation.id===original.target.id&&root.userData.annotation.source.endsWith('shell-chair.glb'),'Stable slot identifies the actual candidate source');
    assert(notes.list().find(r=>r.id===original.id).currentTarget.state==='changed','Old comment is flagged changed instead of pinned to unrelated geometry');
    const alternate=await comment('Candidate check alternate '+crypto.randomUUID());
    assert(alternate.target.source.endsWith('shell-chair.glb')&&alternate.target.label.includes('木框'),'New comment records which candidate was selected');
    editor.select('seat');const activeBefore=candidates.state.active;
    await candidates.choose('broken').then(()=>{throw Error('Missing candidate unexpectedly succeeded');},()=>{});
    assert(candidates.state.active===activeBefore&&root.userData.annotation.source.endsWith('shell-chair.glb')&&!!candidates.state.error,'Missing GLB leaves the previous furniture active with an error');
    app.pipeline.render=()=>{app.pipeline.render=oldRender;throw Error('Injected first-render failure');};
    await candidates.choose('default').then(()=>{throw Error('Compile failure unexpectedly succeeded');},()=>{});
    app.pipeline.render=oldRender;
    assert(candidates.state.active==='shell'&&root.userData.annotation.source.endsWith('shell-chair.glb'),'Compilation failure rolls geometry and annotation identity back together');
    await candidates.choose('default');
    assert(['attached','moved'].includes(notes.list().find(r=>r.id===original.id).currentTarget.state),'Returning to the original candidate restores its original comment association');
    await candidates.choose('shell');const timings=[];
    for(const id of ['default','shell','default','shell']){const began=performance.now();await candidates.choose(id);timings.push(performance.now()-began);}
    const groups=app.scene.getObjectByName('Parked furniture candidates').children.length;
    assert(groups===1,'Repeated swaps retain one parked original without accumulating copies');
    const saved=candidates.session,edited=editor.session.find(([id])=>id==='test');
    await app.loadScene('other');assert(document.querySelector('#furniture-candidates').hidden,'Candidate rail is scoped to the selected scene');
    await app.loadScene('test');editor.select('seat');
    assert(candidates.state.active==='shell'&&JSON.stringify(saved)===JSON.stringify(candidates.session)&&JSON.stringify(edited)===JSON.stringify(editor.session.find(([id])=>id==='test')),'Scene round trip preserves the chosen candidate and manual furniture edits');
    const blob=await app.exportPNG({download:false,width:320});assert(blob.size>1000&&window.studioStats.lastExport.editingOverlaysHidden,'PNG exports the active model without editor overlays');
    const pending=candidates.choose('default'),other=app.loadScene('other');await Promise.allSettled([pending,other]);
    assert(window.studioStats.currentScene==='other'&&window.studioStats.phase==='ready','A scene switch supersedes a pending candidate swap');
    return {passed:true,checks,warmSwapMs:timings.map(t=>+t.toFixed(1)),backend:window.studioStats.backend};
  } finally {
    app.pipeline.render=oldRender;
    for(const id of created)await notes.close(id,'家具候选自动验证完成：原位替换、来源关联、失败回退与状态恢复检查。');
    controls.enableDamping=true;
  }
}
