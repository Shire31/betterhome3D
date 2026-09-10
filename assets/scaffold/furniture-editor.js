import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// Shared surface picking keeps furniture selection and annotations behind the same visible walls.
const surfaceRay=new THREE.Raycaster(),surfacePointer=new THREE.Vector2();
export function pickSurface(scene,camera,canvas,event) {
  const rect=canvas.getBoundingClientRect();
  surfacePointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
  camera.updateMatrixWorld();scene.updateMatrixWorld(true);surfaceRay.setFromCamera(surfacePointer,camera);
  const meshes=[];
  scene.traverseVisible(object=>{
    if(!object.isMesh)return;
    for(let p=object;p;p=p.parent)if(p.userData.editorOverlay)return;
    if([object.material].flat().every(m=>m.transparent&&m.opacity<.5))return;
    meshes.push(object);
  });
  return surfaceRay.intersectObjects(meshes,false)[0]||null;
}

// The loaded furniture groups own their transforms; this editor owns selection and temporary edits.
export function createFurnitureEditor({scene,camera,canvas,orbit,invalidate,moved,selectionChanged=()=>{}}) {
  const $=selector=>document.querySelector(selector);
  const transform=new TransformControls(camera,canvas),rotation=new TransformControls(camera,canvas),tools=[transform,rotation];
  const helper=transform.getHelper(),rotationHelper=rotation.getHelper();
  helper.name='Furniture transform handles';rotationHelper.name='Furniture rotation handles';
  for(const tool of tools) {
    // One pointer owner chooses between both native gizmos; they never compete with OrbitControls.
    tool.disconnect();tool.setSpace('world');tool.setColors('#64748b','#2563eb','#64748b','#0f172a');
    tool.showXY=false;tool.showYZ=false;tool.showXYZE=false;tool.showE=false;
    tool.getHelper().userData.editorOverlay=true;scene.add(tool.getHelper());
  }
  canvas.style.touchAction='none';
  transform.setSize(.48);transform.showY=false;transform.setTranslationSnap(.05);
  rotation.setMode('rotate');rotation.setSize(.78);rotation.showX=false;rotation.showZ=false;rotation.showXZ=false;rotation.setRotationSnap(Math.PI/36);
  const outline=new THREE.BoxHelper(undefined,'#93b4d3');
  outline.name='Furniture selection';outline.userData.editorOverlay=true;outline.material.depthTest=false;
  outline.material.toneMapped=false;outline.renderOrder=10000;outline.visible=false;scene.add(outline);
  const edits=new Map();
  let enabled=true,busy=true,selected=null,roots=[],sceneId='',gesture=null;
  const footprint=new THREE.Vector3(),pivot=new THREE.Vector3();let handleRadius=.5;
  const pose=object=>({x:object.position.x,z:object.position.z,angle:THREE.MathUtils.radToDeg(object.rotation.y)});
  const visible=object=>{for(let p=object;p;p=p.parent)if(!p.visible)return false;return true;};
  function fitHandles() {
    if(!selected?.userData.editableLabel||gesture?.tool)return;
    const factor=camera.isOrthographicCamera?(camera.top-camera.bottom)/camera.zoom:
      camera.position.distanceTo(selected.getWorldPosition(pivot))*Math.min(1.9*Math.tan(Math.PI*camera.fov/360)/camera.zoom,7);
    // Follow the furniture footprint at a distance; cap screen size in close-up views.
    const size=Math.min(.78,8*handleRadius/Math.max(factor,.001));
    rotation.setSize(size);transform.setSize(size*.48/.78);
  }
  function sync() {
    const active=enabled&&!busy&&selected?.userData.editableLabel&&visible(selected);
    for(const tool of tools){tool.enabled=Boolean(active);tool.getHelper().visible=Boolean(active);}
    outline.visible=Boolean(active);
    $('#edit-furniture').disabled=busy||roots.length===0;$('#edit-furniture').setAttribute('aria-pressed',String(enabled));
    if(selected) {
      if(active){outline.setFromObject(selected);if(!gesture?.tool){outline.geometry.computeBoundingBox();outline.geometry.boundingBox.getSize(footprint);handleRadius=Math.max(.2,Math.max(footprint.x,footprint.z)*.6);fitHandles();}}
    }
    selectionChanged(enabled?selected:null);invalidate();
  }
  function remember() {
    if(!selected)return;
    // XZ translation and yaw only, even when the transform helper is controlled programmatically.
    selected.position.y=selected.userData.originalFurniturePose.height;
    selected.rotation.x=0;selected.rotation.z=0;
    selected.updateMatrixWorld(true);edits.get(sceneId).set(selected.name,{...pose(selected),authored:{...selected.userData.originalFurniturePose}});
    moved();sync();
  }
  function select(object) {
    if(busy||!enabled)return;
    if(typeof object==='string')object=roots.find(root=>root.name===object);
    selected=roots.includes(object)&&visible(object)?object:null;
    for(const tool of tools)selected?.userData.editableLabel?tool.attach(selected):tool.detach();
    sync();
  }
  function setPose(next) {
    if(!selected?.userData.editableLabel||busy)return;
    if(!['x','z','angle'].every(key=>Number.isFinite(next[key])))throw Error('家具位置和角度必须是有效数字');
    selected.position.x=next.x;selected.position.z=next.z;selected.rotation.y=THREE.MathUtils.degToRad(next.angle);remember();
  }
  function reset() {
    if(!selected?.userData.editableLabel||busy)return;
    setPose(selected.userData.originalFurniturePose);edits.get(sceneId).delete(selected.name);
  }
  function setEnabled(value) {
    if(busy)return;
    if(!value){cancel();selected=null;for(const tool of tools)tool.detach();}
    enabled=value;sync();
  }
  function setBusy(value) {
    if(value)cancel();
    busy=value;sync();
  }
  function bindModel(model,id) {
    cancel();for(const tool of tools)tool.detach();selected=null;sceneId=id;roots=[];
    if(!edits.has(id))edits.set(id,new Map());
    model.traverse(object=>{for(let p=object;p;p=p.parent)if(p.userData.candidateStorage)return;if(object.userData.editableLabel||object.userData.hasCandidates)roots.push(object);});
    const names=new Set();
    for(const object of roots) {
      if(!object.name||names.has(object.name)||object.parent!==model||object.scale.toArray().some(n=>Math.abs(n-1)>1e-6)||new THREE.Vector3(0,1,0).applyQuaternion(object.quaternion).y<1-1e-6)throw new Error('可编辑对象须有唯一名称、单位缩放、直立朝向，并直接属于当前模型：'+object.name);
      names.add(object.name);
      if(!object.userData.editableLabel)continue;
      // Yaw first: quaternion updates in XYZ fold Y past 90 degrees into X/Z, which we lock.
      object.rotation.reorder('YXZ');
      object.userData.originalFurniturePose??={...pose(object),height:object.position.y};
      let saved=edits.get(id).get(object.name);
      if(saved?.authored&&['x','z','angle','height'].some(k=>Math.abs(saved.authored[k]-object.userData.originalFurniturePose[k])>1e-6)) {
        edits.get(id).delete(object.name);saved=null; // An authored pose change wins; unrelated user edits survive.
      }
      if(saved){object.position.x=saved.x;object.position.z=saved.z;object.rotation.y=THREE.MathUtils.degToRad(saved.angle);}
    }
    model.updateMatrixWorld(true);sync();
  }
  function coordinates(event) {
    const rect=canvas.getBoundingClientRect();
    return {x:(event.clientX-rect.left)/rect.width*2-1,y:-(event.clientY-rect.top)/rect.height*2+1,button:event.button};
  }
  function down(event) {
    if(!enabled||busy||gesture||event.button!==0)return;
    const pointer=coordinates(event);let tool=hover(pointer);
    if(!tool&&selected?.userData.editableLabel&&ownerAt(event)===selected){tool=transform;tool.axis='XZ';}
    gesture={id:event.pointerId,x:event.clientX,y:event.clientY,tool};
    if(!tool)return;
    event.preventDefault();event.stopImmediatePropagation();canvas.focus({preventScroll:true});
    gesture.orbit=orbit.enabled;gesture.damping=orbit.enableDamping;
    gesture.edit=edits.get(sceneId).get(selected.name);
    // Drain residual orbit damping without moving the camera under a furniture gesture.
    const eye=camera.position.clone(),target=orbit.target.clone();
    orbit.enableDamping=false;orbit.update();camera.position.copy(eye);orbit.target.copy(target);orbit.update();orbit.enabled=false;
    tool.getHelper().updateMatrixWorld(true);tool.pointerDown(pointer);
    canvas.setPointerCapture(event.pointerId);canvas.style.cursor=tool===rotation?'ew-resize':'grabbing';
  }
  function ownerAt(event) {
    let object=pickSurface(scene,camera,canvas,event)?.object;
    while(object&&!object.userData.editableLabel&&!object.userData.hasCandidates)object=object.parent;
    return object;
  }
  function hover(pointer) {
    if(!selected?.userData.editableLabel||!visible(selected))return null;
    for(const tool of tools){tool.getHelper().updateMatrixWorld(true);tool.pointerHover(pointer);}
    const hit=rotation.axis?rotation:transform.axis?transform:null;
    for(const tool of tools)if(tool!==hit)tool.axis=null;
    return hit;
  }
  function move(event) {
    if(!enabled||busy)return;
    if(gesture?.tool) {
      if(event.pointerId!==gesture.id)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!gesture.moved&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<=5)return;
      gesture.moved=true;gesture.tool.getHelper().updateMatrixWorld(true);
      gesture.tool.pointerMove({...coordinates(event),button:-1});
    } else if(!gesture)canvas.style.cursor=hover(coordinates(event))?'grab':'';
  }
  function up(event) {
    const start=gesture;if(!start||event.pointerId!==start.id||event.button!==0)return;
    if(start.tool){event.preventDefault();event.stopImmediatePropagation();finish();return;}
    gesture=null;
    if(!busy&&enabled&&Math.hypot(event.clientX-start.x,event.clientY-start.y)<=5)select(ownerAt(event));
  }
  function finish(rollback=false) {
    const start=gesture;gesture=null;
    if(start?.tool){
      if(rollback){start.tool.reset();if(start.edit)edits.get(sceneId).set(selected.name,start.edit);else edits.get(sceneId).delete(selected.name);}
      start.tool.pointerUp(null);orbit.enabled=start.orbit;orbit.enableDamping=start.damping;
      if(canvas.hasPointerCapture(start.id))canvas.releasePointerCapture(start.id);
    }
    for(const tool of tools)tool.axis=null;canvas.style.cursor='';sync();
  }
  function cancel(){if(gesture)finish(true);}
  function key(event){if(event.key==='Escape'&&!busy){event.preventDefault();gesture?.tool?cancel():select(null);}}
  function visibility(){if(document.hidden)cancel();}
  for(const tool of tools){tool.addEventListener('objectChange',remember);tool.addEventListener('change',invalidate);}
  orbit.addEventListener('change',fitHandles);
  canvas.addEventListener('pointerdown',down,true);canvas.addEventListener('pointermove',move,true);canvas.addEventListener('pointerup',up,true);
  canvas.addEventListener('pointercancel',cancel);canvas.addEventListener('lostpointercapture',cancel);window.addEventListener('keydown',key);window.addEventListener('blur',cancel);document.addEventListener('visibilitychange',visibility);
  $('#edit-furniture').onclick=()=>setEnabled(!enabled);
  sync();
  return {select,setPose,reset,setEnabled,setBusy,bindModel,
    get selected(){return selected;},
    get session(){return structuredClone([...edits].map(([id,poses])=>[id,[...poses]]));},
    restoreSession(value){edits.clear();for(const [id,poses] of value)edits.set(id,new Map(structuredClone(poses)));},
    get state(){return {enabled,busy,dragging:tools.some(tool=>tool.dragging)||!!gesture,scene:sceneId,selected:selected?.name??null,pose:selected?pose(selected):null,count:roots.length,overlaysVisible:helper.visible||rotationHelper.visible||outline.visible};},
    refreshVisibility(){if(selected){const active=Boolean(enabled&&!busy&&selected.userData.editableLabel&&visible(selected));for(const tool of tools){tool.getHelper().visible=active;tool.enabled=active;}outline.visible=active;}},
    dispose(){
      cancel();for(const tool of tools){tool.dispose();tool.getHelper().removeFromParent();}outline.removeFromParent();outline.geometry.dispose();outline.material.dispose();
      canvas.removeEventListener('pointerdown',down,true);canvas.removeEventListener('pointermove',move,true);canvas.removeEventListener('pointerup',up,true);canvas.removeEventListener('pointercancel',cancel);canvas.removeEventListener('lostpointercapture',cancel);window.removeEventListener('keydown',key);window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',visibility);
      orbit.removeEventListener('change',fitHandles);
    }
  };
}
