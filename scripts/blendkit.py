"""Small, cached Blendkit search/thumbnail/free-download client. Python stdlib only."""
import argparse, concurrent.futures, hashlib, json, shutil, time, urllib.parse, urllib.request, uuid
from datetime import datetime, timezone
from pathlib import Path

UA='BetterHome3D/1.0'

def request(url, timeout=35):
    if urllib.parse.urlparse(url).scheme!='https':raise ValueError('Expected an HTTPS asset URL')
    return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':UA}),timeout=timeout)

def write(path, value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix(path.suffix+'.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2));temp.replace(path)

def selected(document, ids):
    rows={a['assetBaseId']:a for q in document['queries'] for a in q.get('results',[])}
    keys=list(dict.fromkeys(str(uuid.UUID(x)) for x in ids))
    return [rows[k] for k in keys]

def short(a):
    d=a.get('dictParameters',{})
    return {'id':a['assetBaseId'],'name':a['name'],'category':a.get('category'),
            'dimensions_m':[d.get('dimension'+axis) for axis in 'XYZ'],
            'faces':d.get('faceCount'),'author':a.get('author',{}).get('fullName'),
            'description':a.get('description','')[:160]}

def search(args):
    def run(q):
        start=time.monotonic();full=q+' +asset_type:model'+('' if args.all_prices else ' +is_free:true')
        url='https://www.blenderkit.com/api/v1/search/?'+urllib.parse.urlencode({'query':full,'dict_parameters':1,'page_size':args.limit,'addon_version':'3.17.0'})
        try:
            with request(url) as response:data=json.load(response)
            return {'query':q,'full_query':full,'seconds':round(time.monotonic()-start,3),'count':data['count'],'results':data['results']}
        except Exception as e:
            return {'query':q,'seconds':round(time.monotonic()-start,3),'error':str(e),'results':[]}
    start=time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=list(pool.map(run,args.query))
    document={'provider':'Blendkit','created_at':datetime.now(timezone.utc).isoformat(),'wall_seconds':round(time.monotonic()-start,3),'queries':rows}
    write(args.out,document)
    for row in rows:print(json.dumps({**{k:v for k,v in row.items() if k!='results'},'results':[short(a) for a in row['results']]},ensure_ascii=False))
    if any('error' in row for row in rows):raise SystemExit('Some searches failed; successful results were saved')

def thumbs(args):
    doc=json.loads(Path(args.results).read_text());folder=Path(args.results).parent/'thumbs';folder.mkdir(exist_ok=True)
    def run(a):
        path=folder/(a['assetBaseId']+'.jpg')
        if not path.exists():
            with request(a['thumbnailMiddleUrl']) as response:path.write_bytes(response.read())
        return {'name':a['name'],'id':a['assetBaseId'],'thumbnail':str(path.resolve())}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for row in pool.map(run,selected(doc,args.id)):print(json.dumps(row,ensure_ascii=False))

def fetch(args):
    doc=json.loads(Path(args.results).read_text());folder=Path(args.out);folder.mkdir(parents=True,exist_ok=True)
    def run(a):
        start=time.monotonic()
        if not a['isFree'] or not a['canDownload']:raise ValueError('Only downloadable free assets are handled: '+a['name'])
        files={f['fileType']:f for f in a['files']}
        entry=files.get('blend') if args.resolution=='original' else (files.get('resolution_2K') or files.get('blend'))
        if not entry:raise ValueError('No native blend file: '+a['name'])
        key=str(uuid.UUID(a['assetBaseId']));dest=folder/(key+'.blend');meta=folder/(key+'.source.json')
        previous=json.loads(meta.read_text()) if meta.exists() else {}
        valid=dest.exists() and previous.get('asset',{}).get('id')==a['id'] and previous.get('fileType')==entry['fileType'] and dest.stat().st_size==entry['fileUploadSize'] and previous.get('sha256')==hashlib.sha256(dest.read_bytes()).hexdigest()
        if not valid:
            for attempt in range(2):
                try:
                    separator='&' if '?' in entry['downloadUrl'] else '?'
                    url=entry['downloadUrl']+separator+urllib.parse.urlencode({'scene_uuid':str(uuid.uuid4())})
                    with request(url) as response:link=json.load(response)['filePath']
                    part=dest.with_suffix('.part')
                    with request(link,90) as response,part.open('wb') as out:shutil.copyfileobj(response,out,1024*1024)
                    if part.stat().st_size!=entry['fileUploadSize']:raise ValueError('Incomplete model: '+a['name'])
                    part.replace(dest);break
                except Exception:
                    if attempt:raise
                    time.sleep(1)
        if not valid:
            write(meta,{'asset':a,'fileType':entry['fileType'],'source':'https://www.blendkit.com/asset-gallery-detail/'+key+'/',
                        'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'downloaded_at':datetime.now(timezone.utc).isoformat(),
                        'download_seconds':round(time.monotonic()-start,3)})
        return {'name':a['name'],'file':str(dest.resolve()),'bytes':dest.stat().st_size,'cached':valid,'seconds':round(time.monotonic()-start,3)}
    failed=False
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures={pool.submit(run,a):a for a in selected(doc,args.id)}
        for future in concurrent.futures.as_completed(futures):
            a=futures[future]
            try:row=future.result()
            except Exception as error:
                failed=True;row={'id':a['assetBaseId'],'name':a['name'],'error':str(error)}
            print(json.dumps(row,ensure_ascii=False))
    if failed:raise SystemExit('Some downloads failed; completed files and source records were retained')

def self_test():
    import contextlib, io, tempfile
    a,b=str(uuid.uuid4()),str(uuid.uuid4())
    doc={'queries':[{'results':[{'assetBaseId':b,'name':'B'},{'assetBaseId':a,'name':'A'}]}]}
    assert [x['name'] for x in selected(doc,[a,b,a])]==['A','B']
    try:selected(doc,['../wrong'])
    except ValueError:pass
    else:raise AssertionError('Unsafe asset ID accepted')
    try:request('file:///etc/passwd')
    except ValueError:pass
    else:raise AssertionError('Non-HTTPS URL accepted')
    # A rejected asset must not discard a valid cached sibling or rewrite its provenance.
    with tempfile.TemporaryDirectory() as temporary:
        p=Path(temporary);blob=b'cached native asset';(p/(b+'.blend')).write_bytes(blob)
        write(p/(b+'.source.json'),{'asset':{'id':b},'fileType':'blend','sha256':hashlib.sha256(blob).hexdigest()})
        before=(p/(b+'.source.json')).stat().st_mtime_ns
        rows=[{'assetBaseId':a,'name':'Blocked','isFree':False,'canDownload':True},
              {'assetBaseId':b,'id':b,'name':'Cached','isFree':True,'canDownload':True,'files':[{'fileType':'blend','fileUploadSize':len(blob)}]}]
        write(p/'results.json',{'queries':[{'results':rows}]})
        output=io.StringIO()
        try:
            with contextlib.redirect_stdout(output):fetch(argparse.Namespace(results=str(p/'results.json'),out=str(p),id=[a,b],resolution='original'))
        except SystemExit:pass
        else:raise AssertionError('Failed asset should give a failing command exit')
        saved=[json.loads(line) for line in output.getvalue().splitlines()]
        assert any(x.get('cached') is True for x in saved) and any(x.get('name')=='Blocked' and x.get('error') for x in saved)
        assert (p/(b+'.source.json')).stat().st_mtime_ns==before
        rows[1]['id']=str(uuid.uuid4());write(p/'results.json',{'queries':[{'results':rows[1:]}]})
        output=io.StringIO()
        try:
            with contextlib.redirect_stdout(output):fetch(argparse.Namespace(results=str(p/'results.json'),out=str(p),id=[b],resolution='original'))
        except SystemExit:pass
        else:raise AssertionError('Different asset version incorrectly reused the cached file')
        assert '"cached": true' not in output.getvalue() and (p/(b+'.blend')).read_bytes()==blob
    print('PASS: stable ID selection, deduplication, input rejection, partial failure, version-aware cache, immutable provenance')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('search');p.add_argument('query',nargs='+');p.add_argument('--out',required=True);p.add_argument('--limit',type=int,default=8);p.add_argument('--all-prices',action='store_true')
    for name in ['thumbs','fetch']:
        p=sub.add_parser(name);p.add_argument('--results',required=True);p.add_argument('--id',action='append',required=True)
        if name=='fetch':
            p.add_argument('--out',required=True);p.add_argument('--resolution',choices=['2k','original'],default='2k')
    sub.add_parser('self-test');args=parser.parse_args()
    if args.command=='self-test':self_test()
    else:globals()[args.command](args)
