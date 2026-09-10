#!/usr/bin/env python3
"""Static viewer plus a localhost-only, atomic annotation store. No dependencies."""
import argparse
import base64
import json
import hashlib
import shutil
import uuid
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.annotation-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def publish_scene(root, entry, resources=('models', 'textures', 'assets')):
    """Freeze runtime inputs, then atomically advertise one complete revision."""
    root = Path(root).resolve(strict=True)
    entry_path = (root / entry).resolve(strict=True)
    entry = entry_path.relative_to(root).as_posix()
    if entry_path.suffix != '.js':
        raise ValueError('The scene entry must be a local .js module')
    store = root / '.scene-updates'
    blobs = store / 'blobs'
    blobs.mkdir(parents=True, exist_ok=True)
    revision = uuid.uuid4().hex
    temporary = Path(tempfile.mkdtemp(prefix='.staging-', dir=store))
    extensions = {'.js', '.json', '.glb', '.gltf', '.bin', '.jpg', '.jpeg', '.png', '.webp', '.avif', '.ktx2', '.hdr', '.exr', '.svg', '.wasm'}
    excluded = {'node_modules', '.git', '.scene-updates', 'annotation-snapshots', 'renders', 'reference', '__pycache__'}
    sources = [entry_path.parent] + [(root / name).resolve() for name in resources]
    files = set()
    for source in sources:
        source.relative_to(root)  # Reject paths escaping this project.
        if not source.exists():
            continue
        for folder, directories, names in os.walk(source, followlinks=False):
            directories[:] = [d for d in directories if d not in excluded and not d.startswith('.') and not (Path(folder)/d).is_symlink()]
            for name in names:
                path = Path(folder) / name
                if path.suffix.lower() in extensions and name != 'annotations.json' and not path.is_symlink():
                    files.add(path)
    try:
        for source in sorted(files):
            content = source.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            blob = blobs / digest
            if not blob.exists():
                atomic_write(blob, content)
            destination = temporary / source.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.link(blob, destination)
        if not (temporary / entry).is_file():
            raise ValueError('Scene entry was excluded from publication')
        value = {'revision': revision, 'entry': entry, 'publishedAt': stamp(), 'files': len(files)}
        temporary.rename(store / revision)
        # Single pointer is the commit; clients never see staging or partially copied files.
        atomic_write(store / 'current.json', json.dumps(value).encode())
        return value
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def validate_record(body):
    def text(value, maximum=4000):
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise ValueError('Invalid annotation text or identifier')
    def vector(value, length=3):
        if not isinstance(value, list) or len(value) != length or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 1e8 for v in value):
            raise ValueError('Invalid spatial coordinate')
    if not isinstance(body, dict):
        raise ValueError('Expected an object')
    text(body.get('id'), 36)
    if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', body['id']):
        raise ValueError('Expected a UUID v4')
    for field in ['sceneId', 'sceneLabel', 'text']:
        text(body.get(field))
    target, camera = body.get('target'), body.get('camera')
    if not isinstance(target, dict) or not isinstance(camera, dict):
        raise ValueError('Missing target or camera')
    for field in ['id', 'label', 'signature']:
        text(target.get(field))
    for field in ['localPoint', 'localNormal', 'worldPoint']:
        vector(target.get(field))
    vector(target.get('worldMatrix'), 16)
    for field in ['position', 'target']:
        vector(camera.get(field))
    if type(camera.get('fov')) not in (int, float) or not 1 <= camera['fov'] <= 150:
        raise ValueError('Invalid camera field of view')
    if type(camera.get('aspect')) not in (int, float) or not 0 < camera['aspect'] < 100:
        raise ValueError('Invalid camera aspect')
    data = body.get('snapshotDataUrl', '')
    if not isinstance(data, str) or not data.startswith('data:image/jpeg;base64,'):
        raise ValueError('A marked JPEG snapshot is required')
    picture = base64.b64decode(data.split(',', 1)[1], validate=True)
    if not 4 <= len(picture) <= 2_000_000 or not picture.startswith(b'\xff\xd8\xff') or not picture.endswith(b'\xff\xd9'):
        raise ValueError('Invalid or oversized JPEG snapshot')
    return picture


class ViewerHandler(SimpleHTTPRequestHandler):
    def json_response(self, status, value):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        # No cross-origin write access or arbitrary paths; also reject DNS rebinding.
        host = self.headers.get('Host', '')
        expected = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        origin = self.headers.get('Origin')
        return host in expected and (origin is None or origin == 'http://' + host)

    @property
    def store_path(self):
        return Path(self.directory) / 'annotations.json'

    def read_store(self):
        if not self.store_path.exists():
            return {'schemaVersion': 1, 'comments': []}
        value = json.loads(self.store_path.read_text(encoding='utf-8'))
        if value.get('schemaVersion') != 1 or not isinstance(value.get('comments'), list):
            raise OSError('Unsupported or damaged annotations.json; existing file has been retained')
        return value

    def save_store(self, value):
        atomic_write(self.store_path, (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode())

    def do_GET(self):
        if urlsplit(self.path).path == '/api/scene-update':
            if not self.allowed():
                return self.json_response(403, {'error': 'Same-origin localhost access only'})
            try:
                path = Path(self.directory) / '.scene-updates/current.json'
                self.json_response(200, json.loads(path.read_text()) if path.exists() else None)
            except (OSError, ValueError) as error:
                self.json_response(503, {'error': str(error)})
        elif urlsplit(self.path).path == '/api/annotations':
            if not self.allowed():
                return self.json_response(403, {'error': 'Same-origin localhost access only'})
            try:
                self.json_response(200, self.read_store())
            except (OSError, ValueError, AttributeError) as error:
                self.json_response(503, {'error': str(error)})
        else:
            super().do_GET()

    def do_POST(self):
        self.mutate()

    def do_PATCH(self):
        self.mutate()

    def mutate(self):
        if not self.allowed():
            return self.json_response(403, {'error': 'Same-origin localhost access only'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 3_000_000 or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise ValueError('Expected bounded application/json body')
            body = json.loads(self.rfile.read(size), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON number')))
        except (ValueError, TypeError) as error:
            return self.json_response(400, {'error': str(error)})
        try:
            data = self.read_store()
        except (OSError, ValueError, AttributeError) as error:
            return self.json_response(503, {'error': str(error)})
        route = urlsplit(self.path).path
        snapshot = None
        try:
            if self.command == 'POST' and route == '/api/annotations':
                picture = validate_record(body)
                record = {key: body[key] for key in ['id', 'sceneId', 'sceneLabel', 'text', 'target', 'camera']}
                previous = next((c for c in data['comments'] if c['id'] == record['id']), None)
                if previous:
                    if any(previous[key] != value for key, value in record.items()):
                        return self.json_response(409, {'error': 'Annotation ID already contains different content'})
                    return self.json_response(200, previous)  # A lost response can be retried without duplicating the comment.
                now = stamp()
                record.update(number=max((c['number'] for c in data['comments']), default=0) + 1,
                              status='open', createdAt=now, updatedAt=now,
                              history=[{'status': 'open', 'actor': 'user', 'note': '', 'at': now}],
                              snapshot=f"/annotation-snapshots/{record['id']}.jpg")
                snapshot = Path(self.directory) / record['snapshot'].lstrip('/')
                snapshot.parent.mkdir(exist_ok=True)
                atomic_write(snapshot, picture)
                data['comments'].append(record)
            elif self.command == 'PATCH' and route.startswith('/api/annotations/'):
                record = next((c for c in data['comments'] if c['id'] == route.split('/')[-1]), None)
                if record is None:
                    return self.json_response(404, {'error': 'Comment not found'})
                if not isinstance(body, dict) or body.get('actor') not in ['user', 'assistant']:
                    raise ValueError('Expected actor user/assistant')
                if 'text' in body:
                    text = body['text']
                    if set(body) != {'text', 'actor', 'expectedUpdatedAt'} or not isinstance(text, str) or not text.strip() or len(text) > 4000:
                        raise ValueError('Expected non-empty text up to 4000 characters, actor and expectedUpdatedAt')
                    text = text.strip()
                    if body['expectedUpdatedAt'] != record['updatedAt']:
                        last = record['history'][-1]
                        if last.get('action') == 'edit' and last.get('expectedUpdatedAt') == body['expectedUpdatedAt'] and last['text'] == text and last['actor'] == body['actor']:
                            return self.json_response(200, record)  # Retry the last committed edit after a lost response.
                        return self.json_response(409, {'error': '评论已更新，请重新打开核对。当前输入仍保留。'})
                    if text == record['text']:
                        return self.json_response(200, record)
                    now = stamp()
                    record['history'].append({'action': 'edit', 'status': record['status'], 'actor': body['actor'], 'at': now,
                                              'previousText': record['text'], 'text': text, 'expectedUpdatedAt': body['expectedUpdatedAt']})
                    record.update(text=text, updatedAt=now)
                    self.save_store(data)
                    return self.json_response(200, record)
                if body.get('status') not in ['open', 'closed']:
                    raise ValueError('Expected status open/closed and actor user/assistant')
                note = body.get('note', '')
                if not isinstance(note, str) or len(note) > 4000 or (body['status'] == 'closed' and not note.strip()):
                    raise ValueError('Closing a comment requires a resolution note')
                if body.get('expectedUpdatedAt') != record['updatedAt']:
                    return self.json_response(409, {'error': 'Comment changed; read it again before updating'})
                if record['status'] == body['status']:
                    return self.json_response(200, record)
                now = stamp()
                record.update(status=body['status'], updatedAt=now)
                record['history'].append({'status': body['status'], 'actor': body['actor'], 'note': note.strip(), 'at': now})
            else:
                return self.json_response(404, {'error': 'Unknown annotation operation'})
            self.save_store(data)
            snapshot = None  # Commit succeeded: a lost HTTP response must not remove its snapshot.
            self.json_response(200, record)
        except (ValueError, TypeError, KeyError) as error:
            if snapshot:
                snapshot.unlink(missing_ok=True)
            self.json_response(400, {'error': str(error)})
        except OSError as error:
            if snapshot:
                snapshot.unlink(missing_ok=True)
            self.json_response(503, {'error': 'Could not save annotation: ' + str(error)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8768)
    parser.add_argument('--directory', default='.')
    parser.add_argument('--publish', metavar='SCENE_JS', help='Publish a completed scene revision without restarting the server')
    parser.add_argument('--resources', nargs='*', default=['models', 'textures', 'assets'], help='Additional runtime resource folders relative to directory')
    args = parser.parse_args()
    root = Path(args.directory).resolve(strict=True)
    if args.publish:
        print(json.dumps(publish_scene(root, args.publish, args.resources), ensure_ascii=False))
        return
    # ponytail: one local writer; HTTPServer serializes mutations. Add a database only for multi-process collaboration.
    server = HTTPServer(('127.0.0.1', args.port), partial(ViewerHandler, directory=str(root)))
    print(f'Viewer + annotations: http://127.0.0.1:{args.port}/ (root: {root})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
