import * as THREE from 'three/webgpu';

// Run in a loaded, visible generated viewer; no project furniture names are required.
export async function checkViewer() {
  const app=window.studio,editor=app.editor,checks=[];
  const assert=(ok,message)=>{if(!ok)throw Error(message);checks.push(message);};
  const near=(a,b)=>a.every((n,i)=>Math.abs(n-b[i])<1e-6);
  const saved={scene:window.studioStats.currentScene,selected:editor.state.selected,enabled:editor.state.enabled,
    view:document.querySelector('#view').value,position:app.camera.position.clone(),target:app.controls.target.clone(),fov:app.camera.fov,rotate:app.controls.enableRotate};
  let furnitureName,pose;
  const frames=[];
  try {
    assert(app.selfCheck().backend==='webgpu','Actual WebGPU backend');
    const stage=document.querySelector('#stage').getBoundingClientRect(),canvas=app.renderer.domElement.getBoundingClientRect();
    assert(near([canvas.width,canvas.height,canvas.left,canvas.top],[stage.width,stage.height,stage.left,stage.top]) && Math.abs(app.camera.aspect-stage.width/stage.height)<.002,'Canvas fills the stage with the correct camera aspect');
    editor.setEnabled(true);
    let furniture;app.scene.traverse(o=>{if(!furniture&&o.userData.editableLabel)furniture=o;});
    if(furniture) {
      furnitureName=furniture.name;editor.select(furniture);pose={...editor.state.pose};
      const original=furniture.userData.originalFurniturePose;
      const native=app.scene.getObjectByName('Furniture rotation handles').controls;
      assert(native.mode==='rotate'&&native.getHelper().visible&&app.scene.getObjectByName('Furniture transform handles').visible&&!document.querySelector('[data-transform]'),'Move and rotation handles are available together without a mode switch');
      assert(!document.querySelector('#furniture-panel'),'Direct furniture editing has no floating panel');
      for(const angle of [85,95,165,179,-179,-165,-95,-85]) {
        furniture.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(angle));
        native.dispatchEvent({type:'objectChange'});
        assert(Math.abs(editor.state.pose.angle-angle)<1e-6 && furniture.rotation.x===0 && furniture.rotation.z===0,`Native rotation preserves yaw ${angle}`);
      }
      editor.setPose(pose);app.scene.updateMatrixWorld(true);
      const children=furniture.children.map(o=>({object:o,world:o.matrixWorld.clone(),local:new THREE.Matrix4().copy(furniture.matrixWorld).invert().multiply(o.matrixWorld)}));
      const next={x:pose.x+.25,z:pose.z+.15,angle:pose.angle+30};editor.setPose(next);
      assert(furniture.position.y===original.height && children.every(({object,local,world})=>near(new THREE.Matrix4().copy(furniture.matrixWorld).invert().multiply(object.matrixWorld).elements,local.elements) && !near(object.matrixWorld.elements,world.elements)),'Model and attached props move rigidly without changing furniture height');
      let rejected=false;try{editor.setPose({...next,x:NaN});}catch{rejected=true;}
      assert(rejected && editor.state.pose.x===next.x,'Invalid input leaves the previous pose intact');
      editor.reset();assert(near(Object.values(editor.state.pose),[original.x,original.z,original.angle]),'Reset restores the initial placement');
      editor.setPose(next);
      const other=[...document.querySelectorAll('[data-layout]')].find(b=>b.dataset.layout!==saved.scene)?.dataset.layout;
      if(other) {
        await app.loadScene(other);assert(editor.state.scene===other && editor.state.selected===null,'Switching scenes detaches the previous selection');
        await app.loadScene(saved.scene);editor.select(furnitureName);
        assert(near(Object.values(editor.state.pose),Object.values(next)),'Switching back restores this scene\'s temporary edits');
      }
      editor.setPose(pose);
    } else assert(document.querySelector('#edit-furniture').disabled,'Complete room models stay fixed unless explicitly marked editable');
    const views=[...document.querySelector('#view').options].map(o=>o.value).filter(v=>v!=='orbit').slice(0,2);
    for(const view of views) {
      app.setView(view);const selected=editor.state.selected;
      const blob=await app.exportPNG({download:false,width:320}),bitmap=await createImageBitmap(blob);
      assert(bitmap.width===320 && bitmap.height===Math.round(320/app.camera.aspect),'PNG dimensions match the viewport aspect');bitmap.close();
      assert(window.studioStats.lastExport.editingOverlaysHidden && editor.state.selected===selected && app.controls.enabled,'Export omits editing overlays and restores the editor and camera');
      frames.push(window.studioStats.lastExport.frame);
    }
    assert(new Set(frames).size===frames.length,'Consecutive exports use separate render frames');
    return {passed:true,scene:saved.scene,editableCount:editor.state.count,checks};
  } finally {
    if(window.studioStats.currentScene!==saved.scene)await app.loadScene(saved.scene);
    if(furnitureName&&pose){editor.select(furnitureName);editor.setPose(pose);}
    app.setView(saved.view);app.camera.position.copy(saved.position);app.controls.target.copy(saved.target);app.camera.fov=saved.fov;
    app.controls.enableRotate=saved.rotate;app.camera.updateProjectionMatrix();app.controls.update();app.updateCutaway();
    editor.select(saved.selected);editor.setEnabled(saved.enabled);app.invalidate();
  }
}
