import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {timesOfDay,applyTimeOfDay,addShadowShell} from './lighting.js';

const root=new THREE.Group(),sun=new THREE.DirectionalLight('#fff',3),sky=new THREE.HemisphereLight('#fff','#888',.3);
sun.position.set(-4,7,-8);sun.target.position.set(2,0,2);sun.castShadow=true;
const lamp=new THREE.PointLight('#ffd391',2),windowLight=new THREE.RectAreaLight('#fff',1.6,2,2),fixed=new THREE.PointLight('#00f',7);
fixed.userData.lightingRole='fixed';
const shade=new THREE.Mesh(new THREE.SphereGeometry(.2),new THREE.MeshStandardMaterial({emissive:'#ffe1a4',emissiveIntensity:.6}));
shade.userData.lightingRole='lamp';root.add(sun,sun.target,sky,lamp,windowLight,fixed,shade);
const children=root.children.slice(),positions=[];
for(const id of Object.keys(timesOfDay)) {
  const state=applyTimeOfDay(root,id);positions.push(sun.position.clone());
  assert.equal(state.id,id);assert.equal(root.children.length,children.length);assert.equal(fixed.intensity,7);
  assert.equal(lamp.intensity,2*timesOfDay[id].lamps);assert.equal(shade.material.emissiveIntensity,.6*timesOfDay[id].emission);
}
assert.equal(sun.intensity,0);assert(lamp.intensity>windowLight.intensity*20);assert(sun.shadow.camera.layers.mask&2);
assert(positions[0].distanceTo(positions[2])>5);
applyTimeOfDay(root,'noon');const noon=lamp.intensity;
for(let i=0;i<3;i++){applyTimeOfDay(root,'night');applyTimeOfDay(root,'noon');assert.equal(lamp.intensity,noon);}
assert.throws(()=>applyTimeOfDay(root,'unknown'),/Unknown time/);
applyTimeOfDay(root,'noon',{sunRotation:Math.PI/2});const rotated=sun.position.clone().sub(sun.target.position).normalize();
assert(rotated.x<-.6&&Math.abs(rotated.z)<.1);

const structure=new THREE.Group();structure.position.set(4,0,-3);structure.rotation.y=.3;
const wall=new THREE.Mesh(new THREE.BoxGeometry(2,2,.1),new THREE.MeshStandardMaterial());wall.castShadow=true;wall.position.set(1,1,0);structure.add(wall);
structure.updateWorldMatrix(true,true);
const expected=new THREE.Box3().setFromObject(wall,true),shell=addShadowShell(structure);
assert(!wall.castShadow&&shell.castShadow&&shell.layers.mask===2);
const actual=new THREE.Box3().setFromObject(shell,true);
assert(expected.min.distanceTo(actual.min)<1e-5&&expected.max.distanceTo(actual.max)<1e-5);
assert.equal(addShadowShell(structure),null);
const instances=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial(),2);
instances.castShadow=true;instances.setMatrixAt(1,new THREE.Matrix4().makeTranslation(2,0,0));
const instancedRoot=new THREE.Group();instancedRoot.add(instances);
assert.equal(addShadowShell(instancedRoot).geometry.attributes.position.count,72);
console.log('Lighting presets, repeatability, sun orientation and structural shadow geometry passed');
