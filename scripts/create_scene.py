#!/usr/bin/env python3
"""Create a standalone WebGPU viewer using supplied, existing GLB assets."""
import argparse
import json
import shutil
import struct
import tempfile
from pathlib import Path


def create_scene(target, models, title, editable=False):
    target = Path(target).expanduser().absolute()
    if target.exists():
        raise ValueError(f'Refusing to overwrite existing path: {target}')
    sources = [Path(model).expanduser().resolve(strict=True) for model in models]
    if not sources:
        raise ValueError('Supply at least one existing GLB model')
    for source in sources:
        with source.open('rb') as stream:
            header = stream.read(12)
            if len(header) != 12 or struct.unpack('<4sII', header) != (b'glTF', 2, source.stat().st_size):
                raise ValueError(f'Expected a GLB version 2 file: {source}')
            chunk = stream.read(8)
            if len(chunk) != 8:
                raise ValueError(f'Missing GLB JSON chunk: {source}')
            length, kind = struct.unpack('<I4s', chunk)
            if kind != b'JSON' or length > source.stat().st_size - 20:
                raise ValueError(f'Invalid GLB JSON chunk: {source}')
            document = json.loads(stream.read(length))
            for resource in document.get('images', []) + document.get('buffers', []):
                if resource.get('uri') and not resource['uri'].startswith('data:'):
                    raise ValueError(f'Pack external textures/buffers into the GLB before copying: {source}')
    template = Path(__file__).resolve().parents[1] / 'assets' / 'scaffold'
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.webgpu-scene-', dir=target.parent))
    try:
        shutil.copytree(template, temporary, dirs_exist_ok=True, ignore=shutil.ignore_patterns('node_modules', '__pycache__', '*.pyc', '.scene-updates'))
        shutil.copy2(template.parents[1] / 'LICENSE', temporary / 'LICENSE')
        (temporary / 'models').mkdir()
        scenes = []
        for index, source in enumerate(sources, 1):
            name = f'model-{index}.glb'
            shutil.copy2(source, temporary / 'models' / name)
            scene={'id':str(index),'label':source.stem,'url':f'./models/{name}'}
            if editable:
                scene['assets']=[{'url':scene.pop('url'),'name':f'model-{index}','editable':source.stem}]
            scenes.append(scene)
        config = {'title': title, 'scenes': scenes}
        (temporary / 'scene.js').write_text('// Coordinates: metres, Y up. Edit layouts, cameras and lighting here.\nexport default ' + json.dumps(config, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
        (temporary / 'models' / 'sources.json').write_text(json.dumps([{'file': f'./models/model-{i}.glb', 'copiedFrom': str(source)} for i, source in enumerate(sources,1)], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        # Rename only into a new path. Never merge a generated project into existing work.
        if target.exists():
            raise ValueError(f'Target appeared during generation: {target}')
        temporary.rename(target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', help='New output directory (must not exist)')
    parser.add_argument('--model', action='append', required=True, help='Existing local GLB; repeat for separate scene alternatives')
    parser.add_argument('--name', default='WebGPU 场景', help='Project title')
    parser.add_argument('--editable', action='store_true', help='Treat each supplied GLB as one movable furniture item; omit for complete rooms')
    args = parser.parse_args()
    try:
        result = create_scene(args.output, args.model, args.name, args.editable)
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')
    print(f'Created {result}\nIn that directory run: npm ci && npm start\nOpen http://127.0.0.1:8768/\nEdit scene.js for model placement, room bounds, camera views and project lighting.')


if __name__ == '__main__':
    main()
