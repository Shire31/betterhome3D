import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Art-directed presets, not a geographic sun-position simulation. Directions are Y-up.
export const timesOfDay = {
  morning: { label:'清晨', direction:[-.8,.42,-1], sun:'#fff0d4', sunScale:.72, sky:'#dce9ff', skyScale:.85, ground:'#a89a89', window:'#dceaff', windowScale:.75, lamps:.35, emission:.3, background:'#cbddeb', environment:.8, exposure:1 },
  noon: { label:'中午', direction:[.05,1,-.9], sun:'#fff9ef', sunScale:1.15, sky:'#eaf2ff', skyScale:1.05, ground:'#aaa393', window:'#edf4ff', windowScale:1, lamps:.16, emission:.12, background:'#e0e9ef', environment:1.08, exposure:1 },
  evening: { label:'傍晚', direction:[.9,.24,-1], sun:'#ffbd7e', sunScale:.85, sky:'#edc0a1', skyScale:.6, ground:'#9c7759', window:'#ffd4b1', windowScale:.48, lamps:1.25, emission:1, background:'#cba58d', environment:.72, exposure:1 },
  night: { label:'黑夜', direction:[0,1,-1], sun:'#adc6ef', sunScale:0, sky:'#6d86b1', skyScale:.09, ground:'#29212c', window:'#6082b5', windowScale:.025, lamps:3.5, emission:1.6, background:'#080f20', environment:.1, exposure:1.06 },
};
const originals=new WeakMap(),emissionOriginals=new WeakMap(),up=new THREE.Vector3(0,1,0);

export function applyTimeOfDay(root,id,settings={}) {
  const preset=timesOfDay[id];if(!Object.hasOwn(timesOfDay,id))throw Error('Unknown time of day: '+id);
  const direction=new THREE.Vector3(...preset.direction).applyAxisAngle(up,settings.sunRotation??0).normalize();
  root.updateMatrixWorld(true);
  root.traverse(object=>{
    if(object.isLight) {
      const role=object.userData.lightingRole||(object.isDirectionalLight?'sun':object.isHemisphereLight?'sky':object.isRectAreaLight?'window':object.isPointLight||object.isSpotLight?'lamp':'fixed');
      if(role==='fixed')return;
      if(!originals.has(object))originals.set(object,{intensity:object.intensity,color:object.color.clone(),distance:object.target?Math.max(1,object.position.distanceTo(object.target.position)):0});
      const base=originals.get(object);
      if(role==='sun') {object.intensity=base.intensity*preset.sunScale;object.color.set(preset.sun);object.position.copy(object.target.position).addScaledVector(direction,base.distance);}
      if(role==='sky') {object.intensity=base.intensity*preset.skyScale;object.color.set(preset.sky);object.groundColor?.set(preset.ground);}
      if(role==='window') {object.intensity=base.intensity*preset.windowScale;object.color.set(preset.window);}
      if(role==='lamp') {object.intensity=base.intensity*preset.lamps;object.color.copy(base.color);}
      if(object.castShadow){object.shadow.camera.layers.enable(1);object.shadow.autoUpdate=false;object.shadow.needsUpdate=true;}
    }
    if(!object.isMesh)return;
    let lamp=object;while(lamp&&lamp!==root&&lamp.userData.lightingRole!=='lamp')lamp=lamp.parent;
    if(lamp?.userData.lightingRole!=='lamp')return;
    for(const material of [object.material].flat())if(material?.emissive) {
      if(!emissionOriginals.has(material))emissionOriginals.set(material,material.emissiveIntensity);
      material.emissiveIntensity=emissionOriginals.get(material)*preset.emission;
    }
  });
  return {id,label:preset.label,background:preset.background,environmentIntensity:(settings.environmentIntensity??.5)*preset.environment,exposure:(settings.exposure??1)*preset.exposure};
}

// Call on an explicit static architectural group, never on a whole furnished scene.
// Layer 1 is reserved for occlusion; the visible shell remains editable/cuttable.
export function addShadowShell(root) {
  root.updateWorldMatrix(true,true);
  const inverse=root.matrixWorld.clone().invert(),geometries=[],sources=[];
  root.traverse(object=>{
    if(!object.isMesh||object.isSkinnedMesh||!object.castShadow||object.userData.shadowOccluder)return;
    if([object.material].flat().some(m=>m.transparent||m.alphaTest>0))return;
    const instance=new THREE.Matrix4();
    for(let i=0;i<(object.isInstancedMesh?object.count:1);i++) {
      const geometry=object.geometry.index?object.geometry.toNonIndexed():object.geometry.clone();
      const matrix=inverse.clone().multiply(object.matrixWorld);
      if(object.isInstancedMesh){object.getMatrixAt(i,instance);matrix.multiply(instance);}
      geometry.applyMatrix4(matrix);
      if(!geometry.attributes.normal)geometry.computeVertexNormals();
      for(const key of Object.keys(geometry.attributes))if(key!=='position'&&key!=='normal')geometry.deleteAttribute(key);
      geometries.push(geometry);
    }
    sources.push(object);
  });
  if(!geometries.length)return null;
  let merged;try{merged=mergeGeometries(geometries);}finally{geometries.forEach(g=>g.dispose());}
  if(!merged)throw Error('Could not merge structural shadow geometry');
  const shell=new THREE.Mesh(merged,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  shell.name='Permanent shadow shell';shell.layers.set(1);shell.castShadow=true;shell.userData.shadowOccluder=true;
  sources.forEach(object=>object.castShadow=false);root.add(shell);return shell;
}
