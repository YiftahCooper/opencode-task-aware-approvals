"""Real OpenCode host transport tests. No proposed operation is executed."""
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from concurrent.futures import ThreadPoolExecutor
import pytest
from reference_harness import launch_host


def request(host, path, body=None):
    req = urllib.request.Request(host['url'] + path, data=None if body is None else json.dumps(body).encode(), headers={**host['headers'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response) if response.status != 204 else None
    except urllib.error.HTTPError as e:
        raise AssertionError(f'{path}: {e.code}: {e.read().decode()}') from e


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


@pytest.fixture
def model_server():
    calls = []
    control = {'verdict': 'allow'}
    review_started = Event()
    root_started = Event()
    release_root = Event(); release_root.set()
    release_review = Event(); release_review.set()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(body)
            text = json.dumps(body.get('messages', []))
            check = re.search(r'Review check: \\\"([^\\]+)\\\"', text)
            content = 'Ready.'
            if check:
                content = 'invalid JSON' if control['verdict'] == 'invalid' else json.dumps({'verdict': control['verdict'], 'reason': 'Synthetic transport test', 'check': check.group(1)})
            if check:
                review_started.set()
                assert release_review.wait(10), 'Test did not release the held model response'
            else:
                root_started.set()
                assert release_root.wait(10), 'Test did not release the held root response'
            common = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': body.get('model')}
            chunks = [{**common, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': content}, 'finish_reason': None}]}, {**common, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 10, 'total_tokens': 20}}]
            encoded = (''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Content-Length', str(len(encoded))); self.end_headers(); self.wfile.write(encoded)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True); thread.start()
    yield {'url': f'http://127.0.0.1:{server.server_port}/v1', 'calls': calls, 'control': control, 'review_started': review_started, 'release_review': release_review, 'root_started': root_started, 'release_root': release_root}
    release_review.set(); release_root.set()
    server.shutdown(); server.server_close(); thread.join(3)


def activate(host):
    query = urllib.parse.urlencode({'location[directory]': str(host['project'])})
    deadline = time.monotonic() + 10
    while True:
        plugins = request(host, '/api/plugin?' + query)
        if 'opencode-task-aware-approvals' in json.dumps(plugins) or time.monotonic() > deadline: break
        time.sleep(.1)
    assert 'opencode-task-aware-approvals' in json.dumps(plugins), plugins
    assert 'failed' not in json.dumps(plugins), plugins


def start(launch_host, config, profile='main'):
    return launch_host('v2', '/opencode', {}, global_config=config, profile=profile, extra_env={'OPENCODE_DISABLE_MODELS_FETCH': 'true', 'OPENCODE_APPROVAL_DEBUG': '1'})


def configure(host):
    # Resolving the catalog finishes native provider discovery before pinning it.
    # Pinning earlier captures intermediate metadata and correctly fails closed later.
    request(host, '/api/model?' + urllib.parse.urlencode({'location[directory]': str(host['project'])}))
    provider = request(host, '/api/provider/opencode-go?' + urllib.parse.urlencode({'location[directory]': str(host['project'])}))['data']
    trusted = host['root'] / 'home/.config/opencode/task-aware-approvals.json'
    trusted.parent.mkdir(parents=True, exist_ok=True)
    provider_hash = subprocess.check_output(['/node', '--import', '/plugin/node_modules/tsx/dist/loader.mjs', '/plugin/tests/host/fingerprint.mjs'], input=json.dumps(provider).encode()).decode()
    if provider_hash != digest(provider): print('Canonical provider hash uses the JavaScript runtime serializer', flush=True)
    trusted.write_text(json.dumps({'enabled': True, 'providerID': 'opencode-go', 'providerFingerprint': provider_hash})); trusted.chmod(0o600)
    return provider


def prepared_host(launch_host, model_server):
    model = {'name': 'Synthetic', 'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']}, 'limit': {'context': 32000, 'output': 2048}, 'variants': [{'id': 'high', 'settings': {'reasoningEffort': 'high'}}]}
    config = {'providers': {'opencode-go': {'activation': 'enabled', 'package': '@opencode/ai/providers/openai-compatible', 'settings': {'baseURL': model_server['url'], 'apiKey': 'synthetic'}, 'models': {'gpt-fixture': model}}}}
    host = start(launch_host, config)
    request(host, '/api/config?' + urllib.parse.urlencode({'location[directory]': str(host['project'])}))
    time.sleep(.2)
    configure(host)
    # Seed synthetic evidence while the profile has no active plugin/controller.
    # State transactions are intentionally short; waiting for their lock cannot
    # prove a separate qualification batch has finished.
    catalog = request(host, '/api/model?' + urllib.parse.urlencode({'location[directory]': str(host['project'])}))['data']
    metadata = next(m for m in catalog if m['id'] == 'gpt-fixture')
    host_version = subprocess.check_output(['/opencode', '--version'], env=host['env'], text=True).strip()
    payload = subprocess.check_output(['/node', '--import', '/plugin/node_modules/tsx/dist/loader.mjs', '/plugin/tests/host/seed.mjs', host_version], input=json.dumps(metadata).encode())
    host['stop']()
    state_dir = host['root'] / 'home/.local/state/opencode/task-aware-approvals'; state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / 'selection.json'
    state_file.write_bytes(payload); state_file.chmod(0o600)
    config['plugin'] = [[os.environ.get('TASK_AWARE_PLUGIN_PATH', '/plugin'), {}]]
    host = start(launch_host, config); activate(host)
    session = request(host, '/api/session', {'title': 'Disposable transport test', 'location': {'directory': str(host['project'])}, 'model': {'providerID': 'opencode-go', 'id': 'gpt-fixture', 'variant': 'high'}, 'permissions': [{'action': 'shell', 'resource': '*', 'effect': 'ask'}]})['data']
    sid = session['id']
    return host, sid, state_file


@pytest.mark.parametrize('verdict', ['allow', 'deny', 'escalate', 'invalid'])
def test_real_host(launch_host, model_server, verdict):
    host, sid, _ = prepared_host(launch_host, model_server)
    for text in ('Inspect this project; do not publish changes.', 'Continue with the same restrictions.'):
        request(host, f'/api/session/{sid}/prompt', {'text': text}); request(host, f'/api/experimental/session/{sid}/wait', {})
    model_server['control']['verdict'] = verdict
    before = len(model_server['calls'])
    outcome = request(host, f'/api/session/{sid}/permission', {'action': 'shell', 'resources': ['printf harmless'], 'metadata': {'command': 'printf harmless'}})
    assert outcome['data']['effect'] == ('allow' if verdict == 'allow' else 'ask'), (outcome, model_server['calls'][before:], (host['root'] / 'server.log').read_text())
    reviews = [c for c in model_server['calls'][before:] if 'Review check:' in json.dumps(c)]
    assert len(reviews) == 1, (model_server['calls'][before:], (host['root'] / 'server.log').read_text())
    call = reviews[0]
    assert call['model'] == 'gpt-fixture'
    assert not call.get('tools'), call
    assert call.get('reasoning_effort') == 'high', call
    assert call.get('max_tokens', call.get('max_completion_tokens')) == 2048, call
    assert 'do not publish changes' in json.dumps(call)
    assert 'Continue with the same restrictions' in json.dumps(call)
    if verdict == 'allow':
        trusted_file = host['root'] / 'home/.config/opencode/task-aware-approvals.json'
        policy = json.loads(trusted_file.read_text()); policy['enabled'] = False; trusted_file.write_text(json.dumps(policy))
        before_disabled = len(model_server['calls'])
        disabled = request(host, f'/api/session/{sid}/permission', {'action': 'shell', 'resources': ['printf harmless'], 'metadata': {'command': 'printf harmless'}})
        assert disabled['data']['effect'] == 'ask', disabled
        assert len(model_server['calls']) == before_disabled


@pytest.mark.parametrize('change', ['restriction', 'interrupt', 'disable'])
def test_stale_allow_after_real_host_change(launch_host, model_server, change):
    host, sid, _ = prepared_host(launch_host, model_server)
    if change == 'interrupt':
        model_server['release_root'].clear()
    request(host, f'/api/session/{sid}/prompt', {'text': 'Run the harmless project check.'})
    if change == 'interrupt':
        assert model_server['root_started'].wait(5), 'Root execution never reached the model'
    else:
        request(host, f'/api/experimental/session/{sid}/wait', {})
    model_server['review_started'].clear()
    model_server['release_review'].clear()
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(request, host, f'/api/session/{sid}/permission', {'action': 'shell', 'resources': ['printf harmless'], 'metadata': {'command': 'printf harmless'}})
        try:
            assert model_server['review_started'].wait(5), 'Reviewer never reached the model'
            if change == 'restriction':
                request(host, f'/api/session/{sid}/prompt', {'text': 'Stop. Do not run any commands; I revoke the previous authorization.'})
                request(host, f'/api/experimental/session/{sid}/wait', {})
            elif change == 'interrupt':
                request(host, f'/api/session/{sid}/interrupt', {})
            else:
                path = host['root'] / 'home/.config/opencode/task-aware-approvals.json'
                policy = json.loads(path.read_text()); policy['enabled'] = False; path.write_text(json.dumps(policy))
        finally:
            model_server['release_review'].set()
            model_server['release_root'].set()
        outcome = pending.result(timeout=8)
    assert outcome['data']['effect'] == 'ask', (outcome, (host['root'] / 'server.log').read_text())


def test_fresh_prompt_after_real_host_interrupt(launch_host, model_server):
    host, sid, _ = prepared_host(launch_host, model_server)
    model_server['release_root'].clear()
    request(host, f'/api/session/{sid}/prompt', {'text': 'Run the harmless project check.'})
    assert model_server['root_started'].wait(5)
    request(host, f'/api/session/{sid}/interrupt', {})
    model_server['release_root'].set()
    request(host, f'/api/experimental/session/{sid}/wait', {})
    late = request(host, f'/api/session/{sid}/permission', {'action': 'shell', 'resources': ['printf harmless'], 'metadata': {'command': 'printf harmless'}})
    assert late['data']['effect'] == 'ask', late
    # OpenCode retains outcome=interrupted while processing the following prompt.
    model_server['root_started'].clear()
    model_server['release_root'].clear()
    request(host, f'/api/session/{sid}/prompt', {'text': 'I authorize the harmless check again.'})
    assert model_server['root_started'].wait(5)
    try:
        outcome = request(host, f'/api/session/{sid}/permission', {'action': 'shell', 'resources': ['printf harmless'], 'metadata': {'command': 'printf harmless'}})
        assert outcome['data']['effect'] == 'allow', (outcome, (host['root'] / 'server.log').read_text())
    finally:
        model_server['release_root'].set()


def test_native_plugins_registration(launch_host):
    host = start(launch_host, {'plugins': [{'package': os.environ.get('TASK_AWARE_PLUGIN_PATH', '/plugin'), 'options': {}}]}, profile='native')
    activate(host)

def test_installer_native_config_activation_and_rollback(launch_host, tmp_path):
    import shutil
    from pathlib import Path
    source=Path('/plugin')
    release=tmp_path/'release'
    release.mkdir()
    for name in ('dist', 'server.js', 'package.json', 'scripts/manage.mjs', 'scripts/artifact.mjs'):
        target=release/name
        target.parent.mkdir(parents=True,exist_ok=True)
        if (source/name).is_dir(): shutil.copytree(source/name,target)
        else: shutil.copyfile(source/name,target)
    for name in ('zod','jsonc-parser'):
        shutil.copytree(source/'node_modules'/name,release/'node_modules'/name)
    manifest_script="""import {inventory} from '/plugin/scripts/artifact.mjs'; import {readFile,writeFile} from 'node:fs/promises'; const root=process.argv[1];const pkg=JSON.parse(await readFile(root+'/package.json','utf8'));const stamp=JSON.parse(await readFile(root+'/dist/build.json','utf8'));await writeFile(root+'/manifest.json',JSON.stringify({version:pkg.version,build:stamp.build,files:await inventory(root)}));"""
    subprocess.run(['/node','--input-type=module','-e',manifest_script,str(release)],check=True)
    host=start(launch_host, {'plugins': []}, profile='installer')
    host['stop']()
    run=lambda *args: subprocess.run(['/node',str(release/'scripts/manage.mjs'),*args],env=host['env'],capture_output=True,text=True)
    installed=run('install',str(release),'a'*64)
    assert installed.returncode==0,installed.stderr
    config=host['root']/'config/opencode/opencode.json'
    assert json.loads(config.read_text())['plugins']==[{'package':str(release),'options':{}}]
    # No qualification/provider calls are part of this activation test.
    trusted=host['root']/'home/.config/opencode/task-aware-approvals.json'
    policy=json.loads(trusted.read_text());policy['enabled']=False;trusted.write_text(json.dumps(policy))
    host=start(launch_host,None,profile='installer')
    activate(host)
    host['stop']()
    rolled=run('rollback')
    assert rolled.returncode==0,rolled.stderr
    assert json.loads(config.read_text())['plugins']==[]
