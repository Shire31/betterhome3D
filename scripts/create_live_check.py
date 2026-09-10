#!/usr/bin/env python3
"""Create a disposable online-update check using an existing small GLB furniture asset."""
import argparse
import importlib.util
import json
from pathlib import Path
from create_scene import create_scene

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output')
parser.add_argument('--model', required=True)
args = parser.parse_args()
root = create_scene(args.output, [args.model], '在线更新验证', editable=True)
spec = importlib.util.spec_from_file_location('viewer_server', root/'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
source = '''import * as THREE from 'three/webgpu';
import {wallColor} from './palette.js';
export default {
 title:'在线更新验证',background:'#ece8da',roomBounds:{min:[-2,0,-2],max:[2,3,2]},
 scenes:[{id:'1',label:'在线更新',assets:[
  {url:'./models/model-1.glb',name:'table',editable:'边桌',position:[-.5,0,0]},
  {url:'./models/model-1.glb',name:'other',editable:'另一边桌',position:[.7,0,0]}
 ],views:{hero:{label:'正面',position:[2.5,2,4.5],target:[0,.6,0]}}}],
 async prepare(){await new Promise(resolve=>setTimeout(resolve,700));},
 async setup(root,{manager}){
  const wall=new THREE.Mesh(new THREE.BoxGeometry(4,3,.1),new THREE.MeshStandardMaterial({color:wallColor}));
  const image=document.createElement('canvas');image.width=image.height=4;image.getContext('2d').fillStyle='white';image.getContext('2d').fillRect(0,0,4,4);
  const url=URL.createObjectURL(await new Promise(resolve=>image.toBlob(resolve)));
  wall.material.map=new THREE.TextureLoader(manager).load(url,()=>URL.revokeObjectURL(url));
  wall.name='wall';wall.position.set(0,1.5,-1);wall.userData.annotation={id:'wall:back',label:'背景墙',source:'./palette.js'};root.add(wall);
  root.add(new THREE.HemisphereLight('#ffffff','#777777',2));
 }
};
'''
(root/'scene.js').write_text(source)
(root/'palette.js').write_text("export const wallColor='#d4b286';\n")
revisions = {'baseline': server.publish_scene(root, 'scene.js')}
(root/'scene.js').write_text(source.replace('position:[-.5,0,0]', 'position:[-.1,0,0]'))
(root/'palette.js').write_text("export const wallColor='#547b9a';\n")
revisions['changed'] = server.publish_scene(root, 'scene.js')
(root/'scene.js').write_text(source.replace("'./models/model-1.glb'", "'./models/missing.glb'"))
revisions['missing'] = server.publish_scene(root, 'scene.js')
(root/'scene.js').write_text('export default { scenes: ;')
revisions['syntax'] = server.publish_scene(root, 'scene.js')
(root/'scene.js').write_text(source.replace('async setup(root,{manager}){', "async setup(root,{manager}){new THREE.TextureLoader(manager).load('./textures/missing.jpg');"))
revisions['texture'] = server.publish_scene(root, 'scene.js')
(root/'scene.js').write_text(source.replace('position:[-.5,0,0]', 'position:[-.1,0,0]'))
revisions['recovery'] = server.publish_scene(root, 'scene.js')
server.atomic_write(root/'.scene-updates/current.json', json.dumps(revisions['baseline']).encode())
(root/'live-test-revisions.json').write_text(json.dumps(revisions, indent=2))
print(f'Created {root}\nRun npm ci and python3 server.py --port 8770 there.\nIn that visible browser page run:\nawait (await import("./live-update-check.js")).checkLiveUpdates(await (await fetch("./live-test-revisions.json")).json())')
