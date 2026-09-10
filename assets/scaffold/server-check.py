"""Run: python3 server-check.py. Exercises the real HTTP store in a temporary directory."""
import base64
import json
import tempfile
import threading
import uuid
from functools import partial
from http.server import HTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from server import ViewerHandler, publish_scene


def check():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        server = HTTPServer(('127.0.0.1', 0), partial(ViewerHandler, directory=temporary))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def call(method='GET', path='/api/annotations', body=None, origin=None):
            headers = {'Content-Type': 'application/json'}
            if origin:
                headers['Origin'] = origin
            request = Request(base + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
            try:
                with urlopen(request) as response:
                    return response.status, json.load(response)
            except HTTPError as response:
                return response.code, json.load(response)
        try:
            assert call()[1] == {'schemaVersion': 1, 'comments': []}
            assert call(path='/api/scene-update')[1] is None
            (root/'viewer').mkdir(); (root/'models').mkdir(); (root/'reference').mkdir()
            (root/'viewer/scene.js').write_text("import './palette.js';export default {};")
            (root/'viewer/palette.js').write_text("export const color='red';")
            (root/'models/chair.glb').write_bytes(b'original-model')
            (root/'reference/private.png').write_bytes(b'not-runtime')
            first = publish_scene(root, 'viewer/scene.js')
            assert call(path='/api/scene-update')[1] == first
            old = root/'.scene-updates'/first['revision']
            (root/'viewer/palette.js').write_text("export const color='blue';")
            (root/'models/chair.glb').write_bytes(b'replacement-model')
            assert (old/'models/chair.glb').read_bytes() == b'original-model'
            second = publish_scene(root, 'viewer/scene.js')
            new = root/'.scene-updates'/second['revision']
            assert (new/'models/chair.glb').read_bytes() == b'replacement-model'
            assert (old/'viewer/scene.js').stat().st_ino == (new/'viewer/scene.js').stat().st_ino
            assert not (new/'reference').exists()
            with urlopen(base+'/.scene-updates/'+first['revision']+'/viewer/palette.js') as result:
                assert b"'red'" in result.read()
            assert call(path='/api/scene-update', origin='https://untrusted.example')[0] == 403
            try:
                publish_scene(root, 'viewer/missing.js')
                assert False, 'Missing entry must not publish'
            except FileNotFoundError:
                pass
            assert call(path='/api/scene-update')[1] == second
            assert not list((root/'.scene-updates').glob('.staging-*'))
            body = {'id': str(uuid.uuid4()), 'sceneId': 'colour', 'sceneLabel': '彩椅', 'text': '<script>原文按文字保存</script>',
                    'target': {'id': 'asset:red-lounge', 'label': '红色单椅', 'signature': 'source-signature', 'source': './red.glb',
                               'localPoint': [0, .6, .1], 'localNormal': [0, 0, 1], 'worldPoint': [2, .6, 1], 'worldMatrix': list(range(16))},
                    'camera': {'position': [1, 2, 3], 'target': [0, 0, 0], 'fov': 60, 'aspect': 1.6},
                    'snapshotDataUrl': 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8\xff\xd9').decode()}
            assert call('POST', body=body, origin='https://untrusted.example')[0] == 403
            status, created = call('POST', body=body)
            assert status == 200 and created['status'] == 'open' and created['number'] == 1
            assert (root / created['snapshot'].lstrip('/')).is_file()
            assert call('POST', body=body)[1]['id'] == created['id']
            assert len(call()[1]['comments']) == 1
            assert call('POST', body={**body, 'text': 'Different content'})[0] == 409
            patch = {'status': 'closed', 'note': '已更换并核对配色', 'actor': 'assistant', 'expectedUpdatedAt': created['updatedAt']}
            route = '/api/annotations/' + created['id']
            assert call('PATCH', route, {**patch, 'note': ''})[0] == 400
            status, closed = call('PATCH', route, patch)
            assert status == 200 and closed['status'] == 'closed' and closed['text'] == body['text']
            assert closed['history'][-1]['actor'] == 'assistant'
            assert call('PATCH', route, patch)[0] == 409
            status, opened = call('PATCH', route, {**patch, 'status': 'open', 'expectedUpdatedAt': closed['updatedAt']})
            assert status == 200 and opened['status'] == 'open' and len(opened['history']) == 3
            edit = {'text': '  换成黑色单椅  ', 'actor': 'user', 'expectedUpdatedAt': opened['updatedAt']}
            status, edited = call('PATCH', route, edit)
            assert status == 200 and edited['text'] == '换成黑色单椅'
            assert all(edited[key] == opened[key] for key in ['id', 'number', 'status', 'target', 'camera', 'snapshot', 'createdAt'])
            assert edited['history'][-1]['action'] == 'edit' and edited['history'][-1]['previousText'] == opened['text']
            assert call('PATCH', route, edit)[1] == edited, 'Lost edit response must be safely retryable without another history entry'
            assert call('PATCH', route, {**edit, 'text': 'stale overwrite'})[0] == 409
            for text in ['', '   ', 'x' * 4001, None, 123]:
                assert call('PATCH', route, {**edit, 'text': text, 'expectedUpdatedAt': edited['updatedAt']})[0] == 400
            assert call('PATCH', route, {**edit, 'status': 'closed'})[0] == 400
            assert call('PATCH', route, {**edit, 'actor': 'unknown'})[0] == 400
            assert call('PATCH', route, {**edit, 'target': {'id': 'other'}})[0] == 400
            status, closed_again = call('PATCH', route, {**patch, 'expectedUpdatedAt': edited['updatedAt']})
            status, edited_closed = call('PATCH', route, {**edit, 'text': '黑色皮革单椅', 'expectedUpdatedAt': closed_again['updatedAt']})
            assert status == 200 and edited_closed['status'] == 'closed', 'Editing text does not reopen a resolved comment'
            assert call('PATCH', route, edit)[0] == 409, 'An old edit retry cannot overwrite a later change'
            assert call()[1]['comments'][0] == edited_closed
            assert (root / edited_closed['snapshot'].lstrip('/')).read_bytes() == b'\xff\xd8\xff\xd9'
            assert call('POST', body={**body, 'id': str(uuid.uuid4()), 'target': {**body['target'], 'localPoint': [float('nan'), 0, 0]}})[0] == 400
            assert call('PATCH', '/api/annotations/missing', patch)[0] == 404
            persisted = json.loads((root / 'annotations.json').read_text())
            assert persisted['comments'][0]['history'] == edited_closed['history']
            assert not list(root.glob('.annotation-*'))
            (root / 'annotations.json').write_text('damaged')
            assert call('POST', body={**body, 'id': str(uuid.uuid4())})[0] == 503
            assert (root / 'annotations.json').read_text() == 'damaged'
            print('PASS: immutable scene publication, dependency snapshots, deduplication, failed publication retention; persistence, immutable snapshot, idempotent retry, close/reopen history, conflict and failure protection')
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == '__main__':
    check()
